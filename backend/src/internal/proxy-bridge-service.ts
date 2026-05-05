import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'
import { URL } from 'node:url'
import yaml from 'js-yaml'

import { allocateLocalPort } from './net-utils'
import { getAppStateRoot, loadProxyBridgeBinaryPaths } from './app-config-store'
import { decodeBase64Text, getMapInt, getMapString, parseClashPayload, pickClashNode } from './clash-import'
import { emitWailsEvent } from '../ipc/wails-emit'

type BridgeEntry = {
  key: string
  port: number
  child: ChildProcess
  refCount: number
  lastUsedAt: number
  engine: BridgeEngine
  stopping: boolean
}

type BridgeEngine = 'xray' | 'sing-box'

type BridgePlan = {
  engine: BridgeEngine
  outbound: Record<string, unknown>
}

type BridgeRunFiles = {
  configPath: string
  stderrPath: string
}

function errorMessageOf(input: unknown): string {
  return input instanceof Error ? input.message : String(input)
}

/**
 * 将桥接底层异常归一为可展示提示，便于前端直接显示。
 */
export function formatBridgeErrorForWarning(input: unknown): string {
  const msg = errorMessageOf(input).trim()
  const low = msg.toLowerCase()
  if (low.includes('enoent') || low.includes('not recognized') || low.includes('not found')) {
    return `桥接二进制不可用（未找到可执行文件）：${msg}`
  }
  if (msg.includes('字段不完整') || msg.includes('解析失败')) {
    return `桥接节点配置无效：${msg}`
  }
  if (msg.includes('桥接端口未就绪') || msg.includes('桥接进程提前退出')) {
    return `桥接启动超时或进程异常退出：${msg}`
  }
  return `桥接启动失败：${msg}`
}

const bridges = new Map<string, BridgeEntry>()
const profileBridgeKey = new Map<string, string>()
const BRIDGE_IDLE_TTL_MS = 45_000

function nowMs(): number {
  return Date.now()
}

function decodeB64Compat(raw: string): string {
  const s = raw.replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  const fixed = pad === 0 ? s : `${s}${'='.repeat(4 - pad)}`
  return Buffer.from(fixed, 'base64').toString('utf8')
}

function normalizeProxySource(raw: string): string {
  return String(raw ?? '').trim()
}

function firstNonEmpty(...values: Array<string | null | undefined>): string {
  for (const value of values) {
    const v = String(value ?? '').trim()
    if (v) {
      return v
    }
  }
  return ''
}

function toBoolLike(value: string | null | undefined): boolean {
  const v = String(value ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function parseCsv(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function parseHostList(value: string): string[] {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function parseBridgeDnsConfig(raw: string): Record<string, unknown> | null {
  const src = String(raw ?? '').trim()
  if (!src) return null
  try {
    const parsed = yaml.load(src) as Record<string, unknown> | null
    const dnsSection = parsed && typeof parsed === 'object' ? (parsed.dns as Record<string, unknown> | undefined) : undefined
    const out: string[] = []
    const nameserver = dnsSection?.nameserver
    if (Array.isArray(nameserver)) {
      for (const item of nameserver) {
        const s = String(item ?? '').trim()
        if (s) out.push(s)
      }
    }
    const fallback = dnsSection?.fallback
    if (Array.isArray(fallback)) {
      for (const item of fallback) {
        const s = String(item ?? '').trim()
        if (s) out.push(s)
      }
    }
    if (out.length > 0) {
      return { servers: out }
    }
  } catch {
    /* ignore yaml parse error, try csv fallback */
  }
  const items = src
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  if (items.length > 0) {
    return { servers: items }
  }
  return null
}

function extractBridgeErrorLog(stderrPath: string): string {
  try {
    if (!existsSync(stderrPath)) {
      return ''
    }
    return readFileSync(stderrPath, 'utf8').trim()
  } catch {
    return ''
  }
}

async function waitBridgePortReady(
  port: number,
  timeoutMs: number,
  child: ChildProcess,
  startupErrorRef?: { error: Error | null },
): Promise<void> {
  const deadline = Date.now() + Math.max(1_000, timeoutMs)
  while (Date.now() < deadline) {
    if (startupErrorRef?.error) {
      const msg = startupErrorRef.error.message || String(startupErrorRef.error)
      throw new Error(`桥接进程启动失败: ${msg}`)
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('桥接进程提前退出')
    }
    const ok = await new Promise<boolean>((resolve) => {
      const sock = new Socket()
      let done = false
      const finish = (state: boolean) => {
        if (done) return
        done = true
        try {
          sock.destroy()
        } catch {
          /* ignore */
        }
        resolve(state)
      }
      sock.setTimeout(250, () => finish(false))
      sock.once('error', () => finish(false))
      sock.once('connect', () => finish(true))
      try {
        sock.connect(port, '127.0.0.1')
      } catch {
        finish(false)
      }
    })
    if (ok) {
      return
    }
    await new Promise((res) => setTimeout(res, 120))
  }
  if (startupErrorRef?.error) {
    const msg = startupErrorRef.error.message || String(startupErrorRef.error)
    throw new Error(`桥接进程启动失败: ${msg}`)
  }
  throw new Error(`桥接端口未就绪: 127.0.0.1:${port}`)
}

function isNativeProxy(source: string): boolean {
  const low = source.toLowerCase()
  return (
    !source ||
    low === 'direct://' ||
    low.startsWith('http://') ||
    low.startsWith('https://') ||
    low.startsWith('socks5://') ||
    low.startsWith('socks5h://')
  )
}

function makeNodeKey(source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

function parseVmessOutbound(source: string): Record<string, unknown> {
  const raw = source.slice('vmess://'.length).trim()
  const text = decodeB64Compat(raw)
  const conf = JSON.parse(text) as Record<string, string>
  const host = String(conf.add ?? '').trim()
  const port = Number(conf.port ?? 0) || 0
  const id = String(conf.id ?? '').trim()
  if (!host || !port || !id) {
    throw new Error('vmess 节点字段不完整')
  }
  const network = String(conf.net ?? '').trim().toLowerCase()
  const tlsMode = String(conf.tls ?? '').trim().toLowerCase()
  const sni = String(conf.sni ?? '').trim()
  const hostHeader = String(conf.host ?? '').trim()
  const wsPath = String(conf.path ?? '').trim()
  const alpn = String(conf.alpn ?? '').trim()
  const allowInsecure = toBoolLike(conf.allowInsecure)
  const grpcServiceName = firstNonEmpty(conf.serviceName, conf.service_name, conf.path).replace(/^\//, '')
  const httpHost = firstNonEmpty(conf.host, conf.http_host)
  const httpPath = firstNonEmpty(conf.path, conf.http_path, '/')

  const out: Record<string, unknown> = {
    protocol: 'vmess',
    tag: 'proxy-out',
    settings: {
      vnext: [
        {
          address: host,
          port,
          users: [{ id, security: 'auto' }],
        },
      ],
    },
  }
  const stream: Record<string, unknown> = {}
  if (tlsMode === 'tls') {
    stream.security = 'tls'
    const tlsSettings: Record<string, unknown> = { allowInsecure }
    if (sni) {
      tlsSettings.serverName = sni
    }
    if (alpn) {
      tlsSettings.alpn = parseCsv(alpn)
    }
    stream.tlsSettings = tlsSettings
  }
  if (network === 'ws') {
    stream.network = 'ws'
    const ws: Record<string, unknown> = {}
    if (wsPath) ws.path = wsPath
    if (hostHeader) ws.headers = { Host: hostHeader }
    stream.wsSettings = ws
  } else if (network === 'grpc') {
    stream.network = 'grpc'
    if (grpcServiceName) {
      stream.grpcSettings = { serviceName: grpcServiceName }
    }
  } else if (network === 'http' || network === 'h2') {
    stream.network = 'http'
    stream.httpSettings = {
      ...(httpHost ? { host: parseHostList(httpHost) } : {}),
      ...(httpPath ? { path: httpPath } : {}),
    }
  }
  if (Object.keys(stream).length > 0) {
    out.streamSettings = stream
  }
  return out
}

function parseVlessOutbound(source: string): Record<string, unknown> {
  const u = new URL(source)
  const host = String(u.hostname ?? '').trim()
  const port = Number(u.port ?? 0) || 0
  const id = decodeURIComponent(String(u.username ?? '').trim())
  if (!host || !port || !id) {
    throw new Error('vless 节点字段不完整')
  }
  const q = u.searchParams
  const network = (q.get('type') ?? q.get('network') ?? '').trim().toLowerCase()
  const security = (q.get('security') ?? '').trim().toLowerCase()
  const sni = (q.get('sni') ?? '').trim()
  const hostHeader = (q.get('host') ?? '').trim()
  const wsPath = (q.get('path') ?? '').trim()
  const serviceName = (q.get('serviceName') ?? q.get('service_name') ?? '').trim()
  const flow = (q.get('flow') ?? '').trim()
  const alpn = firstNonEmpty(q.get('alpn'))
  const allowInsecure = toBoolLike(q.get('allowInsecure'))
  const grpcMode = firstNonEmpty(q.get('mode'), q.get('grpc-mode'))
  const httpHost = firstNonEmpty(q.get('host'), q.get('httpHost'), q.get('http-host'))
  const httpPath = firstNonEmpty(q.get('path'), q.get('httpPath'), q.get('http-path'), '/')
  const realityPublicKey = firstNonEmpty(q.get('pbk'), q.get('publicKey'), q.get('public-key'))
  const realityShortId = firstNonEmpty(q.get('sid'), q.get('shortId'), q.get('short-id'))
  const realityFingerprint = firstNonEmpty(
    q.get('fp'),
    q.get('fingerprint'),
    q.get('clientFingerprint'),
    q.get('client-fingerprint'),
  )
  const realitySpiderX = firstNonEmpty(q.get('spx'), q.get('spiderX'), q.get('spider-x'))

  const out: Record<string, unknown> = {
    protocol: 'vless',
    tag: 'proxy-out',
    settings: {
      vnext: [
        {
          address: host,
          port,
          users: [{ id, encryption: 'none', ...(flow ? { flow } : {}) }],
        },
      ],
    },
  }
  const stream: Record<string, unknown> = {}
  if (security === 'tls' || security === 'reality') {
    stream.security = security === 'reality' ? 'reality' : 'tls'
    if (security === 'tls') {
      stream.tlsSettings = {
        ...(sni ? { serverName: sni } : {}),
        allowInsecure,
        ...(alpn ? { alpn: parseCsv(alpn) } : {}),
      }
    } else {
      stream.realitySettings = {
        ...(sni ? { serverName: sni } : {}),
        ...(realityPublicKey ? { publicKey: realityPublicKey } : {}),
        ...(realityShortId ? { shortId: realityShortId } : {}),
        ...(realityFingerprint ? { fingerprint: realityFingerprint } : {}),
        ...(realitySpiderX ? { spiderX: realitySpiderX } : {}),
      }
    }
  }
  if (network === 'ws') {
    stream.network = 'ws'
    const ws: Record<string, unknown> = {}
    if (wsPath) ws.path = wsPath
    if (hostHeader) ws.headers = { Host: hostHeader }
    stream.wsSettings = ws
  } else if (network === 'grpc') {
    stream.network = 'grpc'
    if (serviceName) {
      stream.grpcSettings = { serviceName, ...(grpcMode ? { multiMode: grpcMode === 'multi' } : {}) }
    }
  } else if (network === 'http' || network === 'h2') {
    stream.network = 'http'
    stream.httpSettings = {
      ...(httpHost ? { host: parseHostList(httpHost) } : {}),
      ...(httpPath ? { path: httpPath } : {}),
    }
  }
  if (Object.keys(stream).length > 0) {
    out.streamSettings = stream
  }
  return out
}

function parseTrojanOutbound(source: string): Record<string, unknown> {
  const u = new URL(source)
  const host = String(u.hostname ?? '').trim()
  const port = Number(u.port ?? 0) || 0
  const password = decodeURIComponent(String(u.username ?? '').trim())
  if (!host || !port || !password) {
    throw new Error('trojan 节点字段不完整')
  }
  const q = u.searchParams
  const sni = (q.get('sni') ?? q.get('peer') ?? '').trim()
  const network = (q.get('type') ?? '').trim().toLowerCase()
  const wsPath = (q.get('path') ?? '').trim()
  const hostHeader = (q.get('host') ?? '').trim()
  const allowInsecure =
    toBoolLike(q.get('allowInsecure'))
  const alpn = firstNonEmpty(q.get('alpn'))
  const grpcMode = firstNonEmpty(q.get('mode'), q.get('grpc-mode'))
  const httpHost = firstNonEmpty(q.get('host'), q.get('httpHost'), q.get('http-host'))
  const httpPath = firstNonEmpty(q.get('path'), q.get('httpPath'), q.get('http-path'), '/')

  const out: Record<string, unknown> = {
    protocol: 'trojan',
    tag: 'proxy-out',
    settings: {
      servers: [{ address: host, port, password }],
    },
  }
  const stream: Record<string, unknown> = {
    security: 'tls',
    tlsSettings: {
      ...(sni ? { serverName: sni } : {}),
      allowInsecure,
      ...(alpn ? { alpn: parseCsv(alpn) } : {}),
    },
  }
  if (network === 'ws') {
    stream.network = 'ws'
    const ws: Record<string, unknown> = {}
    if (wsPath) ws.path = wsPath
    if (hostHeader) ws.headers = { Host: hostHeader }
    stream.wsSettings = ws
  } else if (network === 'grpc') {
    stream.network = 'grpc'
    const serviceName = (q.get('serviceName') ?? '').trim()
    if (serviceName) {
      stream.grpcSettings = { serviceName, ...(grpcMode ? { multiMode: grpcMode === 'multi' } : {}) }
    }
  } else if (network === 'http' || network === 'h2') {
    stream.network = 'http'
    stream.httpSettings = {
      ...(httpHost ? { host: parseHostList(httpHost) } : {}),
      ...(httpPath ? { path: httpPath } : {}),
    }
  }
  out.streamSettings = stream
  return out
}

function parseShadowsocksOutbound(source: string): Record<string, unknown> {
  const raw = source.slice('ss://'.length)
  const noFragment = raw.includes('#') ? raw.slice(0, raw.indexOf('#')) : raw
  const at = noFragment.lastIndexOf('@')
  if (at <= 0) {
    throw new Error('ss 节点格式不支持')
  }
  const authPart = noFragment.slice(0, at)
  const hostPart = noFragment.slice(at + 1)
  const [host, portStr] = hostPart.split(':')
  const port = Number(portStr ?? 0) || 0
  const authText = authPart.includes(':') ? authPart : decodeB64Compat(authPart)
  const idx = authText.indexOf(':')
  if (!host || !port || idx <= 0) {
    throw new Error('ss 节点字段不完整')
  }
  const method = authText.slice(0, idx)
  const password = authText.slice(idx + 1)
  return {
    protocol: 'shadowsocks',
    tag: 'proxy-out',
    settings: {
      servers: [{ address: host, port, method, password }],
    },
  }
}

function parseHysteria2Outbound(source: string): Record<string, unknown> {
  const u = new URL(source)
  const server = String(u.hostname ?? '').trim()
  const serverPort = Number(u.port ?? 0) || 0
  const password = decodeURIComponent(String(u.username ?? '').trim())
  const q = u.searchParams
  const sni = firstNonEmpty(q.get('sni'), q.get('server_name'))
  const insecure = toBoolLike(firstNonEmpty(q.get('insecure'), q.get('skip-cert-verify')))
  const obfs = firstNonEmpty(q.get('obfs'))
  const obfsPassword = firstNonEmpty(q.get('obfs-password'), q.get('obfs_password'))
  const upMbps = Number(firstNonEmpty(q.get('upmbps'), q.get('up_mbps'))) || 0
  const downMbps = Number(firstNonEmpty(q.get('downmbps'), q.get('down_mbps'))) || 0
  if (!server || serverPort <= 0 || !password) {
    throw new Error('hysteria2 节点字段不完整')
  }
  return {
    type: 'hysteria2',
    tag: 'proxy-out',
    server,
    server_port: serverPort,
    password,
    tls: {
      enabled: true,
      ...(sni ? { server_name: sni } : {}),
      ...(insecure ? { insecure: true } : {}),
    },
    ...(obfs ? { obfs } : {}),
    ...(obfsPassword ? { obfs_password: obfsPassword } : {}),
    ...(upMbps > 0 ? { up_mbps: upMbps } : {}),
    ...(downMbps > 0 ? { down_mbps: downMbps } : {}),
  }
}

function parseTuicOutbound(source: string): Record<string, unknown> {
  const u = new URL(source)
  const server = String(u.hostname ?? '').trim()
  const serverPort = Number(u.port ?? 0) || 0
  const uuid = decodeURIComponent(String(u.username ?? '').trim())
  const password = decodeURIComponent(String(u.password ?? '').trim())
  const q = u.searchParams
  const sni = firstNonEmpty(q.get('sni'), q.get('server_name'))
  const insecure = toBoolLike(firstNonEmpty(q.get('insecure'), q.get('skip-cert-verify')))
  const congestion = firstNonEmpty(q.get('congestion_control'), q.get('congestion-controller'))
  const udpOverTcp = toBoolLike(firstNonEmpty(q.get('udp-over-tcp'), q.get('udp_over_tcp')))
  if (!server || serverPort <= 0 || !uuid || !password) {
    throw new Error('tuic 节点字段不完整')
  }
  return {
    type: 'tuic',
    tag: 'proxy-out',
    server,
    server_port: serverPort,
    uuid,
    password,
    ...(congestion ? { congestion_control: congestion } : {}),
    ...(udpOverTcp ? { udp_over_tcp: true } : {}),
    tls: {
      enabled: true,
      ...(sni ? { server_name: sni } : {}),
      ...(insecure ? { insecure: true } : {}),
    },
  }
}

function buildPlanFromProxy(source: string): BridgePlan {
  const low = source.toLowerCase()
  if (low.startsWith('vmess://')) return { engine: 'xray', outbound: parseVmessOutbound(source) }
  if (low.startsWith('vless://')) return { engine: 'xray', outbound: parseVlessOutbound(source) }
  if (low.startsWith('trojan://')) return { engine: 'xray', outbound: parseTrojanOutbound(source) }
  if (low.startsWith('ss://')) return { engine: 'xray', outbound: parseShadowsocksOutbound(source) }
  if (low.startsWith('hysteria2://') || low.startsWith('hysteria://')) {
    const fixed = low.startsWith('hysteria://') ? `hysteria2://${source.slice('hysteria://'.length)}` : source
    return { engine: 'sing-box', outbound: parseHysteria2Outbound(fixed) }
  }
  if (low.startsWith('tuic://')) return { engine: 'sing-box', outbound: parseTuicOutbound(source) }
  if (low.startsWith('clash://') || source.includes('proxies:') || hasYamlBridgeType(source)) {
    return parseClashOutbound(source)
  }
  throw new Error('当前协议暂未接入真桥接')
}

function parseClashOutbound(source: string): BridgePlan {
  let raw = source.trim()
  if (raw.toLowerCase().startsWith('clash://')) {
    const body = raw.slice('clash://'.length).trim()
    let decoded = decodeBase64Text(body)
    if (!decoded) {
      try {
        decoded = decodeBase64Text(decodeURIComponent(body))
      } catch {
        decoded = null
      }
    }
    if (!decoded) {
      throw new Error('clash:// 订阅解析失败')
    }
    raw = decoded
  }
  const payload = parseClashPayload(raw)
  const node = pickClashNode(payload)
  const type = getMapString(node, 'type').trim().toLowerCase()
  if (!node || !type) {
    throw new Error('clash 节点解析失败')
  }
  if (type === 'vmess') {
    const host = getMapString(node, 'server').trim()
    const port = getMapInt(node, 'port')
    const id = getMapString(node, 'uuid').trim()
    if (!host || port <= 0 || !id) {
      throw new Error('clash-vmess 节点字段不完整')
    }
    const network = getMapString(node, 'network').trim().toLowerCase()
    const sni = getMapString(node, 'sni').trim() || getMapString(node, 'servername').trim()
    const allowInsecure = Boolean(node['skip-cert-verify'])
    const alpn = parseCsv(getMapString(node, 'alpn').trim())
    const httpHost = firstNonEmpty(getMapString(node, 'http-host'), getMapString(node, 'host'))
    const httpPath = firstNonEmpty(getMapString(node, 'http-path'), getMapString(node, 'path'), '/')
    const out: Record<string, unknown> = {
      protocol: 'vmess',
      tag: 'proxy-out',
      settings: {
        vnext: [{ address: host, port, users: [{ id, security: 'auto' }] }],
      },
    }
    const stream: Record<string, unknown> = {}
    if (network === 'ws') {
      stream.network = 'ws'
      const wsOpts = (node['ws-opts'] as Record<string, unknown> | undefined) ?? {}
      const wsPath = firstNonEmpty(getMapString(wsOpts, 'path'), getMapString(node, 'ws-path'))
      const headers = (wsOpts.headers as Record<string, unknown> | undefined) ?? {}
      const hostHeader = firstNonEmpty(getMapString(headers, 'Host'), getMapString(node, 'ws-host'))
      const ws: Record<string, unknown> = {}
      if (wsPath) ws.path = wsPath
      if (hostHeader) ws.headers = { Host: hostHeader }
      stream.wsSettings = ws
    } else if (network === 'grpc') {
      stream.network = 'grpc'
      const grpcOpts = (node['grpc-opts'] as Record<string, unknown> | undefined) ?? {}
      const serviceName = getMapString(grpcOpts, 'grpc-service-name').trim()
      if (serviceName) {
        stream.grpcSettings = {
          serviceName,
          ...(toBoolLike(getMapString(grpcOpts, 'multi-mode')) ? { multiMode: true } : {}),
        }
      }
    } else if (network === 'http' || network === 'h2') {
      stream.network = 'http'
      stream.httpSettings = {
        ...(httpHost ? { host: parseHostList(httpHost) } : {}),
        ...(httpPath ? { path: httpPath } : {}),
      }
    }
    if (Boolean(node.tls) || getMapString(node, 'tls').trim().toLowerCase() === 'true') {
      stream.security = 'tls'
      stream.tlsSettings = {
        ...(sni ? { serverName: sni } : {}),
        allowInsecure,
        ...(alpn.length > 0 ? { alpn } : {}),
      }
    }
    if (Object.keys(stream).length > 0) {
      out.streamSettings = stream
    }
    return { engine: 'xray', outbound: out }
  }
  if (type === 'vless') {
    const host = getMapString(node, 'server').trim()
    const port = getMapInt(node, 'port')
    const id = getMapString(node, 'uuid').trim()
    if (!host || port <= 0 || !id) {
      throw new Error('clash-vless 节点字段不完整')
    }
    const network = getMapString(node, 'network').trim().toLowerCase()
    const flow = getMapString(node, 'flow').trim()
    const sni = getMapString(node, 'sni').trim() || getMapString(node, 'servername').trim()
    const allowInsecure = Boolean(node['skip-cert-verify'])
    const alpn = parseCsv(getMapString(node, 'alpn').trim())
    const httpHost = firstNonEmpty(getMapString(node, 'http-host'), getMapString(node, 'host'))
    const httpPath = firstNonEmpty(getMapString(node, 'http-path'), getMapString(node, 'path'), '/')
    const realityOpts = (node['reality-opts'] as Record<string, unknown> | undefined) ?? {}
    const publicKey = getMapString(realityOpts, 'public-key').trim()
    const shortId = getMapString(realityOpts, 'short-id').trim()
    const fingerprint = getMapString(node, 'client-fingerprint').trim()
    const securityHint =
      getMapString(node, 'security').trim().toLowerCase() || getMapString(node, 'tls').trim().toLowerCase()
    const isReality = securityHint === 'reality' || publicKey.length > 0 || shortId.length > 0
    const out: Record<string, unknown> = {
      protocol: 'vless',
      tag: 'proxy-out',
      settings: {
        vnext: [{ address: host, port, users: [{ id, encryption: 'none', ...(flow ? { flow } : {}) }] }],
      },
    }
    const stream: Record<string, unknown> = {}
    if (network === 'ws') {
      stream.network = 'ws'
      const wsOpts = (node['ws-opts'] as Record<string, unknown> | undefined) ?? {}
      const wsPath = firstNonEmpty(getMapString(wsOpts, 'path'), getMapString(node, 'ws-path'))
      const headers = (wsOpts.headers as Record<string, unknown> | undefined) ?? {}
      const hostHeader = firstNonEmpty(getMapString(headers, 'Host'), getMapString(node, 'ws-host'))
      const ws: Record<string, unknown> = {}
      if (wsPath) ws.path = wsPath
      if (hostHeader) ws.headers = { Host: hostHeader }
      stream.wsSettings = ws
    } else if (network === 'grpc') {
      stream.network = 'grpc'
      const grpcOpts = (node['grpc-opts'] as Record<string, unknown> | undefined) ?? {}
      const serviceName = getMapString(grpcOpts, 'grpc-service-name').trim()
      if (serviceName) {
        stream.grpcSettings = {
          serviceName,
          ...(toBoolLike(getMapString(grpcOpts, 'multi-mode')) ? { multiMode: true } : {}),
        }
      }
    } else if (network === 'http' || network === 'h2') {
      stream.network = 'http'
      stream.httpSettings = {
        ...(httpHost ? { host: parseHostList(httpHost) } : {}),
        ...(httpPath ? { path: httpPath } : {}),
      }
    }
    if (Boolean(node.tls) || getMapString(node, 'tls').trim().toLowerCase() === 'true' || isReality) {
      if (isReality) {
        stream.security = 'reality'
        stream.realitySettings = {
          ...(sni ? { serverName: sni } : {}),
          ...(publicKey ? { publicKey } : {}),
          ...(shortId ? { shortId } : {}),
          ...(fingerprint ? { fingerprint } : {}),
          spiderX: '',
        }
      } else {
        stream.security = 'tls'
        stream.tlsSettings = {
          ...(sni ? { serverName: sni } : {}),
          allowInsecure,
          ...(alpn.length > 0 ? { alpn } : {}),
        }
      }
    }
    if (Object.keys(stream).length > 0) {
      out.streamSettings = stream
    }
    return { engine: 'xray', outbound: out }
  }
  if (type === 'trojan') {
    const host = getMapString(node, 'server').trim()
    const port = getMapInt(node, 'port')
    const password = getMapString(node, 'password').trim()
    if (!host || port <= 0 || !password) {
      throw new Error('clash-trojan 节点字段不完整')
    }
    const network = getMapString(node, 'network').trim().toLowerCase()
    const sni = getMapString(node, 'sni').trim() || getMapString(node, 'servername').trim()
    const allowInsecure = Boolean(node['skip-cert-verify'])
    const alpn = parseCsv(getMapString(node, 'alpn').trim())
    const httpHost = firstNonEmpty(getMapString(node, 'http-host'), getMapString(node, 'host'))
    const httpPath = firstNonEmpty(getMapString(node, 'http-path'), getMapString(node, 'path'), '/')
    const out: Record<string, unknown> = {
      protocol: 'trojan',
      tag: 'proxy-out',
      settings: {
        servers: [{ address: host, port, password }],
      },
    }
    const stream: Record<string, unknown> = {
      security: 'tls',
      tlsSettings: {
        ...(sni ? { serverName: sni } : {}),
        allowInsecure,
        ...(alpn.length > 0 ? { alpn } : {}),
      },
    }
    if (network === 'ws') {
      stream.network = 'ws'
      const wsOpts = (node['ws-opts'] as Record<string, unknown> | undefined) ?? {}
      const wsPath = firstNonEmpty(getMapString(wsOpts, 'path'), getMapString(node, 'ws-path'))
      const headers = (wsOpts.headers as Record<string, unknown> | undefined) ?? {}
      const hostHeader = firstNonEmpty(getMapString(headers, 'Host'), getMapString(node, 'ws-host'))
      const ws: Record<string, unknown> = {}
      if (wsPath) ws.path = wsPath
      if (hostHeader) ws.headers = { Host: hostHeader }
      stream.wsSettings = ws
    } else if (network === 'grpc') {
      stream.network = 'grpc'
      const grpcOpts = (node['grpc-opts'] as Record<string, unknown> | undefined) ?? {}
      const serviceName = getMapString(grpcOpts, 'grpc-service-name').trim()
      if (serviceName) {
        stream.grpcSettings = {
          serviceName,
          ...(toBoolLike(getMapString(grpcOpts, 'multi-mode')) ? { multiMode: true } : {}),
        }
      }
    } else if (network === 'http' || network === 'h2') {
      stream.network = 'http'
      stream.httpSettings = {
        ...(httpHost ? { host: parseHostList(httpHost) } : {}),
        ...(httpPath ? { path: httpPath } : {}),
      }
    }
    out.streamSettings = stream
    return { engine: 'xray', outbound: out }
  }
  if (type === 'ss' || type === 'shadowsocks') {
    const host = getMapString(node, 'server').trim()
    const port = getMapInt(node, 'port')
    const method = getMapString(node, 'cipher').trim() || getMapString(node, 'method').trim()
    const password = getMapString(node, 'password').trim()
    if (!host || port <= 0 || !method || !password) {
      throw new Error('clash-ss 节点字段不完整')
    }
    return {
      engine: 'xray',
      outbound: {
      protocol: 'shadowsocks',
      tag: 'proxy-out',
      settings: {
        servers: [{ address: host, port, method, password }],
      },
      },
    }
  }
  if (type === 'hysteria2' || type === 'hysteria') {
    const server = getMapString(node, 'server').trim()
    const serverPort = getMapInt(node, 'port')
    const password = getMapString(node, 'password').trim()
    const sni = firstNonEmpty(getMapString(node, 'sni'), getMapString(node, 'servername'))
    const insecure = Boolean(node['skip-cert-verify'])
    const obfs = getMapString(node, 'obfs').trim()
    const obfsPassword = firstNonEmpty(
      getMapString(node, 'obfs-password'),
      getMapString(node, 'obfs_password'),
    )
    const upMbps = getMapInt(node, 'up')
    const downMbps = getMapInt(node, 'down')
    if (!server || serverPort <= 0 || !password) {
      throw new Error('clash-hysteria2 节点字段不完整')
    }
    return {
      engine: 'sing-box',
      outbound: {
        type: 'hysteria2',
        tag: 'proxy-out',
        server,
        server_port: serverPort,
        password,
        tls: {
          enabled: true,
          ...(sni ? { server_name: sni } : {}),
          ...(insecure ? { insecure: true } : {}),
        },
        ...(obfs ? { obfs } : {}),
        ...(obfsPassword ? { obfs_password: obfsPassword } : {}),
        ...(upMbps > 0 ? { up_mbps: upMbps } : {}),
        ...(downMbps > 0 ? { down_mbps: downMbps } : {}),
      },
    }
  }
  if (type === 'tuic') {
    const server = getMapString(node, 'server').trim()
    const serverPort = getMapInt(node, 'port')
    const uuid = getMapString(node, 'uuid').trim()
    const password = getMapString(node, 'password').trim()
    const sni = firstNonEmpty(getMapString(node, 'sni'), getMapString(node, 'servername'))
    const insecure = Boolean(node['skip-cert-verify'])
    const congestion = firstNonEmpty(
      getMapString(node, 'congestion-controller'),
      getMapString(node, 'congestion_control'),
    )
    const udpOverTcp = toBoolLike(
      firstNonEmpty(getMapString(node, 'udp-over-tcp'), getMapString(node, 'udp_over_tcp')),
    )
    if (!server || serverPort <= 0 || !uuid || !password) {
      throw new Error('clash-tuic 节点字段不完整')
    }
    return {
      engine: 'sing-box',
      outbound: {
        type: 'tuic',
        tag: 'proxy-out',
        server,
        server_port: serverPort,
        uuid,
        password,
        ...(congestion ? { congestion_control: congestion } : {}),
        ...(udpOverTcp ? { udp_over_tcp: true } : {}),
        tls: {
          enabled: true,
          ...(sni ? { server_name: sni } : {}),
          ...(insecure ? { insecure: true } : {}),
        },
      },
    }
  }
  throw new Error(`clash 节点类型暂不支持桥接: ${type}`)
}

function bridgeWorkRoot(): string {
  const stateRoot = getAppStateRoot().trim()
  if (stateRoot) {
    return join(stateRoot, '_xray')
  }
  return join(tmpdir(), 'nexbrowser-desktop', '_xray')
}

function toGoPlatformTuple(): { goos: string; goarch: string } {
  const p = platform()
  const a = arch()
  const goos = p === 'win32' ? 'windows' : p
  const goarch = a === 'x64' ? 'amd64' : a === 'ia32' ? '386' : a
  return { goos, goarch }
}

function resolveBridgeBinaryPath(engine: BridgeEngine): string {
  const cfg = loadProxyBridgeBinaryPaths()
  const configPath = engine === 'xray' ? cfg.xrayBinaryPath.trim() : cfg.singboxBinaryPath.trim()
  const envPath = process.env[engine === 'xray' ? 'XRAY_BINARY_PATH' : 'SINGBOX_BINARY_PATH']?.trim() ?? ''
  const binaryNames =
    engine === 'xray'
      ? process.platform === 'win32'
        ? ['xray.exe', 'xray']
        : ['xray']
      : process.platform === 'win32'
        ? ['sing-box.exe', 'sing-box']
        : ['sing-box']

  const appRoot = process.cwd()
  const exeDir = dirname(process.execPath)
  const { goos, goarch } = toGoPlatformTuple()
  const platformDir = `${goos}-${goarch}`
  const legacyPlatformDir = `${platform()}-${arch()}`
  const searchDirs = [
    join(appRoot, 'bin', platformDir),
    join(appRoot, 'bin', legacyPlatformDir),
    join(appRoot, 'bin'),
    join(exeDir, 'bin', platformDir),
    join(exeDir, 'bin', legacyPlatformDir),
    join(exeDir, 'bin'),
  ]

  const assertExecutable = (candidate: string): string | null => {
    if (!existsSync(candidate)) return null
    if (process.platform !== 'win32') {
      try {
        accessSync(candidate, constants.X_OK)
      } catch {
        throw new Error(`桥接二进制不可执行: ${candidate}`)
      }
    }
    return candidate
  }

  const resolveUserPath = (raw: string): string => {
    if (!raw) return ''
    const trimmed = raw.trim()
    if (!trimmed) return ''
    const candidates = isAbsolute(trimmed)
      ? [trimmed]
      : [resolve(appRoot, trimmed), resolve(exeDir, trimmed), resolve(trimmed)]
    for (const candidate of candidates) {
      const ok = assertExecutable(candidate)
      if (ok) return ok
    }
    return ''
  }

  const fromConfig = resolveUserPath(configPath)
  if (fromConfig) return fromConfig
  const fromEnv = resolveUserPath(envPath)
  if (fromEnv) return fromEnv

  for (const dir of searchDirs) {
    for (const name of binaryNames) {
      const ok = assertExecutable(join(dir, name))
      if (ok) return ok
    }
  }

  // 最后兜底交给 PATH，保留与 Go 一致的查找语义
  return binaryNames[0]!
}

function writeXrayRuntimeConfig(
  key: string,
  port: number,
  outbound: Record<string, unknown>,
  dnsServers: string,
): BridgeRunFiles {
  const base = join(bridgeWorkRoot(), key)
  mkdirSync(base, { recursive: true })
  const configPath = join(base, 'xray-config.json')
  const errorLogPath = join(base, 'bridge-stderr.log')
  const payload = {
    log: { loglevel: 'warning', error: errorLogPath },
    inbounds: [
      {
        tag: 'socks-in',
        port,
        listen: '127.0.0.1',
        protocol: 'socks',
        settings: { udp: true },
      },
    ],
    outbounds: [
      outbound,
      { protocol: 'direct', tag: 'direct' },
      { protocol: 'blackhole', tag: 'block' },
    ],
    routing: {
      rules: [{ type: 'field', inboundTag: ['socks-in'], outboundTag: 'proxy-out' }],
    },
    ...(parseBridgeDnsConfig(dnsServers) ? { dns: parseBridgeDnsConfig(dnsServers) } : {}),
  }
  writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8')
  return { configPath, stderrPath: errorLogPath }
}

function writeSingBoxRuntimeConfig(
  key: string,
  port: number,
  outbound: Record<string, unknown>,
): BridgeRunFiles {
  const base = join(bridgeWorkRoot(), key)
  mkdirSync(base, { recursive: true })
  const configPath = join(base, 'sing-box-config.json')
  const stderrPath = join(base, 'bridge-stderr.log')
  const payload = {
    log: { level: 'warn' },
    inbounds: [
      {
        type: 'socks',
        tag: 'socks-in',
        listen: '127.0.0.1',
        listen_port: port,
      },
    ],
    outbounds: [
      outbound,
      { type: 'direct', tag: 'direct' },
      { type: 'block', tag: 'block' },
    ],
    route: {
      rules: [{ inbound: 'socks-in', outbound: 'proxy-out' }],
      final: 'proxy-out',
    },
  }
  writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8')
  return { configPath, stderrPath }
}

async function killChild(child: ChildProcess): Promise<void> {
  const pid = child.pid ?? 0
  if (pid <= 0) {
    return
  }
  try {
    if (process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      })
      return
    }
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
}

function detachBridge(key: string): void {
  const item = bridges.get(key)
  if (!item) return
  item.child.once('exit', (code, signal) => {
    const cur = bridges.get(key)
    if (cur && cur === item) {
      bridges.delete(key)
    }
    if (!item.stopping) {
      emitWailsEvent('proxy:bridge:died', {
        key,
        engine: item.engine,
        pid: item.child.pid ?? 0,
        code: code ?? null,
        signal: signal ?? null,
      })
    }
  })
}

function recycleIdleBridges(): void {
  const t = nowMs()
  for (const [k, b] of bridges) {
    if (b.refCount > 0) continue
    if (t - b.lastUsedAt < BRIDGE_IDLE_TTL_MS) continue
    bridges.delete(k)
    b.stopping = true
    void killChild(b.child)
  }
}

setInterval(recycleIdleBridges, 15_000).unref()

function hasYamlBridgeType(source: string): boolean {
  const low = source.toLowerCase()
  const yamlTypeMatch = low.match(/(?:^|\n)\s*-?\s*type\s*:\s*([a-z0-9_-]+)/)
  const yamlType = String(yamlTypeMatch?.[1] ?? '').trim()
  return (
    yamlType === 'vmess' ||
    yamlType === 'vless' ||
    yamlType === 'trojan' ||
    yamlType === 'ss' ||
    yamlType === 'hysteria2' ||
    yamlType === 'hysteria' ||
    yamlType === 'tuic'
  )
}

export function proxyNeedsBridge(rawProxy: string): boolean {
  const source = normalizeProxySource(rawProxy)
  if (isNativeProxy(source)) return false
  const low = source.toLowerCase()
  return (
    low.startsWith('vmess://') ||
    low.startsWith('vless://') ||
    low.startsWith('trojan://') ||
    low.startsWith('ss://') ||
    low.startsWith('hysteria2://') ||
    low.startsWith('hysteria://') ||
    low.startsWith('tuic://') ||
    low.startsWith('clash://') ||
    source.includes('proxies:') ||
    hasYamlBridgeType(source)
  )
}

export async function acquireProxyBridgeForProfile(
  profileId: string,
  rawProxy: string,
  dnsServers = '',
): Promise<{ proxyServer: string; warning: string }> {
  const source = normalizeProxySource(rawProxy)
  if (!proxyNeedsBridge(source)) {
    return { proxyServer: '', warning: '' }
  }

  const key = makeNodeKey(source)
  const current = bridges.get(key)
  if (current && current.child.exitCode === null && current.child.signalCode === null) {
    current.refCount++
    current.lastUsedAt = nowMs()
    profileBridgeKey.set(profileId.trim(), key)
    console.info('[Bridge] reuse', {
      profileId: profileId.trim(),
      key,
      engine: current.engine,
      port: current.port,
      refCount: current.refCount,
    })
    return { proxyServer: `socks5://127.0.0.1:${current.port}`, warning: '' }
  }
  if (current) {
    bridges.delete(key)
  }

  const plan = buildPlanFromProxy(source)
  const port = await allocateLocalPort()
  const runFiles =
    plan.engine === 'xray'
      ? writeXrayRuntimeConfig(key, port, plan.outbound, dnsServers)
      : writeSingBoxRuntimeConfig(key, port, plan.outbound)
  const binary = resolveBridgeBinaryPath(plan.engine)
  console.info('[Bridge] spawn', {
    profileId: profileId.trim(),
    key,
    engine: plan.engine,
    port,
    binary,
  })
  const child = spawn(binary, ['run', '-c', runFiles.configPath], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: false,
  })
  const startupErrorRef: { error: Error | null } = { error: null }
  child.once('error', (err) => {
    startupErrorRef.error = err instanceof Error ? err : new Error(String(err))
  })
  const stderrChunks: Buffer[] = []
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  })
  child.stderr?.on('close', () => {
    try {
      if (stderrChunks.length > 0) {
        writeFileSync(runFiles.stderrPath, Buffer.concat(stderrChunks))
      }
    } catch {
      /* ignore */
    }
  })

  try {
    await waitBridgePortReady(port, 10_000, child, startupErrorRef)
  } catch (e) {
    await killChild(child)
    const logText = extractBridgeErrorLog(runFiles.stderrPath)
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.toLowerCase().includes('enoent')) {
      const { goos, goarch } = toGoPlatformTuple()
      throw new Error(
        `桥接二进制不存在或不可执行: ${binary}。请将其放到 bin/${goos}-${goarch}/ 或 bin/，或在配置中设置 ${
          plan.engine === 'xray' ? 'browser.xray_binary_path' : 'browser.singbox_binary_path'
        }`,
      )
    }
    if (logText) {
      console.error('[Bridge] startup failed with log', {
        profileId: profileId.trim(),
        key,
        engine: plan.engine,
        port,
        error: msg,
        stderrPath: runFiles.stderrPath,
      })
      throw new Error(`${msg}；${plan.engine} 日志: ${runFiles.stderrPath}`)
    }
    console.error('[Bridge] startup failed', {
      profileId: profileId.trim(),
      key,
      engine: plan.engine,
      port,
      error: msg,
    })
    throw new Error(msg)
  }

  const entry: BridgeEntry = {
    key,
    port,
    child,
    refCount: 1,
    lastUsedAt: nowMs(),
    engine: plan.engine,
    stopping: false,
  }
  bridges.set(key, entry)
  profileBridgeKey.set(profileId.trim(), key)
  console.info('[Bridge] ready', {
    profileId: profileId.trim(),
    key,
    engine: plan.engine,
    port,
    pid: child.pid ?? 0,
  })
  detachBridge(key)
  return { proxyServer: `socks5://127.0.0.1:${port}`, warning: '' }
}

export function releaseProxyBridgeForProfile(profileId: string): void {
  const id = profileId.trim()
  const key = profileBridgeKey.get(id)
  if (!key) return
  profileBridgeKey.delete(id)
  const bridge = bridges.get(key)
  if (!bridge) return
  if (bridge.refCount > 0) {
    bridge.refCount--
  }
  bridge.lastUsedAt = nowMs()
  console.info('[Bridge] release', {
    profileId: id,
    key,
    engine: bridge.engine,
    port: bridge.port,
    refCount: bridge.refCount,
  })
}

export async function stopAllProxyBridges(): Promise<void> {
  const items = [...bridges.values()]
  bridges.clear()
  profileBridgeKey.clear()
  if (items.length > 0) {
    console.info('[Bridge] stopAll', { count: items.length })
  }
  for (const it of items) {
    it.stopping = true
  }
  await Promise.all(items.map((it) => killChild(it.child)))
}

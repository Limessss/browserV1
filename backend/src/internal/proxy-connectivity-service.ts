/**
 * 代理连通性 / 测速（TCP RTT，对齐 Ant-Browser proxy.TestConnectivity；完整 mihomo 测速后续再接）。
 */
import { Socket } from 'node:net'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Database } from 'sql.js'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

import { listProxies } from './browser-data'
import { loadProxyIsolationEnabled } from './app-config-store'
import { persistSqlite } from './database/sqlite-store'
import { proxyTcpTarget } from './proxy-endpoint'
import {
  acquireProxyBridgeForProfile,
  formatBridgeErrorForWarning,
  shouldUseProxyBridge,
  releaseProxyBridgeForProfile,
  type ProxyBridgeOptions,
} from './proxy-bridge-service'

function currentProxyBridgeOptions(): ProxyBridgeOptions {
  return { isolateFromSystemProxy: loadProxyIsolationEnabled() }
}

export type ProxyTestResult = {
  proxyId: string
  ok: boolean
  latencyMs: number
  error: string
}

export type ProxyIPHealthResult = {
  proxyId: string
  ok: boolean
  source: string
  error: string
  errorCode?: string
  ip: string
  fraudScore: number
  isResidential: boolean
  isBroadcast: boolean
  country: string
  region: string
  city: string
  asOrganization: string
  rawData: Record<string, unknown>
  updatedAt: string
}

const TCP_TIMEOUT_MS = 10_000
const IPPURE_INFO_URL = 'https://my.ippure.com/v1/info'
const REAL_SPEED_TEST_URL = 'http://www.gstatic.com/generate_204'

const IP_HEALTH_ERROR = {
  NO_PROXY: 'NO_PROXY',
  DIRECT_UNSUPPORTED: 'DIRECT_UNSUPPORTED',
  BRIDGE_FAILED: 'BRIDGE_FAILED',
  REQUEST_FAILED: 'REQUEST_FAILED',
  RESPONSE_INVALID: 'RESPONSE_INVALID',
  REQUEST_TIMEOUT: 'REQUEST_TIMEOUT',
} as const

function resolveProxyBinding(
  db: Database,
  proxyId: string,
  proxyConfig: string,
): { proxyConfig: string; dnsServers: string } {
  let src = proxyConfig.trim()
  let dnsServers = ''
  const pid = proxyId.trim()
  if (!pid) {
    return { proxyConfig: src, dnsServers }
  }
  const proxies = listProxies(db)
  for (const p of proxies) {
    const row = p as Record<string, unknown>
    if (String(row.proxyId ?? '').toLowerCase() === pid.toLowerCase()) {
      src = String(row.proxyConfig ?? '').trim()
      dnsServers = String(row.dnsServers ?? '').trim()
      break
    }
  }
  return { proxyConfig: src, dnsServers }
}

export function tcpPing(host: string, port: number, timeoutMs = TCP_TIMEOUT_MS): Promise<{
  ok: boolean
  latencyMs: number
  error: string
}> {
  return new Promise((resolve) => {
    const start = Date.now()
    let settled = false
    const sock = new Socket()

    const finish = (ok: boolean, error: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      resolve({ ok, latencyMs: Date.now() - start, error })
    }

    const timer = setTimeout(() => {
      finish(false, 'timeout')
    }, timeoutMs)

    sock.once('connect', () => finish(true, ''))
    sock.once('error', (err: Error) => finish(false, err.message))

    try {
      sock.connect(port, host)
    } catch (err) {
      finish(false, err instanceof Error ? err.message : String(err))
    }
  })
}

function createProxyAgent(proxyUrl: string, targetUrl: string): http.Agent | https.Agent {
  const low = proxyUrl.toLowerCase()
  if (low.startsWith('socks5://') || low.startsWith('socks5h://') || low.startsWith('socks://')) {
    return new SocksProxyAgent(proxyUrl)
  }
  if (targetUrl.startsWith('https:')) {
    return new HttpsProxyAgent(proxyUrl)
  }
  return new HttpProxyAgent(proxyUrl)
}

function normalizeProxyUrlForHttpClient(raw: string): string {
  const src = String(raw ?? '').trim()
  if (!src) {
    throw new Error('代理配置为空')
  }
  const low = src.toLowerCase()
  if (
    low.startsWith('http://') ||
    low.startsWith('https://') ||
    low.startsWith('socks5://') ||
    low.startsWith('socks5h://') ||
    low.startsWith('socks://')
  ) {
    return src
  }
  // 常见写法：127.0.0.1:7890 / localhost:7890，默认按 HTTP 代理处理
  if (/^[^:/\s]+:\d+$/.test(src)) {
    return `http://${src}`
  }
  throw new Error(`代理地址格式无效: ${src}`)
}

async function requestJson(urlStr: string, proxyUrl: string | null): Promise<Record<string, unknown>> {
  const effectiveProxyUrl = proxyUrl ? normalizeProxyUrlForHttpClient(proxyUrl) : null
  let currentUrl = urlStr
  for (let hop = 0; hop < 8; hop++) {
    const output = await new Promise<{ kind: 'done'; json: Record<string, unknown> } | { kind: 'redirect'; url: string }>(
      (resolve, reject) => {
        let u: URL
        try {
          u = new URL(currentUrl)
        } catch (e) {
          reject(new Error(`IPPure URL 无效: ${e instanceof Error ? e.message : String(e)}`))
          return
        }
        const isHttps = u.protocol === 'https:'
        const lib = isHttps ? https : http
        const agent = effectiveProxyUrl ? createProxyAgent(effectiveProxyUrl, currentUrl) : undefined
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: `${u.pathname}${u.search}`,
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'NexBrowser-Desktop/1.0' },
            agent,
          },
          (res) => {
            const status = Number(res.statusCode ?? 0)
            if (status >= 300 && status < 400 && res.headers.location) {
              try {
                const next = new URL(String(res.headers.location), currentUrl).toString()
                resolve({ kind: 'redirect', url: next })
                return
              } catch (e) {
                reject(new Error(`IPPure 重定向地址无效: ${e instanceof Error ? e.message : String(e)}`))
                return
              }
            }
            const chunks: Buffer[] = []
            res.on('data', (chunk: Buffer) => chunks.push(chunk))
            res.on('end', () => {
              const body = Buffer.concat(chunks).toString('utf8')
              if (status < 200 || status >= 300) {
                reject(new Error(`IPPure HTTP ${status}: ${body.slice(0, 180)}`))
                return
              }
              try {
                const json = JSON.parse(body) as Record<string, unknown>
                resolve({ kind: 'done', json })
              } catch (e) {
                reject(new Error(`IPPure JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`))
              }
            })
            res.on('error', (err) => reject(err))
          },
        )
        req.setTimeout(20_000, () => req.destroy(new Error('IPPure 请求超时（20s）')))
        req.on('error', reject)
        req.end()
      },
    )
    if (output.kind === 'done') {
      return output.json
    }
    currentUrl = output.url
  }
  throw new Error('IPPure 重定向过多')
}

async function requestStatus(urlStr: string, proxyUrl: string | null): Promise<number> {
  const effectiveProxyUrl = proxyUrl ? normalizeProxyUrlForHttpClient(proxyUrl) : null
  let currentUrl = urlStr
  for (let hop = 0; hop < 8; hop++) {
    const output = await new Promise<{ kind: 'done'; status: number } | { kind: 'redirect'; url: string }>(
      (resolve, reject) => {
        let u: URL
        try {
          u = new URL(currentUrl)
        } catch (e) {
          reject(new Error(`测速 URL 无效: ${e instanceof Error ? e.message : String(e)}`))
          return
        }
        const isHttps = u.protocol === 'https:'
        const lib = isHttps ? https : http
        const agent = effectiveProxyUrl ? createProxyAgent(effectiveProxyUrl, currentUrl) : undefined
        const req = lib.request(
          {
            hostname: u.hostname,
            port: u.port || (isHttps ? 443 : 80),
            path: `${u.pathname}${u.search}`,
            method: 'GET',
            headers: { 'User-Agent': 'NexBrowser-Desktop/1.0' },
            agent,
          },
          (res) => {
            const status = Number(res.statusCode ?? 0)
            if (status >= 300 && status < 400 && res.headers.location) {
              try {
                const next = new URL(String(res.headers.location), currentUrl).toString()
                resolve({ kind: 'redirect', url: next })
                return
              } catch (e) {
                reject(new Error(`测速重定向地址无效: ${e instanceof Error ? e.message : String(e)}`))
                return
              }
            }
            res.resume()
            resolve({ kind: 'done', status })
          },
        )
        req.setTimeout(15_000, () => req.destroy(new Error('测速请求超时（15s）')))
        req.on('error', reject)
        req.end()
      },
    )
    if (output.kind === 'done') {
      return output.status
    }
    currentUrl = output.url
  }
  throw new Error('测速重定向过多')
}

function boolLike(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes'
}

function numLike(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function strLike(value: unknown): string {
  return String(value ?? '').trim()
}

function normalizeIPPureResult(
  proxyId: string,
  raw: Record<string, unknown>,
  testedAt: string,
): ProxyIPHealthResult {
  const data = (raw.data as Record<string, unknown>) ?? raw
  const geo = (data.geo as Record<string, unknown>) ?? {}
  const ip = strLike(
    data.ip ||
      data.query ||
      raw.ip ||
      (raw.data as Record<string, unknown> | undefined)?.ip ||
      (raw.result as Record<string, unknown> | undefined)?.ip,
  )
  const country = strLike(data.country || data.country_name || geo.country || raw.country)
  const region = strLike(data.region || data.province || geo.region || raw.region)
  const city = strLike(data.city || geo.city || raw.city)
  const asOrganization = strLike(
    data.as_organization ||
      data.asOrganization ||
      data.organization ||
      (data.as as Record<string, unknown> | undefined)?.organization ||
      raw.as_organization,
  )
  const fraudScore = numLike(data.fraud_score ?? data.fraudScore ?? raw.fraud_score)
  const isResidential = boolLike(data.is_residential ?? data.isResidential ?? raw.is_residential)
  const isBroadcast = boolLike(data.is_broadcast ?? data.isBroadcast ?? raw.is_broadcast)
  return {
    proxyId,
    ok: ip.length > 0,
    source: 'ippure',
    error: ip.length > 0 ? '' : 'IPPure 返回缺少出口 IP',
    errorCode: ip.length > 0 ? '' : IP_HEALTH_ERROR.RESPONSE_INVALID,
    ip,
    fraudScore,
    isResidential,
    isBroadcast,
    country,
    region,
    city,
    asOrganization,
    rawData: raw,
    updatedAt: testedAt,
  }
}

function inferIPHealthErrorCode(message: string): string {
  const msg = String(message ?? '').toLowerCase()
  if (!msg) return IP_HEALTH_ERROR.REQUEST_FAILED
  if (msg.includes('超时') || msg.includes('timeout')) return IP_HEALTH_ERROR.REQUEST_TIMEOUT
  if (msg.includes('json') || msg.includes('缺少出口 ip') || msg.includes('response_invalid')) {
    return IP_HEALTH_ERROR.RESPONSE_INVALID
  }
  return IP_HEALTH_ERROR.REQUEST_FAILED
}

function persistIPHealthResult(db: Database, proxyId: string, result: ProxyIPHealthResult): void {
  try {
    db.run(`UPDATE browser_proxies SET last_ip_health_json = ? WHERE proxy_id = ?`, [
      JSON.stringify(result),
      proxyId.trim(),
    ])
    persistSqlite()
  } catch {
    /* ignore persist errors */
  }
}

function baseResult(proxyId: string, ok: boolean, latencyMs: number, error: string): ProxyTestResult {
  return { proxyId, ok, latencyMs, error }
}

export async function testProxyConnectivity(
  db: Database,
  proxyId: string,
  proxyConfig: string,
): Promise<ProxyTestResult> {
  const pid = proxyId.trim()
  const binding = resolveProxyBinding(db, pid, proxyConfig)
  const src = binding.proxyConfig
  if (!src) {
    return baseResult(pid, false, 0, '代理配置为空')
  }

  let effectiveSrc = src
  let tempBridgeProfileId = ''
  const bridgeOptions = currentProxyBridgeOptions()
  try {
    if (shouldUseProxyBridge(src, bridgeOptions)) {
      tempBridgeProfileId = `proxy-test:${pid || 'temp'}:${Date.now()}`
      try {
        const bridge = await acquireProxyBridgeForProfile(
          tempBridgeProfileId,
          src,
          binding.dnsServers,
          bridgeOptions,
        )
        if (bridge.proxyServer) {
          effectiveSrc = bridge.proxyServer
        }
      } catch (e) {
        return baseResult(pid, false, 0, formatBridgeErrorForWarning(e))
      }
    }

    const target = proxyTcpTarget(effectiveSrc)
    if (target === null) {
      return baseResult(pid, false, 0, '无法解析代理地址')
    }
    if (target.kind === 'direct') {
      return baseResult(pid, true, 0, '')
    }

    const r = await tcpPing(target.host, target.port)
    return baseResult(pid, r.ok, r.latencyMs, r.error)
  } finally {
    if (tempBridgeProfileId) {
      releaseProxyBridgeForProfile(tempBridgeProfileId)
    }
  }
}

/** 与 TestProxyConnectivity 相同实现（Go 侧 Real 走 SpeedTest；此处暂无隧桥，先 TCP） */
export async function testProxyRealConnectivity(db: Database, proxyId: string): Promise<ProxyTestResult> {
  const pid = proxyId.trim()
  const binding = resolveProxyBinding(db, pid, '')
  const src = binding.proxyConfig
  if (!src) {
    return baseResult(pid, false, 0, '代理配置为空')
  }

  let proxyUrl: string | null = src
  let tempBridgeProfileId = ''
  const start = Date.now()
  const bridgeOptions = currentProxyBridgeOptions()
  try {
    if (shouldUseProxyBridge(src, bridgeOptions)) {
      tempBridgeProfileId = `proxy-real-test:${pid || 'temp'}:${Date.now()}`
      try {
        const bridge = await acquireProxyBridgeForProfile(
          tempBridgeProfileId,
          src,
          binding.dnsServers,
          bridgeOptions,
        )
        proxyUrl = bridge.proxyServer || null
      } catch (e) {
        return baseResult(pid, false, 0, formatBridgeErrorForWarning(e))
      }
    }
    if (!proxyUrl) {
      return baseResult(pid, false, 0, '代理配置为空')
    }
    if (proxyUrl.toLowerCase() === 'direct://') {
      return baseResult(pid, true, 0, '')
    }
    const status = await requestStatus(REAL_SPEED_TEST_URL, proxyUrl)
    const latency = Date.now() - start
    if (status !== 204) {
      return baseResult(pid, false, latency, `HTTP ${status}`)
    }
    return baseResult(pid, true, latency, '')
  } catch (e) {
    const latency = Date.now() - start
    return baseResult(pid, false, latency, e instanceof Error ? e.message : String(e))
  } finally {
    if (tempBridgeProfileId) {
      releaseProxyBridgeForProfile(tempBridgeProfileId)
    }
  }
}

export async function browserProxyTestSpeed(db: Database, proxyId: string): Promise<ProxyTestResult> {
  const r = await testProxyRealConnectivity(db, proxyId)
  const testedAt = new Date().toISOString()
  db.run(
    `UPDATE browser_proxies SET last_latency_ms = ?, last_test_ok = ?, last_tested_at = ? WHERE proxy_id = ?`,
    [r.latencyMs, r.ok ? 1 : 0, testedAt, proxyId.trim()],
  )
  persistSqlite()
  return r
}

async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.min(Math.max(1, concurrency), Math.max(1, items.length))

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      results[i] = await mapper(items[i]!, i)
    }
  }

  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

export async function browserProxyBatchTestSpeed(
  db: Database,
  proxyIds: string[],
  concurrency: number,
): Promise<ProxyTestResult[]> {
  const ids = Array.isArray(proxyIds) ? proxyIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  if (ids.length === 0) return []

  let c = Number(concurrency) || 20
  if (c <= 0) c = 20
  if (c > ids.length) c = ids.length

  return mapLimit(ids, c, async (proxyId) => browserProxyTestSpeed(db, proxyId))
}

export async function browserProxyCheckIPHealth(
  db: Database,
  proxyId: string,
): Promise<ProxyIPHealthResult> {
  const pid = proxyId.trim()
  const testedAt = new Date().toISOString()
  const binding = resolveProxyBinding(db, pid, '')
  const src = binding.proxyConfig
  if (!src) {
    const result: ProxyIPHealthResult = {
      proxyId: pid,
      ok: false,
      source: 'ippure',
      error: '未找到代理配置',
      errorCode: IP_HEALTH_ERROR.NO_PROXY,
      ip: '',
      fraudScore: 0,
      isResidential: false,
      isBroadcast: false,
      country: '',
      region: '',
      city: '',
      asOrganization: '',
      rawData: {},
      updatedAt: testedAt,
    }
    persistIPHealthResult(db, pid, result)
    return result
  }

  let bridgeRef = ''
  let proxyUrl: string | null = src
  const bridgeOptions = currentProxyBridgeOptions()
  try {
    if (shouldUseProxyBridge(src, bridgeOptions)) {
      bridgeRef = `proxy-ippure:${pid || 'temp'}:${Date.now()}`
      const bridge = await acquireProxyBridgeForProfile(
        bridgeRef,
        src,
        binding.dnsServers,
        bridgeOptions,
      )
      proxyUrl = bridge.proxyServer || null
    }
    if (!proxyUrl || proxyUrl.toLowerCase() === 'direct://') {
      const result: ProxyIPHealthResult = {
        proxyId: pid,
        ok: false,
        source: 'ippure',
        error: '当前代理不可用于出口检测（direct）',
        errorCode: IP_HEALTH_ERROR.DIRECT_UNSUPPORTED,
        ip: '',
        fraudScore: 0,
        isResidential: false,
        isBroadcast: false,
        country: '',
        region: '',
        city: '',
        asOrganization: '',
        rawData: {},
        updatedAt: testedAt,
      }
      persistIPHealthResult(db, pid, result)
      return result
    }
    const raw = await requestJson(IPPURE_INFO_URL, proxyUrl)
    const result = normalizeIPPureResult(pid, raw, testedAt)
    persistIPHealthResult(db, pid, result)
    return result
  } catch (e) {
    const bridgeMode = shouldUseProxyBridge(src, bridgeOptions)
    const msg = bridgeMode ? formatBridgeErrorForWarning(e) : (e instanceof Error ? e.message : String(e))
    const result: ProxyIPHealthResult = {
      proxyId: pid,
      ok: false,
      source: 'ippure',
      error: msg,
      errorCode: bridgeMode ? IP_HEALTH_ERROR.BRIDGE_FAILED : inferIPHealthErrorCode(msg),
      ip: '',
      fraudScore: 0,
      isResidential: false,
      isBroadcast: false,
      country: '',
      region: '',
      city: '',
      asOrganization: '',
      rawData: {},
      updatedAt: testedAt,
    }
    persistIPHealthResult(db, pid, result)
    return result
  } finally {
    if (bridgeRef) {
      releaseProxyBridgeForProfile(bridgeRef)
    }
  }
}

export async function browserProxyBatchCheckIPHealth(
  db: Database,
  proxyIds: string[],
  concurrency: number,
): Promise<ProxyIPHealthResult[]> {
  const ids = Array.isArray(proxyIds) ? proxyIds.map((x) => String(x ?? '').trim()).filter(Boolean) : []
  if (ids.length === 0) return []

  let c = Number(concurrency) || 10
  if (c <= 0) c = 10
  if (c > ids.length) c = ids.length

  return mapLimit(ids, c, async (proxyId) => browserProxyCheckIPHealth(db, proxyId))
}

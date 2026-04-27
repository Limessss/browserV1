/**
 * 从代理配置解析 TCP 目标 host/port（对齐 Ant-Browser proxy.proxyEndpoint）。
 */
import {
  decodeBase64Text,
  pickClashNode,
  parseClashPayload,
  getMapInt,
  getMapString,
} from './clash-import'

export type TcpTarget =
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'direct' }

export function proxyTcpTarget(src: string): TcpTarget | null {
  const raw = src.trim()
  const low = raw.toLowerCase()
  if (!raw) {
    return null
  }
  if (low === 'direct://') {
    return { kind: 'direct' }
  }

  if (
    low.startsWith('http://') ||
    low.startsWith('https://') ||
    low.startsWith('socks5://') ||
    low.startsWith('socks5h://')
  ) {
    try {
      const u = new URL(raw)
      const host = u.hostname
      if (!host) return null
      const proto = u.protocol.toLowerCase()
      let port: number
      if (u.port) {
        port = parseInt(u.port, 10)
      } else if (proto === 'socks5:' || proto === 'socks5h:') {
        port = 1080
      } else {
        port = defaultUrlPort(proto)
      }
      if (!Number.isFinite(port) || port <= 0) {
        return null
      }
      return { kind: 'tcp', host, port }
    } catch {
      return null
    }
  }

  if (low.startsWith('vmess://')) {
    const decodedStr = decodeBase64Text(raw.slice('vmess://'.length).trim())
    if (!decodedStr) return null
    try {
      const j = JSON.parse(decodedStr) as { add?: string; port?: number | string }
      const host = String(j.add ?? '').trim()
      const port = typeof j.port === 'number' ? j.port : parseInt(String(j.port ?? ''), 10)
      if (host && Number.isFinite(port) && port > 0) {
        return { kind: 'tcp', host, port }
      }
    } catch {
      return null
    }
    return null
  }

  if (low.startsWith('vless://') || low.startsWith('trojan://')) {
    const schemeLen = low.startsWith('vless://') ? 'vless://'.length : 'trojan://'.length
    const rest = raw.slice(schemeLen)
    const at = rest.lastIndexOf('@')
    if (at < 0) return null
    let hostPart = rest.slice(at + 1).split(/[/?#]/)[0] ?? ''
    hostPart = hostPart.trim()
    if (!hostPart) return null
    if (hostPart.startsWith('[')) {
      const close = hostPart.indexOf(']')
      if (close > 0) {
        const host = hostPart.slice(1, close)
        const colon = hostPart.indexOf(':', close)
        const port = colon >= 0 ? parseInt(hostPart.slice(colon + 1), 10) : 443
        if (host && Number.isFinite(port) && port > 0) return { kind: 'tcp', host, port }
      }
      return null
    }
    const colonIdx = hostPart.lastIndexOf(':')
    if (colonIdx < 0) {
      return { kind: 'tcp', host: hostPart, port: 443 }
    }
    const host = hostPart.slice(0, colonIdx)
    const port = parseInt(hostPart.slice(colonIdx + 1), 10)
    if (host && Number.isFinite(port) && port > 0) {
      return { kind: 'tcp', host, port }
    }
    return null
  }

  const clashPayload = parseClashPayload(raw)
  if (clashPayload != null) {
    const node = pickClashNode(clashPayload)
    const server = node ? getMapString(node, 'server').trim() : ''
    const port = node ? getMapInt(node, 'port') : 0
    if (server && port > 0) {
      return { kind: 'tcp', host: server, port }
    }
  }

  return null
}

function defaultUrlPort(protocol: string): number {
  const p = protocol.toLowerCase()
  if (p === 'https:') return 443
  if (p === 'http:') return 80
  return 80
}

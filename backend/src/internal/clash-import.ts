/**
 * Clash 订阅正文规范化与统计（对齐 Ant-Browser app_proxy_import.go）。
 */
import yaml from 'js-yaml'

export function toStringMap(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

export function getMapString(m: Record<string, unknown> | null, key: string): string {
  if (!m) return ''
  const value = m[key]
  if (value == null) return ''
  if (typeof value === 'string') return value
  return String(value)
}

export function decodeBase64Text(raw: string): string | null {
  const candidate = raw.trim()
  if (!candidate) return null

  const padded = candidate + '='.repeat((4 - (candidate.length % 4)) % 4)

  for (const t of [candidate, padded]) {
    for (const enc of ['base64', 'base64url'] as const) {
      try {
        const buf = Buffer.from(t, enc)
        const decoded = buf.toString('utf8').trim().replace(/\r\n/g, '\n')
        if (decoded) return decoded
      } catch {
        /* try next */
      }
    }
  }
  return null
}

export function parseClashPayload(text: string): unknown | null {
  try {
    return yaml.load(text) as unknown
  } catch {
    return null
  }
}

/** 取第一个 Clash 节点 map（对齐 Go pickClashNode） */
export function pickClashNode(payload: unknown): Record<string, unknown> | null {
  const m = toStringMap(payload)
  if (m) {
    const proxies = m.proxies
    if (Array.isArray(proxies) && proxies.length > 0) {
      return toStringMap(proxies[0]) ?? null
    }
    const proxyItem = m.proxy
    if (proxyItem && typeof proxyItem === 'object') {
      const pm = toStringMap(proxyItem)
      if (pm) return pm
    }
    return m
  }
  if (Array.isArray(payload) && payload.length > 0) {
    return toStringMap(payload[0]) ?? null
  }
  return null
}

export function getMapInt(m: Record<string, unknown> | null, key: string): number {
  if (!m) return 0
  const v = m[key]
  if (v == null) return 0
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string') return parseInt(v, 10) || 0
  return 0
}

export function clashProxyCount(payload: unknown): number {
  const m = toStringMap(payload)
  if (m) {
    const proxies = m.proxies
    if (Array.isArray(proxies)) return proxies.length
    const proxy = m.proxy
    if (Array.isArray(proxy)) return proxy.length
    const ProxyAlt = m.Proxy
    if (Array.isArray(ProxyAlt)) return ProxyAlt.length
  }
  if (Array.isArray(payload)) return payload.length
  return 0
}

export function extractClashDNSYAML(payload: unknown): string {
  const m = toStringMap(payload)
  if (!m || m.dns == null) return ''
  try {
    const dumped = yaml.dump({ dns: m.dns }, { lineWidth: -1, noRefs: true })
    return dumped.trim()
  } catch {
    return ''
  }
}

export function suggestClashGroupName(payload: unknown, fallbackHost: string): string {
  let host = fallbackHost.trim()
  const m = toStringMap(payload)
  if (m) {
    const groups = m['proxy-groups']
    if (Array.isArray(groups)) {
      for (const item of groups) {
        const gm = toStringMap(item)
        const name = gm ? getMapString(gm, 'name').trim() : ''
        if (name) return name
      }
    }
  }
  if (host.toLowerCase().startsWith('www.')) {
    host = host.slice(4)
  }
  return host
}

export function normalizeClashSubscriptionContent(body: string): {
  content: string
  payload: unknown
} {
  const baseText = body.trim().replace(/\r\n/g, '\n')
  if (!baseText) {
    throw new Error('订阅内容为空')
  }

  const tryTexts: string[] = [baseText]
  try {
    const unescaped = decodeURIComponent(baseText).trim().replace(/\r\n/g, '\n')
    if (unescaped && unescaped !== baseText) tryTexts.push(unescaped)
  } catch {
    /* ignore */
  }

  const decoded = decodeBase64Text(baseText)
  if (decoded) tryTexts.push(decoded)

  for (const text of tryTexts) {
    const payload = parseClashPayload(text)
    if (payload != null && clashProxyCount(payload) > 0) {
      return { content: text, payload }
    }
  }

  throw new Error('URL 内容不是有效 Clash YAML（需包含 proxies）')
}

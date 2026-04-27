/**
 * 代理解析（Electron 中间态）：
 * - 原生可用: direct/http/https/socks5
 * - Clash YAML / clash://: 尝试抽取首个 http/socks5 节点
 * - 其余协议（vmess/vless/trojan...）: 当前降级为直连并返回 warning
 */
import yaml from 'js-yaml'

export type ChromeProxyResolveResult = {
  /** 传给 --proxy-server 的值；空字符串表示不设置该参数 */
  proxyServer: string
  /** 非空表示发生了降级/兼容处理 */
  warning: string
}

function decodeClashSubscription(raw: string): string {
  const b64 = raw.slice('clash://'.length).trim()
  try {
    return Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8')
  } catch {
    return Buffer.from(b64, 'base64').toString('utf8')
  }
}

function parseClashDoc(raw: string): Record<string, unknown> | null {
  const s = raw.trim()
  if (!s) return null
  const low = s.toLowerCase()
  try {
    if (low.startsWith('clash://')) {
      const text = decodeClashSubscription(s)
      const doc = yaml.load(text)
      return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null
    }
    if (s.includes('proxies:')) {
      const doc = yaml.load(s)
      return doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : null
    }
  } catch {
    return null
  }
  return null
}

function firstUsableClashProxy(raw: string): string | null {
  const doc = parseClashDoc(raw)
  if (!doc) return null
  const proxies = doc.proxies
  if (!Array.isArray(proxies)) return null
  for (const item of proxies) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = String(o.type ?? '').trim().toLowerCase()
    const host = String(o.server ?? '').trim()
    const port = Number(o.port ?? 0)
    if (!host || !Number.isFinite(port) || port <= 0) continue
    const username = String(o.username ?? '').trim()
    const password = String(o.password ?? '').trim()
    const auth =
      username || password
        ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
        : ''
    if (type === 'http') {
      return `http://${auth}${host}:${port}`
    }
    if (type === 'socks5') {
      return `socks5://${auth}${host}:${port}`
    }
  }
  return null
}

/**
 * 将任意代理串尽量归一为 Chromium 可识别代理；无法转换时返回 direct:// 并附 warning。
 */
export function normalizeProxyForChrome(rawProxy: string): ChromeProxyResolveResult {
  const raw = String(rawProxy ?? '').trim()
  if (!raw) return { proxyServer: '', warning: '' }
  if (raw.toLowerCase() === 'direct://') return { proxyServer: 'direct://', warning: '' }

  const low = raw.toLowerCase()
  if (
    low.startsWith('http://') ||
    low.startsWith('https://') ||
    low.startsWith('socks5://') ||
    low.startsWith('socks5h://')
  ) {
    return { proxyServer: raw, warning: '' }
  }

  const clash = firstUsableClashProxy(raw)
  if (clash) {
    return {
      proxyServer: clash,
      warning: '检测到 Clash 配置，已自动提取可用的 http/socks5 节点用于 Chromium 代理。',
    }
  }

  return {
    proxyServer: 'direct://',
    warning: '当前代理协议暂不支持直接映射到 Chromium，已降级为直连。',
  }
}

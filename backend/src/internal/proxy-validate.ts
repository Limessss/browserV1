/**
 * ValidateProxyConfig：对齐 Ant-Browser internal/proxy.ValidateProxyConfig（简化 URI / Clash YAML，无完整 sing-box 构造）。
 */
import yaml from 'js-yaml'
import type { Database } from 'sql.js'

import { listProxies } from './browser-data'

export type ProxyValidationResult = {
  supported: boolean
  errorMsg: string
}

const MISSING_POOL_NODE = (id: string) =>
  `代理链路不可用：代理池节点已不存在（proxyId=${id}）。可能因订阅刷新后节点下线或被删除，请重新选择代理后再启动。`

function tryParseClashYaml(src: string): ProxyValidationResult | null {
  const s = src.trim()
  const low = s.toLowerCase()
  if (!s.includes('proxies:') && !low.startsWith('clash://')) {
    return null
  }
  if (low.startsWith('clash://')) {
    try {
      const b64 = s.slice('clash://'.length).trim()
      let decodedUtf8: string
      try {
        decodedUtf8 = Buffer.from(decodeURIComponent(b64), 'base64').toString('utf8')
      } catch {
        decodedUtf8 = Buffer.from(b64, 'base64').toString('utf8')
      }
      yaml.load(decodedUtf8)
      return { supported: true, errorMsg: '' }
    } catch {
      return { supported: false, errorMsg: '代理配置解析失败: clash 订阅解码失败' }
    }
  }
  try {
    yaml.load(s)
    return { supported: true, errorMsg: '' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { supported: false, errorMsg: `代理配置解析失败: ${msg}` }
  }
}

function validateUriLikeProxy(src: string): boolean {
  const trimmed = src.trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)
  if (!m) {
    return false
  }
  const scheme = String(m[1] ?? '').toLowerCase()
  return (
    scheme === 'direct' ||
    scheme === 'http' ||
    scheme === 'https' ||
    scheme === 'socks5' ||
    scheme === 'socks5h' ||
    scheme === 'socks' ||
    scheme === 'vmess' ||
    scheme === 'vless' ||
    scheme === 'trojan' ||
    scheme === 'ss' ||
    scheme === 'hysteria' ||
    scheme === 'hysteria2' ||
    scheme === 'tuic' ||
    scheme === 'clash'
  )
}

function hasSupportedYamlType(src: string): boolean {
  const low = src.toLowerCase()
  const m = low.match(/(?:^|\n)\s*-?\s*type\s*:\s*([a-z0-9_-]+)/)
  const t = String(m?.[1] ?? '').trim()
  return (
    t === 'http' ||
    t === 'https' ||
    t === 'socks5' ||
    t === 'socks' ||
    t === 'vmess' ||
    t === 'vless' ||
    t === 'trojan' ||
    t === 'ss' ||
    t === 'hysteria' ||
    t === 'hysteria2' ||
    t === 'tuic'
  )
}

export function validateProxyConfig(
  db: Database | null,
  proxyConfig: string,
  proxyId: string,
): ProxyValidationResult {
  let src = proxyConfig.trim()
  const pid = proxyId.trim()
  let found = false

  if (pid && db) {
    const proxies = listProxies(db)
    for (const p of proxies) {
      const row = p as Record<string, unknown>
      const id = String(row.proxyId ?? '').trim()
      if (id.toLowerCase() === pid.toLowerCase()) {
        src = String(row.proxyConfig ?? '').trim()
        found = true
        break
      }
    }
    if (!found && src === '') {
      return { supported: false, errorMsg: MISSING_POOL_NODE(pid) }
    }
  } else if (pid && !db && src === '') {
    return { supported: false, errorMsg: MISSING_POOL_NODE(pid) }
  }

  if (!src) {
    return { supported: true, errorMsg: '' }
  }
  if (src.toLowerCase() === 'direct://') {
    return { supported: true, errorMsg: '' }
  }

  const low = src.toLowerCase()
  if (
    low.startsWith('http://') ||
    low.startsWith('https://') ||
    low.startsWith('socks5://')
  ) {
    return { supported: true, errorMsg: '' }
  }

  const clash = tryParseClashYaml(src)
  if (clash !== null) {
    return clash
  }

  if (/^[^:/\s]+:\d+$/.test(src)) {
    return { supported: true, errorMsg: '' }
  }

  if (hasSupportedYamlType(src)) {
    return { supported: true, errorMsg: '' }
  }

  if (validateUriLikeProxy(src)) {
    return { supported: true, errorMsg: '' }
  }

  return {
    supported: false,
    errorMsg: '代理配置解析失败: 不支持的代理协议或格式',
  }
}

/**
 * BrowserProxyFetchClashByURL：HTTP 拉取 Clash 订阅（对齐 app_proxy_import.go）。
 */
import {
  clashProxyCount,
  extractClashDNSYAML,
  normalizeClashSubscriptionContent,
  suggestClashGroupName,
} from './clash-import'

const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 25_000

export async function browserProxyFetchClashByURL(rawURL: string): Promise<Record<string, unknown>> {
  const trimmed = rawURL.trim()
  if (!trimmed) {
    throw new Error('订阅 URL 不能为空')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('URL 格式无效')
  }

  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') {
    throw new Error('仅支持 http/https URL')
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const resp = await fetch(parsed.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: {
        'User-Agent': 'clash-verge/2.0 ant-chrome/1.0',
        Accept: 'application/yaml,text/yaml,text/plain,*/*',
        'Cache-Control': 'no-cache',
      },
    })

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`拉取订阅失败: HTTP ${resp.status}`)
    }

    const buf = new Uint8Array(await resp.arrayBuffer())
    if (buf.byteLength > MAX_BYTES) {
      throw new Error('订阅内容过大（超过 8MB）')
    }

    const text = new TextDecoder('utf8', { fatal: false }).decode(buf)
    const { content, payload } = normalizeClashSubscriptionContent(text)
    const proxyCount = clashProxyCount(payload)
    if (proxyCount <= 0) {
      throw new Error('未检测到可导入的 proxies 节点')
    }

    return {
      url: parsed.toString(),
      content,
      proxyCount,
      dnsServers: extractClashDNSYAML(payload),
      suggestedGroup: suggestClashGroupName(payload, parsed.hostname),
    }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('拉取订阅超时')
    }
    if (e instanceof Error) {
      if (
        e.message.startsWith('订阅') ||
        e.message.startsWith('URL') ||
        e.message.startsWith('拉取')
      ) {
        throw e
      }
      throw new Error(`拉取订阅失败: ${e.message}`)
    }
    throw new Error('拉取订阅失败')
  } finally {
    clearTimeout(timer)
  }
}

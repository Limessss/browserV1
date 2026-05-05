/**
 * FetchRemoteAuthorProfile：拉取远程 JSON 配置（对齐 app_profile.go）。
 */
const MAX_BYTES = 512 * 1024

export async function fetchRemoteAuthorProfile(
  rawURL: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const targetURL = rawURL.trim()
  if (!targetURL) {
    throw new Error('远程作者配置地址不能为空')
  }

  let parsed: URL
  try {
    parsed = new URL(targetURL)
  } catch {
    throw new Error('远程作者配置地址无效')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('远程作者配置仅支持 HTTP/HTTPS 地址')
  }

  let ms = timeoutMs > 0 ? timeoutMs : 3000
  if (ms > 15000) ms = 15000

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)

  try {
    const resp = await fetch(parsed.toString(), {
      method: 'GET',
      signal: ac.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'NexBrowser/1.0 profile-fetch',
      },
    })

    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`远程作者配置返回异常状态码: ${resp.status}`)
    }

    const buf = new Uint8Array(await resp.arrayBuffer())
    if (buf.byteLength > MAX_BYTES) {
      throw new Error('远程作者配置过大')
    }

    const text = new TextDecoder('utf8', { fatal: false }).decode(buf)
    let payload: unknown
    try {
      payload = JSON.parse(text) as unknown
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`解析远程作者配置失败: ${msg}`)
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('解析远程作者配置失败: 期望 JSON 对象')
    }

    const rec = payload as Record<string, unknown>
    if (Object.keys(rec).length === 0) {
      throw new Error('远程作者配置为空')
    }

    return rec
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('远程作者配置请求超时')
    }
    if (e instanceof Error) {
      throw e
    }
    throw new Error('拉取远程作者配置失败')
  } finally {
    clearTimeout(timer)
  }
}

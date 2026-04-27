/**
 * Chrome DevTools Protocol（HTTP /json + WebSocket），对齐 app_cookie.go cdpCall / cdpBrowserCall。
 */
import WebSocket from 'ws'

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url)
  if (!r.ok) {
    throw new Error(`CDP HTTP ${r.status}`)
  }
  return r.json() as Promise<T>
}

export async function getPageWebSocketDebuggerUrl(debugPort: number): Promise<string> {
  const targets = await fetchJson<
    Array<{ type?: string; webSocketDebuggerUrl?: string }>
  >(`http://127.0.0.1:${debugPort}/json`)
  for (const t of targets) {
    if (t.type === 'page' && t.webSocketDebuggerUrl) {
      return t.webSocketDebuggerUrl
    }
  }
  if (targets[0]?.webSocketDebuggerUrl) {
    return targets[0].webSocketDebuggerUrl
  }
  throw new Error('CDP targets 解析失败或为空')
}

export async function getBrowserWebSocketDebuggerUrl(debugPort: number): Promise<string> {
  const v = await fetchJson<{ webSocketDebuggerUrl?: string }>(
    `http://127.0.0.1:${debugPort}/json/version`,
  )
  const ws = v.webSocketDebuggerUrl?.trim()
  if (!ws) {
    throw new Error('未找到浏览器级 WebSocket 调试地址')
  }
  return ws
}

function wsCommand(wsUrl: string, message: { id: number; method: string; params?: unknown }): Promise<unknown> {
  const ws = new WebSocket(wsUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      reject(new Error('CDP 响应超时'))
    }, 25_000)

    const finish = (err: Error | null, result?: unknown): void => {
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else resolve(result)
    }

    const onMessage = (data: WebSocket.RawData): void => {
      let msg: {
        id?: number
        method?: string
        result?: unknown
        error?: { message: string }
      }
      try {
        msg = JSON.parse(String(data)) as typeof msg
      } catch {
        return
      }
      if (msg.method) {
        return
      }
      if (msg.id !== message.id) {
        return
      }
      ws.off('message', onMessage)
      if (msg.error) {
        finish(new Error(msg.error.message))
      } else {
        finish(null, msg.result)
      }
    }

    ws.once('open', () => {
      ws.send(JSON.stringify(message))
    })

    ws.on('message', onMessage)

    ws.once('error', (e) => finish(e instanceof Error ? e : new Error(String(e))))
  })
}

export async function cdpCall(
  debugPort: number,
  method: string,
  params: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const wsUrl = await getPageWebSocketDebuggerUrl(debugPort)
  const id = 1
  const raw = await wsCommand(wsUrl, { id, method, params: params ?? {} })
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
}

export async function cdpBrowserCall(
  debugPort: number,
  method: string,
  params: Record<string, unknown> | null,
): Promise<void> {
  const wsUrl = await getBrowserWebSocketDebuggerUrl(debugPort)
  const id = 1
  try {
    await wsCommand(wsUrl, { id, method, params: params ?? {} })
  } catch (e) {
    if (method === 'Browser.close') {
      return
    }
    throw e
  }
}

export async function cdpBrowserCommandWithResult(
  debugPort: number,
  method: string,
  params: Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  const wsUrl = await getBrowserWebSocketDebuggerUrl(debugPort)
  const id = 1
  const raw = await wsCommand(wsUrl, { id, method, params: params ?? {} })
  return (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
}

/**
 * 实时浏览器桥（Live Bridge）页面
 *
 * 直接连 ws://127.0.0.1:<launchPort>/api/live-bridge，
 * 实时操作浏览器：profile / navigate / screenshot / read_dom / click / type / evaluate。
 *
 * 协议：JSON over WebSocket
 *  C2S: { id, cmd, args }
 *  S2C: { id, ok, result? | error? }
 *  推送: { type: "event", event, data }
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  CircleDot,
  Code2,
  FileSearch,
  Globe,
  Loader2,
  MousePointerClick,
  Power,
  Type as TypeIcon,
} from 'lucide-react'
import { Button, Card, Input, toast } from '../../../shared/components'
import { fetchLaunchServerInfo } from '../api'

interface LiveResp {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}
interface LiveEvent {
  type: 'event'
  event: string
  data: unknown
}
interface LogEntry {
  id: string
  kind: 'req' | 'resp' | 'event' | 'err'
  text: string
  ts: number
}

const PRESET_CMDS: Array<{ label: string; cmd: string; args: object; icon: any }> = [
  { label: '截图', cmd: 'screenshot', args: { fullPage: false }, icon: Camera },
  { label: '读取 DOM', cmd: 'read_dom', args: { maxChars: 30000 }, icon: FileSearch },
  { label: '当前 URL', cmd: 'url', args: {}, icon: Globe },
  { label: '刷新', cmd: 'reload', args: {}, icon: Power },
]

export function LiveBridgePage() {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:19876')
  const [wsUrl, setWsUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [connected, setConnected] = useState(false)
  const [profileCode, setProfileCode] = useState('BUPM2Z')
  const [activeCode, setActiveCode] = useState('')
  const [pageUrl, setPageUrl] = useState('')
  const [screenshotBase64, setScreenshotBase64] = useState('')
  const [domText, setDomText] = useState('')
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [jsonInput, setJsonInput] = useState('{\n  "cmd": "url"\n}')
  const [running, setRunning] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const reqSeqRef = useRef(1)
  const pendingResolvers = useRef<Map<string, (r: LiveResp) => void>>(new Map())
  const logEndRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void fetchLaunchServerInfo().then((info) => {
      setBaseUrl(info.baseUrl)
      const port = info.port || 19876
      setWsUrl(`ws://127.0.0.1:${port}/api/live-bridge`)
      if (info.apiAuth?.configured && info.apiAuth.header) {
        // 仅在用户启用了鉴权时才需要
      }
    }).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (logEndRef.current) logEndRef.current.scrollTop = logEndRef.current.scrollHeight
  }, [logs])

  const appendLog = useCallback((entry: Omit<LogEntry, 'id' | 'ts'>) => {
    setLogs((prev) => {
      const next = [...prev, { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ts: Date.now() }]
      return next.length > 500 ? next.slice(-500) : next
    })
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      toast.info('已连接')
      return
    }
    const url = apiKey ? `${wsUrl}?apikey=${encodeURIComponent(apiKey)}` : wsUrl
    appendLog({ kind: 'event', text: `[connecting] ${url}` })
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setConnected(true)
      appendLog({ kind: 'event', text: `[open] ws 已连接` })
    }
    ws.onclose = (ev) => {
      setConnected(false)
      appendLog({ kind: 'event', text: `[close] code=${ev.code} reason=${ev.reason || ''}` })
      wsRef.current = null
    }
    ws.onerror = () => {
      appendLog({ kind: 'err', text: `[error] WebSocket 错误` })
    }
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (msg?.type === 'event') {
        const ev = msg as LiveEvent
        appendLog({ kind: 'event', text: `[event:${ev.event}] ${JSON.stringify(ev.data).slice(0, 300)}` })
        if (ev.event === 'hello') {
          // ready
        }
        return
      }
      const resp = msg as LiveResp
      const resolver = pendingResolvers.current.get(resp.id)
      pendingResolvers.current.delete(resp.id)
      if (resolver) resolver(resp)
      appendLog({
        kind: resp.ok ? 'resp' : 'err',
        text: `[resp id=${resp.id}] ${resp.ok ? 'OK' : `ERR: ${resp.error}`} ${resp.result ? JSON.stringify(resp.result).slice(0, 200) : ''}`,
      })
      if (resp.ok && resp.result) {
        const r: any = resp.result
        if (r.imageBase64) setScreenshotBase64(r.imageBase64)
        if (r.text !== undefined && typeof r.text === 'string') setDomText(r.text)
        if (typeof r.url === 'string') setPageUrl(r.url)
        if (typeof r.code === 'string') setActiveCode(r.code)
      }
    }
  }, [wsUrl, apiKey, appendLog])

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      try { wsRef.current.close(1000, 'user-disconnect') } catch { /* ignore */ }
      wsRef.current = null
    }
    setConnected(false)
  }, [])

  const sendCmd = useCallback(async (cmd: string, args: Record<string, unknown>): Promise<LiveResp | null> => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      toast.error('WebSocket 未连接')
      return null
    }
    const id = `r${reqSeqRef.current++}`
    const payload = { id, cmd, args }
    appendLog({ kind: 'req', text: `[req ${id}] ${JSON.stringify(payload).slice(0, 300)}` })
    wsRef.current.send(JSON.stringify(payload))
    return await new Promise<LiveResp>((resolve) => {
      const t = setTimeout(() => {
        pendingResolvers.current.delete(id)
        resolve({ id, ok: false, error: 'timeout (10s)' })
      }, 10_000)
      pendingResolvers.current.set(id, (r) => {
        clearTimeout(t)
        resolve(r)
      })
    })
  }, [appendLog])

  const runCustom = useCallback(async () => {
    let parsed: any
    try { parsed = JSON.parse(jsonInput) } catch (e) {
      toast.error(`JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    if (!parsed?.cmd) { toast.error('JSON 缺少 cmd 字段'); return }
    setRunning(true)
    try {
      await sendCmd(String(parsed.cmd), (parsed.args ?? {}) as Record<string, unknown>)
    } finally { setRunning(false) }
  }, [jsonInput, sendCmd])

  const connectProfile = useCallback(async () => {
    setRunning(true)
    try {
      const r = await sendCmd('profile', { code: profileCode })
      if (r?.ok) {
        // url + title 已在 onmessage 里 setPageUrl/setActiveCode
        await sendCmd('screenshot', { fullPage: false })
      }
    } finally { setRunning(false) }
  }, [profileCode, sendCmd])

  const runPreset = useCallback(async (cmd: string, args: object) => {
    setRunning(true)
    try { await sendCmd(cmd, args as Record<string, unknown>) } finally { setRunning(false) }
  }, [sendCmd])

  const headerStatus = useMemo(() => {
    if (!connected) return { color: 'bg-red-500', text: '未连接' }
    if (activeCode) return { color: 'bg-green-500', text: `已连接 · ${activeCode}` }
    return { color: 'bg-yellow-500', text: '已连接 · 未选 profile' }
  }, [connected, activeCode])

  return (
    <div className="flex flex-col h-full">
      {/* 顶部状态栏 */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800 bg-slate-900/60">
        <div className="flex items-center gap-3">
          <span className={`inline-block w-2.5 h-2.5 rounded-full ${headerStatus.color}`} />
          <span className="text-sm font-medium text-slate-100">{headerStatus.text}</span>
          {pageUrl && <span className="text-xs text-slate-400 max-w-[420px] truncate">{pageUrl}</span>}
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={wsUrl}
            onChange={(e) => setWsUrl(e.target.value)}
            placeholder="ws://127.0.0.1:19876/api/live-bridge"
            className="w-[360px] font-mono text-xs"
          />
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="(鉴权头，可选)"
            type="password"
            className="w-[180px] font-mono text-xs"
          />
          {connected ? (
            <Button variant="secondary" onClick={disconnect}>断开</Button>
          ) : (
            <Button variant="primary" onClick={connect}>连接</Button>
          )}
        </div>
      </div>

      {/* 中部：3 列 */}
      <div className="flex-1 grid grid-cols-12 gap-3 p-4 overflow-hidden">
        {/* 左：profile + 预设命令 */}
        <div className="col-span-3 flex flex-col gap-3 overflow-y-auto">
          <Card title="Profile">
            <div className="space-y-2">
              <Input
                value={profileCode}
                onChange={(e) => setProfileCode(e.target.value)}
                placeholder="环境码（如 BUPM2Z）"
                className="font-mono"
              />
              <Button variant="primary" onClick={connectProfile} disabled={!connected || running}>
                {running ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Power className="w-4 h-4 mr-1" />}
                连接 profile
              </Button>
            </div>
          </Card>

          <Card title="预设命令">
            <div className="grid grid-cols-2 gap-2">
              {PRESET_CMDS.map((p) => (
                <Button
                  key={p.label}
                  variant="secondary"
                  onClick={() => runPreset(p.cmd, p.args)}
                  disabled={!connected || running}
                >
                  <p.icon className="w-4 h-4 mr-1" />
                  {p.label}
                </Button>
              ))}
              <Button variant="secondary" onClick={() => runPreset('back', {})} disabled={!connected || running}>
                <CircleDot className="w-4 h-4 mr-1" />
                后退
              </Button>
              <Button variant="secondary" onClick={() => runPreset('forward', {})} disabled={!connected || running}>
                <CircleDot className="w-4 h-4 mr-1" />
                前进
              </Button>
            </div>
          </Card>

          <Card title="自定义 JSON">
            <textarea
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              spellCheck={false}
              className="w-full h-40 px-2 py-1 text-xs font-mono rounded border border-slate-700 bg-slate-950 text-slate-100 resize-none"
            />
            <div className="flex gap-2 mt-2">
              <Button variant="primary" onClick={runCustom} disabled={!connected || running}>
                <Code2 className="w-4 h-4 mr-1" /> 发送
              </Button>
              <Button variant="ghost" onClick={() => setLogs([])}>清日志</Button>
            </div>
            <div className="text-xs text-slate-500 mt-2 leading-relaxed">
              例：<code className="text-slate-300">{`{"cmd":"click","args":{"selector":"text=下一步"}}`}</code>
              <br />
              <code className="text-slate-300">{`{"cmd":"evaluate","args":{"expression":"location.href"}}`}</code>
            </div>
          </Card>
        </div>

        {/* 中：截图 */}
        <div className="col-span-5 flex flex-col">
          <Card title="截图（最近一次 screenshot 响应）" className="flex-1 flex flex-col">
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded overflow-auto flex items-start justify-center">
              {screenshotBase64 ? (
                <img
                  src={`data:image/png;base64,${screenshotBase64}`}
                  className="max-w-full"
                  alt="screenshot"
                />
              ) : (
                <div className="text-slate-500 text-sm py-12">尚未截图。点击"截图"或先"连接 profile"。</div>
              )}
            </div>
          </Card>
        </div>

        {/* 右：DOM 文本 + 实时日志 */}
        <div className="col-span-4 flex flex-col gap-3 overflow-hidden">
          <Card title="DOM 文本（最近 read_dom）" className="h-1/3 flex flex-col">
            <pre className="flex-1 overflow-auto whitespace-pre-wrap break-words text-xs font-mono text-slate-200 bg-slate-950 border border-slate-800 rounded p-2">
              {domText || '（空）'}
            </pre>
          </Card>

          <Card title="实时日志（最近 500 条）" className="flex-1 flex flex-col">
            <div ref={logEndRef} className="flex-1 overflow-auto bg-slate-950 border border-slate-800 rounded p-2 text-xs font-mono space-y-1">
              {logs.length === 0 && <div className="text-slate-500">连接后这里会滚动显示请求/响应/事件。</div>}
              {logs.map((l) => {
                const color =
                  l.kind === 'req' ? 'text-blue-300' :
                  l.kind === 'resp' ? (l.text.includes('ERR') ? 'text-red-300' : 'text-green-300') :
                  l.kind === 'err' ? 'text-red-400' : 'text-slate-300'
                return <div key={l.id} className={color}>{l.text}</div>
              })}
            </div>
          </Card>
        </div>
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 text-xs text-slate-500 border-t border-slate-800 bg-slate-900/40">
        服务端 WS 端点 <code className="text-slate-300">ws://127.0.0.1:&lt;launchPort&gt;/api/live-bridge</code> · Launch 启停会同步挂载/卸载 · 同时仅允许 1 个 ws 连接（新连接会顶替旧连接）
      </div>
    </div>
  )
}
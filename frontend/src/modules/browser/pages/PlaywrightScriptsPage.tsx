import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, RefreshCw, Square, Terminal } from 'lucide-react'
import { Button, Card, Input, toast } from '../../../shared/components'
import {
  fetchLaunchServerInfo,
  fetchPlaywrightScripts,
  killPlaywrightScriptRunApi,
  runPlaywrightScriptApi,
  type LaunchServerInfo,
  type PlaywrightScriptMeta,
  type PlaywrightScriptsListPayload,
} from '../api'

function splitExtraArgs(line: string): string[] {
  return line
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
}

export function PlaywrightScriptsPage() {
  const [loading, setLoading] = useState(true)
  const [payload, setPayload] = useState<PlaywrightScriptsListPayload>({
    rootDir: '',
    scripts: [],
    warnings: [],
  })
  const [launchInfo, setLaunchInfo] = useState<LaunchServerInfo | null>(null)
  const [extraByFolder, setExtraByFolder] = useState<Record<string, string>>({})
  const [logLines, setLogLines] = useState<Array<{ stream: 'stdout' | 'stderr'; text: string }>>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [runningFolderId, setRunningFolderId] = useState<string | null>(null)
  const [lastExitCode, setLastExitCode] = useState<number | null>(null)
  const activeRunIdRef = useRef<string | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  const loadList = useCallback(async () => {
    setLoading(true)
    try {
      const [scriptsPayload, launch] = await Promise.all([
        fetchPlaywrightScripts(),
        fetchLaunchServerInfo(),
      ])
      setPayload(scriptsPayload)
      setLaunchInfo(launch)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '加载脚本列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    activeRunIdRef.current = activeRunId
  }, [activeRunId])

  useEffect(() => {
    const rt = (window as unknown as { runtime?: { EventsOn?: (n: string, cb: (...a: unknown[]) => void) => () => void } })
      .runtime
    if (!rt?.EventsOn) return

    const onChunk = (...args: unknown[]) => {
      const payload = args[0] as {
        runId?: string
        stream?: string
        text?: string
      }
      if (!payload || payload.runId !== activeRunIdRef.current) return
      const stream = payload.stream === 'stderr' ? 'stderr' : 'stdout'
      const text = String(payload.text ?? '')
      if (!text) return
      setLogLines((prev) => [...prev, { stream, text }])
    }

    const onExit = (...args: unknown[]) => {
      const payload = args[0] as { runId?: string; code?: number }
      if (!payload || payload.runId !== activeRunIdRef.current) return
      setActiveRunId(null)
      setRunningFolderId(null)
      activeRunIdRef.current = null
      setLastExitCode(typeof payload.code === 'number' ? payload.code : -1)
    }

    const offChunk = rt.EventsOn('playwright:script:chunk', onChunk)
    const offExit = rt.EventsOn('playwright:script:exit', onExit)
    return () => {
      offChunk?.()
      offExit?.()
    }
  }, [])

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logLines])

  const handleRun = async (script: PlaywrightScriptMeta) => {
    const extraRaw = extraByFolder[script.folderId] ?? ''
    const extraArgs = splitExtraArgs(extraRaw)

    if (script.requiresLaunchServer && launchInfo && !launchInfo.ready) {
      toast.error('Launch 服务未就绪，请先启动应用内 Launch HTTP 服务后再试')
      return
    }

    setLogLines([])
    setLastExitCode(null)

    try {
      const { runId } = await runPlaywrightScriptApi(script.folderId, extraArgs)
      if (!runId) {
        toast.error('未返回 runId')
        return
      }
      activeRunIdRef.current = runId
      setActiveRunId(runId)
      setRunningFolderId(script.folderId)
      toast.success(`已开始运行：${script.name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '启动失败')
    }
  }

  const handleKill = async () => {
    if (!activeRunId) return
    const ok = await killPlaywrightScriptRunApi(activeRunId)
    if (ok) {
      toast.info('已发送终止请求')
    } else {
      toast.error('终止失败（进程可能已结束）')
    }
  }

  return (
    <div className="space-y-5 animate-fade-in">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)] text-xs font-medium mb-3">
              <Terminal className="w-3.5 h-3.5" /> 自动化脚本
            </div>
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Playwright 脚本目录</h1>
            <p className="text-sm text-[var(--color-text-secondary)] mt-2">
              读取仓库内 <code className="text-xs">playwright_scripts/*/script.json</code>
              ，一键用系统 Node 执行入口 <code className="text-xs">.mjs</code>（工作目录为应用根目录，与 README 中命令一致）。
            </p>
            {payload.rootDir ? (
              <p className="text-xs text-[var(--color-text-muted)] mt-2 break-all">
                扫描根路径：<code>{payload.rootDir}</code>
              </p>
            ) : null}
          </div>
          <Button variant="secondary" size="sm" onClick={() => void loadList()} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
            刷新列表
          </Button>
        </div>
      </Card>

      {launchInfo && !launchInfo.ready ? (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <div className="flex gap-2 text-sm text-[var(--color-text-secondary)]">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <p>
              Launch HTTP 服务尚未就绪（<code>{launchInfo.baseUrl}</code>
              ）。依赖 Launch API 的脚本可能失败；可在「自动化接口」页查看接入说明。
            </p>
          </div>
        </Card>
      ) : null}

      {payload.warnings.length > 0 ? (
        <Card className="border-[var(--color-border-muted)]">
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">扫描提示</p>
          <ul className="text-xs text-[var(--color-text-secondary)] space-y-1 list-disc pl-4">
            {payload.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      {loading ? (
        <p className="text-sm text-[var(--color-text-muted)]">加载中…</p>
      ) : payload.scripts.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--color-text-secondary)]">
            未发现可用脚本。请在 <code>playwright_scripts/&lt;主题&gt;/</code> 下添加{' '}
            <code>script.json</code> 与入口 <code>.mjs</code>。
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {payload.scripts.map((s) => (
            <Card key={s.folderId} title={s.name} subtitle={`${s.folderId} · ${s.entry}`}>
              <p className="text-sm text-[var(--color-text-secondary)] mb-3">{s.description}</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {s.version ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
                    v{s.version}
                  </span>
                ) : null}
                {(s.tags ?? []).map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)]"
                  >
                    {t}
                  </span>
                ))}
                {s.requiresLaunchServer ? (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400">
                    需要 Launch
                  </span>
                ) : null}
              </div>
              {s.defaultArgs && s.defaultArgs.length > 0 ? (
                <p className="text-xs text-[var(--color-text-muted)] mb-2 font-mono break-all">
                  默认参数：{s.defaultArgs.join(' ')}
                </p>
              ) : null}
              {s.argsHint ? (
                <p className="text-xs text-[var(--color-text-secondary)] mb-2 whitespace-pre-wrap">{s.argsHint}</p>
              ) : null}
              {s.mcpDoc ? (
                <p className="text-xs text-[var(--color-text-muted)] mb-2">
                  MCP 说明文件（相对本目录）：<code>{s.mcpDoc}</code>
                </p>
              ) : null}
              <div className="space-y-2">
                <label className="block text-xs text-[var(--color-text-muted)]">
                  附加参数（空格分隔，置于默认参数之前传入：同名项以这里为准，例如覆盖 --shop_region）
                </label>
                <Input
                  className="font-mono text-xs"
                  placeholder="例如 --useLaunchApi --code YOUR_CODE --shop_region MY --pick_n 1"
                  value={extraByFolder[s.folderId] ?? ''}
                  onChange={(e) =>
                    setExtraByFolder((prev) => ({ ...prev, [s.folderId]: e.target.value }))
                  }
                  disabled={runningFolderId === s.folderId && activeRunId !== null}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleRun(s)}
                    disabled={runningFolderId === s.folderId && activeRunId !== null}
                  >
                    运行
                  </Button>
                  {runningFolderId === s.folderId && activeRunId ? (
                    <Button size="sm" variant="secondary" onClick={() => void handleKill()}>
                      <Square className="w-3.5 h-3.5 mr-1" /> 终止
                    </Button>
                  ) : null}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Card title="运行输出" subtitle={lastExitCode !== null ? `上次退出码：${lastExitCode}` : undefined}>
        <pre className="text-xs leading-relaxed font-mono whitespace-pre-wrap bg-[var(--color-bg-secondary)] border border-[var(--color-border-muted)] rounded-lg p-3 max-h-[320px] overflow-y-auto">
          {logLines.length === 0 ? (
            <span className="text-[var(--color-text-muted)]">尚无输出；点击上方「运行」后开始采集日志。</span>
          ) : (
            logLines.map((line, i) => (
              <span
                key={i}
                className={
                  line.stream === 'stderr' ? 'text-red-600 dark:text-red-400' : 'text-[var(--color-text-primary)]'
                }
              >
                {line.text}
              </span>
            ))
          )}
          <div ref={logEndRef} />
        </pre>
        <p className="text-[10px] text-[var(--color-text-muted)] mt-2">
          打包分发时请将 <code>playwright_scripts</code> 目录置于可执行文件同级，或自行配置资源拷贝；开发态从项目根目录扫描。
        </p>
      </Card>
    </div>
  )
}

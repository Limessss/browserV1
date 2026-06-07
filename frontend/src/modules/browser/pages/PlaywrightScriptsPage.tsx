import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, Pencil, RefreshCw, Square, Terminal } from 'lucide-react'
import { Button, Card, FormItem, Input, Modal, Switch, Textarea, toast } from '../../../shared/components'
import {
  fetchLaunchServerInfo,
  fetchPlaywrightScripts,
  killPlaywrightScriptRunApi,
  runPlaywrightScriptApi,
  type LaunchServerInfo,
  type PlaywrightScriptManifestInput,
  type PlaywrightScriptMeta,
  type PlaywrightScriptsListPayload,
  openPlaywrightScriptPath,
  openPlaywrightScriptsDir,
  savePlaywrightScriptManifestApi,
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
    bundledRootDir: '',
    scripts: [],
    warnings: [],
  })
  const [launchInfo, setLaunchInfo] = useState<LaunchServerInfo | null>(null)
  const [extraByFolder, setExtraByFolder] = useState<Record<string, string>>({})
  const [logLines, setLogLines] = useState<Array<{ stream: 'stdout' | 'stderr'; text: string }>>([])
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [runningFolderId, setRunningFolderId] = useState<string | null>(null)
  const [lastExitCode, setLastExitCode] = useState<number | null>(null)
  const [editingScript, setEditingScript] = useState<PlaywrightScriptMeta | null>(null)
  const [savingManifest, setSavingManifest] = useState(false)
  const [manifestForm, setManifestForm] = useState({
    name: '',
    description: '',
    entry: '',
    id: '',
    order: '',
    tags: '',
    version: '',
    defaultArgs: '',
    argsHint: '',
    requiresLaunchServer: false,
    mcpDoc: '',
  })
  const activeRunIdRef = useRef<string | null>(null)
  const logEndRef = useRef<HTMLDivElement | null>(null)

  const openEditModal = (script: PlaywrightScriptMeta) => {
    setEditingScript(script)
    setManifestForm({
      name: script.name ?? '',
      description: script.description ?? '',
      entry: script.entry ?? '',
      id: script.id ?? '',
      order: typeof script.order === 'number' ? String(script.order) : '',
      tags: (script.tags ?? []).join(','),
      version: script.version ?? '',
      defaultArgs: (script.defaultArgs ?? []).join('\n'),
      argsHint: script.argsHint ?? '',
      requiresLaunchServer: !!script.requiresLaunchServer,
      mcpDoc: script.mcpDoc ?? '',
    })
  }

  const closeEditModal = () => {
    if (savingManifest) return
    setEditingScript(null)
  }

  const handleOpenScriptsDir = async () => {
    try {
      const ok = await openPlaywrightScriptsDir()
      if (!ok) {
        toast.error('当前环境不支持打开目录')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开脚本目录失败')
    }
  }

  const handleOpenScriptPath = async (relativePath: string) => {
    if (!editingScript) return
    try {
      const ok = await openPlaywrightScriptPath(editingScript.folderId, relativePath)
      if (!ok) {
        toast.error('当前环境不支持打开路径')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '打开路径失败')
    }
  }

  const handleSaveManifest = async () => {
    if (!editingScript) return
    const orderRaw = manifestForm.order.trim()
    const orderValue = orderRaw ? Number(orderRaw) : undefined
    if (orderRaw && !Number.isFinite(orderValue)) {
      toast.error('排序 order 必须是数字')
      return
    }
    const payload: PlaywrightScriptManifestInput = {
      name: manifestForm.name.trim(),
      description: manifestForm.description.trim(),
      entry: manifestForm.entry.trim(),
      requiresLaunchServer: manifestForm.requiresLaunchServer,
    }
    if (manifestForm.id.trim()) payload.id = manifestForm.id.trim()
    if (orderValue !== undefined) payload.order = orderValue
    if (manifestForm.tags.trim()) {
      payload.tags = manifestForm.tags
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
    if (manifestForm.version.trim()) payload.version = manifestForm.version.trim()
    if (manifestForm.defaultArgs.trim()) {
      payload.defaultArgs = manifestForm.defaultArgs
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    }
    if (manifestForm.argsHint.trim()) payload.argsHint = manifestForm.argsHint
    if (manifestForm.mcpDoc.trim()) payload.mcpDoc = manifestForm.mcpDoc.trim()

    setSavingManifest(true)
    try {
      await savePlaywrightScriptManifestApi(editingScript.folderId, payload)
      toast.success(`已保存：${editingScript.folderId}/script.json`)
      setEditingScript(null)
      await loadList()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败')
    } finally {
      setSavingManifest(false)
    }
  }

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
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">Playwright 脚本说明</h1>
            <ol className="text-sm text-[var(--color-text-secondary)] mt-2 space-y-1.5 list-decimal pl-5">
              <li>
                系统会扫描 <code className="text-xs">脚本目录下的所有脚本</code>，在此一键运行。
              </li>
              <li>
                若要修改或自行创建脚本，请打开脚本目录，并让 AI Agent 工具阅读该目录下的{' '}
                <code className="text-xs">README.md</code> 后再动手。
              </li>
            </ol>
          </div>
          <div className="flex flex-wrap gap-2 shrink-0">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleOpenScriptsDir()}
              title="在资源管理器中打开用户脚本目录 playwright_scripts"
            >
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
              打开脚本目录
            </Button>
            <Button variant="secondary" size="sm" onClick={() => void loadList()} disabled={loading}>
              <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
              刷新列表
            </Button>
          </div>
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
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => openEditModal(s)}
                    disabled={runningFolderId === s.folderId && activeRunId !== null}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1" /> 编辑
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
          打包后内置脚本在 <code>playwright_scripts.bundled</code>；首次运行会将缺失文件复制到用户目录{' '}
          <code>playwright_scripts</code>（不覆盖已有文件）。同名文件以用户目录为准。修改或新建脚本前，请让 AI Agent
          阅读用户目录中的 <code>README.md</code>。
        </p>
      </Card>

      <Modal
        open={!!editingScript}
        onClose={closeEditModal}
        title={editingScript ? `编辑 ${editingScript.folderId}/script.json` : '编辑 script.json'}
        width="760px"
        footer={
          <>
            <Button variant="secondary" onClick={closeEditModal} disabled={savingManifest}>
              取消
            </Button>
            <Button onClick={() => void handleSaveManifest()} disabled={savingManifest}>
              {savingManifest ? '保存中...' : '保存'}
            </Button>
          </>
        }
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <FormItem label="脚本名称" hint="name" required>
            <Input
              value={manifestForm.name}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, name: e.target.value }))}
              placeholder="脚本名称"
            />
          </FormItem>
          <FormItem label="入口文件" hint="entry" required>
            <div className="flex items-center gap-2">
              <Input
                value={manifestForm.entry}
                onChange={(e) => setManifestForm((prev) => ({ ...prev, entry: e.target.value }))}
                placeholder="入口文件，例如 main.mjs"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0 px-2"
                title="在资源管理器中打开入口文件（不存在则打开脚本目录）"
                onClick={() => void handleOpenScriptPath(manifestForm.entry)}
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
          </FormItem>
          <FormItem label="脚本 ID" hint="id">
            <Input
              value={manifestForm.id}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, id: e.target.value }))}
            />
          </FormItem>
          <FormItem label="排序" hint="order">
            <Input
              value={manifestForm.order}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, order: e.target.value }))}
              placeholder="数字，越小越靠前"
            />
          </FormItem>
          <FormItem label="版本号" hint="version">
            <Input
              value={manifestForm.version}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, version: e.target.value }))}
            />
          </FormItem>
          <FormItem label="MCP 文档" hint="mcpDoc">
            <div className="flex items-center gap-2">
              <Input
                value={manifestForm.mcpDoc}
                onChange={(e) => setManifestForm((prev) => ({ ...prev, mcpDoc: e.target.value }))}
                placeholder="相对目录文档路径"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="shrink-0 px-2"
                title="在资源管理器中打开 MCP 文档（不存在则打开脚本目录）"
                onClick={() => void handleOpenScriptPath(manifestForm.mcpDoc)}
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>
          </FormItem>
          <FormItem label="标签" hint="tags，逗号分隔" className="md:col-span-2">
            <Input
              value={manifestForm.tags}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, tags: e.target.value }))}
              placeholder="例如 tiktok,compass,ai"
            />
          </FormItem>
          <FormItem label="脚本描述" hint="description" required className="md:col-span-2">
            <Textarea
              rows={3}
              value={manifestForm.description}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, description: e.target.value }))}
            />
          </FormItem>
          <FormItem label="参数说明" hint="argsHint" className="md:col-span-2">
            <Textarea
              rows={3}
              value={manifestForm.argsHint}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, argsHint: e.target.value }))}
            />
          </FormItem>
          <FormItem label="默认参数" hint="defaultArgs，每行一个参数" className="md:col-span-2">
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={manifestForm.defaultArgs}
              onChange={(e) => setManifestForm((prev) => ({ ...prev, defaultArgs: e.target.value }))}
              placeholder={'--useLaunchApi\n--code\nYOUR_CODE'}
            />
          </FormItem>
          <FormItem label="依赖 Launch 服务" hint="requiresLaunchServer" className="md:col-span-2">
            <div className="h-9 flex items-center">
              <Switch
                checked={manifestForm.requiresLaunchServer}
                onChange={(checked) =>
                  setManifestForm((prev) => ({ ...prev, requiresLaunchServer: checked }))
                }
              />
            </div>
          </FormItem>
        </div>
      </Modal>
    </div>
  )
}

/**
 * AI 浏览器接管 — Agent 配置页
 *
 * 面向「交给 AI Agent 使用」：展示服务状态、前置准备与 MCP/Skill 接入方式。
 * 不在此页做手动发命令 / 截图 / DOM 调试（由 Codex、Claude Code、Openclaw 等 Agent 通过 MCP 或 CLI 完成）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  ExternalLink,
  FolderOpen,
  Monitor,
  RefreshCw,
  XCircle,
} from 'lucide-react'
import { Button, Card, toast } from '../../../shared/components'
import {
  fetchLaunchServerInfo,
  fetchLiveBridgeSkillDir,
  openLiveBridgeSkillDir,
  type LaunchServerInfo,
} from '../api'

function StatusDot({ ok }: { ok: boolean }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full shrink-0"
      style={{ background: ok ? 'var(--color-success)' : 'var(--color-text-muted)' }}
    />
  )
}

function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className="px-1 py-0.5 rounded text-[var(--color-text-primary)] bg-[var(--color-bg-muted)] font-mono text-[0.9em]">
      {children}
    </code>
  )
}

function buildMcpConfig(skillDir: string): string {
  const script = `${skillDir.replace(/\\/g, '/')}/scripts/mcp-live-bridge.mjs`
  return JSON.stringify(
    {
      mcpServers: {
        nexbrowser: {
          command: 'node',
          args: [script],
        },
      },
    },
    null,
    2,
  )
}

export function LiveBridgePage() {
  const [info, setInfo] = useState<LaunchServerInfo | null>(null)
  const [skillDir, setSkillDir] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const [launchInfo, dir] = await Promise.all([
        fetchLaunchServerInfo(),
        fetchLiveBridgeSkillDir(),
      ])
      setInfo(launchInfo)
      if (dir) setSkillDir(dir)
    } catch {
      toast.error('无法读取服务状态')
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => { void refresh() }, 8000)
    return () => clearInterval(t)
  }, [refresh])

  const wsUrl = useMemo(() => {
    const port = info?.port || 19876
    return `ws://127.0.0.1:${port}/api/live-bridge`
  }, [info?.port])

  const mcpConfig = useMemo(
    () => (skillDir ? buildMcpConfig(skillDir) : ''),
    [skillDir],
  )

  const launchReady = Boolean(info?.ready)
  const browserRunning = Boolean(info?.activeDebugPort && info.activeDebugPort > 0)

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`已复制${label}`)
    } catch {
      toast.error('复制失败')
    }
  }, [])

  const openSkillDir = useCallback(async () => {
    try {
      const path = await openLiveBridgeSkillDir()
      if (path) {
        setSkillDir(path)
        toast.success('已打开 Skill 目录')
      } else {
        toast.error('无法打开 Skill 目录')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const steps = [
    {
      n: 1,
      title: '保持 NexBrowser 运行',
      desc: '只需 NexBrowser 主程序在跑（Launch 服务 :19876 就绪）。无需手动去实例列表 Launch——Agent 可通过 browser_connect({ code: "BUPM2Z" }) 或 browser_profile 自动打开指定 profile。',
      action: (
        <Link to="/browser/list">
          <Button variant="secondary" size="sm">
            <Monitor className="w-3.5 h-3.5 mr-1" />
            实例列表（可选）
          </Button>
        </Link>
      ),
      done: launchReady,
    },
    {
      n: 2,
      title: '注册 MCP Server（推荐）',
      desc: '将下方配置注册到 Codex、Claude Code、Openclaw、Cursor 等支持 MCP 的 Agent，重启对应 Agent 后即可使用 browser_* 工具。Cursor 可粘贴到 .cursor/mcp.json。',
      action: mcpConfig ? (
        <Button variant="primary" size="sm" onClick={() => void copyText(mcpConfig, ' MCP 配置')}>
          <Copy className="w-3.5 h-3.5 mr-1" />
          复制 MCP 配置
        </Button>
      ) : null,
      done: Boolean(mcpConfig),
    },
    {
      n: 3,
      title: '在 Agent 中下达任务',
      desc: '示例：「用 BUPM2Z 打开浏览器，去订单管理查即将逾期订单」。Agent 会 browser_connect({ code }) → snapshot → 操作。登录态过期时需你手动登录一次，Agent 不会代填密码。',
      action: null,
      done: launchReady && Boolean(mcpConfig),
    },
  ]

  return (
    <div className="h-full overflow-y-auto bg-[var(--color-bg-base)]">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        {/* 标题 */}
        <div>
          <div className="flex items-center gap-2">
            <Bot className="w-6 h-6 text-[var(--color-accent)]" />
            <h1 className="text-xl font-semibold text-[var(--color-text-primary)]">AI 浏览器接管</h1>
          </div>
          <p className="mt-2 text-sm text-[var(--color-text-secondary)] leading-relaxed">
            让 Codex、Claude Code、Openclaw、Cursor 等 AI Agent 通过 MCP 实时控制本机指纹浏览器。
            本页仅用于查看服务状态与完成 Agent 接入配置，日常操作交给 Agent 即可。
          </p>
        </div>

        {/* 服务状态 */}
        <Card title="服务状态">
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm">
                <StatusDot ok={launchReady} />
                <span className="font-medium text-[var(--color-text-primary)]">Launch 服务</span>
                <span className="text-[var(--color-text-secondary)]">{launchReady ? '运行中' : '未就绪'}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
                刷新
              </Button>
            </div>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <StatusDot ok={launchReady} />
              <span className="font-medium text-[var(--color-text-primary)] shrink-0">Live Bridge</span>
              <code className="text-xs text-[var(--color-text-secondary)] font-mono truncate flex-1 bg-[var(--color-bg-muted)] px-2 py-1 rounded">
                {wsUrl}
              </code>
              <Button variant="ghost" size="sm" onClick={() => void copyText(wsUrl, ' WS 地址')}>
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-2 text-sm">
              <StatusDot ok={browserRunning} />
              <span className="font-medium text-[var(--color-text-primary)]">浏览器实例</span>
              <span
                className="font-medium"
                style={{ color: browserRunning ? 'var(--color-success)' : 'var(--color-text-secondary)' }}
              >
                {browserRunning
                  ? `已有 Launch 实例（CDP :${info?.activeDebugPort}，最近 active）`
                  : '当前无 active 实例 — Agent 可通过 browser_connect({ code }) 自动 Launch'}
              </span>
            </div>
          </div>
        </Card>

        {/* 三步接入 */}
        <Card title="接入步骤">
          <div className="space-y-5">
            {steps.map((s) => (
              <div key={s.n} className="flex gap-4">
                <div
                  className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold"
                  style={
                    s.done
                      ? { background: 'var(--color-accent-muted)', color: 'var(--color-success)' }
                      : { background: 'var(--color-bg-muted)', color: 'var(--color-text-secondary)' }
                  }
                >
                  {s.done ? <CheckCircle2 className="w-4 h-4" /> : s.n}
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="text-sm font-medium text-[var(--color-text-primary)]">{s.title}</div>
                  <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">{s.desc}</p>
                  {s.action && <div className="pt-1">{s.action}</div>}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* MCP 配置 */}
        <Card title="通用 MCP 配置">
          <p className="text-sm text-[var(--color-text-secondary)] mb-3 leading-relaxed">
            复制到 Codex、Claude Code、Openclaw、Cursor 等 Agent 的 MCP 配置中。Cursor 示例路径：
            {' '}<InlineCode>.cursor/mcp.json</InlineCode>（无则新建），保存后重启对应 Agent。
          </p>
          {mcpConfig ? (
            <pre className="text-xs font-mono text-[var(--color-text-primary)] bg-[var(--color-bg-muted)] border border-[var(--color-border-default)] rounded-lg p-3 overflow-x-auto leading-relaxed">
              {mcpConfig}
            </pre>
          ) : (
            <p className="text-sm text-[var(--color-text-muted)]">正在读取 Skill 目录…</p>
          )}
          <div className="flex flex-wrap gap-2 mt-3">
            <Button variant="primary" disabled={!mcpConfig} onClick={() => void copyText(mcpConfig, ' MCP 配置')}>
              <Copy className="w-4 h-4 mr-1" />
              复制 MCP 配置
            </Button>
            <Button variant="secondary" onClick={() => void openSkillDir()}>
              <FolderOpen className="w-4 h-4 mr-1" />
              打开 Skill 目录
            </Button>
          </div>
          <p className="text-sm text-[var(--color-text-muted)] mt-3 leading-relaxed">
            首选 <InlineCode>browser_connect</InlineCode>（带 code 自动 Launch）。
            另提供 <InlineCode>browser_attach</InlineCode>、
            <InlineCode>browser_snapshot</InlineCode>、
            <InlineCode>browser_click</InlineCode> 等 16 个工具。
            也可将整个 Skill 目录导入 Agent 的规则/Skill 系统（见目录内 SKILL.md）。
          </p>
        </Card>

        {/* Agent 工作流提示 */}
        <Card title="Agent 如何使用">
          <div className="flex items-start gap-3">
            <Activity className="w-5 h-5 text-[var(--color-accent)] shrink-0 mt-0.5" />
            <div className="space-y-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
              <p>Agent 通过 MCP 连接本机 Live Bridge，推荐流程：</p>
              <ol className="list-decimal list-inside space-y-1.5 text-[var(--color-text-primary)]">
                <li><InlineCode>browser_connect</InlineCode> — 带 <InlineCode>code</InlineCode> 自动打开指定 profile；不带 code 则附着当前实例</li>
                <li><InlineCode>browser_observe</InlineCode> / <InlineCode>browser_snapshot</InlineCode> — 确认是否在登录页、获取 ref</li>
                <li><InlineCode>browser_click</InlineCode> / <InlineCode>browser_type</InlineCode> / <InlineCode>browser_navigate</InlineCode> — 执行操作</li>
                <li><InlineCode>browser_wait_for</InlineCode> — 等待页面条件，避免盲等</li>
              </ol>
              <p className="text-[var(--color-text-muted)]">支持最多 8 个 Agent 并发连接；仅监听 127.0.0.1，不暴露外网。</p>
            </div>
          </div>
        </Card>

        {/* 高级 / 折叠 */}
        <button
          type="button"
          className="flex items-center gap-1 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] transition-colors"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          高级信息
        </button>
        {showAdvanced && (
          <Card>
            <div className="space-y-2 text-sm text-[var(--color-text-secondary)] leading-relaxed">
              <div className="flex items-start gap-2">
                {info?.apiAuth?.enabled ? (
                  <>
                    <XCircle className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-warning)' }} />
                    <span>已启用 Launch API 鉴权（{info.apiAuth.header}），MCP 需配置环境变量或扩展脚本传 Key</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--color-success)' }} />
                    <span>未启用鉴权，本机 Agent 可直接连接</span>
                  </>
                )}
              </div>
              <p>
                HTTP：<InlineCode>{info?.baseUrl ?? 'http://127.0.0.1:19876'}</InlineCode>
                {' · '}
                健康检查 <InlineCode>/api/health</InlineCode>
              </p>
              <p>
                CLI 调试：<InlineCode>node …/live-bridge-cmd.mjs send profile {'{"code":"BUPM2Z"}'}</InlineCode>
                （Skill 目录内 scripts/，开发者用）
              </p>
              <button
                type="button"
                className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:opacity-80 font-medium"
                onClick={() => void openSkillDir()}
              >
                <ExternalLink className="w-3.5 h-3.5" />
                打开 Skill 目录查看 reference.md
              </button>
            </div>
          </Card>
        )}
      </div>
    </div>
  )
}

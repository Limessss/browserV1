#!/usr/bin/env node
/**
 * NexBrowser Live Bridge MCP Server（stdio）
 *
 * 把 Live Bridge WebSocket 协议封装成标准 MCP 工具，供 Codex / Claude Code /
 * Openclaw / Cursor 等任意支持 MCP 的 AI Agent 直接调用。
 *
 * 架构：
 *   AI Agent ──stdio(JSON-RPC)──▶ 本进程 ──WS──▶ Live Bridge :19876 ──CDP──▶ Chromium
 *
 * 零第三方依赖（除项目已有的 ws）：MCP stdio 传输为「按行分隔的 JSON-RPC」，此处手写实现。
 *
 * MCP 注册示例（Cursor: .cursor/mcp.json；其他 Agent 放到对应 MCP 配置）:
 *   {
 *     "mcpServers": {
 *       "nexbrowser": {
 *         "command": "node",
 *         "args": ["<绝对路径>/scripts/mcp-live-bridge.mjs"]
 *       }
 *     }
 *   }
 *
 * Env:
 *   LIVE_BRIDGE_URL         默认 ws://127.0.0.1:19876/api/live-bridge
 *   LIVE_BRIDGE_TIMEOUT_MS  默认 45000
 */
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'

const require_ = createRequire(import.meta.url)

function loadWs() {
  // 优先就近 node_modules（仓库根 / 安装目录），找不到再报清晰错误
  try {
    return require_('ws')
  } catch {
    throw new Error('未找到 ws 模块：请在 NexBrowser 安装目录或仓库根目录运行（node_modules/ws 需存在）')
  }
}

const WS = loadWs()
const BRIDGE_URL = process.env.LIVE_BRIDGE_URL || 'ws://127.0.0.1:19876/api/live-bridge'
const TIMEOUT_MS = Number(process.env.LIVE_BRIDGE_TIMEOUT_MS || 45000)

// ---------------------------------------------------------------------------
// Live Bridge WS 客户端（长连接 + 按需重连）
// ---------------------------------------------------------------------------

let wsClient = null

function connectBridge() {
  return new Promise((resolve, reject) => {
    const ws = new WS(BRIDGE_URL)
    const pending = new Map()
    let seq = 0
    const timer = setTimeout(() => reject(new Error(`连接 Live Bridge 超时（${BRIDGE_URL}）— 请确认 NexBrowser 已启动`)), 8000)
    ws.once('open', () => {
      clearTimeout(timer)
      resolve(client)
    })
    ws.once('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`无法连接 Live Bridge（${BRIDGE_URL}）：${e.message} — 请确认 NexBrowser 已启动`))
    })
    ws.on('close', () => {
      if (wsClient === client) wsClient = null
      for (const [, p] of pending) p.reject(new Error('Live Bridge 连接已断开'))
      pending.clear()
    })
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(String(raw)) } catch { return }
      if (msg.type === 'event') return
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p.resolve(msg)
      }
    })
    const client = {
      ws,
      send(cmd, args = {}) {
        return new Promise((res, rej) => {
          const id = `m${++seq}`
          const t = setTimeout(() => {
            pending.delete(id)
            rej(new Error(`命令超时: ${cmd}`))
          }, TIMEOUT_MS)
          pending.set(id, {
            resolve: (m) => { clearTimeout(t); res(m) },
            reject: (e) => { clearTimeout(t); rej(e) },
          })
          ws.send(JSON.stringify({ id, cmd, args }))
        })
      },
    }
  })
}

async function bridgeSend(cmd, args = {}) {
  if (!wsClient || wsClient.ws.readyState !== WS.OPEN) {
    wsClient = await connectBridge()
  }
  const resp = await wsClient.send(cmd, args)
  if (!resp.ok) throw new Error(resp.error || `命令 ${cmd} 失败`)
  return resp.result ?? {}
}

// ---------------------------------------------------------------------------
// MCP 工具定义
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'browser_connect',
    description:
      '连接浏览器（任务第一步）。用户提供 profile 环境码（如 BUPM2Z）时必须传 code：自动 Launch 或复用该指纹实例并附着；未传 code 则附着最近 Launch 的浏览器。不会代替登录；若返回登录页，提示用户手动登录后用 browser_wait_for 等待后再继续。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'profile 环境码；用户指定店铺/实例时必填' },
        force: { type: 'boolean', description: 'true 时强制重新拉起浏览器（仅在有 code 时生效）' },
      },
    },
    run: (a) => {
      const code = String(a?.code ?? '').trim()
      if (code) return bridgeSend('profile', { code, force: Boolean(a?.force) })
      return bridgeSend('attach')
    },
  },
  {
    name: 'browser_attach',
    description:
      '附着到最近 Launch 的浏览器（不重启）。仅当用户未指定 profile code 时使用；指定了 code 请用 browser_connect({ code })。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => bridgeSend('attach'),
  },
  {
    name: 'browser_observe',
    description: '观察当前页面状态：URL、标题、场景（scene）、可交互要素提示（hints）。每步操作后调用以决定下一步。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => bridgeSend('observe'),
  },
  {
    name: 'browser_profile',
    description:
      '按 profile code 自动 Launch（或复用）指定指纹浏览器并附着。与 browser_connect({ code }) 等价；用户说「打开 BUPM2Z」等时应优先使用 browser_connect 或本工具，不要用 browser_attach。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'profile 编码，如 BUPM2Z' },
        force: { type: 'boolean', description: 'true 时强制重新拉起' },
      },
      required: ['code'],
    },
    run: (a) => bridgeSend('profile', a),
  },
  {
    name: 'browser_snapshot',
    description: '获取当前页面的可访问性树（A11y tree）快照，元素带 [ref=eN] 稳定标记。优先用本工具理解页面结构，再用 ref 精确点击/输入。',
    inputSchema: {
      type: 'object',
      properties: { maxChars: { type: 'number', description: '最大字符数，默认 50000' } },
    },
    run: (a) => bridgeSend('snapshot', a),
  },
  {
    name: 'browser_click',
    description: '点击元素。优先传 ref（来自 browser_snapshot 的 [ref=eN]）；也可传 CSS/text 选择器 selector。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'snapshot 中的 ref，如 e12' },
        selector: { type: 'string', description: 'Playwright 选择器（ref 缺省时使用）' },
      },
    },
    run: (a) => (a.ref ? bridgeSend('click_ref', { ref: a.ref }) : bridgeSend('click', { selector: a.selector })),
  },
  {
    name: 'browser_type',
    description: '在输入框填入文本。优先传 ref；也可传 selector。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['text'],
    },
    run: (a) => (a.ref ? bridgeSend('type_ref', { ref: a.ref, text: a.text }) : bridgeSend('type', { selector: a.selector, text: a.text })),
  },
  {
    name: 'browser_navigate',
    description: '导航到指定 URL。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
    run: (a) => bridgeSend('navigate', a),
  },
  {
    name: 'browser_back',
    description: '浏览器后退。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => bridgeSend('back'),
  },
  {
    name: 'browser_wait_for',
    description: '智能等待页面条件满足：url 包含 / 页面出现文本 / 选择器可见 / 选择器消失 / 网络空闲。代替盲目 sleep。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '等待 URL 包含此子串' },
        text: { type: 'string', description: '等待页面出现此文本' },
        selector: { type: 'string', description: '等待选择器可见' },
        selector_gone: { type: 'string', description: '等待选择器消失' },
        network_idle: { type: 'boolean', description: '等待网络空闲' },
        timeout: { type: 'number', description: '毫秒，默认 15000' },
      },
    },
    run: (a) => bridgeSend('wait_for', a),
  },
  {
    name: 'browser_tabs_list',
    description: '列出当前浏览器所有标签页（index/url/title/active）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: () => bridgeSend('tabs_list'),
  },
  {
    name: 'browser_tab_select',
    description: '切换到指定标签页。',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
    run: (a) => bridgeSend('tab_select', a),
  },
  {
    name: 'browser_tab_new',
    description: '新建标签页，可选直接打开 URL。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    run: (a) => bridgeSend('tab_new', a),
  },
  {
    name: 'browser_tab_close',
    description: '关闭标签页（缺省关闭当前标签页）。',
    inputSchema: { type: 'object', properties: { index: { type: 'number' } } },
    run: (a) => bridgeSend('tab_close', a),
  },
  {
    name: 'browser_screenshot',
    description: '截取当前页面截图（PNG）。用于 snapshot 无法覆盖的视觉确认（如 canvas、验证码）。',
    inputSchema: { type: 'object', properties: { fullPage: { type: 'boolean' } } },
    run: (a) => bridgeSend('screenshot', a),
    formatResult: (r) => ({
      content: [{ type: 'image', data: r.imageBase64, mimeType: 'image/png' }],
    }),
  },
  {
    name: 'browser_evaluate',
    description: '在页面执行 JavaScript 表达式并返回结果（兜底能力，优先用 snapshot/click/type）。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' } },
      required: ['expression'],
    },
    run: (a) => bridgeSend('evaluate', a),
  },
  {
    name: 'browser_extract_content',
    description:
      '提取当前页面正文为 Markdown（Defuddle 引擎，自动去除导航/广告/侧栏，保留标题/作者/正文/元数据）。适合 AI 阅读长文、商品详情、文档页；比 read_dom 更干净。需先 browser_connect/attach。',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'number', description: 'Markdown 最大字符数，默认 80000' },
        includeHtml: { type: 'boolean', description: '同时返回清洗后的 contentHtml' },
        contentSelector: { type: 'string', description: '可选，强制以此 CSS 选择器为正文根' },
        useAsync: { type: 'boolean', description: '是否启用异步 extractor（如 YouTube 字幕），默认 true' },
      },
    },
    run: (a) => bridgeSend('extract_content', a),
    formatResult: (r) => {
      const meta = [
        r.title ? `# ${r.title}` : '',
        r.url ? `URL: ${r.url}` : '',
        r.author ? `Author: ${r.author}` : '',
        r.published ? `Published: ${r.published}` : '',
        r.site ? `Site: ${r.site}` : '',
        r.wordCount != null ? `Words: ${r.wordCount}` : '',
        r.extractorType ? `Extractor: ${r.extractorType}` : '',
      ].filter(Boolean).join('\n')
      const body = r.markdown || ''
      const suffix = r.truncated ? '\n\n[内容已截断，可增大 maxChars 重试]' : ''
      return {
        content: [{ type: 'text', text: meta ? `${meta}\n\n---\n\n${body}${suffix}` : `${body}${suffix}` }],
      }
    },
  },
]

const toolMap = new Map(TOOLS.map((t) => [t.name, t]))

// ---------------------------------------------------------------------------
// MCP stdio 传输（按行分隔 JSON-RPC 2.0）
// ---------------------------------------------------------------------------

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function replyResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleRequest(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    replyResult(id, {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'nexbrowser-live-bridge', version: '1.0.0' },
    })
    return
  }
  if (method === 'ping') {
    replyResult(id, {})
    return
  }
  if (method === 'tools/list') {
    replyResult(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    const tool = toolMap.get(name)
    if (!tool) {
      replyError(id, -32602, `unknown tool: ${name}`)
      return
    }
    try {
      const result = await tool.run(args)
      if (tool.formatResult) {
        replyResult(id, tool.formatResult(result))
      } else {
        replyResult(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] })
      }
    } catch (e) {
      replyResult(id, {
        content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
        isError: true,
      })
    }
    return
  }
  if (id !== undefined) {
    replyError(id, -32601, `method not found: ${method}`)
  }
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try { msg = JSON.parse(trimmed) } catch { return }
  // 通知（无 id）直接忽略：notifications/initialized 等
  if (msg.method && msg.id === undefined) return
  if (msg.method) void handleRequest(msg)
})
rl.on('close', () => {
  try { wsClient?.ws.close() } catch { /* ignore */ }
  process.exit(0)
})

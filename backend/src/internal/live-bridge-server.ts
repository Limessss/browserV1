/**
 * 实时浏览器桥（Live Bridge）
 *
 * 一个 WebSocket 端点 ws://127.0.0.1:<port>/api/live-bridge，让远端以"对话"方式
 * 实时操作本机已 Launch 的 Chromium 浏览器：发 navigate/click/type/screenshot/read_dom
 * 等命令，收回截图/DOM/控制台事件。
 *
 * 设计：
 *  - 单 ws 连接 = 单 profile session（client 发 "profile" cmd 选 profile）
 *  - 同时仅允许 1 个 ws 连接；新连接踢掉旧连接（带 "replaced" 事件）
 *  - 复用 Launch HTTP 的 http.Server 端口（19876）；挂 'upgrade' 事件钩到 /api/live-bridge 路径
 *  - 鉴权：与 Launch API 同样的 X-Ant-Api-Key（仅当用户在设置启用）
 *  - 协议：JSON over WS，每条命令带 id，响应也带同样 id；服务器主动推送走 { type: "event", event, data }
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

import { browserInstanceStartByCode } from './browser-instance-service'
import {
  loadPlaywright,
  type PlaywrightBrowser,
  type PlaywrightPage,
} from './playwright-loader'
import { getLaunchServerActiveTarget } from './launch-server-state'
import { loadLaunchServerConfig } from './app-config-store'
import { getSqlite } from './database/sqlite-store'

const WS_PATH = '/api/live-bridge'

interface LiveBridgeState {
  wss: WebSocketServer | null
  current: WebSocket | null
  browser: PlaywrightBrowser | null
  page: PlaywrightPage | null
  activeCode: string
  consoleBuffer: Array<{ level: string; text: string; ts: number }>
  consoleListenersAttached: boolean
  /**
   * 命令执行队列。串行执行 handleCommand 以避免长 async 操作（profile 拉起）
   * 与后续短命令（screenshot/url）并发跑，导致 state 半初始化问题。
   */
  commandQueue: Promise<void>
}

const state: LiveBridgeState = {
  wss: null,
  current: null,
  browser: null,
  page: null,
  activeCode: '',
  consoleBuffer: [],
  consoleListenersAttached: false,
  commandQueue: Promise.resolve(),
}

function log(m: string): void {
  process.stdout.write(`[LiveBridge ${new Date().toLocaleTimeString()}] ${m}\n`)
}

function send(ws: WebSocket, msg: unknown): void {
  try {
    ws.send(JSON.stringify(msg))
  } catch {
    /* ws closed */
  }
}

function sendResponse(ws: WebSocket, id: string, ok: boolean, result?: unknown, error?: string): void {
  send(ws, { id, ok, ...(ok ? { result } : { error }) })
}

function localhostOnly(req: IncomingMessage): boolean {
  const remote = (req.socket as Socket | undefined)?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function checkAuth(req: IncomingMessage): boolean {
  const cfg = loadLaunchServerConfig()
  const auth = cfg.auth
  if (!auth.enabled || !auth.apiKey) return true
  const header = (auth.header || 'X-Ant-Api-Key').toLowerCase()
  const got = String(req.headers[header] ?? '').trim()
  return got === auth.apiKey
}

async function ensureProfile(code: string): Promise<PlaywrightPage> {
  // 1) 调 browserInstanceStartByCode —— 内部会 setLaunchServerActiveProfile
  try {
    const db = getSqlite()
    if (!db) throw new Error('SQLite 未初始化')
    const params = { launchArgs: ['--window-size=1440,900'], startUrls: [], skipDefaultStartUrls: false }
    await browserInstanceStartByCode(db, code, params)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`  browserInstanceStartByCode(${code}) warn: ${msg}（可能 profile 已在跑）`)
  }
  // 2) 等 active target
  const target = getLaunchServerActiveTarget()
  let debugPort = target.debugPort
  for (let i = 0; debugPort <= 0 && i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    debugPort = getLaunchServerActiveTarget().debugPort
  }
  if (debugPort <= 0) {
    throw new Error(`profile ${code} 拉起后未拿到 debugPort`)
  }
  // 3) connectOverCDP（已有连接就复用）
  if (state.browser) {
    try { await state.browser.close() } catch { /* ignore */ }
    state.browser = null
    state.page = null
  }
  const { chromium } = await loadPlaywright()
  state.browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  const ctx = state.browser.contexts()[0]
  if (!ctx) throw new Error('no context in CDP target')
  let page = ctx.pages()[0]
  if (!page) page = await ctx.newPage()
  state.page = page
  state.activeCode = code
  attachConsoleListeners(page)
  return page
}

function attachConsoleListeners(page: PlaywrightPage): void {
  if (state.consoleListenersAttached) return
  state.consoleListenersAttached = true
  page.on('console', (msg) => {
    const entry = { level: msg.type(), text: msg.text(), ts: Date.now() }
    state.consoleBuffer.push(entry)
    if (state.consoleBuffer.length > 500) state.consoleBuffer.shift()
    if (state.current) {
      send(state.current, { type: 'event', event: 'console', data: entry })
    }
  })
  page.on('pageerror', (err) => {
    const entry = { level: 'error', text: String(err.message ?? err), ts: Date.now() }
    state.consoleBuffer.push(entry)
    if (state.current) {
      send(state.current, { type: 'event', event: 'console', data: entry })
    }
  })
}

async function handleCommand(ws: WebSocket, msg: any): Promise<void> {
  const id = String(msg?.id ?? '')
  const cmd = String(msg?.cmd ?? '')
  const args = (msg?.args ?? {}) as Record<string, unknown>
  if (!id || !cmd) {
    sendResponse(ws, '', false, undefined, 'missing id or cmd')
    return
  }
  if (cmd === 'ping') {
    sendResponse(ws, id, true, { pong: Date.now() })
    return
  }
  if (cmd === 'profile') {
    const code = String(args.code ?? '').trim()
    if (!code) {
      sendResponse(ws, id, false, undefined, 'missing args.code')
      return
    }
    try {
      const page = await ensureProfile(code)
      sendResponse(ws, id, true, {
        code,
        url: page.url(),
        title: await page.title(),
      })
    } catch (e) {
      sendResponse(ws, id, false, undefined, e instanceof Error ? e.message : String(e))
    }
    return
  }
  // 以下命令要求已有 page
  if (!state.page) {
    sendResponse(ws, id, false, undefined, 'no page — send "profile" first')
    return
  }
  const page = state.page
  try {
    switch (cmd) {
      case 'navigate': {
        const url = String(args.url ?? '').trim()
        if (!url) { sendResponse(ws, id, false, undefined, 'missing args.url'); return }
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout ?? 30000) })
        sendResponse(ws, id, true, { url: page.url(), title: await page.title() })
        return
      }
      case 'wait': {
        const ms = Number(args.ms ?? 1000)
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, ms))))
        sendResponse(ws, id, true, { waited: ms })
        return
      }
      case 'screenshot': {
        const buf = await page.screenshot({
          fullPage: Boolean(args.fullPage),
          type: 'png',
        })
        sendResponse(ws, id, true, {
          imageBase64: Buffer.from(buf).toString('base64'),
          width: page.viewportSize()?.width ?? 0,
          height: page.viewportSize()?.height ?? 0,
        })
        return
      }
      case 'evaluate': {
        const expr = String(args.expression ?? '')
        if (!expr) { sendResponse(ws, id, false, undefined, 'missing args.expression'); return }
        const result = await page.evaluate(expr)
        sendResponse(ws, id, true, { result })
        return
      }
      case 'read_dom': {
        const maxChars = Number(args.maxChars ?? 20000)
        const html = await page.content()
        const text = await page.evaluate(() => document.body?.innerText || '')
        sendResponse(ws, id, true, {
          url: page.url(),
          title: await page.title(),
          html: html.length > maxChars ? html.slice(0, maxChars) + '...[truncated]' : html,
          text: text.length > maxChars ? text.slice(0, maxChars) + '...[truncated]' : text,
          htmlLength: html.length,
          textLength: text.length,
        })
        return
      }
      case 'find': {
        const selector = String(args.selector ?? '')
        if (!selector) { sendResponse(ws, id, false, undefined, 'missing args.selector'); return }
        const handle = await page.locator(selector).first()
        const count = await page.locator(selector).count()
        let text = ''
        let visible = false
        try {
          text = (await handle.textContent({ timeout: 1000 })) ?? ''
          visible = await handle.isVisible({ timeout: 1000 })
        } catch { /* no element */ }
        sendResponse(ws, id, true, { count, text: text.slice(0, 500), visible })
        return
      }
      case 'click': {
        const selector = String(args.selector ?? '')
        if (!selector) { sendResponse(ws, id, false, undefined, 'missing args.selector'); return }
        await page.locator(selector).first().click({ timeout: Number(args.timeout ?? 10000) })
        sendResponse(ws, id, true, { clicked: selector })
        return
      }
      case 'type': {
        const selector = String(args.selector ?? '')
        const text = String(args.text ?? '')
        if (!selector) { sendResponse(ws, id, false, undefined, 'missing args.selector'); return }
        await page.locator(selector).first().fill(text, { timeout: Number(args.timeout ?? 10000) })
        sendResponse(ws, id, true, { typed: text.length })
        return
      }
      case 'console_log': {
        sendResponse(ws, id, true, { entries: state.consoleBuffer })
        return
      }
      case 'url': {
        sendResponse(ws, id, true, { url: page.url(), title: await page.title() })
        return
      }
      case 'back':
      case 'forward':
      case 'reload': {
        if (cmd === 'back') await page.goBack({ timeout: 10000 }).catch(() => {})
        if (cmd === 'forward') await page.goForward({ timeout: 10000 }).catch(() => {})
        if (cmd === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        sendResponse(ws, id, true, { url: page.url() })
        return
      }
      default:
        sendResponse(ws, id, false, undefined, `unknown cmd: ${cmd}`)
        return
    }
  } catch (e) {
    sendResponse(ws, id, false, undefined, e instanceof Error ? e.message : String(e))
  }
}

export function startLiveBridge(): boolean {
  if (state.wss) {
    log('already started')
    return true
  }
  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, req) => {
    // 单连接：踢掉旧的
    if (state.current && state.current !== ws) {
      try { send(state.current, { type: 'event', event: 'replaced', data: { reason: 'new connection took over' } }) } catch {}
      try { state.current.close(1000, 'replaced') } catch {}
    }
    // 先把 message listener 全注册好，再设 state.current 与 hello
    // ——避免 client 在 hello 之前发命令，message listener 还没挂上导致丢消息
    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      // 串行化命令处理：把 handleCommand 接到上一个的 .then 上
      // ——这样 ensureProfile 还没返回时，screenshot / url 等不会并发跑、不会读到半初始化的 state
      state.commandQueue = state.commandQueue
        .then(() => handleCommand(ws, msg))
        .catch((e) => {
          log(`handleCommand uncaught: ${e instanceof Error ? e.message : String(e)}`)
        })
    })
    ws.on('close', () => {
      log('client closed')
      if (state.current === ws) state.current = null
    })
    ws.on('error', (e) => log(`ws error: ${e.message}`))
    state.current = ws
    log(`client connected from ${req.socket.remoteAddress ?? '?'}`)
    send(ws, { type: 'event', event: 'hello', data: { ts: Date.now() } })
  })
  state.wss = wss
  log(`WS endpoint ready (will serve /api/live-bridge on launch HTTP server)`)
  return true
}

/**
 * 由 launch-http-server 的 attachLaunchUpgradeHandler 在匹配 /api/live-bridge 路径时调用。
 */
export function handleLiveBridgeUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  if (!state.wss) {
    socket.destroy()
    return
  }
  if (!localhostOnly(req)) {
    socket.destroy()
    return
  }
  if (!checkAuth(req)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
    } catch { /* ignore */ }
    return
  }
  state.wss.handleUpgrade(req, socket, head, (ws) => {
    state.wss!.emit('connection', ws, req)
  })
}

export async function stopLiveBridge(): Promise<void> {
  if (state.current) {
    try { state.current.close(1000, 'server stopped') } catch {}
    state.current = null
  }
  if (state.wss) {
    await new Promise<void>((resolve) => state.wss!.close(() => resolve()))
    state.wss = null
  }
  if (state.browser) {
    try { await state.browser.close() } catch { /* ignore */ }
    state.browser = null
    state.page = null
  }
  state.activeCode = ''
  state.consoleBuffer = []
  state.consoleListenersAttached = false
  log('stopped')
}

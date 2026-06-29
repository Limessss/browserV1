/**
 * 实时浏览器桥（Live Bridge）
 *
 * 一个 WebSocket 端点 ws://127.0.0.1:<port>/api/live-bridge，让远端（AI Agent / CLI / 前端）
 * 以"对话"方式实时操作本机已 Launch 的 Chromium 浏览器。
 *
 * 设计（v2，多会话 + 语义化）：
 *  - 多 ws 连接并存：每个连接 = 一个独立 Session（各自的 activeCode / 当前 tab / 命令队列）
 *  - 浏览器 CDP 连接按 debugPort 共享池化（多个 Session 可同时附着同一浏览器）
 *  - 每个 Session 串行执行自己的命令；对页面有副作用的命令再经 per-page 锁串行，
 *    避免两个 Session 同时操作同一 tab
 *  - 语义化定位：snapshot 返回 A11y tree（带 [ref=eN] 标记），click_ref / type_ref 按 ref 操作
 *    （复用 Playwright 官方 ariaSnapshot({ mode:'ai' }) 与 aria-ref= 选择器，与 Playwright MCP 同款）
 *  - 多 tab：tabs_list / tab_select / tab_new / tab_close
 *  - 智能等待：wait_for { url | text | selector | selector_gone | network_idle }
 *  - 鉴权：与 Launch API 同样的 X-Ant-Api-Key（仅当用户在设置启用）；仅允许 127.0.0.1
 *  - 协议：JSON over WS，每条命令带 id，响应带同样 id；服务器主动推送 { type:"event", event, data }
 */
import { WebSocketServer, type WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import { randomUUID } from 'node:crypto'

import { browserInstanceStartByCode } from './browser-instance-service'
import {
  loadPlaywright,
  type PlaywrightBrowser,
  type PlaywrightBrowserContext,
  type PlaywrightPage,
} from './playwright-loader'
import { getLaunchServerActiveTarget } from './launch-server-state'
import { loadLaunchServerConfig } from './app-config-store'
import { getSqlite } from './database/sqlite-store'
import {
  capturePageHtml,
  extractContentFromHtml,
} from './live-bridge-extract'

const WS_PATH = '/api/live-bridge'
const MAX_SESSIONS = 8

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface PageObserveResult {
  url: string
  title: string
  scene: 'unknown' | 'homepage' | 'chat_inbox' | 'chat_session' | 'other'
  chat?: {
    searchPlaceholder?: string
    activeCustomer?: string
    messageInput?: { placeholder: string; value: string; visible: boolean }
    sendButton?: { text: string; enabled: boolean }
    filters?: string[]
    overlays?: string[]
  }
  hints: string[]
}

interface ConsoleEntry {
  level: string
  text: string
  ts: number
}

/** 每个 ws 连接一个 Session，互不阻塞 */
interface Session {
  id: string
  ws: WebSocket
  /** 当前附着的浏览器调试端口（0 = 未附着） */
  debugPort: number
  activeCode: string
  /** 该 Session 当前操作的 tab */
  page: PlaywrightPage | null
  /** Session 内命令串行队列 */
  queue: Promise<void>
  /** 最近一次 snapshot 的自增 id，用于提示 ref 时效 */
  snapshotId: number
}

interface BrowserPoolEntry {
  browser: PlaywrightBrowser
  debugPort: number
}

// ---------------------------------------------------------------------------
// 全局状态
// ---------------------------------------------------------------------------

let wss: WebSocketServer | null = null
const sessions = new Map<string, Session>()
/** CDP 连接池：同一 debugPort 的浏览器在所有 Session 间共享 */
const browserPool = new Map<number, BrowserPoolEntry>()
/** 已挂过 console/page 监听的页面（防重复挂） */
const pagesWithListeners = new WeakSet<PlaywrightPage>()
/** 每页面 console 缓冲 */
const pageConsoleBuffers = new WeakMap<PlaywrightPage, ConsoleEntry[]>()
/** 每页面写操作锁：跨 Session 串行化对同一 tab 的副作用命令 */
const pageMutationQueues = new WeakMap<PlaywrightPage, Promise<void>>()

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

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

function sessionSnapshot(session: Session): Record<string, unknown> {
  return {
    sessionId: session.id,
    attached: Boolean(session.page),
    activeCode: session.activeCode || null,
    debugPort: session.debugPort || null,
    url: session.page?.url() ?? null,
    sessions: sessions.size,
  }
}

async function pageIsAlive(page: PlaywrightPage): Promise<boolean> {
  try {
    await page.evaluate(() => document.readyState)
    return true
  } catch {
    return false
  }
}

/** 跨 Session 的 per-page 写锁：对同一 tab 的副作用命令串行执行 */
function runOnPage<T>(page: PlaywrightPage, fn: () => Promise<T>): Promise<T> {
  const prev = pageMutationQueues.get(page) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  pageMutationQueues.set(page, next.then(() => undefined, () => undefined))
  return next
}

/**
 * 安全拦截点（预留）：后续在此实现域名 allowlist、高风险动作二次确认与审计日志。
 * 当前一律放行。
 */
function beforeAction(_session: Session, _cmd: string, _args: Record<string, unknown>): { allow: boolean; reason?: string } {
  return { allow: true }
}

// ---------------------------------------------------------------------------
// 浏览器连接池 / 页面监听
// ---------------------------------------------------------------------------

async function getBrowserForPort(debugPort: number): Promise<PlaywrightBrowser> {
  const existing = browserPool.get(debugPort)
  if (existing && existing.browser.isConnected()) {
    return existing.browser
  }
  browserPool.delete(debugPort)
  const { chromium } = await loadPlaywright()
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`)
  browser.on('disconnected', () => {
    browserPool.delete(debugPort)
    for (const s of sessions.values()) {
      if (s.debugPort === debugPort) {
        s.page = null
        s.debugPort = 0
        send(s.ws, { type: 'event', event: 'detached', data: { reason: 'browser disconnected', ts: Date.now() } })
      }
    }
    log(`CDP :${debugPort} disconnected`)
  })
  browserPool.set(debugPort, { browser, debugPort })
  log(`CDP :${debugPort} connected (pool size ${browserPool.size})`)
  return browser
}

function defaultContext(browser: PlaywrightBrowser): PlaywrightBrowserContext {
  const ctx = browser.contexts()[0]
  if (!ctx) throw new Error('no context in CDP target')
  return ctx
}

function listPages(ctx: PlaywrightBrowserContext): PlaywrightPage[] {
  return ctx.pages().filter((p) => !p.url().startsWith('devtools://'))
}

async function pickInitialPage(ctx: PlaywrightBrowserContext): Promise<PlaywrightPage> {
  let page = listPages(ctx)[0]
  if (!page) page = await ctx.newPage()
  return page
}

function consoleBufferOf(page: PlaywrightPage): ConsoleEntry[] {
  let buf = pageConsoleBuffers.get(page)
  if (!buf) {
    buf = []
    pageConsoleBuffers.set(page, buf)
  }
  return buf
}

/** 把页面事件广播给"当前正盯着这个 tab"的所有 Session */
function broadcastToWatchers(page: PlaywrightPage, msg: unknown): void {
  for (const s of sessions.values()) {
    if (s.page === page) send(s.ws, msg)
  }
}

function attachPageListeners(page: PlaywrightPage): void {
  if (pagesWithListeners.has(page)) return
  pagesWithListeners.add(page)
  page.on('console', (msg) => {
    const entry: ConsoleEntry = { level: msg.type(), text: msg.text(), ts: Date.now() }
    const buf = consoleBufferOf(page)
    buf.push(entry)
    if (buf.length > 500) buf.shift()
    broadcastToWatchers(page, { type: 'event', event: 'console', data: entry })
  })
  page.on('pageerror', (err) => {
    const entry: ConsoleEntry = { level: 'error', text: String(err.message ?? err), ts: Date.now() }
    const buf = consoleBufferOf(page)
    buf.push(entry)
    if (buf.length > 500) buf.shift()
    broadcastToWatchers(page, { type: 'event', event: 'console', data: entry })
  })
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return
    void page
      .title()
      .catch(() => '')
      .then((title) => {
        broadcastToWatchers(page, {
          type: 'event',
          event: 'page_changed',
          data: { url: page.url(), title, ts: Date.now() },
        })
      })
  })
  page.on('close', () => {
    for (const s of sessions.values()) {
      if (s.page === page) {
        s.page = null
        send(s.ws, { type: 'event', event: 'tab_closed', data: { ts: Date.now() } })
      }
    }
  })
}

/** 切换 Session 的当前 tab（统一挂监听） */
function setSessionPage(session: Session, page: PlaywrightPage, debugPort: number): void {
  session.page = page
  session.debugPort = debugPort
  attachPageListeners(page)
}

// ---------------------------------------------------------------------------
// observe：语义化页面状态
// ---------------------------------------------------------------------------

async function observeCurrentPage(page: PlaywrightPage): Promise<PageObserveResult> {
  // 页面可能正在导航（如 profile 刚拉起加载起始页），evaluate 会撞上
  // "Execution context was destroyed"，等加载完成后重试
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await observeCurrentPageOnce(page)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (attempt < 3 && (msg.includes('Execution context was destroyed') || msg.includes('navigating'))) {
        await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {})
        await new Promise((r) => setTimeout(r, 300))
        continue
      }
      throw e
    }
  }
}

async function observeCurrentPageOnce(page: PlaywrightPage): Promise<PageObserveResult> {
  const url = page.url()
  const title = await page.title()
  const raw = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
    const hints: string[] = []
    const overlays: string[] = []
    for (const label of ['不再显示', '保持页面开启', '关闭页面']) {
      const el = Array.from(document.querySelectorAll('*')).find((n) => (n.textContent || '').trim() === label)
      if (el) overlays.push(label)
    }
    const filters = Array.from(document.querySelectorAll('*'))
      .map((el) => (el.textContent || '').trim())
      .filter((t) => /^(全部|紧急|未回复|未读|已分配|未分配)\s*\(?\d*\)?$/.test(t))
      .slice(0, 12)
    const ta = document.querySelector('textarea[placeholder*="消息"], textarea[placeholder*="message"]') as HTMLTextAreaElement | null
    const sendBtn = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent || '').trim() === '发送')
    const search = document.querySelector('input[placeholder*="搜索"]') as HTMLInputElement | null
    let activeCustomer = ''
    const headerCandidates = Array.from(document.querySelectorAll('*')).filter((el) => {
      const r = el.getBoundingClientRect()
      const t = (el.textContent || '').trim()
      return r.left > 300 && r.left < 900 && r.top > 40 && r.top < 120 && t.length > 2 && t.length < 40 && el.children.length <= 2
    })
    if (headerCandidates.length) activeCustomer = (headerCandidates[0].textContent || '').trim()
    if (overlays.length) hints.push(`页面有弹层: ${overlays.join(', ')}`)
    if (ta && ta.value.trim()) hints.push('输入框已有草稿')
    if (sendBtn && !sendBtn.disabled) hints.push('发送按钮可用')
    if (text.includes('暂无未分配的聊天')) hints.push('当前无未分配会话')
    return {
      textHead: text.slice(0, 400),
      filters,
      overlays,
      hints,
      searchPlaceholder: search?.placeholder || '',
      activeCustomer,
      messageInput: ta
        ? { placeholder: ta.placeholder || '', value: ta.value || '', visible: ta.getBoundingClientRect().height > 0 }
        : null,
      sendButton: sendBtn
        ? { text: (sendBtn.textContent || '').trim(), enabled: !sendBtn.disabled }
        : null,
    }
  })
  let scene: PageObserveResult['scene'] = 'other'
  if (url.includes('/homepage')) scene = 'homepage'
  else if (url.includes('/chat/inbox')) scene = url.includes('current') ? 'chat_inbox' : 'chat_session'
  else if (raw.messageInput?.visible) scene = 'chat_session'
  return {
    url,
    title,
    scene,
    chat: {
      searchPlaceholder: raw.searchPlaceholder,
      activeCustomer: raw.activeCustomer || undefined,
      messageInput: raw.messageInput || undefined,
      sendButton: raw.sendButton || undefined,
      filters: raw.filters,
      overlays: raw.overlays,
    },
    hints: raw.hints,
  }
}

// ---------------------------------------------------------------------------
// snapshot / ref：A11y tree 语义定位（与 Playwright MCP 同款机制）
// ---------------------------------------------------------------------------

interface AriaSnapshotCapablePage {
  ariaSnapshot(options: { mode?: string; timeout?: number }): Promise<string>
}

/** 捕获带 [ref=eN] 标记的 A11y tree 文本 */
async function captureAriaSnapshot(page: PlaywrightPage): Promise<string> {
  // page.ariaSnapshot({ mode:'ai' }) 在 playwright>=1.59 可用（公开 channel，类型未导出 mode）
  const capable = page as unknown as AriaSnapshotCapablePage
  return await capable.ariaSnapshot({ mode: 'ai' })
}

function refLocator(page: PlaywrightPage, ref: string) {
  return page.locator(`aria-ref=${ref}`)
}

function isStaleRefError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('not found in the current page snapshot') || msg.includes('aria-ref')
}

// ---------------------------------------------------------------------------
// 附着 / 拉起 profile（Session 级）
// ---------------------------------------------------------------------------

async function ensureProfileForSession(session: Session, code: string, force = false): Promise<PlaywrightPage> {
  const normalized = code.trim()
  if (!force && session.page && session.activeCode === normalized && await pageIsAlive(session.page)) {
    log(`[${session.id.slice(0, 8)}] reuse existing page for ${normalized}`)
    return session.page
  }
  // 1) 调 browserInstanceStartByCode —— 内部会 setLaunchServerActiveProfile
  try {
    const db = getSqlite()
    if (!db) throw new Error('SQLite 未初始化')
    const params = { launchArgs: ['--window-size=1440,900'], startUrls: [], skipDefaultStartUrls: false }
    await browserInstanceStartByCode(db, normalized, params)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    log(`  browserInstanceStartByCode(${normalized}) warn: ${msg}（可能 profile 已在跑）`)
  }
  // 2) 等 active target
  let debugPort = getLaunchServerActiveTarget().debugPort
  for (let i = 0; debugPort <= 0 && i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 500))
    debugPort = getLaunchServerActiveTarget().debugPort
  }
  if (debugPort <= 0) {
    throw new Error(`profile ${normalized} 拉起后未拿到 debugPort`)
  }
  const browser = await getBrowserForPort(debugPort)
  const page = await pickInitialPage(defaultContext(browser))
  setSessionPage(session, page, debugPort)
  session.activeCode = normalized
  return page
}

async function attachActiveBrowserForSession(session: Session): Promise<PlaywrightPage> {
  const target = getLaunchServerActiveTarget()
  let debugPort = target.debugPort
  for (let i = 0; debugPort <= 0 && i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 300))
    debugPort = getLaunchServerActiveTarget().debugPort
  }
  if (debugPort <= 0) {
    throw new Error('当前没有已 Launch 的浏览器，请先在实例列表启动 profile 或发送 profile 命令')
  }
  const browser = await getBrowserForPort(debugPort)
  const page = await pickInitialPage(defaultContext(browser))
  setSessionPage(session, page, debugPort)
  const code = String(target.profileName ?? session.activeCode ?? '').trim()
  if (code) session.activeCode = code
  return page
}

function sessionContext(session: Session): PlaywrightBrowserContext {
  const entry = session.debugPort ? browserPool.get(session.debugPort) : undefined
  if (!entry || !entry.browser.isConnected()) {
    throw new Error('未附着浏览器 — 先发送 attach 或 profile 命令')
  }
  return defaultContext(entry.browser)
}

// ---------------------------------------------------------------------------
// 命令分发
// ---------------------------------------------------------------------------

async function handleCommand(session: Session, msg: any): Promise<void> {
  const ws = session.ws
  const id = String(msg?.id ?? '')
  const cmd = String(msg?.cmd ?? '')
  const args = (msg?.args ?? {}) as Record<string, unknown>
  if (!id || !cmd) {
    sendResponse(ws, '', false, undefined, 'missing id or cmd')
    return
  }
  const gate = beforeAction(session, cmd, args)
  if (!gate.allow) {
    sendResponse(ws, id, false, undefined, `blocked: ${gate.reason ?? 'policy'}`)
    return
  }
  if (cmd === 'ping') {
    sendResponse(ws, id, true, { pong: Date.now(), session: sessionSnapshot(session) })
    return
  }
  if (cmd === 'attach') {
    try {
      const page = await attachActiveBrowserForSession(session)
      const observed = await observeCurrentPage(page)
      sendResponse(ws, id, true, {
        attached: true,
        sessionId: session.id,
        activeCode: session.activeCode,
        ...observed,
      })
    } catch (e) {
      sendResponse(ws, id, false, undefined, e instanceof Error ? e.message : String(e))
    }
    return
  }
  if (cmd === 'observe') {
    try {
      if (!session.page || !await pageIsAlive(session.page)) {
        await attachActiveBrowserForSession(session)
      }
      if (!session.page) {
        sendResponse(ws, id, false, undefined, 'no page — send attach or profile first')
        return
      }
      const observed = await observeCurrentPage(session.page)
      sendResponse(ws, id, true, {
        activeCode: session.activeCode,
        ...observed,
      })
    } catch (e) {
      sendResponse(ws, id, false, undefined, e instanceof Error ? e.message : String(e))
    }
    return
  }
  if (cmd === 'profile') {
    const code = String(args.code ?? '').trim()
    if (!code) {
      sendResponse(ws, id, false, undefined, 'missing args.code')
      return
    }
    try {
      const force = Boolean(args.force)
      const page = await ensureProfileForSession(session, code, force)
      const observed = await observeCurrentPage(page)
      sendResponse(ws, id, true, {
        code,
        reused: !force && session.activeCode === code,
        ...observed,
      })
    } catch (e) {
      sendResponse(ws, id, false, undefined, e instanceof Error ? e.message : String(e))
    }
    return
  }
  // ---- 以下命令要求已有 page ----
  if (!session.page) {
    sendResponse(ws, id, false, undefined, 'no page — send "attach" or "profile" first')
    return
  }
  const page = session.page
  try {
    switch (cmd) {
      case 'navigate': {
        const url = String(args.url ?? '').trim()
        if (!url) { sendResponse(ws, id, false, undefined, 'missing args.url'); return }
        await runOnPage(page, () => page.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout ?? 30000) }))
        sendResponse(ws, id, true, { url: page.url(), title: await page.title() })
        return
      }
      case 'wait': {
        const ms = Number(args.ms ?? 1000)
        await new Promise((r) => setTimeout(r, Math.max(0, Math.min(60_000, ms))))
        sendResponse(ws, id, true, { waited: ms })
        return
      }
      case 'wait_for': {
        const timeout = Math.max(100, Math.min(60_000, Number(args.timeout ?? 15_000)))
        const start = Date.now()
        let satisfied: string
        if (args.url) {
          const want = String(args.url)
          await page.waitForURL((u) => u.href.includes(want), { timeout })
          satisfied = 'url'
        } else if (args.text) {
          const want = String(args.text)
          await page.waitForFunction(
            (t) => (document.body?.innerText || '').includes(t),
            want,
            { timeout },
          )
          satisfied = 'text'
        } else if (args.selector) {
          await page.waitForSelector(String(args.selector), { timeout, state: 'visible' })
          satisfied = 'selector'
        } else if (args.selector_gone) {
          await page.waitForSelector(String(args.selector_gone), { timeout, state: 'hidden' })
          satisfied = 'selector_gone'
        } else if (args.network_idle) {
          await page.waitForLoadState('networkidle', { timeout })
          satisfied = 'network_idle'
        } else {
          sendResponse(ws, id, false, undefined, 'wait_for 需要 url / text / selector / selector_gone / network_idle 之一')
          return
        }
        sendResponse(ws, id, true, { satisfied, waitedMs: Date.now() - start, url: page.url() })
        return
      }
      case 'snapshot': {
        const maxChars = Math.max(1000, Math.min(200_000, Number(args.maxChars ?? 50_000)))
        const snapshot = await captureAriaSnapshot(page)
        session.snapshotId += 1
        sendResponse(ws, id, true, {
          snapshotId: session.snapshotId,
          url: page.url(),
          title: await page.title(),
          snapshot: snapshot.length > maxChars ? snapshot.slice(0, maxChars) + '\n...[truncated]' : snapshot,
          length: snapshot.length,
        })
        return
      }
      case 'click_ref': {
        const ref = String(args.ref ?? '').trim()
        if (!ref) { sendResponse(ws, id, false, undefined, 'missing args.ref'); return }
        try {
          await runOnPage(page, () => refLocator(page, ref).click({ timeout: Number(args.timeout ?? 10000) }))
          sendResponse(ws, id, true, { clicked: ref, url: page.url() })
        } catch (e) {
          if (isStaleRefError(e)) {
            sendResponse(ws, id, false, undefined, `stale_snapshot: ref ${ref} 已失效，请重新执行 snapshot 获取最新 ref`)
          } else {
            throw e
          }
        }
        return
      }
      case 'type_ref': {
        const ref = String(args.ref ?? '').trim()
        const text = String(args.text ?? '')
        if (!ref) { sendResponse(ws, id, false, undefined, 'missing args.ref'); return }
        try {
          await runOnPage(page, () => refLocator(page, ref).fill(text, { timeout: Number(args.timeout ?? 10000) }))
          sendResponse(ws, id, true, { typed: text.length, ref })
        } catch (e) {
          if (isStaleRefError(e)) {
            sendResponse(ws, id, false, undefined, `stale_snapshot: ref ${ref} 已失效，请重新执行 snapshot 获取最新 ref`)
          } else {
            throw e
          }
        }
        return
      }
      case 'tabs_list': {
        const ctx = sessionContext(session)
        const pages = listPages(ctx)
        const tabs = await Promise.all(pages.map(async (p, index) => ({
          index,
          url: p.url(),
          title: await p.title().catch(() => ''),
          active: p === session.page,
        })))
        sendResponse(ws, id, true, { tabs })
        return
      }
      case 'tab_select': {
        const ctx = sessionContext(session)
        const pages = listPages(ctx)
        const index = Number(args.index ?? -1)
        const target = pages[index]
        if (!target) { sendResponse(ws, id, false, undefined, `tab index ${index} 不存在（共 ${pages.length} 个）`); return }
        setSessionPage(session, target, session.debugPort)
        await target.bringToFront().catch(() => {})
        sendResponse(ws, id, true, { index, url: target.url(), title: await target.title().catch(() => '') })
        return
      }
      case 'tab_new': {
        const ctx = sessionContext(session)
        const newPage = await ctx.newPage()
        setSessionPage(session, newPage, session.debugPort)
        const url = String(args.url ?? '').trim()
        if (url) {
          await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: Number(args.timeout ?? 30000) })
        }
        const pages = listPages(ctx)
        sendResponse(ws, id, true, { index: pages.indexOf(newPage), url: newPage.url(), title: await newPage.title().catch(() => '') })
        return
      }
      case 'tab_close': {
        const ctx = sessionContext(session)
        const pages = listPages(ctx)
        const index = args.index === undefined ? pages.indexOf(page) : Number(args.index)
        const target = pages[index]
        if (!target) { sendResponse(ws, id, false, undefined, `tab index ${index} 不存在（共 ${pages.length} 个）`); return }
        await target.close()
        const remaining = listPages(ctx)
        if (session.page === target || !session.page) {
          const fallback = remaining[0] ?? null
          if (fallback) setSessionPage(session, fallback, session.debugPort)
          else session.page = null
        }
        sendResponse(ws, id, true, { closed: index, remaining: remaining.length, url: session.page?.url() ?? null })
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
      case 'extract_content': {
        const url = page.url()
        const maxChars = Math.max(0, Math.min(500_000, Number(args.maxChars ?? 80_000)))
        const includeHtml = Boolean(args.includeHtml)
        const contentSelector = String(args.contentSelector ?? '').trim() || undefined
        const html = await capturePageHtml(page)
        const extracted = await extractContentFromHtml(String(html), url, {
          markdown: true,
          includeHtml,
          maxChars,
          contentSelector,
          useAsync: args.useAsync !== false,
        })
        sendResponse(ws, id, true, extracted)
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
        await runOnPage(page, () => page.locator(selector).first().click({ timeout: Number(args.timeout ?? 10000) }))
        sendResponse(ws, id, true, { clicked: selector })
        return
      }
      case 'type': {
        const selector = String(args.selector ?? '')
        const text = String(args.text ?? '')
        if (!selector) { sendResponse(ws, id, false, undefined, 'missing args.selector'); return }
        await runOnPage(page, () => page.locator(selector).first().fill(text, { timeout: Number(args.timeout ?? 10000) }))
        sendResponse(ws, id, true, { typed: text.length })
        return
      }
      case 'console_log': {
        sendResponse(ws, id, true, { entries: consoleBufferOf(page) })
        return
      }
      case 'url': {
        sendResponse(ws, id, true, { url: page.url(), title: await page.title() })
        return
      }
      case 'back':
      case 'forward':
      case 'reload': {
        await runOnPage(page, async () => {
          if (cmd === 'back') await page.goBack({ timeout: 10000 }).catch(() => {})
          if (cmd === 'forward') await page.goForward({ timeout: 10000 }).catch(() => {})
          if (cmd === 'reload') await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
        })
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

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------

export function startLiveBridge(): boolean {
  if (wss) {
    log('already started')
    return true
  }
  wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws, req) => {
    if (sessions.size >= MAX_SESSIONS) {
      send(ws, { type: 'event', event: 'rejected', data: { reason: `max ${MAX_SESSIONS} sessions` } })
      try { ws.close(1013, 'too many sessions') } catch {}
      return
    }
    const session: Session = {
      id: randomUUID(),
      ws,
      debugPort: 0,
      activeCode: '',
      page: null,
      queue: Promise.resolve(),
      snapshotId: 0,
    }
    // 先注册 message listener 再发 hello，避免 client 抢发命令丢消息
    ws.on('message', (raw) => {
      let msg: any
      try { msg = JSON.parse(String(raw)) } catch { return }
      // Session 内串行：避免 ensureProfile 未完成时短命令读到半初始化状态
      session.queue = session.queue
        .then(() => handleCommand(session, msg))
        .catch((e) => {
          log(`handleCommand uncaught: ${e instanceof Error ? e.message : String(e)}`)
        })
    })
    ws.on('close', () => {
      sessions.delete(session.id)
      log(`session ${session.id.slice(0, 8)} closed (${sessions.size} left)`)
    })
    ws.on('error', (e) => log(`ws error: ${e.message}`))
    sessions.set(session.id, session)
    log(`session ${session.id.slice(0, 8)} connected from ${req.socket.remoteAddress ?? '?'} (${sessions.size} total)`)
    send(ws, { type: 'event', event: 'hello', data: { ts: Date.now(), session: sessionSnapshot(session) } })
  })
  log(`WS endpoint ready (will serve ${WS_PATH} on launch HTTP server)`)
  return true
}

/**
 * 由 launch-http-server 的 attachLaunchUpgradeHandler 在匹配 /api/live-bridge 路径时调用。
 */
export function handleLiveBridgeUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
  if (!wss) {
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
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss!.emit('connection', ws, req)
  })
}

export async function stopLiveBridge(): Promise<void> {
  for (const session of sessions.values()) {
    try { session.ws.close(1000, 'server stopped') } catch {}
  }
  sessions.clear()
  if (wss) {
    await new Promise<void>((resolve) => wss!.close(() => resolve()))
    wss = null
  }
  for (const entry of browserPool.values()) {
    try { await entry.browser.close() } catch { /* ignore */ }
  }
  browserPool.clear()
  log('stopped')
}

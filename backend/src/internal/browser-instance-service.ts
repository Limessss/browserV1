/**
 * 浏览器实例：启动 / 停止 / CDP（对齐 Ant-Browser app_instance.go + app_cookie.go）。
 * 代理：非 Chrome 原生代理串不再前置阻断；无法直接映射时降级为直连并通过 runtimeWarning 提示。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { Database } from 'sql.js'

import { getProfileRow, getProfileFrontendById, parseJsonArray, listProxies } from './browser-data'
import { resolveChromeExecutableForProfile } from './browser-core-resolve'
import {
  clearBrowserRuntime,
  consumeGracefulBrowserStop,
  getBrowserRuntime,
  listRunningProfileIds,
  markGracefulBrowserStop,
  mergeRuntimeIntoProfileRecord,
  registerBrowserRuntime,
} from './browser-runtime-store'
import { getSqlite } from './database/sqlite-store'
import { emitWailsEvent } from '../ipc/wails-emit'
import { allocateLocalPort } from './net-utils'
import { listBookmarksResolved } from './bookmark-list-resolve'
import { ensureDefaultBookmarks } from './ensure-default-bookmarks'
import { resolveProfileUserDataDir } from './profile-paths'
import { loadBrowserSettingsMerged, loadProxyBridgeBinaryPaths } from './app-config-store'
import { normalizeProxyForChrome } from './proxy'
import {
  acquireProxyBridgeForProfile,
  formatBridgeErrorForWarning,
  proxyNeedsBridge,
  releaseProxyBridgeForProfile,
} from './proxy-bridge-service'
import {
  cdpBrowserCall,
  cdpBrowserCommandWithResult,
  cdpCall,
} from './cdp-client'
import { findProfileIdByCode } from './launch-code-service'
import type { LaunchRequestParams } from './launch-selector-types'
import {
  clearLaunchServerActiveProfile,
  setLaunchServerActiveProfile,
} from './launch-server-state'

function resolveEffectiveProxyBinding(db: Database, profileId: string): { proxyConfig: string; dnsServers: string } {
  const row = getProfileRow(db, profileId)
  if (!row) return { proxyConfig: '', dnsServers: '' }
  let src = String(row.proxy_config ?? '').trim()
  let dns = ''
  const pid = String(row.proxy_id ?? '').trim()
  if (!pid) return { proxyConfig: src, dnsServers: dns }
  const proxies = listProxies(db)
  for (const p of proxies) {
    const pr = p as Record<string, unknown>
    if (String(pr.proxyId ?? '').toLowerCase() === pid.toLowerCase()) {
      src = String(pr.proxyConfig ?? '').trim()
      dns = String(pr.dnsServers ?? '').trim()
      break
    }
  }
  return { proxyConfig: src, dnsServers: dns }
}

function fingerprintSeedFromProfileId(profileId: string): number {
  let seed = 0
  for (let i = 0; i < profileId.length; i++) {
    seed = (seed << 5) - seed + profileId.charCodeAt(i)
    seed |= 0
  }
  if (seed < 0) seed = -seed
  return seed
}

function hasFingerprintFlag(args: string[]): boolean {
  return args.some((a) => a.startsWith('--fingerprint='))
}

function buildChromeProxyArgs(effectiveProxy: string): string[] {
  const p = effectiveProxy.trim()
  if (!p) return []
  if (p.toLowerCase() === 'direct://') {
    return ['--proxy-server=direct://']
  }
  return [`--proxy-server=${p}`]
}

function enrichProxyWarning(rawWarning: string): string {
  const warning = rawWarning.trim()
  if (!warning) {
    return ''
  }
  const bridgeBins = loadProxyBridgeBinaryPaths()
  const hints: string[] = []
  if (bridgeBins.xrayBinaryPath) {
    hints.push(`xray=${bridgeBins.xrayBinaryPath}`)
  }
  if (bridgeBins.singboxBinaryPath) {
    hints.push(`sing-box=${bridgeBins.singboxBinaryPath}`)
  }
  if (hints.length === 0) {
    return `${warning}；未检测到 browser.xray_binary_path / browser.singbox_binary_path，暂无法启用真桥接`
  }
  return `${warning}；已检测桥接二进制路径(${hints.join(', ')})，可继续接入真桥接`
}

async function waitDevToolsReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(1000, timeoutMs)
  let lastErr: Error | null = null
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) return
      lastErr = new Error(`HTTP ${r.status}`)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
    await new Promise((res) => setTimeout(res, 150))
  }
  throw new Error(
    lastErr ? `浏览器调试端口未就绪: ${lastErr.message}` : '浏览器调试端口未就绪',
  )
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise((res) => setTimeout(res, ms))
}

async function waitDevToolsStableReady(port: number, readyMs: number, stableMs: number): Promise<void> {
  await waitDevToolsReady(port, readyMs)
  const windowMs = Math.max(0, stableMs)
  if (windowMs <= 0) return
  await sleepMs(windowMs)
  await waitDevToolsReady(port, Math.min(1500, Math.max(400, windowMs)))
}

function browserDebugPendingWarning(timeoutMs: number): string {
  return `浏览器窗口已启动，但调试接口在 ${Math.max(1, Math.floor(timeoutMs / 1000))}s 内未就绪，已转入后台附着`
}

function browserDebugPendingStartNotice(timeoutMs: number): string {
  return `实例已启动（调试接口尚未就绪，后台附着中，等待约 ${Math.max(1, Math.floor(timeoutMs / 1000))}s）`
}

function shouldKeepBrowserRunningPendingDebugReady(debugPort: number, child: ChildProcess): boolean {
  return debugPort > 0 && childStillRunning(child)
}

function waitBrowserDebugReadyAsync(profileId: string, debugPort: number, timeoutMs: number): void {
  const id = profileId.trim()
  const timeout = Math.max(3000, timeoutMs)
  void (async () => {
    try {
      await waitDevToolsReady(debugPort, timeout)
      const runtime = getBrowserRuntime(id)
      if (!runtime) return
      runtime.debugReady = true
      runtime.runtimeWarning = ''
      registerBrowserRuntime(id, runtime)
      const db = getSqlite()
      if (!db) return
      const p = getProfileFrontendById(db, id)
      if (!p) return
      mergeRuntimeIntoProfileRecord(p)
      emitWailsEvent('browser:instance:updated', browserInstanceEventPayload(p, false))
    } catch {
      /* keep pending state */
    }
  })()
}

function childStillRunning(child: ChildProcess | null): boolean {
  if (!child) return false
  return child.exitCode === null && child.signalCode === null
}

/** 对齐 Go browserInstanceEventPayload */
function browserInstanceEventPayload(
  p: Record<string, unknown>,
  reused: boolean,
): Record<string, unknown> {
  return {
    profileId: p.profileId,
    profileName: p.profileName ?? '',
    debugPort: Number(p.debugPort ?? 0),
    debugReady: Boolean(p.debugReady ?? false),
    pid: Number(p.pid ?? 0),
    reused,
    running: Boolean(p.running ?? false),
    runtimeWarning: String(p.runtimeWarning ?? ''),
  }
}

function normalizeNonEmptyStrings(items: string[] | undefined): string[] {
  if (!items?.length) {
    return []
  }
  const out: string[] = []
  for (const item of items) {
    const v = String(item).trim()
    if (v) {
      out.push(v)
    }
  }
  return out
}

/** 显式 startUrls 优先；否则在未 skip 时使用实例默认启动页（对齐 Go resolveInstanceStartURLs）。 */
function resolveInstanceStartURLs(
  explicit: string[],
  rowDefaults: string[],
  skipDefault: boolean,
): string[] {
  if (explicit.length > 0) {
    return explicit
  }
  if (skipDefault) {
    return []
  }
  return rowDefaults
}

function ensureNewWindowLaunchArg(args: string[]): string[] {
  for (const arg of args) {
    if (String(arg).trim().toLowerCase() === '--new-window') {
      return args
    }
  }
  return [...args, '--new-window']
}

/**
 * 对齐 Go openBrowserWindowForRunningProfile：已存在用户数据时再起一个 Chromium 仅打开新窗口/URL（无 CDP 端口参数）。
 */
function openBrowserWindowForRunningProfile(
  db: Database,
  profileId: string,
  extraLaunchArgs: string[],
  startURLs: string[],
): void {
  const id = profileId.trim()
  const chromeExe = resolveChromeExecutableForProfile(db, id)
  const userDataDir = resolveProfileUserDataDir(db, id)
  mkdirSync(userDataDir, { recursive: true })
  const args: string[] = [`--user-data-dir=${userDataDir}`]
  args.push(...extraLaunchArgs)
  if (startURLs.length > 0) {
    args.push(...startURLs)
  } else {
    args.push('about:blank')
  }
  const child = spawn(chromeExe, args, {
    cwd: dirname(chromeExe),
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
}

/**
 * 对齐 Wails BrowserInstanceStartWithParams：额外启动参数 + 启动 URL 仅本次生效；已运行时尝试再起窗口。
 */
export async function browserInstanceStartWithParams(
  db: Database,
  profileId: string,
  extraLaunchArgs: unknown,
  startURLs: unknown,
  skipDefaultStartUrls: unknown,
): Promise<Record<string, unknown>> {
  const id = profileId.trim()
  const row = getProfileRow(db, id)
  if (!row) {
    throw new Error(`实例启动失败：未找到实例配置（ID=${id}）。请刷新列表后重试。`)
  }

  const normalizedExtra = ensureNewWindowLaunchArg(
    normalizeNonEmptyStrings(Array.isArray(extraLaunchArgs) ? (extraLaunchArgs as string[]) : []),
  )
  const normalizedStart = normalizeNonEmptyStrings(
    Array.isArray(startURLs) ? (startURLs as string[]) : [],
  )
  const skip = Boolean(skipDefaultStartUrls)
  const rowDefaultStartUrls = parseJsonArray(row.default_start_urls)
  const effectiveStartUrls = resolveInstanceStartURLs(normalizedStart, rowDefaultStartUrls, skip)

  const existing = getBrowserRuntime(id)
  if (existing && existing.debugPort > 0) {
    try {
      const r = await fetch(`http://127.0.0.1:${existing.debugPort}/json/version`)
      if (r.ok) {
        openBrowserWindowForRunningProfile(db, id, normalizedExtra, effectiveStartUrls)
        const p = getProfileFrontendById(db, id)
        if (p) {
          mergeRuntimeIntoProfileRecord(p)
          setLaunchServerActiveProfile(p)
          emitWailsEvent('browser:instance:started', browserInstanceEventPayload(p, true))
          return p
        }
      }
    } catch {
      clearBrowserRuntime(id)
    }
  }

  return browserInstanceStart(db, id, {
    launchArgs: normalizedExtra,
    startUrls: normalizedStart,
    skipDefaultStartUrls: skip,
  })
}

export async function browserInstanceStart(
  db: Database,
  profileId: string,
  params?: LaunchRequestParams | null,
): Promise<Record<string, unknown>> {
  const id = profileId.trim()
  const row = getProfileRow(db, id)
  if (!row) {
    throw new Error(`实例启动失败：未找到实例配置（ID=${id}）。请刷新列表后重试。`)
  }

  const existing = getBrowserRuntime(id)
  if (existing && existing.debugPort > 0) {
    try {
      const r = await fetch(`http://127.0.0.1:${existing.debugPort}/json/version`)
      if (r.ok) {
        const p = getProfileFrontendById(db, id)
        if (p) {
          mergeRuntimeIntoProfileRecord(p)
          setLaunchServerActiveProfile(p)
          emitWailsEvent('browser:instance:started', browserInstanceEventPayload(p, true))
          return p
        }
      }
    } catch {
      clearBrowserRuntime(id)
    }
  }

  const settings = loadBrowserSettingsMerged()
  const readyMs = Number(settings.startReadyTimeoutMs ?? 3000) || 3000
  const stableMs = Number(settings.startStableWindowMs ?? 1200) || 1200
  const maxStartAttempts = 3
  const totalReadyTimeout = maxStartAttempts * readyMs
  const asyncAttachTimeout = Math.max(8000, totalReadyTimeout * 2)

  const chromeExe = resolveChromeExecutableForProfile(db, id)
  const userDataDir = resolveProfileUserDataDir(db, id)
  mkdirSync(userDataDir, { recursive: true })

  try {
    ensureDefaultBookmarks(userDataDir, listBookmarksResolved(db))
  } catch (e) {
    console.error('[browser] EnsureDefaultBookmarks', id, e)
  }

  const proxyBinding = resolveEffectiveProxyBinding(db, id)
  const effectiveProxy = proxyBinding.proxyConfig
  let resolvedProxy = normalizeProxyForChrome(effectiveProxy)
  if (proxyNeedsBridge(effectiveProxy)) {
    try {
      const bridge = await acquireProxyBridgeForProfile(id, effectiveProxy, proxyBinding.dnsServers)
      if (bridge.proxyServer) {
        resolvedProxy = { proxyServer: bridge.proxyServer, warning: '' }
      }
    } catch (e) {
      const msg = formatBridgeErrorForWarning(e)
      resolvedProxy = {
        ...resolvedProxy,
        warning: `${resolvedProxy.warning}；${msg}`.trim(),
      }
    }
  }

  const debugPort = await allocateLocalPort()

  const fpArgs = parseJsonArray(row.fingerprint_args)
  const launchArgs = parseJsonArray(row.launch_args)
  const rowDefaultStartUrls = parseJsonArray(row.default_start_urls)
  const explicitStart = normalizeNonEmptyStrings(params?.startUrls)
  const skipDefault = Boolean(params?.skipDefaultStartUrls)
  const effectiveStartUrls = resolveInstanceStartURLs(
    explicitStart,
    rowDefaultStartUrls,
    skipDefault,
  )
  const extraLaunchArgs = normalizeNonEmptyStrings(params?.launchArgs)

  const args: string[] = [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    '--disable-session-crashed-bubble',
  ]

  if (!hasFingerprintFlag(fpArgs)) {
    args.push(`--fingerprint=${fingerprintSeedFromProfileId(id)}`)
  }

  if (resolvedProxy.proxyServer) {
    args.push(...buildChromeProxyArgs(resolvedProxy.proxyServer))
  }
  args.push(...fpArgs)
  args.push(...launchArgs)
  args.push(...extraLaunchArgs)

  if (effectiveStartUrls.length > 0) {
    args.push(...effectiveStartUrls)
  }

  const child = spawn(chromeExe, args, {
    cwd: dirname(chromeExe),
    detached: false,
    stdio: 'ignore',
    windowsHide: false,
  })

  const pid = child.pid ?? 0

  child.once('exit', (code, signal) => {
    const graceful = consumeGracefulBrowserStop(id)
    releaseProxyBridgeForProfile(id)
    clearBrowserRuntime(id)
    clearLaunchServerActiveProfile(id)
    if (graceful) {
      return
    }
    let profileName = id
    const dbConn = getSqlite()
    if (dbConn) {
      const row = getProfileRow(dbConn, id)
      if (row?.profile_name) {
        profileName = row.profile_name
      }
    }
    const benign =
      (code === 0 || code === null) && (!signal || signal === 'SIGTERM')
    if (benign) {
      emitWailsEvent('browser:instance:stopped', id)
      return
    }
    const detail = signal ? `signal ${signal}` : `exit code ${code ?? '?'}`
    emitWailsEvent('browser:instance:crashed', {
      profileId: id,
      profileName,
      error: `实例运行异常退出：${detail}`,
    })
  })

  child.once('error', (err) => {
    console.error('[browser]', id, err)
    releaseProxyBridgeForProfile(id)
    clearBrowserRuntime(id)
    clearLaunchServerActiveProfile(id)
    consumeGracefulBrowserStop(id)
    let profileName = id
    const dbConn = getSqlite()
    if (dbConn) {
      const row = getProfileRow(dbConn, id)
      if (row?.profile_name) {
        profileName = row.profile_name
      }
    }
    emitWailsEvent('browser:instance:crashed', {
      profileId: id,
      profileName,
      error: err instanceof Error ? err.message : String(err),
    })
  })

  registerBrowserRuntime(id, {
    pid,
    debugPort,
    debugReady: false,
    child,
    runtimeWarning: enrichProxyWarning(resolvedProxy.warning),
  })

  let startReady = false
  let lastReadyErr: Error | null = null
  for (let attempt = 1; attempt <= maxStartAttempts; attempt++) {
    try {
      await waitDevToolsStableReady(debugPort, readyMs, stableMs)
      startReady = true
      break
    } catch (e) {
      lastReadyErr = e instanceof Error ? e : new Error(String(e))
      if (!childStillRunning(child)) {
        break
      }
      if (attempt < maxStartAttempts) {
        await sleepMs(120)
      }
    }
  }

  if (startReady) {
    const cur = getBrowserRuntime(id)
    if (cur) {
      cur.debugReady = true
      cur.runtimeWarning = ''
      registerBrowserRuntime(id, cur)
    }
    const refreshed = getProfileFrontendById(db, id)
    if (refreshed) {
      mergeRuntimeIntoProfileRecord(refreshed)
      emitWailsEvent('browser:instance:updated', browserInstanceEventPayload(refreshed, false))
    }
  } else if (shouldKeepBrowserRunningPendingDebugReady(debugPort, child)) {
    const cur = getBrowserRuntime(id)
    if (cur) {
      cur.debugReady = false
      cur.runtimeWarning = browserDebugPendingWarning(totalReadyTimeout)
      registerBrowserRuntime(id, cur)
    }
    waitBrowserDebugReadyAsync(id, debugPort, asyncAttachTimeout)
  } else {
    releaseProxyBridgeForProfile(id)
    clearBrowserRuntime(id)
    throw lastReadyErr ?? new Error('浏览器调试端口未就绪')
  }

  const p = getProfileFrontendById(db, id)
  if (!p) {
    throw new Error('实例数据异常')
  }
  mergeRuntimeIntoProfileRecord(p)
  setLaunchServerActiveProfile(p)
  emitWailsEvent('browser:instance:started', browserInstanceEventPayload(p, false))
  if (!startReady) {
    p.lastError = browserDebugPendingStartNotice(totalReadyTimeout)
  }
  return p
}

export async function browserInstanceStop(db: Database, profileId: string): Promise<Record<string, unknown>> {
  const id = profileId.trim()
  const entry = getBrowserRuntime(id)
  const snapshot = getProfileFrontendById(db, id)
  if (!snapshot) {
    throw new Error('profile not found')
  }

  if (!entry) {
    return snapshot
  }

  markGracefulBrowserStop(id)

  if (entry.debugPort > 0) {
    try {
      await cdpBrowserCall(entry.debugPort, 'Browser.close', null)
    } catch {
      /* 继续尝试结束进程 */
    }
  }

  if (childStillRunning(entry.child)) {
    try {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          execFile(
            'taskkill',
            ['/PID', String(entry.pid), '/T', '/F'],
            { windowsHide: true },
            () => resolve(),
          )
        })
      } else {
        entry.child?.kill('SIGTERM')
      }
    } catch {
      /* ignore */
    }
  }

  releaseProxyBridgeForProfile(id)
  clearBrowserRuntime(id)
  clearLaunchServerActiveProfile(id)
  emitWailsEvent('browser:instance:stopped', id)
  const after = getProfileFrontendById(db, id)
  return after ?? snapshot
}

export async function browserInstanceRestart(
  db: Database,
  profileId: string,
): Promise<Record<string, unknown>> {
  await browserInstanceStop(db, profileId)
  return browserInstanceStart(db, profileId)
}

export async function browserInstanceStartByCode(
  db: Database,
  code: string,
  params?: LaunchRequestParams | null,
): Promise<Record<string, unknown>> {
  const profileId = findProfileIdByCode(db, code)
  return browserInstanceStart(db, profileId, params ?? null)
}

export async function browserInstanceOpenUrl(
  db: Database,
  profileId: string,
  targetUrl: string,
): Promise<boolean> {
  const entry = getBrowserRuntime(profileId.trim())
  if (!entry?.debugReady || entry.debugPort <= 0) {
    return false
  }
  try {
    await cdpBrowserCommandWithResult(entry.debugPort, 'Target.createTarget', {
      url: targetUrl.trim() || 'about:blank',
    })
    return true
  } catch {
    return false
  }
}

export async function browserInstanceGetTabs(
  db: Database,
  profileId: string,
): Promise<Record<string, unknown>[]> {
  const entry = getBrowserRuntime(profileId.trim())
  if (!entry?.debugReady || entry.debugPort <= 0) {
    return []
  }
  try {
    const list = (await fetch(`http://127.0.0.1:${entry.debugPort}/json/list`).then((r) =>
      r.json(),
    )) as Array<{
      id?: string
      title?: string
      url?: string
      type?: string
      webSocketDebuggerUrl?: string
    }>
    const tabs: Record<string, unknown>[] = []
    let activeSet = false
    for (const t of list) {
      if (t.type !== 'page') continue
      const active = !activeSet
      activeSet = true
      tabs.push({
        tabId: String(t.id ?? ''),
        title: String(t.title ?? ''),
        url: String(t.url ?? ''),
        active,
      })
    }
    return tabs
  } catch {
    return []
  }
}

export async function browserGetCookies(db: Database, profileId: string): Promise<Record<string, unknown>[]> {
  const entry = getBrowserRuntime(profileId.trim())
  if (!entry?.debugReady || entry.debugPort <= 0) {
    throw new Error('实例未运行或调试接口未就绪')
  }
  try {
    await cdpCall(entry.debugPort, 'Network.enable', {})
  } catch {
    /* 部分版本已默认启用 */
  }
  const result = await cdpCall(entry.debugPort, 'Network.getAllCookies', null)
  const cookiesRaw = result.cookies
  if (!Array.isArray(cookiesRaw)) {
    return []
  }
  return cookiesRaw.map((c) => {
    const o = c as Record<string, unknown>
    return {
      name: String(o.name ?? ''),
      value: String(o.value ?? ''),
      domain: String(o.domain ?? ''),
      path: String(o.path ?? '/'),
      expires: Number(o.expires ?? 0),
      httpOnly: Boolean(o.httpOnly),
      secure: Boolean(o.secure),
      sameSite: String(o.sameSite ?? ''),
    }
  })
}

export async function browserClearCookies(db: Database, profileId: string): Promise<void> {
  const entry = getBrowserRuntime(profileId.trim())
  if (!entry?.debugReady || entry.debugPort <= 0) {
    throw new Error('实例未运行或调试接口未就绪')
  }
  await cdpCall(entry.debugPort, 'Network.clearBrowserCookies', null)
}

export async function browserExportCookies(db: Database, profileId: string): Promise<string> {
  const cookies = await browserGetCookies(db, profileId)
  const lines: string[] = ['# Netscape HTTP Cookie File', '# Generated by Ant Browser Desktop', '']
  for (const c of cookies) {
    const domain = String(c.domain ?? '')
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE'
    const path = String(c.path ?? '/')
    const secure = c.secure ? 'TRUE' : 'FALSE'
    let exp = Math.floor(Number(c.expires ?? 0))
    if (exp < 0) exp = 0
    lines.push(
      `${domain}\t${includeSubdomains}\t${path}\t${secure}\t${exp}\t${String(c.name ?? '')}\t${String(c.value ?? '')}`,
    )
  }
  return lines.join('\n')
}

export function getRunningInstancesList(db: Database): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const profileId of listRunningProfileIds()) {
    const p = getProfileFrontendById(db, profileId)
    if (!p) continue
    mergeRuntimeIntoProfileRecord(p)
    out.push(p)
  }
  return out
}

/**
 * Launch HTTP 本地服务（对齐 Ant-Browser internal/launchcode/server.go + profile_api.go）。
 */
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import http from 'node:http'
import type { Socket } from 'node:net'

import httpProxy from 'http-proxy'
import type { Database } from 'sql.js'

import {
  browserProfileCreate,
  browserProfileDelete,
  browserProfileUpdate,
} from './browser-writes'
import {
  DEFAULT_LAUNCH_API_HEADER,
  loadLaunchServerConfig,
  loadLinkeooErpConfig,
} from './app-config-store'
import {
  browserInstanceStart,
  browserInstanceStartByCode as startByCodeWithParams,
} from './browser-instance-service'
import { ensureLaunchCode, setLaunchCode } from './launch-code-service'
import { findProfileBySelector, findProfilesBySelector, withCodeKeywordFallback } from './launch-selector-service'
import type { LaunchPostBody } from './launch-selector-types'
import {
  MATCH_ALL,
  mergeLaunchSelector,
  type LaunchRequestParams,
  type LaunchSelector,
  type LaunchRequestParams as SelectorLaunchParams,
} from './launch-selector-types'
import { getLaunchServerActiveTarget } from './launch-server-state'

import { parseJsonArray, type ProfileRow } from './browser-data'
import { getSqlite } from './database/sqlite-store'
import {
  getEffectiveDefaultArgs,
  killPlaywrightScriptRun,
  listPlaywrightScripts,
  loadUserDefaultArgsForScript,
  loadUserDefaultsFileForScript,
  runPlaywrightScript,
  saveUserDefaultArgsForFolder,
  type PlaywrightScriptItem,
} from './playwright-scripts-service'

function profileRowToUpdatePayload(row: ProfileRow): Record<string, unknown> {
  return {
    profileName: row.profile_name,
    userDataDir: row.user_data_dir,
    coreId: row.core_id,
    fingerprintArgs: parseJsonArray(row.fingerprint_args),
    proxyId: row.proxy_id,
    proxyConfig: row.proxy_config,
    launchArgs: parseJsonArray(row.launch_args),
    tags: parseJsonArray(row.tags),
    keywords: parseJsonArray(row.keywords),
    groupId: row.group_id || '',
    defaultStartUrls: parseJsonArray(row.default_start_urls),
  }
}

/** 由 profile_api / Go mapProfileWriteErrorStatus 对齐 */
export function mapProfileHttpError(err: unknown): number {
  if (!(err instanceof Error)) {
    return 500
  }
  const msg = err.message.toLowerCase()
  if (msg.includes('profile not found')) {
    return 404
  }
  if (msg.includes('running profile cannot')) {
    return 409
  }
  if (msg.includes('launch code already exists')) {
    return 409
  }
  if (msg.includes('launch code format') || msg.includes('launch code must be')) {
    return 400
  }
  if (msg.includes('实例数量已达上限')) {
    return 409
  }
  return 500
}

type LaunchCallRecord = {
  timestamp: string
  method: string
  path: string
  clientIp: string
  code: string
  selector?: LaunchSelector
  params: SelectorLaunchParams
  ok: boolean
  status: number
  error: string
  durationMs: number
  profileId?: string
  profileName?: string
}

let httpListenPort = 0
let httpServer: http.Server | null = null
let launchLogs: LaunchCallRecord[] = []

let liveBridgeHandler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null = null

/**
 * 实时桥 (Live Bridge) 通过本函数挂一个 WS upgrade handler。
 * 路径 /api/live-bridge -> liveBridgeHandler；非 /api/ 路径 (CDP 流量) -> 原有 cdpProxy.ws
 */
export function setLiveBridgeUpgradeHandler(
  handler: ((req: IncomingMessage, socket: Socket, head: Buffer) => void) | null,
): void {
  liveBridgeHandler = handler
}

export function getLaunchHttpServer(): http.Server | null {
  return httpServer
}

const cdpProxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: false,
})

cdpProxy.on('error', (err, _req, res) => {
  const r = res as ServerResponse | undefined
  if (r && !r.headersSent) {
    r.writeHead(502, { 'Content-Type': 'application/json' })
    r.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }))
  }
})

export function getLaunchHttpListenPort(): number {
  return httpListenPort
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function remoteIp(remoteAddr: string | undefined): string {
  if (!remoteAddr) {
    return ''
  }
  const idx = remoteAddr.lastIndexOf(':')
  if (idx === -1) {
    return remoteAddr
  }
  if (remoteAddr.startsWith('[')) {
    const end = remoteAddr.indexOf(']')
    if (end > 0) {
      return remoteAddr.slice(1, end)
    }
  }
  return remoteAddr.slice(0, idx)
}

function localhostOnly(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const host = remoteIp(req.socket.remoteAddress ?? '')
  if (host !== '127.0.0.1' && host !== '::1') {
    writeJson(res, 403, { ok: false, error: 'forbidden: only localhost is allowed' })
    return
  }
  next()
}

function timingSafeEq(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) {
    return false
  }
  return timingSafeEqual(ba, bb)
}

function apiAuthWrap(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const url = req.url ?? '/'
  if (!url.startsWith('/api/')) {
    next()
    return
  }
  const cfg = loadLaunchServerConfig().auth
  const active = cfg.enabled && cfg.apiKey.length > 0
  if (!active) {
    next()
    return
  }
  const hdr = cfg.header.trim() || 'X-Ant-Api-Key'
  const provided = String(req.headers[hdr.toLowerCase()] ?? '').trim()
  if (!timingSafeEq(provided, cfg.apiKey)) {
    writeJson(res, 401, {
      ok: false,
      error: 'unauthorized: invalid api key',
      authHeader: hdr,
    })
    return
  }
  next()
}

function appendLaunchLog(rec: Omit<LaunchCallRecord, 'timestamp' | 'durationMs'> & { startAt: number }): void {
  const durationMs = Date.now() - rec.startAt
  const entry: LaunchCallRecord = {
    timestamp: new Date().toISOString(),
    method: rec.method,
    path: rec.path,
    clientIp: rec.clientIp,
    code: rec.code,
    selector: rec.selector,
    params: rec.params,
    ok: rec.ok,
    status: rec.status,
    error: rec.error,
    durationMs,
    profileId: rec.profileId,
    profileName: rec.profileName,
  }
  launchLogs.push(entry)
  if (launchLogs.length > 500) {
    launchLogs = launchLogs.slice(-500)
  }
}

function launchSuccessPayload(
  profile: Record<string, unknown>,
  launchCode: string,
  launchListenPort: number,
): Record<string, unknown> {
  let cdpPort = launchListenPort
  let cdpUrl =
    launchListenPort > 0 ? `http://127.0.0.1:${launchListenPort}` : ''
  if (!cdpUrl && profile.debugReady && Number(profile.debugPort) > 0) {
    cdpPort = Number(profile.debugPort)
    cdpUrl = `http://127.0.0.1:${cdpPort}`
  }
  return {
    ok: true,
    profileId: profile.profileId,
    profileName: profile.profileName,
    launchCode,
    pid: profile.pid ?? 0,
    debugPort: profile.debugPort ?? 0,
    debugReady: profile.debugReady ?? false,
    runtimeWarning: profile.runtimeWarning ?? '',
    cdpPort,
    cdpUrl,
  }
}

function launchBatchSuccessPayload(
  profiles: Record<string, unknown>[],
  launchListenPort: number,
): Record<string, unknown> {
  const items = profiles.map((profile, i) => ({
    profileId: profile.profileId,
    profileName: profile.profileName,
    launchCode: profile.launchCode ?? '',
    pid: profile.pid ?? 0,
    debugPort: profile.debugPort ?? 0,
    debugReady: profile.debugReady ?? false,
    runtimeWarning: profile.runtimeWarning ?? '',
    isActive: i === profiles.length - 1,
  }))
  const activeProfile = profiles.length > 0 ? profiles[profiles.length - 1]! : null
  let cdpPort = launchListenPort
  let cdpUrl = launchListenPort > 0 ? `http://127.0.0.1:${launchListenPort}` : ''
  if (
    !cdpUrl &&
    activeProfile &&
    activeProfile.debugReady &&
    Number(activeProfile.debugPort) > 0
  ) {
    cdpPort = Number(activeProfile.debugPort)
    cdpUrl = `http://127.0.0.1:${cdpPort}`
  }
  const payload: Record<string, unknown> = {
    ok: true,
    matchMode: MATCH_ALL,
    count: items.length,
    items,
    cdpPort,
    cdpUrl,
  }
  if (activeProfile) {
    payload.activeProfileId = activeProfile.profileId
    payload.activeProfileName = activeProfile.profileName
  }
  return payload
}

function parseProfilePathId(pathname: string): string | null {
  const p = pathname.replace(/^\/api\/profiles\//, '').trim()
  if (!p || p.includes('/')) {
    return null
  }
  return p
}

function readBodyJson(req: IncomingMessage, limit = 1 << 20): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let len = 0
    req.on('data', (c: Buffer) => {
      len += c.length
      if (len > limit) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        if (!raw.trim()) {
          resolve({})
          return
        }
        resolve(JSON.parse(raw) as unknown)
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
    req.on('error', reject)
  })
}

function toLaunchParams(body: LaunchPostBody): LaunchRequestParams {
  return {
    launchArgs: Array.isArray(body.launchArgs) ? body.launchArgs.map(String) : undefined,
    startUrls: Array.isArray(body.startUrls) ? body.startUrls.map(String) : undefined,
    skipDefaultStartUrls: Boolean(body.skipDefaultStartUrls),
  }
}

function mergeStartParams(start: unknown): LaunchRequestParams | null {
  if (!start || typeof start !== 'object') {
    return null
  }
  const s = start as Record<string, unknown>
  return {
    launchArgs: Array.isArray(s.launchArgs) ? s.launchArgs.map(String) : undefined,
    startUrls: Array.isArray(s.startUrls) ? s.startUrls.map(String) : undefined,
    skipDefaultStartUrls: Boolean(s.skipDefaultStartUrls),
  }
}

function playwrightScriptToPublic(item: PlaywrightScriptItem): Record<string, unknown> {
  return {
    folderId: item.folderId,
    id: item.id ?? item.folderId,
    name: item.name,
    description: item.description,
    version: item.version,
    tags: item.tags,
    defaultArgs: item.defaultArgs,
    argsHint: item.argsHint,
    requiresLaunchServer: item.requiresLaunchServer === true,
    mcpDoc: item.mcpDoc,
  }
}

async function enrichPlaywrightScriptPublic(
  item: PlaywrightScriptItem,
): Promise<Record<string, unknown>> {
  const userFile = await loadUserDefaultsFileForScript(item)
  const userDefaultArgs = userFile?.defaultArgs
  const effectiveDefaultArgs = getEffectiveDefaultArgs(item, userDefaultArgs ?? null)
  return {
    ...playwrightScriptToPublic(item),
    userDefaultArgs: userDefaultArgs?.length ? userDefaultArgs : undefined,
    userDefaultArgsUpdatedAt: userFile?.updatedAt || undefined,
    effectiveDefaultArgs,
    hasUserDefaultOverrides: Boolean(userDefaultArgs && userDefaultArgs.length > 0),
  }
}

async function handlePlaywrightScriptsList(res: ServerResponse): Promise<void> {
  try {
    const result = await listPlaywrightScripts()
    const scripts = await Promise.all(result.scripts.map((item) => enrichPlaywrightScriptPublic(item)))
    writeJson(res, 200, {
      ok: true,
      rootDir: result.rootDir,
      bundledRootDir: result.bundledRootDir,
      warnings: result.warnings,
      scripts,
    })
  } catch (e) {
    writeJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
  }
}

async function handlePlaywrightScriptUserDefaultsGet(
  res: ServerResponse,
  folderId: string,
): Promise<void> {
  const fid = String(folderId ?? '').trim()
  try {
    const result = await listPlaywrightScripts()
    const script = result.scripts.find((s) => s.folderId === fid)
    if (!script) {
      writeJson(res, 404, { ok: false, error: `未找到脚本: ${fid}` })
      return
    }
    const userFile = await loadUserDefaultsFileForScript(script)
    writeJson(res, 200, {
      ok: true,
      folderId: fid,
      scriptId: script.id ?? fid,
      manifestDefaultArgs: script.defaultArgs ?? [],
      userDefaultArgs: userFile?.defaultArgs ?? null,
      updatedAt: userFile?.updatedAt ?? null,
      effectiveDefaultArgs: getEffectiveDefaultArgs(script, userFile?.defaultArgs ?? null),
    })
  } catch (e) {
    writeJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
  }
}

async function handlePlaywrightScriptUserDefaultsPut(
  req: IncomingMessage,
  res: ServerResponse,
  folderId: string,
): Promise<void> {
  let raw: unknown
  try {
    raw = await readBodyJson(req)
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid request body' })
    return
  }
  const body = raw as Record<string, unknown>
  if (!Array.isArray(body.defaultArgs) || !body.defaultArgs.every((a) => typeof a === 'string')) {
    writeJson(res, 400, { ok: false, error: 'defaultArgs must be a string array' })
    return
  }
  try {
    const saved = await saveUserDefaultArgsForFolder(folderId, body.defaultArgs)
    writeJson(res, 200, { ok: true, folderId, ...saved })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('未找到脚本')) {
      writeJson(res, 404, { ok: false, error: msg })
      return
    }
    writeJson(res, 500, { ok: false, error: msg })
  }
}

async function handlePlaywrightScriptRunPost(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let raw: unknown
  try {
    raw = await readBodyJson(req)
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid request body' })
    return
  }

  const body = raw as Record<string, unknown>
  const folderIdRaw =
    typeof body.folderId === 'string'
      ? body.folderId.trim()
      : typeof body.id === 'string'
        ? body.id.trim()
        : ''

  let extraArgs: string[] = []
  if (Array.isArray(body.extraArgs)) {
    extraArgs = body.extraArgs.filter((a): a is string => typeof a === 'string')
  }

  if (!folderIdRaw) {
    writeJson(res, 400, { ok: false, error: 'folderId is required' })
    return
  }

  try {
    const { runId } = await runPlaywrightScript(folderIdRaw, extraArgs)
    writeJson(res, 200, { ok: true, runId, folderId: folderIdRaw })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('无效的脚本目录')) {
      writeJson(res, 400, { ok: false, error: msg })
      return
    }
    if (msg.includes('未找到脚本')) {
      writeJson(res, 404, { ok: false, error: msg })
      return
    }
    writeJson(res, 500, { ok: false, error: msg })
  }
}

function handlePlaywrightScriptKill(res: ServerResponse, runId: string): void {
  const id = String(runId ?? '').trim()
  if (!id) {
    writeJson(res, 400, { ok: false, error: 'runId is required' })
    return
  }
  const killed = killPlaywrightScriptRun(id)
  if (!killed) {
    writeJson(res, 404, { ok: false, error: 'run not found or already finished' })
    return
  }
  writeJson(res, 200, { ok: true, runId: id })
}

function attachLaunchUpgradeHandler(server: http.Server): void {
 server.on('upgrade', (req, socket: Socket, head) => {
 const host = remoteIp(socket.remoteAddress ?? '')
 if (host !== '127.0.0.1' && host !== '::1') {
 socket.destroy()
 return
 }
 const url = req.url ?? '/'
 if (url.startsWith('/api/live-bridge')) {
 if (!liveBridgeHandler) {
 socket.destroy()
 return
 }
 try {
 liveBridgeHandler(req, socket, head as Buffer)
 } catch {
 socket.destroy()
 }
 return
 }
 if (url.startsWith('/api/')) {
 socket.destroy()
 return
 }
 const target = getLaunchServerActiveTarget()
 if (target.debugPort <=0) {
 socket.destroy()
 return
 }
 const dst = `http://127.0.0.1:${target.debugPort}`
 try {
 cdpProxy.ws(req, socket, head, { target: dst })
 } catch {
 socket.destroy()
 }
 })
}

async function tryListenOnServer(server: http.Server, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const onError = (err: unknown) => {
      cleanup()
      const e = err as NodeJS.ErrnoException
      if (e?.code !== 'EADDRINUSE') {
        console.error('[LaunchServer] 启动失败:', err)
      }
      resolve(false)
    }
    const onListening = () => {
      cleanup()
      resolve(true)
    }
    const cleanup = () => {
      server.off('error', onError)
      server.off('listening', onListening)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    try {
      server.listen(port > 0 ? port : 0, '127.0.0.1')
    } catch (err) {
      cleanup()
      console.error('[LaunchServer] listen() 异常:', err)
      resolve(false)
    }
  })
}

async function disposeUnusedServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  }).catch(() => undefined)
}

export async function startLaunchHttpServer(): Promise<number | null> {
  if (httpServer) {
    return httpListenPort
  }

  const preferred = loadLaunchServerConfig().preferredPort

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const run = (): void => {
      void handleLaunchHttpRequest(req, res)
    }
    localhostOnly(req, res, () => {
      apiAuthWrap(req, res, run)
    })
  }

  const createServerWithHandlers = (): http.Server => {
    const s = http.createServer(handler)
    attachLaunchUpgradeHandler(s)
    return s
  }

  let server = createServerWithHandlers()
  const firstPort = preferred > 0 ? preferred : 0
  let ok = await tryListenOnServer(server, firstPort)

  if (!ok && preferred > 0) {
    console.warn(
      `[LaunchServer] 首选端口 ${preferred} 不可用（常被其它 NexBrowser/进程占用），已改用系统分配端口`,
    )
    await disposeUnusedServer(server)
    server = createServerWithHandlers()
    ok = await tryListenOnServer(server, 0)
  }

  if (!ok) {
    await disposeUnusedServer(server)
    return null
  }

  const addr = server.address()
  const port =
    typeof addr === 'object' && addr && 'port' in addr ? Number(addr.port) : 0

  httpServer = server
  httpListenPort = port
  if (preferred > 0 && port !== preferred) {
    console.info('[LaunchServer] 监听', `http://127.0.0.1:${port}`, `（配置首选 ${preferred}）`)
  } else {
    console.info('[LaunchServer] 监听', `http://127.0.0.1:${port}`)
  }

  return port
}

export async function stopLaunchHttpServer(): Promise<void> {
  const s = httpServer
  httpServer = null
  httpListenPort = 0
  if (!s) {
    return
  }
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
  })
}

/** Wails GetLaunchServerInfo 对齐 app_launchcode.go */
export function buildGetLaunchServerInfo(): Record<string, unknown> {
  const cfg = loadLaunchServerConfig()
  const preferredPort = cfg.preferredPort
  const actualPort = getLaunchHttpListenPort()
  const auth = cfg.auth
  const requested = auth.enabled
  const configured = auth.apiKey.length > 0
  const enabled = requested && configured
  const header = auth.header.trim() || DEFAULT_LAUNCH_API_HEADER

  const active = getLaunchServerActiveTarget()
  const info: Record<string, unknown> = {
    host: '127.0.0.1',
    preferredPort,
    port: actualPort,
    ready: actualPort > 0,
    apiAuth: {
      requested,
      configured,
      enabled,
      header,
    },
  }
  if (actualPort > 0) {
    info.baseUrl = `http://127.0.0.1:${actualPort}`
    info.cdpUrl = `http://127.0.0.1:${actualPort}`
    info.activeDebugPort = active.debugPort
  } else {
    info.baseUrl = ''
    info.cdpUrl = ''
    info.activeDebugPort = 0
  }
  return info
}

async function handleLaunchHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const pathname = url.pathname
  const method = req.method ?? 'GET'

  try {
    if (pathname === '/api/health' && method === 'GET') {
      writeJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/api/integrations/linkeoo-erp' && method === 'GET') {
      const c = loadLinkeooErpConfig()
      writeJson(res, 200, { baseUrl: c.baseUrl, apiKey: c.apiKey })
      return
    }

    if (pathname === '/api/profiles') {
      if (method === 'GET') {
        await handleListProfiles(res)
        return
      }
      if (method === 'POST') {
        await handleCreateProfile(req, res)
        return
      }
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (pathname.startsWith('/api/profiles/')) {
      const id = parseProfilePathId(pathname)
      if (!id) {
        writeJson(res, 404, { ok: false, error: 'profile not found' })
        return
      }
      if (method === 'GET') {
        await handleGetProfile(res, id)
        return
      }
      if (method === 'PUT') {
        await handleUpdateProfile(req, res, id)
        return
      }
      if (method === 'DELETE') {
        await handleDeleteProfile(res, id)
        return
      }
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (pathname === '/api/launch' && method === 'POST') {
      await handleLaunchPost(req, res)
      return
    }

    if (pathname === '/api/launch/logs') {
      if (method === 'GET') {
        handleLaunchLogs(url, res)
        return
      }
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (pathname.startsWith('/api/launch/')) {
      if (method === 'GET') {
        await handleLaunchGet(req, res, pathname)
        return
      }
      writeJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    if (pathname === '/api/playwright-scripts' && method === 'GET') {
      await handlePlaywrightScriptsList(res)
      return
    }

    if (pathname === '/api/playwright-scripts/run' && method === 'POST') {
      await handlePlaywrightScriptRunPost(req, res)
      return
    }

    {
      const userDefaultsMatch = /^\/api\/playwright-scripts\/([^/]+)\/user-default-args$/.exec(pathname)
      if (userDefaultsMatch) {
        if (method === 'GET') {
          await handlePlaywrightScriptUserDefaultsGet(res, userDefaultsMatch[1])
          return
        }
        if (method === 'PUT') {
          await handlePlaywrightScriptUserDefaultsPut(req, res, userDefaultsMatch[1])
          return
        }
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
    }

    {
      const m = /^\/api\/playwright-scripts\/run\/([^/]+)$/.exec(pathname)
      if (m && method === 'DELETE') {
        handlePlaywrightScriptKill(res, m[1])
        return
      }
    }

    await handleCdpProxy(req, res)
  } catch (e) {
    console.error('[LaunchServer]', e)
    if (!res.headersSent) {
      writeJson(res, 500, { ok: false, error: String(e instanceof Error ? e.message : e) })
    }
  }
}

async function handleListProfiles(res: ServerResponse): Promise<void> {
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }
  const { listProfiles } = await import('./browser-data')
  const rows = listProfiles(db)
  const items = rows.map((p) => ({
    profileId: p.profileId,
    profileName: p.profileName,
    launchCode: p.launchCode ?? '',
    proxyId: p.proxyId ?? '',
    tags: p.tags ?? [],
    proxyConfig: p.proxyConfig ?? '',
  }))
  writeJson(res, 200, { ok: true, count: items.length, items })
}

async function handleCreateProfile(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }
  let raw: unknown
  try {
    raw = await readBodyJson(req)
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid request body' })
    return
  }
  const body = raw as Record<string, unknown>
  const profileRaw = body.profile
  if (!profileRaw || typeof profileRaw !== 'object') {
    writeJson(res, 400, { ok: false, error: 'profile is required' })
    return
  }

  const requestedCode = String(body.launchCode ?? '').trim()
  const autoLaunch = Boolean(body.autoLaunch)
  const startParams = mergeStartParams(body.start)

  try {
    const created = browserProfileCreate(db, profileRaw)
    const pid = String(created.profileId ?? '')
    let launchCode = ensureLaunchCode(db, pid)

    if (requestedCode) {
      try {
        launchCode = setLaunchCode(db, pid, requestedCode)
      } catch (e) {
        browserProfileDelete(db, pid)
        writeJson(res, mapProfileHttpError(e), {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
        return
      }
    }

    created.launchCode = launchCode

    if (autoLaunch) {
      try {
        const launched = await browserInstanceStart(db, pid, startParams ?? undefined)
        Object.assign(created, launched)
        writeJson(res, 201, profileWritePayload(created, launchCode, true, false, true))
        return
      } catch (e) {
        writeJson(res, 500, {
          ok: false,
          created: true,
          updated: false,
          launched: false,
          profileId: pid,
          profileName: created.profileName,
          launchCode,
          profile: created,
          error: e instanceof Error ? e.message : String(e),
        })
        return
      }
    }

    writeJson(res, 201, profileWritePayload(created, launchCode, true, false, false))
  } catch (e) {
    writeJson(res, mapProfileHttpError(e), {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

function profileWritePayload(
  profile: Record<string, unknown>,
  launchCode: string,
  created: boolean,
  updated: boolean,
  launched: boolean,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    ok: true,
    created,
    updated,
    launched,
    profileId: profile.profileId,
    profileName: profile.profileName,
    launchCode,
    profile,
  }
  if (!launched) {
    return base
  }
  Object.assign(base, launchSuccessPayload(profile, launchCode, httpListenPort))
  base.created = created
  base.updated = updated
  base.launched = true
  base.profile = profile
  return base
}

async function handleGetProfile(res: ServerResponse, profileId: string): Promise<void> {
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }
  const { getProfileFrontendById } = await import('./browser-data')
  const { mergeRuntimeIntoProfileRecord } = await import('./browser-runtime-store')
  const p = getProfileFrontendById(db, profileId)
  if (!p) {
    writeJson(res, 404, { ok: false, error: 'profile not found' })
    return
  }
  mergeRuntimeIntoProfileRecord(p)
  writeJson(res, 200, {
    ok: true,
    profileId: p.profileId,
    profileName: p.profileName,
    launchCode: p.launchCode ?? '',
    profile: p,
  })
}

async function handleUpdateProfile(
  req: IncomingMessage,
  res: ServerResponse,
  profileId: string,
): Promise<void> {
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }
  const { getProfileRow } = await import('./browser-data')
  const previousRow = getProfileRow(db, profileId)
  if (!previousRow) {
    writeJson(res, 404, { ok: false, error: 'profile not found' })
    return
  }

  let raw: unknown
  try {
    raw = await readBodyJson(req)
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid request body' })
    return
  }
  const body = raw as Record<string, unknown>
  const profileRaw = body.profile
  if (!profileRaw || typeof profileRaw !== 'object') {
    writeJson(res, 400, { ok: false, error: 'profile is required' })
    return
  }

  const requestedCode = String(body.launchCode ?? '').trim()
  const autoLaunch = Boolean(body.autoLaunch)
  const startParams = mergeStartParams(body.start)

  try {
    const updated = browserProfileUpdate(db, profileId, profileRaw)
    let launchCode = String(updated.launchCode ?? ensureLaunchCode(db, profileId))

    if (requestedCode) {
      try {
        launchCode = setLaunchCode(db, profileId, requestedCode)
      } catch (e) {
        browserProfileUpdate(db, profileId, profileRowToUpdatePayload(previousRow))
        writeJson(res, mapProfileHttpError(e), {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
        return
      }
    }
    updated.launchCode = launchCode

    if (autoLaunch) {
      try {
        const launched = await browserInstanceStart(db, profileId, startParams ?? undefined)
        Object.assign(updated, launched)
        writeJson(res, 200, profileWritePayload(updated, launchCode, false, true, true))
        return
      } catch (e) {
        writeJson(res, 500, {
          ok: false,
          created: false,
          updated: true,
          launched: false,
          profileId,
          profileName: updated.profileName,
          launchCode,
          profile: updated,
          error: e instanceof Error ? e.message : String(e),
        })
        return
      }
    }

    writeJson(res, 200, profileWritePayload(updated, launchCode, false, true, false))
  } catch (e) {
    writeJson(res, mapProfileHttpError(e), {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

async function handleDeleteProfile(res: ServerResponse, profileId: string): Promise<void> {
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }
  const { getProfileFrontendById } = await import('./browser-data')
  const { mergeRuntimeIntoProfileRecord } = await import('./browser-runtime-store')

  const p = getProfileFrontendById(db, profileId)
  if (!p) {
    writeJson(res, 404, { ok: false, error: 'profile not found' })
    return
  }
  mergeRuntimeIntoProfileRecord(p)
  if (p.running) {
    writeJson(res, 409, { ok: false, error: 'running profile cannot be deleted' })
    return
  }

  try {
    const lc = String(p.launchCode ?? '')
    browserProfileDelete(db, profileId)
    writeJson(res, 200, {
      ok: true,
      deleted: true,
      profileId,
      profileName: p.profileName,
      launchCode: lc,
    })
  } catch (e) {
    writeJson(res, mapProfileHttpError(e), {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

function handleLaunchLogs(url: URL, res: ServerResponse): void {
  let limit = 50
  const raw = url.searchParams.get('limit')
  if (raw) {
    const n = Number(raw)
    if (!Number.isNaN(n)) {
      limit = Math.min(200, Math.max(1, n))
    }
  }
  const items = [...launchLogs].reverse().slice(0, limit)
  writeJson(res, 200, { ok: true, items })
}

async function handleLaunchGet(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const startAt = Date.now()
  const clientIp = remoteIp(req.socket.remoteAddress ?? '')
  const code = pathname.replace(/^\/api\/launch\//, '').trim()
  if (!code) {
    writeJson(res, 404, { ok: false, error: 'launch code not found' })
    appendLaunchLog({
      method: req.method ?? 'GET',
      path: pathname,
      clientIp,
      code: '',
      params: {},
      ok: false,
      status: 404,
      error: 'launch code not found',
      startAt,
    })
    return
  }

  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }

  try {
    const profile = await startByCodeWithParams(db, code, null)
    const launchCode = String(profile.launchCode ?? code).trim() || code
    writeJson(res, 200, launchSuccessPayload(profile, launchCode, httpListenPort))
    appendLaunchLog({
      method: 'GET',
      path: pathname,
      clientIp,
      code: launchCode,
      params: {},
      ok: true,
      status: 200,
      error: '',
      profileId: String(profile.profileId ?? ''),
      profileName: String(profile.profileName ?? ''),
      startAt,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.includes('not found') ? 404 : 500
    writeJson(res, status, { ok: false, error: msg })
    appendLaunchLog({
      method: 'GET',
      path: pathname,
      clientIp,
      code,
      params: {},
      ok: false,
      status,
      error: msg,
      startAt,
    })
  }
}

async function handleLaunchPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const startAt = Date.now()
  const clientIp = remoteIp(req.socket.remoteAddress ?? '')
  const db = getSqlite()
  if (!db) {
    writeJson(res, 503, { ok: false, error: 'database not ready' })
    return
  }

  let raw: unknown
  try {
    raw = await readBodyJson(req)
  } catch {
    writeJson(res, 400, { ok: false, error: 'invalid request body' })
    appendLaunchLog({
      method: 'POST',
      path: '/api/launch',
      clientIp,
      code: '',
      params: {},
      ok: false,
      status: 400,
      error: 'invalid request body',
      startAt,
    })
    return
  }

  const body = raw as LaunchPostBody
  let selector = mergeLaunchSelector(body)
  const params = toLaunchParams(body)

  if (selector.matchMode === MATCH_ALL) {
    selector = withCodeKeywordFallback(db, selector, true)
    const { snapshots, status, errMsg } = findProfilesBySelector(db, selector)
    if (errMsg) {
      writeJson(res, status, { ok: false, error: errMsg })
      appendLaunchLog({
        method: 'POST',
        path: '/api/launch',
        clientIp,
        code: selector.code,
        selector,
        params,
        ok: false,
        status,
        error: errMsg,
        startAt,
      })
      return
    }

    const profiles: Record<string, unknown>[] = []
    for (const snap of snapshots) {
      const pid = String(snap.profileId ?? '')
      try {
        const launched = await browserInstanceStart(db, pid, params)
        profiles.push(launched)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const label = String(snap.profileName ?? pid)
        writeJson(res, 500, {
          ok: false,
          error: `failed to start profile ${label} after launching ${profiles.length} profile(s): ${msg}`,
        })
        appendLaunchLog({
          method: 'POST',
          path: '/api/launch',
          clientIp,
          code: selector.code,
          selector,
          params,
          ok: false,
          status: 500,
          error: msg,
          startAt,
        })
        return
      }
    }

    writeJson(res, 200, launchBatchSuccessPayload(profiles, httpListenPort))
    appendLaunchLog({
      method: 'POST',
      path: '/api/launch',
      clientIp,
      code: selector.code,
      selector,
      params,
      ok: true,
      status: 200,
      error: '',
      profileId: profiles.map((p) => String(p.profileId ?? '')).join(','),
      profileName: profiles.map((p) => String(p.profileName ?? '')).join(','),
      startAt,
    })
    return
  }

  selector = withCodeKeywordFallback(db, selector, true)
  const onlyCode =
    Boolean(selector.code) &&
    !selector.key &&
    !selector.profileId &&
    !selector.profileName &&
    !selector.groupId &&
    selector.keywords.length === 0 &&
    selector.tags.length === 0

  let profile: Record<string, unknown>
  let launchCode: string

  if (onlyCode) {
    try {
      profile = await startByCodeWithParams(db, selector.code, params)
      launchCode = String(profile.launchCode ?? selector.code).trim() || selector.code
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const status = msg.includes('not found') ? 404 : 500
      writeJson(res, status, { ok: false, error: msg })
      appendLaunchLog({
        method: 'POST',
        path: '/api/launch',
        clientIp,
        code: selector.code,
        selector,
        params,
        ok: false,
        status,
        error: msg,
        startAt,
      })
      return
    }
  } else {
    const { snapshot, status, errMsg } = findProfileBySelector(db, selector)
    if (errMsg || !snapshot) {
      writeJson(res, status, { ok: false, error: errMsg || 'failed' })
      appendLaunchLog({
        method: 'POST',
        path: '/api/launch',
        clientIp,
        code: selector.code,
        selector,
        params,
        ok: false,
        status,
        error: errMsg,
        startAt,
      })
      return
    }
    launchCode = String(snapshot.launchCode ?? '').trim()
    const pid = String(snapshot.profileId ?? '')
    try {
      profile = await browserInstanceStart(db, pid, params)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      writeJson(res, 500, { ok: false, error: msg })
      appendLaunchLog({
        method: 'POST',
        path: '/api/launch',
        clientIp,
        code: launchCode,
        selector,
        params,
        ok: false,
        status: 500,
        error: msg,
        startAt,
      })
      return
    }
    if (!launchCode) {
      launchCode = ensureLaunchCode(db, pid)
    }
    profile.launchCode = launchCode
  }

  writeJson(res, 200, launchSuccessPayload(profile, launchCode, httpListenPort))
  appendLaunchLog({
    method: 'POST',
    path: '/api/launch',
    clientIp,
    code: launchCode,
    selector,
    params,
    ok: true,
    status: 200,
    error: '',
    profileId: String(profile.profileId ?? ''),
    profileName: String(profile.profileName ?? ''),
    startAt,
  })
}

async function handleCdpProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const target = getLaunchServerActiveTarget()
  if (target.debugPort <= 0) {
    writeJson(res, 503, {
      ok: false,
      error: 'no active browser debug target',
      profileId: target.profileId,
      profileName: target.profileName,
    })
    return
  }
  const dst = `http://127.0.0.1:${target.debugPort}`
  try {
    cdpProxy.web(req, res, { target: dst })
  } catch (e) {
    if (!res.headersSent) {
      writeJson(res, 502, { ok: false, error: String(e instanceof Error ? e.message : e) })
    }
  }
}

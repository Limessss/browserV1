/**
 * 对齐 Ant-Browser DownloadAndExtractCore：异步下载 ZIP → 解压并剥离顶层目录 → validateCorePath → browserCoreSave，
 * 期间 emit download:progress。
 */
import { execSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { URL } from 'node:url'
import type { Database } from 'sql.js'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'

import { listCores } from './browser-data'
import { coreExecutableCandidates } from './core-binary'
import { validateCorePath } from './core-validate'
import { browserCoreSave } from './core-writes'
import { resolveAppRelativePath } from './electron-paths'
import { normalizeProxyForChrome } from './proxy'
import { emitWailsEvent } from '../ipc/wails-emit'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip') as new (path?: string) => {
  getEntries(): Array<{
    entryName: string
    isDirectory: boolean
    getData(): Buffer
  }>
}

export type DownloadProgressPayload = {
  phase: string
  progress: number
  message: string
}

function emitProgress(payload: DownloadProgressPayload): void {
  emitWailsEvent('download:progress', payload)
}

/** 对齐 Go readSystemProxy（简化）：优先读 Win 注册表，否则退回环境变量 */
function resolveProxyUrl(proxyConfig: string): { url: string | undefined; hint: string } {
  const raw = proxyConfig.trim()
  if (!raw || raw === '__direct__' || raw === 'direct://') {
    return { url: undefined, hint: '直连' }
  }
  if (raw === '__system__') {
    const win = readWinInternetSettingsProxy()
    if (win) {
      return { url: win, hint: `已从系统读取代理: ${win}` }
    }
    const env =
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      process.env.https_proxy
    if (env?.trim()) {
      return { url: env.trim(), hint: `使用环境变量代理: ${env.trim()}` }
    }
    return { url: undefined, hint: '系统代理：注册表与环境变量均无配置，直连下载' }
  }
  const normalized = normalizeProxyForChrome(raw)
  const resolved = normalized.proxyServer.trim()
  if (!resolved || resolved.toLowerCase() === 'direct://') {
    return {
      url: undefined,
      hint: normalized.warning || '直连',
    }
  }
  try {
    const u = new URL(resolved.includes('://') ? resolved : `http://${resolved}`)
    return {
      url: u.href,
      hint: normalized.warning ? `${normalized.warning} 实际代理: ${u.href}` : `使用指定代理: ${u.href}`,
    }
  } catch {
    return { url: undefined, hint: '代理地址不可用，已改为直连下载' }
  }
}

function readWinInternetSettingsProxy(): string | undefined {
  if (process.platform !== 'win32') {
    return undefined
  }
  try {
    const base = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    const enableOut = execSync(`reg query "${base}" /v ProxyEnable`, {
      encoding: 'utf8',
      windowsHide: true,
    })
    const enabled =
      /\bREG_DWORD\b\s+0x1\b/i.test(enableOut) ||
      /\bProxyEnable\b.*\b1\s*$/m.test(enableOut)
    if (!enabled) {
      return undefined
    }
    const serverOut = execSync(`reg query "${base}" /v ProxyServer`, {
      encoding: 'utf8',
      windowsHide: true,
    })
    const m = serverOut.match(/ProxyServer\s+REG_SZ\s+(\S+)/i)
    const server = m?.[1]?.trim()
    if (!server) {
      return undefined
    }
    if (server.includes('=')) {
      const parts = server.split(';')
      for (const p of parts) {
        const [k, v] = p.split('=', 2)
        if (!v) continue
        const key = k?.trim().toLowerCase()
        if (key === 'http' || key === 'https') {
          return v.includes('://') ? v.trim() : `http://${v.trim()}`
        }
      }
    }
    return server.includes('://') ? server : `http://${server}`
  } catch {
    return undefined
  }
}

function isCoreNameTaken(db: Database, coreName: string): boolean {
  const n = coreName.trim()
  const cores = listCores(db)
  for (const c of cores) {
    const cn = String((c as { coreName?: string }).coreName ?? '')
    const cp = String((c as { corePath?: string }).corePath ?? '')
    if (cn.toLowerCase() === n.toLowerCase()) {
      return true
    }
    const base = basename(cp.replace(/\\/g, '/'))
    if (base.toLowerCase() === n.toLowerCase()) {
      return true
    }
  }
  return false
}

function detectZipRootPrefix(entries: Array<{ entryName: string }>): {
  hasCommonRoot: boolean
  rootPrefix: string
} {
  let rootPrefix = ''
  let hasCommonRoot = true

  for (const f of entries) {
    const cleanName = f.entryName.replace(/\\/g, '/')
    const slash = cleanName.indexOf('/')
    const first = slash === -1 ? cleanName : cleanName.slice(0, slash)
    if (!first) {
      continue
    }

    if (!rootPrefix) {
      rootPrefix = `${first}/`
    } else if (
      !cleanName.startsWith(rootPrefix) &&
      cleanName !== rootPrefix.slice(0, -1)
    ) {
      hasCommonRoot = false
      break
    }
  }

  return { hasCommonRoot, rootPrefix }
}

function extractZipStripRoot(
  zipPath: string,
  dest: string,
  progressCb: (pct: number, msg: string) => void,
): void {
  const zip = new AdmZip(zipPath)
  const entries = zip.getEntries()
  if (entries.length === 0) {
    throw new Error('空的压缩包')
  }

  const { hasCommonRoot, rootPrefix } = detectZipRootPrefix(entries)

  const root = resolve(dest)
  mkdirSync(root, { recursive: true })

  const total = entries.length
  for (let i = 0; i < entries.length; i++) {
    const f = entries[i]
    if (i % 50 === 0) {
      const pct = Math.min(99, Math.floor((i / Math.max(total, 1)) * 100))
      progressCb(pct, `正在解压文件 ${i + 1} / ${total}...`)
    }

    let cleanName = f.entryName.replace(/\\/g, '/')
    if (hasCommonRoot && rootPrefix) {
      if (cleanName === rootPrefix || cleanName === rootPrefix.slice(0, -1)) {
        continue
      }
      if (cleanName.startsWith(rootPrefix)) {
        cleanName = cleanName.slice(rootPrefix.length)
      }
    }

    if (!cleanName || cleanName === '/') {
      continue
    }

    const segments = cleanName.split('/').filter((s) => s.length > 0)
    if (segments.some((s) => s === '..')) {
      throw new Error(`非法文件路径: ${f.entryName}`)
    }

    const target = join(root, ...segments)
    const rel = relative(root, target)
    if (rel.startsWith('..') || rel === '..') {
      throw new Error(`非法文件路径: ${f.entryName}`)
    }

    if (f.isDirectory || cleanName.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, f.getData())
  }

  progressCb(100, '解压完成！')
}

/**
 * 使用 node:http(s) + proxy-agent，避免引入 undici（其可选缓存会引用 Electron 无此内置的 node:sqlite）。
 */
function createProxyAgent(
  proxyUrl: string | undefined,
  targetUrl: string,
): http.Agent | https.Agent | undefined {
  if (!proxyUrl) {
    return undefined
  }
  return targetUrl.startsWith('https:')
    ? new HttpsProxyAgent(proxyUrl)
    : new HttpProxyAgent(proxyUrl)
}

async function downloadToFile(
  urlStr: string,
  filePath: string,
  proxyUrl: string | undefined,
  onChunk: (loaded: number, total: number | null) => void,
): Promise<void> {
  let currentUrl = urlStr
  for (let hop = 0; hop < 16; hop++) {
    const outcome = await new Promise<'redirect' | 'done'>((resolve, reject) => {
      let u: URL
      try {
        u = new URL(currentUrl)
      } catch (e) {
        reject(new Error(`下载地址无效: ${e instanceof Error ? e.message : e}`))
        return
      }
      const isHttps = u.protocol === 'https:'
      const lib = isHttps ? https : http
      const agent = createProxyAgent(proxyUrl, currentUrl)
      const opts: http.RequestOptions = {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        agent: agent as http.Agent,
        headers: { 'User-Agent': 'Ant-Browser-Desktop/1.0', Accept: '*/*' },
      }

      const req = lib.request(opts, (res) => {
        const code = res.statusCode ?? 0
        if (code >= 300 && code < 400 && res.headers.location) {
          currentUrl = new URL(res.headers.location, currentUrl).href
          res.resume()
          resolve('redirect')
          return
        }
        if (code !== 200) {
          res.resume()
          reject(new Error(`HTTP 状态异常: ${code}`))
          return
        }
        const totalHdr = res.headers['content-length']
        const total = totalHdr ? Number(totalHdr) : null
        const fd = openSync(filePath, 'w')
        let loaded = 0
        res.on('data', (chunk: Buffer) => {
          writeSync(fd, chunk)
          loaded += chunk.length
          onChunk(loaded, Number.isFinite(total) ? total : null)
        })
        res.on('end', () => {
          try {
            closeSync(fd)
          } catch {
            /* ignore */
          }
          resolve('done')
        })
        res.on('error', (err) => {
          try {
            closeSync(fd)
          } catch {
            /* ignore */
          }
          reject(err)
        })
      })
      req.setTimeout(30_000, () => {
        req.destroy(new Error('下载请求超时（30s 内无响应）'))
      })
      req.on('error', reject)
      req.end()
    })
    if (outcome === 'done') {
      return
    }
  }
  throw new Error('重定向过多')
}

async function runDownload(
  targetUrl: string,
  tempZipPath: string,
  proxyConfig: string,
): Promise<void> {
  const { url: proxyUrl, hint } = resolveProxyUrl(proxyConfig)
  emitProgress({
    phase: 'downloading',
    progress: 0,
    message: `开始下载: ${targetUrl}（${hint}）`,
  })

  let lastTick = 0
  await downloadToFile(
    targetUrl,
    tempZipPath,
    proxyUrl,
    (loaded, total) => {
      const now = Date.now()
      if (now - lastTick < 800 && loaded !== total) {
        return
      }
      lastTick = now
      const pct =
        total && total > 0 ? Math.min(99, Math.floor((loaded / total) * 100)) : 0
      const mb = loaded / 1024 / 1024
      const tail = total && total > 0 ? ` / ${(total / 1024 / 1024).toFixed(2)} MB` : ''
      emitProgress({
        phase: 'downloading',
        progress: pct,
        message: `下载中... ${mb.toFixed(2)} MB${tail}`,
      })
    },
  )

  emitProgress({
    phase: 'downloading',
    progress: 100,
    message: '下载完成',
  })
}

export function startBrowserCoreDownload(
  db: Database,
  coreNameRaw: string,
  targetUrlRaw: string,
  proxyConfig: string,
): void {
  void (async () => {
    const coreName = coreNameRaw.trim()
    const targetUrl = targetUrlRaw.trim()

    try {
      emitProgress({
        phase: 'downloading',
        progress: 0,
        message: `开始解析地址: ${targetUrl}`,
      })

      if (!coreName) {
        emitProgress({ phase: 'error', progress: 0, message: '内核名称不能为空' })
        return
      }
      if (!targetUrl) {
        emitProgress({ phase: 'error', progress: 0, message: '下载地址不能为空' })
        return
      }

      if (isCoreNameTaken(db, coreName)) {
        emitProgress({ phase: 'error', progress: 0, message: '名称已存在，请换一个名称' })
        return
      }

      try {
        resolveProxyUrl(proxyConfig)
      } catch (e) {
        emitProgress({
          phase: 'error',
          progress: 0,
          message: e instanceof Error ? e.message : String(e),
        })
        return
      }

      const chromeDir = resolveAppRelativePath('chrome')
      mkdirSync(chromeDir, { recursive: true })

      const targetDir = join(chromeDir, coreName)
      if (existsSync(targetDir)) {
        emitProgress({
          phase: 'error',
          progress: 0,
          message: `同名文件夹已存在: ${coreName}`,
        })
        return
      }

      const tmpDir = mkdtempSync(join(tmpdir(), 'core-dl-'))
      const tempZipPath = join(tmpDir, 'download.zip')

      try {
        await runDownload(targetUrl, tempZipPath, proxyConfig)

        emitProgress({
          phase: 'extracting',
          progress: 0,
          message: '下载完成，正在准备解压文件...',
        })

        mkdirSync(targetDir, { recursive: true })
        extractZipStripRoot(tempZipPath, targetDir, (pct, msg) => {
          emitProgress({ phase: 'extracting', progress: pct, message: msg })
        })
      } finally {
        try {
          unlinkSync(tempZipPath)
        } catch {
          /* ignore */
        }
        try {
          rmSync(tmpDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }

      const corePathRel = join('chrome', coreName)
      const v = validateCorePath(corePathRel)
      if (!v.valid) {
        try {
          rmSync(targetDir, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
        const hint = coreExecutableCandidates().join(', ')
        emitProgress({
          phase: 'error',
          progress: 0,
          message: `解压后未找到浏览器可执行文件（候选：${hint}），请检查压缩包内容！`,
        })
        return
      }

      const cores = listCores(db)
      browserCoreSave(db, {
        coreId: randomUUID(),
        coreName,
        corePath: corePathRel,
        isDefault: cores.length === 0,
      })

      emitProgress({
        phase: 'done',
        progress: 100,
        message: '内核下载与配置成功！',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      emitProgress({ phase: 'error', progress: 0, message: `下载或解压失败: ${msg}` })
    }
  })().catch((e) => {
    console.error('[startBrowserCoreDownload]', e)
    emitProgress({
      phase: 'error',
      progress: 0,
      message: e instanceof Error ? e.message : String(e),
    })
  })
}

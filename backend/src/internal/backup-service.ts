/**
 * 对齐 Ant-Browser app_backup.go + app_backup_ops.go：配置包导出/导入/初始化，事件 backup:export:progress、backup:import:progress。
 */
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { app, dialog } from 'electron'
import type { Database } from 'sql.js'
import yaml from 'js-yaml'

import {
  buildBackupScope,
  buildManifest,
  collectExtraCorePathsFromDb,
  PACKAGE_FORMAT,
  MANIFEST_VERSION,
  type BackupManifest,
  type BackupScope,
  type ScopeEntry,
} from './backup-spec'
import { getSqlite, persistSqlite } from './database/sqlite-store'
import {
  getAppStateRoot,
  loadRootYamlRaw,
  saveRootYamlRaw,
  reloadAppConfig,
} from './app-config-store'
import { resolveDatabasePath } from './paths'
import { browserInstanceStop } from './browser-instance-service'
import { listRunningProfileIds } from './browser-runtime-store'
import { stopLaunchHttpServer, startLaunchHttpServer } from './launch-http-server'
import { stopAllProxyBridges } from './proxy-bridge-service'
import { emitWailsEvent } from '../ipc/wails-emit'
import { runMergeDatabase } from './backup-merge-database'

const require = createRequire(import.meta.url)
const AdmZip = require('adm-zip') as new (data?: string) => {
  addFile(entryName: string, content: Buffer): void
  addLocalFile(localPath: string, zipPath: string, zipName?: string): void
  addLocalFolder(localPath: string, zipPath: string): void
  writeZip(filePath: string): void
  extractAllTo(targetPath: string, overwrite: boolean): void
}

type ProgressMeta = {
  componentId?: string
  componentName?: string
  entryIndex?: number
  entryTotal?: number
}

type MergeStats = { imported: number; skipped: number; conflicts: number }

type FailedComponentErrorType = 'config' | 'database' | 'filesystem' | 'runtime' | 'unknown'

function inferFailedComponentErrorType(componentId: string): FailedComponentErrorType {
  const id = String(componentId ?? '').trim().toLowerCase()
  if (!id) return 'unknown'
  if (id.startsWith('system_config_')) return 'config'
  if (id.startsWith('database_')) return 'database'
  if (
    id.startsWith('app_data_') ||
    id.startsWith('browser_user_data_') ||
    id.startsWith('browser_core_') ||
    id.startsWith('logs_')
  ) {
    return 'filesystem'
  }
  if (id.startsWith('runtime_')) return 'runtime'
  return 'unknown'
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function emitExport(
  phase: string,
  progress: number,
  message: string,
  meta: ProgressMeta | null = null,
): void {
  const payload: Record<string, unknown> = {
    phase: String(phase).trim(),
    progress: Math.max(0, Math.min(100, progress)),
    message: String(message).trim(),
    timestamp: nowTime(),
  }
  if (meta?.componentId) payload.componentId = meta.componentId
  if (meta?.componentName) payload.componentName = meta.componentName
  if (meta?.entryIndex != null) payload.entryIndex = meta.entryIndex
  if (meta?.entryTotal != null) payload.entryTotal = meta.entryTotal
  emitWailsEvent('backup:export:progress', payload)
}

function emitImport(phase: string, progress: number, message: string, meta: ProgressMeta | null = null): void {
  const payload: Record<string, unknown> = {
    phase: String(phase).trim(),
    progress: Math.max(0, Math.min(100, progress)),
    message: String(message).trim(),
    timestamp: nowTime(),
  }
  if (meta?.componentId) payload.componentId = meta.componentId
  if (meta?.componentName) payload.componentName = meta.componentName
  if (meta?.entryIndex) payload.entryIndex = meta.entryIndex
  if (meta?.entryTotal) payload.entryTotal = meta.entryTotal
  emitWailsEvent('backup:import:progress', payload)
}

function ensureZipSuffix(p: string): string {
  const t = p.trim()
  if (t.toLowerCase().endsWith('.zip')) return t
  return `${t}.zip`
}

function normalizeKeyPath(p: string): string {
  return resolve(p).toLowerCase()
}

async function stopBrowsersForMaintenance(): Promise<void> {
  const db = getSqlite()
  if (!db) return
  const ids = listRunningProfileIds()
  for (const id of ids) {
    try {
      await browserInstanceStop(db, id)
    } catch (e) {
      console.error('[backup] stop instance', id, e)
    }
  }
  try {
    await stopLaunchHttpServer()
  } catch {
    /* ignore */
  }
  try {
    await stopAllProxyBridges()
  } catch {
    /* ignore */
  }
}

function resolveEntryLabel(e: ScopeEntry): string {
  if (e.description?.trim()) return e.description.trim()
  return e.id
}

function writePackageZip(
  savePath: string,
  scope: BackupScope,
  manifest: BackupManifest,
): { included: number; skipped: number; fileCount: number } {
  const tmp = `${savePath}.tmp`
  if (existsSync(tmp)) {
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
  const zip = new AdmZip()
  zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'))
  let fileCount = 1
  let included = 0
  let skipped = 0
  const total = scope.entries.length
  for (let i = 0; i < scope.entries.length; i++) {
    const entry = scope.entries[i]
    const label = resolveEntryLabel(entry)
    const startP = 20 + Math.floor((i / Math.max(total, 1)) * 70)
    emitExport(
      'writing',
      startP,
      `开始处理组件 ${i + 1}/${total}：${label}`,
      {
        componentId: entry.id,
        componentName: label,
        entryIndex: i + 1,
        entryTotal: total,
      },
    )
    let info: { isDirectory: () => boolean } | null = null
    try {
      const st = statSync(entry.sourcePath)
      info = st
    } catch (e) {
      if (entry.required) {
        throw new Error(`读取导出源失败(${entry.id}): ${e instanceof Error ? e.message : e}`)
      }
      skipped++
      emitExport(
        'writing',
        20 + Math.floor(((i + 1) / Math.max(total, 1)) * 70),
        `组件跳过：${label}（源路径不存在）`,
        { componentId: entry.id, componentName: label, entryIndex: i + 1, entryTotal: total },
      )
      continue
    }
    if (normalizeKeyPath(entry.sourcePath) === normalizeKeyPath(savePath)) {
      skipped++
      emitExport(
        'writing',
        20 + Math.floor(((i + 1) / Math.max(total, 1)) * 70),
        `组件跳过：${label}（导出文件本身）`,
        { componentId: entry.id, componentName: label, entryIndex: i + 1, entryTotal: total },
      )
      continue
    }
    let entryFiles = 0
    if (info.isDirectory()) {
      const base = entry.archivePath.replace(/\/$/, '') || 'dir'
      zip.addLocalFolder(entry.sourcePath, base)
      const walkCount = (dir: string): number => {
        let n = 0
        for (const name of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, name.name)
          if (name.isDirectory()) n += walkCount(p)
          else n++
        }
        return n
      }
      entryFiles = walkCount(entry.sourcePath)
      fileCount += entryFiles
    } else {
      const ap = entry.archivePath.replace(/\/$/, '')
      const zdir = ap.includes('/') ? ap.slice(0, ap.lastIndexOf('/')) : ''
      const zname = ap.includes('/') ? ap.slice(ap.lastIndexOf('/') + 1) : ap
      zip.addLocalFile(entry.sourcePath, zdir ? `${zdir}/` : '', zname)
      fileCount++
      entryFiles = 1
    }
    included++
    emitExport(
      'writing',
      20 + Math.floor(((i + 1) / Math.max(total, 1)) * 70),
      `组件完成：${label}（新增约 ${entryFiles} 个文件）`,
      { componentId: entry.id, componentName: label, entryIndex: i + 1, entryTotal: total },
    )
  }
  zip.writeZip(tmp)
  try {
    if (existsSync(savePath)) {
      unlinkSync(savePath)
    }
  } catch {
    /* ignore */
  }
  renameSync(tmp, savePath)
  return { included, skipped, fileCount }
}

export async function backupExportPackage(): Promise<Record<string, unknown>> {
  const root = getAppStateRoot()
  if (!root) {
    return { cancelled: true, message: '应用尚未初始化' }
  }
  emitExport('starting', 0, '等待选择导出路径...')

  const defaultName = `nexbrowser-full-backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '-')}.zip`
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '导出全量备份（单 ZIP）',
    defaultPath: defaultName,
    filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
  })
  if (canceled || !filePath?.trim()) {
    emitExport('cancelled', 0, '已取消导出')
    return { cancelled: true, message: '已取消导出' }
  }

  const savePath = ensureZipSuffix(filePath.trim())
  const db = getSqlite()
  emitExport('preparing', 8, '正在收集导出范围...')
  const raw = loadRootYamlRaw()
  const scope = buildBackupScope(root, raw, db)
  const manifest = buildManifest(
    scope,
    app.getName() || 'NexBrowser',
    app.getVersion() || '0.1.0',
    new Date(),
  )
  emitExport('preparing', 15, '开始写入备份包...')
  try {
    mkdirSync(dirname(savePath), { recursive: true })
  } catch (e) {
    emitExport('error', 100, `创建导出目录失败: ${e instanceof Error ? e.message : e}`)
    throw e
  }
  try {
    const { included, skipped, fileCount } = writePackageZip(savePath, scope, manifest)
    emitExport('done', 100, '导出完成')
    return {
      cancelled: false,
      zipPath: savePath,
      includedEntries: included,
      skippedEntries: skipped,
      fileCount,
      message: '导出完成',
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emitExport('error', 100, `导出失败: ${msg}`)
    throw e
  }
}

function extractAndValidate(
  zipPath: string,
): { extractRoot: string; manifest: BackupManifest; cleanup: () => void } {
  const extractRoot = join(
    tmpdir(),
    `ant-chrome-import-${Date.now()}-${randomBytes(4).toString('hex')}`,
  )
  mkdirSync(extractRoot, { recursive: true })
  const zip = new AdmZip(zipPath)
  zip.extractAllTo(extractRoot, true)
  const mpath = join(extractRoot, 'manifest.json')
  if (!existsSync(mpath)) {
    try {
      rmSync(extractRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error('备份包缺少 manifest.json')
  }
  const data = readFileSync(mpath, 'utf8')
  const manifest = JSON.parse(data) as BackupManifest
  if (manifest.format !== PACKAGE_FORMAT) {
    try {
      rmSync(extractRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error(`不支持的备份格式: ${String(manifest.format)}`)
  }
  if (manifest.manifestVersion !== MANIFEST_VERSION) {
    try {
      rmSync(extractRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error(`不支持的 manifest 版本: ${manifest.manifestVersion}`)
  }
  if (!existsSync(join(extractRoot, 'payload'))) {
    try {
      rmSync(extractRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error('备份包缺少 payload 目录')
  }
  return {
    extractRoot,
    manifest,
    cleanup: () => {
      try {
        rmSync(extractRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

function detectPresentManifestEntries(
  extractRoot: string,
  manifest: BackupManifest,
): Map<string, { componentName: string }> {
  const present = new Map<string, { componentName: string }>()
  for (const entry of manifest.entries) {
    const id = String(entry.id ?? '').trim()
    const archivePath = String(entry.archivePath ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
    if (!id || !archivePath) {
      continue
    }
    const absPath = join(extractRoot, archivePath.split('/').join(sep))
    if (!existsSync(absPath)) {
      continue
    }
    const componentName = String(entry.description ?? '').trim() || id
    present.set(id, { componentName })
  }
  return present
}

/** payload 为备份根下的 payload/ 目录 */
function findDatabaseInPayload(payloadDir: string): string {
  const c1 = join(payloadDir, 'app', 'database', 'app.db')
  const c2 = join(payloadDir, 'app', 'data', 'app.db')
  for (const p of [c1, c2]) {
    if (existsSync(p) && statSync(p).isFile()) {
      return p
    }
  }
  return ''
}

function removeDirContentsExcept(dir: string, keep: Set<string>): void {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const norm = full.toLowerCase()
    if (keep.has(norm)) {
      continue
    }
    try {
      const st = statSync(full)
      if (st.isDirectory()) {
        rmSync(full, { recursive: true, force: true })
      } else {
        unlinkSync(full)
      }
    } catch {
      /* ignore */
    }
  }
}

function copyDirWithMerge(
  src: string,
  dst: string,
  overwrite: boolean,
  shouldSkip: (rel: string) => boolean,
  stats: MergeStats,
): void {
  const hashFile = (path: string): string => {
    const data = readFileSync(path)
    return createHash('sha256').update(data).digest('hex')
  }

  const filesSame = (a: string, b: string): boolean => {
    const sa = statSync(a)
    const sb = statSync(b)
    if (sa.size !== sb.size) {
      return false
    }
    return hashFile(a) === hashFile(b)
  }

  if (!existsSync(src)) return
  mkdirSync(dst, { recursive: true })
  const walk = (a: string, b: string, rel: string) => {
    for (const name of readdirSync(a, { withFileTypes: true })) {
      const ap = join(a, name.name)
      const bp = join(b, name.name)
      const r = rel ? `${rel}/${name.name}` : name.name
      if (shouldSkip(r)) {
        stats.skipped++
        continue
      }
      if (name.isDirectory()) {
        walk(ap, bp, r)
        continue
      }
      if (!overwrite && existsSync(bp)) {
        if (filesSame(ap, bp)) {
          stats.skipped++
        } else {
          stats.conflicts++
        }
        continue
      }
      mkdirSync(dirname(bp), { recursive: true })
      copyFileSync(ap, bp)
      stats.imported++
    }
  }
  walk(src, dst, '')
}

function shouldSkipAppDbFile(rel: string): boolean {
  const n = rel.replace(/\\/g, '/').toLowerCase()
  if (n.endsWith('app.db') && !n.includes('profiles')) {
    return true
  }
  if (n.endsWith('app.db-wal') || n.endsWith('app.db-shm')) {
    return true
  }
  return false
}

function applyIncomingConfigYaml(
  pathToYaml: string,
  resetFirst: boolean,
  currentRoot: Record<string, unknown>,
  licenseApp: Record<string, unknown>,
): void {
  const incoming = yaml.load(readFileSync(pathToYaml, 'utf8')) as Record<string, unknown>
  if (resetFirst) {
    const t = { ...incoming }
    t.database = currentRoot.database
    const nextApp = { ...((t.app as Record<string, unknown>) || {}) }
    if (licenseApp.max_profile_limit != null) {
      nextApp.max_profile_limit = licenseApp.max_profile_limit
    }
    if (Array.isArray(licenseApp.used_cd_keys)) {
      nextApp.used_cd_keys = [...licenseApp.used_cd_keys]
    }
    t.app = nextApp
    saveRootYamlRaw(t)
  } else {
    const m = { ...currentRoot }
    const incB = (incoming.browser as Record<string, unknown>) || {}
    const curB = (m.browser as Record<string, unknown>) || {}
    m.browser = { ...curB, ...incB }
    m.database = currentRoot.database
    const cApp = (currentRoot.app as Record<string, unknown>) || {}
    const mApp = (m.app as Record<string, unknown>) || {}
    m.app = { ...mApp, max_profile_limit: cApp.max_profile_limit, used_cd_keys: cApp.used_cd_keys }
    saveRootYamlRaw(m)
  }
  reloadAppConfig()
}

function mergeProxiesFile(
  srcPath: string,
  stateRoot: string,
  resetFirst: boolean,
  stats: MergeStats,
): void {
  const dst = join(stateRoot, 'proxies.yaml')
  if (!existsSync(srcPath)) {
    if (resetFirst && existsSync(dst)) {
      try {
        unlinkSync(dst)
      } catch {
        /* ignore */
      }
    }
    return
  }
  if (resetFirst) {
    copyFileSync(srcPath, dst)
    return
  }
  if (!existsSync(dst)) {
    copyFileSync(srcPath, dst)
    return
  }
  const incoming = (yaml.load(readFileSync(srcPath, 'utf8')) as { proxies?: unknown[] }) || {}
  const current = (yaml.load(readFileSync(dst, 'utf8')) as { proxies?: unknown[] }) || {}
  const curList = Array.isArray(current.proxies) ? current.proxies : []
  const incList = Array.isArray(incoming.proxies) ? incoming.proxies : []
  const seenId = new Set<string>()
  const seenCfg = new Set<string>()
  for (const p of curList) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const id = String(o.proxy_id ?? '').toLowerCase()
    if (id) seenId.add(id)
    const cfg = String(o.proxy_config ?? '').toLowerCase()
    if (cfg) seenCfg.add(cfg)
  }
  const merged: unknown[] = [...curList]
  for (const p of incList) {
    if (!p || typeof p !== 'object') continue
    const o = p as Record<string, unknown>
    const id = String(o.proxy_id ?? '').toLowerCase()
    const cfg = String(o.proxy_config ?? '').toLowerCase()
    if (id && seenId.has(id)) {
      stats.skipped++
      continue
    }
    if (cfg && seenCfg.has(cfg)) {
      stats.skipped++
      continue
    }
    merged.push(p)
    if (id) seenId.add(id)
    if (cfg) seenCfg.add(cfg)
    stats.imported++
  }
  writeFileSync(dst, yaml.dump({ proxies: merged }, { lineWidth: -1, noRefs: true }), 'utf8')
}

function importFileTrees(
  payloadRoot: string,
  stateRoot: string,
  raw: Record<string, unknown>,
  resetFirst: boolean,
  stats: MergeStats,
  report: (id: string, name: string, err: Error) => void,
): void {
  const appDataSrc = join(payloadRoot, 'app', 'data')
  const appDataDst = join(stateRoot, 'data')
  const liveDb = resolveDatabasePath(app)
  const keep = new Set(
    [liveDb, `${liveDb}-wal`, `${liveDb}-shm`].map((p) => p.toLowerCase()),
  )
  if (existsSync(appDataSrc)) {
    try {
      if (resetFirst) {
        removeDirContentsExcept(appDataDst, keep)
        copyDirWithMerge(
          appDataSrc,
          appDataDst,
          true,
          shouldSkipAppDbFile,
          stats,
        )
      } else {
        copyDirWithMerge(
          appDataSrc,
          appDataDst,
          false,
          shouldSkipAppDbFile,
          stats,
        )
      }
    } catch (e) {
      report(
        'app_data_root',
        '应用数据目录（含数据库、快照及默认浏览器数据）',
        e instanceof Error ? e : new Error(String(e)),
      )
    }
  }

  const uRootRel = String((raw.browser as { user_data_root?: string })?.user_data_root ?? 'data')
  const userDataSrc = join(payloadRoot, 'browser', 'user-data')
  const userDataDst = isAbsolute(uRootRel) ? uRootRel : join(stateRoot, uRootRel)
  if (existsSync(userDataSrc)) {
    try {
      if (resetFirst) {
        if (existsSync(userDataDst)) {
          rmSync(userDataDst, { recursive: true, force: true })
        }
        mkdirSync(userDataDst, { recursive: true })
        copyDirWithMerge(userDataSrc, userDataDst, true, () => false, stats)
      } else {
        copyDirWithMerge(userDataSrc, userDataDst, false, () => false, stats)
      }
    } catch (e) {
      report('browser_user_data_root', '浏览器用户数据根目录', e instanceof Error ? e : new Error(String(e)))
    }
  }

  const chromeSrc = join(payloadRoot, 'browser', 'cores', 'chrome')
  const chromeDst = join(stateRoot, 'chrome')
  if (existsSync(chromeSrc)) {
    try {
      if (resetFirst) {
        if (existsSync(chromeDst)) {
          rmSync(chromeDst, { recursive: true, force: true })
        }
        mkdirSync(chromeDst, { recursive: true })
        copyDirWithMerge(chromeSrc, chromeDst, true, () => false, stats)
      } else {
        copyDirWithMerge(chromeSrc, chromeDst, false, () => false, stats)
      }
    } catch (e) {
      report('browser_core_root', '默认内核目录', e instanceof Error ? e : new Error(String(e)))
    }
  }

  const extRoot = join(payloadRoot, 'browser', 'cores', 'external')
  const dbConn = getSqlite()
  if (existsSync(extRoot)) {
    if (!dbConn) {
      for (const name of readdirSync(extRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)) {
        report(
          `browser_core_external_${name}`,
          '额外内核目录（来自配置 cores）',
          new Error('缺少可用配置，无法映射目标路径'),
        )
      }
    } else {
      const paths = collectExtraCorePathsFromDb(dbConn, stateRoot, join(stateRoot, 'chrome'))
      const names = readdirSync(extRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
      for (let i = 0; i < names.length; i++) {
        const name = names[i]!
        const src = join(extRoot, name)
        if (i >= paths.length) {
          stats.skipped++
          report(
            `browser_core_external_${name}`,
            '额外内核目录（来自配置 cores）',
            new Error('目标配置缺失，无法导入该外部内核目录'),
          )
          continue
        }
        const dst = paths[i]!
        try {
          if (resetFirst) {
            if (existsSync(dst)) {
              rmSync(dst, { recursive: true, force: true })
            }
            mkdirSync(dst, { recursive: true })
          }
          copyDirWithMerge(src, dst, resetFirst, () => false, stats)
        } catch (e) {
          report(
            `browser_core_external_${name}`,
            '额外内核目录（来自配置 cores）',
            e instanceof Error ? e : new Error(String(e)),
          )
        }
      }
    }
  }
}

function defaultRootYamlForInit(licenseApp?: Record<string, unknown>): Record<string, unknown> {
  const appSection: Record<string, unknown> = {
    name: 'NexBrowser',
    max_profile_limit: 20,
    used_cd_keys: [] as string[],
  }
  if (licenseApp) {
    if (licenseApp.max_profile_limit != null) {
      appSection.max_profile_limit = licenseApp.max_profile_limit
    }
    if (Array.isArray(licenseApp.used_cd_keys)) {
      appSection.used_cd_keys = licenseApp.used_cd_keys
    }
  }
  return {
    database: { type: 'sqlite', sqlite: { path: 'data/app.db' } },
    app: appSection,
    runtime: { max_memory_mb: 0, gc_percent: 100 },
    browser: {
      user_data_root: 'data',
      default_fingerprint_args: ['--fingerprint-brand=Chrome', '--fingerprint-platform=windows'],
      default_launch_args: ['--disable-sync', '--no-first-run'],
      default_proxy: '',
      start_ready_timeout_ms: 3000,
      start_stable_window_ms: 1200,
    },
    logging: {
      level: 'info',
      file_enabled: false,
      file_path: 'data/logs/app.log',
    },
    launch_server: { port: 19876, auth: { enabled: false, api_key: '', header: 'X-Ant-Api-Key' } },
  }
}

function clearBusinessTables(db: Database): void {
  const tables = [
    'launch_codes',
    'browser_profiles',
    'browser_proxies',
    'browser_cores',
    'browser_bookmarks',
    'browser_groups',
  ]
  for (const t of tables) {
    try {
      db.run(`DELETE FROM ${t}`)
    } catch {
      /* ignore */
    }
  }
  try {
    db.run(`DELETE FROM sqlite_sequence WHERE name IN ('browser_bookmarks')`)
  } catch {
    /* ignore */
  }
}

function backupImportFromPath(
  zipPath: string,
  resetFirst: boolean,
): Record<string, unknown> {
  const { extractRoot, manifest, cleanup } = extractAndValidate(zipPath)
  const stats: MergeStats = { imported: 0, skipped: 0, conflicts: 0 }
  const stateRoot = getAppStateRoot()
  if (!stateRoot) {
    cleanup()
    throw new Error('应用根目录未初始化')
  }
  const componentEntries = detectPresentManifestEntries(extractRoot, manifest)
  const componentUniverse = new Set<string>(componentEntries.keys())
  const failedComponentIds = new Set<string>()
  const issues: Array<{
    componentId: string
    componentName: string
    error: string
    errorType: FailedComponentErrorType
  }> = []
  const report = (componentId: string, componentName: string, err: Error) => {
    const cid = String(componentId ?? '').trim()
    let cname = String(componentName ?? '').trim()
    if (cid) {
      componentUniverse.add(cid)
      failedComponentIds.add(cid)
      if (!cname) {
        cname = componentEntries.get(cid)?.componentName ?? cid
      }
    }
    if (!cname) {
      cname = '未知模块'
    }
    issues.push({
      componentId: cid,
      componentName: cname,
      error: err.message,
      errorType: inferFailedComponentErrorType(cid),
    })
  }
  const payload = join(extractRoot, 'payload')
  const systemDir = join(payload, 'system')
  const cfgPath = join(systemDir, 'config.yaml')
  const rawIncoming = existsSync(cfgPath) ? (yaml.load(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>) : null
  const preLicense = (loadRootYamlRaw().app as Record<string, unknown>) || {}

  if (resetFirst) {
    emitImport('preparing', 30, '正在初始化系统数据...')
    const cur = loadRootYamlRaw()
    saveRootYamlRaw(defaultRootYamlForInit(preLicense))
    try {
      const pxy = join(stateRoot, 'proxies.yaml')
      if (existsSync(pxy)) {
        unlinkSync(pxy)
      }
    } catch {
      /* ignore */
    }
    const db0 = getSqlite()
    if (db0) {
      clearBusinessTables(db0)
      persistSqlite()
    }
    const dbPath0 = resolveDatabasePath(app)
    const dataRoot0 = join(stateRoot, 'data')
    const keep0 = new Set(
      [dbPath0, `${dbPath0}-wal`, `${dbPath0}-shm`].map((p) => p.toLowerCase()),
    )
    try {
      removeDirContentsExcept(dataRoot0, keep0)
    } catch {
      /* ignore */
    }
    const oldU = String((cur.browser as { user_data_root?: string })?.user_data_root || 'data')
    const uAbs = isAbsolute(oldU) ? oldU : join(stateRoot, oldU)
    if (uAbs.toLowerCase() !== dataRoot0.toLowerCase()) {
      try {
        removeDirContentsExcept(uAbs, keep0)
      } catch {
        /* ignore */
      }
    }
    emitImport('preparing', 40, '初始化完成，继续加载备份内容...')
  }

  if (rawIncoming) {
    emitImport('importing', 58, '正在应用系统配置...')
    try {
      applyIncomingConfigYaml(cfgPath, resetFirst, loadRootYamlRaw(), preLicense)
    } catch (e) {
      report('system_config_main', '主配置文件', e instanceof Error ? e : new Error(String(e)))
    }
  } else if (resetFirst) {
    report('system_config_main', '主配置文件', new Error('备份包缺少 payload/system/config.yaml，已保留默认配置继续加载其余模块'))
  }

  emitImport('importing', 66, '正在合并代理配置...')
  try {
    const px = join(payload, 'system', 'proxies.yaml')
    mergeProxiesFile(px, stateRoot, resetFirst, stats)
  } catch (e) {
    report('system_config_proxies', '代理配置文件', e instanceof Error ? e : new Error(String(e)))
  }

  const dbSrc = findDatabaseInPayload(payload)
  const reloaded = loadRootYamlRaw()
  if (dbSrc) {
    emitImport('importing', 76, '正在合并数据库数据...')
    try {
      runMergeDatabase(dbSrc, resetFirst, stats)
    } catch (e) {
      report('database_sqlite_main', 'SQLite 主数据库', e instanceof Error ? e : new Error(String(e)))
    }
  } else {
    if (componentEntries.has('database_sqlite_main')) {
      report('database_sqlite_main', 'SQLite 主数据库', new Error('备份包缺少数据库文件'))
    }
  }

  emitImport('importing', 86, '正在同步文件数据...')
  importFileTrees(
    payload,
    stateRoot,
    reloaded,
    resetFirst,
    stats,
    (id, name, err) => report(id, name, err),
  )

  emitImport('importing', 94, '正在刷新配置...')
  reloadAppConfig()
  void startLaunchHttpServer().catch((e) => console.error(e))

  cleanup()

  const componentTotal = componentUniverse.size
  const componentFailed = failedComponentIds.size
  const componentSuccess = Math.max(0, componentTotal - componentFailed)
  const partial = componentFailed > 0
  const msg = partial
    ? `加载完成（部分成功）：成功 ${componentSuccess} 个模块，异常 ${componentFailed} 个模块`
    : '加载完成'
  emitImport('done', 100, msg)

  return {
    cancelled: false,
    zipPath,
    resetFirst,
    imported: stats.imported,
    skipped: stats.skipped,
    conflicts: stats.conflicts,
    partial,
    componentTotal,
    componentSuccess,
    componentFailed,
    failedComponents: issues.map((x) => ({
      componentId: x.componentId,
      componentName: x.componentName,
      error: x.error,
      errorType: x.errorType,
    })),
    message: msg,
  }
}

export async function backupImportPackage(
  resetFirst: boolean,
): Promise<Record<string, unknown>> {
  emitImport('starting', 0, '等待选择全量备份 ZIP...')
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: '导入全量备份（单 ZIP）',
    properties: ['openFile'],
    filters: [{ name: 'ZIP 文件', extensions: ['zip'] }],
  })
  if (canceled || !filePaths?.[0]?.trim()) {
    emitImport('cancelled', 0, '已取消加载')
    return { cancelled: true, message: '已取消加载' }
  }
  const zipPath = filePaths[0].trim()
  await stopBrowsersForMaintenance()
  emitImport('preparing', 5, '正在校验备份包...')
  try {
    return backupImportFromPath(zipPath, resetFirst)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    emitImport('error', 100, `加载失败: ${msg}`)
    throw e
  }
}

export async function backupInitializeSystem(): Promise<Record<string, unknown>> {
  const root = getAppStateRoot()
  if (!root) {
    return { cancelled: true, message: '应用根目录未初始化' }
  }
  await stopBrowsersForMaintenance()
  const cur = loadRootYamlRaw()
  saveRootYamlRaw(defaultRootYamlForInit())
  try {
    const pxy = join(root, 'proxies.yaml')
    if (existsSync(pxy)) {
      unlinkSync(pxy)
    }
  } catch {
    /* ignore */
  }
  const db = getSqlite()
  if (db) {
    clearBusinessTables(db)
    persistSqlite()
  }
  const dbPath = resolveDatabasePath(app)
  const dataRoot = join(root, 'data')
  const keep = new Set([dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map((p) => p.toLowerCase()))
  const cleared: string[] = []
  try {
    removeDirContentsExcept(dataRoot, keep)
    cleared.push(dataRoot)
  } catch {
    /* ignore */
  }
  const oldU = String((cur.browser as { user_data_root?: string })?.user_data_root || 'data')
  const newU = 'data'
  for (const p of [oldU, newU]) {
    const uAbs = isAbsolute(p) ? p : join(root, p)
    if (uAbs.toLowerCase() === dataRoot.toLowerCase()) {
      continue
    }
    try {
      removeDirContentsExcept(uAbs, keep)
      cleared.push(uAbs)
    } catch {
      /* ignore */
    }
  }
  reloadAppConfig()
  void startLaunchHttpServer().catch((e) => console.error(e))
  return { cancelled: false, resetDone: true, clearedDirs: cleared, message: '系统已初始化到默认状态' }
}

export function backupGetScopeDefinition(): Record<string, unknown> {
  const root = getAppStateRoot()
  if (!root) {
    return { format: PACKAGE_FORMAT, manifestVersion: MANIFEST_VERSION, appRoot: '', entries: [] }
  }
  const db = getSqlite()
  return buildBackupScope(root, loadRootYamlRaw(), db) as unknown as Record<string, unknown>
}

export function backupGetManifestTemplate(): Record<string, unknown> {
  const root = getAppStateRoot()
  if (!root) {
    return {
      format: PACKAGE_FORMAT,
      manifestVersion: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      app: { name: 'NexBrowser', version: app.getVersion() },
      entries: [],
    }
  }
  const s = buildBackupScope(root, loadRootYamlRaw(), getSqlite())
  return buildManifest(
    s,
    app.getName() || 'NexBrowser',
    app.getVersion() || '0.1.0',
    new Date(),
  ) as unknown as Record<string, unknown>
}

/**
 * 对齐 Ant-Browser internal/backup/spec.go：备份包范围与 manifest。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Database } from 'sql.js'

import { listCores } from './browser-data'

export const PACKAGE_FORMAT = 'ant-chrome-full-backup'
export const MANIFEST_VERSION = 1

export type BackupCategory =
  | 'system_config'
  | 'app_data'
  | 'browser_data'
  | 'core_data'
  | 'logs'

export type BackupEntryType = 'file' | 'dir'

export type ScopeEntry = {
  id: string
  category: BackupCategory
  entryType: BackupEntryType
  required: boolean
  sourcePath: string
  archivePath: string
  /** 由 scopeBuilder 在 add 时填充 */
  exists?: boolean
  description?: string
}

export type BackupScope = {
  format: string
  manifestVersion: number
  appRoot: string
  entries: ScopeEntry[]
}

export type ManifestAppInfo = {
  name: string
  version: string
}

export type ManifestEntry = {
  id: string
  category: BackupCategory
  entryType: BackupEntryType
  required: boolean
  archivePath: string
  description?: string
}

export type BackupManifest = {
  format: string
  manifestVersion: number
  createdAt: string
  app: ManifestAppInfo
  entries: ManifestEntry[]
}

function pathExists(p: string): boolean {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function normalizeForCompare(p: string): string {
  let n = resolve(p.trim())
  if (process.platform === 'win32') {
    n = n.toLowerCase()
  }
  return n
}

function samePath(a: string, b: string): boolean {
  return normalizeForCompare(a) === normalizeForCompare(b)
}

function isPathWithin(child: string, dir: string): boolean {
  const p = normalizeForCompare(child)
  const d = normalizeForCompare(dir)
  if (p === d) return true
  if (!d || !p) return false
  const prefix = d.endsWith(sep) ? d : d + sep
  return p.startsWith(prefix)
}

function resolvePath(appRoot: string, p: string): string {
  const t = p.trim()
  if (!t) {
    return resolve(appRoot)
  }
  if (isAbsolute(t)) {
    return resolve(t)
  }
  return resolve(join(appRoot, t))
}

/** 与 Go backupCollectExternalCorePaths 同序：已排序的「非默认 chrome/ 下」内核绝对路径，用于导入时与 ZIP 中 external-* 目录一一对应。 */
export function collectExtraCorePathsFromDb(
  db: Database,
  appRootAbs: string,
  defaultChromeRoot: string,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  const rows = listCores(db)
  for (const c of rows) {
    const cp = String((c as { corePath?: string }).corePath ?? '').trim()
    if (!cp) continue
    const coreAbs = resolvePath(appRootAbs, cp)
    if (isPathWithin(coreAbs, defaultChromeRoot)) continue
    const k = normalizeForCompare(coreAbs)
    if (seen.has(k)) continue
    seen.add(k)
    result.push(coreAbs)
  }
  result.sort()
  return result
}

function detectLogDir(appRootAbs: string, logPath: string): string {
  if (!logPath.trim()) return ''
  const resolved = resolvePath(appRootAbs, logPath)
  const dir = dirname(resolved)
  if (!dir || dir === '.') return ''
  return dir
}

class ScopeBuilder {
  entries: ScopeEntry[] = []

  add(entry: ScopeEntry): void {
    if (!entry.sourcePath.trim()) return
    entry.sourcePath = resolve(entry.sourcePath)
    entry.archivePath = entry.archivePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!entry.archivePath) return

    if (this.isCoveredByExisting(entry.sourcePath)) {
      return
    }

    for (let i = 0; i < this.entries.length; i++) {
      const existing = this.entries[i]
      if (samePath(existing.sourcePath, entry.sourcePath)) {
        if (entry.required && !existing.required) {
          this.entries[i].required = true
        }
        return
      }
    }

    entry.exists = pathExists(entry.sourcePath)
    this.entries.push(entry)
    this.entries.sort((a, b) => a.id.localeCompare(b.id))
  }

  isCoveredByExisting(candidate: string): boolean {
    for (const existing of this.entries) {
      if (existing.entryType === 'dir') {
        if (isPathWithin(candidate, existing.sourcePath)) return true
      } else if (existing.entryType === 'file') {
        if (samePath(candidate, existing.sourcePath)) return true
      }
    }
    return false
  }
}

function readDatabasePath(raw: Record<string, unknown>): string {
  const db = raw.database as Record<string, unknown> | undefined
  const sqlite = db?.sqlite as Record<string, unknown> | undefined
  let p = String(sqlite?.path ?? '').trim()
  if (!p) p = 'data/app.db'
  return p
}

function readUserDataRoot(raw: Record<string, unknown>): string {
  const browser = raw.browser as Record<string, unknown> | undefined
  let r = String(browser?.user_data_root ?? '').trim()
  if (!r) r = 'data'
  return r
}

function readLoggingFilePath(raw: Record<string, unknown>): string {
  const logging = raw.logging as Record<string, unknown> | undefined
  return String(logging?.file_path ?? '').trim()
}

export function buildBackupScope(
  appRoot: string,
  rawYaml: Record<string, unknown>,
  db: Database | null,
): BackupScope {
  const appRootAbs = resolve(appRoot.trim())
  const builder = new ScopeBuilder()

  builder.add({
    id: 'system_config_main',
    category: 'system_config',
    entryType: 'file',
    required: true,
    sourcePath: join(appRootAbs, 'config.yaml'),
    archivePath: 'payload/system/config.yaml',
    exists: true,
    description: '主配置文件',
  })

  builder.add({
    id: 'system_config_proxies',
    category: 'system_config',
    entryType: 'file',
    required: false,
    sourcePath: join(appRootAbs, 'proxies.yaml'),
    archivePath: 'payload/system/proxies.yaml',
    description: '代理配置文件（存在时导出）',
  })

  const appDataRoot = join(appRootAbs, 'data')
  builder.add({
    id: 'app_data_root',
    category: 'app_data',
    entryType: 'dir',
    required: true,
    sourcePath: appDataRoot,
    archivePath: 'payload/app/data/',
    description: '应用数据目录（含数据库、快照及默认浏览器数据）',
  })

  const userDataRootRel = readUserDataRoot(rawYaml)
  const userDataRoot = resolvePath(appRootAbs, userDataRootRel)
  builder.add({
    id: 'browser_user_data_root',
    category: 'browser_data',
    entryType: 'dir',
    required: true,
    sourcePath: userDataRoot,
    archivePath: 'payload/browser/user-data/',
    description: '浏览器用户数据根目录（若与 data 重合则自动去重）',
  })

  const chromeRoot = join(appRootAbs, 'chrome')
  builder.add({
    id: 'browser_core_root',
    category: 'core_data',
    entryType: 'dir',
    required: false,
    sourcePath: chromeRoot,
    archivePath: 'payload/browser/cores/chrome/',
    description: '默认内核目录',
  })

  if (db) {
    const extras = collectExtraCorePathsFromDb(db, appRootAbs, chromeRoot)
    extras.forEach((abs, idx) => {
      const sub = `external-${String(idx + 1).padStart(2, '0')}`
      const id = `browser_core_external_${sub}`
      builder.add({
        id,
        category: 'core_data',
        entryType: 'dir',
        required: false,
        sourcePath: abs,
        archivePath: `payload/browser/cores/external/${sub}/`,
        description: '额外内核目录（来自配置 cores）',
      })
    })
  }

  const dbPath = readDatabasePath(rawYaml)
  const dbAbs = resolvePath(appRootAbs, dbPath)
  builder.add({
    id: 'database_sqlite_main',
    category: 'app_data',
    entryType: 'file',
    required: true,
    sourcePath: dbAbs,
    archivePath: 'payload/app/database/app.db',
    description: 'SQLite 主数据库（若已被 data 覆盖则自动去重）',
  })
  builder.add({
    id: 'database_sqlite_wal',
    category: 'app_data',
    entryType: 'file',
    required: false,
    sourcePath: `${dbAbs}-wal`,
    archivePath: 'payload/app/database/app.db-wal',
    description: 'SQLite WAL 文件（存在时导出）',
  })
  builder.add({
    id: 'database_sqlite_shm',
    category: 'app_data',
    entryType: 'file',
    required: false,
    sourcePath: `${dbAbs}-shm`,
    archivePath: 'payload/app/database/app.db-shm',
    description: 'SQLite SHM 文件（存在时导出）',
  })

  const logDir = detectLogDir(appRootAbs, readLoggingFilePath(rawYaml))
  if (logDir) {
    builder.add({
      id: 'logs_root',
      category: 'logs',
      entryType: 'dir',
      required: false,
      sourcePath: logDir,
      archivePath: 'payload/app/logs/',
      description: '日志目录（存在时导出）',
    })
  }

  return {
    format: PACKAGE_FORMAT,
    manifestVersion: MANIFEST_VERSION,
    appRoot: appRootAbs,
    entries: builder.entries,
  }
}

function resolveEntryName(entry: ScopeEntry): string {
  const d = entry.description?.trim()
  if (d) return d
  if (entry.id) return entry.id
  return '未知组件'
}

export function buildManifest(
  scope: BackupScope,
  appName: string,
  appVersion: string,
  createdAt: Date,
): BackupManifest {
  const name = appName.trim() || 'NexBrowser'
  const version = appVersion.trim() || 'unknown'
  const entries: ManifestEntry[] = scope.entries.map((item) => ({
    id: item.id,
    category: item.category,
    entryType: item.entryType,
    required: item.required,
    archivePath: item.archivePath,
    description: item.description,
  }))
  entries.sort((a, b) => a.id.localeCompare(b.id))
  return {
    format: PACKAGE_FORMAT,
    manifestVersion: MANIFEST_VERSION,
    createdAt: createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    app: { name, version },
    entries,
  }
}

export { resolveEntryName }

/**
 * 浏览器实例用户数据根目录：默认存于 AppData（与 app.db 同区），重装应用不丢登录态。
 * 旧版相对路径 `data` 曾解析到安装目录旁，启动时会迁移到 AppData/profiles。
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import type { App } from 'electron'
import type { Database } from 'sql.js'

import { getAppStateRoot, loadRootYamlRaw, saveRootYamlRaw } from './app-config-store'
import { persistSqlite } from './database/sqlite-store'
import { queryAll } from './database/sqljs-query'
import { resolveAppRelativePath } from './electron-paths'

/** 固定 AppData 目录名，避免 package.json name / productName 不一致导致换目录 */
export const FIXED_APP_USER_DATA_DIRNAME = 'NexBrowser'

/** 新版默认：相对 AppData 状态根（config.yaml 所在目录） */
export const DEFAULT_BROWSER_USER_DATA_ROOT = 'profiles'

/** 旧版默认：相对安装目录（exe 旁） */
export const LEGACY_INSTALL_USER_DATA_ROOT = 'data'

const LEGACY_DATA_SKIP = new Set(['app.db', 'app.db-wal', 'app.db-shm', 'snapshots', 'logs'])

/** 须在 app.whenReady() 之前调用，锁定 userData 路径 */
export function configurePersistentUserData(app: App): void {
  const appData = app.getPath('appData')
  const target = join(appData, FIXED_APP_USER_DATA_DIRNAME)
  app.setName('NexBrowser')
  app.setPath('userData', target)

  const legacyAppDataNames = ['nexbrowser-desktop', 'ant-browser-desktop', 'Ant-Browser']
  for (const name of legacyAppDataNames) {
    const legacyRoot = join(appData, name)
    if (normalizePathKey(legacyRoot) === normalizePathKey(target)) {
      continue
    }
    mergeLegacyAppDataRoot(legacyRoot, target)
  }
}

function normalizePathKey(p: string): string {
  let n = resolve(p.trim())
  if (process.platform === 'win32') {
    n = n.toLowerCase()
  }
  return n
}

function isPathWithin(child: string, dir: string): boolean {
  const p = normalizePathKey(child)
  const d = normalizePathKey(dir)
  if (p === d) return true
  const prefix = d.endsWith(sep) ? d : d + sep
  return p.startsWith(prefix)
}

function mergeLegacyAppDataRoot(legacyRoot: string, targetRoot: string): void {
  if (!existsSync(legacyRoot)) {
    return
  }
  mkdirSync(targetRoot, { recursive: true })
  let merged = 0
  for (const name of readdirSync(legacyRoot, { withFileTypes: true })) {
    if (!name.isDirectory() && name.name !== 'config.yaml') {
      continue
    }
    const src = join(legacyRoot, name.name)
    const dest = join(targetRoot, name.name)
    try {
      if (name.isDirectory()) {
        if (mergeProfileDirectory(src, dest)) {
          merged += 1
        }
      } else if (!existsSync(dest)) {
        cpSync(src, dest)
        merged += 1
      }
    } catch (e) {
      console.warn('[migrate] 合并旧 AppData 跳过', src, e instanceof Error ? e.message : e)
    }
  }
  if (merged > 0) {
    console.info('[migrate] 已合并旧 AppData 目录', legacyRoot, '→', targetRoot, `(${merged} 项)`)
  }
}

/** 旧版：相对路径解析到安装目录旁 */
export function resolveLegacyInstallBrowserDataRoot(configured?: string): string {
  const rel = String(configured ?? LEGACY_INSTALL_USER_DATA_ROOT).trim() || LEGACY_INSTALL_USER_DATA_ROOT
  if (isAbsolute(rel)) {
    return resolve(rel)
  }
  return resolveAppRelativePath(rel)
}

/** 解析浏览器用户数据根目录（Cookie / Profile 等） */
export function resolveBrowserUserDataRootAbs(configured?: string): string {
  const rel =
    String(configured ?? DEFAULT_BROWSER_USER_DATA_ROOT).trim() || DEFAULT_BROWSER_USER_DATA_ROOT
  if (isAbsolute(rel)) {
    return resolve(rel)
  }
  const stateRoot = getAppStateRoot()
  if (!stateRoot) {
    return resolveAppRelativePath(rel)
  }
  return join(stateRoot, rel)
}

/** 实例快照目录（与浏览器 profile 分离，同样放在 AppData） */
export function resolveSnapshotsRootAbs(): string {
  const stateRoot = getAppStateRoot()
  if (!stateRoot) {
    return join(resolveAppRelativePath('data'), 'snapshots')
  }
  return join(stateRoot, 'snapshots')
}

function hasChromeProfileData(dir: string): boolean {
  if (!existsSync(dir)) {
    return false
  }
  return (
    existsSync(join(dir, 'Local State')) ||
    existsSync(join(dir, 'Default', 'Preferences')) ||
    existsSync(join(dir, 'Default', 'Cookies')) ||
    existsSync(join(dir, 'Default', 'Network', 'Cookies'))
  )
}

function mergeProfileDirectory(src: string, dest: string): boolean {
  if (!existsSync(src)) {
    return false
  }
  const srcHasData = hasChromeProfileData(src)
  if (!srcHasData && !hasNonTrivialChildren(src)) {
    return false
  }
  if (!existsSync(dest)) {
    cpSync(src, dest, { recursive: true })
    return true
  }
  const destHasData = hasChromeProfileData(dest)
  if (!destHasData && srcHasData) {
    cpSync(src, dest, { recursive: true, force: true })
    return true
  }
  return false
}

function hasNonTrivialChildren(dir: string): boolean {
  try {
    const entries = readdirSync(dir)
    return entries.some((n) => !LEGACY_DATA_SKIP.has(n))
  } catch {
    return false
  }
}

function collectKnownProfileSubdirs(db: Database | null): Set<string> {
  const names = new Set<string>()
  if (!db) {
    return names
  }
  const rows = queryAll<{ user_data_dir: string; profile_id: string }>(
    db,
    `SELECT user_data_dir, profile_id FROM browser_profiles`,
  )
  for (const row of rows) {
    const udd = String(row.user_data_dir ?? '').trim()
    if (udd && !isAbsolute(udd)) {
      names.add(udd)
    } else if (udd && isAbsolute(udd)) {
      names.add(basename(udd))
    } else {
      names.add(String(row.profile_id ?? '').trim())
    }
  }
  return names
}

/** 收集所有可能的旧浏览器数据根目录（安装目录 + 旧 AppData 子目录） */
function collectLegacyBrowserDataRoots(newRoot: string): string[] {
  const newKey = normalizePathKey(newRoot)
  const seen = new Set<string>()
  const roots: string[] = []
  const add = (p: string) => {
    const key = normalizePathKey(p)
    if (seen.has(key) || key === newKey) {
      return
    }
    seen.add(key)
    roots.push(resolve(p))
  }

  add(resolveLegacyInstallBrowserDataRoot(LEGACY_INSTALL_USER_DATA_ROOT))
  add(resolveLegacyInstallBrowserDataRoot(DEFAULT_BROWSER_USER_DATA_ROOT))

  const stateRoot = getAppStateRoot()
  if (stateRoot) {
    add(join(stateRoot, LEGACY_INSTALL_USER_DATA_ROOT))
    add(join(stateRoot, DEFAULT_BROWSER_USER_DATA_ROOT))
  }

  return roots.filter((p) => existsSync(p))
}

function migrateDirEntries(
  oldRoot: string,
  newRoot: string,
  preferNames: Set<string>,
): number {
  if (!existsSync(oldRoot)) {
    return 0
  }
  if (normalizePathKey(oldRoot) === normalizePathKey(newRoot)) {
    return 0
  }
  mkdirSync(newRoot, { recursive: true })
  let copied = 0

  const entries = readdirSync(oldRoot, { withFileTypes: true })
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  const ordered = [
    ...dirs.filter((n) => preferNames.has(n)),
    ...dirs.filter((n) => !preferNames.has(n) && !LEGACY_DATA_SKIP.has(n)),
  ]

  for (const name of ordered) {
    if (LEGACY_DATA_SKIP.has(name)) {
      continue
    }
    try {
      if (mergeProfileDirectory(join(oldRoot, name), join(newRoot, name))) {
        copied += 1
      }
    } catch (e) {
      console.warn('[migrate] 跳过目录', name, e instanceof Error ? e.message : e)
    }
  }
  return copied
}

function normalizeProfilePathsInDb(db: Database, newRoot: string): number {
  const legacyRoots = [
    ...collectLegacyBrowserDataRoots(newRoot),
    resolveLegacyInstallBrowserDataRoot(LEGACY_INSTALL_USER_DATA_ROOT),
    resolveLegacyInstallBrowserDataRoot(DEFAULT_BROWSER_USER_DATA_ROOT),
  ]
  const rows = queryAll<{ profile_id: string; user_data_dir: string }>(
    db,
    `SELECT profile_id, user_data_dir FROM browser_profiles`,
  )
  let updated = 0
  for (const row of rows) {
    const udd = String(row.user_data_dir ?? '').trim()
    if (!udd || !isAbsolute(udd)) {
      continue
    }
    const underLegacy = legacyRoots.some((root) => isPathWithin(udd, root))
    if (!underLegacy) {
      continue
    }
    const next = basename(udd) || row.profile_id
    if (next === udd) {
      continue
    }
    db.run(`UPDATE browser_profiles SET user_data_dir = ? WHERE profile_id = ?`, [next, row.profile_id])
    updated += 1
  }
  if (updated > 0) {
    persistSqlite()
  }
  return updated
}

/**
 * 将安装目录旁 / 旧 AppData 下的 browser user-data 迁移到 AppData/profiles，并更新 config.yaml。
 * 幂等：目标已有有效 Chrome 数据则不覆盖。
 */
export function migrateLegacyBrowserUserData(db: Database | null): void {
  const stateRoot = getAppStateRoot()
  if (!stateRoot) {
    return
  }

  const raw = loadRootYamlRaw()
  const browser = (raw.browser as Record<string, unknown> | undefined) ?? {}
  const configured = String(browser.user_data_root ?? '').trim()
  const newRel = DEFAULT_BROWSER_USER_DATA_ROOT
  const newRoot = resolveBrowserUserDataRootAbs(newRel)
  mkdirSync(newRoot, { recursive: true })

  const profileNames = collectKnownProfileSubdirs(db)
  let copied = 0

  for (const oldRoot of collectLegacyBrowserDataRoots(newRoot)) {
    copied += migrateDirEntries(oldRoot, newRoot, profileNames)
    const oldSnapshots = join(oldRoot, 'snapshots')
    const newSnapshots = resolveSnapshotsRootAbs()
    if (normalizePathKey(oldSnapshots) !== normalizePathKey(newSnapshots)) {
      copied += migrateDirEntries(oldSnapshots, newSnapshots, new Set())
    }
  }

  let dbUpdated = 0
  if (db) {
    dbUpdated = normalizeProfilePathsInDb(db, newRoot)
  }

  if (configured !== newRel) {
    browser.user_data_root = newRel
    raw.browser = browser
    saveRootYamlRaw(raw)
  }

  console.info(
    '[migrate] 浏览器用户数据根目录:',
    newRoot,
    copied > 0 ? `(已迁移 ${copied} 个实例目录)` : '(无待迁移目录)',
    dbUpdated > 0 ? `(已修正 ${dbUpdated} 条实例路径)` : '',
  )
}

/** 解析单个实例目录；兼容 DB 中残留的绝对路径（旧安装目录） */
export function resolveProfileSubdir(userDataDirValue: string, profileId: string): string {
  const raw = String(userDataDirValue ?? '').trim()
  if (!raw) {
    return profileId
  }
  if (!isAbsolute(raw)) {
    return raw
  }
  const newRoot = resolveBrowserUserDataRootAbs(DEFAULT_BROWSER_USER_DATA_ROOT)
  const name = basename(raw) || profileId
  const canonical = join(newRoot, name)
  if (existsSync(canonical)) {
    return name
  }
  const legacyRoots = collectLegacyBrowserDataRoots(newRoot)
  if (legacyRoots.some((root) => isPathWithin(raw, root)) && existsSync(raw)) {
    mergeProfileDirectory(raw, canonical)
    return name
  }
  return raw
}

export function logBrowserDataPaths(db: Database | null): void {
  const root = resolveBrowserUserDataRootAbs(DEFAULT_BROWSER_USER_DATA_ROOT)
  const stateRoot = getAppStateRoot()
  const installLegacy = resolveLegacyInstallBrowserDataRoot(LEGACY_INSTALL_USER_DATA_ROOT)
  let profileCount = 0
  if (db) {
    profileCount = Number(
      queryAll<{ c: number }>(db, `SELECT COUNT(*) as c FROM browser_profiles`)[0]?.c ?? 0,
    )
  }
  console.info('[paths] userData(stateRoot)=', stateRoot)
  console.info('[paths] browserProfilesRoot=', root)
  console.info('[paths] legacyInstallData=', installLegacy, existsSync(installLegacy) ? '(仍存在)' : '')
  console.info('[paths] profileCount=', profileCount)
}

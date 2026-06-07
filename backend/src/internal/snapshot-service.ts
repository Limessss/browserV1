/**
 * 实例快照：ZIP + meta.json，路径对齐 Ant-Browser app_snapshot.go（data/snapshots/<profileId>/）。
 */
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import type { Database } from 'sql.js'

import { isProfileRunning } from './browser-runtime-store'
import { resolveSnapshotsRootAbs } from './browser-user-data-paths'
import { resolveProfileUserDataDir } from './profile-paths'

const require = createRequire(import.meta.url)
// adm-zip 无官方类型，CommonJS 导出
const AdmZip = require('adm-zip') as new (path?: string) => {
  addLocalFolder(localPath: string, zipPath?: string): void
  writeZip(destination: string): void
  getEntries(): Array<{
    entryName: string
    isDirectory: boolean
    getData(): Buffer
  }>
}

export interface SnapshotInfo {
  snapshotId: string
  profileId: string
  name: string
  sizeMB: number
  createdAt: string
  filePath?: string
}

function snapshotDirForProfile(profileId: string): string {
  const dir = join(resolveSnapshotsRootAbs(), profileId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 解压并校验路径，防止 zip slip（对齐 Go unzipTo） */
function unzipToSafe(zipPath: string, dest: string): void {
  const zip = new AdmZip(zipPath)
  const root = resolve(dest)
  mkdirSync(root, { recursive: true })

  for (const entry of zip.getEntries()) {
    const raw = entry.entryName.replace(/\\/g, '/')
    const segments = raw.split('/').filter((s) => s.length > 0)
    if (segments.some((s) => s === '..')) {
      throw new Error(`非法路径: ${entry.entryName}`)
    }

    const target = segments.length === 0 ? root : resolve(root, ...segments)

    const rel = relative(root, target)
    if (rel.startsWith('..') || rel === '..') {
      throw new Error(`非法路径: ${entry.entryName}`)
    }

    if (entry.isDirectory || raw.endsWith('/')) {
      mkdirSync(target, { recursive: true })
      continue
    }

    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.getData())
  }
}

function findSnapshotFiles(
  snapDir: string,
  snapshotId: string,
): { metaPath: string; zipPath: string } {
  if (!existsSync(snapDir)) {
    throw new Error(`快照不存在: ${snapshotId}`)
  }
  for (const entry of readdirSync(snapDir)) {
    if (entry.startsWith(snapshotId) && entry.endsWith('.meta.json')) {
      const metaPath = join(snapDir, entry)
      const zipPath = metaPath.slice(0, -'.meta.json'.length) + '.zip'
      if (!existsSync(zipPath)) {
        throw new Error(`快照文件不存在: ${zipPath}`)
      }
      return { metaPath, zipPath }
    }
  }
  throw new Error(`快照不存在: ${snapshotId}`)
}

export function browserSnapshotCreate(
  db: Database,
  profileId: string,
  name: string,
): SnapshotInfo {
  const pid = profileId.trim()
  if (isProfileRunning(pid)) {
    throw new Error('请先停止实例再创建快照')
  }

  const userDataDir = resolveProfileUserDataDir(db, profileId)
  if (!existsSync(userDataDir)) {
    throw new Error('用户数据目录不存在，无法创建快照')
  }
  const st = statSync(userDataDir)
  if (!st.isDirectory()) {
    throw new Error('用户数据目录不存在，无法创建快照')
  }

  const snapDir = snapshotDirForProfile(profileId)
  const snapshotId = randomUUID()
  const safeName = name.replace(/[/\\]/g, '_')
  const zipPath = join(snapDir, `${snapshotId}_${safeName}.zip`)
  const metaPath = join(snapDir, `${snapshotId}_${safeName}.meta.json`)

  const zip = new AdmZip()
  zip.addLocalFolder(userDataDir)
  zip.writeZip(zipPath)

  const fi = statSync(zipPath)
  const sizeMB = fi.size / 1024 / 1024
  const createdAt = new Date().toISOString()

  const info: SnapshotInfo = {
    snapshotId,
    profileId,
    name,
    sizeMB,
    createdAt,
    filePath: zipPath,
  }
  writeFileSync(metaPath, JSON.stringify(info), 'utf8')

  return { snapshotId, profileId, name, sizeMB, createdAt }
}

export function browserSnapshotList(profileId: string): SnapshotInfo[] {
  const dir = snapshotDirForProfile(profileId)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const list: SnapshotInfo[] = []
  for (const fileName of entries) {
    if (!fileName.endsWith('.meta.json')) {
      continue
    }
    try {
      const raw = readFileSync(join(dir, fileName), 'utf8')
      const info = JSON.parse(raw) as SnapshotInfo
      delete info.filePath
      list.push(info)
    } catch {
      continue
    }
  }

  list.sort((a, b) => (a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0))
  return list
}

export function browserSnapshotRestore(
  db: Database,
  profileId: string,
  snapshotId: string,
): void {
  const pid = profileId.trim()
  if (isProfileRunning(pid)) {
    throw new Error('请先停止实例再恢复快照')
  }

  const userDataDir = resolveProfileUserDataDir(db, profileId)
  const snapDir = join(resolveSnapshotsRootAbs(), profileId)
  const { zipPath } = findSnapshotFiles(snapDir, snapshotId)

  rmSync(userDataDir, { recursive: true, force: true })
  mkdirSync(userDataDir, { recursive: true })
  unzipToSafe(zipPath, userDataDir)
}

export function browserSnapshotDelete(profileId: string, snapshotId: string): void {
  const snapDir = join(resolveSnapshotsRootAbs(), profileId)
  const { metaPath, zipPath } = findSnapshotFiles(snapDir, snapshotId)
  try {
    unlinkSync(zipPath)
  } catch {
    /* 对齐 Go：忽略删除失败 */
  }
  try {
    unlinkSync(metaPath)
  } catch {
    /* ignore */
  }
}

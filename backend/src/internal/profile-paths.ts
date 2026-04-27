/**
 * 解析浏览器实例用户数据目录（对齐 Go browserMgr.ResolveUserDataDir）。
 */
import { join } from 'node:path'
import type { Database } from 'sql.js'

import { loadBrowserSettingsMerged } from './app-config-store'
import { getProfileRow } from './browser-data'
import { resolveAppRelativePath } from './electron-paths'

export function resolveProfileUserDataDir(db: Database, profileId: string): string {
  const row = getProfileRow(db, profileId)
  if (!row) {
    throw new Error(`实例不存在: ${profileId}`)
  }
  const settings = loadBrowserSettingsMerged()
  const root = String(settings.userDataRoot ?? 'data').trim() || 'data'
  const rootAbs = resolveAppRelativePath(root)
  const udd = String(row.user_data_dir ?? '').trim() || profileId
  return join(rootAbs, udd)
}

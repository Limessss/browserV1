/**
 * 解析浏览器实例用户数据目录（对齐 Go browserMgr.ResolveUserDataDir）。
 */
import { join, isAbsolute, resolve } from 'node:path'
import type { Database } from 'sql.js'

import { loadBrowserSettingsMerged } from './app-config-store'
import { getProfileRow } from './browser-data'
import {
  resolveBrowserUserDataRootAbs,
  resolveProfileSubdir,
} from './browser-user-data-paths'

export function resolveProfileUserDataDir(db: Database, profileId: string): string {
  const row = getProfileRow(db, profileId)
  if (!row) {
    throw new Error(`实例不存在: ${profileId}`)
  }
  const settings = loadBrowserSettingsMerged()
  const rootAbs = resolveBrowserUserDataRootAbs(String(settings.userDataRoot ?? ''))
  const udd = resolveProfileSubdir(String(row.user_data_dir ?? ''), profileId)
  if (isAbsolute(udd)) {
    return resolve(udd)
  }
  return join(rootAbs, udd)
}

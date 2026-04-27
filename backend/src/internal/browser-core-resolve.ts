/**
 * 按实例解析 Chromium 可执行文件路径（对齐 browserMgr.ResolveChromeBinary）。
 */
import { type Database } from 'sql.js'

import { findCoreExecutable } from './core-binary'
import { queryOne } from './database/sqljs-query'
import { resolveAppRelativePath } from './electron-paths'
import { getProfileRow } from './browser-data'

export function resolveChromeExecutableForProfile(db: Database, profileId: string): string {
  const row = getProfileRow(db, profileId)
  if (!row) {
    throw new Error(`实例不存在: ${profileId}`)
  }

  const coreId = String(row.core_id ?? '').trim()
  let storedPath = ''

  if (coreId) {
    const cr = queryOne<{ core_path: string }>(
      db,
      `SELECT core_path FROM browser_cores WHERE core_id = ?`,
      [coreId],
    )
    storedPath = String(cr?.core_path ?? '').trim()
  }

  if (!storedPath) {
    const def = queryOne<{ core_path: string }>(
      db,
      `SELECT core_path FROM browser_cores WHERE is_default = 1 LIMIT 1`,
    )
    storedPath = String(def?.core_path ?? '').trim()
  }

  if (!storedPath) {
    throw new Error('未配置浏览器内核：请在「内核管理」中添加内核并关联实例或设置默认内核')
  }

  const abs = resolveAppRelativePath(storedPath)
  const hit = findCoreExecutable(abs)
  if (!hit.ok) {
    throw new Error(`内核可执行文件未找到（路径: ${abs}）`)
  }
  return hit.path
}

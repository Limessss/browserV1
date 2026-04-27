/**
 * BookmarkList 解析顺序（对齐 Ant-Browser app_bookmark.go）：SQLite → config.yaml → 内置默认。
 */
import type { Database } from 'sql.js'

import { loadDefaultBookmarksFromYaml } from './app-config-store'
import { listBookmarks } from './browser-data'
import { DEFAULT_BOOKMARKS } from './browser-writes'

export function listBookmarksResolved(db: Database): Array<{ name: string; url: string }> {
  const rows = listBookmarks(db)
  if (rows.length > 0) {
    return rows
  }
  const fromYaml = loadDefaultBookmarksFromYaml()
  if (fromYaml.length > 0) {
    return fromYaml
  }
  return DEFAULT_BOOKMARKS.map((b) => ({ name: b.name, url: b.url }))
}

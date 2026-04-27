/**
 * 数据目录与数据库路径（可与 Ant-Browser Wails 版共用同一 app.db 联调）
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { App } from 'electron'

/** 直接指定 SQLite 文件绝对路径 */
const ENV_DB_PATH = 'ANT_BROWSER_DB_PATH'
/** 指定数据目录（使用其中的 app.db） */
const ENV_DATA_DIR = 'ANT_BROWSER_DATA_DIR'

export function resolveDatabasePath(app: App): string {
  const explicit = process.env[ENV_DB_PATH]?.trim()
  if (explicit) {
    return explicit
  }
  const dataDirEnv = process.env[ENV_DATA_DIR]?.trim()
  if (dataDirEnv) {
    return join(dataDirEnv, 'app.db')
  }
  return join(app.getPath('userData'), 'data', 'app.db')
}

export function ensureDatabaseDir(dbPath: string): void {
  mkdirSync(dirname(dbPath), { recursive: true })
}

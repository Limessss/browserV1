/**
 * sql.js 持久化：与 Ant-Browser 共用 schema，启动时执行版本化迁移。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Database } from 'sql.js'
import type { App } from 'electron'
import { ensureDatabaseDir, resolveDatabasePath } from '../paths'
import { applyMigrations } from './migrations'

let db: Database | null = null
let lastInitError: Error | null = null
let persistedPath = ''

/** 与主库同一 WASM 模块构造，供备份合并打开第二份内存库（sql.js 无法用 ATTACH 挂载磁盘路径） */
let SqlDatabaseCtor: (new (data?: Uint8Array | Buffer) => Database) | null = null

const require = createRequire(import.meta.url)
const initSqlJs = require('sql.js/dist/sql-wasm.js') as (opts: {
  locateFile: (file: string) => string
}) => Promise<{
  Database: new (data?: Uint8Array | Buffer) => Database
}>

function wasmDirectory(): string {
  return dirname(require.resolve('sql.js/dist/sql-wasm.wasm'))
}

function persist(dbConn: Database): void {
  if (!persistedPath) {
    return
  }
  mkdirSync(dirname(persistedPath), { recursive: true })
  writeFileSync(persistedPath, Buffer.from(dbConn.export()))
}

export async function initSqlite(app: App): Promise<void> {
  lastInitError = null
  db = null
  persistedPath = resolveDatabasePath(app)
  ensureDatabaseDir(persistedPath)

  try {
    const SQL = await initSqlJs({
      locateFile: (file: string) => join(wasmDirectory(), file),
    })
    SqlDatabaseCtor = SQL.Database

    let database: Database
    if (existsSync(persistedPath)) {
      const buf = readFileSync(persistedPath)
      database = new SQL.Database(buf)
    } else {
      database = new SQL.Database()
    }

    database.run('PRAGMA foreign_keys = ON')
    applyMigrations(database)
    persist(database)
    db = database
    console.info('[sqlite] opened (sql.js):', persistedPath)
  } catch (e) {
    lastInitError = e instanceof Error ? e : new Error(String(e))
    console.error('[sqlite] init failed:', lastInitError.message, lastInitError.stack)
    db = null
  }
}

export function getSqlite(): Database | null {
  return db
}

/** 必须在 initSqlite 成功之后调用 */
export function openBackupDatabaseBuffer(buf: Uint8Array | Buffer): Database {
  if (!SqlDatabaseCtor) {
    throw new Error('SQLite 尚未初始化，无法打开备份库')
  }
  return new SqlDatabaseCtor(buf)
}

export function getLastSqliteError(): Error | null {
  return lastInitError
}

export function persistSqlite(): void {
  if (db) {
    persist(db)
  }
}

export function closeSqlite(): void {
  if (db) {
    try {
      persist(db)
      db.close()
    } catch {
      /* ignore */
    }
    db = null
  }
}

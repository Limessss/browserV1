/**
 * sql.js 查询封装（占位符仅支持 ? 按顺序绑定）。
 */
import type { Database } from 'sql.js'

/** 与 sql.js BindParams 中的数组形态一致 */
type SqlParam = number | string | Uint8Array | null

export function queryAll<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params?: SqlParam[],
): T[] {
  const stmt = db.prepare(sql)
  try {
    if (params?.length) {
      stmt.bind(params)
    }
    const rows: T[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as T)
    }
    return rows
  } finally {
    stmt.free()
  }
}

export function queryOne<T extends Record<string, unknown>>(
  db: Database,
  sql: string,
  params?: SqlParam[],
): T | undefined {
  return queryAll<T>(db, sql, params)[0]
}

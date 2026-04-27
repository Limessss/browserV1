/**
 * 内核 browser_cores 表写入与扩展信息查询。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'sql.js'
import { queryAll, queryOne } from './database/sqljs-query'
import { persistSqlite } from './database/sqlite-store'

function nowIso(): string {
  return new Date().toISOString()
}

export type CoreInputShape = {
  coreId: string
  coreName: string
  corePath: string
  isDefault: boolean
}

function parseCoreInput(raw: unknown): CoreInputShape {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    coreId: String(o.coreId ?? ''),
    coreName: String(o.coreName ?? ''),
    corePath: String(o.corePath ?? ''),
    isDefault: Boolean(o.isDefault),
  }
}

export function browserCoreSave(db: Database, raw: unknown): void {
  const input = parseCoreInput(raw)
  const coreName = input.coreName.trim()
  const corePath = input.corePath.trim()
  if (!coreName) {
    throw new Error('内核名称不能为空')
  }
  if (!corePath) {
    throw new Error('内核路径不能为空')
  }

  let coreId = input.coreId.trim()
  if (!coreId) {
    coreId = randomUUID()
  }

  const isDef = input.isDefault ? 1 : 0
  const now = nowIso()

  if (input.isDefault) {
    db.run(`UPDATE browser_cores SET is_default = 0`)
  }

  db.run(
    `INSERT INTO browser_cores (core_id, core_name, core_path, is_default, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(core_id) DO UPDATE SET
       core_name  = excluded.core_name,
       core_path  = excluded.core_path,
       is_default = excluded.is_default`,
    [coreId, coreName, corePath, isDef, now],
  )

  persistSqlite()
}

export function browserCoreDelete(db: Database, coreId: string): void {
  const id = coreId.trim()
  if (!id) {
    throw new Error('内核ID不能为空')
  }

  const existing = queryOne<{ is_default: number }>(
    db,
    `SELECT is_default FROM browser_cores WHERE core_id = ?`,
    [id],
  )
  if (!existing) {
    throw new Error(`内核不存在: ${id}`)
  }

  const wasDefault = (existing.is_default ?? 0) === 1

  db.run(`DELETE FROM browser_cores WHERE core_id = ?`, [id])

  if (wasDefault) {
    const first = queryOne<{ core_id: string }>(
      db,
      `SELECT core_id FROM browser_cores ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
    )
    if (first?.core_id) {
      db.run(`UPDATE browser_cores SET is_default = 1 WHERE core_id = ?`, [first.core_id])
    }
  }

  persistSqlite()
}

export function browserCoreSetDefault(db: Database, coreId: string): void {
  const id = coreId.trim()
  if (!id) {
    throw new Error('内核ID不能为空')
  }

  const exists = queryOne<{ core_id: string }>(
    db,
    `SELECT core_id FROM browser_cores WHERE core_id = ?`,
    [id],
  )
  if (!exists) {
    throw new Error(`内核不存在: ${id}`)
  }

  db.run(`UPDATE browser_cores SET is_default = 0`)
  db.run(`UPDATE browser_cores SET is_default = 1 WHERE core_id = ?`, [id])

  persistSqlite()
}

export function browserCoreExtendedInfo(db: Database): Record<string, unknown>[] {
  const cores = queryAll<{ core_id: string }>(
    db,
    `SELECT core_id FROM browser_cores ORDER BY sort_order ASC, created_at ASC`,
  )
  const counts = queryAll<{ core_id: string; c: number }>(
    db,
    `SELECT core_id, COUNT(*) as c FROM browser_profiles GROUP BY core_id`,
  )
  const map = new Map<string, number>()
  for (const x of counts) {
    map.set(x.core_id, x.c ?? 0)
  }

  return cores.map((c) => ({
    coreId: c.core_id,
    chromeVersion: '',
    instanceCount: map.get(c.core_id) ?? 0,
  }))
}

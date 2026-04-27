/**
 * Launch Code：与 Ant-Browser internal/launchcode/service.go 对齐（简化无进程内缓存，直接查库）。
 */
import { randomBytes } from 'node:crypto'
import type { Database } from 'sql.js'
import { queryOne } from './database/sqljs-query'

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const CODE_LEN = 6
const MAX_RETRIES = 10
const CUSTOM_MIN = 4
const CUSTOM_MAX = 32
const CUSTOM_PATTERN = /^[A-Z0-9_-]+$/

function utcSqlDatetime(): string {
  const d = new Date()
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

export function randomLaunchCode(): string {
  const buf = randomBytes(CODE_LEN)
  let s = ''
  for (let i = 0; i < CODE_LEN; i++) {
    s += CHARSET[buf[i]! % CHARSET.length]
  }
  return s
}

export function normalizeLaunchCode(code: string): string {
  return code.trim().toUpperCase()
}

export function validateCustomLaunchCode(code: string): void {
  if (code.length < CUSTOM_MIN || code.length > CUSTOM_MAX) {
    throw new Error(`launch code must be ${CUSTOM_MIN}-${CUSTOM_MAX} characters`)
  }
  if (!CUSTOM_PATTERN.test(code)) {
    throw new Error('launch code format invalid: only A-Z, 0-9, _ and - are allowed')
  }
}

export function ensureLaunchCode(db: Database, profileId: string): string {
  const existing = queryOne<{ code: string }>(
    db,
    `SELECT code FROM launch_codes WHERE profile_id = ?`,
    [profileId],
  )
  if (existing?.code) {
    return existing.code
  }

  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = randomLaunchCode()
    const clash = queryOne<{ c: number }>(
      db,
      `SELECT COUNT(*) as c FROM launch_codes WHERE code = ?`,
      [code],
    )
    if ((clash?.c ?? 0) > 0) {
      continue
    }
    const now = utcSqlDatetime()
    db.run(
      `INSERT INTO launch_codes (profile_id, code, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [profileId, code, now, now],
    )
    return code
  }
  throw new Error(`无法在 ${MAX_RETRIES} 次重试内生成唯一 launch code`)
}

export function deleteLaunchCode(db: Database, profileId: string): void {
  db.run(`DELETE FROM launch_codes WHERE profile_id = ?`, [profileId])
}

export function setLaunchCode(db: Database, profileId: string, rawCode: string): string {
  const code = normalizeLaunchCode(rawCode)
  validateCustomLaunchCode(code)

  const owner = queryOne<{ profile_id: string }>(
    db,
    `SELECT profile_id FROM launch_codes WHERE code = ?`,
    [code],
  )
  if (owner && owner.profile_id !== profileId) {
    throw new Error('launch code already exists')
  }

  const now = utcSqlDatetime()
  db.run(
    `INSERT INTO launch_codes (profile_id, code, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET code = excluded.code, updated_at = excluded.updated_at`,
    [profileId, code, now, now],
  )
  return code
}

export function regenerateLaunchCode(db: Database, profileId: string): string {
  deleteLaunchCode(db, profileId)
  return ensureLaunchCode(db, profileId)
}

export function findProfileIdByCode(db: Database, code: string): string {
  const c = normalizeLaunchCode(code)
  const row = queryOne<{ profile_id: string }>(
    db,
    `SELECT profile_id FROM launch_codes WHERE code = ?`,
    [c],
  )
  if (!row?.profile_id) {
    throw new Error(`launch code not found: ${c}`)
  }
  return row.profile_id
}

/**
 * 实例网站账号凭据：按 profile 存储，供 UI 管理与 CDP 自动填充。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'sql.js'

import { decryptCredentialSecret, encryptCredentialSecret } from './credential-crypto'
import { persistSqlite } from './database/sqlite-store'
import { queryAll, queryOne } from './database/sqljs-query'
import { getProfileRow } from './browser-data'

export type ProfileCredentialRow = {
  credential_id: string
  profile_id: string
  label: string
  site_host: string
  url_pattern: string
  username: string
  password_enc: string
  username_selector: string
  password_selector: string
  auto_submit: number
  enabled: number
  sort_order: number
  created_at: string
  updated_at: string
}

export type ProfileCredentialFrontend = {
  credentialId: string
  profileId: string
  label: string
  siteHost: string
  urlPattern: string
  username: string
  /** 列表/编辑回显用；保存时若为空字符串则保留原密码 */
  password: string
  usernameSelector: string
  passwordSelector: string
  autoSubmit: boolean
  enabled: boolean
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type ProfileCredentialInput = {
  credentialId?: string
  label?: string
  siteHost: string
  urlPattern?: string
  username: string
  password?: string
  usernameSelector?: string
  passwordSelector?: string
  autoSubmit?: boolean
  enabled?: boolean
  sortOrder?: number
}

export type ProfileCredentialMatch = {
  credentialId: string
  username: string
  password: string
  usernameSelector: string
  passwordSelector: string
  autoSubmit: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function rowToFrontend(row: ProfileCredentialRow, includePassword = false): ProfileCredentialFrontend {
  return {
    credentialId: row.credential_id,
    profileId: row.profile_id,
    label: row.label,
    siteHost: row.site_host,
    urlPattern: row.url_pattern,
    username: row.username,
    password: includePassword ? decryptCredentialSecret(row.password_enc) : '********',
    usernameSelector: row.username_selector,
    passwordSelector: row.password_selector,
    autoSubmit: row.auto_submit === 1,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizeHost(host: string): string {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split('/')[0]
    .split(':')[0]
}

/** 域名匹配：精确、子域、*.example.com；支持逗号分隔多个域名 */
function hostMatchesSinglePattern(pattern: string, pageHost: string): boolean {
  const p = normalizeHost(pattern)
  const host = normalizeHost(pageHost)
  if (!p || !host) {
    return false
  }
  if (p.startsWith('*.')) {
    const root = p.slice(2)
    return host === root || host.endsWith('.' + root)
  }
  return host === p || host.endsWith('.' + p)
}

export function hostMatchesCredential(siteHost: string, pageHost: string): boolean {
  const patterns = String(siteHost ?? '')
    .split(/[,，;|\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (patterns.length === 0) {
    return false
  }
  return patterns.some((p) => hostMatchesSinglePattern(p, pageHost))
}

function normalizeSiteHostsInput(host: string): string {
  return String(host ?? '')
    .split(/[,，;|\s]+/)
    .map((s) => normalizeHost(s))
    .filter(Boolean)
    .join(', ')
}

function urlMatchesPattern(urlPattern: string, pageUrl: string): boolean {
  const pat = String(urlPattern ?? '').trim()
  if (!pat) {
    return true
  }
  try {
    const u = new URL(pageUrl)
    const path = `${u.pathname}${u.search}`
    if (pat.includes('*')) {
      const re = new RegExp(
        '^' +
          pat
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*') +
          '$',
        'i',
      )
      return re.test(path) || re.test(pageUrl)
    }
    return path.includes(pat) || pageUrl.includes(pat)
  } catch {
    return pageUrl.includes(pat)
  }
}

export function listProfileCredentials(
  db: Database,
  profileId: string,
): ProfileCredentialFrontend[] {
  const pid = profileId.trim()
  const rows = queryAll<ProfileCredentialRow>(
    db,
    `SELECT credential_id, profile_id, label, site_host, url_pattern, username, password_enc,
            username_selector, password_selector, auto_submit, enabled, sort_order, created_at, updated_at
     FROM browser_profile_credentials
     WHERE profile_id = ?
     ORDER BY sort_order ASC, created_at ASC`,
    [pid],
  )
  return rows.map((r) => rowToFrontend(r, false))
}

export function saveProfileCredential(
  db: Database,
  profileId: string,
  input: ProfileCredentialInput,
): ProfileCredentialFrontend {
  const pid = profileId.trim()
  if (!getProfileRow(db, pid)) {
    throw new Error('profile not found')
  }
  const siteHost = normalizeSiteHostsInput(input.siteHost)
  if (!siteHost) {
    throw new Error('siteHost 不能为空')
  }
  const username = String(input.username ?? '').trim()
  if (!username) {
    throw new Error('username 不能为空')
  }

  const cid = String(input.credentialId ?? '').trim() || randomUUID()
  const existing = queryOne<ProfileCredentialRow>(
    db,
    `SELECT * FROM browser_profile_credentials WHERE credential_id = ? AND profile_id = ?`,
    [cid, pid],
  )

  const passwordPlain = String(input.password ?? '')
  let passwordEnc = existing?.password_enc ?? ''
  if (passwordPlain && passwordPlain !== '********') {
    passwordEnc = encryptCredentialSecret(passwordPlain)
  }
  if (!passwordEnc) {
    throw new Error('password 不能为空')
  }

  const now = nowIso()
  const label = String(input.label ?? '').trim()
  const urlPattern = String(input.urlPattern ?? '').trim()
  const usernameSelector = String(input.usernameSelector ?? '').trim()
  const passwordSelector = String(input.passwordSelector ?? '').trim()
  const autoSubmit = input.autoSubmit ? 1 : 0
  const enabled = input.enabled === false ? 0 : 1
  const sortOrder = Number.isFinite(Number(input.sortOrder)) ? Number(input.sortOrder) : 0

  if (existing) {
    db.run(
      `UPDATE browser_profile_credentials SET
        label = ?, site_host = ?, url_pattern = ?, username = ?, password_enc = ?,
        username_selector = ?, password_selector = ?, auto_submit = ?, enabled = ?,
        sort_order = ?, updated_at = ?
       WHERE credential_id = ? AND profile_id = ?`,
      [
        label,
        siteHost,
        urlPattern,
        username,
        passwordEnc,
        usernameSelector,
        passwordSelector,
        autoSubmit,
        enabled,
        sortOrder,
        now,
        cid,
        pid,
      ],
    )
  } else {
    db.run(
      `INSERT INTO browser_profile_credentials (
        credential_id, profile_id, label, site_host, url_pattern, username, password_enc,
        username_selector, password_selector, auto_submit, enabled, sort_order, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        cid,
        pid,
        label,
        siteHost,
        urlPattern,
        username,
        passwordEnc,
        usernameSelector,
        passwordSelector,
        autoSubmit,
        enabled,
        sortOrder,
        now,
        now,
      ],
    )
  }

  persistSqlite()
  const saved = queryOne<ProfileCredentialRow>(
    db,
    `SELECT credential_id, profile_id, label, site_host, url_pattern, username, password_enc,
            username_selector, password_selector, auto_submit, enabled, sort_order, created_at, updated_at
     FROM browser_profile_credentials WHERE credential_id = ?`,
    [cid],
  )
  if (!saved) {
    throw new Error('保存凭据失败')
  }
  return rowToFrontend(saved, true)
}

export function deleteProfileCredential(
  db: Database,
  profileId: string,
  credentialId: string,
): void {
  const pid = profileId.trim()
  const cid = credentialId.trim()
  db.run(`DELETE FROM browser_profile_credentials WHERE credential_id = ? AND profile_id = ?`, [
    cid,
    pid,
  ])
  persistSqlite()
}

export function deleteAllProfileCredentials(db: Database, profileId: string): void {
  db.run(`DELETE FROM browser_profile_credentials WHERE profile_id = ?`, [profileId.trim()])
  persistSqlite()
}

export function listEnabledCredentialSiteHosts(db: Database, profileId: string): string[] {
  const rows = queryAll<{ site_host: string }>(
    db,
    `SELECT site_host FROM browser_profile_credentials WHERE profile_id = ? AND enabled = 1`,
    [profileId.trim()],
  )
  return rows.map((r) => r.site_host).filter(Boolean)
}

export function matchProfileCredentialForPage(
  db: Database,
  profileId: string,
  pageHost: string,
  pageUrl: string,
): ProfileCredentialMatch | null {
  const pid = profileId.trim()
  const rows = queryAll<ProfileCredentialRow>(
    db,
    `SELECT credential_id, profile_id, label, site_host, url_pattern, username, password_enc,
            username_selector, password_selector, auto_submit, enabled, sort_order, created_at, updated_at
     FROM browser_profile_credentials
     WHERE profile_id = ? AND enabled = 1
     ORDER BY sort_order ASC, created_at ASC`,
    [pid],
  )
  for (const row of rows) {
    if (!hostMatchesCredential(row.site_host, pageHost)) {
      continue
    }
    if (!urlMatchesPattern(row.url_pattern, pageUrl)) {
      continue
    }
    const password = decryptCredentialSecret(row.password_enc)
    if (!password) {
      continue
    }
    return {
      credentialId: row.credential_id,
      username: row.username,
      password,
      usernameSelector: row.username_selector,
      passwordSelector: row.password_selector,
      autoSubmit: row.auto_submit === 1,
    }
  }
  return null
}

/**
 * SQLite 写入：实例 / 分组 / 书签（语义对齐 Ant-Browser Go DAO / Manager）。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'sql.js'
import type { ProfileRow } from './browser-data'
import { getProfileFrontendById, getProfileRow, parseJsonArray } from './browser-data'
import { queryAll, queryOne } from './database/sqljs-query'
import {
  deleteLaunchCode,
  ensureLaunchCode,
  findProfileIdByCode,
  normalizeLaunchCode,
  regenerateLaunchCode,
  setLaunchCode,
} from './launch-code-service'
import { deleteAllProfileCredentials } from './profile-credential-service'
import { persistSqlite } from './database/sqlite-store'
import { defaultBrowserSettings, loadBrowserSettingsMerged } from './app-config-store'

function nowIso(): string {
  return new Date().toISOString()
}

/** sql.js 的 bind 不接受 undefined，库表 NULL 读回后也可能缺失字段 */
function bindSqlText(v: unknown): string {
  if (v === undefined || v === null) {
    return ''
  }
  return typeof v === 'string' ? v : String(v)
}

function jsonArr(arr: string[] | undefined): string {
  return JSON.stringify(arr ?? [])
}

/** IPC / 历史数据可能传入数组或类数组对象；统一为去重后的关键字列表 */
function normalizeKeywordsPayload(raw: unknown): string[] {
  if (raw == null) {
    return []
  }
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x).trim()).filter(Boolean)
  }
  if (typeof raw === 'string') {
    const t = raw.trim()
    if (!t) {
      return []
    }
    try {
      const v = JSON.parse(t) as unknown
      if (Array.isArray(v)) {
        return v.map((x) => String(x).trim()).filter(Boolean)
      }
    } catch {
      return [t]
    }
    return [t]
  }
  if (typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    const keys = Object.keys(o)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => Number(a) - Number(b))
    if (keys.length > 0) {
      return keys.map((k) => String(o[k] ?? '').trim()).filter(Boolean)
    }
  }
  return []
}

export type ProfileInputShape = {
  profileName: string
  userDataDir: string
  coreId: string
  fingerprintArgs: string[]
  proxyId: string
  proxyConfig: string
  launchArgs: string[]
  tags: string[]
  keywords: string[]
  groupId: string
  defaultStartUrls: string[]
}

function parseProfileInput(raw: unknown): ProfileInputShape {
  const o = (raw ?? {}) as Record<string, unknown>
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : [])
  return {
    profileName: String(o.profileName ?? ''),
    userDataDir: String(o.userDataDir ?? ''),
    coreId: String(o.coreId ?? ''),
    fingerprintArgs: strs(o.fingerprintArgs),
    proxyId: String(o.proxyId ?? ''),
    proxyConfig: String(o.proxyConfig ?? ''),
    launchArgs: strs(o.launchArgs),
    tags: strs(o.tags),
    keywords: strs(o.keywords),
    groupId: String(o.groupId ?? ''),
    defaultStartUrls: strs(o.defaultStartUrls),
  }
}

function normalizeDefaultStartURLs(urls: string[]): string[] {
  const out: string[] = []
  for (const u of urls) {
    const x = String(u).trim()
    if (x) {
      out.push(x)
    }
  }
  return out
}

function normalizeCoreId(coreId: string): string {
  return coreId.trim()
}

function getDefaultCoreId(db: Database): string {
  const def = queryOne<{ core_id: string }>(
    db,
    `SELECT core_id FROM browser_cores WHERE is_default = 1 ORDER BY sort_order ASC LIMIT 1`,
  )
  if (def?.core_id) {
    return def.core_id
  }
  const first = queryOne<{ core_id: string }>(
    db,
    `SELECT core_id FROM browser_cores ORDER BY sort_order ASC, created_at ASC LIMIT 1`,
  )
  return first?.core_id ?? ''
}

export function resolveProxyBinding(
  db: Database,
  proxyId: string,
  inputProxyConfig: string,
): Pick<
  ProfileRow,
  | 'proxy_id'
  | 'proxy_config'
  | 'proxy_bind_source_id'
  | 'proxy_bind_source_url'
  | 'proxy_bind_name'
  | 'proxy_bind_updated_at'
> {
  const id = proxyId.trim()
  const trimmedInput = inputProxyConfig.trim()
  if (!id) {
    return {
      proxy_id: '',
      proxy_config: trimmedInput,
      proxy_bind_source_id: '',
      proxy_bind_source_url: '',
      proxy_bind_name: '',
      proxy_bind_updated_at: '',
    }
  }

  const px = queryOne<{
    proxy_id: string
    proxy_config: string
    source_id: string
    source_url: string
    proxy_name: string
  }>(
    db,
    `SELECT proxy_id, proxy_config, COALESCE(source_id,''), COALESCE(source_url,''), proxy_name
     FROM browser_proxies WHERE proxy_id = ?`,
    [id],
  )

  if (!px) {
    return {
      proxy_id: id,
      proxy_config: trimmedInput,
      proxy_bind_source_id: '',
      proxy_bind_source_url: '',
      proxy_bind_name: '',
      proxy_bind_updated_at: '',
    }
  }

  let cfg = String(px.proxy_config ?? '').trim()
  if (!cfg && trimmedInput) {
    cfg = trimmedInput
  }

  return {
    proxy_id: id,
    proxy_config: cfg,
    proxy_bind_source_id: String(px.source_id ?? ''),
    proxy_bind_source_url: String(px.source_url ?? ''),
    proxy_bind_name: String(px.proxy_name ?? ''),
    proxy_bind_updated_at: nowIso(),
  }
}

function clearProxyBinding(): Pick<
  ProfileRow,
  | 'proxy_bind_source_id'
  | 'proxy_bind_source_url'
  | 'proxy_bind_name'
  | 'proxy_bind_updated_at'
> {
  return {
    proxy_bind_source_id: '',
    proxy_bind_source_url: '',
    proxy_bind_name: '',
    proxy_bind_updated_at: nowIso(),
  }
}

export function upsertProfileRow(db: Database, r: ProfileRow): void {
  db.run(
    `INSERT INTO browser_profiles
      (profile_id, profile_name, user_data_dir, core_id, fingerprint_args,
       proxy_id, proxy_config, proxy_bind_source_id, proxy_bind_source_url, proxy_bind_name, proxy_bind_updated_at,
       launch_args, tags, keywords, group_id, default_start_urls, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(profile_id) DO UPDATE SET
       profile_name     = excluded.profile_name,
       user_data_dir    = excluded.user_data_dir,
       core_id          = excluded.core_id,
       fingerprint_args = excluded.fingerprint_args,
       proxy_id         = excluded.proxy_id,
       proxy_config     = excluded.proxy_config,
       proxy_bind_source_id = excluded.proxy_bind_source_id,
       proxy_bind_source_url = excluded.proxy_bind_source_url,
       proxy_bind_name = excluded.proxy_bind_name,
       proxy_bind_updated_at = excluded.proxy_bind_updated_at,
       launch_args      = excluded.launch_args,
       tags             = excluded.tags,
       keywords         = excluded.keywords,
       group_id         = excluded.group_id,
       default_start_urls = excluded.default_start_urls,
       updated_at       = excluded.updated_at`,
    [
      bindSqlText(r.profile_id),
      bindSqlText(r.profile_name),
      bindSqlText(r.user_data_dir),
      bindSqlText(r.core_id),
      bindSqlText(r.fingerprint_args),
      bindSqlText(r.proxy_id),
      bindSqlText(r.proxy_config),
      bindSqlText(r.proxy_bind_source_id),
      bindSqlText(r.proxy_bind_source_url),
      bindSqlText(r.proxy_bind_name),
      bindSqlText(r.proxy_bind_updated_at),
      bindSqlText(r.launch_args),
      bindSqlText(r.tags),
      bindSqlText(r.keywords),
      bindSqlText(r.group_id),
      bindSqlText(r.default_start_urls),
      bindSqlText(r.created_at),
      bindSqlText(r.updated_at),
    ],
  )
}

export function browserProfileCreate(db: Database, rawInput: unknown): Record<string, unknown> {
  const input = parseProfileInput(rawInput)
  const profileId = randomUUID()
  let userDataDir = input.userDataDir.trim()
  if (!userDataDir) {
    userDataDir = profileId
  }

  let coreId = normalizeCoreId(input.coreId)
  if (!coreId) {
    coreId = getDefaultCoreId(db)
  }

  const proxyPart = resolveProxyBinding(db, input.proxyId, input.proxyConfig)

  const now = nowIso()
  const row: ProfileRow = {
    profile_id: profileId,
    profile_name: input.profileName,
    user_data_dir: userDataDir,
    core_id: coreId,
    fingerprint_args: jsonArr(input.fingerprintArgs),
    proxy_id: proxyPart.proxy_id,
    proxy_config: proxyPart.proxy_config,
    proxy_bind_source_id: proxyPart.proxy_bind_source_id,
    proxy_bind_source_url: proxyPart.proxy_bind_source_url,
    proxy_bind_name: proxyPart.proxy_bind_name,
    proxy_bind_updated_at: proxyPart.proxy_bind_updated_at,
    launch_args: jsonArr(input.launchArgs),
    tags: jsonArr(input.tags),
    keywords: jsonArr(input.keywords),
    group_id: input.groupId.trim(),
    default_start_urls: jsonArr(normalizeDefaultStartURLs(input.defaultStartUrls)),
    created_at: now,
    updated_at: now,
  }

  upsertProfileRow(db, row)
  ensureLaunchCode(db, profileId)
  persistSqlite()

  const out = getProfileFrontendById(db, profileId)
  if (!out) {
    throw new Error('创建实例后读取失败')
  }
  return out
}

export function browserProfileUpdate(db: Database, profileId: string, rawInput: unknown): Record<string, unknown> {
  const existing = getProfileRow(db, profileId)
  if (!existing) {
    throw new Error('profile not found')
  }

  const input = parseProfileInput(rawInput)
  let coreId = normalizeCoreId(input.coreId)
  if (!coreId) {
    coreId = getDefaultCoreId(db)
  }

  let proxy_id = ''
  let proxy_config = ''
  let proxy_bind_source_id = ''
  let proxy_bind_source_url = ''
  let proxy_bind_name = ''
  let proxy_bind_updated_at = ''

  if (input.proxyId.trim()) {
    const px = resolveProxyBinding(db, input.proxyId, input.proxyConfig)
    proxy_id = px.proxy_id
    proxy_config = px.proxy_config
    proxy_bind_source_id = px.proxy_bind_source_id
    proxy_bind_source_url = px.proxy_bind_source_url
    proxy_bind_name = px.proxy_bind_name
    proxy_bind_updated_at = px.proxy_bind_updated_at
  } else {
    proxy_id = ''
    proxy_config = input.proxyConfig.trim()
    const cleared = clearProxyBinding()
    proxy_bind_source_id = cleared.proxy_bind_source_id
    proxy_bind_source_url = cleared.proxy_bind_source_url
    proxy_bind_name = cleared.proxy_bind_name
    proxy_bind_updated_at = cleared.proxy_bind_updated_at
  }

  const now = nowIso()
  const row: ProfileRow = {
    profile_id: profileId,
    profile_name: input.profileName,
    user_data_dir: input.userDataDir.trim() || profileId,
    core_id: coreId,
    fingerprint_args: jsonArr(input.fingerprintArgs),
    proxy_id,
    proxy_config,
    proxy_bind_source_id,
    proxy_bind_source_url,
    proxy_bind_name,
    proxy_bind_updated_at,
    launch_args: jsonArr(input.launchArgs),
    tags: jsonArr(input.tags),
    keywords: jsonArr(input.keywords),
    group_id: input.groupId.trim(),
    default_start_urls: jsonArr(normalizeDefaultStartURLs(input.defaultStartUrls)),
    created_at: existing.created_at,
    updated_at: now,
  }

  upsertProfileRow(db, row)
  persistSqlite()

  const out = getProfileFrontendById(db, profileId)
  if (!out) {
    throw new Error('更新实例后读取失败')
  }
  return out
}

export function browserProfileDelete(db: Database, profileId: string): void {
  const existing = getProfileRow(db, profileId)
  if (!existing) {
    throw new Error('profile not found')
  }
  deleteLaunchCode(db, profileId)
  deleteAllProfileCredentials(db, profileId)
  db.run(`DELETE FROM browser_profiles WHERE profile_id = ?`, [profileId])
  persistSqlite()
}

export function browserProfileCopy(db: Database, profileId: string, newName: string): Record<string, unknown> {
  const src = getProfileRow(db, profileId)
  if (!src) {
    throw new Error('profile not found')
  }

  const newId = randomUUID()
  let profileName = newName.trim()
  if (!profileName) {
    profileName = `${src.profile_name} (副本)`
  }

  const now = nowIso()
  const row: ProfileRow = {
    profile_id: newId,
    profile_name: profileName,
    user_data_dir: newId,
    core_id: normalizeCoreId(src.core_id) || getDefaultCoreId(db),
    fingerprint_args: jsonArr(
      (() => {
        try {
          const fp = loadBrowserSettingsMerged().defaultFingerprintArgs
          return Array.isArray(fp) ? fp.map(String) : (defaultBrowserSettings().defaultFingerprintArgs as string[])
        } catch {
          return defaultBrowserSettings().defaultFingerprintArgs as string[]
        }
      })(),
    ),
    proxy_id: src.proxy_id,
    proxy_config: src.proxy_config,
    proxy_bind_source_id: src.proxy_bind_source_id,
    proxy_bind_source_url: src.proxy_bind_source_url,
    proxy_bind_name: src.proxy_bind_name,
    proxy_bind_updated_at: src.proxy_bind_updated_at,
    launch_args: src.launch_args,
    tags: src.tags,
    keywords: src.keywords,
    group_id: src.group_id,
    default_start_urls: src.default_start_urls,
    created_at: now,
    updated_at: now,
  }

  upsertProfileRow(db, row)
  ensureLaunchCode(db, newId)
  persistSqlite()

  const out = getProfileFrontendById(db, newId)
  if (!out) {
    throw new Error('复制实例后读取失败')
  }
  return out
}

export function browserProfileSetKeywords(
  db: Database,
  profileId: string,
  keywords: unknown,
): Record<string, unknown> {
  const id = String(profileId ?? '').trim()
  const existing = getProfileRow(db, id)
  if (!existing) {
    throw new Error('profile not found')
  }
  const kw = normalizeKeywordsPayload(keywords)
  const now = nowIso()
  const row: ProfileRow = {
    ...existing,
    keywords: jsonArr(kw),
    updated_at: now,
  }
  upsertProfileRow(db, row)
  persistSqlite()
  const out = getProfileFrontendById(db, id)
  if (!out) {
    throw new Error('更新关键字后读取失败')
  }
  return out
}

export function browserProfileBatchSetTags(
  db: Database,
  profileIds: unknown,
  tags: unknown,
  replace: unknown,
): void {
  const ids = Array.isArray(profileIds)
    ? profileIds.filter((x) => x != null).map((x) => String(x))
    : []
  const tagList = Array.isArray(tags)
    ? tags.filter((x) => x != null).map((x) => String(x))
    : []
  const rep = Boolean(replace)

  for (const pid of ids) {
    const existing = getProfileRow(db, pid)
    if (!existing) {
      continue
    }
    let nextTags: string[]
    const prev = parseJsonArray(existing.tags)
    if (rep) {
      nextTags = [...tagList]
    } else {
      const seen = new Set(prev)
      nextTags = [...prev]
      for (const t of tagList) {
        if (!seen.has(t)) {
          nextTags.push(t)
          seen.add(t)
        }
      }
    }
    const row: ProfileRow = {
      ...existing,
      tags: jsonArr(nextTags),
      updated_at: nowIso(),
    }
    upsertProfileRow(db, row)
  }
  persistSqlite()
}

export function browserProfileBatchRemoveTags(
  db: Database,
  profileIds: unknown,
  tags: unknown,
): void {
  const ids = Array.isArray(profileIds) ? profileIds.map((x) => String(x)) : []
  const remove = new Set((Array.isArray(tags) ? tags : []).map((x) => String(x)))

  for (const pid of ids) {
    const existing = getProfileRow(db, pid)
    if (!existing) {
      continue
    }
    const prev = parseJsonArray(existing.tags)
    const nextTags = prev.filter((t) => !remove.has(t))
    const row: ProfileRow = {
      ...existing,
      tags: jsonArr(nextTags),
      updated_at: nowIso(),
    }
    upsertProfileRow(db, row)
  }
  persistSqlite()
}

export function browserRenameTag(db: Database, oldName: string, newName: string): void {
  const o = oldName.trim()
  const n = newName.trim()
  if (!o || !n) {
    throw new Error('标签名称不能为空')
  }

  const rows = queryAll<{ profile_id: string; tags: string }>(
    db,
    `SELECT profile_id, tags FROM browser_profiles`,
  )

  for (const r of rows) {
    const prev = parseJsonArray(r.tags)
    let changed = false
    const next = prev.map((t) => {
      if (t.toLowerCase() === o.toLowerCase()) {
        changed = true
        return n
      }
      return t
    })
    if (!changed) {
      continue
    }
    const unique = [...new Set(next)]
    const existing = getProfileRow(db, r.profile_id)
    if (!existing) {
      continue
    }
    upsertProfileRow(db, {
      ...existing,
      tags: jsonArr(unique),
      updated_at: nowIso(),
    })
  }
  persistSqlite()
}

export type GroupInputShape = {
  groupName: string
  parentId: string
  sortOrder: number
}

function parseGroupInput(raw: unknown): GroupInputShape {
  const o = (raw ?? {}) as Record<string, unknown>
  return {
    groupName: String(o.groupName ?? ''),
    parentId: String(o.parentId ?? ''),
    sortOrder: Number(o.sortOrder ?? 0),
  }
}

function getGroupRow(db: Database, groupId: string) {
  return queryOne<{
    group_id: string
    group_name: string
    parent_id: string
    sort_order: number
    created_at: string
    updated_at: string
  }>(db, `SELECT * FROM browser_groups WHERE group_id = ?`, [groupId])
}

function checkCircularReference(db: Database, groupId: string, newParentId: string): void {
  if (newParentId === groupId) {
    throw new Error('不能将分组设为自己的子分组')
  }
  let currentId = newParentId
  const visited = new Set<string>()
  while (currentId) {
    if (visited.has(currentId)) {
      throw new Error('检测到循环引用')
    }
    visited.add(currentId)
    if (currentId === groupId) {
      throw new Error('不能将分组设为自己的后代分组')
    }
    const p = getGroupRow(db, currentId)
    currentId = p?.parent_id?.trim() ?? ''
  }
}

export function createGroup(db: Database, raw: unknown): Record<string, unknown> {
  const input = parseGroupInput(raw)
  if (!input.groupName.trim()) {
    throw new Error('分组名称不能为空')
  }
  if (input.parentId.trim()) {
    const p = getGroupRow(db, input.parentId.trim())
    if (!p) {
      throw new Error(`父分组不存在: ${input.parentId}`)
    }
  }

  const groupId = randomUUID()
  const now = nowIso()
  db.run(
    `INSERT INTO browser_groups (group_id, group_name, parent_id, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [groupId, input.groupName.trim(), input.parentId.trim(), input.sortOrder, now, now],
  )
  persistSqlite()
  return {
    groupId,
    groupName: input.groupName.trim(),
    parentId: input.parentId.trim(),
    sortOrder: input.sortOrder,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateGroup(db: Database, groupId: string, raw: unknown): Record<string, unknown> {
  const input = parseGroupInput(raw)
  if (!input.groupName.trim()) {
    throw new Error('分组名称不能为空')
  }
  const existing = getGroupRow(db, groupId)
  if (!existing) {
    throw new Error('分组不存在')
  }
  if (input.parentId.trim()) {
    const p = getGroupRow(db, input.parentId.trim())
    if (!p) {
      throw new Error(`父分组不存在: ${input.parentId}`)
    }
    checkCircularReference(db, groupId, input.parentId.trim())
  }

  const now = nowIso()
  db.run(
    `UPDATE browser_groups SET group_name = ?, parent_id = ?, sort_order = ?, updated_at = ?
     WHERE group_id = ?`,
    [input.groupName.trim(), input.parentId.trim(), input.sortOrder, now, groupId],
  )
  persistSqlite()
  return {
    groupId,
    groupName: input.groupName.trim(),
    parentId: input.parentId.trim(),
    sortOrder: input.sortOrder,
    createdAt: existing.created_at,
    updatedAt: now,
  }
}

export function deleteGroup(db: Database, groupId: string): void {
  const g = getGroupRow(db, groupId)
  if (!g) {
    throw new Error('分组不存在')
  }
  const parentId = String(g.parent_id ?? '')
  db.run(`UPDATE browser_groups SET parent_id = ? WHERE parent_id = ?`, [parentId, groupId])
  db.run(`UPDATE browser_profiles SET group_id = ? WHERE group_id = ?`, [parentId, groupId])
  db.run(`DELETE FROM browser_groups WHERE group_id = ?`, [groupId])
  persistSqlite()
}

export function moveInstancesToGroup(db: Database, profileIds: unknown, groupId: string): void {
  const ids = Array.isArray(profileIds) ? profileIds.map((x) => String(x)) : []
  const gid = groupId.trim()
  for (const pid of ids) {
    db.run(`UPDATE browser_profiles SET group_id = ?, updated_at = ? WHERE profile_id = ?`, [
      gid,
      nowIso(),
      pid,
    ])
  }
  persistSqlite()
}

export const DEFAULT_BOOKMARKS = [
  { name: 'Google', url: 'https://www.google.com/' },
  { name: 'Gmail', url: 'https://mail.google.com/' },
  { name: 'Claude', url: 'https://claude.ai/' },
  { name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { name: 'YouTube', url: 'https://www.youtube.com/' },
]

export function bookmarkSave(db: Database, raw: unknown): void {
  const items = Array.isArray(raw) ? raw : []
  const valid: Array<{ name: string; url: string }> = []
  for (const it of items) {
    const o = it as Record<string, unknown>
    const name = String(o.name ?? '').trim()
    const url = String(o.url ?? '').trim()
    if (name && url) {
      valid.push({ name, url })
    }
  }

  db.run('BEGIN')
  try {
    db.run(`DELETE FROM browser_bookmarks`)
    valid.forEach((b, i) => {
      db.run(`INSERT INTO browser_bookmarks (name, url, sort_order) VALUES (?, ?, ?)`, [
        b.name,
        b.url,
        i,
      ])
    })
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }
  persistSqlite()
}

export function bookmarkReset(db: Database): void {
  bookmarkSave(db, DEFAULT_BOOKMARKS)
}

export function browserProfileGetCode(db: Database, profileId: string): string {
  return ensureLaunchCode(db, profileId)
}

export function browserProfileSetCode(db: Database, profileId: string, code: string): string {
  return setLaunchCode(db, profileId, code)
}

export function browserProfileRegenerateCode(db: Database, profileId: string): string {
  return regenerateLaunchCode(db, profileId)
}

/** 供后续启动管线使用：按 launch code 解析 profileId */
export function resolveProfileIdByLaunchCode(db: Database, code: string): string {
  return findProfileIdByCode(db, code)
}

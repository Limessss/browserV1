/**
 * 从 SQLite（sql.js）读取浏览器相关列表（与 Ant-Browser Go DAO 语义对齐）。
 */
import type { Database } from 'sql.js'
import { mergeRuntimeIntoProfileRecord, runningInstanceCount } from './browser-runtime-store'
import { queryAll, queryOne } from './database/sqljs-query'

export function parseJsonArray(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') {
    return []
  }
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.map((x) => String(x)) : []
  } catch {
    return []
  }
}

export type ProfileRow = {
  profile_id: string
  profile_name: string
  user_data_dir: string
  core_id: string
  fingerprint_args: string
  proxy_id: string
  proxy_config: string
  proxy_bind_source_id: string
  proxy_bind_source_url: string
  proxy_bind_name: string
  proxy_bind_updated_at: string
  launch_args: string
  tags: string
  keywords: string
  group_id: string
  default_start_urls: string
  created_at: string
  updated_at: string
}

export function getProfileRow(db: Database, profileId: string): ProfileRow | undefined {
  return queryOne<ProfileRow>(
    db,
    `
    SELECT profile_id, profile_name, user_data_dir, core_id,
           fingerprint_args, proxy_id, proxy_config,
           COALESCE(proxy_bind_source_id, ''), COALESCE(proxy_bind_source_url, ''),
           COALESCE(proxy_bind_name, ''), COALESCE(proxy_bind_updated_at, ''),
           launch_args,
           tags, keywords, group_id, default_start_urls, created_at, updated_at
    FROM browser_profiles WHERE profile_id = ?`,
    [profileId],
  )
}

export function getProfileFrontendById(
  db: Database,
  profileId: string,
): Record<string, unknown> | undefined {
  const row = getProfileRow(db, profileId)
  if (!row) {
    return undefined
  }
  const codeRow = queryOne<{ code: string }>(
    db,
    `SELECT code FROM launch_codes WHERE profile_id = ?`,
    [profileId],
  )
  return profileToFrontend(row, codeRow?.code ?? '')
}

export function profileToFrontend(
  r: ProfileRow,
  launchCode: string,
): Record<string, unknown> {
  return {
    profileId: r.profile_id,
    profileName: r.profile_name,
    userDataDir: r.user_data_dir,
    coreId: r.core_id,
    fingerprintArgs: parseJsonArray(r.fingerprint_args),
    proxyId: r.proxy_id,
    proxyConfig: r.proxy_config,
    proxyBindSourceId: r.proxy_bind_source_id,
    proxyBindSourceUrl: r.proxy_bind_source_url,
    proxyBindName: r.proxy_bind_name,
    proxyBindUpdatedAt: r.proxy_bind_updated_at,
    launchArgs: parseJsonArray(r.launch_args),
    tags: parseJsonArray(r.tags),
    keywords: parseJsonArray(r.keywords),
    groupId: r.group_id,
    defaultStartUrls: parseJsonArray(r.default_start_urls),
    launchCode,
    running: false,
    debugPort: 0,
    debugReady: false,
    pid: 0,
    runtimeWarning: '',
    lastError: '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastStartAt: '',
    lastStopAt: '',
  }
}

export function countProfiles(db: Database): number {
  const row = queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM browser_profiles`)
  return Number(row?.c ?? 0) || 0
}

export function listProfiles(db: Database): Record<string, unknown>[] {
  const codeRows = queryAll<{ profile_id: string; code: string }>(
    db,
    `SELECT profile_id, code FROM launch_codes`,
  )
  const codeMap = new Map<string, string>()
  for (const c of codeRows) {
    codeMap.set(c.profile_id, c.code ?? '')
  }

  const rows = queryAll<ProfileRow>(
    db,
    `
    SELECT profile_id, profile_name, user_data_dir, core_id,
           fingerprint_args, proxy_id, proxy_config,
           COALESCE(proxy_bind_source_id, ''), COALESCE(proxy_bind_source_url, ''),
           COALESCE(proxy_bind_name, ''), COALESCE(proxy_bind_updated_at, ''),
           launch_args,
           tags, keywords, group_id, default_start_urls, created_at, updated_at
    FROM browser_profiles ORDER BY created_at ASC`,
  )

  const list = rows.map((r) =>
    profileToFrontend(r, codeMap.get(r.profile_id) ?? ''),
  )
  for (const p of list) {
    mergeRuntimeIntoProfileRecord(p as Record<string, unknown>)
  }
  list.sort((a, b) => String(a.profileId).localeCompare(String(b.profileId)))
  return list
}

export function listProfilesByTag(db: Database, tag: string): Record<string, unknown>[] {
  const t = tag.trim()
  const all = listProfiles(db)
  if (!t) {
    return all
  }
  const lower = t.toLowerCase()
  return all.filter((p) => {
    const tags = p.tags as string[]
    return tags.some((x) => x.toLowerCase() === lower)
  })
}

export function listAllTags(db: Database): string[] {
  const rows = queryAll<{ tags: string }>(
    db,
    `
    SELECT tags FROM browser_profiles`,
  )
  const seen = new Set<string>()
  for (const r of rows) {
    for (const tag of parseJsonArray(r.tags)) {
      const x = tag.trim()
      if (x) {
        seen.add(x)
      }
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

type ProxyRow = {
  proxy_id: string
  proxy_name: string
  proxy_config: string
  dns_servers: string
  group_name: string
  source_id: string
  source_url: string
  source_name_prefix: string
  source_auto_refresh: number
  source_refresh_interval_m: number
  source_last_refresh_at: string
  last_latency_ms: number
  last_test_ok: number
  last_tested_at: string
  last_ip_health_json: string
  sort_order: number
}

function mapProxyRow(r: ProxyRow): Record<string, unknown> {
  return {
    proxyId: r.proxy_id,
    proxyName: r.proxy_name,
    proxyConfig: r.proxy_config,
    dnsServers: r.dns_servers ?? '',
    groupName: r.group_name ?? '',
    sortOrder: r.sort_order ?? 0,
    sourceId: r.source_id ?? '',
    sourceUrl: r.source_url ?? '',
    sourceNamePrefix: r.source_name_prefix ?? '',
    sourceAutoRefresh: (r.source_auto_refresh ?? 0) === 1,
    sourceRefreshIntervalM: r.source_refresh_interval_m ?? 0,
    sourceLastRefreshAt: r.source_last_refresh_at ?? '',
    lastLatencyMs: r.last_latency_ms ?? -1,
    lastTestOk: (r.last_test_ok ?? 0) === 1,
    lastTestedAt: r.last_tested_at ?? '',
    lastIPHealthJson: r.last_ip_health_json ?? '',
  }
}

export function listProxies(db: Database): Record<string, unknown>[] {
  const rows = queryAll<ProxyRow>(
    db,
    `
    SELECT proxy_id, proxy_name, proxy_config, dns_servers, COALESCE(group_name, ''),
           COALESCE(source_id, ''), COALESCE(source_url, ''), COALESCE(source_name_prefix, ''),
           COALESCE(source_auto_refresh, 0), COALESCE(source_refresh_interval_m, 0), COALESCE(source_last_refresh_at, ''),
           COALESCE(last_latency_ms, -1), COALESCE(last_test_ok, 0), COALESCE(last_tested_at, ''),
           COALESCE(last_ip_health_json, ''),
           sort_order
    FROM browser_proxies ORDER BY sort_order ASC, created_at ASC`,
  )
  return rows.map(mapProxyRow)
}

export function listProxiesByGroup(db: Database, groupName: string): Record<string, unknown>[] {
  const rows = queryAll<ProxyRow>(
    db,
    `
    SELECT proxy_id, proxy_name, proxy_config, dns_servers, COALESCE(group_name, ''),
           COALESCE(source_id, ''), COALESCE(source_url, ''), COALESCE(source_name_prefix, ''),
           COALESCE(source_auto_refresh, 0), COALESCE(source_refresh_interval_m, 0), COALESCE(source_last_refresh_at, ''),
           COALESCE(last_latency_ms, -1), COALESCE(last_test_ok, 0), COALESCE(last_tested_at, ''),
           COALESCE(last_ip_health_json, ''),
           sort_order
    FROM browser_proxies WHERE group_name = ?
    ORDER BY sort_order ASC, created_at ASC`,
    [groupName],
  )
  return rows.map(mapProxyRow)
}

export function listProxyGroups(db: Database): string[] {
  const rows = queryAll<{ group_name: string }>(
    db,
    `
    SELECT DISTINCT group_name FROM browser_proxies
    WHERE group_name != '' ORDER BY group_name ASC`,
  )
  return rows.map((r) => r.group_name)
}

type CoreRow = {
  core_id: string
  core_name: string
  core_path: string
  is_default: number
}

export function listCores(db: Database): Record<string, unknown>[] {
  const rows = queryAll<CoreRow>(
    db,
    `
    SELECT core_id, core_name, core_path, is_default
    FROM browser_cores ORDER BY sort_order ASC, created_at ASC`,
  )
  return rows.map((r) => ({
    coreId: r.core_id,
    coreName: r.core_name,
    corePath: r.core_path,
    isDefault: (r.is_default ?? 0) === 1,
  }))
}

type GroupRow = {
  group_id: string
  group_name: string
  parent_id: string
  sort_order: number
  created_at: string
  updated_at: string
}

export function listGroupsWithCount(db: Database): Record<string, unknown>[] {
  const groups = queryAll<GroupRow>(
    db,
    `
    SELECT group_id, group_name, parent_id, sort_order, created_at, updated_at
    FROM browser_groups ORDER BY sort_order ASC, created_at ASC`,
  )

  const profiles = queryAll<{ group_id: string }>(
    db,
    `SELECT group_id FROM browser_profiles`,
  )
  const countMap = new Map<string, number>()
  for (const p of profiles) {
    const gid = p.group_id ?? ''
    if (gid) {
      countMap.set(gid, (countMap.get(gid) ?? 0) + 1)
    }
  }

  return groups.map((g) => ({
    groupId: g.group_id,
    groupName: g.group_name,
    parentId: g.parent_id ?? '',
    sortOrder: g.sort_order ?? 0,
    createdAt: g.created_at,
    updatedAt: g.updated_at,
    instanceCount: countMap.get(g.group_id) ?? 0,
  }))
}

export function listBookmarks(db: Database): Array<{ name: string; url: string }> {
  return queryAll<{ name: string; url: string }>(
    db,
    `
    SELECT name, url FROM browser_bookmarks ORDER BY sort_order ASC, id ASC`,
  )
}

export function getDashboardStats(db: Database, appVersion: string): Record<string, unknown> {
  const pc = queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM browser_profiles`)
  const px = queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM browser_proxies`)
  const cc = queryOne<{ c: number }>(db, `SELECT COUNT(*) as c FROM browser_cores`)
  const memUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  return {
    totalInstances: pc?.c ?? 0,
    runningInstances: runningInstanceCount(),
    proxyCount: px?.c ?? 0,
    coreCount: cc?.c ?? 0,
    memUsedMB,
    appVersion,
  }
}

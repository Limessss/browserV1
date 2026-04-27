/**
 * 代理池批量保存：对齐 Ant-Browser SaveBrowserProxies（DeleteAll + Insert + 内置代理 + 实例绑定同步）。
 */
import { randomUUID } from 'node:crypto'
import type { Database } from 'sql.js'
import type { ProfileRow } from './browser-data'
import { getProfileRow } from './browser-data'
import { queryAll } from './database/sqljs-query'
import { persistSqlite } from './database/sqlite-store'
import { resolveProxyBinding, upsertProfileRow } from './browser-writes'

type NormalizedProxy = {
  proxyId: string
  proxyName: string
  proxyConfig: string
  dnsServers: string
  groupName: string
  sourceId: string
  sourceUrl: string
  sourceNamePrefix: string
  sourceAutoRefresh: boolean
  sourceRefreshIntervalM: number
  sourceLastRefreshAt: string
  sortOrder: number
}

const BUILTIN_PROXIES: NormalizedProxy[] = [
  {
    proxyId: '__direct__',
    proxyName: '直连（不走代理）',
    proxyConfig: 'direct://',
    dnsServers: '',
    groupName: '',
    sourceId: '',
    sourceUrl: '',
    sourceNamePrefix: '',
    sourceAutoRefresh: false,
    sourceRefreshIntervalM: 0,
    sourceLastRefreshAt: '',
    sortOrder: 0,
  },
  {
    proxyId: '__local__',
    proxyName: '本地代理',
    proxyConfig: 'http://127.0.0.1:7890',
    dnsServers: '',
    groupName: '',
    sourceId: '',
    sourceUrl: '',
    sourceNamePrefix: '',
    sourceAutoRefresh: false,
    sourceRefreshIntervalM: 0,
    sourceLastRefreshAt: '',
    sortOrder: 0,
  },
]

function nowIso(): string {
  return new Date().toISOString()
}

function normalizeIncomingProxies(raw: unknown): NormalizedProxy[] {
  const arr = Array.isArray(raw) ? raw : []
  const out: NormalizedProxy[] = []

  for (let i = 0; i < arr.length; i++) {
    const item = arr[i] as Record<string, unknown>
    const proxyName = String(item.proxyName ?? '').trim()
    const proxyConfig = String(item.proxyConfig ?? '').trim()
    if (!proxyName || !proxyConfig) {
      continue
    }

    let proxyId = String(item.proxyId ?? '').trim()
    if (!proxyId) {
      proxyId = randomUUID()
    }

    let sourceURL = String(item.sourceUrl ?? '').trim()
    let sourceID = String(item.sourceId ?? '').trim()
    let sourceNamePrefix = String(item.sourceNamePrefix ?? '').trim()
    let sourceLastRefreshAt = String(item.sourceLastRefreshAt ?? '').trim()
    let sourceRefreshIntervalM = Number(item.sourceRefreshIntervalM ?? 0)
    if (sourceRefreshIntervalM < 0) {
      sourceRefreshIntervalM = 0
    }
    if (sourceRefreshIntervalM > 24 * 60) {
      sourceRefreshIntervalM = 24 * 60
    }

    let sourceAutoRefresh = Boolean(item.sourceAutoRefresh) && sourceURL !== ''
    if (sourceAutoRefresh && sourceRefreshIntervalM <= 0) {
      sourceRefreshIntervalM = 60
    }
    if (!sourceAutoRefresh) {
      sourceRefreshIntervalM = 0
    }
    if (!sourceURL) {
      sourceID = ''
      sourceNamePrefix = ''
      sourceLastRefreshAt = ''
      sourceAutoRefresh = false
      sourceRefreshIntervalM = 0
    }

    out.push({
      proxyId,
      proxyName,
      proxyConfig,
      dnsServers: String(item.dnsServers ?? '').trim(),
      groupName: String(item.groupName ?? '').trim(),
      sourceId: sourceID,
      sourceUrl: sourceURL,
      sourceNamePrefix,
      sourceAutoRefresh,
      sourceRefreshIntervalM,
      sourceLastRefreshAt,
      sortOrder: i,
    })
  }

  for (const b of BUILTIN_PROXIES) {
    const found = out.some((p) => p.proxyId === b.proxyId)
    if (!found) {
      out.unshift({ ...b, sortOrder: out.length })
    }
  }

  return out
}

function insertProxy(db: Database, p: NormalizedProxy, createdAt: string): void {
  const autoRefreshInt = p.sourceAutoRefresh ? 1 : 0
  db.run(
    `INSERT INTO browser_proxies (
      proxy_id, proxy_name, proxy_config, dns_servers, group_name,
      source_id, source_url, source_name_prefix, source_auto_refresh, source_refresh_interval_m, source_last_refresh_at,
      sort_order, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.proxyId,
      p.proxyName,
      p.proxyConfig,
      p.dnsServers,
      p.groupName,
      p.sourceId,
      p.sourceUrl,
      p.sourceNamePrefix,
      autoRefreshInt,
      p.sourceRefreshIntervalM,
      p.sourceLastRefreshAt,
      p.sortOrder,
      createdAt,
    ],
  )
}

/** 保存代理列表后，同步仍指向池中代理的实例之绑定快照 */
export function reconcileProfilesAfterProxySave(db: Database): void {
  const ids = queryAll<{ profile_id: string }>(db, `SELECT profile_id FROM browser_profiles`)
  let changed = false

  for (const { profile_id } of ids) {
    const row = getProfileRow(db, profile_id)
    if (!row?.proxy_id?.trim()) {
      continue
    }

    const px = resolveProxyBinding(db, row.proxy_id, row.proxy_config)
    if (
      row.proxy_config === px.proxy_config &&
      row.proxy_bind_source_id === px.proxy_bind_source_id &&
      row.proxy_bind_source_url === px.proxy_bind_source_url &&
      row.proxy_bind_name === px.proxy_bind_name
    ) {
      continue
    }

    const next: ProfileRow = {
      ...row,
      proxy_config: px.proxy_config,
      proxy_bind_source_id: px.proxy_bind_source_id,
      proxy_bind_source_url: px.proxy_bind_source_url,
      proxy_bind_name: px.proxy_bind_name,
      proxy_bind_updated_at: px.proxy_bind_updated_at,
      updated_at: nowIso(),
    }
    upsertProfileRow(db, next)
    changed = true
  }

  if (changed) {
    persistSqlite()
  }
}

export function saveBrowserProxies(db: Database, raw: unknown): void {
  const normalized = normalizeIncomingProxies(raw)
  const createdAt = nowIso()

  db.run('BEGIN')
  try {
    db.run(`DELETE FROM browser_proxies`)
    insertAllProxies(db, normalized, createdAt)
    db.run('COMMIT')
  } catch (e) {
    db.run('ROLLBACK')
    throw e
  }

  persistSqlite()
  reconcileProfilesAfterProxySave(db)
}

function insertAllProxies(db: Database, list: NormalizedProxy[], createdAt: string): void {
  for (let i = 0; i < list.length; i++) {
    insertProxy(db, { ...list[i], sortOrder: i }, createdAt)
  }
}

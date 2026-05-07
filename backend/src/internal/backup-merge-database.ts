/**
 * 备份包内 SQLite 合并到当前主库。
 * sql.js（WASM）不支持 ATTACH 主机磁盘路径，故将备份文件读入字节后用同一模块构造第二份内存库再合并。
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import type { Database, SqlValue } from 'sql.js'

import { getSqlite, openBackupDatabaseBuffer, persistSqlite } from './database/sqlite-store'

export type MergeDbStats = {
  imported: number
  skipped: number
  conflicts: number
}

function pragmaColumnNamesDb(db: Database, table: string): Set<string> {
  const names = new Set<string>()
  try {
    const esc = table.replace(/'/g, "''")
    const r = db.exec(`PRAGMA table_info('${esc}')`)
    const rows = r[0]?.values
    if (!rows) {
      return names
    }
    for (const row of rows) {
      const n = row[1]
      if (n != null && String(n).trim()) {
        names.add(String(n))
      }
    }
  } catch {
    /* ignore */
  }
  return names
}

/** INSERT INTO ... SELECT ... FROM src.xxx → 可在备份库上执行的 SELECT ... FROM xxx */
function parseInsertAllMerge(insertAllSql: string): { columns: string; selectSql: string } | null {
  const m = insertAllSql.match(
    /INSERT INTO \w+\s*\(([^)]+)\)\s*SELECT\s+([\s\S]+?)\s+FROM\s+src\.(\w+)\s*$/im,
  )
  if (!m) {
    return null
  }
  return {
    columns: m[1].trim(),
    selectSql: `SELECT ${m[2].trim()} FROM ${m[3].trim()}`,
  }
}

function mergeStandardTableSafe(
  mainDb: Database,
  srcDb: Database,
  tableName: string,
): void {
  switch (tableName) {
    case 'browser_groups': {
      const data = srcDb.exec(
        `SELECT group_id, group_name, parent_id, sort_order, created_at, updated_at FROM browser_groups`,
      )
      for (const row of data[0]?.values ?? []) {
        const ex = mainDb.exec(
          `SELECT COUNT(*) as c FROM browser_groups WHERE group_id=? OR (parent_id=? AND lower(group_name)=lower(?))`,
          [row[0], row[2], row[1]],
        )
        if (Number(ex[0]?.values?.[0]?.[0] ?? 0) > 0) {
          continue
        }
        mainDb.run(
          `INSERT INTO browser_groups (group_id, group_name, parent_id, sort_order, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
          row as SqlValue[],
        )
      }
      break
    }
    case 'browser_cores': {
      const data = srcDb.exec(
        `SELECT core_id, core_name, core_path, is_default, sort_order, created_at FROM browser_cores`,
      )
      for (const row of data[0]?.values ?? []) {
        const ex = mainDb.exec(
          `SELECT COUNT(*) as c FROM browser_cores WHERE core_id=? OR lower(core_path)=lower(?)`,
          [row[0], row[2]],
        )
        if (Number(ex[0]?.values?.[0]?.[0] ?? 0) > 0) {
          continue
        }
        mainDb.run(
          `INSERT INTO browser_cores (core_id, core_name, core_path, is_default, sort_order, created_at) VALUES (?,?,?,?,?,?)`,
          row as SqlValue[],
        )
      }
      break
    }
    case 'browser_bookmarks': {
      const data = srcDb.exec(`SELECT name, url, sort_order FROM browser_bookmarks`)
      for (const row of data[0]?.values ?? []) {
        const ex = mainDb.exec(`SELECT COUNT(*) as c FROM browser_bookmarks WHERE lower(url)=lower(?)`, [
          row[1],
        ])
        if (Number(ex[0]?.values?.[0]?.[0] ?? 0) > 0) {
          continue
        }
        mainDb.run(`INSERT INTO browser_bookmarks (name, url, sort_order) VALUES (?,?,?)`, row as SqlValue[])
      }
      break
    }
    case 'launch_codes': {
      const data = srcDb.exec(`SELECT profile_id, code, created_at, updated_at FROM launch_codes`)
      for (const row of data[0]?.values ?? []) {
        const ex = mainDb.exec(`SELECT COUNT(*) as c FROM launch_codes WHERE profile_id=? OR code=?`, [
          row[0],
          row[1],
        ])
        if (Number(ex[0]?.values?.[0]?.[0] ?? 0) > 0) {
          continue
        }
        mainDb.run(
          `INSERT INTO launch_codes (profile_id, code, created_at, updated_at) VALUES (?,?,?,?)`,
          row as SqlValue[],
        )
      }
      break
    }
    default:
      throw new Error(`未实现的合并判重表: ${tableName}`)
  }
}

function mergeOneStandardTable(
  mainDb: Database,
  srcDb: Database,
  item: { name: string; insertAll: string; insertSafe: string },
  resetFirst: boolean,
  stats: MergeDbStats,
): void {
  const chk = srcDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${item.name}'`)
  if (!chk.length || !chk[0].values.length) {
    return
  }

  const total = Number(srcDb.exec(`SELECT COUNT(*) as c FROM ${item.name}`)[0].values[0][0])
  if (total === 0) {
    return
  }

  const before = Number(mainDb.exec(`SELECT COUNT(*) as c FROM ${item.name}`)[0].values[0][0])

  if (resetFirst) {
    const parsed = parseInsertAllMerge(item.insertAll)
    if (!parsed) {
      throw new Error(`无法解析 INSERT SQL(${item.name})`)
    }
    const data = srcDb.exec(parsed.selectSql)
    if (!data.length || !data[0].values?.length) {
      return
    }
    const colCount = data[0].values[0].length
    const ph = new Array(colCount).fill('?').join(',')
    const ins = `INSERT INTO ${item.name} (${parsed.columns}) VALUES (${ph})`
    for (const row of data[0].values) {
      mainDb.run(ins, row as SqlValue[])
    }
  } else {
    mergeStandardTableSafe(mainDb, srcDb, item.name)
  }

  const after = Number(mainDb.exec(`SELECT COUNT(*) as c FROM ${item.name}`)[0].values[0][0])
  const inserted = Math.max(0, after - before)
  stats.imported += inserted
  if (!resetFirst) {
    stats.skipped += Math.max(0, total - inserted)
  }
}

function mergeBrowserProxiesFromBackup(
  mainDb: Database,
  srcDb: Database,
  resetFirst: boolean,
  stats: MergeDbStats,
): void {
  const chk = srcDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='browser_proxies'`)
  if (!chk.length || !chk[0].values.length) {
    return
  }

  const cols = pragmaColumnNamesDb(srcDb, 'browser_proxies')
  if (!cols.has('proxy_id')) {
    return
  }

  const pa = (col: string, sqlFallback: string): string =>
    cols.has(col) ? `COALESCE(${col},${sqlFallback})` : sqlFallback

  const selectSql = `SELECT proxy_id, proxy_name, proxy_config, ${cols.has('dns_servers') ? 'dns_servers' : "''"},
${pa('group_name', "''")},
${pa('source_id', "''")},
${pa('source_url', "''")},
${pa('source_name_prefix', "''")},
${pa('source_auto_refresh', '0')},
${pa('source_refresh_interval_m', '0')},
${pa('source_last_refresh_at', "''")},
${pa('last_latency_ms', '-1')},
${pa('last_test_ok', '0')},
${pa('last_tested_at', "''")},
${pa('last_ip_health_json', "''")},
sort_order, created_at
FROM browser_proxies`

  let res: ReturnType<Database['exec']>
  try {
    res = srcDb.exec(selectSql)
  } catch (e) {
    throw new Error(`读取备份代理表失败: ${e instanceof Error ? e.message : e}`)
  }
  if (!res.length || !res[0].values?.length) {
    return
  }

  const rows = res[0].values
  const total = rows.length
  const before = Number(mainDb.exec(`SELECT COUNT(*) as c FROM browser_proxies`)[0]?.values?.[0]?.[0] ?? 0)

  const insertSql = `INSERT INTO browser_proxies (proxy_id, proxy_name, proxy_config, dns_servers, group_name, source_id, source_url, source_name_prefix, source_auto_refresh, source_refresh_interval_m, source_last_refresh_at, last_latency_ms, last_test_ok, last_tested_at, last_ip_health_json, sort_order, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

  for (const row of rows) {
    const r = row as unknown[]
    if (!resetFirst) {
      const dup = mainDb.exec(
        `SELECT COUNT(*) as c FROM browser_proxies WHERE proxy_id=? OR lower(proxy_config)=lower(?)`,
        [r[0] as SqlValue, r[2] as SqlValue],
      )
      if (Number(dup[0]?.values?.[0]?.[0] ?? 0) > 0) {
        continue
      }
    }
    mainDb.run(insertSql, r as SqlValue[])
  }

  const after = Number(mainDb.exec(`SELECT COUNT(*) as c FROM browser_proxies`)[0]?.values?.[0]?.[0] ?? 0)
  const inserted = Math.max(0, after - before)
  stats.imported += inserted
  if (!resetFirst) {
    stats.skipped += Math.max(0, total - inserted)
  }
}

function mergeBrowserProfilesFromBackup(
  mainDb: Database,
  srcDb: Database,
  resetFirst: boolean,
  stats: MergeDbStats,
): void {
  const chk = srcDb.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='browser_profiles'`)
  if (!chk.length || !chk[0].values.length) {
    return
  }

  const totalSrc = Number(srcDb.exec(`SELECT COUNT(*) as c FROM browser_profiles`)[0].values[0][0])
  if (totalSrc === 0) {
    return
  }

  const srcCols = pragmaColumnNamesDb(srcDb, 'browser_profiles')
  const hasBind = srcCols.has('proxy_bind_source_id')

  const before = Number(mainDb.exec(`SELECT COUNT(*) as c FROM browser_profiles`)[0].values[0][0])

  const selectFull = `SELECT profile_id, profile_name, user_data_dir, core_id, fingerprint_args, proxy_id, proxy_config,
COALESCE(proxy_bind_source_id,''), COALESCE(proxy_bind_source_url,''), COALESCE(proxy_bind_name,''), COALESCE(proxy_bind_updated_at,''),
launch_args, tags, keywords, COALESCE(group_id,''), COALESCE(default_start_urls,'[]'), created_at, updated_at FROM browser_profiles`

  const selectLegacy = `SELECT profile_id, profile_name, user_data_dir, core_id, fingerprint_args, proxy_id, proxy_config, '', '', '', '',
launch_args, tags, keywords, COALESCE(group_id,''), COALESCE(default_start_urls,'[]'), created_at, updated_at FROM browser_profiles`

  const insertSql = `INSERT INTO browser_profiles (profile_id, profile_name, user_data_dir, core_id, fingerprint_args, proxy_id, proxy_config, proxy_bind_source_id, proxy_bind_source_url, proxy_bind_name, proxy_bind_updated_at, launch_args, tags, keywords, group_id, default_start_urls, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`

  let rows: ReturnType<Database['exec']>
  try {
    rows = srcDb.exec(hasBind ? selectFull : selectLegacy)
  } catch (e) {
    if (hasBind) {
      rows = srcDb.exec(selectLegacy)
    } else {
      throw new Error(`读取备份实例表失败: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (!rows.length || !rows[0].values?.length) {
    return
  }

  for (const row of rows[0].values) {
    const r = row as unknown[]
    if (!resetFirst) {
      const dup = mainDb.exec(
        `SELECT COUNT(*) as c FROM browser_profiles WHERE profile_id=? OR lower(user_data_dir)=lower(?)`,
        [r[0] as SqlValue, r[2] as SqlValue],
      )
      if (Number(dup[0]?.values?.[0]?.[0] ?? 0) > 0) {
        continue
      }
    }
    mainDb.run(insertSql, r as SqlValue[])
  }

  const after = Number(mainDb.exec(`SELECT COUNT(*) as c FROM browser_profiles`)[0].values[0][0])
  const inserted = Math.max(0, after - before)
  stats.imported += inserted
  if (!resetFirst) {
    stats.skipped += Math.max(0, totalSrc - inserted)
  }
}

/**
 * 将 app.db 与同目录 -wal/-shm 复制到短路径临时目录（便于 WAL 一致），再读入内存合并。
 */
function prepareAttachedSqlitePath(absDbPath: string): {
  attachPath: string
  cleanup: () => void
} {
  const normalized = resolve(absDbPath)
  if (!existsSync(normalized) || !statSync(normalized).isFile()) {
    throw new Error(`不是有效的数据库文件: ${normalized}`)
  }
  const srcDir = dirname(normalized)
  const baseFile = basename(normalized)
  const tmpRoot = mkdtempSync(join(tmpdir(), 'ant-sql-'))
  const sidecars = ['', '-wal', '-shm']
  let copiedMain = false
  for (const suf of sidecars) {
    const name = suf === '' ? baseFile : `${baseFile}${suf}`
    const from = join(srcDir, name)
    if (existsSync(from) && statSync(from).isFile()) {
      copyFileSync(from, join(tmpRoot, name))
      if (suf === '') {
        copiedMain = true
      }
    }
  }
  if (!copiedMain) {
    try {
      rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw new Error(`未复制到主库文件: ${normalized}`)
  }
  const attachAbs = join(tmpRoot, baseFile)
  return {
    attachPath: attachAbs,
    cleanup: () => {
      try {
        rmSync(tmpRoot, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    },
  }
}

export function runMergeDatabase(srcDBPath: string, resetFirst: boolean, stats: MergeDbStats): void {
  const mainDb = getSqlite()
  if (!mainDb) {
    throw new Error('数据库未初始化')
  }

  const resolvedSrc = resolve(srcDBPath)
  let cleanupFiles: (() => void) | undefined
  let srcDb: Database | null = null

  try {
    const prep = prepareAttachedSqlitePath(resolvedSrc)
    cleanupFiles = prep.cleanup
    const buf = readFileSync(prep.attachPath)
    srcDb = openBackupDatabaseBuffer(Buffer.from(buf))
  } catch (e) {
    cleanupFiles?.()
    throw new Error(`打开备份数据库失败: ${resolvedSrc} — ${e instanceof Error ? e.message : e}`)
  }

  const tableDefsBeforeProfiles: { name: string; insertAll: string; insertSafe: string }[] = [
    {
      name: 'browser_groups',
      insertAll: `INSERT INTO browser_groups (group_id, group_name, parent_id, sort_order, created_at, updated_at)
SELECT group_id, group_name, parent_id, sort_order, created_at, updated_at FROM src.browser_groups`,
      insertSafe: `INSERT INTO browser_groups (group_id, group_name, parent_id, sort_order, created_at, updated_at)
SELECT s.group_id, s.group_name, s.parent_id, s.sort_order, s.created_at, s.updated_at
FROM src.browser_groups s
WHERE NOT EXISTS (
  SELECT 1 FROM browser_groups t
  WHERE t.group_id = s.group_id OR (t.parent_id = s.parent_id AND lower(t.group_name) = lower(s.group_name))
)`,
    },
    {
      name: 'browser_cores',
      insertAll: `INSERT INTO browser_cores (core_id, core_name, core_path, is_default, sort_order, created_at)
SELECT core_id, core_name, core_path, is_default, sort_order, created_at FROM src.browser_cores`,
      insertSafe: `INSERT INTO browser_cores (core_id, core_name, core_path, is_default, sort_order, created_at)
SELECT s.core_id, s.core_name, s.core_path, s.is_default, s.sort_order, s.created_at
FROM src.browser_cores s
WHERE NOT EXISTS (
  SELECT 1 FROM browser_cores t
  WHERE t.core_id = s.core_id OR lower(t.core_path) = lower(s.core_path)
)`,
    },
  ]

  const tableDefsAfterProfiles: { name: string; insertAll: string; insertSafe: string }[] = [
    {
      name: 'browser_bookmarks',
      insertAll: `INSERT INTO browser_bookmarks (name, url, sort_order)
SELECT name, url, sort_order FROM src.browser_bookmarks`,
      insertSafe: `INSERT INTO browser_bookmarks (name, url, sort_order)
SELECT s.name, s.url, s.sort_order
FROM src.browser_bookmarks s
WHERE NOT EXISTS (
  SELECT 1 FROM browser_bookmarks t WHERE lower(t.url) = lower(s.url)
)`,
    },
    {
      name: 'launch_codes',
      insertAll: `INSERT INTO launch_codes (profile_id, code, created_at, updated_at)
SELECT profile_id, code, created_at, updated_at FROM src.launch_codes`,
      insertSafe: `INSERT INTO launch_codes (profile_id, code, created_at, updated_at)
SELECT s.profile_id, s.code, s.created_at, s.updated_at
FROM src.launch_codes s
WHERE NOT EXISTS (
  SELECT 1 FROM launch_codes t
  WHERE t.profile_id = s.profile_id OR t.code = s.code
)`,
    },
  ]

  try {
    for (const item of tableDefsBeforeProfiles) {
      try {
        mergeOneStandardTable(mainDb, srcDb, item, resetFirst, stats)
      } catch (e) {
        throw new Error(`导入数据表失败(${item.name}): ${e instanceof Error ? e.message : e}`)
      }
    }
    mergeBrowserProxiesFromBackup(mainDb, srcDb, resetFirst, stats)
    mergeBrowserProfilesFromBackup(mainDb, srcDb, resetFirst, stats)
    for (const item of tableDefsAfterProfiles) {
      try {
        mergeOneStandardTable(mainDb, srcDb, item, resetFirst, stats)
      } catch (e) {
        throw new Error(`导入数据表失败(${item.name}): ${e instanceof Error ? e.message : e}`)
      }
    }
  } finally {
    try {
      srcDb?.close()
    } catch {
      /* ignore */
    }
    cleanupFiles?.()
    persistSqlite()
  }
}

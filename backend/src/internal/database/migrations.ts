/**
 * 与 Ant-Browser Go 版 internal/database/sqlite.go 保持版本与语句一致（只追加版本，勿改历史）。
 */
import type { Database } from 'sql.js'

export type Migration = {
  version: number
  desc: string
  stmts: string[]
}

export const migrations: Migration[] = [
  {
    version: 1,
    desc: '初始化核心表结构',
    stmts: [
      `CREATE TABLE IF NOT EXISTS launch_codes (
				profile_id TEXT PRIMARY KEY,
				code       TEXT NOT NULL UNIQUE,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_launch_codes_code ON launch_codes(code)`,

      `CREATE TABLE IF NOT EXISTS browser_profiles (
				profile_id       TEXT PRIMARY KEY,
				profile_name     TEXT NOT NULL,
				user_data_dir    TEXT NOT NULL DEFAULT '',
				core_id          TEXT NOT NULL DEFAULT '',
				fingerprint_args TEXT NOT NULL DEFAULT '[]',
				proxy_id         TEXT NOT NULL DEFAULT '',
				proxy_config     TEXT NOT NULL DEFAULT '',
				launch_args      TEXT NOT NULL DEFAULT '[]',
				tags             TEXT NOT NULL DEFAULT '[]',
				keywords         TEXT NOT NULL DEFAULT '[]',
				created_at       DATETIME NOT NULL,
				updated_at       DATETIME NOT NULL
			)`,
      `CREATE INDEX IF NOT EXISTS idx_browser_profiles_created_at ON browser_profiles(created_at)`,

      `CREATE TABLE IF NOT EXISTS browser_proxies (
				proxy_id     TEXT PRIMARY KEY,
				proxy_name   TEXT NOT NULL,
				proxy_config TEXT NOT NULL,
				dns_servers  TEXT NOT NULL DEFAULT '',
				sort_order   INTEGER NOT NULL DEFAULT 0,
				created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,

      `CREATE TABLE IF NOT EXISTS browser_cores (
				core_id    TEXT PRIMARY KEY,
				core_name  TEXT NOT NULL,
				core_path  TEXT NOT NULL,
				is_default INTEGER NOT NULL DEFAULT 0,
				sort_order INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,

      `CREATE TABLE IF NOT EXISTS browser_bookmarks (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				name       TEXT NOT NULL,
				url        TEXT NOT NULL UNIQUE,
				sort_order INTEGER NOT NULL DEFAULT 0
			)`,
    ],
  },
  {
    version: 2,
    desc: '添加实例分组支持',
    stmts: [
      `CREATE TABLE IF NOT EXISTS browser_groups (
				group_id   TEXT PRIMARY KEY,
				group_name TEXT NOT NULL,
				parent_id  TEXT DEFAULT '',
				sort_order INTEGER NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
				updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
			)`,
      `CREATE INDEX IF NOT EXISTS idx_browser_groups_parent_id ON browser_groups(parent_id)`,
      `ALTER TABLE browser_profiles ADD COLUMN group_id TEXT DEFAULT ''`,
    ],
  },
  {
    version: 3,
    desc: '代理表添加分组和测速字段',
    stmts: [
      `ALTER TABLE browser_proxies ADD COLUMN group_name TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_proxies ADD COLUMN last_latency_ms INTEGER NOT NULL DEFAULT -1`,
      `ALTER TABLE browser_proxies ADD COLUMN last_test_ok INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE browser_proxies ADD COLUMN last_tested_at TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 4,
    desc: '代理表添加 IP 健康结果字段',
    stmts: [`ALTER TABLE browser_proxies ADD COLUMN last_ip_health_json TEXT NOT NULL DEFAULT ''`],
  },
  {
    version: 5,
    desc: '代理表添加 URL 来源与自动刷新字段',
    stmts: [
      `ALTER TABLE browser_proxies ADD COLUMN source_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_proxies ADD COLUMN source_url TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_proxies ADD COLUMN source_name_prefix TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_proxies ADD COLUMN source_auto_refresh INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE browser_proxies ADD COLUMN source_refresh_interval_m INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE browser_proxies ADD COLUMN source_last_refresh_at TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 6,
    desc: '实例表添加代理绑定快照字段',
    stmts: [
      `ALTER TABLE browser_profiles ADD COLUMN proxy_bind_source_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_profiles ADD COLUMN proxy_bind_source_url TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_profiles ADD COLUMN proxy_bind_name TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE browser_profiles ADD COLUMN proxy_bind_updated_at TEXT NOT NULL DEFAULT ''`,
    ],
  },
  {
    version: 7,
    desc: '实例表添加默认启动网址（JSON 数组）',
    stmts: [`ALTER TABLE browser_profiles ADD COLUMN default_start_urls TEXT NOT NULL DEFAULT '[]'`],
  },
]

function isDuplicateColumnError(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err)
  return s.includes('duplicate column') || s.includes('already exists')
}

export function applyMigrations(db: Database): void {
  db.run(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    INTEGER PRIMARY KEY,
			desc       TEXT NOT NULL DEFAULT '',
			applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`)

  const row = queryMaxVersion(db)
  const currentVersion = row?.v ?? 0

  for (const m of migrations) {
    if (m.version <= currentVersion) {
      continue
    }
    db.run('BEGIN')
    try {
      for (const stmt of m.stmts) {
        try {
          db.run(stmt)
        } catch (e) {
          if (!isDuplicateColumnError(e)) {
            throw e
          }
        }
      }
      db.run('INSERT INTO schema_migrations (version, desc) VALUES (?, ?)', [m.version, m.desc])
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      throw e
    }
  }
}

function queryMaxVersion(db: Database): { v: number } | undefined {
  const stmt = db.prepare(`SELECT COALESCE(MAX(version), 0) as v FROM schema_migrations`)
  try {
    if (!stmt.step()) {
      return undefined
    }
    return stmt.getAsObject() as { v: number }
  } finally {
    stmt.free()
  }
}

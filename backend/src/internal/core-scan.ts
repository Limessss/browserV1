/**
 * 扫描应用根下 chrome/ 子目录，将包含有效浏览器可执行文件的目录注册为内核。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Database } from 'sql.js'

import { getUserDataRoot } from './apppath'
import { listCores } from './browser-data'
import { queryAll } from './database/sqljs-query'
import { validateCorePath } from './core-validate'
import { browserCoreSave } from './core-writes'
import { resolveAppRelativePath, resolveCoreStoredPath } from './electron-paths'

function normalizeKey(abs: string): string {
  return resolve(abs).replace(/\\/g, '/').toLowerCase()
}

/**
 * 扫描 `chrome/<子目录>/`，跳过已在库中（同一路径）的内核。
 * 若库此前为空，第一个成功注册的内核设为默认。
 */
export function browserCoreScanDisk(db: Database): Record<string, unknown>[] {
  const chromeUser = join(getUserDataRoot(), 'chrome')
  const chromeExe = resolveAppRelativePath('chrome')
  /** 优先 userData（持久化下载目录），再安装目录旁 chrome */
  const dirByName = new Map<string, string>()
  for (const chromeRoot of [chromeUser, chromeExe]) {
    if (!existsSync(chromeRoot)) {
      continue
    }
    let sub: string[]
    try {
      sub = readdirSync(chromeRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => String(d.name))
    } catch {
      continue
    }
    for (const name of sub) {
      if (!dirByName.has(name)) {
        dirByName.set(name, join(chromeRoot, name))
      }
    }
  }

  if (dirByName.size === 0) {
    return listCores(db)
  }

  const pathRows = queryAll<{ core_path: string }>(db, `SELECT core_path FROM browser_cores`)
  const seenAbs = new Set<string>()
  for (const row of pathRows) {
    try {
      seenAbs.add(normalizeKey(resolveCoreStoredPath(row.core_path)))
    } catch {
      /* ignore */
    }
  }

  const initialCount = pathRows.length
  let firstNew = initialCount === 0

  const names = Array.from(dirByName.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'))

  for (const name of names) {
    const fullDir = dirByName.get(name)
    if (!fullDir) {
      continue
    }
    const relForDb = join('chrome', name)
    const v = validateCorePath(fullDir)
    if (!v.valid) {
      continue
    }
    const key = normalizeKey(fullDir)
    if (seenAbs.has(key)) {
      continue
    }
    seenAbs.add(key)

    browserCoreSave(db, {
      coreId: '',
      coreName: name,
      corePath: relForDb,
      isDefault: firstNew,
    })
    firstNew = false
  }

  return listCores(db)
}

/**
 * Chromium Default/Bookmarks 合并默认项（对齐 Ant-Browser internal/browser/bookmarks.go）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type BrowserBookmarkInput = { name: string; url: string }

const CHROMIUM_EPOCH_MS = Date.UTC(1601, 0, 1, 0, 0, 0, 0)

function toChromiumTime(d: Date): string {
  const deltaUs = Math.floor((d.getTime() - CHROMIUM_EPOCH_MS) * 1000)
  return String(deltaUs)
}

const FNV_OFFSET = 146959810393466560n
const FNV_PRIME = 1099511628211n
const U64_MASK = (1n << 64n) - 1n

/** 与 Go `for _, c := range str`（按 rune）一致 */
function utfRunes(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; ) {
    const cp = s.codePointAt(i)!
    out.push(cp)
    i += cp > 0xffff ? 2 : 1
  }
  return out
}

function fnvUint64(url: string): bigint {
  let h = FNV_OFFSET
  for (const c of utfRunes(url)) {
    h ^= BigInt(c)
    h = (h * FNV_PRIME) & U64_MASK
  }
  return h & U64_MASK
}

/** 对齐 Go bookmarkGUID（uint64 FNV-1a 风格） */
export function bookmarkGUID(url: string): string {
  const h = fnvUint64(url)
  const p1 = Number(h & 0xffffffffn)
  const p2 = Number((h >> 32n) & 0xffffn)
  const p3 = Number(((h >> 48n) & 0x0fffn) | 0x4000n)
  const p4 = Number(((h >> 16n) & 0x3fffn) | 0x8000n)
  const p5 = h & 0xffffffffffffn
  const last = p5.toString(16).padStart(12, '0')
  return `${p1.toString(16).padStart(8, '0')}-${p2.toString(16).padStart(4, '0')}-${p3.toString(16).padStart(4, '0')}-${p4.toString(16).padStart(4, '0')}-${last}`
}

function newEmptyBookmarkRoot(now: string): Record<string, unknown> {
  return {
    checksum: '',
    version: 1,
    roots: {
      bookmark_bar: {
        children: [],
        date_added: now,
        date_last_used: '0',
        date_modified: now,
        guid: '0bc5d13f-2cba-5d74-951f-3f233fe6c908',
        id: '1',
        name: '书签栏',
        type: 'folder',
      },
      other: {
        children: [],
        date_added: now,
        date_last_used: '0',
        date_modified: '0',
        guid: '82b081ec-3dd3-529c-8475-ab6c344590dd',
        id: '2',
        name: '其他书签',
        type: 'folder',
      },
      synced: {
        children: [],
        date_added: now,
        date_last_used: '0',
        date_modified: '0',
        guid: '4cf2e351-0e85-532b-bb37-df045d8f8d0f',
        id: '3',
        name: '移动设备书签',
        type: 'folder',
      },
    },
  }
}

function collectURLs(nodes: unknown[], out: Record<string, boolean>): void {
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    const node = n as Record<string, unknown>
    if (node.type === 'url') {
      const u = node.url
      if (typeof u === 'string' && u) {
        out[u] = true
      }
    } else if (node.type === 'folder' && Array.isArray(node.children)) {
      collectURLs(node.children as unknown[], out)
    }
  }
}

function extractBarChildren(root: Record<string, unknown>): {
  children: unknown[]
  existingURLs: Record<string, boolean>
} {
  const existing: Record<string, boolean> = {}
  let roots = root.roots as Record<string, unknown> | undefined
  if (!roots || typeof roots !== 'object') {
    root.roots = {
      bookmark_bar: {
        children: [],
        type: 'folder',
        name: '书签栏',
      },
    }
    return { children: [], existingURLs: existing }
  }

  let bar = roots.bookmark_bar as Record<string, unknown> | undefined
  if (!bar || typeof bar !== 'object') {
    roots.bookmark_bar = {
      children: [],
      type: 'folder',
      name: '书签栏',
    }
    root.roots = roots
    return { children: [], existingURLs: existing }
  }

  const children = Array.isArray(bar.children) ? ([...bar.children] as unknown[]) : []
  collectURLs(children, existing)
  return { children, existingURLs: existing }
}

function scanMaxId(node: Record<string, unknown>, max: { v: number }): void {
  const idStr = node.id
  if (typeof idStr === 'string') {
    const n = parseInt(idStr, 10)
    if (!Number.isNaN(n) && n > max.v) {
      max.v = n
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (c && typeof c === 'object') {
        scanMaxId(c as Record<string, unknown>, max)
      }
    }
  }
}

function findMaxId(root: Record<string, unknown>): number {
  const max = { v: 0 }
  const roots = root.roots as Record<string, unknown> | undefined
  if (!roots) {
    return 0
  }
  for (const v of Object.values(roots)) {
    if (v && typeof v === 'object') {
      scanMaxId(v as Record<string, unknown>, max)
    }
  }
  return max.v
}

/**
 * 将默认书签合并到用户数据目录下 Chromium `Default/Bookmarks`（已存在的 URL 不重复）。
 */
export function ensureDefaultBookmarks(userDataDir: string, bookmarks: BrowserBookmarkInput[]): void {
  if (!bookmarks.length) {
    return
  }

  const profileDir = join(userDataDir, 'Default')
  mkdirSync(profileDir, { recursive: true })
  const bookmarksPath = join(profileDir, 'Bookmarks')

  let root: Record<string, unknown> | null = null
  try {
    const data = readFileSync(bookmarksPath, 'utf8')
    const parsed = JSON.parse(data) as unknown
    if (parsed && typeof parsed === 'object') {
      root = parsed as Record<string, unknown>
    }
  } catch {
    root = null
  }

  const now = toChromiumTime(new Date())

  if (!root) {
    root = newEmptyBookmarkRoot(now)
  }

  let { children: barChildren, existingURLs } = extractBarChildren(root)
  let maxId = findMaxId(root)

  for (const b of bookmarks) {
    const url = String(b.url ?? '').trim()
    const name = String(b.name ?? '').trim()
    if (!url || !name) {
      continue
    }
    if (existingURLs[url]) {
      continue
    }
    maxId += 1
    barChildren.push({
      date_added: now,
      date_last_used: '0',
      guid: bookmarkGUID(url),
      id: String(maxId),
      meta_info: { power_bookmark_meta: '' },
      name,
      type: 'url',
      url,
    })
  }

  const roots = root.roots as Record<string, unknown>
  const bar = roots.bookmark_bar as Record<string, unknown>
  bar.children = barChildren
  bar.date_modified = now
  roots.bookmark_bar = bar
  root.roots = roots

  writeFileSync(bookmarksPath, `${JSON.stringify(root, null, 3)}\n`, 'utf8')
}

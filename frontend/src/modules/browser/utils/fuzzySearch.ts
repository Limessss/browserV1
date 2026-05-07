/**
 * 列表模糊搜索：忽略大小写；支持连续子串命中，或字符按顺序分散命中（便于缩写检索）。
 */
export function normalizeSearchText(s: string): string {
  return s.trim().toLowerCase()
}

export function fuzzyMatch(haystack: string, query: string): boolean {
  const q = normalizeSearchText(query)
  if (!q) return true
  const h = normalizeSearchText(haystack)
  if (!h) return false
  if (h.includes(q)) return true
  let hi = 0
  for (let i = 0; i < q.length; i++) {
    const c = q[i]
    let found = false
    while (hi < h.length) {
      if (h[hi++] === c) {
        found = true
        break
      }
    }
    if (!found) return false
  }
  return true
}

/** 任一关键字条目命中即视为匹配 */
export function fuzzyMatchAnyKeyword(keywords: string[] | undefined, query: string): boolean {
  const q = normalizeSearchText(query)
  if (!q) return true
  const list = Array.isArray(keywords) ? keywords : []
  return list.some((kw) => fuzzyMatch(String(kw), q))
}

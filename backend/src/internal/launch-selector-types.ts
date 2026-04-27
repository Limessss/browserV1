/**
 * POST /api/launch 选择器类型（对齐 Ant-Browser launchcode.LaunchSelector / mergeLaunchSelector）。
 */

export type LaunchSelector = {
  code: string
  key: string
  profileId: string
  profileName: string
  keywords: string[]
  tags: string[]
  groupId: string
  matchMode: string
}

export type LaunchRequestParams = {
  launchArgs?: string[]
  startUrls?: string[]
  skipDefaultStartUrls?: boolean
}

export type LaunchPostBody = {
  code?: string
  key?: string
  profileId?: string
  profileName?: string
  keyword?: string
  keywords?: string[]
  tag?: string
  tags?: string[]
  groupId?: string
  matchMode?: string
  selector?: Partial<LaunchSelector> & Record<string, unknown>
  launchArgs?: string[]
  startUrls?: string[]
  skipDefaultStartUrls?: boolean
}

export const MATCH_UNIQUE = 'unique'
export const MATCH_FIRST = 'first'
export const MATCH_ALL = 'all'

function normalizeCode(code: string): string {
  return code.trim().toUpperCase()
}

function firstNonEmpty(...values: string[]): string {
  for (const value of values) {
    const t = String(value ?? '').trim()
    if (t) {
      return t
    }
  }
  return ''
}

function appendSelectorTerms(
  dst: string[],
  single: string,
  many: string[] | undefined,
  ...more: Array<string | string[] | undefined>
): string[] {
  const out = [...dst]
  const s = single.trim()
  if (s) {
    out.push(s)
  }
  if (many) {
    out.push(...many)
  }
  for (const item of more) {
    if (typeof item === 'string') {
      const x = item.trim()
      if (x) {
        out.push(x)
      }
    } else if (Array.isArray(item)) {
      out.push(...item)
    }
  }
  return out
}

export function normalizeSelectorTerms(items: string[]): string[] {
  if (items.length === 0) {
    return []
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const trimmed = item.trim()
    if (!trimmed) {
      continue
    }
    const key = trimmed.toLowerCase()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(trimmed)
  }
  return result
}

function defaultLaunchMatchMode(sel: LaunchSelector): string {
  if (sel.code || sel.key || sel.keywords.length > 0) {
    return MATCH_FIRST
  }
  return MATCH_UNIQUE
}

export function normalizeLaunchSelector(raw: LaunchSelector): LaunchSelector {
  const keywords = normalizeSelectorTerms(
    appendSelectorTerms([], '', raw.keywords, raw.key ? [raw.key] : []),
  )
  const tags = normalizeSelectorTerms(appendSelectorTerms([], '', raw.tags))

  let matchMode = String(raw.matchMode ?? '')
    .trim()
    .toLowerCase()
  if (!matchMode) {
    matchMode = defaultLaunchMatchMode({
      ...raw,
      keywords,
      tags,
    })
  }

  return {
    code: normalizeCode(raw.code),
    key: String(raw.key ?? '').trim(),
    keywords,
    tags,
    profileId: String(raw.profileId ?? '').trim(),
    profileName: String(raw.profileName ?? '').trim(),
    groupId: String(raw.groupId ?? '').trim(),
    matchMode,
  }
}

export function mergeLaunchSelector(req: LaunchPostBody): LaunchSelector {
  const nested = req.selector ?? {}
  const nestedSel = nested as Record<string, unknown>

  const code = firstNonEmpty(
    String(nestedSel.code ?? ''),
    String(req.code ?? ''),
  )
  const key = firstNonEmpty(String(nestedSel.key ?? ''), String(req.key ?? ''))
  const profileId = firstNonEmpty(
    String(nestedSel.profileId ?? ''),
    String(req.profileId ?? ''),
  )
  const profileName = firstNonEmpty(
    String(nestedSel.profileName ?? ''),
    String(req.profileName ?? ''),
  )
  const groupId = firstNonEmpty(String(nestedSel.groupId ?? ''), String(req.groupId ?? ''))
  const matchMode = firstNonEmpty(String(nestedSel.matchMode ?? ''), String(req.matchMode ?? ''))

  const keywords = appendSelectorTerms(
    [],
    '',
    Array.isArray(nestedSel.keywords) ? (nestedSel.keywords as string[]) : [],
    String(nestedSel.keyword ?? ''),
    String(req.keyword ?? ''),
    Array.isArray(req.keywords) ? req.keywords : [],
  )

  const tags = appendSelectorTerms(
    [],
    String(nestedSel.tag ?? ''),
    Array.isArray(nestedSel.tags) ? (nestedSel.tags as string[]) : [],
    String(req.tag ?? ''),
    Array.isArray(req.tags) ? req.tags : [],
  )

  return normalizeLaunchSelector({
    code,
    key,
    profileId,
    profileName,
    keywords,
    tags,
    groupId,
    matchMode,
  })
}

export function selectorIsEmpty(sel: LaunchSelector): boolean {
  return (
    !sel.code &&
    !sel.key &&
    !sel.profileId &&
    !sel.profileName &&
    !sel.groupId &&
    sel.keywords.length === 0 &&
    sel.tags.length === 0
  )
}

export function selectorOnlyCode(sel: LaunchSelector): boolean {
  return Boolean(
    sel.code &&
      !sel.key &&
      !sel.profileId &&
      !sel.profileName &&
      !sel.groupId &&
      sel.keywords.length === 0 &&
      sel.tags.length === 0,
  )
}

export function validateMatchMode(sel: LaunchSelector): string | undefined {
  switch (sel.matchMode) {
    case '':
    case MATCH_UNIQUE:
    case MATCH_FIRST:
    case MATCH_ALL:
      return undefined
    default:
      return 'matchMode must be unique, first or all'
  }
}

/**
 * 实例选择器解析（对齐 Ant-Browser launchcode/selector.go）。
 */
import type { Database } from 'sql.js'

import { listProfiles } from './browser-data'
import { findProfileIdByCode } from './launch-code-service'
import type { LaunchSelector } from './launch-selector-types'
import {
  MATCH_FIRST,
  normalizeLaunchSelector,
  normalizeSelectorTerms,
  selectorIsEmpty,
  selectorOnlyCode,
  validateMatchMode,
} from './launch-selector-types'

type Snapshot = Record<string, unknown>

function filterSnapshots(items: Snapshot[], keep: (item: Snapshot) => boolean): Snapshot[] {
  return items.filter(keep)
}

function profileTags(p: Snapshot): string[] {
  const t = p.tags
  return Array.isArray(t) ? t.map((x) => String(x)) : []
}

function profileKeywords(p: Snapshot): string[] {
  const k = p.keywords
  return Array.isArray(k) ? k.map((x) => String(x)) : []
}

function profileHasAllTags(profile: Snapshot, required: string[]): boolean {
  if (required.length === 0) {
    return true
  }
  const tags = profileTags(profile)
  if (tags.length === 0) {
    return false
  }
  for (const want of required) {
    let found = false
    for (const tag of tags) {
      if (tag.trim().toLowerCase() === want.trim().toLowerCase()) {
        found = true
        break
      }
    }
    if (!found) {
      return false
    }
  }
  return true
}

function profileHasExactKeyword(profile: Snapshot, expected: string): boolean {
  const e = expected.trim()
  if (!e) {
    return false
  }
  const keywords = profileKeywords(profile)
  if (keywords.length === 0) {
    return false
  }
  for (const keyword of keywords) {
    if (keyword.trim().toLowerCase() === e.toLowerCase()) {
      return true
    }
  }
  return false
}

function profileMatchesAllKeywordQueries(profile: Snapshot, queries: string[]): boolean {
  if (queries.length === 0) {
    return true
  }
  const keywords = profileKeywords(profile)
  if (keywords.length === 0) {
    return false
  }
  for (const query of queries) {
    const queryLower = query.trim().toLowerCase()
    let found = false
    for (const keyword of keywords) {
      if (keyword.trim().toLowerCase().includes(queryLower)) {
        found = true
        break
      }
    }
    if (!found) {
      return false
    }
  }
  return true
}

function sortSnapshotsForSelector(items: Snapshot[]): void {
  items.sort((a, b) => {
    const leftName = String(a.profileName ?? '')
      .trim()
      .toLowerCase()
    const rightName = String(b.profileName ?? '')
      .trim()
      .toLowerCase()
    if (leftName !== rightName) {
      return leftName.localeCompare(rightName)
    }
    return String(a.profileId ?? '').localeCompare(String(b.profileId ?? ''))
  })
}

function buildAmbiguousSelectorError(items: Snapshot[]): string {
  const maxPreview = 5
  const parts: string[] = []
  for (let i = 0; i < items.length && i < maxPreview; i++) {
    const item = items[i]!
    let label = String(item.profileName ?? '').trim()
    if (!label) {
      label = String(item.profileId ?? '')
    }
    const code = String(item.launchCode ?? '').trim()
    if (code) {
      parts.push(`${label}[id=${String(item.profileId)}, code=${code}]`)
    } else {
      parts.push(`${label}[id=${String(item.profileId)}]`)
    }
  }
  let suffix = ''
  if (items.length > maxPreview) {
    suffix = ` ... and ${items.length - maxPreview} more`
  }
  return `selector matched ${items.length} profiles: ${parts.join(', ')}${suffix}; use code/profileId or add groupId/tags/keywords, or set matchMode=first`
}

export function withCodeKeywordFallback(
  db: Database,
  sel: LaunchSelector,
  allow: boolean,
): LaunchSelector {
  if (!allow || !sel.code.trim()) {
    return sel
  }
  try {
    findProfileIdByCode(db, sel.code)
    return sel
  } catch {
    const next: LaunchSelector = { ...sel }
    if (!next.key.trim()) {
      next.key = sel.code
    }
    next.code = ''
    return normalizeLaunchSelector(next)
  }
}

export function findProfilesBySelector(
  db: Database,
  selector: LaunchSelector,
): { snapshots: Snapshot[]; status: number; errMsg: string } {
  if (selectorIsEmpty(selector)) {
    return { snapshots: [], status: 400, errMsg: 'selector is required' }
  }
  const ve = validateMatchMode(selector)
  if (ve) {
    return { snapshots: [], status: 400, errMsg: ve }
  }

  let snapshots = listProfiles(db) as Snapshot[]
  if (snapshots.length === 0) {
    return { snapshots: [], status: 404, errMsg: 'profile selector matched no instance' }
  }

  if (selector.code) {
    let profileId: string
    try {
      profileId = findProfileIdByCode(db, selector.code)
    } catch {
      return { snapshots: [], status: 404, errMsg: 'launch code not found' }
    }
    snapshots = filterSnapshots(snapshots, (item) => String(item.profileId) === profileId)
  }

  if (selector.profileId) {
    snapshots = filterSnapshots(
      snapshots,
      (item) => String(item.profileId) === selector.profileId,
    )
  }

  if (selector.profileName) {
    snapshots = filterSnapshots(snapshots, (item) =>
      String(item.profileName ?? '').toLowerCase() === selector.profileName.trim().toLowerCase(),
    )
  }

  if (selector.groupId) {
    snapshots = filterSnapshots(
      snapshots,
      (item) => String(item.groupId ?? '').trim() === selector.groupId.trim(),
    )
  }

  if (selector.tags.length > 0) {
    snapshots = filterSnapshots(snapshots, (item) => profileHasAllTags(item, selector.tags))
  }

  let fuzzyQueries = [...selector.keywords]
  if (selector.key) {
    const exactMatches = filterSnapshots(snapshots, (item) =>
      profileHasExactKeyword(item, selector.key),
    )
    if (exactMatches.length > 0) {
      snapshots = exactMatches
    } else {
      fuzzyQueries = normalizeSelectorTerms([selector.key, ...selector.keywords])
    }
  }

  if (fuzzyQueries.length > 0) {
    snapshots = filterSnapshots(snapshots, (item) =>
      profileMatchesAllKeywordQueries(item, fuzzyQueries),
    )
  }

  if (snapshots.length === 0) {
    const msg = selectorOnlyCode(selector)
      ? 'launch code not found'
      : 'profile selector matched no instance'
    return { snapshots: [], status: 404, errMsg: msg }
  }

  sortSnapshotsForSelector(snapshots)
  return { snapshots, status: 200, errMsg: '' }
}

export function findProfileBySelector(
  db: Database,
  selector: LaunchSelector,
): { snapshot: Snapshot | null; status: number; errMsg: string } {
  const { snapshots, status, errMsg } = findProfilesBySelector(db, selector)
  if (errMsg) {
    return { snapshot: null, status, errMsg }
  }
  if (snapshots.length > 1 && selector.matchMode !== MATCH_FIRST) {
    return {
      snapshot: null,
      status: 409,
      errMsg: buildAmbiguousSelectorError(snapshots),
    }
  }
  return { snapshot: snapshots[0]!, status: 200, errMsg: '' }
}

/**
 * 兑换码 / GitHub Star / 发卡器（对齐 Ant-Browser app_license.go + config.RewardForUsedKey）。
 */
import { createHash, randomInt } from 'node:crypto'

import { loadRootYamlRaw, saveRootYamlRaw } from './app-config-store'

const DEFAULT_MAX_PROFILE_LIMIT = 20
const STANDARD_CD_KEY_BONUS = 10
const GITHUB_STAR_REWARD_KEY = 'GITHUB_STAR_REWARD'
const GITHUB_STAR_PROFILE_BONUS = 50

function rewardForUsedKey(key: string): number {
  const n = key.toUpperCase().trim()
  if (!n) return 0
  if (n === GITHUB_STAR_REWARD_KEY) return GITHUB_STAR_PROFILE_BONUS
  return STANDARD_CD_KEY_BONUS
}

function minimumProfileLimitForUsedKeys(keys: string[]): number {
  let limit = DEFAULT_MAX_PROFILE_LIMIT
  const seen = new Set<string>()
  for (const key of keys) {
    const normalized = key.toUpperCase().trim()
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    limit += rewardForUsedKey(normalized)
  }
  return limit
}

export function generateChecksum(payload: string): string {
  const salt = 'ANT-LITE-KEY-SALT-VER-1'
  const hash = createHash('sha256').update(payload + salt).digest('hex')
  return hash.slice(0, 8).toUpperCase()
}

function normalizeCdKeyInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\t/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
}

function normalizeUsedKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((x) => String(x).trim()).filter(Boolean)
}

export function redeemCdKey(rawKey: string): void {
  const cdkey = normalizeCdKeyInput(rawKey)
  if (!cdkey) {
    throw new Error('兑换码不能为空')
  }
  if (!cdkey.startsWith('ANT-')) {
    throw new Error('无效的兑换码格式')
  }

  const parts = cdkey.split('-')
  if (parts.length < 3) {
    throw new Error('无效的兑换码长度')
  }

  const checksumIdx = parts.length - 1
  const payload = parts.slice(0, checksumIdx).join('-')
  const actualChecksum = parts[checksumIdx]
  const expectedChecksum = generateChecksum(payload)
  if (actualChecksum !== expectedChecksum) {
    throw new Error('无效的兑换码 (Checksum Error)')
  }

  const raw = loadRootYamlRaw()
  const app = ((raw.app as Record<string, unknown>) ?? {}) as Record<string, unknown>
  const usedKeys = normalizeUsedKeys(app.used_cd_keys)

  if (usedKeys.some((k) => k.toUpperCase() === cdkey)) {
    throw new Error('该兑换码已被使用过')
  }

  usedKeys.push(cdkey)
  const minLimit = minimumProfileLimitForUsedKeys(usedKeys)
  const prevMax = Number(app.max_profile_limit ?? DEFAULT_MAX_PROFILE_LIMIT) || DEFAULT_MAX_PROFILE_LIMIT

  raw.app = {
    ...app,
    used_cd_keys: usedKeys,
    max_profile_limit: Math.max(prevMax, minLimit),
  }
  saveRootYamlRaw(raw)
}

export function redeemGithubStar(): void {
  const raw = loadRootYamlRaw()
  const app = ((raw.app as Record<string, unknown>) ?? {}) as Record<string, unknown>
  const usedKeys = normalizeUsedKeys(app.used_cd_keys)
  const starKey = GITHUB_STAR_REWARD_KEY.toUpperCase()

  if (usedKeys.some((k) => k.toUpperCase() === starKey)) {
    throw new Error('您已经领取过 GitHub Star 的赠送额度啦！')
  }

  usedKeys.push(starKey)
  const minLimit = minimumProfileLimitForUsedKeys(usedKeys)
  const prevMax = Number(app.max_profile_limit ?? DEFAULT_MAX_PROFILE_LIMIT) || DEFAULT_MAX_PROFILE_LIMIT

  raw.app = {
    ...app,
    used_cd_keys: usedKeys,
    max_profile_limit: Math.max(prevMax, minLimit),
  }
  saveRootYamlRaw(raw)
}

const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

export function generateCdKeys(count: number): string[] {
  if (count <= 0 || count > 1000) {
    throw new Error('生成数量无效 (1-1000)')
  }
  const keys: string[] = []
  for (let i = 0; i < count; i++) {
    const chars: string[] = []
    for (let j = 0; j < 16; j++) {
      chars.push(CHARSET[randomInt(CHARSET.length)]!)
    }
    const b = chars.join('')
    const part = (from: number, to: number) => b.slice(from, to)
    const payload = `ANT-${part(0, 4)}-${part(4, 8)}-${part(8, 12)}-${part(12, 16)}`
    const checksum = generateChecksum(payload)
    keys.push(`${payload}-${checksum}`)
  }
  return keys
}

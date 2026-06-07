/**
 * 凭据密码加密：优先 Electron safeStorage（OS 密钥链），否则 base64（仅开发降级）。
 */
import { safeStorage } from 'electron'

const PREFIX = 'ss:'

export function encryptCredentialSecret(plain: string): string {
  const text = String(plain ?? '')
  if (!text) {
    return ''
  }
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(text)
    return PREFIX + enc.toString('base64')
  }
  return Buffer.from(text, 'utf8').toString('base64')
}

export function decryptCredentialSecret(stored: string): string {
  const raw = String(stored ?? '').trim()
  if (!raw) {
    return ''
  }
  if (raw.startsWith(PREFIX) && safeStorage.isEncryptionAvailable()) {
    try {
      const buf = Buffer.from(raw.slice(PREFIX.length), 'base64')
      return safeStorage.decryptString(buf)
    } catch {
      return ''
    }
  }
  try {
    return Buffer.from(raw, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

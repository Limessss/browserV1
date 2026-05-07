/**
 * 应用根路径解析：开发态 cwd，打包后 exe 目录（对齐 Ant-Browser resolveAppPath）。
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { App } from 'electron'

let appRef: App | null = null

export function initElectronPaths(app: App): void {
  appRef = app
}

/**
 * 数据库中的内核路径解析。
 * - 绝对路径：原样返回。
 * - 相对路径且以 chrome/ 开头：优先 userData/chrome（下载内核持久化目录），存在则用；否则再解析到安装目录旁 chrome（扫描注册的内核）。
 */
export function resolveCoreStoredPath(stored: string): string {
  const raw = stored.trim()
  if (!raw) {
    return process.cwd()
  }
  if (isAbsolute(raw)) {
    return raw
  }
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  const chromePrefix = /^chrome(\/|$)/i
  if (chromePrefix.test(normalized) && appRef) {
    const afterChrome = normalized.replace(/^chrome\/?/i, '')
    const parts = afterChrome.split('/').filter(Boolean)
    const underUser =
      parts.length > 0
        ? join(appRef.getPath('userData'), 'chrome', ...parts)
        : join(appRef.getPath('userData'), 'chrome')
    if (existsSync(underUser)) {
      return underUser
    }
  }
  return resolveAppRelativePath(stored)
}

/** 相对路径相对于「应用根」；已是绝对路径则原样返回 */
export function resolveAppRelativePath(rel: string): string {
  const r = rel.trim()
  if (!r) {
    return process.cwd()
  }
  if (isAbsolute(r)) {
    return r
  }
  const base =
    appRef && appRef.isPackaged
      ? dirname(appRef.getPath('exe'))
      : process.cwd()
  return resolve(base, r)
}

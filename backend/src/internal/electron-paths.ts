/**
 * 应用根路径解析：开发态 cwd，打包后 exe 目录（对齐 Ant-Browser resolveAppPath）。
 */
import { dirname, isAbsolute, resolve } from 'node:path'
import type { App } from 'electron'

let appRef: App | null = null

export function initElectronPaths(app: App): void {
  appRef = app
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

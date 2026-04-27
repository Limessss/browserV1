/**
 * 在系统文件管理器中打开路径（对齐 OpenUserDataDir / OpenCorePath）。
 */
import { existsSync, mkdirSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { shell } from 'electron'
import { loadBrowserSettingsMerged } from './app-config-store'
import { resolveAppRelativePath } from './electron-paths'

export async function openUserDataDir(subDir: string): Promise<void> {
  const rel = subDir.trim()
  if (!rel) {
    throw new Error('用户数据目录不能为空')
  }
  const settings = loadBrowserSettingsMerged()
  const rootName = String(settings.userDataRoot ?? 'data').trim() || 'data'
  const rootAbs = resolveAppRelativePath(rootName)
  const fullPath = resolve(rootAbs, rel)
  mkdirSync(fullPath, { recursive: true })
  const errMsg = await shell.openPath(fullPath)
  if (errMsg) {
    throw new Error(errMsg)
  }
}

export async function openCorePathInExplorer(corePath: string): Promise<void> {
  const p = corePath.trim()
  if (!p) {
    throw new Error('内核路径不能为空')
  }
  const fullPath = isAbsolute(p) ? p : resolveAppRelativePath(p)
  if (!existsSync(fullPath)) {
    throw new Error(`路径不存在: ${fullPath}`)
  }
  const errMsg = await shell.openPath(fullPath)
  if (errMsg) {
    throw new Error(errMsg)
  }
}

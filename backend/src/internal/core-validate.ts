/**
 * 对齐 browser.Manager.ValidateCorePath：校验内核目录或可执行路径。
 * 与 resolveChromeExecutableForProfile 一致：绝对路径原样；chrome/ 相对路径优先 userData/chrome。
 */
import { existsSync } from 'node:fs'
import { findCoreExecutable, formatCandidateHint } from './core-binary'
import { resolveCoreStoredPath } from './electron-paths'

export function validateCorePath(corePath: string): { valid: boolean; message: string } {
  const trimmed = corePath.trim()
  if (!trimmed) {
    return { valid: false, message: '路径不能为空' }
  }

  const baseDir = resolveCoreStoredPath(trimmed)

  try {
    if (!existsSync(baseDir)) {
      return { valid: false, message: `目录不存在: ${baseDir}` }
    }
  } catch {
    return { valid: false, message: `目录不存在: ${baseDir}` }
  }

  const hit = findCoreExecutable(baseDir)
  if (!hit.ok) {
    return {
      valid: false,
      message: `未找到浏览器可执行文件（候选：${formatCandidateHint()}）`,
    }
  }

  return { valid: true, message: `路径有效: ${hit.path}` }
}

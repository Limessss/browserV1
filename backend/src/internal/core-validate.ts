/**
 * 对齐 browser.Manager.ValidateCorePath：校验内核目录或可执行路径。
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findCoreExecutable, formatCandidateHint } from './core-binary'

function resolveCoreBaseDir(corePath: string): string {
  const p = corePath.trim()
  if (!p) {
    return ''
  }
  if (resolve(p) === p || /^[a-zA-Z]:[\\/]/.test(p)) {
    return p
  }
  return resolve(process.cwd(), p)
}

export function validateCorePath(corePath: string): { valid: boolean; message: string } {
  const trimmed = corePath.trim()
  if (!trimmed) {
    return { valid: false, message: '路径不能为空' }
  }

  const baseDir = resolveCoreBaseDir(trimmed)

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

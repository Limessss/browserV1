/**
 * 对齐 Ant-Browser internal/browser/core_binary.go：在目录内查找浏览器可执行文件。
 */
import { existsSync, statSync } from 'node:fs'
import { basename, join, normalize, sep } from 'node:path'

export function coreExecutableCandidates(): string[] {
  switch (process.platform) {
    case 'win32':
      return ['chrome.exe']
    case 'darwin':
      return [
        'Google Chrome.app/Contents/MacOS/Google Chrome',
        'Chromium.app/Contents/MacOS/Chromium',
        'chrome',
      ]
    case 'linux':
      return ['chrome', 'chrome-bin', 'chrome.exe']
    default:
      return ['chrome']
  }
}

function findDirectCoreExecutable(fp: string): { path: string; candidate: string } | null {
  try {
    const info = statSync(fp)
    if (info.isDirectory()) {
      return null
    }
  } catch {
    return null
  }
  const normalized = normalize(fp).split(sep).join('/')
  for (const candidate of coreExecutableCandidates()) {
    const candPath = candidate.split('/').join(sep)
    const candNorm = normalize(candPath).split(sep).join('/')
    if (
      normalized.endsWith(candNorm) ||
      basename(normalized).toLowerCase() === basename(candNorm).toLowerCase()
    ) {
      return { path: fp, candidate }
    }
  }
  return null
}

/** 返回绝对路径命中的可执行文件与候选名；未找到返回 ok=false */
export function findCoreExecutable(baseDir: string): { path: string; candidate: string; ok: boolean } {
  const trimmed = baseDir.trim()
  if (!trimmed) {
    return { path: '', candidate: '', ok: false }
  }

  const direct = findDirectCoreExecutable(trimmed)
  if (direct) {
    return { ...direct, ok: true }
  }

  if (process.platform === 'darwin') {
    try {
      const info = statSync(trimmed)
      if (info.isDirectory() && trimmed.toLowerCase().endsWith('.app')) {
        for (const candidate of coreExecutableCandidates()) {
          const marker = '.app/'
          const idx = candidate.toLowerCase().indexOf(marker)
          if (idx < 0) {
            continue
          }
          const appName = candidate.slice(0, idx + '.app'.length)
          if (basename(trimmed).toLowerCase() !== basename(appName).toLowerCase()) {
            continue
          }
          const relExec = candidate.slice(idx + marker.length)
          const p = join(trimmed, ...relExec.split('/'))
          if (existsSync(p)) {
            return { path: p, candidate, ok: true }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  for (const candidate of coreExecutableCandidates()) {
    const p = join(trimmed, ...candidate.split('/'))
    try {
      if (existsSync(p)) {
        return { path: p, candidate, ok: true }
      }
    } catch {
      /* ignore */
    }
  }

  return { path: '', candidate: '', ok: false }
}

export function formatCandidateHint(): string {
  return coreExecutableCandidates().join(', ')
}

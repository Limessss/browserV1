/**
 * Playwright 脚本 Node 运行时解析。
 *
 * 脚本能力（如 node:sqlite）独立于 Electron 内置 Node 版本：
 * 1. PLAYWRIGHT_NODE_PATH 显式指定
 * 2. 安装包内 bin/<平台>/node(.exe)（构建时 fetch-node 拉取 Node 22）
 * 3. PATH 上 Node >= 22（开发态）
 * 4. 回退 ELECTRON_RUN_AS_NODE（功能可能受限，打 warn）
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveAppRelativePath } from './electron-paths'

export const PLAYWRIGHT_MIN_NODE_MAJOR = 22

export interface NodeRunner {
  command: string
  extraEnv?: Record<string, string>
  source: 'explicit' | 'bundled' | 'path' | 'electron-fallback'
}

function bundledNodeRelativePath(): string {
  if (process.platform === 'win32') {
    return join('bin', 'windows-amd64', 'node.exe')
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64'
    return join('bin', arch, 'node')
  }
  return join('bin', 'linux-amd64', 'node')
}

function parseNodeMajor(versionOutput: string): number | null {
  const m = /^v(\d+)/.exec(String(versionOutput ?? '').trim())
  if (!m) return null
  const major = Number(m[1])
  return Number.isFinite(major) ? major : null
}

function probeNodeMajor(command: string): number | null {
  try {
    const result = spawnSync(command, ['-v'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      shell: false,
    })
    if (result.status !== 0) return null
    return parseNodeMajor(String(result.stdout ?? result.stderr ?? ''))
  } catch {
    return null
  }
}

/** 解析 Playwright 脚本应使用的 Node 可执行文件 */
export function resolvePlaywrightNodeRunner(): NodeRunner {
  const explicit = String(process.env.PLAYWRIGHT_NODE_PATH ?? '').trim()
  if (explicit && existsSync(explicit)) {
    const major = probeNodeMajor(explicit)
    if (major !== null && major >= PLAYWRIGHT_MIN_NODE_MAJOR) {
      return { command: explicit, source: 'explicit' }
    }
    console.warn(
      `[playwright] PLAYWRIGHT_NODE_PATH=${explicit} 不是 Node ${PLAYWRIGHT_MIN_NODE_MAJOR}+，已忽略`,
    )
  }

  const bundled = resolveAppRelativePath(bundledNodeRelativePath())
  if (existsSync(bundled)) {
    return { command: bundled, source: 'bundled' }
  }

  const pathNode = process.platform === 'win32' ? 'node.exe' : 'node'
  const pathMajor = probeNodeMajor(pathNode)
  if (pathMajor !== null && pathMajor >= PLAYWRIGHT_MIN_NODE_MAJOR) {
    return { command: pathNode, source: 'path' }
  }

  const execPath = process.execPath?.trim()
  if (execPath) {
    console.warn(
      `[playwright] 未找到 Node ${PLAYWRIGHT_MIN_NODE_MAJOR}+（bundled 或 PATH），` +
        `回退 ELECTRON_RUN_AS_NODE；部分脚本（如 node:sqlite）可能无法运行`,
    )
    return {
      command: execPath,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      source: 'electron-fallback',
    }
  }

  return { command: pathNode, source: 'path' }
}

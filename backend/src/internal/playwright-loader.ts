/**
 * 从应用根目录 node_modules 加载 Playwright，避免主进程 bundle 打入 playwright-core
 * （其依赖 chromium-bidi 在 asar 内无法解析）。
 *
 * 打包后 playwright / playwright-core / chromium-bidi 由 electron-builder extraFiles 放在 exe 旁。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAppRelativePath } from './electron-paths'

export type PlaywrightModule = typeof import('playwright')
export type PlaywrightBrowser = import('playwright').Browser
export type PlaywrightPage = import('playwright').Page
export type PlaywrightBrowserContext = import('playwright').BrowserContext

let cached: PlaywrightModule | null = null

function resolvePlaywrightEntry(): string {
  const candidates = [
    join(resolveAppRelativePath('.'), 'node_modules', 'playwright', 'index.mjs'),
    join(process.cwd(), 'node_modules', 'playwright', 'index.mjs'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error('未找到 playwright 模块（请确认 node_modules/playwright 已安装或已随安装包部署）')
}

export async function loadPlaywright(): Promise<PlaywrightModule> {
  if (cached) return cached
  const entry = resolvePlaywrightEntry()
  const mod: PlaywrightModule = await import(pathToFileURL(entry).href)
  cached = mod
  return mod
}

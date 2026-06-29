/**
 * 用户保存的脚本默认参数（覆盖 script.json 的 defaultArgs）。
 * 存储于 playwright_scripts/_user_defaults/<scriptId>.json
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const USER_DEFAULTS_DIR = '_user_defaults'
const MANIFEST_NAME = 'script.json'

export function resolvePlaywrightScriptsRoot(scriptDir) {
  return path.resolve(scriptDir, '..')
}

export function resolveStorageKey(scriptDir, manifest) {
  const id = manifest?.id && String(manifest.id).trim()
  if (id) return id
  return path.basename(scriptDir)
}

export function userDefaultsFilePath(scriptsRoot, storageKey) {
  const safe = String(storageKey || '')
    .trim()
    .replace(/[/\\]/g, '_')
  return path.join(scriptsRoot, USER_DEFAULTS_DIR, `${safe}.json`)
}

export async function readScriptManifest(scriptDir) {
  const fp = path.join(scriptDir, MANIFEST_NAME)
  const raw = await readFile(fp, 'utf8')
  return JSON.parse(raw)
}

export async function loadUserDefaultsFile(scriptsRoot, storageKey) {
  const fp = userDefaultsFilePath(scriptsRoot, storageKey)
  if (!existsSync(fp)) return null
  try {
    const raw = JSON.parse(await readFile(fp, 'utf8'))
    if (!Array.isArray(raw?.defaultArgs)) return null
    return {
      defaultArgs: raw.defaultArgs.filter((a) => typeof a === 'string'),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    }
  } catch {
    return null
  }
}

export async function loadUserDefaultArgs(scriptsRoot, storageKey) {
  const file = await loadUserDefaultsFile(scriptsRoot, storageKey)
  return file?.defaultArgs ?? null
}

export async function saveUserDefaultArgs(scriptsRoot, storageKey, defaultArgs) {
  const dir = path.join(scriptsRoot, USER_DEFAULTS_DIR)
  await mkdir(dir, { recursive: true })
  const cleaned = (defaultArgs || [])
    .map((a) => String(a ?? '').trim())
    .filter((a) => a.length > 0)
  const fp = userDefaultsFilePath(scriptsRoot, storageKey)
  const payload = {
    defaultArgs: cleaned,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(fp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return payload
}

/** 本轮实际传入 Node 的 CLI 参数（去掉入口 .mjs 路径） */
export function getCurrentRunArgs(argv = process.argv) {
  const rest = argv.slice(2)
  if (!rest.length) return []
  const first = rest[0]
  if (first.endsWith('.mjs') || first.includes('playwright_scripts')) {
    return rest.slice(1)
  }
  return rest
}

/** 将面板 textarea 文本解析为参数数组（每行一个；# 开头为注释） */
export function parseArgsLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

export function formatArgsLines(args) {
  return (args || []).join('\n')
}

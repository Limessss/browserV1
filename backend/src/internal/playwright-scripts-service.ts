/**
 * 扫描 playwright_scripts 子目录的 script.json，并 spawn node 运行入口 .mjs。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, readFile, readdir, writeFile } from 'node:fs/promises'
import { constants as FsConstants } from 'node:fs'
import { join, resolve } from 'node:path'
import { emitWailsEvent } from '../ipc/wails-emit'
import { resolveAppRelativePath } from './electron-paths'

const MANIFEST_NAME = 'script.json'

export interface PlaywrightScriptManifest {
  name: string
  description: string
  entry: string
  id?: string
  order?: number
  tags?: string[]
  version?: string
  defaultArgs?: string[]
  argsHint?: string
  requiresLaunchServer?: boolean
  mcpDoc?: string
}

export interface SavePlaywrightScriptManifestInput {
  name: string
  description: string
  entry: string
  id?: string
  order?: number | null
  tags?: string[]
  version?: string
  defaultArgs?: string[]
  argsHint?: string
  requiresLaunchServer?: boolean
  mcpDoc?: string
}

export interface PlaywrightScriptItem extends PlaywrightScriptManifest {
  folderId: string
  manifestPath: string
  entryPath: string
}

export interface ListPlaywrightScriptsResult {
  rootDir: string
  scripts: PlaywrightScriptItem[]
  warnings: string[]
}

const runs = new Map<string, ChildProcess>()

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function parseManifest(raw: unknown, folderId: string): PlaywrightScriptManifest | null {
  if (!isRecord(raw)) return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const description = typeof raw.description === 'string' ? raw.description.trim() : ''
  const entry = typeof raw.entry === 'string' ? raw.entry.trim() : ''
  if (!name || !description || !entry) {
    return null
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : undefined
  const order = typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : undefined
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : undefined
  const version = typeof raw.version === 'string' ? raw.version.trim() : undefined
  const defaultArgs = Array.isArray(raw.defaultArgs)
    ? raw.defaultArgs.filter((a): a is string => typeof a === 'string')
    : undefined
  const argsHint = typeof raw.argsHint === 'string' ? raw.argsHint : undefined
  const requiresLaunchServer = raw.requiresLaunchServer === true
  const mcpDoc = typeof raw.mcpDoc === 'string' ? raw.mcpDoc.trim() : undefined

  return {
    name,
    description,
    entry,
    id,
    order,
    tags,
    version,
    defaultArgs,
    argsHint,
    requiresLaunchServer,
    mcpDoc,
  }
}

export async function listPlaywrightScripts(): Promise<ListPlaywrightScriptsResult> {
  const rootDir = resolveAppRelativePath('playwright_scripts')
  const warnings: string[] = []
  const scripts: PlaywrightScriptItem[] = []

  let entries: string[]
  try {
    entries = await readdir(rootDir, { withFileTypes: true }).then((list) =>
      list.filter((d) => d.isDirectory()).map((d) => d.name),
    )
  } catch {
    warnings.push(`无法读取脚本目录: ${rootDir}`)
    return { rootDir, scripts, warnings }
  }

  for (const folderId of entries.sort()) {
    const manifestPath = join(rootDir, folderId, MANIFEST_NAME)
    try {
      await access(manifestPath, FsConstants.R_OK)
    } catch {
      warnings.push(`跳过 ${folderId}/：缺少 ${MANIFEST_NAME}`)
      continue
    }

    let rawText: string
    try {
      rawText = await readFile(manifestPath, 'utf8')
    } catch (e) {
      warnings.push(`跳过 ${folderId}/：无法读取 ${MANIFEST_NAME}（${e instanceof Error ? e.message : String(e)}）`)
      continue
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      warnings.push(`跳过 ${folderId}/：${MANIFEST_NAME} 不是合法 JSON`)
      continue
    }

    const manifest = parseManifest(parsed, folderId)
    if (!manifest) {
      warnings.push(`跳过 ${folderId}/：${MANIFEST_NAME} 缺少必填字段 name / description / entry`)
      continue
    }

    const entryPath = resolve(rootDir, folderId, manifest.entry)
    try {
      await access(entryPath, FsConstants.R_OK)
    } catch {
      warnings.push(`跳过 ${folderId}/：入口文件不存在 — ${manifest.entry}`)
      continue
    }

    scripts.push({
      ...manifest,
      folderId,
      manifestPath,
      entryPath,
    })
  }

  scripts.sort((a, b) => {
    const oa = a.order ?? 9999
    const ob = b.order ?? 9999
    if (oa !== ob) return oa - ob
    return a.folderId.localeCompare(b.folderId)
  })

  return { rootDir, scripts, warnings }
}

export async function savePlaywrightScriptManifest(
  folderId: string,
  input: unknown,
): Promise<PlaywrightScriptItem> {
  const fid = String(folderId ?? '').trim()
  if (!fid || fid.includes('..') || fid.includes('/') || fid.includes('\\')) {
    throw new Error('无效的脚本目录 id')
  }

  if (!isRecord(input)) {
    throw new Error('manifest 参数必须是对象')
  }

  const parsed = parseManifest(input, fid)
  if (!parsed) {
    throw new Error('script.json 缺少必填字段 name / description / entry')
  }

  const rootDir = resolveAppRelativePath('playwright_scripts')
  const folderDir = join(rootDir, fid)
  const manifestPath = join(folderDir, MANIFEST_NAME)
  const entryPath = resolve(folderDir, parsed.entry)
  try {
    await access(entryPath, FsConstants.R_OK)
  } catch {
    throw new Error(`入口文件不存在: ${parsed.entry}`)
  }

  const rawOrder = input.order
  const normalizedOrder =
    typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : undefined
  const normalized = {
    name: parsed.name,
    description: parsed.description,
    entry: parsed.entry,
    ...(parsed.id ? { id: parsed.id } : {}),
    ...(normalizedOrder !== undefined ? { order: normalizedOrder } : {}),
    ...(parsed.tags && parsed.tags.length > 0 ? { tags: parsed.tags } : {}),
    ...(parsed.version ? { version: parsed.version } : {}),
    ...(parsed.defaultArgs && parsed.defaultArgs.length > 0 ? { defaultArgs: parsed.defaultArgs } : {}),
    ...(parsed.argsHint ? { argsHint: parsed.argsHint } : {}),
    ...(parsed.requiresLaunchServer ? { requiresLaunchServer: true } : {}),
    ...(parsed.mcpDoc ? { mcpDoc: parsed.mcpDoc } : {}),
  }

  await writeFile(manifestPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return {
    ...parsed,
    order: normalizedOrder,
    folderId: fid,
    manifestPath,
    entryPath,
  }
}

function resolveNodeRunner(): { command: string; extraEnv?: Record<string, string> } {
  /**
   * 在打包 Electron 应用里，目标机器通常没有全局 node/node.exe。
   * 这里使用当前可执行文件并开启 ELECTRON_RUN_AS_NODE，让 Electron 以 Node 模式执行脚本。
   */
  const execPath = process.execPath
  if (execPath && execPath.trim().length > 0) {
    return {
      command: execPath,
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  return { command: process.platform === 'win32' ? 'node.exe' : 'node' }
}

export async function runPlaywrightScript(
  folderId: string,
  extraArgs: unknown,
): Promise<{ runId: string }> {
  const fid = String(folderId ?? '').trim()
  if (!fid || fid.includes('..') || fid.includes('/') || fid.includes('\\')) {
    throw new Error('无效的脚本目录 id')
  }

  const list = await listPlaywrightScripts()
  const script = list.scripts.find((s) => s.folderId === fid)
  if (!script) {
    throw new Error(`未找到脚本: ${fid}`)
  }

  const extra =
    Array.isArray(extraArgs) && extraArgs.every((a) => typeof a === 'string')
      ? (extraArgs as string[])
      : []

  const appRoot = resolveAppRelativePath('.')
  // 与「命令行只打一遍参数」一致：各 .mjs 里 getArgValue 多取 **首个** 出现的 flag。
  // 故「自动化页」的附加参数必须排在 script.json 的 defaultArgs **之前**，
  // 否则 --shop_region 等会被默认里的值盖住（先出现的是 PH，用户填的 MY 被忽略）。
  const args = [script.entryPath, ...extra, ...(script.defaultArgs ?? [])]
  const nodeRunner = resolveNodeRunner()
  const runId = randomUUID()

  const child = spawn(nodeRunner.command, args, {
    cwd: appRoot,
    env: { ...process.env, ...(nodeRunner.extraEnv ?? {}) },
    windowsHide: true,
    shell: false,
  })

  runs.set(runId, child)

  const hashChunk = (stream: 'stdout' | 'stderr', buf: Buffer) => {
    const text = buf.toString('utf8')
    if (!text) return
    emitWailsEvent('playwright:script:chunk', {
      runId,
      folderId: fid,
      stream,
      text,
    })
  }

  child.stdout?.on('data', (d: Buffer | string) => {
    hashChunk('stdout', Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'))
  })
  child.stderr?.on('data', (d: Buffer | string) => {
    hashChunk('stderr', Buffer.isBuffer(d) ? d : Buffer.from(String(d), 'utf8'))
  })

  const finish = (code: number | null, signal: NodeJS.Signals | null) => {
    runs.delete(runId)
    emitWailsEvent('playwright:script:exit', {
      runId,
      folderId: fid,
      code: code ?? -1,
      signal: signal ?? '',
    })
  }

  child.on('error', (err) => {
    runs.delete(runId)
    emitWailsEvent('playwright:script:chunk', {
      runId,
      folderId: fid,
      stream: 'stderr',
      text: `[spawn error] ${err instanceof Error ? err.message : String(err)}\n`,
    })
    emitWailsEvent('playwright:script:exit', {
      runId,
      folderId: fid,
      code: -1,
      signal: '',
    })
  })

  child.on('close', (code, signal) => {
    finish(code, signal)
  })

  return { runId }
}

export function killPlaywrightScriptRun(runId: string): boolean {
  const id = String(runId ?? '').trim()
  if (!id) return false
  const child = runs.get(id)
  if (!child || child.killed) {
    return false
  }
  try {
    if (process.platform === 'win32') {
      child.kill()
    } else {
      child.kill('SIGTERM')
    }
  } catch {
    return false
  }
  return true
}

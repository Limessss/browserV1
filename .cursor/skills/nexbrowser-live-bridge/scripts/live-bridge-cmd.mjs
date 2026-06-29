#!/usr/bin/env node
/**
 * NexBrowser Live Bridge CLI — 单次 WS 连接执行一条或多条命令
 *
 * Usage (from repo root):
 *   node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs attach
 *   node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs observe
 *   node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs send profile '{"code":"BUPM2Z"}'
 *   node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs send click '{"selector":"text=登录"}'
 *   node .cursor/skills/nexbrowser-live-bridge/scripts/live-bridge-cmd.mjs batch '[{"cmd":"attach"},{"cmd":"observe"}]'
 *
 * Env:
 *   LIVE_BRIDGE_URL  default ws://127.0.0.1:19876/api/live-bridge
 *   LIVE_BRIDGE_TIMEOUT_MS  default 45000
 */
import WS from 'ws'

const DEFAULT_URL = process.env.LIVE_BRIDGE_URL || 'ws://127.0.0.1:19876/api/live-bridge'
const TIMEOUT_MS = Number(process.env.LIVE_BRIDGE_TIMEOUT_MS || 45000)

function parseArgs(argv) {
  const [mode, ...rest] = argv
  if (!mode || mode === '-h' || mode === '--help') {
    return { help: true }
  }
  if (mode === 'send') {
    const [cmd, argsJson = '{}'] = rest
    return { mode: 'batch', commands: [{ cmd, args: JSON.parse(argsJson) }] }
  }
  if (mode === 'batch' || mode === '--file' || mode === '-f') {
    const pathOrJson = rest.join(' ').trim()
    if (mode === '--file' || mode === '-f') {
      return { mode: 'batch', file: pathOrJson }
    }
    if (pathOrJson === '-' || !pathOrJson) {
      return { mode: 'batch', stdin: true }
    }
    return { mode: 'batch', commands: JSON.parse(pathOrJson) }
  }
  return { mode: 'batch', commands: [{ cmd: mode, args: {} }] }
}

async function loadCommands(parsed) {
  if (parsed.commands) return parsed.commands
  if (parsed.file) {
    const fs = await import('node:fs/promises')
    return JSON.parse(await fs.readFile(parsed.file, 'utf8'))
  }
  if (parsed.stdin) {
    const chunks = []
    for await (const c of process.stdin) chunks.push(c)
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  throw new Error('no commands')
}

function createClient(url) {
  const ws = new WS(url)
  const pending = new Map()
  let seq = 0
  const events = []

  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw))
    if (msg.type === 'event') {
      events.push(msg)
      return
    }
    const resolve = pending.get(msg.id)
    if (resolve) {
      pending.delete(msg.id)
      resolve(msg)
    }
  })

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
    setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000)
  })

  async function send(cmd, args = {}) {
    await ready
    return new Promise((resolve, reject) => {
      const id = `c${++seq}`
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`timeout: ${cmd}`))
      }, TIMEOUT_MS)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      ws.send(JSON.stringify({ id, cmd, args }))
    })
  }

  async function close() {
    try { ws.close() } catch { /* ignore */ }
  }

  return { send, close, events, ready }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    console.log(`NexBrowser Live Bridge CLI — 单次 WebSocket 连接执行命令

用法:
  live-bridge-cmd.mjs attach|observe|ping|url|screenshot|...
  live-bridge-cmd.mjs send <cmd> '<args-json>'
  live-bridge-cmd.mjs batch '<json-array>'
  live-bridge-cmd.mjs batch -          # 从 stdin 读 JSON 数组
  live-bridge-cmd.mjs -f batch.json    # 从文件读（Windows 推荐）

示例:
  node live-bridge-cmd.mjs attach
  node live-bridge-cmd.mjs -f .cursor/skills/nexbrowser-live-bridge/scripts/example-batch.json`)
    process.exit(0)
  }

  const client = createClient(DEFAULT_URL)
  const results = []
  let commands = []

  try {
    commands = await loadCommands(parsed)
    await client.ready
    for (const { cmd, args } of commands) {
      const resp = await client.send(cmd, args ?? {})
      results.push({ cmd, ok: resp.ok, result: resp.result, error: resp.error })
      if (!resp.ok) break
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }, null, 2))
    process.exit(1)
  } finally {
    await client.close()
  }

  const out = {
    ok: results.every((r) => r.ok),
    url: DEFAULT_URL,
    events: client.events.map((e) => ({ event: e.event, data: e.data })),
    results,
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main()

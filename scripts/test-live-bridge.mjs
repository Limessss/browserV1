/**
 * 快速测试 Live Bridge 接管
 * 用法: node scripts/test-live-bridge.mjs [profileCode]
 */
import WS from 'ws'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const PROFILE = process.argv[2] || 'BUPM2Z'
const WS_URL = 'ws://127.0.0.1:19876/api/live-bridge'
const OUT_DIR = join(process.cwd(), 'scripts', '_live_bridge_test')

const ws = new WS(WS_URL)
const pending = new Map()
let seq = 0

function sendCmd(cmd, args = {}) {
  return new Promise((resolve, reject) => {
    const id = 't' + (++seq)
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`timeout: ${cmd}`))
    }, 60000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    ws.send(JSON.stringify({ id, cmd, args }))
  })
}

ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw))
  if (msg.type === 'event') {
    console.log(`[event] ${msg.event}:`, JSON.stringify(msg.data).slice(0, 200))
    return
  }
  const p = pending.get(msg.id)
  if (p) {
    pending.delete(msg.id)
    p(msg)
  }
})

ws.on('error', (e) => {
  console.error('[ws error]', e.message)
  process.exit(1)
})

await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
  setTimeout(() => reject(new Error('connect timeout')), 5000)
})
console.log('✓ WebSocket 已连接')

// 连接 profile
console.log(`→ 连接 profile: ${PROFILE}`)
const prof = await sendCmd('profile', { code: PROFILE })
if (!prof.ok) {
  console.error('✗ profile 失败:', prof.error)
  ws.close()
  process.exit(1)
}
console.log('✓ profile 已连接:', JSON.stringify(prof.result))

// 获取当前 URL
const urlRes = await sendCmd('url')
console.log('→ 当前 URL:', urlRes.ok ? urlRes.result?.url : urlRes.error)

// 截图
console.log('→ 截图中...')
const shot = await sendCmd('screenshot', { fullPage: false })
if (shot.ok && shot.result?.imageBase64) {
  await mkdir(OUT_DIR, { recursive: true })
  const buf = Buffer.from(shot.result.imageBase64, 'base64')
  const path = join(OUT_DIR, `${PROFILE}_screenshot.png`)
  await writeFile(path, buf)
  console.log(`✓ 截图已保存: ${path} (${buf.length} bytes)`)
} else {
  console.error('✗ 截图失败:', shot.error)
}

// 读取 DOM 摘要
const dom = await sendCmd('read_dom', { maxChars: 500 })
if (dom.ok) {
  const text = (dom.result?.text || '').replace(/\s+/g, ' ').trim()
  console.log('→ DOM 摘要:', text.slice(0, 300) || '(空)')
} else {
  console.error('✗ read_dom 失败:', dom.error)
}

ws.close()
console.log('完成')

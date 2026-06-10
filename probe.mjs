import WS from 'ws'
import { writeFile, mkdir } from 'node:fs/promises'
const ws = new WS('ws://127.0.0.1:19876/api/live-bridge')
const pending = new Map()
let seq = 0
function sendCmd(cmd, args) {
 return new Promise((resolve) => {
 const id = 'r' + (++seq)
 pending.set(id, resolve)
 ws.send(JSON.stringify({ id, cmd, args }))
 })
}
ws.on('message', (raw) => {
 const msg = JSON.parse(String(raw))
 if (msg.type === 'event') return
 const p = pending.get(msg.id)
 if (p) { pending.delete(msg.id); p(msg) }
})
await new Promise(r => ws.once('open', r))
await new Promise(r => setTimeout(r, 500))

const dir = 'C:\\Users\\Lin\\Desktop\\browserV1\\playwright_scripts\\tiktok_auto_keyword_submit\\_temp\\debug_reports'
await mkdir(dir, { recursive: true })
async function shot(label) {
 const r = await sendCmd('screenshot', { fullPage: false })
 if (r.ok) {
 const buf = Buffer.from(r.result.imageBase64, 'base64')
 await writeFile(`${dir}\\${label}.png`, buf)
 console.log(`  [shot] ${label}.png (${buf.length}B)`)
 }
}

// 1) 看下"客户消息 1"这个 span 在哪个父级 a/button 上
console.log('==== 1: 找"客户消息"导航项的父级 ====')
const r1 = await sendCmd('evaluate', { expression: '(() => { const spans = Array.from(document.querySelectorAll("span")); const target = spans.find(s => s.textContent.trim() === "客户消息"); if (!target) return "not found"; const link = target.closest("a") || target.closest("div[role=link]") || target.closest("button"); return JSON.stringify({ tag: target.tagName, parent: link?.tagName, href: link?.getAttribute("href"), onclick: !!link?.onclick, parentText: link?.textContent?.trim().slice(0, 50) }); })()' })
console.log(' ', r1.result?.result)

console.log('\n==== 2: 直接 navigate to /im/notification 或 /msg ====')
for (const url of [
 'https://seller.tiktokshopglobalselling.com/im/notification?shop_region=MY',
 'https://seller.tiktokshopglobalselling.com/notification/im?shop_region=MY',
 'https://seller.tiktokshopglobalselling.com/buyer-im/notification?shop_region=MY',
 'https://seller.tiktokshopglobalselling.com/msg/notification?shop_region=MY',
 'https://seller.tiktokshopglobalselling.com/inbox?shop_region=MY',
 'https://seller.tiktokshopglobalselling.com/im?shop_region=MY',
]) {
 const r = await sendCmd('navigate', { url })
 console.log(' ', url, '→', r.result?.url)
 await new Promise(r => setTimeout(r, 3000))
 const rd = await sendCmd('read_dom', { maxChars: 600 })
 if (rd.ok) {
 const text = rd.result.text || ''
 // 检测页面是否包含"会话/对话/未读"等关键词
 if (/消息|未读|会话|对话|买家|chat|inbox/i.test(text)) {
 console.log('   *** 找到消息页!text 含 消息|未读|会话|对话|买家|chat|inbox ***')
 console.log('   text snippet:', text.replace(/\s+/g, ' ').slice(0, 400))
 // 截图
 await shot('msg try ' + url.split('/').slice(-2).join('-').slice(0,30))
 }
 }
}

ws.close()
process.exit(0)
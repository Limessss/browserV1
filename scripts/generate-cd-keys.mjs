#!/usr/bin/env node
/**
 * 离线生成客户端扩容兑换码（与 backend/src/internal/license-service.ts 中逻辑一致）。
 *
 * 用法:
 *   node scripts/generate-cd-keys.mjs [数量]
 *   node scripts/generate-cd-keys.mjs 5
 *
 * 数量范围 1–1000，默认 1。每行输出一个完整兑换码。
 */

import { createHash, randomInt } from 'node:crypto'

const SALT = 'NEX-LITE-KEY-SALT-VER-1'
const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const MIN_COUNT = 1
const MAX_COUNT = 1000

function generateChecksum(payload) {
  const hash = createHash('sha256').update(payload + SALT).digest('hex')
  return hash.slice(0, 8).toUpperCase()
}

function generateOneKey() {
  let b = ''
  for (let j = 0; j < 16; j++) {
    b += CHARSET[randomInt(CHARSET.length)]
  }
  const part = (from, to) => b.slice(from, to)
  const payload = `NEX-${part(0, 4)}-${part(4, 8)}-${part(8, 12)}-${part(12, 16)}`
  const checksum = generateChecksum(payload)
  return `${payload}-${checksum}`
}

function parseCount(argv) {
  const raw = argv[2]
  if (raw === undefined || raw === '') return 1
  const n = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(n)) {
    throw new Error(`无效的数量: ${raw}`)
  }
  return n
}

const count = parseCount(process.argv)
if (count < MIN_COUNT || count > MAX_COUNT) {
  console.error(`数量须在 ${MIN_COUNT}–${MAX_COUNT} 之间`)
  process.exit(1)
}

for (let i = 0; i < count; i++) {
  console.log(generateOneKey())
}

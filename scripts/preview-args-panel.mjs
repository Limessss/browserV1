#!/usr/bin/env node
/**
 * 仅打开脚本参数面板 Tab（不跑业务），可选截图后保持浏览器不关。
 *
 * node scripts/preview-args-panel.mjs --useLaunchApi --code AF7H54 \
 *   --scriptDir playwright_scripts/tiktok_product_optimizer_batch_update --keepOpen
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { openScriptArgsPanel } from '../playwright_scripts/_lib/script_args_panel.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEBUG_READY_RETRY = 35
const DEBUG_READY_INTERVAL_MS = 1000

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx !== -1 && idx + 1 < process.argv.length) return String(process.argv[idx + 1] || '').trim()
  const inline = process.argv.find((arg) => arg.startsWith(`${flagName}=`))
  return inline ? inline.slice(flagName.length + 1).trim() : ''
}

function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options)
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`)
  return json
}

async function launchProfile(baseUrl, code) {
  const json = await requestJson(new URL('/api/launch', baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, launchArgs: ['about:blank'] }),
  })
  const cdpUrl =
    json?.cdpUrl ||
    json?.data?.cdpUrl ||
    json?.debuggingUrl ||
    json?.data?.debuggingUrl ||
    json?.wsEndpoint ||
    json?.data?.wsEndpoint ||
    baseUrl
  return cdpUrl
}

async function waitUntilDebugReady(cdpUrl) {
  for (let i = 0; i < DEBUG_READY_RETRY; i += 1) {
    try {
      const res = await fetch(new URL('/json/version', cdpUrl).toString())
      if (res.ok) return true
    } catch {
      /* retry */
    }
    await sleep(DEBUG_READY_INTERVAL_MS)
  }
  return false
}

async function main() {
  const scriptDirRel = getArgValue('--scriptDir') || 'playwright_scripts/tiktok_product_optimizer_batch_update'
  const scriptDir = path.resolve(ROOT, scriptDirRel)
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const code = getArgValue('--code') || 'AF7H54'
  const keepOpen = hasFlag('--keepOpen')

  let browser
  let cdpUrl = getArgValue('--cdp')

  if (hasFlag('--useLaunchApi') || !cdpUrl) {
    cdpUrl = await launchProfile(baseUrl, code)
    const ready = await waitUntilDebugReady(cdpUrl)
    if (!ready) throw new Error(`CDP not ready: ${cdpUrl}`)
    browser = await chromium.connectOverCDP(cdpUrl)
  } else {
    browser = await chromium.connectOverCDP(cdpUrl)
  }

  const panelPage = await openScriptArgsPanel(browser, { scriptDir })
  if (!panelPage) throw new Error('openScriptArgsPanel returned null')

  await panelPage.waitForTimeout(800)
  await panelPage.bringToFront()

  const outDir = path.join(ROOT, 'playwright_scripts', '_coord', 'artifacts')
  await fs.mkdir(outDir, { recursive: true })
  const shotPath = path.join(outDir, 'args-panel-form-preview.png')
  await panelPage.screenshot({ path: shotPath, fullPage: true })
  console.log(`[preview-args-panel] 截图已保存：${shotPath}`)
  console.log(`[preview-args-panel] 请在浏览器中切换到标题含「脚本参数」或「${path.basename(scriptDir)}」的新 Tab`)

  if (!keepOpen) {
    await browser.close()
  } else {
    console.log('[preview-args-panel] --keepOpen：浏览器保持打开')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

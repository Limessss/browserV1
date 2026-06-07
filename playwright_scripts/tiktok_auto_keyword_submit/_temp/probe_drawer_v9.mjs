#!/usr/bin/env node

/**
 * TikTok 自动关键词提报 - 抽屉 step 探针 v9。
 *
 * 打开 trending_keywords 页面，模拟点击第一个 lead 行 trigger，dump：
 *  - 抽屉是否出现、class 是什么；
 *  - "选择商品"按钮文本；
 *  - input 候选（placeholder）；
 *  - "下一步 / Next" 按钮；
 *  - "提交 / Submit" 按钮；
 *  - searchTag 推荐关键词标签。
 *
 * 用法：
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_drawer_v9.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH
 */

import { chromium } from 'playwright'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TRENDING_KEYWORDS_URL =
  'https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords'
const DEFAULT_LAUNCH_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_LAUNCH_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_LAUNCH_AUTH_KEY = process.env.LAUNCH_API_KEY || ''

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}
function hasFlag(flagName) { return process.argv.includes(flagName) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function logStep(msg) { process.stdout.write(`[drawerv9 ${new Date().toLocaleTimeString()}] ${msg}\n`) }
function buildLaunchHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_LAUNCH_AUTH_KEY) headers[DEFAULT_LAUNCH_AUTH_HEADER] = DEFAULT_LAUNCH_AUTH_KEY
  return headers
}
function buildTrendingUrl(shopRegion) {
  const u = new URL(TRENDING_KEYWORDS_URL)
  const region = String(shopRegion || '').trim().toUpperCase()
  if (region) u.searchParams.set('shop_region', region)
  return u.toString()
}
function resolveSelector() {
  const code = getArgValue('--code') || 'GMNQ5O'
  const profileId = getArgValue('--profileId')
  const profileName = getArgValue('--profileName')
  const keyword = getArgValue('--keyword')
  const matchMode = getArgValue('--matchMode') || 'first'
  if (profileId) return { profileId, matchMode }
  if (profileName) return { profileName, matchMode }
  if (keyword) return { keyword, matchMode }
  return { code, matchMode }
}
async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  let payload = null
  try { payload = await response.json() } catch { /* ignore */ }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload ? String(payload.error) : `HTTP ${response.status}`
    throw new Error(`${message} (${url})`)
  }
  return payload
}
async function connectViaLaunchApi(baseUrl, startUrl) {
  logStep(`checking Launch API health: ${baseUrl}`)
  await requestJson(`${baseUrl}/api/health`, { method: 'GET', headers: buildLaunchHeaders() })
  logStep(`launching profile at: ${startUrl}`)
  // launch API 在前一会话 Browser.close 后可能短暂拒绝；做 1 次重试
  const launchHeaders = buildLaunchHeaders()
  logStep(`launch headers: ${JSON.stringify(launchHeaders)}`)
  const launchBody = JSON.stringify({
    selector: resolveSelector(),
    launchArgs: ['--window-size=1440,960'],
    startUrls: [startUrl],
    skipDefaultStartUrls: true,
  })
  logStep(`launch body: ${launchBody}`)
  let launchResponse
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      logStep(`launch attempt ${attempt} request: ${launchBody.slice(0, 200)}...`)
      launchResponse = await requestJson(`${baseUrl}/api/launch`, {
        method: 'POST',
        headers: launchHeaders,
        body: launchBody,
      })
      break
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logStep(`launch attempt ${attempt} failed: ${msg}`)
      if (attempt >= 3) throw e
      await sleep(2500)
    }
  }
  let ready = launchResponse
  const launchCode = String(launchResponse?.launchCode || '').trim()
  for (let i = 0; launchCode && !ready?.debugReady && i < 12; i += 1) {
    await sleep(500)
    ready = await requestJson(`${baseUrl}/api/launch/${encodeURIComponent(launchCode)}`, {
      method: 'GET',
      headers: buildLaunchHeaders(),
    })
  }
  const cdpUrl = String(ready?.cdpUrl || '').trim()
  if (!cdpUrl) throw new Error('Launch API did not return cdpUrl')
  logStep(`connecting CDP: ${cdpUrl}`)
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  return { browser, page, cdpUrl, launchResponse: ready }
}

async function main() {
  const shopRegion = String(getArgValue('--shop_region') || 'PH').trim().toUpperCase()
  const targetUrl = buildTrendingUrl(shopRegion)
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_LAUNCH_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const navTimeoutMs = Number(getArgValue('--nav_timeout_ms') || 120_000)
  const waitMs = Number(getArgValue('--wait_ms') || 8_000)
  const keyword = getArgValue('--keyword') || "Cotton Spandex Cross Over Blouse"
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')
  await mkdir(outDir, { recursive: true })

  const drawerScriptText = await readFile(path.join(scriptDir, 'drawer_probe_script.js'), 'utf8')

  const conn = useLaunchApi ? await connectViaLaunchApi(baseUrl, targetUrl) : (async () => {
    const b = await chromium.connectOverCDP(cdpUrl)
    return { browser: b, page: b.contexts()[0].pages()[0] }
  })()
  const { browser, page } = conn
  const result = {
    code: getArgValue('--code') || 'GMNQ5O',
    ok: false,
    targetUrl,
    cdpUrl: conn.cdpUrl || '',
    keyword,
    drawerResult: null,
    errors: [],
  }

  try {
    logStep('navigating trending keywords page')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`initial wait ${waitMs}ms`)
    await sleep(waitMs)
    logStep(`running drawer probe (target keyword="${keyword}")`)
    // 用 IIFE 把 keyword 注入到 window，再调 drawer 脚本
    const wrapped = `(() => { window.__PENDING_KEYWORD__ = ${JSON.stringify(keyword)}; return (${drawerScriptText})(); })()`
    result.drawerResult = await page.evaluate(wrapped)
    logStep(`drawerResult.ok=${result.drawerResult?.ok}, drawerPresent=${result.drawerResult?.drawerPresent}, selectProductButtonCount=${result.drawerResult?.selectProductButtonCount}, inputCount=${result.drawerResult?.inputCandidates?.length}`)
    if (result.drawerResult?.error) {
      result.errors.push(result.drawerResult.error)
    } else if (result.drawerResult?.drawerPresent) {
      result.ok = true
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logStep(`FAILED: ${result.errors[0]}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_drawer_v9_${stamp}.json`)
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8').catch(() => {})
    result.jsonPath = jsonPath
    logStep(`JSON: ${jsonPath}`)
    console.log(JSON.stringify(result, null, 2))
    if (keepOpen) {
      logStep('--keepOpen set')
      await new Promise(() => {})
    } else {
      await browser.close().catch(() => {})
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

#!/usr/bin/env node

/**
 * TikTok 自动关键词提报 - lead/list API 探针 v6。
 *
 * v3-v5 已确认 DOM 端无法拿到完整关键词（虚拟滚动只渲染 12 行）。
 * v6 直接走 TikTok opportunity 站内接口：
 *   POST /api/v1/product/oc/seller_product_opportunity/seller/lead/list
 *   body: { opportunity_type: 2, use_like: false, sort_field: 1,
 *           page_number: 1, page_size: 20, traffic_source: 'seller_organic',
 *           tab_code_filter: ['trending_keyword', 'all'] }
 *   headers: x-tt-oec-region, referer, etc.
 *
 * 输出：HTTP 状态、code/message、total_product_count、data[] 真实字段、lead_name 样本。
 *
 * 用法：
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_api_v6.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH --pageSize 20
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
function logStep(msg) { process.stdout.write(`[apiv6 ${new Date().toLocaleTimeString()}] ${msg}\n`) }
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
  const launchResponse = await requestJson(`${baseUrl}/api/launch`, {
    method: 'POST',
    headers: buildLaunchHeaders(),
    body: JSON.stringify({
      selector: resolveSelector(),
      launchArgs: ['--window-size=1440,960'],
      startUrls: [startUrl],
      skipDefaultStartUrls: true,
    }),
  })
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
  const pageSize = Number(getArgValue('--pageSize') || 20)
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')
  await mkdir(outDir, { recursive: true })

  const apiScriptText = await readFile(path.join(scriptDir, 'lead_list_script.js'), 'utf8')
  // 替换 pageSize 默认
  const apiScriptPatched = apiScriptText.replace('page_size: 20,', `page_size: ${pageSize},`)

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
    pageSize,
    result: null,
    errors: [],
  }

  try {
    logStep('navigating trending keywords page')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`initial wait ${waitMs}ms`)
    await sleep(waitMs)
    logStep(`calling lead/list via main world (page_size=${pageSize})`)
    result.result = await page.evaluate(`(${apiScriptPatched})()`)
    result.ok = result.result?.ok && result.result?.code === 0
    logStep(`HTTP ${result.result?.status}, code=${result.result?.code}, message="${result.result?.message}", dataLength=${result.result?.dataLength}, totalProductCount=${result.result?.totalProductCount}`)
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logStep(`FAILED: ${result.errors[0]}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_api_v6_${stamp}.json`)
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

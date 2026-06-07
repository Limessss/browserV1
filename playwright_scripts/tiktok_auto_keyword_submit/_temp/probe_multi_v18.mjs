#!/usr/bin/env node

/**
 * v18 探针：多商品勾选 + 一次性提交。
 * 用真实 productIds 数组（3 个），先循环搜索勾选，再"下一步"+"提交"。
 * ⚠️ 真实提交：探针会向 TikTok 机会系统提交。
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
function logStep(msg) { process.stdout.write(`[v18 ${new Date().toLocaleTimeString()}] ${msg}\n`) }
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
  const matchMode = getArgValue('--matchMode') || 'first'
  if (profileId) return { profileId, matchMode }
  if (profileName) return { profileName, matchMode }
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
  const cdpUrl = String(launchResponse?.cdpUrl || '').trim()
  if (!cdpUrl) throw new Error('Launch API did not return cdpUrl')
  logStep(`connecting CDP: ${cdpUrl}`)
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  return { browser, page, cdpUrl, launchResponse }
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
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')
  await mkdir(outDir, { recursive: true })

  // 真实 3 个 productId（v17 拿到的列表，挑 3 个能搜到的）
  const productIds = [
    '1735873998701954740', // Thin Women's Shirt Summer New Design ...
    '1735858919516309172', // Elastic Satin Includes Neckband ...
    '1735858737446291124', // European and American Style ...
  ]
  const keyword = 'lautner neck'

  const scriptText = await readFile(path.join(scriptDir, 'multi_select_script.js'), 'utf8')
  const conn = useLaunchApi ? await connectViaLaunchApi(baseUrl, targetUrl) : (async () => {
    const b = await chromium.connectOverCDP(cdpUrl)
    return { browser: b, page: b.contexts()[0].pages()[0] }
  })()
  const { browser, page } = conn
  const result = { code: getArgValue('--code') || 'GMNQ5O', ok: false, targetUrl, cdpUrl: conn.cdpUrl || '', productIds, keyword, multiResult: null, errors: [] }
  try {
    logStep('navigating')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`waiting ${waitMs}ms`)
    await sleep(waitMs)
    logStep(`⚠️ 真实提交：3 个 productId, keyword="${keyword}"`)
    const wrapped = `(() => { window.__PENDING_KEYWORD__ = ${JSON.stringify(keyword)}; return (${scriptText})(${JSON.stringify(productIds)}); })()`
    result.multiResult = await page.evaluate(wrapped)
    result.ok = !!result.multiResult
    for (const r of result.multiResult.steps || []) {
      logStep(`step=${r.step}: ${r.productId || ''} checked=${r.checked || ''} error=${r.error || ''}`)
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logStep(`FAILED: ${result.errors[0]}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_multi_v18_${stamp}.json`)
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

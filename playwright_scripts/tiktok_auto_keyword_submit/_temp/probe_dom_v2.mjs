#!/usr/bin/env node

/**
 * TikTok 自动关键词提报 - DOM 关键词提取 v2 探针。
 *
 * 由 probe_keyword_submit.mjs 第一次跑通发现：DOM 表格行数=0。
 * 真实 trending_keywords 页可能：
 *  - 用虚拟滚动 / virtual-list（只渲染可见行），需等待或滚动；
 *  - 用 .arco-list / .pulse-list 等其他组件库；
 *  - 需先点击 trending_keywords tab 才会渲染；
 *  - 嵌在 iframe 里；
 *  - 渲染较慢，需要等接口数据。
 *
 * 本探针不调 ERP，只诊断 DOM/视觉状态，输出 5 类信号：
 *   (1) 真实可见 .core-table / .pulse / .arco 容器与行数；
 *   (2) 包含"Trending keyword"或"推荐关键词"等中文的容器；
 *   (3) 候选关键词文本（前缀过滤后）；
 *   (4) 可见 tab / button 列表（含 "trending keyword" / "Trending keywords" / 全部 / 行业 / "立即使用" / "+提报" / "关联商品"）；
 *   (5) iframe / shadowRoot 存在性。
 *
 * 用法：
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_dom_v2.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH
 */

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
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
function hasFlag(flagName) {
  return process.argv.includes(flagName)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
function logStep(msg) {
  process.stdout.write(`[domv2 ${new Date().toLocaleTimeString()}] ${msg}\n`)
}
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

const DOM_DIAG_JS = `() => {
  const compact = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const visible = (el) => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    const st = window.getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  const allRoots = [document]
  const seenRoots = new Set([document])
  const stack = [document]
  while (stack.length) {
    const root = stack.shift()
    const all = root.querySelectorAll ? root.querySelectorAll('*') : []
    for (const el of all) {
      if (el.shadowRoot && !seenRoots.has(el.shadowRoot)) {
        seenRoots.add(el.shadowRoot)
        allRoots.push(el.shadowRoot)
        stack.push(el.shadowRoot)
      }
      if (el.tagName === 'IFRAME') {
        try {
          const d = el.contentDocument
          if (d && !seenRoots.has(d)) {
            seenRoots.add(d)
            allRoots.push(d)
            stack.push(d)
          }
        } catch (_) { /* ignore */ }
      }
    }
  }
  const deepQueryAll = (selector) => {
    const out = []
    for (const root of allRoots) {
      try {
        if (root.querySelectorAll) root.querySelectorAll(selector).forEach((el) => out.push(el))
      } catch (_) { /* ignore */ }
    }
    return Array.from(new Set(out))
  }

  const containerSelectors = [
    '.core-table',
    '.core-table-body',
    '.core-table-content',
    '.core-table-content-inner',
    '.core-table tbody',
    'tr.core-table-tr',
    '.pulse-table',
    '.pulse-list',
    '.arco-table',
    '.arco-table-body',
    '.arco-list',
    '.virtual-list',
    '.virtual-list-holder',
    '[class*="VirtualList"]',
    '[class*="virtual"]',
    '[class*="List"]',
    '[class*="list"]',
    '[class*="Table"]',
    '[class*="table"]',
  ]
  const containerCounts = {}
  for (const sel of containerSelectors) {
    const nodes = deepQueryAll(sel)
    containerCounts[sel] = {
      total: nodes.length,
      visible: nodes.filter(visible).length,
    }
  }

  const candidateWordsRe = /^[A-Za-z][A-Za-z0-9 &.'\\-]{1,60}$/
  const stopRe = /(商家中心|客户消息|商家助手|机会详情|提报指南|机会趋势|推荐关键词|商品提报要求|Trending keyword|trending keyword|使用此关键词|立即使用|查看更多|展开|收起|机会类型|关联商品|提交|下一步|选择商品|Select product|Submit|Next|Operation|操作)/i
  const allTd = deepQueryAll('td')
  const cellSamples = allTd
    .filter(visible)
    .map((el) => compact(el.textContent))
    .filter((t) => t && t.length >= 2 && t.length <= 80 && candidateWordsRe.test(t) && !stopRe.test(t))
    .slice(0, 80)
  const divSamples = deepQueryAll('div, span, p')
    .map((el) => compact(el.textContent))
    .filter((t) => t && t.length >= 2 && t.length <= 60 && candidateWordsRe.test(t) && !stopRe.test(t))
    .slice(0, 80)

  const tabTexts = []
  for (const root of allRoots) {
    try {
      const tabs = root.querySelectorAll ? root.querySelectorAll('[role="tab"], .core-tabs-tab, .core-tabs-tab-btn, .arco-tabs-tab, .pulse-tabs-tab, [class*="tabItem"]') : []
      tabs.forEach((el) => {
        if (visible(el)) tabTexts.push(compact(el.textContent) || el.getAttribute('aria-label') || '')
      })
    } catch (_) { /* ignore */ }
  }

  const buttonTexts = []
  for (const root of allRoots) {
    try {
      const btns = root.querySelectorAll ? root.querySelectorAll('button, [role="button"]') : []
      btns.forEach((el) => {
        if (visible(el)) {
          const t = compact(el.textContent) || el.getAttribute('aria-label') || ''
          if (t) buttonTexts.push(t)
        }
      })
    } catch (_) { /* ignore */ }
  }

  const bodyText = compact(document.body?.innerText || '').slice(0, 8000)

  return {
    url: location.href,
    title: document.title,
    rootsCount: allRoots.length,
    iframeCount: allRoots.filter((r) => r !== document).length,
    containerCounts,
    cellSamples,
    divSamples,
    tabTexts: Array.from(new Set(tabTexts)).slice(0, 40),
    buttonSamples: Array.from(new Set(buttonTexts)).slice(0, 60),
    bodyPreview: bodyText,
    bodyLength: bodyText.length,
  }
}`

async function captureDomSnapshot(page) {
  return page.evaluate(`(${DOM_DIAG_JS})()`)
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
  const rerunAfterMs = Number(getArgValue('--rerun_after_ms') || 4_000)
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')

  await mkdir(outDir, { recursive: true })
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
    rounds: [],
    errors: [],
  }

  try {
    logStep('navigating trending keywords page')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`initial wait ${waitMs}ms`)
    await sleep(waitMs)
    result.rounds.push({ round: 1, waitAfterMs: waitMs, snapshot: await captureDomSnapshot(page) })

    if (rerunAfterMs > 0) {
      logStep(`rerun snapshot after ${rerunAfterMs}ms`)
      await sleep(rerunAfterMs)
      result.rounds.push({ round: 2, waitAfterMs: rerunAfterMs, snapshot: await captureDomSnapshot(page) })
    }

    const first = result.rounds[0].snapshot
    const totalKeywordLike =
      (first.cellSamples?.length || 0) + (first.divSamples?.length || 0)
    if (totalKeywordLike > 0) {
      result.ok = true
      logStep(`OK: candidate keyword-like cells=${totalKeywordLike}`)
    } else {
      logStep('NO keyword candidates found in DOM yet')
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logStep(`FAILED: ${result.errors[0]}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_dom_v2_${new Date().toISOString().slice(0, 10)}_${stamp}.json`)
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

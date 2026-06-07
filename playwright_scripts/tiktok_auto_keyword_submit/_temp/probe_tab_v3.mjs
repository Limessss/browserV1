#!/usr/bin/env node

/**
 * TikTok 自动关键词提报 - tab 切换 v3 探针。
 *
 * 由 probe_dom_v2 发现：URL tab=trending_keywords 没有真正切到「热门关键词」tab。
 * 当前显示的列头是「关键词 / 参考图片 / 潜在商家来源 / 搜索次数 / 在售商品 / 操作」，
 * 但行内是产品描述（"Women's Satin Long Sleeve Blouse"）而非关键词。
 *
 * 本探针依次：
 *   (1) 列出全部 tab 节点 + 激活状态（aria-selected / class / 文本）；
 *   (2) 强制点击 "热门关键词" tab（若无则匹配英文 trending keyword）；
 *   (3) 等 5s 后重新 dump 表格，截断 bodyText 前 2000 字符；
 *   (4) 滚动到底部再次 dump，看是否触发虚拟列表补齐。
 *
 * 用法：
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_tab_v3.mjs \
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
function hasFlag(flagName) { return process.argv.includes(flagName) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function logStep(msg) { process.stdout.write(`[tabv3 ${new Date().toLocaleTimeString()}] ${msg}\n`) }
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

const SNAPSHOT_JS = `() => {
  const compact = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
  const visible = (el) => {
    if (!el || !el.isConnected) return false
    const r = el.getBoundingClientRect()
    const st = window.getComputedStyle(el)
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
  }
  // 1) tab 节点（包含子标题 div）
  const tabSelectors = [
    '[role="tab"]',
    '.core-tabs-tab',
    '.core-tabs-tab-btn',
    '.pulse-tabs-tab',
    '.arco-tabs-tab',
    '[class*="tabItem"]',
    '[class*="tab-item"]',
    '[class*="tabItem-active"]',
    '[class*="tabItemActive"]',
  ]
  const seen = new Set()
  const tabs = []
  for (const sel of tabSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (seen.has(el)) return
      seen.add(el)
      const text = compact(el.textContent) || compact(el.getAttribute('aria-label'))
      if (!text) return
      tabs.push({
        selector: sel,
        text,
        ariaSelected: el.getAttribute('aria-selected'),
        className: compact(String(el.className || '')).slice(0, 200),
        active: /active|selected|current/i.test(String(el.className || '')) || el.getAttribute('aria-selected') === 'true',
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })(),
      })
    })
  }
  // 2) 真实可见 table 行（排除空表头）
  const rows = Array.from(document.querySelectorAll('tr.core-table-tr, .core-table-body tr, .pulse-table tr, .core-table tr, .core-table-content-inner tr'))
    .filter(visible)
    .map((tr) => {
      const cells = Array.from(tr.querySelectorAll('td, th')).map((c) => compact(c.textContent).slice(0, 120))
      return { rowText: compact(tr.textContent).slice(0, 300), cells }
    })
    .slice(0, 30)
  // 3) 列表头
  const headers = Array.from(document.querySelectorAll('thead th, .core-table-thead th, .pulse-table-thead th, .core-table thead th'))
    .map((th) => compact(th.textContent)).filter(Boolean)
  // 4) 滚动容器
  const scrollContainers = ['.core-table-body', '.core-table-content', '.core-table-content-inner', '.virtual-list', '.pulse-table-body', '[class*="virtual"]']
    .map((sel) => {
      const el = document.querySelector(sel)
      if (!el || !visible(el)) return { selector: sel, present: false }
      return {
        selector: sel,
        present: true,
        scrollTop: el.scrollTop,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      }
    })
  return {
    url: location.href,
    title: document.title,
    tabs,
    tableHeaders: headers,
    visibleRows: rows,
    visibleRowCount: rows.length,
    scrollContainers,
    bodyTail: compact(document.body?.innerText || '').slice(-2400),
  }
}`

async function captureSnapshot(page) {
  return page.evaluate(`(${SNAPSHOT_JS})()`)
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
    result.rounds.push({ phase: 'initial', waitAfterMs: waitMs, snapshot: await captureSnapshot(page) })

    // 查找 "热门关键词" tab
    const initial = result.rounds[0].snapshot
    const trendingTab = initial.tabs.find((t) => /热门关键词|trending[\s_-]*keyword/i.test(t.text))
    if (trendingTab) {
      logStep(`found trending tab: "${trendingTab.text}", active=${trendingTab.active}, rect=${JSON.stringify(trendingTab.rect)}`)
      if (!trendingTab.active) {
        logStep('clicking trending tab')
        await page.evaluate((text) => {
          const targets = Array.from(document.querySelectorAll('[role="tab"], .core-tabs-tab, .core-tabs-tab-btn, .pulse-tabs-tab, .arco-tabs-tab, [class*="tabItem"], [class*="tab-item"]'))
            .filter((el) => {
              const t = String(el.textContent || '').replace(/\s+/g, ' ').trim()
              return t === text || t.includes(text) || /热门关键词|trending[\s_-]*keyword/i.test(t)
            })
          if (targets[0]) targets[0].click()
        }, trendingTab.text)
        await sleep(5000)
        result.rounds.push({ phase: 'after-click-trending', waitAfterMs: 5000, snapshot: await captureSnapshot(page) })
      }
    } else {
      logStep('trending tab not found by selectors')
    }

    // 滚动到底部看虚拟列表是否补齐
    logStep('scrolling to bottom')
    await page.evaluate(() => {
      const sels = ['.core-table-body', '.core-table-content', '.core-table-content-inner', '.virtual-list', '.pulse-table-body', '[class*="virtual"]']
      sels.forEach((sel) => {
        const el = document.querySelector(sel)
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = el.scrollHeight
        }
      })
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' })
    })
    await sleep(3000)
    result.rounds.push({ phase: 'after-scroll-bottom', waitAfterMs: 3000, snapshot: await captureSnapshot(page) })

    const last = result.rounds[result.rounds.length - 1].snapshot
    result.ok = last.visibleRowCount > 0
    logStep(`final visibleRowCount=${last.visibleRowCount}`)
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
    logStep(`FAILED: ${result.errors[0]}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_tab_v3_${stamp}.json`)
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

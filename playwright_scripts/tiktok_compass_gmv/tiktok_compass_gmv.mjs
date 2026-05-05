#!/usr/bin/env node

/**
 * TikTok Shop Compass：数据概览 → 读取「当天」GMV 展示值。
 * 流程对齐 MCP：同目录 `mcp_tiktok_compass_gmv.md`；成对约定见上级 `../README.md`。
 *
 * 须已在本机浏览器登录卖家中心；无 Cookie 时会停在登录页。
 * 连接方式与 `../tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs` 相同。
 *
 * 示例：
 *   node playwright_scripts/tiktok_compass_gmv/tiktok_compass_gmv.mjs --useLaunchApi --code ICHPPH--shop_region PH
 *   node playwright_scripts/tiktok_compass_gmv/tiktok_compass_gmv.mjs --cdp http://127.0.0.1:19876 --shop_region PH
 */

import { chromium } from 'playwright'

const COMPASS_PATH = '/compass/data-overview'

/** @param {string} shopRegion 如 PH、US、ID；空则不带 shop_region */
function buildCompassUrl(shopRegion) {
  const base = 'https://seller.tiktokshopglobalselling.com'
  const u = new URL(COMPASS_PATH, base)
  const r = String(shopRegion || '').trim()
  if (r) u.searchParams.set('shop_region', r)
  return u.toString()
}

const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 12
const DEBUG_READY_INTERVAL_MS = 500

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}

function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_AUTH_KEY) {
    headers[DEFAULT_AUTH_HEADER] = DEFAULT_AUTH_KEY
  }
  return headers
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    /* ignore */
  }
  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : `HTTP ${response.status}`
    throw new Error(`${message} (${url})`)
  }
  return payload
}

async function checkHealth(baseUrl) {
  return requestJson(`${baseUrl}/api/health`, { method: 'GET', headers: buildHeaders() })
}

function resolveSelector() {
  const code = getArgValue('--code')
  const keyword = getArgValue('--keyword')
  const profileId = getArgValue('--profileId')
  const profileName = getArgValue('--profileName')
  const matchMode = getArgValue('--matchMode') || 'first'
  if (profileId) return { profileId, matchMode }
  if (profileName) return { profileName, matchMode }
  if (keyword) return { keyword, matchMode }
  if (code) return { code, matchMode }
  return { code: 'BUYER_001', matchMode: 'first' }
}

async function launchProfile(baseUrl, startUrl) {
  const selector = resolveSelector()
  const payload = {
    selector,
    launchArgs: ['--window-size=1400,900'],
    startUrls: [startUrl],
    skipDefaultStartUrls: true,
  }
  return requestJson(`${baseUrl}/api/launch`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  })
}

async function waitUntilDebugReady(baseUrl, initialResponse) {
  if (initialResponse?.debugReady) return initialResponse
  const code = String(initialResponse?.launchCode || '').trim()
  if (!code) return initialResponse
  for (let i = 0; i < DEBUG_READY_RETRY; i += 1) {
    await sleep(DEBUG_READY_INTERVAL_MS)
    const latest = await requestJson(`${baseUrl}/api/launch/${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: buildHeaders(),
    })
    if (latest?.debugReady) return latest
  }
  return initialResponse
}

async function connectViaLaunchApi(baseUrl, startUrl) {
  await checkHealth(baseUrl)
  const launchResponse = await launchProfile(baseUrl, startUrl)
  const readyResponse = await waitUntilDebugReady(baseUrl, launchResponse)
  const cdpUrl = String(readyResponse?.cdpUrl || '').trim()
  if (!cdpUrl) throw new Error('未拿到 cdpUrl')
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  return { browser, page, close: () => browser.close() }
}

async function connectBrowser({ headed, cdpUrl, launchEdge }) {
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    return { browser, page, close: () => browser.close() }
  }
  if (launchEdge) {
    const browser = await chromium.launch({ channel: 'msedge', headless: !headed })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    return { browser, page, close: () => browser.close() }
  }
  const browser = await chromium.launch({
    headless: !headed,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  })
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  return { browser, page, close: () => browser.close() }
}

/** @param {import('playwright').Page} page */
async function trySelectTodayRange(page) {
  const tryClick = async (locator) => {
    const n = await locator.count().catch(() => 0)
    if (n < 1) return false
    const first = locator.first()
    if (!(await first.isVisible().catch(() => false))) return false
    await first.click()
    await sleep(900)
    return true
  }

  if (await tryClick(page.getByRole('tab', { name: /^(Today|今日|1D|1\s*天)$/i }))) return true
  if (await tryClick(page.getByRole('button', { name: /^(Today|今日|1D)$/i }))) return true
  if (await tryClick(page.getByText(/^Today$/))) return true
  if (await tryClick(page.getByText(/^今日$/))) return true
  return false
}

/**
 * 数据概览 KPI：实测 DOM（CDP 调试 2026-05-03）主指标在 `.pcm-smc-wrapper`，
 * 当前选中项带 `.pcm-smc-wrapper-selected`；卡片合并文案形如 `GMV ₱ 1,215 .00`（小数点前可能有空格）。
 *
 * @param {import('playwright').Page} page
 */
async function extractGmvDisplay(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()

    const rangeMatch = (document.body.innerText || '').match(
      /(\d{4}\/\d{2}\/\d{2})\s*[-–]\s*(\d{4}\/\d{2}\/\d{2})/,
    )
    const pageDateRange = rangeMatch ? `${rangeMatch[1]} - ${rangeMatch[2]}` : null

    const wrappers = Array.from(document.querySelectorAll('.pcm-smc-wrapper'))
    const gmvCard =
      wrappers.find(
        (w) =>
          w.classList.contains('pcm-smc-wrapper-selected') && /\bGMV\b/i.test(w.innerText),
      ) || wrappers.find((w) => /\bGMV\b/i.test(compact(w.innerText)))

    if (gmvCard) {
      const raw = compact(gmvCard.innerText)
      const symMatch = raw.match(/\b(₱|\$|RM|PHP|USD|EUR|GBP|£|¥|Rp|IDR)\b/i)
      const numMatch = raw.match(/([\d,]+)\s*\.\s*(\d{2})/)
      let gmvText = null
      if (numMatch) {
        const sym = symMatch ? symMatch[1] : '₱'
        gmvText = `${sym} ${numMatch[1]}.${numMatch[2]}`
      }
      return {
        gmvText,
        source: 'pcm-smc-wrapper',
        cardPreview: raw.slice(0, 500),
        pageDateRange,
      }
    }

    /**
     * @param {string} text
     * @returns {string[]}
     */
    function moneyCandidates(text) {
      const re = /(?:[\$₱€£¥]\s*)?[\d][\d,]*(?:\.\d{1,4})?/g
      const out = text.match(re) || []
      return out.filter((x) => {
        const digits = x.replace(/[^\d]/g, '')
        return digits.length >= 1 && digits.length <= 18
      })
    }

    const labelOk = (t) => {
      const s = compact(t)
      if (s.length > 60) return false
      return /^(GMV|Gross merchandise value|总成交额|成交额)$/i.test(s)
    }

    const leaves = Array.from(document.querySelectorAll('span, div, p, h1, h2, h3, h4, td, th, label'))
    for (const el of leaves) {
      if (!labelOk(el.textContent || '')) continue
      let p = el.parentElement
      for (let depth = 0; depth < 12 && p; depth += 1) {
        const block = compact(p.innerText || p.textContent || '')
        if (!block || block.length > 900) {
          p = p.parentElement
          continue
        }
        const monies = moneyCandidates(block)
        if (monies.length) {
          monies.sort(
            (a, b) => b.replace(/[^\d]/g, '').length - a.replace(/[^\d]/g, '').length,
          )
          return {
            gmvText: monies[0],
            source: 'metric-card-fallback',
            cardPreview: block.slice(0, 420),
            pageDateRange,
          }
        }
        p = p.parentElement
      }
    }

    const body = compact(document.body.innerText || '')
    const idx = body.search(/\bGMV\b/i)
    if (idx >= 0) {
      const slice = body.slice(Math.max(0, idx - 24), Math.min(body.length, idx + 220))
      const monies = moneyCandidates(slice)
      if (monies.length) {
        monies.sort(
          (a, b) => b.replace(/[^\d]/g, '').length - a.replace(/[^\d]/g, '').length,
        )
        return {
          gmvText: monies[0],
          source: 'near-gmv-label',
          slicePreview: slice,
          pageDateRange,
        }
      }
    }

    return {
      gmvText: null,
      source: 'none',
      bodyPreview: body.slice(0, 1400),
      pageDateRange,
    }
  })
}

function localTodayYmd() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string }} opts
 */
async function runCompassGmvFlow(page, opts) {
  const { pageUrl } = opts
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
  await sleep(1200)
  const switched = await trySelectTodayRange(page)
  await sleep(800)

  const extracted = await extractGmvDisplay(page)

  return {
    ok: Boolean(extracted.gmvText),
    url: pageUrl,
    dateLocal: localTodayYmd(),
    /** 页面上「关键指标」旁展示的统计日期区间（与 GMV 同一筛选）；可能与日历「当天」不一致，请以页面为准。 */
    pageDateRange: extracted.pageDateRange ?? null,
    shopRegion: opts.shopRegion || '',
    timeRangeSwitchedToToday: switched,
    gmvText: extracted.gmvText,
    extractionSource: extracted.source,
    preview:
      extracted.cardPreview || extracted.slicePreview || extracted.bodyPreview || '',
  }
}

function resolveCompassOptions() {
  const shopRegion = getArgValue('--shop_region') || 'PH'
  const pageUrl = buildCompassUrl(shopRegion)
  return { pageUrl, shopRegion: String(shopRegion).trim() }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const cdpUrl =
    getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const flowOpts = resolveCompassOptions()

  let page
  let close
  if (useLaunchApi) {
    const conn = await connectViaLaunchApi(baseUrl, flowOpts.pageUrl)
    page = conn.page
    close = conn.close
  } else if (cdpUrl) {
    const conn = await connectBrowser({ headed, cdpUrl, launchEdge: false })
    page = conn.page
    close = conn.close
  } else if (launchEdge) {
    const conn = await connectBrowser({ headed, cdpUrl: '', launchEdge: true })
    page = conn.page
    close = conn.close
  } else {
    const conn = await connectBrowser({ headed, cdpUrl: '', launchEdge: false })
    page = conn.page
    close = conn.close
  }

  try {
    const result = await runCompassGmvFlow(page, flowOpts)
    console.log(JSON.stringify(result, null, 2))
    if (keepOpen) {
      await new Promise(() => {})
    }
  } finally {
    if (!keepOpen && close) await close()
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})

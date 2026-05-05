#!/usr/bin/env node

/**
 * 机会榜单 → 随机 3 条待开发商品 → 用 `cover` 作为图片 URL 列表，
 * 在 1688 图搜（填图 URL → 等 1s → 点「图 搜」）→ 打开第二条结果详情 → 将详情 HTML POST 到仓库采集接口（**不等待**服务端采集完成）；每张图处理完后关闭多余标签并回到图搜起始页 → 最后批量标记「已开发」。
 *
 * 依赖 ERP OpenAPI（ApiKey）：榜单列表、仓库采集、批量标记。
 *
 * 链氪 ERP 凭证（优先级从高到低）：
 *   1) 环境变量 ERP_API_KEY（可选 ERP_API_BASE）
 *   2) 命令行 --erpKey（可选 --erpBase）
 *   3) 应用「系统设置 → 第三方接口配置 → 链氪 ERP」，经 Launch GET /api/integrations/linkeoo-erp 读取（需本应用已保存 config.yaml）
 *
 * 示例：
 *   node ... --cdp http://127.0.0.1:19876
 *   node ... --useLaunchApi --code ICHPPH --erpKey erp_sk_xxx
 *
 * 成对文档：`mcp_tiktok_ranking_1688_image_collect.md`；约定见 `../README.md`。
 */

import { chromium } from 'playwright'

const OFFER_SEARCH_URL = 'https://s.1688.com/selloffer/offer_search.html'

const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 12
const DEBUG_READY_INTERVAL_MS = 500

const DEFAULT_ERP_BASE = 'https://api.linkeoo.com'

/**
 * @param {string} flagName
 * @returns {string}
 */
function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}

/**
 * @param {string} flagName
 */
function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function buildLaunchHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_AUTH_KEY) {
    headers[DEFAULT_AUTH_HEADER] = DEFAULT_AUTH_KEY
  }
  return headers
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {string} url
 * @param {RequestInit} [options]
 */
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
      payload && typeof payload === 'object' && 'detail' in payload
        ? String(/** @type {{ detail: unknown }} */ (payload).detail)
        : payload && typeof payload === 'object' && 'error' in payload
          ? String(/** @type {{ error: unknown }} */ (payload).error)
          : `HTTP ${response.status}`
    throw new Error(`${message} (${url})`)
  }
  return payload
}

async function checkHealth(baseUrl) {
  return requestJson(`${baseUrl}/api/health`, { method: 'GET', headers: buildLaunchHeaders() })
}

/**
 * 解析链氪 ERP：`ERP_*` 环境变量 → `--erpKey` → Launch `/api/integrations/linkeoo-erp`
 * @param {string} launchBaseUrl 一般为 `http://127.0.0.1:19876`，与 `--baseUrl` 一致
 * @returns {Promise<{ baseUrl: string, apiKey: string } | null>}
 */
async function resolveErpCredentials(launchBaseUrl) {
  const envKey = String(process.env.ERP_API_KEY || '').trim()
  const envBase = (process.env.ERP_API_BASE || DEFAULT_ERP_BASE).replace(/\/$/, '')
  if (envKey) {
    return { baseUrl: envBase, apiKey: envKey }
  }
  const cliKey = getArgValue('--erpKey').trim()
  const cliBase = getArgValue('--erpBase').trim()
  if (cliKey) {
    return { baseUrl: (cliBase || DEFAULT_ERP_BASE).replace(/\/$/, ''), apiKey: cliKey }
  }
  const base = String(launchBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  try {
    const headers = buildLaunchHeaders()
    const r = await fetch(`${base}/api/integrations/linkeoo-erp`, {
      method: 'GET',
      headers: { ...headers, Accept: 'application/json' },
    })
    if (r.ok) {
      const j = /** @type {{ baseUrl?: string; apiKey?: string }} */ (await r.json())
      const bu = String(j.baseUrl || '').trim().replace(/\/$/, '') || DEFAULT_ERP_BASE
      const k = String(j.apiKey || '').trim()
      if (k) return { baseUrl: bu, apiKey: k }
    }
  } catch {
    /* ignore */
  }
  return null
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

/**
 * @param {string} baseUrl
 * @param {string} startUrl
 */
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
    headers: buildLaunchHeaders(),
    body: JSON.stringify(payload),
  })
}

/**
 * @param {string} baseUrl
 * @param {unknown} initialResponse
 */
async function waitUntilDebugReady(baseUrl, initialResponse) {
  if (initialResponse?.debugReady) return initialResponse
  const code = String(initialResponse?.launchCode || '').trim()
  if (!code) return initialResponse
  for (let i = 0; i < DEBUG_READY_RETRY; i += 1) {
    await sleep(DEBUG_READY_INTERVAL_MS)
    const latest = await requestJson(`${baseUrl}/api/launch/${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: buildLaunchHeaders(),
    })
    if (latest?.debugReady) return latest
  }
  return initialResponse
}

/**
 * @param {string} baseUrl
 * @param {string} startUrl
 */
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

/**
 * @param {{ headed: boolean, cdpUrl: string, launchEdge: boolean }}
 */
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

/**
 * @param {unknown} cover
 * @returns {string[]}
 */
function coverToImageUrlList(cover) {
  if (cover == null) return []
  if (Array.isArray(cover)) {
    return cover.map((x) => String(x).trim()).filter(Boolean)
  }
  if (typeof cover === 'object') {
    const o = /** @type {Record<string, unknown>} */ (cover)
    if (Array.isArray(o.image_url_list)) {
      return o.image_url_list.map((x) => String(x).trim()).filter(Boolean)
    }
    if (typeof o.url === 'string' && o.url.trim()) return [o.url.trim()]
  }
  const s = String(cover).trim()
  if (!s) return []
  if (s.startsWith('[')) {
    try {
      const j = JSON.parse(s)
      if (Array.isArray(j)) return j.map((x) => String(x).trim()).filter(Boolean)
    } catch {
      /* fallthrough */
    }
  }
  if (s.includes(',') && !/^https?:\/\//i.test(s)) {
    return s
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
  }
  if (/^https?:\/\//i.test(s)) return [s]
  return []
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} n
 * @returns {T[]}
 */
function pickRandomUnique(items, n) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.min(n, a.length))
}

/**
 * @param {string} erpBase
 * @param {string} apiKey
 * @param {number} current
 * @param {number} pageSize
 */
async function fetchUndevelopedRankingProducts(erpBase, apiKey, current, pageSize) {
  const u = new URL(`${erpBase}/api/opportunity/tiktok_ranking_product/`)
  u.searchParams.set('current', String(current))
  u.searchParams.set('pageSize', String(pageSize))
  u.searchParams.set('only_developed', 'false')
  const data = await requestJson(u.toString(), {
    method: 'GET',
    headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
  })
  const results = /** @type {Array<Record<string, unknown>>} */ (data?.results || [])
  return { count: data?.count, results }
}

/**
 * 发起仓库采集 POST：**当前调用立即返回**，不把 `JSON.stringify(大 HTML)` 与等待响应放在主流程里。
 * `stringify` + `fetch` 在 `setImmediate` 中执行，避免阻塞 Playwright 下一轮图搜。
 * 接口若在服务端长时间处理，亦不阻塞本脚本。
 * @param {string} erpBase
 * @param {string} apiKey
 * @param {string} detailUrl
 * @param {string} html
 * @param {boolean} dryRun
 * @returns {{ status: string, result?: { msg?: string } }}
 */
function postWarehouseCollect(erpBase, apiKey, detailUrl, html, dryRun) {
  if (dryRun) {
    return { status: 'dry_run', result: { msg: 'skipped' } }
  }
  const collectUrl = `${String(erpBase).replace(/\/$/, '')}/api/warehouse/collect/`
  const apiKeyCopy = apiKey
  const detailCopy = detailUrl
  const htmlCopy = html

  setImmediate(() => {
    let body
    try {
      body = JSON.stringify({
        url: detailCopy,
        platform: '1688',
        data: htmlCopy,
      })
    } catch (e) {
      console.error(
        `[warehouse/collect] JSON.stringify failed: ${e instanceof Error ? e.message : String(e)} detailUrl=${detailCopy.slice(0, 80)}`,
      )
      return
    }
    void fetch(collectUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKeyCopy,
      },
      body,
    })
      .then(async (response) => {
        if (!response.ok) {
          const t = await response.text().catch(() => '')
          console.error(
            `[warehouse/collect] HTTP ${response.status} detailUrl=${detailCopy.slice(0, 80)} ${t.slice(0, 300)}`,
          )
        }
      })
      .catch((e) => {
        console.error(
          `[warehouse/collect] ${e instanceof Error ? e.message : String(e)} detailUrl=${detailCopy.slice(0, 80)}`,
        )
      })
  })

  return { status: 'dispatched', result: { msg: 'scheduled (stringify+fetch deferred)' } }
}

/**
 * @param {string} erpBase
 * @param {string} apiKey
 * @param {number[]} ids
 * @param {boolean} dryRun
 */
async function postMarkDevelopedBatch(erpBase, apiKey, ids, dryRun) {
  if (dryRun) {
    return { ok: true, target_type: 'ranking_product', marked: 0, skipped: [], dry_run: true }
  }
  return requestJson(`${erpBase}/api/opportunity/tiktok_developed/mark_batch/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey,
    },
    body: JSON.stringify({
      target_type: 'ranking_product',
      ids,
    }),
  })
}

/**
 * 图搜列表商品根节点（1688 常改版，按优先级探测）：
 * 1) `[data-tracker="offer"]` 顶层可见节点（当前页主列表）
 * 2) `[class*="searchOfferWrapper"]` 旧版卡片根
 * 3) `[class*="offerTitleRow"]` 更旧 / 兜底
 * @param {import('playwright').Frame} frame
 */
async function get1688VisibleGridStats(frame) {
  return frame.evaluate(() => {
    const vis = (/** @type {Element} */ el) => {
      const r = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return (
        r.width > 2 &&
        r.height > 2 &&
        st.visibility !== 'hidden' &&
        st.display !== 'none' &&
        Number(st.opacity || '1') > 0.05
      )
    }
    /** 顶层 offer 卡片：无更近的 `[data-tracker="offer"]` 祖先 */
    const byTracker = [...document.querySelectorAll('[data-tracker="offer"]')].filter((el) => {
      if (!vis(el)) return false
      return !el.parentElement?.closest('[data-tracker="offer"]')
    })
    if (byTracker.length >= 2) return { visibleOfferCards: byTracker.length }
    /** 仅顶层卡片：避免嵌套结构误算 */
    const wrappers = [...document.querySelectorAll('[class*="searchOfferWrapper"]')].filter((el) => {
      if (!vis(el)) return false
      const parentWrap = el.parentElement?.closest('[class*="searchOfferWrapper"]')
      return !parentWrap || parentWrap === el
    })
    if (wrappers.length >= 2) return { visibleOfferCards: wrappers.length }
    const titleRows = [...document.querySelectorAll('[class*="offerTitleRow"]')].filter(vis)
    return { visibleOfferCards: titleRows.length }
  })
}

/**
 * 图搜结果可能在主文档或子 frame。轮询直至**可见**商品线索 ≥2。
 * @param {import('playwright').Page} page
 * @param {number} timeoutMs
 * @returns {Promise<import('playwright').Frame>}
 */
async function waitFor1688ResultsFrame(page, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        const s = await get1688VisibleGridStats(frame)
        if (s.visibleOfferCards >= 2) {
          return frame
        }
      } catch {
        /* 跨域 frame 等 */
      }
    }
    await sleep(350)
  }
  throw new Error(
    `1688 图搜后 ${timeoutMs}ms 内未在任一 frame 中发现 ≥2 个可见商品根（[data-tracker="offer"] / searchOfferWrapper / offerTitleRow）。`,
  )
}

/** 详情页 URL：供点击商品后识别「哪个标签是详情」 */
const OFFER_DETAIL_URL_RE =
  /1688\.com\/[^?#]*\/offer\/|\/\/offer\.1688\.com\/|detail\.m\.1688\.com|\/\/detail\.m\.1688\.com|\/\/detail\.1688\.com/i

/**
 * 图搜结果中点击**第二个**商品卡片：优先 `[data-tracker="offer"]`，再 `searchOfferWrapper`，再 `offerTitleRow`。
 * 若详情在**新标签**打开，必须切到该标签再取 `content()`；此处与图搜列表同理：点击前监听 `page`，超时后再对比 `context.pages()`。
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} resultsPage 图搜结果列表所在标签（勿与填图页混淆）
 * @returns {Promise<{ detailPage: import('playwright').Page, detailUrl: string }>}
 */
async function clickSecondOfferOpenDetail(context, resultsPage) {
  const frame = await waitFor1688ResultsFrame(resultsPage, 45_000)

  const pagesBefore = new Set(context.pages())
  const newPagePromise = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null)

  const clicked = await frame.evaluate(() => {
    const vis = (/** @type {Element} */ el) => {
      const r = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return (
        r.width > 2 &&
        r.height > 2 &&
        st.visibility !== 'hidden' &&
        st.display !== 'none' &&
        Number(st.opacity || '1') > 0.05
      )
    }
    const byTracker = [...document.querySelectorAll('[data-tracker="offer"]')].filter((el) => {
      if (!vis(el)) return false
      return !el.parentElement?.closest('[data-tracker="offer"]')
    })
    if (byTracker.length >= 2) {
      byTracker[1].scrollIntoView({ block: 'center', inline: 'nearest' })
      byTracker[1].click()
      return 'tracker'
    }
    const wrappers = [...document.querySelectorAll('[class*="searchOfferWrapper"]')].filter((el) => {
      if (!vis(el)) return false
      const parentWrap = el.parentElement?.closest('[class*="searchOfferWrapper"]')
      return !parentWrap || parentWrap === el
    })
    if (wrappers.length >= 2) {
      wrappers[1].scrollIntoView({ block: 'center', inline: 'nearest' })
      wrappers[1].click()
      return 'wrapper'
    }
    const titleRows = [...document.querySelectorAll('[class*="offerTitleRow"]')].filter(vis)
    if (titleRows.length >= 2) {
      titleRows[1].scrollIntoView({ block: 'center', inline: 'nearest' })
      titleRows[1].click()
      return 'titleRow'
    }
    return ''
  })

  if (!clicked) {
    throw new Error(
      '1688 结果区：可见 data-tracker=offer、searchOfferWrapper、offerTitleRow 均不足 2，无法点第二个商品。',
    )
  }

  let opened = await newPagePromise
  if (!opened || opened.isClosed()) {
    for (const p of context.pages()) {
      if (!pagesBefore.has(p) && !p.isClosed()) {
        opened = p
        break
      }
    }
  }

  let detailPage = opened && !opened.isClosed() ? opened : resultsPage
  if (opened && !opened.isClosed()) {
    await opened.bringToFront().catch(() => {})
  }

  /** 详情页不做 `networkidle`（1688 常驻上报/轮询，几乎永远不等闲，易虚耗数十秒） */
  await detailPage.waitForLoadState('domcontentloaded', { timeout: 45_000 })
  let url = detailPage.url()

  /** 详情在新标签时，当前 detailPage 可能仍是结果列表；先扫描所有标签再找 URL，避免对错误标签 waitForURL 卡死 */
  if (!OFFER_DETAIL_URL_RE.test(url)) {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        if (p.isClosed()) continue
        try {
          const u = p.url()
          if (OFFER_DETAIL_URL_RE.test(u)) {
            detailPage = p
            await p.bringToFront().catch(() => {})
            url = u
            break
          }
        } catch {
          /* ignore */
        }
      }
      if (OFFER_DETAIL_URL_RE.test(url)) break
      await sleep(250)
    }
  }

  if (!OFFER_DETAIL_URL_RE.test(url)) {
    await detailPage.waitForURL(OFFER_DETAIL_URL_RE, { timeout: 45_000 })
    url = detailPage.url()
  }

  /** 业务要求：详情页再留 10s 给首屏/模块加载后再取 HTML */
  await sleep(10_000)

  return { detailPage, detailUrl: url }
}

/**
 * 图搜：填图后点「图 搜」（`div.input-button` 内带「图」「搜」的 `span.input-button-text`），勿点「搜 索」关键词按钮。
 * @param {import('playwright').Page} page
 */
async function click1688ImageSearchButton(page) {
  const btn = page
    .locator('div.input-button span.input-button-text')
    .filter({ hasText: /图\s*搜/ })
  await btn.click({ timeout: 20_000 })
}

/**
 * 点击「图搜」后，1688 可能 **当前标签跳转** 展示结果，也可能 **新开标签** 展示列表；
 * Playwright 的 `page` 仍指向填图的那个标签，若不切换到新标签会在旧的 `offer_search.html` 上找列表。
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} searchPage 填图并点击图搜的标签
 * @returns {Promise<import('playwright').Page>} 承载图搜结果列表的标签（可能与 searchPage 同一页）
 */
async function resolve1688ImageSearchResultsPage(context, searchPage) {
  const newPagePromise = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null)
  await click1688ImageSearchButton(searchPage)
  const opened = await newPagePromise
  if (opened && !opened.isClosed()) {
    await opened.waitForLoadState('domcontentloaded', { timeout: 120_000 }).catch(() => {})
    await opened.bringToFront().catch(() => {})
    return opened
  }
  return searchPage
}

/**
 * 每张图跑完后：关闭除主标签外的所有标签，并在主标签重新打开图搜起始页，避免多标签堆积。
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} preferredPage 优先保留的标签（与 connect 时传入的「主」页一致）
 * @returns {Promise<import('playwright').Page>} 下一循环应使用的单页引用
 */
async function resetContextToOfferSearchStart(context, preferredPage) {
  const alive = context.pages().filter((p) => !p.isClosed())
  let keep =
    preferredPage && alive.includes(preferredPage) ? preferredPage : alive[0] || null
  if (!keep) {
    keep = await context.newPage()
  } else {
    for (const p of alive) {
      if (p !== keep) {
        await p.close().catch(() => {})
      }
    }
  }
  await keep.goto(OFFER_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  return keep
}

/**
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Page} page
 * @param {string} imageUrl
 * @returns {Promise<{ detailUrl: string, html: string, page: import('playwright').Page }>}
 */
async function run1688ImageSearchFlow(context, page, imageUrl) {
  await page.goto(OFFER_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForSelector('.ali-search-input', { state: 'visible', timeout: 30_000 })
  await page.locator('.ali-search-input').fill(imageUrl)
  await sleep(1000)
  const resultsPage = await resolve1688ImageSearchResultsPage(context, page)

  await resultsPage.waitForLoadState('domcontentloaded', { timeout: 120_000 })
  /** 图搜结果页留 10s 给列表/图片等加载，再点第二条 */
  await sleep(10_000)
  await resultsPage
    .evaluate(() => {
      try {
        window.scrollTo(0, Math.min(document.body?.scrollHeight ?? 800, 1200))
      } catch {
        /* ignore */
      }
    })
    .catch(() => {})
  await sleep(600)

  const { detailPage, detailUrl } = await clickSecondOfferOpenDetail(context, resultsPage)
  const html = await detailPage.content()

  const nextPage = await resetContextToOfferSearchStart(context, page)
  return { detailUrl, html, page: nextPage }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const launchEdge = hasFlag('--launch-edge')
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const dryRun = hasFlag('--dryRun')
  const skipMark = hasFlag('--skipMark')

  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const cdpUrl = getArgValue('--cdp') || String(process.env.PLAYWRIGHT_CDP_URL || '').trim()
  const pageSize = Math.min(500, Math.max(1, Number(getArgValue('--pageSize') || '20') || 20))
  const pickN = Math.min(100, Math.max(1, Number(getArgValue('--pick') || '3') || 3))

  const erp = await resolveErpCredentials(baseUrl)
  if (!erp?.apiKey) {
    console.error(
      '未找到链氪 ERP 凭证：请在应用「系统设置」保存 Host/API Key，或设置 ERP_API_KEY / --erpKey；Launch 需可读 GET /api/integrations/linkeoo-erp。',
    )
    process.exitCode = 1
    return
  }

  const { results } = await fetchUndevelopedRankingProducts(erp.baseUrl, erp.apiKey, 1, pageSize)

  const withImages = results
    .map((row) => {
      const id = Number(row.id)
      const urls = coverToImageUrlList(row.cover)
      return { id, row, image_url_list: urls }
    })
    .filter((x) => Number.isFinite(x.id) && x.image_url_list.length > 0)

  if (withImages.length === 0) {
    console.error(JSON.stringify({ ok: false, error: '当前页无带 cover 图片 URL 的待开发商品' }, null, 2))
    process.exitCode = 1
    return
  }

  const picked = pickRandomUnique(withImages, pickN)
  if (picked.length < pickN) {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: `可随机商品不足 ${pickN} 条（仅有 ${picked.length} 条含有效 cover）`,
          available: withImages.length,
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
    return
  }

  /** @type {import('playwright').Page | null} */
  let page = null
  /** @type {(() => Promise<void>) | null} */
  let close = null

  if (useLaunchApi) {
    const conn = await connectViaLaunchApi(baseUrl, OFFER_SEARCH_URL)
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

  if (!page) throw new Error('no page')

  const context = page.context()

  /** @type {Array<Record<string, unknown>>} */
  const collectResults = []

  try {
    for (let pi = 0; pi < picked.length; pi += 1) {
      const item = picked[pi]
      const { id, image_url_list } = item
      for (let ii = 0; ii < image_url_list.length; ii += 1) {
        const imageUrl = image_url_list[ii]
        const phase = `product[${pi + 1}/${picked.length}] id=${id} image[${ii + 1}/${image_url_list.length}]`
        try {
          const { detailUrl, html, page: nextPage } = await run1688ImageSearchFlow(context, page, imageUrl)
          page = nextPage
          const collectPayload = postWarehouseCollect(erp.baseUrl, erp.apiKey, detailUrl, html, dryRun)
          const st =
            collectPayload && typeof collectPayload === 'object'
              ? /** @type {{ status?: string }} */ (collectPayload).status
              : ''
          const ok =
            dryRun || st === 'success' || st === 'dispatched'
          collectResults.push({
            phase,
            rankingProductId: id,
            imageUrl,
            detailUrl,
            collect: collectPayload,
            ok,
          })
          if (!ok) {
            throw new Error(
              `仓库采集未成功: ${JSON.stringify(collectPayload)}`,
            )
          }
        } catch (e) {
          collectResults.push({
            phase,
            rankingProductId: id,
            imageUrl,
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          })
          throw e
        }
      }
    }

    const ids = picked.map((p) => p.id)
    let markPayload = null
    if (!skipMark) {
      markPayload = await postMarkDevelopedBatch(erp.baseUrl, erp.apiKey, ids, dryRun)
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          pickedIds: ids,
          picked: picked.map((p) => ({
            id: p.id,
            title: p.row.title,
            imageCount: p.image_url_list.length,
          })),
          collectResults,
          markDeveloped: markPayload,
        },
        null,
        2,
      ),
    )

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

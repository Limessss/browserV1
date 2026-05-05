#!/usr/bin/env node

/**
 * TikTok Shop：Compass 单品卡 → 页面**默认日期**（不改动日期筛选）→ 按「曝光」降序取 Top N（默认 10）→
 * 随机从中抽取 M 个商品（默认 5）→ 带货视频 material-2-video：**AI 视频生成器 → 选品 → 生成视频**（每个商品各跑一轮）。
 *
 * 成对文档：`mcp_tiktok_compass_top10_random5_ai_video.md`；约定见 `../README.md`。
 *
 * 示例：
 *   node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH
 *   node ... --cdp http://127.0.0.1:19876 --shop_region PH
 *   node ... --useLaunchApi --code ICHPPH --shop_region PH --top_n 10 --pick_n 5
 */

import { chromium } from 'playwright'

const COMPASS_PATH = '/compass/single-product-card'
const MATERIAL_PAGE_PATH = '/shoppable-videos/material-2-video'

/** @param {string} shopRegion */
function buildCompassUrl(shopRegion) {
  const base = 'https://seller.tiktokshopglobalselling.com'
  const u = new URL(COMPASS_PATH, base)
  const r = String(shopRegion || '').trim()
  if (r) u.searchParams.set('shop_region', r)
  return u.toString()
}

/** @param {string} shopRegion */
function buildMaterialPageUrl(shopRegion) {
  const base = 'https://seller.tiktokshopglobalselling.com'
  const u = new URL(MATERIAL_PAGE_PATH, base)
  u.searchParams.set('from', 'tab')
  const r = String(shopRegion || '').trim()
  if (r) u.searchParams.set('shop_region', r)
  return u.toString()
}

const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 12
const DEBUG_READY_INTERVAL_MS = 500

const EXPOSURE_HEADER_RE =
  /曝光(用户|人数|量)?|Product\s*impressions|Impressions|曝光用户|Exposures?/i

/**
 * @param {string} a
 * @param {string} b
 */
function regionCodeEq(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
}

/**
 * 从地址栏 query 读取 `shop_region`（卖家中心部分路由会在 SPA 内改写 URL，以这里为准）。
 * @param {import('playwright').Page} page
 */
async function readUrlShopRegionParam(page) {
  return page.evaluate(() => {
    try {
      return new URL(window.location.href).searchParams.get('shop_region') || ''
    } catch {
      return ''
    }
  })
}

/**
 * 全球卖卖家中心为 SPA：仅 `goto` 一次时，常仍沿用当前店铺区域；需强制让 URL/路由与 `shop_region` 对齐。
 * @param {import('playwright').Page} page
 * @param {string} pageUrl 已含 `shop_region` 的完整 URL
 * @param {string} expectedRegion 如 MY、PH
 * @returns {Promise<{ finalUrl: string, urlShopRegion: string, steps: string[] }>}
 */
async function gotoSellerPageRespectingShopRegion(page, pageUrl, expectedRegion) {
  const want = String(expectedRegion || '').trim()
  const steps = []

  const nav = async (url, label) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
    steps.push(label)
  }

  if (!want) {
    await nav(pageUrl, 'goto-once')
    const finalUrl = page.url()
    return { finalUrl, urlShopRegion: await readUrlShopRegionParam(page), steps }
  }

  await nav(pageUrl, 'goto-initial')
  await sleep(600)

  let urlParam = await readUrlShopRegionParam(page)
  if (regionCodeEq(urlParam, want)) {
    try {
      await page
        .waitForFunction(
          (code) => {
            try {
              const v = new URL(window.location.href).searchParams.get('shop_region') || ''
              return v && String(v).toUpperCase() === String(code).toUpperCase()
            } catch {
              return false
            }
          },
          want,
          { timeout: 12_000 },
        )
        .catch(() => {})
    } catch {
      /* ignore */
    }
    return { finalUrl: page.url(), urlShopRegion: await readUrlShopRegionParam(page), steps }
  }

  await page.evaluate((u) => {
    window.location.replace(u)
  }, pageUrl)
  await page.waitForLoadState('domcontentloaded', { timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
  steps.push('location-replace')
  await sleep(800)
  urlParam = await readUrlShopRegionParam(page)

  if (!regionCodeEq(urlParam, want)) {
    const bust = new URL(pageUrl)
    bust.searchParams.set('shop_region', want)
    bust.searchParams.set('_nc', String(Date.now()))
    await nav(bust.toString(), 'goto-cache-bust')
    await sleep(600)
  }

  urlParam = await readUrlShopRegionParam(page)
  if (!regionCodeEq(urlParam, want)) {
    await nav(pageUrl, 'goto-retry-same')
    await sleep(600)
    urlParam = await readUrlShopRegionParam(page)
  }

  if (!regionCodeEq(urlParam, want)) {
    try {
      await page
        .waitForFunction(
          (code) => {
            try {
              const v = new URL(window.location.href).searchParams.get('shop_region') || ''
              return v && String(v).toUpperCase() === String(code).toUpperCase()
            } catch {
              return false
            }
          },
          want,
          { timeout: 20_000 },
        )
        .catch(() => {})
    } catch {
      /* ignore */
    }
  }

  return { finalUrl: page.url(), urlShopRegion: await readUrlShopRegionParam(page), steps }
}

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

/**
 * @param {import('playwright').Page} page
 */
async function trySortByExposureUsersDescending(page) {
  const headerCandidates = [
    page.getByRole('columnheader', { name: EXPOSURE_HEADER_RE }),
    page.locator('th').filter({ hasText: EXPOSURE_HEADER_RE }),
    page.locator('[role="columnheader"]').filter({ hasText: EXPOSURE_HEADER_RE }),
  ]

  for (const loc of headerCandidates) {
    const n = await loc.count().catch(() => 0)
    if (n < 1) continue
    const h = loc.first()
    if (!(await h.isVisible().catch(() => false))) continue

    for (let click = 0; click < 4; click += 1) {
      await h.click({ timeout: 12_000 })
      await sleep(900)
      const aria = await h.getAttribute('aria-sort').catch(() => null)
      if (aria === 'descending') {
        return { ok: true, strategy: 'aria-sort-desc', clicks: click + 1 }
      }
      const cls = (await h.getAttribute('class')) || ''
      if (/sort-desc|descend|down/i.test(cls)) {
        return { ok: true, strategy: 'class-desc', clicks: click + 1 }
      }
    }
    return { ok: true, strategy: 'header-clicks-fallback', clicks: 4 }
  }

  return { ok: false, strategy: 'no-header' }
}

/**
 * @param {import('playwright').Page} page
 * @param {number} n
 */
async function extractTopProductRows(page, n) {
  return page.evaluate(
    (limit) => {
      const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()

      /**
       * @param {string} href
       * @returns {string | null}
       */
      function idFromHref(href) {
        if (!href) return null
        try {
          const u = new URL(href, location.origin)
          const sp = u.searchParams
          const keys = [
            'product_id',
            'productId',
            'item_id',
            'itemId',
            'id',
            'pid',
            'p_id',
            'spu_id',
            'global_product_id',
          ]
          for (const k of keys) {
            const v = sp.get(k)
            if (v && /^\d{5,24}$/.test(v)) return v
          }
        } catch {
          /* ignore */
        }
        const m =
          href.match(/[?&]product_?id=(\d{5,24})/i) ||
          href.match(/\/product\/[^/]*?(\d{10,24})/) ||
          href.match(/item[_-]?id[=:](\d{5,24})/i)
        return m ? m[1] : null
      }

      /**
       * @param {HTMLElement} root
       * @returns {string | null}
       */
      function idFromElement(root) {
        const withData = root.closest('[data-product-id], [data-id], [data-row-key]')
        if (withData) {
          for (const attr of ['data-product-id', 'data-id', 'data-row-key']) {
            const v = withData.getAttribute(attr)
            if (v && /^\d{5,24}$/.test(String(v).trim())) return String(v).trim()
          }
        }
        const a = root.querySelector('a[href*="product"], a[href*="item"]')
        if (a) {
          const fromHref = idFromHref(a.getAttribute('href') || '')
          if (fromHref) return fromHref
        }
        return null
      }

      const bodyRows = Array.from(document.querySelectorAll('tbody tr'))
      const anyRows = bodyRows.length
        ? bodyRows
        : Array.from(document.querySelectorAll('table tr')).filter((tr) => {
            return tr.querySelector('td') && tr.querySelector('img')
          })

      const out = []
      for (const tr of anyRows) {
        if (out.length >= limit) break
        if (tr.querySelector('thead')) continue
        const tds = tr.querySelectorAll('td')
        if (tds.length < 1) continue

        const img = tr.querySelector('img[src]')
        const imageUrl = img ? String(img.getAttribute('src') || '').trim() : ''

        const productId = idFromElement(tr)
        if (!productId) continue

        let title = ''
        const titleEl =
          tr.querySelector(
            '[class*="title"], [class*="name"], [class*="product-name"], .product-title',
          ) || tds[1] || tds[2]
        if (titleEl) title = compact(titleEl.textContent)

        if (!title) {
          const link = tr.querySelector('a[href*="product"]')
          if (link) title = compact(link.textContent)
        }
        if (!title) {
          const texts = Array.from(tds).map((td) => compact(td.textContent))
          title = texts.find((t) => t.length > 2 && t.length < 500) || ''
        }

        if (imageUrl && title) {
          out.push({ product_id: productId, title, imageUrl })
        }
      }

      return out
    },
    n,
  )
}

/**
 * 单品卡：不修改日期，按曝光降序取前 topN。
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, shopRegion: string, topN: number }} opts
 */
async function runCompassTopProductsDefaultDate(page, opts) {
  const navMeta = await gotoSellerPageRespectingShopRegion(page, opts.pageUrl, opts.shopRegion)
  await sleep(900)

  await page
    .locator('table, [role="grid"], tbody')
    .first()
    .waitFor({ state: 'visible', timeout: 90_000 })
    .catch(() => {})

  const sortMeta = await trySortByExposureUsersDescending(page)
  await sleep(1000)

  const rows = await extractTopProductRows(page, opts.topN)

  const pageDateRange = await page.evaluate(() => {
    const body = document.body.innerText || ''
    const m = body.match(
      /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*[-–~至到]\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/,
    )
    return m ? `${m[1]} - ${m[2]}` : null
  })

  const ranked = rows.slice(0, opts.topN).map((r, i) => ({
    rank: i + 1,
    ...r,
  }))

  return {
    ok: ranked.length > 0,
    url: opts.pageUrl,
    /** 导航后地址栏中的 `shop_region`（可与入参对比，用于确认是否已切换区域） */
    urlShopRegion: navMeta.urlShopRegion,
    finalUrl: navMeta.finalUrl,
    shopRegionNavSteps: navMeta.steps,
    shopRegionUrlMatchesArg: regionCodeEq(navMeta.urlShopRegion, opts.shopRegion),
    shopRegion: opts.shopRegion || '',
    pageDateRange,
    note: '未改动页面日期筛选，统计区间为 Compass 默认展示区间。',
    sortExposureUsers: sortMeta,
    topN: opts.topN,
    products: ranked,
    hint:
      ranked.length === 0
        ? '未解析到表格行：请在真实页用 MCP 核对单品卡表格与「曝光」列，并更新脚本（见同目录 mcp_*.md）。'
        : !regionCodeEq(navMeta.urlShopRegion, opts.shopRegion) && String(opts.shopRegion || '').trim()
          ? '地址栏 shop_region 与 --shop_region 仍不一致：可能需在卖家中心顶栏手动切换目标市场，或当前登录账号下该区域无店铺。'
        : '',
  }
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} n
 */
function pickRandomUnique(items, n) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.min(n, a.length))
}

/** --- AI 视频（与 tiktok_shoppable_ai_video.mjs 语义一致）--- */

/**
 * @param {import('playwright').Locator} productDialog
 */
async function waitProductConfirmEnabled(productDialog) {
  const confirmBtn = productDialog.getByRole('button', { name: '确认' })
  for (let i = 0; i < 100; i += 1) {
    if (await confirmBtn.isEnabled().catch(() => false)) {
      return
    }
    await sleep(150)
  }
  throw new Error('「确认」在点击商品行后仍为不可用，请确认搜索已出结果且点击的是目标行')
}

/**
 * @param {import('playwright').Locator} productDialog
 * @param {import('playwright').Locator} row
 */
async function clickRowUntilConfirmEnabled(productDialog, row) {
  await row.scrollIntoViewIfNeeded()
  await row.click({ timeout: 15_000 })
  const confirmBtn = productDialog.getByRole('button', { name: '确认' })
  for (let i = 0; i < 15; i += 1) {
    if (await confirmBtn.isEnabled().catch(() => false)) {
      return
    }
    await sleep(200)
  }
  const label = row.locator('label').first()
  if (await label.count()) {
    await label.click({ force: true })
    return
  }
  const radio = row.locator('input[type="radio"]').first()
  if (await radio.count()) {
    await radio.click({ force: true })
  }
}

/**
 * @param {import('playwright').Locator} productDialog
 * @param {string} productId
 */
async function selectProductRow(productDialog, productId) {
  const id = String(productId || '').trim()
  if (!id) {
    const row0 = productDialog.locator('table tbody tr').first()
    await row0.waitFor({ state: 'visible', timeout: 15_000 })
    await clickRowUntilConfirmEnabled(productDialog, row0)
    await waitProductConfirmEnabled(productDialog)
    return
  }

  const trySearchAndSubmit = async () => {
    const candidates = [
      productDialog.getByRole('searchbox'),
      productDialog.getByPlaceholder(/搜索|搜尋|Search|商品|Product/i),
      productDialog.locator('input[type="search"]'),
      productDialog.locator('input[placeholder*="Search" i]'),
      productDialog.locator('input[placeholder*="搜索"]'),
    ]
    for (const loc of candidates) {
      const cnt = await loc.count().catch(() => 0)
      if (cnt > 0) {
        const input = loc.first()
        if (await input.isVisible().catch(() => false)) {
          await input.click()
          await input.fill(id)
          await input.press('Enter')
          await sleep(500)
          await productDialog
            .locator('table tbody tr')
            .filter({ hasText: id })
            .first()
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(() => {})
          await sleep(800)
          return true
        }
      }
    }
    return false
  }

  await trySearchAndSubmit()

  const row = productDialog.locator('table tbody tr').filter({ hasText: id }).first()
  const count = await row.count().catch(() => 0)
  if (count > 0) {
    await row.waitFor({ state: 'visible', timeout: 25_000 })
    await clickRowUntilConfirmEnabled(productDialog, row)
    await waitProductConfirmEnabled(productDialog)
    return
  }

  const anyRow = productDialog.locator('table tbody tr').first()
  await anyRow.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  throw new Error(`未在列表中找到含商品标识「${id}」的行（请先确认已用搜索触发筛选），请检查 product_id、店铺与 shop_region`)
}

/**
 * @param {import('playwright').Page} page
 */
function locatorProductPickerDialog(page) {
  return page
    .getByRole('dialog')
    .filter({ hasText: /选择一款商品/ })
    .filter({ has: page.locator('table') })
    .filter({ has: page.getByRole('button', { name: '确认' }) })
}

/**
 * @param {import('playwright').Page} page
 */
function locatorAiVideoGeneratorDialog(page) {
  return page
    .getByRole('dialog')
    .filter({ hasText: /AI 视频生成器/ })
    .filter({ has: page.getByRole('button', { name: /生成视频/ }) })
}

/**
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, productId: string, shopRegion: string }} opts
 */
async function runAiVideoFlow(page, opts) {
  const { pageUrl, productId, shopRegion } = opts
  await gotoSellerPageRespectingShopRegion(page, pageUrl, shopRegion)
  await page
    .getByRole('button', { name: /AI 视频生成器/ })
    .waitFor({ state: 'visible', timeout: 90_000 })

  await page.getByRole('button', { name: /AI 视频生成器/ }).click()
  await page.getByRole('button', { name: '选择商品' }).click()

  const productDialog = locatorProductPickerDialog(page)
  await productDialog.waitFor({ state: 'visible', timeout: 30_000 })
  await selectProductRow(productDialog, productId)
  await productDialog.getByRole('button', { name: '确认' }).click()

  const mainDialog = locatorAiVideoGeneratorDialog(page)
  await sleep(2000)
  await mainDialog.getByRole('button', { name: /生成视频/ }).click()

  await mainDialog.getByText('正在生成视频').waitFor({ timeout: 30_000 })
  const hint = await mainDialog.textContent()
  return { ok: true, hint: (hint || '').slice(0, 500) }
}

function resolveTopN() {
  const raw = getArgValue('--top_n')
  if (!raw) return 10
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1 || n > 50) return 10
  return n
}

function resolvePickN() {
  const raw = getArgValue('--pick_n')
  if (!raw) return 5
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1 || n > 50) return 5
  return n
}

function resolveFlowOptions() {
  const shopRegion = getArgValue('--shop_region') || 'PH'
  const compassUrl = buildCompassUrl(shopRegion)
  const materialUrl = buildMaterialPageUrl(shopRegion)
  const topN = resolveTopN()
  const pickN = resolvePickN()
  return {
    compassUrl,
    materialUrl,
    shopRegion: String(shopRegion).trim(),
    topN,
    pickN,
  }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const cdpUrl =
    getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const flow = resolveFlowOptions()

  let page
  let close
  if (useLaunchApi) {
    const conn = await connectViaLaunchApi(baseUrl, flow.compassUrl)
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
    const compass = await runCompassTopProductsDefaultDate(page, {
      pageUrl: flow.compassUrl,
      shopRegion: flow.shopRegion,
      topN: flow.topN,
    })

    if (!compass.ok || compass.products.length === 0) {
      console.log(
        JSON.stringify(
          { ok: false, phase: 'compass', compass },
          null,
          2,
        ),
      )
      process.exitCode = 1
      return
    }

    const pickedRows = pickRandomUnique(compass.products, flow.pickN)
    const pickedProductIds = pickedRows.map((p) => p.product_id)

    /** @type {Array<Record<string, unknown>>} */
    const aiRuns = []
    for (let i = 0; i < pickedRows.length; i += 1) {
      const row = pickedRows[i]
      const productId = row.product_id
      try {
        const r = await runAiVideoFlow(page, {
          pageUrl: flow.materialUrl,
          productId,
          shopRegion: flow.shopRegion,
        })
        aiRuns.push({
          index: i + 1,
          productId,
          title: row.title,
          rankInCompass: row.rank,
          ...r,
        })
      } catch (e) {
        aiRuns.push({
          index: i + 1,
          productId,
          title: row.title,
          rankInCompass: row.rank,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        })
      }
      await sleep(2000)
    }

    const allAiOk = aiRuns.every((x) => x.ok !== false)
    if (!allAiOk) process.exitCode = 1

    console.log(
      JSON.stringify(
        {
          ok: allAiOk,
          shopRegion: flow.shopRegion,
          topN: flow.topN,
          pickN: flow.pickN,
          compass,
          pickedProductIds,
          pickedProducts: pickedRows,
          aiVideoRuns: aiRuns,
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

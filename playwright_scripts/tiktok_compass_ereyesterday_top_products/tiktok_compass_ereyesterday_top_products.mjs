#!/usr/bin/env node

/**
 * TikTok Shop Compass：单品卡（Single product card）→ 统计日选「前天」（默认：相对本地日历今天往前 **2** 天，如 5/3 → 5/1）→
 * 按「曝光用户数」降序 → 取前 10 条：imageUrl、title、product_id。
 *
 * 可选 `--days_ago <n>`：**默认 2**（前天）；`1` = 昨天，`3` = 大前天。
 *
 * 成对文档：`mcp_tiktok_compass_ereyesterday_top_products.md`；约定见 `../README.md`。
 * 须已登录卖家中心；无登录会停在登录页。
 *
 * 示例：
 *   node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --useLaunchApi --code ICHPPH--shop_region PH
 *   node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 2
 *   node playwright_scripts/tiktok_compass_ereyesterday_top_products/tiktok_compass_ereyesterday_top_products.mjs --cdp http://127.0.0.1:19876 --shop_region PH --days_ago 1
 */

import { chromium } from 'playwright'

const COMPASS_PATH = '/compass/single-product-card'

/** @param {string} shopRegion */
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
const TOP_N = 10

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

/** @param {number} daysAgo 相对本地日历今天往前推的天数，默认业务为 2（前天） */
function targetDayYmdLocal(daysAgo) {
  const n = Number(daysAgo)
  const back = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2
  const d = new Date()
  d.setDate(d.getDate() - back)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function resolveDaysAgo() {
  const raw = getArgValue('--days_ago')
  if (!raw) return 2
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < 1 || n > 90) return 2
  return n
}

/**
 * CDP 探测（connectOverCDP）：单品卡顶栏为 Arco `m4b-date-picker-range`，前缀文案「最近 7 天」；
 * 仅快捷 **最近 7 天 / 最近 28 天**。单日需打开非 `arco-picker-disabled` 的 picker，
 * 在日历中选中**目标日**同日两次（range 起止相同 = 单日）。
 *
 * @param {import('playwright').Locator} panel 单月面板 `.arco-panel-date`（避免 range 双表头导致 nth 错位）
 * @param {number} targetYear
 * @param {number} targetMonth 1-12
 */
async function ensureArcoPickerMonthYear(panel, targetYear, targetMonth) {
  for (let step = 0; step < 36; step += 1) {
    const labels = panel.locator('.arco-picker-header-label')
    if ((await labels.count()) < 2) return false
    const yText = await labels.nth(0).innerText()
    const mText = await labels.nth(1).innerText()
    const cy = parseInt(String(yText).replace(/\D/g, ''), 10)
    const cm = parseInt(String(mText).replace(/\D/g, ''), 10)
    if (cy === targetYear && cm === targetMonth) return true

    const cur = cy * 12 + cm
    const tgt = targetYear * 12 + targetMonth
    const icons = panel.locator('.arco-picker-header .arco-picker-header-icon')
    if (tgt < cur) {
      await icons.nth(1).click()
    } else {
      await icons.nth(2).click()
    }
    await sleep(400)
  }
  return false
}

/**
 * @param {import('playwright').Page} page
 * @param {string} ymd `YYYY-MM-DD`（目标统计日）
 * @returns {Promise<{ ok: boolean, strategy: string, detail?: string }>}
 */
async function trySelectTargetDayArcoM4b(page, ymd) {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return { ok: false, strategy: 'arco-bad-ymd' }
  const targetYear = parseInt(m[1], 10)
  const targetMonth = parseInt(m[2], 10)
  const targetDay = parseInt(m[3], 10)
  const dayStr = String(targetDay)

  const picker = page.locator('.m4b-date-picker-range:not(.arco-picker-disabled)').first()
  if (!(await picker.isVisible().catch(() => false))) {
    return { ok: false, strategy: 'no-arco-picker' }
  }

  await picker.click({ timeout: 15_000 })
  await sleep(900)

  const container = page.locator('.arco-picker-container').first()
  await container.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})

  const panel = container.locator('.arco-panel-date').first()
  if (!(await panel.isVisible().catch(() => false))) {
    await page.keyboard.press('Escape').catch(() => {})
    return { ok: false, strategy: 'arco-no-panel-date' }
  }

  const navigated = await ensureArcoPickerMonthYear(panel, targetYear, targetMonth)
  if (!navigated) {
    await page.keyboard.press('Escape').catch(() => {})
    return { ok: false, strategy: 'arco-month-nav-failed' }
  }

  const cells = panel.locator('.arco-picker-cell-in-view')
  const n = await cells.count()
  /** @type {import('playwright').Locator | null} */
  let dayCell = null
  for (let i = 0; i < n; i += 1) {
    const c = cells.nth(i)
    const val = c.locator('.arco-picker-date-value').first()
    const txt = (await val.innerText().catch(() => '')).trim()
    if (txt !== dayStr) continue
    dayCell = c
    break
  }

  if (!dayCell) {
    await page.keyboard.press('Escape').catch(() => {})
    return { ok: false, strategy: 'arco-day-cell-missing' }
  }

  const disabled = await dayCell.evaluate((el) =>
    el.classList.contains('arco-picker-cell-disabled'),
  )
  if (disabled) {
    await page.keyboard.press('Escape').catch(() => {})
    return {
      ok: false,
      strategy: 'arco-target-day-disabled',
      detail: '目标日在日历上为不可选（arco-picker-cell-disabled）；可改用其它 --days_ago 或待数据可用。',
    }
  }

  await dayCell.scrollIntoViewIfNeeded().catch(() => {})
  await dayCell.click({ timeout: 12_000 })
  await sleep(450)
  await dayCell.scrollIntoViewIfNeeded().catch(() => {})
  await dayCell.click({ timeout: 12_000 })
  await sleep(500)

  const confirmBtn = page.getByRole('button', { name: /^(确定|确认|OK|Apply)$/i })
  if (await confirmBtn.isVisible().catch(() => false)) {
    await confirmBtn.click()
    await sleep(600)
  }

  return { ok: true, strategy: 'arco-m4b-range-single-day-double-click' }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} ymd `YYYY-MM-DD`
 * @returns {Promise<{ ok: boolean, strategy: string, detail?: string }>}
 */
async function trySelectTargetDay(page, ymd) {
  const slash = ymd.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1/$2/$3')
  const ymdCompact = ymd.replace(/-/g, '')

  const arcoCount = await page
    .locator('.m4b-date-picker-range:not(.arco-picker-disabled)')
    .count()
    .catch(() => 0)
  if (arcoCount > 0) {
    return trySelectTargetDayArcoM4b(page, ymd)
  }

  const tryClick = async (locator, strategy) => {
    const cnt = await locator.count().catch(() => 0)
    if (cnt < 1) return null
    const first = locator.first()
    if (!(await first.isVisible().catch(() => false))) return null
    await first.click({ timeout: 15_000 })
    await sleep(1200)
    return { ok: true, strategy }
  }

  let r =
    (await tryClick(
      page.getByRole('tab', { name: /^(Yesterday|昨天|昨日)$/i }),
      'tab-yesterday',
    )) ||
    (await tryClick(
      page.getByRole('button', { name: /^(Yesterday|昨天|昨日)$/i }),
      'button-yesterday',
    )) ||
    (await tryClick(page.getByText(/^Yesterday$/i), 'text-yesterday-en')) ||
    (await tryClick(page.getByText(/^昨日$/), 'text-yesterday-zh')) ||
    (await tryClick(page.getByText(/^昨天$/), 'text-yesterday-zh2'))

  if (r) return r

  const rangeText = await page.locator('body').innerText().catch(() => '')
  if (
    rangeText.includes(slash) ||
    rangeText.includes(ymd) ||
    rangeText.includes(ymdCompact)
  ) {
    return { ok: true, strategy: 'body-already-contains-target-day' }
  }

  return { ok: false, strategy: 'none' }
}

const EXPOSURE_HEADER_RE =
  /曝光(用户|人数|量)?|Product\s*impressions|Impressions|曝光用户|Exposures?/i

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
 * 从页面表格/列表解析前 n 行商品（降序后应位于表顶）。
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
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, shopRegion: string, daysAgo: number }} opts
 */
async function runFlow(page, opts) {
  const daysAgo = opts.daysAgo
  const ymd = targetDayYmdLocal(daysAgo)
  await page.goto(opts.pageUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
  await sleep(1500)

  /** 先切目标单日再等产品表刷新 */
  const targetDayMeta = await trySelectTargetDay(page, ymd)
  await sleep(1200)

  await page.locator('table, [role="grid"], tbody').first().waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {})

  const sortMeta = await trySortByExposureUsersDescending(page)
  await sleep(1000)

  const rows = await extractTopProductRows(page, TOP_N)

  const pageDateRange = await page.evaluate(() => {
    const body = document.body.innerText || ''
    const m = body.match(
      /(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*[-–~至到]\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/,
    )
    return m ? `${m[1]} - ${m[2]}` : null
  })

  const ranked = rows.slice(0, TOP_N).map((r, i) => ({
    rank: i + 1,
    ...r,
  }))

  const dateTargetLabel =
    daysAgo === 1 ? '昨天' : daysAgo === 2 ? '前天' : `往前${daysAgo}天`

  return {
    ok: ranked.length > 0,
    url: opts.pageUrl,
    shopRegion: opts.shopRegion || '',
    /** 相对本地「今天」往前推的天数（默认 2 = 前天） */
    daysAgo,
    /** 人类可读，与 daysAgo 对应 */
    dateTargetLabel,
    /** 脚本锁定的本地日历目标日 YYYY-MM-DD */
    dateTargetYmd: ymd,
    /** 页面上可见的「开始–结束」区间文案；可能与筛选不一致。 */
    pageDateRange,
    targetDaySelection: targetDayMeta,
    sortExposureUsers: sortMeta,
    topN: TOP_N,
    products: ranked,
    hint:
      ranked.length === 0
        ? '未解析到表格行：请在真实页用 MCP 核对日期筛选与「曝光」列表列名，并更新本脚本选择器（见同目录 mcp_*.md）。'
        : !targetDayMeta.ok &&
            String(targetDayMeta.strategy || '') === 'arco-target-day-disabled'
          ? `目标日（${ymd}）在 Arco 日历上为不可选格；当前列表仍为页面默认统计区间（如最近 7 天）。可调整 --days_ago 或待数据可用。`
          : '',
  }
}

function resolveOptions() {
  const shopRegion = getArgValue('--shop_region') || 'PH'
  const pageUrl = buildCompassUrl(shopRegion)
  const daysAgo = resolveDaysAgo()
  return { pageUrl, shopRegion: String(shopRegion).trim(), daysAgo }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const cdpUrl =
    getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const flowOpts = resolveOptions()

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
    const result = await runFlow(page, flowOpts)
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

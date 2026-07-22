#!/usr/bin/env node

/**
 * TikTok Ads GMV Max dashboard: switch shops, collect overview metrics, and write an HTML report.
 *
 * Examples:
 *   node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --useLaunchApi --code IKXSD8 --aadvid 7581297450980294657
 *   node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --cdp http://127.0.0.1:19876 --aadvid 7581297450980294657
 *   node playwright_scripts/tiktok_ads_gmv_max_dashboard/tiktok_ads_gmv_max_dashboard.mjs --cdp http://127.0.0.1:19876 --aadvid 7581297450980294657 --shops "Shop A,Shop B"
 */

import { chromium } from 'playwright'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { logProgress, showPageResultModalUntilAck } from '../_lib/page_runtime_ui.mjs'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_URL = 'https://ads.tiktok.com/i18n/gmv-max/dashboard'
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 12
const DEBUG_READY_INTERVAL_MS = 500
const READY_AFTER_NAV_MS = 2500
const READY_AFTER_SHOP_SWITCH_MS = 3500
const READY_AFTER_DATE_SWITCH_MS = 1800

const DATE_RANGE_PRESETS = {
  today: { label: '今天', aliases: ['today', 'day', '1d', '今天', '今日'] },
  yesterday: { label: '昨天', aliases: ['yesterday', '昨天', '昨日'] },
  last7: { label: '近 7 天', aliases: ['last7', 'last_7', '7d', '近7天', '近 7 天'] },
  last30: { label: '近 30 天', aliases: ['last30', 'last_30', '30d', '近30天', '近 30 天'] },
  last3m: { label: '近 3 个月', aliases: ['last3m', 'last_3m', '3m', '近3个月', '近 3 个月'] },
  last6m: { label: '近 6 个月', aliases: ['last6m', 'last_6m', '6m', '近6个月', '近 6 个月'] },
  last12m: {
    label: '过去 12 个月',
    aliases: ['last12m', 'last_12m', '12m', 'past12m', '过去12个月', '过去 12 个月'],
  },
}

const METRIC_LABELS = [
  ['cost', /^(Cost|Spend|Ad spend|花费|消耗|广告花费|成本|净成本)$/i],
  ['gmv', /^(GMV|Gross merchandise value|Revenue|Total revenue|总收入|成交金额|商品交易总额)$/i],
  ['roi', /^(ROI|ROAS|Return on ad spend|投入产出比)$/i],
  ['orders', /^(Orders|Order|SKU\s*Orders?|SKU\s*订单数|订单|订单数)$/i],
  ['avg_order_cost', /^(Average order cost|Cost per order|平均下单成本)$/i],
  ['impressions', /^(Impressions|Impression|展示|曝光|曝光量)$/i],
  ['clicks', /^(Clicks|Click|点击|点击量)$/i],
  ['ctr', /^(CTR|Click-through rate|点击率)$/i],
  ['cvr', /^(CVR|Conversion rate|转化率)$/i],
]

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}

function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function getNumberArg(flagName, fallback) {
  const raw = getArgValue(flagName)
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseListArg(raw) {
  const s = String(raw || '').trim()
  if (!s) return []
  if (s.startsWith('[')) {
    const parsed = JSON.parse(s)
    if (!Array.isArray(parsed)) throw new Error(`${s} is not a JSON array`)
    return parsed.map((x) => String(x ?? '').trim()).filter(Boolean)
  }
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function normalizeDateRange(raw) {
  const s = String(raw || 'today').trim()
  if (!s) return 'today'
  const hit = Object.entries(DATE_RANGE_PRESETS).find(([, item]) =>
    item.aliases.some((alias) => alias.toLowerCase() === s.toLowerCase()),
  )
  if (!hit) {
    const supported = Object.keys(DATE_RANGE_PRESETS).join(', ')
    throw new Error(`不支持的 --date_range：${s}；可选：${supported}`)
  }
  return hit[0]
}

function buildDashboardUrl(aadvid = '') {
  const u = new URL(DASHBOARD_URL)
  const id = String(aadvid || '').trim()
  if (id) u.searchParams.set('aadvid', id)
  u.searchParams.set('oec_seller_id', 'withoutShop')
  return u.toString()
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_AUTH_KEY) headers[DEFAULT_AUTH_HEADER] = DEFAULT_AUTH_KEY
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
  return requestJson(`${baseUrl}/api/launch`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      selector: resolveSelector(),
      launchArgs: ['--window-size=1440,960'],
      startUrls: [startUrl],
      skipDefaultStartUrls: true,
    }),
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
  if (!cdpUrl) throw new Error('Launch API did not return cdpUrl')
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
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  return { browser, page, close: () => browser.close() }
}

function compactText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function parseNumericValue(text) {
  const raw = compactText(text)
  if (!raw || /^[-–—]$/.test(raw)) return null
  const percent = /%/.test(raw)
  const currency = raw.match(/(USD|PHP|THB|VND|MYR|SGD|IDR|RM|Rp|₱|\$|฿|₫)/i)?.[1] || ''
  const negative = /^\s*-/.test(raw) || /\([^)]+\)/.test(raw)
  const scale = /万/.test(raw) ? 10_000 : /亿/.test(raw) ? 100_000_000 : /[kK]\b/.test(raw) ? 1000 : /[mM]\b/.test(raw) ? 1_000_000 : 1
  const match = raw.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
  if (!match) return { text: raw, value: null, currency, percent }
  const value = Number(match[0]) * scale * (negative ? -1 : 1)
  return { text: raw, value: Number.isFinite(value) ? value : null, currency, percent }
}

function normalizeMetricKey(label) {
  const s = compactText(label)
  for (const [key, re] of METRIC_LABELS) {
    if (re.test(s)) return key
  }
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
}

async function gotoDashboard(page, aadvid = '') {
  await page.goto(buildDashboardUrl(aadvid), { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 35_000 }).catch(() => {})
  await sleep(READY_AFTER_NAV_MS)
}

function readAadvidFromUrl(url) {
  try {
    return new URL(url).searchParams.get('aadvid') || ''
  } catch {
    return ''
  }
}

async function selectAdAccountIfNeeded(page, opts) {
  const beforeUrl = page.url()
  if (!/\/i18n\/home\b/i.test(beforeUrl)) {
    return { selected: false, beforeUrl, afterUrl: beforeUrl, aadvid: readAadvidFromUrl(beforeUrl), reason: 'not-home' }
  }

  const wanted = String(opts.adAccount || opts.aadvid || '').trim()
  const accountCards = page.locator('.account-card-popover, .selection-item, .selection-basic')
  const count = await accountCards.count().catch(() => 0)
  let picked = null

  for (let i = 0; i < count; i += 1) {
    const card = accountCards.nth(i)
    const text = compactText(await card.innerText().catch(() => ''))
    if (!text || /商务中心|Business Center|비지니스 센터/i.test(text)) continue
    if (wanted && !text.includes(wanted)) continue
    picked = { card, text }
    break
  }

  if (!picked && wanted) {
    const card = page.getByText(wanted).first()
    if (await card.isVisible({ timeout: 1200 }).catch(() => false)) {
      picked = { card, text: wanted }
    }
  }

  if (!picked) {
    return {
      selected: false,
      beforeUrl,
      afterUrl: beforeUrl,
      aadvid: '',
      reason: wanted ? `ad account not found: ${wanted}` : 'ad account not found',
    }
  }

  await picked.card.click({ timeout: 20_000 })
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {})
  await sleep(4500)
  const afterUrl = page.url()
  return {
    selected: true,
    text: picked.text,
    beforeUrl,
    afterUrl,
    aadvid: readAadvidFromUrl(afterUrl) || opts.aadvid || '',
  }
}

async function discoverShopCandidates(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return rect.width > 4 && rect.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const scoreShopButton = (text, aria, cls, id) => {
      const hay = `${text} ${aria} ${cls} ${id}`
      let score = 0
      if (/shop|store|seller|account|店铺|商店|店|账号|账户/i.test(hay)) score += 4
      if (/select|dropdown|switch|menu|trigger|选择|切换/i.test(hay)) score += 3
      if (/[▼▾⌄]/.test(text)) score += 1
      if (text.length > 0 && text.length <= 120) score += 1
      return score
    }
    return Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], [class*="select"], [class*="dropdown"], [class*="shop"], [class*="store"]'))
      .filter(visible)
      .map((el, index) => {
        const text = compact(el.innerText || el.textContent || el.getAttribute('aria-label') || '')
        const aria = compact(el.getAttribute('aria-label') || '')
        const cls = compact(el.className || '')
        const id = compact(el.id || '')
        return {
          index,
          text,
          aria,
          selector: el.id ? `#${CSS.escape(el.id)}` : '',
          score: scoreShopButton(text, aria, cls, id),
        }
      })
      .filter((x) => x.score >= 4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
  })
}

async function clickCandidateByIndex(page, candidateIndex) {
  return page.evaluate((candidateIndex) => {
    const els = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], [class*="select"], [class*="dropdown"], [class*="shop"], [class*="store"]'))
    const el = els[candidateIndex]
    if (!el) return false
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.click()
    return true
  }, candidateIndex)
}

async function readDropdownOptions(page) {
  await sleep(800)
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return rect.width > 8 && rect.height > 8 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const shopLabels = Array.from(
      document.querySelectorAll('[data-testid="shop-select-modal-index-iQvVSR"]'),
    )
      .filter(visible)
      .map((el, index) => {
        const text = compact(el.innerText || el.textContent || el.getAttribute('aria-label') || '')
        const code = (text.match(/(?:店铺代码|Shop code)\s*[：:]\s*([A-Z0-9]+)/i) || [])[1] || ''
        const name = text
          .replace(/需要授权\s*·?\s*/g, '')
          .replace(/(?:店铺代码|Shop code)\s*[：:]\s*[A-Z0-9]+/i, '')
          .trim()
        return { index, text, name, code, disabled: /需要授权|authorize|authorization/i.test(text) }
      })
      .filter((x) => x.text && x.code)

    if (shopLabels.length) return shopLabels

    const optionSelectors = [
      '[role="option"]',
      '[role="menuitem"]',
      '[class*="option"]',
      '[class*="item"]',
      '[data-e2e*="shop"]',
      '[data-testid*="shop"]',
    ].join(',')
    return Array.from(document.querySelectorAll(optionSelectors))
      .filter(visible)
      .map((el, index) => ({
        index,
        text: compact(el.innerText || el.textContent || el.getAttribute('aria-label') || ''),
      }))
      .filter((x) => x.text && x.text.length <= 160 && !/^(All|全部|确定|取消|Confirm|Cancel)$/i.test(x.text))
      .slice(0, 80)
  })
}

async function clickDropdownOptionByText(page, optionText) {
  const exact = page.getByText(optionText, { exact: true }).last()
  if (await exact.isVisible({ timeout: 1200 }).catch(() => false)) {
    await exact.click()
    return true
  }
  const fuzzy = page.getByText(optionText).last()
  if (await fuzzy.isVisible({ timeout: 1200 }).catch(() => false)) {
    await fuzzy.click()
    return true
  }
  return false
}

async function openShopDropdown(page, preferredText = '') {
  const realShopSwitcher = page.locator('[class^="shop-switch-"]').first()
  if (await realShopSwitcher.isVisible({ timeout: 1200 }).catch(() => false)) {
    await realShopSwitcher.click({ force: true })
    return { ok: true, method: '[class^="shop-switch-"]' }
  }

  const directSelectors = [
    '[data-e2e*="shop"]',
    '[data-testid*="shop"]',
    '[aria-label*="Shop"]',
    '[aria-label*="shop"]',
    '[aria-label*="店"]',
    'button:has-text("Shop")',
    'button:has-text("店")',
    '[role="button"]:has-text("Shop")',
    '[role="button"]:has-text("店")',
  ]
  for (const selector of directSelectors) {
    const loc = page.locator(selector).first()
    if (await loc.isVisible({ timeout: 700 }).catch(() => false)) {
      await loc.click()
      return { ok: true, method: selector }
    }
  }

  const candidates = await discoverShopCandidates(page)
  if (!candidates.length) return { ok: false, method: 'none', candidates }

  const preferred = preferredText
    ? candidates.find((x) => x.text.includes(preferredText) || preferredText.includes(x.text))
    : null
  const picked = preferred || candidates[0]
  const clicked = await clickCandidateByIndex(page, picked.index)
  return { ok: clicked, method: 'candidate', picked, candidates }
}

async function autoDiscoverShops(page, maxShops) {
  if (!/\/gmv-max\/dashboard\b/i.test(page.url())) {
    return {
      shops: [],
      openMeta: { ok: false, method: 'skip', reason: `not on dashboard: ${page.url()}` },
      rawOptions: [],
    }
  }
  const open = await openShopDropdown(page)
  if (!open.ok) return { shops: [], openMeta: open }
  const options = await readDropdownOptions(page)
  const shops = []
  const seen = new Set()
  for (const opt of options) {
    if (opt.disabled) continue
    const name = compactText(opt.code ? `${opt.name} | ${opt.code}` : opt.text)
    const key = (opt.code || name).toLowerCase()
    if (
      !/^\d+$/.test(name) &&
      !/TikTok for Business|©|帮助|Help|条款|Terms|政策|Policy/i.test(name) &&
      !seen.has(key)
    ) {
      seen.add(key)
      shops.push(name)
    }
    if (shops.length >= maxShops) break
  }
  await page.keyboard.press('Escape').catch(() => {})
  return { shops, openMeta: open, rawOptions: options }
}

async function switchShop(page, shopName) {
  const open = await openShopDropdown(page, shopName)
  if (!open.ok) return { ok: false, message: 'Cannot open shop switcher', open }
  const clicked = await clickShopModalOption(page, shopName)
  if (!clicked) {
    const options = await readDropdownOptions(page)
    return { ok: false, message: `Cannot find shop option: ${shopName}`, open, options }
  }
  const nextClicked = await clickShopModalNext(page)
  if (!nextClicked) {
    return { ok: false, message: `Shop selected but cannot click next: ${shopName}`, open }
  }
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await sleep(READY_AFTER_SHOP_SWITCH_MS)
  return { ok: true, message: 'switched' }
}

async function selectDateRange(page, dateRange) {
  const presetKey = normalizeDateRange(dateRange)
  const preset = DATE_RANGE_PRESETS[presetKey]

  const picker = page.locator('[data-testid="dashboard-date-picker-index-rF7379"]').first()
  let clicked = false
  if (await picker.isVisible({ timeout: 1500 }).catch(() => false)) {
    await picker.click({ force: true })
    clicked = true
  }

  if (!clicked) {
    clicked = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect()
        const st = window.getComputedStyle(el)
        return rect.width > 4 && rect.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
      }
      const candidates = Array.from(
        document.querySelectorAll('[class*="picker-component"], [class*="DatePicker"], [class*="date-picker"]'),
      )
      const el = candidates.find(visible)
      if (!el) return false
      el.scrollIntoView({ block: 'center', inline: 'center' })
      el.click()
      return true
    })
  }

  if (!clicked) return { ok: false, dateRange: presetKey, label: preset.label, message: 'date picker not found' }
  await sleep(500)

  const selected = await page.evaluate((label) => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return rect.width > 4 && rect.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span, li'))
      .filter(visible)
      .filter((el) => compact(el.innerText || el.textContent || '') === label)
    const el = candidates[candidates.length - 1]
    if (!el) return false
    el.scrollIntoView({ block: 'center', inline: 'center' })
    el.click()
    return true
  }, preset.label)

  if (!selected) {
    await page.keyboard.press('Escape').catch(() => {})
    return { ok: false, dateRange: presetKey, label: preset.label, message: 'date preset not found' }
  }

  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
  await sleep(READY_AFTER_DATE_SWITCH_MS)
  return { ok: true, dateRange: presetKey, label: preset.label, message: 'selected' }
}

async function clickShopModalOption(page, shopName) {
  const raw = String(shopName || '').trim()
  const code = (raw.match(/[A-Z]{2,}[A-Z0-9]{6,}/) || [])[0] || ''
  const ok = await page.evaluate(({ raw, code }) => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const labels = Array.from(
      document.querySelectorAll('[data-testid="shop-select-modal-index-iQvVSR"]'),
    )
    const target = labels.find((el) => {
      const text = compact(el.innerText || el.textContent || '')
      if (/需要授权|authorize|authorization/i.test(text)) return false
      if (code && text.includes(code)) return true
      return raw && (text.includes(raw) || raw.includes(text))
    })
    if (!target) return false
    target.scrollIntoView({ block: 'center', inline: 'center' })
    target.click()
    return true
  }, { raw, code })
  if (ok) return true
  return clickDropdownOptionByText(page, shopName)
}

async function clickShopModalNext(page) {
  for (const name of ['下一步', 'Next', 'Continue', '继续', '确定', 'Confirm']) {
    const btn = page.getByRole('button', { name }).last()
    if (
      (await btn.isVisible({ timeout: 800 }).catch(() => false)) &&
      (await btn.isEnabled().catch(() => false))
    ) {
      await btn.click()
      return true
    }
  }
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
    const btn = buttons.find((el) => {
      const text = compact(el.innerText || el.textContent || '')
      const disabled =
        el.disabled ||
        el.getAttribute('aria-disabled') === 'true' ||
        String(el.className || '').includes('disabled')
      return /下一步|Next|Continue|继续|确定|Confirm/i.test(text) && !disabled
    })
    if (!btn) return false
    btn.scrollIntoView({ block: 'center', inline: 'center' })
    btn.click()
    return true
  })
}

async function extractOverviewMetrics(page) {
  return page.evaluate((metricSources) => {
    const labels = metricSources.map(([key, source]) => [key, new RegExp(source, 'i')])
    const looseLabels = metricSources.map(([key, source]) => [
      key,
      new RegExp(source.replace(/^\^/, '').replace(/\$$/, ''), 'i'),
    ])
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return rect.width > 4 && rect.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const parse = (raw) => {
      const text = compact(raw)
      const percent = /%/.test(text)
      const currency = (text.match(/(USD|PHP|THB|VND|MYR|SGD|IDR|RM|Rp|₱|\$|฿|₫)/i) || [])[1] || ''
      const negative = /^\s*-/.test(text) || /\([^)]+\)/.test(text)
      const scale = /万/.test(text) ? 10000 : /亿/.test(text) ? 100000000 : /[kK]\b/.test(text) ? 1000 : /[mM]\b/.test(text) ? 1000000 : 1
      const m = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)
      if (!m) return { text, value: null, currency, percent }
      const value = Number(m[0]) * scale * (negative ? -1 : 1)
      return { text, value: Number.isFinite(value) ? value : null, currency, percent }
    }
    const normalize = (label) => {
      const s = compact(label)
      for (const [key, re] of labels) {
        if (re.test(s)) return key
      }
      return s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48)
    }
    const numberLike = /(?:USD|PHP|THB|VND|MYR|SGD|IDR|RM|Rp|₱|\$|฿|₫)?\s*-?\d[\d,]*(?:\.\d+)?\s*(?:%|万|亿|[kKmM])?/
    const metric = {}

    const overviewCards = Array.from(document.querySelectorAll('[data-testid^="overview-card-basic"], [class*="overview-item-span"]'))
      .filter(visible)
      .map((el) => compact(el.innerText || el.textContent || ''))
      .filter((text) => text && text.length <= 260 && numberLike.test(text))

    for (const text of overviewCards) {
      for (const [key, re] of looseLabels) {
        if (!re.test(text) || metric[key]) continue
        const valueText = (text.replace(re, ' ').match(numberLike) || [''])[0]
        if (valueText) {
          metric[key] = { ...parse(valueText), label: key, sourceText: text.slice(0, 260) }
        }
      }
    }

    const cards = Array.from(document.querySelectorAll('[class*="card"], [class*="metric"], [class*="overview"], [class*="stat"], [data-e2e], [data-testid]'))
      .filter(visible)
      .map((el) => ({ el, text: compact(el.innerText || el.textContent || '') }))
      .filter((x) => x.text && x.text.length <= 800 && numberLike.test(x.text))

    for (const { text } of cards) {
      const parts = text.split(/[\n\r]+| {2,}/).map(compact).filter(Boolean)
      for (const [key, re] of looseLabels) {
        if (!re.test(text)) continue
        const idx = parts.findIndex((p) => re.test(p))
        const rest = idx >= 0 ? parts.slice(idx + 1).join(' ') : text.replace(re, ' ')
        const valueText = (rest.match(numberLike) || text.match(numberLike) || [''])[0]
        if (valueText && !metric[key]) {
          metric[key] = { ...parse(valueText), label: key, sourceText: text.slice(0, 260) }
        }
      }
    }

    if (Object.keys(metric).length < 2) {
      const leaves = Array.from(document.querySelectorAll('span, div, p, td, th, label'))
        .filter(visible)
        .map((el) => ({ el, text: compact(el.textContent || '') }))
        .filter((x) => x.text && x.text.length <= 80)
      for (const leaf of leaves) {
        const key = normalize(leaf.text)
        if (!key || metric[key]) continue
        if (!labels.some(([, re]) => re.test(leaf.text))) continue
        let p = leaf.el.parentElement
        for (let depth = 0; depth < 5 && p; depth += 1) {
          const block = compact(p.innerText || p.textContent || '')
          const valueText = (block.replace(leaf.text, ' ').match(numberLike) || [''])[0]
          if (valueText) {
            metric[key] = { ...parse(valueText), label: leaf.text, sourceText: block.slice(0, 260) }
            break
          }
          p = p.parentElement
        }
      }
    }

    const pageDateRange = (() => {
      const body = document.body.innerText || ''
      const m = body.match(/(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*[-~至到]\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/)
      return m ? `${m[1]} - ${m[2]}` : null
    })()

    return {
      metrics: metric,
      pageDateRange,
      title: compact(document.title),
      bodyPreview: compact(document.body.innerText || '').slice(0, 1200),
    }
  }, METRIC_LABELS.map(([key, re]) => [key, re.source]))
}

async function collectForShop(page, shopName, index, opts = {}) {
  const shouldSwitch = Boolean(shopName) && /\/gmv-max\/dashboard\b/i.test(page.url())
  const switched = shouldSwitch
    ? await switchShop(page, shopName)
    : { ok: true, message: shopName ? 'shop switch skipped because page is not dashboard' : 'current account/page' }
  const dateRange = await selectDateRange(page, opts.dateRange || 'today')
  const extracted = await extractOverviewMetrics(page)
  return {
    shopName: shopName || 'Current shop',
    ok: switched.ok && dateRange.ok && Object.keys(extracted.metrics || {}).length > 0,
    switched,
    dateRange,
    url: page.url(),
    pageDateRange: extracted.pageDateRange,
    metrics: extracted.metrics,
    bodyPreview: extracted.bodyPreview,
  }
}

function sumMetric(rows, key) {
  return rows.reduce((total, row) => {
    const v = row.metrics?.[key]?.value
    return total + (Number.isFinite(v) ? v : 0)
  }, 0)
}

function buildSummary(rows) {
  const okRows = rows.filter((r) => r.ok)
  const totals = {}
  for (const [key] of METRIC_LABELS) {
    const value = sumMetric(okRows, key)
    if (value) totals[key] = value
  }
  const bestGmv = [...okRows].sort((a, b) => (b.metrics?.gmv?.value ?? -Infinity) - (a.metrics?.gmv?.value ?? -Infinity))[0] || null
  const bestRoi = [...okRows].sort((a, b) => (b.metrics?.roi?.value ?? -Infinity) - (a.metrics?.roi?.value ?? -Infinity))[0] || null
  return { totalShops: rows.length, okShops: okRows.length, failedShops: rows.length - okRows.length, totals, bestGmv, bestRoi }
}

function htmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatNumber(n) {
  return Number.isFinite(n) ? new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n) : '-'
}

function metricText(row, key) {
  const m = row.metrics?.[key]
  return m?.text || (Number.isFinite(m?.value) ? formatNumber(m.value) : '-')
}

function renderHtmlReport(payload) {
  const rows = payload.rows || []
  const summary = payload.summary || {}
  const generatedAt = new Date(payload.generatedAt).toLocaleString('zh-CN')
  const dateRangeLabel = payload.dateRange?.label || '今天'

  const getValue = (row, key) => {
    const v = row.metrics?.[key]?.value
    if (Number.isFinite(v)) return v
    if (key === 'cost') {
      const m = String(row.bodyPreview || '').match(/成本\s*([\d,]+(?:\.\d+)?)\s*USD/)
      if (m) {
        const n = Number(m[1].replace(/,/g, ''))
        if (Number.isFinite(n)) return n
      }
    }
    return 0
  }
  const okRows = rows.filter((r) => r.ok)
  const totalGmv = okRows.reduce((sum, r) => sum + getValue(r, 'gmv'), 0)
  const totalCost = okRows.reduce((sum, r) => sum + getValue(r, 'cost'), 0)
  const totalOrders = okRows.reduce((sum, r) => sum + getValue(r, 'orders'), 0)
  const overallRoi = totalCost > 0 ? totalGmv / totalCost : null
  const avgOrderCost = totalOrders > 0 && totalCost > 0 ? totalCost / totalOrders : null
  const shopCode = (name) => (String(name || '').match(/[A-Z]{2,}[A-Z0-9]{6,}/) || [''])[0]
  const shopTitle = (name) => String(name || '').replace(/\s*\|\s*[A-Z]{2,}[A-Z0-9]{6,}\s*$/, '')
  const compareRows = [...okRows].sort((a, b) => getValue(b, 'gmv') - getValue(a, 'gmv'))
  const maxGmv = Math.max(1, ...compareRows.map((r) => getValue(r, 'gmv')))
  const maxOrders = Math.max(1, ...compareRows.map((r) => getValue(r, 'orders')))
  const bestGmv = compareRows[0] || null
  const bestRoi = [...okRows].sort((a, b) => getValue(b, 'roi') - getValue(a, 'roi'))[0] || null
  const worstAoc = [...okRows].sort((a, b) => getValue(b, 'avg_order_cost') - getValue(a, 'avg_order_cost'))[0] || null

  const money = (n) => (Number.isFinite(n) ? `${formatNumber(n)} USD` : '-')
  const num = (n) => (Number.isFinite(n) ? formatNumber(n) : '-')
  const pctWidth = (value, max) => Math.max(3, Math.min(100, (value / max) * 100)).toFixed(2)
  const metricCell = (row, key, suffix = '') => {
    const value = getValue(row, key)
    if (!Number.isFinite(value)) return '<span class="empty">-</span>'
    if (value === 0 && !row.metrics?.[key]?.value && key !== 'cost') return '<span class="empty">-</span>'
    return `${htmlEscape(formatNumber(value))}${suffix}`
  }
  const sortText = (value) => htmlEscape(String(value ?? ''))
  const sortNumber = (value) => (Number.isFinite(value) ? String(value) : '0')
  const statusText = (row) => (row.ok ? '已获取' : '失败')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok GMV Max 店铺广告数据看板</title>
  <style>
    :root {
      color-scheme: light;
      --ink:#152238;
      --muted:#667085;
      --line:#d9dee8;
      --soft:#f5f7fb;
      --panel:#ffffff;
      --blue:#2563eb;
      --teal:#0f9f8f;
      --green:#139b63;
      --amber:#b7791f;
      --red:#c2410c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: var(--ink);
      background: #eef2f7;
    }
    header {
      background: #0f172a;
      color: #fff;
      padding: 24px 28px 22px;
      border-bottom: 4px solid #14b8a6;
    }
    h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.25; letter-spacing: 0; }
    h2 { margin: 0 0 14px; font-size: 18px; letter-spacing: 0; }
    .sub { color: #cbd5e1; font-size: 13px; line-height: 1.7; }
    main { max-width: 1320px; margin: 0 auto; padding: 22px 18px 38px; }
    section { margin: 0 0 18px; }
    .summary-grid { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 12px; }
    .card, .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: 0 8px 22px rgba(15, 23, 42, .05);
    }
    .card { padding: 15px 16px; min-height: 96px; }
    .card span { display:block; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .card strong { display:block; font-size: 24px; line-height: 1.2; word-break: break-word; }
    .card small { display:block; color: var(--muted); margin-top: 7px; font-size: 12px; }
    .panel { padding: 16px; }
    .insights { display:grid; grid-template-columns: repeat(3, minmax(220px, 1fr)); gap: 12px; }
    .insight { padding: 14px 15px; border-radius: 8px; border: 1px solid var(--line); background: #fbfcff; }
    .insight b { display:block; margin-bottom: 6px; font-size: 13px; color: var(--muted); }
    .insight strong { font-size: 17px; }
    .insight p { margin: 7px 0 0; color: var(--muted); font-size: 12px; }
    .grid { display:grid; grid-template-columns: minmax(360px, 1fr) minmax(360px, 1fr); gap: 14px; align-items:start; }
    .rank-row { display:grid; grid-template-columns: 32px minmax(130px, 1fr) 1.3fr 96px; gap: 10px; align-items:center; padding: 9px 0; border-bottom: 1px solid #edf0f5; font-size: 13px; }
    .rank-row:last-child { border-bottom:0; }
    .rank { width: 24px; height: 24px; border-radius: 999px; display:inline-flex; align-items:center; justify-content:center; background:#e8f1ff; color:#1d4ed8; font-weight:700; font-size:12px; }
    .shop-name { font-weight: 650; }
    .shop-code { color: var(--muted); font-size: 12px; margin-top: 3px; }
    .track { height: 12px; border-radius: 999px; background: #e8ecf3; overflow:hidden; }
    .fill { height:100%; border-radius:inherit; background: linear-gradient(90deg, var(--blue), var(--teal)); min-width: 2px; }
    .fill.orders { background: linear-gradient(90deg, #16a34a, #84cc16); }
    .value { text-align:right; font-variant-numeric: tabular-nums; font-weight:650; }
    .table-wrap { overflow:auto; border: 1px solid var(--line); border-radius: 8px; background:#fff; }
    table { width:100%; min-width: 980px; border-collapse: collapse; }
    th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid var(--line); font-size: 13px; vertical-align: middle; }
    th { background:#f1f4f8; color:#344054; font-weight:700; position: sticky; top: 0; z-index: 1; }
    th.sortable { cursor:pointer; user-select:none; white-space:nowrap; }
    th.sortable::after { content:"↕"; color:#98a2b3; font-size:11px; margin-left:6px; }
    th.sortable.sorted-asc::after { content:"↑"; color:var(--blue); }
    th.sortable.sorted-desc::after { content:"↓"; color:var(--blue); }
    tr:last-child td { border-bottom: 0; }
    tbody tr:nth-child(even) { background:#fbfcff; }
    .status { display:inline-flex; align-items:center; min-width: 58px; justify-content:center; padding: 3px 8px; border-radius: 999px; font-size: 12px; border:1px solid var(--line); }
    .ok { color: var(--green); background:#ecfdf3; border-color:#abefc6; }
    .fail { color: var(--red); background:#fff4ed; border-color:#fedf89; }
    .empty, .muted { color: var(--muted); }
    .note { margin: 8px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; }
    details { background:#fff; border: 1px solid var(--line); border-radius:8px; padding: 12px 14px; }
    summary { cursor:pointer; font-weight:700; }
    pre { white-space: pre-wrap; word-break: break-word; background:#0f172a; color:#dbeafe; border-radius:8px; padding:14px; max-height:360px; overflow:auto; font-size:12px; }
    @media (max-width: 980px) {
      .summary-grid, .insights, .grid { grid-template-columns: 1fr; }
      header { padding: 20px 16px; }
      main { padding: 16px 10px 28px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>TikTok GMV Max 店铺广告数据看板</h1>
    <div class="sub">生成时间：${htmlEscape(generatedAt)} · 日期口径：${htmlEscape(dateRangeLabel)} · 广告账号：${htmlEscape(payload.accountSelection?.aadvid || '-')} · 成功获取 ${summary.okShops || 0}/${summary.totalShops || 0} 个店铺</div>
  </header>
  <main>
    <section class="summary-grid">
      <div class="card"><span>已获取店铺</span><strong>${summary.okShops || 0}/${summary.totalShops || 0}</strong><small>失败 ${summary.failedShops || 0} 个</small></div>
      <div class="card"><span>总收入</span><strong>${money(totalGmv)}</strong><small>按已成功店铺汇总</small></div>
      <div class="card"><span>广告花费</span><strong>${money(totalCost)}</strong><small>成本字段汇总</small></div>
      <div class="card"><span>SKU 订单数</span><strong>${num(totalOrders)}</strong><small>当前店铺订单累计</small></div>
      <div class="card"><span>整体 ROI</span><strong>${overallRoi === null ? '-' : formatNumber(overallRoi)}</strong><small>${avgOrderCost === null ? '平均下单成本 -' : `平均下单成本 ${money(avgOrderCost)}`}</small></div>
    </section>

    <section class="insights">
      <div class="insight"><b>总收入最高</b><strong>${htmlEscape(bestGmv?.shopName || '-')}</strong><p>${bestGmv ? money(getValue(bestGmv, 'gmv')) : '-'}</p></div>
      <div class="insight"><b>ROI 最高</b><strong>${htmlEscape(bestRoi?.shopName || '-')}</strong><p>${bestRoi ? formatNumber(getValue(bestRoi, 'roi')) : '-'}</p></div>
      <div class="insight"><b>下单成本最高</b><strong>${htmlEscape(worstAoc?.shopName || '-')}</strong><p>${worstAoc ? money(getValue(worstAoc, 'avg_order_cost')) : '-'}</p></div>
    </section>

    <section class="grid">
      <div class="panel">
        <h2>店铺总收入排行</h2>
        ${compareRows.map((r, i) => `<div class="rank-row"><span class="rank">${i + 1}</span><div><div class="shop-name">${htmlEscape(shopTitle(r.shopName))}</div><div class="shop-code">${htmlEscape(shopCode(r.shopName))}</div></div><div class="track"><div class="fill" style="width:${pctWidth(getValue(r, 'gmv'), maxGmv)}%"></div></div><div class="value">${money(getValue(r, 'gmv'))}</div></div>`).join('')}
      </div>
      <div class="panel">
        <h2>SKU 订单数排行</h2>
        ${[...okRows].sort((a, b) => getValue(b, 'orders') - getValue(a, 'orders')).map((r, i) => `<div class="rank-row"><span class="rank">${i + 1}</span><div><div class="shop-name">${htmlEscape(shopTitle(r.shopName))}</div><div class="shop-code">${htmlEscape(shopCode(r.shopName))}</div></div><div class="track"><div class="fill orders" style="width:${pctWidth(getValue(r, 'orders'), maxOrders)}%"></div></div><div class="value">${num(getValue(r, 'orders'))}</div></div>`).join('')}
      </div>
    </section>

    <section class="panel">
      <h2>店铺明细</h2>
      <div class="table-wrap">
        <table id="shop-detail-table">
          <thead><tr><th class="sortable" data-type="number">排名</th><th class="sortable" data-type="text">店铺</th><th class="sortable" data-type="text">状态</th><th class="sortable sorted-desc" data-type="number">总收入</th><th class="sortable" data-type="number">广告花费</th><th class="sortable" data-type="number">ROI</th><th class="sortable" data-type="number">SKU 订单数</th><th class="sortable" data-type="number">平均下单成本</th><th class="sortable" data-type="text">店铺代码</th></tr></thead>
          <tbody>
            ${compareRows.map((r, i) => `<tr><td data-sort="${sortNumber(i + 1)}">${i + 1}</td><td data-sort="${sortText(shopTitle(r.shopName))}"><strong>${htmlEscape(shopTitle(r.shopName))}</strong></td><td data-sort="${sortText(statusText(r))}"><span class="status ${r.ok ? 'ok' : 'fail'}">${statusText(r)}</span></td><td data-sort="${sortNumber(getValue(r, 'gmv'))}">${metricCell(r, 'gmv')}</td><td data-sort="${sortNumber(getValue(r, 'cost'))}">${metricCell(r, 'cost')}</td><td data-sort="${sortNumber(getValue(r, 'roi'))}">${metricCell(r, 'roi')}</td><td data-sort="${sortNumber(getValue(r, 'orders'))}">${metricCell(r, 'orders')}</td><td data-sort="${sortNumber(getValue(r, 'avg_order_cost'))}">${metricCell(r, 'avg_order_cost')}</td><td class="muted" data-sort="${sortText(shopCode(r.shopName) || '')}">${htmlEscape(shopCode(r.shopName) || '-')}</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="note">说明：本报告按 GMV Max 概览页的“${htmlEscape(dateRangeLabel)}”日期口径采集；“总收入”对应页面里的当前店铺总收入，也就是汇总看板中的 GMV 口径。</p>
    </section>

    <details>
      <summary>查看原始 JSON 数据</summary>
      <pre>${htmlEscape(JSON.stringify(payload, null, 2))}</pre>
    </details>
  </main>
  <script>
    (() => {
      const table = document.getElementById('shop-detail-table');
      if (!table) return;
      const headers = Array.from(table.querySelectorAll('th.sortable'));
      const tbody = table.querySelector('tbody');
      let activeIndex = 3;
      let activeDir = 'desc';

      function cellValue(row, index, type) {
        const cell = row.children[index];
        const raw = cell?.dataset?.sort ?? cell?.textContent ?? '';
        if (type === 'number') {
          const n = Number(String(raw).replace(/,/g, ''));
          return Number.isFinite(n) ? n : 0;
        }
        return String(raw).trim().toLocaleLowerCase('zh-CN');
      }

      function applySort(index, dir) {
        const type = headers[index]?.dataset?.type || 'text';
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const av = cellValue(a, index, type);
          const bv = cellValue(b, index, type);
          const result = type === 'number' ? av - bv : av.localeCompare(bv, 'zh-CN');
          return dir === 'asc' ? result : -result;
        });
        rows.forEach((row) => tbody.appendChild(row));
        headers.forEach((th) => th.classList.remove('sorted-asc', 'sorted-desc'));
        headers[index].classList.add(dir === 'asc' ? 'sorted-asc' : 'sorted-desc');
        activeIndex = index;
        activeDir = dir;
      }

      headers.forEach((th, index) => {
        th.title = '点击排序';
        th.addEventListener('click', () => {
          const nextDir = activeIndex === index && activeDir === 'desc' ? 'asc' : 'desc';
          applySort(index, nextDir);
        });
      });
    })();
  </script>
</body>
</html>`
}

async function writeReports(payload, outDir) {
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(outDir, `tiktok_ads_gmv_max_dashboard_${stamp}.json`)
  const htmlPath = path.join(outDir, `tiktok_ads_gmv_max_dashboard_${stamp}.html`)
  await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')
  await writeFile(htmlPath, renderHtmlReport(payload), 'utf8')
  return { jsonPath, htmlPath }
}

function buildShopResultLines(row) {
  const gmv = row.metrics?.gmv?.text || row.metrics?.gmv?.value || '-'
  const roi = row.metrics?.roi?.text || row.metrics?.roi?.value || '-'
  const cost = row.metrics?.cost?.text || row.metrics?.cost?.value || '-'
  return [
    `店铺：${row.shopName}`,
    `结果：${row.ok ? '成功' : '失败'}`,
    `GMV：${gmv}`,
    `ROI：${roi}`,
    `花费：${cost}`,
    ...(row.switched?.message && !row.switched.ok ? [`切换：${row.switched.message}`] : []),
  ]
}

async function runFlow(page, opts) {
  const dateLabel = DATE_RANGE_PRESETS[opts.dateRange]?.label || opts.dateRange
  await logProgress(page, `[脚本] 开始 GMV Max 概览采集：日期 ${dateLabel}，aadvid=${opts.aadvid}`)
  await gotoDashboard(page, opts.aadvid)
  await logProgress(page, `[脚本] GMV Max Dashboard 已打开`)

  const accountSelection = await selectAdAccountIfNeeded(page, opts)
  const aadvid = accountSelection.aadvid || opts.aadvid || ''
  if (accountSelection.selected) {
    await logProgress(page, `[脚本] 已选择广告账号，正在进入 Dashboard`)
  }
  if (accountSelection.selected || aadvid) {
    await gotoDashboard(page, aadvid)
  }

  let shops = opts.shops
  let discovery = null
  if (!shops.length) {
    await logProgress(page, `[脚本] 正在自动发现店铺列表…`)
    discovery = await autoDiscoverShops(page, opts.maxShops)
    shops = discovery.shops
    await logProgress(page, `[脚本] 发现 ${shops.length} 个店铺，开始逐店采集`)
  } else {
    await logProgress(page, `[脚本] 使用指定店铺列表（${shops.length} 个），开始采集`)
  }
  if (!shops.length) shops = ['']

  const rows = []
  for (let i = 0; i < shops.length; i += 1) {
    const shopName = shops[i]
    const shopLabel = shopName || '当前店铺'
    await logProgress(page, `[脚本] 采集店铺 ${i + 1}/${shops.length}：${shopLabel}`)
    const row = await collectForShop(page, shopName, i, { dateRange: opts.dateRange })
    rows.push(row)
    const gmvText = row.metrics?.gmv?.text || row.metrics?.gmv?.value || '-'
    await logProgress(
      page,
      `[脚本] 店铺 ${shopLabel} ${row.ok ? '完成' : '失败'} · GMV ${gmvText}`,
    )
  }
  const payload = {
    ok: rows.some((r) => r.ok),
    url: DASHBOARD_URL,
    generatedAt: new Date().toISOString(),
    accountSelection,
    finalUrl: page.url(),
    dateRange: {
      key: opts.dateRange,
      label: DATE_RANGE_PRESETS[opts.dateRange]?.label || opts.dateRange,
    },
    shopsRequested: opts.shops,
    shopDiscovery: discovery,
    rows,
    summary: buildSummary(rows),
  }
  const reports = await writeReports(payload, opts.outDir)
  await logProgress(
    page,
    `[脚本] 报告已生成：${reports.jsonPath ? path.basename(reports.jsonPath) : 'json'} / ${reports.htmlPath ? path.basename(reports.htmlPath) : 'html'}`,
  )
  return { ...payload, reports }
}

async function run() {
  const fromJson = getArgValue('--from_json')
  if (fromJson) {
    const raw = await readFile(fromJson, 'utf8')
    const payload = JSON.parse(raw)
    const outDir =
      getArgValue('--out_dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports')
    const reports = await writeReports(payload, outDir)
    const result = { ok: true, status: 'success', mode: 'from_json', reports, folderId: path.dirname(fileURLToPath(import.meta.url)) }
    console.log(JSON.stringify(result, null, 2))
    console.log(`scriptResult: ${JSON.stringify(result)}`)
    return
  }

  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const showResultModal = hasFlag('--showResultModal') || (!useLaunchApi && !hasFlag('--noResultModal'))
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const maxShops = getNumberArg('--max_shops', 50)
  const shops = parseListArg(getArgValue('--shops'))
  const aadvid = getArgValue('--aadvid')
  const adAccount = getArgValue('--ad_account') || getArgValue('--account')
  const dateRange = normalizeDateRange(getArgValue('--date_range') || getArgValue('--dateRange') || 'today')
  if (!aadvid) {
    throw new Error('缺少必填参数：--aadvid <广告账号ID>，例如 --aadvid 7581297450980294657')
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'reports')

  let page
  let close
  if (useLaunchApi) {
    const conn = await connectViaLaunchApi(baseUrl, buildDashboardUrl(aadvid))
    page = conn.page
    close = conn.close
  } else {
    const conn = await connectBrowser({ headed, cdpUrl, launchEdge })
    page = conn.page
    close = conn.close
  }

  await openScriptArgsPanel(page, { scriptDir })

  try {
    const result = await runFlow(page, { shops, maxShops, outDir, aadvid, adAccount, dateRange })
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    console.log(`scriptResult: ${JSON.stringify({ ...result, status: result.ok ? 'success' : 'failed', folderId: scriptDir })}`)

    const summary = result.summary || {}
    const summaryLines = [
      `日期范围：${result.dateRange?.label || dateRange}`,
      `广告账号 aadvid：${aadvid}`,
      `店铺总数：${summary.totalShops ?? result.rows?.length ?? 0}`,
      `成功：${summary.okShops ?? 0} · 失败：${summary.failedShops ?? 0}`,
      ...(result.reports?.jsonPath ? [`JSON：${result.reports.jsonPath}`] : []),
      ...(result.reports?.htmlPath ? [`HTML：${result.reports.htmlPath}`] : []),
      '',
      '分项如下：',
      '',
    ]
    for (const row of result.rows || []) {
      summaryLines.push(`「${row.shopName}」· ${row.ok ? '成功' : '失败'}`)
      summaryLines.push(...buildShopResultLines(row).map((line) => `  ${line}`))
      summaryLines.push('')
    }
    summaryLines.push('终端已输出完整 JSON。点击「确定」关闭。')

    if (showResultModal) await showPageResultModalUntilAck(page, {
      title: result.ok ? 'GMV Max 采集已完成' : 'GMV Max 采集结束（部分失败）',
      variant: result.ok ? 'success' : 'warning',
      lines: summaryLines,
    })

    if (keepOpen) await new Promise(() => {})
  } finally {
    if (!keepOpen && close) await close()
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

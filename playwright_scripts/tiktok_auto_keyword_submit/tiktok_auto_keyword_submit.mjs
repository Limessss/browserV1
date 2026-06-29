#!/usr/bin/env node

/**
 * TikTok 自动关键词提报（主流程，v0.9.5 — 视口已提报时向下滚动表格加载更多关键词）。
 *
 * 经真实浏览器探针验证后的关键事实（探针位置 _temp/probe_*.mjs）：
 *   - lead/list endpoint 真实可用（v6），opportunity_type=202，total_product_count=500；
 *   - lead/detail 真实可用（v8），不返回 tour_id；
 *   - relate API endpoint 接受 payload（v7），但真实提报**改走 DOM**（与 linkeoo_extension
 *     `processKeywordItemsViaDom` 一致：点行 → 抽屉 → 选商品 → 推荐关键词 → 提交）。
 *   - 链氪 ERP 鉴权：**X-Api-Key 头**（参考 tiktok_ranking_1688_image_collect.mjs），
 *     Key 通过 Launch 服务 GET /api/integrations/linkeoo-erp 读取。
 *   - 关键词列表 100% 走 lead/list API，DOM 仅做页面健康检查（v3/v4/v5 确认虚拟滚动
 *     只能拿到 ~12 行）。
 *
 * 用法（需在应用「系统设置 → 第三方接口配置」中保存链氪 ERP Key）：
 *   node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH
 */

import { chromium } from 'playwright'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { showPageToast, showPageResultModalUntilAck } from '../_lib/page_runtime_ui.mjs'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const TRENDING_KEYWORDS_URL =
  'https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords'
const DEFAULT_LAUNCH_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_LAUNCH_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_LAUNCH_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEFAULT_ERP_BASE = process.env.LINKEOO_ERP_BASE || process.env.ERP_API_BASE || 'https://api.linkeoo.com'
const DEFAULT_PAGE_API_ORIGIN = 'https://api16-normal-sg.tiktokshopglobalselling.com'
const DEFAULT_KEYWORD_LIMIT = 50
const DEFAULT_TOP_N = 5
const DEFAULT_LEAD_PAGE_SIZE = 100
const MAX_LEAD_PAGES = 8
const OPPORTUNITY_TYPE = 202
const USER_ACTION = 'trending_keyword'
/** 视口内关键词均已提报时，向下滚动表格的最大轮数（v0.9.5 / Live Bridge 0ZF9ZK PH 验证） */
const DISCOVER_SCROLL_MAX_ROUNDS = 50

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}
function getNumberArg(flagName, fallback) {
  const direct = getArgValue(flagName)
  const inline = process.argv.find((arg) => arg.startsWith(`${flagName}=`))
  const value = direct || (inline ? inline.slice(flagName.length + 1) : '')
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}
function hasFlag(flagName) { return process.argv.includes(flagName) }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function logStep(msg) { process.stdout.write(`[submit ${new Date().toLocaleTimeString()}] ${msg}\n`) }
function compact(s) { return String(s || '').replace(/\s+/g, ' ').trim() }
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
async function connectBrowser(cdpUrl) {
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    return { browser, page, cdpUrl }
  }
  logStep('launching local Chromium (no CDP provided)')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  return { browser, page, cdpUrl: '' }
}

/**
 * 解析链氪 ERP 凭证（参考 tiktok_ranking_1688_image_collect.mjs#resolveErpCredentials）：
 *   env ERP_API_KEY / ERP_API_BASE  >  --erpKey / --erpBase  >  Launch /api/integrations/linkeoo-erp
 * @param {string} launchBaseUrl
 * @returns {Promise<{ baseUrl: string, apiKey: string } | null>}
 */
async function resolveErpCredentials(launchBaseUrl) {
  const envKey = String(process.env.ERP_API_KEY || '').trim()
  const envBase = String(process.env.ERP_API_BASE || DEFAULT_ERP_BASE).replace(/\/$/, '')
  if (envKey) return { baseUrl: envBase, apiKey: envKey }
  const cliKey = getArgValue('--erpKey').trim()
  const cliBase = getArgValue('--erpBase').trim()
  if (cliKey) return { baseUrl: (cliBase || DEFAULT_ERP_BASE).replace(/\/$/, ''), apiKey: cliKey }
  const base = String(launchBaseUrl || DEFAULT_LAUNCH_BASE_URL).replace(/\/$/, '')
  try {
    const r = await fetch(`${base}/api/integrations/linkeoo-erp`, {
      method: 'GET',
      headers: { ...buildLaunchHeaders(), Accept: 'application/json' },
    })
    if (r.ok) {
      const j = await r.json()
      const bu = String(j.baseUrl || '').trim().replace(/\/$/, '') || DEFAULT_ERP_BASE
      const k = String(j.apiKey || '').trim()
      if (k) return { baseUrl: bu, apiKey: k }
    }
  } catch { /* ignore */ }
  return null
}

/**
 * 解析 `--shop_region`：单区域码、`MY,PH,TH` 逗号分隔、或 JSON 数组字符串 `["MY","PH"]`。
 * 与 tiktok_compass_top10_random5_ai_video.mjs#parseShopRegions 行为一致。
 * @param {string} raw getArgValue('--shop_region')
 * @returns {string[]}
 */
function parseShopRegions(raw) {
  const s = String(raw || '').trim()
  if (!s) return ['PH']
  if (s.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(s)
    } catch {
      throw new Error(
        '--shop_region JSON 解析失败，请使用例如 --shop_region \'["MY","PH","TH","VN"]\'',
      )
    }
    if (!Array.isArray(parsed)) {
      throw new Error('--shop_region 的 JSON 必须是字符串数组')
    }
    const codes = parsed.map((x) => String(x ?? '').trim().toUpperCase()).filter(Boolean)
    if (!codes.length) return ['PH']
    return codes
  }
  if (s.includes(',')) {
    return s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)
  }
  return [s.toUpperCase()]
}

// ============== SQLite 持久化（v0.9 — 防止同 lead/product 重复提报） ==============
// 表 lead_submissions：UNIQUE(lead_name, product_id, shop_id, region) WHERE status='submitted'
// 启动时建表；启动时把已成功提报的 lead_name 集合传给 discovered 过滤；
// 每次提报成功后 INSERT OR IGNORE。
function openSubmissionsDb({ dbPath, reset }) {
  if (reset && existsSync(dbPath)) {
    rmSync(dbPath)
    logStep(`reset: removed ${dbPath}`)
  }
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS lead_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_name TEXT NOT NULL,
      lead_id  TEXT NOT NULL,
      product_id TEXT NOT NULL,
      shop_id TEXT NOT NULL,
      region TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('submitted','skipped','dryRun','failed')),
      title TEXT,
      submitted_at TEXT NOT NULL,
      run_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_lp ON lead_submissions(lead_name, product_id);
    CREATE INDEX IF NOT EXISTS idx_lead ON lead_submissions(lead_name);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_lps
      ON lead_submissions(lead_name, product_id, shop_id, region)
      WHERE status = 'submitted';
  `)
  return db
}

function recordSubmission(db, { leadName, leadId, productId, shopId, region, status, title, runId }) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO lead_submissions
      (lead_name, lead_id, product_id, shop_id, region, status, title, submitted_at, run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const res = stmt.run(
    String(leadName || ''), String(leadId || ''), String(productId),
    String(shopId || ''), String(region || ''), String(status || 'submitted'),
    title ? String(title) : null, new Date().toISOString(), runId ? String(runId) : null,
  )
  stmt.finalize?.()
  return res.changes || 0
}

function getSubmittedLeads(db, { shopId, region }) {
  const stmt = db.prepare(`
        SELECT DISTINCT lead_name FROM lead_submissions
        WHERE shop_id = ? AND region = ? AND status = 'submitted'
      `)
  const rows = stmt.all(String(shopId), String(region))
  stmt.finalize?.()
  return new Set(rows.map((r) => r.lead_name))
}

function isProductSubmitted(db, { leadName, productId, shopId, region }) {
  const stmt = db.prepare(`
        SELECT 1 FROM lead_submissions
        WHERE lead_name = ? AND product_id = ? AND shop_id = ? AND region = ?
          AND status = 'submitted'
        LIMIT 1
      `)
  const row = stmt.get(String(leadName), String(productId), String(shopId), String(region))
  stmt.finalize?.()
  return Boolean(row)
}

function getSubmittedProductIds(db, { leadName, shopId, region }) {
  const stmt = db.prepare(`
        SELECT product_id FROM lead_submissions
        WHERE lead_name = ? AND shop_id = ? AND region = ? AND status = 'submitted'
      `)
  const rows = stmt.all(String(leadName), String(shopId), String(region))
  stmt.finalize?.()
  return new Set(rows.map((r) => r.product_id))
}

// ============== ERP 接口（X-Api-Key 头） ==============
async function erpGetUserInfo({ base, apiKey }) {
  const url = `${base}/api/organization/userinfo/`
  const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' }
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let r
    try {
      r = await fetch(url, { method: 'GET', headers })
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      logStep(`  userinfo attempt ${attempt} 网络异常: ${msg}，1.5s 后重试`)
      await sleep(1500)
      continue
    }
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (_) { /* keep null */ }
    if (!r.ok) {
      const msg = (data && (data.msg || data.detail)) || `HTTP ${r.status}`
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    return Array.isArray(data) ? data[0] : data
  }
  throw new Error(`userinfo fetch 网络异常（3 次重试均失败）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)} (${url})`)
}

async function erpSearchByKeyword({ base, apiKey, shopPk, keyword, topN }) {
  const url = `${base}/api/tiktok/product/search_by_keyword/`
  const body = JSON.stringify({ shop_pk: Number(shopPk), keyword: String(keyword || '').trim(), top_n: Number(topN) || 5 })
  const headers = { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, Accept: 'application/json' }
  let lastErr = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let r
    try {
      r = await fetch(url, { method: 'POST', headers, body })
    } catch (e) {
      lastErr = e
      const msg = e instanceof Error ? e.message : String(e)
      logStep(`  search_by_keyword attempt ${attempt} 网络异常: ${msg}，1.5s 后重试`)
      await sleep(1500)
      continue
    }
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch (_) { /* keep null */ }
    if (!r.ok) {
      const msg = (data && (data.msg || data.detail)) || `HTTP ${r.status}`
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    }
    const items = Array.isArray(data?.result?.items) ? data.result.items : []
    return items
  }
  throw new Error(`search_by_keyword 网络异常（3 次重试均失败）: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
}

function findShopPkByShopId(userInfo, pageShopId, pageRegion) {
  if (!userInfo) return null
  const shopList = Array.isArray(userInfo.shop_list) ? userInfo.shop_list : []
  const tiktokShops = shopList.filter((s) => s?.platform === 'Tiktok')
  const target = compact(pageShopId)
  const region = compact(pageRegion).toUpperCase()
  if (!target) return null
  const exact = tiktokShops.find((s) => {
    if (compact(s.shop_id) !== target) return false
    if (!region) return true
    const r = compact(s.region || s.market || '').toUpperCase()
    return !r || r === region
  })
  if (exact?.id) return { match: exact, mode: 'exact' }
  const fuzzy = tiktokShops.find((s) => compact(s.shop_id) === target)
  if (fuzzy?.id) return { match: fuzzy, mode: 'fuzzy' }
  return null
}

/** 商品机会页「关键词」Tab 文案（含 i18n 兜底） */
const KEYWORD_TAB_LABELS = ['关键词', '热门关键词', 'Keywords', 'Keyword']

/**
 * 判断当前是否已在「关键词 / trending_keywords」Tab。
 * URL 带 tab=trending_keywords 时部分店铺仍默认停在「精选」，不能只看 URL。
 */
async function isOnTrendingKeywordsTab(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const isKwRow = (t) => t.includes('搜索关键词') || t.includes('搜索次数')
      || (/添加同款商品|查看详情/.test(t) && !t.includes('全球畅销'))
    const keywordRows = Array.from(document.querySelectorAll('div.core-table-tr')).filter((tr) => {
      return isKwRow(compact(tr.textContent))
    })
    if (keywordRows.length > 0) return true

    const activeSelectors = [
      '[role="tab"][aria-selected="true"]',
      '.core-tabs-tab-active',
      '.arco-tabs-tab-active',
      '[class*="tabs-tab-active"]',
    ]
    for (const sel of activeSelectors) {
      const el = document.querySelector(sel)
      if (!el) continue
      const t = compact(el.textContent)
      if (t.includes('关键词') || t.includes('Keywords') || t.includes('热门关键词')) return true
      if (t.includes('精选') || t.includes('Featured')) return false
    }

    const snippet = compact(document.body?.innerText?.slice(0, 4000) || '')
    if (snippet.includes('全球畅销商品') && !snippet.includes('搜索次数') && !snippet.includes('搜索关键词')) return false
    return false
  })
}

/** 点击顶部「关键词」Tab（Playwright role 优先，DOM 兜底） */
async function clickTrendingKeywordsTab(page) {
  for (const label of KEYWORD_TAB_LABELS) {
    const tab = page.getByRole('tab', { name: new RegExp(label) }).first()
    if (await tab.count() > 0) {
      try {
        await tab.click({ timeout: 8000 })
        return { clicked: true, label }
      } catch { /* try next */ }
    }
  }
  return page.evaluate((labels) => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const isTabLike = (el) => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0 || r.width > 240) return false
      const role = el.getAttribute('role')
      const cls = el.className || ''
      return role === 'tab' || String(cls).includes('tab')
    }
    const nodes = Array.from(document.querySelectorAll('[role="tab"], [class*="tabs-tab"], [class*="tab-item"]'))
    for (const label of labels) {
      for (const el of nodes) {
        const t = compact(el.textContent)
        if (t !== label && !t.startsWith(label)) continue
        if (!isTabLike(el) && el.tagName !== 'BUTTON') continue
        el.click()
        return { clicked: true, text: t }
      }
    }
    for (const label of labels) {
      for (const el of document.querySelectorAll('div, span, button')) {
        const t = compact(el.textContent)
        if (t !== label) continue
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0 || r.top > 400 || r.width > 200) continue
        el.click()
        return { clicked: true, text: t }
      }
    }
    return { clicked: false }
  }, KEYWORD_TAB_LABELS)
}

/**
 * 部分店铺 URL 虽带 tab=trending_keywords，首屏仍停在「精选」——必须显式切到「关键词」。
 */
async function ensureTrendingKeywordsTab(page, { waitMs = 8000, regionLabel = '' } = {}) {
  if (await isOnTrendingKeywordsTab(page)) {
    logStep('keywords tab already active')
    return { switched: false }
  }
  logStep('不在关键词 Tab（可能停在精选），切换到「关键词」')
  try { await showPageToast(page, `[脚本${regionLabel}] 切换到「关键词」Tab…`) } catch { /* ignore */ }
  const clickResult = await clickTrendingKeywordsTab(page)
  if (!clickResult.clicked) {
    throw new Error('未找到「关键词」Tab，无法从精选页切换')
  }
  logStep(`已点击关键词 Tab: ${clickResult.label || clickResult.text || '关键词'}`)
  const tableReady = await waitForKeywordTableRows(page, Math.min(waitMs + 7000, 15000))
  if (tableReady) {
    logStep('关键词表格已就绪')
  } else {
    logStep('警告: 点击关键词 Tab 后表格仍未就绪，继续尝试')
  }
  return { switched: true, tableReady, ...clickResult }
}

/** 切换 Tab 后轮询，直到关键词表格行出现 */
async function waitForKeywordTableRows(page, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      return Array.from(document.querySelectorAll('div.core-table-tr')).some((tr) => {
        const t = compact(tr.textContent)
        return t.includes('搜索关键词') || t.includes('搜索次数')
          || (/添加同款商品|查看详情/.test(t) && !t.includes('全球畅销'))
      })
    })
    if (ready) return true
    await sleep(500)
  }
  return false
}

/** goto 机会页 + 等待渲染 + 确保停在「关键词」Tab */
async function gotoTrendingKeywordsPage(page, targetUrl, { navTimeoutMs, waitMs, regionLabel = '' }) {
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
  logStep(`domcontentloaded, current URL: ${page.url()}`)
  logStep(`waiting ${waitMs}ms for client render`)
  await sleep(waitMs)
  await ensureTrendingKeywordsTab(page, { waitMs, regionLabel })
}

async function resetKeywordTableScroll(page) {
  await page.evaluate(() => {
    const body = document.querySelector('.core-table-body')
      || document.querySelector('[class*="table-body"]')
    if (body) {
      body.scrollTop = 0
      body.dispatchEvent(new Event('scroll', { bubbles: true }))
    }
    document.scrollingElement.scrollTop = 0
  })
  await sleep(350)
}

/** 向下滚 `.core-table-body`（rc-virtual-list），触发加载更多关键词行 */
async function scrollKeywordTableBody(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const body = document.querySelector('.core-table-body')
      || [...document.querySelectorAll('[class*="table-body"],.rc-virtual-list-holder')]
        .find((el) => visible(el) && el.scrollHeight > el.clientHeight + 50)
    if (!body) return { scrolled: false, atBottom: true, scrollTop: 0, scrollHeight: 0 }
    const beforeTop = body.scrollTop
    const beforeHeight = body.scrollHeight
    const step = Math.max(280, Math.floor(body.clientHeight * 0.65))
    body.scrollTop = Math.min(body.scrollTop + step, body.scrollHeight)
    body.dispatchEvent(new Event('scroll', { bubbles: true }))
    window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: step }))
    const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 8
    const stuck = body.scrollTop === beforeTop && atBottom
    return {
      scrolled: body.scrollTop > beforeTop || body.scrollHeight > beforeHeight,
      atBottom: stuck || atBottom,
      scrollTop: body.scrollTop,
      scrollHeight: body.scrollHeight,
    }
  })
}

/**
 * 在当前 DOM 视口内按 lead/list API 顺序找第一条未提报关键词（不含滚动）。
 * 由 discoverNextLeadName 循环调用；滚动逻辑在 Playwright 侧。
 */
async function readDiscoveredLeadNamesInViewport(page) {
  return page.evaluate(async () => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const submittedLeads = new Set(Array.isArray(window.__SUBMITTED_LEADS__) ? window.__SUBMITTED_LEADS__ : [])
    const apiOrder = Array.isArray(window.__API_LEAD_ORDER__) ? window.__API_LEAD_ORDER__ : []

    const readVisibleLeads = () => {
      const rows = Array.from(document.querySelectorAll('div.core-table-tr')).filter((el) => {
        const r = el.getBoundingClientRect()
        const st = window.getComputedStyle(el)
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'
      })
      const map = new Map()
      for (const tr of rows) {
        const text = compact(tr.textContent)
        if (text.includes('已提报') || text.includes('审核中') || text.includes('已批准') || text.includes('已驳回')) continue
        const isKwRow = text.includes('搜索关键词') || text.includes('搜索次数')
          || (/添加同款商品|查看详情/.test(text) && !text.includes('全球畅销'))
        if (!isKwRow && !/^#\s+/m.test(text)) continue

        let name = ''
        const hashMatch = text.match(/^#\s*([^\n]+?)(?=Womenswear|Menswear|全球|$)/)
        if (hashMatch) name = hashMatch[1].trim()

        if (!name) {
          const recMatch = text.match(/^(.+?)(?:推荐\+|搜索次数|搜索关键词)/)
          if (recMatch) name = recMatch[1].trim()
        }

        if (!name) {
          for (const apiName of apiOrder) {
            if (apiName && text.includes(apiName)) {
              name = apiName
              break
            }
          }
        }

        if (!name && text.includes('搜索关键词')) {
          const kwMatch = text.match(/^#\s*(.+?)搜索关键词/)
          if (kwMatch) name = kwMatch[1].trim()
        }

        if (!name) continue
        if (submittedLeads.has(name)) continue
        if (!map.has(name)) map.set(name, { row: tr, text })
      }
      return map
    }

    const nudgeScroll = () => {
      const sc = document.scrollingElement || document.documentElement
      const delta = Math.round(window.innerHeight * 0.6)
      sc.scrollTop = sc.scrollTop + delta
      return new Promise((resolve) => requestAnimationFrame(() => {
        sc.scrollTop = sc.scrollTop - delta
        requestAnimationFrame(() => resolve())
      }))
    }

    let visible = readVisibleLeads()
    if (!apiOrder.some((n) => visible.has(n))) {
      await nudgeScroll()
      await new Promise((r) => setTimeout(r, 300))
      visible = readVisibleLeads()
    }

    const out = []
    for (const name of apiOrder) {
      if (visible.has(name)) {
        out.push(name)
        if (out.length >= 30) break
      }
    }
    if (out.length === 0) {
      for (const [name] of visible) {
        out.push(name)
        if (out.length >= 30) break
      }
    }
    return out
  })
}

/** 视口内找不到未提报关键词时，向下滚动表格直到发现或到底 */
async function discoverNextLeadName(page, { submittedLeadsFromDb, apiLeadNameOrder, maxScrollRounds = DISCOVER_SCROLL_MAX_ROUNDS }) {
  try {
    await page.evaluate((leads) => { window.__SUBMITTED_LEADS__ = leads; }, [...submittedLeadsFromDb])
    await page.evaluate((names) => { window.__API_LEAD_ORDER__ = names; }, apiLeadNameOrder)
  } catch { /* ignore */ }

  await resetKeywordTableScroll(page)

  for (let round = 0; round <= maxScrollRounds; round += 1) {
    const discovered = await readDiscoveredLeadNamesInViewport(page)
    if (discovered.length) {
      if (round > 0) {
        logStep(`  向下滚动 ${round} 次后发现未提报关键词: "${discovered[0].slice(0, 72)}"`)
      }
      return discovered[0]
    }
    if (round === maxScrollRounds) break

    if (round === 0) {
      logStep('  当前视口关键词均已提报或不可见，向下滚动加载更多…')
    }
    const scrollMeta = await scrollKeywordTableBody(page)
    if (!scrollMeta.scrolled && scrollMeta.atBottom) {
      logStep(`  关键词列表已滚到底（scrollTop=${scrollMeta.scrollTop}/${scrollMeta.scrollHeight}），无更多未提报行`)
      break
    }
    await sleep(450)
  }
  return ''
}

// ============== 页面主世界：lead/list API（v6 探针验证） ==============
async function fetchLeadListAll({ page, pageSize = DEFAULT_LEAD_PAGE_SIZE, maxPages = MAX_LEAD_PAGES }) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const scriptText = await readFile(path.join(scriptDir, '_temp/lead_list_script.js'), 'utf8')
  const finalScript = scriptText
    .replace('opportunity_type: 2,', `opportunity_type: ${OPPORTUNITY_TYPE},`)
    .replace('page_size: 20,', `page_size: ${pageSize},`)
  const all = []
  let totalProductCount = 0
  for (let p = 1; p <= maxPages; p += 1) {
    const res = await page.evaluate(
      `(${finalScript.replace('page_number: 1,', `page_number: ${p},`)})()`,
    )
    if (!res.ok || res.code !== 0) {
      throw new Error(`lead/list 失败: ${res.message || `HTTP ${res.status}`}`)
    }
    const data = Array.isArray(res.data) ? res.data : []
    all.push(...data)
    totalProductCount = Number(res.totalProductCount) || 0
    if (data.length === 0 || p * pageSize >= totalProductCount) break
  }
  return { rows: all, totalProductCount }
}

// ============== DOM 提报（v17 真实探针验证：单 lead + 单 productId 完整三步真实提报） ==============
// 注意：v18 探针误读为"多商品循环 search+勾选+一次性提交"——真实生产中**第二次 search
//  会覆盖第一次的"已选"**。正确流程是**单商品单 drawer 单提交**，每个 productId 独立走一遍。
/** v28 探针：legacy 点行 / new UI 点行内「添加同款商品」——须用 Playwright 点击（evaluate.click 无效） */
async function openLeadOpportunityDrawer(page, leadName) {
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(800)
  const row = page.locator('div.core-table-tr').filter({ hasText: leadName }).first()
  await row.scrollIntoViewIfNeeded().catch(() => {})
  const rowText = await row.innerText().catch(() => '')
  const isNewUi = rowText.includes('添加同款商品') && !/^\s*#/.test(rowText)
  if (isNewUi) {
    await row.getByText('添加同款商品', { exact: true }).click({ force: true, timeout: 10_000 })
  } else {
    await row.click({ timeout: 10_000 })
  }
  await sleep(3000)
  const bind = page.getByRole('button', { name: /绑定现有商品/ }).first()
  if (await bind.count() === 0) {
    throw new Error('打开机会 drawer 后未找到「绑定现有商品」按钮')
  }
  await bind.click({ timeout: 10_000 })
  await sleep(2500)
}

const DOM_STEP1_JS = `async (productId) => {
  const compact = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const setNative = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && typeof desc.set === 'function') desc.set.call(el, value);
    else el.value = value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // skipped=true 表示该 product 因 DOM 找不到关键元素（按钮 / 行 / 输入框）而跳过
  // ——不是 fatal，主流程应跳过本 product 继续下一个，不计入 row.success。
  const out = { ok: false, skipped: false, error: '', steps: [] };

  // drawer 已由 openLeadOpportunityDrawer（Playwright）打开并完成「绑定现有商品」点击

  // 1) 搜索 productId（按下 Enter）
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) { out.error = '未找到商品搜索输入框'; out.skipped = true; return out; }
  searchInput.focus();
  setNative(searchInput, productId);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));
  const keyPayload = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, charCode: 13, bubbles: true, cancelable: true };
  searchInput.dispatchEvent(new KeyboardEvent('keydown', keyPayload));
  searchInput.dispatchEvent(new KeyboardEvent('keypress', keyPayload));
  searchInput.dispatchEvent(new KeyboardEvent('keyup', keyPayload));
  out.steps.push({ step: 'search-typed' });
  await sleep(3500);

  // 4) 找含 productId 的行——v17 真实会点击 checkbox
  const allRowDivs2 = Array.from(document.querySelectorAll('tr.core-table-tr, div.core-table-tr')).filter(visible);
  const matchRow = allRowDivs2.find((d) => compact(d.textContent).includes(productId));
  if (!matchRow) { out.error = '未找到含 productId 的行: ' + productId; out.skipped = true; return out; }
  let checkbox = matchRow.querySelector('input[type="checkbox"]');
  if (!checkbox) {
    const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
    if (tdCb) checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
  }
  // 勾选失败：checkbox 不存在或 click 后仍未 checked → 跳过本 product
  if (!checkbox) { out.error = '未找到商品行的 checkbox'; out.skipped = true; return out; }
  if (!checkbox.checked) {
    checkbox.click();
    await sleep(500);
  }
  if (!checkbox.checked) { out.error = 'checkbox 勾选后仍未 checked（可能商品被禁用 / DOM 状态异常）'; out.skipped = true; return out; }
  out.steps.push({ step: 'checkbox-checked', checked: true });

  // 5) 点 "下一步"（限定在"商品选择 drawer"范围内——避免点主页面表格的"下一步"）
  const drawerScope = Array.from(document.querySelectorAll('.core-drawer-inner, .core-drawer-content'))
    .filter(visible)
    .map((d) => ({ d, txt: compact(d.textContent || '') }))
    .find(({ txt }) => txt.includes('选择商品') || txt.includes('第 1 步') || txt.includes('第 2 步') || txt.includes('添加关键词'))?.d
    || document;
  const drawerBtns = Array.from(drawerScope.querySelectorAll('button, [role="button"]')).filter(visible);
  const nextBtn = drawerBtns.find((b) => compact(b.textContent) === '下一步' || compact(b.textContent).includes('下一步'));
  if (!nextBtn) { out.error = '未找到「下一步」按钮'; out.skipped = true; return out; }
  nextBtn.click();
  out.steps.push({ step: 'click-next' });
  await sleep(5000);
  out.ok = true;
  return out;
}`

const DOM_SUBMIT_JS = `async () => {
  const compact = (s) => String(s || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const st = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const drawerScope = Array.from(document.querySelectorAll('.core-drawer-inner, .core-drawer-content'))
    .filter(visible)
    .map((d) => ({ d, txt: compact(d.textContent || '') }))
    .find(({ txt }) => txt.includes('第 2 步') || txt.includes('添加关键词') || txt.includes('提交'))?.d
    || document;
  const buttons = Array.from(drawerScope.querySelectorAll('button, [role="button"]')).filter(visible);
  const submitBtn = buttons.find((b) => compact(b.textContent) === '提交' || compact(b.textContent) === 'Submit' || compact(b.textContent).includes('提交'));
  if (!submitBtn) return { ok: false, error: '未找到「提交」按钮' };
  submitBtn.click();
  await sleep(4000);
  const bodyText = compact(document.body?.innerText || '');
  const success = bodyText.includes('商品提交成功') || bodyText.includes('提交成功') || bodyText.includes('已提交');
  return {
    ok: success,
    success,
    bodyTail: bodyText.slice(-600),
    drawerPresent: !!document.querySelector('.core-drawer-inner'),
  };
}`

async function domStep1SingleProduct(page, leadName, productId) {
  try {
    await openLeadOpportunityDrawer(page, leadName)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, skipped: true, error: msg, steps: [] }
  }
  return page.evaluate(`(${DOM_STEP1_JS})(${JSON.stringify(productId)})`)
}

async function domSubmitFromStep2(page) {
  return page.evaluate(`(${DOM_SUBMIT_JS})()`)
}

// ============== main ==============
function buildReportLines(report) {
  return [
    `目标区域：${report.shopRegion}`,
    `lead/list：total_product_count=${report.totalProductCount}，抓取关键词=${report.allLeads.length}`,
    `本次待提报：${report.limitedLeads.length}`,
    `成功 relate（DOM）：${report.submitSuccess}`,
    `跳过 / 失败：${report.skipped}`,
    `因 DOM 缺元素跳过的 product 数：${report.skippedProducts}`,
    `去重 DB：${report.dbStats.dbPath}（启动时已记录 ${report.dbStats.initialSubmittedLeads} lead / ${report.dbStats.initialSubmittedProducts} product）`,
    `shop_id：${report.shopId || '（无）'}`,
    `shop_pk：${report.shopPk || '（无）'}`,
    `ERP 凭证来源：${report.erpSource || '（无）'}`,
    '',
    ...(report.errors.length ? ['错误（最多 8 条）：', ...report.errors.slice(0, 8)] : []),
  ]
}

/**
 * 单 region 完整跑一次：开 Launch / CDP → 解析 shop_id / ERP / lead/list / 提报循环。
 * 出错抛出 → 外层 run() 决定是否中断下一 region。
 *
 * @param {{
 *   shopRegion: string, targetUrl: string,
 *   useLaunchApi: boolean, baseUrl: string, cdpUrl: string,
 *   keepOpen: boolean,
 *   topN: number, keywordLimit: number, leadPageSize: number,
 *   navTimeoutMs: number, waitMs: number,
 *   db: DatabaseSync,
 *   runId: string, code: string,
 *   regionIndex: number, totalRegions: number,
 *   keepBrowser: boolean,  // true 时不在 finally 中 close（让 run() 在最后统一展示 modal）
 * }} cfg
 */
async function runForRegion(cfg) {
  const { shopRegion, targetUrl, useLaunchApi, baseUrl, cdpUrl, keepOpen, topN,
    keywordLimit, leadPageSize, navTimeoutMs, waitMs, db, runId, code,
    regionIndex, totalRegions, keepBrowser } = cfg

  const regionLabel = totalRegions > 1 ? ` [区域 ${regionIndex + 1}/${totalRegions} · ${shopRegion}]` : ` (${shopRegion})`
  logStep(`========== 进入 region=${shopRegion}${regionLabel} ==========`)

  const conn = useLaunchApi ? await connectViaLaunchApi(baseUrl, targetUrl) : await connectBrowser(cdpUrl)
  const { browser, page } = conn
  if (regionIndex === 0) {
    await openScriptArgsPanel(page, { scriptDir: SCRIPT_DIR })
  }
  const report = {
    code,
    ok: false,
    shopRegion,
    shopId: '',
    shopPk: null,
    totalProductCount: 0,
    allLeads: [],
    limitedLeads: [],
    submitSuccess: 0,
    skipped: 0,
    skippedProducts: 0,
    erpSource: '',
    errors: [],
    rows: [],
    dbStats: { dbPath: '', initialSubmittedLeads: 0, initialSubmittedProducts: 0 },
  }
  // dbStats 实际值在下面读
  report.dbStats.dbPath = getArgValue('--db') || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data', 'submissions.sqlite')

  try {
    logStep('navigating trending keywords page')
    await gotoTrendingKeywordsPage(page, targetUrl, { navTimeoutMs, waitMs, regionLabel })

    // shop_id（v1 探针确认 5 个来源一致）
    const shopIdInPage = await page.evaluate(() => {
      const sellerStore = window.__SELLER_USER_STORE__
      if (sellerStore?.localSellerId) return String(sellerStore.localSellerId)
      const fetchStore = window.__SELLER_FETCH_STORE__
      if (fetchStore?.userStore?.localSellerId) return String(fetchStore.userStore.localSellerId)
      try {
        const o = JSON.parse(localStorage.getItem('SeraphEdrWebAccount') || '{}')
        if (o?.shopid) return String(o.shopid)
        if (o?.account) return String(o.account)
      } catch (_) {}
      try {
        const m = document.cookie.match(/(?:^|;\s*)oec_seller_id_unified_seller_env=([^;]+)/)
        if (m) return decodeURIComponent(m[1])
      } catch (_) {}
      const scriptEl = document.getElementById('atlas_inject_workbench-base-info')
      if (scriptEl) {
        try {
          const data = JSON.parse(scriptEl.textContent || '{}')
          const seller = data?.seller_base_info?.seller
          if (seller?.seller_id) return String(seller.seller_id)
        } catch (_) {}
      }
      return ''
    })
    report.shopId = shopIdInPage
    logStep(`shop_id=${shopIdInPage}`)
    if (!shopIdInPage) throw new Error('未从页面任一来源读取到 shop_id')
    try { await showPageToast(page, `[脚本${regionLabel}] shop_id=${shopIdInPage} · 即将匹配 ERP`) } catch { /* ignore */ }

    // v0.9: 启动时读 DB，拿到该 shop+region 已成功提报的 lead 集合
    // → 注入 page 上下文，discovered 阶段会跳过这些 lead_name
    const initialSubmittedLeads = getSubmittedLeads(db, { shopId: shopIdInPage, region: shopRegion })
    report.dbStats.initialSubmittedLeads = initialSubmittedLeads.size
    // 统计 product 维度
    {
      const stmt = db.prepare(`
        SELECT COUNT(*) as n FROM lead_submissions
        WHERE shop_id = ? AND region = ? AND status = 'submitted'
      `)
      const row = stmt.get(shopIdInPage, shopRegion)
      stmt.finalize?.()
      report.dbStats.initialSubmittedProducts = row?.n || 0
    }
    logStep(`DB 初始已提报: ${initialSubmittedLeads.size} lead / ${report.dbStats.initialSubmittedProducts} product`)
    // 注入到 page 上下文（discover 时用）
    try {
      await page.evaluate((leads) => { window.__SUBMITTED_LEADS__ = leads; }, [...initialSubmittedLeads])
    } catch { /* 首次连接时 page 可能还没 ready，由后续重新注入兜底 */ }

    // 1) 解析 ERP 凭证
    const erpCreds = await resolveErpCredentials(baseUrl)
    if (!erpCreds) {
      throw new Error('未找到链氪 ERP 凭证：请在应用「系统设置」保存 Host/API Key，或设置 ERP_API_KEY / --erpKey；Launch 需可读 GET /api/integrations/linkeoo-erp。')
    }
    report.erpSource = process.env.ERP_API_KEY ? 'env' : (getArgValue('--erpKey') ? 'cli' : 'launch-integration')
    logStep(`ERP: base=${erpCreds.baseUrl}, key len=${erpCreds.apiKey.length}, source=${report.erpSource}`)
    try { await showPageToast(page, `[脚本${regionLabel}] ERP 凭证 OK（source=${report.erpSource}）`) } catch { /* ignore */ }

    // 2) 调 userinfo + 匹配 shop_pk
    const userInfo = await erpGetUserInfo({ base: erpCreds.baseUrl, apiKey: erpCreds.apiKey })
    const matched = findShopPkByShopId(userInfo, shopIdInPage, shopRegion)
    if (!matched) throw new Error(`userinfo.shop_list 找不到 shop_id=${shopIdInPage} 的 TikTok 店铺`)
    const shopPk = Number(matched.match.id)
    report.shopPk = shopPk
    logStep(`matched shop_pk=${shopPk} (mode=${matched.mode})`)
    try { await showPageToast(page, `[脚本${regionLabel}] shop_pk=${shopPk} · lead/list 抓取中…`) } catch { /* ignore */ }

    // 3) lead/list API 拿全部 trending_keyword 关键词
    logStep('calling lead/list (page main world) for trending_keyword')
    const leadsResp = await fetchLeadListAll({ page, pageSize: leadPageSize })
    report.totalProductCount = leadsResp.totalProductCount
    report.allLeads = leadsResp.rows.map((r) => ({
      lead_id: String(r.lead_id),
      lead_name: String(r.lead_name || '').trim(),
      search_volume: r.search_volume,
    }))
    logStep(`lead/list returned ${report.allLeads.length} leads, total_product_count=${report.totalProductCount}`)
    if (!report.allLeads.length) throw new Error('lead/list 未返回任何 lead')
    try { await showPageToast(page, `[脚本${regionLabel}] lead/list ${report.allLeads.length} 条 · limit=${keywordLimit}`) } catch { /* ignore */ }

    // 4) 限制 + 逐个走 ERP search_by_keyword + DOM 提报
    // v0.8 改进：每条 lead 提报前**从当前页面真实可见的 div.core-table-tr 取首条**——而不是按 lead/list API 固定顺序。
    // 这样保证每条 lead 都在新页面可视 13 行内。
    const limitedLeads = []  // 不再 pre-collect，循环里按需取
    report.limitedLeads = limitedLeads
    logStep(`limit=${keywordLimit}`)
    await showPageToast(page, `[脚本] 开始自动关键词提报（${limitedLeads.length} 个）`)

    for (let i = 0; i < keywordLimit; i += 1) {
      // v0.8：从当前页面真实可见的 div.core-table-tr 取首条未提报的 lead
      // v0.9：再叠加两层过滤——(a) 本地 DB 已成功提报的 lead_name 全集；
      //                          (b) 当前 lead 下已成功提报的 product_id 集合（用于 ERP 侧过滤）
      // v0.9.2：discovered 改为「按 lead/list API 顺序 + 在 DOM 视口内查询」——
      //   原因：TikTok表格虚拟滚动只渲染视口内约 11 行；如果脚本按 DOM 出现顺序取首条，
      //   可能拿到 lead/list API 第 N 条（视口内）而非第1 条（视口外）。
      //   因此传入「lead/list API 全量 lead_name 顺序」给前端，前端按这个顺序在 DOM 视口内查询。
      //   v0.9.2 还加上「目标 lead 不在视口时滚一段再 query」的兜底（处理刚好边界的情况）。
      const submittedLeadsFromDb = await getSubmittedLeads(db, { shopId: shopIdInPage, region: shopRegion })
      const apiLeadNameOrder = report.allLeads.map((l) => l.lead_name).filter(Boolean)
      const leadName = await discoverNextLeadName(page, { submittedLeadsFromDb, apiLeadNameOrder })
      if (!leadName) {
        logStep(`  (${i + 1}/${keywordLimit}) 页面找不到任何 lead 行（页面+DB 过滤后），结束`)
        break
      }
      // v0.9: 取出该 lead 已成功提报的 product 集合 → ERP 结果里直接过滤（不再点侧栏搜索）
      const priorSubmittedProductIds = getSubmittedProductIds(db, { leadName, shopId: shopIdInPage, region: shopRegion })
      try {
        await page.evaluate((arr) => { window.__SUBMITTED_PRODUCT_IDS__ = arr; }, [...priorSubmittedProductIds])
      } catch { /* ignore */ }
      const lead = { lead_id: `discovered-${i}`, lead_name: leadName }
      limitedLeads.push(lead)
      logStep(`(${i + 1}/${keywordLimit}) lead_name="${lead.lead_name}" (自动发现，DB 已过滤 ${submittedLeadsFromDb.size} lead)`)
      const row = { lead_id: lead.lead_id, lead_name: lead.lead_name, status: 'pending', items: 0, success: 0, error: '' }
      try {
        logStep(`(${i + 1}/${limitedLeads.length}) lead_name="${lead.lead_name}" lead_id=${lead.lead_id}`)
        const items = await erpSearchByKeyword({
          base: erpCreds.baseUrl, apiKey: erpCreds.apiKey,
          shopPk, keyword: lead.lead_name, topN,
        })
        row.items = items.length
        if (!items.length) {
          row.status = 'empty'
          report.skipped += 1
          logStep(`  → ERP 返回空商品，跳过 lead_name="${lead.lead_name}"`)
          continue
        }
        // 真实 DOM 提报：v17 探针验证的三步流程。
        // 每个 lead 提报 items[0] 一个商品（多商品流程可在下个版本扩展）。
        // 收集所有有效 productId —— v0.9 进一步用 DB 排除本 lead 已成功提报过的 product
        const firstItem = items.find((it) => it?.product_id)
        const rawProductIds = items
          .map((it) => it && it.product_id)
          .filter((pid) => pid != null && String(pid).length > 0)
          .map((pid) => String(pid))
        const dedupAgainstDb = rawProductIds.filter((pid) => !priorSubmittedProductIds.has(pid))
        const filteredOutByDb = rawProductIds.length - dedupAgainstDb.length
        if (filteredOutByDb > 0) {
          logStep(`  → DB 已存在 ${filteredOutByDb} 个 product，从本轮剔除（不再点侧栏搜索）`)
        }
        const productIds = dedupAgainstDb
        if (!productIds.length) {
          row.status = 'all-already-submitted'
          report.skippedProducts += filteredOutByDb
          report.skipped += 1
          logStep(`  → DB 已有本 lead 全部 product，跳过 lead_name="${lead.lead_name}"`)
          continue
        }
        logStep(`  → ${productIds.length} 个商品将独立提报（每个重新打开 drawer）`)

        // 对每个 productId 独立完整跑"行 click → 绑定 → 搜索 → 下一步 → 提交"
        // （v22 探针证实：单 drawer 多商品循环 search 会覆盖前一个；v17 探针证实：单商品单提报真实成功）
        let submittedCount = 0
        const submittedProductIds = []
        const skippedProductIds = []  // 因 DOM 找不到关键元素跳过的 product，事后审计
        for (let p = 0; p < productIds.length; p += 1) {
          const productId = productIds[p]
          const item = items.find((it) => String(it?.product_id) === productId)
          const title = String(item?.title || item?.description_preview || '').trim()
          try {
            const step1 = await domStep1SingleProduct(page, lead.lead_name, productId)
            if (step1?.skipped) {
              // DOM 缺关键元素（行/按钮/输入框/勾选失败）→ 跳过本 product，继续下一个
              logStep(`  ⏭ 跳过 product=${productId} (${step1.error})`)
              skippedProductIds.push({ productId, reason: step1.error || 'unknown' })
              // v0.9: 记 skipped
              recordSubmission(db, {
                leadName: lead.lead_name, leadId: lead.lead_id,
                productId, shopId: shopIdInPage, region: shopRegion,
                status: 'skipped', title, runId,
              })
              continue
            }
            if (!step1?.ok) {
              // 其它 step1 失败（非 skipped 标记）：保守起见仍跳过本 product
              logStep(`  ⏭ 跳过 product=${productId} (step1 未 ok: ${step1?.error || 'unknown'})`)
              skippedProductIds.push({ productId, reason: step1?.error || 'step1-not-ok' })
              recordSubmission(db, {
                leadName: lead.lead_name, leadId: lead.lead_id,
                productId, shopId: shopIdInPage, region: shopRegion,
                status: 'skipped', title, runId,
              })
              continue
            }
            const submitRes = await domSubmitFromStep2(page)
            if (!submitRes?.ok) {
              logStep(`  ⏭ 跳过 product=${productId} (提交未成功: ${submitRes?.error || 'unknown'})`)
              skippedProductIds.push({ productId, reason: `submit-fail: ${submitRes?.error || 'unknown'}` })
              recordSubmission(db, {
                leadName: lead.lead_name, leadId: lead.lead_id,
                productId, shopId: shopIdInPage, region: shopRegion,
                status: 'skipped', title, runId,
              })
              continue
            }
            logStep(`  ✓ 提报成功 lead=${lead.lead_id} product=${productId} title="${title.slice(0, 30)}"`)
            submittedCount += 1
            submittedProductIds.push(productId)
            report.submitSuccess += 1
            try { await showPageToast(page, `[脚本${regionLabel}] ✓ ${lead.lead_name} → product=${productId}（${submittedCount}/${productIds.length}）`) } catch { /* ignore */ }
            // v0.9: 真实成功 → status=submitted，UNIQUE(lead_name, product_id, shop_id, region) 命中即跳过
            recordSubmission(db, {
              leadName: lead.lead_name, leadId: lead.lead_id,
              productId, shopId: shopIdInPage, region: shopRegion,
              status: 'submitted', title, runId,
            })
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            // page closed / CDP 断开等浏览器级异常 → 标记为 skipped 但 **终止本 lead 后续 product**
            // （页面已不可用，继续做也只是抛同样的异常）
            logStep(`  ⚠️ 异常 lead=${lead.lead_id} product=${productId}: ${msg}，本 lead 后续 product 也跳过`)
            skippedProductIds.push({ productId, reason: `exception: ${msg}` })
            report.errors.push(`${lead.lead_name}/${productId}: ${msg}`)
            recordSubmission(db, {
              leadName: lead.lead_name, leadId: lead.lead_id,
              productId, shopId: shopIdInPage, region: shopRegion,
              status: 'skipped', title, runId,
            })
            break
          }
        }
        if (submittedCount === 0) {
          row.status = skippedProductIds.length === productIds.length ? 'all-skipped' : 'all-products-failed'
        } else {
          row.status = 'submitted'
        }
        row.success = submittedCount
        row.submitted_product_ids = submittedProductIds
        row.skipped_product_ids = skippedProductIds
        report.skippedProducts += skippedProductIds.length
        report.rows.push(row)
        try { await showPageToast(page, `[脚本${regionLabel}] lead ${i + 1}/${keywordLimit} "${lead.lead_name}" 完成 · 成功 ${submittedCount} 跳过 ${skippedProductIds.length}`) } catch { /* ignore */ }
        // 真实提报后：goto 重新加载 trending_keywords，让 discovered[0] 在新一轮指向"新的首条"
        // 不重新加载时，TikTok React 状态不会切，已提报 lead 仍可能出现在 DOM 里
        if (i + 1 < keywordLimit) {
          logStep(`  → 重新加载 trending_keywords 让 discovered[0] 切到下一条 (${i + 2}/${keywordLimit})`)
          try {
            await gotoTrendingKeywordsPage(page, targetUrl, { navTimeoutMs, waitMs, regionLabel })
          } catch (e) {
            logStep(`  → 重新加载失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        row.error = msg
        row.status = 'failed'
        report.skipped += 1
        report.errors.push(`${lead.lead_name}: ${msg}`)
        logStep(`  × failed lead_name="${lead.lead_name}": ${msg}`)
        report.rows.push(row)
      } finally {
        // 真实提报后：页面可能被导航 / 虚拟滚动状态被破坏。强制重新加载 trending_keywords
        // 让下一条 lead 在新页面里能找到行。
        if (i + 1 < limitedLeads.length) {
          logStep(`  → 重新加载 trending_keywords 准备下一条 lead (${i + 2}/${limitedLeads.length})`)
          try {
            await gotoTrendingKeywordsPage(page, targetUrl, { navTimeoutMs, waitMs, regionLabel })
          } catch (e) {
            logStep(`  → 重新加载失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
    }

    report.ok = report.errors.length === 0
    logStep(`done: submitSuccess=${report.submitSuccess}, skipped=${report.skipped}`)
    console.log(JSON.stringify(report, null, 2))
    return { report, page, conn }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    report.errors.push(msg)
    process.exitCode = 1
    logStep(`FATAL: ${msg}`)
    console.log(JSON.stringify(report, null, 2))
    return { report, page, conn }
  } finally {
    // keepBrowser=true（最后一个 region）时把浏览器留给 run() 弹汇总 modal；
    // 其它 region 一律 close，便于下个 region 重启
    if (!keepBrowser && !keepOpen) await browser.close().catch(() => {})
  }
}

async function run() {
  const shopRegions = parseShopRegions(getArgValue('--shop_region'))
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_LAUNCH_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const topN = getNumberArg('--topN', DEFAULT_TOP_N)
  const keywordLimit = getNumberArg('--limit', DEFAULT_KEYWORD_LIMIT)
  const leadPageSize = getNumberArg('--leadPageSize', DEFAULT_LEAD_PAGE_SIZE)
  const navTimeoutMs = Number(getArgValue('--nav_timeout_ms') || 120_000)
  const waitMs = Number(getArgValue('--wait_ms') || 8_000)
  const reportDir = getArgValue('--report_dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports')
  await mkdir(reportDir, { recursive: true })

  // v0.9: SQLite 持久化（防重复提报）—— DB 在所有 region 间共享
  const resetDb = hasFlag('--reset-db')
  const dbPath = getArgValue('--db') || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data', 'submissions.sqlite')
  const runId = `${getArgValue('--code') || 'GMNQ5O'}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const db = openSubmissionsDb({ dbPath, reset: resetDb })
  logStep(`submissions DB: ${dbPath} (reset=${resetDb})`)
  logStep(`shop_regions=${JSON.stringify(shopRegions)} (${shopRegions.length} 个区域依次独立跑)`)

  const code = getArgValue('--code') || 'GMNQ5O'
  const allReports = []
  /** 最后一个 region 的 page/conn，弹汇总 modal 用；runForRegion 已正确返回 */
  let lastPage = null
  let lastConn = null

  for (let ri = 0; ri < shopRegions.length; ri += 1) {
    const shopRegion = shopRegions[ri]
    const targetUrl = buildTrendingUrl(shopRegion)
    const isLast = ri === shopRegions.length - 1
    const cfg = {
      shopRegion, targetUrl,
      useLaunchApi, baseUrl, cdpUrl,
      keepOpen,
      topN, keywordLimit, leadPageSize,
      navTimeoutMs, waitMs,
      db, runId, code,
      regionIndex: ri, totalRegions: shopRegions.length,
      // 仅最后一个 region 保留 browser；其它 region 提报后立即 close
      keepBrowser: isLast,
    }
    let report = null
    let page = null
    let conn = null
    try {
      const ret = await runForRegion(cfg)
      report = ret?.report || null
      page = ret?.page || null
      conn = ret?.conn || null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      logStep(`region=${shopRegion} 未捕获异常: ${msg}`)
      report = {
        code, shopRegion, ok: false,
        submitSuccess: 0, skipped: 0, skippedProducts: 0,
        errors: [msg], rows: [], allLeads: [], limitedLeads: [],
        shopId: '', shopPk: null, totalProductCount: 0, erpSource: '',
        dbStats: { dbPath, initialSubmittedLeads: 0, initialSubmittedProducts: 0 },
      }
    }
    if (isLast && page) {
      lastPage = page
      lastConn = conn
    }
    allReports.push(report)
    // 写每 region 的独立 JSON
    const reportPath = path.join(
      reportDir,
      `tiktok_auto_keyword_submit_${code}_${shopRegion}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {})
    logStep(`report[${ri + 1}/${shopRegions.length}]: ${reportPath}`)
  }

  // 合并汇总
  const summary = {
    code,
    ok: allReports.every((r) => r.ok),
    regions: shopRegions,
    totalSubmitSuccess: allReports.reduce((s, r) => s + (r.submitSuccess || 0), 0),
    totalSkipped: allReports.reduce((s, r) => s + (r.skipped || 0), 0),
    totalSkippedProducts: allReports.reduce((s, r) => s + (r.skippedProducts || 0), 0),
    perRegion: allReports.map((r) => ({
      shopRegion: r.shopRegion,
      ok: r.ok,
      submitSuccess: r.submitSuccess,
      skipped: r.skipped,
      skippedProducts: r.skippedProducts,
      errors: r.errors,
    })),
  }
  const summaryPath = path.join(
    reportDir,
    `tiktok_auto_keyword_submit_${code}_summary_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  )
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8').catch(() => {})
  logStep(`summary: ${summaryPath}`)
  console.log(JSON.stringify(summary, null, 2))

  // 弹汇总 modal
  const anyOk = allReports.some((r) => r.ok)
  const anyErr = allReports.some((r) => r.errors && r.errors.length)
  const lastReport = allReports[allReports.length - 1]
  const lines = shopRegions.length === 1
    ? buildReportLines(lastReport)
    : [
        `本次共 ${shopRegions.length} 个区域：${shopRegions.join(', ')}`,
        `总成功 relate：${summary.totalSubmitSuccess}`,
        `总跳过：${summary.totalSkipped}`,
        `因 DOM 缺元素跳过 product：${summary.totalSkippedProducts}`,
        '',
        '—— 各 region 汇总 ——',
        ...summary.perRegion.flatMap((r) => [
          `${r.shopRegion}: ${r.ok ? '✅' : '⚠️'} success=${r.submitSuccess} skipped=${r.skipped} skippedProducts=${r.skippedProducts} errors=${r.errors.length}`,
        ]),
      ]
  const variant = anyErr ? 'danger' : 'success'
  const title = anyOk
    ? (shopRegions.length > 1 ? `任务已完成（${shopRegions.length} 个区域）` : '任务已完成')
    : '任务已结束（部分失败）'

  // 弹 modal：直接用 runForRegion 返回的最后一个 region 的 page/conn
  // 之前"兜底重开浏览器"那段已删——runForRegion 100% 会返回 page
  if (lastPage) {
    try {
      await showPageResultModalUntilAck(lastPage, {
        title, variant, lines,
      })
    } catch (e) {
      logStep(`弹汇总 modal 失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  } else {
    logStep('无 page 可用，跳过页面汇总 modal（终端 summary 仍可用）')
  }

  if (keepOpen && lastPage) {
    await new Promise(() => {})
  }

  if (lastConn && !keepOpen) {
    await lastConn.browser?.close().catch(() => {})
  }
  if (!anyOk) process.exitCode = 1
  try { db.close() } catch { /* ignore */ }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

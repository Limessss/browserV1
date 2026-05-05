#!/usr/bin/env node

/**
 * TikTok Shop 卖家中心：带货视频 → AI 视频生成器 → 选品 → 生成视频。
 *
 * 成对文档：`mcp_tiktok_shoppable_ai_video.md`；开发/修改流程见上级 `../README.md`（必守）。
 * 修改定位或交互前：须先用 Playwright MCP 在真实页验证；若 MCP 无法连上本机 CDP，则按 README
 * 用同一 CDP 做等价验证（本脚本支持 `--cdp <url>`，常见为 Launch 暴露地址如 http://127.0.0.1:19876），
 * 再将实测结论写回 `mcp_*.md` 与本文件。
 *
 * 须已在本机浏览器登录卖家中心；无登录 Cookie 时会卡在登录页。
 * 连接方式与 `../baidu_today_weather/baidu_today_weather.mjs` 相同：--useLaunchApi / --cdp / --launch-edge / 默认 Chromium。
 *
 * 示例：
 *   node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --useLaunchApi --code ICHPPH
 *   node ... --useLaunchApi --code YOUR_CODE --shop_region PH
 *   node ... --useLaunchApi --code YOUR_CODE --shop_region PH --product_id 1234567890
 *   node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --cdp http://127.0.0.1:19876 --shop_region PH
 *   node playwright_scripts/tiktok_shoppable_ai_video/tiktok_shoppable_ai_video.mjs --launch-edge
 */

import { chromium } from 'playwright'

const MATERIAL_PAGE_PATH = '/shoppable-videos/material-2-video'

/** @param {string} shopRegion 如 PH、US、ID；空则不带 shop_region */
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
    launchArgs: ['--window-size=1280,900'],
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
 * 在「选择一款商品」弹窗中：无 productId 时点首行；有 productId 时先搜索（Enter），**搜索结果出现后点击该行 `<tr>`** 即可选中（无需抠 radio）。
 * @param {import('playwright').Locator} productDialog
 * @param {string} productId
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
 * 先点整行（符合「点行选中」）；若「确认」仍未启用，再点行内 label / radio（实测部分 Arco 表格仅点 tr 不会勾选）。
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
 * 填入 product_id 后先 **Enter 触发搜索**，结果出现后点击商品行（必要时 fallback label/radio），再轮询「确认」可点。
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
      const n = await loc.count().catch(() => 0)
      if (n > 0) {
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
 * 「选择一款商品」层：页面可能同时存在 drawer 外壳与内层 Arco Modal，两者文案都含「选择一款商品」，
 * 仅按 hasText 会 strict 命中 2 个 [role=dialog]。收窄为：含商品表 + 底部「确认」的弹层。
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
 * 主流程「AI 视频生成器」弹窗：同页可能多个 dialog，用「生成视频」按钮缩窄。
 * @param {import('playwright').Page} page
 */
function locatorAiVideoGeneratorDialog(page) {
  return page
    .getByRole('dialog')
    .filter({ hasText: /AI 视频生成器/ })
    .filter({ has: page.getByRole('button', { name: /生成视频/ }) })
}

/**
 * 与 MCP 相同交互语义：AI 视频生成器 → 选择商品 →（可选按 product_id）→ 确认 → 生成视频。
 * @param {{ pageUrl: string, productId: string }} opts
 */
async function runAiVideoFlow(page, opts) {
  const { pageUrl, productId } = opts
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  // material-2-video 为 SPA：实测仅在 domcontentloaded 后主区按钮尚未挂载；须等待后再点。
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

function resolveMaterialOptions() {
  const shopRegion = getArgValue('--shop_region') || ''
  const productId = getArgValue('--product_id') || ''
  const pageUrl = buildMaterialPageUrl(shopRegion)
  return { pageUrl, productId: String(productId).trim(), shopRegion: String(shopRegion).trim() }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const cdpUrl =
    getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const flowOpts = resolveMaterialOptions()

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
    const result = await runAiVideoFlow(page, flowOpts)
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

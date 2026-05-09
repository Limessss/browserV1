#!/usr/bin/env node

import { chromium } from 'playwright'

const MATERIAL_PAGE_PATH = '/shoppable-videos/material-2-video'
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''

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

function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildMaterialPageUrl(shopRegion) {
  const u = new URL(MATERIAL_PAGE_PATH, 'https://seller.tiktokshopglobalselling.com')
  u.searchParams.set('from', 'tab')
  const region = String(shopRegion || '').trim()
  if (region) u.searchParams.set('shop_region', region)
  return u.toString()
}

function buildHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_AUTH_KEY) headers[DEFAULT_AUTH_HEADER] = DEFAULT_AUTH_KEY
  return headers
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
  return { matchMode: 'first' }
}

async function connectViaLaunchApi(baseUrl, startUrl) {
  await requestJson(`${baseUrl}/api/health`, { method: 'GET', headers: buildHeaders() })
  const launchResponse = await requestJson(`${baseUrl}/api/launch`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify({
      selector: resolveSelector(),
      launchArgs: ['--window-size=1280,900'],
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
      headers: buildHeaders(),
    })
  }
  const cdpUrl = String(ready?.cdpUrl || '').trim()
  if (!cdpUrl) throw new Error('未拿到 cdpUrl')
  return connectOverCdp(cdpUrl)
}

async function connectOverCdp(cdpUrl) {
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  return { browser, page }
}

function parseRowText(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  const id = normalized.match(/ID:\s*(\d+)/)?.[1] || ''
  const generated = Number(normalized.match(/已生成\s*(\d+)\s*个视频/)?.[1] || 0)
  const pub = normalized.match(/(\d+)\/(\d+)\s*已发布/)
  const published = pub ? Number(pub[1]) : 0
  const publishTotal = pub ? Number(pub[2]) : generated
  const status = normalized.includes('已完成') ? 'done' : normalized.includes('未完成') ? 'incomplete' : ''
  return { id, generated, published, publishTotal, status, text: normalized }
}

function isPending(row) {
  return row.status === 'done' && row.generated > 0 && row.published < row.publishTotal
}

async function clickPageNumber(page, pageNumber) {
  const pagerItem = page
    .locator('li.theme-arco-pagination-item')
    .filter({ hasText: new RegExp(`^\\s*${pageNumber}\\s*$`) })
  if (await pagerItem.count().catch(() => 0)) {
    await pagerItem.first().click()
    await page.waitForTimeout(5000)
    return true
  }
  return false
}

async function gotoList(page, pageUrl, pageNumber = 1) {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForTimeout(7000)
  if (pageNumber > 1) await clickPageNumber(page, pageNumber)
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
}

async function readRows(page) {
  const rows = page.locator('table tbody tr')
  const count = await rows.count().catch(() => 0)
  const out = []
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i)
    const parsed = parseRowText(await row.innerText().catch(() => ''))
    if (parsed.id) out.push({ index: i, ...parsed })
  }
  return out
}

async function closeAddProductDialogIfPresent(page) {
  const dialog = page.getByRole('dialog').filter({ hasText: '将商品添加到你的视频' }).last()
  if (!(await dialog.count().catch(() => 0))) return false
  if (!(await dialog.isVisible().catch(() => false))) return false
  const buttons = dialog.locator('button')
  const count = await buttons.count().catch(() => 0)
  if (count > 0) await buttons.nth(count - 1).click().catch(() => {})
  else await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(1000)
  return true
}

async function waitProductCardLoaded(page, productId) {
  const id = String(productId || '').trim()
  for (let i = 0; i < 40; i += 1) {
    await closeAddProductDialogIfPresent(page)
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')
    const hasProductId = id ? body.includes(id) : true
    const editVisible = await page.getByRole('button', { name: '编辑' }).last().isVisible().catch(() => false)
    if (body.includes('商品') && body.includes('添加商品') && hasProductId && editVisible) return
    await page.mouse.wheel(0, 600).catch(() => {})
    await sleep(1000)
  }
  throw new Error(`商品卡片未加载完成，跳过发布: ${productId}`)
}

async function ensureAiGeneratedContentEnabled(page) {
  await page.getByText('AI 生成的内容').last().scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {})
  await sleep(500)
  const result = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    const candidates = []
    while (walker.nextNode()) {
      const el = /** @type {HTMLElement} */ (walker.currentNode)
      const text = (el.innerText || el.textContent || '').trim()
      if (text === 'AI 生成的内容' || text.includes('AI 生成的内容')) candidates.push(el)
    }
    const label = candidates.at(-1)
    if (!label) return { ok: false, reason: 'label-not-found' }
    let root = label
    for (let i = 0; i < 8 && root; i += 1) {
      const switches = Array.from(root.querySelectorAll('[role="switch"], .content-arco-switch, .core-switch'))
      const sw = switches.find((node) => node instanceof HTMLElement)
      if (sw instanceof HTMLElement) {
        const cls = String(sw.className || '')
        const enabled = sw.getAttribute('aria-checked') === 'true' || /\bchecked\b|switch-checked|is-checked/.test(cls)
        if (!enabled) sw.click()
        return { ok: true, clicked: !enabled }
      }
      root = root.parentElement
    }
    return { ok: false, reason: 'switch-not-found' }
  })
  await sleep(800)
  if (!result.ok) throw new Error(`未找到 AI 生成的内容开关: ${JSON.stringify(result)}`)
}

async function clickFinalPublishWhenReady(page, rowInfo) {
  await waitProductCardLoaded(page, rowInfo.id)
  await ensureAiGeneratedContentEnabled(page)
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: '在 TikTok 上发布' }).last().click()
    await sleep(1500)
    if (await closeAddProductDialogIfPresent(page)) {
      await waitProductCardLoaded(page, rowInfo.id)
      await ensureAiGeneratedContentEnabled(page)
      continue
    }
    return
  }
  throw new Error(`商品仍未被发布表单识别: ${rowInfo.id}`)
}

async function publishOneFromRow(page, rowInfo) {
  const row = page.locator('table tbody tr').filter({ hasText: rowInfo.id }).first()
  await row.waitFor({ state: 'visible', timeout: 30000 })
  await row.getByRole('button', { name: '查看' }).click()
  await page.getByText('你的视频已准备就绪').waitFor({ state: 'visible', timeout: 30000 })
  await sleep(1000)
  await page.getByRole('button', { name: '在 TikTok 上发布' }).last().click()
  await page.locator('text=TikTok 账号详情').waitFor({ state: 'visible', timeout: 30000 })
  await sleep(1500)
  await clickFinalPublishWhenReady(page, rowInfo)
  await page.getByText('你的视频发布成功').waitFor({ state: 'visible', timeout: 90000 })
  await sleep(3000)
}

async function run() {
  const shopRegion = getArgValue('--shop_region') || 'MY'
  const pageUrl = buildMaterialPageUrl(shopRegion)
  const maxPublishes = getNumberArg('--max', 200)
  const maxPages = getNumberArg('--pages', 5)
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const conn = hasFlag('--useLaunchApi')
    ? await connectViaLaunchApi(baseUrl, pageUrl)
    : await connectOverCdp(cdpUrl || 'http://127.0.0.1:19876')
  const { browser, page } = conn
  const log = []
  let currentPage = 1

  try {
    await gotoList(page, pageUrl, currentPage)
    for (let guard = 0; guard < maxPublishes; guard += 1) {
      let rows = await readRows(page)
      let pending = rows.find(isPending)
      while (!pending && currentPage < maxPages) {
        currentPage += 1
        if (!(await clickPageNumber(page, currentPage))) break
        rows = await readRows(page)
        pending = rows.find(isPending)
      }
      if (!pending) break
      console.log(`[publish] page=${currentPage} id=${pending.id} ${pending.published}/${pending.publishTotal}`)
      await publishOneFromRow(page, pending)
      log.push({ page: currentPage, id: pending.id, before: `${pending.published}/${pending.publishTotal}` })
      await gotoList(page, pageUrl, currentPage)
    }
    console.log(JSON.stringify({ publishedCount: log.length, log }, null, 2))
    if (keepOpen) await new Promise(() => {})
  } finally {
    if (!keepOpen) await browser.close()
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

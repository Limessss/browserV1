#!/usr/bin/env node

import { chromium } from 'playwright'

const OPTIMIZER_PATH = '/product/optimizer'
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 35
const DEBUG_READY_INTERVAL_MS = 1000

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx !== -1 && idx + 1 < process.argv.length) return String(process.argv[idx + 1] || '').trim()

  const inline = process.argv.find((arg) => arg.startsWith(`${flagName}=`))
  return inline ? inline.slice(flagName.length + 1).trim() : ''
}

function getNumberArg(flagName, fallback) {
  const raw = getArgValue(flagName)
  if (raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function hasFlag(flagName) {
  return process.argv.includes(flagName)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseShopRegions(raw) {
  const s = String(raw || '').trim()
  if (!s) return ['MY']

  if (s.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(s)
    } catch {
      throw new Error('Failed to parse --shop_region JSON array, for example: --shop_region \'["MY","PH"]\'')
    }
    if (!Array.isArray(parsed)) throw new Error('--shop_region JSON value must be an array')
    const codes = parsed.map((x) => String(x ?? '').trim()).filter(Boolean)
    return codes.length ? codes : ['MY']
  }

  if (s.includes(',')) {
    const codes = s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    return codes.length ? codes : ['MY']
  }

  return [s]
}

function buildOptimizerUrl(shopRegion) {
  const url = new URL(OPTIMIZER_PATH, 'https://seller.tiktokshopglobalselling.com')
  url.searchParams.set('shop_region', shopRegion)
  return url.toString()
}

function requestJson(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      ...(DEFAULT_AUTH_KEY ? { [DEFAULT_AUTH_HEADER]: DEFAULT_AUTH_KEY } : {}),
      ...(options.headers || {}),
    },
  }).then(async (res) => {
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text }
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
    }
    return json
  })
}

async function checkHealth(baseUrl) {
  try {
    const json = await requestJson(new URL('/api/health', baseUrl).toString())
    return Boolean(json?.ok)
  } catch {
    return false
  }
}

function resolveLaunchSelector() {
  const selectorKeys = ['code', 'keyword', 'profileId', 'profileName']
  const selector = {}
  for (const key of selectorKeys) {
    const value = getArgValue(`--${key}`)
    if (value) selector[key] = value
  }
  if (!Object.keys(selector).length) selector.code = 'IKXSD8'
  return selector
}

async function launchProfile(startUrl) {
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const ok = await checkHealth(baseUrl)
  if (!ok) throw new Error(`Launch API is not healthy: ${baseUrl}`)

  const selector = resolveLaunchSelector()
  const payload = {
    ...selector,
    launchArgs: [startUrl],
  }

  const json = await requestJson(new URL('/api/launch', baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })

  const cdpUrl =
    json?.cdpUrl ||
    json?.data?.cdpUrl ||
    json?.debuggingUrl ||
    json?.data?.debuggingUrl ||
    json?.wsEndpoint ||
    json?.data?.wsEndpoint ||
    baseUrl

  return { cdpUrl, launchResponse: json }
}

async function waitUntilDebugReady(cdpUrl) {
  for (let i = 0; i < DEBUG_READY_RETRY; i += 1) {
    try {
      const res = await fetch(new URL('/json/version', cdpUrl).toString())
      if (res.ok) return true
    } catch {
      // keep polling
    }
    await sleep(DEBUG_READY_INTERVAL_MS)
  }
  return false
}

async function connectBrowser(startUrl) {
  const explicitCdp = getArgValue('--cdp')
  if (explicitCdp) {
    return {
      browser: await chromium.connectOverCDP(explicitCdp),
      closeBrowser: !hasFlag('--keepOpen'),
      cdpUrl: explicitCdp,
      launchResponse: null,
    }
  }

  if (hasFlag('--useLaunchApi')) {
    const { cdpUrl, launchResponse } = await launchProfile(startUrl)
    const ready = await waitUntilDebugReady(cdpUrl)
    if (!ready) throw new Error(`CDP is not ready after launch: ${cdpUrl}`)
    return {
      browser: await chromium.connectOverCDP(cdpUrl),
      closeBrowser: !hasFlag('--keepOpen'),
      cdpUrl,
      launchResponse,
    }
  }

  const headed = hasFlag('--headed')
  const browser = await chromium.launch({ headless: !headed })
  return { browser, closeBrowser: true, cdpUrl: '', launchResponse: null }
}

async function getActivePage(browser, startUrl) {
  const context = browser.contexts()[0] || (await browser.newContext())
  const pages = context.pages()
  const page = pages[0] || (await context.newPage())
  if (page.url() === 'about:blank') await page.goto(startUrl, { waitUntil: 'domcontentloaded' })
  return page
}

async function safeBodyPreview(page) {
  try {
    const text = await page.locator('body').innerText({ timeout: 3000 })
    return text.replace(/\s+/g, ' ').slice(0, 1200)
  } catch {
    return ''
  }
}

async function clickFirstVisibleLocator(locator, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0)
    for (let i = 0; i < count; i += 1) {
      const item = locator.nth(i)
      try {
        if (!(await item.isVisible({ timeout: 300 }).catch(() => false))) continue
        if (!(await item.isEnabled({ timeout: 300 }).catch(() => true))) continue
        const text = await item.innerText({ timeout: 500 }).catch(() => '')
        await item.click({ timeout: 3000 })
        return { ok: true, text: text.replace(/\s+/g, ' ').trim() }
      } catch (err) {
        lastError = err
      }
    }
    await sleep(300)
  }

  return { ok: false, error: lastError?.message || 'No visible clickable locator found' }
}

async function clickBatchOptimize(page) {
  const roleButton = page.getByRole('button', {
    name: /批量优化|Bulk\s+optimi[sz]e|Batch\s+optimi[sz]e/i,
  })
  let clicked = await clickFirstVisibleLocator(roleButton, 6000)
  if (clicked.ok) return clicked

  const fallback = page.locator('button, [role="button"], a').filter({
    hasText: /批量优化|Bulk\s+optimi[sz]e|Batch\s+optimi[sz]e/i,
  })
  clicked = await clickFirstVisibleLocator(fallback, 6000)
  if (clicked.ok) return clicked

  return page.evaluate(() => {
    const pattern = /批量优化|Bulk\s+optimi[sz]e|Batch\s+optimi[sz]e/i
    const nodes = [...document.querySelectorAll('button, [role="button"], a, span, div')]
    const visible = (el) => {
      const style = window.getComputedStyle(el)
      const rect = el.getBoundingClientRect()
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
    }
    const target = nodes.find((el) => pattern.test((el.textContent || '').trim()) && visible(el))
    if (!target) return { ok: false, error: 'Batch optimize button not found' }
    target.click()
    return { ok: true, text: (target.textContent || '').replace(/\s+/g, ' ').trim() }
  })
}

async function clickUpdateProducts(page, { dryRun = false, timeoutMs = 20000 } = {}) {
  const updatePattern = /\u66f4\u65b0\s*\d+\s*\u4ef6\u5546\u54c1|Update\s*\d+\s*products?/i
  const deadline = Date.now() + timeoutMs
  let lastDisabledZero = null
  let lastClickError = null

  while (Date.now() < deadline) {
    const candidate = page.locator('button, [role="button"]').filter({ hasText: updatePattern })
    const count = await candidate.count().catch(() => 0)

    for (let i = 0; i < count; i += 1) {
      const item = candidate.nth(i)
      const visible = await item.isVisible({ timeout: 500 }).catch(() => false)
      const enabled = await item.isEnabled({ timeout: 500 }).catch(() => true)
      if (!visible) continue

      const text = (await item.innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim()
      const matchedCount = Number((text.match(/\d+/) || [0])[0])
      if (dryRun) return { ok: true, dryRun: true, text, productCount: matchedCount, clicked: false }
      if (!enabled) {
        if (matchedCount === 0) {
          lastDisabledZero = { ok: false, text, productCount: matchedCount, error: 'Update button is disabled' }
          continue
        }
        return { ok: false, text, productCount: matchedCount, error: 'Update button is disabled' }
      }

      try {
        await item.click({ timeout: Math.min(15000, Math.max(5000, deadline - Date.now())) })
        return { ok: true, dryRun: false, text, productCount: matchedCount, clicked: true }
      } catch (err) {
        lastClickError = { ok: false, text, productCount: matchedCount, error: err?.message || String(err) }
      }
    }

    await sleep(500)
  }

  if (lastDisabledZero) return lastDisabledZero
  if (lastClickError) return lastClickError

  return page.evaluate(
    ({ dry }) => {
      const pattern = /更新\s*\d+\s*件商品|Update\s*\d+\s*products?/i
      const nodes = [...document.querySelectorAll('button, [role="button"], a, div, span')]
      const visible = (el) => {
        const style = window.getComputedStyle(el)
        const rect = el.getBoundingClientRect()
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0
      }
      const target = nodes.find((el) => pattern.test((el.textContent || '').replace(/\s+/g, ' ').trim()) && visible(el))
      if (!target) return { ok: false, error: 'Update products button not found' }

      const text = (target.textContent || '').replace(/\s+/g, ' ').trim()
      const productCount = Number((text.match(/\d+/) || [0])[0])
      if (!dry) target.click()
      return { ok: true, dryRun: dry, text, productCount, clicked: !dry }
    },
    { dry: dryRun },
  )
}

async function updateProductsUntilDone(page, options) {
  const batches = []
  let lastResult = null

  for (let batchIndex = 1; batchIndex <= options.maxUpdateBatches; batchIndex += 1) {
    const updateResult = await clickUpdateProducts(page, {
      dryRun: options.dryRun,
      timeoutMs: options.updateButtonTimeoutMs,
    })
    lastResult = updateResult

    if (!updateResult.ok) {
      const noUpdateButton = /not found/i.test(updateResult.error || '')
      const noMoreProducts =
        Number(updateResult.productCount) === 0 &&
        /disabled/i.test(updateResult.error || '') &&
        /\b0\b/.test(updateResult.text || '0')
      return {
        ok: noUpdateButton || noMoreProducts || batches.length > 0,
        batches,
        lastResult: updateResult,
        totalProductCount: batches.reduce((sum, item) => sum + (Number(item.productCount) || 0), 0),
        stopReason: noMoreProducts ? 'no_more_products' : noUpdateButton ? 'no_update_button_found' : 'update_button_error',
      }
    }

    batches.push({
      batchIndex,
      text: updateResult.text,
      productCount: updateResult.productCount,
      clicked: updateResult.clicked,
      dryRun: updateResult.dryRun,
    })

    if (options.dryRun) {
      return {
        ok: true,
        batches,
        lastResult: updateResult,
        totalProductCount: batches.reduce((sum, item) => sum + (Number(item.productCount) || 0), 0),
        stopReason: 'dry_run_first_batch_only',
      }
    }

    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterUpdateClickMs)
  }

  return {
    ok: false,
    batches,
    lastResult,
    totalProductCount: batches.reduce((sum, item) => sum + (Number(item.productCount) || 0), 0),
    stopReason: `max_update_batches_reached_${options.maxUpdateBatches}`,
  }
}

async function runForRegion(page, shopRegion, options) {
  const url = buildOptimizerUrl(shopRegion)
  const result = {
    shopRegion,
    url,
    ok: false,
    batchOptimize: null,
    updateProducts: null,
    updateBatches: [],
    totalProductCount: 0,
    stopReason: '',
    finalUrl: '',
    bodyPreview: '',
  }

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs })
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.waitMs)

    if (/\/account\/login/i.test(page.url())) {
      result.error = 'TikTok Shop login is required for this browser profile'
      result.bodyPreview = await safeBodyPreview(page)
      result.finalUrl = page.url()
      return result
    }

    result.batchOptimize = await clickBatchOptimize(page)
    if (!result.batchOptimize?.ok) {
      result.bodyPreview = await safeBodyPreview(page)
      result.finalUrl = page.url()
      return result
    }

    await sleep(options.afterBatchClickMs)
    const updateSummary = await updateProductsUntilDone(page, options)
    result.updateProducts = updateSummary.lastResult
    result.updateBatches = updateSummary.batches
    result.totalProductCount = updateSummary.totalProductCount
    result.stopReason = updateSummary.stopReason

    result.finalUrl = page.url()
    result.bodyPreview = await safeBodyPreview(page)
    result.ok = Boolean(result.batchOptimize?.ok && updateSummary.ok)
    return result
  } catch (err) {
    result.error = err?.message || String(err)
    result.finalUrl = page.url()
    result.bodyPreview = await safeBodyPreview(page)
    return result
  }
}

async function main() {
  const shopRegions = parseShopRegions(getArgValue('--shop_region'))
  const dryRun = hasFlag('--dryRun')
  const options = {
    dryRun,
    waitMs: getNumberArg('--wait_ms', 1500),
    afterBatchClickMs: getNumberArg('--after_batch_click_ms', 1200),
    afterUpdateClickMs: getNumberArg('--after_update_click_ms', 2500),
    updateButtonTimeoutMs: getNumberArg('--update_button_timeout_ms', 60000),
    maxUpdateBatches: getNumberArg('--max_update_batches', 100),
    navigationTimeoutMs: getNumberArg('--navigation_timeout_ms', 60000),
    networkIdleTimeoutMs: getNumberArg('--network_idle_timeout_ms', 12000),
  }

  const startUrl = buildOptimizerUrl(shopRegions[0])
  const connection = await connectBrowser(startUrl)
  const page = await getActivePage(connection.browser, startUrl)
  page.setDefaultTimeout(12000)

  const results = []
  try {
    for (const shopRegion of shopRegions) {
      console.log(`[${shopRegion}] open product optimizer and ${dryRun ? 'locate' : 'click'} batch update`)
      results.push(await runForRegion(page, shopRegion, options))
    }
  } finally {
    if (connection.closeBrowser) {
      await connection.browser.close().catch(() => {})
    }
  }

  const summary = {
    ok: results.every((x) => x.ok),
    dryRun,
    cdpUrl: connection.cdpUrl,
    shopRegions,
    results,
  }

  console.log(JSON.stringify(summary, null, 2))
  if (!summary.ok) process.exitCode = 1
  if (hasFlag('--keepOpen')) {
    setTimeout(() => process.exit(process.exitCode || 0), 50)
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exitCode = 1
})

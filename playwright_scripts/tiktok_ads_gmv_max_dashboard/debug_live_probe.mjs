#!/usr/bin/env node

/**
 * Fast live probe for TikTok Ads GMV Max pages.
 *
 * This script is intentionally read-heavy and short-lived: it opens or attaches to a
 * real logged-in browser, visits the GMV Max URL, captures page state, and leaves
 * enough selectors/text for tightening the production script.
 *
 * Examples:
 *   node playwright_scripts/tiktok_ads_gmv_max_dashboard/debug_live_probe.mjs --useLaunchApi --code IKXSD8 --aadvid 7581297450980294657
 *   node playwright_scripts/tiktok_ads_gmv_max_dashboard/debug_live_probe.mjs --cdp http://127.0.0.1:19876 --aadvid 7581297450980294657 --noNavigate
 */

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DASHBOARD_URL = 'https://ads.tiktok.com/i18n/gmv-max/dashboard'
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
  if (DEFAULT_AUTH_KEY) headers[DEFAULT_AUTH_HEADER] = DEFAULT_AUTH_KEY
  return headers
}

function buildDashboardUrl(aadvid) {
  const u = new URL(DASHBOARD_URL)
  u.searchParams.set('aadvid', String(aadvid || '').trim())
  u.searchParams.set('oec_seller_id', 'withoutShop')
  return u.toString()
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

function logStep(message) {
  process.stdout.write(`[probe ${new Date().toLocaleTimeString()}] ${message}\n`)
}

async function withTimeout(promise, ms, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
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
  logStep(`checking Launch API health: ${baseUrl}`)
  await requestJson(`${baseUrl}/api/health`, { method: 'GET', headers: buildHeaders() })
  logStep(`launching profile at: ${startUrl}`)
  const launchResponse = await launchProfile(baseUrl, startUrl)
  logStep(`waiting debug endpoint, launchCode=${launchResponse?.launchCode || ''}`)
  const readyResponse = await waitUntilDebugReady(baseUrl, launchResponse)
  const cdpUrl = String(readyResponse?.cdpUrl || '').trim()
  if (!cdpUrl) throw new Error('Launch API did not return cdpUrl')
  logStep(`connecting CDP: ${cdpUrl}`)
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  return { browser, page, cdpUrl, launchResponse: readyResponse }
}

async function connectBrowser({ cdpUrl, headed }) {
  if (cdpUrl) {
    logStep(`connecting existing CDP: ${cdpUrl}`)
    const browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    return { browser, page, cdpUrl }
  }
  logStep('launching local Chromium')
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  return { browser, page, cdpUrl: '' }
}

async function capturePageState(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return rect.width > 4 && rect.height > 4 && st.visibility !== 'hidden' && st.display !== 'none'
    }
    const describe = (el, index) => ({
      index,
      tag: el.tagName,
      role: el.getAttribute('role') || '',
      text: compact(el.innerText || el.textContent || el.getAttribute('aria-label') || '').slice(0, 240),
      aria: compact(el.getAttribute('aria-label') || ''),
      title: compact(el.getAttribute('title') || ''),
      href: el.href || '',
      className: compact(el.className || '').slice(0, 180),
      id: el.id || '',
      testid: el.getAttribute('data-testid') || '',
      e2e: el.getAttribute('data-e2e') || '',
      rect: (() => {
        const r = el.getBoundingClientRect()
        return {
          x: Math.round(r.x),
          y: Math.round(r.y),
          width: Math.round(r.width),
          height: Math.round(r.height),
        }
      })(),
    })

    const interactiveSelector = [
      'a',
      'button',
      'input',
      '[role="button"]',
      '[role="link"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[aria-haspopup]',
      '[data-e2e]',
      '[data-testid]',
      '[class*="select"]',
      '[class*="Select"]',
      '[class*="dropdown"]',
      '[class*="Dropdown"]',
      '[class*="shop"]',
      '[class*="Shop"]',
      '[class*="store"]',
      '[class*="Store"]',
      '[class*="account"]',
      '[class*="Account"]',
    ].join(',')

    const metricSelector = [
      '[class*="card"]',
      '[class*="Card"]',
      '[class*="metric"]',
      '[class*="Metric"]',
      '[class*="stat"]',
      '[class*="Stat"]',
      '[class*="overview"]',
      '[class*="Overview"]',
      '[data-e2e]',
      '[data-testid]',
    ].join(',')

    const interactive = Array.from(document.querySelectorAll(interactiveSelector))
      .filter(visible)
      .map(describe)
      .filter((x) => x.text || x.href || x.aria || x.testid || x.e2e)
      .slice(0, 220)

    const metricTextRe =
      /GMV|Gross|Cost|Spend|ROI|ROAS|Orders?|Impressions?|Clicks?|CTR|CVR|成交|花费|消耗|订单|曝光|展示|点击|转化|投入产出/i

    const metricCandidates = Array.from(document.querySelectorAll(metricSelector))
      .filter(visible)
      .map(describe)
      .filter((x) => x.text && metricTextRe.test(x.text))
      .slice(0, 160)

    const bodyText = compact(document.body.innerText || '')
    return {
      url: window.location.href,
      title: document.title,
      language: document.documentElement.lang || '',
      bodyPreview: bodyText.slice(0, 5000),
      bodyLength: bodyText.length,
      interactive,
      metricCandidates,
    }
  })
}

async function main() {
  const aadvid = getArgValue('--aadvid')
  if (!aadvid) throw new Error('Missing required --aadvid, e.g. --aadvid 7581297450980294657')

  const targetUrl = buildDashboardUrl(aadvid)
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const headed = hasFlag('--headed')
  const noNavigate = hasFlag('--noNavigate')
  const keepOpen = hasFlag('--keepOpen')
  const waitMs = Number(getArgValue('--wait_ms') || 7000)
  const navigateTimeoutMs = Number(getArgValue('--nav_timeout_ms') || 45_000)
  const captureTimeoutMs = Number(getArgValue('--capture_timeout_ms') || 12_000)
  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')

  logStep(`target URL: ${targetUrl}`)
  const conn = useLaunchApi
    ? await connectViaLaunchApi(baseUrl, targetUrl)
    : await connectBrowser({ cdpUrl, headed })

  const { browser, page } = conn
  try {
    if (!noNavigate) {
      logStep('navigating target page')
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navigateTimeoutMs })
      logStep(`domcontentloaded, current URL: ${page.url()}`)
    }
    logStep(`waiting ${waitMs}ms for client render`)
    await sleep(waitMs)

    await mkdir(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const screenshotPath = path.join(outDir, `probe_${stamp}.png`)
    const jsonPath = path.join(outDir, `probe_${stamp}.json`)
    logStep('capturing viewport screenshot')
    await withTimeout(page.screenshot({ path: screenshotPath, fullPage: false }), captureTimeoutMs, 'screenshot').catch(
      (e) => logStep(`screenshot skipped: ${e.message}`),
    )
    logStep('reading DOM state')
    const state = await withTimeout(capturePageState(page), captureTimeoutMs, 'capture DOM state')
    const payload = {
      ok: true,
      targetUrl,
      cdpUrl: conn.cdpUrl || '',
      launchResponse: conn.launchResponse || null,
      capturedAt: new Date().toISOString(),
      screenshotPath,
      ...state,
    }
    logStep(`writing probe JSON: ${jsonPath}`)
    await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')
    console.log(JSON.stringify({ ...payload, jsonPath, bodyPreview: payload.bodyPreview.slice(0, 1600) }, null, 2))
  } finally {
    if (keepOpen) {
      logStep('keeping process and browser connection open because --keepOpen was passed')
      await new Promise(() => {})
    }
    logStep('closing browser connection')
    await browser.close().catch(() => {})
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

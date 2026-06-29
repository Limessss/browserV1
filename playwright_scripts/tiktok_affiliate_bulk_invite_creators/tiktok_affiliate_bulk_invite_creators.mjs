#!/usr/bin/env node

import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logProgress, showPageResultModalUntilAck } from '../_lib/page_runtime_ui.mjs'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

const CREATOR_PATH = '/connection/creator'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const INVITED_LEDGER_PATH = path.join(__dirname, 'invited_creators_by_product.sqlite')
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEBUG_READY_RETRY = 35
const DEBUG_READY_INTERVAL_MS = 1000

const TEXT_BULK_INVITE = '\u6279\u91cf\u9080\u8bf7'
const TEXT_INVITE = '\u9080\u8bf7'
const TEXT_CANCEL = '\u53d6\u6d88'
const TEXT_INVITED = '\u5df2\u9080\u8bf7'
const TEXT_RESET = '\u91cd\u7f6e'
const TEXT_TAB_IN_PROGRESS = '\u8fdb\u884c\u4e2d'
const TEXT_TAB_CREATE_NEW = '\u521b\u5efa\u65b0\u9080\u8bf7'
const TEXT_EMPTY_PLANS = '\u6682\u65e0\u4efb\u4f55\u9080\u8bf7'
const TEXT_DIALOG_SELECTOR = '.target-invitation-modal__CustomizedModal,[class*="target-invitation-modal"]'
const TEXT_PRODUCT_CATEGORY = '\u5546\u54c1\u7c7b\u76ee'
const TEXT_AVG_COMMISSION = '\u5e73\u5747\u4f63\u91d1\u7387'
const TEXT_CONTENT_TYPE = '\u5185\u5bb9\u7c7b\u578b'
const TEXT_CREATOR_AGENCY = '\u8fbe\u4eba\u673a\u6784'
const TEXT_CONTENT_LANGUAGE = '\u5185\u5bb9\u8bed\u8a00'
const TEXT_UNINVITED_90_DAYS = '\u8fc7\u53bb 90 \u5929\u5185\u672a\u83b7\u9080\u8bf7\u7684\u8fbe\u4eba'
const TEXT_CREATOR_TAB = '\u8fbe\u4eba'
const TEXT_FOLLOWERS_TAB = '\u7c89\u4e1d\u6570'
const TEXT_PERFORMANCE_TAB = '\u8868\u73b0'
const TEXT_FAN_AGE = '\u7c89\u4e1d\u5e74\u9f84'
const TEXT_FAN_GENDER = '\u7c89\u4e1d\u6027\u522b'
const TEXT_FAN_COUNT = '\u7c89\u4e1d\u6570'
const TEXT_GMV = 'GMV'
const TEXT_UNITS_SOLD = '\u6210\u4ea4\u4ef6\u6570'
const TEXT_AVG_VIDEO_VIEWS = '\u5e73\u5747\u6bcf\u4e2a\u89c6\u9891\u7684\u64ad\u653e\u91cf'
const TEXT_AVG_LIVE_VIEWS = '\u5e73\u5747\u6bcf\u573a\u76f4\u64ad\u7684\u89c2\u770b\u4eba\u6570'
const TEXT_ENGAGEMENT_RATE = '\u4e92\u52a8\u7387'
const TEXT_ESTIMATED_PUBLISH_RATE = '\u9884\u8ba1\u53d1\u5e03\u7387'
const TEXT_BRAND_COLLABORATION = '\u54c1\u724c\u5408\u4f5c'
// \u65b0\u6d41\u7a0b\u76f8\u5173
const TEXT_ONLY_COMMISSION = '\u4ec5\u4f63\u91d1'
const TEXT_INVITATION_NAME = '\u9080\u8bf7\u540d\u79f0'
const TEXT_CONTACT = '\u8054\u7cfb\u65b9\u5f0f'
const TEXT_INVITATION_TEXT = '\u9080\u8bf7\u6587\u672c'
const TEXT_SEND = '\u53d1\u9001'
const TEXT_INVITATION_SENT_SUCCESS = '\u5408\u4f5c\u9080\u8bf7\u53d1\u9001\u6210\u529f'
const TEXT_RESOLVE_DUPLICATES = '\u89e3\u51b3\u91cd\u590d\u95ee\u9898'
const TEXT_DUPLICATE_RESOLUTION_PROMPT = '\u4f60\u60f3\u5982\u4f55\u89e3\u51b3\u8fd9\u4e9b\u91cd\u590d\u95ee\u9898'
const TEXT_REMOVE_FROM_INVITATION = '\u4ece\u6b64\u9080\u8bf7\u4e2d\u79fb\u9664'
const TEXT_SOLVE = '\u53bb\u89e3\u51b3'
const TEXT_SEND_MESSAGE_TO_CREATORS = '\u5411\u8fbe\u4eba\u53d1\u9001\u6d88\u606f'
const TEXT_SHARE = '\u5206\u4eab'
const TEXT_CONFIRM = '\u786e\u8ba4'
const TEXT_PRODUCT_ADDED_SUCCESS = '\u4ef6\u5546\u54c1\u6dfb\u52a0\u6210\u529f'
const CREATOR_SORT_OPTIONS = ['\u76f8\u5173\u6027', 'GMV', '\u6210\u4ea4\u4ef6\u6570', '\u7c89\u4e1d\u6570', '\u5e73\u5747\u89c6\u9891\u64ad\u653e\u91cf', '\u4e92\u52a8\u7387']
const FILTER_VALUE_ALIASES = {
  contentLanguage: {
    en: '\u82f1\u8bed',
    eng: '\u82f1\u8bed',
    english: '\u82f1\u8bed',
  },
  contentType: {
    video: '\u89c6\u9891',
    live: '\u76f4\u64ad',
    livestream: '\u76f4\u64ad',
  },
  avgCommissionRate: {
    lt20: '\u5c0f\u4e8e 20%',
    '<20': '\u5c0f\u4e8e 20%',
    '<20%': '\u5c0f\u4e8e 20%',
    '小于20': '\u5c0f\u4e8e 20%',
    '小于20%': '\u5c0f\u4e8e 20%',
    lt15: '\u5c0f\u4e8e 15%',
    '<15': '\u5c0f\u4e8e 15%',
    '<15%': '\u5c0f\u4e8e 15%',
    '小于15': '\u5c0f\u4e8e 15%',
    '小于15%': '\u5c0f\u4e8e 15%',
    lt10: '\u5c0f\u4e8e 10%',
    '<10': '\u5c0f\u4e8e 10%',
    '<10%': '\u5c0f\u4e8e 10%',
    '小于10': '\u5c0f\u4e8e 10%',
    '小于10%': '\u5c0f\u4e8e 10%',
    lt5: '\u5c0f\u4e8e 5%',
    '<5': '\u5c0f\u4e8e 5%',
    '<5%': '\u5c0f\u4e8e 5%',
    '小于5': '\u5c0f\u4e8e 5%',
    '小于5%': '\u5c0f\u4e8e 5%',
  },
  fanGender: {
    male: '\u7537\u6027',
    female: '\u5973\u6027',
    men: '\u7537\u6027',
    women: '\u5973\u6027',
  },
  brandCollaboration: {
    yes: '\u662f',
    no: '\u5426',
    true: '\u662f',
    false: '\u5426',
  },
}

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

function getBooleanArg(flagName, fallback = null) {
  const raw = getArgValue(flagName)
  if (raw === '') return hasFlag(flagName) ? true : fallback
  if (/^(1|true|yes|y|on)$/i.test(raw)) return true
  if (/^(0|false|no|n|off)$/i.test(raw)) return false
  return fallback
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseShopRegions(raw) {
  const s = String(raw || '').trim()
  if (!s) return ['PH']

  if (s.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(s)
    } catch {
      throw new Error('Failed to parse --shop_region JSON array, for example: --shop_region \'["PH","MY"]\'')
    }
    if (!Array.isArray(parsed)) throw new Error('--shop_region JSON value must be an array')
    const codes = parsed.map((x) => String(x ?? '').trim()).filter(Boolean)
    return codes.length ? codes : ['PH']
  }

  if (s.includes(',')) {
    const codes = s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
    return codes.length ? codes : ['PH']
  }

  return [s]
}

function parseListArg(flagName) {
  const raw = getArgValue(flagName)
  const s = String(raw || '').trim()
  if (!s) return []

  if (s.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(s)
    } catch {
      throw new Error(`Failed to parse ${flagName} JSON array`)
    }
    if (!Array.isArray(parsed)) throw new Error(`${flagName} JSON value must be an array`)
    return parsed.map((x) => String(x ?? '').trim()).filter(Boolean)
  }

  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
}

function normalizeFilterValues(values, filterKey) {
  const aliases = FILTER_VALUE_ALIASES[filterKey] || {}
  return values.map((value) => aliases[value.toLowerCase()] || value)
}

const SHOP_REGION_CODES = ['MY', 'PH', 'SG', 'TH', 'VN', 'ID']

function regionCodeEq(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
}

function buildCreatorUrl(shopRegion) {
  const url = new URL(CREATOR_PATH, 'https://affiliate.tiktokshopglobalselling.com')
  url.searchParams.set('shop_region', shopRegion)
  return url.toString()
}

/** 从地址栏读取 shop_region（SPA 可能改写 URL，仅作辅助） */
async function readUrlShopRegionParam(page) {
  return page.evaluate(() => {
    try {
      return new URL(window.location.href).searchParams.get('shop_region') || ''
    } catch {
      return ''
    }
  })
}

/** 读取右上角头像旁的站点标识（MY/PH 等），比 URL 更可靠 */
async function readVisibleHeaderShopRegion(page) {
  return page.evaluate((codes) => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'
    }
    const matchCode = (text) => {
      const t = compact(text)
      return codes.find((code) => t === code) || ''
    }

    const headerAvatars = Array.from(document.querySelectorAll('[class*="pulse-avatar"]'))
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().top < 120)

    for (const av of headerAvatars) {
      let node = av.parentElement
      for (let depth = 0; depth < 8 && node; depth += 1) {
        const direct = matchCode(node.innerText || '')
        if (direct) return direct
        const nested = Array.from(node.querySelectorAll('span, div'))
          .filter(visible)
          .map((el) => matchCode(el.innerText || ''))
          .find(Boolean)
        if (nested) return nested
        node = node.parentElement
      }
    }

    return (
      Array.from(document.querySelectorAll('span, div'))
        .filter(visible)
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.top < 120 && r.right > window.innerWidth * 0.65
        })
        .map((el) => matchCode(el.innerText || ''))
        .find(Boolean) || ''
    )
  }, SHOP_REGION_CODES)
}

/** 等待联盟顶栏（联盟中心 + 右上角头像）就绪 */
async function waitForAffiliateHeaderReady(page, timeoutMs = 20_000) {
  try {
    await page.waitForFunction(
      () => {
        const visible = (el) => {
          const r = el.getBoundingClientRect()
          const st = window.getComputedStyle(el)
          return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'
        }
        const hasAvatar = Array.from(document.querySelectorAll('[class*="pulse-avatar"]'))
          .filter(visible)
          .some((el) => el.getBoundingClientRect().top < 120)
        const hasTitle = (document.body?.innerText || '').includes('联盟中心')
        return hasAvatar && hasTitle
      },
      { timeout: timeoutMs },
    )
    return { ok: true }
  } catch {
    return { ok: false, error: 'Affiliate header not ready' }
  }
}

/** 点击右上角头像（取最右侧），展开站点切换菜单 */
async function clickHeaderProfileMenu(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'
    }
    const headerAvatars = Array.from(document.querySelectorAll('[class*="pulse-avatar"]'))
      .filter(visible)
      .filter((el) => el.getBoundingClientRect().top < 120)
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)
    if (!headerAvatars.length) return { ok: false, error: 'Header avatar not found' }

    let clickTarget = headerAvatars[0]
    for (let node = headerAvatars[0]; node; node = node.parentElement) {
      if (node.getBoundingClientRect().top > 120) break
      const st = window.getComputedStyle(node)
      if (st.cursor === 'pointer' || node.getAttribute('role') === 'button') clickTarget = node
    }
    clickTarget.click()
    return { ok: true }
  })
}

async function waitForProfileRegionMenu(page, timeoutMs = 8000) {
  try {
    await page.waitForFunction(
      () => /Choose one to manage/i.test(document.body?.innerText || ''),
      { timeout: timeoutMs },
    )
    return { ok: true }
  } catch {
    return { ok: false, error: 'Profile region menu did not open' }
  }
}

/** 在头像下拉「Choose one to manage」面板内点击目标站点（探针：PH Philippines / MY Malaysia 等） */
async function clickShopRegionInProfileMenu(page, shopRegion) {
  return page.evaluate((want) => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const r = el.getBoundingClientRect()
      const st = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden'
    }
    const patterns = {
      MY: [/^MY\s+Malaysia$/i, /^MY$/],
      PH: [/^PH\s+Philippines$/i, /^Philippines(?:\s|\(|$)/i],
      SG: [/^SG\s+Singapore$/i, /^Singapore(?:\s|\(|$)/i],
      TH: [/^TH\s+Thailand$/i, /^Thailand(?:\s|\(|$)/i],
      VN: [/^VN\s+Vietnam$/i, /^Vietnam(?:\s|\(|$)/i],
      ID: [/^ID\s+Indonesia$/i, /^Indonesia(?:\s|\(|$)/i],
    }
    const pats = patterns[want] || [new RegExp(`^${want}$`)]
    const menuRoots = Array.from(document.querySelectorAll('div'))
      .filter(visible)
      .filter((el) => /Choose one to manage/i.test(el.innerText || ''))
    const root = menuRoots.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length)[0]
    if (!root) return { ok: false, error: 'Region menu root not found' }

    const candidates = []
    for (const el of root.querySelectorAll('div, span, li, button, [role="menuitem"]')) {
      if (!visible(el)) continue
      const text = compact(el.innerText || '')
      if (!text || text.length > 100) continue
      if (/退出|简体中文|店铺管理|账号持有人|店铺代码|Choose one to manage/i.test(text)) continue
      let score = -1
      for (let i = 0; i < pats.length; i += 1) {
        if (pats[i].test(text)) score = 100 - i * 10
      }
      if (score < 0) continue
      score += Math.min(text.length, 40) * 0.1
      candidates.push({ el, text, score })
    }
    candidates.sort((a, b) => b.score - a.score)
    const best = candidates[0]
    if (!best) return { ok: false, error: `Region option not found in menu: ${want}` }
    best.el.click()
    return { ok: true, text: best.text, score: best.score }
  }, String(shopRegion || '').trim().toUpperCase())
}

/** 对比顶栏站点标识，不一致则点头像切换 */
async function ensureAffiliateShopRegion(page, shopRegion, options = {}) {
  const want = String(shopRegion || '').trim().toUpperCase()
  if (!want) return { ok: true, skipped: true, switched: false, steps: [] }

  const maxAttempts = options.regionSwitchAttempts ?? 2
  const steps = []
  let visibleRegion = await readVisibleHeaderShopRegion(page)
  const urlRegion = await readUrlShopRegionParam(page)
  steps.push(`visible=${visibleRegion || '(empty)'} url=${urlRegion || '(empty)'}`)

  if (regionCodeEq(visibleRegion, want)) {
    return { ok: true, visibleRegion, urlRegion, steps, switched: false }
  }
  if (!visibleRegion && regionCodeEq(urlRegion, want)) {
    return { ok: true, visibleRegion, urlRegion, steps, switched: false }
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await waitForAffiliateHeaderReady(page, options.headerReadyTimeoutMs ?? 20_000)
    let opened = await clickHeaderProfileMenu(page)
    if (!opened.ok) {
      await sleep(1200)
      opened = await clickHeaderProfileMenu(page)
    }
    if (!opened.ok) return { ok: false, error: opened.error || 'Failed to open profile menu', steps, visibleRegion }

    const menuReady = await waitForProfileRegionMenu(page, options.profileMenuTimeoutMs ?? 8000)
    if (!menuReady.ok) {
      await page.keyboard.press('Escape').catch(() => {})
      return { ok: false, error: menuReady.error, steps, visibleRegion }
    }
    await sleep(options.afterProfileMenuMs ?? 400)
    steps.push('open-profile-menu')

    const picked = await clickShopRegionInProfileMenu(page, want)
    if (!picked.ok) {
      await page.keyboard.press('Escape').catch(() => {})
      return { ok: false, error: picked.error, steps, visibleRegion }
    }
    steps.push(`pick=${picked.text}`)

    await page.waitForLoadState('domcontentloaded', { timeout: options.navigationTimeoutMs ?? 120_000 }).catch(() => {})
    await sleep(options.afterRegionSwitchMs ?? 1500)

    visibleRegion = await readVisibleHeaderShopRegion(page)
    const nextUrlRegion = await readUrlShopRegionParam(page)
    steps.push(`after-visible=${visibleRegion || '(empty)'} url=${nextUrlRegion || '(empty)'}`)

    if (regionCodeEq(visibleRegion, want) || regionCodeEq(nextUrlRegion, want)) {
      return { ok: true, visibleRegion, urlRegion: nextUrlRegion, steps, switched: true }
    }
  }

  return {
    ok: false,
    error: `Header region still not ${want} after UI switch (visible=${visibleRegion || 'n/a'})`,
    visibleRegion,
    urlRegion: await readUrlShopRegionParam(page),
    steps,
  }
}

/** 打开达人发现页并确保顶栏站点与 --shop_region 一致 */
async function gotoCreatorPageRespectingShopRegion(page, shopRegion, options) {
  const url = buildCreatorUrl(shopRegion)
  const multiLabel = options.multiLabel || ''

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs })
  await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
  await sleep(options.waitMs)
  await waitForAffiliateHeaderReady(page, options.headerReadyTimeoutMs ?? 20_000)

  const visibleBefore = await readVisibleHeaderShopRegion(page)
  const urlRegionBefore = await readUrlShopRegionParam(page)
  const needSwitch = !regionCodeEq(visibleBefore, shopRegion) && !regionCodeEq(urlRegionBefore, shopRegion)

  if (needSwitch) {
    await logProgress(
      page,
      `[脚本${multiLabel}] 页面站点为 ${visibleBefore || urlRegionBefore || '未知'}，正在通过顶栏切换到 ${shopRegion}`,
    )
  }

  const ensured = await ensureAffiliateShopRegion(page, shopRegion, options)
  if (!ensured.ok) {
    return { ok: false, url, error: ensured.error, regionSwitch: ensured }
  }

  if (ensured.switched) {
    await logProgress(page, `[脚本${multiLabel}] 已通过顶栏切换到站点 ${shopRegion}`)
  }

  return {
    ok: true,
    url,
    regionSwitch: ensured,
    visibleRegion: ensured.visibleRegion,
    urlRegion: ensured.urlRegion,
  }
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
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 500)}`)
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
  if (!Object.keys(selector).length) selector.code = 'BUPM2Z'
  return selector
}

async function launchProfile(startUrl) {
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const ok = await checkHealth(baseUrl)
  if (!ok) throw new Error(`Launch API is not healthy: ${baseUrl}`)

  const json = await requestJson(new URL('/api/launch', baseUrl).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...resolveLaunchSelector(),
      launchArgs: [startUrl],
    }),
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
    return text.replace(/\s+/g, ' ').slice(0, 1600)
  } catch {
    return ''
  }
}

async function reapplyCreatorSelectionInputs(page, options, result) {
  const ready = await waitForCreatorPage(page, options)
  if (!ready.ok) return { ok: false, error: ready.error }

  result.filters = await applyCreatorFilters(page, options)
  if (!result.filters.ok) return { ok: false, error: result.filters.error }

  result.creatorSearch = await applyCreatorKeywordSearch(page, options)
  if (!result.creatorSearch.ok) return { ok: false, error: result.creatorSearch.error }

  result.creatorSort = await applyCreatorSort(page, options)
  if (!result.creatorSort.ok) return { ok: false, error: result.creatorSort.error }

  return { ok: true }
}

function buildAffiliateResultLines(result) {
  const selectedCount = result.selectedCreators?.selectedCreators?.length ?? result.selectedCreators?.count ?? 0
  return [
    `店铺区域：${result.shopRegion}`,
    `执行结果：${result.ok ? '成功' : '未完成'}`,
    `已选达人：${selectedCount} 人`,
    `商品 ID：${(result.productIds || []).join(', ') || '（无）'}`,
    ...(result.invitationName ? [`邀请名称：${result.invitationName}`] : []),
    ...(result.error ? [`异常：${result.error}`] : []),
    ...(result.finalInvite?.text ? [`最终步骤：${result.finalInvite.text}`] : []),
  ]
}

async function runCreateNewInvitationFlow(page, shopRegion, options, result, creatorPageUrl) {
  const multiLabel = options.multiLabel || ''
  const duplicateReselectAttempts = []
  const maxDuplicateReselectAttempts = options.duplicateReselectAttempts ?? 3

  for (let attempt = 0; attempt <= maxDuplicateReselectAttempts; attempt += 1) {
    if (attempt > 0) {
      await logProgress(page, `[脚本${multiLabel}] 检测到重复邀约达人，重新选人中（第 ${attempt + 1} 次）`)
      const renav = await gotoCreatorPageRespectingShopRegion(page, shopRegion, options)
      if (!renav.ok) {
        result.error = renav.error
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }
      const reapplied = await reapplyCreatorSelectionInputs(page, options, result)
      if (!reapplied.ok) {
        result.error = reapplied.error
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }
    }

    await logProgress(page, `[脚本${multiLabel}] 正在勾选达人（最多 ${options.maxCreators} 人）…`)
    result.selectedCreators = await selectCreatorRows(page, options.maxCreators, options)
    result.duplicateReselectAttempts = duplicateReselectAttempts
    if (!result.selectedCreators.ok) {
      result.error = 'No creators were selected'
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 未勾选到可用达人`)
      return result
    }
    const pickedCount = result.selectedCreators?.selectedCreators?.length ?? result.selectedCreators?.count ?? 0
    await logProgress(page, `[脚本${multiLabel}] 已勾选 ${pickedCount} 位达人，正在点击「批量邀约」`)

    await returnToBulkActions(page)
    result.bulkInvite = await clickButtonByText(page, TEXT_BULK_INVITE, { timeoutMs: options.invitationTimeoutMs })
    if (!result.bulkInvite.ok) {
      result.error = result.bulkInvite.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      return result
    }

    await sleep(options.afterBulkInviteMs)

    await logProgress(page, `[脚本${multiLabel}] 正在切换到「创建新邀请」·「仅佣金」`)
    const switchResult = await switchToCreateNewInvitation(page, options)
    result.createFlow = switchResult
    if (!switchResult.ok) {
      result.error = switchResult.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 切换创建新邀请失败`)
      return result
    }

    await logProgress(page, `[脚本${multiLabel}] 正在打开邀约表单页`)
    const formResult = await clickInviteButtonToForm(page, options)
    result.inviteToForm = formResult
    if (!formResult.ok) {
      result.error = formResult.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      return result
    }

    const selectedCreatorIdsFromUrl = attachCreatorIdsFromUrl(result.selectedCreators, page.url())
    result.selectedCreators.creatorIdsFromUrl = selectedCreatorIdsFromUrl
    const duplicateCreators = findAlreadyInvitedSelectedCreators(options.productIds, result.selectedCreators?.selectedCreators || [])
    if (duplicateCreators.length) {
      const ledgerNameEnrichment = enrichInvitedLedgerCreatorNames(
        options.productIds,
        duplicateCreators,
        { invitationName: options.invitationName, shopRegion },
      )
      duplicateReselectAttempts.push({
        attempt: attempt + 1,
        duplicates: duplicateCreators,
        ledgerNameEnrichment,
      })
      result.duplicateCreators = duplicateCreators
      result.duplicateReselectAttempts = duplicateReselectAttempts
      if (attempt < maxDuplicateReselectAttempts) continue

      result.error = `Selected creators already invited for product(s): ${duplicateCreators.map((item) => item.creatorId || item.name).join(', ')}`
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      return result
    }

    await logProgress(
      page,
      `[脚本${multiLabel}] 正在填写邀约表单（商品 ${options.productIds.length} 个）`,
    )
    result.formFill = await fillInvitationForm(page, options)
    result.ok = Boolean(result.formFill?.submitted)
    if (!result.ok) result.error = result.formFill?.error || 'Invitation form was not submitted'
    await logProgress(
      page,
      `[脚本${multiLabel}] ${result.ok ? '合作邀请发送成功' : '邀约发送未完成'}`,
    )

    result.finalUrl = page.url()
    result.bodyPreview = await safeBodyPreview(page)
    if (result.ok && /\u5408\u4f5c\u9080\u8bf7\u53d1\u9001\u6210\u529f|\u9080\u8bf7\u53d1\u9001\u6210\u529f/.test(result.bodyPreview || '')) {
      result.invitedLedger = recordInvitedCreatorsForProducts(
        options.productIds,
        result.selectedCreators?.selectedCreators || [],
        { invitationName: options.invitationName, shopRegion },
      )
    }
    return result
  }

  result.error = 'Duplicate reselect loop exhausted'
  result.finalUrl = page.url()
  result.bodyPreview = await safeBodyPreview(page)
  return result
}

async function clickButtonByText(page, text, { timeoutMs = 12000, preferLast = false } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    const result = await page.evaluate(
      ({ buttonText, last }) => {
        const visible = (el) => {
          const st = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const disabled = (el) =>
          Boolean(el.disabled) ||
          el.getAttribute('aria-disabled') === 'true' ||
          String(el.className || '').includes('disabled')
        const nodes = [...document.querySelectorAll('button,[role="button"]')].filter((el) => {
          const t = (el.textContent || '').replace(/\s+/g, ' ').trim()
          return visible(el) && t === buttonText
        })
        const enabledNodes = nodes.filter((el) => !disabled(el))
        const target = last ? enabledNodes.at(-1) : enabledNodes[0]
        if (!target) {
          return {
            ok: false,
            error: nodes.length ? `Button "${buttonText}" is disabled` : `Button "${buttonText}" not found`,
          }
        }
        const text = (target.textContent || '').replace(/\s+/g, ' ').trim()
        target.click()
        return { ok: true, text }
      },
      { buttonText: text, last: preferLast },
    )

    if (result.ok) return result
    lastError = result.error
    await sleep(400)
  }

  return { ok: false, error: lastError || `Button "${text}" not found` }
}

async function maybeResetFilters(page, options) {
  if (!options.resetFilters) return { ok: true, skipped: true }

  const result = await page.evaluate((resetText) => {
    const visible = (el) => {
      const st = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const disabled = (el) =>
      Boolean(el.disabled) ||
      el.getAttribute('aria-disabled') === 'true' ||
      String(el.className || '').includes('disabled')

    const button = [...document.querySelectorAll('button,[role="button"]')].find((el) => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
      return visible(el) && text === resetText
    })

    if (!button) return { ok: false, skipped: true, error: 'Reset button not found' }
    if (disabled(button)) return { ok: true, skipped: true, text: resetText }
    button.click()
    return { ok: true, skipped: false, text: resetText }
  }, TEXT_RESET)

  if (result.ok && !result.skipped) {
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFilterMs)
  }
  return result
}

async function clickExactFilterButton(page, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    const result = await page.evaluate((filterLabel) => {
      const visible = (el) => {
        const st = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible)
      const target = buttons.find((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
        return text === filterLabel || text.startsWith(`${filterLabel} `)
      })
      if (!target) return { ok: false, error: `Filter button "${filterLabel}" not found` }
      target.click()
      return { ok: true, text: (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim() }
    }, label)

    last = result
    if (result.ok) return result
    await sleep(300)
  }

  return last || { ok: false, error: `Filter button "${label}" timed out` }
}

async function clickDropdownOption(page, optionText, timeoutMs, opts = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null

  while (Date.now() < deadline) {
    const result = await page.evaluate(({ wanted, strictExact }) => {
      const normalize = (text) =>
        String(text || '')
          .replace(/\([0-9]+\)/g, '')
          .replace(/\s+/g, '')
          .trim()
      const visible = (el) => {
        const st = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const disabled = (el) =>
        Boolean(el.disabled) ||
        el.getAttribute('aria-disabled') === 'true' ||
        String(el.className || '').includes('disabled')

      const selectors = [
        '[role="option"]',
        'li',
        'label',
        '[class*="option"]',
        '[class*="Option"]',
        '[class*="checkbox"]',
        '[class*="Checkbox"]',
      ].join(',')

      const nodes = [...document.querySelectorAll(selectors)].filter(visible)
      const matches = nodes
        .map((el) => {
          const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
          return { el, text, normalized: normalize(text) }
        })
        .filter((item) => item.text && item.text.includes(wanted))

      const wantedNormalized = normalize(wanted)
      const exactItem =
        matches.find((item) => !disabled(item.el) && item.normalized === wantedNormalized) ||
        matches.find((item) => !disabled(item.el) && item.text === wanted)
      const targetItem = exactItem || (strictExact ? null : matches.find((item) => !disabled(item.el)))

      if (!targetItem) {
        return {
          ok: false,
          error: `Option "${wanted}" not found`,
          visibleOptions: nodes
            .map((el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 30),
        }
      }

      targetItem.el.click()
      return { ok: true, text: targetItem.text }
    }, { wanted: optionText, strictExact: Boolean(opts.strictExact) })

    last = result
    if (result.ok) return result
    await sleep(300)
  }

  return last || { ok: false, error: `Option "${optionText}" timed out` }
}

async function applyDropdownFilter(page, label, values, options) {
  if (!values.length) return { ok: true, skipped: true, label, values: [] }

  const opened = await clickExactFilterButton(page, label, options.filterTimeoutMs)
  if (!opened.ok) return { ok: false, label, values, error: opened.error }

  await sleep(options.afterFilterOpenMs)

  // 商品类目使用级联选择器，需要特殊处理
  if (label === TEXT_PRODUCT_CATEGORY) {
    return await applyCascaderFilter(page, label, values, options)
  }

  const selected = []
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    const clicked = await clickDropdownOption(page, value, options.filterTimeoutMs, {
      strictExact: label === TEXT_PRODUCT_CATEGORY,
    })
    selected.push({ value, ...clicked })
    if (!clicked.ok) return { ok: false, label, values, selected, error: clicked.error }
    await sleep(options.afterFilterOptionMs)
  }

  // 尝试点击确认按钮，如果找不到再按 Escape
  const confirmed = await page.evaluate(() => {
    const visible = (el) => {
      const s = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const btns = document.querySelectorAll('button')
    const confirmBtn = [...btns].find(b => {
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim()
      return visible(b) && text.includes('确认')
    })
    if (confirmBtn) {
      confirmBtn.click()
      return true
    }
    return false
  })

  if (!confirmed) {
    await page.keyboard.press('Escape').catch(() => {})
  }

  await sleep(options.afterFilterMs)
  await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})

  return { ok: true, skipped: false, label, values, opened, selected }
}

// 级联选择器（商品类目）专用处理
// 支持多层级类目路径，如 "女装与女士内衣-女士连衣裙" 表示先展开"女装与女士内衣"，再选择"女士连衣裙"
async function applyCascaderFilter(page, label, values, options) {
  const selected = []

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]

    // 解析多层级路径
    const categories = value.split('-').map(s => s.trim())
    const topLevel = categories[0]
    const subLevels = categories.slice(1)

    if (!subLevels.length) {
      const clicked = await page.evaluate((cat) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
        const visible = (el) => {
          const st = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const item = [...document.querySelectorAll('.core-cascader-list-item')]
          .filter(visible)
          .find((el) => norm(el.innerText || el.textContent).startsWith(cat))
        if (!item) {
          return {
            ok: false,
            error: `Category "${cat}" not found`,
            visibleItems: [...document.querySelectorAll('.core-cascader-list-item')]
              .filter(visible)
              .map((el) => norm(el.innerText || el.textContent))
              .slice(0, 80),
          }
        }

        const checkboxInput = item.querySelector('input[type="checkbox"]')
        const checkboxLabel = item.querySelector('label.core-checkbox,[class*="checkbox"],[class*="Checkbox"]')
        const beforeChecked = Boolean(checkboxInput?.checked)
        if (!beforeChecked) {
          const target = checkboxLabel || checkboxInput || item
          target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
          target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
          target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        const afterChecked = Boolean(item.querySelector('input[type="checkbox"]')?.checked)
        return {
          ok: afterChecked,
          selected: norm(item.innerText || item.textContent),
          beforeChecked,
          afterChecked,
          checkboxClassName: String((checkboxLabel || checkboxInput)?.className || ''),
        }
      }, topLevel)

      selected.push({ value, categories, ...clicked })
      if (!clicked.ok) return { ok: false, label, values, selected, error: clicked.error || `Failed to select "${topLevel}"` }
      await sleep(300)
      continue
    }

    // 多级路径：先点击父级展开，再勾选最终层级。
    try {
      await page.click(`.core-cascader-list-item:has-text("${topLevel}")`, { timeout: 5000 })
    } catch (e) {
      selected.push({ value, ok: false, error: `Failed to click category "${topLevel}": ${e.message}` })
      return { ok: false, label, values, selected, error: e.message }
    }

    await sleep(1000)

    // 逐层展开并选择子类目
    for (const subCategory of subLevels) {
      // 等待新列出现
      let hasSubcategory = false
      for (let retry = 0; retry < 10; retry++) {
        const colCount = await page.locator('.core-cascader-list-column').count()
        if (colCount > 1) {
          hasSubcategory = true
          break
        }
        await sleep(300)
      }

      if (!hasSubcategory) {
        selected.push({ value, ok: false, error: 'Subcategory column did not appear' })
        return { ok: false, label, values, selected, error: 'Timeout waiting for subcategory column' }
      }

      try {
        // 点击子类目
        await page.click(`.core-cascader-list-item:has-text("${subCategory}")`, { timeout: 5000 })
      } catch (e) {
        selected.push({ value, ok: false, error: `Failed to click subcategory "${subCategory}"`, subCategory })
        return { ok: false, label, values, selected, error: e.message }
      }

      await sleep(800)
    }

    // 选择最终要选中的类目
    const targetCategory = subLevels.length > 0 ? subLevels[subLevels.length - 1] : topLevel

    try {
      const clicked = await page.evaluate((cat) => {
        const t = s => String(s || '').replace(/\s+/g, ' ').trim()
        const visible = el => {
          const s = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }

        const columns = document.querySelectorAll('.core-cascader-list-column')
        const lastColumn = columns[columns.length - 1]
        if (!lastColumn) return false

        const items = lastColumn.querySelectorAll('.core-cascader-list-item')
        for (const item of items) {
          if (t(item.innerText).startsWith(cat)) {
            const checkboxInput = item.querySelector('input[type="checkbox"]')
            const checkboxLabel = item.querySelector('label.core-checkbox,[class*="checkbox"],[class*="Checkbox"]')
            if (!checkboxInput?.checked) {
              const target = checkboxLabel || checkboxInput || item
              target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }
            return Boolean(item.querySelector('input[type="checkbox"]')?.checked)
          }
        }
        return false
      }, targetCategory)

      if (!clicked) {
        throw new Error(`Checkbox for "${targetCategory}" did not become checked`)
      }
      selected.push({ value, categories, ok: true, selected: targetCategory })
    } catch (e) {
      selected.push({ value, categories, ok: false, error: `Failed to select "${targetCategory}": ${e.message}` })
      return { ok: false, label, values, selected, error: e.message }
    }

    await sleep(300)
  }

  // 这个级联下拉通常没有确认按钮；勾选后筛选立即生效。
  const confirmed = await page.evaluate(() => {
    const visible = (el) => {
      const s = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const btns = document.querySelectorAll('button')
    const confirmBtn = [...btns].find(b => {
      const text = (b.textContent || '').replace(/\s+/g, ' ').trim()
      return visible(b) && text.includes('确认')
    })
    if (!confirmBtn) return false
    confirmBtn.click()
    return true
  })

  if (!confirmed) {
    await page.keyboard.press('Escape').catch(() => {})
  }

  await sleep(options.afterFilterMs)
  await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})

  return { ok: true, skipped: false, label, values, selected, confirmed }
}

async function applyCheckboxFilter(page, label, shouldCheck, options) {
  if (shouldCheck === null) return { ok: true, skipped: true, label }

  const result = await page.evaluate(
    ({ filterLabel, desired }) => {
      const visible = (el) => {
        const st = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const labels = [...document.querySelectorAll('label,[class*="checkbox"],[class*="Checkbox"]')].filter(visible)
      const target = labels.find((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim()
        return text.includes(filterLabel)
      })
      if (!target) return { ok: false, error: `Checkbox "${filterLabel}" not found` }
      const checked =
        String(target.className || '').includes('checked') ||
        Boolean(target.querySelector('input[type="checkbox"]')?.checked)
      if (checked !== desired) target.click()
      return { ok: true, text: (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim(), before: checked, after: desired }
    },
    { filterLabel: label, desired: Boolean(shouldCheck) },
  )

  if (result.ok) {
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFilterMs)
  }
  return { label, ...result }
}

async function switchFilterTab(page, tabName, options) {
  const result = await clickButtonByText(page, tabName, { timeoutMs: options.filterTimeoutMs })
  if (result.ok) {
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFilterMs)
    await page.keyboard.press('Escape').catch(() => {})
    await sleep(300)
  }
  return result
}

async function applyCreatorFilters(page, options) {
  const hasDropdownFilters =
    Object.values(options.filters.creator).some((values) => values.length) ||
    Object.values(options.filters.followers).some((values) => values.length) ||
    Object.values(options.filters.performance).some((values) => values.length)
  const hasCheckboxFilters = options.filters.uninvited90Days !== null
  if (!hasDropdownFilters && !hasCheckboxFilters) return { ok: true, skipped: true, applied: [] }

  const applied = []
  applied.push(await maybeResetFilters(page, options))

  const groupedSteps = [
    [
      TEXT_CREATOR_TAB,
      [
        [TEXT_PRODUCT_CATEGORY, options.filters.creator.productCategory],
        [TEXT_AVG_COMMISSION, options.filters.creator.avgCommissionRate],
        [TEXT_CONTENT_TYPE, options.filters.creator.contentType],
        [TEXT_CREATOR_AGENCY, options.filters.creator.creatorAgency],
        [TEXT_CONTENT_LANGUAGE, options.filters.creator.contentLanguage],
      ],
      true,
    ],
    [
      TEXT_FOLLOWERS_TAB,
      [
        [TEXT_FAN_AGE, options.filters.followers.fanAge],
        [TEXT_FAN_GENDER, options.filters.followers.fanGender],
        [TEXT_FAN_COUNT, options.filters.followers.fanCount],
      ],
      false,
    ],
    [
      TEXT_PERFORMANCE_TAB,
      [
        [TEXT_GMV, options.filters.performance.gmv],
        [TEXT_UNITS_SOLD, options.filters.performance.unitsSold],
        [TEXT_AVG_VIDEO_VIEWS, options.filters.performance.avgVideoViews],
        [TEXT_AVG_LIVE_VIEWS, options.filters.performance.avgLiveViews],
        [TEXT_ENGAGEMENT_RATE, options.filters.performance.engagementRate],
        [TEXT_ESTIMATED_PUBLISH_RATE, options.filters.performance.estimatedPublishRate],
        [TEXT_BRAND_COLLABORATION, options.filters.performance.brandCollaboration],
      ],
      false,
    ],
  ]

  for (const [tabName, filterSteps, hasCreatorCheckbox] of groupedSteps) {
    const groupHasFilters =
      filterSteps.some(([, values]) => values.length) ||
      (hasCreatorCheckbox && options.filters.uninvited90Days !== null)
    if (!groupHasFilters) continue

    const tabResult = await switchFilterTab(page, tabName, options)
    applied.push({ tab: tabName, ...tabResult })
    if (!tabResult.ok) return { ok: false, skipped: false, applied, error: tabResult.error }

    for (const [label, values] of filterSteps) {
      const result = await applyDropdownFilter(page, label, values, options)
      applied.push(result)
      if (!result.ok) return { ok: false, skipped: false, applied, error: result.error }
    }

    if (hasCreatorCheckbox) {
      const checkboxResult = await applyCheckboxFilter(page, TEXT_UNINVITED_90_DAYS, options.filters.uninvited90Days, options)
      applied.push(checkboxResult)
      if (!checkboxResult.ok) return { ok: false, skipped: false, applied, error: checkboxResult.error }
    }
  }

  return { ok: true, skipped: false, applied }
}

async function applyCreatorKeywordSearch(page, options) {
  const keyword = String(options.creatorSearch || '').trim()
  if (!keyword) return { ok: true, skipped: true }

  const result = await page.evaluate((value) => {
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const input = [...document.querySelectorAll('input')]
      .filter(visible)
      .find((el) => (el.getAttribute('placeholder') || '').includes('\u641c\u7d22\u59d3\u540d'))
    if (!input) return { ok: false, error: 'Creator search input not found' }

    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (setter) setter.call(input, value)
    else input.value = value
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }))

    const icon = input.closest('[class*="input"],[class*="Input"],div')?.querySelector('svg,[role="button"],button')
    if (icon && visible(icon)) {
      icon.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      icon.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      icon.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    return { ok: true, keyword: value, value: input.value }
  }, keyword)

  if (result.ok) {
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFilterMs)
  }
  return result
}

function pickCreatorSortLabel(options) {
  const explicit = String(options.creatorSortBy || '').trim()
  if (explicit) {
    const matched = CREATOR_SORT_OPTIONS.find((label) => label.toLowerCase() === explicit.toLowerCase()) ||
      CREATOR_SORT_OPTIONS.find((label) => label.includes(explicit) || explicit.includes(label))
    return matched || explicit
  }
  if (!options.randomSort) return ''
  return CREATOR_SORT_OPTIONS[Math.floor(Math.random() * CREATOR_SORT_OPTIONS.length)]
}

async function applyCreatorSort(page, options) {
  const label = pickCreatorSortLabel(options)
  if (!label) return { ok: true, skipped: true }

  const result = await page.evaluate((sortLabel) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const knownSortLabels = ['\u76f8\u5173\u6027', 'GMV', '\u6210\u4ea4\u4ef6\u6570', '\u7c89\u4e1d\u6570', '\u5e73\u5747\u89c6\u9891\u64ad\u653e\u91cf', '\u4e92\u52a8\u7387']
    const labels = [...document.querySelectorAll('*')]
      .filter(visible)
      .filter((el) => norm(el.innerText || el.textContent) === '\u6392\u5e8f\u4f9d\u636e')

    const selectCandidates = [...document.querySelectorAll('.core-select-view,[role="combobox"],[class*="select"],[class*="Select"]')]
      .filter(visible)
      .filter((el) => {
        const text = norm(el.innerText || el.textContent)
        return text && knownSortLabels.includes(text)
      })

    let select = null
    for (const labelEl of labels) {
      const labelRect = labelEl.getBoundingClientRect()
      select = selectCandidates
        .map((el) => {
          const rect = el.getBoundingClientRect()
          const verticalDistance = Math.abs((rect.top + rect.height / 2) - (labelRect.top + labelRect.height / 2))
          const horizontalDistance = rect.left - labelRect.right
          return { el, verticalDistance, horizontalDistance }
        })
        .filter((item) => item.verticalDistance <= 35 && item.horizontalDistance >= -5 && item.horizontalDistance <= 180)
        .sort((a, b) => a.verticalDistance - b.verticalDistance || a.horizontalDistance - b.horizontalDistance)[0]?.el || null
      if (select) break
    }

    if (!select) {
      select = [...document.querySelectorAll('.core-select-view,[class*="select"],[class*="Select"]')]
        .filter(visible)
        .find((el) => {
          const text = norm(el.innerText || el.textContent)
          const parentText = norm(el.parentElement?.innerText || '')
          return parentText.includes('\u6392\u5e8f\u4f9d\u636e') && (text || parentText)
        })
    }
    if (!select) return { ok: false, error: 'Creator sort select not found', label: sortLabel }

    select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    select.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    select.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    const option = [...document.querySelectorAll('li[role="option"],[role="option"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === sortLabel)
    if (!option) {
      return {
        ok: false,
        error: `Creator sort option not found: ${sortLabel}`,
        label: sortLabel,
        visibleOptions: [...document.querySelectorAll('li[role="option"],[role="option"]')]
          .filter(visible)
          .map((el) => norm(el.innerText || el.textContent))
          .filter(Boolean)
          .slice(0, 20),
      }
    }
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return { ok: true, label: sortLabel }
  }, label)

  if (result.ok) {
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFilterMs)
  }
  return result
}

async function waitForCreatorPage(page, options) {
  await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
  await sleep(options.waitMs)

  if (/\/account\/login|\/login/i.test(page.url())) {
    return { ok: false, error: 'TikTok Affiliate login is required for this browser profile' }
  }

  const hasBulkInvite = await page.evaluate((bulkText) => {
    const text = document.body?.innerText || ''
    return text.includes(bulkText)
  }, TEXT_BULK_INVITE)

  return hasBulkInvite ? { ok: true } : { ok: false, error: 'Creator page did not expose bulk invite controls' }
}

async function clearSelectedCreators(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const st = window.getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const checked = [...document.querySelectorAll('td.core-table-checkbox label.core-checkbox')]
      .filter((label) => {
        const input = label.querySelector('input')
        return Boolean(input?.checked) || String(label.className || '').includes('checked')
      })
      .filter(visible)
    for (const el of checked) el.click()
    return { unchecked: checked.length }
  })
}

function normalizeLedgerName(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().split(/\s+/)[0]?.toLowerCase() || ''
}

function openInvitedLedgerDb() {
  fs.mkdirSync(path.dirname(INVITED_LEDGER_PATH), { recursive: true })
  const db = new DatabaseSync(INVITED_LEDGER_PATH)
  db.exec(`
    CREATE TABLE IF NOT EXISTS invited_creators (
      product_id TEXT NOT NULL,
      creator_id TEXT NOT NULL,
      creator_name TEXT,
      shop_region TEXT,
      invitation_name TEXT,
      invited_at TEXT NOT NULL,
      PRIMARY KEY (product_id, creator_id)
    );
    CREATE INDEX IF NOT EXISTS idx_invited_creators_product ON invited_creators(product_id);
  `)
  return db
}

function getLedgerSkipKeys(productIds) {
  const creatorIds = new Set()
  const creatorNames = new Set()
  if (!productIds?.length) return { creatorIds: [], creatorNames: [] }
  const db = openInvitedLedgerDb()
  try {
    // 只信任实际邀请产生的记录（排除手动种入的 "seeded-from-last-success-output" 等假记录）
    const stmt = db.prepare(`SELECT DISTINCT creator_id, creator_name FROM invited_creators
      WHERE product_id = ?
      AND invitation_name != 'seeded-from-last-success-output'
      AND invitation_name IS NOT NULL
      AND invitation_name != ''`)
    for (const productId of productIds) {
      for (const row of stmt.all(String(productId))) {
        const creatorId = String(row.creator_id || '')
        if (creatorId.startsWith('name:')) {
          const name = creatorId.slice(5)
          if (name) creatorNames.add(name)
        } else if (creatorId) {
          creatorIds.add(creatorId)
        }
        const normalizedName = normalizeLedgerName(row.creator_name)
        if (normalizedName) creatorNames.add(normalizedName)
      }
    }
  } finally {
    db.close()
  }
  return { creatorIds: [...creatorIds], creatorNames: [...creatorNames] }
}

function recordInvitedCreatorsForProducts(productIds, creators, meta = {}) {
  if (!productIds?.length || !creators?.length) return { recorded: 0, path: INVITED_LEDGER_PATH }
  const db = openInvitedLedgerDb()
  let recorded = 0
  const now = new Date().toISOString()
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO invited_creators
        (product_id, creator_id, creator_name, shop_region, invitation_name, invited_at)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `)
    db.exec('BEGIN')
    for (const productId of productIds) {
      for (const creator of creators) {
        const creatorId = creator.creatorId ? String(creator.creatorId) : ''
        const creatorKey = creatorId || `name:${normalizeLedgerName(creator.name)}`
        if (!creatorKey || creatorKey === 'name:') continue
        const result = insert.run(
          String(productId),
          creatorKey,
          creator.name || '',
          meta.shopRegion || '',
          meta.invitationName || '',
          now,
        )
        recorded += Number(result.changes || 0)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  } finally {
    db.close()
  }
  return { recorded, path: INVITED_LEDGER_PATH }
}

function extractCreatorIdsFromUrl(url) {
  return [...String(url || '').matchAll(/creator_ids(?:\[[0-9]+\]|%5B[0-9]+%5D)=([0-9]+)/g)].map((match) => match[1])
}

function attachCreatorIdsFromUrl(selectedCreators, url) {
  const ids = extractCreatorIdsFromUrl(url)
  const creators = selectedCreators?.selectedCreators || []
  for (let i = 0; i < creators.length && i < ids.length; i += 1) {
    if (!creators[i].creatorId) creators[i].creatorId = ids[i]
  }
  return ids
}

function findAlreadyInvitedSelectedCreators(productIds, creators) {
  const skipKeys = getLedgerSkipKeys(productIds)
  const idSet = new Set(skipKeys.creatorIds.map(String))
  const nameSet = new Set(skipKeys.creatorNames)
  return (creators || []).filter((creator) => {
    const creatorId = creator.creatorId ? String(creator.creatorId) : ''
    const name = normalizeLedgerName(creator.name)
    return (creatorId && idSet.has(creatorId)) || (name && nameSet.has(name))
  })
}

function enrichInvitedLedgerCreatorNames(productIds, creators, meta = {}) {
  if (!productIds?.length || !creators?.length) return { updated: 0, path: INVITED_LEDGER_PATH }
  const db = openInvitedLedgerDb()
  let updated = 0
  const now = new Date().toISOString()
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO invited_creators
        (product_id, creator_id, creator_name, shop_region, invitation_name, invited_at)
      VALUES
        (?, ?, ?, ?, ?, ?)
    `)
    const update = db.prepare(`
      UPDATE invited_creators
      SET creator_name = CASE WHEN ? != '' THEN ? ELSE creator_name END,
          shop_region = CASE WHEN ? != '' THEN ? ELSE shop_region END
      WHERE product_id = ? AND creator_id = ?
    `)
    db.exec('BEGIN')
    for (const productId of productIds) {
      for (const creator of creators) {
        const creatorId = creator.creatorId ? String(creator.creatorId) : ''
        const creatorName = creator.name || ''
        if (!creatorId) continue
        insert.run(String(productId), creatorId, creatorName, meta.shopRegion || '', meta.invitationName || 'duplicate-name-enrichment', now)
        const result = update.run(creatorName, creatorName, meta.shopRegion || '', meta.shopRegion || '', String(productId), creatorId)
        updated += Number(result.changes || 0)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  } finally {
    db.close()
  }
  return { updated, path: INVITED_LEDGER_PATH }
}

async function selectCreatorRows(page, maxCreators, options) {
  const selectedNames = []
  const selectedCreators = []
  const skippedPreviouslyInvited = []
  let totalClicked = 0
  let stagnantRounds = 0
  let lastSeenCreators = new Set() // 跟踪上一轮看到的达人
  let sameContentRounds = 0 // 连续看到相同内容的轮次
  const skipKeys = getLedgerSkipKeys(options.productIds)

  await page.keyboard.press('Escape').catch(() => {})
  await clearSelectedCreators(page)
  await sleep(500)

  for (let round = 0; round <= options.scrollRounds && totalClicked < maxCreators; round += 1) {
    const batch = await page.evaluate(
      ({ remaining, skipCreatorIds, skipCreatorNames }) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
        const nameKey = (s) => norm(s).toLowerCase()
        const visible = (el) => {
          const st = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const inViewport = (el) => {
          const r = el.getBoundingClientRect()
          return r.bottom > 80 && r.top < window.innerHeight - 20 && r.right > 0 && r.left < window.innerWidth
        }
        const disabled = (el) =>
          el.getAttribute('aria-disabled') === 'true' ||
          String(el.className || '').includes('disabled')

        const idSet = new Set((skipCreatorIds || []).map(String))
        const nameSet = new Set(skipCreatorNames || [])
        const extractCreatorId = (row) => {
          const text = row?.outerHTML || ''
          const patterns = [
            /creator_ids?%5B\d+%5D=([0-9]{12,})/i,
            /creator_ids?\[[^\]]*\]=([0-9]{12,})/i,
            /creator[_-]?id["'=:\s%]+([0-9]{12,})/i,
            /creatorId["'=:\s]+([0-9]{12,})/i,
            /\/creator\/([0-9]{12,})/i,
          ]
          for (const pattern of patterns) {
            const match = text.match(pattern)
            if (match) return match[1]
          }
          return ''
        }
        const extractName = (row) => {
          const rowText = norm(row?.innerText || '')
          return rowText.split(/\s+/)[0] || rowText.slice(0, 80)
        }

        const labels = [...document.querySelectorAll('td.core-table-checkbox label.core-checkbox')]
          .filter((el) => {
            if (!visible(el)) return false
            if (!inViewport(el.closest('tr') || el)) return false
            if (disabled(el)) return false
            if (String(el.className || '').includes('checked')) return false
            return true
          })

        const clicked = []
        const skipped = []
        const currentCreators = new Set() // 当前可见的达人
        for (const label of labels) {
          if (clicked.length >= remaining) break
          const row = label.closest('tr')
          const rowText = norm(row?.innerText || '')
          const creatorId = extractCreatorId(row)
          const name = extractName(row)
          if (!name || name === '达人') continue
          currentCreators.add(nameKey(name)) // 记录当前看到的达人

          const skipById = creatorId && idSet.has(String(creatorId))
          const skipByName = name && nameSet.has(nameKey(name))
          if (skipById || skipByName) {
            skipped.push({ creatorId: creatorId || null, name: name || rowText.slice(0, 80), reason: skipById ? 'product_creator_id_seen' : 'product_creator_name_seen' })
            continue
          }
          label.click()
          clicked.push({ creatorId: creatorId || null, name: name || rowText.slice(0, 80) })
        }

        return { count: clicked.length, clicked, skipped, currentCreators: [...currentCreators] }
      },
      {
        remaining: maxCreators - totalClicked,
        skipCreatorIds: skipKeys.creatorIds,
        skipCreatorNames: skipKeys.creatorNames,
      },
    )

    if (batch.count) {
      totalClicked += batch.count
      selectedCreators.push(...batch.clicked)
      selectedNames.push(...batch.clicked.map((item) => item.name))
      stagnantRounds = 0
      sameContentRounds = 0
      lastSeenCreators = new Set(batch.currentCreators)
      await sleep(options.afterSelectMs)
    } else {
      stagnantRounds += 1
      // 检查是否加载了新内容
      const currentCreatorSet = new Set(batch.currentCreators)
      const hasNewContent = batch.currentCreators.some(c => !lastSeenCreators.has(c))
      if (hasNewContent) {
        sameContentRounds = 0
        lastSeenCreators = currentCreatorSet
      } else {
        sameContentRounds += 1
      }
    }
    skippedPreviouslyInvited.push(...(batch.skipped || []))

    // 继续滚动直到选够人数
    if (totalClicked >= maxCreators) break

    // 如果连续3轮看到的内容相同，说明没有新内容了，停止滚动
    if (sameContentRounds >= 3) {
      break
    }

    // 逐屏滚动；TikTok 达人表格会保留整页 DOM，不能直接用全量 DOM 判断是否到底。
    await page.evaluate(() => {
      const visible = (el) => {
        const st = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const candidates = [
        ...document.querySelectorAll('.core-table-body,[class*="table-body"],[class*="overflow-auto"],[style*="overflow"]'),
        document.scrollingElement,
      ].filter(Boolean)
      const scrollRoot = candidates
        .filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 100)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || document.scrollingElement
      const step = Math.max(300, Math.floor(window.innerHeight * 0.75))
      scrollRoot.scrollTop = Math.min(scrollRoot.scrollTop + step, scrollRoot.scrollHeight)
      scrollRoot.dispatchEvent(new Event('scroll', { bubbles: true }))
      window.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: step }))
    })
    await sleep(options.afterScrollMs)
  }

  const selectedText = await page.evaluate(() => {
    const match = (document.body?.innerText || '').match(/已选择\s*([0-9]+)\s*\/\s*([0-9]+)/)
    return match ? { selected: Number(match[1]), limit: Number(match[2]) } : null
  })

  return {
    ok: totalClicked > 0,
    requested: maxCreators,
    clicked: totalClicked,
    selectedText,
    selectedNames: selectedNames.slice(0, 30),
    selectedCreators,
    skippedPreviouslyInvited: skippedPreviouslyInvited.slice(0, 100),
    skippedPreviouslyInvitedCount: skippedPreviouslyInvited.length,
  }
}

async function returnToBulkActions(page) {
  await page.evaluate(() => {
    const tableBody =
      document.querySelector('.core-table-body') ||
      document.querySelector('[class*="table-body"]')
    if (tableBody) tableBody.scrollTop = 0
    window.scrollTo(0, 0)
    document.scrollingElement.scrollTop = 0
  })
  await sleep(800)
}

async function closeInviteDialog(page) {
  const closed = await clickButtonByText(page, TEXT_CANCEL, { timeoutMs: 3000, preferLast: true })
  await sleep(800)
  return closed
}

function parseInvitedCount(text) {
  const match = String(text || '').match(new RegExp(`${TEXT_INVITED}\\s*([0-9]+)`))
  return match ? Number(match[1]) : 0
}

async function readInvitationDialogState(page) {
  return page.evaluate(
    ({ tabInProgress, tabCreate, emptyText, dialogSelector }) => {
      const t = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const vis = (el) => {
        const s = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const dialog = document.querySelector(dialogSelector)
      if (!dialog) return { ok: false, error: 'invitation dialog not found' }

      const activeTabEl = [...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].find(vis)
      const activeTabText = t(activeTabEl?.innerText)
      const tabType = activeTabText === tabInProgress ? 'inProgress' : activeTabText === tabCreate ? 'create' : null

      const allPanels = [...dialog.querySelectorAll('[role="tabpanel"]')]
      const visiblePanels = allPanels.filter((p) => p.getAttribute('aria-hidden') !== 'true' && vis(p))
      const isEmpty = visiblePanels.some((p) => t(p.innerText).includes(emptyText))

      const planRadios = [...dialog.querySelectorAll('label.core-radio')].filter(vis)
      const plans = planRadios.map((radio, index) => {
        let text = ''
        let el = radio
        for (let i = 0; el && i < 6; i += 1, el = el.parentElement) {
          const txt = t(el.innerText)
          if (txt.length > 15 && txt.length < 300) {
            text = txt
            break
          }
        }
        if (!text) text = t(radio.innerText)
        return {
          index,
          text,
          checked: String(radio.className || '').includes('core-radio-checked'),
          disabled: String(radio.className || '').includes('disabled'),
          value: radio.querySelector('input')?.value || null,
        }
      })

      const footerButtons = [...dialog.querySelectorAll('.core-modal-footer button')].filter(vis)
      const inviteBtn = footerButtons.find((b) => t(b.innerText) === '\u9080\u8bf7')
      const inviteEnabled = Boolean(inviteBtn) && !String(inviteBtn.className || '').includes('disabled')

      return { ok: true, tabType, activeTabText, isEmpty, plans, inviteEnabled }
    },
    {
      tabInProgress: TEXT_TAB_IN_PROGRESS,
      tabCreate: TEXT_TAB_CREATE_NEW,
      emptyText: TEXT_EMPTY_PLANS,
      dialogSelector: TEXT_DIALOG_SELECTOR,
    },
  )
}

async function switchInvitationTab(page, tabName) {
  return page.evaluate(
    ({ name, dialogSelector }) => {
      const t = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const vis = (el) => {
        const s = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const dialog = document.querySelector(dialogSelector)
      if (!dialog) return { ok: false, error: 'invitation dialog not found' }

      const titleEl = [...dialog.querySelectorAll('.pulse-tabs-pane-title-content')].find(
        (el) => vis(el) && t(el.innerText) === name,
      )
      if (!titleEl) return { ok: false, error: `tab "${name}" not found` }

      const tab = titleEl.closest('[role="tab"]')
      if (!tab) return { ok: false, error: `tab element for "${name}" not found` }

      const wasActive = tab.getAttribute('aria-selected') === 'true'
      if (!wasActive) {
        const r = tab.getBoundingClientRect()
        const opts = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0 }
        tab.dispatchEvent(new MouseEvent('mousedown', opts))
        tab.dispatchEvent(new MouseEvent('mouseup', opts))
        tab.dispatchEvent(new MouseEvent('click', opts))
      }
      return { ok: true, switched: !wasActive, name }
    },
    { name: tabName, dialogSelector: TEXT_DIALOG_SELECTOR },
  )
}

async function readInvitationPlans(page, options) {
  return page.evaluate(
    ({ capacity, invitedText }) => {
      const visible = (el) => {
        const st = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }

      const radios = [...document.querySelectorAll('label.core-radio')]
        .filter((el) => visible(el))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          return r.y > 300 && r.x > window.innerWidth / 3
        })

      const readPlanText = (radio) => {
        let el = radio
        for (let i = 0; el && i < 10; i += 1, el = el.parentElement) {
          const text = (el.innerText || '').replace(/\s+/g, ' ').trim()
          if (text.includes(invitedText)) return text
        }

        const r = radio.getBoundingClientRect()
        const nearby = document.elementsFromPoint(r.x + 120, r.y + 8)
        for (const node of nearby) {
          let cur = node
          for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
            const text = (cur.innerText || '').replace(/\s+/g, ' ').trim()
            if (text.includes(invitedText)) return text
          }
        }

        return (radio.innerText || radio.textContent || '').replace(/\s+/g, ' ').trim()
      }

      return radios.map((radio, index) => {
        const text = readPlanText(radio)
        const match = text.match(new RegExp(`${invitedText}\\s*([0-9]+)`))
        const invitedCount = match ? Number(match[1]) : 0
        const remaining = Math.max(0, capacity - invitedCount)
        return {
          index,
          text,
          invitedCount,
          capacity,
          remaining,
          disabled: String(radio.className || '').includes('disabled'),
        }
      })
    },
    { capacity: options.planCapacity, invitedText: TEXT_INVITED },
  )
}

function chooseInvitationPlan(plans, invitationName) {
  const candidates = plans.filter((plan) => plan.remaining > 0 && !plan.disabled)
  if (invitationName) return candidates.find((plan) => plan.text.includes(invitationName)) || null
  return candidates[0] || null
}

async function probeInvitationPlanCapacity(page, options) {
  await clearSelectedCreators(page)
  await sleep(500)

  const one = await selectCreatorRows(page, 1, { ...options, scrollRounds: 0 })
  if (!one.ok) return { ok: false, error: 'Unable to select one creator for invitation plan probe' }

  await returnToBulkActions(page)
  const opened = await clickButtonByText(page, TEXT_BULK_INVITE, { timeoutMs: options.invitationTimeoutMs })
  if (!opened.ok) return { ok: false, error: opened.error }

  await sleep(options.afterBulkInviteMs)

  let state = await readInvitationDialogState(page)
  if (!state.ok) {
    await closeInviteDialog(page)
    await clearSelectedCreators(page)
    return { ok: false, error: state.error }
  }

  let plans = state.plans
  let selected = null
  let mode = null

  if (state.tabType === 'inProgress' && state.isEmpty) {
    const switched = await switchInvitationTab(page, TEXT_TAB_CREATE_NEW)
    if (!switched.ok) {
      await closeInviteDialog(page)
      await clearSelectedCreators(page)
      return { ok: false, error: `Failed to switch to ${TEXT_TAB_CREATE_NEW} tab: ${switched.error}`, state }
    }
    await sleep(500)
    state = await readInvitationDialogState(page)
    if (!state.ok) {
      await closeInviteDialog(page)
      await clearSelectedCreators(page)
      return { ok: false, error: state.error }
    }
    plans = state.plans
  }

  if (state.tabType === 'create') {
    const plan = plans.find((p) => !p.disabled) || plans[0]
    if (!plan) {
      await closeInviteDialog(page)
      await clearSelectedCreators(page)
      return { ok: false, error: 'No commission plan available in create tab', state, plans }
    }
    mode = 'create'
    selected = {
      text: TEXT_TAB_CREATE_NEW,
      remaining: options.planCapacity,
      capacity: options.planCapacity,
      mode,
      planIndex: plan.index,
      planValue: plan.value,
    }
  } else if (state.tabType === 'inProgress' && !state.isEmpty) {
    mode = 'inProgress'
    const inProgressPlans = await readInvitationPlans(page, options)
    plans = inProgressPlans
    selected = chooseInvitationPlan(inProgressPlans, options.invitationName)
  } else {
    await closeInviteDialog(page)
    await clearSelectedCreators(page)
    return {
      ok: false,
      error: state.tabType
        ? `Unsupported dialog state on ${state.activeTabText || state.tabType} tab`
        : `Unknown active tab: ${state.activeTabText}`,
      state,
      plans,
    }
  }

  await closeInviteDialog(page)
  await clearSelectedCreators(page)
  await sleep(500)

  if (!selected) {
    return {
      ok: false,
      error: options.invitationName
        ? `No invitation plan containing "${options.invitationName}" has remaining capacity`
        : mode === 'create'
          ? 'No commission plan available in create tab'
          : 'No invitation plan has remaining capacity',
      mode,
      plans,
    }
  }

  return { ok: true, selected, plans, mode, state }
}

async function selectInvitationPlan(page, invitationName, options) {
  const deadline = Date.now() + options.invitationTimeoutMs
  let last = null

  while (Date.now() < deadline) {
    const result = await page.evaluate(
      ({ name, tabInProgress, tabCreate, emptyText, dialogSelector }) => {
        const t = (s) => String(s || '').replace(/\s+/g, ' ').trim()
        const vis = (el) => {
          const s = window.getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const dialog = document.querySelector(dialogSelector)
        if (!dialog) return { ok: false, error: 'invitation dialog not found' }

        const activeTabEl = [...dialog.querySelectorAll('[role="tab"][aria-selected="true"]')].find(vis)
        const activeTabText = t(activeTabEl?.innerText)
        const tabType = activeTabText === tabInProgress ? 'inProgress' : activeTabText === tabCreate ? 'create' : null
        const visiblePanels = [...dialog.querySelectorAll('[role="tabpanel"]')].filter(
          (p) => p.getAttribute('aria-hidden') !== 'true' && vis(p),
        )
        const isEmpty = visiblePanels.some((p) => t(p.innerText).includes(emptyText))

        if (tabType === 'inProgress' && isEmpty) {
          const createTitle = [...dialog.querySelectorAll('.pulse-tabs-pane-title-content')].find(
            (el) => vis(el) && t(el.innerText) === tabCreate,
          )
          if (createTitle) {
            const tab = createTitle.closest('[role="tab"]')
            if (tab) {
              tab.click()
              return { ok: false, switchedTab: true, error: 'switched to create tab, retry' }
            }
          }
          return { ok: false, error: `tab "${tabCreate}" not found for fallback` }
        }

        if (tabType === 'create') {
          const radios = [...dialog.querySelectorAll('label.core-radio')].filter(vis)
          if (!radios.length) return { ok: false, error: 'no commission plan visible in create tab' }
          const enabled = radios.find((r) => !String(r.className || '').includes('disabled'))
          const target = name
            ? radios.find((r) => t(r.innerText).includes(name))
            : enabled || radios[0]
          if (!target) {
            return {
              ok: false,
              error: name ? `commission plan containing "${name}" not found` : 'no enabled commission plan',
              candidates: radios.map((r) => t(r.innerText)).slice(0, 5),
            }
          }
          if (!String(target.className || '').includes('core-radio-checked')) target.click()
          return {
            ok: true,
            mode: 'create',
            selectedText: t(target.innerText) || 'commissionOnly',
            selectedIndex: 0,
            candidates: radios.map((r) => t(r.innerText)).slice(0, 5),
          }
        }

        if (tabType === 'inProgress') {
          const radios = [...dialog.querySelectorAll('label.core-radio')]
            .filter(vis)
            .filter((el) => {
              const r = el.getBoundingClientRect()
              return r.y > 300 && r.x > window.innerWidth / 3
            })
          const rows = radios.map((radio, index) => {
            const readPlanText = () => {
              let el = radio
              for (let i = 0; el && i < 10; i += 1, el = el.parentElement) {
                const text = t(el.innerText)
                if (text.includes('\u5df2\u9080\u8bf7')) return text
              }
              const r = radio.getBoundingClientRect()
              const nearby = document.elementsFromPoint(r.x + 120, r.y + 8)
              for (const node of nearby) {
                let cur = node
                for (let i = 0; cur && i < 8; i += 1, cur = cur.parentElement) {
                  const text = t(cur.innerText)
                  if (text.includes('\u5df2\u9080\u8bf7')) return text
                }
              }
              return t(radio.innerText || radio.textContent)
            }
            return { radio, index, text: readPlanText() }
          })
          const target = name ? rows.find((row) => row.text.includes(name)) : rows[0]
          if (!target) {
            return {
              ok: false,
              error: name ? `Invitation plan containing "${name}" not found` : 'No enabled invitation plan found',
              candidates: rows.map((row) => row.text).slice(0, 10),
            }
          }
          target.radio.click()
          return {
            ok: true,
            mode: 'inProgress',
            selectedText: target.text,
            selectedIndex: target.index,
            candidates: rows.map((row) => row.text).slice(0, 10),
          }
        }

        return { ok: false, error: `unknown active tab: ${activeTabText}` }
      },
      {
        name: invitationName,
        tabInProgress: TEXT_TAB_IN_PROGRESS,
        tabCreate: TEXT_TAB_CREATE_NEW,
        emptyText: TEXT_EMPTY_PLANS,
        dialogSelector: TEXT_DIALOG_SELECTOR,
      },
    )

    last = result
    if (result.ok) return result
    if (result.switchedTab) {
      await sleep(500)
      continue
    }
    await sleep(500)
  }

  return last || { ok: false, error: 'Invitation plan lookup timed out' }
}

// 切换到"创建新邀请"标签并选择"仅佣金"
async function switchToCreateNewInvitation(page, options) {
  const deadline = Date.now() + options.invitationTimeoutMs
  let last = null

  while (Date.now() < deadline) {
    const result = await page.evaluate((dialogSelector) => {
      const t = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const vis = (el) => {
        const s = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }

      const dialog = document.querySelector(dialogSelector)
      if (!dialog) return { ok: false, error: 'invitation dialog not found' }

      // 查找"创建新邀请"标签
      const createTab = [...dialog.querySelectorAll('[role="tab"]')].find(el => {
        const text = t(el.innerText || '')
        return text === '创建新邀请'
      })

      if (!createTab) return { ok: false, error: '创建新邀请 tab not found' }

      // 点击切换到创建新邀请
      if (vis(createTab) && createTab.getAttribute('aria-selected') !== 'true') {
        createTab.click()
      }

      return { ok: true, switched: true }
    }, TEXT_DIALOG_SELECTOR)

    last = result
    if (!result.ok) {
      await sleep(500)
      continue
    }

    // 等待切换完成
    await sleep(800)

    // 点击"仅佣金"选项
    const commissionResult = await page.evaluate(() => {
      const t = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const vis = (el) => {
        const s = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }

      // "仅佣金"不在label中，而是在div或radio-group中
      // 查找包含"仅佣金"文本的radio-group选项
      const radioGroups = document.querySelectorAll('[class*="radio-group"]')
      for (const group of radioGroups) {
        if (!vis(group)) continue
        // 在radio-group中查找"仅佣金"
        const items = group.querySelectorAll('[class*="flex items-start"]')
        for (const item of items) {
          const text = t(item.innerText || '')
          if (text.includes('仅佣金')) {
            // 查找radio或点击区域
            const radio = item.querySelector('[class*="radio"]')
            if (radio && !radio.className.includes('core-radio-checked')) {
              radio.click()
              return { ok: true, text: '仅佣金', method: 'radio' }
            }
            // 直接点击整个选项
            if (!item.className.includes('core-radio-checked')) {
              item.click()
              return { ok: true, text: '仅佣金', method: 'item' }
            }
            return { ok: true, text: '仅佣金', method: 'already-selected' }
          }
        }
      }

      // 备选：查找任何包含"仅佣金"的元素
      const allElements = document.querySelectorAll('*')
      for (const el of allElements) {
        if (!vis(el)) continue
        const text = t(el.innerText || '')
        if (text === '仅佣金' || text.startsWith('仅佣金')) {
          // 查找父级radio
          let parent = el
          for (let i = 0; i < 5 && parent; i++) {
            parent = parent.parentElement
            if (parent && /radio|checkbox/i.test(parent.className)) {
              if (!parent.className.includes('core-radio-checked')) {
                parent.click()
                return { ok: true, text: '仅佣金', method: 'parent-radio' }
              }
              return { ok: true, text: '仅佣金', method: 'already-selected' }
            }
          }
          // 直接点击元素
          el.click()
          return { ok: true, text: '仅佣金', method: 'direct' }
        }
      }

      return { ok: false, error: '仅佣金 option not found' }
    })

    if (commissionResult.ok) {
      return { ok: true, commissionSelected: true, ...commissionResult }
    }

    await sleep(500)
  }

  return last || { ok: false, error: 'switchToCreateNewInvitation timed out' }
}

// 点击邀请按钮跳转到表单页
async function clickInviteButtonToForm(page, options) {
  // 使用Playwright原生click，确保元素可见并滚动到视图
  try {
    // 滚动到对话框底部
    await page.evaluate(() => {
      const dialog = document.querySelector('[class*="target-invitation-modal"]')
      if (dialog) dialog.scrollTop = dialog.scrollHeight
    })
    await page.waitForTimeout(300)

    // 找到最后一个"邀请"按钮（在对话框底部）并点击
    const inviteBtn = page.locator('[class*="target-invitation-modal"] button:has-text("邀请")').last()
    await inviteBtn.scrollIntoViewIfNeeded()
    await inviteBtn.click({ timeout: 5000 })

    return { ok: true, text: '邀请' }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

// 在表单页填写信息
async function fillInvitationName(page, value) {
  const targetValue = String(value || '').trim().slice(0, 30)
  if (!targetValue) return { ok: false, error: 'Invitation name is empty' }

  const result = { ok: false, expected: targetValue, value: '', attempts: [] }
  const locator = page.locator('input[placeholder="邀请名称"]').first()
  const verify = () => page.evaluate((name) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const input = [...document.querySelectorAll('input')]
      .find((el) => visible(el) && el.getAttribute('placeholder') === '邀请名称')
    const value = input?.value || ''
    const bodyText = norm(document.body.innerText)
    return {
      ok: value === name,
      value,
      counterSeen: bodyText.includes(`${name.length}/30`),
      requiredSeen: bodyText.includes('必填字段'),
      bodyPreview: bodyText.slice(0, 500),
    }
  }, targetValue)

  const nativeSet = () => page.evaluate((name) => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const input = [...document.querySelectorAll('input')]
      .find((el) => visible(el) && el.getAttribute('placeholder') === '邀请名称') ||
      [...document.querySelectorAll('input')]
        .find((el) => visible(el) && norm(el.closest('label,div')?.innerText || '').includes('邀请名称'))
    if (!input) return { ok: false, error: 'Invitation name input not found' }
    input.focus()
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    const tracker = input._valueTracker
    if (tracker) tracker.setValue('')
    if (setter) setter.call(input, '')
    else input.value = ''
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', data: null }))
    if (tracker) tracker.setValue('')
    if (setter) setter.call(input, name)
    else input.value = name
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: name }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    return { ok: input.value === name, value: input.value, tracker: Boolean(tracker) }
  }, targetValue)

  await locator.waitFor({ state: 'visible', timeout: 10000 })
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const item = { attempt }
    try {
      await locator.click({ timeout: 5000, force: true })
      await locator.fill(targetValue, { timeout: 5000 })
      item.afterFillValue = await locator.inputValue({ timeout: 3000 }).catch(() => '')
      if (item.afterFillValue !== targetValue) {
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
        await page.keyboard.press('Backspace')
        await page.keyboard.type(targetValue, { delay: 30 })
        item.afterTypeValue = await locator.inputValue({ timeout: 3000 }).catch(() => '')
      }
      item.native = await nativeSet()
      await locator.blur().catch(() => {})
      await page.waitForTimeout(700)
      item.verified = await verify()
    } catch (error) {
      item.error = error?.message || String(error)
    }
    result.attempts.push(item)
    if (item.verified?.ok) {
      await page.waitForTimeout(900)
      const stable = await verify()
      item.stable = stable
      if (stable.ok) {
        result.value = stable.value
        result.counterSeen = stable.counterSeen
        result.ok = true
        return result
      }
    }
    await page.waitForTimeout(600)
  }

  const last = result.attempts.at(-1)?.stable || result.attempts.at(-1)?.verified || {}
  result.value = last.value || ''
  result.counterSeen = Boolean(last.counterSeen)
  result.error = `Invitation name verify failed: expected "${targetValue}", got "${result.value || ''}"`
  return result
}

async function fillInvitationForm(page, options) {
  const result = {
    ok: true,
    invitationName: null,
    expirationDate: null,
    facebookAccount: null,
    invitationText: null,
    productIds: null,
    productSearch: [],
    standardCommissionRate: null,
    shopAdsCommission: null,
    shopAdsCommissionRate: null,
    freeSample: null,
    submitted: false,
  }

  // 等待表单页加载完成
  let currentUrl = page.url()
  let waitCount = 0
  while (!currentUrl.includes('/target-invitation/create') && waitCount < 10) {
    await page.waitForTimeout(500)
    currentUrl = page.url()
    waitCount++
  }

  if (!currentUrl.includes('/target-invitation/create')) {
    return { ok: false, error: 'Not on invitation form page', url: currentUrl }
  }

  // 等待页面内容加载
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
  await page.waitForTimeout(1500)

  // 1. 填写邀请名称
  if (options.invitationName) {
    const nameResult = await fillInvitationName(page, options.invitationName)
    result.invitationName = nameResult.value || null
    result.invitationNameFill = nameResult
    if (!nameResult.ok) {
      result.error = nameResult.error || 'Invitation name was not filled'
      return result
    }
    await page.waitForTimeout(300)
  }

  // 2. 填写有效期截至
  if (options.expirationDays) {
    try {
      const futureDate = new Date()
      futureDate.setDate(futureDate.getDate() + options.expirationDays)
      const dateStr = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`
      const [yearText, monthText, dayText] = dateStr.split('-')
      const targetYear = Number(yearText)
      const targetMonth = Number(monthText)
      const targetDay = String(Number(dayText)).padStart(2, '0')

      await page.evaluate(() => {
        const visible = (el) => {
          const st = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const input = [...document.querySelectorAll('input')]
          .filter(visible)
          .find((el) => el.placeholder === '结束日期' || /结束日期|日期/.test(el.placeholder))
        input?.click()
      })
      await page.waitForTimeout(700)

      for (let i = 0; i < 24; i += 1) {
        const state = await page.evaluate(() => {
          const visible = (el) => {
            const st = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
          }
          const popup = [...document.querySelectorAll('.core-picker-container')].filter(visible).at(-1)
          const header = popup?.querySelector('.core-picker-header-value')?.textContent?.replace(/\s+/g, ' ').trim()
          return { header: header || null }
        })
        const match = state.header?.match(/(\d{2})\/(\d{4})/)
        if (!match) break

        const curMonth = Number(match[1])
        const curYear = Number(match[2])
        if (curYear === targetYear && curMonth === targetMonth) break

        const delta = (targetYear - curYear) * 12 + (targetMonth - curMonth)
        await page.evaluate((delta) => {
          const visible = (el) => {
            const st = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
          }
          const popup = [...document.querySelectorAll('.core-picker-container')].filter(visible).at(-1)
          const icons = [...(popup?.querySelectorAll('.core-picker-header-icon') || [])].filter(visible)
          if (delta > 0) {
            const target = Math.abs(delta) >= 12 ? icons.at(-1) : icons.at(-2)
            target?.click()
          } else if (delta < 0) {
            const target = Math.abs(delta) >= 12 ? icons[0] : icons[1]
            target?.click()
          }
        }, delta)
        await page.waitForTimeout(500)
      }

      const picked = await page.evaluate((targetDay) => {
        const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
        const visible = (el) => {
          const st = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const popup = [...document.querySelectorAll('.core-picker-container')].filter(visible).at(-1)
        const cells = [...(popup?.querySelectorAll('.core-picker-cell-in-view') || [])]
          .filter(visible)
          .filter((cell) => !String(cell.className || '').includes('disabled'))
        const target = cells.find((cell) => norm(cell.innerText || cell.textContent) === targetDay)
        if (!target) return { ok: false, candidates: cells.map((cell) => norm(cell.innerText || cell.textContent)) }
        target.click()
        return { ok: true, text: norm(target.innerText || target.textContent) }
      }, targetDay)
      await page.waitForTimeout(700)

      const expirationDateValue = await page.evaluate(() => {
        const visible = (el) => {
          const st = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const input = [...document.querySelectorAll('input')]
          .filter(visible)
          .find((el) => el.placeholder === '结束日期' || /结束日期|日期/.test(el.placeholder))
        return input?.value || null
      })
      result.expirationDate = dateStr
      result.expirationDateValue = expirationDateValue
      result.expirationDatePicked = picked
    } catch (e) {
      result.expirationDateError = e.message
    }
    await page.waitForTimeout(300)
  }

  // 3. 填写联系方式（Facebook账号）
  if (options.facebookAccount) {
    try {
      const fbInput = page.locator('input[placeholder="请输入 Facebook 账号"]').first()
      await fbInput.click({ timeout: 5000, force: true })
      await fbInput.fill(options.facebookAccount, { timeout: 5000 })
      await page.keyboard.press('Tab')
      result.facebookAccount = options.facebookAccount
    } catch (e) {}
    await page.waitForTimeout(300)
  }

  // 4. 填写邀请文本
  if (options.invitationText) {
    try {
      // textarea可能在多个地方，使用第一个可见的textarea
      const textArea = page.locator('textarea').first()
      await textArea.click({ timeout: 5000 })
      await textArea.fill(options.invitationText, { timeout: 5000 })
      result.invitationText = options.invitationText
    } catch (e) {}
    await page.waitForTimeout(300)
  }

  // 5. 选择商品（输入产品ID）
  if (options.productIds && options.productIds.length > 0) {
    try {
      // 点击"选择商品"折叠面板
      await page.click('[role="button"]:has-text("选择商品")', { timeout: 5000 })
      await page.waitForTimeout(800)

      // 点击"添加商品"按钮
      await page.click('button:has-text("添加商品")', { timeout: 5000 })
      await page.waitForTimeout(1500)

      // 切换到"商品 ID"搜索模式
      await page.evaluate(() => {
        const selects = document.querySelectorAll('.core-select-view')
        for (const s of selects) {
          if (s.innerText && s.innerText.includes('商品名称')) {
            s.click()
            return
          }
        }
      })
      await page.waitForTimeout(800)

      // 选择"商品 ID"选项
      await page.evaluate(() => {
        const options = document.querySelectorAll('[role="option"], [class*="option-item"]')
        for (const opt of options) {
          if (opt.innerText && opt.innerText.includes('商品 ID')) {
            opt.click()
            return
          }
        }
      })
      await page.waitForTimeout(1000)

      // 逐个搜索并添加商品。添加弹窗在切换搜索关键词时不会稳定保留跨页勾选，
      // 所以每个商品单独搜索、勾选、点击“添加”。
      for (let productIndex = 0; productIndex < options.productIds.length; productIndex += 1) {
        const productId = options.productIds[productIndex]
        const productResult = { id: productId, inputSet: false, searchClicked: false, selected: false }
        try {
          if (productIndex > 0) {
            const drawerOpen = await page.evaluate(() => {
              const visible = (el) => {
                const st = window.getComputedStyle(el)
                const r = el.getBoundingClientRect()
                return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
              }
              return [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')]
                .filter(visible)
                .some((scope) => [...scope.querySelectorAll('input[placeholder*="搜索"]')].some((input) => visible(input) && input.ariaHidden !== 'true'))
            })
            if (!drawerOpen) {
              await page.evaluate(() => {
                const visible = (el) => {
                  const st = window.getComputedStyle(el)
                  const r = el.getBoundingClientRect()
                  return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
                }
                const target = [...document.querySelectorAll('button')]
                  .filter((btn) => visible(btn) && (btn.textContent || '').trim() === '添加商品')
                  .at(-1)
                if (target) target.click()
              })
              await page.waitForTimeout(1500)
            }
            await page.evaluate(() => {
              const selects = document.querySelectorAll('.core-select-view')
              for (const s of selects) {
                if (s.innerText && s.innerText.includes('商品名称')) {
                  s.click()
                  return
                }
              }
            })
            await page.waitForTimeout(800)
            await page.evaluate(() => {
              const options = document.querySelectorAll('[role="option"], [class*="option-item"]')
              for (const opt of options) {
                if (opt.innerText && opt.innerText.includes('商品 ID')) {
                  opt.click()
                  return
                }
              }
            })
            await page.waitForTimeout(1000)
          }

          // 用原生setter设置值以触发React onChange
          const setResult = await page.evaluate((id) => {
            const visible = (el) => {
              const st = window.getComputedStyle(el)
              const r = el.getBoundingClientRect()
              return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
            }
            const scopes = [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')].filter(visible)
            const scope = scopes.at(-1) || document
            const inputs = [...scope.querySelectorAll('input[placeholder*="搜索"]')]
              .filter((input) => visible(input))
              .filter((input) => input.ariaHidden !== 'true')
              .filter((input) => !input.readOnly && !input.disabled)
            for (const input of inputs) {
              if (input.ariaHidden !== 'true' && !input.placeholder.includes('达人')) {
                input.focus()
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                nativeInputValueSetter.call(input, id)
                input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: id }))
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return { ok: true, placeholder: input.placeholder }
              }
            }
            return { ok: false }
          }, productId)
          productResult.inputSet = Boolean(setResult.ok)
          productResult.inputPlaceholder = setResult.placeholder || null
          if (setResult.ok) {
            await page.waitForTimeout(500)
            await page.keyboard.press('Enter').catch(() => {})
            await page.waitForTimeout(1200)

            // 点击搜索图标按钮
            const searchClicked = await page.evaluate(() => {
              const visible = (el) => {
                const st = window.getComputedStyle(el)
                const r = el.getBoundingClientRect()
                return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
              }
              const scopes = [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')].filter(visible)
              const scope = scopes.at(-1) || document
              const inputs = [...scope.querySelectorAll('input[placeholder*="搜索"]')]
                .filter((input) => visible(input))
                .filter((input) => input.ariaHidden !== 'true')
              for (const input of inputs) {
                if (input.ariaHidden !== 'true' && !input.placeholder.includes('达人')) {
                  // 找搜索图标的父级
                  const wrapper = input.closest('.core-input-group-wrapper, .core-input-group, [class*="input-group"], [class*="search"]')
                  if (wrapper) {
                    // 点击搜索图标
                    const searchIcon = wrapper.querySelector('button, svg.arco-icon-search, .core-input-group-suffix, [class*="suffix"], [class*="search"]')
                    if (searchIcon) {
                      searchIcon.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
                      searchIcon.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
                      searchIcon.dispatchEvent(new MouseEvent('click', { bubbles: true }))
                      return true
                    }
                  }
                }
              }
              return false
            })
            productResult.searchClicked = Boolean(searchClicked)
            await page.waitForTimeout(3000)

            // 查找搜索结果中匹配产品ID的行（结果加载有延迟，做短轮询）
            let clicked = { ok: false }
            for (let attempt = 0; attempt < 8 && !clicked.ok; attempt += 1) {
              clicked = await page.evaluate((id) => {
                const visible = (el) => {
                  const st = window.getComputedStyle(el)
                  const r = el.getBoundingClientRect()
                  return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
                }
              const scopes = [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')].filter(visible)
              const scope = scopes.at(-1) || document
              const tables = [...scope.querySelectorAll('table')].filter(visible)
                for (const table of tables) {
                  if (table.closest('.core-collapse-item-content') || table.closest('.core-modal')) {
                    const rows = table.querySelectorAll('tbody tr')
                    for (const row of rows) {
                      const text = row.innerText || ''
                      if (text.includes(id)) {
                        const checkbox = row.querySelector('label.core-checkbox')
                        if (checkbox) {
                          checkbox.click()
                          return { ok: true, foundIn: 'modal table' }
                        }
                      }
                    }
                  }
                }
                for (const table of tables) {
                  const rows = table.querySelectorAll('tbody tr')
                  for (const row of rows) {
                    const text = row.innerText || ''
                    if (text.includes(id) && text.length < 500) {
                      const checkbox = row.querySelector('label.core-checkbox')
                      if (checkbox) {
                        checkbox.click()
                        return { ok: true, foundIn: 'any table' }
                      }
                    }
                  }
                }
                return { ok: false }
              }, productId)
              if (!clicked.ok) await page.waitForTimeout(1000)
            }
            productResult.selected = Boolean(clicked.ok)
            productResult.foundIn = clicked.foundIn || null
            await page.waitForTimeout(500)

            if (clicked.ok) {
              const addClicked = await page.evaluate(() => {
                const visible = (el) => {
                  const st = window.getComputedStyle(el)
                  const r = el.getBoundingClientRect()
                  return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
                }
                const scopes = [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')].filter(visible)
                const scope = scopes.at(-1) || document
                const buttons = [...scope.querySelectorAll('button')]
                const target = buttons
                  .filter((btn) => visible(btn) && (btn.textContent || '').trim() === '添加')
                  .at(-1)
                if (!target) return false
                target.click()
                return true
              })
              productResult.addClicked = Boolean(addClicked)
              await page.waitForTimeout(1500)
              result.productSearch.push(productResult)
              continue
            }

            // 清除搜索框
            await page.evaluate(() => {
              const visible = (el) => {
                const st = window.getComputedStyle(el)
                const r = el.getBoundingClientRect()
                return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
              }
              const scopes = [...document.querySelectorAll('.core-drawer-wrapper,.core-modal,[role="dialog"]')].filter(visible)
              const scope = scopes.at(-1) || document
              const inputs = [...scope.querySelectorAll('input[placeholder*="搜索"]')]
                .filter((input) => visible(input))
                .filter((input) => input.ariaHidden !== 'true')
              for (const input of inputs) {
                if (input.ariaHidden !== 'true' && !input.placeholder.includes('达人')) {
                  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
                  nativeInputValueSetter.call(input, '')
                  input.dispatchEvent(new Event('input', { bubbles: true }))
                  return
                }
              }
            })
            await page.waitForTimeout(500)
          }
        } catch (e) {
          productResult.error = e.message
        }
        result.productSearch.push(productResult)
      }

      result.productIds = options.productIds
      result.productAddButton = result.productSearch.some((item) => item.addClicked)
    } catch (e) {
      result.productIds = options.productIds
      result.productError = e.message
    }
  }

  // 6. 设置商品佣金和店铺广告佣金
  if (options.standardCommissionRate || options.shopAdsCommission !== undefined || options.shopAdsCommissionRate) {
    try {
      const ensureRows = async () => page.evaluate(() => {
        const visible = (el) => {
          const st = getComputedStyle(el)
          const r = el.getBoundingClientRect()
          return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
        }
        const rows = [...document.querySelectorAll('table tbody tr')]
          .filter(visible)
          .filter((row) => row.querySelector('input[placeholder="1.00-80.00"]') || row.querySelector('[role="switch"]'))
        if (rows.length > 0) return { rowCount: rows.length, expanded: true }

        const productToggle = [...document.querySelectorAll('[role="button"],button')]
          .filter(visible)
          .find((el) => (el.innerText || '').includes('选择商品'))
        productToggle?.click()
        return { rowCount: 0, expanded: Boolean(productToggle) }
      })

      let rowState = await ensureRows()
      if (!rowState.rowCount && rowState.expanded) {
        await page.waitForTimeout(1000)
        rowState = await ensureRows()
      }

      const commissionRows = await page.evaluate(
        ({ standardRate, enableAds }) => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
          const visible = (el) => {
            const st = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
          }
          const setInput = (input, value) => {
            input.focus()
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, String(value))
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            input.dispatchEvent(new Event('blur', { bubbles: true }))
          }

          const rows = [...document.querySelectorAll('table tbody tr')].filter(visible)
          const results = []
          for (const row of rows) {
            if (!row.querySelector('input[placeholder="1.00-80.00"]') && !row.querySelector('[role="switch"]')) continue
            const inputs = [...row.querySelectorAll('input[placeholder="1.00-80.00"]')]
              .filter(visible)
              .filter((input) => input.ariaHidden !== 'true')
            const standardInput = inputs[0] || null
            if (standardInput && standardRate) setInput(standardInput, standardRate)

            const switchEl = [...row.querySelectorAll('[role="switch"]')].find(visible)
            const switchBefore = switchEl?.getAttribute('aria-checked') || null
            if (switchEl && enableAds && switchBefore !== 'true') {
              switchEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
              switchEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
              switchEl.dispatchEvent(new MouseEvent('click', { bubbles: true }))
            }

            results.push({
              rowText: norm(row.innerText).slice(0, 500),
              standardInputFound: Boolean(standardInput),
              standardValue: standardInput?.value || null,
              switchFound: Boolean(switchEl),
              switchBefore,
            })
          }
          return results
        },
        {
          standardRate: options.standardCommissionRate ? String(options.standardCommissionRate) : null,
          enableAds: options.shopAdsCommission !== false,
        },
      )
      result.commissionRows = commissionRows
      if (options.standardCommissionRate) result.standardCommissionRate = options.standardCommissionRate
      if (options.shopAdsCommission !== undefined) result.shopAdsCommission = options.shopAdsCommission

      if (options.shopAdsCommission !== false && options.shopAdsCommissionRate) {
        await page.waitForTimeout(1500)
        const adRows = await page.evaluate((adsRate) => {
          const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
          const visible = (el) => {
            const st = getComputedStyle(el)
            const r = el.getBoundingClientRect()
            return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
          }
          const setInput = (input, value) => {
            input.focus()
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
            setter.call(input, String(value))
            input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }))
            input.dispatchEvent(new Event('change', { bubbles: true }))
            input.dispatchEvent(new Event('blur', { bubbles: true }))
          }

          const rows = [...document.querySelectorAll('table tbody tr')].filter(visible)
          const results = []
          for (const row of rows) {
            if (!row.querySelector('input[placeholder="1.00-80.00"]') && !row.querySelector('[role="switch"]')) continue
            const inputs = [...row.querySelectorAll('input[placeholder="1.00-80.00"]')]
              .filter(visible)
              .filter((input) => input.ariaHidden !== 'true')
            const adsInput = inputs[1] || null
            if (adsInput) setInput(adsInput, adsRate)
            results.push({
              rowText: norm(row.innerText).slice(0, 500),
              visibleCommissionInputCount: inputs.length,
              adsInputFound: Boolean(adsInput),
              values: inputs.map((input) => input.value),
              switchChecked: [...row.querySelectorAll('[role="switch"]')].find(visible)?.getAttribute('aria-checked') || null,
            })
          }
          return results
        }, String(options.shopAdsCommissionRate))
        result.adCommissionRows = adRows
        result.shopAdsCommission = true
        result.shopAdsCommissionRate = options.shopAdsCommissionRate
      }
    } catch (e) {
      result.commissionError = e.message
    }
    await page.waitForTimeout(300)
  }

  // 9. 设置免费样品（勾选复选框）
  if (options.freeSampleEnabled !== false) {
    await page.evaluate(() => {
      const labels = document.querySelectorAll('label')
      const sampleLabel = Array.from(labels).find(el => el.innerText.includes('提供免费样品'))
      if (sampleLabel) {
        sampleLabel.click()
      }
    })
    result.freeSample = '提供免费样品'
    await page.waitForTimeout(300)
  }

  // 6. 自动审核申请（勾选复选框）
  if (options.autoApprove !== false) {
    await page.evaluate(() => {
      const labels = document.querySelectorAll('label')
      const approveLabel = Array.from(labels).find(el => el.innerText.includes('手动审核申请'))
      if (approveLabel) {
        approveLabel.click()
      }
    })
    await page.waitForTimeout(300)
  }

  // 7. 点击发送按钮
  const sendClicked = await page.evaluate(() => {
    const btns = document.querySelectorAll('button')
    const sendBtn = Array.from(btns).find(b => b.innerText.trim() === '发送')
    if (!sendBtn) return false
    sendBtn.click()
    return true
  })
  result.sendClicked = sendClicked
  if (!sendClicked) {
    result.submitted = false
    result.error = 'Send button not found'
    return result
  }

  result.submitOutcome = await waitInvitationSubmitOutcome(page, options)
  if (result.submitOutcome.stage === 'overlap') {
    result.overlapResolution = await resolveOverlapModalIfPresent(page)
    result.submitOutcome = await waitInvitationSubmitOutcome(page, options)
  } else {
    result.overlapResolution = { stage: 'none' }
  }
  result.submitted = result.submitOutcome.stage === 'success'
  if (!result.submitted) result.error = result.submitOutcome.error || `Submit did not reach success state: ${result.submitOutcome.stage}`
  if (result.submitted) {
    result.messageShare = await sendMessageAfterInvitationSuccess(page, options)
  }

  return result
}

async function waitInvitationSubmitOutcome(page, options) {
  const startedAt = Date.now()
  const deadline = Date.now() + Math.max(8000, options.invitationTimeoutMs || 20000)
  let last = null
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const visible = (el) => {
        const st = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const bodyText = norm(document.body.innerText)
      const dialogs = [...document.querySelectorAll('.core-modal,.core-modal-wrapper,[role="dialog"],[class*="Modal"],[class*="modal"]')]
        .filter(visible)
        .map((el) => norm(el.innerText || el.textContent))
        .filter(Boolean)
      if (/合作邀请发送成功|邀请发送成功/.test(bodyText)) {
        return { stage: 'success' }
      }
      if (
        bodyText.includes('解决重叠问题') ||
        bodyText.includes('你想如何解决这些重叠问题') ||
        dialogs.some((text) =>
          text.includes('从此邀请中移除') ||
          text.includes('移动到此邀请') ||
          text.includes('正在进行中的邀请')
        )
      ) {
        return { stage: 'overlap', dialogs: dialogs.slice(0, 3) }
      }
      const visibleErrors = [...document.querySelectorAll('[role="alert"],.core-toast,[class*="toast"],[class*="Toast"]')]
        .filter(visible)
        .map((el) => norm(el.innerText || el.textContent))
        .filter(Boolean)
        .filter((text) => {
          if (text.includes('件商品添加成功') || text.includes('合作邀请发送成功') || text.includes('邀请发送成功')) return false
          return /失败|错误|异常|无法|不能|未完成|重试|请填写|请选择|required|failed|error|invalid/i.test(text)
        })
      if (visibleErrors.length) return { stage: 'error', error: visibleErrors.join(' | ').slice(0, 500) }
      return { stage: 'pending', bodyPreview: bodyText.slice(0, 800) }
    })
    last = state
    if (state.stage === 'error' && Date.now() - startedAt < 10000) {
      await page.waitForTimeout(700)
      continue
    }
    if (state.stage !== 'pending') return state
    await page.waitForTimeout(700)
  }
  return { ...(last || {}), stage: last?.stage || 'timeout', error: 'Timed out waiting for submit result' }
}

async function sendMessageAfterInvitationSuccess(page, options) {
  const context = page.context()
  const result = { ok: false, openedMessagePage: false, clickedShare: false }
  const pagesBefore = new Set(context.pages())
  const pagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null)

  const clickMessage = await clickButtonByText(page, TEXT_SEND_MESSAGE_TO_CREATORS, { timeoutMs: 10000, preferLast: true })
  result.clickMessage = clickMessage
  if (!clickMessage.ok) {
    result.error = clickMessage.error || `Failed to click ${TEXT_SEND_MESSAGE_TO_CREATORS}`
    return result
  }

  const newPage = await pagePromise
  let messagePage = newPage || null
  if (messagePage) {
    await messagePage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
  } else {
    await page.waitForTimeout(4000)
    messagePage = context.pages().find((candidate) => !pagesBefore.has(candidate)) || null
  }
  messagePage = context.pages().find((candidate) => candidate.url().includes('/seller/im')) || messagePage || page
  result.openedMessagePage = messagePage.url().includes('/seller/im')
  result.messagePageUrl = messagePage.url()

  await messagePage.bringToFront().catch(() => {})
  await messagePage.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs || 15000 }).catch(() => {})
  await messagePage.waitForTimeout(1500)

  const clickShare = await clickVisibleButtonByMouse(messagePage, [TEXT_SHARE, TEXT_SEND, TEXT_CONFIRM], 15000)
  result.clickShare = clickShare
  result.clickedShare = Boolean(clickShare.ok)
  if (!clickShare.ok) {
    result.error = clickShare.error || 'Failed to click message share button'
    return result
  }

  await messagePage.waitForTimeout(5000)
  result.afterShare = await messagePage.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const dialogs = [...document.querySelectorAll('.core-modal,.core-modal-wrapper,[role="dialog"],[class*="modal"],[class*="Modal"]')]
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter(Boolean)
    const toasts = [...document.querySelectorAll('[role="alert"],.core-toast,[class*="toast"],[class*="Toast"]')]
      .filter(visible)
      .map((el) => norm(el.innerText || el.textContent))
      .filter(Boolean)
    return { dialogs: dialogs.slice(0, 3), toasts: toasts.slice(0, 5), bodyPreview: norm(document.body.innerText).slice(0, 800) }
  })
  result.ok = !result.afterShare.dialogs.some((text) => text.includes(TEXT_SHARE) || text.includes(TEXT_SEND))
  if (!result.ok) result.error = 'Message share dialog did not close after clicking share'
  return result
}

async function clickVisibleButtonByMouse(page, labels, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const target = await page.evaluate((wantedLabels) => {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const visible = (el) => {
        const st = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const buttons = [...document.querySelectorAll('button,[role="button"]')]
        .filter(visible)
        .map((el) => {
          const text = norm(el.innerText || el.textContent)
          const r = el.getBoundingClientRect()
          return {
            text,
            disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || String(el.className || '').includes('disabled'),
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            width: r.width,
            height: r.height,
          }
        })
        .filter((item) => item.text && wantedLabels.includes(item.text))
      return buttons.filter((item) => !item.disabled).at(-1) || buttons.at(-1) || null
    }, labels)
    last = target
    if (target && !target.disabled) {
      await page.mouse.click(target.x, target.y)
      return { ok: true, text: target.text, x: target.x, y: target.y }
    }
    await page.waitForTimeout(700)
  }
  return { ok: false, error: `Button not found or disabled: ${labels.join('/')}`, last }
}

async function resolveOverlapModalIfPresent(page) {
  const moveConfirmStep = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const dialogs = [...document.querySelectorAll('.core-modal,.core-modal-wrapper,[role="dialog"],[class*="Modal"],[class*="modal"]')]
      .filter(visible)
    const moveDialog = dialogs.find((el) => {
      const text = norm(el.innerText || el.textContent)
      return text.includes('移动到此邀请') && text.includes('移动') && text.includes('返回')
    })
    if (!moveDialog) return { stage: 'not-move-confirm' }
    const backBtn = [...moveDialog.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '返回')
    if (backBtn) backBtn.click()
    return { stage: 'move-confirm-return', clickedBack: Boolean(backBtn) }
  })
  if (moveConfirmStep.stage === 'move-confirm-return') {
    await page.waitForTimeout(1200)
  }

  const firstStep = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const bodyText = norm(document.body.innerText)
    const alreadyConfirmRemove = bodyText.includes('从此邀请中移除') && bodyText.includes('移除') && !bodyText.includes('去解决')
    if (alreadyConfirmRemove) return { stage: 'confirm-remove' }

    if (!bodyText.includes('解决重叠问题') && !bodyText.includes('你想如何解决这些重叠问题')) {
      return { stage: 'none' }
    }

    const option = [...document.querySelectorAll('label.core-radio,label[class*="radio"],[role="radio"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent).startsWith('从此邀请中移除达人'))
    if (option) {
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
      option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }
    const selectedRemoveOption = Boolean(option) && (
      option.getAttribute('aria-checked') === 'true' ||
      String(option.className || '').includes('checked') ||
      Boolean(option.querySelector('input:checked'))
    )

    const solveBtn = [...document.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '去解决')
    if (solveBtn && selectedRemoveOption) solveBtn.click()

    return {
      stage: 'choose-resolution',
      selectedRemoveOption: Boolean(option),
      removeOptionChecked: selectedRemoveOption,
      clickedSolve: Boolean(solveBtn && selectedRemoveOption),
    }
  })

  if (firstStep.stage === 'none') return { ...moveConfirmStep, ...firstStep }
  if (firstStep.stage === 'choose-resolution') await page.waitForTimeout(1200)

  const secondStep = await page.evaluate(() => {
    const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      const st = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
    }
    const scopes = [...document.querySelectorAll('.core-modal,.core-modal-wrapper,[role="dialog"],[class*="Modal"],[class*="modal"]')]
      .filter(visible)
      .filter((el) => norm(el.innerText || el.textContent).includes('从此邀请中移除'))
    const scope = scopes.find((el) => [...el.querySelectorAll('button,[role="button"]')]
      .some((btn) => visible(btn) && norm(btn.innerText || btn.textContent) === '移除')) || document
    const removeBtn = [...scope.querySelectorAll('button,[role="button"]')]
      .filter(visible)
      .find((el) => norm(el.innerText || el.textContent) === '移除')
    if (!removeBtn) return { clickedConfirmRemove: false }
    removeBtn.click()
    return { clickedConfirmRemove: true }
  })

  await page.waitForTimeout(3000)
  return { ...moveConfirmStep, ...firstStep, ...secondStep }
}

async function clickFinalInvite(page, options) {
  const deadline = Date.now() + options.invitationTimeoutMs
  let last = null

  while (Date.now() < deadline) {
    const result = await page.evaluate((inviteText) => {
      const visible = (el) => {
        const st = window.getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0 && r.height > 0
      }
      const disabled = (el) =>
        Boolean(el.disabled) ||
        el.getAttribute('aria-disabled') === 'true' ||
        String(el.className || '').includes('disabled')

      const buttons = [...document.querySelectorAll('button,[role="button"]')]
        .filter((el) => visible(el) && (el.textContent || '').replace(/\s+/g, ' ').trim() === inviteText)

      const footerButtons = buttons.filter((el) => {
        const r = el.getBoundingClientRect()
        return r.y > window.innerHeight / 2
      })
      const target = footerButtons.at(-1) || buttons.at(-1)
      if (!target) return { ok: false, error: 'Final invite button not found' }
      if (disabled(target)) return { ok: false, error: 'Final invite button is disabled' }

      target.click()
      return { ok: true, text: (target.textContent || '').replace(/\s+/g, ' ').trim() }
    }, TEXT_INVITE)

    last = result
    if (result.ok) return result
    await sleep(500)
  }

  return last || { ok: false, error: 'Final invite button timed out' }
}

async function runForRegion(page, shopRegion, options) {
  const url = buildCreatorUrl(shopRegion)
  const multiLabel = options.multiLabel || ''
  const result = {
    shopRegion,
    url,
    ok: false,
    invitationName: options.invitationName,
    productIds: options.productIds,
    selectedCreators: null,
    bulkInvite: null,
    selectedInvitationPlan: null,
    finalInvite: null,
    filters: null,
    finalUrl: '',
    bodyPreview: '',
  }

  try {
    await logProgress(page, `[脚本${multiLabel}] 正在打开联盟达人发现页（区域 ${shopRegion}）`)
    const nav = await gotoCreatorPageRespectingShopRegion(page, shopRegion, options)
    if (!nav.ok) {
      result.error = nav.error
      result.regionSwitch = nav.regionSwitch
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 站点切换失败：${nav.error || 'unknown'}`)
      return result
    }
    result.regionSwitch = nav.regionSwitch
    const ready = await waitForCreatorPage(page, options)
    if (!ready.ok) {
      result.error = ready.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 达人发现页未就绪：${ready.error || 'unknown'}`)
      return result
    }
    await logProgress(page, `[脚本${multiLabel}] 达人发现页已打开，正在应用筛选条件`)

    result.filters = await applyCreatorFilters(page, options)
    if (!result.filters.ok) {
      result.error = result.filters.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 筛选条件应用失败`)
      return result
    }

    await logProgress(page, `[脚本${multiLabel}] 正在搜索达人：「${options.creatorSearch || ''}」`)
    result.creatorSearch = await applyCreatorKeywordSearch(page, options)
    if (!result.creatorSearch.ok) {
      result.error = result.creatorSearch.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 达人搜索失败`)
      return result
    }

    await logProgress(
      page,
      `[脚本${multiLabel}] 正在设置排序${options.randomSort ? '（随机）' : options.creatorSortBy ? `：${options.creatorSortBy}` : ''}`,
    )
    result.creatorSort = await applyCreatorSort(page, options)
    if (!result.creatorSort.ok) {
      result.error = result.creatorSort.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      await logProgress(page, `[脚本${multiLabel}] 排序设置失败`)
      return result
    }

    if (options.useNewFlow) {
      return await runCreateNewInvitationFlow(page, shopRegion, options, result, page.url())
    }

    // 新流程：跳过planProbe，直接选择达人
    if (options.useNewFlow) {
      result.selectedCreators = await selectCreatorRows(page, options.maxCreators, options)
      if (!result.selectedCreators.ok) {
        result.error = 'No creators were selected'
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }
    } else {
      // 原有流程：探测邀约计划容量
      const planProbe = await probeInvitationPlanCapacity(page, options)
      result.planProbe = planProbe
      if (!planProbe.ok) {
        result.error = planProbe.error
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }
      const inviteCount = Math.min(options.maxCreators, planProbe.selected.remaining)
      result.selectedCreators = await selectCreatorRows(page, inviteCount, options)
      if (!result.selectedCreators.ok) {
        result.error = 'No creators were selected'
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }
    }

    await returnToBulkActions(page)
    result.bulkInvite = await clickButtonByText(page, TEXT_BULK_INVITE, { timeoutMs: options.invitationTimeoutMs })
    if (!result.bulkInvite.ok) {
      result.error = result.bulkInvite.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      return result
    }

    await sleep(options.afterBulkInviteMs)

    // 新流程：切换到"创建新邀请"并选择"仅佣金"
    if (options.useNewFlow) {
      const switchResult = await switchToCreateNewInvitation(page, options)
      result.createFlow = switchResult
      if (!switchResult.ok) {
        result.error = switchResult.error
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }

      // 点击邀请按钮跳转到表单页
      const formResult = await clickInviteButtonToForm(page, options)
      result.inviteToForm = formResult
      if (!formResult.ok) {
        result.error = formResult.error
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }

      const selectedCreatorIdsFromUrl = attachCreatorIdsFromUrl(result.selectedCreators, page.url())
      result.selectedCreators.creatorIdsFromUrl = selectedCreatorIdsFromUrl
      const duplicateCreators = findAlreadyInvitedSelectedCreators(options.productIds, result.selectedCreators?.selectedCreators || [])
      if (duplicateCreators.length) {
        result.error = `Selected creators already invited for product(s): ${duplicateCreators.map((item) => item.creatorId || item.name).join(', ')}`
        result.duplicateCreators = duplicateCreators
        result.finalUrl = page.url()
        result.bodyPreview = await safeBodyPreview(page)
        return result
      }

      // 填写表单并发送邀约。
      result.formFill = await fillInvitationForm(page, options)
      result.ok = Boolean(result.formFill?.submitted)
      if (!result.ok) result.error = result.formFill?.error || 'Invitation form was not submitted'
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      if (result.ok && /合作邀请发送成功|邀请发送成功/.test(result.bodyPreview || '')) {
        result.invitedLedger = recordInvitedCreatorsForProducts(
          options.productIds,
          result.selectedCreators?.selectedCreators || [],
          { invitationName: options.invitationName, shopRegion },
        )
      }
      return result
    }

    // 原有流程：选择已有邀约计划
    const planNameForFinalSelection = options.invitationName || planProbe.selected.text
    result.selectedInvitationPlan = await selectInvitationPlan(page, planNameForFinalSelection, options)
    if (!result.selectedInvitationPlan.ok) {
      result.error = result.selectedInvitationPlan.error
      result.finalUrl = page.url()
      result.bodyPreview = await safeBodyPreview(page)
      return result
    }

    result.finalInvite = await clickFinalInvite(page, options)
    result.ok = Boolean(result.finalInvite.ok)
    await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
    await sleep(options.afterFinalInviteMs)

    result.finalUrl = page.url()
    result.bodyPreview = await safeBodyPreview(page)
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
  const productCategoryArg = parseListArg('--product_category')
  const avgCommissionRateArg = parseListArg('--avg_commission_rate')
  const dropdownFilters = {
    productCategory: normalizeFilterValues(
      productCategoryArg.length ? productCategoryArg : ['\u5973\u88c5\u4e0e\u5973\u58eb\u5185\u8863'],
      'productCategory',
    ),
    avgCommissionRate: normalizeFilterValues(
      avgCommissionRateArg.length ? avgCommissionRateArg : ['\u5c0f\u4e8e 15%'],
      'avgCommissionRate',
    ),
    contentType: normalizeFilterValues(parseListArg('--content_type'), 'contentType'),
    creatorAgency: normalizeFilterValues(parseListArg('--creator_agency'), 'creatorAgency'),
    contentLanguage: normalizeFilterValues(parseListArg('--content_language'), 'contentLanguage'),
  }
  const followerFilters = {
    fanAge: normalizeFilterValues(parseListArg('--fan_age'), 'fanAge'),
    fanGender: normalizeFilterValues(parseListArg('--fan_gender'), 'fanGender'),
    fanCount: normalizeFilterValues(parseListArg('--fan_count'), 'fanCount'),
  }
  const performanceFilters = {
    gmv: normalizeFilterValues(parseListArg('--gmv'), 'gmv'),
    unitsSold: normalizeFilterValues(parseListArg('--units_sold'), 'unitsSold'),
    avgVideoViews: normalizeFilterValues(parseListArg('--avg_video_views'), 'avgVideoViews'),
    avgLiveViews: normalizeFilterValues(parseListArg('--avg_live_views'), 'avgLiveViews'),
    engagementRate: normalizeFilterValues(parseListArg('--engagement_rate'), 'engagementRate'),
    estimatedPublishRate: normalizeFilterValues(parseListArg('--estimated_publish_rate'), 'estimatedPublishRate'),
    brandCollaboration: normalizeFilterValues(parseListArg('--brand_collaboration'), 'brandCollaboration'),
  }
  const hasAnyFilter =
    Object.values(dropdownFilters).some((values) => values.length) ||
    Object.values(followerFilters).some((values) => values.length) ||
    Object.values(performanceFilters).some((values) => values.length) ||
    getBooleanArg('--uninvited_90_days', true) !== null
  // 生成默认邀请名称：日期+4位随机字符串
  function generateDefaultInvitationName() {
    const date = new Date()
    const dateStr = date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).replace(/\//g, '')
    const random = Math.floor(1000 + Math.random() * 9000)
    return `${dateStr}${random}`
  }

  // 默认邀请文本
  const DEFAULT_INVITATION_TEXT = 'Hi, these products have sold exceptionally well and achieved great results in other markets. Your content style is a perfect fit for our products. To secure our cooperation, we’ve specially increased your commission. Free samples will be provided, and we look forward to collaborating with you.'

  // 默认Facebook账号
  const DEFAULT_FACEBOOK = 'linkeoo'

  // 解析产品ID列表
  const productIdsRaw = getArgValue('--product_ids')
  const productIds = productIdsRaw ? productIdsRaw.split(',').map(s => s.trim()).filter(Boolean) : []
  const creatorSearch = getArgValue('--creator_search') || getArgValue('--search_keyword') || getArgValue('--creator_keyword') || 'top'
  const randomSort = getBooleanArg('--random_sort', getBooleanArg('--creator_random_sort', true))
  const creatorSortBy = getArgValue('--sort_by') || getArgValue('--creator_sort_by')

  const options = {
    useNewFlow: hasFlag('--useNewFlow'), // 新流程：创建新邀约
    maxCreators: Math.min(getNumberArg('--max_creators', 50), 50),
    scrollRounds: getNumberArg('--scroll_rounds', 40),
    waitMs: getNumberArg('--wait_ms', 2500),
    afterSelectMs: getNumberArg('--after_select_ms', 500),
    afterScrollMs: getNumberArg('--after_scroll_ms', 900),
    afterBulkInviteMs: getNumberArg('--after_bulk_invite_ms', 1500),
    afterFinalInviteMs: getNumberArg('--after_final_invite_ms', 3000),
    afterFilterMs: getNumberArg('--after_filter_ms', 1800),
    afterFilterOpenMs: getNumberArg('--after_filter_open_ms', 600),
    afterFilterOptionMs: getNumberArg('--after_filter_option_ms', 400),
    filterTimeoutMs: getNumberArg('--filter_timeout_ms', 12000),
    invitationTimeoutMs: getNumberArg('--invitation_timeout_ms', 20000),
    planCapacity: getNumberArg('--plan_capacity', 50),
    navigationTimeoutMs: getNumberArg('--navigation_timeout_ms', 60000),
    networkIdleTimeoutMs: getNumberArg('--network_idle_timeout_ms', 12000),
    duplicateReselectAttempts: getNumberArg('--duplicate_reselect_attempts', 3),
    // 新流程参数
    invitationName: getArgValue('--invitation_name') || generateDefaultInvitationName(),
    invitationText: getArgValue('--invitation_text') || DEFAULT_INVITATION_TEXT,
    expirationDays: getNumberArg('--expiration_days', 365), // 默认一年
    facebookAccount: getArgValue('--facebook') || DEFAULT_FACEBOOK,
    productIds: productIds,
    // 佣金相关参数
    standardCommissionRate: getNumberArg('--standard_commission_rate', 12), // 默认12%
    shopAdsCommission: getBooleanArg('--shop_ads_commission', true), // 默认开启
    shopAdsCommissionRate: getNumberArg('--shop_ads_commission_rate', 6), // 默认6%
    freeSampleEnabled: getBooleanArg('--free_sample', true),
    autoApprove: getBooleanArg('--auto_approve', true),
    resetFilters: getBooleanArg('--reset_filters', hasAnyFilter),
    creatorSearch,
    randomSort,
    creatorSortBy,
    filters: {
      creator: dropdownFilters,
      followers: followerFilters,
      performance: performanceFilters,
      uninvited90Days: getBooleanArg('--uninvited_90_days', true),
    },
  }

  const keepOpen = hasFlag('--keepOpen')
  const totalRegions = shopRegions.length
  const startUrl = buildCreatorUrl(shopRegions[0])
  const connection = await connectBrowser(startUrl)
  const page = await getActivePage(connection.browser, startUrl)
  page.setDefaultTimeout(12000)
  await openScriptArgsPanel(connection.browser, { scriptDir: SCRIPT_DIR })

  const results = []
  try {
    for (let ri = 0; ri < shopRegions.length; ri += 1) {
      const shopRegion = shopRegions[ri]
      const multiLabel = totalRegions > 1 ? ` [区域 ${ri + 1}/${totalRegions} · ${shopRegion}]` : ''
      await logProgress(
        page,
        `[脚本] 开始联盟批量邀约达人${multiLabel}：区域 ${shopRegion}，最多 ${options.maxCreators} 人`,
      )
      const regionResult = await runForRegion(page, shopRegion, { ...options, multiLabel })
      results.push(regionResult)

      if (totalRegions > 1 && ri + 1 < shopRegions.length) {
        const nextRegion = shopRegions[ri + 1]
        await logProgress(
          page,
          `[脚本] 区域 ${shopRegion} ${regionResult.ok ? '已完成' : '未完成'}，继续下一区域：${nextRegion}`,
        )
      }
    }

    const allOk = results.every((x) => x.ok)
    const summary = {
      ok: allOk,
      cdpUrl: connection.cdpUrl,
      shopRegions,
      results,
    }
    console.log(JSON.stringify(summary, null, 2))
    if (!allOk) process.exitCode = 1

    if (totalRegions === 1) {
      const result = results[0]
      await showPageResultModalUntilAck(page, {
        title: result.ok ? '联盟邀约任务已完成' : '联盟邀约任务结束',
        variant: result.error ? 'danger' : result.ok ? 'success' : 'warning',
        lines: [...buildAffiliateResultLines(result), '', '终端已输出完整 JSON。点击「确定」关闭。'],
      })
    } else if (results.length > 0) {
      const summaryLines = [
        `配置区域（共 ${totalRegions} 个）：${shopRegions.join('、')}`,
        '',
        '分项如下：',
        '',
      ]
      for (const result of results) {
        summaryLines.push(`「${result.shopRegion}」· ${result.ok ? '已完成' : '未完成'}`)
        summaryLines.push(...buildAffiliateResultLines(result).map((line) => (line ? `  ${line}` : line)))
        summaryLines.push('')
      }
      await showPageResultModalUntilAck(page, {
        title: allOk ? '联盟邀约任务已完成' : '联盟邀约任务结束（部分未完成）',
        variant: allOk ? 'success' : 'warning',
        lines: summaryLines,
      })
    }

    if (keepOpen) await new Promise(() => {})
  } finally {
    if (connection.closeBrowser && !keepOpen) await connection.browser.close().catch(() => {})
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exitCode = 1
})

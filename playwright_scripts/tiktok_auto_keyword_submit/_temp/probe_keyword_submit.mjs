#!/usr/bin/env node

/**
 * TikTok 自动关键词提报 - 探针脚本
 * Code: GMNQ5O
 *
 * 目标：连接已登录浏览器 → 打开 trending_keywords 页面 → 从页面提取 shop_id →
 *       调 linkeoo-erp 鉴权拉 userinfo → 匹配 shop_pk → 调 /api/tiktok/product/search_by_keyword/
 *       验证以下事实：
 *         (1) 页面能取到 shop_id（任一来源）；
 *         (2) ERP /api/login 可用、token 写入 chrome.storage.local 后 /api/organization/userinfo/ 可用；
 *         (3) userinfo.shop_list 包含目标 platform==='Tiktok' 且 shop_id 匹配；
 *         (4) /api/tiktok/product/search_by_keyword/ 返回 result.items（数组）。
 *
 * 用法：
 *   # 方式 A：通过 NexBrowser Launch HTTP 拉起档案（推荐）
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_keyword_submit.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH
 *
 *   # 方式 B：使用已开启的 CDP
 *   node playwright_scripts/tiktok_auto_keyword_submit/_temp/probe_keyword_submit.mjs \
 *       --cdp http://127.0.0.1:19876 --shop_region PH
 *
 *   可选：--keyword <具体关键词>（默认从页面首条可见关键词）
 *         --erpBase http://127.0.0.1:8000（默认 https://api.linkeoo.com）
 *         --erpUser <用户名> --erpPass <密码>（默认从环境变量 LINKEOO_USERNAME / LINKEOO_PASSWORD 读取）
 *         --topN 5
 */

import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TRENDING_KEYWORDS_URL =
  'https://seller.tiktokshopglobalselling.com/product/opportunity?shop_region=PH&sort_field=1&use_like=false&tab=trending_keywords'
const DEFAULT_LAUNCH_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_LAUNCH_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_LAUNCH_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEFAULT_ERP_BASE = process.env.LINKEOO_ERP_BASE || 'https://api.linkeoo.com'
const PROBE_CODE = 'GMNQ5O'

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}
function hasFlag(flagName) {
  return process.argv.includes(flagName)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
function logStep(msg) {
  process.stdout.write(`[probe ${new Date().toLocaleTimeString()}] ${msg}\n`)
}

function buildLaunchHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (DEFAULT_LAUNCH_AUTH_KEY) headers[DEFAULT_LAUNCH_AUTH_HEADER] = DEFAULT_LAUNCH_AUTH_KEY
  return headers
}

function buildTrendingUrl(shopRegion) {
  const u = new URL(TRENDING_KEYWORDS_URL)
  const region = String(shopRegion || 'PH').trim().toUpperCase()
  if (region) u.searchParams.set('shop_region', region)
  return u.toString()
}

function resolveSelector() {
  const code = getArgValue('--code') || PROBE_CODE
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
    logStep(`connecting existing CDP: ${cdpUrl}`)
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
 * 在卖家中心主世界抓取 shop_id。优先 window 全局，兜底 localStorage，再兜底 cookie。
 * 与 linkeoo_extension 的 readShopContext 行为一致；保留扩展里的多条来源以便探针覆盖所有分支。
 */
async function readShopIdInPage(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const sources = []

    const sellerStore = window.__SELLER_USER_STORE__
    if (sellerStore?.localSellerId) {
      sources.push({ source: '__SELLER_USER_STORE__.localSellerId', shopid: compact(sellerStore.localSellerId) })
    }

    const fetchStore = window.__SELLER_FETCH_STORE__
    if (fetchStore?.userStore?.localSellerId) {
      sources.push({ source: '__SELLER_FETCH_STORE__.userStore.localSellerId', shopid: compact(fetchStore.userStore.localSellerId) })
    }

    try {
      const raw = localStorage.getItem('SeraphEdrWebAccount')
      if (raw) {
        const o = JSON.parse(raw)
        if (o?.shopid) sources.push({ source: 'SeraphEdrWebAccount.shopid', shopid: compact(o.shopid) })
        else if (o?.account) sources.push({ source: 'SeraphEdrWebAccount.account', shopid: compact(o.account) })
      }
    } catch (_) {
      /* ignore */
    }

    try {
      const m = document.cookie.match(/(?:^|;\s*)oec_seller_id_unified_seller_env=([^;]+)/)
      if (m) sources.push({ source: 'cookie:oec_seller_id_unified_seller_env', shopid: compact(decodeURIComponent(m[1])) })
    } catch (_) {
      /* ignore */
    }

    const scriptEl = document.getElementById('atlas_inject_workbench-base-info')
    let scriptShopid = ''
    let scriptRegion = ''
    if (scriptEl) {
      try {
        const data = JSON.parse(scriptEl.textContent || '{}')
        const seller = data?.seller_base_info?.seller
        if (seller?.seller_id) scriptShopid = compact(seller.seller_id)
        if (seller?.shop_region) scriptRegion = compact(seller.shop_region)
      } catch (_) {
        /* ignore */
      }
    }
    if (scriptShopid) sources.push({ source: 'workbench-base-info.seller_id', shopid: scriptShopid })

    let shopRegion = ''
    try {
      const r = localStorage.getItem('current_shop_region')
      if (r) {
        let v = r
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
        shopRegion = compact(v)
      }
    } catch (_) {
      /* ignore */
    }
    if (!shopRegion && scriptRegion) shopRegion = scriptRegion

    return { sources, shopRegion, primary: sources[0]?.shopid || '' }
  })
}

/**
 * 在 trending_keywords 表格里抓取首条可见关键词。
 */
async function readFirstKeyword(page) {
  return page.evaluate(() => {
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const rows = Array.from(
      document.querySelectorAll('.core-table-body tbody tr, .core-table-content-inner tbody tr, .core-table tbody tr'),
    ).filter((tr) => {
      const r = tr.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    if (!rows.length) return { keyword: '', count: 0 }
    const first = rows[0]
    const firstCell = first.querySelector('td')
    const keyword = firstCell ? compact((firstCell.textContent || '').split('\n')[0]) : ''
    return { keyword, count: rows.length }
  })
}

/**
 * 调用 linkeoo-erp 登录接口拿 token（dev 环境：http://127.0.0.1:8000/api/login/）。
 * 仿照 linkeoo_extension/src/pages/Background/index.js#fetchLinkeooLoginJson。
 */
async function erpLogin({ base, username, password, referer }) {
  const url = `${base}/api/login/`
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Referer: referer,
  }
  try {
    const origin = new URL(base).origin
    // 真实 ERP 也常带 csrftoken header；通过 fetch 一次 GET 拉 cookie 不在 Node 环境中，做不到，
    // 直接登录即可（与 linkeoo_extension 在 SW 内的行为一致，csrftoken 是从 chrome.cookies 拿的）。
    void origin
  } catch (_) {
    /* ignore */
  }
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password }),
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch (_) {
    throw new Error(text ? text.slice(0, 200) : `HTTP ${res.status}`)
  }
  if (!res.ok) {
    const msg = data.msg || data.detail || `请求失败 (${res.status})`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  if (data.status !== 'success' || !data.token) {
    throw new Error(data.msg || data.detail || '登录失败：未拿到 token')
  }
  return data.token
}

async function erpRequest({ base, token, path, method = 'POST', body }) {
  const url = `${base}${path}`
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `token ${token}`,
    Referer: base.endsWith('/') ? base : `${base}/`,
  }
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : {}
  } catch (_) {
    /* keep raw */
  }
  return { ok: res.ok, status: res.status, data, text }
}

function findShopPkByShopId(userInfo, pageShopId, pageRegion) {
  if (!userInfo) return null
  const shopList = Array.isArray(userInfo.shop_list) ? userInfo.shop_list : []
  const tiktokShops = shopList.filter((s) => s?.platform === 'Tiktok')
  const target = String(pageShopId || '').trim()
  const region = String(pageRegion || '').trim().toUpperCase()
  if (!target) return null
  const exact = tiktokShops.find((s) => {
    if (String(s.shop_id || '').trim() !== target) return false
    if (!region) return true
    const r = String(s.region || s.market || '').trim().toUpperCase()
    return !r || r === region
  })
  if (exact?.id) return { match: exact, matchMode: 'exact' }
  const fuzzy = tiktokShops.find((s) => String(s.shop_id || '').trim() === target)
  if (fuzzy?.id) return { match: fuzzy, matchMode: 'fuzzy' }
  return null
}

async function main() {
  const shopRegion = String(getArgValue('--shop_region') || 'PH').trim().toUpperCase()
  const targetUrl = buildTrendingUrl(shopRegion)
  const erpBase = String(getArgValue('--erpBase') || DEFAULT_ERP_BASE).replace(/\/$/, '')
  const erpUser = getArgValue('--erpUser') || process.env.LINKEOO_USERNAME || ''
  const erpPass = getArgValue('--erpPass') || process.env.LINKEOO_PASSWORD || ''
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_LAUNCH_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const topN = Number(getArgValue('--topN') || 5)
  const explicitKeyword = getArgValue('--keyword')
  const navTimeoutMs = Number(getArgValue('--nav_timeout_ms') || 120_000)
  const waitMs = Number(getArgValue('--wait_ms') || 6_000)

  const scriptDir = path.dirname(fileURLToPath(import.meta.url))
  const outDir = getArgValue('--out_dir') || path.join(scriptDir, 'debug_reports')
  await mkdir(outDir, { recursive: true })

  logStep(`target URL: ${targetUrl}`)
  logStep(`probe code: ${PROBE_CODE}`)
  const conn = useLaunchApi ? await connectViaLaunchApi(baseUrl, targetUrl) : await connectBrowser(cdpUrl)
  const { browser, page } = conn
  const result = {
    code: PROBE_CODE,
    ok: false,
    targetUrl,
    cdpUrl: conn.cdpUrl || '',
    steps: {},
    errors: [],
  }

  try {
    logStep('navigating trending keywords page')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`waiting ${waitMs}ms for client render`)
    await sleep(waitMs)

    logStep('reading shop_id from page')
    const shopCtx = await readShopIdInPage(page)
    result.steps.shopContext = shopCtx
    logStep(`shop_id candidates: ${JSON.stringify(shopCtx.sources)}`)
    logStep(`primary shop_id: ${shopCtx.primary}, region: ${shopCtx.shopRegion}`)

    logStep('reading first keyword from page')
    const firstKw = await readFirstKeyword(page)
    result.steps.firstKeyword = firstKw
    logStep(`first keyword: ${firstKw.keyword || '(empty)'} (rows=${firstKw.count})`)

    const keyword = String(explicitKeyword || firstKw.keyword || '').trim()
    if (!keyword) {
      throw new Error('未从页面或 --keyword 拿到任何关键词')
    }
    if (!shopCtx.primary) {
      throw new Error('未从页面任一来源读取到 shop_id')
    }

    if (!erpUser || !erpPass) {
      logStep('未提供 --erpUser/--erpPass 或 LINKEOO_USERNAME/LINKEOO_PASSWORD，跳过 ERP 探针部分')
      result.steps.erp = { skipped: true, reason: 'missing credentials' }
    } else {
      const referer = erpBase.includes('127.0.0.1') ? 'http://127.0.0.1:8000/' : `${erpBase}/`
      logStep(`ERP login → ${erpBase}/api/login/`)
      const token = await erpLogin({ base: erpBase, username: erpUser, password: erpPass, referer })
      logStep(`token len=${String(token || '').length}`)

      logStep('ERP GET /api/organization/userinfo/')
      const userInfoResp = await erpRequest({ base: erpBase, token, path: '/api/organization/userinfo/', method: 'GET' })
      const userInfo = Array.isArray(userInfoResp.data) ? userInfoResp.data[0] : userInfoResp.data
      result.steps.userinfoRaw = { ok: userInfoResp.ok, status: userInfoResp.status, keys: userInfo ? Object.keys(userInfo) : [] }
      if (!userInfo) {
        throw new Error(`userinfo 接口返回为空: status=${userInfoResp.status}`)
      }
      const shopList = Array.isArray(userInfo.shop_list) ? userInfo.shop_list : []
      const tiktokShops = shopList.filter((s) => s?.platform === 'Tiktok')
      result.steps.userinfoSummary = {
        username: userInfo.username || null,
        totalShops: shopList.length,
        tiktokShops: tiktokShops.length,
        sampleShopIds: tiktokShops.slice(0, 8).map((s) => ({
          id: s.id,
          shop_id: s.shop_id,
          region: s.region || s.market || '',
          platform: s.platform,
        })),
      }
      logStep(`userinfo totalShops=${shopList.length}, tiktokShops=${tiktokShops.length}`)

      const matched = findShopPkByShopId(userInfo, shopCtx.primary, shopCtx.shopRegion || shopRegion)
      result.steps.shopPkMatch = matched
        ? {
            matchMode: matched.matchMode,
            shopPk: Number(matched.match.id),
            shopId: String(matched.match.shop_id),
            region: String(matched.match.region || matched.match.market || ''),
          }
        : null
      if (!matched) {
        throw new Error(`未在 userinfo.shop_list 找到匹配 shop_id=${shopCtx.primary} 的 TikTok 店铺`)
      }
      const shopPk = Number(matched.match.id)
      logStep(`matched shop_pk=${shopPk} (mode=${matched.matchMode})`)

      logStep(`ERP POST /api/tiktok/product/search_by_keyword/ keyword="${keyword}" topN=${topN}`)
      const searchResp = await erpRequest({
        base: erpBase,
        token,
        path: '/api/tiktok/product/search_by_keyword/',
        method: 'POST',
        body: { shop_pk: shopPk, keyword, top_n: topN },
      })
      result.steps.searchByKeyword = {
        ok: searchResp.ok,
        status: searchResp.status,
        topLevelKeys: searchResp.data ? Object.keys(searchResp.data) : [],
        items: Array.isArray(searchResp.data?.result?.items)
          ? searchResp.data.result.items.slice(0, 5).map((it) => ({
              product_id: it.product_id,
              title: String(it.title || it.description_preview || '').slice(0, 80),
            }))
          : null,
        itemsLength: Array.isArray(searchResp.data?.result?.items) ? searchResp.data.result.items.length : 0,
        rawPreview: searchResp.text ? searchResp.text.slice(0, 400) : '',
      }
      if (!searchResp.ok) {
        throw new Error(`search_by_keyword HTTP ${searchResp.status}: ${searchResp.text.slice(0, 200)}`)
      }
    }

    result.ok = true
    logStep('probe OK')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.errors.push(msg)
    logStep(`probe FAILED: ${msg}`)
  } finally {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const jsonPath = path.join(outDir, `probe_${PROBE_CODE}_${stamp}.json`)
    await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8').catch(() => {})
    result.jsonPath = jsonPath
    logStep(`probe JSON: ${jsonPath}`)
    console.log(JSON.stringify(result, null, 2))
    if (keepOpen) {
      logStep('--keepOpen set, leaving connection open')
      await new Promise(() => {})
    } else {
      await browser.close().catch(() => {})
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

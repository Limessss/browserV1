#!/usr/bin/env node

/**
 * TikTok Shop：Compass 单品卡 → 页面**默认日期**（不改动日期筛选）→ 按「曝光」降序取 Top N（默认 10）→
 * 随机打乱 Top N 列表后依次尝试 → 带货视频 material-2-video：**AI 视频生成器 → 选品 → 生成视频**；
 * 直至累计 **M 次成功**（默认 5）：选品失败（搜不到/勾不中）或生成异常的商品**跳过并从池中多试下一个**，不计入 M。
 *
 * 成对文档：`mcp_tiktok_compass_top10_random5_ai_video.md`；约定见 `../README.md`。
 *
 * 示例：
 *   node playwright_scripts/tiktok_compass_top10_random5_ai_video/tiktok_compass_top10_random5_ai_video.mjs --useLaunchApi --code ICHPPH --shop_region PH
 *   node ... --cdp http://127.0.0.1:19876 --shop_region PH
 *   node ... --useLaunchApi --code ICHPPH --shop_region PH --top_n 10 --pick_n 5
 *   多区域依次执行（JSON 数组或逗号分隔）：
 *   node ... --shop_region '["MY","PH","TH","VN"]'
 *   node ... --shop_region MY,PH,TH,VN
 *
 * 页面内会在底部显示「[脚本] …」短时 Toast（约 3 秒，`pointer-events: none`，尽量不挡操作）。
 * 任务结束时会居中弹出带「确定」的结果 Modal（需点击后脚本才结束等待并关闭浏览器，除非 `--keepOpen`）。
 * 未使用 `--keepOpen` 时，「确定」显示 0:30 倒计时，到点未点则通过 CDP 关闭宿主浏览器。
 *
 * 导航仅等 `domcontentloaded`，不等 `networkidle`；各步骤在**对应可操作元素可见后再等待约 1 秒**执行动作。
 */

import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  closeChromiumWindowHard,
  showPageToast,
  showPageResultModalUntilAck,
} from '../_lib/page_runtime_ui.mjs'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

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

/** 需要操作的元素变为可见后，再等待此时长（毫秒）再执行点击/排序等操作 */
const READY_AFTER_VISIBLE_MS = 1000

/** Compass 单品卡：轮询间隔；直到 `extractTopProductRows` 能解析出至少一行（ID + img[src] + 标题），避免仅 tbody tr 可见但行内未就绪 */
const COMPASS_ROWS_READY_POLL_MS = 350
/** 首次进入页面后，等待表格行数据就绪的上限（排序前；无商品时会占满该时长） */
const COMPASS_PRE_SORT_ROWS_TIMEOUT_MS = 15_000
/** 点击「曝光」排序后，等待表格刷新完毕的上限 */
const COMPASS_POST_SORT_ROWS_TIMEOUT_MS = 75_000

/** AI 额度文案：连续多少次解析结果一致才视为稳定（避免短暂 0/5 闪烁误判） */
const AI_QUOTA_STABLE_NEED = 3
/** AI 额度轮询间隔、最大轮数（约 12s 上限） */
const AI_QUOTA_POLL_INTERVAL_MS = 250
const AI_QUOTA_MAX_POLLS = 48

/**
 * @param {string} a
 * @param {string} b
 */
function regionCodeEq(a, b) {
  return String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase()
}

/**
 * v0.9.3 关键: page.evaluate 包装 — 抗 "Execution context was destroyed" 间歇 race
 *
 * 06-18 / 06-20 batch 跨店 fail, err 字节级相同:
 *   "page.evaluate: Execution context was destroyed, most likely because of a navigation"
 *
 * 根因: TikTok Shop 是 SPA, page.goto / window.location.replace 之后 navigation 状态不稳定;
 *       紧随其后的 page.evaluate 偶尔会撞 destroyed context (Playwright 已知 race)
 *
 * 修法: 3 次 retry on destroyed, 每次 retry 前等 navigation 稳定 (waitForLoadState + 800ms 缓冲)
 *       其他异常 (TypeError, ReferenceError 等) 不重试, 立即抛 (保留原 evaluate 行为)
 *
 * 行为兼容: 3 次 retry 内成功 = 跟原 evaluate 一样 1 次成功 (无副作用);
 *         3 次都 destroyed = 跟原 evaluate 一样抛 destroyed (行为不退化)
 *         不会改变 evaluate 的语义, 只是加 retry 层
 *
 * 替换范围 (devops 06-20 紧急修复):
 *   1. readUrlShopRegionParam (line 96) — 跟 navigation 紧耦合
 *   2. gotoSellerPageRespectingShopRegion line 131 (readUrlShopRegionParam 调用)
 *   3. gotoSellerPageRespectingShopRegion line 154 (window.location.replace 触发的 evaluate)
 *
 * 探针: _temp/devops_probe_evaluate_destroyed.mjs (5+ 轮, 间歇 bug 未 100% 复现, 但 safePageEvaluate 验证 ok)
 */
async function safePageEvaluate(page, fn, argOrOpts = undefined, maybeOpts = {}) {
  const thirdArgIsOpts =
    arguments.length === 3 &&
    argOrOpts &&
    typeof argOrOpts === 'object' &&
    ('maxRetries' in argOrOpts || 'waitBeforeRetry' in argOrOpts)
  const hasEvalArg = arguments.length >= 3 && !thirdArgIsOpts
  const opts = thirdArgIsOpts ? argOrOpts : maybeOpts
  const maxRetries = opts.maxRetries ?? 3
  const waitBeforeRetry = opts.waitBeforeRetry ?? 800
  const lastErr = { message: '' }
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return hasEvalArg ? await page.evaluate(fn, argOrOpts) : await page.evaluate(fn)
    } catch (e) {
      const msg = String(e?.message || e)
      lastErr.message = msg
      const isDestroyed = /Execution context was destroyed|context was destroyed/i.test(msg)
      if (!isDestroyed) {
        throw e  // 非 destroyed 错误立即抛, 不重试
      }
      if (attempt === maxRetries - 1) {
        throw e  // 最后一次仍 destroyed, 抛
      }
      // 等等 navigation 稳定
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
      } catch {
        /* ignore - load state 偶发超时 */
      }
      await new Promise((r) => setTimeout(r, waitBeforeRetry))
    }
  }
  throw new Error(`safePageEvaluate exhausted retries: ${lastErr.message}`)
}

/**
 * 从地址栏 query 读取 `shop_region`（卖家中心部分路由会在 SPA 内改写 URL，以这里为准）。
 * @param {import('playwright').Page} page
 */
async function readUrlShopRegionParam(page) {
  return safePageEvaluate(page, () => {
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

  /** 仅等待 DOM，不等待 networkidle（卖家中心常驻请求会导致长时间阻塞）。后续由各流程等待可操作元素。 */
  const nav = async (url, label) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    steps.push(label)
  }

  if (!want) {
    await nav(pageUrl, 'goto-once')
    const finalUrl = page.url()
    return { finalUrl, urlShopRegion: await readUrlShopRegionParam(page), steps }
  }

  await nav(pageUrl, 'goto-initial')

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

  await safePageEvaluate(page, (u) => {
    window.location.replace(u)
  }, pageUrl)
  await page.waitForLoadState('domcontentloaded', { timeout: 120_000 })
  steps.push('location-replace')
  urlParam = await readUrlShopRegionParam(page)

  if (!regionCodeEq(urlParam, want)) {
    const bust = new URL(pageUrl)
    bust.searchParams.set('shop_region', want)
    bust.searchParams.set('_nc', String(Date.now()))
    await nav(bust.toString(), 'goto-cache-bust')
  }

  urlParam = await readUrlShopRegionParam(page)
  if (!regionCodeEq(urlParam, want)) {
    await nav(pageUrl, 'goto-retry-same')
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

/**
 * `connectOverCDP` 时仅 `browser.close()` 往往只断开 Playwright 与调试端的连接，宿主窗口可能仍在；优先发送 CDP `Browser.close`。
 * @param {import('playwright').Browser | null | undefined} browser
 */
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
  return { browser, page, close: () => closeChromiumWindowHard(browser) }
}

async function connectBrowser({ headed, cdpUrl, launchEdge }) {
  if (cdpUrl) {
    const browser = await chromium.connectOverCDP(cdpUrl)
    const context = browser.contexts()[0] || (await browser.newContext())
    const page = context.pages()[0] || (await context.newPage())
    return { browser, page, close: () => closeChromiumWindowHard(browser) }
  }
  if (launchEdge) {
    const browser = await chromium.launch({ channel: 'msedge', headless: !headed })
    const context = await browser.newContext({ locale: 'zh-CN' })
    const page = await context.newPage()
    return { browser, page, close: () => closeChromiumWindowHard(browser) }
  }
  const browser = await chromium.launch({
    headless: !headed,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL || undefined,
  })
  const context = await browser.newContext({ locale: 'zh-CN' })
  const page = await context.newPage()
  return { browser, page, close: () => closeChromiumWindowHard(browser) }
}

/**
 * Compass / Arco Table：列头内可能出现 `svg.arco-icon-sort_descending` 表示当前为降序。
 * @param {import('playwright').Locator} header
 * @returns {Promise<string | null>} 检测到的策略名，未判定为降序则 null
 */
async function exposureColumnDescendingState(header) {
  const aria = await header.getAttribute('aria-sort').catch(() => null)
  if (aria === 'descending') return 'aria-sort-desc'
  const cls = (await header.getAttribute('class')) || ''
  if (/sort-desc|descend|down/i.test(cls)) return 'class-desc'
  const arcoDesc = header.locator(
    'svg.arco-icon-sort_descending, .arco-icon-sort_descending, [class*="arco-icon-sort_descending"]',
  )
  const cnt = await arcoDesc.count().catch(() => 0)
  if (cnt > 0 && (await arcoDesc.first().isVisible().catch(() => false))) {
    return 'arco-icon-sort-descending'
  }
  return null
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

    let state = await exposureColumnDescendingState(h)
    if (state) {
      return { ok: true, strategy: state, clicks: 0 }
    }

    for (let click = 0; click < 4; click += 1) {
      await h.click({ timeout: 12_000 })
      await sleep(900)
      state = await exposureColumnDescendingState(h)
      if (state) {
        return { ok: true, strategy: state, clicks: click + 1 }
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
  return safePageEvaluate(
    page,
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
        const textId = compact(root.textContent).match(/\bID\s*[:：]\s*(\d{5,24})\b/i)
        if (textId) return textId[1]
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
 * 轮询直到 `extractTopProductRows` 与正式解析使用同一套规则且至少得到 `minRows` 条，避免「tr 已显示但 ID/图/标题未就绪」的竞态。
 * @param {import('playwright').Page} page
 * @param {{ minRows?: number, timeoutMs?: number, pollMs?: number, topN: number }} opts
 * @returns {Promise<{ ok: boolean, lastCount: number }>}
 */
async function waitUntilCompassProductRowsReady(page, opts) {
  const minRows = Math.max(1, opts.minRows ?? 1)
  const timeoutMs = opts.timeoutMs ?? COMPASS_POST_SORT_ROWS_TIMEOUT_MS
  const pollMs = opts.pollMs ?? COMPASS_ROWS_READY_POLL_MS
  const limit = Math.max(opts.topN || 1, minRows)
  const deadline = Date.now() + timeoutMs
  let lastCount = 0
  while (Date.now() < deadline) {
    const rows = await extractTopProductRows(page, limit)
    lastCount = rows.length
    if (rows.length >= minRows) {
      return { ok: true, lastCount }
    }
    await sleep(pollMs)
  }
  return { ok: false, lastCount }
}

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<{ serverError: boolean, noProductText: boolean, dateLabel: string }>}
 */
async function readCompassPageState(page) {
  return safePageEvaluate(page, () => {
    const body = String(document.body?.innerText || '')
    const compact = (s) => String(s || '').replace(/\s+/g, ' ').trim()
    const visible = (el) => {
      if (!(el instanceof HTMLElement)) return false
      const r = el.getBoundingClientRect()
      const s = window.getComputedStyle(el)
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
    }
    const picker = Array.from(document.querySelectorAll('.arco-picker-range')).find(
      (el) => visible(el) && !String(el.className || '').includes('disabled'),
    )
    const dateLabel =
      compact(
        picker?.querySelector('.arco-picker-prefix')?.textContent ||
          picker?.textContent ||
          document.querySelector('.arco-picker-prefix')?.textContent ||
          '',
      ) || ''
    return {
      serverError: /服务器错误|出了点问题|请稍后重试|Server\s*error/i.test(body),
      noProductText: /暂无数据|暂无商品|没有商品|No\s+data|No\s+products/i.test(body),
      dateLabel,
    }
  })
}

/**
 * Compass 默认最近 7 天可能无商品或接口报错；此时切到最近 30 天再取数。
 * @param {import('playwright').Page} page
 */
async function selectCompassLast30Days(page) {
  const quickRangeRe = /最近\s*(?:28|30)\s*天|近\s*(?:28|30)\s*天|过去\s*(?:28|30)\s*天|Last\s*(?:28|30)\s*days/i
  const alreadyLast30 = await readCompassPageState(page).then((s) => /(?:28|30)/.test(s.dateLabel)).catch(() => false)
  if (alreadyLast30) return { ok: true, strategy: 'already-last30' }

  let clickedPicker = false
  const deadline = Date.now() + 30_000
  while (!clickedPicker && Date.now() < deadline) {
    const pickers = page.locator('.arco-picker-range')
    const pickerCount = await pickers.count().catch(() => 0)
    for (let i = 0; i < pickerCount; i += 1) {
      const picker = pickers.nth(i)
      const cls = (await picker.getAttribute('class').catch(() => '')) || ''
      if (/disabled/i.test(cls)) continue
      if (!(await picker.isVisible().catch(() => false))) continue
      await picker.click({ timeout: 10_000 })
      clickedPicker = true
      break
    }
    if (!clickedPicker) await sleep(500)
  }
  if (!clickedPicker) {
    clickedPicker = await safePageEvaluate(page, () => {
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const r = el.getBoundingClientRect()
        const s = window.getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }
      const picker = Array.from(document.querySelectorAll('.arco-picker-range')).find(
        (el) => visible(el) && !String(el.className || '').includes('disabled'),
      )
      if (!(picker instanceof HTMLElement)) return false
      picker.click()
      return true
    }).catch(() => false)
  }
  if (!clickedPicker) {
    throw new Error('未找到可点击的 Compass 日期选择器')
  }
  await sleep(600)

  const preset = page
    .locator('button, [role="button"], li, span, div')
    .filter({ hasText: quickRangeRe })
    .last()

  if ((await preset.count().catch(() => 0)) > 0 && (await preset.isVisible().catch(() => false))) {
    await preset.click({ timeout: 10_000, force: true })
  } else {
    const clicked = await safePageEvaluate(page, () => {
      const re = /最近\s*(?:28|30)\s*天|近\s*(?:28|30)\s*天|过去\s*(?:28|30)\s*天|Last\s*(?:28|30)\s*days/i
      const visible = (el) => {
        if (!(el instanceof HTMLElement)) return false
        const r = el.getBoundingClientRect()
        const s = window.getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], li, span, div'))
        .filter((el) => visible(el) && re.test(el.textContent || ''))
      const target = candidates.at(-1)
      if (!target) return false
      ;(target instanceof HTMLElement ? target : target.closest('button,[role="button"],li,span,div'))?.click()
      return true
    })
    if (!clicked) {
      throw new Error('未找到 Compass 日期快捷项「最近 30 天」')
    }
  }

  await sleep(1000)
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})
  await page
    .waitForFunction(
      () => {
        const visible = (el) => {
          if (!(el instanceof HTMLElement)) return false
          const r = el.getBoundingClientRect()
          const s = window.getComputedStyle(el)
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
        }
        const picker = Array.from(document.querySelectorAll('.arco-picker-range')).find(
          (el) => visible(el) && !String(el.className || '').includes('disabled'),
        )
        return /(?:28|30)/.test(picker?.textContent || '')
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {})
  const afterState = await readCompassPageState(page)
  if (!/(?:28|30)/.test(afterState.dateLabel)) {
    throw new Error(`选择最近 30/28 天后日期仍未切换，当前显示：${afterState.dateLabel || '空'}`)
  }
  return { ok: true, strategy: /28/.test(afterState.dateLabel) ? 'quick-range-last28' : 'quick-range-last30' }
}

/**
 * 单品卡：默认不修改日期；若默认最近 7 天无商品或服务端错误，则切到最近 30 天后重试。
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, shopRegion: string, topN: number }} opts
 */
async function runCompassTopProductsDefaultDate(page, opts) {
  const navMeta = await gotoSellerPageRespectingShopRegion(page, opts.pageUrl, opts.shopRegion)
  await showPageToast(page, `[脚本] Compass 单品卡：页面已打开，正在读取表格…`)

  const tableArea = page.locator('table, [role="grid"], tbody').first()
  await tableArea.waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {})
  await sleep(READY_AFTER_VISIBLE_MS)

  await showPageToast(page, `[脚本] Compass：等待表格行数据（ID/主图/标题）就绪…`)
  let dateFallback = null
  let preSortReady = await waitUntilCompassProductRowsReady(page, {
    topN: opts.topN,
    timeoutMs: COMPASS_PRE_SORT_ROWS_TIMEOUT_MS,
    minRows: 1,
  })

  let pageState = await readCompassPageState(page).catch(() => ({ serverError: false, noProductText: false, dateLabel: '' }))
  if (!preSortReady.ok || pageState.serverError || pageState.noProductText) {
    const reason = pageState.serverError ? 'server_error' : pageState.noProductText ? 'no_product_text' : 'no_rows'
    await showPageToast(page, `[脚本] Compass：默认日期未获取到商品（${reason}），切换到最近 30 天/28 天重试…`)
    dateFallback = {
      reason,
      fromLabel: pageState.dateLabel,
      ...(await selectCompassLast30Days(page)),
    }
    preSortReady = await waitUntilCompassProductRowsReady(page, {
      topN: opts.topN,
      timeoutMs: COMPASS_POST_SORT_ROWS_TIMEOUT_MS,
      minRows: 1,
    })
    pageState = await readCompassPageState(page).catch(() => ({ serverError: false, noProductText: false, dateLabel: '' }))
  }

  const sortMeta = await trySortByExposureUsersDescending(page)

  await showPageToast(page, `[脚本] Compass：排序后等待表格刷新…`)
  const postSortReady = await waitUntilCompassProductRowsReady(page, {
    topN: opts.topN,
    timeoutMs: COMPASS_POST_SORT_ROWS_TIMEOUT_MS,
    minRows: 1,
  })

  const rows = await extractTopProductRows(page, opts.topN)

  const pageDateRange = await safePageEvaluate(page, () => {
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

  await showPageToast(
    page,
    `[脚本] Compass：已解析 ${ranked.length} 个商品（Top ${opts.topN} 范围内）`,
  )

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
    note: dateFallback
      ? '默认日期未取到商品或页面报错，已切换到最近 30 天/28 天后重试。'
      : '未改动页面日期筛选，统计区间为 Compass 默认展示区间。',
    dateFallback,
    preSortReady,
    postSortReady,
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
 * 新版商品选择弹窗的「商品 ID」搜索框不是标准 searchbox，仅按 Enter 偶尔不触发查询。
 * 这里同时派发原生 input/change、Enter，并点击输入框右侧放大镜 suffix。
 * @param {import('playwright').Locator} input
 * @param {string} id
 */
async function triggerProductPickerSearch(input, id) {
  await input.click({ timeout: 10_000 })
  await input.fill(id)
  await input.evaluate((el, value) => {
    const inputEl = /** @type {HTMLInputElement} */ (el)
    const proto = Object.getPrototypeOf(inputEl)
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
    descriptor?.set?.call(inputEl, value)
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
    inputEl.dispatchEvent(new Event('change', { bubbles: true }))
  }, id)
  await input.press('Enter').catch(() => {})
  await sleep(250)

  await input.evaluate((el) => {
    const inputEl = /** @type {HTMLElement} */ (el)
    const wrapper =
      inputEl.closest('.core-input-group-wrapper, .arco-input-group-wrapper, [class*="input-group"]') ||
      inputEl.parentElement
    const suffix = wrapper?.querySelector(
      '.core-input-group-suffix, .arco-input-suffix, [class*="suffix"], svg',
    )
    const target = suffix instanceof HTMLElement ? suffix : suffix?.closest?.('span,button,div')
    if (target instanceof HTMLElement) {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }))
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }))
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    }
  }).catch(() => {})

  const box = await input.boundingBox().catch(() => null)
  if (box) {
    await input.page().mouse.click(box.x + box.width - 10, box.y + box.height / 2).catch(() => {})
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
          await triggerProductPickerSearch(input, id)
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
    .filter({ hasText: /选择一款商品|今日剩余|AI 信用额度|生成视频/ })
}

/**
 * 新版 AI 视频生成器把最终按钮从「生成视频」改成了「确认 (1 点信用额度)」。
 * 保持旧文案兼容，同时避免在商品选择弹窗内误点普通「确认」。
 * @param {import('playwright').Locator} mainDialog
 */
function locatorAiVideoSubmitButton(mainDialog) {
  return mainDialog
    .getByRole('button', {
      name: /生成\s*\d*\s*个视频|生成视频|确认\s*[（(][^）)]*(AI\s*)?信用额度[^）)]*[）)]/i,
    })
    .last()
}

/** AI 信用额度用尽时终止整次任务（主循环识别 `code`） */
const AI_CREDIT_EXHAUSTED = 'AI_CREDIT_EXHAUSTED'

/**
 * 从文本中取所有「今日剩余 X/Y」，以**最后一次出现**为准（避免全文里先出现陈旧段导致误判）。
 * @param {string} raw
 * @returns {{ remaining: number, total: number } | null}
 */
function parseQuotaFromTextLast(raw) {
  const re = /今日剩余\s*(\d+)\s*\/\s*(\d+)/g
  const s = String(raw || '')
  let m
  let last = null
  while ((m = re.exec(s)) !== null) {
    last = { remaining: parseInt(m[1], 10), total: parseInt(m[2], 10) }
  }
  return last
}

/**
 * 在当前 AI 视频生成器 dialog 内读取额度（优先 dialog 内 footer，否则整段 innerText）。
 * @param {import('playwright').Locator} mainDialog
 */
async function sampleAiQuotaOnce(mainDialog) {
  const footer = mainDialog
    .locator('.drawer-footer-left-zGjQyz, [class*="drawer-footer-left"]')
    .first()
  if ((await footer.count().catch(() => 0)) > 0) {
    if (await footer.isVisible().catch(() => false)) {
      const t = await footer.innerText().catch(() => '')
      const q = parseQuotaFromTextLast(t)
      if (q) return q
    }
  }
  const dialogText = await mainDialog.innerText().catch(() => '')
  return parseQuotaFromTextLast(dialogText)
}

/**
 * 打开 AI 视频生成器后检查页脚「今日剩余 X/Y 点 AI 信用额度」；剩余为 0 时抛错停止任务。
 * 仅在当前 AI 对话框内取样；多轮解析至数值稳定后再判断，避免短暂 0/5 或错误首段文案。
 * @param {import('playwright').Page} page
 */
async function assertAiVideoCreditRemaining(page) {
  const mainDialog = locatorAiVideoGeneratorDialog(page)
  await mainDialog.waitFor({ state: 'visible', timeout: 45_000 })

  /** @type {{ remaining: number, total: number } | null} */
  let quota = null
  let stableKey = ''
  let stableCount = 0

  for (let poll = 0; poll < AI_QUOTA_MAX_POLLS; poll += 1) {
    const q = await sampleAiQuotaOnce(mainDialog)
    if (q) {
      const key = `${q.remaining}/${q.total}`
      if (key === stableKey) {
        stableCount += 1
      } else {
        stableKey = key
        stableCount = 1
      }
      quota = q
      if (stableCount >= AI_QUOTA_STABLE_NEED) {
        break
      }
    } else {
      stableKey = ''
      stableCount = 0
    }
    await sleep(AI_QUOTA_POLL_INTERVAL_MS)
  }

  if (!quota) {
    const fallbackRaw = await page.evaluate(() => {
      const el =
        document.querySelector('.drawer-footer-left-zGjQyz') ||
        document.querySelector('[class*="drawer-footer-left"]')
      return el ? el.innerText : ''
    })
    quota = parseQuotaFromTextLast(fallbackRaw)
  }

  /* 仅当「剩余为 0」且已连续稳定采样足够次数时才终止，避免偶发 0 或未加载完误判 */
  if (quota && quota.remaining === 0 && stableCount >= AI_QUOTA_STABLE_NEED) {
    await showPageToast(
      page,
      `[脚本] AI 额度已用尽（今日剩余 ${quota.remaining}/${quota.total}），任务将停止`,
    )
    const err = new Error(
      `${AI_CREDIT_EXHAUSTED}: 今日剩余 ${quota.remaining}/${quota.total} 点 AI 信用额度，停止任务`,
    )
    Object.assign(err, { code: AI_CREDIT_EXHAUSTED })
    throw err
  }
}

/**
 * 带货视频页偶发 Dreamina / Seedance 推广弹窗，会遮挡「AI 视频生成器」按钮。
 * 这里只做关闭/确认，不点击「尝试 AI 视频生成器」，避免改变后续主流程。
 * @param {import('playwright').Page} page
 */
async function dismissMaterialPagePromoDialogs(page) {
  const promoText = /Dreamina|Seedance/i
  let hasPromo = false
  for (let i = 0; i < 20; i += 1) {
    hasPromo = await page
      .locator('body')
      .filter({ hasText: promoText })
      .isVisible({ timeout: 1000 })
      .catch(() => false)
    if (hasPromo) break
    const seedanceRootCount = await page
      .locator('[data-uid^="seedancemodal:"], [class*="modal-LmOKFj"]')
      .count()
      .catch(() => 0)
    if (seedanceRootCount > 0) {
      hasPromo = true
      break
    }
    await sleep(500)
  }
  if (!hasPromo) return { dismissed: false, strategy: 'not-visible' }

  const seedanceGotIt = page
    .locator('[data-uid^="seedancemodal:button"], button')
    .filter({ hasText: /\u6211\u77e5\u9053\u4e86|\u77e5\u9053\u4e86|Got it|I know|OK/i })
    .first()
  if (await seedanceGotIt.isVisible({ timeout: 2000 }).catch(() => false)) {
    await seedanceGotIt.click({ timeout: 8000, force: true })
    await page.waitForTimeout(1200)
    const stillVisible = await page
      .locator('[data-uid^="seedancemodal:"], [class*="modal-LmOKFj"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false)
    if (!stillVisible) return { dismissed: true, strategy: 'seedance-got-it-button' }
  }

  const seedanceClose = page.locator('[data-uid="seedancemodal:iconclose:close"]').first()
  if (await seedanceClose.isVisible({ timeout: 1000 }).catch(() => false)) {
    await seedanceClose.click({ timeout: 8000, force: true })
    await page.waitForTimeout(1200)
    const stillVisible = await page
      .locator('[data-uid^="seedancemodal:"], [class*="modal-LmOKFj"]')
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false)
    if (!stillVisible) return { dismissed: true, strategy: 'seedance-close-icon' }
  }

  const globalGotIt = page.locator('button').filter({
    hasText: /\u6211\u77e5\u9053\u4e86|\u77e5\u9053\u4e86|Got it|I know|OK/i,
  })
  if ((await globalGotIt.count().catch(() => 0)) > 0) {
    const btn = globalGotIt.last()
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ timeout: 8000, force: true })
      await page.waitForTimeout(1200)
      const stillVisible = await page
        .locator('body')
        .filter({ hasText: promoText })
        .isVisible({ timeout: 1000 })
        .catch(() => false)
      if (!stillVisible) return { dismissed: true, strategy: 'global-got-it-button' }
    }
  }

  const domDismissed = await page.evaluate(() => {
    const textRe = /Dreamina|Seedance/i
    const gotItRe = /\u6211\u77e5\u9053\u4e86|\u77e5\u9053\u4e86|Got it|I know|OK/i
    const isVisible = (el) => {
      if (!(el instanceof HTMLElement)) return false
      const rect = el.getBoundingClientRect()
      const style = window.getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }
    const click = (el) => {
      if (!(el instanceof HTMLElement) || !isVisible(el)) return false
      el.click()
      return true
    }
    const roots = Array.from(document.querySelectorAll('body *')).filter(
      (el) => isVisible(el) && textRe.test(el.textContent || ''),
    )
    let root = roots.find((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width >= 300 && rect.height >= 200
    })
    if (!root) root = roots[0]
    if (!root) return false

    let box = root
    for (let i = 0; i < 8 && box.parentElement; i += 1) {
      const rect = box.getBoundingClientRect()
      if (rect.width >= 500 && rect.height >= 300) break
      box = box.parentElement
    }

    const buttons = Array.from(box.querySelectorAll('button,[role="button"]'))
    const gotIt = buttons.find((el) => gotItRe.test(el.textContent || ''))
    if (click(gotIt)) return true

    const closers = Array.from(
      box.querySelectorAll(
        'button[aria-label*="close" i],button[aria-label*="关闭"],[class*="close" i],[class*="Close"],svg',
      ),
    )
    for (const el of closers.reverse()) {
      if (click(el instanceof SVGElement ? el.closest('button,[role="button"],span,div') : el)) return true
    }
    return false
  })
  if (domDismissed) {
    await page.waitForTimeout(1200)
    const stillVisible = await page
      .locator('body')
      .filter({ hasText: promoText })
      .isVisible({ timeout: 1000 })
      .catch(() => false)
    if (!stillVisible) return { dismissed: true, strategy: 'dom-click' }
  }

  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(1200)
  const stillVisible = await page
    .locator('body')
    .filter({ hasText: promoText })
    .isVisible({ timeout: 1000 })
    .catch(() => false)
  return { dismissed: !stillVisible, strategy: 'escape' }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, productId: string, shopRegion: string }} opts
 */
async function runAiVideoFlow(page, opts) {
  const { pageUrl, productId, shopRegion } = opts
  await gotoSellerPageRespectingShopRegion(page, pageUrl, shopRegion)
  await showPageToast(page, `[脚本] 带货视频页已打开 · 商品 ${productId}`)

  const promoDismiss = await dismissMaterialPagePromoDialogs(page)
  if (promoDismiss.dismissed) {
    await showPageToast(page, `[脚本] 已关闭带货视频页弹窗（${promoDismiss.strategy}）`)
  }

  const aiVideoGenBtn = page.getByRole('button', { name: /AI 视频生成器/ })
  await aiVideoGenBtn.waitFor({ state: 'visible', timeout: 90_000 })
  await sleep(READY_AFTER_VISIBLE_MS)
  await aiVideoGenBtn.click()
  await showPageToast(page, `[脚本] 已打开 AI 视频生成器，正在检查额度…`)
  await assertAiVideoCreditRemaining(page)
  await showPageToast(page, `[脚本] 额度可用 · 正在选择商品 ${productId}`)

  const pickProductBtn = page.getByRole('button', { name: '选择商品' })
  await pickProductBtn.waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(READY_AFTER_VISIBLE_MS)
  await pickProductBtn.click()

  const productDialog = locatorProductPickerDialog(page)
  await productDialog.waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(READY_AFTER_VISIBLE_MS)
  await selectProductRow(productDialog, productId)
  await productDialog.getByRole('button', { name: '确认' }).click()

  const mainDialog = locatorAiVideoGeneratorDialog(page)
  await mainDialog.waitFor({ state: 'visible', timeout: 45_000 })
  await sleep(READY_AFTER_VISIBLE_MS)
  await showPageToast(page, `[脚本] 已选品 · 正在点击生成视频`)
  const submitButton = locatorAiVideoSubmitButton(mainDialog)
  await submitButton.waitFor({ state: 'visible', timeout: 30_000 })
  await submitButton.click()

  await mainDialog.getByText('正在生成视频').waitFor({ timeout: 30_000 })
  await showPageToast(page, `[脚本] 正在生成视频（商品 ${productId}）`)
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

/**
 * 解析 `--shop_region`：单区域码、`MY,PH,TH` 逗号分隔、或 JSON 数组字符串 `["MY","PH"]`。
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
    const codes = parsed.map((x) => String(x ?? '').trim()).filter(Boolean)
    if (!codes.length) return ['PH']
    return codes
  }
  if (s.includes(',')) {
    return s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  }
  return [s]
}

/**
 * @returns {{ shopRegions: string[], topN: number, pickN: number }}
 */
function resolveSharedFlowOptions() {
  const shopRegions = parseShopRegions(getArgValue('--shop_region'))
  return {
    shopRegions,
    topN: resolveTopN(),
    pickN: resolvePickN(),
  }
}

/**
 * @param {string} shopRegion
 * @param {{ topN: number, pickN: number }} shared
 */
function buildFlowForShopRegion(shopRegion, shared) {
  const r = String(shopRegion || '').trim()
  return {
    compassUrl: buildCompassUrl(r),
    materialUrl: buildMaterialPageUrl(r),
    shopRegion: r,
    topN: shared.topN,
    pickN: shared.pickN,
  }
}

async function run() {
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const headed = hasFlag('--headed')
  const keepOpen = hasFlag('--keepOpen')
  const showResultModal = hasFlag('--showResultModal') || (!useLaunchApi && !hasFlag('--noResultModal'))
  const failOnPartial = hasFlag('--failOnPartial')
  const cdpUrl =
    getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const launchEdge = hasFlag('--launch-edge') || hasFlag('--msedge')
  const shared = resolveSharedFlowOptions()
  const firstFlow = buildFlowForShopRegion(shared.shopRegions[0], shared)

  let page
  let close
  if (useLaunchApi) {
    const conn = await connectViaLaunchApi(baseUrl, firstFlow.compassUrl)
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

  await openScriptArgsPanel(page, { scriptDir: SCRIPT_DIR })

  try {
    const totalRegions = shared.shopRegions.length
    /** 多区域时收集分项，最后只弹一次汇总 Modal */
    /** @type {Array<{ shopRegion: string, ok: boolean, kind: 'compass' | 'ai', lines: string[] }>} */
    const multiReport = []
    /** @type {Array<Record<string, unknown>>} */
    const regionResults = []

    for (let ri = 0; ri < totalRegions; ri += 1) {
      const flow = buildFlowForShopRegion(shared.shopRegions[ri], shared)
      const multiLabel = totalRegions > 1 ? ` [区域 ${ri + 1}/${totalRegions} · ${flow.shopRegion}]` : ''

      try {
        await showPageToast(page, `[脚本] 开始执行${multiLabel}`)
      } catch {
        /* ignore */
      }

      const compass = await runCompassTopProductsDefaultDate(page, {
        pageUrl: flow.compassUrl,
        shopRegion: flow.shopRegion,
        topN: flow.topN,
      })

      if (!compass.ok || compass.products.length === 0) {
        const compassResult = {
          ok: false,
          phase: 'compass',
          multiRegion: totalRegions > 1 ? { index: ri + 1, total: totalRegions } : undefined,
          shopRegion: flow.shopRegion,
          compass,
        }
        regionResults.push(compassResult)
        await showPageToast(
          page,
          totalRegions > 1
            ? `[脚本] ${flow.shopRegion} · Compass 未取到可用商品，已记入最终汇总`
            : `[脚本] Compass 阶段失败：未解析到可用商品，请查看终端输出`,
        )
        console.log(
          JSON.stringify(
            compassResult,
            null,
            2,
          ),
        )
        process.exitCode = 1
        if (totalRegions > 1) {
          multiReport.push({
            shopRegion: flow.shopRegion,
            ok: false,
            kind: 'compass',
            lines: [
              '阶段：Compass 单品卡',
              `候选商品数：${compass.products.length}`,
              ...(compass.hint ? [`说明：${compass.hint}`] : []),
            ],
          })
        } else if (showResultModal) {
          try {
            await showPageResultModalUntilAck(page, {
              title: 'Compass 阶段失败',
              variant: 'danger',
              lines: [
                '阶段：Compass 单品卡',
                `店铺区域：${flow.shopRegion}`,
                `候选商品数：${compass.products.length}`,
                ...(compass.hint ? [`说明：${compass.hint}`] : []),
                '',
                '终端已输出完整 JSON（phase: compass）。点击「确定」关闭。',
              ],
            })
          } catch {
            /* 页面不可用时仍可依赖终端输出 */
          }
        }
        continue
      }

      /** 随机打乱全部 Compass 候选，依次尝试直到累计 pick_n 次成功（失败则换下一个）。 */
      const candidatePool = pickRandomUnique(compass.products, compass.products.length)

      await showPageToast(
        page,
        `[脚本] 开始 AI 视频阶段${multiLabel}：目标成功 ${flow.pickN} 次，候选 ${candidatePool.length} 个`,
      )

      /** @type {Array<Record<string, unknown>>} */
      const aiVideoRuns = []
      /** @type {Array<Record<string, unknown>>} */
      const aiVideoSkipped = []

      /** @type {string | null} */
      let stopReason = null

      let ci = 0
      while (aiVideoRuns.length < flow.pickN && ci < candidatePool.length) {
        const row = candidatePool[ci]
        ci += 1
        const productId = row.product_id
        await showPageToast(
          page,
          `[脚本]${multiLabel} 第 ${ci}/${candidatePool.length} 个候选 · 已成功 ${aiVideoRuns.length}/${flow.pickN} · ${productId}`,
        )
        try {
          const r = await runAiVideoFlow(page, {
            pageUrl: flow.materialUrl,
            productId,
            shopRegion: flow.shopRegion,
          })
          aiVideoRuns.push({
            index: aiVideoRuns.length + 1,
            productId,
            title: row.title,
            rankInCompass: row.rank,
            imageUrl: row.imageUrl,
            ...r,
          })
        } catch (e) {
          const code =
            e && typeof e === 'object' && 'code' in e
              ? String((/** @type {{ code?: unknown }} */ (e)).code)
              : ''
          const msg = e instanceof Error ? e.message : String(e)
          if (code === AI_CREDIT_EXHAUSTED || msg.includes(AI_CREDIT_EXHAUSTED)) {
            stopReason = 'ai_credit_exhausted'
            aiVideoSkipped.push({
              product_id: productId,
              title: row.title,
              rank: row.rank,
              imageUrl: row.imageUrl,
              error: msg,
            })
            break
          }
          aiVideoSkipped.push({
            product_id: productId,
            title: row.title,
            rank: row.rank,
            imageUrl: row.imageUrl,
            error: msg,
          })
        }
        await sleep(2000)
      }

      const pickedProducts = aiVideoRuns.map((run) => ({
        rank: run.rankInCompass,
        product_id: run.productId,
        title: run.title,
        imageUrl: run.imageUrl,
      }))
      const pickedProductIds = pickedProducts.map((p) => p.product_id)

      const aiVideoComplete = aiVideoRuns.length === flow.pickN
      if (!aiVideoComplete) process.exitCode = 1

      let resultHint = ''
      if (!aiVideoComplete) {
        resultHint =
          stopReason === 'ai_credit_exhausted'
            ? totalRegions > 1 && ri + 1 < totalRegions
              ? '本区域 AI 信用额度已用尽（今日剩余 0/N）；将按配置继续下一店铺区域。'
              : 'AI 信用额度为 0（今日剩余 0/N），本区域任务停止。'
            : aiVideoRuns.length < flow.pickN
              ? flow.pickN > compass.products.length
                ? `--pick_n（${flow.pickN}）大于 Compass 可用商品数（${compass.products.length}），无法凑满成功次数。`
                : `已达 Compass 候选上限仍未凑满 ${flow.pickN} 次成功（详见终端 aiVideoSkipped）。`
              : ''
      }

      const modalTitle = aiVideoComplete
        ? '任务已完成'
        : stopReason === 'ai_credit_exhausted'
          ? '任务已停止（AI 额度用尽）'
          : '任务未完成'
      const modalVariant = aiVideoComplete ? 'success' : 'warning'

      const modalLines = [
        `总体：${aiVideoComplete ? '成功' : '未完成'}`,
        ...(totalRegions > 1 ? [`多区域进度：${ri + 1} / ${totalRegions}`] : []),
        `店铺区域：${flow.shopRegion}`,
        `Compass 候选：${compass.products.length} 个（Top ${flow.topN}）`,
        `AI 视频成功：${aiVideoRuns.length} / ${flow.pickN}`,
        `跳过 / 失败：${aiVideoSkipped.length} 条`,
      ]
      if (stopReason) modalLines.push(`stopReason：${stopReason}`)
      if (resultHint) modalLines.push(`说明：${resultHint}`)
      modalLines.push('')
      modalLines.push(`成功商品 ID：${pickedProductIds.length ? pickedProductIds.join(', ') : '（无）'}`)
      modalLines.push('')
      modalLines.push('终端已输出完整 JSON；点击「确定」后关闭此窗口。')

      const regionResult = {
        ok: aiVideoComplete,
        stopReason,
        shopRegion: flow.shopRegion,
        multiRegion: totalRegions > 1 ? { index: ri + 1, total: totalRegions } : undefined,
        topN: flow.topN,
        pickN: flow.pickN,
        aiVideoSuccessCount: aiVideoRuns.length,
        aiVideoSkippedCount: aiVideoSkipped.length,
        compassCandidateCount: compass.products.length,
        compass,
        pickedProductIds,
        pickedProducts,
        aiVideoRuns,
        aiVideoSkipped,
        ...(aiVideoComplete
          ? {}
          : {
              hint: resultHint,
            }),
      }
      regionResults.push(regionResult)

      console.log(
        JSON.stringify(
          regionResult,
          null,
          2,
        ),
      )

      if (totalRegions > 1) {
        multiReport.push({
          shopRegion: flow.shopRegion,
          ok: aiVideoComplete,
          kind: 'ai',
          lines: [
            `总体：${aiVideoComplete ? '成功' : '未完成'}`,
            `Compass 候选：${compass.products.length} 个（Top ${flow.topN}）`,
            `AI 视频成功：${aiVideoRuns.length} / ${flow.pickN}`,
            `跳过 / 失败：${aiVideoSkipped.length} 条`,
            ...(stopReason ? [`stopReason：${stopReason}`] : []),
            ...(resultHint ? [`说明：${resultHint}`] : []),
            `成功商品 ID：${pickedProductIds.length ? pickedProductIds.join(', ') : '（无）'}`,
          ],
        })
      } else if (showResultModal) {
        try {
          await showPageResultModalUntilAck(page, {
            title: modalTitle,
            variant: modalVariant,
            lines: modalLines,
          })
        } catch {
          /* 页面不可用时仍可依赖终端输出 */
        }
      }

      if (stopReason === 'ai_credit_exhausted' && totalRegions > 1 && ri + 1 < totalRegions) {
        try {
          await showPageToast(
            page,
            `[脚本] ${flow.shopRegion} · AI 额度已用尽，继续下一区域：${shared.shopRegions[ri + 1]}`,
          )
        } catch {
          /* ignore */
        }
      }
    }

    if (multiReport.length > 0) {
      const allOk = multiReport.every((r) => r.ok)
      const finalResult = {
        ok: allOk,
        status: allOk ? 'success' : 'partial',
        folderId: SCRIPT_DIR,
        totalRegions,
        regions: regionResults,
        summary: multiReport.map((r) => ({
          shopRegion: r.shopRegion,
          ok: r.ok,
          kind: r.kind,
          lines: r.lines,
        })),
      }
      console.log(`scriptResult: ${JSON.stringify(finalResult)}`)
      if (useLaunchApi && !failOnPartial) {
        process.exitCode = 0
      }
      if (totalRegions <= 1) {
        return
      }
      /** 本回合至少进入过汇总（Compass 或 AI）的国家 */
      const ranRegionCodes = [...new Set(multiReport.map((r) => r.shopRegion))]
      let summaryTitle = '任务已结束（部分未完成）'
      if (allOk) summaryTitle = '任务已完成'
      const summaryVariant = allOk ? 'success' : 'warning'
      /** @type {string[]} */
      const summaryLines = [
        `配置区域（共 ${totalRegions} 个）：${shared.shopRegions.join('、')}`,
        `本回合已在页面中跑过分项的国家（${ranRegionCodes.length} 个）：${ranRegionCodes.join('、')}`,
        '多区域模式约定：整次任务结束后只弹本窗口一次（不会按国别多次阻塞「确定」）。',
        '某一区域 AI 额度用尽时，脚本会继续尝试下一区域（额度是否按区域独立以平台为准）。',
        '终端已按区域分别输出完整 JSON。',
        '',
        '分项如下：',
        '',
      ]
      for (const r of multiReport) {
        const phaseLabel = r.kind === 'compass' ? 'Compass' : 'AI 视频'
        summaryLines.push(`「${r.shopRegion}」· ${phaseLabel} · ${r.ok ? '已完成' : '未完成'}`)
        summaryLines.push(...r.lines.map((line) => `  ${line}`))
        summaryLines.push('')
      }
      summaryLines.push(showResultModal ? '点击「确定」关闭此窗口。' : '自动化模式不等待结果弹窗。')
      if (!allOk && (!useLaunchApi || failOnPartial)) process.exitCode = 1
      if (showResultModal) {
        try {
          await showPageResultModalUntilAck(page, {
            title: summaryTitle,
            variant: summaryVariant,
            lines: summaryLines,
          })
        } catch {
          /* 页面不可用时仍可依赖终端输出 */
        }
      }
    }

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

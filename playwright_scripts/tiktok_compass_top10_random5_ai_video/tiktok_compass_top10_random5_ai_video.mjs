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
 *
 * 导航仅等 `domcontentloaded`，不等 `networkidle`；各步骤在**对应可操作元素可见后再等待约 1 秒**执行动作。
 */

import { chromium } from 'playwright'

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
 * 从地址栏 query 读取 `shop_region`（卖家中心部分路由会在 SPA 内改写 URL，以这里为准）。
 * @param {import('playwright').Page} page
 */
async function readUrlShopRegionParam(page) {
  return page.evaluate(() => {
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

  await page.evaluate((u) => {
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

/** 页面底部 Toast 展示时长（毫秒） */
const PAGE_TOAST_MS = 3000
const PAGE_TOAST_DOM_ID = 'ant-playwright-top-toast'
const PAGE_MODAL_ROOT_ID = 'ant-playwright-result-modal'

/**
 * 在页面底部显示短时提示，默认 3 秒后移除；`pointer-events: none` 尽量不挡点击。
 * @param {import('playwright').Page} page
 * @param {string} message
 */
async function showPageToast(page, message) {
  const msg = String(message || '').slice(0, 600)
  try {
    await page.evaluate(
      ({ text, ms, rootId }) => {
        const prev = document.getElementById(rootId)
        if (prev) prev.remove()

        const sid = 'ant-playwright-toast-styles'
        if (!document.getElementById(sid)) {
          const st = document.createElement('style')
          st.id = sid
          st.textContent = `
@keyframes ant-pw-toast-in {
  from { opacity: 0; transform: translateY(14px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ant-pw-toast-out {
  from { opacity: 1; transform: translateY(0); }
  to { opacity: 0; transform: translateY(10px); }
}
`
          document.head.appendChild(st)
        }

        const root = document.createElement('div')
        root.id = rootId
        root.setAttribute('data-ant-playwright-toast', '1')
        root.style.cssText = [
          'position:fixed',
          'bottom:0',
          'left:0',
          'right:0',
          'z-index:2147483646',
          'pointer-events:none',
          'display:flex',
          'justify-content:center',
          'align-items:flex-end',
          'padding:0 14px 12px',
          'box-sizing:border-box',
          'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'font-size:13px',
          'line-height:1.5',
        ].join(';')

        const row = document.createElement('div')
        row.style.cssText = [
          'max-width:min(560px,92vw)',
          'display:flex',
          'align-items:stretch',
          'border-radius:14px 14px 0 0',
          'overflow:hidden',
          'box-shadow:0 -10px 36px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.07)',
          'animation:ant-pw-toast-in 0.38s cubic-bezier(.22,1,.36,1) both',
        ].join(';')

        const stripe = document.createElement('div')
        stripe.style.cssText =
          'width:5px;flex-shrink:0;background:linear-gradient(180deg,#2dd4bf,#6366f1);'

        const bar = document.createElement('div')
        bar.style.cssText = [
          'flex:1',
          'background:linear-gradient(145deg,rgba(32,32,40,.98) 0%,rgba(20,20,26,.99) 100%)',
          'color:#f4f4f8',
          'padding:12px 18px',
          'text-align:center',
          'word-break:break-word',
          'font-weight:500',
          'letter-spacing:.02em',
        ].join(';')
        bar.textContent = text

        row.appendChild(stripe)
        row.appendChild(bar)
        root.appendChild(row)
        document.body.appendChild(root)

        window.setTimeout(() => {
          row.style.animation = 'ant-pw-toast-out 0.28s ease forwards'
          window.setTimeout(() => root.remove(), 280)
        }, ms)
      },
      { text: msg, ms: PAGE_TOAST_MS, rootId: PAGE_TOAST_DOM_ID },
    )
  } catch {
    /* 导航中或未就绪时忽略 */
  }
}

/**
 * 任务结束时居中 Modal，展示摘要；需用户点击「确定」后关闭（脚本会等待该点击）。
 * @param {import('playwright').Page} page
 * @param {{ title: string, variant?: 'success' | 'warning' | 'danger', lines: string[] }} opts
 */
async function showPageResultModalUntilAck(page, opts) {
  const title = String(opts.title || '任务结束').slice(0, 200)
  const variant = opts.variant === 'danger' || opts.variant === 'warning' ? opts.variant : 'success'
  const lines = (opts.lines || []).map((s) => String(s).slice(0, 2000))

  await page.evaluate(
    ({ title: t, variant: v, lines: ln, rootId }) => {
      const existing = document.getElementById(rootId)
      if (existing) existing.remove()

      const sid = 'ant-playwright-modal-styles'
      if (!document.getElementById(sid)) {
        const st = document.createElement('style')
        st.id = sid
        st.textContent = `
@keyframes ant-pw-modal-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes ant-pw-modal-panel-in {
  from { opacity: 0; transform: translateY(16px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
`
        document.head.appendChild(st)
      }

      const grad =
        v === 'success'
          ? 'linear-gradient(135deg,#0d9488 0%,#6366f1 55%,#7c3aed 100%)'
          : v === 'warning'
            ? 'linear-gradient(135deg,#d97706 0%,#ea580c 100%)'
            : 'linear-gradient(135deg,#dc2626 0%,#be185d 100%)'

      const backdrop = document.createElement('div')
      backdrop.id = rootId
      backdrop.setAttribute('data-ant-playwright-result-modal', '1')
      backdrop.style.cssText = [
        'position:fixed',
        'inset:0',
        'z-index:2147483647',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'padding:24px 16px',
        'box-sizing:border-box',
        'background:rgba(12,12,18,.52)',
        'backdrop-filter:saturate(1.2) blur(10px)',
        '-webkit-backdrop-filter:saturate(1.2) blur(10px)',
        'animation:ant-pw-modal-in 0.28s ease both',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';')

      const panel = document.createElement('div')
      panel.style.cssText = [
        'width:100%',
        'max-width:440px',
        'max-height:min(72vh,620px)',
        'display:flex',
        'flex-direction:column',
        'border-radius:18px',
        'overflow:hidden',
        'box-shadow:0 24px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)',
        'animation:ant-pw-modal-panel-in 0.4s cubic-bezier(.22,1,.36,1) both',
        'background:#14141a',
      ].join(';')

      const head = document.createElement('div')
      head.style.cssText = [
        'padding:22px 24px 18px',
        'background:' + grad,
        'color:#fff',
      ].join(';')

      const headTitle = document.createElement('div')
      headTitle.style.cssText = 'font-size:18px;font-weight:700;letter-spacing:.03em;line-height:1.35;'
      headTitle.textContent = t
      head.appendChild(headTitle)

      const sub = document.createElement('div')
      sub.style.cssText = 'margin-top:6px;font-size:12px;opacity:.92;font-weight:500;'
      sub.textContent = 'Playwright 脚本执行结果'
      head.appendChild(sub)

      const body = document.createElement('div')
      body.style.cssText = [
        'padding:18px 22px 12px',
        'background:linear-gradient(180deg,#1a1a22 0%,#14141a 40%)',
        'color:#e8e8ef',
        'overflow:auto',
        'flex:1',
        'min-height:0',
      ].join(';')

      const pre = document.createElement('pre')
      pre.style.cssText = [
        'margin:0',
        'white-space:pre-wrap',
        'word-break:break-word',
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        'font-size:12.5px',
        'line-height:1.65',
        'color:#d4d4dc',
      ].join(';')
      pre.textContent = ln.length ? ln.join('\n') : '（无详情）'

      body.appendChild(pre)

      const foot = document.createElement('div')
      foot.style.cssText =
        'padding:14px 22px 20px;background:#14141a;border-top:1px solid rgba(255,255,255,.06);'

      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-ant-playwright-modal-ok', '1')
      btn.textContent = '确定'
      btn.style.cssText = [
        'width:100%',
        'padding:12px 16px',
        'border:none',
        'border-radius:12px',
        'cursor:pointer',
        'font-size:15px',
        'font-weight:600',
        'letter-spacing:.08em',
        'color:#fff',
        'background:linear-gradient(135deg,#6366f1,#7c3aed)',
        'box-shadow:0 8px 24px rgba(99,102,241,.35)',
        'transition:transform .15s ease,filter .15s ease',
      ].join(';')
      btn.onmouseenter = () => {
        btn.style.filter = 'brightness(1.06)'
      }
      btn.onmouseleave = () => {
        btn.style.filter = 'none'
      }
      btn.onclick = () => backdrop.remove()

      foot.appendChild(btn)
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(foot)
      backdrop.appendChild(panel)
      document.body.appendChild(backdrop)
    },
    { title, variant, lines, rootId: PAGE_MODAL_ROOT_ID },
  )

  /* 必须由真实用户点击「确定」关闭；勿用 Playwright .click()，否则会立刻触发按钮等同瞬间关闭 */
  await page.locator(`#${PAGE_MODAL_ROOT_ID}`).waitFor({ state: 'detached', timeout: 0 })
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
 * 单品卡：不修改日期，按曝光降序取前 topN。
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, shopRegion: string, topN: number }} opts
 */
async function runCompassTopProductsDefaultDate(page, opts) {
  const navMeta = await gotoSellerPageRespectingShopRegion(page, opts.pageUrl, opts.shopRegion)
  await showPageToast(page, `[脚本] Compass 单品卡：页面已打开，正在读取表格…`)

  const tableArea = page.locator('table, [role="grid"], tbody').first()
  await tableArea.waitFor({ state: 'visible', timeout: 90_000 }).catch(() => {})
  await sleep(READY_AFTER_VISIBLE_MS)

  const sortMeta = await trySortByExposureUsersDescending(page)

  await page.locator('tbody tr').first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  await sleep(READY_AFTER_VISIBLE_MS)

  const rows = await extractTopProductRows(page, opts.topN)

  const pageDateRange = await page.evaluate(() => {
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
    note: '未改动页面日期筛选，统计区间为 Compass 默认展示区间。',
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
    .filter({ has: page.getByRole('button', { name: /生成视频/ }) })
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
 * @param {import('playwright').Page} page
 * @param {{ pageUrl: string, productId: string, shopRegion: string }} opts
 */
async function runAiVideoFlow(page, opts) {
  const { pageUrl, productId, shopRegion } = opts
  await gotoSellerPageRespectingShopRegion(page, pageUrl, shopRegion)
  await showPageToast(page, `[脚本] 带货视频页已打开 · 商品 ${productId}`)

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
  await mainDialog.getByRole('button', { name: /生成视频/ }).click()

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

  try {
    const totalRegions = shared.shopRegions.length
    /** 多区域时收集分项，最后只弹一次汇总 Modal */
    /** @type {Array<{ shopRegion: string, ok: boolean, kind: 'compass' | 'ai', lines: string[] }>} */
    const multiReport = []

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
        await showPageToast(
          page,
          totalRegions > 1
            ? `[脚本] ${flow.shopRegion} · Compass 未取到可用商品，已记入最终汇总`
            : `[脚本] Compass 阶段失败：未解析到可用商品，请查看终端输出`,
        )
        console.log(
          JSON.stringify(
            {
              ok: false,
              phase: 'compass',
              multiRegion: totalRegions > 1 ? { index: ri + 1, total: totalRegions } : undefined,
              shopRegion: flow.shopRegion,
              compass,
            },
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
        } else {
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

      console.log(
        JSON.stringify(
          {
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
          },
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
      } else {
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

    if (totalRegions > 1 && multiReport.length > 0) {
      const allOk = multiReport.every((r) => r.ok)
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
      summaryLines.push('点击「确定」关闭此窗口。')
      if (!allOk) process.exitCode = 1
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

#!/usr/bin/env node

/**
 * TikTok 自动关键词提报（主流程，v0.3 — 探针 v1/v6/v7/v8 + DOM 提报 + X-Api-Key 鉴权）。
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
 * 用法（dry-run）：
 *   node playwright_scripts/tiktok_auto_keyword_submit/tiktok_auto_keyword_submit.mjs \
 *       --useLaunchApi --code GMNQ5O --shop_region PH --dryRun --limit 3
 *
 * 真实提报（去掉 --dryRun；需在应用「系统设置 → 第三方接口配置」中保存链氪 ERP Key）：
 *   node ... --useLaunchApi --code GMNQ5O --shop_region PH
 */

import { chromium } from 'playwright'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const PAGE_TOAST_DOM_ID = 'ant-playwright-top-toast'
const PAGE_MODAL_ROOT_ID = 'ant-playwright-result-modal'
const PAGE_TOAST_MS = 3000
const PAGE_MODAL_IDLE_BROWSER_CLOSE_MS = 60 * 1000

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
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey, Accept: 'application/json' },
    body: JSON.stringify({ shop_pk: Number(shopPk), keyword: String(keyword || '').trim(), top_n: Number(topN) || 5 }),
  })
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
  const out = { ok: false, steps: [] };

  // 1) 行 click
  const keyword = String(window.__PENDING_KEYWORD__ || '').trim();
  const allRowDivs = Array.from(document.querySelectorAll('div.core-table-tr')).filter(visible);
  const row = allRowDivs.find((d) => compact(d.textContent).includes(keyword));
  if (!row) { out.error = 'row not found for keyword: ' + keyword; return out; }
  row.scrollIntoView({ block: 'center' });
  await sleep(300);
  row.click();
  out.steps.push({ step: 'row-click' });
  await sleep(1500);

  // 2) 点 "绑定现有商品"
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
  const bindBtn = allButtons.find((b) => {
    const t = compact(b.textContent);
    return t === '绑定现有商品' || t.includes('绑定现有商品');
  });
  if (!bindBtn) { out.error = '未找到「绑定现有商品」按钮'; return out; }
  bindBtn.click();
  out.steps.push({ step: 'click-bind' });
  await sleep(2500);

  // 3) 搜索 productId（按下 Enter）
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const searchInput = inputs.find((el) => el.getAttribute('placeholder') === '搜索商品名称');
  if (!searchInput) { out.error = '未找到商品搜索输入框'; return out; }
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
  if (!matchRow) { out.error = '未找到含 productId 的行: ' + productId; return out; }
  let checkbox = matchRow.querySelector('input[type="checkbox"]');
  if (!checkbox) {
    const tdCb = matchRow.querySelector('td.core-table-checkbox, [class*="checkbox"]');
    if (tdCb) checkbox = tdCb.querySelector('input[type="checkbox"]') || tdCb;
  }
  if (checkbox && !checkbox.checked) {
    checkbox.click();
    await sleep(500);
  }
  out.steps.push({ step: 'checkbox-checked', checked: checkbox ? checkbox.checked : false });

  // 5) 点 "下一步"（限定在"商品选择 drawer"范围内——避免点主页面表格的"下一步"）
  const drawerScope = Array.from(document.querySelectorAll('.core-drawer-inner, .core-drawer-content'))
    .filter(visible)
    .map((d) => ({ d, txt: compact(d.textContent || '') }))
    .find(({ txt }) => txt.includes('选择商品') || txt.includes('第 1 步') || txt.includes('第 2 步') || txt.includes('添加关键词'))?.d
    || document;
  const drawerBtns = Array.from(drawerScope.querySelectorAll('button, [role="button"]')).filter(visible);
  const nextBtn = drawerBtns.find((b) => compact(b.textContent) === '下一步' || compact(b.textContent).includes('下一步'));
  if (!nextBtn) { out.error = '未找到「下一步」按钮'; return out; }
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
  return page.evaluate(
    `(() => { window.__PENDING_KEYWORD__ = ${JSON.stringify(leadName)}; return (${DOM_STEP1_JS})(${JSON.stringify(productId)}); })()`,
  )
}

async function domSubmitFromStep2(page) {
  return page.evaluate(`(${DOM_SUBMIT_JS})()`)
}

// ============== page toast / modal ==============
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
@keyframes ant-pw-toast-in { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
@keyframes ant-pw-toast-out { from { opacity: 1; transform: translateY(0); } to { opacity: 0; transform: translateY(10px); } }`
          document.head.appendChild(st)
        }
        const root = document.createElement('div')
        root.id = rootId
        root.style.cssText = [
          'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:2147483646',
          'pointer-events:none', 'display:flex', 'justify-content:center', 'align-items:flex-end',
          'padding:0 14px 12px', 'box-sizing:border-box',
          'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'font-size:13px', 'line-height:1.5',
        ].join(';')
        const row = document.createElement('div')
        row.style.cssText = [
          'max-width:min(560px,92vw)', 'display:flex', 'align-items:stretch',
          'border-radius:14px 14px 0 0', 'overflow:hidden',
          'box-shadow:0 -10px 36px rgba(0,0,0,.42),0 0 0 1px rgba(255,255,255,.07)',
          'animation:ant-pw-toast-in 0.38s cubic-bezier(.22,1,.36,1) both',
        ].join(';')
        const stripe = document.createElement('div')
        stripe.style.cssText = 'width:5px;flex-shrink:0;background:linear-gradient(180deg,#2dd4bf,#6366f1);'
        const bar = document.createElement('div')
        bar.style.cssText = [
          'flex:1', 'background:linear-gradient(145deg,rgba(32,32,40,.98) 0%,rgba(20,20,26,.99) 100%)',
          'color:#f4f4f8', 'padding:12px 18px', 'text-align:center', 'word-break:break-word', 'font-weight:500',
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
  } catch { /* ignore */ }
}

async function showPageResultModalUntilAck(page, opts) {
  const suppressIdleBrowserClose = Boolean(opts.suppressIdleBrowserClose)
  const title = String(opts.title || '任务结束').slice(0, 200)
  const variant = opts.variant === 'danger' || opts.variant === 'warning' ? opts.variant : 'success'
  const lines = (opts.lines || []).map((line) => String(line).slice(0, 2000))
  const idleCountdownMs = suppressIdleBrowserClose ? 0 : PAGE_MODAL_IDLE_BROWSER_CLOSE_MS

  await page.evaluate(
    ({ title: t, variant: v, lines: ln, rootId, idleCountdownMs: idleMs }) => {
      const existing = document.getElementById(rootId)
      if (existing) existing.remove()
      const sid = 'ant-playwright-modal-styles'
      if (!document.getElementById(sid)) {
        const st = document.createElement('style')
        st.id = sid
        st.textContent = `
@keyframes ant-pw-modal-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ant-pw-modal-panel-in { from { opacity: 0; transform: translateY(16px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }`
        document.head.appendChild(st)
      }
      const grad =
        v === 'success' ? 'linear-gradient(135deg,#0d9488 0%,#6366f1 55%,#7c3aed 100%)'
          : v === 'warning' ? 'linear-gradient(135deg,#d97706 0%,#ea580c 100%)'
            : 'linear-gradient(135deg,#dc2626 0%,#be185d 100%)'
      const backdrop = document.createElement('div')
      backdrop.id = rootId
      backdrop.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center', 'padding:24px 16px',
        'box-sizing:border-box', 'background:rgba(12,12,18,.52)',
        'backdrop-filter:saturate(1.2) blur(10px)', '-webkit-backdrop-filter:saturate(1.2) blur(10px)',
        'animation:ant-pw-modal-in 0.28s ease both',
        'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      ].join(';')
      const panel = document.createElement('div')
      panel.style.cssText = [
        'width:100%', 'max-width:440px', 'max-height:min(72vh,620px)', 'display:flex',
        'flex-direction:column', 'border-radius:18px', 'overflow:hidden',
        'box-shadow:0 24px 80px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)',
        'animation:ant-pw-modal-panel-in 0.4s cubic-bezier(.22,1,.36,1) both',
        'background:#14141a',
      ].join(';')
      const head = document.createElement('div')
      head.style.cssText = `padding:22px 24px 18px;background:${grad};color:#fff`
      const headTitle = document.createElement('div')
      headTitle.style.cssText = 'font-size:18px;font-weight:700;line-height:1.35;'
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
        'color:#e8e8ef', 'overflow:auto', 'flex:1', 'min-height:0',
      ].join(';')
      const pre = document.createElement('pre')
      pre.style.cssText = [
        'margin:0', 'white-space:pre-wrap', 'word-break:break-word',
        'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
        'font-size:12.5px', 'line-height:1.65', 'color:#d4d4dc',
      ].join(';')
      pre.textContent = ln.length ? ln.join('\n') : '（无详情）'
      body.appendChild(pre)
      const foot = document.createElement('div')
      foot.style.cssText = 'padding:14px 22px 20px;background:#14141a;border-top:1px solid rgba(255,255,255,.06);'
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('data-ant-playwright-modal-ok', '1')
      btn.textContent = '确定'
      btn.style.cssText = [
        'width:100%', 'padding:12px 16px', 'border:none', 'border-radius:12px',
        'cursor:pointer', 'font-size:15px', 'font-weight:600', 'color:#fff',
        'background:linear-gradient(135deg,#6366f1,#7c3aed)',
        'box-shadow:0 8px 24px rgba(99,102,241,.35)',
      ].join(';')
      const idleNum = Number(idleMs) || 0
      if (idleNum > 0) {
        const pad = (x) => String(x).padStart(2, '0')
        const deadline = Date.now() + idleNum
        let tickTimer = 0
        const updateBtn = () => {
          if (!backdrop.isConnected) return
          const secLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
          if (secLeft <= 0) {
            btn.textContent = '确定'
            if (tickTimer) window.clearInterval(tickTimer)
            tickTimer = 0
            return
          }
          const mm = Math.floor(secLeft / 60)
          const ss = secLeft % 60
          btn.textContent = '确定（' + pad(mm) + ':' + pad(ss) + '）'
        }
        tickTimer = window.setInterval(updateBtn, 250)
        updateBtn()
        btn.onclick = () => {
          if (tickTimer) window.clearInterval(tickTimer)
          backdrop.remove()
        }
      } else {
        btn.onclick = () => backdrop.remove()
      }
      foot.appendChild(btn)
      panel.appendChild(head)
      panel.appendChild(body)
      panel.appendChild(foot)
      backdrop.appendChild(panel)
      document.body.appendChild(backdrop)
    },
    { title, variant, lines, rootId: PAGE_MODAL_ROOT_ID, idleCountdownMs },
  )
  const modalLocator = page.locator(`#${PAGE_MODAL_ROOT_ID}`)
  if (suppressIdleBrowserClose) {
    await modalLocator.waitFor({ state: 'detached', timeout: 0 })
    return
  }
  try {
    await modalLocator.waitFor({ state: 'detached', timeout: PAGE_MODAL_IDLE_BROWSER_CLOSE_MS })
  } catch {
    try {
      const browser = page.context().browser()
      if (browser) {
        const session = await browser.newBrowserCDPSession()
        try { await session.send('Browser.close') } finally { await session.detach().catch(() => {}) }
      } else {
        await page.context().close().catch(() => {})
      }
    } catch { /* ignore */ }
  }
}

// ============== main ==============
function buildReportLines(report) {
  return [
    `目标区域：${report.shopRegion}`,
    `lead/list：total_product_count=${report.totalProductCount}，抓取关键词=${report.allLeads.length}`,
    `本次待提报：${report.limitedLeads.length}`,
    `成功 relate（DOM）：${report.submitSuccess}`,
    `跳过 / 失败：${report.skipped}`,
    `dryRun：${report.dryRun ? '是（未真实提交）' : '否'}`,
    `shop_id：${report.shopId || '（无）'}`,
    `shop_pk：${report.shopPk || '（无）'}`,
    `ERP 凭证来源：${report.erpSource || '（无）'}`,
    '',
    ...(report.errors.length ? ['错误（最多 8 条）：', ...report.errors.slice(0, 8)] : []),
  ]
}

async function run() {
  const shopRegion = String(getArgValue('--shop_region') || 'PH').trim().toUpperCase()
  const targetUrl = buildTrendingUrl(shopRegion)
  const useLaunchApi = hasFlag('--useLaunchApi')
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_LAUNCH_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const dryRun = hasFlag('--dryRun')
  const topN = getNumberArg('--topN', DEFAULT_TOP_N)
  const keywordLimit = getNumberArg('--limit', DEFAULT_KEYWORD_LIMIT)
  const leadPageSize = getNumberArg('--leadPageSize', DEFAULT_LEAD_PAGE_SIZE)
  const navTimeoutMs = Number(getArgValue('--nav_timeout_ms') || 120_000)
  const waitMs = Number(getArgValue('--wait_ms') || 8_000)
  const reportDir = getArgValue('--report_dir') || path.join(path.dirname(fileURLToPath(import.meta.url)), 'reports')
  await mkdir(reportDir, { recursive: true })

  const conn = useLaunchApi ? await connectViaLaunchApi(baseUrl, targetUrl) : await connectBrowser(cdpUrl)
  const { browser, page } = conn
  const report = {
    code: getArgValue('--code') || 'GMNQ5O',
    ok: false,
    shopRegion,
    shopId: '',
    shopPk: null,
    totalProductCount: 0,
    allLeads: [],
    limitedLeads: [],
    dryRun,
    submitSuccess: 0,
    skipped: 0,
    erpSource: '',
    errors: [],
    rows: [],
  }

  try {
    logStep('navigating trending keywords page')
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
    logStep(`domcontentloaded, current URL: ${page.url()}`)
    logStep(`waiting ${waitMs}ms for client render`)
    await sleep(waitMs)

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

    // 1) 解析 ERP 凭证
    const erpCreds = await resolveErpCredentials(baseUrl)
    if (!erpCreds) {
      throw new Error('未找到链氪 ERP 凭证：请在应用「系统设置」保存 Host/API Key，或设置 ERP_API_KEY / --erpKey；Launch 需可读 GET /api/integrations/linkeoo-erp。')
    }
    report.erpSource = process.env.ERP_API_KEY ? 'env' : (getArgValue('--erpKey') ? 'cli' : 'launch-integration')
    logStep(`ERP: base=${erpCreds.baseUrl}, key len=${erpCreds.apiKey.length}, source=${report.erpSource}`)

    // 2) 调 userinfo + 匹配 shop_pk
    const userInfo = await erpGetUserInfo({ base: erpCreds.baseUrl, apiKey: erpCreds.apiKey })
    const matched = findShopPkByShopId(userInfo, shopIdInPage, shopRegion)
    if (!matched) throw new Error(`userinfo.shop_list 找不到 shop_id=${shopIdInPage} 的 TikTok 店铺`)
    const shopPk = Number(matched.match.id)
    report.shopPk = shopPk
    logStep(`matched shop_pk=${shopPk} (mode=${matched.mode})`)

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

    // 4) 限制 + 逐个走 ERP search_by_keyword + DOM 提报
    const limitedLeads = report.allLeads.slice(0, keywordLimit)
    report.limitedLeads = limitedLeads
    logStep(`limited=${limitedLeads.length}, dryRun=${dryRun}`)
    await showPageToast(page, `[脚本] 开始自动关键词提报（${limitedLeads.length} 个，dryRun=${dryRun ? '是' : '否'}）`)

    for (let i = 0; i < limitedLeads.length; i += 1) {
      const lead = limitedLeads[i]
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
        if (dryRun) {
          for (let j = 0; j < items.length; j += 1) {
            const it = items[j]
            const productId = it?.product_id
            if (!productId) continue
            logStep(`  [dryRun] would DOM-submit lead=${lead.lead_id} product=${productId} title="${String(it.title || '').slice(0, 40)}"`)
            row.success += 1
            report.submitSuccess += 1
          }
          row.status = 'dryRun-logged'
          continue
        }
        // 真实 DOM 提报：v17 探针验证的三步流程。
        // 每个 lead 提报 items[0] 一个商品（多商品流程可在下个版本扩展）。
        const firstItem = items.find((it) => it?.product_id)
        // 收集所有有效 productId
        const productIds = items
          .map((it) => it && it.product_id)
          .filter((pid) => pid != null && String(pid).length > 0)
          .map((pid) => String(pid))
        if (!productIds.length) {
          row.status = 'empty-no-product-id'
          report.skipped += 1
          logStep(`  → items 中无 product_id，跳过 lead_name="${lead.lead_name}"`)
          continue
        }
        logStep(`  → ${productIds.length} 个商品将独立提报（每个重新打开 drawer）`)

        // 对每个 productId 独立完整跑"行 click → 绑定 → 搜索 → 下一步 → 提交"
        // （v22 探针证实：单 drawer 多商品循环 search 会覆盖前一个；v17 探针证实：单商品单提报真实成功）
        let submittedCount = 0
        for (let p = 0; p < productIds.length; p += 1) {
          const productId = productIds[p]
          const item = items.find((it) => String(it?.product_id) === productId)
          const title = String(item?.title || item?.description_preview || '').trim()
          if (dryRun) {
            logStep(`  [dryRun] would DOM-submit lead=${lead.lead_id} product=${productId} title="${title.slice(0, 40)}"`)
            submittedCount += 1
            report.submitSuccess += 1
            continue
          }
          try {
            const step1 = await domStep1SingleProduct(page, lead.lead_name, productId)
            if (!step1?.ok) {
              logStep(`  ⚠️ DOM 第 1 步失败 lead=${lead.lead_id} product=${productId} (${step1?.error})，跳过本商品继续下一个`)
              continue
            }
            const submitRes = await domSubmitFromStep2(page)
            if (!submitRes?.ok) {
              logStep(`  ⚠️ 提交失败 lead=${lead.lead_id} product=${productId}: ${submitRes?.error || 'unknown'}`)
              continue
            }
            logStep(`  ✓ 提报成功 lead=${lead.lead_id} product=${productId} title="${title.slice(0, 30)}"`)
            submittedCount += 1
            report.submitSuccess += 1
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            logStep(`  ⚠️ 异常 lead=${lead.lead_id} product=${productId}: ${msg}`)
            continue
          }
        }
        if (submittedCount === 0) {
          row.status = 'all-products-failed'
        } else {
          row.status = 'submitted'
        }
        row.success = submittedCount
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        row.error = msg
        row.status = 'failed'
        report.skipped += 1
        report.errors.push(`${lead.lead_name}: ${msg}`)
        logStep(`  × failed lead_name="${lead.lead_name}": ${msg}`)
      } finally {
        report.rows.push(row)
        // 真实提报后：页面可能被导航 / 虚拟滚动状态被破坏。强制重新加载 trending_keywords
        //  让下一条 lead 在新页面里能找到行。dryRun 不需要（不真实提报）
        if (!dryRun && i + 1 < limitedLeads.length) {
          logStep(`  → 重新加载 trending_keywords 准备下一条 lead (${i + 2}/${limitedLeads.length})`)
          try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs })
            await sleep(waitMs)
          } catch (e) {
            logStep(`  → 重新加载失败: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
      }
    }

    report.ok = report.errors.length === 0
    logStep(`done: submitSuccess=${report.submitSuccess}, skipped=${report.skipped}`)

    const reportPath = path.join(
      reportDir,
      `tiktok_auto_keyword_submit_${report.code}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
    )
    await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8').catch(() => {})
    logStep(`report: ${reportPath}`)
    console.log(JSON.stringify(report, null, 2))

    await showPageResultModalUntilAck(page, {
      title: report.ok ? '任务已完成' : '任务已结束（部分失败）',
      variant: report.errors.length ? (dryRun ? 'warning' : 'danger') : 'success',
      suppressIdleBrowserClose: keepOpen,
      lines: buildReportLines(report),
    })
    if (keepOpen) await new Promise(() => {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    report.errors.push(msg)
    process.exitCode = 1
    logStep(`FATAL: ${msg}`)
    console.log(JSON.stringify(report, null, 2))
    try {
      await showPageResultModalUntilAck(page, {
        title: '任务异常结束',
        variant: 'danger',
        suppressIdleBrowserClose: keepOpen,
        lines: buildReportLines(report),
      })
    } catch { /* ignore */ }
    if (keepOpen) await new Promise(() => {})
  } finally {
    if (!keepOpen) await browser.close().catch(() => {})
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

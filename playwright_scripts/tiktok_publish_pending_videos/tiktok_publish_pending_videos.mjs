#!/usr/bin/env node

import { chromium } from 'playwright'

const MATERIAL_PAGE_PATH = '/shoppable-videos/material-2-video'
const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const PRODUCT_NAME_BY_REGION = {
  ID: 'Produk dalam video',
  MY: 'Produk dalam video',
  PH: 'Product in the video',
  SG: 'Product in the video',
  TH: 'สินค้าในวิดีโอ',
  VN: 'Sản phẩm trong video',
}

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

const PAGE_TOAST_MS = 3000
const PAGE_TOAST_DOM_ID = 'ant-playwright-top-toast'
const PAGE_MODAL_ROOT_ID = 'ant-playwright-result-modal'

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
        stripe.style.cssText = 'width:5px;flex-shrink:0;background:linear-gradient(180deg,#2dd4bf,#6366f1);'

        const bar = document.createElement('div')
        bar.style.cssText = [
          'flex:1',
          'background:linear-gradient(145deg,rgba(32,32,40,.98) 0%,rgba(20,20,26,.99) 100%)',
          'color:#f4f4f8',
          'padding:12px 18px',
          'text-align:center',
          'word-break:break-word',
          'font-weight:500',
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
    /* ignore page navigation races */
  }
}

async function showPageResultModalUntilAck(page, opts) {
  const title = String(opts.title || '任务结束').slice(0, 200)
  const variant = opts.variant === 'danger' || opts.variant === 'warning' ? opts.variant : 'success'
  const lines = (opts.lines || []).map((line) => String(line).slice(0, 2000))

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
      foot.style.cssText = 'padding:14px 22px 20px;background:#14141a;border-top:1px solid rgba(255,255,255,.06);'

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
        'color:#fff',
        'background:linear-gradient(135deg,#6366f1,#7c3aed)',
        'box-shadow:0 8px 24px rgba(99,102,241,.35)',
      ].join(';')
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

  await page.locator(`#${PAGE_MODAL_ROOT_ID}`).waitFor({ state: 'detached', timeout: 0 })
}

function buildMaterialPageUrl(shopRegion) {
  const u = new URL(MATERIAL_PAGE_PATH, 'https://seller.tiktokshopglobalselling.com')
  u.searchParams.set('from', 'tab')
  const region = String(shopRegion || '').trim()
  if (region) u.searchParams.set('shop_region', region)
  return u.toString()
}

function getFallbackProductName(shopRegion) {
  const region = String(shopRegion || '').trim().toUpperCase()
  return PRODUCT_NAME_BY_REGION[region] || 'Product in the video'
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

function getPendingKey(row, pageNumber) {
  return `${pageNumber}:${row.index}:${row.id}:${row.published}/${row.publishTotal}`
}

async function clickPageNumber(page, pageNumber) {
  const pagerItem = page
    .locator('li.theme-arco-pagination-item')
    .filter({ hasText: new RegExp(`^\\s*${pageNumber}\\s*$`) })
  const previousSignature = await getRowsSignature(page)
  await pagerItem.first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  if (!(await pagerItem.count().catch(() => 0))) return false
  await pagerItem.first().click()
  await waitForDataRows(page, previousSignature)
  return true
}

async function getRowsSignature(page) {
  return page
    .evaluate(() =>
      Array.from(document.querySelectorAll('table tbody tr'))
        .map((row) => (row.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((text) => /ID:\s*\d+/.test(text))
        .join('\n---\n'),
    )
    .catch(() => '')
}

async function waitForDataRows(page, previousSignature = '') {
  await page.locator('table tbody tr').first().waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction(
    (prev) => {
      const signature = Array.from(document.querySelectorAll('table tbody tr'))
        .map((row) => (row.textContent || '').replace(/\s+/g, ' ').trim())
        .filter((text) => /ID:\s*\d+/.test(text))
        .join('\n---\n')
      return Boolean(signature) && (!prev || signature !== prev)
    },
    previousSignature,
    { timeout: 60000, polling: 500 },
  )
}

async function gotoList(page, pageUrl, pageNumber = 1) {
  await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await waitForDataRows(page)
  if (pageNumber > 1 && !(await clickPageNumber(page, pageNumber))) {
    throw new Error(`无法切换到第 ${pageNumber} 页`)
  }
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

async function ensureProductNameFilled(page, shopRegion) {
  const fallbackName = getFallbackProductName(shopRegion)
  await page.getByText('商品名称').last().scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {})
  const result = await page
    .waitForFunction(
      (name) => {
        const readValue = (field) =>
          field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
            ? field.value
            : field.textContent || ''
        const primary = document.querySelector('#product_name_input')
        if (primary instanceof HTMLElement && readValue(primary).trim()) {
          return { ok: true, filled: false, value: readValue(primary).trim(), source: 'auto' }
        }
        return false
      },
      fallbackName,
      { timeout: 20000, polling: 500 },
    )
    .then((handle) => handle.jsonValue())
    .catch(() => null)
  if (result?.ok) return

  const fillResult = await page.evaluate((name) => {
    const normalize = (text) => String(text || '').replace(/\s+/g, '').trim()
    const findEditable = (root) =>
      root?.querySelector?.('input:not([disabled]), textarea:not([disabled]), [contenteditable="true"]') || null
    const readValue = (field) =>
      field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : field.textContent || ''
    const writeValue = (field, value) => {
      field.focus()
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
        const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
        if (descriptor?.set) descriptor.set.call(field, value)
        else field.value = value
      } else {
        field.textContent = value
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      field.dispatchEvent(new Event('change', { bubbles: true }))
      field.blur()
    }
    const fillIfEmpty = (field) => {
      const current = readValue(field).trim()
      if (current) return { ok: true, filled: false, value: current }
      writeValue(field, name)
      return { ok: true, filled: true, value: name }
    }

    const primary = document.querySelector('#product_name_input')
    if (primary instanceof HTMLElement) return fillIfEmpty(primary)

    const labels = Array.from(document.querySelectorAll('label, div, span, p')).filter((el) =>
      normalize(el.textContent).includes('商品名称'),
    )
    const label = labels.at(-1)
    if (label) {
      let root = label
      for (let depth = 0; root && depth < 8; depth += 1) {
        const field = findEditable(root)
        if (field instanceof HTMLElement) return fillIfEmpty(field)
        root = root.parentElement
      }

      const siblingField = findEditable(label.parentElement?.nextElementSibling)
      if (siblingField instanceof HTMLElement) return fillIfEmpty(siblingField)
    }

    const fallbackFields = Array.from(
      document.querySelectorAll('input:not([disabled]), textarea:not([disabled]), [contenteditable="true"]'),
    ).filter((field) => {
      if (!(field instanceof HTMLElement)) return false
      const rect = field.getBoundingClientRect()
      const current = readValue(field).trim()
      const placeholder = field.getAttribute('placeholder') || ''
      const className = String(field.className || '')
      return (
        !current &&
        !placeholder &&
        rect.width >= 160 &&
        rect.height >= 20 &&
        rect.bottom > 0 &&
        rect.top < window.innerHeight &&
        /content-arco-input|core-input|input/.test(className)
      )
    })
    const fallbackField = fallbackFields.at(0)
    if (fallbackField instanceof HTMLElement) return fillIfEmpty(fallbackField)
    return { ok: false, reason: 'field-not-found' }
  }, fallbackName)
  await sleep(800)
  if (!fillResult.ok) throw new Error(`未找到商品名称输入框: ${JSON.stringify(fillResult)}`)
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

async function clickFinalPublishWhenReady(page, rowInfo, shopRegion) {
  await waitProductCardLoaded(page, rowInfo.id)
  await ensureProductNameFilled(page, shopRegion)
  await ensureAiGeneratedContentEnabled(page)
  for (let i = 0; i < 3; i += 1) {
    await page.getByRole('button', { name: '在 TikTok 上发布' }).last().click()
    await sleep(1500)
    if (await closeAddProductDialogIfPresent(page)) {
      await waitProductCardLoaded(page, rowInfo.id)
      await ensureProductNameFilled(page, shopRegion)
      await ensureAiGeneratedContentEnabled(page)
      continue
    }
    return
  }
  throw new Error(`商品仍未被发布表单识别: ${rowInfo.id}`)
}

async function publishOneFromRow(page, rowInfo, shopRegion) {
  const row = page.locator('table tbody tr').nth(rowInfo.index)
  await row.waitFor({ state: 'visible', timeout: 30000 })
  const rowText = await row.innerText().catch(() => '')
  if (!rowText.includes(rowInfo.id)) {
    throw new Error(`表格行定位失败，期望第 ${rowInfo.index + 1} 行包含 ID ${rowInfo.id}`)
  }
  await row.getByRole('button', { name: '查看' }).click()
  await page.getByText('你的视频已准备就绪').waitFor({ state: 'visible', timeout: 30000 })
  await sleep(1000)
  await page.getByRole('button', { name: '在 TikTok 上发布' }).last().click()
  await page.locator('text=TikTok 账号详情').waitFor({ state: 'visible', timeout: 30000 })
  await sleep(1500)
  await clickFinalPublishWhenReady(page, rowInfo, shopRegion)
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
  const skipped = []
  const skippedKeys = new Set()
  let currentPage = 1

  try {
    await gotoList(page, pageUrl, currentPage)
    await showPageToast(page, `[脚本] 开始发布待发布视频：区域 ${shopRegion}，目标成功 ${maxPublishes} 个`)
    for (let guard = 0; log.length < maxPublishes && guard < maxPublishes * 10; guard += 1) {
      let rows = await readRows(page)
      let pending = rows.find((row) => isPending(row) && !skippedKeys.has(getPendingKey(row, currentPage)))
      while (!pending && currentPage < maxPages) {
        currentPage += 1
        if (!(await clickPageNumber(page, currentPage))) break
        rows = await readRows(page)
        pending = rows.find((row) => isPending(row) && !skippedKeys.has(getPendingKey(row, currentPage)))
      }
      if (!pending) break
      console.log(`[publish] page=${currentPage} id=${pending.id} ${pending.published}/${pending.publishTotal}`)
      await showPageToast(
        page,
        `[脚本] 发布中：第 ${log.length + 1}/${maxPublishes} 个 · 第 ${currentPage} 页 · ${pending.id} · ${pending.published}/${pending.publishTotal}`,
      )
      try {
        await publishOneFromRow(page, pending, shopRegion)
        log.push({ page: currentPage, id: pending.id, before: `${pending.published}/${pending.publishTotal}` })
        await showPageToast(page, `[脚本] 发布成功：${pending.id}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const skipRecord = {
          page: currentPage,
          index: pending.index,
          id: pending.id,
          before: `${pending.published}/${pending.publishTotal}`,
          error: message,
        }
        skipped.push(skipRecord)
        skippedKeys.add(getPendingKey(pending, currentPage))
        console.error(`[skip] page=${currentPage} id=${pending.id} ${skipRecord.before} ${message}`)
        await showPageToast(page, `[脚本] 已跳过异常视频：${pending.id}，继续下一个`)
      }
      await gotoList(page, pageUrl, currentPage)
    }
    const result = { publishedCount: log.length, skippedCount: skipped.length, log, skipped }
    console.log(JSON.stringify(result, null, 2))
    await showPageResultModalUntilAck(page, {
      title: log.length >= maxPublishes ? '任务已完成' : '任务结束',
      variant: skipped.length ? 'warning' : 'success',
      lines: [
        `店铺区域：${shopRegion}`,
        `成功发布：${log.length} / ${maxPublishes}`,
        `跳过 / 失败：${skipped.length}`,
        '',
        `成功 ID：${log.length ? log.map((item) => item.id).join(', ') : '（无）'}`,
        ...(skipped.length
          ? [
              '',
              '跳过项：',
              ...skipped.map((item) => `第 ${item.page} 页 ${item.id} ${item.before}：${item.error}`),
            ]
          : []),
        '',
        '终端已输出完整 JSON；点击「确定」后关闭此窗口。',
      ],
    })
    if (keepOpen) await new Promise(() => {})
  } finally {
    if (!keepOpen) await browser.close()
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

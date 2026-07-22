#!/usr/bin/env node

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

/**
 * 解析 `--shop_region`：单码、`MY,PH,TH` 逗号分隔、或 JSON 数组 `["MY","PH"]`；空则默认 MY。
 * @param {string} raw getArgValue('--shop_region')
 * @returns {string[]}
 */
function parseShopRegions(raw) {
  const s = String(raw || '').trim()
  if (!s) return ['MY']
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
    if (!codes.length) return ['MY']
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `connectOverCDP` 时仅 `browser.close()` 往往只断开 Playwright 与调试端的连接，宿主窗口可能仍在；优先发送 CDP `Browser.close`。
 * @param {import('playwright').Browser | null | undefined} browser
 */
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
  return { browser, page, close: () => closeChromiumWindowHard(browser) }
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

async function waitPublishFormReady(page) {
  await page.waitForFunction(
    () => {
      const bodyText = document.body?.innerText || ''
      const hasFormSections =
        bodyText.includes('\u53d1\u5e03\u8d26\u53f7') &&
        bodyText.includes('\u89c6\u9891\u8be6\u60c5') &&
        bodyText.includes('\u5546\u54c1') &&
        bodyText.includes('\u53d1\u5e03\u504f\u597d')
      const hasPublishButton = Array.from(document.querySelectorAll('button,[role="button"]')).some((el) =>
        (el.textContent || '').replace(/\s+/g, ' ').trim().includes('\u5728 TikTok \u4e0a\u53d1\u5e03'),
      )
      return hasFormSections && hasPublishButton
    },
    null,
    { timeout: 45000, polling: 500 },
  )
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
  await waitPublishFormReady(page)
  await sleep(1500)
  await clickFinalPublishWhenReady(page, rowInfo, shopRegion)
  await page.getByText('你的视频发布成功').waitFor({ state: 'visible', timeout: 90000 })
  await sleep(3000)
}

function buildRegionResultLines(report) {
  return [
    `店铺区域：${report.shopRegion}`,
    `成功发布：${report.publishedCount} / ${report.maxPublishes}`,
    `跳过 / 失败：${report.skippedCount}`,
    ...(report.error ? [`异常：${report.error}`] : []),
    '',
    `成功 ID：${report.log.length ? report.log.map((item) => item.id).join(', ') : '（无）'}`,
    ...(report.skipped.length
      ? [
          '',
          '跳过项：',
          ...report.skipped.map((item) => `第 ${item.page} 页 ${item.id} ${item.before}：${item.error}`),
        ]
      : []),
  ]
}

async function run() {
  const shopRegions = parseShopRegions(getArgValue('--shop_region'))
  const firstPageUrl = buildMaterialPageUrl(shopRegions[0])
  const maxPublishes = getNumberArg('--max', 200)
  const maxPages = getNumberArg('--pages', 5)
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const cdpUrl = getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''
  const keepOpen = hasFlag('--keepOpen')
  const useLaunchApi = hasFlag('--useLaunchApi')
  const showResultModal = hasFlag('--showResultModal') || (!useLaunchApi && !hasFlag('--noResultModal'))
  const totalRegions = shopRegions.length
  const conn = useLaunchApi
    ? await connectViaLaunchApi(baseUrl, firstPageUrl)
    : await connectOverCdp(cdpUrl || 'http://127.0.0.1:19876')
  const { page, close } = conn
  await openScriptArgsPanel(page, { scriptDir: SCRIPT_DIR })

  try {
    const multiReport = []

    for (let ri = 0; ri < totalRegions; ri += 1) {
      const shopRegion = shopRegions[ri]
      const pageUrl = buildMaterialPageUrl(shopRegion)
      const log = []
      const skipped = []
      const skippedKeys = new Set()
      let currentPage = 1
      const multiLabel = totalRegions > 1 ? ` [区域 ${ri + 1}/${totalRegions}]` : ''

      try {
        await gotoList(page, pageUrl, currentPage)
        await showPageToast(page, `[脚本] 开始发布待发布视频${multiLabel}：区域 ${shopRegion}，目标成功 ${maxPublishes} 个`)
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
          console.log(`[publish] shop_region=${shopRegion} page=${currentPage} id=${pending.id} ${pending.published}/${pending.publishTotal}`)
          await showPageToast(
            page,
            `[脚本]${multiLabel} 发布中：第 ${log.length + 1}/${maxPublishes} 个 · 第 ${currentPage} 页 · ${pending.id} · ${pending.published}/${pending.publishTotal}`,
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
            console.error(`[skip] shop_region=${shopRegion} page=${currentPage} id=${pending.id} ${skipRecord.before} ${message}`)
            await showPageToast(page, `[脚本] 已跳过异常视频：${pending.id}，继续下一个`)
          }
          await gotoList(page, pageUrl, currentPage)
        }

        const report = {
          ok: log.length >= maxPublishes,
          shopRegion,
          publishedCount: log.length,
          skippedCount: skipped.length,
          maxPublishes,
          log,
          skipped,
          ...(totalRegions > 1 ? { multiRegion: { index: ri + 1, total: totalRegions } } : {}),
        }
        console.log(JSON.stringify(report, null, 2))
        if (totalRegions > 1) {
          multiReport.push(report)
        } else {
          console.log(`scriptResult: ${JSON.stringify({ ...report, status: report.ok ? 'success' : 'failed', folderId: SCRIPT_DIR })}`)
        }
        if (totalRegions === 1 && showResultModal) {
          await showPageResultModalUntilAck(page, {
            title: report.ok ? '任务已完成' : '任务结束',
            variant: skipped.length ? 'warning' : 'success',
            lines: buildRegionResultLines(report),
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const report = {
          ok: false,
          shopRegion,
          publishedCount: log.length,
          skippedCount: skipped.length,
          maxPublishes,
          log,
          skipped,
          error: message,
          ...(totalRegions > 1 ? { multiRegion: { index: ri + 1, total: totalRegions } } : {}),
        }
        process.exitCode = 1
        console.error(`[region-error] shop_region=${shopRegion} ${message}`)
        console.log(JSON.stringify(report, null, 2))
        if (totalRegions > 1) {
          multiReport.push(report)
          if (ri + 1 < totalRegions) {
            await showPageToast(page, `[脚本] 区域 ${shopRegion} 异常，继续下一区域：${shopRegions[ri + 1]}`)
          }
        } else {
          console.log(`scriptResult: ${JSON.stringify({ ...report, status: 'failed', folderId: SCRIPT_DIR })}`)
        }
        if (totalRegions === 1 && showResultModal) {
          await showPageResultModalUntilAck(page, {
            title: '任务异常结束',
            variant: 'danger',
            lines: buildRegionResultLines(report),
          })
        }
      }
    }

    if (totalRegions > 1 && multiReport.length > 0) {
      const allOk = multiReport.every((report) => report.ok)
      const hasSkipped = multiReport.some((report) => report.skippedCount > 0)
      const summaryLines = [
        `配置区域（共 ${totalRegions} 个）：${shopRegions.join('、')}`,
        `已执行区域：${multiReport.map((report) => report.shopRegion).join('、')}`,
        '多区域模式：所有区域执行完成后仅弹出本汇总窗口一次。',
        '某一区域异常时已记入汇总，并继续尝试下一区域。',
        '',
        '分项如下：',
        '',
      ]
      for (const report of multiReport) {
        summaryLines.push(`「${report.shopRegion}」· ${report.ok ? '已完成' : '未完成'}`)
        summaryLines.push(...buildRegionResultLines(report).map((line) => (line ? `  ${line}` : line)))
        summaryLines.push('')
      }
      if (!allOk) process.exitCode = 1
      console.log(`scriptResult: ${JSON.stringify({ ok: allOk, status: allOk ? 'success' : 'failed', folderId: SCRIPT_DIR, shopRegions, reports: multiReport })}`)
      if (showResultModal) {
        await showPageResultModalUntilAck(page, {
        title: allOk ? '任务已完成' : '任务已结束（部分未完成）',
        variant: allOk && !hasSkipped ? 'success' : 'warning',
        lines: summaryLines,
        })
      }
    }
    if (keepOpen) await new Promise(() => {})
  } finally {
    if (!keepOpen && close) await close()
  }
}

run().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

#!/usr/bin/env node

import { chromium } from 'playwright'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { logProgress, showPageResultModalUntilAck } from '../_lib/page_runtime_ui.mjs'
import { openScriptArgsPanel } from '../_lib/script_args_panel.mjs'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

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

function isRuntimeExpired(options) {
  return Boolean(options.deadlineAtMs && Date.now() >= options.deadlineAtMs)
}

function parseShopRegions(raw) {
  const s = String(raw || '').trim()
  if (!s) return ['MY']

  if (s.startsWith('[')) {
    let parsed
    try {
      parsed = JSON.parse(s)
    } catch {
      const looseCodes = s
        .slice(1, s.endsWith(']') ? -1 : undefined)
        .split(',')
        .map((x) => x.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      if (looseCodes.length) return looseCodes
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



function formatStopReasonChinese(stopReason) {
  const reason = String(stopReason || '').trim()
  if (!reason) return '（未记录）'
  if (reason === 'max_runtime_ms_reached') return '已达最长运行时间上限'
  if (reason === 'no_more_products') return '无可更新商品'
  if (reason === 'no_update_button_found') return '未找到「更新 N 件商品」按钮'
  if (reason === 'update_button_error') return '更新按钮点击异常'
  if (reason === 'batch_optimize_button_not_found_after_rounds') return '多轮后仍未找到「批量优化」按钮'
  if (reason === 'no_updates_after_reopen') return '重新打开页面后无可更新商品'
  const maxBatches = reason.match(/^max_update_batches_reached_(\d+)$/)
  if (maxBatches) return `已达最大更新批次数（${maxBatches[1]}）`
  const maxRounds = reason.match(/^max_optimize_rounds_reached_(\d+)$/)
  if (maxRounds) return `已达最大优化轮数（${maxRounds[1]}）`
  return reason
}

function buildRegionResultLines(result) {
  const batchTexts = (result.updateBatches || [])
    .map((batch) => `第 ${batch.roundIndex || '?'} 轮 · 第 ${batch.batchIndex} 批 · ${batch.text || '（无文案）'}`)
    .slice(0, 12)
  return [
    `店铺区域：${result.shopRegion}`,
    `执行结果：${result.ok ? '成功' : '未完成'}`,
    `优化轮数：${(result.optimizeRounds || []).length}`,
    `更新批次数：${(result.updateBatches || []).length}`,
    `累计商品数：${result.totalProductCount || 0}`,
    `结束原因：${formatStopReasonChinese(result.stopReason)}`,
    ...(result.error ? [`异常：${result.error}`] : []),
    ...(batchTexts.length
      ? ['', '批次明细（最多展示 12 条）：', ...batchTexts]
      : ['', '批次明细：（无）']),
  ]
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

async function clickUpdateProducts(page, { timeoutMs = 20000 } = {}) {
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
      if (!enabled) {
        if (matchedCount === 0) {
          lastDisabledZero = { ok: false, text, productCount: matchedCount, error: 'Update button is disabled' }
          continue
        }
        return { ok: false, text, productCount: matchedCount, error: 'Update button is disabled' }
      }

      try {
        await item.click({ timeout: Math.min(15000, Math.max(5000, deadline - Date.now())) })
        return { ok: true, text, productCount: matchedCount, clicked: true }
      } catch (err) {
        lastClickError = { ok: false, text, productCount: matchedCount, error: err?.message || String(err) }
      }
    }

    await sleep(500)
  }

  if (lastDisabledZero) return lastDisabledZero
  if (lastClickError) return lastClickError

  return page.evaluate(() => {
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
    target.click()
    return { ok: true, text, productCount, clicked: true }
  })
}

async function updateProductsUntilDone(page, options) {
  const batches = []
  let lastResult = null

  for (let batchIndex = 1; batchIndex <= options.maxUpdateBatches; batchIndex += 1) {
    if (isRuntimeExpired(options)) {
      return {
        ok: batches.length > 0,
        batches,
        lastResult,
        totalProductCount: batches.reduce((sum, item) => sum + (Number(item.productCount) || 0), 0),
        stopReason: 'max_runtime_ms_reached',
      }
    }

    const updateResult = await clickUpdateProducts(page, {
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
    })
    await logProgress(
      page,
      `[脚本${options.multiLabel || ''}] 第 ${batchIndex} 批：已点击「${updateResult.text}」` +
        (updateResult.productCount ? `（${updateResult.productCount} 件）` : ''),
    )

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
  const multiLabel = options.multiLabel || ''
  const result = {
    shopRegion,
    url,
    ok: false,
    batchOptimize: null,
    updateProducts: null,
    updateBatches: [],
    optimizeRounds: [],
    totalProductCount: 0,
    stopReason: '',
    finalUrl: '',
    bodyPreview: '',
  }

  try {
    for (let roundIndex = 1; roundIndex <= options.maxOptimizeRounds; roundIndex += 1) {
      if (isRuntimeExpired(options)) {
        result.stopReason = 'max_runtime_ms_reached'
        result.ok = result.optimizeRounds.some((item) => item.updateBatches.length > 0)
        await logProgress(page, `[脚本${multiLabel}] 已达最长运行时间，停止当前区域`)
        break
      }

      const roundLabel =
        options.maxOptimizeRounds > 1 ? `第 ${roundIndex}/${options.maxOptimizeRounds} 轮` : '本轮'
      await logProgress(
        page,
        `[脚本${multiLabel}] ${roundLabel}：正在打开商品优化页（区域 ${shopRegion}）`,
      )
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.navigationTimeoutMs })
      await page.waitForLoadState('networkidle', { timeout: options.networkIdleTimeoutMs }).catch(() => {})
      await sleep(options.waitMs)
      await logProgress(page, `[脚本${multiLabel}] 商品优化页已打开`)

      if (/\/account\/login/i.test(page.url())) {
        result.error = 'TikTok Shop login is required for this browser profile'
        result.bodyPreview = await safeBodyPreview(page)
        result.finalUrl = page.url()
        await logProgress(page, `[脚本${multiLabel}] 需要登录 TikTok Shop 卖家中心`)
        return result
      }

      await logProgress(page, `[脚本${multiLabel}] 正在点击「批量优化」`)
      const batchOptimize = await clickBatchOptimize(page)
      result.batchOptimize = batchOptimize
      if (!batchOptimize?.ok) {
        await logProgress(page, `[脚本${multiLabel}] 未找到「批量优化」按钮`)
        result.bodyPreview = await safeBodyPreview(page)
        result.finalUrl = page.url()
        result.stopReason = result.optimizeRounds.length ? 'batch_optimize_button_not_found_after_rounds' : ''
        result.ok = result.optimizeRounds.length > 0
        return result
      }

      await logProgress(
        page,
        `[脚本${multiLabel}] 已点击「批量优化」${batchOptimize.text ? `：${batchOptimize.text}` : ''}`,
      )
      await sleep(options.afterBatchClickMs)
      await logProgress(page, `[脚本${multiLabel}] 侧边栏已打开，正在点击「更新 N 件商品」`)
      const updateSummary = await updateProductsUntilDone(page, {
        ...options,
        multiLabel,
      })
      const round = {
        roundIndex,
        batchOptimize,
        updateProducts: updateSummary.lastResult,
        updateBatches: updateSummary.batches,
        totalProductCount: updateSummary.totalProductCount,
        stopReason: updateSummary.stopReason,
        ok: updateSummary.ok,
      }
      result.optimizeRounds.push(round)
      result.updateProducts = updateSummary.lastResult
      result.updateBatches.push(
        ...updateSummary.batches.map((batch) => ({
          ...batch,
          roundIndex,
        })),
      )
      result.totalProductCount += updateSummary.totalProductCount
      result.stopReason = updateSummary.stopReason

      if (!updateSummary.ok) {
        result.ok = result.optimizeRounds.some((item) => item.updateBatches.length > 0)
        break
      }

      await logProgress(
        page,
        `[脚本${multiLabel}] ${roundLabel}结束：${formatStopReasonChinese(updateSummary.stopReason)}` +
          ` · 累计 ${updateSummary.totalProductCount || 0} 件`,
      )

      const roundHadUpdates = updateSummary.batches.length > 0
      if (!roundHadUpdates) {
        await logProgress(page, `[脚本${multiLabel}] 重新打开后无可更新商品，结束当前区域`)
        result.ok = true
        result.stopReason = 'no_updates_after_reopen'
        break
      }

      const noMoreInCurrentFlow = ['no_update_button_found', 'no_more_products'].includes(updateSummary.stopReason)
      const shouldTryNextRound = noMoreInCurrentFlow && roundIndex < options.maxOptimizeRounds
      if (!shouldTryNextRound) {
        result.ok = Boolean(batchOptimize?.ok && updateSummary.ok)
        if (noMoreInCurrentFlow && roundHadUpdates && roundIndex >= options.maxOptimizeRounds) {
          result.stopReason = `max_optimize_rounds_reached_${options.maxOptimizeRounds}`
          await logProgress(
            page,
            `[脚本${multiLabel}] 已达最大优化轮数（${options.maxOptimizeRounds}），结束当前区域`,
          )
        }
        break
      }

      await logProgress(
        page,
        `[脚本${multiLabel}] 准备进入第 ${roundIndex + 1}/${options.maxOptimizeRounds} 轮批量优化`,
      )
      await sleep(options.afterOptimizeRoundMs)
    }

    if (!result.stopReason && result.optimizeRounds.length >= options.maxOptimizeRounds) {
      result.stopReason = `max_optimize_rounds_reached_${options.maxOptimizeRounds}`
    }

    result.finalUrl = page.url()
    result.bodyPreview = await safeBodyPreview(page)
    result.ok = Boolean(result.ok || result.optimizeRounds.some((item) => item.updateBatches.length > 0))
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
  const keepOpen = hasFlag('--keepOpen')
  const maxRuntimeMs = getNumberArg('--max_runtime_ms', 0)
  const totalRegions = shopRegions.length
  const options = {
    waitMs: getNumberArg('--wait_ms', 1500),
    afterBatchClickMs: getNumberArg('--after_batch_click_ms', 1200),
    afterUpdateClickMs: getNumberArg('--after_update_click_ms', 2500),
    afterOptimizeRoundMs: getNumberArg('--after_optimize_round_ms', 1500),
    updateButtonTimeoutMs: getNumberArg('--update_button_timeout_ms', 60000),
    maxUpdateBatches: getNumberArg('--max_update_batches', 100),
    maxOptimizeRounds: getNumberArg('--max_optimize_rounds', 1),
    maxRuntimeMs,
    deadlineAtMs: maxRuntimeMs > 0 ? Date.now() + maxRuntimeMs : 0,
    navigationTimeoutMs: getNumberArg('--navigation_timeout_ms', 60000),
    networkIdleTimeoutMs: getNumberArg('--network_idle_timeout_ms', 12000),
  }

  const startUrl = buildOptimizerUrl(shopRegions[0])
  const connection = await connectBrowser(startUrl)
  await openScriptArgsPanel(connection.browser, { scriptDir: SCRIPT_DIR })
  const page = await getActivePage(connection.browser, startUrl)
  page.setDefaultTimeout(12000)

  const results = []
  try {
    for (let ri = 0; ri < shopRegions.length; ri += 1) {
      const shopRegion = shopRegions[ri]
      const multiLabel = totalRegions > 1 ? ` [区域 ${ri + 1}/${totalRegions} · ${shopRegion}]` : ''
      await logProgress(
        page,
        `[脚本] 开始商品批量优化更新${multiLabel}：区域 ${shopRegion}` +
          (options.maxOptimizeRounds > 1 ? `，最多 ${options.maxOptimizeRounds} 轮` : ''),
      )
      const regionResult = await runForRegion(page, shopRegion, { ...options, multiLabel })
      results.push(regionResult)

      if (totalRegions > 1 && ri + 1 < shopRegions.length) {
        const nextRegion = shopRegions[ri + 1]
        if (regionResult.ok) {
          await logProgress(page, `[脚本] 区域 ${shopRegion} 已完成，继续下一区域：${nextRegion}`)
        } else {
          await logProgress(page, `[脚本] 区域 ${shopRegion} 未完成，继续下一区域：${nextRegion}`)
        }
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
        title: result.ok ? '任务已完成' : '任务结束',
        variant: result.error ? 'danger' : result.ok ? 'success' : 'warning',
        lines: [
          ...buildRegionResultLines(result),
          '',
          '终端已输出完整 JSON。点击「确定」关闭。',
        ],
      })
    } else if (results.length > 0) {
      const summaryLines = [
        `配置区域（共 ${totalRegions} 个）：${shopRegions.join('、')}`,
        `已执行区域：${results.map((item) => item.shopRegion).join('、')}`,
        '多区域模式：所有区域执行完成后仅弹出本汇总窗口一次。',
        '',
        '分项如下：',
        '',
      ]
      for (const result of results) {
        summaryLines.push(`「${result.shopRegion}」· ${result.ok ? '已完成' : '未完成'}`)
        summaryLines.push(...buildRegionResultLines(result).map((line) => (line ? `  ${line}` : line)))
        summaryLines.push('')
      }
      await showPageResultModalUntilAck(page, {
        title: allOk ? '任务已完成' : '任务已结束（部分未完成）',
        variant: allOk ? 'success' : 'warning',
        lines: summaryLines,
      })
    }

    if (keepOpen) await new Promise(() => {})
  } finally {
    if (connection.closeBrowser && !keepOpen) {
      await connection.browser.close().catch(() => {})
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err))
  process.exitCode = 1
})

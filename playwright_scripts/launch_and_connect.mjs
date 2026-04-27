#!/usr/bin/env node

/**
 * 方案 A 示例：
 * 外部脚本 -> Launch API -> Playwright 接管 CDP
 *
 * 运行前：
 * 1) 应用已启动，Launch API 可访问（默认 http://127.0.0.1:19876）
 * 2) 安装依赖：npm i -D playwright
 *
 * 示例：
 * node playwright_scripts/launch_and_connect.mjs
 * node playwright_scripts/launch_and_connect.mjs --code BUYER_001
 * node playwright_scripts/launch_and_connect.mjs --keyword buyer-001 --matchMode first
 */

import { chromium } from 'playwright'

const DEFAULT_BASE_URL = process.env.LAUNCH_BASE_URL || 'http://127.0.0.1:19876'
const DEFAULT_AUTH_HEADER = process.env.LAUNCH_API_AUTH_HEADER || 'X-Ant-Api-Key'
const DEFAULT_AUTH_KEY = process.env.LAUNCH_API_KEY || ''
const DEFAULT_TARGET_URL = process.env.TARGET_URL || 'https://example.com'
const DEFAULT_SEARCH_TEXT = process.env.SEARCH_TEXT || '你好'
const DEBUG_READY_RETRY = 12
const DEBUG_READY_INTERVAL_MS = 500

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) {
    return ''
  }
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
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options)
  let payload = null
  try {
    payload = await response.json()
  } catch {
    // Ignore JSON parse failures and keep payload as null.
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

  if (profileId) {
    return { profileId, matchMode }
  }
  if (profileName) {
    return { profileName, matchMode }
  }
  if (keyword) {
    return { keyword, matchMode }
  }
  if (code) {
    return { code, matchMode }
  }

  return { code: 'BUYER_001', matchMode: 'first' }
}

async function launchProfile(baseUrl) {
  const selector = resolveSelector()
  const payload = {
    selector,
    launchArgs: ['--window-size=1280,800'],
    startUrls: [DEFAULT_TARGET_URL],
    skipDefaultStartUrls: true,
  }

  return requestJson(`${baseUrl}/api/launch`, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(payload),
  })
}

async function waitUntilDebugReady(baseUrl, initialResponse) {
  if (initialResponse?.debugReady) {
    return initialResponse
  }

  const code = String(initialResponse?.launchCode || '').trim()
  if (!code) {
    return initialResponse
  }

  for (let i = 0; i < DEBUG_READY_RETRY; i += 1) {
    await sleep(DEBUG_READY_INTERVAL_MS)
    const latest = await requestJson(`${baseUrl}/api/launch/${encodeURIComponent(code)}`, {
      method: 'GET',
      headers: buildHeaders(),
    })
    if (latest?.debugReady) {
      return latest
    }
  }

  return initialResponse
}

async function run() {
  const baseUrl = getArgValue('--baseUrl') || DEFAULT_BASE_URL
  const targetUrl = getArgValue('--targetUrl') || DEFAULT_TARGET_URL
  const searchText = getArgValue('--searchText') || DEFAULT_SEARCH_TEXT
  const keepOpen = hasFlag('--keepOpen')

  console.log(`[1/4] 健康检查: ${baseUrl}/api/health`)
  await checkHealth(baseUrl)

  console.log('[2/4] 调用 Launch API 启动实例')
  const launchResponse = await launchProfile(baseUrl)
  console.log('启动响应:', {
    profileId: launchResponse?.profileId,
    profileName: launchResponse?.profileName,
    launchCode: launchResponse?.launchCode,
    debugReady: launchResponse?.debugReady,
    cdpUrl: launchResponse?.cdpUrl,
  })

  console.log('[3/4] 等待 debugReady 并确认 cdpUrl')
  const readyResponse = await waitUntilDebugReady(baseUrl, launchResponse)
  const cdpUrl = String(readyResponse?.cdpUrl || '').trim()
  if (!cdpUrl) {
    throw new Error('未拿到 cdpUrl，无法接管 CDP')
  }

  console.log(`[4/4] Playwright 接管 CDP: ${cdpUrl}`)
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  } catch (error) {
    console.warn(
      `页面跳转超时，将继续使用当前页面: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  console.log('页面标题:', await page.title())
  console.log('当前 URL:', page.url())

  // 百度自动化示例：输入关键词并获取第一条结果。
  if (page.url().includes('baidu.com')) {
    const visibleKeywordInput = page
      .locator('input#kw:visible, textarea#kw:visible, input[name="wd"]:visible, textarea[name="wd"]:visible')
      .first()

    if ((await visibleKeywordInput.count()) > 0) {
      await visibleKeywordInput.fill(searchText)
      await visibleKeywordInput.press('Enter')
    } else {
      const triggerMode = await page.evaluate((keyword) => {
        const input =
          document.querySelector('#kw') ||
          document.querySelector('input[name="wd"]') ||
          document.querySelector('textarea[name="wd"]')
        if (input && 'value' in input) {
          input.value = keyword
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }

        const submit =
          document.querySelector('#su') ||
          document.querySelector('input[type="submit"]') ||
          document.querySelector('button[type="submit"]')
        if (submit instanceof HTMLElement) {
          submit.click()
          return 'click-submit'
        }

        const form = input?.closest('form')
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
          return 'form-submit'
        }

        window.location.href = `https://www.baidu.com/s?wd=${encodeURIComponent(keyword)}`
        return 'location-jump'
      }, searchText)
      console.log('百度搜索触发方式:', triggerMode)
    }

    await page.waitForSelector(
      '#content_left h3 a, #content_left .result a, .result-op a',
      { timeout: 30_000 },
    )

    const firstResult = page
      .locator('#content_left h3 a, #content_left .result a, .result-op a')
      .first()
    const firstTitle = (await firstResult.textContent())?.trim() || ''
    const firstHref = (await firstResult.getAttribute('href')) || ''

    console.log('搜索关键词:', searchText)
    console.log('第一条结果标题:', firstTitle)
    console.log('第一条结果链接:', firstHref)
  }

  if (keepOpen) {
    console.log('已启用 --keepOpen，脚本将保持连接。按 Ctrl+C 退出。')
    // Keep process alive for manual inspection.
    await new Promise(() => {})
  } else {
    await browser.close()
    console.log('执行完成，连接已关闭。')
  }
}

run().catch((error) => {
  console.error('执行失败:', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})


#!/usr/bin/env node
/**
 * 一次性 CDP 探测：单品卡页与「日期 / 前天（统计日）」相关的 DOM 线索。
 * 运行：node playwright_scripts/tiktok_compass_ereyesterday_top_products/probe_ereyesterday_cdp.mjs --cdp http://127.0.0.1:19876
 *
 * 注意：默认 Launch 端口 19876 仅在**已有活跃浏览器**（应用内启动档案或 POST /api/launch）时可连；
 * 否则会 503。详见 playwright_scripts/README.md「CDP 与 Launch 默认端口 19876」。
 */
import { chromium } from 'playwright'

const url =
  'https://seller.tiktokshopglobalselling.com/compass/single-product-card?shop_region=PH'

function getArgValue(flagName) {
  const idx = process.argv.indexOf(flagName)
  if (idx === -1 || idx + 1 >= process.argv.length) return ''
  return String(process.argv[idx + 1] || '').trim()
}

const cdpUrl =
  getArgValue('--cdp') || process.env.PLAYWRIGHT_CDP_URL || process.env.CDP_URL || ''

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

async function main() {
  if (!cdpUrl) {
    console.error('需要 --cdp http://127.0.0.1:19876')
    process.exitCode = 1
    return
  }
  const browser = await chromium.connectOverCDP(cdpUrl)
  const context = browser.contexts()[0] || (await browser.newContext())
  const page = context.pages()[0] || (await context.newPage())
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {})
  await sleep(2500)

  const report = await page.evaluate(() => {
    const snip = (s, n = 140) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)

    /** @type {{ tag: string, text: string, className: string }[]} */
    const hits = []
    document.querySelectorAll('button, [role="button"], span, div, li, a, label').forEach((el) => {
      if (hits.length >= 100) return
      const t = snip(el.textContent, 120)
      if (t.length > 100) return
      const ok =
        /\d{4}[/.-]\d{1,2}/.test(t) ||
        /最近|7\s*天|Yesterday|昨天|昨日|今日|Today|近\d+\s*天|天:|GMT/.test(t)
      if (!ok) return
      hits.push({
        tag: el.tagName.toLowerCase(),
        text: t,
        className: snip(el.className?.toString?.() || '', 120),
      })
    })

    const bodySample = snip(document.body?.innerText || '', 2500)

    const iframeCount = document.querySelectorAll('iframe').length

    return { hits, bodySample, iframeCount }
  })

  console.log('--- phase1 ---')
  console.log(JSON.stringify(report, null, 2))

  const picker = page.locator('.m4b-date-picker-range:not(.arco-picker-disabled)').first()
  await picker.click({ timeout: 15_000 }).catch(() => {})
  await sleep(1200)

  const afterClick = await page.evaluate(() => {
    const snip = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n)
    /** @type {string[]} */
    const texts = []
    document.querySelectorAll('.arco-trigger-popup, .arco-picker-container, [role="listbox"], li, button, span').forEach((el) => {
      const t = snip(el.textContent, 80)
      if (
        t &&
        t.length < 90 &&
        /昨天|昨日|Yesterday|近|天|日|周|月|Custom|自定义/.test(t)
      ) {
        texts.push(`${el.tagName}.${snip(el.className?.toString?.(), 40)} → ${t}`)
      }
    })
    return [...new Set(texts)].slice(0, 60)
  })

  console.log('--- phase2 after picker click ---')
  console.log(JSON.stringify(afterClick, null, 2))

  const panelHtml = await page.evaluate(() => {
    const p = document.querySelector('.arco-picker-container')
    return p ? p.innerHTML.slice(0, 12_000) : ''
  })
  console.log('--- panel html head ---')
  console.log(panelHtml.slice(0, 4000))

  const allButtons = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
  )
  console.log('--- all button labels (sample) ---')
  console.log(JSON.stringify(allButtons.slice(0, 80), null, 2))

  await browser.close()
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exitCode = 1
})

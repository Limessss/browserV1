/**
 * 跨 Playwright 业务脚本复用：页面底部 Toast 步骤说明 + 结束汇总 Modal。
 */

export const PAGE_TOAST_MS = 3000
export const PAGE_TOAST_DOM_ID = 'ant-playwright-top-toast'
export const PAGE_MODAL_ROOT_ID = 'ant-playwright-result-modal'
/** 结果 Modal 无操作时自动关闭浏览器（毫秒，默认 30 秒）；与 `--keepOpen` 互斥 */
export const PAGE_MODAL_IDLE_BROWSER_CLOSE_MS = 30 * 1000

/** 调试开关：命令行带 `--keepOpen` 时不倒计时、不自动关浏览器（勿写入 script.json 的 defaultArgs） */
export function hasKeepOpenFlag(argv = process.argv) {
  return argv.includes('--keepOpen')
}

export async function closeChromiumWindowHard(browser) {
  if (!browser) return
  try {
    const session = await browser.newBrowserCDPSession()
    try {
      await session.send('Browser.close')
    } finally {
      await session.detach().catch(() => {})
    }
  } catch {
    await browser.close().catch(() => {})
  }
}

/** @param {import('playwright').Page} page */
export async function closeBrowserFromPlaywrightPage(page) {
  const browser = page.context().browser()
  if (browser) await closeChromiumWindowHard(browser)
  else await page.context().close().catch(() => {})
}

/**
 * @param {import('playwright').Page} page
 * @param {string} message
 */
export async function showPageToast(page, message) {
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

/**
 * @param {import('playwright').Page | null | undefined} page
 * @param {string} message
 */
export async function logProgress(page, message) {
  console.log(message)
  if (page) await showPageToast(page, message)
}

/**
 * @param {import('playwright').Page} page
 * @param {{ title: string, variant?: 'success' | 'warning' | 'danger', lines: string[] }} opts
 */
export async function showPageResultModalUntilAck(page, opts) {
  const suppressIdleBrowserClose = hasKeepOpenFlag()
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
      await closeBrowserFromPlaywrightPage(page)
    } catch {
      /* 连接已断开或页面已销毁 */
    }
  }
}

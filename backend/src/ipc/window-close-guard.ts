/**
 * Windows 下拦截窗口关闭，由前端 `app:request-close` 弹窗确认（对齐 Wails OnBeforeClose + ShouldBlockClose）。
 */
import type { BrowserWindow } from 'electron'

import { emitWailsEvent } from './wails-emit'

let allowCloseOnce = false

/** 用户已在弹窗中选择退出方式，下一次 close 不再拦截 */
export function setAllowCloseOnce(): void {
  allowCloseOnce = true
}

export function attachCloseConfirmation(win: BrowserWindow): void {
  win.on('close', (e) => {
    if (process.platform !== 'win32') {
      return
    }
    if (allowCloseOnce) {
      allowCloseOnce = false
      return
    }
    e.preventDefault()
    emitWailsEvent('app:request-close')
  })
}

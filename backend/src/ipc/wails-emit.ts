/**
 * 主进程 → 渲染进程：对齐 Wails runtime.EventsEmit（preload 监听 `wails:event`）。
 */
import { BrowserWindow } from 'electron'

export function emitWailsEvent(eventName: string, ...args: unknown[]): void {
  const payload = { name: eventName, args }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) {
      continue
    }
    w.webContents.send('wails:event', payload)
  }
}

/**
 * IPC 注册：go:call 多路复用 + 运行时指令
 */
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron'
import { forceQuitCleanup } from '../internal/force-quit-cleanup'
import { setQuitMode } from '../internal/quit-mode'
import { invokeGoCall } from './go-handlers'
import { setAllowCloseOnce } from './window-close-guard'

export interface IpcContext {
  getWindow: () => BrowserWindow | null
}

export function registerIpcHandlers(ctx: IpcContext): void {
  ipcMain.handle('go:call', async (_event, method: string, args: unknown[]) => {
    if (typeof method !== 'string') {
      return undefined
    }
    if (method === 'ForceQuit') {
      setAllowCloseOnce()
      setQuitMode('full')
      await forceQuitCleanup()
      app.quit()
      return undefined
    }
    if (method === 'QuitAppOnly') {
      setAllowCloseOnce()
      setQuitMode('app-only')
      app.quit()
      return undefined
    }
    return invokeGoCall(method, Array.isArray(args) ? args : [])
  })

  ipcMain.handle('runtime:environment', () => ({
    buildType: 'desktop',
    platform: process.platform,
    arch: process.arch,
  }))

  ipcMain.on('runtime:quit', () => app.quit())

  ipcMain.on('runtime:window-hide', () => {
    ctx.getWindow()?.hide()
  })

  ipcMain.on('runtime:window-show', () => {
    ctx.getWindow()?.show()
  })

  ipcMain.on('runtime:window-minimise', () => {
    ctx.getWindow()?.minimize()
  })

  ipcMain.on('runtime:window-reload', () => {
    ctx.getWindow()?.webContents.reload()
  })

  ipcMain.on('runtime:window-reload-app', () => {
    ctx.getWindow()?.webContents.reload()
  })

  ipcMain.on('runtime:open-external', (_e, url: string) => {
    if (typeof url === 'string' && url.startsWith('http')) {
      void shell.openExternal(url)
    }
  })

  ipcMain.handle('runtime:clipboard-get-text', () => clipboard.readText())

  ipcMain.handle('runtime:clipboard-set-text', (_e, text: string) => {
    clipboard.writeText(String(text ?? ''))
    return true
  })
}

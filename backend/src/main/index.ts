/**
 * Electron 主进程入口（职责对齐原项目 main.go + backend 胶水层）
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initAppConfig } from '../internal/app-config-store'
import { initSqlite } from '../internal/database/sqlite-store'
import { initElectronPaths } from '../internal/electron-paths'
import { registerIpcHandlers } from '../ipc/register-handlers'
import { attachCloseConfirmation } from '../ipc/window-close-guard'
import { startLaunchHttpServer } from '../internal/launch-http-server'
import { forceQuitCleanup } from '../internal/force-quit-cleanup'
import { resetQuitMode, shouldStopRuntimeServicesOnQuit } from '../internal/quit-mode'
import { installAppLogBridge } from '../internal/app-runtime-service'
import { destroyTray, initTray } from '../internal/tray'

const isDev = !app.isPackaged

function resolvePreloadScript(): string {
  const base = join(__dirname, '../preload/index')
  for (const ext of ['.js', '.mjs', '.cjs']) {
    const p = base + ext
    if (existsSync(p)) {
      return p
    }
  }
  return base + '.mjs'
}

let mainWindow: BrowserWindow | null = null

function getWindow(): BrowserWindow | null {
  return mainWindow
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1750,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.setMenuBarVisibility(false)
  win.removeMenu()

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../../renderer/index.html'))
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  attachCloseConfirmation(win)

  return win
}

app.whenReady().then(async () => {
  installAppLogBridge()
  resetQuitMode()
  initElectronPaths(app)
  initAppConfig(app)
  await initSqlite(app)
  void startLaunchHttpServer().catch((e) => console.error('[LaunchServer]', e))
  registerIpcHandlers({ getWindow })
  mainWindow = createWindow()
  await initTray(getWindow)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('before-quit', () => {
  destroyTray()
  if (!shouldStopRuntimeServicesOnQuit()) {
    return
  }
  void forceQuitCleanup()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

/**
 * Electron 主进程入口（职责对齐原项目 main.go + backend 胶水层）
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { initAppConfig } from '../internal/app-config-store'
import {
  configurePersistentUserData,
  logBrowserDataPaths,
  migrateLegacyBrowserUserData,
} from '../internal/browser-user-data-paths'
import { initSqlite, getSqlite } from '../internal/database/sqlite-store'
import { initElectronPaths } from '../internal/electron-paths'
import { registerIpcHandlers } from '../ipc/register-handlers'
import { attachCloseConfirmation } from '../ipc/window-close-guard'
import { startLaunchHttpServer, getLaunchHttpServer, setLiveBridgeUpgradeHandler } from '../internal/launch-http-server'
import { startLiveBridge, stopLiveBridge, handleLiveBridgeUpgrade } from '../internal/live-bridge-server'
import { forceQuitCleanup } from '../internal/force-quit-cleanup'
import { resetQuitMode, shouldStopRuntimeServicesOnQuit } from '../internal/quit-mode'
import { installAppLogBridge } from '../internal/app-runtime-service'
import { destroyTray, initTray } from '../internal/tray'

const isDev = !app.isPackaged

configurePersistentUserData(app)

/** 打包版临时调试：启动前设置环境变量 NEXBROWSER_DEVTOOLS=1（或 true/yes）自动打开 Console */
function shouldOpenPackagedDevTools(): boolean {
  if (!app.isPackaged) {
    return false
  }
  const v = (process.env.NEXBROWSER_DEVTOOLS ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function attachPackagedDevTools(win: BrowserWindow): void {
  if (!shouldOpenPackagedDevTools()) {
    return
  }
  const open = (): void => {
    win.webContents.openDevTools({ mode: 'detach' })
  }
  win.webContents.once('did-finish-load', open)
  win.webContents.once('did-fail-load', open)
}

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

/** 窗口左上角图标（开发态 cwd/build；打包后 resources/icon.png，见 package.json extraResources） */
function resolveWindowIconPath(): string | undefined {
  if (isDev) {
    const devPath = join(process.cwd(), 'build', 'icon.png')
    return existsSync(devPath) ? devPath : undefined
  }
  const packagedPath = join(process.resourcesPath, 'icon.png')
  return existsSync(packagedPath) ? packagedPath : undefined
}

function createWindow(): BrowserWindow {
  const iconPath = resolveWindowIconPath()
  const win = new BrowserWindow({
    width: 1750,
    height: 1000,
    minWidth: 1200,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: resolvePreloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 生产态 file:// 加载 Vite 打出的带 crossorigin 的 module 脚本时，需关闭同源限制，否则常见白屏
      webSecurity: isDev,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.setMenuBarVisibility(false)
  win.removeMenu()

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  attachPackagedDevTools(win)

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
  migrateLegacyBrowserUserData(getSqlite())
  logBrowserDataPaths(getSqlite())
  void startLaunchHttpServer().then(() => {
    if (startLiveBridge()) {
      setLiveBridgeUpgradeHandler(handleLiveBridgeUpgrade)
      console.log('[LiveBridge] WS endpoint ready at ws://127.0.0.1:19876/api/live-bridge')
    }
  }).catch((e) => console.error('[LaunchServer]', e))
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

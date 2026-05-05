import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'

let tray: Tray | null = null

function createFallbackBitmapIcon() {
  const width = 16
  const height = 16
  const pixels = Buffer.alloc(width * height * 4)

  // Electron bitmap uses BGRA. 生成一个带边框的蓝色图标，确保非透明可见。
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const isBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1
      if (isBorder) {
        pixels[i] = 0x2f // B
        pixels[i + 1] = 0x1f // G
        pixels[i + 2] = 0x14 // R
        pixels[i + 3] = 0xff // A
      } else {
        pixels[i] = 0xff // B
        pixels[i + 1] = 0xa5 // G
        pixels[i + 2] = 0x60 // R
        pixels[i + 3] = 0xff // A
      }
    }
  }

  return nativeImage
    .createFromBitmap(pixels, { width, height, scaleFactor: 1 })
    .resize({ width: 16, height: 16 })
}

async function resolveTrayIcon() {
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'normal' })
    if (!icon.isEmpty()) {
      return icon.resize({ width: 16, height: 16 })
    }
  } catch (error) {
    console.warn('[Tray] getFileIcon failed:', error)
  }
  return createFallbackBitmapIcon()
}

function showMainWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win) return
  if (win.isMinimized()) {
    win.restore()
  }
  win.show()
  win.focus()
}

export async function initTray(getWindow: () => BrowserWindow | null): Promise<void> {
  if (process.platform !== 'win32' || tray) {
    return
  }

  tray = new Tray(await resolveTrayIcon())
  tray.setToolTip(app.name || 'NexBrowser')

  tray.on('click', () => {
    showMainWindow(getWindow)
  })

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示主窗口',
      click: () => {
        showMainWindow(getWindow)
      },
    },
    { type: 'separator' },
    {
      label: '退出应用',
      click: () => {
        app.quit()
      },
    },
  ])
  tray.setContextMenu(contextMenu)
}

export function destroyTray(): void {
  if (!tray) {
    return
  }
  tray.destroy()
  tray = null
}

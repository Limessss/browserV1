/**
 * 退出模式（对齐 Ant-Browser quitMode）：
 * - full: 全量退出，关闭运行时服务
 * - app-only: 仅退出应用，保留已打开浏览器与桥接进程
 */
export type QuitMode = 'full' | 'app-only'

let currentQuitMode: QuitMode = 'full'

export function setQuitMode(mode: QuitMode): void {
  currentQuitMode = mode
}

export function shouldStopRuntimeServicesOnQuit(): boolean {
  return currentQuitMode !== 'app-only'
}

export function resetQuitMode(): void {
  currentQuitMode = 'full'
}

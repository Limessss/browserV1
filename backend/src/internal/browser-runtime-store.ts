/**
 * 运行中浏览器进程与调试端口（主进程内存态，对齐 Go browserMgr 运行态）。
 */
import type { ChildProcess } from 'node:child_process'

export type BrowserRuntimeEntry = {
  pid: number
  debugPort: number
  debugReady: boolean
  /** 主进程持有的启动器子进程；用户从任务栏关闭 Chromium 后可能提前退出 */
  child: ChildProcess | null
  runtimeWarning: string
}

const runtimes = new Map<string, BrowserRuntimeEntry>()

/** 用户/API 主动停止时标记，子进程 exit 时不应再报 crashed */
const gracefulStopIds = new Set<string>()

export function markGracefulBrowserStop(profileId: string): void {
  gracefulStopIds.add(profileId.trim())
}

/** 若存在标记则清除并返回 true（表示本次 exit 来自主动停止） */
export function consumeGracefulBrowserStop(profileId: string): boolean {
  const id = profileId.trim()
  if (!gracefulStopIds.has(id)) {
    return false
  }
  gracefulStopIds.delete(id)
  return true
}

export function registerBrowserRuntime(profileId: string, entry: BrowserRuntimeEntry): void {
  runtimes.set(profileId.trim(), entry)
}

export function clearBrowserRuntime(profileId: string): void {
  runtimes.delete(profileId.trim())
}

export function getBrowserRuntime(profileId: string): BrowserRuntimeEntry | undefined {
  return runtimes.get(profileId.trim())
}

export function isProfileRunning(profileId: string): boolean {
  return runtimes.has(profileId.trim())
}

export function runningInstanceCount(): number {
  return runtimes.size
}

export function listRunningProfileIds(): string[] {
  return [...runtimes.keys()]
}

export function mergeRuntimeIntoProfileRecord(p: Record<string, unknown>): void {
  const id = String(p.profileId ?? '')
  if (!id) return
  const e = runtimes.get(id)
  if (!e) {
    return
  }
  p.running = true
  p.pid = e.pid
  p.debugPort = e.debugPort
  p.debugReady = e.debugReady
  p.runtimeWarning = e.runtimeWarning ?? ''
}

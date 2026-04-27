/**
 * 运行时杂项：内存指标、日志缓冲、Interceptor、日志级别（对齐 app.go）。
 */
import v8 from 'node:v8'
import type { Database } from 'sql.js'

import { loadLicenseHints, loadRuntimeMemoryHints } from './app-config-store'
import { countProfiles } from './browser-data'

const LOG_CAP = 800
let logLevel = 'info'
let logBridgeInstalled = false

type MemLog = {
  time: string
  level: string
  component: string
  message: string
  fields?: Record<string, unknown>
}

const memoryLogs: MemLog[] = []

function stringifyLogArg(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message || String(value)
  }
  if (typeof value === 'string') {
    return value
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function normalizeLevel(level: string): string {
  const upper = String(level || '').trim().toUpperCase()
  if (upper === 'ERROR' || upper === 'WARN' || upper === 'DEBUG') {
    return upper
  }
  return 'INFO'
}

export function appendMemoryLog(
  level: string,
  message: string,
  component = 'App',
  fields?: Record<string, unknown>,
): void {
  memoryLogs.push({
    time: new Date().toISOString(),
    level,
    component,
    message,
    fields,
  })
  while (memoryLogs.length > LOG_CAP) {
    memoryLogs.shift()
  }
}

export function installAppLogBridge(): void {
  if (logBridgeInstalled) {
    return
  }
  logBridgeInstalled = true

  const bindConsole = (method: keyof Console, level: string, component: string) => {
    const target = console as unknown as Record<string, (...args: unknown[]) => void>
    const original = (target[method as string] || console.log).bind(console)
    target[method as string] = (...args: unknown[]) => {
      original(...args)
      const message = args.map((item) => stringifyLogArg(item)).join(' ')
      appendMemoryLog(normalizeLevel(level), message, component)
    }
  }

  bindConsole('log', 'INFO', 'Console')
  bindConsole('info', 'INFO', 'Console')
  bindConsole('warn', 'WARN', 'Console')
  bindConsole('error', 'ERROR', 'Console')
  bindConsole('debug', 'DEBUG', 'Console')

  process.on('unhandledRejection', (reason) => {
    appendMemoryLog('ERROR', stringifyLogArg(reason), 'UnhandledRejection')
  })
  process.on('uncaughtException', (error) => {
    appendMemoryLog('ERROR', stringifyLogArg(error), 'UncaughtException')
  })
  process.on('warning', (warning) => {
    appendMemoryLog('WARN', stringifyLogArg(warning), 'ProcessWarning')
  })

  appendMemoryLog('INFO', '应用日志桥接已启用', 'Runtime')
}

export function getAppLogs(): MemLog[] {
  return [...memoryLogs]
}

export function clearAppLogs(): void {
  memoryLogs.length = 0
}

export function getMemoryStats(): Record<string, unknown> {
  const m = process.memoryUsage()
  const hints = loadRuntimeMemoryHints()
  const hs = v8.getHeapStatistics()
  return {
    alloc_mb: m.heapUsed / 1024 / 1024,
    total_alloc_mb: hs.used_heap_size / 1024 / 1024,
    sys_mb: m.rss / 1024 / 1024,
    num_gc: 0,
    limit_mb: hints.limitMb,
    gc_percent: hints.gcPercent,
  }
}

export function triggerGc(): void {
  const gc = globalThis.gc as ((...args: unknown[]) => void) | undefined
  if (typeof gc === 'function') {
    gc()
  }
}

export function getDefaultInterceptor(): Record<string, unknown> {
  return {
    enabled: false,
    logParameters: false,
    logResults: false,
    sensitiveFields: [],
  }
}

export function getLogLevel(): string {
  return logLevel
}

export function setLogLevel(level: string): void {
  logLevel = String(level ?? '').trim() || 'info'
}

export function getLicenseStatus(db: Database | null): Record<string, unknown> {
  const hints = loadLicenseHints()
  const usedCount = db ? countProfiles(db) : 0
  return {
    maxLimit: hints.maxLimit,
    usedCount,
    usedKeys: hints.usedKeys,
  }
}

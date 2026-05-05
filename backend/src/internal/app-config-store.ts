/**
 * 浏览器全局设置：读写 userData/config.yaml 的 browser 段（对齐 Ant-Browser YAML 键名）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import yaml from 'js-yaml'
import type { App } from 'electron'

let configPath = ''
const DEFAULT_LAUNCH_PORT = 19876
export const DEFAULT_LAUNCH_API_HEADER = 'X-Ant-Api-Key'

export function initAppConfig(app: App): void {
  configPath = join(app.getPath('userData'), 'config.yaml')
}

/** 与 Go apppath.StateRoot 相当：可写根目录（config.yaml 所在目录） */
export function getAppStateRoot(): string {
  if (!configPath) {
    return ''
  }
  return dirname(configPath)
}

export function defaultBrowserSettings(): Record<string, unknown> {
  return {
    userDataRoot: 'data',
    defaultFingerprintArgs: ['--fingerprint-brand=Chrome', '--fingerprint-platform=windows'],
    defaultLaunchArgs: ['--disable-sync', '--no-first-run'],
    defaultProxy: '',
    startReadyTimeoutMs: 3000,
    startStableWindowMs: 1200,
  }
}

function defaultRootYaml(): Record<string, unknown> {
  return {
    app: {
      name: 'NexBrowser',
      max_profile_limit: 20,
      used_cd_keys: [],
    },
    runtime: {
      max_memory_mb: 0,
      gc_percent: 100,
    },
    logging: {
      level: 'info',
      file_enabled: false,
      file_path: 'data/logs/app.log',
      format: 'text',
      buffer_size: 4,
      async_queue_size: 1000,
      flush_interval_ms: 1000,
      rotation: {
        enabled: false,
        max_size_mb: 100,
        max_age: 7,
        max_backups: 5,
        time_interval: 'daily',
      },
      interceptor: {
        enabled: true,
        log_parameters: true,
        log_results: true,
        sensitive_fields: ['password', 'token', 'secret'],
      },
    },
    browser: {
      user_data_root: 'data',
      default_fingerprint_args: ['--fingerprint-brand=Chrome', '--fingerprint-platform=windows'],
      default_launch_args: ['--disable-sync', '--no-first-run'],
      default_proxy: '',
      start_ready_timeout_ms: 3000,
      start_stable_window_ms: 1200,
      default_bookmarks: [],
      cores: [],
      proxies: [],
      profiles: [],
    },
    launch_server: {
      port: DEFAULT_LAUNCH_PORT,
      auth: { enabled: false, api_key: '', header: DEFAULT_LAUNCH_API_HEADER },
    },
    integrations: {
      linkeoo_erp: {
        base_url: 'https://api.linkeoo.com',
        api_key: '',
      },
    },
  }
}

function ensureObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function normalizeRootYaml(raw: Record<string, unknown>): Record<string, unknown> {
  const def = defaultRootYaml()
  const out = { ...raw }
  const app = { ...ensureObject(def.app), ...ensureObject(out.app) }
  if (!Array.isArray(app.used_cd_keys)) app.used_cd_keys = []
  if (Number(app.max_profile_limit ?? 0) < 20) app.max_profile_limit = 20
  out.app = app

  const runtime = { ...ensureObject(def.runtime), ...ensureObject(out.runtime) }
  if (Number(runtime.gc_percent ?? 0) <= 0) runtime.gc_percent = 100
  if (Number(runtime.max_memory_mb ?? 0) < 0) runtime.max_memory_mb = 0
  out.runtime = runtime

  const logging = { ...ensureObject(def.logging), ...ensureObject(out.logging) }
  logging.rotation = { ...ensureObject(ensureObject(def.logging).rotation), ...ensureObject(logging.rotation) }
  logging.interceptor = {
    ...ensureObject(ensureObject(def.logging).interceptor),
    ...ensureObject(logging.interceptor),
  }
  if (!Array.isArray(ensureObject(logging.interceptor).sensitive_fields)) {
    ensureObject(logging.interceptor).sensitive_fields = ['password', 'token', 'secret']
  }
  out.logging = logging

  const browser = { ...ensureObject(def.browser), ...ensureObject(out.browser) }
  if (!Array.isArray(browser.default_fingerprint_args)) {
    browser.default_fingerprint_args = ensureObject(def.browser).default_fingerprint_args
  }
  if (!Array.isArray(browser.default_launch_args)) {
    browser.default_launch_args = ensureObject(def.browser).default_launch_args
  }
  if (!Array.isArray(browser.default_bookmarks)) browser.default_bookmarks = []
  if (!Array.isArray(browser.cores)) browser.cores = []
  if (!Array.isArray(browser.proxies)) browser.proxies = []
  if (!Array.isArray(browser.profiles)) browser.profiles = []
  if (Number(browser.start_ready_timeout_ms ?? 0) <= 0) browser.start_ready_timeout_ms = 3000
  if (Number(browser.start_stable_window_ms ?? 0) <= 0) browser.start_stable_window_ms = 1200
  out.browser = browser

  const launchServer = { ...ensureObject(def.launch_server), ...ensureObject(out.launch_server) }
  launchServer.auth = {
    ...ensureObject(ensureObject(def.launch_server).auth),
    ...ensureObject(launchServer.auth),
  }
  if (Number(launchServer.port ?? 0) <= 0) launchServer.port = DEFAULT_LAUNCH_PORT
  if (!String(ensureObject(launchServer.auth).header ?? '').trim()) {
    ensureObject(launchServer.auth).header = DEFAULT_LAUNCH_API_HEADER
  }
  out.launch_server = launchServer

  const defInt = ensureObject(def.integrations)
  const integ = { ...defInt, ...ensureObject(out.integrations) }
  const defLe = ensureObject(defInt.linkeoo_erp as Record<string, unknown>)
  integ.linkeoo_erp = {
    ...defLe,
    ...ensureObject(integ.linkeoo_erp as Record<string, unknown>),
  }
  out.integrations = integ
  return out
}

function readRootYaml(): Record<string, unknown> {
  if (!configPath || !existsSync(configPath)) {
    return normalizeRootYaml({})
  }
  try {
    const text = readFileSync(configPath, 'utf8')
    const doc = yaml.load(text)
    return normalizeRootYaml((doc && typeof doc === 'object' ? doc : {}) as Record<string, unknown>)
  } catch {
    return normalizeRootYaml({})
  }
}

/** 读取完整 config.yaml（含 app/browser/runtime 等段），用于授权等非 browser 写入 */
export function loadRootYamlRaw(): Record<string, unknown> {
  return readRootYaml()
}

/** browser.default_bookmarks（无 SQLite 数据时的降级来源，对齐 Go config.Browser.DefaultBookmarks） */
export function loadDefaultBookmarksFromYaml(): Array<{ name: string; url: string }> {
  const raw = readRootYaml()
  const browser = raw.browser as Record<string, unknown> | undefined
  const arr = browser?.default_bookmarks
  if (!Array.isArray(arr) || arr.length === 0) {
    return []
  }
  const out: Array<{ name: string; url: string }> = []
  for (const it of arr) {
    if (!it || typeof it !== 'object') {
      continue
    }
    const o = it as Record<string, unknown>
    const name = String(o.name ?? '').trim()
    const url = String(o.url ?? '').trim()
    if (name && url) {
      out.push({ name, url })
    }
  }
  return out
}

/** 覆盖写入完整 config.yaml（调用方需合并后再写入，避免丢段） */
export function saveRootYamlRaw(raw: Record<string, unknown>): void {
  if (!configPath) {
    throw new Error('应用配置尚未初始化')
  }
  mkdirSync(dirname(configPath), { recursive: true })
  const normalized = normalizeRootYaml({ ...raw })
  writeFileSync(configPath, yaml.dump(normalized, { lineWidth: -1, noRefs: true }), 'utf8')
}

/** 合并默认值与 YAML，返回前端 camelCase（与 Wails Settings 一致） */
export function loadBrowserSettingsMerged(): Record<string, unknown> {
  const def = defaultBrowserSettings()
  const raw = readRootYaml()
  const b = (raw.browser as Record<string, unknown>) ?? {}

  const fp = b.default_fingerprint_args
  const lp = b.default_launch_args

  return {
    userDataRoot: String(b.user_data_root ?? def.userDataRoot).trim() || String(def.userDataRoot),
    defaultFingerprintArgs: Array.isArray(fp)
      ? fp.map((x) => String(x))
      : (def.defaultFingerprintArgs as string[]),
    defaultLaunchArgs: Array.isArray(lp)
      ? lp.map((x) => String(x))
      : (def.defaultLaunchArgs as string[]),
    defaultProxy: String(b.default_proxy ?? def.defaultProxy ?? ''),
    startReadyTimeoutMs: Math.max(
      0,
      Number(b.start_ready_timeout_ms ?? def.startReadyTimeoutMs ?? 3000) || 3000,
    ),
    startStableWindowMs: Math.max(
      0,
      Number(b.start_stable_window_ms ?? def.startStableWindowMs ?? 1200) || 1200,
    ),
  }
}

export function saveBrowserSettings(input: unknown): void {
  if (!configPath) {
    throw new Error('应用配置尚未初始化')
  }
  const o = (input ?? {}) as Record<string, unknown>
  const def = defaultBrowserSettings()
  const raw = readRootYaml()

  const fp = o.defaultFingerprintArgs
  const lp = o.defaultLaunchArgs

  raw.browser = {
    user_data_root: String(o.userDataRoot ?? def.userDataRoot).trim() || 'data',
    default_fingerprint_args: Array.isArray(fp)
      ? fp.map((x) => String(x))
      : (def.defaultFingerprintArgs as string[]),
    default_launch_args: Array.isArray(lp)
      ? lp.map((x) => String(x))
      : (def.defaultLaunchArgs as string[]),
    default_proxy: String(o.defaultProxy ?? ''),
    start_ready_timeout_ms:
      Number(o.startReadyTimeoutMs) > 0
        ? Number(o.startReadyTimeoutMs)
        : Number(def.startReadyTimeoutMs ?? 3000),
    start_stable_window_ms:
      Number(o.startStableWindowMs) > 0
        ? Number(o.startStableWindowMs)
        : Number(def.startStableWindowMs ?? 1200),
  }

  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }), 'utf8')
}

/** ReloadConfig：当前实现为幂等读盘；预留缓存时可在此清空 */
export function reloadAppConfig(): void {
  /* 读 side-effect：下次 loadBrowserSettingsMerged 即最新文件 */
}

/** runtime 段：读 Go config.yaml 中 runtime.max_memory_mb / gc_percent */
export function loadRuntimeMemoryHints(): { limitMb: number; gcPercent: number } {
  const raw = readRootYaml()
  const r = (raw.runtime as Record<string, unknown>) ?? {}
  return {
    limitMb: Math.max(0, Number(r.max_memory_mb ?? 0) || 0),
    gcPercent: Number(r.gc_percent ?? 100) || 100,
  }
}

/** app 段：授权上限与已用兑换码列表（对齐 Ant-Browser config.App） */
export function loadLicenseHints(): { maxLimit: number; usedKeys: string[] } {
  const raw = readRootYaml()
  const appSection = (raw.app as Record<string, unknown>) ?? {}
  const maxLimit = Number(appSection.max_profile_limit ?? 20) || 20
  const uk = appSection.used_cd_keys
  const usedKeys = Array.isArray(uk) ? uk.map((x) => String(x)) : []
  return { maxLimit, usedKeys }
}

export type LaunchServerAuthYaml = {
  enabled: boolean
  apiKey: string
  header: string
}

/** launch_server 段（端口 + API Key），供 Launch HTTP 与状态查询共用 */
export function loadLaunchServerConfig(): {
  preferredPort: number
  auth: LaunchServerAuthYaml
} {
  const raw = readRootYaml()
  const ls = (raw.launch_server as Record<string, unknown>) ?? {}
  const auth = (ls.auth as Record<string, unknown>) ?? {}
  const port = Number(ls.port ?? DEFAULT_LAUNCH_PORT) || DEFAULT_LAUNCH_PORT
  const headerRaw = String(auth.header ?? '').trim()
  return {
    preferredPort: port,
    auth: {
      enabled: Boolean(auth.enabled),
      apiKey: String(auth.api_key ?? '').trim(),
      header: headerRaw || DEFAULT_LAUNCH_API_HEADER,
    },
  }
}

/** 兼容旧 IPC：仅 preferredPort + listenUrl */
export type LinkeooErpConfig = {
  baseUrl: string
  apiKey: string
}

/** 链氪 ERP（OpenAPI）基址与 ApiKey，存于 config.yaml → integrations.linkeoo_erp */
export function loadLinkeooErpConfig(): LinkeooErpConfig {
  const raw = readRootYaml()
  const integ = (raw.integrations as Record<string, unknown>) ?? {}
  const le = (integ.linkeoo_erp as Record<string, unknown>) ?? {}
  const base = String(le.base_url ?? 'https://api.linkeoo.com').trim() || 'https://api.linkeoo.com'
  return {
    baseUrl: base.replace(/\/$/, ''),
    apiKey: String(le.api_key ?? '').trim(),
  }
}

/**
 * 保存链氪 ERP 配置。`apiKey` 若未传或为空字符串，则保留文件中的原 api_key（便于「仅改 host、不重复填 key」）。
 */
export function saveLinkeooErpConfig(input: { baseUrl?: string; apiKey?: string }): void {
  if (!configPath) {
    throw new Error('应用配置尚未初始化')
  }
  const raw = readRootYaml()
  const integ = { ...ensureObject(raw.integrations as Record<string, unknown>) }
  const prev = ensureObject(integ.linkeoo_erp as Record<string, unknown>)
  const nextBase = String(input.baseUrl ?? prev.base_url ?? 'https://api.linkeoo.com').trim() || 'https://api.linkeoo.com'
  const keyIn = input.apiKey
  const nextKey =
    typeof keyIn === 'string' && keyIn.trim() !== '' ? keyIn.trim() : String(prev.api_key ?? '').trim()
  integ.linkeoo_erp = {
    base_url: nextBase.replace(/\/$/, ''),
    api_key: nextKey,
  }
  raw.integrations = integ
  saveRootYamlRaw(raw)
}

export function loadLaunchServerInfo(): Record<string, unknown> {
  const cfg = loadLaunchServerConfig()
  const { auth, preferredPort: port } = cfg
  return {
    preferredPort: port,
    listenUrl: `http://127.0.0.1:${port}`,
    apiKeyConfigured: auth.enabled && auth.apiKey.length > 0,
  }
}

/** browser 段桥接二进制路径（对齐原版 xray_binary_path / singbox_binary_path） */
export function loadProxyBridgeBinaryPaths(): {
  xrayBinaryPath: string
  singboxBinaryPath: string
} {
  const raw = readRootYaml()
  const browser = (raw.browser as Record<string, unknown>) ?? {}
  return {
    xrayBinaryPath: String(browser.xray_binary_path ?? '').trim(),
    singboxBinaryPath: String(browser.singbox_binary_path ?? '').trim(),
  }
}

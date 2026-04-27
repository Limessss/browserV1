/**
 * 在非 Electron 环境（例如仅用浏览器打开 Vite 开发地址）下，preload 不存在，
 * wailsjs/runtime/runtime.js 依赖的 window.runtime / window.go 未注入会导致白屏。
 * 在 Electron 下由 preload 提供真实对象，此处仅在缺失时补上开发用占位。
 */

type RuntimeApi = Record<string, unknown>

function inferPlatform(): string {
  if (typeof navigator === 'undefined') {
    return 'windows'
  }
  const p = navigator.platform?.toLowerCase() ?? ''
  if (p.includes('mac')) {
    return 'darwin'
  }
  if (p.includes('linux')) {
    return 'linux'
  }
  return 'windows'
}

function buildDevRuntime(): RuntimeApi {
  const noopAsync = async (): Promise<undefined> => undefined
  const noop = (): void => {}

  const base: RuntimeApi = {
    EventsOnMultiple: (
      _eventName: string,
      _callback: (...args: unknown[]) => void,
      _maxCallbacks: number,
    ) => noop,
    EventsOn: (_eventName: string, _callback: (...args: unknown[]) => void) => noop,
    EventsOff: noop,
    EventsOffAll: noop,
    EventsOnce: (_eventName: string, _callback: (...args: unknown[]) => void) => noop,
    EventsEmit: noop,
    BrowserOpenURL: (url: string) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    Environment: async () => ({
      buildType: 'browser-dev',
      platform: inferPlatform(),
      arch: 'amd64',
    }),
    Quit: noop,
    Hide: noop,
    Show: noop,
    WindowHide: noop,
    WindowMinimise: noop,
    WindowShow: noop,
    WindowReload: () => window.location.reload(),
    WindowReloadApp: () => window.location.reload(),
    ClipboardGetText: async () => '',
    ClipboardSetText: noopAsync,
    LogPrint: noop,
    LogTrace: noop,
    LogDebug: noop,
    LogInfo: noop,
    LogWarning: noop,
    LogError: noop,
    LogFatal: noop,
  }

  return new Proxy(base, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') {
        return undefined
      }
      if (prop in target) {
        return Reflect.get(target, prop)
      }
      if (prop.startsWith('Log')) {
        return noop
      }
      if (prop.startsWith('Window')) {
        if (prop.includes('Is') || prop.includes('Get')) {
          return async () => (prop.includes('Fullscreen') ? false : null)
        }
        return noop
      }
      if (prop.startsWith('Screen')) {
        return noop
      }
      return noop
    },
  })
}

/** 与 desktop 端 go-mock、GetDashboardStats 前端字段对齐 */
function devInvokeGo(method: string, _args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'GetBrowserSettings':
      return Promise.resolve({
        userDataRoot: 'data',
        defaultFingerprintArgs: ['--fingerprint-brand=Chrome', '--fingerprint-platform=windows'],
        defaultLaunchArgs: ['--disable-sync', '--no-first-run'],
        defaultProxy: '',
        startReadyTimeoutMs: 3000,
        startStableWindowMs: 1200,
      })
    case 'SaveBrowserSettings':
      return Promise.resolve(undefined)
    case 'GetDashboardStats':
      return Promise.resolve({
        totalInstances: 0,
        runningInstances: 0,
        proxyCount: 0,
        coreCount: 0,
        memUsedMB: 0,
        appVersion: 'browser-dev',
      })
    case 'GetLicenseStatus':
      return Promise.resolve({
        maxLimit: 20,
        usedCount: 0,
        usedKeys: [] as string[],
      })
    case 'GetLaunchServerInfo':
      return Promise.resolve({
        preferredPort: 19876,
        listenUrl: 'http://127.0.0.1:19876',
        apiKeyConfigured: false,
      })
    case 'BrowserProxyFetchClashByURL':
      return Promise.reject(
        new Error('纯浏览器开发模式不支持订阅 URL 拉取，请运行 npm run dev 使用 Electron'),
      )
    case 'FetchRemoteAuthorProfile':
      return Promise.reject(
        new Error('纯浏览器开发模式不支持远程作者配置拉取，请运行 npm run dev 使用 Electron'),
      )
    case 'GetAppConfig':
      return Promise.resolve({})
    case 'GetInterceptor':
      return Promise.resolve({
        enabled: false,
        logParameters: false,
        logResults: false,
        sensitiveFields: [],
      })
    case 'BookmarkList':
    case 'BrowserProfileList':
    case 'BrowserProfileListByTag':
    case 'BrowserProxyList':
    case 'BrowserProxyListByGroup':
    case 'BrowserProxyListGroups':
    case 'BrowserGetAllTags':
    case 'BrowserProxyBatchCheckIPHealth':
    case 'BrowserProxyBatchTestSpeed':
    case 'ListGroups':
    case 'BrowserCoreList':
    case 'BrowserCoreScan':
    case 'BrowserCoreExtendedInfo':
    case 'GetRunningInstances':
    case 'GetAppLogs':
    case 'GenerateCDKeys':
      return Promise.resolve([])
    default:
      if (/List(Members)?$/i.test(method) || /^Browser.*List/.test(method)) {
        return Promise.resolve([])
      }
      if (/^Get[A-Z]/.test(method)) {
        if (method.includes('Health') || method.includes('Speed') || method.includes('Validation')) {
          return Promise.resolve({})
        }
        return Promise.resolve({})
      }
      if (
        /^(Save|Set|Delete|Clear|Reload|Trigger|Move|Rename|Redeem|Open|Create|Update|Backup|Bookmark|Browser)/.test(
          method,
        )
      ) {
        return Promise.resolve(undefined)
      }
      return Promise.resolve(undefined)
  }
}

function installDevGo(): void {
  const w = window as Window & { go?: { main: { App: unknown } } }
  if (w.go?.main?.App != null) {
    return
  }

  const appBinding = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop !== 'string') {
          return undefined
        }
        return (...args: unknown[]) => devInvokeGo(prop, args)
      },
    },
  )

  w.go = { main: { App: appBinding } }
}

export function installDevWailsShims(): void {
  const w = window as Window & { runtime?: RuntimeApi }
  if (!w.runtime) {
    w.runtime = buildDevRuntime() as RuntimeApi
  }
  installDevGo()
}

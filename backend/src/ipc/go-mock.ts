/**
 * Go/Wails API 迁移前的占位实现：返回安全默认值，避免 UI 在未接真实业务时报错。
 * 后续按方法名逐步替换为 SQLite / 进程 / 代理的真实逻辑。
 */

const defaultBrowserSettings = () => ({
  userDataRoot: 'data',
  defaultFingerprintArgs: ['--fingerprint-brand=Chrome', '--fingerprint-platform=windows'],
  defaultLaunchArgs: ['--disable-sync', '--no-first-run'],
  defaultProxy: '',
  startReadyTimeoutMs: 3000,
  startStableWindowMs: 1200,
})

const defaultDashboardStats = () => ({
  profileCount: 0,
  runningCount: 0,
  proxyCount: 0,
  coreCount: 0,
})

const defaultLicenseStatus = () => ({
  maxLimit: 20,
  usedCount: 0,
  usedKeys: [] as string[],
})

const defaultLauncherInfo = () => ({
  preferredPort: 19876,
  listenUrl: 'http://127.0.0.1:19876',
  apiKeyConfigured: false,
})

export async function invokeGoMock(method: string, _args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'BrowserInstanceStatus':
      throw new Error('数据库未就绪')
    case 'GetBrowserSettings':
      return defaultBrowserSettings()
    case 'GetLinkeooErpConfig':
      return { baseUrl: 'https://api.linkeoo.com', apiKey: '' }
    case 'SaveBrowserSettings':
    case 'SaveLinkeooErpConfig':
      return undefined
    case 'GetDashboardStats':
      return defaultDashboardStats()
    case 'GetLicenseStatus':
      return defaultLicenseStatus()
    case 'GetLaunchServerInfo':
      return defaultLauncherInfo()
    case 'ListPlaywrightScripts':
      return {
        rootDir: '',
        bundledRootDir: '',
        scripts: [] as unknown[],
        warnings: ['数据库未就绪：Playwright 脚本列表不可用'],
      }
    case 'RunPlaywrightScript':
      throw new Error('数据库未就绪：无法运行脚本')
    case 'KillPlaywrightScriptRun':
      return false
    case 'GetAppConfig':
      return {}
    case 'GetInterceptor':
      return {
        enabled: false,
        logParameters: false,
        logResults: false,
        sensitiveFields: [],
      }
    case 'BookmarkList':
      return []
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
      return []
    default:
      if (/List(Members)?$/i.test(method) || /^Browser.*List/.test(method)) {
        return []
      }
      if (/^Get[A-Z]/.test(method)) {
        if (method.includes('Health') || method.includes('Speed') || method.includes('Validation')) {
          return {}
        }
        return {}
      }
      if (/^(Save|Set|Delete|Clear|Reload|Trigger|Move|Rename|Redeem|Open|Create|Update|Backup|Bookmark|Browser)/.test(method)) {
        return undefined
      }
      console.warn('[go-mock] unimplemented:', method)
      return undefined
  }
}

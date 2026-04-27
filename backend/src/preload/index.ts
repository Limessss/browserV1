/**
 * Preload：还原 Wails 注入的 window.go.main.App.* 与 window.runtime.*
 */
import { contextBridge, ipcRenderer } from 'electron'

/** 订阅 wails:event 的业务回调 */
type EventCb = (...args: unknown[]) => void
const eventListeners = new Map<string, Set<EventCb>>()

ipcRenderer.on('wails:event', (_event, payload: { name: string; args: unknown[] }) => {
  const set = eventListeners.get(payload.name)
  if (!set || set.size === 0) return
  for (const cb of set) {
    try {
      cb(...payload.args)
    } catch (e) {
      console.error('[wails:event]', payload.name, e)
    }
  }
})

function eventsOnMultiple(eventName: string, callback: EventCb, maxCallbacks: number): () => void {
  if (!eventListeners.has(eventName)) {
    eventListeners.set(eventName, new Set())
  }
  const handlers = eventListeners.get(eventName)!

  let inner: EventCb
  if (maxCallbacks === 1) {
    inner = (...args: unknown[]) => {
      callback(...args)
      handlers.delete(inner)
    }
  } else {
    inner = callback
  }
  handlers.add(inner)
  return () => {
    handlers.delete(inner)
  }
}

function buildRuntime(): Record<string, unknown> {
  const noop = () => {}
  const noopAsync = async () => {}
  const base: Record<string, unknown> = {
    EventsOnMultiple: eventsOnMultiple,
    EventsOn: (eventName: string, callback: EventCb) => eventsOnMultiple(eventName, callback, -1),
    EventsOff: (eventName: string, ...additionalEventNames: string[]) => {
      eventListeners.delete(eventName)
      for (const n of additionalEventNames) {
        eventListeners.delete(n)
      }
    },
    EventsOffAll: () => {
      eventListeners.clear()
    },
    EventsOnce: (eventName: string, callback: EventCb) => eventsOnMultiple(eventName, callback, 1),
    EventsEmit: () => {},
    BrowserOpenURL: (url: string) => ipcRenderer.send('runtime:open-external', url),
    Environment: () => ipcRenderer.invoke('runtime:environment'),
    Quit: () => ipcRenderer.send('runtime:quit'),
    Hide: () => ipcRenderer.send('runtime:window-hide'),
    Show: () => ipcRenderer.send('runtime:window-show'),
    WindowHide: () => ipcRenderer.send('runtime:window-hide'),
    WindowMinimise: () => ipcRenderer.send('runtime:window-minimise'),
    WindowShow: () => ipcRenderer.send('runtime:window-show'),
    WindowReload: () => ipcRenderer.send('runtime:window-reload'),
    WindowReloadApp: () => ipcRenderer.send('runtime:window-reload-app'),
    ClipboardGetText: () => ipcRenderer.invoke('runtime:clipboard-get-text'),
    ClipboardSetText: (text: string) => ipcRenderer.invoke('runtime:clipboard-set-text', text),
    LogPrint: noop,
    LogTrace: noop,
    LogDebug: noop,
    LogInfo: noop,
    LogWarning: noop,
    LogError: noop,
    LogFatal: noop,
    WindowIsFullscreen: async () => false,
    WindowGetPosition: async () => null,
    WindowGetSize: async () => null,
    NotificationShow: noopAsync,
    NotificationHide: noopAsync,
    NotificationRemove: noopAsync,
    RequestBrowserNotificationPermission: noopAsync,
    IsNotificationPermissionGranted: noopAsync,
    CanResolveFilePaths: noop,
    ResolveFilePaths: noop,
  }
  return base
}

const appMethodNames = [
  'BackupExportPackage',
  'BackupGetManifestTemplate',
  'BackupGetScopeDefinition',
  'BackupImportPackage',
  'BackupInitializeSystem',
  'BookmarkList',
  'BookmarkReset',
  'BookmarkSave',
  'BrowserClearCookies',
  'BrowserCoreDelete',
  'BrowserCoreDownload',
  'BrowserCoreExtendedInfo',
  'BrowserCoreList',
  'BrowserCoreSave',
  'BrowserCoreScan',
  'BrowserCoreSetDefault',
  'BrowserCoreValidate',
  'BrowserExportCookies',
  'BrowserGetAllTags',
  'BrowserGetCookies',
  'BrowserInstanceGetTabs',
  'BrowserInstanceOpenUrl',
  'BrowserInstanceRestart',
  'BrowserInstanceStart',
  'BrowserInstanceStartByCode',
  'BrowserInstanceStartWithParams',
  'BrowserInstanceStatus',
  'BrowserInstanceStop',
  'BrowserProfileBatchRemoveTags',
  'BrowserProfileBatchSetTags',
  'BrowserProfileCopy',
  'BrowserProfileCreate',
  'BrowserProfileDelete',
  'BrowserProfileGetCode',
  'BrowserProfileList',
  'BrowserProfileListByTag',
  'BrowserProfileRegenerateCode',
  'BrowserProfileSetCode',
  'BrowserProfileSetKeywords',
  'BrowserProfileUpdate',
  'BrowserProxyBatchCheckIPHealth',
  'BrowserProxyBatchTestSpeed',
  'BrowserProxyCheckIPHealth',
  'BrowserProxyFetchClashByURL',
  'BrowserProxyList',
  'BrowserProxyListByGroup',
  'BrowserProxyListGroups',
  'BrowserProxyTestSpeed',
  'BrowserRenameTag',
  'BrowserSnapshotCreate',
  'BrowserSnapshotDelete',
  'BrowserSnapshotList',
  'BrowserSnapshotRestore',
  'ClearAppLogs',
  'CreateGroup',
  'DeleteGroup',
  'FetchRemoteAuthorProfile',
  'ForceQuit',
  'GenerateCDKeys',
  'GetAppConfig',
  'GetAppLogs',
  'GetBrowserSettings',
  'GetDashboardStats',
  'GetInterceptor',
  'GetLaunchServerInfo',
  'GetLicenseStatus',
  'GetLogLevel',
  'GetMemoryStats',
  'GetRunningInstances',
  'ListGroups',
  'MoveInstancesToGroup',
  'OpenCorePath',
  'OpenUserDataDir',
  'QuitAppOnly',
  'RedeemCDKey',
  'RedeemGithubStar',
  'ReloadConfig',
  'SaveBrowserProxies',
  'SaveBrowserSettings',
  'SetLogLevel',
  'StartInstance',
  'StartInstanceWithParams',
  'TestProxyConnectivity',
  'TestProxyRealConnectivity',
  'TriggerGC',
  'UpdateGroup',
  'ValidateProxyConfig',
] as const

const appBinding: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
for (const method of appMethodNames) {
  appBinding[method] = (...args: unknown[]) => ipcRenderer.invoke('go:call', method, args)
}

contextBridge.exposeInMainWorld('go', {
  main: {
    App: appBinding,
  },
})

contextBridge.exposeInMainWorld('runtime', buildRuntime())

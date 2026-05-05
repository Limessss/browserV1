/**
 * go:call 真实实现：SQLite 就绪时走 browser-data / browser-writes，否则回退 go-mock。
 */
import { app } from 'electron'
import type { Database } from 'sql.js'
import {
  getDashboardStats,
  getProfileFrontendById,
  listAllTags,
  listCores,
  listGroupsWithCount,
  listProfiles,
  listProfilesByTag,
  listProxies,
  listProxiesByGroup,
  listProxyGroups,
} from '../internal/browser-data'
import { listBookmarksResolved } from '../internal/bookmark-list-resolve'
import { browserCoreScanDisk } from '../internal/core-scan'
import {
  browserCoreDelete,
  browserCoreExtendedInfo,
  browserCoreSave,
  browserCoreSetDefault,
} from '../internal/core-writes'
import { validateCorePath } from '../internal/core-validate'
import { startBrowserCoreDownload } from '../internal/core-download-service'
import { saveBrowserProxies } from '../internal/proxy-pool-writes'
import {
  bookmarkReset,
  bookmarkSave,
  browserProfileBatchRemoveTags,
  browserProfileBatchSetTags,
  browserProfileCopy,
  browserProfileCreate,
  browserProfileDelete,
  browserProfileGetCode,
  browserProfileRegenerateCode,
  browserProfileSetCode,
  browserProfileSetKeywords,
  browserProfileUpdate,
  browserRenameTag,
  createGroup,
  deleteGroup,
  moveInstancesToGroup,
  updateGroup,
} from '../internal/browser-writes'
import {
  loadBrowserSettingsMerged,
  loadLinkeooErpConfig,
  reloadAppConfig,
  saveBrowserSettings,
  saveLinkeooErpConfig,
} from '../internal/app-config-store'
import {
  browserSnapshotCreate,
  browserSnapshotDelete,
  browserSnapshotList,
  browserSnapshotRestore,
} from '../internal/snapshot-service'
import {
  clearAppLogs,
  getAppLogs,
  getDefaultInterceptor,
  getLicenseStatus,
  getLogLevel,
  getMemoryStats,
  setLogLevel,
  triggerGc,
} from '../internal/app-runtime-service'
import { validateProxyConfig } from '../internal/proxy-validate'
import { browserProxyFetchClashByURL } from '../internal/clash-fetch-service'
import { fetchRemoteAuthorProfile } from '../internal/remote-profile-fetch'
import { generateCdKeys, redeemCdKey, redeemGithubStar } from '../internal/license-service'
import { mergeRuntimeIntoProfileRecord } from '../internal/browser-runtime-store'
import {
  browserClearCookies,
  browserExportCookies,
  browserGetCookies,
  browserInstanceGetTabs,
  browserInstanceOpenUrl,
  browserInstanceRestart,
  browserInstanceStart,
  browserInstanceStartByCode,
  browserInstanceStartWithParams,
  browserInstanceStop,
  getRunningInstancesList,
} from '../internal/browser-instance-service'
import {
  backupExportPackage,
  backupGetManifestTemplate,
  backupGetScopeDefinition,
  backupImportPackage,
  backupInitializeSystem,
} from '../internal/backup-service'
import {
  browserProxyBatchCheckIPHealth,
  browserProxyBatchTestSpeed,
  browserProxyCheckIPHealth,
  browserProxyTestSpeed,
  testProxyConnectivity,
  testProxyRealConnectivity,
} from '../internal/proxy-connectivity-service'
import { buildGetLaunchServerInfo } from '../internal/launch-http-server'
import {
  killPlaywrightScriptRun,
  listPlaywrightScripts,
  runPlaywrightScript,
} from '../internal/playwright-scripts-service'
import { getSqlite } from '../internal/database/sqlite-store'
import { openCorePathInExplorer, openUserDataDir } from '../internal/fs-open'
import { invokeGoMock } from './go-mock'

function appVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.1.0'
  }
}

function dispatch(db: Database, method: string, args: unknown[]): unknown | null {
  switch (method) {
    case 'BrowserProfileList':
      return listProfiles(db)
    case 'BrowserProfileListByTag':
      return listProfilesByTag(db, String(args[0] ?? ''))
    case 'BrowserGetAllTags':
      return listAllTags(db)
    case 'BrowserProxyList':
      return listProxies(db)
    case 'BrowserProxyListByGroup':
      return listProxiesByGroup(db, String(args[0] ?? ''))
    case 'BrowserProxyListGroups':
      return listProxyGroups(db)
    case 'ListGroups':
      return listGroupsWithCount(db)
    case 'BrowserCoreList':
      return listCores(db)
    case 'BrowserCoreScan':
      return browserCoreScanDisk(db)
    case 'BrowserCoreExtendedInfo':
      return browserCoreExtendedInfo(db)
    case 'BookmarkList':
      return listBookmarksResolved(db)
    case 'GetDashboardStats':
      return getDashboardStats(db, appVersion())
    case 'GetRunningInstances':
      return getRunningInstancesList(db)

    case 'BrowserProfileCreate':
      return browserProfileCreate(db, args[0])
    case 'BrowserProfileUpdate':
      return browserProfileUpdate(db, String(args[0] ?? ''), args[1])
    case 'BrowserProfileDelete':
      browserProfileDelete(db, String(args[0] ?? ''))
      return undefined
    case 'BrowserProfileCopy':
      return browserProfileCopy(db, String(args[0] ?? ''), String(args[1] ?? ''))
    case 'BrowserProfileSetKeywords':
      return browserProfileSetKeywords(db, String(args[0] ?? ''), args[1])
    case 'BrowserProfileBatchSetTags':
      browserProfileBatchSetTags(db, args[0], args[1], args[2])
      return undefined
    case 'BrowserProfileBatchRemoveTags':
      browserProfileBatchRemoveTags(db, args[0], args[1])
      return undefined
    case 'BrowserRenameTag':
      browserRenameTag(db, String(args[0] ?? ''), String(args[1] ?? ''))
      return undefined
    case 'BrowserProfileGetCode':
      return browserProfileGetCode(db, String(args[0] ?? ''))
    case 'BrowserProfileSetCode':
      return browserProfileSetCode(db, String(args[0] ?? ''), String(args[1] ?? ''))
    case 'BrowserProfileRegenerateCode':
      return browserProfileRegenerateCode(db, String(args[0] ?? ''))

    case 'CreateGroup':
      return createGroup(db, args[0])
    case 'UpdateGroup':
      return updateGroup(db, String(args[0] ?? ''), args[1])
    case 'DeleteGroup':
      deleteGroup(db, String(args[0] ?? ''))
      return undefined
    case 'MoveInstancesToGroup':
      moveInstancesToGroup(db, args[0], String(args[1] ?? ''))
      return undefined

    case 'BookmarkSave':
      bookmarkSave(db, args[0])
      return undefined
    case 'BookmarkReset':
      bookmarkReset(db)
      return undefined

    case 'SaveBrowserProxies':
      saveBrowserProxies(db, args[0])
      return undefined
    case 'BrowserCoreSave':
      browserCoreSave(db, args[0])
      return undefined
    case 'BrowserCoreDelete':
      browserCoreDelete(db, String(args[0] ?? ''))
      return undefined
    case 'BrowserCoreSetDefault':
      browserCoreSetDefault(db, String(args[0] ?? ''))
      return undefined

    case 'BrowserSnapshotCreate':
      return browserSnapshotCreate(db, String(args[0] ?? ''), String(args[1] ?? ''))
    case 'BrowserSnapshotList':
      return browserSnapshotList(String(args[0] ?? ''))
    case 'BrowserSnapshotRestore':
      browserSnapshotRestore(db, String(args[0] ?? ''), String(args[1] ?? ''))
      return undefined
    case 'BrowserSnapshotDelete':
      browserSnapshotDelete(String(args[0] ?? ''), String(args[1] ?? ''))
      return undefined

    case 'BrowserInstanceStatus': {
      const p = getProfileFrontendById(db, String(args[0] ?? ''))
      if (!p) {
        throw new Error(`实例不存在: ${String(args[0] ?? '')}`)
      }
      mergeRuntimeIntoProfileRecord(p)
      return p
    }

    default:
      return null
  }
}

export async function invokeGoCall(method: string, args: unknown[]): Promise<unknown> {
  if (method === 'BrowserCoreValidate') {
    try {
      return validateCorePath(String(args[0] ?? ''))
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'GetBrowserSettings') {
    try {
      return loadBrowserSettingsMerged()
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'SaveBrowserSettings') {
    try {
      saveBrowserSettings(args[0])
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'GetLinkeooErpConfig') {
    try {
      return loadLinkeooErpConfig()
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'SaveLinkeooErpConfig') {
    try {
      const o = (args[0] ?? {}) as Record<string, unknown>
      saveLinkeooErpConfig({
        baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : undefined,
        apiKey: typeof o.apiKey === 'string' ? o.apiKey : undefined,
      })
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'ReloadConfig') {
    reloadAppConfig()
    return undefined
  }
  if (method === 'GetAppConfig') {
    return {
      name: app.getName(),
      version: app.getVersion(),
    }
  }
  if (method === 'GetLaunchServerInfo') {
    return buildGetLaunchServerInfo()
  }
  if (method === 'ListPlaywrightScripts') {
    try {
      return await listPlaywrightScripts()
    } catch (e) {
      console.error('[go-call]', method, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }
  if (method === 'RunPlaywrightScript') {
    try {
      return await runPlaywrightScript(String(args[0] ?? ''), args[1])
    } catch (e) {
      console.error('[go-call]', method, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }
  if (method === 'KillPlaywrightScriptRun') {
    try {
      return killPlaywrightScriptRun(String(args[0] ?? ''))
    } catch (e) {
      console.error('[go-call]', method, e)
      throw e instanceof Error ? e : new Error(String(e))
    }
  }
  if (method === 'BackupGetScopeDefinition') {
    return backupGetScopeDefinition()
  }
  if (method === 'BackupGetManifestTemplate') {
    return backupGetManifestTemplate()
  }
  if (method === 'BackupExportPackage') {
    try {
      return await backupExportPackage()
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'OpenUserDataDir') {
    try {
      await openUserDataDir(String(args[0] ?? ''))
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  if (method === 'OpenCorePath') {
    try {
      await openCorePathInExplorer(String(args[0] ?? ''))
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'ValidateProxyConfig') {
    try {
      return validateProxyConfig(getSqlite() ?? null, String(args[0] ?? ''), String(args[1] ?? ''))
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'GetMemoryStats') {
    return getMemoryStats()
  }
  if (method === 'TriggerGC') {
    triggerGc()
    return undefined
  }
  if (method === 'GetInterceptor') {
    return getDefaultInterceptor()
  }
  if (method === 'GetAppLogs') {
    return getAppLogs()
  }
  if (method === 'ClearAppLogs') {
    clearAppLogs()
    return undefined
  }
  if (method === 'GetLogLevel') {
    return getLogLevel()
  }
  if (method === 'SetLogLevel') {
    setLogLevel(String(args[0] ?? ''))
    return undefined
  }
  if (method === 'GetLicenseStatus') {
    return getLicenseStatus(getSqlite() ?? null)
  }

  if (method === 'BrowserProxyFetchClashByURL') {
    try {
      return await browserProxyFetchClashByURL(String(args[0] ?? ''))
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'FetchRemoteAuthorProfile') {
    try {
      return await fetchRemoteAuthorProfile(String(args[0] ?? ''), Number(args[1] ?? 3000))
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'RedeemCDKey') {
    try {
      redeemCdKey(String(args[0] ?? ''))
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'RedeemGithubStar') {
    try {
      redeemGithubStar()
      return undefined
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  if (method === 'GenerateCDKeys') {
    try {
      return generateCdKeys(Number(args[0] ?? 0))
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }

  const db = getSqlite()
  if (db) {
    if (method === 'TestProxyConnectivity') {
      try {
        return await testProxyConnectivity(db, String(args[0] ?? ''), String(args[1] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'TestProxyRealConnectivity') {
      try {
        return await testProxyRealConnectivity(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserProxyTestSpeed') {
      try {
        return await browserProxyTestSpeed(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserProxyBatchTestSpeed') {
      try {
        const ids = Array.isArray(args[0]) ? (args[0] as unknown[]) : []
        return await browserProxyBatchTestSpeed(
          db,
          ids.map((x) => String(x ?? '')),
          Number(args[1] ?? 20),
        )
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserProxyCheckIPHealth') {
      try {
        return await browserProxyCheckIPHealth(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserProxyBatchCheckIPHealth') {
      try {
        const ids = Array.isArray(args[0]) ? (args[0] as unknown[]) : []
        return await browserProxyBatchCheckIPHealth(
          db,
          ids.map((x) => String(x ?? '')),
          Number(args[1] ?? 10),
        )
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }

    if (method === 'BrowserCoreDownload') {
      startBrowserCoreDownload(
        db,
        String(args[0] ?? ''),
        String(args[1] ?? ''),
        String(args[2] ?? ''),
      )
      return undefined
    }
    if (method === 'BrowserInstanceStartWithParams') {
      try {
        return await browserInstanceStartWithParams(
          db,
          String(args[0] ?? ''),
          args[1] ?? [],
          args[2] ?? [],
          args[3] ?? false,
        )
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'StartInstance') {
      try {
        return await browserInstanceStart(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'StartInstanceWithParams') {
      try {
        const p = (args[1] ?? {}) as Record<string, unknown>
        return await browserInstanceStartWithParams(
          db,
          String(args[0] ?? ''),
          p.launchArgs,
          p.startUrls,
          p.skipDefaultStartUrls,
        )
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BackupImportPackage') {
      try {
        return await backupImportPackage(Boolean(args[0]))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BackupInitializeSystem') {
      try {
        return await backupInitializeSystem()
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }

    if (method === 'BrowserInstanceStart') {
      try {
        return await browserInstanceStart(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserInstanceStop') {
      try {
        return await browserInstanceStop(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserInstanceRestart') {
      try {
        return await browserInstanceRestart(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserInstanceStartByCode') {
      try {
        return await browserInstanceStartByCode(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserInstanceOpenUrl') {
      try {
        return await browserInstanceOpenUrl(db, String(args[0] ?? ''), String(args[1] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserInstanceGetTabs') {
      try {
        return await browserInstanceGetTabs(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserGetCookies') {
      try {
        return await browserGetCookies(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserClearCookies') {
      try {
        await browserClearCookies(db, String(args[0] ?? ''))
        return undefined
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }
    if (method === 'BrowserExportCookies') {
      try {
        return await browserExportCookies(db, String(args[0] ?? ''))
      } catch (e) {
        console.error('[go-call]', method, e)
        if (e instanceof Error) {
          throw e
        }
        throw new Error(String(e))
      }
    }

    try {
      const direct = dispatch(db, method, args)
      if (direct !== null) {
        return direct
      }
    } catch (e) {
      console.error('[go-call]', method, e)
      if (e instanceof Error) {
        throw e
      }
      throw new Error(String(e))
    }
  }
  return invokeGoMock(method, args)
}

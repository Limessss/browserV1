// Settings 模块 API
import type { AppSettings } from './types'
import { defaultSettings } from './types'

// 本地存储 key
const SETTINGS_KEY = 'app_settings'

const getBindings = async () => {
  try {
    return await import('../../wailsjs/go/main/App')
  } catch {
    return null
  }
}

export interface BackupActionResult {
  cancelled?: boolean
  message?: string
  zipPath?: string
  resetFirst?: boolean
  imported?: number
  skipped?: number
  conflicts?: number
  partial?: boolean
  componentTotal?: number
  componentSuccess?: number
  componentFailed?: number
  failedComponents?: Array<{
    componentId?: string
    componentName?: string
    error?: string
  }>
}

// 获取设置
export async function fetchSettings(): Promise<AppSettings> {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY)
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) }
    }
  } catch (error) {
    console.error('Failed to load settings:', error)
  }
  return defaultSettings
}

// 保存设置
export async function saveSettings(settings: AppSettings): Promise<boolean> {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    return true
  } catch (error) {
    console.error('Failed to save settings:', error)
    return false
  }
}

// 重置设置
export async function resetSettings(): Promise<AppSettings> {
  localStorage.removeItem(SETTINGS_KEY)
  return defaultSettings
}

export async function initializeSystemData(): Promise<BackupActionResult> {
  const bindings: any = await getBindings()
  if (!bindings?.BackupInitializeSystem) {
    return { cancelled: false, message: '当前环境不支持后端初始化接口' }
  }
  return (await bindings.BackupInitializeSystem()) || {}
}

export async function exportSystemConfig(): Promise<BackupActionResult> {
  const bindings: any = await getBindings()
  if (!bindings?.BackupExportPackage) {
    return { cancelled: false, message: '当前环境不支持后端导出接口' }
  }
  return (await bindings.BackupExportPackage()) || {}
}

export async function importSystemConfig(resetFirst: boolean): Promise<BackupActionResult> {
  const bindings: any = await getBindings()
  if (!bindings?.BackupImportPackage) {
    return { cancelled: false, message: '当前环境不支持后端加载接口' }
  }
  return (await bindings.BackupImportPackage(resetFirst)) || {}
}

export interface LinkeooErpConfig {
  baseUrl: string
  apiKey: string
}

/** 链氪 ERP（config.yaml），供系统设置与脚本经 Launch HTTP 读取 */
export async function fetchLinkeooErpConfig(): Promise<LinkeooErpConfig> {
  const bindings: any = await getBindings()
  if (!bindings?.GetLinkeooErpConfig) {
    return { baseUrl: 'https://api.linkeoo.com', apiKey: '' }
  }
  const c = (await bindings.GetLinkeooErpConfig()) as Partial<LinkeooErpConfig>
  return {
    baseUrl: String(c?.baseUrl ?? 'https://api.linkeoo.com').trim() || 'https://api.linkeoo.com',
    apiKey: String(c?.apiKey ?? ''),
  }
}

/** `apiKey` 不传或空字符串：保留已保存的密钥（仅更新 host） */
export async function saveLinkeooErpConfig(payload: { baseUrl: string; apiKey?: string }): Promise<boolean> {
  const bindings: any = await getBindings()
  if (!bindings?.SaveLinkeooErpConfig) {
    return false
  }
  await bindings.SaveLinkeooErpConfig(payload)
  return true
}

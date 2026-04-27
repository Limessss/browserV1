/**
 * 应用数据目录解析（对齐 Ant-Browser/backend/internal/apppath）
 */
import { app } from 'electron'
import { join } from 'node:path'

export function getUserDataRoot(): string {
  return app.getPath('userData')
}

export function resolveDataPath(...segments: string[]): string {
  return join(getUserDataRoot(), ...segments)
}

/**
 * ForceQuit：退出前停止实例与 Launch 服务（对齐 Ant-Browser ForceQuit + stopRuntimeServices 中的浏览器/Launch 部分）。
 */
import { browserInstanceStop } from './browser-instance-service'
import { listRunningProfileIds } from './browser-runtime-store'
import { persistSqlite, getSqlite } from './database/sqlite-store'
import { stopLaunchHttpServer } from './launch-http-server'
import { stopAllProxyBridges } from './proxy-bridge-service'
import { killResidualRuntimeProcesses } from './residual-process-cleanup'

let cleanupPromise: Promise<void> | null = null

export async function forceQuitCleanup(): Promise<void> {
  if (cleanupPromise) {
    return cleanupPromise
  }
  cleanupPromise = (async () => {
    const db = getSqlite()
    if (db) {
      const ids = [...listRunningProfileIds()]
      for (const id of ids) {
        try {
          await browserInstanceStop(db, id)
        } catch (err) {
          console.error('[quit] stop instance', id, err)
        }
      }
      persistSqlite()
    }
    await stopLaunchHttpServer()
    await stopAllProxyBridges()
    try {
      await killResidualRuntimeProcesses(process.cwd())
    } catch (err) {
      console.error('[quit] residual cleanup failed', err)
    }
  })()
  return cleanupPromise
}

/**
 * 存储层组合根：进程级单例（Worker 每页只起一个），
 * 以及 UI 用的孤儿扫描辅助。
 */

import { StorageAdapter } from './adapter'
import { SessionStore } from './sessionStore'
import { scanOrphans } from './cleanup'
import type { OrphanReport } from './cleanup'

let adapter: StorageAdapter | null = null
let store: SessionStore | null = null

export function getStorageAdapter(): StorageAdapter {
  adapter ??= new StorageAdapter()
  return adapter
}

export function getSessionStore(): SessionStore {
  store ??= new SessionStore()
  return store
}

/** 启动/进入设置页时扫描孤儿数据（无 manifest 或超 30 天） */
export async function findOrphans(): Promise<OrphanReport> {
  const [dirs, records] = await Promise.all([
    getStorageAdapter().listSessions(),
    getSessionStore().list(),
  ])
  return scanOrphans(dirs, records)
}

export type { OrphanReport, OrphanSession } from './cleanup'

/** 人类可读字节数（iOS estimate() 恒 0，统一用此格式化） */
export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${Math.max(1, n)} B`
}

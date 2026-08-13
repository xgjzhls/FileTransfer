/**
 * 孤儿数据扫描与清理（SPEC §4）。
 *
 * 孤儿 = OPFS 中存在会话目录，但 IndexedDB 无 manifest（no-manifest）
 * 或 manifest 超过 30 天未活跃（expired）。中断的传输会遗留这类数据。
 */

import type { SessionDirInfo } from './types'
import type { SessionManifest } from './sessionStore'

export const ORPHAN_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type OrphanReason = 'no-manifest' | 'expired'

export interface OrphanSession {
  sessionId: string
  bytes: number
  reason: OrphanReason
  record?: SessionManifest
}

export interface OrphanReport {
  orphans: OrphanSession[]
  totalBytes: number
}

/** 存储源抽象：StorageEngine 与 Worker 适配器都满足 */
export interface SessionSource {
  listSessions(): Promise<SessionDirInfo[]>
  deleteSession(sessionId: string): Promise<void>
  deleteAll(): Promise<void>
}

/** 纯函数：目录清单 + manifest 记录 → 孤儿报告（now 可注入以便测试） */
export function scanOrphans(
  dirs: SessionDirInfo[],
  records: SessionManifest[],
  now: number = Date.now(),
): OrphanReport {
  const byId = new Map(records.map((r) => [r.sessionId, r]))
  const orphans: OrphanSession[] = []
  for (const dir of dirs) {
    const record = byId.get(dir.sessionId)
    if (!record) {
      orphans.push({ sessionId: dir.sessionId, bytes: dir.bytes, reason: 'no-manifest' })
    } else if (now - record.lastActiveAt > ORPHAN_AGE_MS) {
      orphans.push({ sessionId: dir.sessionId, bytes: dir.bytes, reason: 'expired', record })
    }
  }
  return { orphans, totalBytes: orphans.reduce((sum, o) => sum + o.bytes, 0) }
}

/** 删除指定孤儿：OPFS 目录 + manifest 记录 */
export async function cleanupOrphans(
  source: SessionSource,
  store: { delete(sessionId: string): Promise<void> },
  sessionIds: string[],
): Promise<void> {
  for (const id of sessionIds) {
    await source.deleteSession(id)
    await store.delete(id)
  }
}

/** 设置页「清除全部数据」：整个 OPFS 根 + IndexedDB（幂等） */
export async function clearAllData(
  source: SessionSource,
  store: { clear(): Promise<void> },
): Promise<void> {
  await source.deleteAll()
  await store.clear()
}

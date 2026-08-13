import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { MemorySyncFs } from './memorySyncFs'
import { StorageEngine } from './engine'
import { SessionStore } from './sessionStore'
import { ORPHAN_AGE_MS, cleanupOrphans, clearAllData, scanOrphans } from './cleanup'
import type { SessionManifest } from './sessionStore'

const NOW = 1_800_000_000_000

function record(sessionId: string, lastActiveAt: number): SessionManifest {
  return { sessionId, createdAt: lastActiveAt, lastActiveAt, files: [] }
}

describe('scanOrphans — 孤儿判定', () => {
  it('有目录无 manifest → no-manifest 孤儿', () => {
    const report = scanOrphans([{ sessionId: 'a', bytes: 10 }], [], NOW)
    expect(report.orphans).toEqual([{ sessionId: 'a', bytes: 10, reason: 'no-manifest' }])
  })

  it('lastActiveAt 超 30 天 → expired 孤儿', () => {
    const stale = record('a', NOW - ORPHAN_AGE_MS - 1000)
    const report = scanOrphans([{ sessionId: 'a', bytes: 20 }], [stale], NOW)
    expect(report.orphans).toEqual([
      { sessionId: 'a', bytes: 20, reason: 'expired', record: stale },
    ])
  })

  it('有 manifest 且未过期 → 非孤儿', () => {
    const fresh = record('a', NOW - 1000)
    const report = scanOrphans([{ sessionId: 'a', bytes: 20 }], [fresh], NOW)
    expect(report.orphans).toEqual([])
  })

  it('恰好 30 天前活跃不视为过期', () => {
    const report = scanOrphans(
      [{ sessionId: 'a', bytes: 1 }],
      [record('a', NOW - ORPHAN_AGE_MS)],
      NOW,
    )
    expect(report.orphans).toEqual([])
  })

  it('totalBytes 只统计孤儿', () => {
    const report = scanOrphans(
      [
        { sessionId: 'orphan1', bytes: 100 },
        { sessionId: 'orphan2', bytes: 50 },
        { sessionId: 'fresh', bytes: 9999 },
      ],
      [record('fresh', NOW)],
      NOW,
    )
    expect(report.totalBytes).toBe(150)
    expect(report.orphans.map((o) => o.sessionId)).toEqual(['orphan1', 'orphan2'])
  })
})

describe('清理动作', () => {
  async function setupStorage() {
    const fs = new MemorySyncFs()
    const engine = new StorageEngine(fs)
    const store = new SessionStore(new IDBFactory())
    return { engine, store }
  }

  it('cleanupOrphans 删除 OPFS 目录与 manifest 记录', async () => {
    const { engine, store } = await setupStorage()
    await engine.openPart('orphan', 0, 0).then(async (w) => {
      engine.writeChunk(w, 0, new TextEncoder().encode('data'))
      engine.closeWriter(w)
    })
    await store.upsert(record('orphan', NOW - ORPHAN_AGE_MS - 1))

    await cleanupOrphans(engine, store, ['orphan'])

    expect(await engine.listSessions()).toEqual([])
    expect(await store.list()).toEqual([])
  })

  it('clearAllData 清空 OPFS 与 manifest，且幂等', async () => {
    const { engine, store } = await setupStorage()
    await engine.openPart('s', 0, 0).then(async (w) => {
      engine.writeChunk(w, 0, new TextEncoder().encode('data'))
      engine.closeWriter(w)
    })
    await store.upsert(record('s', NOW))

    await clearAllData(engine, store)
    expect(await engine.listSessions()).toEqual([])
    expect(await store.list()).toEqual([])

    await clearAllData(engine, store)
    expect(await engine.listSessions()).toEqual([])
    expect(await store.list()).toEqual([])
  })
})

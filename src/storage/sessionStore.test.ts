import { describe, expect, it } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { SessionStore } from './sessionStore'

function setup() {
  return new SessionStore(new IDBFactory())
}

const RECORD = {
  sessionId: 'sess-1',
  createdAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  files: [{ fileId: 0, name: 'a.mov', size: 100, partCount: 2 }],
}

describe('SessionStore — IndexedDB 会话 manifest', () => {
  it('upsert 后 list 返回记录', async () => {
    const store = setup()
    await store.upsert(RECORD)
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0]).toEqual(RECORD)
  })

  it('同 sessionId 重复 upsert 覆盖而非新增', async () => {
    const store = setup()
    await store.upsert(RECORD)
    await store.upsert({ ...RECORD, lastActiveAt: 1_700_100_000_000 })
    const all = await store.list()
    expect(all).toHaveLength(1)
    expect(all[0].lastActiveAt).toBe(1_700_100_000_000)
  })

  it('get 返回记录，不存在时返回 undefined', async () => {
    const store = setup()
    await store.upsert(RECORD)
    await expect(store.get('sess-1')).resolves.toEqual(RECORD)
    await expect(store.get('nope')).resolves.toBeUndefined()
  })

  it('delete 移除指定记录，不影响其他', async () => {
    const store = setup()
    await store.upsert(RECORD)
    await store.upsert({ ...RECORD, sessionId: 'sess-2' })
    await store.delete('sess-1')
    const all = await store.list()
    expect(all.map((r) => r.sessionId)).toEqual(['sess-2'])
  })

  it('clear 清空全部', async () => {
    const store = setup()
    await store.upsert(RECORD)
    await store.upsert({ ...RECORD, sessionId: 'sess-2' })
    await store.clear()
    expect(await store.list()).toEqual([])
  })
})

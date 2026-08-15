import { describe, expect, it } from 'vitest'
import {
  clearLastRoom,
  getLastRoom,
  getOrCreateDeviceId,
  setLastRoom,
  type StorageLike,
} from './session'

/** 内存版 localStorage（node 测试环境无 localStorage） */
function memoryStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('session — 房间会话持久化（T12，SPEC §5.4 / ADR-0006）', () => {
  describe('getOrCreateDeviceId（设备身份稳定）', () => {
    it('首次调用生成并持久化，后续调用返回同一 id', () => {
      const storage = memoryStorage()
      const a = getOrCreateDeviceId(storage)
      const b = getOrCreateDeviceId(storage)
      expect(a).toBe(b)
      expect(a).toMatch(/^[0-9a-f-]{36}$/i)
    })

    it('不同存储各自独立（换浏览器/换设备互不影响）', () => {
      const a = getOrCreateDeviceId(memoryStorage())
      const b = getOrCreateDeviceId(memoryStorage())
      expect(a).not.toBe(b)
    })

    it('已有持久化 id 时直接复用（重载后同一身份重连）', () => {
      const storage = memoryStorage()
      storage.setItem('lt.deviceId', 'persisted-id-123')
      expect(getOrCreateDeviceId(storage)).toBe('persisted-id-123')
    })
  })

  describe('lt.lastRoom（记住上次房间）', () => {
    it('默认无房间', () => {
      expect(getLastRoom(memoryStorage())).toBe('')
    })

    it('setLastRoom 后 getLastRoom 读回', () => {
      const storage = memoryStorage()
      setLastRoom('K7Q2', storage)
      expect(getLastRoom(storage)).toBe('K7Q2')
      // 手动输入新码加入 → 覆盖旧房间
      setLastRoom('AB3C', storage)
      expect(getLastRoom(storage)).toBe('AB3C')
    })

    it('clearLastRoom 清除（退出房间）', () => {
      const storage = memoryStorage()
      setLastRoom('K7Q2', storage)
      clearLastRoom(storage)
      expect(getLastRoom(storage)).toBe('')
    })
  })
})

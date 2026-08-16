/**
 * 局域网可见性开关单测（T06，SPEC §5.5 / ADR-0009 决策 2）——
 * 默认开、'0'=关、持久化重启保持、注入 storage（模式同 rooms/session.test.ts）。
 */
import { describe, expect, it } from 'vitest'
import { getLanVisible, setLanVisible, LAN_VISIBLE_KEY } from './visibility'
import type { StorageLike } from '../rooms/session'

function memStorage(init: Record<string, string> = {}): StorageLike {
  const map = new Map(Object.entries(init))
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

describe('getLanVisible', () => {
  it('未设置时默认开', () => {
    expect(getLanVisible(memStorage())).toBe(true)
  })

  it("存储 '0' = 关，'1' = 开", () => {
    expect(getLanVisible(memStorage({ [LAN_VISIBLE_KEY]: '0' }))).toBe(false)
    expect(getLanVisible(memStorage({ [LAN_VISIBLE_KEY]: '1' }))).toBe(true)
  })

  it('异常残留值（非 0）按开处理（防御性）', () => {
    expect(getLanVisible(memStorage({ [LAN_VISIBLE_KEY]: 'true' }))).toBe(true)
    expect(getLanVisible(memStorage({ [LAN_VISIBLE_KEY]: '' }))).toBe(true)
  })
})

describe('setLanVisible', () => {
  it('写入后立即读回一致', () => {
    const s = memStorage()
    setLanVisible(false, s)
    expect(getLanVisible(s)).toBe(false)
    setLanVisible(true, s)
    expect(getLanVisible(s)).toBe(true)
  })

  it('重启保持：新 storage 视图读同一底层（持久化语义）', () => {
    const s = memStorage()
    setLanVisible(false, s)
    // 模拟重启：另一实例读同一存储
    const reloaded = memStorage({
      [LAN_VISIBLE_KEY]: s.getItem(LAN_VISIBLE_KEY) ?? '1',
    })
    expect(getLanVisible(reloaded)).toBe(false)
  })

  it("落盘值为 '0'/'1'", () => {
    const s = memStorage()
    setLanVisible(false, s)
    expect(s.getItem(LAN_VISIBLE_KEY)).toBe('0')
    setLanVisible(true, s)
    expect(s.getItem(LAN_VISIBLE_KEY)).toBe('1')
  })
})

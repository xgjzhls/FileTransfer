/**
 * capacityCheck —— 容量检查编排（SPEC §4）：estimate 优先，iOS 降级探测，
 * 全部失败不阻断。
 */

import { describe, expect, it } from 'vitest'
import { checkIncomingCapacity, probeResultFromMessage, PROBE_CAP_BYTES } from './capacityCheck'

const TARGET = 300 * 1024 * 1024 // 300 MiB

describe('probeResultFromMessage — worker 消息解析（失败点=结果，环境错误=抛错）', () => {
  it('无 error：返回可用字节 + 探测上限', () => {
    expect(probeResultFromMessage({ availableBytes: 123, error: null })).toEqual({
      availableBytes: 123,
      probeCapBytes: PROBE_CAP_BYTES,
    })
  })

  it('写失败（QuotaExceeded，error 但 availableBytes > 0）：仍 resolve（失败点即真实上限）', () => {
    // worker 修复后不会为此设 error，但保守双保险：不吞掉可用下限
    expect(probeResultFromMessage({ availableBytes: 448 * 1024 ** 2, error: 'QuotaExceededError' })).toEqual({
      availableBytes: 448 * 1024 ** 2,
      probeCapBytes: PROBE_CAP_BYTES,
    })
  })

  it('环境错误（error 且 0 字节，OPFS 不可用）：抛错', () => {
    expect(() => probeResultFromMessage({ availableBytes: 0, error: 'OPFS unavailable' })).toThrow(
      'OPFS unavailable',
    )
  })
})

describe('checkIncomingCapacity — 编排策略', () => {
  it('estimate 可靠（桌面）：直接用 quota-usage，不探测', async () => {
    let probed = false
    const r = await checkIncomingCapacity(TARGET, {
      estimate: async () => ({ usage: 1e9, quota: 10e9 }),
      runProbe: async () => {
        probed = true
        return { availableBytes: TARGET, probeCapBytes: TARGET }
      },
    })
    expect(probed).toBe(false)
    expect(r.ok).toBe(true)
    expect(r.message).toContain('充足')
  })

  it('estimate 不可靠（iOS 恒 0）：降级探测', async () => {
    let probed = false
    const r = await checkIncomingCapacity(TARGET, {
      estimate: async () => ({ usage: 0, quota: 0 }),
      runProbe: async () => {
        probed = true
        return { availableBytes: 100 * 1024 ** 2, probeCapBytes: TARGET } // 100 MiB < 300 MiB
      },
    })
    expect(probed).toBe(true)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('不足')
  })

  it('estimate 抛异常：降级探测', async () => {
    let probed = false
    const r = await checkIncomingCapacity(TARGET, {
      estimate: async () => {
        throw new Error('estimate unavailable')
      },
      runProbe: async () => {
        probed = true
        return { availableBytes: TARGET, probeCapBytes: TARGET }
      },
    })
    expect(probed).toBe(true)
    expect(r.ok).toBe(true)
  })

  it('estimate 不可用且探测抛错（OPFS 不可用）：不阻断，提示无法预检', async () => {
    const r = await checkIncomingCapacity(TARGET, {
      estimate: async () => ({ usage: 0, quota: 0 }),
      runProbe: async () => {
        throw new Error('OPFS unavailable')
      },
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('无法预检')
  })

  it('大文件目标超出探测上限（iOS）：ok + 已验证下限提示', async () => {
    const big = 5 * 1024 ** 3 // 5 GiB > 2 GiB cap
    const r = await checkIncomingCapacity(big, {
      estimate: async () => ({ usage: 0, quota: 0 }),
      runProbe: async () => ({ availableBytes: PROBE_CAP_BYTES, probeCapBytes: PROBE_CAP_BYTES }),
    })
    expect(r.ok).toBe(true)
    expect(r.message).toContain('无法精确预检')
  })

  it('target ≤ 0（空清单）：跳过检查，直接 ok', async () => {
    let probed = false
    const r = await checkIncomingCapacity(0, {
      estimate: async () => {
        throw new Error('should not be called')
      },
      runProbe: async () => {
        probed = true
        return { availableBytes: 0, probeCapBytes: 0 }
      },
    })
    expect(probed).toBe(false)
    expect(r).toEqual({ ok: true, level: 'ok', message: '' })
  })
})

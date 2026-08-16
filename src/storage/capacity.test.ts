/**
 * capacity —— 传输前容量预警（SPEC §4 [v2] / CONTEXT 关键风险）。
 *
 * iOS `navigator.storage.estimate()` 恒返回 0（spike 实测），桌面返回真实
 * quota/usage。容量判断分两级：estimate 可靠时直接用（quota - usage）；
 * 不可靠时（iOS）用 OPFS 写探测（步进写 probe 文件到目标大小或失败点）。
 * 本模块为纯逻辑（可注入 estimate / write），浏览器 IO 在 capacityProbe
 * worker 中实现 —— 单测不接触浏览器。
 */

import { describe, expect, it } from 'vitest'
import {
  usableFromEstimate,
  planProbeBytes,
  probeAvailable,
  interpretCapacity,
  fmtBytes,
} from './capacity'

describe('usableFromEstimate — estimate() 可用容量（处理 iOS 恒 0）', () => {
  it('正常值：可用 = quota - usage', () => {
    expect(usableFromEstimate({ usage: 1e9, quota: 10e9 })).toEqual({
      availableBytes: 9e9,
      reliable: true,
    })
  })

  it('iOS 恒 0（quota 0 / usage 0）：标记不可靠', () => {
    expect(usableFromEstimate({ usage: 0, quota: 0 })).toEqual({ availableBytes: 0, reliable: false })
    expect(usableFromEstimate({ usage: 5, quota: 0 })).toEqual({ availableBytes: 0, reliable: false })
  })

  it('null / 缺字段：不可靠', () => {
    expect(usableFromEstimate(null)).toEqual({ availableBytes: 0, reliable: false })
    expect(usableFromEstimate(undefined)).toEqual({ availableBytes: 0, reliable: false })
    expect(usableFromEstimate({})).toEqual({ availableBytes: 0, reliable: false })
  })

  it('usage 超过 quota（异常）：可用按 0 计', () => {
    expect(usableFromEstimate({ usage: 12e9, quota: 10e9 })).toEqual({
      availableBytes: 0,
      reliable: true,
    })
  })
})

describe('planProbeBytes — 探测步进计划（上限 cap 截断）', () => {
  it('目标 ≤ 上限：线性步进到目标（末步不满 step）', () => {
    expect(planProbeBytes(100, 64, 200)).toEqual([64, 100])
    expect(planProbeBytes(128, 64, 200)).toEqual([64, 128])
    expect(planProbeBytes(64, 64, 200)).toEqual([64])
  })

  it('目标 > 上限：截断到上限（末步不满 step）', () => {
    expect(planProbeBytes(300, 64, 200)).toEqual([64, 128, 192, 200])
    expect(planProbeBytes(300, 64, 256)).toEqual([64, 128, 192, 256])
  })

  it('目标 / 上限为 0 或负数：空计划（不探测）', () => {
    expect(planProbeBytes(0, 64, 200)).toEqual([])
    expect(planProbeBytes(-5, 64, 200)).toEqual([])
    expect(planProbeBytes(100, 64, 0)).toEqual([])
  })

  it('上限是 step 整数倍：步进精确', () => {
    expect(planProbeBytes(200, 64, 200)).toEqual([64, 128, 192, 200])
  })
})

describe('probeAvailable — 注入式写探测循环', () => {
  it('全部步进成功：available = 计划末值，清理被调用', async () => {
    const written: number[] = []
    const result = await probeAvailable(
      [64, 128, 200],
      async (at) => {
        written.push(at)
        return true
      },
      async () => {
        written.push(-1) // 清理标记
      },
    )
    expect(result).toEqual({ availableBytes: 200, ok: true })
    expect(written).toEqual([0, 64, 128, -1]) // 清理最后执行
  })

  it('中途失败：available = 最后成功字节，清理仍执行', async () => {
    let failAt = 64 // 第二步（写到 64）即失败 → available = 0？不：第一步 from 0→64 已成功
    // 语义：write(at) 在 at >= failAt 失败 → 第一步 at=0 成功（0<64），第二步 at=64 失败
    const written: number[] = []
    const result = await probeAvailable(
      [64, 128, 192],
      async (at) => {
        written.push(at)
        if (at >= failAt) return false
        return true
      },
      async () => {
        written.push(-1)
      },
    )
    expect(result).toEqual({ availableBytes: 64, ok: false })
    expect(written).toEqual([0, 64, -1])
  })

  it('write 抛错视同失败', async () => {
    const result = await probeAvailable(
      [64],
      async () => {
        throw new Error('QuotaExceededError')
      },
    )
    expect(result).toEqual({ availableBytes: 0, ok: false })
  })

  it('空计划：available 0，不写不清理', async () => {
    let calls = 0
    const result = await probeAvailable([], async () => {
      calls++
      return true
    })
    expect(result).toEqual({ availableBytes: 0, ok: true })
    expect(calls).toBe(0)
  })
})

describe('interpretCapacity — 判定与文案', () => {
  const TARGET = 300 * 1024 * 1024 // 300 MiB

  it('estimate 可靠且充足：ok，显示可用量', () => {
    const r = interpretCapacity(TARGET, {
      mode: 'estimate',
      availableBytes: 10 * 1024 ** 3,
      reliable: true,
    })
    expect(r.ok).toBe(true)
    expect(r.level).toBe('ok')
    expect(r.message).toContain('充足')
    expect(r.message).toContain('10.00 GB')
  })

  it('estimate 可靠但不足：not ok，给出需/可用', () => {
    const r = interpretCapacity(TARGET, {
      mode: 'estimate',
      availableBytes: 100 * 1024 ** 2,
      reliable: true,
    })
    expect(r.ok).toBe(false)
    expect(r.level).toBe('warn')
    expect(r.message).toContain('不足')
    expect(r.message).toContain('300.0 MB')
    expect(r.message).toContain('100.0 MB')
  })

  it('探测到目标全部可写：ok', () => {
    const r = interpretCapacity(TARGET, {
      mode: 'probe',
      availableBytes: TARGET,
      reliable: true,
      probeCapBytes: TARGET,
    })
    expect(r.ok).toBe(true)
    expect(r.level).toBe('ok')
  })

  it('探测在上限内失败（真实不足）：not ok', () => {
    const r = interpretCapacity(TARGET, {
      mode: 'probe',
      availableBytes: 100 * 1024 ** 2,
      reliable: true,
      probeCapBytes: TARGET, // 目标 ≤ 探测上限 → 失败点即真实上限
    })
    expect(r.ok).toBe(false)
    expect(r.level).toBe('warn')
    expect(r.message).toContain('不足')
  })

  it('目标超出探测上限且探测成功到达上限（大文件，iOS）：info，不阻断', () => {
    const bigTarget = 5 * 1024 ** 3 // 5 GiB
    const r = interpretCapacity(bigTarget, {
      mode: 'probe',
      availableBytes: 2 * 1024 ** 3, // 探测到 2 GiB 上限（全部成功）
      reliable: true,
      probeCapBytes: 2 * 1024 ** 3,
    })
    expect(r.ok).toBe(true)
    expect(r.level).toBe('info')
    expect(r.message).toContain('2.00 GB')
    expect(r.message).toContain('不设大小上限')
  })

  it('目标超出探测上限但探测在上限内失败：warn（失败点精确）', () => {
    const bigTarget = 5 * 1024 ** 3 // 5 GiB
    const r = interpretCapacity(bigTarget, {
      mode: 'probe',
      availableBytes: 448 * 1024 ** 2, // 探测在 448 MiB 失败（真实上限）< 2 GiB cap
      reliable: true,
      probeCapBytes: 2 * 1024 ** 3,
    })
    expect(r.ok).toBe(false)
    expect(r.level).toBe('warn')
    expect(r.message).toContain('不足')
    expect(r.message).toContain('448.0 MB')
  })

  it('无法预检（estimate 不可用且探测失败）：不阻断', () => {
    const r = interpretCapacity(TARGET, { mode: 'unavailable', availableBytes: 0, reliable: false })
    expect(r.ok).toBe(true)
    expect(r.level).toBe('info')
    expect(r.message).toContain('无法预检')
  })
})

describe('fmtBytes — 文案用字节格式化（与 UI formatBytes 一致）', () => {
  it('GB / MB / B', () => {
    expect(fmtBytes(10 * 1024 ** 3)).toBe('10.00 GB')
    expect(fmtBytes(300 * 1024 ** 2)).toBe('300.0 MB')
    expect(fmtBytes(123)).toBe('123 B')
    expect(fmtBytes(0)).toBe('1 B')
  })
})

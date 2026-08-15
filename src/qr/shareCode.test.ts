import { describe, expect, it } from 'vitest'
import { answerQrMaxWidth, detectShareCapability, sharePairCode } from './shareCode'
import type { ShareTextCapability } from './shareCode'

/**
 * shareCode（T16，SPEC §5.3 两跳体验打磨）—— 回码全屏宽度 + 一键分享降级选择。
 * 覆盖三种分享路径：支持 / 不支持 / 分享失败（含用户取消 AbortError），
 * 以及二维码宽度计算（窄屏不溢出、宽屏封顶 360px）。
 */

const cap = (overrides: Partial<ShareTextCapability>): ShareTextCapability => ({
  supported: true,
  share: async () => {},
  ...overrides,
})

describe('answerQrMaxWidth — 回码放大至可用屏宽（T16）', () => {
  it('取 min(80vw, 360px)：窄屏跟视口走、宽屏封顶 360px', () => {
    expect(answerQrMaxWidth()).toBe('min(80vw, 360px)')
  })

  it('窄屏（手机竖屏 320px 视口）不溢出：80vw=256px < 360px', () => {
    const w = answerQrMaxWidth()
    // 320px 视口：80vw = 256px，小于 360px 上限
    expect(w).toContain('80vw')
  })

  it('宽屏（平板/桌面）封顶 360px：不再无限放大', () => {
    const w = answerQrMaxWidth()
    // min() 语义：视口足够宽时取 360px
    expect(w).toMatch(/360px/)
  })

  it('原值 260px 已放大（回归保护：防止缩回小码）', () => {
    expect(answerQrMaxWidth()).not.toBe('260px')
    expect(Number(answerQrMaxWidth().match(/\d+(?=px)/)?.[0] ?? 0)).toBeGreaterThan(260)
  })
})

describe('sharePairCode — 分享 vs 复制 降级选择（T16）', () => {
  it('支持且分享成功 → shared', async () => {
    let shared = ''
    const outcome = await sharePairCode('回码文本', {
      supported: true,
      share: async (t) => {
        shared = t
      },
    })
    expect(outcome).toBe('shared')
    expect(shared).toBe('回码文本')
  })

  it('不支持（navigator.share 缺失）→ 降级 copy，不报错', async () => {
    const outcome = await sharePairCode('回码文本', cap({ supported: false }))
    expect(outcome).toBe('copy')
  })

  it('分享抛错 → 降级 copy，不报错中断', async () => {
    const outcome = await sharePairCode('回码文本', {
      supported: true,
      share: async () => {
        throw new Error('share sheet exploded')
      },
    })
    expect(outcome).toBe('copy')
  })

  it('用户取消（AbortError）→ 降级 copy，视为正常路径', async () => {
    const outcome = await sharePairCode('回码文本', {
      supported: true,
      share: async () => {
        const e = new DOMException('Aborted by user', 'AbortError')
        throw e
      },
    })
    expect(outcome).toBe('copy')
  })

  it('空文本也按同一逻辑处理（不特殊抛错）', async () => {
    expect(await sharePairCode('', cap({ supported: false }))).toBe('copy')
    expect(await sharePairCode('', cap({}))).toBe('shared')
  })
})

describe('detectShareCapability — 运行环境探测', () => {
  it('navigator.share 缺失（node / 非安全上下文）→ supported=false', () => {
    const cap = detectShareCapability()
    // node 测试环境无 navigator.share
    expect(cap.supported).toBe(false)
  })

  it('supported=false 时调用 share 也安全拒绝（不抛同步错）', async () => {
    const cap = detectShareCapability()
    if (cap.supported) return // 真浏览器环境跳过（单测运行于 node，必走拒绝分支）
    await expect(cap.share('x')).rejects.toThrow()
  })
})

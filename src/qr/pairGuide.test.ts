import { describe, expect, it } from 'vitest'
import { pairButtonLabels, pairGuide, primaryPairAction } from './pairGuide'

/**
 * pairGuide（T14）—— 设备分工默认主路径 + 引导文案纯逻辑测试。
 * 文案是产品约束：断言关键步骤存在（电脑出码 / 手机扫码 / 回码粘贴），
 * 防止将来回归成「两端都要扫码」或「电脑要读屏」的错配流程。
 */

describe('primaryPairAction — 按设备类型选默认主路径（T14）', () => {
  it('电脑 → 显示配对码（无摄像头，只出码）', () => {
    expect(primaryPairAction('desktop')).toBe('offer')
  })

  it('手机 → 扫码', () => {
    expect(primaryPairAction('phone')).toBe('scan')
  })

  it('平板 → 扫码', () => {
    expect(primaryPairAction('tablet')).toBe('scan')
  })

  it('未知设备 → 扫码（按有摄像头处理，无摄像头可手动切换）', () => {
    expect(primaryPairAction('other')).toBe('scan')
  })
})

describe('pairGuide — 分工引导文案（T14）', () => {
  it('桌面引导：电脑出码、手机扫码、回码粘贴回电脑', () => {
    const g = pairGuide('desktop')
    expect(g.headline).toMatch(/电脑/)
    const all = [...g.steps, g.note].join(' ')
    expect(all).toMatch(/手机扫码/)
    expect(all).toMatch(/回码文本.*粘贴|粘贴.*回码文本/)
    expect(all).toMatch(/两台电脑/)
  })

  it('桌面引导：三步结构完整（恰好一轮跨设备传输，无「电脑扫码」）', () => {
    const g = pairGuide('desktop')
    expect(g.steps).toHaveLength(3)
    expect(g.steps.join(' ')).not.toMatch(/电脑.*扫码/)
  })

  it('手机引导：对方出码、本机扫码、回码发给对方粘贴', () => {
    const g = pairGuide('phone')
    expect(g.headline).toMatch(/手机/)
    const all = [...g.steps, g.note].join(' ')
    expect(all).toMatch(/扫码/)
    expect(all).toMatch(/回码文本/)
    expect(g.note).toMatch(/手机↔手机/)
  })

  it('平板引导：headline 区分平板，步骤与手机一致', () => {
    const g = pairGuide('tablet')
    expect(g.headline).toMatch(/平板/)
    expect(g.steps).toEqual(pairGuide('phone').steps)
  })
})

describe('pairButtonLabels — pick 页按钮文案（T14）', () => {
  it('电脑：主路径「显示配对码（免摄像头）」带提示后缀', () => {
    const l = pairButtonLabels('desktop')
    expect(l.offerLabel).toBe('显示配对码（免摄像头）')
    expect(l.scanLabel).toContain('扫码配对')
  })

  it('手机/平板：按钮无后缀', () => {
    const l = pairButtonLabels('phone')
    expect(l.offerLabel).toBe('显示配对码')
    expect(l.scanLabel).toBe('扫码配对')
    expect(pairButtonLabels('tablet')).toEqual(l)
  })
})

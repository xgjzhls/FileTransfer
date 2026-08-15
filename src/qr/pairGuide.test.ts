import { describe, expect, it } from 'vitest'
import {
  pairButtonLabels,
  pairGuide,
  pairPolishLabels,
  primaryPairAction,
  rePairAction,
} from './pairGuide'

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

describe('pairPolishLabels — T16/T17 两跳打磨文案（ADR-0007）', () => {
  it('断线快捷重配：重新配对按钮 + 续传提示文案就位（T17）', () => {
    const p = pairPolishLabels()
    expect(p.rePairLabel).toBe('重新配对')
    expect(p.disconnectedWarning).toMatch(/连接已断开/)
    expect(p.disconnectedWarning).toMatch(/续传|断点/)
  })

  it('回码一键分享：分享按钮 + 降级提示就位（T16）', () => {
    const p = pairPolishLabels()
    expect(p.shareAnswerLabel).toBe('分享回码')
    expect(p.shareFallbackMsg).toMatch(/复制配对码/)
  })

  it('桌面 offer 页主次重排：粘贴为唯一主操作，扫码降为次要入口（T17）', () => {
    const p = pairPolishLabels()
    // 主操作标题强调「粘贴回码」且指向手机回码
    expect(p.desktopPasteTitle).toMatch(/回码.*粘贴|粘贴.*回码/)
    expect(p.desktopPasteTitle).toMatch(/主路径/)
    // 扫码降级为 details 折叠入口（非按钮平级）
    expect(p.desktopScanSummary).toContain('扫码对方的回码')
    // 重新生成/复制/扫码/停止 标签集中，UI 不得另造文案
    expect(p.regenerateLabel).toBe('重新生成')
    expect(p.copyCodeLabel).toBe('复制配对码')
    expect(p.scanAnswerLabel).toBe('扫码对方的回码')
    expect(p.stopScanLabel).toBe('停止扫码')
    expect(p.startScanLabel).toBe('开始扫码')
    // 无摄像头手动粘贴入口文案集中（手机 offer-show 贴接收端回码 / scan-wait 贴发送端码）
    expect(p.mobilePasteSummary).toContain('手动粘贴')
    expect(p.mobilePasteSummary).toMatch(/接收端/)
    expect(p.scanWaitPasteSummary).toMatch(/发送端/)
    expect(p.scanWaitPasteSummary).not.toBe(p.mobilePasteSummary)
  })

  it('断线重配保留 answerer 引导文案（等对方重新出码，不切角色）', () => {
    const p = pairPolishLabels()
    expect(p.rePairScanMsg).toMatch(/重新.*出码|对方重新/)
  })
})

describe('rePairAction — 断线快捷重配保持本端角色（T17）', () => {
  it('offerer（offer-show）→ 重新出码', () => {
    expect(rePairAction('offer-show')).toBe('offer')
  })

  it('offerer 配对完成等待中（done）→ 重新出码', () => {
    expect(rePairAction('done')).toBe('offer')
  })

  it('answerer（answer-show）→ 保持接收角色，扫对方新码', () => {
    expect(rePairAction('answer-show')).toBe('scan')
  })

  it('answerer（scan-wait）→ 保持接收角色', () => {
    expect(rePairAction('scan-wait')).toBe('scan')
  })

  it('pick（角色已随收起重置）→ 默认按本端出码开始（不重走 pick）', () => {
    expect(rePairAction('pick')).toBe('offer')
  })
})

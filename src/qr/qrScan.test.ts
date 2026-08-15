import { describe, expect, it } from 'vitest'
import { calcScanRegion, SCAN_REGION_RATIO } from './qrScan'

/**
 * calcScanRegion（T15）—— 扫描区计算纯函数。
 *
 * 回归保护：qr-scanner 默认中心 2/3 会把「充满取景框」的二维码裁掉三个定位角，
 * 导致任何引擎都无法识别（真机症状：码在框内但永不识别）。本函数必须覆盖
 * 接近充满画面的码，且保持中心对称。
 */

describe('calcScanRegion — 扫描区（T15，防裁剪定位角）', () => {
  it('扫描区比例 ≥ 90%（默认 2/3 会裁掉充满取景框的码）', () => {
    expect(SCAN_REGION_RATIO).toBeGreaterThanOrEqual(0.9)
  })

  it('覆盖接近充满画面的码：95% 区域 ≥ 视频短边的 90%', () => {
    const r = calcScanRegion({ videoWidth: 640, videoHeight: 720 })
    expect(r.width).toBeGreaterThanOrEqual(640 * 0.9)
    expect(r.height).toBe(r.width)
  })

  it('中心对称（横向）', () => {
    const r = calcScanRegion({ videoWidth: 640, videoHeight: 720 })
    expect(r.y + r.height).toBeLessThanOrEqual(720)
    expect(r.y + r.height / 2).toBeCloseTo(720 / 2)
  })

  it('中心对称（竖向）', () => {
    const r = calcScanRegion({ videoWidth: 1920, videoHeight: 1080 })
    expect(r.x + r.width).toBeLessThanOrEqual(1920)
    expect(r.x + r.width / 2).toBeCloseTo(1920 / 2)
  })

  it('无尺寸时退化为 1×1，不崩溃', () => {
    const r = calcScanRegion({ videoWidth: 0, videoHeight: 0 })
    expect(r.width).toBe(1)
    expect(r.height).toBe(1)
  })
})

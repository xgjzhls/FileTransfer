import { beforeEach, describe, expect, it } from 'vitest'
import { routeScannedCode } from './scanRoute'
import { cameraErrorText } from './scanErrors'

// node 测试环境无 navigator.mediaDevices：桩上它，使 cameraErrorText 走真实场景分支
// （真实 HTTPS 浏览器中 mediaDevices 存在，该守卫不会命中）
beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia: () => Promise.reject(new Error('unused')) },
    configurable: true,
  })
})

// mediaDevices 不可用场景单独测：清掉桩
function withoutMediaDevices() {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: undefined, configurable: true })
}

describe('scanRoute — 扫码自动角色判定（T13，SPEC §5.3 轻量打磨 / ADR-0006）', () => {
  it('接收端扫码（scan-wait）识别到 offer 码 → 自动走 answer 流程，无需先选角色', () => {
    expect(routeScannedCode('offer', 'scan-wait')).toEqual({ action: 'answer' })
  })

  it('接收端扫码扫到 answer 码 → 明确报错，提示方向性约束（offer 必须先于 answer）', () => {
    const r = routeScannedCode('answer', 'scan-wait')
    expect(r.action).toBe('error')
    if (r.action === 'error') expect(r.message).toMatch(/发送端.*配对码|answer/i)
  })

  it('发送端展示 offer 后扫码扫到 answer 码 → 配对完成', () => {
    expect(routeScannedCode('answer', 'offer-show')).toEqual({ action: 'complete' })
  })

  it('发送端展示 offer 后误扫 offer 码 → 报错并继续可重扫', () => {
    const r = routeScannedCode('offer', 'offer-show')
    expect(r.action).toBe('error')
    if (r.action === 'error') expect(r.message).toMatch(/接收端|扫描/i)
  })
})

describe('scanErrors — 摄像头错误文案按场景区分（T13）', () => {
  const dom = (name: string) => new DOMException('boom', name)

  it('权限拒绝（NotAllowedError）→ 权限提示', () => {
    expect(cameraErrorText(dom('NotAllowedError'))).toMatch(/权限/)
  })

  it('无摄像头（NotFoundError）→ 无摄像头提示', () => {
    expect(cameraErrorText(dom('NotFoundError'))).toMatch(/摄像头/)
  })

  it('摄像头被占用（NotReadableError）→ 占用提示', () => {
    expect(cameraErrorText(dom('NotReadableError'))).toMatch(/占用|其他应用/)
  })

  it('参数不受支持（OverconstrainedError）→ 明确提示', () => {
    expect(cameraErrorText(dom('OverconstrainedError'))).toMatch(/参数|分辨率/)
  })

  it('非安全上下文（SecurityError）→ HTTPS 提示', () => {
    expect(cameraErrorText(dom('SecurityError'))).toMatch(/HTTPS|安全上下文/)
  })

  it('mediaDevices 不可用（非安全上下文典型表现）→ HTTPS 提示', () => {
    withoutMediaDevices()
    expect(cameraErrorText(new TypeError('navigator.mediaDevices is undefined'))).toMatch(
      /HTTPS|安全上下文|摄像头/,
    )
  })

  it('未知错误 → 通用文案（含原始信息）', () => {
    expect(cameraErrorText(new Error('weird camera thing'))).toMatch(/weird camera thing/)
  })
})

import { describe, expect, it } from 'vitest'
import { detectKind } from './device'

/**
 * detectKind（T14）—— UA 桩分类测试。
 * node 环境无真实 userAgent，直接覆写 navigator 属性。
 */

function withUa(ua: string, maxTouchPoints = 0) {
  Object.defineProperty(globalThis.navigator, 'userAgent', { value: ua, configurable: true })
  Object.defineProperty(globalThis.navigator, 'maxTouchPoints', {
    value: maxTouchPoints,
    configurable: true,
  })
}

describe('detectKind — 设备类型判定（T14，SPEC §5.3 设备分工）', () => {
  it('iPhone（Safari UA）→ phone', () => {
    withUa(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    )
    expect(detectKind()).toBe('phone')
  })

  it('Android 手机（含 Mobile 标记）→ phone', () => {
    withUa(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    )
    expect(detectKind()).toBe('phone')
  })

  it('iPad（Macintosh + 触摸）→ tablet', () => {
    withUa(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/604.1',
      5,
    )
    expect(detectKind()).toBe('tablet')
  })

  it('Android 平板（无 Mobile 标记）→ tablet', () => {
    withUa(
      'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    )
    expect(detectKind()).toBe('tablet')
  })

  it('Windows（Chrome）→ desktop', () => {
    withUa(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    )
    expect(detectKind()).toBe('desktop')
  })

  it('macOS 桌面 → desktop', () => {
    withUa(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    )
    expect(detectKind()).toBe('desktop')
  })

  it('Linux 桌面 → desktop', () => {
    withUa(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    )
    expect(detectKind()).toBe('desktop')
  })
})

import type { DeviceKind } from './protocol/signaling'

/**
 * 按 UA / 触摸能力判定设备类型（T14，SPEC §5.3 设备分工）。
 * Home 设备上报与 OfflinePair 分工默认共用。
 *
 * 规则：
 * - iPad（Macintosh + 触摸）→ tablet
 * - iPhone / Android 手机（Mobile 标记）→ phone
 * - Android 平板（无 Mobile 标记）→ tablet
 * - 其余（Windows / macOS / Linux 桌面）→ desktop
 */
export function detectKind(): DeviceKind {
  const ua = navigator.userAgent
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 0) return 'tablet'
  if (/iPhone|Android/.test(ua) && /Mobile/.test(ua)) return 'phone'
  if (/Android/.test(ua)) return 'tablet'
  return 'desktop'
}

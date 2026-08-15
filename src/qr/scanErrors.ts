/**
 * 摄像头错误文案（T13，SPEC §5.3 轻量打磨）—— 按失败场景区分提示。
 * 沿用 T07 的 cameraErrorText 分类，补齐 OverconstrainedError 与
 * mediaDevices 不可用（非安全上下文典型表现）等缺漏场景。
 */

export function cameraErrorText(e: unknown): string {
  // 非安全上下文：mediaDevices 直接不存在（HTTPS 之外的典型表现）
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return '当前页面不是安全上下文（需 HTTPS），无法使用摄像头：请通过 HTTPS 打开本应用（localhost 除外）'
  }
  const name = e instanceof DOMException ? e.name : ''
  // 同时匹配 DOMException.name 与 message（浏览器错误文案随版本变化，name 稳定）
  const msg = e instanceof Error ? e.message : String(e)
  const haystack = `${name} ${msg}`
  if (/NotAllowedError|Permission|denied/i.test(haystack)) {
    return '摄像头权限被拒绝：请在浏览器地址栏允许摄像头后重试（需 HTTPS 安全上下文，已添加到主屏幕的 PWA 首次授权需确认）'
  }
  if (/NotFoundError|no camera|No camera/i.test(haystack)) return '未找到可用摄像头'
  if (/NotReadableError|in use|busy/i.test(haystack)) return '摄像头被其他应用占用，请关闭占用它的应用后重试'
  if (/OverconstrainedError|constraint/i.test(haystack)) {
    return '摄像头不支持当前扫码参数：请换用其他摄像头或设备重试'
  }
  if (/SecurityError|secure context|secure/i.test(haystack)) {
    return '当前页面不是安全上下文（需 HTTPS），无法使用摄像头：请通过 HTTPS 打开本应用'
  }
  return `摄像头启动失败：${msg}`
}

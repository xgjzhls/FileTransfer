/**
 * 二维码渲染（T07）—— qrcode 库的薄封装。
 *
 * 动态 import：扫码/渲染库不进首屏主包（vite 自动 code-split）。
 * errorCorrectionLevel 'L'：单码容量优先（SPEC §5.3：QR v40-L ≈ 3KB）。
 *
 * maxSize（T21）：渲染像素尺寸上限。普通展示 512 足够；全屏放大（点击二维码
 * 弹超大码）传 1024，避免 CSS 拉伸导致码块模糊难扫。
 */

export async function renderQrToCanvas(
  canvas: HTMLCanvasElement,
  text: string,
  maxSize = 512,
): Promise<void> {
  const QRCode = (await import('qrcode')).default
  const size = Math.max(160, Math.min(canvas.clientWidth || 256, maxSize))
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'L',
    margin: 1,
    width: size,
  })
}

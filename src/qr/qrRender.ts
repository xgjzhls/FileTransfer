/**
 * 二维码渲染（T07）—— qrcode 库的薄封装。
 *
 * 动态 import：扫码/渲染库不进首屏主包（vite 自动 code-split）。
 * errorCorrectionLevel 'L'：单码容量优先（SPEC §5.3：QR v40-L ≈ 3KB）。
 */

export async function renderQrToCanvas(
  canvas: HTMLCanvasElement,
  text: string,
): Promise<void> {
  const QRCode = (await import('qrcode')).default
  const size = Math.max(160, Math.min(canvas.clientWidth || 256, 512))
  await QRCode.toCanvas(canvas, text, {
    errorCorrectionLevel: 'L',
    margin: 1,
    width: size,
  })
}

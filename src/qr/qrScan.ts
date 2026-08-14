/**
 * 摄像头扫码（T07）—— qr-scanner（封装 jsQR）的薄封装。
 *
 * 动态 import 懒加载（主包不含相机库）；worker 脚本由 vite 按相对
 * 动态 import 自动打包（qr-scanner 内部 `import("./qr-scanner-worker.min.js")`）。
 * 兼容 iOS Safari 权限流：start() 内部请求 getUserMedia，失败以 onStartError 抛出。
 */

export interface QrScannerHandle {
  stop(): void
}

export interface StartQrScannerOptions {
  /** 启动失败（无摄像头 / 权限拒绝 / 非安全上下文）回调 */
  onStartError?(err: unknown): void
}

/** 启动摄像头扫码；返回停止句柄（组件卸载 / 取消时调用） */
export async function startQrScanner(
  video: HTMLVideoElement,
  onDecode: (text: string) => void,
  options: StartQrScannerOptions = {},
): Promise<QrScannerHandle> {
  const QrScanner = (await import('qr-scanner')).default
  const scanner = new QrScanner(video, (result) => onDecode(result.data), {
    preferredCamera: 'environment',
    maxScansPerSecond: 10,
  })
  try {
    await scanner.start()
  } catch (err) {
    scanner.destroy()
    options.onStartError?.(err)
    throw err
  }
  return {
    stop: () => scanner.destroy(),
  }
}

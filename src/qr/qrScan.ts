/**
 * 摄像头扫码（T07）—— qr-scanner（封装 jsQR）的薄封装。
 *
 * 动态 import 懒加载（主包不含相机库）；worker 脚本由 vite 按相对
 * 动态 import 自动打包（qr-scanner 内部 `import("./qr-scanner-worker.min.js")`）。
 * 兼容 iOS Safari 权限流：start() 内部请求 getUserMedia，失败以 onStartError 抛出。
 *
 * T15 扫描区修复：qr-scanner 默认只解码视频中心 2/3 正方形 —— 二维码一旦
 * 大于该区域（用户把码充满取景框），裁剪区里只剩码的中间、三个定位角被裁掉，
 * 任何引擎都无法识别，表现为「码在框内但永不识别」。修复：
 * 1) 自定义 calculateScanRegion：中心 95% 正方形（SCAN_REGION_RATIO），码稍留边距即可完整入框
 * 2) 不降采样（省略 downScaledWidth/Height，画布 = 区域原尺寸，优于默认 400px，
 *    对密集码 / 远处小码都更宽容）
 * 3) highlightScanRegion：显示可见取景框，引导用户把码完整放进框内
 */

export interface QrScannerHandle {
  stop(): void
}

export interface StartQrScannerOptions {
  /** 启动失败（无摄像头 / 权限拒绝 / 非安全上下文）回调 */
  onStartError?(err: unknown): void
}

/** 扫描区占视频短边的比例（T15：默认 2/3 会裁掉充满取景框的码的定位角） */
export const SCAN_REGION_RATIO = 0.95

export interface ScanRegionLike {
  videoWidth: number
  videoHeight: number
}

export interface ScanRegion {
  x: number
  y: number
  width: number
  height: number
}

/** 中心正方形扫描区（纯函数，单测覆盖；不设 downScaledWidth —— 保持区域原分辨率解码） */
export function calcScanRegion(video: ScanRegionLike): ScanRegion {
  const vw = video.videoWidth || 1
  const vh = video.videoHeight || 1
  const size = Math.round(Math.min(vw, vh) * SCAN_REGION_RATIO)
  const x = Math.round((vw - size) / 2)
  const y = Math.round((vh - size) / 2)
  return { x, y, width: size, height: size }
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
    highlightScanRegion: true,
    calculateScanRegion: (v) => calcScanRegion(v),
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

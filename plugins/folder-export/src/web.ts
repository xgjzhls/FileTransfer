/**
 * web 降级实现：非壳（浏览器）环境调用原生导出即明确报错。
 * 桌面 Chrome/Edge 用 FSA（fsaExport.ts），手机网页版用 zip/分享，均不经过本插件。
 */
import type { FolderExportPlugin } from './index'

const unavailable = (method: string) => (): Promise<never> =>
  Promise.reject(new Error(`FolderExport.${method} 仅 iOS app 内可用（ADR-0008）`))

export const webFolderExport: FolderExportPlugin = {
  pickFolder: unavailable('pickFolder'),
  mkdir: unavailable('mkdir'),
  writeChunk: unavailable('writeChunk'),
  abort: unavailable('abort'),
  writeTemp: unavailable('writeTemp'),
}

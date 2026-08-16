/**
 * folder-export —— ADR-0008 原生文件夹导出插件（T02）的类型化 facade。
 *
 * 桥契约（spike 实测，prototype/ios-app-spike）：
 * - 二进制必须 JS 侧**显式 base64**（Capacitor 桥不自动转换 TypedArray）
 * - 4 MiB 分块实测最优；isLast 返回最终文件 size
 * - 一次 pickFolder 授权会话内多次写入（v1 不持久化）
 *
 * web 构建（非壳）下所有调用明确拒绝——导出到文件夹仅 iOS app 内可用；
 * 桌面走 FSA（fsaExport.ts），手机网页版走 zip/分享。
 */
import { registerPlugin } from '@capacitor/core'

/** 用户取消文件夹选择（含后台收起选择器）时 reject 的机器可识别标记 */
export const PICKER_CANCELLED = 'PICK_FOLDER_CANCELLED'

export interface PickFolderResult {
  ok: boolean
  /** 所选文件夹的沙盒路径（仅展示/调试用） */
  folderPath: string
  folderName: string
}

export interface WriteChunkOptions {
  /** 目标相对路径（含文件名；父目录由 mkdir 逐段创建，目录树原生还原） */
  file: string
  /** base64 编码的分块数据（JS 侧显式编码，见模块注释） */
  data: string
  isFirst: boolean
  isLast: boolean
}

export interface WriteChunkResult {
  ok: boolean
  bytes: number
  /** isLast 时返回最终文件大小（字节） */
  size?: number
}

export interface AbortResult {
  ok: boolean
  /** 是否清理了当前文件的半成品（已写完成的文件保留） */
  cleaned: boolean
}

export interface WriteTempResult {
  ok: boolean
  bytes: number
  size?: number
  /** 临时文件 file:// URL（供 @capacitor/share 的 files 参数） */
  url?: string
}

export interface FolderExportPlugin {
  /** 选文件夹（UIDocumentPicker .folder → security-scoped URL），会话内可写多个文件 */
  pickFolder(): Promise<PickFolderResult>
  /** 按相对路径逐段建目录（嵌套；幂等） */
  mkdir(options: { relDir: string }): Promise<{ ok: boolean }>
  /** 分块写：isFirst 截断建文件、其后追加；isLast 返回最终 size */
  writeChunk(options: WriteChunkOptions): Promise<WriteChunkResult>
  /** 中断当前文件写入并清理半成品（已写完成的文件保留） */
  abort(): Promise<AbortResult>
  /** 分块写临时文件（共享/下载用），isLast 返回 file:// URL */
  writeTemp(options: Omit<WriteChunkOptions, 'file'> & { name: string }): Promise<WriteTempResult>
}

const FolderExport = registerPlugin<FolderExportPlugin>('FolderExport', {
  web: () => import('./web').then((m) => m.webFolderExport),
})

export { FolderExport }

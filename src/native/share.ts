/**
 * 壳内分享（ADR-0008 #3 / T04）：@capacitor/share。
 *
 * navigator.share 在 WKWebView 中不可靠（ADR 决策 #3 依据）；@capacitor/share
 * 原生 UIActivityViewController。iOS 侧 files 参数需本地 file:// URL ——
 * OPFS 背书 File 无路径，先经 folder-export.writeTemp 分块落临时目录再分享。
 *
 * 临时文件保留（OS 自动清理 temporaryDirectory）；分享面板由系统复制给目标 app。
 * 桌面/web 不动（保持 navigator.share / FSA 路径）。
 */
import { Share } from '@capacitor/share'
import { FolderExport } from 'folder-export'
import { writeFileToTemp } from '../transfer/nativeExport'

export interface NativeShareFile {
  file: File
  name: string
}

/** 批量分享（单文件/批量共用）：writeTemp 分块落盘 → UIActivityViewController */
export async function shareFilesNative(
  files: NativeShareFile[],
  title: string,
  text: string,
): Promise<void> {
  const urls: string[] = []
  for (const { file, name } of files) {
    urls.push(await writeFileToTemp(FolderExport, file, name))
  }
  await Share.share({ title, text, files: urls, dialogTitle: title })
}

/** 壳内「下载到本机」：WKWebView 无可靠 a.download，经分享面板存「文件」App */
export async function downloadFileNative(file: File, name: string): Promise<void> {
  await shareFilesNative([{ file, name }], name, '存储到文件')
}

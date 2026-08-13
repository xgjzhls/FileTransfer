/**
 * 导出目标分类（SPEC §4）。
 *
 * image/*|video/* 且 < 300MiB → 分享面板可「存储到照片」；
 * 其余（大视频/大文件）→ 「存储到文件」（spike 实测 ~600MiB 视频
 * 经 Web Share 会使页面崩溃，故门控）。
 */

export const PHOTO_GATE_BYTES = 300 * 1024 * 1024 // 配置常量（T05；真机实测可调）

export type ExportTarget = 'photo' | 'file'

const IMAGE_VIDEO_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'bmp', 'avif',
  'mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv',
])

export function classifyExport(name: string, size: number): ExportTarget {
  if (size >= PHOTO_GATE_BYTES) return 'file'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_VIDEO_EXT.has(ext) ? 'photo' : 'file'
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  avif: 'image/avif', svg: 'image/svg+xml',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/mp4', webm: 'video/webm',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska',
  txt: 'text/plain', pdf: 'application/pdf', zip: 'application/zip',
}

/** 导出 File 的 MIME（接收端只有文件名，按扩展名推断） */
export function guessMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

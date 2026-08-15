/**
 * 路径工具 —— 存储层（OPFS 布局）与目录选择共用的相对路径安全校验。
 *
 * 拼接路径 sessions/<sessionId>/<fileId>/<name> 中的 name 来自 meta
 * （发送端可控）：必须拒绝 ../ 穿越、绝对路径、反斜杠、控制字符，
 * 否则恶意对端可写出会话目录（路径穿越）或破坏布局。
 */

/**
 * 相对路径安全校验。
 * 合法：非空、不以 / 或 \ 开头、不以 / 或 \ 结尾、不含反斜杠、
 * 不含 NUL 控制字符、各段非空且非 . 或 ..。
 */
export function isSafeRelPath(path: string): boolean {
  if (!path) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (path.endsWith('/') || path.endsWith('\\')) return false
  if (path.includes('\\')) return false
  if (path.includes('\0')) return false
  return path.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..')
}

/** 路径末段（导出/分享用的真实文件名） */
export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

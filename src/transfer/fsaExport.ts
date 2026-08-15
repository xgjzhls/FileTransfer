/**
 * fsaExport —— 桌面 Chrome/Edge：把接收文件树写入用户选定的目标文件夹
 * （File System Access：showDirectoryPicker + createWritable）。
 *
 * 与 zip 导出互补：目标端目录结构 100% 保留且无需解压，直接得到文件树；
 * 仅桌面 Chrome/Edge 支持（手机端无 FSA，用「导出 zip → 分享到「文件」App
 * 选位置」替代，两端体验对齐）。
 */

/** 按相对路径把单文件写入目标目录句柄（逐段建目录，保留目录结构） */
export async function writeFileTree(
  root: FileSystemDirectoryHandle,
  relPath: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const segments = relPath.split('/')
  let dir: FileSystemDirectoryHandle = root
  for (const seg of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg, { create: true })
  }
  const name = segments[segments.length - 1]
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(bytes)
  await writable.close()
}

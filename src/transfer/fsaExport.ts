/**
 * fsaExport —— 桌面 Chrome/Edge：把接收文件树写入用户选定的目标文件夹
 * （File System Access：showDirectoryPicker + createWritable）。
 *
 * 与 zip 导出互补：目标端目录结构 100% 保留且无需解压，直接得到文件树；
 * 仅桌面 Chrome/Edge 支持（手机端无 FSA，用「导出 zip → 分享到「文件」App
 * 选位置」替代，两端体验对齐）。
 *
 * T23：改为流式写（File.stream() 分块 → writable，逐块 await 背压），
 * 大文件导出不再整载入内存。
 */

/** 按相对路径把单文件流式写入目标目录句柄（逐段建目录，保留目录结构；T23 流式） */
export async function writeFileStreamTree(
  root: FileSystemDirectoryHandle,
  relPath: string,
  file: File,
): Promise<void> {
  const segments = relPath.split('/')
  let dir: FileSystemDirectoryHandle = root
  for (const seg of segments.slice(0, -1)) {
    dir = await dir.getDirectoryHandle(seg, { create: true })
  }
  const name = segments[segments.length - 1]
  const fileHandle = await dir.getFileHandle(name, { create: true })
  const writable = await fileHandle.createWritable()
  try {
    const reader = file.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
    }
    await writable.close()
  } catch (e) {
    await writable.close().catch(() => {})
    throw e
  }
}

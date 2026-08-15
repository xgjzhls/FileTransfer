/**
 * dirPicker —— 桌面 Chrome File System Access 选文件夹（SPEC §6.3）。
 *
 * 浏览器选「文件夹」后得到 FileSystemDirectoryHandle（目录树句柄），
 * 需递归遍历并展平为文件列表；name 用相对路径（/ 分隔）——接收端
 * 存储层按 name 重建目录结构（OPFS dirOf 逐段 create），同名文件
 * 因路径不同而互不冲突，用户可辨识来源。
 *
 * 安全：相对路径可能被用于 OPFS 拼接（sessions/<sid>/<fileId>/<name>），
 * 必须拒绝 ../ 穿越、绝对路径、反斜杠等 —— 校验逻辑见 storage/path.ts
 * （接收端存储层同样强制，防御恶意对端）。
 */

import { isSafeRelPath, basename } from '../storage/path'

export { isSafeRelPath, basename }

/** 目录遍历产出的单个文件：name=相对路径，baseName=真实文件名 */
export interface PickedDirFile {
  /** 相对路径（photos/2024/img.jpg；根目录文件为纯文件名）—— 传输/存储的 name */
  name: string
  /** 真实文件名（UI 展示 / 导出 basename） */
  baseName: string
  file: File
}

/** walkDirectory 结果：files=合法文件；skipped=因路径不安全而被跳过的相对路径（UI 提示用） */
export interface WalkResult {
  files: PickedDirFile[]
  skipped: string[]
}

/**
 * 递归遍历目录树（DFS 先序）→ 扁平文件列表。
 * - name = 相对路径（根文件为纯文件名；子目录用 / 连接）
 * - baseName = 真实文件名（导出/显示用）
 * - 每层按条目名字典序（二进制比较）排序 —— 输出确定性，但不保证全局字典序
 *   （DFS 先序：父目录条目先于其子文件）；不依赖浏览器遍历顺序
 * - 路径不安全（含 ../、\、绝对路径等，isSafeRelPath 拒绝）的条目记入 skipped
 *   （如 macOS/Linux 上合法的含 \ 文件名），不进入发送队列
 */
export async function walkDirectory(handle: FileSystemDirectoryHandle, basePath = ''): Promise<WalkResult> {
  const entries: [string, FileSystemHandle][] = []
  for await (const [name, child] of handle.entries()) {
    entries.push([name, child])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))

  const files: PickedDirFile[] = []
  const skipped: string[] = []
  for (const [name, child] of entries) {
    const rel = basePath ? `${basePath}/${name}` : name
    if (!isSafeRelPath(rel)) {
      skipped.push(rel)
      continue
    }
    if (child.kind === 'directory') {
      const sub = await walkDirectory(child as FileSystemDirectoryHandle, rel)
      files.push(...sub.files)
      skipped.push(...sub.skipped)
    } else {
      const file = await (child as FileSystemFileHandle).getFile()
      files.push({ name: rel, baseName: name, file })
    }
  }
  return { files, skipped }
}

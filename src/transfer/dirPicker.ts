/**
 * dirPicker —— 选文件夹（SPEC §6.3）。两条来源，产出同构：
 *
 * 1. 桌面 Chrome/Edge：File System Access（showDirectoryPicker）→
 *    FileSystemDirectoryHandle 目录树句柄，walkDirectory 递归遍历展平；
 * 2. iOS Safari 18.4+ / Android Chrome / 桌面 Chrome：<input type=file
 *    webkitdirectory> → 浏览器递归返回整棵目录树的 File[]，每个
 *    File.webkitRelativePath = "<选中文件夹名>/<子目录>/<文件>"，
 *    filesFromWebkitDirectory 去掉首段得到与 1 相同的相对路径。
 *
 * name 用相对路径（/ 分隔）——接收端存储层按 name 重建目录结构
 * （OPFS dirOf 逐段 create），同名文件因路径不同而互不冲突。
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

/**
 * webkitdirectory 的 File.webkitRelativePath → 与 walkDirectory 一致的相对路径。
 *
 * webkitRelativePath 首段是用户选中的文件夹名（"照片/2024/img.jpg"），
 * 与桌面 showDirectoryPicker 语义对齐（name 相对选中文件夹根）→ 去掉首段。
 * 无 '/'（异常情况）回退纯文件名。
 */
export function relFromWebkitPath(webkitPath: string, fallbackName: string): string {
  const i = webkitPath.indexOf('/')
  return i >= 0 ? webkitPath.slice(i + 1) : fallbackName
}

/**
 * webkitdirectory 选中的 File[] → WalkResult（与 walkDirectory 同构）。
 * - name = webkitRelativePath 去掉首段（根目录文件为纯文件名）
 * - baseName = file.name；按 name 排序保证 UI 确定性（浏览器返回顺序不保证）
 * - 路径不安全（isSafeRelPath 拒绝）的条目记入 skipped
 */
export function filesFromWebkitDirectory(files: File[]): WalkResult {
  const out: PickedDirFile[] = []
  const skipped: string[] = []
  for (const file of files) {
    const rel = relFromWebkitPath(file.webkitRelativePath || '', file.name)
    if (!isSafeRelPath(rel)) {
      skipped.push(rel)
      continue
    }
    out.push({ name: rel, baseName: file.name, file })
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return { files: out, skipped }
}

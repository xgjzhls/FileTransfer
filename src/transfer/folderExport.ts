/**
 * folderExport —— 接收端按顶层目录分组 + 结构保持导出（SPEC §4）。
 *
 * 文件夹发送的文件 name 为相对路径（photos/2024/img.jpg），按首段分组为
 * 「顶层目录」导出单元，提供两种方式：
 * 1. zip（store，不压缩，见 zip.ts）：目录树结构 100% 保留，目标端
 *    iOS「文件」App 原生解压即可还原整棵目录树；
 * 2. 批量分享：全部文件一次进分享面板（iOS 收进一个文件夹，子目录拍平，
 *    适合「选个文件夹导出」的快捷路径）。
 *
 * 内存守卫：zip/批量分享都要把组内全部文件读入内存，超限提示分批/逐文件。
 */

import { basename } from '../storage/path'

/** zip / 批量分享的组总大小上限（读入内存 + Blob 组装，iOS 内存敏感） */
export const ZIP_TOTAL_GUARD_BYTES = 1024 * 1024 * 1024 // 1 GiB

export interface FolderExportItem {
  name: string
  size: number
}

export interface FolderGroup<T extends FolderExportItem = FolderExportItem> {
  /** 顶层目录名（name 首段；不含 '/' 的文件归入根目录组 dir=''） */
  dir: string
  /** 组内文件（原始对象引用，调用方可读扩展字段如 id/status） */
  items: T[]
  totalBytes: number
}

/**
 * 按顶层目录分组。稳定性：目录组在前（按名排序），根目录组（dir=''）最后。
 * 根目录组仅含 name 无 '/' 的散文件（普通多选发送场景），UI 保持逐文件导出。
 */
export function groupTopLevel<T extends FolderExportItem>(items: T[]): FolderGroup<T>[] {
  const byDir = new Map<string, T[]>()
  for (const it of items) {
    const i = it.name.indexOf('/')
    const dir = i >= 0 ? it.name.slice(0, i) : ''
    const list = byDir.get(dir)
    if (list) list.push(it)
    else byDir.set(dir, [it])
  }
  const dirs = [...byDir.keys()].sort((a, b) => {
    if (a === '') return 1
    if (b === '') return -1
    return a < b ? -1 : a > b ? 1 : 0
  })
  return dirs.map((dir) => {
    const list = byDir.get(dir)!
    return { dir, items: list, totalBytes: list.reduce((s, it) => s + it.size, 0) }
  })
}

/**
 * 批量分享的 File 名：basename（share 不允许路径分隔符），
 * 组内重名（不同子目录同名文件）用父目录名做前缀消歧，仍重名再追加序号。
 * 返回 { name: shareName } 映射。
 */
export function shareNames<T extends FolderExportItem>(items: T[]): Map<string, string> {
  const used = new Set<string>()
  const out = new Map<string, string>()
  for (const it of items) {
    const base = basename(it.name)
    if (!used.has(base)) {
      used.add(base)
      out.set(it.name, base)
      continue
    }
    // 重名：父目录名（it.name 倒数第二段）做前缀，仍重名再追加序号
    const segs = it.name.split('/')
    const parent = segs.length >= 2 ? segs[segs.length - 2] : ''
    let candidate = parent ? `${parent}_${base}` : base
    let k = 1
    while (used.has(candidate)) candidate = `${parent}_${base} (${++k})`
    used.add(candidate)
    out.set(it.name, candidate)
  }
  return out
}

/**
 * folderExport —— 接收端按顶层目录分组 + 结构保持导出（SPEC §4）。
 *
 * 文件夹发送的文件 name 为相对路径（photos/2024/img.jpg），按首段分组为
 * 「顶层目录」导出单元，提供两种方式：
 * 1. zip（deflate 均衡压缩 level 6，见 zip.ts）：目录树结构 100% 保留，目标端
 *    iOS「文件」App 原生解压即可还原整棵目录树；
 * 2. 批量分享：全部文件一次进分享面板（iOS 收进一个文件夹，子目录拍平，
 *    适合「选个文件夹导出」的快捷路径）。
 *
 * T20 补充：跨组勾选导出（复选框多选）复用本模块的 uniqueZipPaths / shareNames，
 * 并用 disambiguateRootVsDir 处理「根散文件名 vs 目录名」冲突。
 *
 * 大小策略（T22）：导出不设大小上限。zip/批量分享需整组读入内存，超大导出在
 * iOS 可能内存不足导致本次导出失败（已收数据不丢，可分批重试）；导出到文件夹
 * （FSA）逐文件写盘，无内存风险。
 */

import { basename } from '../storage/path'

/** 条目总大小（T20 跨组勾选导出的守卫计算；group.totalBytes 为分组预计算版本） */
export function sumBytes<T extends FolderExportItem>(items: T[]): number {
  return items.reduce((s, it) => s + it.size, 0)
}

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
 * 以条目对象为键（同名条目可能共存，不能按 name 键）。
 */
export function shareNames<T extends FolderExportItem>(items: T[]): Map<T, string> {
  const used = new Set<string>()
  const out = new Map<T, string>()
  for (const it of items) {
    const base = basename(it.name)
    if (!used.has(base)) {
      used.add(base)
      out.set(it, base)
      continue
    }
    // 重名：优先父目录名前缀消歧（可读）；无父目录（纯同名文件）或前缀仍撞 → 追加序号
    const segs = it.name.split('/')
    const parent = segs.length >= 2 ? segs[segs.length - 2] : ''
    const pref = parent ? `${parent}_${base}` : null
    let candidate = pref && !used.has(pref) ? pref : base
    if (!used.has(candidate)) {
      used.add(candidate)
      out.set(it, candidate)
      continue
    }
    let k = 1
    while (used.has(candidate)) candidate = `${pref ?? base} (${++k})`
    used.add(candidate)
    out.set(it, candidate)
  }
  return out
}

/**
 * zip / 目录导出的去重路径：同名条目追加序号（多选发送可能同名，如两个 IMG_0001.JPG），
 * 保持目录结构不变。以条目对象为键（同名条目共存）。
 */
export function uniqueZipPaths<T extends FolderExportItem>(items: T[]): Map<T, string> {
  const used = new Set<string>()
  const out = new Map<T, string>()
  for (const it of items) {
    let p = it.name
    let k = 1
    while (used.has(p)) p = `${it.name} (${++k})`
    used.add(p)
    out.set(it, p)
  }
  return out
}

/**
 * T20：跨组勾选导出的「根散文件 vs 目录」冲突消歧（FSA 导出到目标文件夹 / zip）。
 *
 * 勾选同时含根目录散文件 `photos` 与目录组 `photos/…` 时，目标端一个条目要建文件、
 * 另一个要建同名目录——FSA 的 getFileHandle/getDirectoryHandle 会直接抛错（写一半失败）。
 * 策略：目录优先，撞目录首段的根散文件追加序号改名；同时去重同全路径条目（多选可能
 * 同名），勾选导出场景下取代 uniqueZipPaths。以条目对象为键。
 */
export function disambiguateRootVsDir<T extends FolderExportItem>(items: T[]): Map<T, string> {
  const dirs = new Set<string>()
  for (const it of items) {
    const i = it.name.indexOf('/')
    if (i >= 0) dirs.add(it.name.slice(0, i))
  }
  const used = new Set<string>()
  const out = new Map<T, string>()
  for (const it of items) {
    let p = it.name
    if (it.name.indexOf('/') < 0 && dirs.has(p)) p = `${p} (2)` // 根散文件撞目录名 → 目录优先
    let k = 1
    while (used.has(p)) p = `${it.name} (${++k})`
    used.add(p)
    out.set(it, p)
  }
  return out
}

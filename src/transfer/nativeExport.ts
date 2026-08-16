/**
 * nativeExport —— app 内「导出到文件夹…」的 JS 侧分块流式拷贝（T03）。
 *
 * 数据面：OPFS 磁盘背书 File（mergedFileOf）→ File.slice().arrayBuffer() 按块读取
 * （峰值内存 = 块大小）→ JS 显式 base64 → 经桥逐块写入用户所选文件夹。
 *
 * 桥契约（ADR-0008 / spike 实测）：4 MiB 块最优；Capacitor 桥不自动转换
 * TypedArray，二进制必须 JS 侧显式 base64；isLast 返回最终 size。
 *
 * 编码优化（FileReader/worker 提升端到端吞吐）标 [v2]，本票不做。
 */

/** 分块大小（spike 实测最优：177 MB/s @4MiB，ADR-0008） */
export const NATIVE_CHUNK_BYTES = 4 * 1024 * 1024

/** 取消导出（抛给调用方；已写完成的文件保留，当前文件半成品由桥清理） */
export class NativeExportAbortedError extends Error {
  readonly relPath: string
  constructor(relPath: string) {
    super(`导出已取消：${relPath}`)
    this.name = 'NativeExportAbortedError'
    this.relPath = relPath
  }
}

/** 原生导出桥最小接口（结构上兼容 plugins/folder-export 的 FolderExport facade；选文件夹由调用方直接调插件） */
export interface NativeExportBridge {
  mkdir(options: { relDir: string }): Promise<{ ok: boolean }>
  writeChunk(options: {
    file: string
    data: string
    isFirst: boolean
    isLast: boolean
  }): Promise<{ ok: boolean; bytes: number; size?: number }>
  writeTemp(options: {
    name: string
    data: string
    isFirst: boolean
    isLast: boolean
  }): Promise<{ ok: boolean; bytes: number; size?: number; url?: string }>
  abort(): Promise<{ ok: boolean; cleaned: boolean }>
}

/** Uint8Array → base64（分步 String.fromCharCode + btoa，防调用栈溢出；spike 验证） */
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + STEP) as unknown as number[],
    )
  }
  return btoa(bin)
}

/** 读一块（slice + arrayBuffer → Uint8Array；峰值内存 = 块大小）并编码 base64 */
async function encodeChunk(file: File, start: number, end: number): Promise<string> {
  return bytesToBase64(new Uint8Array(await file.slice(start, end).arrayBuffer()))
}

/** 桥结果 ok=false 即视为失败（nativeExport 契约；防止原生侧静默假成功） */
function assertOk<T extends { ok: boolean }>(res: T, label: string): T {
  if (!res.ok) throw new Error(`桥写入未确认（ok=false）：${label}`)
  return res
}

/**
 * APFS 大小写不敏感消歧（T03 补充）：uniqueZipPaths / disambiguateRootVsDir 是字节级
 * 去重，iOS（APFS 默认大小写不敏感）上 `IMG_0001.JPG` 与 `img_0001.jpg` 会落到同一
 * 路径、后者 isFirst 截断覆盖前者——违反 ADR-0008「追加序号，不覆盖」。壳内导出在
 * 既有消歧结果之上再补一轮大小写不敏感去重（追加序号，不覆盖）。
 */
export function caseInsensitiveUnique<T>(base: Map<T, string>): Map<T, string> {
  const out = new Map<T, string>()
  const seen = new Set<string>()
  for (const [key, path] of base) {
    // 始终从原始路径切 stem/ext（与 OS 一致：仅最后一个点视为扩展名），序号加在 stem 后
    const dot = path.lastIndexOf('.')
    const stem = dot > 0 ? path.slice(0, dot) : path
    const ext = dot > 0 ? path.slice(dot) : ''
    let candidate = path
    let n = 1
    while (seen.has(candidate.toLowerCase())) {
      candidate = `${stem} (${++n})${ext}`
    }
    seen.add(candidate.toLowerCase())
    out.set(key, candidate)
  }
  return out
}

export interface CopyFileToNativeOptions {
  bridge: NativeExportBridge
  /** OPFS 磁盘背书 File（mergedFileOf 的产物） */
  file: File
  /** 目标相对路径（含文件名；父目录经 mkdir 逐段创建） */
  relPath: string
  onProgress?: (writtenBytes: number, totalBytes: number) => void
  /** 取消信号：触发后停止当前文件写入（桥 abort 清理半成品） */
  signal?: AbortSignal
  /** 覆盖块大小（测试用；默认 4 MiB） */
  chunkBytes?: number
}

/**
 * 把单个文件分块拷贝到用户所选文件夹。
 * 目录树原生还原：mkdir(父目录) → writeChunk(isFirst…isLast)。
 * 桥失败时 abort 清理当前文件半成品（已写完成的文件保留）。
 */
export async function copyFileToNative(opts: CopyFileToNativeOptions): Promise<{ size: number }> {
  const { bridge, file, relPath, signal, onProgress, chunkBytes = NATIVE_CHUNK_BYTES } = opts
  const slash = relPath.lastIndexOf('/')
  if (slash >= 0) {
    await bridge.mkdir({ relDir: relPath.slice(0, slash) })
  }
  const total = file.size
  if (total === 0) {
    // 空文件：单次空块建文件（isFirst + isLast）
    await bridge.writeChunk({ file: relPath, data: '', isFirst: true, isLast: true }).then((r) => assertOk(r, relPath))
    onProgress?.(0, 0)
    return { size: 0 }
  }
  let written = 0
  let index = 0
  while (written < total) {
    if (signal?.aborted) {
      await bridge.abort()
      throw new NativeExportAbortedError(relPath)
    }
    const end = Math.min(written + chunkBytes, total)
    const isFirst = index === 0
    const isLast = end >= total
    try {
      await bridge
        .writeChunk({ file: relPath, data: await encodeChunk(file, written, end), isFirst, isLast })
        .then((r) => assertOk(r, relPath))
    } catch (e) {
      if (!(e instanceof NativeExportAbortedError)) {
        await bridge.abort().catch(() => {})
      }
      throw e
    }
    written = end
    index++
    onProgress?.(written, total)
  }
  return { size: total }
}

export interface CopyFilesToNativeOptions {
  bridge: NativeExportBridge
  entries: { file: File; relPath: string }[]
  onFileStart?: (index: number, name: string, totalBytes: number) => void
  onFileProgress?: (index: number, writtenBytes: number, totalBytes: number) => void
  onFileDone?: (index: number, size: number) => void
  /** 取消信号：停止当前文件（半成品清理），已写完成的文件保留 */
  signal?: AbortSignal
  chunkBytes?: number
}

export interface CopyFilesToNativeResult {
  copied: number
  cancelled: boolean
}

/**
 * 批量分块拷贝：逐文件顺序写；取消 = 停止当前文件、已写保留（ADR-0008 v1 语义）。
 */
export async function copyFilesToNative(
  opts: CopyFilesToNativeOptions,
): Promise<CopyFilesToNativeResult> {
  const { bridge, entries, signal, chunkBytes } = opts
  let copied = 0
  for (let i = 0; i < entries.length; i++) {
    if (signal?.aborted) {
      await bridge.abort()
      return { copied, cancelled: true }
    }
    const { file, relPath } = entries[i]
    opts.onFileStart?.(i, relPath, file.size)
    try {
      const { size } = await copyFileToNative({
        bridge,
        file,
        relPath,
        signal,
        chunkBytes,
        onProgress: (w, t) => opts.onFileProgress?.(i, w, t),
      })
      copied++
      opts.onFileDone?.(i, size)
    } catch (e) {
      if (e instanceof NativeExportAbortedError) return { copied, cancelled: true }
      throw e
    }
  }
  return { copied, cancelled: false }
}

/** 写临时文件（@capacitor/share / 下载用）：分块 base64 落 app 临时目录，返回 file:// URL */
export async function writeFileToTemp(
  bridge: NativeExportBridge,
  file: File,
  name: string,
  chunkBytes = NATIVE_CHUNK_BYTES,
): Promise<string> {
  const total = file.size
  if (total === 0) {
    const res = await bridge.writeTemp({ name, data: '', isFirst: true, isLast: true })
    if (!res.ok || !res.url) throw new Error('writeTemp 未确认（ok=false 或未返回 URL）')
    return res.url
  }
  let written = 0
  let index = 0
  let url: string | undefined
  while (written < total) {
    const end = Math.min(written + chunkBytes, total)
    const isFirst = index === 0
    const isLast = end >= total
    try {
      const res = await bridge.writeTemp({
        name,
        data: await encodeChunk(file, written, end),
        isFirst,
        isLast,
      })
      assertOk(res, name)
      if (isLast) url = res.url
    } catch (e) {
      if (!(e instanceof NativeExportAbortedError)) {
        await bridge.abort().catch(() => {}) // 清理临时文件半成品
      }
      throw e
    }
    written = end
    index++
  }
  if (!url) throw new Error('writeTemp 未返回 file:// URL')
  return url
}

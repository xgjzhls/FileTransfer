/**
 * 存储层共享类型。
 *
 * `SyncHandle` 镜像 OPFS FileSystemSyncAccessHandle 的同步读写语义
 * （{at} 显式定位，不推进内部位置）；`SyncFs` 是文件系统抽象，
 * 生产实现（opfsSyncFs.ts，仅 Worker 内可用）与测试实现
 * （memorySyncFs.ts）共用同一接口 —— 存储引擎因此可脱离浏览器单测。
 */

export interface SyncHandle {
  /** 当前文件字节数 */
  getSize(): number
  /** 从 {at} 处读入 buffer，返回实际读到的字节数（到 EOF 为止） */
  read(buffer: ArrayBufferView, options?: { at?: number }): number
  /** 从 {at} 处写入 buffer，返回写入字节数（超出 EOF 自动扩展） */
  write(buffer: ArrayBufferView, options?: { at?: number }): number
  /** 截断到指定大小 */
  truncate(size: number): void
  /** 落盘（OPFS 语义；内存实现为空操作） */
  flush(): void
  close(): void
}

export interface SessionDirInfo {
  sessionId: string
  bytes: number
}

export interface SyncFs {
  /** 按根相对路径打开（不存在则创建）文件，返回同步句柄 */
  openFile(path: string): Promise<SyncHandle>
  /** 列出顶层会话目录（含各自占用字节数） */
  listSessions(): Promise<SessionDirInfo[]>
  /** 递归删除一个会话目录 */
  removeSession(sessionId: string): Promise<void>
  /** 删除 OPFS 根下全部内容 */
  removeAll(): Promise<void>
}

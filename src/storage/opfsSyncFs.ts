/**
 * OPFS 版 SyncFs —— 仅 Worker 内可用（sync access handle 必须在 worker）。
 *
 * 路径即 SPEC §4 布局（sessions/<sessionId>/<fileId>/part-<index>.bin 等），
 * 与内存版（memorySyncFs）共用同一接口与 key 约定。
 * iOS 无 createWritable，唯一写入 API 即 createSyncAccessHandle（spike 验证）。
 */

import type { SessionDirInfo, SyncFs, SyncHandle } from './types'

const SESSION_ROOT = 'sessions'

export class OpfsSyncFs implements SyncFs {
  private rootPromise: Promise<FileSystemDirectoryHandle> | null = null

  private root(): Promise<FileSystemDirectoryHandle> {
    if (!this.rootPromise) this.rootPromise = navigator.storage.getDirectory()
    return this.rootPromise
  }

  private async dirOf(path: string): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const segments = path.split('/').filter(Boolean)
    const name = segments.pop()
    if (!name) throw new Error(`invalid path: ${path}`)
    let dir = await this.root()
    for (const seg of segments) {
      dir = await dir.getDirectoryHandle(seg, { create: true })
    }
    return { dir, name }
  }

  async openFile(path: string): Promise<SyncHandle> {
    const { dir, name } = await this.dirOf(path)
    const fileHandle = await dir.getFileHandle(name, { create: true })
    return fileHandle.createSyncAccessHandle()
  }

  async listSessions(): Promise<SessionDirInfo[]> {
    const root = await this.root()
    const sessionsDir = await root.getDirectoryHandle(SESSION_ROOT, { create: true })
    const out: SessionDirInfo[] = []
    for await (const [name, handle] of (sessionsDir as FileSystemDirectoryHandle).entries()) {
      if (handle.kind !== 'directory') continue
      out.push({ sessionId: name, bytes: await dirBytes(handle) })
    }
    return out
  }

  async removeSession(sessionId: string): Promise<void> {
    const root = await this.root()
    const sessionsDir = await root.getDirectoryHandle(SESSION_ROOT, { create: true })
    await sessionsDir.removeEntry(sessionId, { recursive: true })
  }

  async removeAll(): Promise<void> {
    const root = await this.root()
    // 先收集名字再删：WebKit 在迭代中被修改会使迭代器失效
    // （"state cached in an interface object"）—— 见 spike clearOpfsTestData
    const names: string[] = []
    for await (const [name] of (root as FileSystemDirectoryHandle).entries()) {
      names.push(name)
    }
    for (const name of names) {
      await root.removeEntry(name, { recursive: true })
    }
  }
}

async function dirBytes(dir: FileSystemDirectoryHandle): Promise<number> {
  let total = 0
  for await (const [, handle] of (dir as FileSystemDirectoryHandle).entries()) {
    if (handle.kind === 'file') {
      total += (await handle.getFile()).size
    } else {
      total += await dirBytes(handle)
    }
  }
  return total
}

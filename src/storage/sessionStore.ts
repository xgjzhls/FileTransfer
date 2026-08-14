/**
 * SessionStore —— 会话 manifest 的 IndexedDB 持久化（T02 最小版 + T06 续传状态）。
 *
 * T06 扩展：files[].parts 记录每 part 的续传状态（done / partial + bitfield，
 * 64MiB 粒度）与期望 SHA-256；接收端为权威，节流写入由调用方（TransferController）
 * 控制（SPEC §3.4 节流 ≤2s）。IndexedDB 可注入（测试用 fake-indexeddb；生产用浏览器全局）。
 */

/** 单个 part 的持久化续传状态（会话 manifest 用；字段多于协议 resume_manifest） */
export interface StoredPartState {
  index: number
  state: 'done' | 'partial'
  /** base64 位图（64MiB 粒度）；done 的 part 为空 */
  bitfield: string
  /** meta 时的期望 SHA-256：恢复时对比新 meta 检测文件是否被改 */
  sha256: string
}

export interface FileManifest {
  fileId: number
  name: string
  size: number
  partCount: number
  /** T06：每 part 续传状态（旧记录无此字段 = 视为全缺） */
  parts?: StoredPartState[]
}

export interface SessionManifest {
  sessionId: string
  createdAt: number
  lastActiveAt: number
  files: FileManifest[]
}

const DB_NAME = 'localtransfer'
const DB_VERSION = 1
const STORE_NAME = 'sessions'

export class SessionStore {
  private readonly indexedDb: IDBFactory
  private dbPromise: Promise<IDBDatabase> | null = null

  constructor(indexedDb: IDBFactory = globalThis.indexedDB) {
    this.indexedDb = indexedDb
  }

  async list(): Promise<SessionManifest[]> {
    const db = await this.db()
    return req(db.transaction(STORE_NAME).objectStore(STORE_NAME).getAll())
  }

  async get(sessionId: string): Promise<SessionManifest | undefined> {
    const db = await this.db()
    const record = await req(db.transaction(STORE_NAME).objectStore(STORE_NAME).get(sessionId))
    return record as SessionManifest | undefined
  }

  async upsert(record: SessionManifest): Promise<void> {
    const db = await this.db()
    await req(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record))
  }

  async delete(sessionId: string): Promise<void> {
    const db = await this.db()
    await req(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(sessionId))
  }

  async clear(): Promise<void> {
    const db = await this.db()
    await req(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear())
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const open = this.indexedDb.open(DB_NAME, DB_VERSION)
        open.onupgradeneeded = () => {
          const db = open.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'sessionId' })
          }
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error ?? new Error('open IndexedDB failed'))
      })
    }
    return this.dbPromise
  }
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

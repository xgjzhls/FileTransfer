/**
 * Wake Lock 管理（SPEC §6.7，T08）。
 *
 * 传输期间保持屏幕常亮（iOS 17+ Safari / 新版 Chrome 支持）。
 * - 活跃传输时 acquire('screen')，结束/取消时 release
 * - 标签页切后台（iOS 会自动释放锁）→ 回前台自动重新请求
 * - 不支持 / 被拒绝 → 状态机降级为 denied/unavailable，调用方提示，不抛错
 */

export type WakeLockState =
  | 'idle' // 支持但当前未持有
  | 'held' // 正在持有（屏幕常亮中）
  | 'released' // 因后台/系统释放，等待回到前台重试
  | 'denied' // 请求被拒（如 NotAllowedError：页面不可见/策略）
  | 'unavailable' // 浏览器不支持 navigator.wakeLock

/** 我们只用到的 sentinel 子集（便于单测注入；完整 DOM 类型满足该结构） */
export interface WakeLockSentinelLike {
  release(): Promise<void>
  addEventListener(type: 'release', cb: () => void): void
  removeEventListener(type: 'release', cb: () => void): void
}

/** 我们只用到的 Document 子集（真实 Document 结构上满足） */
export interface DocLike {
  visibilityState: DocumentVisibilityState
  addEventListener(type: string, cb: () => void): void
  removeEventListener(type: string, cb: () => void): void
}

/** 可注入的最小依赖（便于单测；默认走全局 navigator/document） */
export interface WakeLockDeps {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> }
  document?: DocLike
}

const RELEASE_EVENT = 'release'
const VISIBILITY_EVENT = 'visibilitychange'

export class WakeLockManager {
  private stateValue: WakeLockState
  private sentinel: WakeLockSentinelLike | null = null
  private desired = false
  private disposed = false
  private acquireInFlight: Promise<void> | null = null
  private readonly listeners = new Set<(s: WakeLockState) => void>()
  private readonly api: WakeLockDeps['wakeLock']
  private readonly doc: WakeLockDeps['document']

  constructor(deps: WakeLockDeps = {}) {
    this.api = deps.wakeLock ?? (globalThis as { navigator?: { wakeLock?: unknown } }).navigator?.wakeLock as
      | WakeLockDeps['wakeLock']
      | undefined
    this.doc = deps.document ?? (globalThis as { document?: Document }).document
    this.stateValue = this.fallbackState
    this.doc?.addEventListener(VISIBILITY_EVENT, this.onVisibility)
  }

  get state(): WakeLockState {
    return this.stateValue
  }

  /** 无锁持有的基础状态：支持 API → idle，否则 unavailable */
  private get fallbackState(): WakeLockState {
    return this.api ? 'idle' : 'unavailable'
  }

  /** 传输活跃状态（调用方驱动：有在途发送/接收 → true） */
  async setActive(active: boolean) {
    if (this.disposed) return
    this.desired = active
    if (active) {
      if (!this.sentinel) await this.acquire()
    } else {
      await this.release()
    }
  }

  /** 显式释放（页面卸载 / 手动取消） */
  async release() {
    const s = this.sentinel
    this.sentinel = null
    if (s) {
      try {
        await s.release()
      } catch {
        // 忽略释放错误
      }
    }
    if (this.sentinel === null) {
      this.setState(this.fallbackState)
    }
  }

  /** 释放资源 + 移除监听（组件卸载；永久失效——调用方在每次挂载时新建实例） */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.doc?.removeEventListener(VISIBILITY_EVENT, this.onVisibility)
    void this.release()
  }

  subscribe(cb: (s: WakeLockState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private acquire(): Promise<void> {
    // in-flight 守卫：并发 setActive(true) 只发一次 request，避免后者覆盖前者泄漏 sentinel
    if (this.acquireInFlight) return this.acquireInFlight
    this.acquireInFlight = this.doAcquire().finally(() => {
      this.acquireInFlight = null
    })
    return this.acquireInFlight
  }

  private async doAcquire() {
    if (!this.api) {
      this.setState('unavailable')
      return
    }
    if (this.sentinel || !this.desired || this.disposed) return
    try {
      const sentinel = await this.api.request('screen')
      // 竞态：请求期间被 setActive(false) 取消 → 立刻释放拿到的锁
      if (!this.desired || this.disposed) {
        sentinel.release().catch(() => {})
        this.setState(this.fallbackState)
        return
      }
      this.sentinel = sentinel
      sentinel.addEventListener(RELEASE_EVENT, this.onSentinelRelease)
      this.setState('held')
    } catch {
      // NotAllowedError（页面不可见/权限策略）等 → 降级提示；回前台自动重试
      this.setState('denied')
    }
  }

  private onSentinelRelease = () => {
    this.sentinel = null
    if (this.desired && !this.disposed) {
      // 活跃中：可见则立即重取；隐藏（iOS 后台释放）则等回前台
      if (this.isVisible()) void this.acquire()
      else this.setState('released')
    } else {
      this.setState(this.fallbackState)
    }
  }

  private onVisibility = () => {
    if (!this.doc) return
    const visible = this.doc.visibilityState === 'visible'
    if (!visible && this.sentinel) {
      // 切后台：iOS 会释放锁；主动释放避免界面显示 stale「常亮中」
      const s = this.sentinel
      this.sentinel = null
      s.release().catch(() => {})
      this.setState(this.desired ? 'released' : this.fallbackState)
      return
    }
    if (visible && this.desired && !this.sentinel) {
      void this.acquire()
    }
  }

  private isVisible(): boolean {
    return this.doc ? this.doc.visibilityState === 'visible' : true
  }

  private setState(next: WakeLockState) {
    if (next === this.stateValue) return
    this.stateValue = next
    for (const cb of this.listeners) cb(next)
  }
}

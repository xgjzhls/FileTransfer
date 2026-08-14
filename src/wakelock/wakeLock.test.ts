import { describe, expect, it, vi } from 'vitest'
import { WakeLockManager } from './wakeLock'
import type { WakeLockState } from './wakeLock'

/** 假 WakeLockSentinel：记录 release，可手动触发 'release' 事件（模拟浏览器主动释放） */
class FakeSentinel {
  released = false
  private listeners = new Map<string, Array<() => void>>()
  addEventListener(type: string, cb: () => void) {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((f) => f !== cb))
  }
  /** 测试钩子：模拟浏览器释放（如用户切走标签页后被系统释放） */
  emitRelease() {
    this.released = true
    for (const cb of this.listeners.get('release') ?? []) cb()
  }
  async release() {
    this.emitRelease()
  }
}

/** 假 navigator.wakeLock：可注入失败；记录 request 次数与 sentinel */
class FakeWakeLock {
  requestCalls = 0
  sentinels: FakeSentinel[] = []
  failWith: Error | null = null
  async request(_type: 'screen') {
    this.requestCalls++
    if (this.failWith) throw this.failWith
    const s = new FakeSentinel()
    this.sentinels.push(s)
    return s
  }
}

interface Harness {
  wl: FakeWakeLock
  doc: {
    visibilityState: DocumentVisibilityState
    listeners: Map<string, Array<() => void>>
    addEventListener: (t: string, cb: () => void) => void
    removeEventListener: (t: string, cb: () => void) => void
    setVisible: (v: boolean) => void
  }
  manager: WakeLockManager
  states: WakeLockState[]
}

function setup(opts: { withApi?: boolean } = {}): Harness {
  const withApi = opts.withApi ?? true
  const wl = new FakeWakeLock()
  const listeners = new Map<string, Array<() => void>>()
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    listeners,
    addEventListener(t: string, cb: () => void) {
      const list = listeners.get(t) ?? []
      list.push(cb)
      listeners.set(t, list)
    },
    removeEventListener(t: string, cb: () => void) {
      listeners.set(t, (listeners.get(t) ?? []).filter((f) => f !== cb))
    },
    setVisible(v: boolean) {
      this.visibilityState = v ? 'visible' : 'hidden'
      for (const cb of listeners.get('visibilitychange') ?? []) cb()
    },
  }
  const manager = new WakeLockManager(
    withApi ? { wakeLock: wl, document: doc } : { wakeLock: undefined, document: doc },
  )
  const states: WakeLockState[] = []
  manager.subscribe((s) => states.push(s))
  return { wl, doc, manager, states }
}

describe('WakeLockManager — 传输期间保持屏幕常亮（SPEC §6.7）', () => {
  it('初始状态：支持时 idle，不支持时 unavailable', () => {
    expect(setup().manager.state).toBe('idle')
    expect(setup({ withApi: false }).manager.state).toBe('unavailable')
  })

  it('无 Wake Lock API → setActive(true) 不抛错，状态保持 unavailable，无多余通知', async () => {
    const { manager, states } = setup({ withApi: false })
    await manager.setActive(true)
    expect(manager.state).toBe('unavailable')
    expect(states).toEqual([]) // 初始即 unavailable，无状态变化 → 不通知
  })

  it('setActive(true) → 请求 screen 锁，状态 held', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    expect(wl.requestCalls).toBe(1)
    expect(manager.state).toBe('held')
  })

  it('重复 setActive(true) 幂等：只请求一次', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    await manager.setActive(true)
    await manager.setActive(true)
    expect(wl.requestCalls).toBe(1)
    expect(manager.state).toBe('held')
  })

  it('并发 setActive(true)（未 await）→ in-flight 守卫：仍只请求一次，无泄漏', async () => {
    const { wl, manager } = setup()
    await Promise.all([manager.setActive(true), manager.setActive(true), manager.setActive(true)])
    expect(wl.requestCalls).toBe(1)
    expect(wl.sentinels).toHaveLength(1)
    expect(manager.state).toBe('held')
    await manager.setActive(false)
    expect(wl.sentinels[0].released).toBe(true)
  })

  it('setActive(false) → 释放 sentinel，状态回 idle', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    expect(wl.sentinels[0].released).toBe(false)
    await manager.setActive(false)
    expect(wl.sentinels[0].released).toBe(true)
    expect(manager.state).toBe('idle')
  })

  it('未持有就 setActive(false) / release 不抛错', async () => {
    const { manager } = setup()
    await manager.setActive(false)
    await manager.release()
    expect(manager.state).toBe('idle')
  })

  it('request 被拒（NotAllowedError）→ 状态 denied，不抛错，可后续重试', async () => {
    const { wl, manager } = setup()
    wl.failWith = new DOMException('not allowed', 'NotAllowedError')
    await manager.setActive(true)
    expect(manager.state).toBe('denied')
    wl.failWith = null
    await manager.setActive(true)
    expect(wl.requestCalls).toBe(2)
    expect(manager.state).toBe('held')
  })

  it('隐藏→可见时若仍活跃 → 自动重新请求（iOS 在后台释放锁）', async () => {
    const { wl, doc, manager } = setup()
    await manager.setActive(true)
    expect(wl.requestCalls).toBe(1)
    doc.setVisible(false) // 系统释放 sentinel，锁丢失
    wl.sentinels[0].emitRelease()
    expect(manager.state).toBe('released')
    doc.setVisible(true) // 回到前台 → 重新请求（异步）
    await vi.waitFor(() => expect(wl.requestCalls).toBe(2))
    await vi.waitFor(() => expect(manager.state).toBe('held'))
  })

  it('sentinel 被浏览器主动释放且仍活跃 → 自动重新请求', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    wl.sentinels[0].emitRelease()
    expect(wl.requestCalls).toBe(2)
    expect(manager.state).toBe('held')
  })

  it('sentinel 释放但已不活跃 → 不重新请求，状态 idle', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    await manager.setActive(false)
    wl.sentinels[0].emitRelease()
    expect(wl.requestCalls).toBe(1)
    expect(manager.state).toBe('idle')
  })

  it('隐藏期间 request 被拒，回到可见时重试成功', async () => {
    const { wl, doc, manager } = setup()
    wl.failWith = new DOMException('hidden', 'NotAllowedError')
    doc.setVisible(false)
    await manager.setActive(true)
    expect(manager.state).toBe('denied')
    wl.failWith = null
    doc.setVisible(true)
    await vi.waitFor(() => expect(wl.requestCalls).toBe(2))
    await vi.waitFor(() => expect(manager.state).toBe('held'))
  })

  it('subscribe 在每次状态变化时通知；unsubscribe 后不再通知', async () => {
    const { manager } = setup()
    const seen: WakeLockState[] = []
    const unsub = manager.subscribe((s) => seen.push(s))
    await manager.setActive(true)
    await manager.setActive(false)
    expect(seen).toEqual(['held', 'idle'])
    unsub()
    await manager.setActive(true)
    await manager.setActive(false)
    expect(seen).toEqual(['held', 'idle']) // 退订后不再追加
  })

  it('dispose 释放锁并移除 visibility 监听；之后 setActive 永久失效（StrictMode 由调用方重建实例）', async () => {
    const { wl, doc, manager } = setup()
    await manager.setActive(true)
    manager.dispose()
    expect(wl.sentinels[0].released).toBe(true)
    const before = doc.listeners.get('visibilitychange')?.length ?? 0
    doc.setVisible(false)
    doc.setVisible(true)
    // dispose 后不再响应可见性变化 → 不再请求
    expect(doc.listeners.get('visibilitychange')?.length ?? 0).toBe(before)
    expect(wl.requestCalls).toBe(1)
    expect(manager.state).toBe('idle')
    // dispose 后 setActive 不产生任何请求
    await manager.setActive(true)
    expect(wl.requestCalls).toBe(1)
    expect(manager.state).toBe('idle')
  })

  it('request 抛非标准错误（如安全策略）→ 视为 denied 不崩溃', async () => {
    const { wl, manager } = setup()
    wl.failWith = new Error('wake lock disabled by policy')
    await manager.setActive(true)
    expect(manager.state).toBe('denied')
  })

  it('setActive 快速切换不产生竞态：最终释放', async () => {
    const { wl, manager } = setup()
    const p1 = manager.setActive(true)
    const p2 = manager.setActive(false)
    await Promise.all([p1, p2])
    expect(wl.sentinels[0].released).toBe(true)
    expect(manager.state).toBe('idle')
  })
})

describe('WakeLockManager — document/visibility 依赖注入', () => {
  it('未传 document 时使用全局 document（默认依赖）', () => {
    // vitest node 环境无全局 document → 构造函数应能安全跳过监听注册
    const wl = new FakeWakeLock()
    const m = new WakeLockManager({ wakeLock: wl })
    expect(m.state).toBe('idle')
  })

  it('外部释放 sentinel 后 state 反映 released，且不重复 request（非活跃时）', async () => {
    const { wl, manager } = setup()
    await manager.setActive(true)
    await manager.setActive(false)
    wl.sentinels[0].emitRelease()
    expect(manager.state).toBe('idle')
  })

  it('release() 幂等：多次调用不抛错', async () => {
    const { manager } = setup()
    await manager.release()
    await manager.release()
    expect(manager.state).toBe('idle')
  })

  it('vi 兼容：subscribe 回调在异步状态机中按序触发', async () => {
    const { manager } = setup()
    const spy = vi.fn()
    manager.subscribe(spy)
    await manager.setActive(true)
    await manager.setActive(false)
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['held', 'idle'])
  })
})

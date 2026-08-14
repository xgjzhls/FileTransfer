/**
 * ReconnectingSignalingClient —— 信令 WS 自动重连（T09）。
 *
 * 在 SignalingClient（单 socket 路由）之上包一层连接生命周期：
 * WS 断开 → 指数退避（1s→2s→4s…封顶 30s）自动重连 → 重新 join 原房间码
 * → room_state 恢复设备列表。最多自动重连 10 次（退避合计约 3 分钟）；
 * 仍失败则转「offline」态，等用户手动 retry()。
 *
 * 状态机（T09 验收 1/2/3/4）：
 *   connecting → connected ⇄ reconnecting → offline（手动 retry 回到 connecting）
 *   close() 为主动关闭：清定时器、关底层 socket、不再自动重连。
 */

import type { DeviceInfo, SignalPayload } from '../protocol/signaling'
import { SignalingClient } from './client'
import type { SignalingEvents, SignalingSocket } from './client'

export type SignalingConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline'

export interface ReconnectingSignalingClientOptions {
  /** 每次连接前创建底层 socket（浏览器 WebSocket / 测试假 socket） */
  createSocket(url: string): SignalingSocket
  /** 消息路由回调（与 SignalingClient 相同） */
  events: SignalingEvents
  /** 连接状态变化（UI 展示：连接中 / 已连接 / 重连中 / 离线） */
  onState(state: SignalingConnState): void
  /** 连续失败达到上限、放弃自动重连时回调（提示手动操作） */
  onGaveUp?(): void
  /** 初始退避延迟（ms），默认 1000 */
  initialDelayMs?: number
  /** 退避封顶（ms），默认 30000 */
  maxDelayMs?: number
  /** 自动重连次数上限（达到后放弃、转 offline），默认 10 */
  maxAttempts?: number
}

export class ReconnectingSignalingClient {
  private readonly createSocket: (url: string) => SignalingSocket
  private readonly events: SignalingEvents
  private readonly onState: (state: SignalingConnState) => void
  private readonly onGaveUp?: () => void
  private readonly initialDelayMs: number
  private readonly maxDelayMs: number
  private readonly maxAttempts: number

  private socket: SignalingSocket | null = null
  private client: SignalingClient | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 连续失败次数（每次成功 open 归零） */
  private attempts = 0
  /** true 表示主动关闭或从未连接（不自动重连） */
  private closed = true
  private url = ''
  private room = ''
  private device: DeviceInfo | null = null
  private _state: SignalingConnState = 'idle'

  constructor(options: ReconnectingSignalingClientOptions) {
    this.createSocket = options.createSocket
    this.events = options.events
    this.onState = options.onState
    this.onGaveUp = options.onGaveUp
    this.initialDelayMs = options.initialDelayMs ?? 1_000
    this.maxDelayMs = options.maxDelayMs ?? 30_000
    this.maxAttempts = options.maxAttempts ?? 10
  }

  /** 连接并 join 房间；可重复调用切换房间（自动关闭旧连接与定时器） */
  connect(url: string, room: string, device: DeviceInfo): void {
    this.close()
    this.attempts = 0
    this.url = url
    this.room = room
    this.device = device
    this.closed = false
    this.open()
  }

  /** 手动重连（offline 态恢复）：重置失败计数后立即连接 */
  retry(): void {
    if (this.closed) return
    this.attempts = 0
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.open()
  }

  /**
   * 测试钩子：模拟底层 WS 被外力断开（网络抖动 / 服务重启 / 锁屏回收）。
   * 与 close() 不同：不停止自动重连——底层 socket 的 close 事件照常触发
   * 退避重连路径。生产代码不调用；供 e2e 断线重连用例（T09）使用。
   */
  forceDisconnect(): void {
    this.client?.close()
  }

  signal(to: string, payload: SignalPayload): void {
    // 非 connected 时底层 socket 可能已关闭：send 会抛错，静默丢弃
    //（断线期间对陈旧 peer 的点击不应产生异常；重连后 room_state 会刷新列表）
    if (this._state !== 'connected') return
    this.client?.signal(to, payload)
  }

  leave(): void {
    if (this._state !== 'connected') return
    this.client?.leave()
  }

  /** 主动关闭：清定时器、关底层 socket、不再自动重连 */
  close(): void {
    this.closed = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.client?.close()
    this.socket = null
    this.client = null
    this.setState('idle')
  }

  private open(): void {
    if (this.closed) return
    this.setState('connecting')
    const socket = this.createSocket(this.url)
    this.socket = socket
    this.client = new SignalingClient(socket, this.events)
    socket.on('open', () => {
      // 旧 socket 迟到的 open 忽略（已切换/已关闭）
      if (this.closed || socket !== this.socket || !this.device) return
      this.client?.join(this.room, this.device)
      this.attempts = 0
      this.setState('connected')
    })
    socket.on('error', () => {
      if (this.closed || socket !== this.socket) return
      this.fail()
    })
    socket.on('close', () => {
      if (this.closed || socket !== this.socket) return
      this.fail()
    })
  }

  /** 一次连接失败：error/close 双事件只排程一次 */
  private fail(): void {
    if (this.closed || this.timer !== null) return
    // 收尾失败的 socket：真实 WS 的 error 后总会跟随 close，但若只有 error
    // （或已断开），先关掉旧连接，避免死 socket 残留再收到迟到事件
    this.client?.close()
    this.attempts++
    if (this.attempts > this.maxAttempts) {
      this.setState('offline')
      this.onGaveUp?.()
      return
    }
    const delay = Math.min(this.initialDelayMs * 2 ** (this.attempts - 1), this.maxDelayMs)
    this.setState('reconnecting')
    this.timer = setTimeout(() => {
      this.timer = null
      this.open()
    }, delay)
  }

  private setState(state: SignalingConnState): void {
    if (state === this._state) return
    this._state = state
    this.onState(state)
  }
}

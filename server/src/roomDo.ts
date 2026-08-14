/**
 * Room —— Durable Object 房间（WebSocket Hibernation API）。
 *
 * 薄壳：WebSocket 生命周期 + presence 持久化 + 过期 alarm；业务逻辑全部在
 * RoomCore（已单测）。消息格式遵循 SPEC §5.2。
 *
 * T10 presence 持久化：DO evict（Hibernation 保留连接、内存清空）后唤醒时，
 * 从 `ctx.storage` 重建 RoomCore.peers / deviceByWs / wsByDevice，设备无需
 * 重新 join。重建钩子：实例首个 webSocketMessage / alarm 时 restoreIfNeeded。
 *
 * 过期回收：每次 join/leave 重置 alarm 到 24h 后；alarm 触发时先重建 presence，
 * 若房间为空 → 删除状态（房间回收）；有设备 → 顺延（连接存在即活跃）。
 */

import { RoomCore } from './room'
import type { PeerConnection } from './room'
import type { ClientMessage, DeviceInfo, PeerInfo } from '../../src/protocol/signaling'

export const MAX_PEERS = 8
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24h 无活动回收（SPEC §5 / 票 T03）

/** presence 持久化键前缀：`presence:<deviceId>` → PeerInfo */
export const PRESENCE_PREFIX = 'presence:'
const presenceKey = (deviceId: string) => PRESENCE_PREFIX + deviceId

/** 从 WS URL 提取设备身份（客户端 join 时 URL 带 `?device=<uuid>`） */
export function deviceIdFromUrl(url: string): string | null {
  try {
    const id = new URL(url).searchParams.get('device')
    return id && id.length > 0 ? id : null
  } catch {
    return null
  }
}

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
}

export class Room implements DurableObject, Rpc.DurableObjectBranded {
  declare readonly [Rpc.__DURABLE_OBJECT_BRAND]: never
  private readonly core = new RoomCore(MAX_PEERS)
  private readonly deviceByWs = new Map<WebSocket, string>()
  private readonly wsByDevice = new Map<string, WebSocket>()
  /** 本实例是否已从 storage 重建 presence（每个实例只建一次） */
  private restored = false
  protected readonly ctx: DurableObjectState
  protected readonly env: Env

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket connection', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // deviceId 在 URL 上（join 消息到达前就必须打 tag；Hibernation tag 无法事后修改）
    const deviceId = deviceIdFromUrl(request.url)
    this.ctx.acceptWebSocket(server, deviceId ? [deviceId] : undefined)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.restoreIfNeeded()

    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return // 非法 JSON：忽略
    }

    const knownId = this.deviceByWs.get(ws)
    if (msg.type !== 'join') {
      if (!knownId) {
        ws.send(JSON.stringify({ type: 'error', reason: 'join first' }))
        return
      }
      if (msg.type === 'leave') {
        this.drop(knownId)
        return
      }
      if (msg.type === 'signal') {
        this.core.signal(knownId, msg.to, msg.payload)
        return
      }
      return
    }

    // join
    if (knownId) {
      if (knownId === msg.device.id) {
        // 同一连接重复 join：仅刷新 room_state
        ws.send(JSON.stringify({ type: 'room_state', peers: this.core.peerInfos() }))
        return
      }
      // 同一连接换 deviceId（异常）：先按旧 id 离开
      this.drop(knownId)
    }
    await this.handleJoin(ws, msg)
  }

  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    const deviceId = this.deviceByWs.get(ws)
    if (!deviceId) return
    this.deviceByWs.delete(ws)
    // 若该 device 已有新连接（重连替换），旧连接关闭不应触发 leave
    if (this.wsByDevice.get(deviceId) === ws) {
      this.wsByDevice.delete(deviceId)
      this.core.leave(deviceId)
      await this.deletePresence(deviceId)
      this.scheduleExpiry()
    }
  }

  async alarm(): Promise<void> {
    // evict 后唤醒可能先到 alarm：先重建 presence 再判空，避免误删活跃房间
    await this.restoreIfNeeded()
    if (this.core.size === 0) {
      await this.ctx.storage.deleteAll()
    } else {
      this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    }
  }

  /**
   * T10 唤醒重建：从 storage 恢复 presence → 重建 core / deviceByWs / wsByDevice。
   * 脏数据（presence 在但对应 socket 已不在）跳过并清理；持久化失败兜底为空房间。
   */
  private async restoreIfNeeded(): Promise<void> {
    if (this.restored) return
    this.restored = true
    let entries: Map<string, unknown>
    try {
      entries = await this.ctx.storage.list({ prefix: PRESENCE_PREFIX })
    } catch (e) {
      console.error('[room] presence restore failed, start empty:', String(e))
      return
    }
    for (const [key, value] of entries) {
      const deviceId = key.slice(PRESENCE_PREFIX.length)
      const info = value as PeerInfo
      // 该设备必须有存活 socket（Hibernation tag 按 deviceId 打）才恢复
      const [ws] = this.ctx.getWebSockets(deviceId)
      if (!ws) {
        // 脏数据：presence 残留但连接已回收（如 DO 迁移/连接异常关闭）
        void this.ctx.storage.delete(key).catch(() => {})
        continue
      }
      this.deviceByWs.set(ws, deviceId)
      this.wsByDevice.set(deviceId, ws)
      this.core.restore([{ info, conn: this.connFor(ws) }])
    }
  }

  private async handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): Promise<void> {
    const oldWs = this.wsByDevice.get(msg.device.id)
    if (oldWs && oldWs !== ws) {
      // 重连：core.join 会关闭旧连接；先解除旧映射，避免其 close hook 触发 leave
      this.deviceByWs.delete(oldWs)
    }
    const result = this.core.join(msg.device, this.connFor(ws))
    if (result.kind === 'full') return // core 已发 error + close
    this.deviceByWs.set(ws, msg.device.id)
    this.wsByDevice.set(msg.device.id, ws)
    await this.persistPresence(msg.device)
    this.scheduleExpiry()
  }

  private drop(deviceId: string): void {
    const ws = this.wsByDevice.get(deviceId)
    if (ws) {
      this.deviceByWs.delete(ws)
      this.wsByDevice.delete(deviceId)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
    }
    this.core.leave(deviceId)
    void this.deletePresence(deviceId)
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
  }

  /** presence 持久化是尽力而为：失败不阻断房间功能（内存态仍有效） */
  private async persistPresence(info: DeviceInfo): Promise<void> {
    try {
      await this.ctx.storage.put(presenceKey(info.id), info)
    } catch (e) {
      console.error('[room] presence persist failed:', String(e))
    }
  }

  private async deletePresence(deviceId: string): Promise<void> {
    try {
      await this.ctx.storage.delete(presenceKey(deviceId))
    } catch (e) {
      console.error('[room] presence delete failed:', String(e))
    }
  }

  private connFor(ws: WebSocket): PeerConnection {
    return {
      send: (m) => ws.send(JSON.stringify(m)),
      close: (code, reason) => ws.close(code, reason),
    }
  }
}

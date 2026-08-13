/**
 * Room —— Durable Object 房间（WebSocket Hibernation API）。
 *
 * 薄壳：WebSocket 生命周期 + 过期 alarm；业务逻辑全部在 RoomCore
 * （已单测）。消息格式遵循 SPEC §5.2。
 *
 * 过期回收：每次 join/leave 重置 alarm 到 24h 后；alarm 触发时
 * 若房间为空 → 删除状态（房间回收）；有设备 → 顺延（连接存在即活跃）。
 */

import { RoomCore } from './room'
import type { ClientMessage } from '../../src/protocol/signaling'

export const MAX_PEERS = 8
const ROOM_TTL_MS = 24 * 60 * 60 * 1000 // 24h 无活动回收（SPEC §5 / 票 T03）

export interface Env {
  ROOMS: DurableObjectNamespace<Room>
}

export class Room implements DurableObject, Rpc.DurableObjectBranded {
  declare readonly [Rpc.__DURABLE_OBJECT_BRAND]: never
  private readonly core = new RoomCore(MAX_PEERS)
  private readonly deviceByWs = new Map<WebSocket, string>()
  private readonly wsByDevice = new Map<string, WebSocket>()
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
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): void {
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
    this.handleJoin(ws, msg)
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const deviceId = this.deviceByWs.get(ws)
    if (!deviceId) return
    this.deviceByWs.delete(ws)
    // 若该 device 已有新连接（重连替换），旧连接关闭不应触发 leave
    if (this.wsByDevice.get(deviceId) === ws) {
      this.wsByDevice.delete(deviceId)
      this.core.leave(deviceId)
      this.scheduleExpiry()
    }
  }

  async alarm(): Promise<void> {
    if (this.core.size === 0) {
      await this.ctx.storage.deleteAll()
    } else {
      this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    }
  }

  private handleJoin(ws: WebSocket, msg: Extract<ClientMessage, { type: 'join' }>): void {
    const oldWs = this.wsByDevice.get(msg.device.id)
    if (oldWs && oldWs !== ws) {
      // 重连：core.join 会关闭旧连接；先解除旧映射，避免其 close hook 触发 leave
      this.deviceByWs.delete(oldWs)
    }
    const result = this.core.join(msg.device, {
      send: (m) => ws.send(JSON.stringify(m)),
      close: (code, reason) => ws.close(code, reason),
    })
    if (result.kind === 'full') return // core 已发 error + close
    this.deviceByWs.set(ws, msg.device.id)
    this.wsByDevice.set(msg.device.id, ws)
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
    this.scheduleExpiry()
  }

  private scheduleExpiry(): void {
    this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
  }
}

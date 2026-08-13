/**
 * LocalTransfer 信令服务入口（SPEC §5）。
 *
 * 路由：
 *   GET  /            → 服务信息（冒烟/健康检查）
 *   POST /api/room    → 生成 4 字符房间码（服务端生成，§5.4）
 *   GET  /ws?room=X   → 升级 WebSocket → 房间 Durable Object
 *
 * 纯转发不落盘：只传 presence 与 SDP，数据面永不接触（ADR-0004）。
 */

import { Room } from './roomDo'
import type { Env } from './roomDo'
import { generateRoomCode } from './roomCode'

export { Room }
export type { Env }

const ROOM_CODE_RE = /^[2-9A-HJ-NP-Z]{4}$/

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'localtransfer-signaling', spec: 'SPEC §5.2' })
    }

    if (request.method === 'POST' && url.pathname === '/api/room') {
      return json({ room: generateRoomCode() })
    }

    if (request.method === 'GET' && url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? ''
      if (!ROOM_CODE_RE.test(room)) {
        return json({ error: 'invalid room code' }, 400)
      }
      const id = env.ROOMS.idFromName(room)
      return env.ROOMS.get(id).fetch(request)
    }

    return json({ error: 'not found' }, 404)
  },
} satisfies ExportedHandler<Env>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

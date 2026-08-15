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
import { generateRoomCode, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './roomCode'

export { Room }
export type { Env }

// 从字母表派生，避免第二处手写正则漂移（客户端另有同字母表，见 roomCode.test 交叉校验）
const ROOM_CODE_RE = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`)

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // CORS：前端（GitHub Pages / localhost）跨域调用 /api/room；
    // WebSocket 升级不受 CORS 约束，但统一响应头无害。
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }))
    }

    if (request.method === 'GET' && url.pathname === '/') {
      return cors(json({ ok: true, service: 'localtransfer-signaling', spec: 'SPEC §5.2' }))
    }

    if (request.method === 'POST' && url.pathname === '/api/room') {
      return cors(json({ room: generateRoomCode() }))
    }

    if (request.method === 'GET' && url.pathname === '/ws') {
      const room = url.searchParams.get('room') ?? ''
      if (!ROOM_CODE_RE.test(room)) {
        return cors(json({ error: 'invalid room code' }, 400))
      }
      const id = env.ROOMS.idFromName(room)
      return env.ROOMS.get(id).fetch(request)
    }

    return cors(json({ error: 'not found' }, 404))
  },
} satisfies ExportedHandler<Env>

function cors(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  headers.set('Access-Control-Allow-Headers', 'content-type')
  return new Response(response.body, { status: response.status, headers })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

#!/usr/bin/env node
/**
 * 信令服务冒烟测试（T03 验收 5）：两个 WebSocket 客户端连同一房间互通 signal。
 *
 * 用法：node server/smoke.mjs [origin]
 *   origin 默认 http://localhost:8787（wrangler dev 本地）
 *   部署后：node server/smoke.mjs https://localtransfer-signaling.xxx.workers.dev
 *
 * 流程：POST /api/room → 建两连接 → join → 校验 room_state/peer_joined →
 *       双向 signal 转发 → leave → peer_left。全过打印 PASS，退出码 0。
 */

const origin = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '')
const wsOrigin = origin.replace(/^http/, 'ws')

const steps = []
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function openClient(room, deviceId = `smoke-${Math.random().toString(36).slice(2, 8)}`) {
  return new Promise((resolve, reject) => {
    // URL 带 device：与服务端 Hibernation tag（T10）对齐
    const ws = new WebSocket(`${wsOrigin}/ws?room=${room}&device=${deviceId}`)
    const queue = []
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      queue.push(msg)
    }
    ws.onopen = () => resolve({ ws, next: () => (queue.length ? queue.shift() : null) })
    ws.onerror = () => reject(new Error('ws error'))
    ws.onclose = () => {
      // 客户端已显式 close 时忽略
    }
  })
}

async function expectMsg(client, predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const msg = client.next()
    if (msg && predicate(msg)) return msg
    if (msg) {
      // 非目标消息：打印但继续等（如 history room_state）
    }
    await wait(20)
  }
  throw new Error(`timeout waiting for ${label}`)
}

async function main() {
  console.log(`smoke: ${origin}`)

  // 1. 建房间
  const resp = await fetch(`${origin}/api/room`, { method: 'POST' })
  if (resp.status !== 200) throw new Error(`POST /api/room → ${resp.status}`)
  const { room } = await resp.json()
  step('POST /api/room 返回房间码', /^[2-9A-HJ-NP-Z]{4}$/.test(room), room)

  // 2. A、B 连接
  const a = await openClient(room)
  const b = await openClient(room)
  step('两个客户端 WebSocket 连接成功', true)

  // 3. A join → room_state 只含 A
  a.ws.send(JSON.stringify({ type: 'join', room, device: { id: 'smoke-A', name: 'Smoke A', kind: 'phone' } }))
  const stateA = await expectMsg(a, (m) => m.type === 'room_state', 'A 的 room_state')
  step('A join 收到 room_state', stateA.peers.length === 1 && stateA.peers[0].id === 'smoke-A')

  // 4. B join → A 收 peer_joined、B 收 room_state(2)
  b.ws.send(JSON.stringify({ type: 'join', room, device: { id: 'smoke-B', name: 'Smoke B', kind: 'desktop' } }))
  const joinedA = await expectMsg(a, (m) => m.type === 'peer_joined', 'A 的 peer_joined')
  const stateB = await expectMsg(b, (m) => m.type === 'room_state', 'B 的 room_state')
  step(
    'B join：A 收到 peer_joined(B)，B 收到含两台的 room_state',
    joinedA.peer.id === 'smoke-B' &&
      stateB.peers.length === 2 &&
      stateB.peers.some((p) => p.id === 'smoke-A') &&
      stateB.peers.some((p) => p.id === 'smoke-B'),
  )

  // 5. B→A signal（offer）
  b.ws.send(JSON.stringify({ type: 'signal', to: 'smoke-A', payload: { kind: 'offer', sdp: 'v=0 offer-smoke' } }))
  const sigA = await expectMsg(a, (m) => m.type === 'signal', 'A 收到 offer')
  step('B→A signal 转发', sigA.from === 'smoke-B' && sigA.payload.kind === 'offer' && sigA.payload.sdp === 'v=0 offer-smoke')

  // 6. A→B signal（answer）
  a.ws.send(JSON.stringify({ type: 'signal', to: 'smoke-B', payload: { kind: 'answer', sdp: 'v=0 answer-smoke' } }))
  const sigB = await expectMsg(b, (m) => m.type === 'signal', 'B 收到 answer')
  step('A→B signal 转发', sigB.from === 'smoke-A' && sigB.payload.kind === 'answer')

  // 7. B leave → A 收 peer_left
  b.ws.send(JSON.stringify({ type: 'leave' }))
  const leftA = await expectMsg(a, (m) => m.type === 'peer_left', 'A 收到 peer_left')
  step('B leave：A 收到 peer_left', leftA.peerId === 'smoke-B')

  // 8. 重复 join 幂等：A 再 join 同 id，应只收 room_state（无 peer_joined 广播给自己或 B——B 已走）
  a.ws.send(JSON.stringify({ type: 'join', room, device: { id: 'smoke-A', name: 'Smoke A', kind: 'phone' } }))
  const stateA2 = await expectMsg(a, (m) => m.type === 'room_state', 'A 重连 room_state')
  step('同 deviceId 重连幂等（仅 room_state 刷新）', stateA2.peers.length === 1 && stateA2.peers[0].id === 'smoke-A')

  a.ws.close()
  b.ws.close()

  const failed = steps.filter((s) => !s.ok)
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${steps.length - failed.length}/${steps.length} 步通过`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})

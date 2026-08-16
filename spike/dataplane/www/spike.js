'use strict';

/* =====================================================================
 * LocalTransfer 数据面 spike（T01）— 单文件，无依赖，无构建。
 * 验证：WKWebView（Capacitor）内 RTCPeerConnection + RTCDataChannel
 *   · 建连（WKWebView↔WKWebView / WKWebView↔Chrome）
 *   · WebKit bug 174500：仅数据通道是否需要摄像头/麦克风权限、授权后是否可用
 *   · 吞吐（≥30 MiB/s 量级）、峰值内存、后台/锁屏挂起
 * 信令复用正式服务器（只转发 SDP，数据面直连）。
 * ===================================================================== */

/* ---------------- 常量 ---------------- */
const PIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CHUNK = 64 * 1024 // 64 KiB / 块（两端安全尺寸）
const BACKPRESSURE_LIMIT = 8 * 1024 * 1024 // bufferedAmount 等待阈值
const GATHER_TIMEOUT_MS = 20_000
const DEFAULT_SIG = 'wss://localtransfer-signaling.dirichray.workers.dev/ws'
const GAP_MS = 2_000 // 收包间隙判据（后台/锁屏挂起信号）
const PROGRESS_LOG_BYTES = 16 * 1024 * 1024

/* ---------------- DOM 助手 ---------------- */
const $ = (id) => document.getElementById(id)
const setText = (id, s) => { $(id).textContent = s }

/* ---------------- 日志 ---------------- */
const logEl = $('log')
let logCount = 0
function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.join(' ')}`
  logCount++
  logEl.textContent += line + '\n'
  if (logCount > 3000) {
    const lines = logEl.textContent.split('\n')
    logEl.textContent = lines.slice(lines.length - 1500).join('\n')
    logCount = 1500
  }
  logEl.scrollTop = logEl.scrollHeight
  console.log(line)
}
function fmt(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`
}
function randSuffix(n = 4) {
  let s = ''
  for (let i = 0; i < n; i++) s += PIN_ALPHABET[Math.floor(Math.random() * PIN_ALPHABET.length)]
  return s
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- 环境自检 ---------------- */
const ua = navigator.userAgent
const isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())
const looksLikeWKWebView = /iPhone|iPad|iPod/.test(ua) && !/Safari\//.test(ua)
const isWKWebView = isCapacitor || looksLikeWKWebView
const kind = isCapacitor ? 'phone' : /Mac|Linux|Windows/.test(navigator.platform || '') ? 'desktop' : 'other'

const deviceId = (() => {
  if (crypto.randomUUID) return crypto.randomUUID()
  return `lt-${randSuffix(8)}`
})()
const deviceName = `${isCapacitor ? 'App' : kind === 'desktop' ? 'Chrome' : 'Browser'}-${randSuffix(4)}`

function renderEnv() {
  const lines = [
    `UA: ${ua}`,
    `isCapacitor: ${isCapacitor}  isWKWebView(判定): ${isWKWebView}`,
    `secure context: ${window.isSecureContext}`,
    `RTCPeerConnection: ${typeof RTCPeerConnection !== 'undefined' ? '✓' : '✗ 无'}`,
    `RTCDataChannel 默认支持: ${typeof RTCDataChannel !== 'undefined' ? '✓' : 'n/a'}`,
    `getUserMedia: ${typeof navigator.mediaDevices?.getUserMedia === 'function' ? '✓' : '✗ 无'}`,
    `deviceMemory: ${navigator.deviceMemory ?? 'n/a'} GB`,
    `performance.memory: ${typeof performance.memory !== 'undefined' ? '✓' : '✗（WKWebView 无此 API）'}`,
    `deviceId: ${deviceId}`,
    `deviceName: ${deviceName}`,
  ]
  setText('env', lines.join('\n'))
}

/* ---------------- 信令（复用正式协议：SPEC §5.2） ---------------- */
let ws = null
let room = ''
let joined = false
const peers = new Map() // id -> {id,name,kind}

function openWs(url) {
  return new Promise((resolve, reject) => {
    let s
    try {
      s = new WebSocket(url)
    } catch (e) {
      reject(new Error(`WebSocket 构造失败: ${e.message}`))
      return
    }
    const timer = setTimeout(() => reject(new Error('信令连接超时（10s）')), 10_000)
    s.onopen = () => { clearTimeout(timer); log(`✓ 信令已连接：${url}`); resolve(s) }
    s.onerror = () => { clearTimeout(timer); reject(new Error('信令连接失败（网络 / 服务器不可达）')) }
    s.onclose = () => {
      if (joined) log('⚠ 信令连接关闭')
      joined = false
      ws = null
      peers.clear()
      renderPeers('信令未连接')
    }
    s.onmessage = (e) => {
      try { handleMsg(JSON.parse(String(e.data))) }
      catch (err) { log(`⚠ 非法信令消息: ${err.message}`) }
    }
  })
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'room_state':
      peers.clear()
      for (const p of msg.peers) if (p.id !== deviceId) peers.set(p.id, p)
      log(`房间状态：${peers.size} 个其他设备（${[...peers.values()].map((p) => `${p.name}(${p.kind})`).join('，') || '无'}）`)
      renderPeers()
      break
    case 'peer_joined':
      if (msg.peer.id !== deviceId) {
        peers.set(msg.peer.id, msg.peer)
        log(`设备加入：${msg.peer.name} (${msg.peer.kind})`)
        renderPeers()
      }
      break
    case 'peer_left':
      peers.delete(msg.peerId)
      log(`设备离开：${msg.peerId.slice(0, 8)}…`)
      renderPeers()
      break
    case 'signal':
      handleSignal(msg.from, msg.payload)
      break
    case 'error':
      log(`✗ 信令错误：${msg.reason}`)
      break
  }
}

function sendRaw(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('信令未连接')
  ws.send(JSON.stringify(obj))
}
function sendSignal(to, payload) { sendRaw({ type: 'signal', to, payload }) }

async function joinRoom() {
  const code = $('room').value.trim().toUpperCase()
  if (!new RegExp(`^[${PIN_ALPHABET}]{4}$`).test(code)) {
    log('✗ 房间码需为 4 位（字母表 23456789ABCDEFGHJKLMNPQRSTUVWXYZ）')
    return
  }
  room = code
  const base = $('sigUrl').value.trim() || DEFAULT_SIG
  // 服务端 /ws 要求 URL 带 room + device（与正式前端一致，SPEC §5.2）
  const url = `${base}${base.includes('?') ? '&' : '?'}room=${encodeURIComponent(room)}&device=${encodeURIComponent(deviceId)}`
  try {
    // 信令断线/抖动重试（正式前端有 reconnect 逻辑，spike 页做轻量重试）
    for (let attempt = 1; ; attempt++) {
      try {
        if (!ws || ws.readyState !== WebSocket.OPEN) ws = await openWs(url)
        break
      } catch (e) {
        if (attempt >= 3) throw e
        log(`⚠ 信令连接失败（第 ${attempt} 次），1s 后重试…`)
        await sleep(1000)
      }
    }
    sendRaw({ type: 'join', room, device: { id: deviceId, name: deviceName, kind } })
    joined = true
    log(`✓ 已加入房间 ${room}（本机 = ${deviceName}）`)
  } catch (e) {
    log(`✗ 加入失败：${e.message}`)
  }
}

function leaveRoom() {
  try { if (ws && ws.readyState === WebSocket.OPEN) sendRaw({ type: 'leave' }) } catch { /* noop */ }
  joined = false
  try { ws?.close() } catch { /* noop */ }
  ws = null
  peers.clear()
  renderPeers('已离开房间')
  log('已离开房间')
}

function renderPeers(prefix) {
  if (prefix) { setText('peers', prefix); return }
  if (peers.size === 0) { setText('peers', `房间 ${room}：暂无其他设备（等对端加入）`); return }
  const lines = [`房间 ${room} · 其他设备（点「发起连接」将连接列表第一个）：`]
  for (const p of peers.values()) {
    lines.push(`  · ${p.name}  kind=${p.kind}  id=${p.id.slice(0, 8)}…`)
  }
  setText('peers', lines.join('\n'))
}

/* ---------------- WebRTC 数据面（无媒体，无 STUN —— 局域网直连） ---------------- */
let pc = null
let dc = null
let connState = 'idle'
let connStart = 0
let connectMs = 0
let bufferedLowResolve = null
let tpRunning = false
let lastSent = 0

/* 接收端统计 */
const recv = { bytes: 0, firstTs: 0, lastTs: 0, prevTs: 0, t0: 0, gaps: [] }
let bytesSinceLog = 0

/* 内存采样 */
let memBaseline = 0
let memPeak = 0
let memTimer = null
const sampleMem = () => (performance.memory && performance.memory.usedJSHeapSize) || 0
function startMemSampling() {
  memBaseline = sampleMem()
  memPeak = 0
  if (typeof performance.memory === 'undefined') {
    log('（内存：本环境无 performance.memory —— WKWebView 峰值请在 Xcode 内存仪表观察）')
    return
  }
  memTimer = setInterval(() => {
    const m = sampleMem()
    if (m > memPeak) memPeak = m
  }, 300)
}
function stopMemSampling() {
  if (memTimer) { clearInterval(memTimer); memTimer = null }
}
function memDeltaText() {
  if (!memPeak) return 'n/a（无 performance.memory）'
  return `+${fmt(memPeak - memBaseline)}（基线 ${fmt(memBaseline)} → 峰值 ${fmt(memPeak)}）`
}

/* 控制帧（text=JSON 控制，binary=数据块） */
function sendControl(obj) { dc.send(JSON.stringify(obj)) }
function onControl(obj) {
  switch (obj.t) {
    case 'ping': sendControl({ t: 'pong', n: obj.n }); break
    case 'pong': {
      const r = latencyWaiters.get(obj.n)
      if (r) { latencyWaiters.delete(obj.n); r(performance.now()) }
      break
    }
    case 'tp-start': {
      log(`▶ 收到对端吞吐开始：${fmt(obj.total)}`)
      recv.bytes = 0; recv.firstTs = 0; recv.lastTs = 0; recv.prevTs = 0; recv.gaps = []
      recv.t0 = performance.now()
      bytesSinceLog = 0
      startMemSampling()
      break
    }
    case 'tp-end': {
      // 发送端已发完 → 统计并回传汇总
      const wallMs = recv.firstTs ? recv.lastTs - recv.firstTs : 0
      const memDelta = memPeak ? memPeak - memBaseline : null
      stopMemSampling()
      log(`✓ 对端数据已收完：${fmt(recv.bytes)}，首包→末包 ${(wallMs / 1000).toFixed(2)}s`)
      if (recv.gaps.length) {
        log(`⚠ 收包间隙（>${GAP_MS / 1000}s，疑似后台/锁屏挂起）：${recv.gaps.map((g) => `t+${(g.at / 1000).toFixed(1)}s 间隙 ${(g.ms / 1000).toFixed(1)}s`).join('；')}`)
      } else {
        log('✓ 无收包间隙（传输未被后台/锁屏打断）')
      }
      if (memDelta != null) log(`（内存峰值（接收端）：+${fmt(memDelta)}）`)
      sendControl({ t: 'tp-done', id: obj.id, received: recv.bytes, wallMs, gaps: recv.gaps, memDelta })
      break
    }
    case 'tp-done': {
      // 发送端收到对端汇总 → 唤醒等待
      const r = throughputWaiters.get(obj.id)
      if (r) { throughputWaiters.delete(obj.id); r(obj) }
      break
    }
  }
}
function onBinary(buf) {
  const now = performance.now()
  const n = buf.byteLength
  recv.bytes += n
  if (!recv.firstTs) recv.firstTs = now
  recv.lastTs = now
  if (recv.prevTs && now - recv.prevTs > GAP_MS) {
    recv.gaps.push({ at: Math.round(now - recv.t0), ms: Math.round(now - recv.prevTs) })
  }
  recv.prevTs = now
  bytesSinceLog += n
  if (bytesSinceLog >= PROGRESS_LOG_BYTES) {
    bytesSinceLog = 0
    log(`…接收中 ${fmt(recv.bytes)}`)
  }
}

function attachChannel(ch) {
  dc = ch
  dc.binaryType = 'arraybuffer'
  dc.bufferedAmountLowThreshold = BACKPRESSURE_LIMIT / 2
  dc.onbufferedamountlow = () => {
    if (bufferedLowResolve) { const r = bufferedLowResolve; bufferedLowResolve = null; r() }
  }
  dc.onopen = () => {
    log(`✓ DataChannel 已打开（name=${ch.label}，本机 → 对端）`)
    setText('conn', `connected（DataChannel open，${fmt(connectMs)} ms）`)
  }
  dc.onclose = () => { log('DataChannel 关闭'); setText('conn', 'closed') }
  dc.onerror = (e) => log(`✗ DataChannel 错误：${e.message ?? e.type ?? 'unknown'}`)
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') {
      try { onControl(JSON.parse(e.data)) } catch { log('⚠ 无法解析控制帧') }
    } else {
      onBinary(e.data instanceof ArrayBuffer ? e.data : e.data.buffer)
    }
  }
}

function setConnState(state) {
  connState = state
  const label = { idle: 'idle', signaling: '信令交换中', connecting: '连接中…', connected: 'connected', disconnected: 'disconnected', failed: 'failed', closed: 'closed' }[state] ?? state
  log(`连接状态 → ${label}`)
  if (state === 'connected' && connStart) {
    connectMs = Math.round(performance.now() - connStart)
    log(`✓ 建连成功，耗时 ${connectMs} ms`)
    setText('conn', `connected（建连 ${connectMs} ms）`)
  } else {
    setText('conn', label)
  }
}

function makePc() {
  closePeer()
  pc = new RTCPeerConnection({ iceServers: [] })
  pc.onconnectionstatechange = () => setConnState(pc.connectionState)
  pc.onicecandidate = () => { /* 非 trickle：gather 完成后整包 SDP */ }
  pc.onicegatheringstatechange = () => {
    if (pc.iceGatheringState === 'complete') log('ICE gather 完成')
  }
  return pc
}

function waitGather() {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      pc.onicegatheringstatechange = null
      resolve()
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') finish()
    }
    setTimeout(() => {
      if (pc.iceGatheringState === 'complete') log('ICE gather 完成')
      finish()
    }, GATHER_TIMEOUT_MS)
  })
}

async function startOffer() {
  if (peers.size === 0) { log('✗ 没有可连接的对端（先等双方加入同一房间）'); return }
  const target = [...peers.values()][0]
  connStart = performance.now()
  log(`▶ 发起连接 → ${target.name}（bug 174500 路径：${$('grantRes').textContent.includes('✓') ? '已授权' : '未授权（冷启动）'}）`)
  try {
    const p = makePc()
    const ch = p.createDataChannel('lt', { ordered: true })
    attachChannel(ch)
    setConnState('signaling')
    const offer = await p.createOffer()
    await p.setLocalDescription(offer)
    await waitGather()
    sendSignal(target.id, { kind: 'offer', sdp: p.localDescription.sdp })
    log(`✓ offer 已发出（sdp ${p.localDescription.sdp.length} 字符）`)
  } catch (e) {
    log(`✗ 发起连接失败：${e.name ?? ''} ${e.message}`)
    setText('conn', `failed: ${e.name ?? ''} ${e.message}`)
  }
}

async function onOffer(from, payload) {
  log(`▶ 收到 ${peers.get(from)?.name ?? from.slice(0, 8)} 的 offer（bug 174500 路径：${$('grantRes').textContent.includes('✓') ? '已授权' : '未授权（冷启动）'}）`)
  connStart = performance.now()
  try {
    const p = makePc()
    p.ondatachannel = (e) => attachChannel(e.channel)
    setConnState('signaling')
    await p.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
    const ans = await p.createAnswer()
    await p.setLocalDescription(ans)
    await waitGather()
    sendSignal(from, { kind: 'answer', sdp: p.localDescription.sdp })
    log('✓ answer 已回复')
  } catch (e) {
    log(`✗ 应答失败：${e.name ?? ''} ${e.message}`)
    setText('conn', `failed: ${e.name ?? ''} ${e.message}`)
  }
}

async function onAnswer(payload) {
  try {
    await pc?.setRemoteDescription({ type: 'answer', sdp: payload.sdp })
    log('✓ 已设置对端 answer')
  } catch (e) {
    log(`✗ 处理 answer 失败：${e.name ?? ''} ${e.message}`)
  }
}

function handleSignal(from, payload) {
  if (payload.kind === 'offer') void onOffer(from, payload)
  else if (payload.kind === 'answer') void onAnswer(payload)
}

function closePeer() {
  if (dc) { try { dc.onopen = dc.onmessage = dc.onclose = dc.onerror = null; dc.close() } catch { /* noop */ } }
  if (pc) { try { pc.onconnectionstatechange = null; pc.close() } catch { /* noop */ } }
  dc = null
  pc = null
  bufferedLowResolve = null
  connState = 'idle'
  stopMemSampling()
  setText('conn', 'idle')
}

/* ---------------- 延迟（ping-pong） ---------------- */
const latencyWaiters = new Map()
async function runLatency() {
  if (!dc || dc.readyState !== 'open') { log('✗ 通道未打开'); return }
  const N = 20
  const rtts = []
  log(`▶ 往返延迟测试 ×${N}`)
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    try {
      await new Promise((resolve, reject) => {
        latencyWaiters.set(i, (t) => resolve(t - t0))
        sendControl({ t: 'ping', n: i })
        setTimeout(() => { if (latencyWaiters.delete(i)) reject(new Error('pong 超时')) }, 5000)
      })
      rtts.push(performance.now() - t0)
    } catch (e) {
      log(`✗ ping ${i} 失败：${e.message}`)
      break
    }
    await sleep(100)
  }
  if (rtts.length === 0) { log('✗ 延迟测试无结果'); return }
  rtts.sort((a, b) => a - b)
  const med = rtts[Math.floor(rtts.length / 2)]
  const avg = rtts.reduce((s, v) => s + v, 0) / rtts.length
  log(`✓ 延迟：中位 ${med.toFixed(1)} ms，平均 ${avg.toFixed(1)} ms，最差 ${rtts[rtts.length - 1].toFixed(1)} ms（n=${rtts.length}）`)
  setText('res', `延迟：中位 ${med.toFixed(1)} ms / 平均 ${avg.toFixed(1)} ms / 最差 ${rtts[rtts.length - 1].toFixed(1)} ms`)
}

/* ---------------- 吞吐（发送端） ---------------- */
const throughputWaiters = new Map()
function waitLow() {
  if (dc.bufferedAmount <= BACKPRESSURE_LIMIT) return Promise.resolve()
  return new Promise((resolve) => {
    bufferedLowResolve = resolve
    setTimeout(() => { if (bufferedLowResolve) { bufferedLowResolve = null; resolve() } }, 5_000)
  })
}

async function runThroughput(totalBytes) {
  if (!dc || dc.readyState !== 'open') { log('✗ 通道未打开（先建连）'); return }
  if (tpRunning) { log('吞吐测试进行中，请等待'); return }
  tpRunning = true
  const id = randSuffix(6)
  lastSent = 0
  log(`▶ 吞吐开始：本机 → 对端，共 ${fmt(totalBytes)}（${CHUNK / 1024} KiB/块，背压阈值 ${fmt(BACKPRESSURE_LIMIT)}）`)
  startMemSampling()
  const t0 = performance.now()
  sendControl({ t: 'tp-start', id, total: totalBytes })
  const chunk = new Uint8Array(CHUNK)
  try {
    while (lastSent < totalBytes) {
      const n = Math.min(CHUNK, totalBytes - lastSent)
      dc.send(n < CHUNK ? new Uint8Array(n) : chunk)
      lastSent += n
      if (dc.bufferedAmount > BACKPRESSURE_LIMIT) await waitLow()
    }
  } catch (e) {
    log(`✗ 发送中断：${e.name ?? ''} ${e.message}`)
    stopMemSampling()
    tpRunning = false
    return
  }
  const sendWall = performance.now() - t0
  const sendRate = lastSent / 1e6 / (sendWall / 1000)
  log(`✓ 本机发送完成：${fmt(lastSent)}，壁钟 ${(sendWall / 1000).toFixed(2)}s → ${sendRate.toFixed(1)} MB/s（发送端）`)
  log(`（内存峰值（发送端）：${memDeltaText()}）`)
  sendControl({ t: 'tp-end', id })
  // 等对端汇总
  try {
    const s = await new Promise((resolve, reject) => {
      throughputWaiters.set(id, resolve)
      setTimeout(() => { if (throughputWaiters.delete(id)) reject(new Error('对端汇总超时')) }, 30_000)
    })
    const recvWall = s.wallMs
    const recvRate = s.received / 1e6 / (recvWall / 1000)
    const match = s.received === lastSent ? '✓ 字节一致' : `✗ 字节不一致（发 ${lastSent} / 收 ${s.received}）`
    log(`✓ 对端汇总：已收 ${fmt(s.received)}，首包→末包 ${(recvWall / 1000).toFixed(2)}s → ${recvRate.toFixed(1)} MB/s（接收端）${match}`)
    if (s.gaps && s.gaps.length) {
      log(`⚠ 对端收包间隙（>${GAP_MS / 1000}s，疑似后台/锁屏挂起）：${s.gaps.map((g) => `t+${(g.at / 1000).toFixed(1)}s 间隙 ${(g.ms / 1000).toFixed(1)}s`).join('；')}`)
    } else {
      log('✓ 对端无收包间隙（传输未被后台/锁屏打断）')
    }
    if (s.memDelta != null) log(`（对端内存峰值：+${fmt(s.memDelta)}）`)
    setText('res', `吞吐 ${recvRate.toFixed(1)} MB/s（接收端 ${fmt(s.received)} / ${(recvWall / 1000).toFixed(1)}s）；${match}`)
  } catch (e) {
    log(`✗ 未收到对端汇总：${e.message}`)
  } finally {
    stopMemSampling()
    tpRunning = false
  }
}

/* ---------------- 权限探针（bug 174500） ---------------- */
async function grantPermission() {
  setText('grantRes', '请求中…')
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('本环境无 getUserMedia')
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    stream.getTracks().forEach((t) => t.stop())
    log('✓ 摄像头+麦克风权限已授予（tracks 已停，仅用于触发权限系统）')
    setText('grantRes', '✓ 已授权（摄像头+麦克风）')
  } catch (e) {
    log(`✗ getUserMedia 失败：${e.name ?? ''} ${e.message}`)
    setText('grantRes', `✗ ${e.name ?? ''} ${e.message}`)
  }
}

/* ---------------- UI 绑定 ---------------- */
$('room').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(new RegExp(`[^${PIN_ALPHABET}]`, 'g'), '').slice(0, 4)
})
$('btnRand').addEventListener('click', () => { $('room').value = randSuffix() })
$('btnJoin').addEventListener('click', () => void joinRoom())
$('btnLeave').addEventListener('click', leaveRoom)
$('btnGrant').addEventListener('click', () => void grantPermission())
$('btnOffer').addEventListener('click', () => void startOffer())
$('btnClose').addEventListener('click', () => { closePeer(); log('已主动断开（本机）') })
$('btnLat').addEventListener('click', () => void runLatency())
$('btnThrough').addEventListener('click', () => void runThroughput(Number($('size').value)))
$('btnCopy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logEl.textContent)
    log('✓ 日志已复制')
  } catch {
    log('✗ 复制失败（手动长按选择复制）')
  }
})
$('btnDl').addEventListener('click', () => {
  const blob = new Blob([logEl.textContent], { type: 'text/plain;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `dataplane-${room || 'noroom'}-${deviceName}.log`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  log('✓ 日志已导出')
})

/* ---------------- 初始化 ---------------- */
renderEnv()
$('room').value = randSuffix()
log('页面就绪。加入同一房间码后，任一端点「发起连接」。')
log(`本机：${deviceName}（kind=${kind}，isCapacitor=${isCapacitor}）`)

/* ---------------- 冒烟测试接缝（smoke.mjs 用） ---------------- */
window.__ltSpike = {
  join: () => joinRoom(),
  offer: () => startOffer(),
  runThroughput,
  runLatency,
  connected: () => connState === 'connected',
  get peerCount() { return peers.size },
  get recvBytes() { return recv.bytes },
  get sentBytes() { return lastSent },
  get localSdp() { return pc?.localDescription?.sdp ?? '' },
  get connState() { return connState },
}

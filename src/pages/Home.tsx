import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { findOrphans, formatBytes } from '../storage'
import type { OrphanReport } from '../storage'
import { createBrowserSocket, SignalingClient } from '../signaling/client'
import type { SignalingEvents } from '../signaling/client'
import { ConnectionManager } from '../webrtc/connection'
import { RtcPeer } from '../webrtc/peer'
import { buildMeta } from '../webrtc/transferMeta'
import type { FileMeta, MetaMessage } from '../protocol/transfer'
import type { DeviceKind, PeerInfo } from '../protocol/signaling'

/** 信令服务地址（.env 注入，T03 部署；形如 wss://host/ws） */
const SIGNALING_WSS = import.meta.env.VITE_SIGNALING_WSS ?? ''

function httpBaseOf(wssUrl: string): string {
  return wssUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '')
}

function detectKind(): DeviceKind {
  const ua = navigator.userAgent
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 0) return 'tablet'
  if (/iPhone|Android/.test(ua) && /Mobile/.test(ua)) return 'phone'
  if (/Android/.test(ua)) return 'tablet'
  return 'desktop'
}

export default function Home() {
  const [orphans, setOrphans] = useState<OrphanReport | null>(null)
  const [room, setRoom] = useState('')
  const [joinInput, setJoinInput] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [connState, setConnState] = useState('idle')
  const [incoming, setIncoming] = useState<FileMeta[] | null>(null)
  const [sent, setSent] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const device = useMemo(
    () => ({
      id: crypto.randomUUID(),
      name: localStorage.getItem('lt.deviceName')?.trim() || '未命名设备',
      kind: detectKind(),
    }),
    [],
  )

  const signalRef = useRef<SignalingClient | null>(null)
  const managerRef = useRef<ConnectionManager | null>(null)

  // 孤儿数据扫描（SPEC §4：启动时提示）
  useEffect(() => {
    let cancelled = false
    findOrphans()
      .then((report) => {
        if (!cancelled) setOrphans(report)
      })
      .catch(() => {
        if (!cancelled) setOrphans({ orphans: [], totalBytes: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 组件卸载时断开
  useEffect(() => {
    return () => {
      managerRef.current?.close()
      signalRef.current?.close()
    }
  }, [])

  function ensureManager(): ConnectionManager {
    if (!managerRef.current) {
      managerRef.current = new ConnectionManager(
        { signal: (to, payload) => signalRef.current?.signal(to, payload) },
        {
          onState: (s) => setConnState(s),
          onMeta: (meta: MetaMessage) => setIncoming(meta.files),
          onError: (r) => setError(r),
        },
        (events) => new RtcPeer(events),
      )
    }
    return managerRef.current
  }

  const signalEvents: SignalingEvents = {
    onRoomState: (list) => setPeers(list.filter((p) => p.id !== device.id)),
    onPeerJoined: (peer) =>
      setPeers((prev) => (prev.some((p) => p.id === peer.id) ? prev : [...prev, peer])),
    onPeerLeft: (id) => setPeers((prev) => prev.filter((p) => p.id !== id)),
    onSignal: (from, payload) => {
      if (payload.kind === 'offer') void ensureManager().handleOffer(from, payload)
      else void ensureManager().handleAnswer(payload)
    },
    onError: (r) => setError(r),
  }

  async function createRoom() {
    if (!SIGNALING_WSS) {
      setError('未配置信令服务（.env 的 VITE_SIGNALING_WSS）')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${httpBaseOf(SIGNALING_WSS)}/api/room`, { method: 'POST' })
      if (!res.ok) throw new Error(`create room → ${res.status}`)
      const { room: code } = (await res.json()) as { room: string }
      setRoom(code)
      joinRoom(code)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function joinRoom(code: string) {
    setRoom(code)
    setError('')
    const ws = createBrowserSocket(`${SIGNALING_WSS}?room=${code}`)
    const client = new SignalingClient(ws, signalEvents)
    signalRef.current = client
    ws.on('open', () => {
      client.join(code, device)
      setStatus(`已加入房间 ${code}`)
    })
    ws.on('close', () => {
      setPeers([])
      setConnState('idle')
      setStatus('信令连接已断开')
    })
  }

  async function connectTo(peerId: string) {
    setError('')
    try {
      await ensureManager().connectTo(peerId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function sendSelected() {
    const files = Array.from(fileInputRef.current?.files ?? [])
    if (files.length === 0 || connState !== 'connected') return
    const meta = buildMeta(
      crypto.randomUUID(),
      files.map((f, i) => ({ id: i, name: f.name, size: f.size })),
    )
    ensureManager().sendMeta(meta)
    setSent(files.map((f) => f.name))
    setStatus(`已发送清单：${files.length} 个文件（数据流 T05）`)
  }

  const orphanCount = orphans?.orphans.length ?? 0
  const incomingCount = incoming?.length ?? 0

  return (
    <>
      <h1>LocalTransfer</h1>
      <p>局域网 P2P 文件传输 · 零安装 · 离线可用</p>

      {orphanCount > 0 && (
        <div className="banner">
          <span>
            发现 {orphanCount} 个孤儿会话（占用 {formatBytes(orphans!.totalBytes)}，可能来自中断的传输）
          </span>
          <Link to="/settings">去设置清理 →</Link>
        </div>
      )}

      <section className="card">
        <h2>房间</h2>
        {!SIGNALING_WSS && (
          <p className="bad">未配置 VITE_SIGNALING_WSS（见 .env.example），信令不可用。</p>
        )}
        <div className="row">
          {room === '' ? (
            <>
              <button onClick={createRoom} disabled={busy}>
                创建房间
              </button>
              <input
                value={joinInput}
                onChange={(e) => setJoinInput(e.target.value.toUpperCase())}
                placeholder="输入房间码加入"
                maxLength={4}
                style={{ width: 140, textTransform: 'uppercase' }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && joinInput.length === 4) joinRoom(joinInput)
                }}
              />
              <button onClick={() => joinInput.length === 4 && joinRoom(joinInput)}>加入</button>
            </>
          ) : (
            <span className="badge">房间码：{room}</span>
          )}
          <span className={`badge ${connState === 'connected' ? 'ok' : ''}`}>
            状态：{connState}
          </span>
        </div>
        {status && <p>{status}</p>}
        {error && <p className="bad">{error}</p>}
      </section>

      <section className="card">
        <h2>设备（{peers.length} 台在线）</h2>
        {peers.length === 0 && room !== '' && (
          <p className="muted">等待其他设备输入房间码 {room} 加入…</p>
        )}
        {peers.length === 0 && room === '' && (
          <p className="muted">创建或加入房间后显示同房间设备。</p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {peers.map((peer) => (
            <li key={peer.id} className="row" style={{ justifyContent: 'space-between', margin: '8px 0' }}>
              <span>
                {peer.name} <span className="muted">({peer.kind})</span>
              </span>
              <button onClick={() => void connectTo(peer.id)} disabled={connState === 'signaling' || connState === 'connecting'}>
                {connState === 'signaling' || connState === 'connecting' ? '连接中…' : '连接'}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>传输</h2>
        {connState === 'connected' ? (
          <>
            <input ref={fileInputRef} type="file" multiple />
            <div className="row">
              <button onClick={() => void sendSelected()}>发送清单</button>
            </div>
            {incomingCount > 0 && (
              <p className="ok">
                收到清单：{incomingCount} 个文件 ——{' '}
                {incoming!.map((f) => `${f.name} (${formatBytes(f.size)})`).join('、')}
                <br />
                <span className="muted">[T05 实现接收] 确认后自动接收。</span>
              </p>
            )}
            {sent.length > 0 && (
              <p className="muted">已发送清单：{sent.join('、')}</p>
            )}
          </>
        ) : (
          <p className="muted">连接建立后可发送文件清单（meta）。</p>
        )}
      </section>
    </>
  )
}

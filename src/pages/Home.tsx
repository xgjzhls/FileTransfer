import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { findOrphans, formatBytes, getStorageAdapter } from '../storage'
import type { OrphanReport } from '../storage'
import { createBrowserSocket } from '../signaling/client'
import type { SignalingEvents } from '../signaling/client'
import { ReconnectingSignalingClient } from '../signaling/reconnect'
import type { SignalingConnState } from '../signaling/reconnect'
import { ConnectionManager } from '../webrtc/connection'
import { RtcPeer } from '../webrtc/peer'
import { TransferController } from '../transfer/controller'
import { classifyExport, guessMime } from '../transfer/export'
import { CHUNK_SIZE } from '../transfer/sender'
import { collectLocalCandidates, describeCandidateIp } from '../webrtc/diagnostics'
import type { FileMeta } from '../protocol/transfer'
import type { DeviceKind, PeerInfo } from '../protocol/signaling'

/** 信令服务地址（.env 注入，T03 部署；形如 wss://host/ws） */
const SIGNALING_WSS = import.meta.env.VITE_SIGNALING_WSS ?? ''

/** 信令连接状态展示文案（T09：重连中 / 离线可重试） */
const WS_STATE_LABEL: Record<SignalingConnState, string> = {
  idle: '未连接',
  connecting: '连接中…',
  connected: '已连接',
  reconnecting: '重连中…',
  offline: '离线（可重试）',
}

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

interface SendItem {
  id: number
  file: File
  status: 'pending' | 'transferring' | 'done'
  sentChunks: number
  totalChunks: number
}

interface RecvItem {
  id: number
  name: string
  size: number
  status: 'receiving' | 'done'
  receivedChunks: number
  totalChunks: number
}

export default function Home() {
  const [orphans, setOrphans] = useState<OrphanReport | null>(null)
  const [room, setRoom] = useState('')
  const [joinInput, setJoinInput] = useState('')
  const [peers, setPeers] = useState<PeerInfo[]>([])
  const [connState, setConnState] = useState('idle')
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [wsState, setWsState] = useState<SignalingConnState>('idle')
  const [diagIps, setDiagIps] = useState<string[]>([])
  const [diagMsg, setDiagMsg] = useState('')

  // 传输状态
  const [sendItems, setSendItems] = useState<SendItem[]>([])
  const [recvItems, setRecvItems] = useState<RecvItem[]>([])
  const [exportMsg, setExportMsg] = useState('')
  const [sessionId, setSessionId] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const recvMetaRef = useRef<FileMeta[]>([])

  const device = useMemo(
    () => ({
      id: crypto.randomUUID(),
      name: localStorage.getItem('lt.deviceName')?.trim() || '未命名设备',
      kind: detectKind(),
    }),
    [],
  )

  const reconnectRef = useRef<ReconnectingSignalingClient | null>(null)
  const roomRef = useRef('')
  const managerRef = useRef<ConnectionManager | null>(null)
  const controllerRef = useRef<TransferController | null>(null)

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

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      managerRef.current?.close()
      reconnectRef.current?.close()
    }
  }, [])

  // e2e 测试钩子（scripts/e2e.mjs 断线重连用例）：仅 dev 构建暴露，生产无
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const hook = { forceDisconnect: () => reconnectRef.current?.forceDisconnect() }
    ;(window as unknown as { __ltSignaling?: typeof hook }).__ltSignaling = hook
    return () => {
      delete (window as unknown as { __ltSignaling?: unknown }).__ltSignaling
    }
  }, [])

  function ensureController(): TransferController {
    if (!controllerRef.current) {
      controllerRef.current = new TransferController(
        getStorageAdapter(),
        {
          send: (frame) => managerRef.current?.sendData(frame),
          get bufferedAmount() {
            return managerRef.current?.bufferedAmount ?? 0
          },
          onBufferedAmountLow: (cb) => managerRef.current?.onBufferedAmountLow(cb) ?? (() => {}),
        },
        {
          onMeta: (files, sid) => {
            setSessionId(sid)
            recvMetaRef.current = files
            setRecvItems(
              files.map((f) => ({
                id: f.id,
                name: f.name,
                size: f.size,
                status: 'receiving',
                receivedChunks: 0,
                totalChunks: Math.max(1, Math.ceil(f.size / CHUNK_SIZE)),
              })),
            )
            setStatus(`收到 ${files.length} 个文件的清单，开始接收`)
          },
          onProgress: (fileId, sent, total) => {
            setSendItems((prev) =>
              prev.map((it) => (it.id === fileId ? { ...it, sentChunks: sent, totalChunks: total } : it)),
            )
          },
          onRecvProgress: (fileId, _part, received, total) => {
            setRecvItems((prev) =>
              prev.map((it) => (it.id === fileId ? { ...it, receivedChunks: received, totalChunks: total } : it)),
            )
          },
          onFileDone: (fileId) => {
            setSendItems((prev) => prev.map((it) => (it.id === fileId ? { ...it, status: 'done' } : it)))
            setRecvItems((prev) =>
              prev.map((it) => (it.id === fileId ? { ...it, status: 'done' } : it)),
            )
          },
          onError: (r) => setError(r),
        },
      )
    }
    return controllerRef.current
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

  function ensureManager(): ConnectionManager {
    if (!managerRef.current) {
      managerRef.current = new ConnectionManager(
        { signal: (to, payload) => reconnectRef.current?.signal(to, payload) },
        {
          onState: (s) => setConnState(s),
          onData: (data) => ensureController().handleData(data),
          onError: (r) => setError(r),
        },
        (events) => new RtcPeer(events),
      )
    }
    return managerRef.current
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
    roomRef.current = code
    setRoom(code)
    setError('')
    if (!reconnectRef.current) {
      reconnectRef.current = new ReconnectingSignalingClient({
        createSocket: createBrowserSocket,
        events: signalEvents,
        onState: (s) => {
          setWsState(s)
          if (s === 'connected') setStatus(`已加入房间 ${roomRef.current}（信令已连接）`)
          else if (s === 'reconnecting') setStatus('信令连接断开，自动重连中…（设备列表可能不是最新）')
          else if (s === 'offline') setStatus('信令离线：多次重连失败，请检查网络 / 信令服务后手动重试')
        },
      })
    }
    setStatus(`正在连接信令服务，加入房间 ${code}…`)
    // 断线后由客户端自动重连并重新 join 原房间（指数退避 1s→30s，最多 10 次）
    reconnectRef.current.connect(`${SIGNALING_WSS}?room=${code}`, code, device)
  }

  /** 诊断：收集本机 WebRTC 候选 IP（连接失败时定位网络问题） */
  async function runDiag() {
    setDiagMsg('收集中…')
    try {
      const ips = await collectLocalCandidates()
      setDiagIps(ips)
      setDiagMsg(ips.length > 0 ? '' : '未收集到候选（浏览器/网络异常）')
    } catch (e) {
      setDiagMsg(`收集失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 连接失败时自动收集候选（定位 fake-ip / mDNS / 路由器过滤）
  useEffect(() => {
    if (connState === 'failed' || connState === 'disconnected') {
      void runDiag()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState])

  async function connectTo(peerId: string) {
    setError('')
    try {
      await ensureManager().connectTo(peerId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function pickFiles() {
    fileInputRef.current?.click()
  }

  function onFilesSelected() {
    const files = Array.from(fileInputRef.current?.files ?? [])
    if (files.length === 0) return
    setSendItems(files.map((file, i) => ({ id: i, file, status: 'pending', sentChunks: 0, totalChunks: 0 })))
    setStatus(`已选 ${files.length} 个文件，点「开始发送」`)
  }

  async function startSend() {
    const items = sendItems.filter((it) => it.status !== 'done')
    if (items.length === 0) return
    setError('')
    setStatus('发送中…')
    abortRef.current = new AbortController()
    // 等 DataChannel open，避免首帧（meta）被丢
    try {
      await managerRef.current?.waitChannel(10_000)
    } catch {
      setStatus('数据通道未就绪，请重试')
      return
    }
    const sources = items.map((it) => ({
      id: it.id,
      name: it.file.name,
      size: it.file.size,
      source: {
        name: it.file.name,
        size: it.file.size,
        slice: async (start: number, end: number) => {
          const blob = it.file.slice(start, end)
          return new Uint8Array(await blob.arrayBuffer())
        },
      },
    }))
    try {
      await ensureController().startSend(sources, abortRef.current.signal)
      setStatus('发送完成')
    } catch (e) {
      if ((e as Error).name === 'AbortError') setStatus('已取消')
      else setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function exportFile(item: RecvItem, mode: 'share' | 'download') {
    const fileMeta = recvMetaRef.current.find((f) => f.id === item.id)
    if (!fileMeta || !sessionId) return
    setExportMsg('拼接中…')
    try {
      const adapter = getStorageAdapter()
      await adapter.merge(sessionId, item.id, item.name, fileMeta.parts.length)
      const bytes = await adapter.readMerged(sessionId, item.id, item.name)
      if (mode === 'download') {
        // 桌面：保存到文件系统（下载目录或选择位置）
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: guessMime(item.name) })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = item.name
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        setExportMsg(`已下载 ${item.name}（浏览器下载目录）`)
        return
      }
      const file = new File([bytes.buffer as ArrayBuffer], item.name, { type: guessMime(item.name) })
      const target = classifyExport(item.name, item.size)
      await navigator.share({
        files: [file],
        title: item.name,
        text: target === 'photo' ? '存储到照片' : '存储到文件',
      })
      setExportMsg(
        target === 'photo'
          ? `已导出 ${item.name}（分享面板选「存储到照片」）`
          : `已导出 ${item.name}（分享面板选「存储到文件」）`,
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  const orphanCount = orphans?.orphans.length ?? 0

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
                style={{ width: 140 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && joinInput.length === 4) joinRoom(joinInput)
                }}
              />
              <button onClick={() => joinInput.length === 4 && joinRoom(joinInput)}>加入</button>
            </>
          ) : (
            <span className="badge">房间码：{room}</span>
          )}
          <span className={`badge ${connState === 'connected' ? 'ok' : ''}`}>状态：{connState}</span>
        </div>
        {status && <p>{status}</p>}
        {error && <p className="bad">{error}</p>}
        {wsState === 'reconnecting' && (
          <p className="bad">⚠ 信令连接断开，自动重连中（指数退避 1s→30s，最多 10 次）…</p>
        )}
        {wsState === 'offline' && (
          <p className="bad">
            信令离线：自动重连已放弃。
            <button
              onClick={() => reconnectRef.current?.retry()}
              style={{ marginLeft: 8, padding: '2px 10px' }}
            >
              重新连接
            </button>
          </p>
        )}

        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer' }}>诊断（信令 / 本机候选 IP）</summary>
          <p className="mono" style={{ fontSize: 12 }}>
            信令：{WS_STATE_LABEL[wsState]} · {SIGNALING_WSS || '未配置'}
          </p>
          <div className="row">
            <button onClick={() => void runDiag()} style={{ padding: '6px 10px', fontSize: 12 }}>
              收集本机候选 IP
            </button>
          </div>
          {diagMsg && <p className="muted">{diagMsg}</p>}
          {diagIps.length > 0 && (
            <ul className="mono" style={{ fontSize: 12, margin: '6px 0', paddingLeft: 18 }}>
              {diagIps.map((ip) => (
                <li key={ip}>{describeCandidateIp(ip)}</li>
              ))}
            </ul>
          )}
          <p className="muted" style={{ fontSize: 12 }}>
            mDNS 名（xxx.local）依赖路由器组播解析；198.18.x.x 是 Clash fake-ip。
          </p>
        </details>
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
              <button
                onClick={() => void connectTo(peer.id)}
                disabled={
                  wsState !== 'connected' ||
                  connState === 'signaling' ||
                  connState === 'connecting'
                }
              >
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
            <div className="row">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={onFilesSelected}
              />
              <button onClick={pickFiles}>选择文件</button>
              {sendItems.length > 0 && (
                <button onClick={() => void startSend()} disabled={sendItems.every((it) => it.status === 'done')}>
                  开始发送
                </button>
              )}
              {sendItems.some((it) => it.status === 'transferring') && (
                <button onClick={() => abortRef.current?.abort()}>取消</button>
              )}
            </div>

            {sendItems.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
                {sendItems.map((it) => (
                  <li key={it.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span>
                      {it.file.name} <span className="muted">({formatBytes(it.file.size)})</span>
                    </span>
                    {it.status === 'done' ? (
                      <span className="ok">完成 ✓</span>
                    ) : (
                      <span className="mono">
                        {it.totalChunks > 0 ? `${it.sentChunks}/${it.totalChunks} chunk` : '排队中'}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {recvItems.length > 0 && (
              <>
                <h3 style={{ fontSize: 13, margin: '12px 0 6px', color: 'var(--muted)' }}>接收</h3>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {recvItems.map((it) => (
                    <li key={it.id} style={{ margin: '8px 0' }}>
                      <div className="row" style={{ justifyContent: 'space-between' }}>
                        <span>
                          {it.name} <span className="muted">({formatBytes(it.size)})</span>
                        </span>
                        {it.status === 'done' ? (
                          <div className="row">
                            <button onClick={() => void exportFile(it, 'share')}>导出（分享）</button>
                            <button onClick={() => void exportFile(it, 'download')}>下载到本机</button>
                          </div>
                        ) : (
                          <span className="mono">
                            {it.receivedChunks}/{it.totalChunks} chunk
                          </span>
                        )}
                      </div>
                      {it.status !== 'done' && (
                        <div className="progress">
                          <div style={{ width: `${(it.receivedChunks / it.totalChunks) * 100}%` }} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {exportMsg && <p>{exportMsg}</p>}
            <p className="muted">
              [T06 续传] 中断后可续传；[T07 离线二维码] 无网配对。
            </p>
          </>
        ) : (
          <p className="muted">连接建立后可传输文件（照片门控：{`<300MiB`} 可存照片）。</p>
        )}
      </section>
    </>
  )
}

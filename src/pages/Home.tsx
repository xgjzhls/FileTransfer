import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { findOrphans, formatBytes, getSessionStore, getStorageAdapter } from '../storage'
import type { OrphanReport } from '../storage'
import { clearSendProgress, getSendProgress, setSendProgress } from '../transfer/progressCache'
import { createBrowserSocket } from '../signaling/client'
import type { SignalingEvents } from '../signaling/client'
import { ReconnectingSignalingClient } from '../signaling/reconnect'
import type { SignalingConnState } from '../signaling/reconnect'
import { ConnectionManager } from '../webrtc/connection'
import { RtcPeer } from '../webrtc/peer'
import { TransferController } from '../transfer/controller'
import { classifyExport, guessMime } from '../transfer/export'
import { CHUNK_SIZE } from '../transfer/sender'
import { WakeLockManager } from '../wakelock/wakeLock'
import type { WakeLockState } from '../wakelock/wakeLock'
import { collectLocalCandidates, describeCandidateIp } from '../webrtc/diagnostics'
import OfflinePair from './OfflinePair'
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
  /** 已完成 part 数（本地进度缓存恢复，非权威） */
  doneParts: number
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
  const sendItemsRef = useRef<SendItem[]>([])
  useEffect(() => {
    sendItemsRef.current = sendItems
  }, [sendItems])
  const [recvItems, setRecvItems] = useState<RecvItem[]>([])
  const [exportMsg, setExportMsg] = useState('')
  const [sessionId, setSessionId] = useState('')
  // T08 Wake Lock：传输期间保持屏幕常亮（iOS 17+）；状态驱动界面提示。
  // 实例在 effect 内创建/销毁：StrictMode 双跑（同实例重放 effect）会重建 manager，
  // dispose 是永久性的，不能在渲染期懒创建后跨 effect 复用。
  const wakeRef = useRef<WakeLockManager | null>(null)
  const [wakeState, setWakeState] = useState<WakeLockState>('idle')
  useEffect(() => {
    const m = (wakeRef.current ??= new WakeLockManager())
    setWakeState(m.state) // 首帧对齐（如浏览器不支持 → unavailable）
    const unsub = m.subscribe(setWakeState)
    return () => {
      unsub()
      m.dispose()
      wakeRef.current = null
    }
  }, [])
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
  /** T06：记录当前连接的对端 + 断连中断标记（自动续传） */
  const peerIdRef = useRef<string | null>(null)
  const interruptedRef = useRef(false)
  const connStateRef = useRef(connState)
  useEffect(() => {
    connStateRef.current = connState
  }, [connState])

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
      // Wake Lock manager 由上面的 effect 管理（dispose + 置空 ref）
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

  /** T08：是否有在途传输（发送/接收任一活跃）且连接在线 —— 驱动 Wake Lock 与界面提示 */
  const transferActive = useMemo(
    () =>
      connState === 'connected' &&
      (sendItems.some((it) => it.status === 'transferring') ||
        recvItems.some((it) => it.status === 'receiving')),
    [sendItems, recvItems, connState],
  )

  // T08 Wake Lock：有在途传输 → 常亮；全部结束/取消/断连 → 释放（避免断线后一直常亮）
  useEffect(() => {
    void wakeRef.current?.setActive(transferActive)
  }, [transferActive])

  // 页面关闭/切后台时把未落盘的续传位图写掉（崩溃最多重传 64MiB + 在途）
  useEffect(() => {
    const flush = () => void controllerRef.current?.flushResume()
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
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
              prev.map((it) =>
                it.id === fileId
                  ? {
                      ...it,
                      status: it.status === 'done' ? 'done' : 'transferring',
                      sentChunks: sent,
                      totalChunks: total,
                    }
                  : it,
              ),
            )
          },
          onRecvProgress: (fileId, _part, received, total) => {
            setRecvItems((prev) =>
              prev.map((it) => (it.id === fileId ? { ...it, receivedChunks: received, totalChunks: total } : it)),
            )
          },
          onFileDone: (fileId) => {
            // 缓存写操作移出 state updater（StrictMode 双调用纯度）
            const items = sendItemsRef.current
            const it = items.find((x) => x.id === fileId)
            if (it) clearSendProgress(it.file.name, it.file.size)
            setSendItems((prev) =>
              prev.map((x): SendItem => (x.id === fileId ? { ...x, status: 'done' } : x)),
            )
            setRecvItems((prev) =>
              prev.map((it) => (it.id === fileId ? { ...it, status: 'done' } : it)),
            )
          },
          onError: (r) => setError(r),
          onPartDone: (fileId, partIndex) => {
            // 本地进度缓存（重载后恢复显示；非权威）——写操作在 updater 外
            const it = sendItemsRef.current.find((x) => x.id === fileId)
            if (it) setSendProgress(it.file.name, it.file.size, partIndex + 1)
            setSendItems((prev) =>
              prev.map((x) => (x.id === fileId ? { ...x, doneParts: partIndex + 1 } : x)),
            )
          },
          onResumeMismatch: (fileName) =>
            setStatus(`文件 ${fileName} 与已收清单不一致（可能被修改），已重新开始接收`),
        },
        getSessionStore(),
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
    onError: (r) => {
      setError(r)
      // 对端已离开（如接收端重载换新 device id）：自动重连无目标 → 复位连接态，允许重新点选
      if (r === 'peer not found') setConnState('idle')
    },
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
    // URL 带 device 身份：服务端用它做 Hibernation tag（T10 evict 唤醒后重建 presence）
    reconnectRef.current.connect(
      `${SIGNALING_WSS}?room=${code}&device=${encodeURIComponent(device.id)}`,
      code,
      device,
    )
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

  // 断连自动续传（T06 验收 4）：DataChannel 断开 → 中断发送 + 自动重建 → 恢复后 resumeSend
  useEffect(() => {
    if (connState === 'failed' || connState === 'disconnected') {
      interruptedRef.current = true
      abortRef.current?.abort() // 停掉当前发送循环（重连后 resumeSend 续传）
      void runDiag()
      // 信令在线且有对端 → 自动重建 DataChannel（重新 offer）
      if (wsState === 'connected' && peerIdRef.current) {
        if (connState === 'failed') {
          void ensureManager().reconnectTo(peerIdRef.current).catch(() => {})
        } else {
          // disconnected 可能是瞬时抖动（ICE 可自愈）：5s 后仍未 connected 再重建
          const t = setTimeout(() => {
            if (connStateRef.current !== 'connected' && peerIdRef.current) {
              void ensureManager().reconnectTo(peerIdRef.current).catch(() => {})
            }
          }, 5000)
          return () => clearTimeout(t)
        }
      }
    } else if (connState === 'connected') {
      if (interruptedRef.current) {
        interruptedRef.current = false
        void resumeAfterReconnect()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState, wsState])

  /** 重连成功后自动续传：同 sessionId 重握手，只补缺失块 */
  async function resumeAfterReconnect() {
    setStatus('连接已恢复，自动续传中…')
    const ac = new AbortController()
    abortRef.current = ac
    try {
      await managerRef.current?.waitChannel(10_000)
      await ensureController().resumeSend(ac.signal)
      if (!ac.signal.aborted) setStatus('发送完成')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  async function connectTo(peerId: string) {
    peerIdRef.current = peerId
    setError('')
    // 对端重载/断连后手动重建连接：旧连接可能仍显示 connected（ICE 失败检测有延迟），
    // 此时在途发送的 Sender 还停在旧 dc 上。标记中断 + 取消旧发送循环——新连接
    // 建立后自动走 resumeSend 续传（SPEC §3.3 disconnected → 重新 signal → 新 DC）。
    if (controllerRef.current?.hasActiveSend()) {
      interruptedRef.current = true
      abortRef.current?.abort()
    }
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
    const progress = getSendProgress()
    setSendItems(
      files.map((file, i) => ({
        id: i,
        file,
        status: 'pending',
        sentChunks: 0,
        totalChunks: 0,
        doneParts: progress[`${file.name}:${file.size}`] ?? 0,
      })),
    )
    setStatus(`已选 ${files.length} 个文件，点「开始发送」`)
  }

  async function startSend() {
    const items = sendItems.filter((it) => it.status !== 'done')
    if (items.length === 0) return
    setError('')
    setStatus('发送中…')
    abortRef.current = new AbortController()
    // 立即置 transferring：waitChannel / meta 哈希（10GB 级可达数分钟）期间
    // 也有取消按钮 + Wake Lock 常亮（T08：取消/重试体验）
    setSendItems((prev) =>
      prev.map((it) => (it.status === 'pending' ? { ...it, status: 'transferring' } : it)),
    )
    // 等 DataChannel open，避免首帧（meta）被丢
    try {
      await managerRef.current?.waitChannel(10_000)
    } catch {
      setStatus('数据通道未就绪，请重试')
      setSendItems((prev) =>
        prev.map((it) => (it.status === 'transferring' ? { ...it, status: 'pending' } : it)),
      )
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
      if ((e as Error).name === 'AbortError') {
        // 断连中断 → 自动续传流程接管；手动取消 → 重置为排队中可重试
        setStatus(interruptedRef.current ? '传输中断，等待重连自动续传…' : '已取消')
        // 重置为排队中：释放 Wake Lock、隐藏取消按钮；断连场景由 resume 重新置位
        setSendItems((prev) =>
          prev.map((it) => (it.status === 'transferring' ? { ...it, status: 'pending' } : it)),
        )
      } else setError(e instanceof Error ? e.message : String(e))
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

      {/* T07：离线二维码配对（无信令服务时；建连后完全复用在线数据面） */}
      <OfflinePair manager={() => ensureManager()} connState={connState} />

      <section className="card">
        <h2>传输</h2>
        {transferActive &&
          (wakeState === 'held' ? (
            <p className="ok" style={{ margin: '4px 0 8px' }}>✓ 屏幕常亮中（Wake Lock）</p>
          ) : wakeState === 'denied' || wakeState === 'unavailable' ? (
            <p className="bad" style={{ margin: '4px 0 8px' }}>
              ⚠ 屏幕常亮不可用（iOS 17+ Safari / 新版 Chrome 支持），传输期间屏幕可能休眠。
            </p>
          ) : null)}
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
                        {it.totalChunks > 0
                          ? `${it.sentChunks}/${it.totalChunks} chunk`
                          : it.doneParts > 0
                            ? `续传：已完成 ${it.doneParts} 个 part（重新发送时自动继续）`
                            : '排队中'}
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
              [T06 续传] 中断后可续传；[T07 离线二维码] 无网配对；[T08 常亮] 传输中保持屏幕常亮。
            </p>
            <p className="muted">
              iOS 分区隔离：接收/导出与「设置 → 清理」必须在同一浏览器/模式（独立 PWA 各占独立存储）。
            </p>
          </>
        ) : (
          <p className="muted">连接建立后可传输文件（照片门控：{`<300MiB`} 可存照片）。</p>
        )}
      </section>
    </>
  )
}

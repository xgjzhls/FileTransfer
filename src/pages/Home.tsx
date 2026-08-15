import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { findOrphans, formatBytes, getSessionStore, getStorageAdapter } from '../storage'
import type { OrphanReport } from '../storage'
import { checkIncomingCapacity } from '../storage/capacityCheck'
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
import { walkDirectory, filesFromWebkitDirectory, basename } from '../transfer/dirPicker'
import type { PickedDirFile } from '../transfer/dirPicker'
import { groupTopLevel, shareNames, uniqueZipPaths, ZIP_TOTAL_GUARD_BYTES } from '../transfer/folderExport'
import type { FolderGroup } from '../transfer/folderExport'
import { buildZip, ZIP_MIME } from '../transfer/zip'
import type { ZipEntry } from '../transfer/zip'
import { writeFileTree } from '../transfer/fsaExport'
import { WakeLockManager } from '../wakelock/wakeLock'
import type { WakeLockState } from '../wakelock/wakeLock'
import { collectLocalCandidates, describeCandidateIp } from '../webrtc/diagnostics'
import { isValidPin, PIN_LENGTH, sanitizePin } from '../rooms/roomCode'
import { clearLastRoom, getLastRoom, getOrCreateDeviceId, setLastRoom } from '../rooms/session'
import OfflinePair from './OfflinePair'
import type { FileMeta } from '../protocol/transfer'
import type { PeerInfo } from '../protocol/signaling'
import { detectKind } from '../device'

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

interface SendItem {
  id: number
  file: File
  /** 传输/存储用的名称：文件夹发送时为相对路径（photos/a.jpg），文件选择时为文件名 */
  relName: string
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

/**
 * 文件夹选择能力（SPEC §6.3）：
 * - 桌面 Chrome/Edge：File System Access（showDirectoryPicker，项目原实现）
 * - iOS Safari 18.4+ / Android Chrome / 桌面 Chrome：webkitdirectory
 *   （<input type=file webkitdirectory>，浏览器递归返回目录树 File[]）
 * 两者满足其一即显示「选择文件夹」；都不满足（如 iOS <18.4）降级多选文件。
 */
const CAN_PICK_DIR =
  typeof window !== 'undefined' &&
  ('showDirectoryPicker' in window || 'webkitdirectory' in HTMLInputElement.prototype)

/** 桌面 Chrome/Edge：File System Access 目录选择器（选源/目标）；有它=桌面端 */
const HAS_FSA_PICKER = typeof window !== 'undefined' && 'showDirectoryPicker' in window

/** 分享文件能力（navigator.share + canShare(files)）；桌面 macOS Chrome 等不支持时降级下载 */
const CAN_SHARE_FILES =
  typeof navigator !== 'undefined' &&
  typeof navigator.share === 'function' &&
  (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [new File(['x'], 'x')] }))

export default function Home() {
  const [orphans, setOrphans] = useState<OrphanReport | null>(null)
  const [room, setRoom] = useState('')
  /** T11：PIN 输入框内容（sanitize 后，仅 32 字母表字符）；输满 4 位自动加入 */
  const [pinInput, setPinInput] = useState('')
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
  // SPEC §4 容量预警：接收前异步检查（estimate 优先 / iOS 探测），不阻塞接收
  const [capacity, setCapacity] = useState<{ level: 'info' | 'warn'; message: string } | null>(null)
  /** 容量检查代际：新 meta 使旧检查结果作废（竞态守卫） */
  const capacityEpochRef = useRef(0)
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
  /** iOS Safari 18.4+ / Android Chrome：<input type=file webkitdirectory> 选文件夹 */
  const webkitDirRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const recvMetaRef = useRef<FileMeta[]>([])

  // T12：设备身份持久化（lt.deviceId）——重载后同一身份重连，旧 presence 不残留
  const device = useMemo(
    () => ({
      id: getOrCreateDeviceId(),
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

  // T12：重开应用在线时自动加入上次的房间（lt.lastRoom）——「二次使用零操作」
  useEffect(() => {
    const last = getLastRoom()
    if (!SIGNALING_WSS) return // 未配置信令：不自动回房（保留 lastRoom，配置后重开仍可用）
    if (!last) return
    if (!isValidPin(last)) {
      clearLastRoom() // 非法残留码：清除，避免下次继续尝试
      return
    }
    setStatus(`正在自动加入上次的房间 ${last}…`)
    joinRoom(last)
    // joinRoom 仅依赖 refs 与稳定 setter，首帧执行一次即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // T11：输满 4 位合法码 → 自动建房/加入（对称 PIN）；输入框仅接受 32 字母表字符
  useEffect(() => {
    if (isValidPin(pinInput) && pinInput !== roomRef.current) joinRoom(pinInput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinInput])

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
            // 容量预警（SPEC §4）：estimate 可靠时精确判定，iOS 走写探测；
            // 充足（level ok）静默，不足/无法预检时提示（接收不阻断）
            const totalBytes = files.reduce((s, f) => s + f.size, 0)
            const epoch = ++capacityEpochRef.current
            setCapacity(null)
            void checkIncomingCapacity(totalBytes).then((v) => {
              if (capacityEpochRef.current !== epoch) return // 过期结果（新 meta 已来）丢弃
              setCapacity(v.level === 'ok' ? null : { level: v.level, message: v.message })
            })
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
            if (it) clearSendProgress(it.relName, it.file.size)
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
            if (it) setSendProgress(it.relName, it.file.size, partIndex + 1)
            setSendItems((prev) =>
              prev.map((x) => (x.id === fileId ? { ...x, doneParts: partIndex + 1 } : x)),
            )
          },
          onResumeMismatch: (fileName) =>
            setStatus(`文件 ${fileName} 与已收清单不一致（可能被修改），已重新开始接收`),
          onInvalidFiles: (names) =>
            setStatus(
              `已忽略 ${names.length} 个路径非法的文件（${names.slice(0, 3).join('、')}${names.length > 3 ? '…' : ''}）`,
            ),
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

  /** T11：随机生成一个合法房间码（POST /api/room）并填入输入框 → 自动加入 */
  async function randomPin() {
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
      setPinInput(code) // 合法 4 位 → 自动 join（见 pinInput effect）
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  /** T11：输码即建房/加入（对称 PIN，服务端零改动） */
  function joinRoom(code: string) {
    // 客户端兜底：非法码直接忽略——避免触发 10 次无意义自动重连（服务端 ROOM_CODE_RE 兜底）
    if (!isValidPin(code)) return
    // T12：记住上次房间（重开应用自动回房）
    setLastRoom(code)
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
          else if (s === 'offline') setStatus('信令离线：多次重连失败，请检查网络 / 信令服务后重试')
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

  /** 选文件夹：桌面 Chrome/Edge 走 File System Access；其余（iOS 18.4+ / Android）走 webkitdirectory */
  function pickFolderAny() {
    if ('showDirectoryPicker' in window) void pickFolder()
    else webkitDirRef.current?.click()
  }

  /** 选中文件 → 发送队列（relName=相对路径；文件夹场景复用；进度按 name:size 缓存） */
  function buildSendItems(picked: PickedDirFile[]): SendItem[] {
    const progress = getSendProgress()
    return picked.map((f, i) => ({
      id: i,
      file: f.file,
      relName: f.name,
      status: 'pending' as const,
      sentChunks: 0,
      totalChunks: 0,
      doneParts: progress[`${f.name}:${f.file.size}`] ?? 0,
    }))
  }

  /** SPEC §6.3：桌面 Chrome 用 File System Access 选文件夹发送（递归含子目录） */
  async function pickFolder() {
    if (!('showDirectoryPicker' in window)) return
    setError('')
    try {
      const dirHandle = await window.showDirectoryPicker()
      setStatus('正在扫描文件夹…')
      const { files: picked, skipped } = await walkDirectory(dirHandle)
      if (picked.length === 0) {
        setStatus(skipped.length > 0 ? '所选文件夹无可发送文件（含不支持的文件名）' : '所选文件夹为空')
        return
      }
      setSendItems(buildSendItems(picked))
      setStatus(
        `已选文件夹 ${dirHandle.name}（${picked.length} 个文件）${skipped.length > 0 ? `，跳过 ${skipped.length} 个不支持的文件名` : ''}，点「开始发送」`,
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        // 用户取消选择（AbortError）静默；其余为权限/读取错误
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }

  function onFilesSelected() {
    const files = Array.from(fileInputRef.current?.files ?? [])
    if (files.length === 0) return
    const progress = getSendProgress()
    setSendItems(
      files.map((file, i) => ({
        id: i,
        file,
        relName: file.name,
        status: 'pending',
        sentChunks: 0,
        totalChunks: 0,
        doneParts: progress[`${file.name}:${file.size}`] ?? 0,
      })),
    )
    setStatus(`已选 ${files.length} 个文件，点「开始发送」`)
  }

  /**
   * SPEC §6.3：webkitdirectory 选文件夹（iOS Safari 18.4+ / Android Chrome）。
   * 浏览器递归返回整棵目录树 File[]，每个 webkitRelativePath 带子目录结构。
   */
  function onWebkitDirSelected() {
    const input = webkitDirRef.current
    const files = Array.from(input?.files ?? [])
    if (input) input.value = '' // 清空以允许重复选择同一文件夹（FileList 不可重置）
    if (files.length === 0) return
    setError('')
    setStatus('正在扫描文件夹…')
    const { files: picked, skipped } = filesFromWebkitDirectory(files)
    if (picked.length === 0) {
      setStatus(skipped.length > 0 ? '所选文件夹无可发送文件（含不支持的文件名）' : '所选文件夹为空')
      return
    }
    setSendItems(buildSendItems(picked))
    setStatus(
      `已选文件夹（${picked.length} 个文件，含子目录）${skipped.length > 0 ? `，跳过 ${skipped.length} 个不支持的文件名` : ''}，点「开始发送」`,
    )
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
      name: it.relName,
      size: it.file.size,
      source: {
        name: it.relName,
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
    if (!sessionId) return
    setExportMsg('拼接中…')
    try {
      const bytes = await readMergedOf(item)
      // 文件夹发送的文件名含相对路径（photos/a.jpg）：导出/下载必须用 basename
      // （a.download 与 share File.name 不允许路径分隔符）
      const name = basename(item.name)
      if (mode === 'download') {
        // 桌面：保存到文件系统（下载目录或选择位置）
        const blob = new Blob([bytes.buffer as ArrayBuffer], { type: guessMime(name) })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = name
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
        setExportMsg(`已下载 ${name}（浏览器下载目录）`)
        return
      }
      const file = new File([bytes.buffer as ArrayBuffer], name, { type: guessMime(name) })
      const target = classifyExport(name, item.size)
      await navigator.share({
        files: [file],
        title: name,
        text: target === 'photo' ? '存储到照片' : '存储到文件',
      })
      setExportMsg(
        target === 'photo'
          ? `已导出 ${name}（分享面板选「存储到照片」）`
          : `已导出 ${name}（分享面板选「存储到文件」）`,
      )
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 读取接收端已拼接文件（exportFile 的 merge+read 模式，供文件夹导出复用） */
  async function readMergedOf(item: RecvItem): Promise<Uint8Array<ArrayBuffer>> {
    const fileMeta = recvMetaRef.current.find((f) => f.id === item.id)
    if (!fileMeta || !sessionId) throw new Error('接收清单缺失')
    const adapter = getStorageAdapter()
    await adapter.merge(sessionId, item.id, item.name, fileMeta.parts.length)
    // rpc 反序列化恒为 ArrayBuffer 支撑（worker 结构化克隆），cast 安全
    return adapter.readMerged(sessionId, item.id, item.name) as Promise<Uint8Array<ArrayBuffer>>
  }

  /** 浏览器下载（a.download）—— 桌面端 zip / 分享失败时的落盘路径 */
  function downloadBlob(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  /**
   * 文件夹导出 zip（deflate 均衡压缩）：目录树结构 100% 保留（SPEC §4）。
   * 分享仅用于无 FSA 的设备（iOS/Android，实测可用）；桌面 Chrome/Edge（有
   * FSA）直接下载——navigator.share 在桌面端要求用户激活尚在，拼接+压缩耗时后
   * 激活已失效，会抛 NotAllowedError（权限不足）。分享抛权限类错误同样降级下载。
   */
  async function exportFolderZip(group: FolderGroup<RecvItem>) {
    if (group.totalBytes > ZIP_TOTAL_GUARD_BYTES) {
      setExportMsg(`文件夹共 ${formatBytes(group.totalBytes)}，超过 1GiB 打包上限，请分批或逐文件导出`)
      return
    }
    setExportMsg(`正在压缩 ${group.dir || '全部文件'}/ 为 zip…`)
    try {
      const paths = uniqueZipPaths(group.items)
      const entries: ZipEntry[] = []
      for (const it of group.items) {
        entries.push({ path: paths.get(it)!, data: await readMergedOf(it) })
      }
      const blob = await buildZip(entries)
      const zipName = `${group.dir || '全部文件'}.zip`
      if (CAN_SHARE_FILES && !HAS_FSA_PICKER) {
        try {
          const file = new File([blob], zipName, { type: ZIP_MIME })
          await navigator.share({ files: [file], title: zipName, text: '存储到文件后解压，即还原目录结构' })
          setExportMsg(`已分享 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
          return
        } catch (shareErr) {
          if ((shareErr as Error).name === 'AbortError') return
          if ((shareErr as Error).name === 'NotAllowedError' || (shareErr as Error).name === 'SecurityError') {
            downloadBlob(blob, zipName)
            setExportMsg(`分享不可用，已改为下载 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
            return
          }
          throw shareErr
        }
      }
      downloadBlob(blob, zipName)
      setExportMsg(`已下载 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /**
   * 文件夹导出到指定文件夹（桌面 FSA）：showDirectoryPicker 选目标 →
   * 按相对路径逐段建目录写入文件树，无需解压即还原目录结构。
   */
  async function exportFolderToDir(group: FolderGroup<RecvItem>) {
    if (typeof window.showDirectoryPicker !== 'function') {
      setExportMsg('此浏览器不支持选目标文件夹（需桌面 Chrome/Edge）；可用「导出 zip」后经「文件」App 选位置')
      return
    }
    if (group.totalBytes > ZIP_TOTAL_GUARD_BYTES) {
      setExportMsg(`文件夹共 ${formatBytes(group.totalBytes)}，超过 1GiB，请分批或逐文件导出`)
      return
    }
    setExportMsg('选择目标文件夹…')
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setExportMsg(`正在导出 ${group.items.length} 个文件到「${dirHandle.name}」…`)
      const paths = uniqueZipPaths(group.items)
      for (const it of group.items) {
        await writeFileTree(dirHandle, paths.get(it)!, await readMergedOf(it))
      }
      setExportMsg(`已导出 ${group.items.length} 个文件到「${dirHandle.name}」（目录结构保留，无需解压）`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 文件夹批量分享：全部文件一次进分享面板（iOS 收进目标文件夹，子目录拍平） */
  async function exportFolderShare(group: FolderGroup<RecvItem>) {
    if (group.totalBytes > ZIP_TOTAL_GUARD_BYTES) {
      setExportMsg(`文件夹共 ${formatBytes(group.totalBytes)}，超过 1GiB，请分批或逐文件导出`)
      return
    }
    setExportMsg('正在拼接文件…')
    try {
      const names = shareNames(group.items)
      const files: File[] = []
      for (const it of group.items) {
        const shareName = names.get(it)!
        const bytes = await readMergedOf(it)
        files.push(new File([bytes.buffer as ArrayBuffer], shareName, { type: guessMime(shareName) }))
      }
      await navigator.share({ files, title: group.dir, text: '存储到文件（多个文件收进一个文件夹，子目录拍平）' })
      setExportMsg(`已批量分享 ${group.items.length} 个文件（分享面板选「存储到文件」）`)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if ((e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError') {
        setExportMsg('分享不可用（权限受限）：桌面端请用「导出 zip」下载或「导出到文件夹…」')
        return
      }
      setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const orphanCount = orphans?.orphans.length ?? 0

  // SPEC §4：接收文件按顶层目录分组（文件夹发送 → 结构保持导出单元）
  const folderGroups = useMemo(() => groupTopLevel(recvItems), [recvItems])

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
        {/* T11：房间与设备卡片合并为「设备」视图 —— PIN 输入区 + 设备列表 + 点选连接 */}
        <h2>设备（{peers.length} 台在线）</h2>
        {!SIGNALING_WSS && (
          <p className="bad">未配置 VITE_SIGNALING_WSS（见 .env.example），信令不可用——请使用下方「离线扫码配对」。</p>
        )}
        <div className="row">
          {room === '' ? (
            <>
              <input
                value={pinInput}
                onChange={(e) => setPinInput(sanitizePin(e.target.value))}
                placeholder="输入 4 位房间码（PIN）"
                maxLength={PIN_LENGTH}
                style={{ width: 170 }}
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isValidPin(pinInput)) joinRoom(pinInput)
                }}
              />
              <button onClick={() => void randomPin()} disabled={busy}>
                随机生成
              </button>
            </>
          ) : (
            <span className="badge">房间码：{room}</span>
          )}
          <span className={`badge ${connState === 'connected' ? 'ok' : ''}`}>状态：{connState}</span>
        </div>
        {room === '' && pinInput.length > 0 && pinInput.length < PIN_LENGTH && (
          <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
            继续输入至 {PIN_LENGTH} 位自动加入（仅限 2-9 与 A-Z，已自动剔除 0/O、1/I）
          </p>
        )}
        {room !== '' && (
          <p className="muted" style={{ fontSize: 12, margin: '4px 0 0' }}>
            退出房间在「设置 → 房间」页（退出后下次打开不再自动回房）。
          </p>
        )}
        {status && <p>{status}</p>}
        {error && <p className="bad">{error}</p>}
        {wsState === 'reconnecting' && (
          <p className="bad">⚠ 信令连接断开，自动重连中（指数退避 1s→30s，最多 10 次）…</p>
        )}
        {wsState === 'offline' && (
          <p className="bad">
            信令离线：自动回房已放弃。请检查网络 / 信令服务后重试，或使用下方「离线扫码配对」。
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

        {peers.length === 0 && room !== '' && (
          <p className="muted">等待其他设备输入房间码 {room} 加入…</p>
        )}
        {peers.length === 0 && room === '' && (
          <p className="muted">
            输入房间码（PIN）或「随机生成」一个码分享给对方，同码设备会出现在这里；重开应用自动回到上次的房间。
          </p>
        )}
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {peers.map((peer) => (
            <li key={peer.id} className="row" style={{ justifyContent: 'space-between', margin: '8px 0' }}>
              <span>
                <span className="ok" style={{ marginRight: 6 }}>●</span>
                {peer.name} <span className="muted">({peer.kind} · 在线)</span>
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
      <OfflinePair manager={() => ensureManager()} connState={connState} deviceKind={device.kind} />

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
              <input
                // webkitdirectory 是 IDL 属性（非 HTML 属性）：必须在元素挂载时置位。
                // 用 ref callback 而非 useEffect——传输区是连接后才渲染的条件分支，
                // 首挂载 effect 时 input 还不存在，属性会永远落空（T18 手机端 bug）。
                ref={(el) => {
                  webkitDirRef.current = el
                  if (el) el.webkitdirectory = true
                }}
                type="file"
                multiple
                style={{ display: 'none' }}
                onChange={onWebkitDirSelected}
              />
              <button onClick={pickFiles}>选择文件</button>
              {CAN_PICK_DIR && <button onClick={pickFolderAny}>选择文件夹</button>}
              {sendItems.length > 0 && (
                <button onClick={() => void startSend()} disabled={sendItems.every((it) => it.status === 'done')}>
                  开始发送
                </button>
              )}
              {sendItems.some((it) => it.status === 'transferring') && (
                <button onClick={() => abortRef.current?.abort()}>取消</button>
              )}
            </div>
            {!CAN_PICK_DIR && (
              <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
                选文件夹需 iOS 18.4+ / 支持 webkitdirectory 的浏览器；当前设备可先多选文件发送。
              </p>
            )}

            {sendItems.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0' }}>
                {sendItems.map((it) => (
                  <li key={it.id} className="row" style={{ justifyContent: 'space-between' }}>
                    <span title={it.relName}>
                      {it.relName} <span className="muted">({formatBytes(it.file.size)})</span>
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
                {capacity && recvItems.some((it) => it.status === 'receiving') && (
                  <p
                    className={capacity.level === 'warn' ? 'bad' : 'muted'}
                    style={{ margin: '4px 0 8px' }}
                  >
                    {capacity.message}
                  </p>
                )}
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {folderGroups.map((g) => {
                    // 根目录组（散文件多选发送，name 无 /）：单独显示也可批量导出
                    const label = g.dir ? `📁 ${g.dir}/` : `📁 ${folderGroups.length === 1 ? '全部文件' : '根目录'}`
                    return (
                      <li key={g.dir || '__root__'} style={{ margin: '8px 0' }}>
                        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
                          <span>
                            {label}{' '}
                            <span className="muted">({g.items.length} 个文件 · {formatBytes(g.totalBytes)})</span>
                          </span>
                          {g.items.every((it) => it.status === 'done') ? (
                            <div className="row" style={{ flexWrap: 'wrap', rowGap: 4 }}>
                              <button onClick={() => void exportFolderZip(g)}>导出 zip</button>
                              {HAS_FSA_PICKER && (
                                <button onClick={() => void exportFolderToDir(g)}>导出到文件夹…</button>
                              )}
                              {CAN_SHARE_FILES && !HAS_FSA_PICKER && (
                                <button onClick={() => void exportFolderShare(g)}>批量分享</button>
                              )}
                            </div>
                          ) : (
                            <span className="mono">
                              {g.items.filter((it) => it.status === 'done').length}/{g.items.length} 完成
                            </span>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
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

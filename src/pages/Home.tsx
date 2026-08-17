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
import { groupTopLevel, shareNames, sumBytes, uniqueZipPaths, disambiguateRootVsDir } from '../transfer/folderExport'
import type { FolderGroup } from '../transfer/folderExport'
import { buildZipStream } from '../transfer/zip'
import type { ZipStreamEntry } from '../transfer/zip'
import { writeFileStreamTree } from '../transfer/fsaExport'
import { opfsMergedFile, withOpfsTempFile, writableChunkSink } from '../storage/opfsExport'
import { IS_NATIVE } from '../native/env'
import { createNativeExportBridge } from '../native/bridge'
import { downloadFileNative, shareFilesNative, type NativeShareFile } from '../native/share'
import { caseInsensitiveUnique, copyFilesToNative } from '../transfer/nativeExport'
import { FolderExport, PICKER_CANCELLED } from 'folder-export'
import { WakeLockManager } from '../wakelock/wakeLock'
import type { WakeLockState } from '../wakelock/wakeLock'
import { collectLocalCandidates, describeCandidateIp } from '../webrtc/diagnostics'
import { isValidPin, PIN_LENGTH, sanitizePin } from '../rooms/roomCode'
import { clearLastRoom, getLastRoom, getOrCreateDeviceId, setLastRoom } from '../rooms/session'
import OfflinePair from './OfflinePair'
import type { FileMeta } from '../protocol/transfer'
import type { PeerInfo, SignalPayload } from '../protocol/signaling'
import { detectKind } from '../device'
// T05 局域网发现（ADR-0009）：mDNS 发现 + 原生信令通道 → WebRTC 数据面（分支 A）
import { CHANNEL_ERRORS, DEFAULT_SIGNALING_PORT } from 'lan-discovery'
import { DEFAULT_LOCAL_SERVER_PORT } from 'lan-discovery'
import type { DeviceInfo as LanDeviceInfo, PeerConnectedEvent, TrackedDevice } from 'lan-discovery'
import { LanDiscoverySession, describeLanError } from '../lan/lanSession'
import { LocalServerSession } from '../lan/localServer'
import { lanDiscoveryTransport, lanLocalServerTransport } from '../lan/lanTransport'
import { getLanVisible } from '../lan/visibility'

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

/** T03：app 内「导出到文件夹…」进度状态（ADR-0008） */
interface NativeExportState {
  phase: 'idle' | 'picking' | 'copying' | 'done' | 'cancelled' | 'error'
  folderName?: string
  totalFiles: number
  doneFiles: number
  currentName?: string
  currentWritten?: number
  currentTotal?: number
  message?: string
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
  /** T20：接收文件多选勾选（仅 done 可勾，跨组批量导出）；新会话清空 */
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
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

  // ── T05 局域网发现（ADR-0009，app 壳内）：设备列表 / 状态 / 连接编排 ──
  const [lanDevices, setLanDevices] = useState<TrackedDevice[]>([])
  const [lanStatus, setLanStatus] = useState('')
  const [lanError, setLanError] = useState('')
  /** 信令服务器监听端口（null = 未监听；启动失败提示用） */
  const [lanPort, setLanPort] = useState<number | null>(null)
  // ── T07 本地 WSS 服务器（电脑腿 A）：地址/指纹/客户端连接态 ──
  const [localServer, setLocalServer] = useState<{
    running: boolean
    port: number | null
    urls: string[]
    fingerprint: string | null
    clientConnected: boolean
    error: string
  }>({ running: false, port: null, urls: [], fingerprint: null, clientConnected: false, error: '' })
  const localServerRef = useRef<LocalServerSession | null>(null)
  /** 桌面连接地址复制反馈（「已复制」气泡） */
  const [localCopied, setLocalCopied] = useState('')
  /** 正在点选连接的设备 id（按钮态） */
  const [lanConnecting, setLanConnecting] = useState<string | null>(null)
  /** 已建立原生信令通道的 peerId（UI「已连接」标记；瞬态幂等） */
  const [lanConnectedIds, setLanConnectedIds] = useState<Set<string>>(new Set())
  /** T06：局域网可见性（lt.lanVisible，默认开）——关 = 不广告不浏览（会话不启动，隐身语义）
   *  Home 只读（切换在设置页；路由切换时 Home 重挂载重新读取） */
  const [lanVisible] = useState<boolean>(() => getLanVisible())
  /** T06：本地网络权限被拒标记（专属引导区块，优先于普通错误文案渲染） */
  const [lanPermissionDenied, setLanPermissionDenied] = useState(false)
  const lanSessionRef = useRef<LanDiscoverySession | null>(null)
  /** 当前连接的信令载体：ws = 在线房间；lan = 原生信令通道（SDP 经 TCP） */
  const transportRef = useRef<'ws' | 'lan'>('ws')
  /** LAN 断线重连尝试计数（成功 connected 归零；封顶 3 次转手动） */
  const lanReconnectAttemptsRef = useRef(0)
  /** 等待重新发现的设备（peerId → 时间戳）；重新发现后自动重连 */
  const pendingReconnectRef = useRef<{ id: string; at: number } | null>(null)
  /** LAN 断线重连中（防 peerDisconnected 事件与 connState 效果双重触发） */
  const lanReconnectingRef = useRef(false)
  /** connectTo 后 peerConnected 迟迟不来的兑底（对端异常） */
  const lanConnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** 本机广告身份（TXT schema：name/id/kind/port/ver；端口在 startSignalingServer 依次尝试） */
  const lanAdvertDevice = useMemo(
    () => ({
      name: device.name,
      id: device.id,
      // detectKind 只返回 phone/tablet/desktop（src/device.ts）；cast 收敛到插件 schema
      kind: device.kind as LanDeviceInfo['kind'],
      port: DEFAULT_SIGNALING_PORT,
      ver: '1',
    }),
    [device],
  )

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
      void lanSessionRef.current?.stop()
      // Wake Lock manager 由上面的 effect 管理（dispose + 置空 ref）
    }
  }, [])

  // T05：app 壳内启动局域网发现会话（mDNS 广告+浏览 + 原生信令服务器，ADR-0009）。
  // T06：会话生命周期由可见性开关驱动——lanVisible 关 → 不启动/停止（即不广告不浏览）；
  // 切换时重建会话（stop/start 幂等），事件闭包取最新可见性。
  // 设备列表/通道事件驱动 UI 与 WebRTC 接线；handlers 只依赖 refs 与稳定 setter，首帧闭包安全。
  useEffect(() => {
    if (!IS_NATIVE) return
    const session = new LanDiscoverySession({
      transport: lanDiscoveryTransport,
      device: lanAdvertDevice,
      events: {
        // 代际守卫：StrictMode 双跑时旧会话的迟到事件（stop 清空列表）不覆盖新会话状态
        onDevicesChanged: (devices) => {
          if (lanSessionRef.current !== session) return
          setLanDevices(devices)
          // 断线后设备从列表消失 → 重新发现时自动重连（验收 3：重新发现 → 原生重连）
          const pending = pendingReconnectRef.current
          if (pending) {
            if (Date.now() - pending.at > 60_000) {
              pendingReconnectRef.current = null
              setLanStatus('未重新发现设备，请手动点选连接')
            } else if (devices.some((d) => d.id === pending.id)) {
              const dev = devices.find((d) => d.id === pending.id)!
              pendingReconnectRef.current = null
              setLanStatus(`已重新发现 ${dev.name}，自动重连…`)
              void reconnectLan(dev.id)
            }
          }
        },
        // 代际守卫：StrictMode 双跑时旧会话的迟到事件（stop 清理）不驱动 UI/WebRTC 握手
        onPeerConnected: (e) => {
          if (lanSessionRef.current === session) handleLanPeerConnected(e)
        },
        onPeerDisconnected: (id) => {
          if (lanSessionRef.current === session) handleLanPeerDisconnected(id)
        },
        onSignal: (from, payload) => {
          if (lanSessionRef.current === session) handleLanSignal(from, payload)
        },
        onServerChange: (port) => {
          if (lanSessionRef.current !== session) return
          setLanPort(port)
          if (port !== null) setLanStatus(`局域网发现已就绪（信令服务器 :${port}）`)
        },
        onPermissionDenied: () => {
          if (lanSessionRef.current !== session) return
          setLanPermissionDenied(true)
          setLanError('') // 权限引导由专属区块承担（lanPermissionDenied 优先渲染）
        },
        onError: (code, message) => {
          if (lanSessionRef.current !== session) return
          setLanError(describeLanError(code, message))
        },
      },
    })
    lanSessionRef.current = session
    // T06 可见性门控：关 = 不广告不浏览（会话不启动）；开 = 全量启动（广告 + 浏览 + 信令服务器）
    if (lanVisible) {
      void session.start().then((r) => {
        if (!r.ok) setLanStatus('局域网发现未启动（见下方错误提示）')
      })
    }
    return () => {
      if (lanConnectTimeoutRef.current) clearTimeout(lanConnectTimeoutRef.current)
      void session.stop()
      lanSessionRef.current = null
    }
    // 可见性切换 → 重建会话；依赖 lanVisible（事件闭包需取最新可见性）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanVisible])

  // T07：app 本地 WSS 信令服务器（电脑腿 A）——与发现会话同生命周期（lanVisible 门控）。
  // 桌面 Chrome 连入此服务器（地址/CA 指纹见下方 UI）；信令中继给调用方（T08 接 WebRTC）。
  useEffect(() => {
    if (!IS_NATIVE) return
    const session = new LocalServerSession({
      transport: lanLocalServerTransport,
      device: { ...device, kind: device.kind as LanDeviceInfo['kind'], port: DEFAULT_LOCAL_SERVER_PORT, ver: '1' },
      events: {
        onClientChange: (connected) => {
          if (localServerRef.current !== session) return
          setLocalServer((s) => ({ ...s, clientConnected: connected }))
        },
        onSignal: (_payload) => {
          // T08：桌面 offer/answer 在此交给 ConnectionManager（与原生信令通道同构接线）
        },
        onError: (code, message) => {
          if (localServerRef.current !== session) return
          setLocalServer((s) => ({ ...s, running: false, error: message || code }))
        },
      },
    })
    localServerRef.current = session
    if (lanVisible) {
      void session.start().then((r) => {
        if (localServerRef.current !== session) return
        setLocalServer({
          running: r.ok,
          port: r.ok ? session.port : null,
          urls: r.ok ? session.urls() : [],
          fingerprint: r.ok ? session.caFingerprint : null,
          clientConnected: false,
          error: r.ok ? '' : (r.error ?? '启动失败'),
        })
      })
    }
    return () => {
      void session.stop()
      localServerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lanVisible])

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
            setSelectedIds(new Set()) // T20：新会话清空勾选
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
      transportRef.current = 'ws' // WS 房间来的 offer/answer → 回复走 WS 通道
      routeSignal(from, payload, setError)
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
        {
          signal: (to, payload) => {
            if (transportRef.current === 'lan') {
              // T05：原生信令通道——SDP 经活跃通道发出（SPEC §5.5）。NOT_CONNECTED /
              // ALREADY_CONNECTING 是竞态/重连瞬态（通道已被替换或正在建立），静默忽略——
              // 最终通道由 peerConnected 角色与收到的 offer 驱动收敛（T04 设计定稿）。
              const session = lanSessionRef.current
              if (!session) return
              void session
                .sendSignal(to, payload)
                .then((r) => {
                  if (!r.ok && r.error !== CHANNEL_ERRORS.NOT_CONNECTED && r.error !== CHANNEL_ERRORS.ALREADY_CONNECTING) {
                    setLanError(r.error ? describeLanError(r.error) : '发送信令失败')
                  }
                })
                .catch((err) => setLanError(err instanceof Error ? err.message : String(err)))
            } else {
              reconnectRef.current?.signal(to, payload)
            }
          },
        },
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
      if (transportRef.current === 'lan' && peerIdRef.current) {
        const peerId = peerIdRef.current
        if (lanSessionRef.current?.isConnected(peerId)) {
          // T05：原生信令通道仍存活（WebRTC 数据面单独失败）→ 直接重建 DataChannel：
          // 重新 offer 经现有通道发出，同 WS 语义（SPEC §3.3 disconnected → 重新 signal）
          void ensureManager().reconnectTo(peerId).catch(() => {})
        } else {
          // 原生通道也断了 → 重新发现/原生重连 → peerConnected 驱动新 offer → 续传
          void reconnectLan(peerId)
        }
      } else if (wsState === 'connected' && peerIdRef.current) {
        // 信令在线且有对端 → 自动重建 DataChannel（重新 offer）
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
        lanReconnectAttemptsRef.current = 0
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
    transportRef.current = 'ws'
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

  // ── T05 局域网发现接线（ADR-0009，分支 A）：原生信令通道 ↔ ConnectionManager ──

  /** 点选局域网设备：native connect → peerConnected 驱动 offer（本端为 initiator） */
  async function connectToLanDevice(device: TrackedDevice) {
    const session = lanSessionRef.current
    if (!session) return
    if (session.isConnected(device.id)) {
      // 通道已连但 WebRTC 数据面未建（断线恢复中）：手动重触发 = 重新 offer（同 WS 语义）
      if (connStateRef.current !== 'connected') {
        void ensureManager()
          .reconnectTo(device.id)
          .catch((err) => setLanError(err instanceof Error ? err.message : String(err)))
      }
      return
    }
    transportRef.current = 'lan'
    peerIdRef.current = device.id
    setLanError('')
    setLanConnecting(device.id)
    // 已有在途发送 → 标记中断 + 取消旧发送循环（新连接建立后自动走 resumeSend 续传，同 WS 语义）
    if (controllerRef.current?.hasActiveSend()) {
      interruptedRef.current = true
      abortRef.current?.abort()
    }
    const r = await session.connectTo(device)
    if (!r.ok) {
      setLanConnecting((cur) => (cur === device.id ? null : cur))
      setLanError(r.error ? describeLanError(r.error) : '连接失败')
      setLanStatus('连接失败，请确认对方在首页后重试')
      return
    }
    // 兑底：native connect 成功但 peerConnected 迟迟不来（对端异常/已离开）→ 提示可重试
    if (lanConnectTimeoutRef.current) clearTimeout(lanConnectTimeoutRef.current)
    lanConnectTimeoutRef.current = setTimeout(() => {
      if (!lanSessionRef.current?.isConnected(device.id)) {
        setLanConnecting((cur) => (cur === device.id ? null : cur))
        setLanStatus(`与 ${device.name} 的信令通道未建立（对端可能已离开），可重新点选连接`)
      }
    }, 10_000)
  }

  /**
   * T05：原生信令通道建立 → 按角色走 WebRTC 握手。
   * initiator = 幸存连接的发起方（即 offer 方）：创建 offer 经原生通道发出；
   * receiver = 等对方 offer → handleOffer 回 answer。双发起竞态由原生消解（低 deviceId 胜），
   * 可能看到 initiator→disconnected→receiver 瞬态——以最终 session 幂等处理（T04 设计定稿）。
   */
  function handleLanPeerConnected(e: PeerConnectedEvent) {
    transportRef.current = 'lan'
    peerIdRef.current = e.id
    setLanConnecting((cur) => (cur === e.id ? null : cur))
    setLanConnectedIds((prev) => new Set(prev).add(e.id))
    setLanError('')
    pendingReconnectRef.current = null
    lanReconnectAttemptsRef.current = 0
    setLanStatus(
      `已连接 ${e.id}（${e.role === 'initiator' ? '发起方，正在交换 SDP…' : '接收方，等待对方 offer…'}）`,
    )
    if (e.role === 'initiator') {
      // 我是 offer 方：ConnectionManager 建 offer，signal 路由到原生 sendMessage
      void ensureManager()
        .connectTo(e.id)
        .catch((err) => setLanError(err instanceof Error ? err.message : String(err)))
    }
    // receiver：等 messageReceived(offer) → handleLanSignal 回 answer
  }

  /**
   * offer/answer 分发（WS 与原生通道共用同一 ConnectionManager 语义，SPEC §3.3）：
   * offer → 本端为 answer 方自动回 answer；answer → 应用到本端既有 offerer peer。
   */
  function routeSignal(from: string, payload: SignalPayload, onError: (m: string) => void): void {
    if (payload.kind === 'offer') {
      void ensureManager()
        .handleOffer(from, payload)
        .catch((err) => onError(err instanceof Error ? err.message : String(err)))
    } else {
      void ensureManager()
        .handleAnswer(payload)
        .catch((err) => onError(err instanceof Error ? err.message : String(err)))
    }
  }

  /** 原生通道收到 offer/answer → WebRTC 握手（与 WS 路径同一 ConnectionManager / RtcPeer） */
  function handleLanSignal(from: string, payload: SignalPayload) {
    transportRef.current = 'lan'
    peerIdRef.current = from
    setLanConnecting((cur) => (cur === from ? null : cur))
    setLanConnectedIds((prev) => new Set(prev).add(from))
    routeSignal(from, payload, setLanError)
  }

  /**
   * T05：原生信令通道断开 → 标记中断 + 走「重新发现 → 原生重连 → 从 bitfield 续传」
   * （验收 3，§3.4 不变）。TCP 断开是强信号（对端关闭/网络中断）；即使 WebRTC 数据面
   * 仍短暂存活，重握手 + resumeSend 也只是几秒的代价且零数据损失——不等 ICE 超时（可能
   * 很久甚至不触发，无 STUN 时 consent 检测不可靠）。
   */
  function handleLanPeerDisconnected(id: string) {
    if (peerIdRef.current !== id) return
    setLanConnectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    interruptedRef.current = true
    abortRef.current?.abort() // 停当前发送循环（重连后 resumeSend 续传）
    setLanStatus(`与 ${id} 的信令通道断开，尝试重新发现并重连…`)
    void reconnectLan(id)
  }

  /**
   * LAN 重连：注册表找设备（重新发现）→ 原生 connect → peerConnected 驱动新 offer →
   * connState 回到 connected 后 resumeAfterReconnect 自动续传。封顶 3 次转手动。
   * lanReconnectingRef 防双重触发（peerDisconnected 事件 + connState 效果）。
   */
  async function reconnectLan(id: string) {
    const session = lanSessionRef.current
    if (!session) return
    if (!lanVisible) {
      // T06：可见性关闭 = 隐身语义——不主动重连（设备列表也不显示，重新开启后重新发现）
      setLanStatus('局域网可见性已关闭，未自动重连（可在「设置 → 局域网」重新开启）')
      pendingReconnectRef.current = null
      return
    }
    if (lanReconnectingRef.current) return
    lanReconnectingRef.current = true
    try {
      if (lanReconnectAttemptsRef.current >= 3) {
        setLanStatus('自动重连多次失败，请重新点选设备连接')
        pendingReconnectRef.current = null
        return
      }
      lanReconnectAttemptsRef.current++
      const device = session.devices().find((d) => d.id === id)
      if (!device) {
        // 设备已从列表消失：等重新发现（onDevicesChanged 里自动重连）
        pendingReconnectRef.current = { id, at: Date.now() }
        setLanStatus('设备已消失，等待重新发现后自动重连…')
        return
      }
      const r = await session.connectTo(device)
      if (!r.ok) {
        setLanError(r.error ? describeLanError(r.error) : '原生重连失败')
        pendingReconnectRef.current = { id, at: Date.now() }
        setLanStatus('原生重连失败，等待重新发现…')
      }
      // ok → peerConnected(initiator) 触发新 offer；connected 后由 connState 流程续传
    } finally {
      lanReconnectingRef.current = false
    }
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
      const file = await mergedFileOf(item)
      // 文件夹发送的文件名含相对路径（photos/a.jpg）：导出/下载必须用 basename
      // （a.download 与 share File.name 不允许路径分隔符）
      const name = basename(item.name)
      if (IS_NATIVE) {
        // 壳内（ADR-0008 #3/#4）：分享/下载都经 @capacitor/share（WKWebView 无可靠
        // navigator.share / a.download）；下载 = 分享面板选「存储到文件」
        const target = classifyExport(name, item.size)
        if (mode === 'download') {
          await downloadFileNative(file, name)
        } else {
          await shareFilesNative([{ file, name }], name, target === 'photo' ? '存储到照片' : '存储到文件')
        }
        setExportMsg(
          mode === 'download'
            ? `已分享 ${name}（面板选「存储到文件」）`
            : `已分享 ${name}（面板选「存储到照片 / 存储到文件」）`,
        )
        return
      }
      if (mode === 'download') {
        // 零拷贝：objectURL 由浏览器从磁盘流式读（不再整载内存，T23）
        downloadBlob(file, name)
        setExportMsg(`已下载 ${name}（浏览器下载目录）`)
        return
      }
      const target = classifyExport(name, item.size)
      const shareFile = shareableFile(file, name)
      await navigator.share({
        files: [shareFile],
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

  /** 读取接收端已拼接文件 → OPFS 磁盘背书 File（merge 在 worker 流式；getFile 零拷贝，T23） */
  async function mergedFileOf(item: RecvItem): Promise<File> {
    const fileMeta = recvMetaRef.current.find((f) => f.id === item.id)
    if (!fileMeta || !sessionId) throw new Error('接收清单缺失')
    const adapter = getStorageAdapter()
    await adapter.merge(sessionId, item.id, item.name, fileMeta.parts.length)
    return opfsMergedFile(sessionId, item.id, item.name)
  }

  /** 分享/下载用 File：磁盘背书 + 正确 MIME（OPFS getFile 的 type 为空；包装是惰性引用，不拷贝） */
  function shareableFile(file: File, name: string): File {
    return new File([file], name, { type: guessMime(name) })
  }

  /** 流式 zip：合并全部 → fflate 流式压缩 → OPFS exports/ 临时文件 → 磁盘背书 File（零驻留，T23） */
  async function streamZipToFile(
    zipName: string,
    items: RecvItem[],
    paths: Map<RecvItem, string>,
  ): Promise<File> {
    const entries: ZipStreamEntry[] = []
    for (const it of items) {
      entries.push({
        path: paths.get(it)!,
        byteLength: it.size,
        stream: (await mergedFileOf(it)).stream(),
      })
    }
    const { file } = await withOpfsTempFile(zipName, (writable) =>
      buildZipStream(entries, writableChunkSink(writable)),
    )
    return file
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
    setExportMsg(`正在压缩 ${group.dir || '全部文件'}/ 为 zip…`)
    try {
      const zipName = `${group.dir || '全部文件'}.zip`
      const file = await streamZipToFile(zipName, group.items, uniqueZipPaths(group.items))
      if (IS_NATIVE) {
        // 壳内：@capacitor/share（zip 在 OPFS exports/，先落临时文件）
        try {
          await shareFilesNative([{ file, name: zipName }], zipName, '存储到文件后解压，即还原目录结构')
          setExportMsg(`已分享 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
        } catch (shareErr) {
          if ((shareErr as Error).name !== 'AbortError') {
            setExportMsg(`分享失败：${shareErr instanceof Error ? shareErr.message : String(shareErr)}`)
          }
        }
        return
      }
      if (CAN_SHARE_FILES && !HAS_FSA_PICKER) {
        try {
          await navigator.share({ files: [shareableFile(file, zipName)], title: zipName, text: '存储到文件后解压，即还原目录结构' })
          setExportMsg(`已分享 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
          return
        } catch (shareErr) {
          if ((shareErr as Error).name === 'AbortError') return
          if ((shareErr as Error).name === 'NotAllowedError' || (shareErr as Error).name === 'SecurityError') {
            downloadBlob(file, zipName)
            setExportMsg(`分享不可用，已改为下载 ${zipName}（${group.items.length} 个文件，目录结构保留）`)
            return
          }
          throw shareErr
        }
      }
      downloadBlob(file, zipName)
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
    setExportMsg('选择目标文件夹…')
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setExportMsg(`正在导出 ${group.items.length} 个文件到「${dirHandle.name}」…`)
      const paths = uniqueZipPaths(group.items)
      for (const it of group.items) {
        await writeFileStreamTree(dirHandle, paths.get(it)!, await mergedFileOf(it))
      }
      setExportMsg(`已导出 ${group.items.length} 个文件到「${dirHandle.name}」（目录结构保留，无需解压）`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** 文件夹批量分享：全部文件一次进分享面板（iOS 收进目标文件夹，子目录拍平；磁盘背书零拷贝，T23） */
  async function exportFolderShare(group: FolderGroup<RecvItem>) {
    setExportMsg('正在准备分享…')
    try {
      const names = shareNames(group.items)
      if (IS_NATIVE) {
        const files: NativeShareFile[] = []
        for (const it of group.items) {
          files.push({ file: await mergedFileOf(it), name: names.get(it)! })
        }
        await shareFilesNative(files, group.dir, '存储到文件（多个文件收进一个文件夹，子目录拍平）')
        setExportMsg(`已批量分享 ${group.items.length} 个文件（分享面板选「存储到文件」）`)
        return
      }
      const files: File[] = []
      for (const it of group.items) {
        const shareName = names.get(it)!
        files.push(shareableFile(await mergedFileOf(it), shareName))
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

  // ── T03：app 内「导出到文件夹…」（ADR-0008 主路径；桌面 FSA 路径不动）──
  const [nativeExport, setNativeExport] = useState<NativeExportState>({
    phase: 'idle',
    totalFiles: 0,
    doneFiles: 0,
  })
  const nativeAbortRef = useRef<AbortController | null>(null)
  const nativeBridgeRef = useRef(createNativeExportBridge())

  /**
   * T03 主路径：选文件夹 → 保持相对路径逐段建目录 → 4MiB 分块流式拷贝
   * （目录树原生还原，无需 zip；取消 = 停当前文件、已写保留）。
   * paths：重名/根散文件冲突消歧复用 FSA 同款逻辑（uniqueZipPaths / disambiguateRootVsDir），
   * 壳内再补一轮 APFS 大小写不敏感消歧（caseInsensitiveUnique，追加序号不覆盖）。
   */
  async function exportToNativeFolder(items: RecvItem[], paths: Map<RecvItem, string>) {
    if (!sessionId || items.length === 0) return
    setNativeExport({ phase: 'picking', totalFiles: items.length, doneFiles: 0 })
    try {
      const picked = await FolderExport.pickFolder()
      const ctrl = new AbortController()
      nativeAbortRef.current = ctrl
      setNativeExport({
        phase: 'copying',
        folderName: picked.folderName,
        totalFiles: items.length,
        doneFiles: 0,
      })
      try {
        const safePaths = caseInsensitiveUnique(paths)
        const entries: { file: File; relPath: string }[] = []
        for (const it of items) {
          entries.push({ file: await mergedFileOf(it), relPath: safePaths.get(it)! })
        }
        const res = await copyFilesToNative({
          bridge: nativeBridgeRef.current,
          entries,
          signal: ctrl.signal,
          onFileStart: (_i, name, totalBytes) =>
            setNativeExport((s) => ({ ...s, currentName: name, currentWritten: 0, currentTotal: totalBytes })),
          onFileProgress: (_i, written, total) =>
            setNativeExport((s) => ({ ...s, currentWritten: written, currentTotal: total })),
          onFileDone: () => setNativeExport((s) => ({ ...s, doneFiles: s.doneFiles + 1 })),
        })
        setNativeExport(
          res.cancelled
            ? { phase: 'cancelled', folderName: picked.folderName, totalFiles: items.length, doneFiles: res.copied }
            : { phase: 'done', folderName: picked.folderName, totalFiles: items.length, doneFiles: res.copied },
        )
      } finally {
        nativeAbortRef.current = null
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg === PICKER_CANCELLED || (e as Error).name === 'NativeExportAbortedError') {
        setNativeExport({ phase: 'cancelled', totalFiles: items.length, doneFiles: 0 })
        return
      }
      setNativeExport({
        phase: 'error',
        totalFiles: items.length,
        doneFiles: 0,
        message: `导出失败：${msg}`,
      })
    }
  }

  function cancelNativeExport(): void {
    nativeAbortRef.current?.abort()
  }

  /** T20：导出选中 zip（跨组打包，deflate level 6；分享/下载路由同分组 zip；流式零驻留，T23） */
  async function exportSelectedZip() {
    if (selectedItems.length === 0) return
    setExportMsg(`正在压缩选中文件为 zip…`)
    try {
      const zipName = '选中文件.zip'
      const file = await streamZipToFile(zipName, selectedItems, disambiguateRootVsDir(selectedItems))
      if (IS_NATIVE) {
        try {
          await shareFilesNative([{ file, name: zipName }], zipName, '存储到文件后解压，即还原目录结构')
          setExportMsg(`已分享 ${zipName}（${selectedItems.length} 个文件，目录结构保留）`)
        } catch (shareErr) {
          if ((shareErr as Error).name !== 'AbortError') {
            setExportMsg(`分享失败：${shareErr instanceof Error ? shareErr.message : String(shareErr)}`)
          }
        }
        return
      }
      if (CAN_SHARE_FILES && !HAS_FSA_PICKER) {
        try {
          await navigator.share({ files: [shareableFile(file, zipName)], title: zipName, text: '存储到文件后解压，即还原目录结构' })
          setExportMsg(`已分享 ${zipName}（${selectedItems.length} 个文件，目录结构保留）`)
          return
        } catch (shareErr) {
          if ((shareErr as Error).name === 'AbortError') return
          if ((shareErr as Error).name === 'NotAllowedError' || (shareErr as Error).name === 'SecurityError') {
            downloadBlob(file, zipName)
            setExportMsg(`分享不可用，已改为下载 ${zipName}（${selectedItems.length} 个文件，目录结构保留）`)
            return
          }
          throw shareErr
        }
      }
      downloadBlob(file, zipName)
      setExportMsg(`已下载 ${zipName}（${selectedItems.length} 个文件，目录结构保留）`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** T20：导出选中到指定文件夹（桌面 FSA，保持相对路径，无需解压） */
  async function exportSelectedToDir() {
    if (selectedItems.length === 0) return
    if (typeof window.showDirectoryPicker !== 'function') {
      setExportMsg('此浏览器不支持选目标文件夹（需桌面 Chrome/Edge）；可用「导出选中 zip」后经「文件」App 选位置')
      return
    }
    setExportMsg('选择目标文件夹…')
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' })
      setExportMsg(`正在导出 ${selectedItems.length} 个文件到「${dirHandle.name}」…`)
      // 目录优先消歧：根散文件与目录首段同名时 FSA 建文件/建目录冲突会抛错（T20 评审修正）
      const paths = disambiguateRootVsDir(selectedItems)
      for (const it of selectedItems) {
        await writeFileStreamTree(dirHandle, paths.get(it)!, await mergedFileOf(it))
      }
      setExportMsg(`已导出 ${selectedItems.length} 个文件到「${dirHandle.name}」（目录结构保留，无需解压）`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /** T20：批量分享选中（手机；子目录拍平，shareNames 消歧；磁盘背书零拷贝，T23） */
  async function exportSelectedShare() {
    if (selectedItems.length === 0) return
    setExportMsg('正在准备分享…')
    try {
      const names = shareNames(selectedItems)
      if (IS_NATIVE) {
        const files: NativeShareFile[] = []
        for (const it of selectedItems) {
          files.push({ file: await mergedFileOf(it), name: names.get(it)! })
        }
        await shareFilesNative(files, '选中文件', '存储到文件（多个文件收进一个文件夹，子目录拍平）')
        setExportMsg(`已批量分享 ${selectedItems.length} 个文件（分享面板选「存储到文件」）`)
        return
      }
      const files: File[] = []
      for (const it of selectedItems) {
        const shareName = names.get(it)!
        files.push(shareableFile(await mergedFileOf(it), shareName))
      }
      await navigator.share({ files, title: '选中文件', text: '存储到文件（多个文件收进一个文件夹，子目录拍平）' })
      setExportMsg(`已批量分享 ${selectedItems.length} 个文件（分享面板选「存储到文件」）`)
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
      if ((e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError') {
        setExportMsg('分享不可用（权限受限）：桌面端请用「导出 zip」下载或「导出到文件夹…」')
        return
      }
      setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // SPEC §4：接收文件按顶层目录分组（文件夹发送 → 结构保持导出单元）
  const folderGroups = useMemo(() => groupTopLevel(recvItems), [recvItems])

  // T20：勾选派生 —— 仅 done 文件可勾可导出；receiving → done 后自动可勾
  const selectedItems = useMemo(
    () => recvItems.filter((it) => it.status === 'done' && selectedIds.has(it.id)),
    [recvItems, selectedIds],
  )
  const allDoneSelected = useMemo(() => {
    const doneIds = recvItems.filter((it) => it.status === 'done').map((it) => it.id)
    return doneIds.length > 0 && doneIds.every((id) => selectedIds.has(id))
  }, [recvItems, selectedIds])

  function toggleSelected(id: number): void {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function toggleSelectAll(): void {
    setSelectedIds(
      allDoneSelected
        ? new Set()
        : new Set(recvItems.filter((it) => it.status === 'done').map((it) => it.id)),
    )
  }

  // ── T06：设备双区块（ADR-0009 决策 6 / SPEC §6.1）─────────────────────────────
  // 「在线房间」（PIN 门控，ADR-0006 语义不变）+「局域网发现」（app 端 mDNS，来源标注）；
  // 信令不可达（未配置 / 重试耗尽离线 / 尚未建立任何信令会话）→ 离线主场景：局域网区块为主（自动聚焦，区块置前 + 强调）。
  // 注：无 lastRoom 的完全离线首开（ADR-0007 主场景）从不触发 joinRoom，wsState 停在 idle——
  // 此时同样判为不可达，否则局域网区块永不聚焦（评审修正）。
  const signalingDown =
    !SIGNALING_WSS || wsState === 'offline' || (wsState === 'idle' && room === '')

  /** 「在线房间」区块：PIN 输入 / 状态 / 诊断 / 房间设备列表（ADR-0006 门控不变） */
  const roomBlock = (
    <div className="device-block">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="block-title">
          在线房间 <span className="badge">{peers.length} 台</span>
        </span>
        {signalingDown && (
          <span className="badge bad">
            {!SIGNALING_WSS || wsState === 'offline' ? '信令不可达' : '未加入房间'}
          </span>
        )}
      </div>
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
    </div>
  )

  /** 「局域网发现」区块（app 壳内 mDNS；来源标注「局域网」；离线时置前 + 强调） */
  const lanBlock = IS_NATIVE ? (
    <div className={`device-block${signalingDown ? ' lan-primary' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="block-title">
          局域网发现 <span className="badge">{lanDevices.length} 台</span>
          <span className="badge ok">局域网</span>
          {signalingDown && <span className="badge ok">离线主通道</span>}
        </span>
      </div>
      {lanVisible ? (
        <>
          {lanPermissionDenied ? (
            <p className="bad">
              本地网络权限被拒：请到 系统设置 → 隐私与安全性 → 本地网络 开启 LocalTransfer 后重启 App。
            </p>
          ) : (
            <>
              {lanError && <p className="bad">{lanError}</p>}
              {lanStatus && <p>{lanStatus}</p>}
              {lanPort !== null && (
                <p className="muted" style={{ fontSize: 12, margin: '2px 0 6px' }}>
                  信令服务器：:{lanPort}（SRV = TXT 端口）
                </p>
              )}
              {/* T07 电脑腿 A：本地 WSS 信令服务器（桌面 Chrome 连入；地址 + CA 指纹 + 客户端态） */}
              {IS_NATIVE && (
                <div style={{ margin: '8px 0', padding: 8, border: '1px dashed #8884', borderRadius: 8 }}>
                  <div className="row" style={{ justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      电脑腿连接{' '}
                      <span className="badge ok">本地服务器</span>
                    </span>
                    {localServer.clientConnected && <span className="badge ok">● 电脑已连接</span>}
                  </div>
                  {localServer.running && localServer.port !== null ? (
                    <>
                      <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>
                        桌面 Chrome 打开下方任一地址（手机与电脑需同一 Wi-Fi）：
                      </p>
                      {localServer.urls.map((url) => (
                        <div key={url} className="row" style={{ gap: 6, margin: '4px 0' }}>
                          <code style={{ fontSize: 11, wordBreak: 'break-all', flex: 1 }}>{url}</code>
                          <button
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            onClick={() => {
                              void navigator.clipboard?.writeText(url)
                              setLocalCopied(url)
                              setTimeout(() => setLocalCopied(''), 1500)
                            }}
                          >
                            {localCopied === url ? '已复制' : '复制'}
                          </button>
                        </div>
                      ))}
                      <p className="muted" style={{ fontSize: 11, margin: '6px 0 0' }}>
                        首次需一次性信任证书：桌面运行{' '}
                        <code style={{ fontSize: 10 }}>bash scripts/trust-local-ca.sh 到 ca.crt</code>
                        （或把下方指纹与下载的 CA 比对）。本机 CA 指纹：
                      </p>
                      {localServer.fingerprint && (
                        <code style={{ fontSize: 10, display: 'block', wordBreak: 'break-all', marginTop: 2 }}>
                          {localServer.fingerprint}
                        </code>
                      )}
                    </>
                  ) : localServer.error ? (
                    <p className="bad" style={{ fontSize: 12, margin: '4px 0' }}>{localServer.error}</p>
                  ) : (
                    <p className="muted" style={{ fontSize: 12, margin: '4px 0' }}>正在启动本地服务器…</p>
                  )}
                </div>
              )}
              {lanDevices.length === 0 ? (
                lanPort === null ? (
                  <p className="muted">正在启动局域网发现…（绑定信令服务器 + mDNS 浏览）</p>
                ) : (
                  <p className="muted">
                    正在发现 / 未发现设备：同一 Wi-Fi 下的 LocalTransfer App 会自动出现在这里（mDNS 发现 + 原生信令直连，免扫码）；
                    请确认对方也在 App 首页，且无 AP 隔离（AP 隔离时 mDNS 不可达，请用「离线扫码配对」）。
                  </p>
                )
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {lanDevices.map((d) => {
                    const connected = lanConnectedIds.has(d.id)
                    const connecting = lanConnecting === d.id
                    return (
                      <li key={d.id} className="row" style={{ justifyContent: 'space-between', margin: '8px 0' }}>
                        <span>
                          <span className="ok" style={{ marginRight: 6 }}>●</span>
                          {d.name}{' '}
                          <span className="badge" style={{ padding: '1px 8px', fontSize: 11 }}>局域网</span>{' '}
                          <span className="muted">({d.kind} · :{d.port})</span>
                        </span>
                        <button
                          onClick={() => void connectToLanDevice(d)}
                          disabled={connected || connecting || connState === 'signaling' || connState === 'connecting'}
                        >
                          {connected ? '已连接' : connecting || connState === 'signaling' || connState === 'connecting' ? '连接中…' : '连接'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </>
          )}
        </>
      ) : (
        <p className="muted">
          局域网可见性已关闭：本机不会出现在他人发现列表、也不主动发现。可在「设置 → 局域网」重新开启，
          或使用在线房间 / 离线扫码配对。
        </p>
      )}
    </div>
  ) : null

  /** 桌面端：本地服务器连接的设备（T08 接入后显示；无发现能力时不出空误导文案，T06 验收 4） */
  const desktopBlock = !IS_NATIVE ? (
    <div className="device-block">
      <span className="block-title">
        本地服务器连接的设备 <span className="badge">电脑腿</span>
      </span>
      <p className="muted">
        桌面端浏览器无 mDNS 发现能力：由手机 App 内的本地信令服务器（WSS）接入。此区块将在「电脑腿」接入（T08）后
        显示已连接的电脑设备；当前请{signalingDown ? '使用下方「离线扫码配对」' : '使用上方「在线房间」或下方「离线扫码配对」'}。
      </p>
    </div>
  ) : null

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
        {/* T06：设备双区块（ADR-0009 决策 6 / SPEC §6.1）——在线房间（PIN 门控）+ 局域网发现（来源标注）；
            信令不可达（未配置 / 重试耗尽离线）时局域网区块为主（自动聚焦）；桌面端显示「本地服务器连接的设备」占位 */}
        <h2>设备</h2>
        {signalingDown ? (
          <>
            {lanBlock}
            {roomBlock}
          </>
        ) : (
          <>
            {roomBlock}
            {lanBlock}
          </>
        )}
        {desktopBlock}
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
                {selectedItems.length > 0 && (
                  <div className="row" style={{ flexWrap: 'wrap', rowGap: 4, margin: '6px 0' }}>
                    <span className="muted">
                      已选 {selectedItems.length} 项 · {formatBytes(sumBytes(selectedItems))}
                    </span>
                    <button onClick={toggleSelectAll}>{allDoneSelected ? '取消全选' : '全选'}</button>
                    <button onClick={() => setSelectedIds(new Set())}>清空</button>
                    {IS_NATIVE && (
                      <button onClick={() => void exportToNativeFolder(selectedItems, disambiguateRootVsDir(selectedItems))}>
                        导出选中到文件夹…
                      </button>
                    )}
                    {HAS_FSA_PICKER && !IS_NATIVE && (
                      <button onClick={() => void exportSelectedToDir()}>导出选中到文件夹…</button>
                    )}
                    <button onClick={() => void exportSelectedZip()}>导出选中 zip</button>
                    {(IS_NATIVE || (CAN_SHARE_FILES && !HAS_FSA_PICKER)) && (
                      <button onClick={() => void exportSelectedShare()}>批量分享选中</button>
                    )}
                  </div>
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
                              {IS_NATIVE && (
                                <button onClick={() => void exportToNativeFolder(g.items, uniqueZipPaths(g.items))}>
                                  导出到文件夹…
                                </button>
                              )}
                              <button onClick={() => void exportFolderZip(g)}>导出 zip</button>
                              {IS_NATIVE ? (
                                <button onClick={() => void exportFolderShare(g)}>批量分享</button>
                              ) : HAS_FSA_PICKER ? (
                                <button onClick={() => void exportFolderToDir(g)}>导出到文件夹…</button>
                              ) : CAN_SHARE_FILES ? (
                                <button onClick={() => void exportFolderShare(g)}>批量分享</button>
                              ) : null}
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
                        {it.status === 'done' ? (
                          <label className="row" style={{ gap: 6, minWidth: 0 }}>
                            <input
                              type="checkbox"
                              checked={selectedIds.has(it.id)}
                              onChange={() => toggleSelected(it.id)}
                            />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {it.name} <span className="muted">({formatBytes(it.size)})</span>
                            </span>
                          </label>
                        ) : (
                          <span>
                            {it.name} <span className="muted">({formatBytes(it.size)})</span>
                          </span>
                        )}
                        {it.status === 'done' ? (
                          <div className="row">
                            {IS_NATIVE && (
                              <button onClick={() => void exportToNativeFolder([it], new Map([[it, it.name]]))}>
                                导出到文件夹…
                              </button>
                            )}
                            <button onClick={() => void exportFile(it, 'share')}>{IS_NATIVE ? '分享' : '导出（分享）'}</button>
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
            {nativeExport.phase === 'picking' && <p>选择目标文件夹…</p>}
            {nativeExport.phase === 'copying' && (
              <div style={{ margin: '8px 0' }}>
                <p>
                  正在导出到「{nativeExport.folderName}」：{nativeExport.doneFiles}/{nativeExport.totalFiles} 个文件完成
                  {nativeExport.currentName && (
                    <>
                      {' '}· 当前：{basename(nativeExport.currentName)}
                      {nativeExport.currentTotal != null
                        ? `（${formatBytes(nativeExport.currentWritten ?? 0)} / ${formatBytes(nativeExport.currentTotal)}）`
                        : ''}
                    </>
                  )}
                </p>
                {nativeExport.currentTotal != null && nativeExport.currentTotal > 0 && (
                  <div className="progress">
                    <div
                      style={{ width: `${((nativeExport.currentWritten ?? 0) / nativeExport.currentTotal) * 100}%` }}
                    />
                  </div>
                )}
                <button onClick={cancelNativeExport}>取消（已写文件保留）</button>
              </div>
            )}
            {(nativeExport.phase === 'done' ||
              nativeExport.phase === 'cancelled' ||
              nativeExport.phase === 'error') && (
              <p>
                {nativeExport.phase === 'done'
                  ? `已导出 ${nativeExport.doneFiles} 个文件到「${nativeExport.folderName ?? ''}」（目录结构保留，无需解压）`
                  : nativeExport.phase === 'cancelled'
                    ? `已取消：已写入 ${nativeExport.doneFiles} 个文件（当前文件已停止，已写保留）`
                    : nativeExport.message}
              </p>
            )}
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

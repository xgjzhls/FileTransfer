import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { FolderExport } from 'folder-export'
import { LanDiscovery, DeviceRegistry, LAN_CHANNEL_EVENTS } from 'lan-discovery'
import type { DeviceInfo, TrackedDevice } from 'lan-discovery'
import { runOpfsQuotaTest, clearOpfsTestData, type OpfsQuotaResult } from '../spike/opfs'
import { runStreamDownloadTest, type StreamDownloadResult } from '../spike/streamDownload'
import { LocalServerSession, makeLocalSignalMessage } from '../lan/localServer'
import { lanLocalServerTransport } from '../lan/lanTransport'
import { createNativeExportBridge } from '../native/bridge'
import { copyFileToNative } from '../transfer/nativeExport'
import { getOrCreateDeviceId } from '../rooms/session'
import { detectKind } from '../device'

const IS_NATIVE = Capacitor.isNativePlatform()

type SwState = 'unsupported' | 'registering' | 'controlled' | 'uncontrolled'

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export default function SpikePage() {
  const [swState, setSwState] = useState<SwState>('unsupported')
  const [deviceInfo, setDeviceInfo] = useState('读取中…')

  // ---- Test 1: OPFS quota ----
  const [opfsRunning, setOpfsRunning] = useState(false)
  const [opfsProgress, setOpfsProgress] = useState(0)
  const [opfsResult, setOpfsResult] = useState<OpfsQuotaResult | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [cleanResult, setCleanResult] = useState('')

  // ---- Test 2: SW streamed download ----
  const [streamSize, setStreamSize] = useState<number>(1 * 1024 * 1024 * 1024)
  const [streamRunning, setStreamRunning] = useState(false)
  const [streamProgress, setStreamProgress] = useState(0)
  const [streamResult, setStreamResult] = useState<StreamDownloadResult | null>(null)

  // ---- Test 3: Web Share ----
  const [pickedFiles, setPickedFiles] = useState<File[]>([])
  const [shareResult, setShareResult] = useState('')

  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setSwState('unsupported'); return }
    setSwState('registering')
    navigator.serviceWorker.register('sw.js').then(() => {
      setSwState(navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled')
    })
    const onController = () => setSwState('controlled')
    navigator.serviceWorker.addEventListener('controllerchange', onController)
    return () => navigator.serviceWorker.removeEventListener('controllerchange', onController)
  }, [])

  useEffect(() => {
    const lines = [
      `UA: ${navigator.userAgent}`,
      `Secure context: ${window.isSecureContext}`,
    ]
    if ('storage' in navigator) {
      navigator.storage.estimate().then((e) => {
        lines.push(`Storage estimate: usage ${fmtBytes(e.usage ?? 0)} / quota ${fmtBytes(e.quota ?? 0)}`)
        setDeviceInfo(lines.join('\n'))
      })
    } else {
      setDeviceInfo(lines.join('\n'))
    }
  }, [])

  const swLabel = {
    unsupported: '不支持',
    registering: '注册中…',
    controlled: '已控制 ✓',
    uncontrolled: '未控制（点重载）',
  }[swState]

  async function handleOpfsTest() {
    setOpfsRunning(true)
    setOpfsProgress(0)
    setOpfsResult(null)
    try {
      const r = await runOpfsQuotaTest(setOpfsProgress)
      setOpfsResult(r)
    } catch (e) {
      setOpfsResult({ opfsAvailable: true, persistedBefore: false, persistedAfter: false, estimateBefore: null, estimateAfter: null, maxBytes: 0, durationMs: 0, mbPerSec: 0, error: e instanceof Error ? e.message : String(e), hitCap: false })
    } finally {
      setOpfsRunning(false)
    }
  }

  async function handleCleanup() {
    setCleaning(true)
    setCleanResult('清理中…')
    try {
      const r = await clearOpfsTestData()
      setCleanResult(`已移除 ${r.removed.length} 项：${r.removed.join(', ') || '（无）'}；释放 ${fmtBytes(r.freedBytes)}`)
    } catch (e) {
      setCleanResult(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setCleaning(false)
    }
  }

  async function handleStreamTest() {
    setStreamRunning(true)
    setStreamProgress(0)
    setStreamResult(null)
    try {
      const r = await runStreamDownloadTest({
        sizeBytes: streamSize,
        chunkSize: 32 * 1024 * 1024,
        onProgress: setStreamProgress,
      })
      setStreamResult(r)
    } catch (e) {
      setStreamResult({ ok: false, error: e instanceof Error ? e.message : String(e), pumpDurationMs: 0, bytesFed: 0 })
    } finally {
      setStreamRunning(false)
    }
  }

  // ---- Test 4: 原生文件夹导出插件（T02）----
  const [nativeProbe, setNativeProbe] = useState('')
  const [nativeBusy, setNativeBusy] = useState(false)

  /** 复用正式泵的分块吞吐 + 目录还原验证（T02 验收） */
  async function handleNativeProbe() {
    setNativeBusy(true)
    setNativeProbe('运行中…')
    try {
      const bridge = createNativeExportBridge()
      const picked = await FolderExport.pickFolder()
      if (!picked.ok) throw new Error('pickFolder 未 ok')
      const lines: string[] = [`已选文件夹: ${picked.folderName}（${picked.folderPath}）`]

      // 1) 目录树还原 + 内容校验：photos/2024/a.txt（嵌套目录）与顶层 b.txt
      const payloads = [
        { relPath: 'photos/2024/a.txt', data: new Uint8Array(2 * 1024 * 1024 + 3) },
        { relPath: 'b.txt', data: new Uint8Array(1024) },
      ]
      for (let i = 0; i < payloads.length; i++) {
        const p = payloads[i]
        for (let k = 0; k < p.data.length; k++) p.data[k] = (k * 7 + i) & 0xff
        await copyFileToNative({ bridge, file: new File([p.data], p.relPath), relPath: p.relPath })
        lines.push(`✓ 写入 ${p.relPath}（${p.data.length} B，目录 ${i === 0 ? 'photos/2024/ 嵌套' : '顶层'}）`)
      }

      // 2) 分块过桥吞吐：64 MiB 泵完（复用正式泵，块 4MiB）
      const total = 64 * 1024 * 1024
      const t0 = performance.now()
      const big = new Uint8Array(total)
      for (let k = 0; k < big.length; k++) big[k] = k & 0xff
      await copyFileToNative({ bridge, file: new File([big], 'throughput.bin'), relPath: 'throughput.bin' })
      const dt = (performance.now() - t0) / 1000
      lines.push(`✓ 64 MiB 分块过桥: ${(total / 1e6 / dt).toFixed(1)} MB/s（含 JS base64 编码）`)

      // 3) abort：写 64MiB 文件中途取消，确认半成品被清理（已写文件保留）
      const ctrl = new AbortController()
      const t1 = performance.now()
      let chunks = 0
      const abortProbe = copyFileToNative({
        bridge,
        file: new File([big], 'abort.bin'),
        relPath: 'abort.bin',
        signal: ctrl.signal,
        onProgress: () => {
          chunks++
          if (chunks === 2 && performance.now() - t1 > 30) ctrl.abort() // 第 2 块后取消
        },
      }).catch((e) => (e.name === 'NativeExportAbortedError' ? 'aborted' : Promise.reject(e)))
      const aborted = await abortProbe
      lines.push(aborted === 'aborted' ? '✓ abort 生效（中途取消，已写文件保留）' : `✗ abort 未生效: ${aborted}`)
      lines.push('→ 去「文件」App 核对：photos/2024/a.txt、b.txt、throughput.bin 存在且大小正确；abort.bin 不存在（半成品已清理）')
      setNativeProbe(lines.join('\n'))
    } catch (e) {
      setNativeProbe(`失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setNativeBusy(false)
    }
  }

  async function handleShare() {
    if (pickedFiles.length === 0) return
    setShareResult('分享中…')
    try {
      await navigator.share({ files: pickedFiles })
      setShareResult('分享面板已处理（请在面板中选择「存储到照片 / 存储到文件」）')
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setShareResult('已取消')
      } else {
        setShareResult(`失败：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  // ---- Test 5: 局域网发现插件（ADR-0009 / T02，仅 app 内）----
  const [lanLog, setLanLog] = useState<string[]>([])
  const [lanDevices, setLanDevices] = useState<TrackedDevice[]>([])
  const [lanBusy, setLanBusy] = useState('')
  const lanRegistryRef = useRef<DeviceRegistry | null>(null)
  if (lanRegistryRef.current === null) lanRegistryRef.current = new DeviceRegistry()

  const detectedKind = detectKind()
  const advertOptions: DeviceInfo = {
    name: localStorage.getItem('lt.deviceName')?.trim() || '未命名设备',
    id: getOrCreateDeviceId(),
    // 插件 schema 只收 phone/tablet/desktop（SPEC §5.5）；detectKind 的 'other' 归为 phone
    kind: detectedKind === 'other' ? 'phone' : detectedKind,
    port: 8443, // T04 信令端口默认值（SPEC §5.5；探针起服务器时若被占依次试 8444/8445）
    ver: '1',
  }

  useEffect(() => {
    if (!IS_NATIVE) return
    const registry = lanRegistryRef.current!
    const unsubs: Promise<PluginListenerHandle>[] = [
      LanDiscovery.addListener('deviceFound', (d) => {
        registry.add(d, Date.now())
        setLanDevices(registry.list())
      }),
      LanDiscovery.addListener('deviceLost', ({ id }) => {
        registry.remove(id)
        setLanDevices(registry.list())
      }),
      LanDiscovery.addListener('permissionDenied', () => {
        setLanLog((l) => [...l, '⚠️ 本地网络权限被拒：设置 → 隐私与安全性 → 本地网络 → 开启 LocalTransfer'])
      }),
      // T04 信令通道事件（真机验收用）
      LanDiscovery.addListener(LAN_CHANNEL_EVENTS.peerConnected, (e) => {
        setLanLog((l) => [...l, `⚡ peerConnected ${e.id} session=${e.session} role=${e.role}`])
      }),
      LanDiscovery.addListener(LAN_CHANNEL_EVENTS.peerDisconnected, ({ id }) => {
        setLanLog((l) => [...l, `⚡ peerDisconnected ${id}`])
      }),
      LanDiscovery.addListener(LAN_CHANNEL_EVENTS.messageReceived, (e) => {
        setLanLog((l) => [...l, `⚡ messageReceived ${e.from} ${e.kind} sdp=${e.sdp.slice(0, 40)}…`])
      }),
      LanDiscovery.addListener(LAN_CHANNEL_EVENTS.signalingError, (e) => {
        setLanLog((l) => [...l, `⚡ signalingError ${e.peerId ?? '(无)'} ${e.code}：${e.message}`])
      }),
    ]
    return () => { void Promise.all(unsubs).then((hs) => hs.forEach((h) => h.remove())) }
  }, [])

  // last-seen TTL 兑底（mDNS TTL 默认 120s）：即使没收到 deviceLost 也清掉超时设备
  useEffect(() => {
    if (!IS_NATIVE) return
    const t = setInterval(() => {
      if (lanRegistryRef.current!.pruneStale(120_000, Date.now()).length > 0) {
        setLanDevices(lanRegistryRef.current!.list())
      }
    }, 30_000)
    return () => clearInterval(t)
  }, [])

  const lanPush = (line: string) => setLanLog((l) => [...l.slice(-20), line])

  async function handleAdvert(on: boolean) {
    setLanBusy(on ? '广告' : '停广告')
    try {
      const r = on
        ? await LanDiscovery.startAdvertising(advertOptions)
        : await LanDiscovery.stopAdvertising()
      lanPush(on ? `startAdvertising → ${JSON.stringify(r)}` : `stopAdvertising → ${JSON.stringify(r)}`)
    } catch (e) {
      lanPush(`广告失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleBrowse(on: boolean) {
    setLanBusy(on ? '浏览' : '停浏览')
    try {
      if (on) {
        const r = await LanDiscovery.startBrowsing()
        lanPush(`startBrowsing → ${JSON.stringify(r)}`)
        if (r.permissionDenied) {
          lanPush('⚠️ 权限被拒（见上引导）')
        }
      } else {
        const r = await LanDiscovery.stopBrowsing()
        lanPush(`stopBrowsing → ${JSON.stringify(r)}`)
      }
    } catch (e) {
      lanPush(`浏览失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleLanStatus() {
    try {
      lanPush(`getStatus → ${JSON.stringify(await LanDiscovery.getStatus())}`)
    } catch (e) {
      lanPush(`getStatus 失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---- T04 原生信令通道探针（真机待验：建通道 + SDP 互发 + 竞态）----
  const [lanServerPort, setLanServerPort] = useState<number | null>(null)

  async function handleServer(on: boolean) {
    setLanBusy(on ? '信令服务器' : '停信令服务器')
    try {
      if (on) {
        // PORT_IN_USE 依次试 8443/8444/8445（SPEC §5.5 默认 8443）
        for (const port of [8443, 8444, 8445]) {
          const r = await LanDiscovery.startSignalingServer({ device: { ...advertOptions, port } })
          if (r.ok) {
            lanPush(`startSignalingServer(port=${port}) → ${JSON.stringify(r)}`)
            setLanServerPort(port)
            return
          }
          lanPush(`startSignalingServer(port=${port}) → ${JSON.stringify(r)}`)
          if (r.error !== 'PORT_IN_USE') return
        }
      } else {
        const r = await LanDiscovery.stopSignalingServer()
        lanPush(`stopSignalingServer → ${JSON.stringify(r)}`)
        setLanServerPort(null)
      }
    } catch (e) {
      lanPush(`信令服务器失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleChannelConnect(device: TrackedDevice) {
    setLanBusy(`连接 ${device.name}`)
    try {
      const r = await LanDiscovery.connect({ peer: device, myId: advertOptions.id })
      lanPush(`connect(${device.name}) → ${JSON.stringify(r)}`)
    } catch (e) {
      lanPush(`connect 失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleChannelSend(device: TrackedDevice, kind: 'offer' | 'answer') {
    setLanBusy(`发送 ${kind}`)
    try {
      // 压缩约定与 WS/QR 同一套（SPEC §5.1）：sdp 对原生透明，探针直接塞占位串
      const sdp = `probe-${kind}-${Date.now()}`
      const r = await LanDiscovery.sendMessage({ peerId: device.id, kind, sdp })
      lanPush(`sendMessage(${device.name}, ${kind}) → ${JSON.stringify(r)}`)
    } catch (e) {
      lanPush(`sendMessage 失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleChannelDisconnect(device: TrackedDevice) {
    setLanBusy(`断开 ${device.name}`)
    try {
      const r = await LanDiscovery.disconnect({ peerId: device.id })
      lanPush(`disconnect(${device.name}) → ${JSON.stringify(r)}`)
    } catch (e) {
      lanPush(`disconnect 失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  // ---- T07 本地 WSS 服务器探针（电脑腿 A：启动/地址/指纹/客户端/中继）----
  const [localServerProbe, setLocalServerProbe] = useState<{
    port: number
    urls: string[]
    fingerprint: string
    clientConnected: boolean
    messages: string[]
  } | null>(null)
  const localServerRef = useRef<LocalServerSession | null>(null)

  async function handleLocalServer(on: boolean) {
    setLanBusy('本地服务器')
    try {
      if (on) {
        const session = new LocalServerSession({
          transport: lanLocalServerTransport,
          device: { ...advertOptions },
          events: {
            onClientChange: (connected) =>
              setLocalServerProbe((s) => (s ? { ...s, clientConnected: connected } : s)),
            onSignal: (payload) =>
              setLocalServerProbe((s) =>
                s
                  ? { ...s, messages: [...s.messages, `收到桌面 ${payload.kind}（sdp ${payload.sdp.slice(0, 40)}…）`].slice(-8) }
                  : s,
              ),
            onError: (code, message) => lanPush(`本地服务器错误：${code} ${message}`),
          },
        })
        localServerRef.current = session
        const r = await session.start()
        if (r.ok && session.port !== null) {
          setLocalServerProbe({
            port: session.port,
            urls: session.urls(),
            fingerprint: session.caFingerprint ?? '',
            clientConnected: false,
            messages: ['本地服务器已监听 ✓（CA 已持久化）'],
          })
        } else {
          lanPush(`本地服务器启动失败：${r.error ?? '未知错误'}`)
        }
      } else {
        await localServerRef.current?.stop()
        localServerRef.current = null
        setLocalServerProbe(null)
        lanPush('本地服务器已停止')
      }
    } catch (e) {
      lanPush(`本地服务器失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  async function handleLocalSend() {
    setLanBusy('本地发送')
    try {
      const text = makeLocalSignalMessage({ kind: 'offer', sdp: `probe-${Date.now()}` })
      const sent = await lanLocalServerTransport.sendLocalMessage({ message: text })
      lanPush(`发测试 signal → ${JSON.stringify(sent)}`)
    } catch (e) {
      lanPush(`本地发送失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setLanBusy('')
    }
  }

  return (
    <>
      <header>
        <h1>LocalTransfer — 存储 spike</h1>
        <p>目标：验证 iOS Safari 能否承接 10GB 级文件（OPFS 配额 / SW 流式下载 / Web Share 存照片）。请在真实 iPhone/iPad 上测试，Safari 标签页和「添加到主屏幕」两种模式各跑一遍。</p>
      </header>

      <Card title="设备与状态">
        <pre className="mono">{deviceInfo}</pre>
        <div className="row">
          <span>
            Service Worker：<strong className={swState === 'controlled' ? 'ok' : 'bad'}>{swLabel}</strong>
          </span>
          {swState === 'uncontrolled' && (
            <button onClick={() => location.reload()}>重载页面</button>
          )}
        </div>
        <p>说明：OPFS 与 SW 都需要安全上下文（HTTPS 或 localhost）。本页若不是 https，下面测试会直接失败——这是预期行为。</p>
      </Card>

      <Card title="测试 1：OPFS 配额（10GB 存得下吗）">
        <p>向 OPFS 持续写入直到失败，测出真实容量上限（含 persist() 前后对比）。会写掉不少磁盘空间，测试完自动清理。</p>
        <p className="bad">⚠️ 若测试中途关闭页面/被系统终止，写入的文件会残留在 OPFS（沙盒内，不可见、不自动清理）——用下面的红色按钮清除。</p>
        <button onClick={handleOpfsTest} disabled={opfsRunning}>
          {opfsRunning ? '写入中…' : '开始 OPFS 配额测试'}
        </button>
        {opfsRunning && (
          <div className="progress"><div style={{ width: '100%' }} /></div>
        )}
        {opfsRunning && <p className="mono">已写入 {fmtBytes(opfsProgress)}</p>}
        {opfsResult && (
          <pre className="mono">
            {[
              `OPFS 可用: ${opfsResult.opfsAvailable}`,
              `persist() 前持久化: ${opfsResult.persistedBefore}`,
              `persist() 请求结果: ${opfsResult.persistedAfter}`,
              `estimate 前: usage ${fmtBytes(opfsResult.estimateBefore?.usage ?? 0)} / quota ${fmtBytes(opfsResult.estimateBefore?.quota ?? 0)}`,
              `estimate 后: usage ${fmtBytes(opfsResult.estimateAfter?.usage ?? 0)} / quota ${fmtBytes(opfsResult.estimateAfter?.quota ?? 0)}`,
              `最大写入: ${fmtBytes(opfsResult.maxBytes)}`,
              `耗时: ${(opfsResult.durationMs / 1000).toFixed(1)}s，平均 ${opfsResult.mbPerSec.toFixed(0)} MB/s`,
              opfsResult.hitCap ? '达到安全上限（64GB）未触发配额' : `错误: ${opfsResult.error ?? '（无，写满至上限）'}`,
            ].join('\n')}
          </pre>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <button onClick={handleCleanup} disabled={cleaning} style={{ background: '#ff453a' }}>
            {cleaning ? '清理中…' : '⚠️ 清理 OPFS 测试数据（释放磁盘）'}
          </button>
        </div>
        {cleanResult && <p>{cleanResult}</p>}
      </Card>

      <Card title="测试 2：SW 流式下载（能否绕过 OPFS 直落「文件」App）">
        <p>页面把 N GB 数据经 Service Worker 喂成下载。若 Safari 流式落盘 → 成功；若整体缓冲 → 内存爆掉/设备卡死（这本身就是答案）。完成后去「文件」App 看 spike-stream.bin 是否完整。</p>
        <div className="row">
          <label>
            大小：
            <select value={streamSize} onChange={(e) => setStreamSize(Number(e.target.value))} disabled={streamRunning}>
              <option value={1 * 1024 ** 3}>1 GB</option>
              <option value={5 * 1024 ** 3}>5 GB</option>
              <option value={10 * 1024 ** 3}>10 GB</option>
            </select>
          </label>
          <button onClick={handleStreamTest} disabled={streamRunning || swState !== 'controlled'}>
            {streamRunning ? '喂流中…' : '开始流式下载测试'}
          </button>
        </div>
        {streamRunning && (
          <>
            <div className="progress"><div style={{ width: `${Math.min(100, (streamProgress / streamSize) * 100)}%` }} /></div>
            <p className="mono">已泵出 {fmtBytes(streamProgress)} / {fmtBytes(streamSize)}</p>
          </>
        )}
        {streamResult && (
          <pre className="mono">
            {[
              `泵出: ${fmtBytes(streamResult.bytesFed)}，耗时 ${(streamResult.pumpDurationMs / 1000).toFixed(1)}s`,
              streamResult.ok ? '泵流完成 → 去「文件」App 检查 spike-stream.bin 是否完整存在' : `错误: ${streamResult.error}`,
            ].join('\n')}
          </pre>
        )}
      </Card>

      <Card title="测试 3：Web Share 存照片（大视频能不能进「照片」库）">
        <p>从「照片」选一个大视频（尽量 1GB+），点分享，在面板里选「存储到照片」，看能否完成。</p>
        <input
          type="file"
          multiple
          accept="image/*,video/*"
          onChange={(e) => setPickedFiles(Array.from(e.target.files ?? []))}
        />
        <div className="row">
          <button onClick={handleShare} disabled={pickedFiles.length === 0 || !navigator.share}>
            {pickedFiles.length > 0 ? `分享 ${pickedFiles.length} 个文件（${fmtBytes(pickedFiles.reduce((s, f) => s + f.size, 0))}）` : '先选文件'}
          </button>
          {!navigator.share && <span className="bad">此浏览器不支持 Web Share</span>}
        </div>
        {shareResult && <p>{shareResult}</p>}
      </Card>

      <Card title="测试 4：原生文件夹导出插件（T02，仅 iOS app 内）">
        <p>ADR-0008 正式插件验收：pickFolder 选文件夹 → mkdir 嵌套目录 → writeChunk 分块写（4 MiB，含吞吐）→ abort 取消清理。非壳（网页）环境按钮不可用。</p>
        <p className="mono">isNativePlatform: {String(IS_NATIVE)}</p>
        <button onClick={handleNativeProbe} disabled={nativeBusy || !IS_NATIVE}>
          {nativeBusy ? '运行中…' : '选文件夹并跑插件探针'}
        </button>
        {!IS_NATIVE && <p className="bad">仅 app 内可用（网页版请用桌面 FSA / zip / 分享路径）</p>}
        {nativeProbe && <pre className="mono">{nativeProbe}</pre>}
      </Card>

      <Card title="测试 5：局域网发现插件（ADR-0009 / T02 + T04，仅 app 内）">
        <p>T02 验收：两台 iOS app 实例同 Wi-Fi 下互发现（发现 → 消失 → 重发现）。T04 验收：发现后起信令服务器 → 点设备连接（发起方 TCP 连对端 TXT port）→ 双向发 offer/answer；两台同时点连接验证竞态（低 deviceId 胜，不产生双连接）。首次使用会弹本地网络授权。</p>
        <p className="mono">isNativePlatform: {String(IS_NATIVE)}</p>
        <p className="mono">本机广告参数: {JSON.stringify(advertOptions)}</p>
        <div className="row">
          <button onClick={() => handleAdvert(true)} disabled={!!lanBusy || !IS_NATIVE}>{lanBusy === '广告' ? '广告中…' : '开始广告'}</button>
          <button onClick={() => handleAdvert(false)} disabled={!!lanBusy || !IS_NATIVE}>停止广告</button>
          <button onClick={() => handleBrowse(true)} disabled={!!lanBusy || !IS_NATIVE}>{lanBusy === '浏览' ? '浏览中…' : '开始浏览'}</button>
          <button onClick={() => handleBrowse(false)} disabled={!!lanBusy || !IS_NATIVE}>停止浏览</button>
          <button onClick={handleLanStatus} disabled={!!lanBusy || !IS_NATIVE}>状态</button>
        </div>
        <div className="row">
          <button onClick={() => handleServer(true)} disabled={!!lanBusy || !IS_NATIVE} title="绑定 8443（被占依次试 8444/8445）+ 挂 Bonjour（SRV=TXT=监听端口）">
            {lanBusy === '信令服务器' ? '启动中…' : lanServerPort ? `信令服务器 :${lanServerPort}` : '启动信令服务器'}
          </button>
          <button onClick={() => handleServer(false)} disabled={!!lanBusy || !IS_NATIVE}>停信令服务器</button>
        </div>
        {!IS_NATIVE && <p className="bad">仅 app 内可用（浏览器无 mDNS/DNS-SD 能力，ADR-0009）</p>}
        {lanDevices.length === 0 && !lanLog.length ? null : (
          <>
            <p className="mono">发现的设备（{lanDevices.length}）：</p>
            <ul>
              {lanDevices.filter((d) => d.id !== advertOptions.id).map((d) => (
                <li key={d.id} className="mono">
                  {d.name}（{d.kind}，port {d.port}，ver {d.ver}）service={d.serviceName}@{d.domain} 首次 {new Date(d.firstSeen).toLocaleTimeString()} 最后 {new Date(d.lastSeen).toLocaleTimeString()}
                  <div className="row">
                    <button onClick={() => handleChannelConnect(d)} disabled={!!lanBusy}>连接</button>
                    <button onClick={() => handleChannelSend(d, 'offer')} disabled={!!lanBusy}>发 offer</button>
                    <button onClick={() => handleChannelSend(d, 'answer')} disabled={!!lanBusy}>发 answer</button>
                    <button onClick={() => handleChannelDisconnect(d)} disabled={!!lanBusy}>断开</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
        {lanLog.map((line, i) => <pre key={i} className="mono">{line}</pre>)}
      </Card>

      <Card title="测试 6：本地 WSS 服务器（T07 电脑腿 A，仅 app 内）">
        <p>
          T07 验收：App 起本地 WSS 信令服务器（默认 9443，被占依次试 9444/9445）→ 桌面 Chrome 连
          <code className="mono">wss://&lt;地址&gt;/ws?device=&lt;deviceId&gt;</code>（证书由 App 自签，桌面一次性信任 CA）→ 双向交换
          offer/answer → 数据面 WebRTC 直连（文件不经服务器）。首次启动会生成并持久化 CA（<code className="mono">lt.localCa</code>）。
        </p>
        <div className="row">
          <button onClick={() => handleLocalServer(true)} disabled={!!lanBusy || !IS_NATIVE}>
            {lanBusy === '本地服务器' ? '启动中…' : localServerProbe ? `本地服务器 :${localServerProbe.port}` : '启动本地服务器'}
          </button>
          <button onClick={() => handleLocalServer(false)} disabled={!!lanBusy || !IS_NATIVE}>停本地服务器</button>
          <button onClick={() => handleLocalSend()} disabled={!!lanBusy || !IS_NATIVE || !localServerProbe?.clientConnected}>发测试 signal</button>
        </div>
        {!IS_NATIVE && <p className="bad">仅 app 内可用（浏览器无监听能力，ADR-0009 决策 4）</p>}
        {localServerProbe && (
          <>
            <p className="mono">地址：{localServerProbe.urls.join(' / ')}</p>
            <p className="mono">CA 指纹：{localServerProbe.fingerprint}</p>
            <p className="mono">
              桌面客户端：{localServerProbe.clientConnected ? '已连接 ✓' : '未连接'}；CA 下载：
              <code className="mono">https://&lt;地址&gt;/ca.crt</code>（curl -k + 指纹校验）
            </p>
            {localServerProbe.messages.map((m, i) => <pre key={i} className="mono">{m}</pre>)}
          </>
        )}
      </Card>
    </>
  )
}

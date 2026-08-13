import { useEffect, useState } from 'react'
import { runOpfsQuotaTest, type OpfsQuotaResult } from './spike/opfs'
import { runStreamDownloadTest, type StreamDownloadResult } from './spike/streamDownload'

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

function App() {
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
  const [shareResult, setShareResult] = useState<string>('')

  useEffect(() => {
    if (!('serviceWorker' in navigator)) { setSwState('unsupported'); return }
    setSwState('registering')
    navigator.serviceWorker.register('/sw.js').then(() => {
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
    </>
  )
}

export default App

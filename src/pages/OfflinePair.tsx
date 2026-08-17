/**
 * 离线扫码配对（T07 + T13，SPEC §5.3 / ADR-0002 / ADR-0006）——
 * 无信令服务时的 WebRTC 配对。
 *
 * 流程：发送端生成 offer 二维码 → 接收端直接扫码（T13：免选角色，
 * 按码型自动判定）→ 接收端显示 answer 二维码 → 发送端扫码 → 建连。
 * 建连后完全复用 T04/T05/T06 数据面（ConnectionManager 事件 → Home
 * 状态机；断连后重新配对 → 自动续传）。
 *
 * 两个方向都提供「摄像头扫码」与「手动粘贴文本」两种交换方式
 * （电脑无摄像头 fallback，SPEC §5.3 低优先级项；也为 e2e 提供注入路径）。
 *
 * T13 轻量打磨：
 * - 免选角色：接收端直接扫码，扫到 offer 码自动走 answer 流程（方向性约束：
 *   offer 必须先于 answer 存在——发送端仍需先「显示配对码」）
 * - 扫码失败（解码失败 / 码型与当前角色不符）→ 明确提示 + 扫码器保持运行可重扫
 * - 错误文案按场景区分（权限 / 无摄像头 / 占用 / 参数 / 非安全上下文）
 * - 配对成功明确反馈 + 自动收起
 *
 * T14 设备分工（SPEC §5.3）：按设备类型给默认主路径——电脑（无摄像头）默认
 * 「显示配对码」、手机/平板默认「扫码」，pick 页三步引导（电脑显示 → 手机扫屏
 * → 回码经微信/文件发回电脑粘贴），两向均可手动切换。
 *
 * T16 回码打磨（SPEC §5.3 / ADR-0007）：answer 端回码全屏（min(80vw,360px)）+
 * 「分享回码」一键 navigator.share({ text })，失败降级复制（src/qr/shareCode.ts）。
 *
 * T17 断线快捷重配（SPEC §5.3 / ADR-0007）：断线警告旁「重新配对」一步回本端 offer
 * 页（保持角色，不重走 pick）+ 自动重新生成配对码；桌面 offer 页主次重排——粘贴为
 * 唯一主操作、扫码降为 details 入口、重新生成收进角落（手机端 offer 页保持现状）。
 *
 * T21 全屏放大（SPEC §5.3）：offer/answer 二维码可点击放大为全屏超大码
 * （min(88vw,82vh)，渲染上限 1024 保证清晰），点码外空白处 / Esc 关闭。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { decodeQrText, encodeQrText } from '../qr/qrCodec'
import { renderQrToCanvas } from '../qr/qrRender'
import { startQrScanner } from '../qr/qrScan'
import type { QrScannerHandle } from '../qr/qrScan'
import { routeScannedCode } from '../qr/scanRoute'
import type { ScanPhase } from '../qr/scanRoute'
import { cameraErrorText } from '../qr/scanErrors'
import {
  pairButtonLabels,
  pairGuide,
  pairPolishLabels,
  primaryPairAction,
  rePairAction,
} from '../qr/pairGuide'
import type { PairPhase } from '../qr/pairGuide'
import { answerQrMaxWidth, detectShareCapability, sharePairCode } from '../qr/shareCode'
import { detectKind } from '../device'
import type { ConnectionManager } from '../webrtc/connection'
import type { SignalPayload } from '../protocol/signaling'
import type { DeviceKind } from '../protocol/signaling'

type Phase = PairPhase

interface OfflinePairProps {
  /** 获取（惰性创建）共享 ConnectionManager；数据面事件已由 Home 接线 */
  manager: () => ConnectionManager
  /** 当前连接状态（Home 的 connState；配对成功自动收起面板） */
  connState: string
  /** 本端设备类型（T14 分工默认主路径；Home 传入与设备上报一致的值，缺省自检） */
  deviceKind?: DeviceKind
  /**
   * T08：外部自动打开面板的令牌（Home 的「改用离线扫码配对」一键降级）——
   * 值变化即打开（setEverOpened(true) + setOpen(true)），与手动点击同语义。
   */
  openToken?: number
}

export default function OfflinePair({ manager, connState, deviceKind, openToken }: OfflinePairProps) {
  const [open, setOpen] = useState(false)
  /** 本次挂载是否打开过配对面板：离线断连警告仅在用过离线配对后出现（不打扰纯在线用户） */
  const [everOpened, setEverOpened] = useState(false)
  const [phase, setPhase] = useState<Phase>('pick')
  /** e2e 测试钩子（DEV 仅）：可覆盖 connState 以验证断线快捷重配（T17） */
  const [connOverride, setConnOverride] = useState<string | null>(null)
  const effectiveConn = connOverride ?? connState
  // T14 设备分工：本端默认主路径与引导文案（手机扫码 / 电脑出码）
  const kind = useMemo(() => deviceKind ?? detectKind(), [deviceKind])
  const primary = primaryPairAction(kind)
  const guide = pairGuide(kind)
  const buttonLabels = pairButtonLabels(kind)
  /** T16/T17 打磨文案（按钮标签/提示集中一处，便于单测与改文案） */
  const polish = pairPolishLabels()
  /** T16：navigator.share 能力探测（非安全上下文 / 老浏览器 → 降级复制） */
  const shareCapability = useMemo(() => detectShareCapability(), [])
  const [offerText, setOfferText] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [pasteInput, setPasteInput] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  /** T21：全屏放大二维码开关（点码触发；点空白 / Esc / 相位切换关闭） */
  const [qrFullscreen, setQrFullscreen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** T21：全屏放大专用 canvas（独立 ref，随遮罩挂载/卸载；避免与主码共 ref） */
  const fullscreenCanvasRef = useRef<HTMLCanvasElement>(null)
  const scannerRef = useRef<QrScannerHandle | null>(null)
  /** 解码处理中防重入（扫码帧高频触发） */
  const processingRef = useRef(false)
  /** 当前相位（onDecoded 闭包取自扫码器启动那次渲染，用 ref 防陈旧） */
  const phaseRef = useRef<Phase>('pick')
  /** 错误提示节流：同文案 1.5s 内不重复刷屏（扫码帧 10 次/秒） */
  const lastErrRef = useRef<{ msg: string; at: number }>({ msg: '', at: 0 })
  /** 本次配对是否由 QR 流程推进（防在线连接完成时误报「配对成功」） */
  const pairedRef = useRef(false)
  /** e2e 钩子用（与 __ltSignaling 同模式）：最新配对码文本 */
  const offerTextRef = useRef('')
  const answerTextRef = useRef('')

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  // e2e 测试钩子（仅 DEV）：读取本端生成的 offer / answer 文本；模拟断线（T17 重配入口）
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const hook = {
      getOfferText: () => offerTextRef.current,
      getAnswerText: () => answerTextRef.current,
      setConnStateForTest: (s: string | null) => setConnOverride(s),
    }
    ;(window as unknown as { __ltQr?: typeof hook }).__ltQr = hook
    return () => {
      delete (window as unknown as { __ltQr?: unknown }).__ltQr
    }
  }, [])

  // 摄像头扫码生命周期（scanning 置 true 时启动；置 false / 卸载时停止）
  useEffect(() => {
    if (!scanning) return
    const video = videoRef.current
    if (!video) return
    let cancelled = false
    let handle: QrScannerHandle | null = null
    void startQrScanner(
      video,
      (text) => void onDecoded(text),
      {
        onStartError: (e) => setErr(cameraErrorText(e)),
      },
    )
      .then((h) => {
        if (cancelled) {
          h.stop()
          return
        }
        handle = h
        scannerRef.current = h
      })
      .catch(() => {
        /* 错误已通过 onStartError 呈现；start 失败时恢复非扫码态 */
        if (!cancelled) setScanning(false)
      })
    return () => {
      cancelled = true
      handle?.stop()
      scannerRef.current = null
    }
    // onDecoded 仅依赖 refs 与稳定 setter，无需重建扫描器
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanning])

  // 二维码渲染（phase 对应本端当前应展示的码）
  useEffect(() => {
    const canvas = canvasRef.current
    const text = phase === 'offer-show' ? offerText : phase === 'answer-show' ? answerText : ''
    if (!canvas || !text) return
    void renderQrToCanvas(canvas, text).catch((e) =>
      setErr(`二维码渲染失败：${e instanceof Error ? e.message : String(e)}`),
    )
  }, [offerText, answerText, phase])

  // T21 全屏二维码渲染（遮罩打开时渲染一次；maxSize 1024 放大后码块不糊）
  useEffect(() => {
    const canvas = fullscreenCanvasRef.current
    const text = phase === 'offer-show' ? offerText : phase === 'answer-show' ? answerText : ''
    if (!qrFullscreen || !canvas || !text) return
    void renderQrToCanvas(canvas, text, 1024).catch((e) =>
      setErr(`二维码渲染失败：${e instanceof Error ? e.message : String(e)}`),
    )
  }, [qrFullscreen, offerText, answerText, phase])

  // 配对成功（连接已建立，且本次连接由 QR 流程推进）→ 明确反馈 + 短暂提示后自动收起。
  // pairedRef 门控：面板开着但连接来自在线 WS（点选设备）时不误报、不误收起。
  useEffect(() => {
    if (effectiveConn !== 'connected' || !pairedRef.current) return
    if (phase === 'offer-show' || phase === 'answer-show' || phase === 'done') {
      setErr('')
      setMsg('配对成功，正在建立连接…')
      const t = setTimeout(() => {
        reset()
        setOpen(false)
      }, 1500)
      return () => clearTimeout(t)
    }
  }, [effectiveConn, phase])

  // 面板收起时确保停掉摄像头
  useEffect(() => {
    if (!open) setScanning(false)
  }, [open])

  // T08：Home「改用离线扫码配对」一键打开本面板（token 变化即触发）
  useEffect(() => {
    if (!openToken) return
    setEverOpened(true)
    setOpen(true)
  }, [openToken])

  // T21：相位切换 / 面板收起时关闭全屏（全屏内容不得与当前相位脱节）
  useEffect(() => {
    setQrFullscreen(false)
  }, [phase, open])

  // T21：全屏打开时锁定 body 滚动（背后页面不跟随滚动）
  useEffect(() => {
    if (!qrFullscreen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [qrFullscreen])

  // T21：Esc 关闭全屏
  useEffect(() => {
    if (!qrFullscreen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setQrFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [qrFullscreen])

  function reset(): void {
    setPhase('pick')
    setPasteInput('')
    setMsg('')
    setErr('')
    setCopyMsg('')
    setScanning(false)
    lastErrRef.current = { msg: '', at: 0 }
    pairedRef.current = false
  }

  /** 扫码失败提示节流：解码失败/码型不符时扫码器保持运行，不刷屏 */
  function showScanError(message: string): void {
    const now = Date.now()
    if (message === lastErrRef.current.msg && now - lastErrRef.current.at < 1500) return
    lastErrRef.current = { msg: message, at: now }
    setErr(message)
  }

  // ── 发送端（offerer）──
  async function generateOffer(): Promise<void> {
    setErr('')
    setMsg('正在生成配对码…')
    try {
      const payload = await manager().createQrOffer()
      const text = await encodeQrText(payload)
      offerTextRef.current = text
      setOfferText(text)
      setMsg(
        kind === 'desktop'
          ? '已生成配对码：手机扫此码后，把手机显示的回码文本发回本机粘贴。'
          : '让接收端扫描此码；扫码后把对方的回码给我（扫码或粘贴）。',
      )
      setPhase('offer-show')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  async function acceptAnswerPayload(payload: SignalPayload): Promise<void> {
    await manager().handleQrAnswer(payload)
    pairedRef.current = true // 发送端：回码已应用，本次连接归属 QR 流程
    setMsg('配对成功，正在建立连接…')
    setPhase('done')
  }

  // ── 接收端（answerer，T13：免选角色自动进入）──
  async function acceptOfferPayload(payload: SignalPayload): Promise<void> {
    const answer = await manager().handleQrOffer(payload)
    pairedRef.current = true // 接收端：offer 已接受，后续连接归属 QR 流程
    const text = await encodeQrText(answer)
    answerTextRef.current = text
    setAnswerText(text)
    setMsg('配对码已识别：请让对端扫描下方二维码，或复制文本发给对端粘贴。')
    setPhase('answer-show')
  }

  /** 手动粘贴路径：解码后按「码型 + 当前相位」自动路由（与扫码同一逻辑） */
  async function applyPaste(): Promise<void> {
    setErr('')
    if (!pasteInput.trim()) {
      setErr('请先粘贴或输入配对码文本')
      return
    }
    try {
      const payload = await decodeQrText(pasteInput)
      const outcome = routeScannedCode(payload.kind, scanPhaseOf(phaseRef.current))
      if (outcome.action === 'error') {
        setErr(outcome.message)
        return
      }
      if (outcome.action === 'answer') await acceptOfferPayload(payload)
      else await acceptAnswerPayload(payload)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 摄像头解码路径：按码型自动判定角色（T13），失败不中断扫码可重扫 */
  function onDecoded(text: string): void {
    if (processingRef.current) return
    processingRef.current = true
    void (async () => {
      try {
        const payload = await decodeQrText(text)
        const outcome = routeScannedCode(payload.kind, scanPhaseOf(phaseRef.current))
        if (outcome.action === 'error') {
          showScanError(outcome.message)
          return // 扫码器保持运行：可继续扫正确的码
        }
        setScanning(false)
        if (outcome.action === 'answer') await acceptOfferPayload(payload)
        else await acceptAnswerPayload(payload)
      } catch (e) {
        // 解码失败（非本应用配对码 / 损坏）：提示 + 自动恢复可重扫
        showScanError(`无法识别的配对码：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        processingRef.current = false
      }
    })()
  }

  async function copyText(text: string): Promise<void> {
    setCopyMsg('')
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg('已复制')
    } catch {
      setCopyMsg('复制失败：请手动选择下方文本复制')
    }
  }

  /**
   * T16：分享回码——navigator.share({ text }) 一键分享到微信/文件传输（iOS 支持文本分享），
   * 省掉「复制 → 切 app → 粘贴」；不支持 / 抛错 / 用户取消 → 降级提示用「复制配对码」。
   */
  async function shareAnswer(): Promise<void> {
    setCopyMsg('')
    const outcome = await sharePairCode(answerText, shareCapability)
    if (outcome === 'shared') {
      setCopyMsg('已分享：等待对端粘贴回码')
    } else {
      setCopyMsg(polish.shareFallbackMsg)
    }
  }

  /**
   * T17：断线快捷重配——不重走 pick 页，按本端角色一步续配：
   * offerer 重新出码；answerer 保持接收角色，等对方重新「显示配对码」后扫新码。
   * 重配后由现有 resume_manifest 流程从 bitfield 断点续传。
   */
  async function rePair(): Promise<void> {
    setErr('')
    setCopyMsg('')
    if (rePairAction(phaseRef.current) === 'scan') {
      setMsg(polish.rePairScanMsg)
      setPhase('scan-wait')
      setScanning(true)
      return
    }
    setScanning(false)
    await generateOffer()
  }

  const offlineDisconnected = effectiveConn === 'failed' || effectiveConn === 'disconnected'

  return (
    <>
      <section className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>离线扫码配对</h2>
        {open && (
          <button onClick={reset} style={{ padding: '4px 12px', fontSize: 12 }}>
            收起
          </button>
        )}
      </div>
      <p className="muted" style={{ fontSize: 12 }}>
        无信令服务时的配对，按设备分工：电脑端默认「显示配对码」（免摄像头），手机端默认「扫码」；
        手机↔手机仍是一台显示、一台扫码。数据仍是局域网 P2P 直连。
      </p>

      {/* T17 断线快捷重配：警告旁直接提供「重新配对」——面板收起（配对成功自动收起后断线）也可见；
          仅对用过离线配对的会话显示，纯在线用户不受打扰 */}
      {everOpened && offlineDisconnected && (
        <div
          className="row"
          style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginTop: 8 }}
        >
          <p className="bad" style={{ margin: 0, flex: 1 }}>{polish.disconnectedWarning}</p>
          <button
            onClick={() => void rePair()}
            style={{ padding: '6px 12px', fontSize: 12, whiteSpace: 'nowrap' }}
          >
            {polish.rePairLabel}
          </button>
        </div>
      )}

      {!open ? (
        <button
          onClick={() => {
            setEverOpened(true)
            setOpen(true)
          }}
        >
          离线扫码配对
        </button>
      ) : (
        <div style={{ marginTop: 8 }}>
          {msg && <p className="ok">{msg}</p>}
          {err && <p className="bad">{err}</p>}

          {phase === 'pick' && (
            <div>
              <p className="muted" style={{ fontSize: 12 }}>{guide.headline}</p>
              <ol style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 10px', paddingLeft: 18 }}>
                {guide.steps.map((s, i) => (
                  <li key={i} style={{ margin: '2px 0' }}>
                    {s}
                  </li>
                ))}
              </ol>
              <div className="row">
                <button
                  onClick={() => void generateOffer()}
                  style={primary === 'scan' ? { order: 2 } : undefined}
                >
                  {buttonLabels.offerLabel}
                </button>
                <button
                  onClick={() => {
                    setErr('')
                    setMsg('')
                    setPhase('scan-wait')
                    setScanning(true)
                  }}
                  style={primary === 'offer' ? { order: 2 } : undefined}
                >
                  {buttonLabels.scanLabel}
                </button>
              </div>
              <p className="muted" style={{ fontSize: 11 }}>{guide.note}</p>
            </div>
          )}

          {phase === 'offer-show' && (
            <>
              <p className="muted">发送端配对码（对方扫码，或手动发送文本）：</p>
              {/* T17 桌面端：重新生成收进角落（二维码上方的次级入口，不喧宾夺主） */}
              {kind === 'desktop' && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
                  <button
                    onClick={() => void generateOffer()}
                    style={{ padding: '2px 10px', fontSize: 11, opacity: 0.55 }}
                  >
                    {polish.regenerateLabel}
                  </button>
                </div>
              )}
              <div style={{ textAlign: 'center' }}>
                <QrZoomButton onClick={() => setQrFullscreen(true)}>
                  <canvas
                    ref={canvasRef}
                    style={{ maxWidth: 260, width: '100%', background: '#fff', borderRadius: 8, padding: 4 }}
                  />
                </QrZoomButton>
              </div>
              {kind === 'desktop' ? (
                /* T17 桌面端主次重排：粘贴为唯一主操作（视觉突出），扫码折叠为次要入口 */
                <>
                  <div className="row" style={{ marginTop: 8, justifyContent: 'center' }}>
                    <button
                      onClick={() => void copyText(offerText)}
                      style={{ padding: '6px 12px', fontSize: 12, opacity: 0.75 }}
                    >
                      {polish.copyCodeLabel}
                    </button>
                    {copyMsg && <span className="ok" style={{ fontSize: 12 }}>{copyMsg}</span>}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <p className="muted" style={{ fontSize: 12 }}>{polish.desktopPasteTitle}</p>
                    <PasteBox
                      value={pasteInput}
                      onChange={setPasteInput}
                      onSubmit={() => void applyPaste()}
                      highlight
                    />
                  </div>
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                      {polish.desktopScanSummary}
                    </summary>
                    {scanning ? (
                      <>
                        <ScannerVideo videoRef={videoRef} />
                        <button
                          onClick={() => setScanning(false)}
                          style={{ padding: '6px 12px', fontSize: 12, marginTop: 6 }}
                        >
                          {polish.stopScanLabel}
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => {
                          setErr('')
                          setScanning(true)
                        }}
                        style={{ padding: '6px 12px', fontSize: 12, marginTop: 6 }}
                      >
                        {polish.scanAnswerLabel}
                      </button>
                    )}
                  </details>
                </>
              ) : (
                /* 手机端保持现状主操作：扫码在按钮区（手机↔手机仍以扫码为便），不受桌面重排影响 */
                <>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      onClick={() => void generateOffer()}
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      {polish.regenerateLabel}
                    </button>
                    <button
                      onClick={() => {
                        if (!scanning) {
                          setErr('')
                          setScanning(true)
                        } else setScanning(false)
                      }}
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      {scanning ? polish.stopScanLabel : polish.scanAnswerLabel}
                    </button>
                    <button
                      onClick={() => void copyText(offerText)}
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      {polish.copyCodeLabel}
                    </button>
                    {copyMsg && <span className="ok" style={{ fontSize: 12 }}>{copyMsg}</span>}
                  </div>
                  {scanning && <ScannerVideo videoRef={videoRef} />}
                  <details style={{ marginTop: 8 }}>
                    <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                      {polish.mobilePasteSummary}
                    </summary>
                    <PasteBox value={pasteInput} onChange={setPasteInput} onSubmit={() => void applyPaste()} />
                  </details>
                </>
              )}
            </>
          )}

          {phase === 'scan-wait' && (
            <>
              <p className="muted">扫描发送端的配对码（或粘贴其文本）；扫到 offer 码会自动进入接收流程：</p>
              <p className="muted" style={{ fontSize: 12 }}>
                提示：把二维码完整放入取景框，码的边缘留出边距，不要贴太近。
              </p>
              {scanning && <ScannerVideo videoRef={videoRef} />}
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    if (!scanning) {
                      setErr('')
                      setScanning(true)
                    } else setScanning(false)
                  }}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  {scanning ? polish.stopScanLabel : polish.startScanLabel}
                </button>
                {!scanning && (
                  <button
                    onClick={() => {
                      setErr('')
                      setPhase('pick')
                    }}
                    style={{ padding: '6px 12px', fontSize: 12 }}
                  >
                    返回
                  </button>
                )}
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                  {polish.scanWaitPasteSummary}
                </summary>
                <PasteBox value={pasteInput} onChange={setPasteInput} onSubmit={() => void applyPaste()} />
              </details>
            </>
          )}

          {phase === 'answer-show' && (
            <>
              <p className="muted">接收端回码（请发送端扫描，或把文本发给对方粘贴）：</p>
              <div style={{ textAlign: 'center' }}>
                <QrZoomButton onClick={() => setQrFullscreen(true)}>
                  <canvas
                    ref={canvasRef}
                    style={{
                      /* T16：回码放大至可用屏宽（min(80vw,360px)），offer 端回扫/回拍更容易扫中 */
                      maxWidth: answerQrMaxWidth(),
                      width: '100%',
                      background: '#fff',
                      borderRadius: 8,
                      padding: 4,
                    }}
                  />
                </QrZoomButton>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  onClick={() => {
                    setErr('')
                    setMsg('')
                    setPhase('scan-wait')
                    setScanning(true)
                  }}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  重扫/重粘发送端配对码
                </button>
                <button
                  onClick={() => void shareAnswer()}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  {polish.shareAnswerLabel}
                </button>
                <button
                  onClick={() => void copyText(answerText)}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  {polish.copyCodeLabel}
                </button>
                {copyMsg && <span className="ok" style={{ fontSize: 12 }}>{copyMsg}</span>}
              </div>
            </>
          )}

          {phase === 'done' && <p className="muted">等待数据通道建立…（连接后自动进入传输界面）</p>}
        </div>
      )}
      </section>

      {/* T21 全屏放大二维码：点码外空白处 / Esc 关闭；点码本身不关闭 */}
      {qrFullscreen && (
        <div
          onClick={() => setQrFullscreen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="放大二维码，点击空白处或按 Esc 关闭"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'rgba(0, 0, 0, 0.85)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'zoom-out',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 12, padding: 12, cursor: 'default' }}
          >
            <canvas
              ref={fullscreenCanvasRef}
              style={{
                display: 'block',
                width: 'min(88vw, 82vh)',
                height: 'min(88vw, 82vh)',
              }}
            />
          </div>
          <span className="muted" style={{ position: 'absolute', bottom: 28, fontSize: 12 }}>
            点击空白处关闭（或按 Esc）
          </span>
        </div>
      )}
    </>
  )
}

/** 相位 → 扫码路由相位：发送端展示 offer 后扫回码用 offer-show，其余扫码均为 scan-wait */
function scanPhaseOf(phase: Phase): ScanPhase {
  return phase === 'offer-show' ? 'offer-show' : 'scan-wait'
}

/** 手动粘贴输入框 + 应用按钮（offer-show / scan-wait 复用）；highlight 用于桌面主操作（T17 视觉突出） */
function PasteBox({
  value,
  onChange,
  onSubmit,
  highlight = false,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  highlight?: boolean
}) {
  return (
    <div className="row" style={{ marginTop: 6 }}>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="粘贴或输入配对码文本"
        rows={3}
        style={{
          flex: 1,
          background: '#0d0f13',
          color: 'var(--text)',
          border: highlight ? '1.5px solid var(--accent)' : '1px solid var(--line)',
          borderRadius: 8,
          padding: highlight ? 10 : 8,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 11,
        }}
      />
      <button onClick={onSubmit} style={{ padding: highlight ? '10px 16px' : '6px 12px', fontSize: 12 }}>
        应用
      </button>
    </div>
  )
}

/** 扫码取景（offer-show / scan-wait 复用；ref 由父级提供，摄像头生命周期在 OfflinePair） */
function ScannerVideo({ videoRef }: { videoRef: RefObject<HTMLVideoElement | null> }) {
  return (
    <video
      ref={videoRef}
      playsInline
      muted
      style={{ width: '100%', maxWidth: 320, borderRadius: 8, background: '#000', marginTop: 6 }}
    />
  )
}

/**
 * T21 二维码放大按钮——包裹二维码 canvas，点击弹全屏大码。
 * 真实 button + aria-label：可键盘/读屏到达（裸 canvas 不可聚焦）。
 */
function QrZoomButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="点击放大查看二维码"
      title="点击放大查看二维码"
      style={{
        display: 'block',
        margin: '0 auto',
        padding: 0,
        border: 'none',
        background: 'transparent',
        cursor: 'zoom-in',
        lineHeight: 0,
      }}
    >
      {children}
    </button>
  )
}

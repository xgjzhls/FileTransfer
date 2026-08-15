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
 */

import { useEffect, useRef, useState } from 'react'
import { decodeQrText, encodeQrText } from '../qr/qrCodec'
import { renderQrToCanvas } from '../qr/qrRender'
import { startQrScanner } from '../qr/qrScan'
import type { QrScannerHandle } from '../qr/qrScan'
import { routeScannedCode } from '../qr/scanRoute'
import type { ScanPhase } from '../qr/scanRoute'
import { cameraErrorText } from '../qr/scanErrors'
import type { ConnectionManager } from '../webrtc/connection'
import type { SignalPayload } from '../protocol/signaling'

type Phase = 'pick' | 'offer-show' | 'scan-wait' | 'answer-show' | 'done'

interface OfflinePairProps {
  /** 获取（惰性创建）共享 ConnectionManager；数据面事件已由 Home 接线 */
  manager: () => ConnectionManager
  /** 当前连接状态（Home 的 connState；配对成功自动收起面板） */
  connState: string
}

export default function OfflinePair({ manager, connState }: OfflinePairProps) {
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('pick')
  const [offerText, setOfferText] = useState('')
  const [answerText, setAnswerText] = useState('')
  const [pasteInput, setPasteInput] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [copyMsg, setCopyMsg] = useState('')
  const [scanning, setScanning] = useState(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
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

  // e2e 测试钩子（仅 DEV）：读取本端生成的 offer / answer 文本
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const hook = {
      getOfferText: () => offerTextRef.current,
      getAnswerText: () => answerTextRef.current,
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

  // 配对成功（连接已建立，且本次连接由 QR 流程推进）→ 明确反馈 + 短暂提示后自动收起。
  // pairedRef 门控：面板开着但连接来自在线 WS（点选设备）时不误报、不误收起。
  useEffect(() => {
    if (connState !== 'connected' || !pairedRef.current) return
    if (phase === 'offer-show' || phase === 'answer-show' || phase === 'done') {
      setErr('')
      setMsg('配对成功，正在建立连接…')
      const t = setTimeout(() => {
        reset()
        setOpen(false)
      }, 1500)
      return () => clearTimeout(t)
    }
  }, [connState, phase])

  // 面板收起时确保停掉摄像头
  useEffect(() => {
    if (!open) setScanning(false)
  }, [open])

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
      setMsg('让接收端扫描此码；扫码后把对方的回码给我（扫码或粘贴）。')
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
    setMsg('配对码已识别：请让发送端扫描下方二维码（或粘贴其文本）。')
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

  const offlineDisconnected = connState === 'failed' || connState === 'disconnected'

  return (
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
        无信令服务时的配对：发送端先显示配对码 → 接收端直接扫码（自动判定角色）→ 接收端显示回码 → 发送端扫码。数据仍是局域网 P2P 直连。
      </p>

      {!open ? (
        <button onClick={() => setOpen(true)}>离线扫码配对</button>
      ) : (
        <div style={{ marginTop: 8 }}>
          {offlineDisconnected && (
            <p className="bad">
              ⚠ 连接已断开：重新配对后自动续传（只补缺失部分，不重传已收数据）。
            </p>
          )}
          {msg && <p className="ok">{msg}</p>}
          {err && <p className="bad">{err}</p>}

          {phase === 'pick' && (
            <div className="row">
              <button onClick={() => void generateOffer()}>我是发送端（显示配对码）</button>
              <button
                onClick={() => {
                  setErr('')
                  setMsg('')
                  setPhase('scan-wait')
                  setScanning(true)
                }}
              >
                扫码配对
              </button>
            </div>
          )}

          {phase === 'offer-show' && (
            <>
              <p className="muted">发送端配对码（对方扫码，或手动发送文本）：</p>
              <div style={{ textAlign: 'center' }}>
                <canvas
                  ref={canvasRef}
                  style={{ maxWidth: 260, width: '100%', background: '#fff', borderRadius: 8, padding: 4 }}
                />
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <button
                  onClick={() => void generateOffer()}
                  style={{ padding: '6px 12px', fontSize: 12 }}
                >
                  重新生成
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
                  {scanning ? '停止扫码' : '扫码对方的回码'}
                </button>
                <button onClick={() => void copyText(offerText)} style={{ padding: '6px 12px', fontSize: 12 }}>
                  复制配对码
                </button>
                {copyMsg && <span className="ok" style={{ fontSize: 12 }}>{copyMsg}</span>}
              </div>
              <details style={{ marginTop: 8 }}>
                <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>
                  没有摄像头？手动粘贴接收端的配对码
                </summary>
                <PasteBox value={pasteInput} onChange={setPasteInput} onSubmit={() => void applyPaste()} />
              </details>
            </>
          )}

          {phase === 'scan-wait' && (
            <>
              <p className="muted">扫描发送端的配对码（或粘贴其文本）；扫到 offer 码会自动进入接收流程：</p>
              {scanning && (
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  style={{ width: '100%', maxWidth: 320, borderRadius: 8, background: '#000' }}
                />
              )}
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
                  {scanning ? '停止扫码' : '开始扫码'}
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
                  没有摄像头？手动粘贴发送端的配对码
                </summary>
                <PasteBox value={pasteInput} onChange={setPasteInput} onSubmit={() => void applyPaste()} />
              </details>
            </>
          )}

          {phase === 'answer-show' && (
            <>
              <p className="muted">接收端回码（请发送端扫描，或把文本发给对方粘贴）：</p>
              <div style={{ textAlign: 'center' }}>
                <canvas
                  ref={canvasRef}
                  style={{ maxWidth: 260, width: '100%', background: '#fff', borderRadius: 8, padding: 4 }}
                />
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
                <button onClick={() => void copyText(answerText)} style={{ padding: '6px 12px', fontSize: 12 }}>
                  复制配对码
                </button>
                {copyMsg && <span className="ok" style={{ fontSize: 12 }}>{copyMsg}</span>}
              </div>
            </>
          )}

          {phase === 'done' && <p className="muted">等待数据通道建立…（连接后自动进入传输界面）</p>}
        </div>
      )}
    </section>
  )
}

/** 相位 → 扫码路由相位：发送端展示 offer 后扫回码用 offer-show，其余扫码均为 scan-wait */
function scanPhaseOf(phase: Phase): ScanPhase {
  return phase === 'offer-show' ? 'offer-show' : 'scan-wait'
}

/** 手动粘贴输入框 + 应用按钮（offer-show / scan-wait 复用） */
function PasteBox({
  value,
  onChange,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
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
          border: '1px solid var(--line)',
          borderRadius: 8,
          padding: 8,
          fontFamily: 'ui-monospace, Menlo, monospace',
          fontSize: 11,
        }}
      />
      <button onClick={onSubmit} style={{ padding: '6px 12px', fontSize: 12 }}>
        应用
      </button>
    </div>
  )
}

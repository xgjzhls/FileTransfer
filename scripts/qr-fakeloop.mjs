#!/usr/bin/env node
/**
 * T15 回归回路：真实应用 + 伪造摄像头（y4m）驱动完整扫码管线。
 *
 * 背景（T15）：qr-scanner 默认只解码视频中心 2/3 —— 二维码一旦大于该区域
 * （用户把码充满取景框），裁剪区里只剩码的中间、三个定位角被裁掉，任何引擎
 * 都无法识别，症状即「码在框内但永不识别、一直停在摄像状态」。
 * 修复：自定义 calculateScanRegion 扩到中心 95% + 可见取景框 + 提示文案。
 *
 * 本脚本复现手机的真实路径：摄像头画面（y4m 里的二维码）→ qr-scanner 裁剪
 * → 引擎解码 → onDecode。通过 = 扫码页在超时内自动生成 answer。
 *
 * 用法：node scripts/qr-fakeloop.mjs [scale]   （scale：码占帧高百分比，默认 92）
 *   修复前：66% 内可解、>66% 失败；修复后：≤92% 应全部在 ~15ms 内解码。
 * 退出码 0 通过 / 1 失败。
 */
import { chromium } from 'playwright'
import { spawn } from 'child_process'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import QRCode from 'qrcode'

const SCALE = Number(process.argv[2] ?? 92)
const PORT = process.env.LOOP_PORT ?? '5180'
const BASE = `http://localhost:${PORT}`
const VW = 640
const VH = 720
const FRAMES = 150 // 5s @ 30fps
const TIMEOUT_MS = 30000

const LAUNCH_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
  '--allow-loopback-ice',
  '--use-fake-device-for-media-stream',
]

/** QR 矩阵 → I420 y4m（白底黑块，模拟手机拍到的另一块屏幕） */
function renderI420(qr, vw, vh, scale) {
  const n = qr.modules.size
  const qrPx = Math.floor(Math.min(vw, vh) * scale / 100)
  const cell = Math.max(1, Math.floor(qrPx / n))
  const draw = Math.min(qrPx, cell * n)
  const ox = Math.floor((vw - draw) / 2)
  const oy = Math.floor((vh - draw) / 2)
  const Y = new Uint8Array(vw * vh).fill(255)
  const U = new Uint8Array((vw >> 1) * (vh >> 1)).fill(128)
  const V = new Uint8Array((vw >> 1) * (vh >> 1)).fill(128)
  const data = qr.modules.data
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!data[row * n + col]) continue
      const x0 = ox + col * cell
      const y0 = oy + row * cell
      for (let dy = 0; dy < cell; dy++) {
        const yy = y0 + dy
        if (yy >= vh) continue
        for (let dx = 0; dx < cell; dx++) {
          const xx = x0 + dx
          if (xx >= vw) continue
          Y[yy * vw + xx] = 0
        }
      }
    }
  }
  const frame = Buffer.alloc(vw * vh + (vw >> 1) * (vh >> 1) * 2)
  frame.set(Buffer.from(Y), 0)
  frame.set(Buffer.from(U), vw * vh)
  frame.set(Buffer.from(V), vw * vh + (vw >> 1) * (vh >> 1))
  return frame
}

async function genY4m(text, outPath) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L', margin: 1 })
  const frame = renderI420(qr, VW, VH, SCALE)
  let buf = Buffer.from(`YUV4MPEG2 W${VW} H${VH} F30:1 Ip A1:1 C420mpeg2\n`)
  for (let i = 0; i < FRAMES; i++) buf = Buffer.concat([buf, Buffer.from('FRAME\n'), frame])
  writeFileSync(outPath, buf)
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try { const r = await fetch(url); if (r.ok) return resolve() } catch { /* retry */ }
      if (Date.now() - start > timeoutMs) return reject(new Error('dev server 未就绪'))
      setTimeout(poll, 250)
    }
    poll()
  })
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'qr-loop-'))
  const y4mPath = join(dir, 'qr.y4m')

  let dev = null
  try {
    const r = await fetch(BASE)
    if (!r.ok) throw new Error('port up but bad response')
    console.log('[qr-loop] 复用已运行的 dev server')
  } catch {
    dev = spawn('npx', ['vite', '--port', PORT, '--strictPort'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForServer(BASE, 60000)
  }

  try {
    const browser = await chromium.launch({ channel: 'chromium', args: LAUNCH_ARGS })

    // 1) 生成真实 offer 码（真实 WebRTC SDP）
    const ctx1 = await browser.newContext({ permissions: ['camera'] })
    const pageA = await ctx1.newPage()
    await pageA.goto(BASE)
    await pageA.getByRole('button', { name: '离线扫码配对' }).click()
    await pageA.getByRole('button', { name: /显示配对码/ }).click()
    await pageA.waitForFunction(() => (window.__ltQr?.getOfferText().length ?? 0) > 0, null, { timeout: 30000 })
    const offerText = await pageA.evaluate(() => window.__ltQr.getOfferText())
    await ctx1.close()

    // 2) 把该二维码画成「手机拍到的屏幕画面」喂给伪造摄像头
    await genY4m(offerText, y4mPath)

    // 3) 扫码端完整走 startQrScanner → 解码 → 自动生成 answer
    const browser2 = await chromium.launch({
      channel: 'chromium',
      args: [...LAUNCH_ARGS, `--use-file-for-fake-video-capture=${y4mPath}`],
    })
    const ctx2 = await browser2.newContext({ permissions: ['camera'] })
    const pageB = await ctx2.newPage()
    await pageB.goto(BASE)
    await pageB.getByRole('button', { name: '离线扫码配对' }).click()
    await pageB.getByRole('button', { name: '扫码配对' }).click()
    const t0 = Date.now()
    const ok = await pageB
      .waitForFunction(() => (window.__ltQr?.getAnswerText().length ?? 0) > 0, null, { timeout: TIMEOUT_MS })
      .then(() => true)
      .catch(() => false)
    const elapsed = Date.now() - t0
    console.log(`[qr-loop] scale=${SCALE}% → ${ok ? '✅ 解码成功' : '❌ 超时未识别'}（${elapsed}ms）`)
    await browser.close()
    await browser2.close()
    process.exitCode = ok ? 0 : 1
  } catch (e) {
    console.error('[qr-loop] 失败:', e.message)
    process.exitCode = 1
  } finally {
    if (dev) dev.kill('SIGTERM')
  }
}

main()

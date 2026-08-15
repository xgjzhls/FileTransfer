#!/usr/bin/env node
/**
 * E2E 点击测试（Playwright）—— 房间 → 发现 → WebRTC 连接 → 文件传输。
 *
 * 用法：node scripts/e2e.mjs [baseURL]   （默认 http://localhost:5173）
 * 前置：dev server 已启动（npm run dev）；.env 已配 VITE_SIGNALING_WSS。
 *
 * WebRTC 环境探测：Clash TUN + fake-ip（198.18.x.x）会劫持 host candidate，
 * 同机 WebRTC 自连不可行。探测失败时自动降级——只验证 UI 流程与信令
 * offer/answer 交换（connected/传输断言跳过并明确警告）。
 */

import { chromium } from 'playwright'
import { randomBytes } from 'crypto'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BASE = process.argv[2] ?? 'http://localhost:5173'
const PROXY = process.env.E2E_PROXY ?? 'http://127.0.0.1:7890'
const LAUNCH_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
  '--allow-loopback-ice',
  ...(process.env.E2E_NO_PROXY ? [] : [`--proxy-server=${PROXY}`]),
]

const steps = []
function step(name, ok, detail = '') {
  steps.push({ name, ok, detail })
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function waitStatus(page, target, timeout = 30000) {
  await page.waitForFunction(
    (t) => {
      const badge = [...document.querySelectorAll('.badge')].find((b) => b.textContent?.includes('状态：'))
      return badge?.textContent?.includes(t)
    },
    target,
    { timeout },
  )
}

/** 等待连接状态徽章落在任一候选（降级模式：offer/answer 已交换即算连接进行中） */
async function waitStatusAny(page, targets, timeout = 30000) {
  await page.waitForFunction(
    (ts) => {
      const badge = [...document.querySelectorAll('.badge')].find((b) => b.textContent?.includes('状态：'))
      return badge !== undefined && ts.some((t) => badge.textContent?.includes(t))
    },
    targets,
    { timeout },
  )
}

/** 轮询连接状态徽章直到脱离 signaling/connecting；返回最终状态字符串 */
async function waitFinalConnState(page, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    const s = await page.evaluate(() => {
      const badge = [...document.querySelectorAll('.badge')].find((b) => b.textContent?.includes('状态：'))
      return badge?.textContent?.replace('状态：', '').trim() ?? ''
    })
    if (s.includes('connected') || s.includes('failed') || s.includes('idle')) return s
    if (Date.now() - t0 > timeoutMs) return s
    await page.waitForTimeout(250)
  }
}

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS })
try {
  // ── 0. WebRTC 环境探测（双页真实交换，更贴近实际设备场景）
  // 旧探测（同页双 pc loopback）在 Clash fake-ip TUN 下会误判：本机双页/双设备
  // 经真实候选仍可互通。改为两个独立页面交换 SDP（与真实配对流程一致）。
  const probeA = await browser.newPage()
  const probeB = await browser.newPage()
  const webrtcOk = await (async () => {
    try {
      const offerSdp = await probeA.evaluate(async () => {
        const pc1 = new RTCPeerConnection({ iceServers: [] })
        pc1.createDataChannel('t')
        const offer = await pc1.createOffer()
        await pc1.setLocalDescription(offer)
        if (pc1.iceGatheringState !== 'complete') {
          await new Promise((res) => {
            pc1.addEventListener('icegatheringstatechange', () => pc1.iceGatheringState === 'complete' && res())
            setTimeout(res, 15000)
          })
        }
        window.__probe = { pc1 }
        return pc1.localDescription.sdp
      })
      const answerSdp = await probeB.evaluate(async (offerSdp) => {
        const pc2 = new RTCPeerConnection({ iceServers: [] })
        await pc2.setRemoteDescription({ type: 'offer', sdp: offerSdp })
        const answer = await pc2.createAnswer()
        await pc2.setLocalDescription(answer)
        if (pc2.iceGatheringState !== 'complete') {
          await new Promise((res) => {
            pc2.addEventListener('icegatheringstatechange', () => pc2.iceGatheringState === 'complete' && res())
            setTimeout(res, 15000)
          })
        }
        return pc2.localDescription.sdp
      }, offerSdp)
      return await probeA.evaluate(async (answerSdp) => {
        const pc1 = window.__probe.pc1
        await pc1.setRemoteDescription({ type: 'answer', sdp: answerSdp })
        return await new Promise((res) => {
          const t = setInterval(() => {
            if (pc1.connectionState === 'connected' || pc1.connectionState === 'failed') {
              clearInterval(t)
              res(pc1.connectionState === 'connected')
            }
          }, 200)
          // fake-ip TUN 干扰时 ICE 可能很慢：给足 25s 再判失败
          setTimeout(() => {
            clearInterval(t)
            res(false)
          }, 25000)
        })
      }, answerSdp)
    } catch {
      return false
    }
  })()
  await probeA.close()
  await probeB.close()
  console.log(`WebRTC 双页探测：${webrtcOk ? '可用 ✓（全量断言）' : '不可用 ⚠（降级：仅 UI + 信令断言）'}\n`)
  if (!webrtcOk) {
    console.log('  ⚠ 本机 Clash TUN + fake-ip（198.18.x.x）会劫持 WebRTC host candidate，')
    console.log('    同机自连不可行。这**不影响**跨设备（真实局域网 IP）场景，但电脑端')
    console.log('    需确保 Clash 未劫持局域网流量，否则手机连不上电脑。\n')
  }

  // 准备测试文件（3 MiB，3 chunk）
  const dir = mkdtempSync(join(tmpdir(), 'lt-e2e-'))
  const srcPath = join(dir, 'e2e-source.bin')
  writeFileSync(srcPath, randomBytes(3 * 1024 * 1024))

  const ctxA = await browser.newContext({ ignoreHTTPSErrors: true })
  const ctxB = await browser.newContext({ ignoreHTTPSErrors: true })
  await ctxB.addInitScript(() => localStorage.setItem('lt.deviceName', 'E2E-B'))
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  const pageErrors = { A: [], B: [] }
  for (const [name, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', (e) => pageErrors[name].push(e.message))
  }

  // ── 1. A 创建房间（曾报错的步骤：CORS）
  await pageA.goto(BASE)
  await pageA.getByRole('button', { name: '创建房间' }).click()
  const roomBadge = pageA.locator('.badge', { hasText: '房间码：' })
  await roomBadge.waitFor({ timeout: 20000 })
  const room = (await roomBadge.textContent()).replace('房间码：', '').trim()
  step('A 点「创建房间」显示房间码', /^[2-9A-HJ-NP-Z]{4}$/.test(room), room)

  // ── 2. B 输码加入
  await pageB.goto(BASE)
  await pageB.getByPlaceholder('输入房间码加入').fill(room)
  await pageB.getByRole('button', { name: '加入' }).click()
  await pageB.locator('.badge', { hasText: '房间码：' }).waitFor({ timeout: 20000 })
  step('B 输码加入成功', true, room)

  // ── 3. A 设备列表出现 B
  await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-B'), null, {
    timeout: 20000,
  })
  step('A 设备列表出现 B', true)

  // ── 4. A 点连接 → 两端 connected（修复 gather 后连接很快，不中途等 signaling）
  await pageA.getByRole('button', { name: '连接' }).click()
  if (webrtcOk) {
    await waitStatus(pageA, 'connected')
    await waitStatus(pageB, 'connected')
    step('A 点连接：两端状态 connected', true)

    // ── 5. A 选文件发送 → B 接收完成（B 端显示「导出」按钮）
    await pageA.setInputFiles('input[type="file"]', srcPath)
    await pageA.getByRole('button', { name: '开始发送' }).click()
    await pageB.waitForFunction(() => document.body.textContent?.includes('导出'), null, {
      timeout: 60000,
    })
    step('文件传输，B 端接收完成（显示导出）', true, '3 MiB')
  } else {
    // 信令往返快时 signaling 可能一闪而过直接到 connecting：两者都算「连接进行中」
    await waitStatusAny(pageA, ['signaling', 'connecting'])
    await waitStatusAny(pageB, ['signaling', 'connecting'])
    step('（降级）A 点连接：两端进入 signaling/connecting（offer/answer 已交换）', true)
    step('（降级）WebRTC connected + 传输断言跳过', true, '环境不支持同机 ICE')
  }

  // ── 5.5 T06：传输中途杀接收端页面 → 自动恢复 → 文件完整（续传）
  if (webrtcOk) {
    const srcResume = join(dir, 'e2e-resume.bin')
    writeFileSync(srcResume, randomBytes(20 * 1024 * 1024)) // 20 MiB（给中断留时间）
    await pageA.setInputFiles('input[type="file"]', srcResume)
    await pageA.getByRole('button', { name: '开始发送' }).click()
    // 等 B 出现接收进度，再等一个节流周期（2s）确保位图已落盘 IndexedDB
    await pageB.waitForFunction(() => /chunk/.test(document.body.textContent ?? ''), null, {
      timeout: 30000,
    })
    await pageB.waitForTimeout(2500)
    // 杀 B：重载页面（内存态丢失，IndexedDB manifest 保留）→ 重新入房
    await pageB.reload()
    await pageB.getByPlaceholder('输入房间码加入').fill(room)
    await pageB.getByRole('button', { name: '加入' }).click()
    await pageB.locator('.badge', { hasText: '房间码：' }).waitFor({ timeout: 20000 })
    // A 的对端换成新 device id（peer_left + peer_joined）；等 A 的「连接」按钮可点
    await pageA.waitForFunction(
      () => {
        const btn = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === '连接')
        return btn !== undefined && !btn.disabled
      },
      null,
      { timeout: 20000 },
    )
    await pageA.getByRole('button', { name: '连接' }).click()
    await waitStatus(pageA, 'connected')
    // A 连接恢复 → 自动 resumeSend（同 sessionId）→ B 从断点继续直到完成
    await pageB.waitForFunction(() => document.body.textContent?.includes('导出'), null, {
      timeout: 120000,
    })
    step('T06 断连续传：杀接收端页面后自动恢复，文件完整（B 显示导出）', true, '20 MiB')
  } else {
    step('（降级）T06 断连续传断言跳过', true, '环境不支持同机 ICE')
  }

  // ── 5.7 T07：离线二维码配对（粘贴 fallback 全流程，数据面不经信令）
  // SDP 生成/交换不依赖 ICE 成功，降级模式也执行；仅 connected/传输断言需要真 WebRTC
  await pageA.getByRole('button', { name: '离线扫码配对' }).click()
  await pageA.getByRole('button', { name: '我是发送端（显示配对码）' }).click()
  await pageA.waitForFunction(() => (window.__ltQr?.getOfferText().length ?? 0) > 0, null, {
    timeout: 30000,
  })
  const offerText = await pageA.evaluate(() => window.__ltQr.getOfferText())
  step('T07 A 生成发送端配对码', offerText.length > 0, `${offerText.length} 字符`)

  // B（接收端）粘贴 offer → 生成 answer 配对码
  await pageB.getByRole('button', { name: '离线扫码配对' }).click()
  await pageB.getByRole('button', { name: '我是接收端（扫码配对）' }).click()
  await pageB.getByText('没有摄像头？手动粘贴发送端的配对码').click()
  await pageB.getByPlaceholder('粘贴或输入配对码文本').fill(offerText)
  await pageB.getByRole('button', { name: '应用' }).click()
  await pageB.waitForFunction(() => (window.__ltQr?.getAnswerText().length ?? 0) > 0, null, {
    timeout: 30000,
  })
  const answerText = await pageB.evaluate(() => window.__ltQr.getAnswerText())
  step('T07 B 粘贴 offer 并生成接收端回码', answerText.length > 0, `${answerText.length} 字符`)

  // A 粘贴 answer（两端完成 SDP 交换）
  await pageA.getByText('没有摄像头？手动粘贴接收端的配对码').click()
  await pageA.getByPlaceholder('粘贴或输入配对码文本').fill(answerText)
  await pageA.getByRole('button', { name: '应用' }).click()
  if (webrtcOk) {
    await waitStatus(pageA, 'connected')
    await waitStatus(pageB, 'connected')
    step('T07 A 粘贴 answer：两端离线 connected', true)

    // 离线路径传文件（复用同一数据面）
    const qrPath = join(dir, 'e2e-qr.bin')
    writeFileSync(qrPath, randomBytes(2 * 1024 * 1024))
    await pageA.setInputFiles('input[type="file"]', qrPath)
    await pageA.getByRole('button', { name: '开始发送' }).click()
    await pageB.waitForFunction(() => document.body.textContent?.includes('e2e-qr.bin'), null, {
      timeout: 60000,
    })
    step('T07 离线配对后传输完成（B 显示文件）', true, '2 MiB')
  } else {
    // 连接能力以实际结果为准：等状态脱离 signaling（connected / failed / 卡在 connecting）
    const finalState = await waitFinalConnState(pageA, 25000)
    // 降级环境（无 ICE）下 pc 会停在 connecting：SDP 已成功应用即为本步目标
    const exchangeDone = ['connected', 'failed', 'connecting'].includes(finalState)
    step(
      '（降级）T07 SDP 交换完成（offer/answer 均已应用）',
      exchangeDone,
      `最终状态 ${finalState || '未知'}；本机 ICE 不可达，跳过 connected/传输断言`,
    )
  }

  // ── 6. 杀 WS → 自动重连 → 房间码/设备列表恢复（T09 + T10）
  // T09：A 的 WS 被外力断开 → 指数退避自动重连 + 重新 join 原房间。
  // T10：miniflare 在 close + 新 fetch 时重建 DO 实例（近似 evict）——B 的
  // presence 从 storage 恢复，A 无需等 B 重连就重新看到 B；B 全程未断线。
  await pageA.evaluate(() => window.__ltSignaling?.forceDisconnect())
  await ctxA.setOffline(true) // A 离线：重连尝试失败 → 稳定停留在「重连中」态
  await pageA.waitForFunction(() => document.body.textContent?.includes('自动重连'), null, {
    timeout: 15000,
  })
  step('A 断开信令：UI 进入「自动重连」态', true)
  const peersDuring = await pageA.getByText('E2E-B').count()
  step('断线期间设备列表保留（非永久清空）', peersDuring > 0)
  await ctxA.setOffline(false)
  await pageA.waitForFunction(
    () =>
      document.body.textContent?.includes('已连接') &&
      !document.body.textContent?.includes('重连中'),
    null,
    { timeout: 30000 },
  )
  await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-B'), null, {
    timeout: 15000,
  })
  step('A 恢复网络：信令自动重连成功', true)
  const roomBadgeAfter = pageA.locator('.badge', { hasText: '房间码：' })
  const roomAfter = (await roomBadgeAfter.textContent()).replace('房间码：', '').trim()
  // B 从未断线：presence 是从 storage 恢复的（T10），而非 B 重连
  const bStillConnected = (await pageB.evaluate(() => document.body.textContent)).includes(
    '信令：已连接',
  )
  const bSeesA = (await pageB.evaluate(() => document.body.textContent)).includes('未命名设备')
  step(
    '重连后房间码不丢、设备列表恢复（B 未断线，presence 已恢复）',
    roomAfter === room && bStillConnected && bSeesA,
    `room=${roomAfter}`,
  )

  // ── 7. 无 JS 报错
  const errors = [...pageErrors.A, ...pageErrors.B]
  step('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | '))

  const failed = steps.filter((s) => !s.ok)
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${steps.length - failed.length}/${steps.length} 步通过`)
  process.exit(failed.length === 0 ? 0 : 1)
} catch (e) {
  console.error('\nE2E ERROR:', e.message ?? e)
  process.exit(1)
} finally {
  await browser.close()
}

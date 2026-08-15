#!/usr/bin/env node
/**
 * E2E 点击测试（Playwright）—— PIN 房间 → 发现 → WebRTC 连接 → 文件传输。
 *
 * 用法：node scripts/e2e.mjs [baseURL]   （默认 http://localhost:5173）
 * 前置：dev server 已启动（npm run dev）；.env 已配 VITE_SIGNALING_WSS。
 *
 * 覆盖：T11 对称 PIN（随机生成 / 输码即加入 / 双页互见 / 点选连接）、
 * T12 记住房间（重载自动回房 / 身份稳定 / 新会话自动回房）、T06 续传、
 * T13 离线扫码（免选角色直接扫码）、T09/T10 断线重连 + presence 恢复。
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

/** 读取页面「房间码：X」徽章；不存在返回 '' */
async function readRoomBadge(page) {
  const badge = page.locator('.badge', { hasText: '房间码：' })
  if ((await badge.count()) === 0) return ''
  return (await badge.textContent()).replace('房间码：', '').trim()
}

/** 输入 4 位 PIN：fill 触发 input 事件 → 输满 4 位自动加入（T11 输即加入） */
async function joinRoomByPin(page, code) {
  await page.getByPlaceholder('输入 4 位房间码（PIN）').fill(code)
  await page.locator('.badge', { hasText: '房间码：' }).waitFor({ timeout: 20000 })
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

  // ── 1. T11 A 随机生成房间码（POST /api/room → 填入输入框 → 自动加入）
  await pageA.goto(BASE)
  await pageA.getByRole('button', { name: '随机生成' }).click()
  await pageA.locator('.badge', { hasText: '房间码：' }).waitFor({ timeout: 20000 })
  const room = await readRoomBadge(pageA)
  step('T11 A 随机生成房间码并自动加入', /^[2-9A-HJ-NP-Z]{4}$/.test(room), room)

  // ── 2. T11 B 输同码 → 输满 4 位自动建房/加入（对称 PIN，无「创建/加入」之分）
  await pageB.goto(BASE)
  await joinRoomByPin(pageB, room)
  const roomB = await readRoomBadge(pageB)
  step('T11 B 输码即加入（无需先创建/选择角色）', roomB === room, roomB)

  // ── 3. T11 A 设备列表出现 B（同码互见）
  await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-B'), null, {
    timeout: 20000,
  })
  step('T11 双页输入同码：A 设备列表出现 B', true)

  // ── 4. T11 A 点连接 → 两端 connected（修复 gather 后连接很快，不中途等 signaling）
  await pageA.getByRole('button', { name: '连接' }).click()
  if (webrtcOk) {
    await waitStatus(pageA, 'connected')
    await waitStatus(pageB, 'connected')
    step('T11 A 点连接：两端状态 connected', true)

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
    step('（降级）T11 A 点连接：两端进入 signaling/connecting（offer/answer 已交换）', true)
    step('（降级）WebRTC connected + 传输断言跳过', true, '环境不支持同机 ICE')
  }

  // ── 5.5+5.6 T06/T12：断连续传 + 重载自动回房 + 身份稳定
  // T12 断言（自动回房/身份稳定/新会话回房）不依赖 WebRTC，始终执行；
  // T06 断连续传仅在 WebRTC 可用时执行（接收端重载即上文这次 reload）
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
  }

  // T12：重载 → 自动 join 上次房间（lt.lastRoom），无需手动输码
  await pageB.reload()
  const roomBAfterReload = await readRoomBadge(pageB)
  step('T12 B 重载后自动回房（无需手动输入）', roomBAfterReload === room, roomBAfterReload)
  // 同一 deviceId（lt.deviceId）重连：A 设备列表仅一条 E2E-B（无幽灵重复条目）
  await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-B'), null, {
    timeout: 20000,
  })
  await pageA.waitForTimeout(800) // 等 peer_joined/peer_left 全部落定
  const bEntries = await pageA.evaluate(() => {
    return [...document.querySelectorAll('li')].filter((li) => li.textContent?.includes('E2E-B')).length
  })
  step('T12 身份稳定：A 设备列表仅一条 E2E-B（无幽灵广播）', bEntries === 1, `条目数=${bEntries}`)
  // 新会话（新 context，preload lt.lastRoom）重开应用 → 自动回房（「重开零操作」）
  const ctxC = await browser.newContext({ ignoreHTTPSErrors: true })
  await ctxC.addInitScript(
    (lastRoom) => {
      localStorage.setItem('lt.lastRoom', lastRoom)
      localStorage.setItem('lt.deviceName', 'E2E-C')
    },
    room,
  )
  const pageC = await ctxC.newPage()
  await pageC.goto(BASE)
  const roomC = await readRoomBadge(pageC)
  step('T12 新会话（重开应用）自动回房', roomC === room, roomC)
  await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-C'), null, {
    timeout: 20000,
  })
  step('T12 自动回房后设备列表恢复（A 看到 E2E-C）', true)
  await pageC.close()
  await ctxC.close()

  // T12 设置页「退出房间」入口（SPEC §6.7）：清 lt.lastRoom → 回首页不再自动回房
  await pageA.getByRole('link', { name: '设置' }).click()
  await pageA.getByText('当前房间：').waitFor({ timeout: 10000 })
  const roomCardText = (await pageA.locator('.card').filter({ hasText: '当前房间：' }).textContent()) ?? ''
  step('T12 设置页显示当前房间', roomCardText.includes(room), room)
  await pageA.getByRole('button', { name: '退出房间' }).click()
  await pageA.getByText('未记住房间').waitFor({ timeout: 10000 })
  step('T12 设置页「退出房间」清除记住的房间', true)
  await pageA.getByRole('link', { name: '首页' }).click()
  await pageA.getByPlaceholder('输入 4 位房间码（PIN）').waitFor({ timeout: 10000 })
  const roomBadgeAfterExit = await pageA.locator('.badge', { hasText: '房间码：' }).count()
  step('T12 退出房间后回首页不自动回房（回到 PIN 输入）', roomBadgeAfterExit === 0)
  // 重新加入 QVZB（后续 T13 离线配对 / T09 断线重连依赖 A 在房间）
  await joinRoomByPin(pageA, room)

  if (webrtcOk) {
    // T06：A 的对端同 id 重连后等「连接」按钮可点，重新连接 → 自动续传
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

  // ── 5.7 T13/T14：离线二维码配对（免选角色 + 设备分工：电脑出码、手机扫码）
  // SDP 生成/交换不依赖 ICE 成功，降级模式也执行；仅 connected/传输断言需要真 WebRTC
  await pageA.getByRole('button', { name: '离线扫码配对' }).click()
  // A（桌面 UA）默认主路径即「显示配对码（免摄像头）」——直接点主按钮
  await pageA.getByRole('button', { name: /显示配对码/ }).click()
  await pageA.waitForFunction(() => (window.__ltQr?.getOfferText().length ?? 0) > 0, null, {
    timeout: 30000,
  })
  const offerText = await pageA.evaluate(() => window.__ltQr.getOfferText())
  step('T14 A 电脑端显示配对码', offerText.length > 0, `${offerText.length} 字符`)

  // B（接收端）：桌面次要路径「扫码配对」→ 粘贴 offer → 自动进入 answer 流程
  await pageB.getByRole('button', { name: '离线扫码配对' }).click()
  await pageB.getByRole('button', { name: '扫码配对' }).click()
  await pageB.getByText('没有摄像头？手动粘贴发送端的配对码').click()
  await pageB.getByPlaceholder('粘贴或输入配对码文本').fill(offerText)
  await pageB.getByRole('button', { name: '应用' }).click()
  await pageB.waitForFunction(() => (window.__ltQr?.getAnswerText().length ?? 0) > 0, null, {
    timeout: 30000,
  })
  const answerText = await pageB.evaluate(() => window.__ltQr.getAnswerText())
  step('T13 接收端免选角色直接扫码：识别 offer 自动生成回码', answerText.length > 0, `${answerText.length} 字符`)

  // T16 回码全屏 + 一键分享：answer 端二维码放大至 min(80vw,360px)、新增「分享回码」按钮
  const shareBtnCount = await pageB.getByRole('button', { name: '分享回码' }).count()
  const answerCanvas = await pageB.evaluate(() => {
    const c = document.querySelector('canvas')
    if (!c) return null
    return {
      cssMaxWidth: c.style.maxWidth,
      computedMaxWidth: getComputedStyle(c).maxWidth, // min() 由浏览器解析成像素
      boxWidth: c.getBoundingClientRect().width, // 含 padding 的实际渲染宽
    }
  })
  step(
    'T16 回码全屏 + 分享回码按钮（answer 端）',
    shareBtnCount === 1 &&
      answerCanvas !== null &&
      answerCanvas.cssMaxWidth === 'min(80vw, 360px)' &&
      parseFloat(answerCanvas.computedMaxWidth) >= 320 && // 桌面视口下 min() 解析为 360px
      answerCanvas.boxWidth > 260, // 比旧 260px 上限明显放大（可完整扫描）
    answerCanvas
      ? `渲染宽 ${answerCanvas.boxWidth.toFixed(0)}px（computed ${answerCanvas.computedMaxWidth}）`
      : '无 canvas',
  )

  // T21 点击二维码放大全屏：点码 → 遮罩 + 超大码出现；点空白处关闭（answer 端验证，offer 端同组件同路径）
  await pageB.getByRole('button', { name: '点击放大查看二维码' }).click()
  const qrFull = await pageB.evaluate(() => {
    const fc = document.querySelector('[role="dialog"] canvas')
    const dialog = document.querySelector('[role="dialog"]')
    if (!dialog || !fc) return null
    const r = fc.getBoundingClientRect()
    return { dialogVisible: true, w: r.width, h: r.height }
  })
  step(
    'T21 点击二维码放大全屏',
    qrFull !== null && qrFull.dialogVisible && qrFull.w >= 300 && qrFull.h >= 300,
    qrFull ? `全屏码 ${qrFull.w.toFixed(0)}×${qrFull.h.toFixed(0)}px` : '无全屏遮罩',
  )
  await pageB.mouse.click(10, 10) // 左上角空白处：点周围空白关闭
  const closedAfterBlank = (await pageB.getByRole('dialog').count()) === 0
  step('T21 点空白处关闭全屏', closedAfterBlank, closedAfterBlank ? '遮罩已移除' : '遮罩仍存在')

  // A 粘贴 answer（T14 电脑端回码粘贴框常驻，无需展开 details；两端完成 SDP 交换）
  await pageA.getByPlaceholder('粘贴或输入配对码文本').fill(answerText)
  await pageA.getByRole('button', { name: '应用' }).click()
  if (webrtcOk) {
    await waitStatus(pageA, 'connected')
    await waitStatus(pageB, 'connected')
    step('T13 A 粘贴 answer：两端离线 connected', true)

    // 离线路径传文件（复用同一数据面）
    const qrPath = join(dir, 'e2e-qr.bin')
    writeFileSync(qrPath, randomBytes(2 * 1024 * 1024))
    await pageA.setInputFiles('input[type="file"]', qrPath)
    await pageA.getByRole('button', { name: '开始发送' }).click()
    await pageB.waitForFunction(() => document.body.textContent?.includes('e2e-qr.bin'), null, {
      timeout: 60000,
    })
    step('T13 离线配对后传输完成（B 显示文件）', true, '2 MiB')
  } else {
    // 连接能力以实际结果为准：等状态脱离 signaling（connected / failed / 卡在 connecting）
    const finalState = await waitFinalConnState(pageA, 25000)
    // 降级环境（无 ICE）下 pc 会停在 connecting：SDP 已成功应用即为本步目标
    const exchangeDone = ['connected', 'failed', 'connecting'].includes(finalState)
    step(
      '（降级）T13 SDP 交换完成（offer/answer 均已应用）',
      exchangeDone,
      `最终状态 ${finalState || '未知'}；本机 ICE 不可达，跳过 connected/传输断言`,
    )
  }

  // ── 5.8 T17 断线快捷重配：断线警告旁「重新配对」→ 一步回 offer 页 + 重新生成配对码
  // 面板状态因环境而异（降级停在 done / 全量成功自动收起）：收起时先重新打开
  const openBtn = await pageA.getByRole('button', { name: '离线扫码配对' }).count()
  if (openBtn > 0) await pageA.getByRole('button', { name: '离线扫码配对' }).click()
  // 模拟离线断连（DEV 钩子覆盖 connState）→ 断线警告 + 重新配对按钮出现
  await pageA.evaluate(() => window.__ltQr?.setConnStateForTest('disconnected'))
  await pageA.getByRole('button', { name: '重新配对' }).waitFor({ timeout: 10000 })
  const offerBeforeRePair = await pageA.evaluate(() => window.__ltQr.getOfferText())
  await pageA.getByRole('button', { name: '重新配对' }).click()
  // 一步回到本端 offer 页（不重走 pick）：桌面主操作「粘贴回码」标题可见即 offer-show
  // （generateOffer 在生成新码后才切相位，标题出现即新码已就绪）
  await pageA.getByText('把手机显示的回码粘贴到这里（电脑主路径）：').waitFor({ timeout: 10000 })
  const offerAfterRePair = await pageA.evaluate(() => window.__ltQr.getOfferText())
  const backOnOffer = await pageA.getByText('把手机显示的回码粘贴到这里（电脑主路径）：').count()
  step(
    'T17 重新配对：断线警告旁按钮 → 一步回 offer 页并重新生成配对码',
    backOnOffer === 1 && offerAfterRePair.length > 0 && offerAfterRePair !== offerBeforeRePair,
    `重生成 ${offerAfterRePair.length} 字符`,
  )
  await pageA.evaluate(() => window.__ltQr?.setConnStateForTest(null))

  // T17 保持本端角色：answerer（B 在 answer-show）断线重配 → 回扫码相位等对方重新出码（不切 offerer）
  await pageB.evaluate(() => window.__ltQr?.setConnStateForTest('disconnected'))
  await pageB.getByRole('button', { name: '重新配对' }).waitFor({ timeout: 10000 })
  await pageB.getByRole('button', { name: '重新配对' }).click()
  await pageB.getByText('扫描发送端的配对码').waitFor({ timeout: 10000 })
  const stayedAnswerer = (await pageB.getByText('扫描发送端的配对码').count()) === 1
  await pageB.evaluate(() => window.__ltQr?.setConnStateForTest(null))
  step('T17 重新配对保持本端角色：answerer 回扫码相位（不切 offerer）', stayedAnswerer)

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
  const roomAfter = await readRoomBadge(pageA)
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

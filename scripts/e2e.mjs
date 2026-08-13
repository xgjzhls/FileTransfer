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
const LAUNCH_ARGS = [
  '--disable-features=WebRtcHideLocalIpsWithMdns',
  '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces',
  '--allow-loopback-ice',
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

const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS })
try {
  // ── 0. WebRTC 环境探测（同页双 pc loopback）
  const probe = await browser.newPage()
  const webrtcOk = await probe.evaluate(async () => {
    try {
      const pc1 = new RTCPeerConnection({ iceServers: [] })
      pc1.createDataChannel('t')
      const waitGather = (pc) =>
        new Promise((res) => {
          if (pc.iceGatheringState === 'complete') return res()
          pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && res())
          setTimeout(res, 15000)
        })
      const offer = await pc1.createOffer()
      await pc1.setLocalDescription(offer)
      await waitGather(pc1)
      const pc2 = new RTCPeerConnection({ iceServers: [] })
      await pc2.setRemoteDescription({ type: 'offer', sdp: pc1.localDescription.sdp })
      const answer = await pc2.createAnswer()
      await pc2.setLocalDescription(answer)
      await waitGather(pc2)
      await pc1.setRemoteDescription({ type: 'answer', sdp: pc2.localDescription.sdp })
      return await new Promise((res) => {
        const t = setInterval(() => {
          if (pc1.connectionState === 'connected' || pc1.connectionState === 'failed') {
            clearInterval(t)
            res(pc1.connectionState === 'connected')
          }
        }, 200)
        setTimeout(() => {
          clearInterval(t)
          res(false)
        }, 15000)
      })
    } catch {
      return false
    }
  })
  await probe.close()
  console.log(`WebRTC loopback 探测：${webrtcOk ? '可用 ✓（全量断言）' : '不可用 ⚠（降级：仅 UI + 信令断言）'}\n`)
  if (!webrtcOk) {
    console.log('  ⚠ 本机 Clash TUN + fake-ip（198.18.x.x）会劫持 WebRTC host candidate，')
    console.log('    同机自连不可行。这**不影响**跨设备（真实局域网 IP）场景，但电脑端')
    console.log('    需确保 Clash 未劫持局域网流量，否则手机连不上电脑。\n')
  }

  // 准备测试文件（3 MiB，3 chunk）
  const dir = mkdtempSync(join(tmpdir(), 'lt-e2e-'))
  const srcPath = join(dir, 'e2e-source.bin')
  writeFileSync(srcPath, randomBytes(3 * 1024 * 1024))

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
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

  // ── 4. A 点连接 → 信令 offer/answer 交换
  await pageA.getByRole('button', { name: '连接' }).click()
  await waitStatus(pageA, 'signaling')
  await waitStatus(pageB, 'signaling')
  step('A 点连接：两端进入 signaling（offer/answer 已交换）', true)

  if (webrtcOk) {
    await waitStatus(pageA, 'connected')
    await waitStatus(pageB, 'connected')
    step('两端状态 connected', true)

    // ── 5. A 选文件发送 → B 接收完成
    await pageA.setInputFiles('input[type="file"]', srcPath)
    await pageA.getByRole('button', { name: '开始发送' }).click()
    await pageB.waitForFunction(() => document.body.textContent?.includes('完成 ✓'), null, {
      timeout: 60000,
    })
    step('文件传输，B 端显示完成 ✓', true, '3 MiB')
  } else {
    step('（降级）WebRTC connected + 传输断言跳过', true, '环境不支持同机 ICE')
  }

  // ── 6. 无 JS 报错
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

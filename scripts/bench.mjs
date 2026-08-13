#!/usr/bin/env node
/**
 * 传输速度测量（e2e 全流程 + 计时）。
 * 用法：E2E_NO_PROXY=1 node scripts/bench.mjs [baseURL] [sizeMB]
 */
import { chromium } from 'playwright'
import { randomBytes } from 'crypto'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const BASE = process.argv[2] ?? 'https://localhost:5173'
const SIZE_MB = Number(process.argv[3] ?? 30)

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--force-webrtc-ip-handling-policy=default_public_and_private_interfaces', '--allow-loopback-ice'],
})
const ctxA = await browser.newContext({ ignoreHTTPSErrors: true })
const ctxB = await browser.newContext({ ignoreHTTPSErrors: true })
await ctxB.addInitScript(() => localStorage.setItem('lt.deviceName', 'E2E-B'))
const pageA = await ctxA.newPage()
const pageB = await ctxB.newPage()

const dir = mkdtempSync(join(tmpdir(), 'lt-bench-'))
const srcPath = join(dir, 'bench.bin')
writeFileSync(srcPath, randomBytes(SIZE_MB * 1024 * 1024))

await pageA.goto(BASE)
await pageA.getByRole('button', { name: '创建房间' }).click()
const room = (await pageA.locator('.badge', { hasText: '房间码：' }).textContent()).replace('房间码：', '').trim()
await pageB.goto(BASE)
await pageB.getByPlaceholder('输入房间码加入').fill(room)
await pageB.getByRole('button', { name: '加入' }).click()
await pageA.waitForFunction(() => document.body.textContent?.includes('E2E-B'), null, { timeout: 30000 })
await pageA.getByRole('button', { name: '连接' }).click()
await pageA.waitForFunction(() => [...document.querySelectorAll('.badge')].some((b) => b.textContent?.includes('connected')), null, { timeout: 30000 })
await new Promise((r) => setTimeout(r, 5000)) // dc open（长等待排除 dc open 延迟影响）

const start = Date.now()
await pageA.setInputFiles('input[type="file"]', srcPath)
await pageA.getByRole('button', { name: '开始发送' }).click()
await pageB.waitForFunction(() => document.body.textContent?.includes('下载到本机'), null, { timeout: 300000 })
const ms = Date.now() - start
const mbps = (SIZE_MB / ms) * 1000
console.log(`\n传输 ${SIZE_MB} MiB 耗时 ${(ms / 1000).toFixed(1)}s → ${mbps.toFixed(1)} MiB/s`)
await browser.close()

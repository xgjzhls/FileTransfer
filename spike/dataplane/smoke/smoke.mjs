// 冒烟测试：真实信令服务器 + 两个无头 Chrome 页面，验证 spike 页逻辑。
//
// 阶段 1（真实路径）：加入房间 → 互相可见 → offer/answer 经真实信令服务器交换
//   → 双方进入 connecting/connected（本机 Clash TUN 会劫持 WebRTC host candidate
//   为 198.18.0.1，真实 ICE 在本机无法直连 —— 真实验证留给真机测试，见 README）。
// 阶段 2（假传输）：注入 fake-rtc（BroadcastChannel 模拟 DataChannel），跑完整
//   数据面：建连 → 延迟 → 双向吞吐 → 字节核对。页面代码 100% 未改。
//
// 运行（仓库根目录，复用根 node_modules 的 playwright）：
//   node spike/dataplane/smoke/smoke.mjs
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { chromium } from 'playwright'
import { __injectFakeRtc } from './fake-rtc.mjs'

const ROOT = new URL('../www/', import.meta.url).pathname
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const THROUGHPUT_BYTES = 8 * 1024 * 1024 // 8 MiB（冒烟用小块，快）

const randCode = () =>
  Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/') p = '/index.html'
    const file = normalize(join(ROOT, p))
    if (!file.startsWith(normalize(ROOT + sep))) { res.writeHead(403); res.end(); return }
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'text/html' })
    res.end(data)
  } catch { res.writeHead(404); res.end() }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/`

async function waitFor(fn, what, timeout = 30_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try { if (await fn()) return } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`超时等待：${what}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function watchErrors(name, page, problems) {
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name} console.error: ${m.text()}`) })
}

let passed = 0
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`) }

// ─────────────────────────────────────────────────────────────────────────
console.log('阶段 1：真实信令 + SDP 交换（真实 RTCPeerConnection 路径）')
const browser1 = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
try {
  const pA = await browser1.newPage()
  const pB = await browser1.newPage()
  const problems = []
  watchErrors('A', pA, problems); watchErrors('B', pB, problems)
  await Promise.all([pA.goto(base), pB.goto(base)])
  await Promise.all([pA.waitForFunction(() => window.__ltSpike !== undefined), pB.waitForFunction(() => window.__ltSpike !== undefined)])
  const env = await pA.evaluate(() => ({ secure: window.isSecureContext, webrtc: typeof RTCPeerConnection !== 'undefined' }))
  if (!env.secure || !env.webrtc) throw new Error(`A 环境不满足：${JSON.stringify(env)}`)
  ok('页面加载，secure context + WebRTC 可用')

  const code = randCode()
  await pA.fill('#room', code); await pB.fill('#room', code)
  await pA.click('#btnJoin'); await pB.click('#btnJoin')
  await waitFor(() => pA.evaluate(() => window.__ltSpike.peerCount >= 1), 'A 看到 B')
  await waitFor(() => pB.evaluate(() => window.__ltSpike.peerCount >= 1), 'B 看到 A')
  ok('双方加入同一房间并互相可见（真实信令）')

  await pA.click('#btnOffer')
  await waitFor(() => pA.evaluate(() => document.querySelector('#log').textContent.includes('offer 已发出')), 'A 发出 offer')
  await waitFor(() => pB.evaluate(() => document.querySelector('#log').textContent.includes('answer 已回复')), 'B 回复 answer')
  await waitFor(() => pA.evaluate(() => document.querySelector('#log').textContent.includes('已设置对端 answer')), 'A 收到 answer')
  ok('offer/answer 经真实信令服务器完成交换（真实 RTCPeerConnection 路径）')

  const connA = await pA.textContent('#conn')
  console.log(`  注：本机 Clash TUN 劫持 WebRTC candidate → 状态停在「${connA}」属预期（真机/关 TUN 后才会 connected）`)
  if (problems.length) throw new Error(`页面异常：\n${problems.join('\n')}`)
  ok('阶段 1 无页面错误')
} finally {
  await browser1.close()
}

// ─────────────────────────────────────────────────────────────────────────
console.log('\n阶段 2：假传输（fake-rtc + Node 中继）→ 完整数据面逻辑（建连/延迟/双向吞吐/字节核对）')
const browser2 = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
try {
  const pA = await browser2.newPage()
  const pB = await browser2.newPage()
  await Promise.all([pA.addInitScript(__injectFakeRtc), pB.addInitScript(__injectFakeRtc)])
  const problems = []
  watchErrors('A', pA, problems); watchErrors('B', pB, problems)
  await Promise.all([pA.goto(base), pB.goto(base)])
  await Promise.all([pA.waitForFunction(() => window.__ltSpike !== undefined), pB.waitForFunction(() => window.__ltSpike !== undefined)])

  // Node 中继：A 的发送 → 交给 B 交付；反之亦然
  let deliverA = () => {}
  let deliverB = () => {}
  await pA.exposeFunction('__ltFakeTransport', (payload) => deliverB(payload))
  await pB.exposeFunction('__ltFakeTransport', (payload) => deliverA(payload))
  deliverA = (p) => pA.evaluate((x) => window.__ltFakeDeliver(x), p).catch(() => {})
  deliverB = (p) => pB.evaluate((x) => window.__ltFakeDeliver(x), p).catch(() => {})


  const code = randCode()
  await pA.fill('#room', code); await pB.fill('#room', code)
  await pA.click('#btnJoin'); await pB.click('#btnJoin')
  await waitFor(() => pA.evaluate(() => window.__ltSpike.peerCount >= 1), 'A 看到 B')
  await waitFor(() => pB.evaluate(() => window.__ltSpike.peerCount >= 1), 'B 看到 A')
  ok('双方可见（真实信令）')

  await pA.click('#btnOffer')
  await waitFor(() => pA.evaluate(() => window.__ltSpike.connected()), 'A 建连成功')
  await waitFor(() => pB.evaluate(() => window.__ltSpike.connected()), 'B 建连成功')
  ok('DataChannel 建连（fake 传输）')

  await pA.evaluate(() => window.__ltSpike.runLatency())
  await waitFor(() => pA.evaluate(() => document.querySelector('#res').textContent.includes('延迟')), 'A 延迟结果')
  console.log(`  ${(await pA.textContent('#res')).trim()}`)
  ok('往返延迟测量完成')

  await pA.evaluate((n) => window.__ltSpike.runThroughput(n), THROUGHPUT_BYTES)
  await waitFor(() => pA.evaluate(() => document.querySelector('#res').textContent.includes('吞吐')), 'A 吞吐结果', 60_000)
  const resA = (await pA.textContent('#res')).trim()
  console.log(`  ${resA}`)
  const recvB = await pB.evaluate(() => window.__ltSpike.recvBytes)
  const sentA = await pA.evaluate(() => window.__ltSpike.sentBytes)
  if (recvB !== THROUGHPUT_BYTES || sentA !== THROUGHPUT_BYTES) {
    throw new Error(`A→B 字节不一致：发送 ${sentA} / 接收 ${recvB}（期望 ${THROUGHPUT_BYTES}）`)
  }
  ok(`A→B 吞吐字节核对：发送 ${sentA} = 接收 ${recvB}`)

  await pB.evaluate((n) => window.__ltSpike.runThroughput(n), THROUGHPUT_BYTES)
  await waitFor(() => pB.evaluate(() => document.querySelector('#res').textContent.includes('吞吐')), 'B 吞吐结果', 60_000)
  const recvA = await pA.evaluate(() => window.__ltSpike.recvBytes)
  if (recvA !== THROUGHPUT_BYTES) throw new Error(`B→A 字节不一致：${recvA}`)
  ok(`B→A 吞吐字节核对：接收 ${recvA}`)

  await sleep(400)
  if (problems.length) throw new Error(`页面异常：\n${problems.join('\n')}`)
  ok('阶段 2 无页面错误')
} finally {
  await browser2.close()
}

server.close()
console.log(`\nSMOKE PASS —— 共 ${passed} 项全部通过（信令 / SDP 交换 / 建连 / 延迟 / 双向吞吐 / 字节核对）`)

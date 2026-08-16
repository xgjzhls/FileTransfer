// 极简静态服务器：给 spike 页服务（Chrome 腿 + 冒烟测试共用）。
// 用法：node smoke/serve.mjs [端口，默认 8080]  —— 打印含局域网 IP 的访问地址
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import { networkInterfaces } from 'node:os'

const ROOT = new URL('../www/', import.meta.url).pathname
const PORT = Number(process.argv[2] ?? 8080)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (p === '/') p = '/index.html'
    const file = normalize(join(ROOT, p))
    if (!file.startsWith(normalize(ROOT + sep))) {
      res.writeHead(403); res.end('forbidden'); return
    }
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404); res.end('not found')
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`spike www 已启动：`)
  console.log(`  本机:  http://localhost:${PORT}`)
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  局域网: http://${a.address}:${PORT}`)
    }
  }
})

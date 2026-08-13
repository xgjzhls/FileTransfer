/**
 * WebRTC 诊断工具：收集本机 ICE 候选 IP（排除 mDNS/fake-ip 干扰的可视化）。
 * 用于连接失败时定位网络层问题（路由器 mDNS 过滤 / Clash fake-ip 劫持等）。
 */

export async function collectLocalCandidates(timeoutMs = 5000): Promise<string[]> {
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.createDataChannel('lt-diag')
  const raw: string[] = []
  pc.onicecandidate = (e) => {
    if (e.candidate) raw.push(e.candidate.candidate)
  }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  await new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.onicegatheringstatechange = null
        clearTimeout(timer)
        resolve()
      }
    }
    pc.onicegatheringstatechange = done
    const timer = setTimeout(() => {
      pc.onicegatheringstatechange = null
      resolve()
    }, timeoutMs)
  })
  pc.close()

  // candidate 格式: "candidate:<foundation> <component> <proto> <priority> <ip> <port> ..."
  const ips: string[] = []
  for (const c of raw) {
    const ip = c.split(' ')[4]
    if (ip && !ips.includes(ip)) ips.push(ip)
  }
  return ips
}

/** 候选 IP 分类标注：mDNS 名 / fake-ip / 真实局域网 IP */
export function describeCandidateIp(ip: string): string {
  if (ip.endsWith('.local')) return `${ip}（mDNS 名，依赖组播解析）`
  if (/^198\.18\./.test(ip) || ip.includes(':')) return `${ip}（疑似 Clash fake-ip / 隧道接口）`
  return `${ip}（真实地址）`
}

// 假 RTC 传输注入（冒烟测试用）：
// 本机 Clash TUN（utun1500 = 198.18.0.1）会劫持 Chromium 的 WebRTC host candidate，
// 真实 ICE 在本机无法直连（真实验证留给真机测试，见 README）。这里用 Node 中继
// （Playwright exposeFunction + evaluate）模拟 DataChannel 传输，验证 spike 页的
// 完整数据面逻辑：控制帧、吞吐统计、字节核对。页面代码 100% 未改。
//
// 注入（addInitScript）：定义 FakeRTCPeerConnection/FakeDC；发送走
//   window.__ltFakeTransport(payload)（由 smoke 用 exposeFunction 提供），
//   接收由 window.__ltFakeDeliver(payload) 交付（由 smoke 的 Node 中继调用）。
// payload = JSON { chId, str? | b64? }。

function __injectFakeRtc() {
  const FIXED_CH = 'ch-main' // 1:1 房间：两端通道 id 固定一致即可
  const dcs = new Map()

  const b64encode = (u8) => {
    let bin = ''
    for (let i = 0; i < u8.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
    }
    return btoa(bin)
  }
  const b64decode = (s) => {
    const bin = atob(s)
    const u = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
    return u.buffer
  }

  class FakeDC {
    constructor(chId, label) {
      this.chId = chId
      this.label = label
      this.readyState = 'connecting'
      this.binaryType = 'blob'
      this.bufferedAmount = 0
      this.bufferedAmountLowThreshold = 0
      this._msgCb = null
      this.onopen = null; this.onclose = null; this.onerror = null
    }
    set onmessage(fn) {
      this._msgCb = (e) => {
        const head = typeof e.data === 'string' ? `str ${e.data.slice(0, 70)}` : `bin ${e.data.byteLength}`
        console.log(`[fake-dc:${this.chId}][${Date.now()}] deliver ->`, head)
        try {
          const r = fn(e)
          console.log(`[fake-dc:${this.chId}][${Date.now()}] handler returned`)
          return r
        } catch (err) {
          console.log(`[fake-dc:${this.chId}][${Date.now()}] HANDLER THREW:`, err.message)
          throw err
        }
      }
    }
    get onmessage() { return this._msgCb }
    open() {
      this.readyState = 'open'
      setTimeout(() => { if (this.onopen) this.onopen() }, 50)
    }
    send(data) {
      if (this.readyState !== 'open') throw new Error('fake dc not open')
      const m = typeof data === 'string'
        ? { chId: this.chId, str: data }
        : { chId: this.chId, b64: b64encode(data) }
      pushOut(m)
    }
    close() { this.readyState = 'closed'; if (this.onclose) this.onclose() }
  }

  // 批量中继：同一任务内的多个 send 合并成一次传输（吞吐测试 128×64KiB 块 → ~32 次往返）
  let outbox = []
  let flushTimer = null
  function pushOut(m) {
    outbox.push(m)
    if (outbox.length >= 4) {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      flushNow()
    } else if (!flushTimer) {
      flushTimer = setTimeout(flushNow, 5)
    }
  }
  function flushNow() {
    flushTimer = null
    if (!outbox.length) return
    const payload = JSON.stringify({ msgs: outbox })
    outbox = []
    if (typeof window.__ltFakeTransport !== 'function') throw new Error('fake transport 未注入')
    window.__ltFakeTransport(payload)
  }

  // Node 中继侧调用：把对端发来的批量 payload 逐条交给本地对应通道
  window.__ltFakeDeliver = (payload) => {
    try {
      const { msgs } = JSON.parse(payload)
      for (const m of msgs) {
        const dc = dcs.get(m.chId)
        if (!dc) continue
        const delivered = m.str !== undefined ? m.str : b64decode(m.b64)
        setTimeout(() => { if (dc.onmessage) dc.onmessage({ data: delivered }) }, 1)
      }
    } catch (e) {
      console.error('[fake-rtc] deliver failed:', e.message)
    }
  }

  function maybeConnect(pc) {
    if (pc._ld && pc._rd && pc._conn !== 'connected') {
      setTimeout(() => {
        pc._conn = 'connected'
        if (pc.onconnectionstatechange) pc.onconnectionstatechange()
        for (const dc of pc._dcs) dc.open()
      }, 300)
    }
  }

  class FakeRTCPeerConnection {
    constructor() {
      this._conn = 'new'
      this._gather = 'new'
      this._ld = null
      this._rd = null
      this._dcs = []
      this.onconnectionstatechange = null
      this.onicecandidate = null
      this.onicegatheringstatechange = null
      this.ondatachannel = null
    }
    createDataChannel(label) {
      const dc = new FakeDC(FIXED_CH, label)
      this._dcs.push(dc)
      dcs.set(FIXED_CH, dc)
      return dc
    }
    async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer' } }
    async createAnswer() { return { type: 'answer', sdp: 'v=0 fake-answer' } }
    async setLocalDescription(desc) {
      this._ld = desc
      this._gather = 'complete'
      if (this.onicegatheringstatechange) this.onicegatheringstatechange()
      maybeConnect(this)
    }
    async setRemoteDescription(desc) {
      this._rd = desc
      if (desc.type === 'offer') {
        const dc = new FakeDC(FIXED_CH, 'lt')
        this._dcs.push(dc)
        dcs.set(FIXED_CH, dc)
        setTimeout(() => { if (this.ondatachannel) this.ondatachannel({ channel: dc }) }, 100)
      }
      maybeConnect(this)
    }
    close() { this._conn = 'closed' }
    get connectionState() { return this._conn }
    get iceGatheringState() { return this._gather }
    get localDescription() { return this._ld }
  }

  window.RTCPeerConnection = FakeRTCPeerConnection
  window.__ltFakeDebug = () => ({
    keys: [...dcs.keys()],
    chMain: dcs.get(FIXED_CH)
      ? { ready: dcs.get(FIXED_CH).readyState, hasOnMsg: typeof dcs.get(FIXED_CH).onmessage === 'function' }
      : 'missing',
  })
}

export { __injectFakeRtc }

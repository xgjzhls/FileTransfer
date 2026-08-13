export default function Home() {
  return (
    <>
      <h1>LocalTransfer</h1>
      <p>局域网 P2P 文件传输 · 零安装 · 离线可用</p>

      <section className="card">
        <h2>房间</h2>
        <p className="muted">
          [T04 实现] 在线：显示本机房间码 + 同房间设备列表；离线：扫码配对入口。
        </p>
        <div className="row">
          <span className="badge">房间码：—</span>
          <span className="badge">设备 0 台在线</span>
        </div>
      </section>

      <section className="card">
        <h2>传输</h2>
        <p className="muted">
          [T05 实现] 选文件 → 发送；接收确认 → 自动接收 → 导出（文件 / 照片）。
        </p>
      </section>
    </>
  )
}

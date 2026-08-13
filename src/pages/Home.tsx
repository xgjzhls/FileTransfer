import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { findOrphans, formatBytes } from '../storage'
import type { OrphanReport } from '../storage'

export default function Home() {
  const [orphans, setOrphans] = useState<OrphanReport | null>(null)

  useEffect(() => {
    let cancelled = false
    // 启动时扫描孤儿数据（SPEC §4：无 manifest 或超 30 天）
    findOrphans()
      .then((report) => {
        if (!cancelled) setOrphans(report)
      })
      .catch(() => {
        // OPFS 不可用（如非安全上下文）时静默跳过
        if (!cancelled) setOrphans({ orphans: [], totalBytes: 0 })
      })
    return () => {
      cancelled = true
    }
  }, [])

  const orphanCount = orphans?.orphans.length ?? 0

  return (
    <>
      <h1>LocalTransfer</h1>
      <p>局域网 P2P 文件传输 · 零安装 · 离线可用</p>

      {orphanCount > 0 && (
        <div className="banner">
          <span>
            发现 {orphanCount} 个孤儿会话（占用 {formatBytes(orphans!.totalBytes)}，可能来自中断的传输）
          </span>
          <Link to="/settings">去设置清理 →</Link>
        </div>
      )}

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

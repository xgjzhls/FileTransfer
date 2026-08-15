import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { clearAllData, cleanupOrphans, ORPHAN_AGE_MS } from '../storage/cleanup'
import { findOrphans, formatBytes, getSessionStore, getStorageAdapter } from '../storage'
import type { OrphanReport } from '../storage'
import { clearLastRoom, getLastRoom } from '../rooms/session'

const DEVICE_NAME_KEY = 'lt.deviceName'

interface IncompleteFile {
  fileId: number
  name: string
  size: number
  doneParts: number
  totalParts: number
  bytes: number
}

interface IncompleteSession {
  sessionId: string
  lastActiveAt: number
  expired: boolean
  files: IncompleteFile[]
  totalBytes: number
}

export default function Settings() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [orphans, setOrphans] = useState<OrphanReport>({ orphans: [], totalBytes: 0 })
  const [scanError, setScanError] = useState('')
  const [busy, setBusy] = useState(false)
  const [clearResult, setClearResult] = useState('')
  // T12：记住的房间（设置页「退出房间」入口）
  const [lastRoom, setLastRoom] = useState('')
  const [roomMsg, setRoomMsg] = useState('')

  useEffect(() => {
    setName(localStorage.getItem(DEVICE_NAME_KEY) ?? '')
    setLastRoom(getLastRoom())
    void refreshOrphans()
  }, [])

  async function refreshOrphans() {
    try {
      setScanError('')
      setOrphans(await findOrphans())
    } catch (e) {
      setScanError(e instanceof Error ? e.message : String(e))
    }
  }

  function handleSave() {
    localStorage.setItem(DEVICE_NAME_KEY, name.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function handleCleanOrphans() {
    setBusy(true)
    setClearResult('清理中…')
    try {
      const ids = orphans.orphans.map((o) => o.sessionId)
      await cleanupOrphans(getStorageAdapter(), getSessionStore(), ids)
      setClearResult(`已清理 ${ids.length} 个孤儿会话`)
      await refreshOrphans()
    } catch (e) {
      setClearResult(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  async function handleClearAll() {
    setBusy(true)
    setClearResult('清理中…')
    try {
      await clearAllData(getStorageAdapter(), getSessionStore())
      localStorage.clear()
      setOrphans({ orphans: [], totalBytes: 0 })
      setClearResult('已清除全部数据（OPFS + IndexedDB + 本地设置）')
    } catch (e) {
      setClearResult(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  // ── T06：未完成会话（续传 / 删除） ───────────────────────────────────────
  const [sessions, setSessions] = useState<IncompleteSession[]>([])
  const [sessionMsg, setSessionMsg] = useState('')

  useEffect(() => {
    void refreshSessions()
  }, [])

  async function refreshSessions() {
    try {
      const [records, dirs] = await Promise.all([
        getSessionStore().list(),
        getStorageAdapter().listSessions(),
      ])
      const bytesBySession = new Map(dirs.map((d) => [d.sessionId, d.bytes]))
      const now = Date.now()
      const incomplete: IncompleteSession[] = []
      for (const record of records) {
        const files: IncompleteFile[] = []
        for (const f of record.files) {
          const parts = f.parts ?? []
          const done = parts.filter((p) => p.state === 'done').length
          const total = Math.max(f.partCount, parts.length)
          // 有 part 记录且未全部完成 → 未完成
          if (parts.length > 0 && done < total) {
            files.push({
              fileId: f.fileId,
              name: f.name,
              size: f.size,
              doneParts: done,
              totalParts: total,
              bytes: bytesBySession.get(record.sessionId) ?? 0,
            })
          }
        }
        if (files.length > 0) {
          incomplete.push({
            sessionId: record.sessionId,
            lastActiveAt: record.lastActiveAt,
            expired: now - record.lastActiveAt > ORPHAN_AGE_MS,
            files,
            totalBytes: bytesBySession.get(record.sessionId) ?? 0,
          })
        }
      }
      setSessions(incomplete)
    } catch (e) {
      setSessionMsg(`读取会话失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setBusy(true)
    try {
      await getStorageAdapter().deleteSession(sessionId)
      await getSessionStore().delete(sessionId)
      setSessionMsg('已删除未完成会话（含部分文件）')
      await refreshSessions()
    } catch (e) {
      setSessionMsg(`删除失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  /** T12：退出房间 —— 清 lt.lastRoom；回首页不再自动回房（首页卸载时信令已断开） */
  function handleLeaveRoom() {
    clearLastRoom()
    setLastRoom('')
    setRoomMsg('已退出房间：下次打开首页不会自动加入该房间')
  }

  return (
    <>
      <h1>设置</h1>

      <section className="card">
        <h2>设备</h2>
        <div className="row">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="设备名称（如：我的 iPhone）"
            style={{ flex: 1, minWidth: 160 }}
          />
          <button onClick={handleSave}>{saved ? '已保存 ✓' : '保存'}</button>
        </div>
        <p className="muted">设备名会显示在配对列表中。</p>
      </section>

      <section className="card">
        <h2>房间</h2>
        {lastRoom ? (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>
              当前房间：<span className="badge">{lastRoom}</span>
              <span className="muted" style={{ marginLeft: 8 }}>
                （打开首页自动加入）
              </span>
            </span>
            <button onClick={handleLeaveRoom} style={{ padding: '2px 10px' }}>
              退出房间
            </button>
          </div>
        ) : (
          <p className="muted">未记住房间：打开首页后输入房间码即可加入，重开应用自动回房。</p>
        )}
        {roomMsg && <p className="ok">{roomMsg}</p>}
      </section>

      <section className="card">
        <h2>数据</h2>

        <h3 style={{ fontSize: 13, margin: '4px 0 8px', color: 'var(--muted)' }}>孤儿数据</h3>
        {scanError && <p className="bad">{scanError}</p>}
        {orphans.orphans.length === 0 && !scanError && (
          <p className="muted">未发现孤儿会话。</p>
        )}
        {orphans.orphans.length > 0 && (
          <>
            <p className="bad">
              发现 {orphans.orphans.length} 个孤儿会话（占用 {formatBytes(orphans.totalBytes)}）
              —— 无 manifest 或超 30 天未活跃。
            </p>
            <button onClick={handleCleanOrphans} disabled={busy}>
              清理孤儿数据
            </button>
          </>
        )}

        <hr style={{ border: 'none', borderTop: '1px solid var(--line)', margin: '14px 0' }} />

        <button onClick={handleClearAll} disabled={busy} style={{ background: '#ff453a' }}>
          {busy ? '清理中…' : '清除全部数据（OPFS + IndexedDB + 本地设置）'}
        </button>
        {clearResult && <p>{clearResult}</p>}
        <p className="muted">
          传输接收的文件暂存在本应用沙盒（OPFS），此操作会清空全部未导出的数据。
        </p>
        <p className="bad">
          ⚠ iOS 分区隔离：各浏览器/独立 PWA 的存储互不可见——传输与清理必须在同一浏览器/模式。
        </p>
      </section>

      <section className="card">
        <h2>未完成会话（续传 / 删除）</h2>
        {sessionMsg && <p>{sessionMsg}</p>}
        {sessions.length === 0 && !sessionMsg && (
          <p className="muted">没有未完成的传输。断线后回到首页重新配对，会自动从断点继续。</p>
        )}
        {sessions.map((s) => (
          <div key={s.sessionId} style={{ margin: '10px 0', padding: '8px', border: '1px solid var(--line)', borderRadius: 8 }}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono" style={{ fontSize: 12 }}>
                {s.sessionId.slice(0, 8)}… · {formatBytes(s.totalBytes)}
                {s.expired ? ' · 已超 30 天' : ''}
              </span>
              <button onClick={() => void handleDeleteSession(s.sessionId)} disabled={busy} style={{ padding: '2px 10px' }}>
                删除
              </button>
              <Link to="/" style={{ fontSize: 13 }}>续传 →</Link>
            </div>
            <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
              {s.files.map((f) => (
                <li key={f.fileId} className="mono" style={{ fontSize: 12, margin: '2px 0' }}>
                  {f.name}（{formatBytes(f.size)}）· 已收 {f.doneParts}/{f.totalParts} part
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>
              回首页重新配对后自动续传（只补缺失部分）。
            </p>
          </div>
        ))}
        <p className="muted" style={{ fontSize: 12 }}>
          续传进度由接收端保存（位图节流写入）；超过 30 天未活跃的会话标记为可清理。
        </p>
      </section>

      <section className="card">
        <h2>关于</h2>
        <p className="muted">
          LocalTransfer · 局域网 P2P 文件传输（PWA）<br />
          SPEC.md 定义协议；decisions/adr/ 记录架构决策。
        </p>
      </section>
    </>
  )
}

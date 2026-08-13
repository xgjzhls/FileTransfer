import { useEffect, useState } from 'react'
import { clearAllData, cleanupOrphans } from '../storage/cleanup'
import { findOrphans, formatBytes, getSessionStore, getStorageAdapter } from '../storage'
import type { OrphanReport } from '../storage'

const DEVICE_NAME_KEY = 'lt.deviceName'

export default function Settings() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [orphans, setOrphans] = useState<OrphanReport>({ orphans: [], totalBytes: 0 })
  const [scanError, setScanError] = useState('')
  const [busy, setBusy] = useState(false)
  const [clearResult, setClearResult] = useState('')

  useEffect(() => {
    setName(localStorage.getItem(DEVICE_NAME_KEY) ?? '')
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
        <p className="muted">设备名会显示在配对列表中 [T04 接入信令]。</p>
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

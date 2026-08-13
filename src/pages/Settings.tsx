import { useEffect, useState } from 'react'
import { clearOpfsTestData } from '../spike/opfs'

const DEVICE_NAME_KEY = 'lt.deviceName'

export default function Settings() {
  const [name, setName] = useState('')
  const [saved, setSaved] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearResult, setClearResult] = useState('')

  useEffect(() => {
    setName(localStorage.getItem(DEVICE_NAME_KEY) ?? '')
  }, [])

  function handleSave() {
    localStorage.setItem(DEVICE_NAME_KEY, name.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  async function handleClearAll() {
    setClearing(true)
    setClearResult('清理中…')
    try {
      const r = await clearOpfsTestData()
      localStorage.clear()
      setClearResult(`已清理 ${r.removed.length} 项 OPFS 数据，本地设置已重置（释放 ${r.freedBytes} 字节）`)
    } catch (e) {
      setClearResult(`清理失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setClearing(false)
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
        <button onClick={handleClearAll} disabled={clearing} style={{ background: '#ff453a' }}>
          {clearing ? '清理中…' : '清除全部数据（OPFS + 本地设置）'}
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

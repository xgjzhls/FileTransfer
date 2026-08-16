/**
 * lan-discovery 插件 JS 侧单测（T02 契约）：
 * - validateAdvertisingOptions：TXT 载荷契约（RFC 6763 单值 ≤255B / kind 枚举 / port 1..65535）
 * - web 降级实现：非壳环境调用明确报错（浏览器无 mDNS 能力，ADR-0009）
 * - facade 包装：非法参数先于原生被拦（LanOptionsError）；合法参数正确委托 web 实现
 */
import { describe, expect, it } from 'vitest'
import {
  LanDiscovery,
  LanOptionsError,
  SERVICE_TYPE,
  validateAdvertisingOptions,
  LAN_KINDS,
} from './index'
import { webLanDiscovery } from './web'

const valid = {
  name: 'iPhone 11',
  id: '4f6a3f4c-0c2e-4b8a-9d5f-1e2a3b4c5d6e',
  kind: 'phone' as const,
  port: 8443,
  ver: '1',
}

describe('服务类型与常量', () => {
  it('服务类型为 _localtranfer._tcp（SPEC §5.5）', () => {
    expect(SERVICE_TYPE).toBe('_localtranfer._tcp')
  })

  it('kind 枚举与 SPEC §5.3 设备分工一致', () => {
    expect([...LAN_KINDS].sort()).toEqual(['desktop', 'phone', 'tablet'])
  })
})

describe('validateAdvertisingOptions（TXT 载荷契约）', () => {
  it('合法参数通过（含中文设备名，UTF-8 字节数 < 255）', () => {
    expect(() =>
      validateAdvertisingOptions({ ...valid, name: '张三的 iPhone' }),
    ).not.toThrow()
  })

  it('参数缺失 / 非对象拒绝', () => {
    expect(() => validateAdvertisingOptions(undefined)).toThrow(LanOptionsError)
    expect(() => validateAdvertisingOptions(null)).toThrow(LanOptionsError)
    expect(() => validateAdvertisingOptions('nope')).toThrow(LanOptionsError)
  })

  it('name/id/ver 必须是非空字符串', () => {
    expect(() => validateAdvertisingOptions({ ...valid, name: '' })).toThrow(/name/)
    expect(() => validateAdvertisingOptions({ ...valid, id: '' })).toThrow(/id/)
    expect(() => validateAdvertisingOptions({ ...valid, ver: '' })).toThrow(/ver/)
    expect(() => validateAdvertisingOptions({ ...valid, name: 42 })).toThrow(/name/)
  })

  it('TXT 单值超 255 字节（RFC 6763）拒绝', () => {
    expect(() =>
      validateAdvertisingOptions({ ...valid, name: 'x'.repeat(256) }),
    ).toThrow(/255/)
    // 中文按 UTF-8 字节计（3 字节/字）：85 个字 = 255 字节（边界内），86 个超限
    expect(() => validateAdvertisingOptions({ ...valid, name: '中'.repeat(85) })).not.toThrow()
    expect(() => validateAdvertisingOptions({ ...valid, name: '中'.repeat(86) })).toThrow(/255/)
  })

  it('kind 必须是 phone/tablet/desktop', () => {
    expect(() => validateAdvertisingOptions({ ...valid, kind: 'laptop' })).toThrow(/kind/)
    expect(() => validateAdvertisingOptions({ ...valid, kind: 'tablet' })).not.toThrow()
  })

  it('port 必须是 1..65535 整数', () => {
    expect(() => validateAdvertisingOptions({ ...valid, port: 0 })).toThrow(/port/)
    expect(() => validateAdvertisingOptions({ ...valid, port: 65536 })).toThrow(/port/)
    expect(() => validateAdvertisingOptions({ ...valid, port: 8443.5 })).toThrow(/port/)
    expect(() => validateAdvertisingOptions({ ...valid, port: '8443' })).toThrow(/port/)
    expect(() => validateAdvertisingOptions({ ...valid, port: 1 })).not.toThrow()
    expect(() => validateAdvertisingOptions({ ...valid, port: 65535 })).not.toThrow()
  })
})

describe('web 降级实现（浏览器无发现能力）', () => {
  it('四个原语明确报错（仅 app 内可用）', async () => {
    for (const m of ['startAdvertising', 'stopAdvertising', 'startBrowsing', 'stopBrowsing'] as const) {
      await expect((webLanDiscovery as any)[m](valid)).rejects.toThrow(/仅 app 内可用/)
    }
  })

  it('removeAllListeners 为无操作收尾（跨平台清理路径安全）', async () => {
    await expect(webLanDiscovery.removeAllListeners()).resolves.toBeUndefined()
  })

  it('addListener 返回可移除的空句柄（web 无事件可收，但不炸）', async () => {
    const handle = await webLanDiscovery.addListener('deviceFound', () => {})
    expect(typeof handle.remove).toBe('function')
    await expect(handle.remove()).resolves.toBeUndefined()
  })
})

describe('LanDiscovery facade 包装', () => {
  it('非法参数先于原生被拦（LanOptionsError）', async () => {
    await expect(LanDiscovery.startAdvertising({ ...valid, port: 0 } as never)).rejects.toThrow(LanOptionsError)
    await expect(LanDiscovery.startAdvertising({ name: '' } as never)).rejects.toThrow(LanOptionsError)
  })

  it('合法参数正确委托到底层实现（node 测试环境 = web 实现 → 报仅 app 内可用）', async () => {
    await expect(LanDiscovery.startAdvertising(valid)).rejects.toThrow(/仅 app 内可用/)
  })

  it('其余原语直接委托底层实现', async () => {
    await expect(LanDiscovery.stopAdvertising()).rejects.toThrow(/仅 app 内可用/)
    await expect(LanDiscovery.startBrowsing()).rejects.toThrow(/仅 app 内可用/)
    await expect(LanDiscovery.stopBrowsing()).rejects.toThrow(/仅 app 内可用/)
  })
})

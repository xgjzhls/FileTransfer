/**
 * 本地 WSS 服务器 facade 层（T07 电脑端 A）参数校验单测：
 * startLocalServer 的 PEM/设备校验、sendLocalMessage 的 ≤64KiB 校验、
 * 默认端口池（与 app↔app TCP 信令 8443 分离）、事件名常量。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCAL_SERVER_PORT,
  LanOptionsError,
  LOCAL_SERVER_EVENTS,
  LOCAL_SERVER_PORTS,
  validateLocalMessage,
  validateLocalServerOptions,
} from './index'

const pem = (label: string) =>
  `-----BEGIN ${label}-----\n${'aGVsbG8='}\n-----END ${label}-----`

const goodOptions = {
  certPem: pem('CERTIFICATE'),
  keyPem: pem('PRIVATE KEY'),
  caPem: pem('CERTIFICATE'),
  device: { id: 'dev-1', name: 'iPhone', kind: 'phone' as const, port: 8443, ver: '1' },
}

describe('validateLocalServerOptions', () => {
  it('合法参数通过（PEM 块齐全 + 设备信息合法）', () => {
    expect(() => validateLocalServerOptions(goodOptions)).not.toThrow()
  })

  it('PEM 块缺失/标签不符 → LanOptionsError', () => {
    expect(() =>
      validateLocalServerOptions({ ...goodOptions, certPem: 'not-pem' }),
    ).toThrow(LanOptionsError)
    expect(() =>
      validateLocalServerOptions({ ...goodOptions, keyPem: pem('CERTIFICATE') }),
    ).toThrow(/PRIVATE KEY/)
  })

  it('设备信息非法（缺 id/name/kind/port）→ LanOptionsError', () => {
    expect(() =>
      validateLocalServerOptions({
        ...goodOptions,
        device: { id: '', name: 'x', kind: 'phone', port: 9443, ver: '1' },
      }),
    ).toThrow(LanOptionsError)
  })

  it('非对象参数 → LanOptionsError', () => {
    expect(() => validateLocalServerOptions(null as never)).toThrow(LanOptionsError)
  })
})

describe('validateLocalMessage', () => {
  it('合法信令 JSON 通过', () => {
    expect(() =>
      validateLocalMessage(JSON.stringify({ v: 1, type: 'signal', kind: 'offer', sdp: 'x' })),
    ).not.toThrow()
  })

  it('空串/非字符串 → LanOptionsError', () => {
    expect(() => validateLocalMessage('')).toThrow(LanOptionsError)
    expect(() => validateLocalMessage(42 as never)).toThrow(LanOptionsError)
  })

  it('超过 64KiB → LanOptionsError', () => {
    expect(() => validateLocalMessage('x'.repeat(64 * 1024 + 1))).toThrow(/上限/)
    // 恰好上限通过
    expect(() => validateLocalMessage('x'.repeat(64 * 1024))).not.toThrow()
  })
})

describe('本地服务器端口池（与 app↔app TCP 信令分离）', () => {
  it('默认 9443，冲突依次 9444/9445（不与 8443 通道端口冲突）', () => {
    expect(DEFAULT_LOCAL_SERVER_PORT).toBe(9443)
    expect(LOCAL_SERVER_PORTS).toEqual([9443, 9444, 9445])
    expect(LOCAL_SERVER_PORTS).not.toContain(8443)
  })

  it('事件名常量', () => {
    expect(LOCAL_SERVER_EVENTS).toEqual({
      clientConnected: 'localClientConnected',
      clientDisconnected: 'localClientDisconnected',
      messageReceived: 'localMessageReceived',
      serverError: 'localServerError',
    })
  })
})
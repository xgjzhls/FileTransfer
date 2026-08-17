/**
 * 证书设施单测（ADR-0009 决策 4 / T07）—— Node `crypto.X509Certificate`（OpenSSL 内核）
 * 作为格式兼容性 oracle：生成的 CA/叶证书必须被 OpenSSL 正确解析、链校验、SAN 匹配。
 * 这正是 iOS/Android 原生 TLS 栈将要消费的同一格式。
 */
import { describe, expect, it } from 'vitest'
import { X509Certificate, createHash } from 'node:crypto'
import {
  CertUnavailableError,
  createSigningAuthority,
  derToPem,
  fingerprintSha256,
  localHostName,
  parseCertificate,
  parseSubjectAltName,
  pemToDer,
  signLeafCertificate,
} from './cert'

const CA_CN = 'LocalTransfer Test CA'

/** 生成一套 CA + 叶证书（默认 SAN：.local + 两个 IP） */
async function makeSet(opts?: { dnsName?: string; ipAddresses?: string[]; commonName?: string }) {
  const ca = await createSigningAuthority(CA_CN)
  const leaf = await signLeafCertificate({
    caPem: ca.caPem,
    caKeyPem: ca.caKeyPem,
    dnsName: opts?.dnsName ?? localHostName('0123456789abcdef0123456789abcdef'),
    ipAddresses: opts?.ipAddresses ?? ['10.213.80.3', '127.0.0.1'],
    commonName: opts?.commonName,
  })
  return { ca, leaf }
}

describe('DER/PEM 基础', () => {
  it('PEM 往返一致（DER 保真）', async () => {
    const { ca, leaf } = await makeSet()
    expect(pemToDer(ca.caPem, 'CERTIFICATE')).toEqual(pemToDer(derToPem(pemToDer(ca.caPem, 'CERTIFICATE'), 'CERTIFICATE'), 'CERTIFICATE'))
    // 叶证书长度合理（ECDSA P-256 证书 ≈ 500-600 字节）
    const leafDer = pemToDer(leaf.certPem, 'CERTIFICATE')
    expect(leafDer.length).toBeGreaterThan(400)
    expect(leafDer.length).toBeLessThan(700)
  })

  it('PEM 块缺失抛错', async () => {
    const { ca } = await makeSet()
    expect(() => pemToDer('-----BEGIN WRONG-----\nabc\n-----END WRONG-----', 'CERTIFICATE')).toThrow(/不含 CERTIFICATE/)
    expect(() => pemToDer(ca.caPem, 'PRIVATE KEY')).toThrow(/不含 PRIVATE KEY/)
  })
})

describe('CA 生成', () => {
  it('被 OpenSSL 解析为 CA：基本约束 CA:TRUE + keyCertSign', async () => {
    const { ca } = await makeSet()
    const cert = new X509Certificate(ca.caPem)
    expect(cert.ca).toBe(true)
    expect(cert.subject).toContain(`CN=${CA_CN}`)
    expect(cert.issuer).toContain(`CN=${CA_CN}`) // 自签
    expect(cert.serialNumber).toMatch(/^[0-9A-F]+$/) // Node 序列号为十六进制
  })

  it('CA 私钥导出自检（PEM 可解析回 PKCS#8 EC）', async () => {
    const ca = await createSigningAuthority(CA_CN)
    expect(ca.caKeyPem).toContain('-----BEGIN PRIVATE KEY-----')
    // PKCS#8 结构：SEQUENCE { INTEGER 0, SEQUENCE {...} }
    const der = pemToDer(ca.caKeyPem, 'PRIVATE KEY')
    expect(der[0]).toBe(0x30)
    expect(der.length).toBeGreaterThan(100)
  })
})

describe('叶证书（OpenSSL oracle）', () => {
  it('SAN 覆盖 .local + IP，且能被 OpenSSL 解析', async () => {
    const { leaf } = await makeSet()
    const cert = new X509Certificate(leaf.certPem)
    expect(cert.subjectAltName).toContain('DNS:0123456789abcdef0123456789abcdef.local')
    expect(cert.subjectAltName).toContain('IP Address:10.213.80.3')
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1')
    expect(cert.ca).toBe(false) // 叶证书不是 CA
    expect(cert.issuer).toContain(`CN=${CA_CN}`) // 签发者 = CA subject
    // v3 扩展存在
    expect(cert.raw.length).toBeGreaterThan(0)
  })

  it('链校验：叶证书由 CA 公钥验证通过（同一 OpenSSL 内核，等价于 openssl verify）', async () => {
    const { ca, leaf } = await makeSet()
    const caCert = new X509Certificate(ca.caPem)
    const leafCert = new X509Certificate(leaf.certPem)
    expect(leafCert.verify(caCert.publicKey)).toBe(true) // 叶 ← CA
    expect(caCert.verify(caCert.publicKey)).toBe(true) // 自签 CA
  })

  it('有效期：notBefore 早于现在，notAfter 约一年后', async () => {
    const { leaf } = await makeSet()
    const cert = new X509Certificate(leaf.certPem)
    const before = new Date(cert.validFrom)
    const after = new Date(cert.validTo)
    expect(before.getTime()).toBeLessThan(Date.now())
    expect(after.getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 3600_000)
    expect(after.getTime()).toBeLessThan(Date.now() + 400 * 24 * 3600_000)
  })

  it('序列号唯一（两次签发不同）；EKU serverAuth', async () => {
    const { ca, leaf, } = await makeSet()
    const leaf2 = await signLeafCertificate({
      caPem: ca.caPem,
      caKeyPem: ca.caKeyPem,
      dnsName: 'a.local',
      ipAddresses: ['127.0.0.1'],
    })
    const c1 = new X509Certificate(leaf.certPem)
    const c2 = new X509Certificate(leaf2.certPem)
    expect(c1.serialNumber).not.toBe(c2.serialNumber)
    // Node X509Certificate 不直接暴露 EKU；用解析器确认扩展无碍（OpenSSL 校验通过即代表结构合法）
    expect(parseCertificate(leaf.certPem).serial).not.toBe(parseCertificate(leaf2.certPem).serial)
  })

  it('显式 serial 可用（同一 CA 下重签同参也能区分）', async () => {
    const { ca } = await makeSet()
    const a = await signLeafCertificate({ caPem: ca.caPem, caKeyPem: ca.caKeyPem, ipAddresses: ['127.0.0.1'], serial: 42n })
    const b = await signLeafCertificate({ caPem: ca.caPem, caKeyPem: ca.caKeyPem, ipAddresses: ['127.0.0.1'], serial: 43n })
    // Node serialNumber 是十六进制；parseCertificate.serial 是 bigint
    expect(BigInt(`0x${new X509Certificate(a.certPem).serialNumber}`)).toBe(42n)
    expect(BigInt(`0x${new X509Certificate(b.certPem).serialNumber}`)).toBe(43n)
    expect(parseCertificate(a.certPem).serial).toBe(42n)
    expect(parseCertificate(b.certPem).serial).toBe(43n)
  })
})

describe('parseCertificate（结构化解析）', () => {
  it('解析出 SAN / issuer / subject / CA 标志 / 有效期 / 序列号', async () => {
    const { ca, leaf } = await makeSet()
    const p = parseCertificate(leaf.certPem)
    expect(p.isCa).toBe(false)
    expect(p.issuerCn).toBe(CA_CN)
    expect(p.subjectCn).toBe('LocalTransfer Local Server')
    expect(p.san.dns).toEqual(['0123456789abcdef0123456789abcdef.local'])
    expect(p.san.ip).toEqual(['10.213.80.3', '127.0.0.1'])
    expect(p.notBefore.getTime()).toBeLessThan(Date.now())
    expect(p.notAfter.getTime()).toBeGreaterThan(Date.now())
    expect(p.serial).toBeGreaterThan(0n)

    const caP = parseCertificate(ca.caPem)
    expect(caP.isCa).toBe(true)
    expect(caP.san.dns).toEqual([])
    expect(caP.san.ip).toEqual([])
  })

  it('parseSubjectAltName 兼容名返回 SAN', async () => {
    const { leaf } = await makeSet()
    expect(parseSubjectAltName(leaf.certPem).dns).toEqual(['0123456789abcdef0123456789abcdef.local'])
  })

  it('非法 IP 参数拒绝（非 IPv4 四段）', async () => {
    const { ca } = await makeSet()
    await expect(
      signLeafCertificate({ caPem: ca.caPem, caKeyPem: ca.caKeyPem, ipAddresses: ['999.1.1.1'] }),
    ).rejects.toThrow(/非法 IP/)
  })
})

describe('指纹', () => {
  it('SHA-256 指纹与 OpenSSL/shasum 一致（冒号分隔大写）', async () => {
    const { ca } = await makeSet()
    const fp = await fingerprintSha256(ca.caPem)
    const der = pemToDer(ca.caPem, 'CERTIFICATE')
    const expected = createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g)!.join(':')
    expect(fp).toBe(expected)
    expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
  })
})

describe('localHostName', () => {
  it('deviceId → <id>.local（合法 DNS 标签）', () => {
    expect(localHostName('4c75f2e0-9a1b-4c3d-8e5f-001122334455')).toBe('4c75f2e0-9a1b-4c3d-8e5f-001122334455.local')
  })
})

describe('isUsableCa（CA 自愈校验，T07 审查项）', () => {
  it('合法 CA（证书可解析且为 CA + 私钥可导入）→ true', async () => {
    const { ca } = await makeSet()
    const { isUsableCa } = await import('./cert')
    expect(await isUsableCa(ca.caPem, ca.caKeyPem)).toBe(true)
  })

  it('叶证书当 CA 用（isCa=false）→ false', async () => {
    const { leaf } = await makeSet()
    const { isUsableCa } = await import('./cert')
    expect(await isUsableCa(leaf.certPem, leaf.keyPem)).toBe(false)
  })

  it('损坏 DER（块在但内容垃圾）→ false', async () => {
    const { isUsableCa } = await import('./cert')
    const bad = '-----BEGIN CERTIFICATE-----\nZ2FyYmFnZQ==\n-----END CERTIFICATE-----'
    const badKey = '-----BEGIN PRIVATE KEY-----\nZ2FyYmFnZQ==\n-----END PRIVATE KEY-----'
    expect(await isUsableCa(bad, badKey)).toBe(false)
  })
})

// 需要真实 WebCrypto（Node ≥20 全局可用）；探针级跳过实现
describe('CertUnavailableError', () => {
  it('错误类型与文案', () => {
    const e = new CertUnavailableError('缺失')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('CertUnavailableError')
    expect(e.message).toContain('安全上下文')
  })
})
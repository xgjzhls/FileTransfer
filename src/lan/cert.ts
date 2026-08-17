/**
 * 本地信令服务器证书设施（ADR-0009 决策 4 / T07）—— 纯 TS + WebCrypto，无 @capacitor 依赖。
 *
 * 机制（T07 spike 2026-08-17 拍板，见 .scratch/lan-discovery/issues/T07 与 ADR-0009 决策 4 注释）：
 * - CA 由 app 首次启动时在 WKWebView 内生成（ECDSA P-256）并持久化（CA 不变 →
 *   桌面浏览器只信任一次，永不需要重信任）
 * - 叶证书每次启动 / 网络变更自动重签：SAN = `DNS:<deviceId>.local` + 当前接口 IP + 127.0.0.1
 *   —— `.local` 使 DHCP 换 IP 免重签（macOS 已验证 Chrome 解析 .local）；IP 路径重输地址即可
 * - 桌面一次性信任脚本经 `curl -k https://<ip>:<port>/ca.crt` 取 CA → 校验 SHA-256 指纹
 *   （fingerprintSha256 生成、UI 显示）→ `security add-trusted-cert` / `certutil`
 *
 * X.509 手工构建（RFC 5280，ECDSA-with-SHA256 / P-256）：
 * - 本模块是 Swift/Java 原生侧 **PEM 消费者**（原生只管 SecIdentity / KeyManager），
 *   证书生成全部在 JS（WebCrypto：generateKey / exportKey pkcs8+spki / subtle.sign）
 * - Node ≥20 / 现代浏览器（含 WKWebView capacitor://localhost secure context）均有 crypto.subtle；
 *   非安全上下文调用抛 CertUnavailableError
 *
 * 验证：cert.test.ts 用 Node `crypto.X509Certificate`（OpenSSL 内核）校验 CA/叶链、
 * SAN、CA 标志、有效期、指纹 —— 与原生 TLS 栈（iOS/Android）同一格式兼容性基准。
 */

/** 证书设施不可用（非安全上下文 / WebCrypto 缺失） */
export class CertUnavailableError extends Error {
  constructor(detail: string) {
    super(`证书设施不可用（需要安全上下文 + WebCrypto）：${detail}`)
    this.name = 'CertUnavailableError'
  }
}

/** 叶证书 SAN 里的 `.local` 主机名（= deviceId，UUID 小写十六进制 → 合法 DNS 标签） */
export function localHostName(deviceId: string): string {
  return `${deviceId}.local`
}

/** ECDSA P-256 密钥对（WebCrypto 导出形态） */
export interface EcKeyMaterial {
  /** PKCS#8 DER */
  privateKeyDer: Uint8Array
  /** SubjectPublicKeyInfo DER */
  publicKeySpki: Uint8Array
}

export interface SigningAuthority {
  /** CA 证书 PEM（桌面信任对象） */
  caPem: string
  /** CA 私钥 PEM（PKCS#8；仅 app 内持久化） */
  caKeyPem: string
}

export interface LeafCertificate {
  /** 叶证书 PEM（SAN 覆盖 .local + 当前 IP） */
  certPem: string
  /** 叶私钥 PEM（PKCS#8） */
  keyPem: string
}

export interface SignLeafOptions {
  caPem: string
  caKeyPem: string
  /** SAN DNS 名（如 `<deviceId>.local`；省略 = 无 DNS SAN） */
  dnsName?: string
  /** SAN IP 列表（如当前各接口 IP + 127.0.0.1） */
  ipAddresses: string[]
  /** 证书序列号（缺省随机 8 字节正数；同一 CA 下必须唯一） */
  serial?: bigint
  /** subject/issuer 通用名（缺省 = LocalTransfer Local Server；浏览器只认 SAN，CN 仅显示） */
  commonName?: string
}

/** 证书结构化的轻量解析结果（UI 展示 + 测试断言） */
export interface ParsedCertificate {
  serial: bigint
  issuerCn: string
  subjectCn: string
  notBefore: Date
  notAfter: Date
  isCa: boolean
  san: { dns: string[]; ip: string[] }
}

// ---------------------------------------------------------------------------
// WebCrypto 访问（安全上下文断言）
// ---------------------------------------------------------------------------

function getSubtle(): SubtleCrypto {
  const cryptoObj = globalThis.crypto
  if (!cryptoObj?.subtle) {
    throw new CertUnavailableError('crypto.subtle 不存在（非 HTTPS/localhost 或环境不支持）')
  }
  return cryptoObj.subtle
}

/** 生成 ECDSA P-256 密钥对并导出（私钥 PKCS#8 / 公钥 SPKI） */
async function generateEcKey(): Promise<EcKeyMaterial> {
  const pair = await getSubtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const [pkcs8, spki] = await Promise.all([
    getSubtle().exportKey('pkcs8', pair.privateKey),
    getSubtle().exportKey('spki', pair.publicKey),
  ])
  return { privateKeyDer: new Uint8Array(pkcs8), publicKeySpki: new Uint8Array(spki) }
}

/** 导入 PKCS#8 私钥（EC，sign 用途）——TS7 下 Uint8Array<ArrayBufferLike> ≠ BufferSource，边界转一次 */
async function importEcPrivateKey(pkcs8Der: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey('pkcs8', pkcs8Der as unknown as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ])
}

/** ECDSA P-256 签名：WebCrypto 返回原始 r||s（各 32B）——须包成 DER ECDSA-Sig-Value 再嵌入证书 */
async function signEcdsaSha256(der: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  const raw = new Uint8Array(await getSubtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, der as unknown as BufferSource))
  // r/s 各 32 字节 → DER SEQUENCE { INTEGER r, INTEGER s }
  const r = raw.subarray(0, 32)
  const s = raw.subarray(32)
  return derSequence([derIntegerFromBytes(r), derIntegerFromBytes(s)])
}

// ---------------------------------------------------------------------------
// DER 编码（RFC 5280 所需子集）
// ---------------------------------------------------------------------------

function derLength(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n])
  const bytes: number[] = []
  let v = n
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v >>= 8
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes])
}

function derTlv(tag: number, content: Uint8Array): Uint8Array {
  return new Uint8Array([tag, ...derLength(content.length), ...content])
}

function derSequence(items: Uint8Array[]): Uint8Array {
  return derTlv(0x30, concatBytes(items))
}

function derSet(items: Uint8Array[]): Uint8Array {
  return derTlv(0x31, concatBytes(items))
}

/** INTEGER：大端字节；首位 ≥0x80 时补 0x00 保证正数 */
function derInteger(value: bigint | number): Uint8Array {
  let hex = value.toString(16)
  if (hex.length % 2) hex = `0${hex}`
  let bytes = hexToBytes(hex === '' ? '00' : hex)
  if (bytes.length === 0) bytes = new Uint8Array([0])
  if (bytes[0] >= 0x80) bytes = new Uint8Array([0, ...bytes])
  return derTlv(0x02, bytes)
}

function derIntegerFromBytes(bytes: Uint8Array): Uint8Array {
  let out = bytes
  if (out.length === 0 || out[0] >= 0x80) out = new Uint8Array([0, ...bytes])
  return derTlv(0x02, out)
}

function derOctetString(bytes: Uint8Array): Uint8Array {
  return derTlv(0x04, bytes)
}

/** BIT STRING：首字节 = 末尾未用位数，随后为位流（MSB 优先） */
function derBitString(bitBytes: Uint8Array, unusedBits = 0): Uint8Array {
  return derTlv(0x03, new Uint8Array([unusedBits, ...bitBytes]))
}

function derBoolean(v: boolean): Uint8Array {
  return new Uint8Array([0x01, 0x01, v ? 0xff : 0x00])
}

function derNull(): Uint8Array {
  return new Uint8Array([0x05, 0x00])
}

/** OID：首字节 = 40*arc0 + arc1，其余 base-128 分段 */
function derOid(oid: readonly number[]): Uint8Array {
  const body: number[] = []
  const pushBase128 = (v: number) => {
    const stack: number[] = [v & 0x7f]
    v >>= 7
    while (v > 0) {
      stack.unshift(0x80 | (v & 0x7f))
      v >>= 7
    }
    body.push(...stack)
  }
  pushBase128(40 * oid[0] + oid[1])
  for (const arc of oid.slice(2)) pushBase128(arc)
  return derTlv(0x06, new Uint8Array(body))
}

function derUtcTime(date: Date): Uint8Array {
  const pad = (n: number) => String(n).padStart(2, '0')
  const s =
    pad(date.getUTCFullYear() % 100) +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate()) +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    'Z'
  return derTlv(0x17, new TextEncoder().encode(s))
}

function derUtf8String(s: string): Uint8Array {
  return derTlv(0x0c, new TextEncoder().encode(s))
}

/** 上下文标签 [n]（constructed 由构造器/显式传参决定） */
function derContext(tag: number, content: Uint8Array, constructed = true): Uint8Array {
  const base = 0x80 | tag
  return derTlv(constructed ? base | 0x20 : base, content)
}

// ---------------------------------------------------------------------------
// DER 读取（TLV 游标；X.509 轻量解析用）
// ---------------------------------------------------------------------------

interface Tlv {
  tag: number
  /** 载荷（不含头） */
  value: Uint8Array
  /** 载荷结束位置（下一 TLV 起点） */
  next: number
}

class DerReader {
  private readonly der: Uint8Array
  private pos = 0
  constructor(der: Uint8Array) {
    this.der = der
  }
  read(): Tlv {
    if (this.pos >= this.der.length) throw new Error('DER 越界')
    const tag = this.der[this.pos]
    this.pos += 1
    let len = this.der[this.pos]
    this.pos += 1
    if (len >= 0x80) {
      const n = len & 0x7f
      len = 0
      for (let i = 0; i < n; i++) {
        len = len * 256 + this.der[this.pos]
        this.pos += 1
      }
    }
    const value = this.der.subarray(this.pos, this.pos + len)
    const next = this.pos + len
    this.pos = next
    return { tag, value, next }
  }
  /** 读取并断言为指定 tag 的 TLV */
  expect(tag: number): Tlv {
    const t = this.read()
    if (t.tag !== tag) throw new Error(`DER 期望 tag 0x${tag.toString(16)}，实得 0x${t.tag.toString(16)}`)
    return t
  }
  atEnd(): boolean {
    return this.pos >= this.der.length
  }
}

// ---------------------------------------------------------------------------
// X.509 常量
// ---------------------------------------------------------------------------

const OID = {
  cN: [2, 5, 4, 3],
  subjectAltName: [2, 5, 29, 17],
  basicConstraints: [2, 5, 29, 19],
  keyUsage: [2, 5, 29, 15],
  extKeyUsage: [2, 5, 29, 37],
  serverAuth: [1, 3, 6, 1, 5, 5, 7, 3, 1],
  ecdsaWithSha256: [1, 2, 840, 10045, 4, 3, 2],
} as const

/** OID 内容十六进制（不含 06 tag/长度头——与解析端 expect(0x06).value 对齐） */
function oidContentHex(oid: readonly number[]): string {
  const tlv = derOid(oid)
  return bytesToHex(tlv.subarray(2)) // 跳过 0x06 + 长度
}

const OID_HEX = {
  cN: oidContentHex(OID.cN),
  subjectAltName: oidContentHex(OID.subjectAltName),
  basicConstraints: oidContentHex(OID.basicConstraints),
} as const

/** AlgorithmIdentifier：ecdsa-with-SHA256 + NULL 参数 */
function signatureAlgorithm(): Uint8Array {
  return derSequence([derOid(OID.ecdsaWithSha256), derNull()])
}

/** Name：RDN 集（单个 CN = UTF8String；浏览器只认 SAN，CN 仅显示） */
function nameDer(commonName: string): Uint8Array {
  return derSequence([derSet([derSequence([derOid(OID.cN), derUtf8String(commonName)])])])
}

/** subjectAltName 扩展值：SEQUENCE 内 [2] dNSName / [7] iPAddress */
function sanExtensionValue(dnsName: string | undefined, ipAddresses: string[]): Uint8Array {
  const entries: Uint8Array[] = []
  if (dnsName) entries.push(derContext(2, new TextEncoder().encode(dnsName), false)) // [2] 隐式 IA5String（值 = 裸字符串）
  for (const ip of ipAddresses) {
    const bytes = ipToBytes(ip)
    if (bytes === null) throw new Error(`非法 IP 地址：${ip}`)
    entries.push(derContext(7, bytes, false)) // [7] 隐式 OCTET STRING（值 = 4 字节）
  }
  return derSequence(entries)
}

/** basicConstraints 扩展值：CA 证书 cA=TRUE；叶证书空 SEQUENCE（= 非 CA） */
function basicConstraintsValue(isCa: boolean): Uint8Array {
  return derSequence(isCa ? [derBoolean(true)] : [])
}

/** keyUsage：CA = keyCertSign|cRLSign；叶 = digitalSignature */
function keyUsageValue(isCa: boolean): Uint8Array {
  return isCa ? derBitString(new Uint8Array([0b0000_0110]), 1) : derBitString(new Uint8Array([0b1000_0000]), 7)
}

/** extendedKeyUsage：serverAuth */
function extKeyUsageValue(): Uint8Array {
  return derSequence([derOid(OID.serverAuth)])
}

/** 扩展集合 [3] EXPLICIT Extensions */
function extensionsDer(exts: Array<{ oid: readonly number[]; critical: boolean; value: Uint8Array }>): Uint8Array {
  const list = exts.map((e) =>
    derSequence([derOid(e.oid), ...(e.critical ? [derBoolean(true)] : []), derOctetString(e.value)]),
  )
  return derContext(3, derSequence(list))
}

/** 时间戳：notBefore = 现在 - 1h（时钟偏差余量），notAfter = +1 年 */
function validityDer(): { notBefore: Date; notAfter: Date; der: Uint8Array } {
  const notBefore = new Date(Date.now() - 3600_000)
  const notAfter = new Date(Date.now() + 365 * 24 * 3600_000)
  return { notBefore, notAfter, der: derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]) }
}

/** 随机 8 字节序列号（首位清高位，保证正数） */
function randomSerial(): bigint {
  const bytes = new Uint8Array(8)
  getSubtle() // 及早断言安全上下文
  globalThis.crypto.getRandomValues(bytes)
  bytes[0] &= 0x7f
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return BigInt(`0x${hex}`)
}

// ---------------------------------------------------------------------------
// 构建与签名
// ---------------------------------------------------------------------------

/**
 * 构建 TBSCertificate（RFC 5280 §4.1.2）并用签名密钥签发 → 完整证书 DER。
 * isCa=true 时即自签 CA（signingKey = 本证书公钥对应私钥）。
 */
async function buildSignedCertificate(input: {
  /** subject CN（叶 = 本证书名；CA = CA 名） */
  subjectCn: string
  /** issuer CN（叶 = CA 的 CN；自签 = 自身 CN） */
  issuerCn: string
  serial: bigint
  subjectPublicKeySpki: Uint8Array
  signingKey: CryptoKey
  isCa: boolean
  dnsName?: string
  ipAddresses: string[]
}): Promise<Uint8Array> {
  const validity = validityDer()
  const extensions = extensionsDer([
    { oid: OID.subjectAltName, critical: false, value: sanExtensionValue(input.dnsName, input.ipAddresses) },
    { oid: OID.basicConstraints, critical: input.isCa, value: basicConstraintsValue(input.isCa) },
    { oid: OID.keyUsage, critical: true, value: keyUsageValue(input.isCa) },
    { oid: OID.extKeyUsage, critical: false, value: extKeyUsageValue() },
  ])
  const tbs = derSequence([
    derContext(0, derInteger(2n)), // version = v3
    derInteger(input.serial),
    signatureAlgorithm(),
    nameDer(input.issuerCn), // issuer（叶 = CA subject；自签 CA = 自身）
    validity.der,
    nameDer(input.subjectCn), // subject
    input.subjectPublicKeySpki, // subjectPublicKeyInfo（WebCrypto spki 导出本身即 SEQUENCE，原样嵌入）
    extensions,
  ])
  const signature = await signEcdsaSha256(tbs, input.signingKey)
  return derSequence([tbs, signatureAlgorithm(), derBitString(signature)])
}

/**
 * 生成自签 CA（ECDSA P-256；basicConstraints CA:TRUE + keyCertSign）。
 * CA 私钥只应被 app 持久化（机制核心：CA 不变 → 桌面信任一次，换 IP 免重信任）。
 */
export async function createSigningAuthority(commonName = 'LocalTransfer CA'): Promise<SigningAuthority> {
  const key = await generateEcKey()
  const signingKey = await importEcPrivateKey(key.privateKeyDer)
  const der = await buildSignedCertificate({
    subjectCn: commonName,
    issuerCn: commonName,
    serial: randomSerial(),
    subjectPublicKeySpki: key.publicKeySpki,
    signingKey,
    isCa: true,
    ipAddresses: [],
  })
  return { caPem: derToPem(der, 'CERTIFICATE'), caKeyPem: derToPem(key.privateKeyDer, 'PRIVATE KEY') }
}

/**
 * 为本地 WSS 服务器生成叶证书（SAN = dnsName + 给定 IP），用现有 CA 私钥签发。
 * 每次启动 / 网络变更重签 —— 证书不过期、IP 自动覆盖（CA 不变，桌面无需重信任）。
 */
export async function signLeafCertificate(options: SignLeafOptions): Promise<LeafCertificate> {
  const { caPem, caKeyPem, dnsName, ipAddresses, commonName } = options
  const serial = options.serial ?? randomSerial()
  const caSigningKey = await importEcPrivateKey(pemToDer(caKeyPem, 'PRIVATE KEY'))
  const { subjectCn: caSubjectCn } = parseCertificate(caPem) // issuer = CA subject（链校验依据）
  const leafKey = await generateEcKey()
  const leafSigningKey = await importEcPrivateKey(leafKey.privateKeyDer)
  void leafSigningKey // 叶私钥仅用于对外导出（TLS 终止在原生侧）；证书签名用 CA 私钥
  const der = await buildSignedCertificate({
    subjectCn: commonName ?? 'LocalTransfer Local Server',
    issuerCn: caSubjectCn,
    serial,
    subjectPublicKeySpki: leafKey.publicKeySpki,
    signingKey: caSigningKey,
    isCa: false,
    dnsName,
    ipAddresses,
  })
  return { certPem: derToPem(der, 'CERTIFICATE'), keyPem: derToPem(leafKey.privateKeyDer, 'PRIVATE KEY') }
}

// ---------------------------------------------------------------------------
// PEM / 指纹 / SAN 解析（UI 显示 + 桌面信任脚本校验 + 测试）
// ---------------------------------------------------------------------------

/** DER → PEM（64 列换行） */
export function derToPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der)
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`
}

/** PEM → DER（label 严格匹配；块缺失抛错） */
export function pemToDer(pem: string, label: string): Uint8Array {
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`)
  const m = pem.match(re)
  if (!m) throw new Error(`PEM 不含 ${label} 块`)
  return base64ToBytes(m[1].replace(/\s+/g, ''))
}

/** 证书 SHA-256 指纹（冒号分隔大写十六进制；桌面信任脚本据此校验下载的 CA） */
export async function fingerprintSha256(certPem: string): Promise<string> {
  const der = pemToDer(certPem, 'CERTIFICATE')
  const digest = new Uint8Array(await getSubtle().digest('SHA-256', der as unknown as BufferSource))
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':')
}

/**
 * 结构化解析证书（SAN / issuer / subject / CA 标志 / 有效期 / 序列号）。
 * 供 UI 展示与测试断言；解析失败抛错（证书由本模块生成，格式应始终合法）。
 */
export function parseCertificate(certPem: string): ParsedCertificate {
  const reader = new DerReader(pemToDer(certPem, 'CERTIFICATE'))
  const cert = reader.expect(0x30) // Certificate
  // TBSCertificate = 证书内容的首个子元素
  const tbsTlv = new DerReader(cert.value).expect(0x30)
  const tbsReader = new DerReader(tbsTlv.value)
  tbsReader.expect(0xa0) // [0] version（explicit）
  const serial = readInteger(tbsReader)
  tbsReader.expect(0x30) // signature AlgorithmIdentifier
  const issuerCn = readCommonName(tbsReader)
  const validityTlv = tbsReader.expect(0x30) // Validity（消费该元素）
  const validity = readValidityValue(validityTlv.value)
  const subjectCn = readCommonName(tbsReader)
  tbsReader.expect(0x30) // subjectPublicKeyInfo
  // 后续：issuerUniqueID / subjectUniqueID（非定义不含）→ extensions [3]
  let san: { dns: string[]; ip: string[] } = { dns: [], ip: [] }
  let isCa = false
  while (!tbsReader.atEnd()) {
    const t = tbsReader.read()
    // 上下文类 = 高二位 10（constructed 位不参与类判定；[0]/[3] 为 0xa0/0xa3）
    if ((t.tag & 0xc0) === 0x80) {
      if ((t.tag & 0x1f) === 3) {
        // [3] EXPLICIT Extensions：值 = Extensions SEQUENCE（含列表头），须再解一层
        const exts = new DerReader(new DerReader(t.value).expect(0x30).value)
        while (!exts.atEnd()) {
          const ext = exts.expect(0x30).value
          const er = new DerReader(ext)
          const oidHex = bytesToHex(er.expect(0x06).value)
          // 扩展结构 = SEQUENCE { OID, [critical BOOLEAN], extnValue OCTET STRING }
          const next = er.read()
          let extnValue: Uint8Array
          if (next.tag === 0x01) {
            // critical 标志存在 → 其后才是 OCTET STRING
            extnValue = er.expect(0x04).value
          } else {
            extnValue = next.value
          }
          if (oidHex === OID_HEX.subjectAltName) {
            san = parseSan(extnValue)
          } else if (oidHex === OID_HEX.basicConstraints) {
            const bc = new DerReader(extnValue)
            const seq = bc.expect(0x30).value
            const bcr = new DerReader(seq)
            if (!bcr.atEnd()) {
              const first = bcr.read()
              if (first.tag === 0x01) isCa = first.value[0] !== 0
            }
          }
        }
      }
    }
  }
  return { serial, issuerCn, subjectCn, notBefore: validity.notBefore, notAfter: validity.notAfter, isCa, san }
}

/** 兼容名：只取 SAN（UI 展示「本机证书含哪些地址」） */
export function parseSubjectAltName(certPem: string): { dns: string[]; ip: string[] } {
  return parseCertificate(certPem).san
}

/**
 * 校验持久化的 CA 是否可用：证书可解析且为 CA + 私钥可导入（WebCrypto 完整 DER 校验）。
 * 任一失败 → 调用方应重新生成（CA 损坏自愈路径，T07 审查项）。
 */
export async function isUsableCa(caPem: string, caKeyPem: string): Promise<boolean> {
  try {
    const parsed = parseCertificate(caPem)
    if (!parsed.isCa) return false
    await importEcPrivateKey(pemToDer(caKeyPem, 'PRIVATE KEY'))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

function readInteger(r: DerReader): bigint {
  const v = r.expect(0x02).value
  let hex = ''
  for (const b of v) hex += b.toString(16).padStart(2, '0')
  return BigInt(`0x${hex}`)
}

/** 读取 RDN 集里的 CN 值（UTF8String）；缺失返回空串 */
function readCommonName(r: DerReader): string {
  const name = r.expect(0x30).value
  const nr = new DerReader(name)
  let cn = ''
  while (!nr.atEnd()) {
    const rdn = nr.expect(0x31).value
    const rr = new DerReader(rdn)
    const attrs = rr.expect(0x30).value
    const ar = new DerReader(attrs)
    const oidHex = bytesToHex(ar.expect(0x06).value)
    const value = ar.read()
    if (oidHex === OID_HEX.cN && value.tag === 0x0c) {
      cn = new TextDecoder('utf8').decode(value.value)
    }
  }
  return cn
}

function readValidityValue(value: Uint8Array): { notBefore: Date; notAfter: Date } {
  const vr = new DerReader(value)
  const notBefore = readUtcTime(vr)
  const notAfter = readUtcTime(vr)
  return { notBefore, notAfter }
}

function readUtcTime(r: DerReader): Date {
  const v = r.expect(0x17).value
  const s = new TextDecoder('latin1').decode(v)
  if (!/^\d{12}Z$/.test(s)) throw new Error(`非法 UTCTime：${s}`)
  const yy = Number(s.slice(0, 2))
  const year = yy >= 50 ? 1900 + yy : 2000 + yy
  return new Date(
    Date.UTC(year, Number(s.slice(2, 4)) - 1, Number(s.slice(4, 6)), Number(s.slice(6, 8)), Number(s.slice(8, 10)), Number(s.slice(10, 12))),
  )
}

function parseSan(extnValue: Uint8Array): { dns: string[]; ip: string[] } {
  const dns: string[] = []
  const ip: string[] = []
  const names = new DerReader(extnValue).expect(0x30).value // GeneralNames SEQUENCE 内容
  const r = new DerReader(names)
  while (!r.atEnd()) {
    const t = r.read()
    const tagNum = t.tag & 0x1f
    if (tagNum === 2) dns.push(new TextDecoder('latin1').decode(t.value))
    else if (tagNum === 7) {
      const ipStr = bytesToIp(t.value)
      if (ipStr) ip.push(ipStr)
    }
  }
  return { dns, ip }
}

// ---------------------------------------------------------------------------
// 字节工具
// ---------------------------------------------------------------------------

function concatBytes(items: Uint8Array[]): Uint8Array {
  const total = items.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const a of items) {
    out.set(a, off)
    off += a.length
  }
  return out
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

function bytesToIp(bytes: Uint8Array): string | null {
  if (bytes.length !== 4) return null
  return Array.from(bytes).join('.')
}

function ipToBytes(ip: string): Uint8Array | null {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null
  return new Uint8Array(parts)
}
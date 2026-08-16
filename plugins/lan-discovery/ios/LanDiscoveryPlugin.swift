import Capacitor
import Network

// MARK: - 错误

enum LanDiscoveryError: LocalizedError {
    case badParams(String)
    case listenerCreateFailed

    var errorDescription: String? {
        switch self {
        case .badParams(let detail): return "参数错误：\(detail)"
        case .listenerCreateFailed: return "创建广播监听器失败"
        }
    }
}

/// 局域网发现插件（ADR-0009 / T02）：mDNS 广告 + 浏览（iOS Network.framework）。
///
/// 契约（SPEC §5.5；API 已对照 iOS 18.5 SDK swiftinterface 核实）：
/// - 服务类型 `_localtranfer._tcp`；TXT（RFC 6763）name/id/kind/port/ver，UTF-8 ≤255B
///   （JS 侧先校验，原生侧兜底拒绝超长值）
/// - 广告用 `NWListener` + `service` 属性：**iOS SDK 没有 NWAdvertiser 类**，Apple 文档的
///   广告 API 即 listener 的 service 属性（TN3213 佐证）。监听临时端口、不接受连接
///   （newConnectionHandler 直接 cancel），仅用于 Bonjour 注册
/// - Bonjour 实例名 = deviceId（稳定唯一，避免重名冲突 + 自动改名后缀）；显示名在 TXT["name"]
/// - 浏览：`NWBrowser(.bonjour)`；消失检测 = browseResultsChangedHandler 的 .removed 变更
///   （mDNS TTL 默认 120s 内对方未刷新即消失）；JS 侧另有 last-seen TTL 兜底（registry.ts）
/// - 权限：首次广告/浏览触发本地网络授权弹窗（**必须** Info.plist 配
///   NSLocalNetworkUsageDescription，否则访问本地网络直接崩溃）；拒绝后 listener/browser
///   进入 .failed（NWError.dns kDNSServiceErr_PolicyDenied = -65570，或 posix EPERM/EACCES）→
///   置 permissionDenied + 通知 JS（permissionDenied 事件 + getStatus()）
/// - 前后台（生命周期记录）：退后台 = iOS 挂起，mDNS 自动暂停 → 显式 cancel 干净停；
///   回前台按上次参数重启（willResignActive / didBecomeActive 监听）
///
/// 注册：cap sync 扫描本包 ios/** 里的 `@objc(CAPLanDiscoveryPlugin)` 写入
/// packageClassList 自动注册；JS 侧暴露为 Capacitor.Plugins.LanDiscovery。
@objc(CAPLanDiscoveryPlugin)
public class CAPLanDiscoveryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CAPLanDiscoveryPlugin"
    public let jsName = "LanDiscovery"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "startAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopAdvertising", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startBrowsing", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopBrowsing", returnType: CAPPluginReturnPromise),
        // T04 原生信令通道（ADR-0009）：TCP 监听/连接 + SDP 交换 + 竞态消解
        CAPPluginMethod(name: "startSignalingServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSignalingServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMessage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    ]

    static let serviceType = "_localtranfer._tcp"

    /// mDNS 策略拒绝错误码（kDNSServiceErr_PolicyDenied，dns_sd.h）
    private static let policyDeniedCode: Int32 = -65570

    private let netQueue = DispatchQueue(label: "local.transfer.lan-discovery.net")

    // 以下状态仅在主线程读写：插件方法由 Capacitor 在主线程调用，Network 回调
    // 一律 hop 回主线程再处理（见 stateUpdateHandler / browseResultsChangedHandler）
    private var advertiser: NWListener?
    private var browser: NWBrowser?
    private var advertTxt: NWTXTRecord?
    private var advertServiceName: String?
    private var permissionDenied = false
    /// 前台期间 JS 是否要求过广告/浏览（退后台后 resume 据此重启）
    private var wasAdvertising = false
    private var wasBrowsing = false

    private var backgroundObserver: NSObjectProtocol?
    private var foregroundObserver: NSObjectProtocol?

    // MARK: 原生信令通道（T04）状态 —— 全部主线程读写（连接回调一律 main 队列）

    /// 信令服务器（统一监听器：TCP 接受连接 + Bonjour 广告，SRV 端口 = 监听端口 = TXT port）
    private var signalingServer: NWListener?
    private var signalingServerPort: UInt16?
    /// 本机 deviceId（startSignalingServer 设置；connect 携带的 myId 兜底更新）—— 竞态判定用
    private var selfDeviceId: String?
    /// peerId → 活跃通道（每对端恰好一条；竞态收敛后）
    private var channels: [String: SignalingConnContext] = [:]
    /// peerId → 连接建立中的出向连接（TCP 连上后发 hello 再激活）
    private var outboundPending: [String: SignalingConnContext] = [:]
    /// peerId → connect 超时（10s 未 ready 即失败）
    private var connectTimeouts: [String: DispatchWorkItem] = [:]
    /// startSignalingServer 的待结算 call（listener .ready/.failed 时 resolve，恰一次）
    private var pendingServerCall: CAPPluginCall?

    public override func load() {
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.suspend()
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.resume()
        }
    }

    deinit {
        if let backgroundObserver {
            NotificationCenter.default.removeObserver(backgroundObserver)
        }
        if let foregroundObserver {
            NotificationCenter.default.removeObserver(foregroundObserver)
        }
    }

    // MARK: - startAdvertising

    @objc func startAdvertising(_ call: CAPPluginCall) {
        if advertiser != nil {
            call.resolve(["ok": true]) // 幂等：已在广播视为成功
            return
        }
        guard let params = readDeviceParams(call) else { return } // 非法参数已在内部 reject
        guard let txt = makeTxtRecord(params) else {
            call.reject(LanDiscoveryError.badParams("TXT 值超过 255 字节（UTF-8）").localizedDescription)
            return
        }
        // 实例名 = deviceId：稳定唯一；TXT["name"] 才是展示名
        guard let listener = makeAdvertiser(txt: txt, serviceName: params.id) else {
            call.reject(LanDiscoveryError.listenerCreateFailed.localizedDescription)
            return
        }

        advertiser = listener
        advertTxt = txt
        advertServiceName = params.id
        wasAdvertising = true
        call.resolve(["ok": true])
    }

    @objc func stopAdvertising(_ call: CAPPluginCall) {
        advertiser?.cancel()
        advertiser = nil
        wasAdvertising = false
        call.resolve(["ok": true])
    }

    // MARK: - startBrowsing

    @objc func startBrowsing(_ call: CAPPluginCall) {
        if permissionDenied {
            call.resolve(["ok": false, "permissionDenied": true, "error": "LOCAL_NETWORK_DENIED"])
            return
        }
        if browser != nil {
            call.resolve(["ok": true]) // 幂等：已在浏览视为成功
            return
        }
        browser = makeBrowser()
        wasBrowsing = true
        call.resolve(["ok": true])
    }

    @objc func stopBrowsing(_ call: CAPPluginCall) {
        browser?.cancel()
        browser = nil
        wasBrowsing = false
        call.resolve(["ok": true])
    }

    // MARK: - getStatus

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve([
            // 双模式：T02 旧广告 listener，或 T04 信令服务器挂的 Bonjour 服务
            "advertising": advertiser != nil || signalingServer != nil,
            "browsing": browser != nil,
            "permissionDenied": permissionDenied,
            "signaling": signalingServer != nil, // T04：信令服务器在监听
        ])
    }

    // MARK: - 状态处理

    private func handleAdvertState(_ state: NWListener.State) {
        switch state {
        case .ready:
            // 权限恢复（用户在设置里重开）后能正常广告 → 清除拒绝标记
            if permissionDenied { permissionDenied = false }
        case .failed(let error):
            handleNetworkError(error)
            advertiser = nil
        case .waiting:
            break // 等待网络/权限（可能随后 failed）
        case .setup, .cancelled:
            break
        }
    }

    private func handleBrowseState(_ state: NWBrowser.State) {
        switch state {
        case .ready:
            // 权限恢复（用户在设置里重开）后能正常浏览 → 清除拒绝标记
            if permissionDenied { permissionDenied = false }
        case .failed(let error):
            handleNetworkError(error)
            browser = nil
        case .waiting, .setup, .cancelled:
            break
        }
    }

    /// 浏览结果变化：.added/.changed → 重新上报（JS 侧 add/touch）；.removed → 消失
    private func handleBrowseChanges(_ changes: Set<NWBrowser.Result.Change>) {
        for change in changes {
            switch change {
            case .added(let result):
                emitDevice(result)
            case .changed(_, let new, _):
                emitDevice(new)
            case .removed(let result):
                emitDeviceLost(result)
            case .identical:
                break
            }
        }
    }

    private func handleNetworkError(_ error: NWError) {
        if looksLikeLocalNetworkDenied(error) {
            permissionDenied = true
            notifyListeners("permissionDenied", data: [:])
        }
    }

    /// 本地网络权限被拒：mDNS 策略拒绝（-65570）或 posix 权限错误
    private func looksLikeLocalNetworkDenied(_ error: NWError) -> Bool {
        switch error {
        case .dns(let code):
            return code == Self.policyDeniedCode
        case .posix(let code):
            return code == .EPERM || code == .EACCES
        case .tls:
            return false
        }
    }

    // MARK: - 事件上报

    private func emitDevice(_ result: NWBrowser.Result) {
        var txt: [String: String] = [:]
        if case .bonjour(let record) = result.metadata {
            txt = record.dictionary
        }
        guard let name = txt["name"], let id = txt["id"],
              let portStr = txt["port"], let port = UInt16(portStr),
              let ver = txt["ver"],
              ["phone", "tablet", "desktop"].contains(txt["kind"] ?? "") else {
            return // TXT 不完整/非法（如同名服务的其他 App）→ 忽略
        }
        let endpoint = result.endpoint
        let serviceName: String
        let domain: String
        if case .service(let svcName, _, let svcDomain, _) = endpoint {
            serviceName = svcName
            domain = svcDomain
        } else {
            serviceName = id
            domain = "local."
        }
        notifyListeners("deviceFound", data: [
            "id": id,
            "name": name,
            "kind": txt["kind"] ?? "",
            "port": Int(port),
            "ver": ver,
            "serviceName": serviceName,
            "domain": domain,
        ])
    }

    private func emitDeviceLost(_ result: NWBrowser.Result) {
        let id = extractId(from: result)
        notifyListeners("deviceLost", data: ["id": id])
    }

    /// TXT["id"] 优先（跨平台稳定）；缺失时退回实例名
    private func extractId(from result: NWBrowser.Result) -> String {
        if case .bonjour(let record) = result.metadata, let id = record.dictionary["id"] {
            return id
        }
        if case .service(let name, _, _, _) = result.endpoint {
            return name
        }
        return ""
    }

    // MARK: - 前后台

    /// 退后台：iOS 挂起会停 mDNS，显式 cancel 干净停（resume 按 was* 标志重启）
    private func suspend() {
        advertiser?.cancel()
        advertiser = nil
        browser?.cancel()
        browser = nil
    }

    private func resume() {
        if wasAdvertising, advertiser == nil, let txt = advertTxt, let name = advertServiceName {
            advertiser = makeAdvertiser(txt: txt, serviceName: name)
        }
        if wasBrowsing, browser == nil {
            browser = makeBrowser()
        }
    }

    // MARK: - 构造器（startAdvertising/startBrowsing 与 resume 共用）

    /// 创建并启动广告监听器（Bonjour 注册；不接受连接）
    private func makeAdvertiser(txt: NWTXTRecord, serviceName: String) -> NWListener? {
        guard let listener = try? NWListener(using: .tcp, on: .any) else { return nil }
        listener.service = NWListener.Service(
            name: serviceName, type: Self.serviceType, domain: nil, txtRecord: txt)
        listener.newConnectionHandler = { $0.cancel() } // 广告监听器不接受连接（信令端口在 T04）
        listener.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async { self?.handleAdvertState(state) }
        }
        listener.start(queue: netQueue)
        return listener
    }

    /// 创建并启动浏览器
    private func makeBrowser() -> NWBrowser {
        let browser = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: .tcp)
        browser.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async { self?.handleBrowseState(state) }
        }
        browser.browseResultsChangedHandler = { [weak self] _, changes in
            DispatchQueue.main.async { self?.handleBrowseChanges(changes) }
        }
        browser.start(queue: netQueue)
        return browser
    }

    // MARK: - 参数解析

    private struct DeviceParams {
        let name: String
        let id: String
        let kind: String
        let port: UInt16
        let ver: String
    }

    /// 解析并校验 startAdvertising 参数（schema 与 JS 侧 txt.ts 一致）；非法时 reject 并返回 nil
    private func readDeviceParams(_ call: CAPPluginCall) -> DeviceParams? {
        let name = call.getString("name") ?? ""
        let id = call.getString("id") ?? ""
        let kind = call.getString("kind") ?? ""
        let ver = call.getString("ver") ?? ""
        let port = call.getInt("port") ?? -1
        let validKinds: Set<String> = ["phone", "tablet", "desktop"]
        var problems: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("name") }
        if id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("id") }
        if !validKinds.contains(kind) { problems.append("kind") }
        if port < 1 || port > 65535 { problems.append("port") }
        if ver.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("ver") }
        guard problems.isEmpty else {
            call.reject(LanDiscoveryError.badParams(problems.joined(separator: ",")).localizedDescription)
            return nil
        }
        return DeviceParams(name: name, id: id, kind: kind, port: UInt16(port), ver: ver)
    }

    /// RFC 6763：值 UTF-8 ≤255B；超长返回 nil（JS 侧已校验，此处兜底）
    private func makeTxtRecord(_ params: DeviceParams) -> NWTXTRecord? {
        let fields: [(String, String)] = [
            ("name", params.name),
            ("id", params.id),
            ("kind", params.kind),
            ("port", String(params.port)),
            ("ver", params.ver),
        ]
        for (_, value) in fields where value.utf8.count > 255 {
            return nil
        }
        return NWTXTRecord(fields.reduce(into: [String: String]()) { $0[$1.0] = $1.1 })
    }

    // =========================================================================
    // 原生信令通道（T04，ADR-0009 决策 1）—— 信令「单协议多载体」的第三种载体
    // =========================================================================
    //
    // Wire 协议（与 channel.ts / Android 逐条对齐，T04 设计定稿）：
    // - 帧 = 4B 大端长度前缀 + UTF-8 JSON；上限 maxFrameBytes（超限 = 协议违规关连接）
    // - hello：发起方连上即发 {v:1,type:hello,id,session}，接收方不回
    // - signal：{v:1,type:signal,kind:offer|answer,sdp}（sdp = gzip+base64url，透明）
    // - TCP 断开 = 断线
    //
    // 竞态（两台同时发起）：低 deviceId 胜 —— 幸存连接 = 低 id 方发起的连接。
    // 激活点有两处（出向 ready 发完 hello / 入向收到 hello），两侧独立套同一规则收敛。
    //
    // 线程：所有连接回调在 main 队列（connection.start(queue: .main)），全部状态主线程读写；
    // listener 在 netQueue，其回调 hop 回 main（与 T02 广告/浏览同一纪律）。
    // 事件：peerConnected {id,session,role} / peerDisconnected {id} /
    //       messageReceived {from,session,kind,sdp} / signalingError {peerId?,code,message}

    /// 单帧上限（与 channel.ts MAX_FRAME_BYTES 一致）
    private static let maxFrameBytes = 64 * 1024

    /// 一条 TCP 连接的读写上下文（含竞态消解后的通道归属）
    private final class SignalingConnContext {
        let connection: NWConnection
        let isOutbound: Bool
        /// 对端 deviceId（出向 = 拨号目标；入向 = hello 后得知）
        var peerId: String?
        var session: String?
        var role: String?
        var terminated = false
        init(connection: NWConnection, isOutbound: Bool) {
            self.connection = connection
            self.isOutbound = isOutbound
        }
    }

    // MARK: - startSignalingServer / stopSignalingServer

    /// 启动信令服务器：绑定 device.port + 挂 Bonjour（SRV = TXT = 监听端口，DNS-SD 语义正确）。
    /// 与 T02 旧 `startAdvertising`（纯广告、拒绝连接）双模式并存：T04 流程用本方法一体（广告+监听）。
    @objc func startSignalingServer(_ call: CAPPluginCall) {
        if signalingServer != nil {
            call.resolve(["ok": true, "port": Int(signalingServerPort ?? 0)]) // 幂等
            return
        }
        guard let deviceDict = call.getObject("device"),
              let params = parseDeviceParams(deviceDict) else {
            call.reject(LanDiscoveryError.badParams("device 必填且 name/id/kind/port/ver 合法").localizedDescription)
            return
        }
        guard let txt = makeTxtRecord(params) else {
            call.reject(LanDiscoveryError.badParams("TXT 值超过 255 字节（UTF-8）").localizedDescription)
            return
        }
        guard let port = NWEndpoint.Port(rawValue: params.port) else {
            call.reject(LanDiscoveryError.badParams("port 越界").localizedDescription)
            return
        }

        selfDeviceId = params.id
        // 双模式互斥（对齐 Android）：新统一监听器接管广告，旧纯广告 listener 让位，
        // 避免同 deviceId 同类型双 Bonjour 注册（auto-rename/注册失败风险）
        advertiser?.cancel()
        advertiser = nil
        wasAdvertising = false
        let listener: NWListener
        do {
            listener = try NWListener(using: .tcp, on: port)
        } catch {
            // 构造失败（参数类错误；端口占用是异步 .failed）
            call.reject(LanDiscoveryError.badParams("监听器创建失败：\(error.localizedDescription)").localizedDescription)
            return
        }
        // Bonjour 服务在 start() 前挂上（SRV 端口 = 监听端口自动；T02 同序）
        listener.service = NWListener.Service(name: params.id, type: Self.serviceType, domain: nil, txtRecord: txt)
        listener.newConnectionHandler = { [weak self] connection in
            DispatchQueue.main.async { self?.handleInboundConnection(connection) }
        }
        pendingServerCall = call
        listener.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async { self?.handleServerState(state) }
        }
        listener.start(queue: netQueue)
        signalingServer = listener
    }

    /// listener .ready（绑定成功，端口确定）/.failed（端口被占/权限拒绝）→ 结算 startSignalingServer 调用
    private func handleServerState(_ state: NWListener.State) {
        guard let listener = signalingServer else { return }
        switch state {
        case .ready:
            signalingServerPort = listener.port?.rawValue
            let call = pendingServerCall
            pendingServerCall = nil
            if let call {
                call.resolve(["ok": true, "port": Int(listener.port?.rawValue ?? 0)])
            }
            if permissionDenied { permissionDenied = false } // 权限恢复后能监听 → 清拒绝标记
        case .failed(let error):
            signalingServer = nil
            signalingServerPort = nil
            let code = Self.mapListenerError(error)
            if code == "LOCAL_NETWORK_DENIED" {
                permissionDenied = true
                notifyListeners("permissionDenied", data: [:])
            }
            let call = pendingServerCall
            pendingServerCall = nil
            if let call {
                call.resolve(["ok": false, "error": code])
            } else {
                emitSignalingError(peerId: nil, code: code, message: error.localizedDescription)
            }
        case .waiting, .setup, .cancelled:
            break
        }
    }

    @objc func stopSignalingServer(_ call: CAPPluginCall) {
        let activePeerIds = Array(channels.keys) // 拷贝：closeChannel 会移除 channels 条目
        for peerId in activePeerIds {
            if let ctx = channels[peerId] { closeChannel(ctx, notify: true) }
        }
        for (_, ctx) in outboundPending {
            ctx.connection.cancel()
        }
        outboundPending.removeAll()
        for (_, work) in connectTimeouts { work.cancel() }
        connectTimeouts.removeAll()
        signalingServer?.cancel()
        signalingServer = nil
        signalingServerPort = nil
        pendingServerCall = nil
        call.resolve(["ok": true])
    }

    // MARK: - connect / disconnect / sendMessage

    /// 主动连对端信令端口（iOS 经 Bonjour .service 端点解析 SRV；host 字段对 iOS 无意义）。
    /// 连上即发 hello（携带 myId + 新 session）；双发起竞态由激活点消解（低 id 胜）。
    @objc func connect(_ call: CAPPluginCall) {
        guard let peer = call.getObject("peer"),
              let peerId = peer["id"] as? String, !peerId.isEmpty,
              let myId = call.getString("myId"), !myId.isEmpty else {
            call.reject(LanDiscoveryError.badParams("peer.id 与 myId 必填").localizedDescription)
            return
        }
        if channels[peerId] != nil {
            call.resolve(["ok": true]) // 已连接（幂等：竞态消解可能已把入向通道激活）
            return
        }
        guard outboundPending[peerId] == nil else {
            call.resolve(["ok": false, "error": "ALREADY_CONNECTING"])
            return
        }
        guard let serviceName = peer["serviceName"] as? String, !serviceName.isEmpty else {
            call.resolve(["ok": false, "error": "INVALID_PARAMS", "message": "peer 缺 serviceName（iOS 端点需要）"])
            return
        }

        selfDeviceId = myId
        let domain = (peer["domain"] as? String) ?? "local."
        let connection = NWConnection(
            to: .service(name: serviceName, type: Self.serviceType, domain: domain, interface: nil), using: .tcp)
        let ctx = SignalingConnContext(connection: connection, isOutbound: true)
        ctx.peerId = peerId
        let session = UUID().uuidString.lowercased()
        ctx.session = session
        ctx.role = "initiator"
        outboundPending[peerId] = ctx

        // 10s 连接超时：未 ready 即失败（NWConnection 无内建 connect 超时）
        let timeout = DispatchWorkItem { [weak self] in
            guard let self, let pending = self.outboundPending[peerId], pending === ctx else { return }
            if ctx.terminated { return }
            ctx.connection.cancel()
            self.outboundPending[peerId] = nil
            self.emitSignalingError(peerId: peerId, code: "CONNECTION_TIMEOUT", message: "连接超时（10s）")
            call.resolve(["ok": false, "error": "CONNECTION_TIMEOUT"])
        }
        connectTimeouts[peerId] = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: timeout)

        connection.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                guard let self else { return }
                switch state {
                case .ready:
                    guard self.outboundPending[peerId] === ctx else { return } // 已被替代/超时
                    self.connectTimeouts[peerId]?.cancel()
                    self.connectTimeouts[peerId] = nil
                    self.outboundPending[peerId] = nil
                    self.sendHello(ctx)
                    self.activate(ctx) // 出向激活点（竞态判定在 activate 内）
                    call.resolve(["ok": true])
                    // 出向也必须读帧（对端 answer/signal 经此到达）——与入向同一读循环
                    self.readFrame(ctx) { [weak self] payload in
                        self?.handleFrame(ctx, payload: payload)
                    }
                case .failed(let error):
                    if self.outboundPending[peerId] === ctx {
                        // 连接建立失败（未 ready）
                        self.connectTimeouts[peerId]?.cancel()
                        self.connectTimeouts[peerId] = nil
                        self.outboundPending[peerId] = nil
                        ctx.terminated = true
                        let code = Self.mapConnectError(error)
                        self.emitSignalingError(peerId: peerId, code: code, message: error.localizedDescription)
                        call.resolve(["ok": false, "error": code])
                    } else if self.channels[peerId] === ctx {
                        // 已建立通道的连接失败 → 断线收尾（peerDisconnected）
                        self.connectionEnded(ctx, error: error)
                    }
                case .cancelled, .waiting, .setup, .preparing:
                    break
                }
            }
        }
        connection.start(queue: .main)
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId") else {
            call.reject(LanDiscoveryError.badParams("peerId 必填").localizedDescription)
            return
        }
        if let ctx = channels[peerId] {
            closeChannel(ctx, notify: true) // 主动断开 → 通知 JS（含对端，经 TCP 关闭传播）
        }
        if let ctx = outboundPending[peerId] {
            connectTimeouts[peerId]?.cancel()
            connectTimeouts[peerId] = nil
            outboundPending[peerId] = nil
            ctx.connection.cancel()
        }
        call.resolve(["ok": true])
    }

    /// 向 peerId 的活跃通道发 signal 帧（kind/sdp 由 facade 校验；此处兜底）
    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let peerId = call.getString("peerId"),
              let kind = call.getString("kind"),
              let sdp = call.getString("sdp"), !sdp.isEmpty,
              kind == "offer" || kind == "answer" else {
            call.reject(LanDiscoveryError.badParams("peerId/kind(offer|answer)/sdp 必填").localizedDescription)
            return
        }
        guard let ctx = channels[peerId] else {
            call.resolve(["ok": false, "error": "NOT_CONNECTED"])
            return
        }
        guard let frame = makeFrame(["v": 1, "type": "signal", "kind": kind, "sdp": sdp]) else {
            call.resolve(["ok": false, "error": "INVALID_PARAMS"])
            return
        }
        ctx.connection.send(content: frame, completion: .contentProcessed { [weak self] error in
            DispatchQueue.main.async {
                if let error {
                    self?.emitSignalingError(peerId: peerId, code: "NOT_CONNECTED", message: error.localizedDescription)
                    call.resolve(["ok": false, "error": "NOT_CONNECTED"])
                } else {
                    call.resolve(["ok": true])
                }
            }
        })
    }

    // MARK: - 入向连接 / 帧读写

    /// listener 接受连接：开始两段式读帧（首帧必须是 hello）
    private func handleInboundConnection(_ connection: NWConnection) {
        let ctx = SignalingConnContext(connection: connection, isOutbound: false)
        connection.start(queue: .main)
        readFrame(ctx) { [weak self] payload in
            self?.handleFrame(ctx, payload: payload)
        }
    }

    /// 两段式读帧循环：4B 大端长度 → 恰好 length 字节载荷 → 重复（main 队列回调）
    private func readFrame(_ ctx: SignalingConnContext, onFrame: @escaping (Data) -> Void) {
        guard !ctx.terminated else { return }
        ctx.connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { [weak self] lengthData, _, isComplete, error in
            guard let self else { return }
            if let error {
                self.connectionEnded(ctx, error: error)
                return
            }
            guard let lengthData, lengthData.count == 4, !isComplete else {
                self.connectionEnded(ctx, error: nil) // EOF（对端断开）
                return
            }
            let length = Int(lengthData[0]) << 24 | Int(lengthData[1]) << 16 | Int(lengthData[2]) << 8 | Int(lengthData[3])
            guard length <= Self.maxFrameBytes else {
                self.protocolViolation(ctx) // 帧长度超上限
                return
            }
            ctx.connection.receive(minimumIncompleteLength: length, maximumLength: length) { [weak self] payload, _, isComplete, error in
                guard let self else { return }
                if let error {
                    self.connectionEnded(ctx, error: error)
                    return
                }
                guard let payload, payload.count == length, !isComplete else {
                    self.connectionEnded(ctx, error: nil)
                    return
                }
                onFrame(payload)
                self.readFrame(ctx, onFrame: onFrame)
            }
        }
    }

    /// 帧分发：入向首帧必须是 hello；之后只收 signal（其余 → 协议违规）
    private func handleFrame(_ ctx: SignalingConnContext, payload: Data) {
        guard let json = try? JSONSerialization.jsonObject(with: payload) as? [String: Any] else {
            protocolViolation(ctx)
            return
        }
        guard let v = json["v"] as? Int, v == 1 else {
            protocolViolation(ctx)
            return
        }
        switch json["type"] as? String {
        case "hello":
            guard !ctx.isOutbound, ctx.peerId == nil,
                  let id = json["id"] as? String, !id.isEmpty,
                  let session = json["session"] as? String, !session.isEmpty else {
                protocolViolation(ctx)
                return
            }
            ctx.peerId = id
            ctx.session = session
            ctx.role = "receiver"
            activate(ctx) // 入向激活点（竞态判定在 activate 内）
        case "signal":
            guard let kind = json["kind"] as? String,
                  kind == "offer" || kind == "answer",
                  let sdp = json["sdp"] as? String, !sdp.isEmpty else {
                protocolViolation(ctx)
                return
            }
            guard let peerId = ctx.peerId, let session = ctx.session else {
                protocolViolation(ctx) // 未握手即发 signal
                return
            }
            notifyListeners("messageReceived", data: [
                "from": peerId, "session": session, "kind": kind, "sdp": sdp,
            ])
        default:
            protocolViolation(ctx)
        }
    }

    // MARK: - 激活与竞态消解

    /// 激活点（出向 ready 发完 hello / 入向收到 hello 两处调用）：
    /// 若该对端已有活跃通道 → 竞态消解（低 deviceId 胜：保留下方发起的连接）。
    /// 被弃连接：已激活的记 peerDisconnected；未激活的静默关闭（从未对外）。
    private func activate(_ ctx: SignalingConnContext) {
        guard let peerId = ctx.peerId, !ctx.terminated else { return }
        if let existing = channels[peerId], !existing.terminated {
            // 低 deviceId 胜；selfDeviceId 未知（不应发生）时与 Android 一致保守取保入向
            let keepOutbound: Bool
            if let selfDeviceId {
                keepOutbound = selfDeviceId < peerId
            } else {
                keepOutbound = false
            }
            if ctx.isOutbound == keepOutbound {
                closeChannel(existing, notify: true) // 候选胜：弃现有（若已对外 → 通知）
                activateAs(ctx)
            } else {
                ctx.connection.cancel() // 候选弃：静默关闭（从未激活对外）
                ctx.terminated = true
            }
            return
        }
        activateAs(ctx)
    }

    private func activateAs(_ ctx: SignalingConnContext) {
        guard let peerId = ctx.peerId, let session = ctx.session else { return }
        channels[peerId] = ctx
        notifyListeners("peerConnected", data: [
            "id": peerId, "session": session, "role": ctx.role ?? "receiver",
        ])
    }

    /// 关闭通道：通知（peerDisconnected）+ 取消连接（幂等）
    private func closeChannel(_ ctx: SignalingConnContext, notify: Bool) {
        guard !ctx.terminated else { return }
        ctx.terminated = true
        if notify, let peerId = ctx.peerId {
            if channels[peerId] === ctx {
                channels.removeValue(forKey: peerId)
            }
            notifyListeners("peerDisconnected", data: ["id": peerId])
        }
        ctx.connection.cancel()
    }

    /// 连接失败 / 对端关闭 / EOF → 收尾（peerDisconnected + 清理 pending）
    private func connectionEnded(_ ctx: SignalingConnContext, error: Error?) {
        guard !ctx.terminated else { return }
        ctx.terminated = true
        if let peerId = ctx.peerId {
            if channels[peerId] === ctx {
                channels.removeValue(forKey: peerId)
                notifyListeners("peerDisconnected", data: ["id": peerId])
            }
            if outboundPending[peerId] === ctx {
                outboundPending[peerId] = nil
                connectTimeouts[peerId]?.cancel()
                connectTimeouts[peerId] = nil
            }
        }
        ctx.connection.cancel()
        _ = error
    }

    /// 协议违规（坏帧/缺 hello/未知 type/超限）→ 关闭连接 + signalingError
    private func protocolViolation(_ ctx: SignalingConnContext) {
        if let peerId = ctx.peerId {
            emitSignalingError(peerId: peerId, code: "PROTOCOL_VIOLATION", message: "帧/消息非法，关闭连接")
        } else {
            emitSignalingError(peerId: nil, code: "PROTOCOL_VIOLATION", message: "握手前非法帧，关闭连接")
        }
        connectionEnded(ctx, error: nil)
    }

    // MARK: - 发送与事件

    private func sendHello(_ ctx: SignalingConnContext) {
        guard let session = ctx.session, let frame = makeFrame([
            "v": 1, "type": "hello", "id": selfDeviceId ?? "", "session": session,
        ]) else { return }
        ctx.connection.send(content: frame, completion: .contentProcessed { _ in })
    }

    /// 4B 大端长度前缀 + JSON 载荷（与 channel.ts encodeFrame 一致）
    private func makeFrame(_ message: [String: Any]) -> Data? {
        guard let payload = try? JSONSerialization.data(withJSONObject: message) else { return nil }
        guard payload.count <= Self.maxFrameBytes else { return nil }
        var frame = Data(count: 4)
        frame[0] = UInt8((payload.count >> 24) & 0xFF)
        frame[1] = UInt8((payload.count >> 16) & 0xFF)
        frame[2] = UInt8((payload.count >> 8) & 0xFF)
        frame[3] = UInt8(payload.count & 0xFF)
        frame.append(payload)
        return frame
    }

    private func emitSignalingError(peerId: String?, code: String, message: String) {
        var data: [String: Any] = ["code": code, "message": message]
        if let peerId { data["peerId"] = peerId }
        notifyListeners("signalingError", data: data)
    }

    // MARK: - 错误映射

    private static func mapConnectError(_ error: NWError) -> String {
        switch error {
        case .posix(let code):
            switch code {
            case .ECONNREFUSED: return "CONNECTION_REFUSED"
            case .ETIMEDOUT: return "CONNECTION_TIMEOUT"
            default: return "CONNECTION_REFUSED"
            }
        case .dns:
            return "CONNECTION_REFUSED" // 服务解析失败（过期/不可达）
        case .tls:
            return "CONNECTION_REFUSED"
        }
    }

    private static func mapListenerError(_ error: NWError) -> String {
        switch error {
        case .posix(let code):
            if code == .EADDRINUSE { return "PORT_IN_USE" }
            if code == .EACCES || code == .EPERM { return "LOCAL_NETWORK_DENIED" }
            return "PORT_IN_USE"
        case .dns(let code):
            if code == Self.policyDeniedCode { return "LOCAL_NETWORK_DENIED" }
            return "PORT_IN_USE"
        case .tls:
            return "PORT_IN_USE"
        }
    }

    /// 解析 startSignalingServer 的嵌套 device 参数（与 startAdvertising 平铺参数同 schema）
    private func parseDeviceParams(_ dict: [String: Any]) -> DeviceParams? {
        let name = dict["name"] as? String ?? ""
        let id = dict["id"] as? String ?? ""
        let kind = dict["kind"] as? String ?? ""
        let ver = dict["ver"] as? String ?? ""
        let port = dict["port"] as? Int ?? -1
        let validKinds: Set<String> = ["phone", "tablet", "desktop"]
        var problems: [String] = []
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("name") }
        if id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("id") }
        if !validKinds.contains(kind) { problems.append("kind") }
        if port < 1 || port > 65535 { problems.append("port") }
        if ver.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { problems.append("ver") }
        guard problems.isEmpty else { return nil }
        return DeviceParams(name: name, id: id, kind: kind, port: UInt16(port), ver: ver)
    }
}

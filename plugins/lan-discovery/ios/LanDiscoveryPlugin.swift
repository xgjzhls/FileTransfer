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
            "advertising": advertiser != nil,
            "browsing": browser != nil,
            "permissionDenied": permissionDenied,
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
}

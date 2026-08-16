import Capacitor
import UniformTypeIdentifiers

// MARK: - 错误

enum FolderExportError: LocalizedError {
    case noFolderPicked
    case badPath(String)
    case pickerBusy
    case createFailed(String)

    var errorDescription: String? {
        switch self {
        case .noFolderPicked: return "尚未选择文件夹（请先选文件夹）"
        case .badPath(let p): return "非法路径段：\(p)"
        case .pickerBusy: return "文件夹选择器已打开"
        case .createFailed(let name): return "创建文件失败：\(name)"
        }
    }
}

/// 分块流式导出桥（ADR-0008 / T02）。
///
/// 契约（spike 实测，prototype/ios-app-spike）：
/// - 桥**不自动转换 TypedArray** → 二进制必须 JS 侧显式 base64
/// - 4 MiB 块实测最优（177 MB/s 桥吞吐）
/// - `UIDocumentPicker(.folder)` + security-scoped URL 写入端到端通过
///
/// 注册：cap sync 扫描本包 ios/** 里的 `@objc(CAPFolderExportPlugin)` 写入
/// packageClassList 自动注册；JS 侧暴露为 Capacitor.Plugins.FolderExport。
@objc(CAPFolderExportPlugin)
public class CAPFolderExportPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CAPFolderExportPlugin"
    public let jsName = "FolderExport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "pickFolder", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "mkdir", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "writeTemp", returnType: CAPPluginReturnPromise),
    ]

    /// 用户取消选择器 / 后台收起选择器时 reject 的机器可识别标记（JS 侧 PICKER_CANCELLED）
    static let pickerCancelled = "PICK_FOLDER_CANCELLED"

    /// 会话内选中的目标文件夹（security-scoped URL）；重选时释放旧授权（v1 不持久化）。
    /// 只在主线程读写（delegate 回调 / 插件方法都在主线程），writeQueue 任务用捕获值。
    private var pickedFolder: URL?
    private var picking = false
    private var pendingPickCall: CAPPluginCall?

    /// 当前正在写入的目标文件（abort / 写失败时清理半成品；已写完成的文件保留）
    private var currentWrite: URL?

    /// 串行写队列：JS 侧已按序 await 每个 writeChunk，这里兜底保证 I/O 不并发、
    /// 且 mkdir/abort 与写入互相串行
    private let writeQueue = DispatchQueue(label: "local.transfer.folder-export.write")

    private var backgroundObserver: NSObjectProtocol?

    public override func load() {
        // 应用退后台时系统会收起文档选择器，但 delegate 回调不保证触发——
        // 兜底 reject 挂起的 pick 调用，避免 picking 永久卡住
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willResignActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.rejectPendingPick()
        }
    }

    deinit {
        if let backgroundObserver {
            NotificationCenter.default.removeObserver(backgroundObserver)
        }
    }

    private func rejectPendingPick() {
        guard picking || pendingPickCall != nil else { return }
        pendingPickCall?.reject(Self.pickerCancelled)
        pendingPickCall = nil
        picking = false
    }

    // MARK: - pickFolder

    @objc func pickFolder(_ call: CAPPluginCall) {
        guard !picking else {
            call.reject(FolderExportError.pickerBusy.localizedDescription)
            return
        }
        picking = true
        pendingPickCall = call
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
            picker.delegate = self
            picker.allowsMultipleSelection = false
            self.bridge?.viewController?.present(picker, animated: true)
        }
    }

    // MARK: - mkdir

    @objc func mkdir(_ call: CAPPluginCall) {
        guard let relDir = call.getString("relDir"), !relDir.isEmpty else {
            call.reject("缺少 relDir")
            return
        }
        guard let base = pickedFolder else {
            call.reject(FolderExportError.noFolderPicked.localizedDescription)
            return
        }
        writeQueue.async { [weak self, base] in
            guard let self else { return }
            do {
                let target = try self.safeJoin(base, relDir)
                try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
                self.resolveMain { call.resolve(["ok": true]) }
            } catch {
                self.rejectMain(call, "mkdir 失败：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - writeChunk

    @objc func writeChunk(_ call: CAPPluginCall) {
        guard let file = call.getString("file"), !file.isEmpty else {
            call.reject("缺少 file")
            return
        }
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("data 缺失或不是合法 base64")
            return
        }
        let isFirst = call.getBool("isFirst", false)
        let isLast = call.getBool("isLast", false)
        guard !data.isEmpty || isFirst else {
            call.reject("非首块收到空数据")
            return
        }
        guard let base = pickedFolder else {
            call.reject(FolderExportError.noFolderPicked.localizedDescription)
            return
        }
        writeQueue.async { [weak self, base] in
            guard let self else { return }
            do {
                let target = try self.safeJoin(base, file)
                try FileManager.default.createDirectory(
                    at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if isFirst {
                    self.currentWrite = target
                }
                try self.appendOrCreate(data, to: target, truncate: isFirst)
                if isLast {
                    let size = self.fileSize(target) ?? Int64(data.count)
                    self.currentWrite = nil
                    self.resolveMain { call.resolve(["ok": true, "bytes": data.count, "size": size]) }
                } else {
                    self.resolveMain { call.resolve(["ok": true, "bytes": data.count]) }
                }
            } catch {
                self.cleanupCurrentWrite() // 写失败：尽力清理半成品（已写完成的文件保留）
                self.rejectMain(call, "写入失败：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - abort

    @objc func abort(_ call: CAPPluginCall) {
        writeQueue.async { [weak self] in
            guard let self else { return }
            let cleaned = self.cleanupCurrentWrite()
            self.resolveMain { call.resolve(["ok": true, "cleaned": cleaned]) }
        }
    }

    // MARK: - writeTemp（@capacitor/share 用的临时文件，file:// URL）

    @objc func writeTemp(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), !name.isEmpty else {
            call.reject("缺少 name")
            return
        }
        guard let b64 = call.getString("data"), let data = Data(base64Encoded: b64) else {
            call.reject("data 缺失或不是合法 base64")
            return
        }
        let isFirst = call.getBool("isFirst", false)
        let isLast = call.getBool("isLast", false)
        guard !data.isEmpty || isFirst else {
            call.reject("非首块收到空数据")
            return
        }
        writeQueue.async { [weak self] in
            guard let self else { return }
            do {
                let dir = try self.shareTempDir()
                let target = try self.safeJoin(dir, name) // 与 writeChunk 同路径防护（拒绝 .. / 绝对路径）
                try FileManager.default.createDirectory(
                    at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
                if isFirst {
                    self.currentWrite = target
                }
                try self.appendOrCreate(data, to: target, truncate: isFirst)
                if isLast {
                    let size = self.fileSize(target) ?? Int64(data.count)
                    self.currentWrite = nil
                    self.resolveMain { call.resolve(["ok": true, "bytes": data.count, "size": size, "url": target.absoluteString]) }
                } else {
                    self.resolveMain { call.resolve(["ok": true, "bytes": data.count]) }
                }
            } catch {
                self.cleanupCurrentWrite()
                self.rejectMain(call, "写入临时文件失败：\(error.localizedDescription)")
            }
        }
    }

    // MARK: - helpers

    /// 相对路径安全拼接：拒绝绝对路径与 .. / . 段（路径穿越防护；writeTemp 同用）
    private func safeJoin(_ base: URL, _ relPath: String) throws -> URL {
        let segments = relPath.split(separator: "/").map(String.init)
        guard !segments.isEmpty else { throw FolderExportError.badPath("(空)") }
        var url = base
        for seg in segments {
            guard seg != "..", seg != ".", !seg.isEmpty else {
                throw FolderExportError.badPath(seg)
            }
            url = url.appendingPathComponent(seg, isDirectory: false)
        }
        return url
    }

    private func shareTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("LocalTransferShare", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// 分块写核心：isFirst 截断建文件（createFile 失败必须抛错，否则假成功），其后追加
    private func appendOrCreate(_ data: Data, to url: URL, truncate: Bool) throws {
        if truncate {
            let ok = FileManager.default.createFile(atPath: url.path, contents: data)
            guard ok else { throw FolderExportError.createFailed(url.lastPathComponent) }
        } else {
            let handle = try FileHandle(forWritingTo: url)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        }
    }

    /// 清理当前文件的半成品并解除追踪；返回是否清理了文件
    @discardableResult
    private func cleanupCurrentWrite() -> Bool {
        guard let target = currentWrite else { return false }
        currentWrite = nil
        do {
            try FileManager.default.removeItem(at: target)
            return true
        } catch {
            return false
        }
    }

    private func fileSize(_ url: URL) -> Int64? {
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.int64Value
    }

    private func resolveMain(_ block: @escaping () -> Void) {
        DispatchQueue.main.async(execute: block)
    }

    private func rejectMain(_ call: CAPPluginCall, _ message: String) {
        DispatchQueue.main.async { call.reject(message) }
    }
}

// MARK: - UIDocumentPickerDelegate

extension CAPFolderExportPlugin: UIDocumentPickerDelegate {
    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        picking = false
        guard let folder = urls.first else {
            pendingPickCall?.reject(Self.pickerCancelled)
            pendingPickCall = nil
            return
        }
        // 释放旧授权（v1 不持久化 security-scoped bookmark，重选即换）
        if let old = pickedFolder {
            old.stopAccessingSecurityScopedResource()
        }
        _ = folder.startAccessingSecurityScopedResource()
        pickedFolder = folder
        let folderName = folder.lastPathComponent
        pendingPickCall?.resolve(["ok": true, "folderPath": folder.path, "folderName": folderName])
        pendingPickCall = nil
    }

    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        picking = false
        pendingPickCall?.reject(Self.pickerCancelled)
        pendingPickCall = nil
    }
}

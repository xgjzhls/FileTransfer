// swift-tools-version: 5.9
import PackageDescription

// ADR-0008 正式插件（T02）：本地插件经 SPM 链接（Capacitor 8 默认包管理）。
// product 名必须是 FolderExport（= CLI fixName("folder-export") 的结果），cap sync
// 生成的 app Package.swift 用 .product(name: "FolderExport", package: "FolderExport") 引用。
let package = Package(
    name: "folder-export",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "FolderExport", targets: ["FolderExport"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.0")
    ],
    targets: [
        .target(
            name: "FolderExport",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "ios"
        )
    ]
)

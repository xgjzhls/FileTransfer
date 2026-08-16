#!/usr/bin/env bash
#
# iOS app 壳一键部署（ADR-0008 / T01）：构建 → cap sync → xcodebuild → 真机安装 → 启动。
#
# 前置：Xcode 16+、Apple ID 个人团队（免费签名，7 天有效）、iPhone 数据线连接并已信任
#       开发者证书（设置 → 通用 → VPN 与设备管理）。
# 用法：bash scripts/ios-deploy.sh [设备 UDID]（省略时自动选择已连接设备）
set -euo pipefail

cd "$(dirname "$0")/.."

APP_ID="local.transfer.app"
DERIVED="build/ios/DerivedData"
APP_PATH="$DERIVED/Build/Products/Debug-iphoneos/App.app"

# ── 1. app 构建（禁用 SW 注入——壳内 SW 不可用，ADR-0008）─────────────────
echo "▸ 构建 app 产物（LT_APP_BUILD=1，无 SW）…"
npm run build:app

# ── 2. cap sync（同步 webDir + 插件注册 + SPM 链接）────────────────────────
# cap sync 会把 dist 全量拷进 ios/App/App/public（含 web 构建的 sw.ts 源文件）——
# app 构建无 sw.js/不注册 SW，残留源文件只会误导排查，删掉
echo "▸ cap sync ios…"
npx cap sync ios
rm -f ios/App/App/public/sw.ts ios/App/App/public/manifest.webmanifest

# ── 3. xcodebuild（自动签名，个人团队免费证书）─────────────────────────────
# Capacitor 8 SPM 模式无 CocoaPods workspace，直接用 xcodeproj 构建
PROJECT="ios/App/App.xcodeproj"
echo "▸ xcodebuild（自动签名 + provisioning updates）…"
xcodebuild -project "$PROJECT" \
  -scheme App \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  build

# ── 4. 找已连接设备（未显式指定 UDID）──────────────────────────────────────
DEVICE="${1:-}"
if [[ -z "$DEVICE" ]]; then
  # 第三列为 Identifier（UDID，稳定）；设备名/主机名可能含空格或变化
  DEVICE=$(xcrun devicectl list devices 2>/dev/null | awk '/connected/ {print $3; exit}')
fi
if [[ -z "$DEVICE" ]]; then
  echo "✗ 未找到已连接设备（检查数据线 / 开发者模式）。" >&2
  exit 1
fi
echo "▸ 目标设备 UDID: $DEVICE"

# ── 5. 安装 + 启动 ──────────────────────────────────────────────────────────
echo "▸ devicectl install + launch…"
xcrun devicectl device install app --device "$DEVICE" "$APP_PATH"
xcrun devicectl device process launch --device "$DEVICE" "$APP_ID"

echo "✓ 部署完成：LocalTransfer 已在真机启动。"

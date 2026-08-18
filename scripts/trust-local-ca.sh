#!/usr/bin/env bash
#
# 一次性信任 LocalTransfer App 的本地 CA（电脑端 A，T07 验收 4，ADR-0009 决策 4）。
#
# 背景：桌面 Chrome（https PWA）连 app 本地 WSS 信令服务器（wss://<ip>:<port>/ws?device=<id>）
# 需要可信证书；app 首次启动自签 CA + 叶证书（CA 持久化，永不变）——本脚本把该 CA 装进
# 系统信任库一次，之后 app 换 IP/重签叶证书都不需要再操作。
#
# 用法（任选其一）：
#   1. 从 App 界面复制 CA 指纹（app 首页「电脑端连接」区块），再指定地址下载：
#      bash scripts/trust-local-ca.sh https://192.168.1.5:9443/ca.crt AA:BB:CC:...:FF
#   2. 已有 ca.crt 文件（例如开发仓库的 .local-certs/ca.crt）：
#      bash scripts/trust-local-ca.sh /path/to/ca.crt
#   3. 只下载不安装（供比对指纹）：
#      bash scripts/trust-local-ca.sh https://192.168.1.5:9443/ca.crt --no-install
#
# 平台：
#   macOS —— security add-trusted-cert（login keychain，无需 sudo；卸载：
#            security delete-certificate -c "LocalTransfer"）
#   Windows —— certutil（PowerShell 管理员）：
#            certutil -addstore -f Root ca.crt
#            （卸载：certutil -delstore Root <sha1 指纹>）
#
# 校验：安装前用 openssl 校验下载 CA 的 SHA-256 指纹与 App 界面显示一致（防中间人/串台）。
set -euo pipefail

log() { printf '\033[36m▸\033[0m %s\n' "$*"; }
fail() { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

SOURCE="${1:-}"
FINGERPRINT="${2:-}"
[ -z "$SOURCE" ] && fail "用法：bash scripts/trust-local-ca.sh <ca.crt 路径 | https://ip:port/ca.crt> [SHA-256 指纹]"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CA_FILE="$WORK/ca.crt"

case "$SOURCE" in
  https://*|http://*)
    log "从 $SOURCE 下载 CA（curl -k：服务器证书自签属预期）…"
    curl -ksS --max-time 15 -o "$CA_FILE" "$SOURCE" || fail "下载失败（地址格式：https://<ip>:<port>/ca.crt；端口默认 9443）"
    ;;
  *)
    CA_FILE="$SOURCE"
    [ -f "$CA_FILE" ] || fail "找不到 CA 文件：$SOURCE"
    ;;
esac

# 校验内容确为证书
openssl x509 -in "$CA_FILE" -noout -subject >/dev/null 2>&1 || fail "文件不是合法 X.509 证书"

# 指纹校验（App 界面显示；可选但强烈建议）
if [ -n "$FINGERPRINT" ]; then
  ACTUAL="$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 | sed 's/.*=//')"
  EXPECT="$(printf '%s' "$FINGERPRINT" | tr '[:lower:]' '[:upper:]')"
  [ "$ACTUAL" = "$EXPECT" ] || fail "指纹不匹配！实际：$ACTUAL"
  log "指纹匹配 ✓（${ACTUAL}）"
else
  ACTUAL="$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 | sed 's/.*=//')"
  log "未提供指纹，跳过比对；CA SHA-256 = $ACTUAL"
fi

# 是否已安装（同指纹证书已在信任库 → 幂等）
SUBJ="$(openssl x509 -in "$CA_FILE" -noout -subject | sed 's/^subject=//')"

case "$(uname -s)" in
  Darwin)
    # CN 取 subject 中最后一个 CN= 之后的全部内容（设备名可能含逗号）
    CN="$(echo "$SUBJ" | sed -n 's/.*CN=\(.*\)/\1/p')"
    if security find-certificate -c "$CN" ~/Library/Keychains/login.keychain-db >/dev/null 2>&1; then
      log "CA 已在登录钥匙串（幂等，跳过）"
    else
      log "安装到登录钥匙串（安全 → 始终信任）…"
      security add-trusted-cert -d -r trustRoot -p ssl -k ~/Library/Keychains/login.keychain-db "$CA_FILE"
      log "已安装 ✓ —— 重启 Chrome 后即可连 wss:// 本地服务器"
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    log "Windows 安装（需管理员 PowerShell）…"
    cp "$CA_FILE" "$WORK/ca.crt"
    powershell -Command "certutil -addstore -f Root \"$WORK/ca.crt\"" || fail "certutil 失败（请用管理员 PowerShell 运行：certutil -addstore -f Root ca.crt）"
    log "已安装 ✓ —— 重启 Chrome 后即可连 wss:// 本地服务器"
    ;;
  Linux)
    fail "Linux：请手动安装到系统信任库（如 sudo cp ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates）"
    ;;
  *)
    fail "未知平台：$(uname -s)"
    ;;
esac

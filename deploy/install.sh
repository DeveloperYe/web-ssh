#!/usr/bin/env bash
#
# web-ssh 一键安装脚本（面向 Linux VM，Debian/Ubuntu）
#
# 用法（在目标 VM 上，一条命令）：
#   bash <(curl -fsSL https://raw.githubusercontent.com/DeveloperYe/web-ssh/main/deploy/install.sh)
#
# 可选环境变量（不传则自动处理）：
#   SSH_API_TOKEN          传则启用 /api/exec；不传则自动生成随机令牌并在结尾打印（务必记下）
#   SSH_DEFAULT_USER       本机 SSH 用户名（默认：脚本运行用户；root 时用 root）
#   SSH_DEFAULT_PASSWORD   本机 SSH 密码（不传则你改用私钥，在 /opt/web-ssh/.env 补配）
#   WEB_SSH_BIND_PORT      监听端口（默认 3000）
#
# 脚本做了：装 Node>=18 + openssh-server、拉取 web-ssh 到 /opt/web-ssh、
#           装依赖、写 .env、配置并启动 systemd 服务（开机自启 + 崩溃自拉）。
set -euo pipefail

REPO="DeveloperYe/web-ssh"
BRANCH="main"
DEST="/opt/web-ssh"
BIND_PORT="${WEB_SSH_BIND_PORT:-3000}"

# root / sudo 自适应
if [[ $EUID -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
say() { printf '==> %s\n' "$*"; }

# ---------- 1. 依赖：Node >= 18、openssh-server ----------
say "检查 / 安装依赖 (nodejs, openssh-server)..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)" -lt 18 ]]; then
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg
  $SUDO mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO apt-get update -y
  $SUDO apt-get install -y nodejs
fi
$SUDO apt-get install -y openssh-server >/dev/null 2>&1 || true
$SUDO systemctl enable --now ssh >/dev/null 2>&1 || \
  $SUDO systemctl enable --now sshd >/dev/null 2>&1 || \
  say "提示：openssh-server 已装，但未能自动启动 ssh 服务，请手动启动"

# ---------- 2. 拉取源码 ----------
if [[ -f "$DEST/server.js" ]]; then
  say "已存在 $DEST，跳过下载（如需更新请手动 pull）"
else
  say "下载 web-ssh -> $DEST"
  $SUDO mkdir -p /opt
  TMP=$(mktemp -d)
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xz -C "$TMP"
  $SUDO mv "$TMP/web-ssh-$BRANCH" "$DEST"
  rm -rf "$TMP"
fi

# ---------- 3. 安装依赖 ----------
say "安装 npm 依赖（--omit=dev）..."
( cd "$DEST" && $SUDO npm install --omit=dev )

# ---------- 4. 生成 .env（不覆盖已有） ----------
if [[ ! -f "$DEST/.env" ]]; then
  say "生成 $DEST/.env ..."
  local_run_user="${SSH_DEFAULT_USER:-$(id -un)}"
  token="${SSH_API_TOKEN:-}"
  if [[ -z "$token" ]]; then
    token="$(openssl rand -hex 24 2>/dev/null || echo web-ssh-$(date +%s))"
    generated_token="$token"
  fi
  envtmp="$(mktemp)"
  if [[ -n "${SSH_DEFAULT_PASSWORD:-}" ]]; then
    cat > "$envtmp" <<EOF
PORT=$BIND_PORT

SSH_API_TOKEN=$token

SSH_DEFAULT_HOST=127.0.0.1
SSH_DEFAULT_PORT=22
SSH_DEFAULT_USER=$local_run_user
SSH_DEFAULT_PASSWORD=${SSH_DEFAULT_PASSWORD}
EOF
  else
    cat > "$envtmp" <<EOF
PORT=$BIND_PORT

SSH_API_TOKEN=$token

SSH_DEFAULT_HOST=127.0.0.1
SSH_DEFAULT_PORT=22
SSH_DEFAULT_USER=$local_run_user
SSH_DEFAULT_PRIVATE_KEY_PATH=/home/$local_run_user/.ssh/id_ed25519
EOF
  fi
  $SUDO cp "$envtmp" "$DEST/.env"
  rm -f "$envtmp"
else
  say "$DEST/.env 已存在，保留原配置"
fi

# ---------- 5. 安装并启动 systemd 服务 ----------
say "配置 systemd 服务 web-ssh..."
SVC="$DEST/deploy/web-ssh.service"
if [[ -f "$SVC" ]]; then
  run_user="${SSH_DEFAULT_USER:-$(id -un)}"
  if [[ "$run_user" == "root" ]]; then
    sed -i '/^User=/d' "$SVC"
  else
    sed -i "s/^User=.*/User=$run_user/" "$SVC"
  fi
  $SUDO cp "$SVC" /etc/systemd/system/web-ssh.service
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now web-ssh
else
  say "警告：未找到 manifest 文件，跳过 systemd 配置。请手动启动：cd $DEST && node server.js"
fi

# ---------- 6. 收尾 ----------
say "完成。验证："
sleep 1
curl -fsS "http://127.0.0.1:$BIND_PORT/api/health" || echo "（health 探活失败，请查看: journalctl -u web-ssh -n 20）"
echo
say "访问入口：http://<你的域名或IP>:$BIND_PORT  （如需套域名+HTTPS 请配 nginx 反代）"
if [[ -n "${generated_token:-}" ]]; then
  say "已为你自动生成 API 令牌（请立即保存，仅显示这一次）：$generated_token"
fi
say "AI 调用：curl -X POST http://127.0.0.1:$BIND_PORT/api/exec -H \"Authorization: Bearer <令牌>\" -H \"Content-Type: application/json\" -d '{\"command\":\"hostname\"}'"
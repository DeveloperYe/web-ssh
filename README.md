# web-ssh

单端口 Web SSH 服务器：浏览器访问 `域名` 或 `域名:端口`，填上目标主机、用户名、密码/私钥，就能在网页里拉起一个真实 SSH 终端。

> 适合服务商**限制端口**、只能通过「端口-域名」（域名/CNAME）方式访问的场景 —— 因为整套服务只需要**一个 HTTP 端口**，套上域名即可，不需要额外开放 22 号随机端口。

## 特性

- **单端口即用**：一个 HTTP 端口承载静态页 + WebSocket，绑到 80/443 + 域名即可
- **网页版 PuTTY**：前端输入「目标主机 / 端口 / 用户名 / 密码或私钥」，可连任意机器
- **xterm.js 真终端**：完全本地化引入，**不依赖任何外网 CDN**（国内网络友好）
- **支持密码 & 私钥**：RSA / ECDSA / Ed25519（OpenSSH 私钥格式）
- **可选整站 Basic Auth**：公网使用建议开启
- **URL 参数预填**：`?host=...&port=...&user=...&mode=key` 方便分享入口
- **Headless API**：`/api/exec` 让 AI / 脚本直接发 HTTP 执行命令拿文本结果，无需浏览器

## 一行命令部署（Linux VM）

在目标机上执行一条命令，自动完成：装 Node>=18 + openssh-server、拉代码到 `/opt/web-ssh`、装依赖、写 `.env`、systemd 开机自启：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DeveloperYe/web-ssh/main/deploy/install.sh)
```

可用环境变量预设（不传则自动处理）：

| 变量 | 作用 |
| --- | --- |
| `SSH_API_TOKEN` | 传则启用 `/api/exec`；否则自动生成随机令牌并在结尾打印 |
| `SSH_DEFAULT_USER` | 本机 SSH 用户名（默认脚本运行用户） |
| `SSH_DEFAULT_PASSWORD` | 本机 SSH 密码（不传则默认走本地 `~/.ssh/id_ed25519` 私钥） |
| `WEB_SSH_BIND_PORT` | 监听端口（默认 `3000`） |

例：

```bash
SSH_API_TOKEN=想自己定的令牌 SSH_DEFAULT_USER=ubuntu \
  bash <(curl -fsSL https://raw.githubusercontent.com/DeveloperYe/web-ssh/main/deploy/install.sh)
```

> 也支持预先把本仓库 `deploy/install.sh` 拷到 VM 后 `bash install.sh` 本地执行。

## 快速开始

### 方式一：直接 Node 运行

```bash
npm install
PORT=3000 node server.js
# 浏览器打开 http://你的服务器:3000
```

> 需要 `npm run` 外的常驻进程，用 pm2：`pm2 start server.js --name web-ssh`。
> Node 方式不自动读 `.env`，要开 API 就把 `SSH_API_TOKEN` 等 `export` 到环境变量再启动（见 `.env.example` 顶部说明）。

### 方式二：Docker（推荐）

```bash
# 1. 复制配置模板并填写
cp .env.example .env

# 2. 启动（docker compose 会自动读取同目录 .env）
docker compose up -d --build
# 或直接 build
docker build -t web-ssh .
docker run -d -p 3000:3000 --name web-ssh --env-file .env web-ssh
```

> `.env` 里至少应收好 `SSH_API_TOKEN`；该令牌不设时 `/api/exec` 保持关闭（安全默认）。docker 部署时别用占位令牌 `sk-请改成随机强令牌`——它既是假的也可能被人借用。

### 对外访问（套域名）

nginx 反代到裸 80/443：

```nginx
server {
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

> `proxy_set_header Connection "upgrade"` 这行**必须保留**，否则 WebSocket 连不上，终端会无响应。

## 部署到虚拟机（web-ssh 就住在 VM 里，AI 操作 VM 自身）

适用你「服务商限端口 + 端口-域名 访问」且**容器就是目标机器**的场景：web-ssh 跑在 VM 上，AI 通过 `/api/exec` 命令落在 VM 自身。全程一个 HTTP 端口对外。

### 1. VM 里装并启动 OpenSSH Server

AI 执行命令靠 SSH 回连本机，VM 上必须有一个 sshd 在跑（Ubuntu/Debian）：

```bash
sudo apt update && sudo apt install -y openssh-server
sudo systemctl enable --now ssh
# 本机自连测试：ssh localhost 能进说明 OK（同一台机器复用 SSH 账号即运行用户）
```

### 2. 放代码并装依赖

```bash
sudo cp -r web-ssh /opt/web-ssh && cd /opt/web-ssh
sudo npm install --omit=dev
```

### 3. 配置 .env（指向本机 + 令牌）

```bash
sudo cp .env.example /opt/web-ssh/.env
# 编辑，至少改两处：
#   SSH_API_TOKEN      -> 你的强令牌，生成：openssl rand -hex 24
#   SSH_DEFAULT_PASSWORD -> 运行用户在本机 SSH 的密码（或改用私钥路径）
```

> `.example` 里 `SSH_DEFAULT_HOST` 已指向 `127.0.0.1`，AI 命令就会落在 VM 自身。要操作别的服务器，改成那台即可。

### 4. systemd 托管（开机自启 + 崩溃自拉）

```bash
sudo cp deploy/web-ssh.service /etc/systemd/system/
# 非 root 运行的话，编辑该文件把 User=deploy 改成你的用户
sudo systemctl daemon-reload
sudo systemctl enable --now web-ssh
systemctl status web-ssh          # 看到 active (running) 即可
journalctl -u web-ssh -f          # 实时看日志
```

> 简单起见也能用 pm2：`pm2 start server.js --name web-ssh && pm2 save`，但 systemd 更贴近"系统服务"语义。

### 5. 对外暴露（单端口 + 域名）

服务监听 `3000`，用 nginx 转发到域名（`Upgrade` 头照旧补上），或直接 `-p 80:3000`。就得到了你要的「端口-域名」网页入口。

### 6. 验证

```bash
curl http://127.0.0.1:3000/api/health                      # API 启用状态
curl -X POST http://127.0.0.1:3000/api/exec \
  -H "Authorization: Bearer $SSH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"hostname && whoami && uptime"}'
# -> ok:true, stdout 返回 VM 的主机名/用户/运行时长
```

## 配置（环境变量）

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 监听端口 | `3000` |
| `HOST` | 监听地址 | `0.0.0.0` |
| `SSH_WEB_USER` | HTTP Basic Auth 用户名（设置则开启鉴权） | 关闭 |
| `SSH_WEB_PASS` | HTTP Basic Auth 密码（设置则开启鉴权） | 关闭 |
| `SSH_API_TOKEN` | API 访问令牌（设置则 `/api/exec` 可用） | 关闭 |
| `SSH_DEFAULT_HOST` `SSH_DEFAULT_PORT` `SSH_DEFAULT_USER` | 服务端默认 SSH 目标（API 用） | `localhost/22/root` |
| `SSH_DEFAULT_PASSWORD` | 默认密码 | 无 |
| `SSH_DEFAULT_PRIVATE_KEY_PATH` | 默认私钥文件路径（优先） | 无 |
| `SSH_DEFAULT_PRIVATE_KEY` | 默认私钥文本 | 无 |

## AI / 脚本 API（Headless）

不需要浏览器，AI 直接 `POST /api/exec` 执行命令并拿回文本结果。凭据用**服务端默认**配置，AI 只发命令即可。

```bash
# 探活
curl http://your.domain/api/health

# 执行命令（Bearer Token 鉴权；未带或带错返回 401）
curl -X POST http://your.domain/api/exec \
  -H "Authorization: Bearer sk-你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"command":"df -h; uname -a"}'
```

返回：

```json
{
  "ok": true,
  "stdout": "Filesystem ...\nLinux ...",
  "stderr": "",
  "exitCode": 0,
  "timedOut": false,
  "durationMs": 312
}
```

请求字段：

| 字段 | 说明 |
| --- | --- |
| `command` | 必填。要执行的命令 |
| `timeout` | 可选。秒，默认 30，最大 120 |
| `host` / `port` / `username` / `password` / `privateKey` | 可选。不传则用服务端默认凭据，传了则覆盖此次连接 |

> 注意：`command` 由调用方自行拼写，需要 shell 特性（管道、相对路径等）时请显式包 `sh -c "..."`。
> 输出各自截断到 256KB，防止无限输出拖垮内存。

## 安全建议

- 公网部署**务必开 HTTPS**（Let's Encrypt）并设置 `SSH_WEB_USER/PASS`
- `SSH_API_TOKEN` 是执行任意命令的钥匙，**务必用长随机串**，且别嵌进前端页面
- AI 客户端调用 `Authorization: Bearer <token>`，走 HTTPS 传输，避免令牌在公网明文暴露
- 网页 URL 里不会保存密码，但配置分享请谨慎
- 私钥只在浏览器→服务器的 WebSocket 中传输，不影响本机

## 项目结构

```
web-ssh/
├── server.js            # 后端：Express 静态 + WebSocket→ssh2 桥接 + Basic Auth + /api/exec
├── lib/
│   └── ssh.js           # 统一 SSH 模块：默认凭据 + 连接参数合成 + 单条命令执行
├── deploy/
│   ├── web-ssh.service   # systemd 单元（VM 直接 Node 托管：开机自启 + 崩溃自拉）
│   └── install.sh        # 一行命令安装脚本（curl | bash）
├── public/              # 前端
│   ├── index.html       # 登录表单 + 终端布局
│   ├── app.js           # xterm 逻辑 + WebSocket
│   └── vendor/          # 本地化的 xterm.js（不依赖 CDN）
├── .env.example         # 配置模板
├── Dockerfile
├── docker-compose.yml
└── README.md
```

## License

MIT
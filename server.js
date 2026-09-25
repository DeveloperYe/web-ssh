/**
 * web-ssh —— 单端口 Web SSH 服务器
 *
 * 一个 HTTP/WebSocket 端口即可工作：
 *  - 网页：浏览器访问域名或 域名:端口，填目标主机/凭据拉起交互终端
 *  - API：  AI/脚本直接发 POST /api/exec 执行命令，拿文本结果，无需浏览器
 *
 * 环境变量（均可选）：
 *   PORT                  监听端口          默认 3000
 *   HOST                  监听地址          默认 0.0.0.0
 *   SSH_WEB_USER          网页 Basic Auth 用户名（设置后开启）
 *   SSH_WEB_PASS          网页 Basic Auth 密码（设置后开启）
 *   SSH_API_TOKEN         API 访问令牌（Bearer Token；未设置则 /api/exec 关闭）
 *   SSH_DEFAULT_HOST/   服务端默认 SSH 凭据，供 API 使用（详见 lib/ssh.js）
 *   SSH_DEFAULT_PORT/
 *   SSH_DEFAULT_USER/
 *   SSH_DEFAULT_PASSWORD/
 *   SSH_DEFAULT_PRIVATE_KEY_PATH/
 *   SSH_DEFAULT_PRIVATE_KEY
 */
'use strict';

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Client } = require('ssh2');
const ssh = require('./lib/ssh');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const API_TOKEN = process.env.SSH_API_TOKEN;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 可选整站 Basic Auth（网页用）
if (process.env.SSH_WEB_USER || process.env.SSH_WEB_PASS) {
  const user = process.env.SSH_WEB_USER || '';
  const pass = process.env.SSH_WEB_PASS || '';
  app.use((req, res, next) => {
    const auth = req.headers.authorization || '';
    const b64 = auth.replace(/^Basic\s+/i, '');
    const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
    const oku = Buffer.from(u || '').length === Buffer.from(user).length &&
      Buffer.from(u || '').equals(Buffer.from(user));
    const okp = Buffer.from(p || '').length === Buffer.from(pass).length &&
      Buffer.from(p || '').equals(Buffer.from(pass));
    if (oku && okp) return next();
    res.set('WWW-Authenticate', 'Basic realm="web-ssh"');
    res.status(401).send('Unauthorized');
  });
}

// ---- HTTP API：给 AI / 脚本直接调用（headless，无需浏览器） ----

// 探活端点，不鉴权（不泄露敏感信息）
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'web-ssh', api: API_TOKEN ? 'enabled' : 'disabled' });
});

// Bearer Token 鉴权中间件
function requireApiToken(req, res, next) {
  if (!API_TOKEN) {
    return res.status(503).json({ error: 'API 未启用：服务端未设置 SSH_API_TOKEN' });
  }
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${API_TOKEN}`) return next();
  return res.status(401).json({ error: '未授权：缺少或错误的有效 Bearer Token' });
}

// 执行远程命令
app.post('/api/exec', requireApiToken, async (req, res) => {
  const { command, timeout } = req.body || {};
  if (typeof command !== 'string' || !command.trim()) {
    return res.status(400).json({ error: '缺少 command 字段（string）' });
  }
  const timeoutMs = Math.min(Number(timeout) || 30, 120) * 1000;
  const opts = ssh.buildOpts(req.body || {});
  try {
    const r = await ssh.exec(opts, command, timeoutMs);
    res.json({
      ok: r.exitCode === 0 && !r.timedOut,
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.exitCode,
      timedOut: r.timedOut,
      durationMs: r.durationMs,
    });
  } catch (e) {
    res.status(502).json({ error: String(e && e.message || e) });
  }
});

// ---- WebSocket <-> SSH 交互式桥接（网页终端） ----

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const conn = new Client();
  let guard = null;

  const fail = (message) => {
    try { ws.send(JSON.stringify({ type: 'error', message })); } catch (_) {}
    try { ws.close(); } catch (_) {}
  };

  guard = setTimeout(() => {
    if (ws.readyState === ws.OPEN) fail('等待登录参数超时');
  }, 15000);

  ws.on('message', (data) => {
    if (guard) { clearTimeout(guard); guard = null; }

    if (!conn._configured) {
      let cfg;
      try { cfg = JSON.parse(data.toString()); } catch (_) { return fail('登录参数格式错误'); }
      conn._configured = true;

      const opts = ssh.buildOpts(cfg);
      if (!ssh.isUsable(opts)) return fail('请提供密码或私钥');

      conn.on('ready', () => {
        const rows = cfg.rows || 24, cols = cfg.cols || 80;
        conn.shell({ term: 'xterm-256color', rows, cols }, (err, stream) => {
          if (err) return fail('打开 shell 失败: ' + err.message);
          conn._stream = stream;
          try { ws.send(JSON.stringify({ type: 'ready', message: '连接成功' })); } catch (_) {}
          stream.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
          stream.stderr.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
          stream.on('close', () => {
            try { ws.send(JSON.stringify({ type: 'close', message: '会话已结束' })); } catch (_) {}
            ws.close();
          });
        });
      });
      conn.on('error', (err) => fail('SSH 错误: ' + err.message));
      conn.connect(opts);
      return;
    }

    // 已就绪：区分「控制帧」与「终端输入」
    if (conn._stream && ws.readyState === ws.OPEN) {
      let s;
      try { s = data.toString(); } catch (_) { s = ''; }
      if (s[0] === '{') {
        try {
          const msg = JSON.parse(s);
          if (msg && msg.type === 'resize') {
            conn._stream.setWindow(msg.rows, msg.cols);
            return;
          }
        } catch (_) { /* 不是控制帧，按终端输入处理 */ }
      }
      conn._stream.write(data);
    }
  });

  ws.on('close', () => conn.end());
  ws.on('error', () => conn.end());
});

server.listen(PORT, HOST, () => {
  console.log(`web-ssh started: http://${HOST}:${PORT}`);
  if (!API_TOKEN) console.warn('warning: SSH_API_TOKEN 未设置，/api/exec 处于关闭状态');
});
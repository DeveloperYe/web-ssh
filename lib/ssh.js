/**
 * lib/ssh.js —— 统一的 SSH 连接与命令执行模块
 *
 * 被两处复用：
 *  - WebSocket 交互式终端（网页用户填写主机/凭据）
 *  - /api/exec 命令执行接口（AI 直接调用，使用服务端默认凭据）
 *
 * 服务端默认凭据来自环境变量（可选，支持“每次请求覆盖默认”）：
 *   SSH_DEFAULT_HOST=PATH...        默认目标主机
 *   SSH_DEFAULT_PORT                 默认端口（默认 22）
 *   SSH_DEFAULT_USER                 默认用户名
 *   SSH_DEFAULT_PASSWORD             默认密码
 *   SSH_DEFAULT_PRIVATE_KEY_PATH    默认私钥文件路径（优先于文本）
 *   SSH_DEFAULT_PRIVATE_KEY          默认私钥文本（多行）
 */
'use strict';

const fs = require('fs');
const { Client } = require('ssh2');

// 读取服务端默认连接参数
function defaultConn() {
  return {
    host: process.env.SSH_DEFAULT_HOST,
    port: Number(process.env.SSH_DEFAULT_PORT) || 22,
    username: process.env.SSH_DEFAULT_USER,
    password: process.env.SSH_DEFAULT_PASSWORD,
    privateKeyPath: process.env.SSH_DEFAULT_PRIVATE_KEY_PATH,
    privateKey: process.env.SSH_DEFAULT_PRIVATE_KEY,
  };
}

/**
 * 由「请求载荷 + 服务端默认」合成可传给 conn.connect(opts) 的连接参数。
 * payload 里的 host/port/username/password/privateKey 可显式覆盖默认。
 */
function buildOpts(payload = {}) {
  const def = defaultConn();
  const host = payload.host || def.host || 'localhost';
  const port = Number(payload.port) || def.port || 22;
  const username = payload.username || def.username || 'root';

  let privateKey = payload.privateKey || def.privateKey;
  if (def.privateKeyPath && !privateKey) {
    try { privateKey = fs.readFileSync(def.privateKeyPath, 'utf8'); } catch (_) { privateKey = null; }
  }

  const opts = { host, port, username, readyTimeout: 15000 };
  if (payload.passphrase) opts.passphrase = payload.passphrase;
  if (privateKey && privateKey.trim()) {
    opts.privateKey = privateKey;
  } else {
    opts.password = payload.password || def.password;
  }
  return opts;
}

/** 判断一组连接参数是否可用（至少有一种认证方式） */
function isUsable(opts) {
  return !!(opts.password || opts.privateKey);
}

/**
 * 建立连接并执行单条命令，收集 stdout / stderr / exitCode。
 * @param {object} opts       buildOpts() 的输出
 * @param {string} command    要执行的命令
 * @param {number} timeoutMs  超时（默认 30s，最大 120s）
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number, timedOut:boolean, durationMs:number}>}
 */
function exec(opts, command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const start = Date.now();
    let settled = false;

    const settle = (value, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.end();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      settle({ stdout: out, stderr: err, exitCode: -1, timedOut: true, durationMs: Date.now() - start });
    }, Math.min(timeoutMs, 120000));

    let out = '', err = '';
    // 防止命令输出无限膨胀拖垮内存，各自截断到 256KB
    const push = (buf, arr) => { if (arr.length < 256 * 1024) arr += buf; return arr; };

    conn.on('ready', () => {
      conn.exec(command, (execErr, stream) => {
        if (execErr) return settle(null, execErr);
        stream.on('data', (d) => { out = push(d, out); });
        stream.stderr.on('data', (d) => { err = push(d, err); });
        stream.on('close', (code, signal) => {
          settle({
            stdout: out, stderr: err, exitCode: code, signal: signal || null,
            timedOut: false, durationMs: Date.now() - start,
          }, null);
        });
      });
    });
    conn.on('error', (e) => settle(null, e));
    conn.connect(opts);
  });
}

module.exports = { defaultConn, buildOpts, isUsable, exec };
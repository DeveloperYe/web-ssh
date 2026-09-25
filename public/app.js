/* web-ssh 前端：登录表单 + xterm.js 终端 + WebSocket 桥接 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const loginCard = $('login-card');
  const termWrap = $('terminal-wrap');
  const errEl = $('error');
  const loadingEl = $('loading');

  let term = null;
  let fitAddon = null;
  let socket = null;
  let pendingResize = 0;

  // ---- 登录方式切换 ----
  let mode = 'password';
  document.querySelectorAll('.mode button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
      $('pw-field').style.display = mode === 'password' ? 'block' : 'none';
      $('key-field').style.display = mode === 'key' ? 'block' : 'none';
    });
  });

  // ---- 终端初始化 ----
  function initTerm() {
    if (term) return;
    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: '"Cascadia Code", Consolas, "Courier New", monospace',
      theme: { background: '#0f1117' },
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open($('terminal'));

    term.onData((d) => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send(d);
    });
    term.onResize(({ cols, rows }) => sendResize(cols, rows));
    window.addEventListener('resize', () => {
      if (term && fitAddon) fitAddon.fit();
    });
  }

  // resize 节流：xterm 的 onResize 已经够灵敏，配合后端 setWindow
  function sendResize(cols, rows) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  // ---- 建立连接 ----
  function connect() {
    errEl.textContent = '';
    loadingEl.style.display = 'block';
    const cfg = {
      host: $('host').value.trim() || 'localhost',
      port: parseInt($('port').value, 10) || 22,
      username: $('username').value.trim() || 'root',
    };
    if (mode === 'password') cfg.password = $('password').value;
    else cfg.privateKey = $('privateKey').value;

    initTerm();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ssh`);

    socket.onopen = () => socket.send(JSON.stringify(cfg));

    socket.onmessage = async (ev) => {
      // 二进制/Blob -> 终端输出（UTF-8 文本 + ANSI 转义）
      if (ev.data instanceof Blob) {
        const t = await ev.data.text();
        term.write(t);
        return;
      }
      if (ev.data instanceof ArrayBuffer) {
        term.write(new TextDecoder().decode(ev.data));
        return;
      }
      // JSON 控制消息
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return term.write(ev.data); }
      if (msg.type === 'ready') {
        loadingEl.style.display = 'none';
        loginCard.style.display = 'none';
        termWrap.style.display = 'flex';
        fitAddon.fit();
        term.focus();
        sendResize(term.cols, term.rows);
      } else if (msg.type === 'error') {
        loadingEl.style.display = 'none';
        errEl.textContent = '连接失败：' + msg.message;
        disconnect();
      } else if (msg.type === 'close') {
        loadingEl.style.display = 'none';
        term.write('\r\n\x1b[90m[已断开]\x1b[0m\r\n');
      }
    };

    socket.onclose = () => {
      loadingEl.style.display = 'none';
      showClosed();
    };
    socket.onerror = () => {};
  }

  function showClosed() {
    if (term && termWrap.style.display === 'flex') {
      term.write('\r\n\x1b[90m[连接已断开]\x1b[0m\r\n');
    }
  }

  function disconnect() {
    if (socket) { try { socket.close(); } catch (_) {} socket = null; }
  }

  $('connect').addEventListener('click', connect);
  $('disconnect').addEventListener('click', resetToLogin);
  $('reconnect').addEventListener('click', () => { resetToLogin(); setTimeout(connect, 50); });

  defaultOptions();

  function resetToLogin() {
    disconnect();
    loginCard.style.display = 'block';
    loadingEl.style.display = 'none';
    termWrap.style.display = 'none';
  }

  // 按 URL 查询参数预填，方便做成多人分享链接
  function defaultOptions() {
    const q = new URLSearchParams(location.search);
    if (q.get('host')) $('host').value = q.get('host');
    if (q.get('port')) $('port').value = q.get('port');
    if (q.get('user')) $('username').value = q.get('user');
    if (q.get('mode') === 'key') {
      document.querySelector('[data-mode="key"]').click();
    }
  }

  // 回车快速连接
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
})();
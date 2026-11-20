/* 手机副屏：电脑起一个局域网页面，手机扫码看最新答案，并可远程触发一次框选截图。
 *
 * 页面只暴露当前这一题的识别文字和答案，不提供历史；除带随机 token 的截图指令外不接收写入。
 * 应用退出或手动关闭后服务立即停止。这个模块不依赖后端，适合考试环境网络受限时使用。
 */
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const QRCode = require('qrcode');

let server = null;
let token = '';
let port = 0;
let currentUrl = '';
let currentQr = '';
let latest = null;
const clients = new Set();
let captureHandler = null;
let cancelHandler = null;

function setCaptureHandlers(handlers = {}) {
  captureHandler = typeof handlers.capture === 'function' ? handlers.capture : null;
  cancelHandler = typeof handlers.cancel === 'function' ? handlers.cancel : null;
}

function lanIp() {
  /* 优先真实网卡：Windows 上 VMware / Hyper-V / WSL 的虚拟网卡也会给 192.168 地址，
   * 手机扫码后连不到，所以按网卡名称排掉常见虚拟网卡，再按 Wi-Fi / 有线优先。 */
  const virtual = /vmware|virtualbox|vethernet|hyper-v|wsl|docker|tap|loopback|bluetooth|zerotier|tailscale|radmin/i;
  const preferred = /wi-?fi|wlan|wireless|以太网|ethernet|en\d|eth\d/i;
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      candidates.push({ name: String(name || ''), address: net.address });
    }
  }
  const real = candidates.filter((item) => !virtual.test(item.name));
  const pool = real.length ? real : candidates;
  const best = pool.find((item) => preferred.test(item.name)) || pool[0];
  return best ? best.address : '';
}

function snapshot() {
  return { text: '', answer: '', at: 0, ...(latest || {}) };
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<title>应声面试 · 笔试副屏</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 18px 16px 28px;
    background: #0b0d12; color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #f59e0b; }
  .dot.on { background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.12); }
  .title { font-size: 13px; font-weight: 600; letter-spacing: .3px; }
  .status { margin-left: auto; font-size: 11px; color: #8b93a5; }
  .card {
    background: #12151d; border: 1px solid rgba(255,255,255,.07);
    border-radius: 14px; padding: 14px 14px 16px; margin-bottom: 12px;
  }
  .label { font-size: 10.5px; color: #7f8899; letter-spacing: .4px; margin-bottom: 8px; }
  .answer {
    font-size: 16px; line-height: 1.65; white-space: pre-wrap; word-break: break-word;
    color: #f3f4f6;
  }
  .answer:empty::before { content: "等待电脑端截图…"; color: #6b7280; }
  details { margin-top: 4px; }
  summary { font-size: 11px; color: #8b93a5; cursor: pointer; }
  .ocr { margin-top: 8px; font-size: 12.5px; line-height: 1.6; white-space: pre-wrap; color: #a7b0c0; }
  .foot { display: flex; gap: 8px; margin-top: 14px; }
  button {
    flex: 1; border: 1px solid rgba(255,255,255,.1); border-radius: 10px;
    background: rgba(255,255,255,.06); color: #d1d5db; font-size: 12px;
    padding: 9px 10px; font-family: inherit;
  }
  button:active { background: rgba(255,255,255,.12); }
  .capture {
    background: #34d399; border-color: #34d399; color: #052e1b;
    font-size: 14px; font-weight: 700; padding: 11px 12px;
  }
  .capture:active { background: #4ade80; }
  .capture.danger { background: #ef4444; border-color: #ef4444; color: #fff; }
  .capture.danger:active { background: #f87171; }
  .tip { margin-top: 14px; font-size: 11px; line-height: 1.6; color: #6b7280; }
</style>
</head>
<body>
  <div class="head">
    <span class="dot" id="dot"></span>
    <span class="title">应声面试 · 笔试副屏</span>
    <span class="status" id="status">连接中</span>
  </div>
  <div class="card">
    <div class="label">答案</div>
    <div class="answer" id="answer"></div>
    <details>
      <summary>查看识别到的题目</summary>
      <div class="ocr" id="ocr"></div>
    </details>
  </div>
  <div class="foot">
    <button class="capture" id="capture" type="button">远程截图</button>
  </div>
  <div class="foot">
    <button id="copy" type="button">复制答案</button>
    <button id="reload" type="button">重新连接</button>
  </div>
  <div class="tip">这个页面只在本机局域网内可访问，关闭电脑端应用后立即失效。答案仅供个人参考，请遵守考试规则。</div>
<script>
  const answerEl = document.getElementById('answer');
  const ocrEl = document.getElementById('ocr');
  const dot = document.getElementById('dot');
  const statusEl = document.getElementById('status');
  let source = null;

  function render(data) {
    if (!data) return;
    answerEl.textContent = data.answer || '';
    ocrEl.textContent = data.text || '';
  }

  function connect() {
    if (source) source.close();
    dot.classList.remove('on');
    statusEl.textContent = '连接中';
    source = new EventSource('/events' + location.search);
    source.onopen = () => { dot.classList.add('on'); statusEl.textContent = '已连接'; };
    source.onmessage = (event) => {
      try { render(JSON.parse(event.data)); } catch (err) {}
    };
    source.onerror = () => { dot.classList.remove('on'); statusEl.textContent = '连接断开'; };
  }

  document.getElementById('copy').addEventListener('click', async () => {
    const text = answerEl.textContent || '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); statusEl.textContent = '已复制'; }
    catch (err) {
      const area = document.createElement('textarea');
      area.value = text; document.body.appendChild(area); area.select();
      document.execCommand('copy'); area.remove(); statusEl.textContent = '已复制';
    }
  });
  document.getElementById('reload').addEventListener('click', connect);

  const captureBtn = document.getElementById('capture');
  let capturing = false;

  async function postCapture(path, signal) {
    const res = await fetch(path + location.search, { method: 'POST', signal });
    let data = {};
    try { data = await res.json(); } catch (err) {}
    return data;
  }

  captureBtn.addEventListener('click', async () => {
    if (capturing) {
      statusEl.textContent = '取消中…';
      try { await postCapture('/capture/cancel'); } catch (err) {}
      return;
    }
    capturing = true;
    captureBtn.textContent = '取消截图';
    captureBtn.classList.add('danger');
    statusEl.textContent = '请在电脑上框选';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
      const data = await postCapture('/capture', controller.signal);
      if (data.cancelled) statusEl.textContent = '已取消';
      else if (data.ok) statusEl.textContent = '已更新';
      else statusEl.textContent = data.error || '截图失败';
    } catch (err) {
      statusEl.textContent = err && err.name === 'AbortError' ? '截图超时' : '截图失败';
    } finally {
      clearTimeout(timer);
      capturing = false;
      captureBtn.textContent = '远程截图';
      captureBtn.classList.remove('danger');
    }
  });

  connect();
</script>
</body>
</html>`;
}

function stop() {
  for (const client of clients) {
    try { client.end(); } catch (err) {}
  }
  clients.clear();
  if (server) {
    try { server.close(); } catch (err) {}
  }
  server = null;
  token = '';
  port = 0;
  currentUrl = '';
  currentQr = '';
}

async function start() {
  if (server) return status();
  token = crypto.randomBytes(12).toString('hex');
  server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.searchParams.get('t') !== token) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    if (url.pathname === '/capture' || url.pathname === '/capture/cancel') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const handler = url.pathname === '/capture' ? captureHandler : cancelHandler;
      if (typeof handler !== 'function') {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '电脑端暂时不可用' }));
        return;
      }
      Promise.resolve()
        .then(() => handler())
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result || { ok: true }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageHtml());
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', resolve);
    });
  } catch (err) {
    stop();
    return { ok: false, error: `手机副屏启动失败：${err.message}` };
  }

  port = server.address().port;
  const ip = lanIp();
  if (!ip) {
    stop();
    return { ok: false, error: '没有找到局域网 IP，请先连接 Wi-Fi 或网线' };
  }
  currentUrl = `http://${ip}:${port}/?t=${token}`;
  let qr = '';
  try {
    qr = await QRCode.toDataURL(currentUrl, {
      margin: 1,
      width: 240,
      color: { dark: '#0f172a', light: '#ffffff' },
    });
  } catch (err) {
    // 二维码生成失败时仍然可以用下面的地址手动打开
  }
  currentQr = qr;
  console.log(`[phone] 副屏已启动，端口 ${port}`);
  return { ok: true, url: currentUrl, qr, port };
}

function status() {
  return { ok: true, running: Boolean(server), url: currentUrl, qr: currentQr, port };
}

function push(payload) {
  latest = {
    text: String(payload && payload.text || ''),
    answer: String(payload && payload.answer || ''),
    at: Date.now(),
  };
  const line = `data: ${JSON.stringify(latest)}\n\n`;
  for (const client of clients) {
    try { client.write(line); } catch (err) { clients.delete(client); }
  }
  return { ok: true };
}

module.exports = { start, stop, status, push, setCaptureHandlers };

/* 客户端更新：检查 /api/app/version、下载安装包、校验 SHA256、启动安装程序。
 *
 * 服务端只下发「当前平台」的下载信息；客户端不信任更新地址，下载前后都做校验：
 * - 只接受 https（本机调试允许 127.0.0.1 / localhost）
 * - 必须带 SHA256，下载完按字节流边下边算
 * - 文件落在系统临时目录，安装接口不接受渲染层传入的路径
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { spawn } = require('child_process');
const { app, shell } = require('electron');
const auth = require('./auth');

const PRODUCT = 'interview';
const CHANNEL = 'stable';
const CHECK_TIMEOUT_MS = 6000;

let lastCheck = null;
let downloadAbort = null;
let downloaded = null;
let installing = false;

function platformTag() {
  if (process.platform === 'win32') return 'win-x64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return 'linux-x64';
}

function parseVersion(value) {
  const match = String(value || '').trim().replace(/^v/i, '')
    .match(/^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return {
    nums: match[1].split('.').map((item) => Number(item) || 0),
    pre: match[2] ? match[2].split('.') : [],
  };
}

/* 与服务端 compareVersions 保持一致：任意段数、支持 -beta.1，无法解析按相等处理。 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  const length = Math.max(left.nums.length, right.nums.length);
  for (let i = 0; i < length; i += 1) {
    const x = left.nums[i] || 0;
    const y = right.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;
  const preLength = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < preLength; i += 1) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff) return diff > 0 ? 1 : -1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

function safeHttps(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return parsed;
    if (parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')) return parsed;
  } catch (err) {
    // 地址不合法按不安全处理
  }
  return null;
}

async function check() {
  try {
    const base = auth.baseUrl();
    if (!safeHttps(base)) throw new Error('账号服务地址不是 HTTPS，已跳过更新检查');
    const params = new URLSearchParams({
      product: PRODUCT,
      channel: CHANNEL,
      platform: platformTag(),
      current: app.getVersion(),
    });
    const response = await fetch(`${base}/api/app/version?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const latest = data && data.latest;
    const download = latest && latest.download;
    /* 服务端已经算过 update_available，这里再按版本号兜一层，避免回退或脏数据。 */
    const available = Boolean(
      data && data.update_available && latest && latest.version
      && download && download.url
      && compareVersions(latest.version, app.getVersion()) > 0,
    );
    lastCheck = {
      ok: true,
      available,
      mandatory: available && Boolean(data.mandatory),
      current: app.getVersion(),
      latest: available ? {
        version: String(latest.version),
        notes: String(latest.notes || ''),
        published_at: String(latest.published_at || ''),
        min_supported: String(latest.min_supported || ''),
        download: {
          url: String(download.url),
          size: Math.max(0, Number(download.size) || 0),
          sha256: String(download.sha256 || '').trim().toLowerCase(),
        },
      } : null,
    };
    console.log(`[update] check current=${lastCheck.current} available=${available} latest=${available ? latest.version : '-'}`);
    return lastCheck;
  } catch (err) {
    console.warn('[update] 检查失败：', err.message);
    return { ok: false, error: err.message, available: false, mandatory: false, latest: null };
  }
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function targetFile(version) {
  const dir = path.join(app.getPath('temp'), 'echoq-update');
  fs.mkdirSync(dir, { recursive: true });
  const safeVersion = String(version || '').replace(/[^0-9A-Za-z._-]/g, '') || 'latest';
  return path.join(dir, `应声面试-${safeVersion}-setup.exe`);
}

function verifyFile(file, sha256, size) {
  try {
    const stat = fs.statSync(file);
    if (size && stat.size !== size) return false;
    if (!sha256) return false;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return hash === sha256;
  } catch (err) {
    return false;
  }
}

async function download(onProgress) {
  if (downloadAbort) return { ok: false, error: '正在下载更新' };
  const info = lastCheck && lastCheck.available ? lastCheck.latest : null;
  if (!info || !info.download) return { ok: false, error: '没有可下载的更新' };
  if (downloaded && downloaded.version !== info.version) downloaded = null;

  const { download: source } = info;
  let resolved = null;
  try {
    resolved = safeHttps(new URL(source.url, `${auth.baseUrl()}/`).toString());
  } catch (err) {
    return { ok: false, error: '更新地址无效' };
  }
  if (!resolved) return { ok: false, error: '更新地址不是 HTTPS，已阻止下载' };
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) {
    return { ok: false, error: '更新包缺少有效的 SHA256，已阻止下载' };
  }

  const file = targetFile(info.version);
  if (verifyFile(file, source.sha256, source.size)) {
    downloaded = { file, version: info.version, size: source.size };
    onProgress && onProgress({ received: source.size, total: source.size, percent: 100 });
    return { ok: true, file, version: info.version, size: source.size, cached: true };
  }

  const controller = new AbortController();
  downloadAbort = controller;
  try {
    const response = await fetch(resolved, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
    if (!safeHttps(response.url)) throw new Error('更新地址跳转到了非 HTTPS，已阻止下载');

    const total = Math.max(0, Number(response.headers.get('content-length')) || 0) || source.size;
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastSent = 0;

    /* 边下边算哈希并报进度；pipeline 负责背压与错误传播。 */
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        hash.update(chunk);
        received += chunk.length;
        const now = Date.now();
        if (onProgress && (now - lastSent > 120 || received === total)) {
          lastSent = now;
          onProgress({
            received,
            total,
            percent: total ? Math.min(100, Math.round((received / total) * 100)) : null,
            text: total ? `${formatBytes(received)} / ${formatBytes(total)}` : formatBytes(received),
          });
        }
        callback(null, chunk);
      },
    });

    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(file));

    const digest = hash.digest('hex');
    if (source.size && received !== source.size) {
      throw new Error(`安装包大小不一致（${received} / ${source.size}）`);
    }
    if (digest !== source.sha256) throw new Error('安装包校验失败，请重试');

    downloaded = { file, version: info.version, size: received };
    onProgress && onProgress({ received, total: received, percent: 100, text: formatBytes(received) });
    console.log(`[update] 下载完成 version=${info.version} size=${received} file=${file}`);
    return { ok: true, file, version: info.version, size: received };
  } catch (err) {
    try {
      fs.unlinkSync(file);
    } catch (cleanupErr) {
      // 临时文件清不掉不影响下次重下
    }
    if (err.name === 'AbortError' || /abort/i.test(err.message)) return { ok: false, cancelled: true };
    console.warn('[update] 下载失败：', err.message);
    return { ok: false, error: err.message };
  } finally {
    downloadAbort = null;
  }
}

function cancel() {
  if (!downloadAbort) return { ok: false, error: '没有正在进行的下载' };
  downloadAbort.abort();
  return { ok: true };
}

function install() {
  if (installing) return { ok: false, error: '正在启动安装程序' };
  if (!downloaded || !fs.existsSync(downloaded.file)) {
    return { ok: false, error: '安装包不存在，请重新下载' };
  }
  installing = true;
  try {
    console.log(`[update] 启动安装程序 version=${downloaded.version} file=${downloaded.file}`);
    if (process.platform === 'win32') {
      const child = spawn(downloaded.file, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => app.quit(), 500);
    } else {
      shell.openPath(downloaded.file);
      setTimeout(() => app.quit(), 500);
    }
    return { ok: true };
  } catch (err) {
    installing = false;
    return { ok: false, error: err.message };
  }
}

module.exports = { check, download, cancel, install, platformTag, compareVersions };

/* 语音识别运行时资源：llama.cpp 引擎 + Qwen3-ASR 的 GGUF 模型。
 *
 * 全部下载到用户数据目录（runtime/bin、runtime/models），带进度、断点续传、
 * 取消和大小校验。国内优先走 hf-mirror，失败再回落到 huggingface 官方源。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const paths = require('./paths');
const config = require('./config');

/* 引擎版本与安装包哈希都写死：下载后必须逐字节一致，不接受任何代理改写的文件。 */
const LLAMA_VERSION = 'b12096';
const LLAMA_ZIP_URL = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_VERSION}/llama-${LLAMA_VERSION}-bin-win-cpu-x64.zip`;
const LLAMA_ZIP_SHA256 = '0540277115a61ee46709bfd317ec73076c0cbfa4072bc06710e520042f6d0d96';
// 只保留 llama-server 运行必需的 exe/dll，命令行工具及其实现库一律不落盘。
const ENGINE_FILE = /^(llama-server\.exe|llama-server-impl\.dll|llama-common\.dll|llama\.dll|mtmd\.dll|libomp\.dll|ggml\.dll|ggml-base\.dll|ggml-cpu-.+\.dll)$/i;

const MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];

/* 三档模型共用同一套 llama.cpp 引擎：按本机内存推荐，用户也可以自己选。 */
const MODELS = {
  small: {
    label: '小模型 · Qwen3-ASR 0.6B',
    detail: '约 0.9 GB · 低配/老电脑，速度最快',
    repo: 'ggml-org/Qwen3-ASR-0.6B-GGUF',
    file: 'Qwen3-ASR-0.6B-Q8_0.gguf',
    bytes: 804749248,
    mmproj: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf',
    mmprojBytes: 214392480,
  },
  medium: {
    label: '中模型 · Qwen3-ASR 1.7B',
    detail: '约 2.4 GB · 识别更准，8 GB 内存以上推荐',
    repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF',
    file: 'Qwen3-ASR-1.7B-Q8_0.gguf',
    bytes: 2165034944,
    mmproj: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
    mmprojBytes: 355709344,
  },
  large: {
    label: '大模型 · Qwen3-ASR 1.7B 高精度',
    detail: '约 4.4 GB · 准确率最高，16 GB 内存以上推荐',
    repo: 'ggml-org/Qwen3-ASR-1.7B-GGUF',
    file: 'Qwen3-ASR-1.7B-bf16.gguf',
    bytes: 4069674944,
    mmproj: 'mmproj-Qwen3-ASR-1.7B-bf16.gguf',
    mmprojBytes: 641773984,
  },
};

const TIER_ORDER = ['small', 'medium', 'large'];

function memoryGb() {
  return os.totalmem() / 1024 / 1024 / 1024;
}

function recommendTier(gb) {
  if (gb < 8) return 'small';
  if (gb < 16) return 'medium';
  return 'large';
}

function modelPaths(id) {
  const meta = MODELS[id];
  return {
    model: path.join(paths.modelsDir(), meta.file),
    mmproj: path.join(paths.modelsDir(), meta.mmproj),
  };
}

let active = null; // { id, controller }

function exists(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch (err) {
    return false;
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (err) {
    return 0;
  }
}

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function status() {
  const rt = paths.runtimePaths();
  const bundled = paths.bundledPaths();
  const runtimeEngine = sizeOf(rt.binary);
  const bundledEngine = sizeOf(bundled.binary);
  const engineSource = bundledEngine > 0 ? 'bundled' : (runtimeEngine > 0 ? 'runtime' : 'missing');
  const gb = memoryGb();
  const recommend = recommendTier(gb);
  const settings = config.load().asr;

  const items = [
    {
      id: 'llama',
      kind: 'engine',
      label: '语音识别引擎',
      detail: engineSource === 'bundled'
        ? 'llama.cpp Windows CPU 版（安装包内置）'
        : 'llama.cpp Windows CPU 版',
      ready: engineSource !== 'missing',
      source: engineSource,
      bytes: engineSource === 'bundled' ? bundledEngine : runtimeEngine,
      total: 0,
    },
  ];

  for (const id of TIER_ORDER) {
    const meta = MODELS[id];
    const dest = modelPaths(id);
    const modelBytes = sizeOf(dest.model);
    const mmBytes = sizeOf(dest.mmproj);
    items.push({
      id,
      kind: 'model',
      label: meta.label,
      detail: meta.detail,
      ready: modelBytes >= meta.bytes * 0.95 && mmBytes >= meta.mmprojBytes * 0.95,
      active: settings.llama_model === dest.model && settings.llama_mmproj === dest.mmproj,
      recommended: id === recommend,
      bytes: modelBytes + mmBytes,
      total: meta.bytes + meta.mmprojBytes,
    });
  }

  const engineReady = items[0].ready;
  const modelReady = items.some((item) => item.kind === 'model' && item.ready);
  const activeItem = items.find((item) => item.active);

  return {
    dir: paths.runtimeRoot(),
    items,
    ready: engineReady && modelReady,
    engine: engineSource,
    active: active ? active.id : null,
    recommend,
    memory_gb: gb,
    activeTier: activeItem ? activeItem.id : '',
  };
}

function report(id, payload, onProgress) {
  if (typeof onProgress !== 'function') return;
  onProgress({ id, phase: 'download', received: 0, total: 0, percent: null, ...payload });
}

/* 下载到 .part，完成后改名为正式文件；支持断点续传，并带 40 秒无响应超时。 */
function fetchToFile(urls, dest, id, onProgress) {
  const part = `${dest}.part`;

  return (async () => {
    let offset = sizeOf(part);
    let lastError = null;

    for (const url of urls) {
      let timedOut = false;
      let stream = null;
      let lastActivity = Date.now();
      const controller = new AbortController();
      active = { id, controller, cancelled: false };

      const watchdog = setInterval(() => {
        if (Date.now() - lastActivity > 40000) {
          timedOut = true;
          controller.abort();
        }
      }, 5000);

      try {
        const headers = { 'User-Agent': 'interview-copilot' };
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        report(id, { received: offset, total: 0, percent: null }, onProgress);

        const response = await fetch(url, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`下载源返回 HTTP ${response.status}`);
        if (!response.body) throw new Error('下载源没有返回内容');

        const resumed = response.status === 206;
        const length = Number(response.headers.get('content-length') || 0);
        const total = length ? length + (resumed ? offset : 0) : 0;
        if (!resumed) {
          offset = 0;
          fs.rmSync(part, { force: true });
        }

        stream = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
        const reader = response.body.getReader();
        let received = offset;
        let lastTick = 0;

        while (true) {
          const { value, done } = await reader.read();
          lastActivity = Date.now();
          if (done) break;
          received += value.length;
          if (!stream.write(Buffer.from(value))) {
            await new Promise((resolve) => stream.once('drain', resolve));
          }
          const now = Date.now();
          if (now - lastTick > 200) {
            lastTick = now;
            report(id, {
              received,
              total,
              percent: total ? (received / total) * 100 : null,
            }, onProgress);
          }
        }
        await new Promise((resolve, reject) => stream.end((err) => (err ? reject(err) : resolve())));
        stream = null;
        active = null;

        if (total && received < total) throw new Error(`下载不完整（${received}/${total}）`);
        fs.rmSync(dest, { force: true });
        fs.renameSync(part, dest);
        report(id, { received, total: total || received, percent: 100 }, onProgress);
        return { url, bytes: received };
      } catch (err) {
        const cancelled = Boolean(active && active.cancelled);
        if (stream) {
          try { stream.destroy(); } catch (destroyErr) { /* ignore */ }
        }
        active = null;
        if (cancelled) throw new Error('已取消下载');
        lastError = timedOut ? new Error('下载源响应超时') : err;
        offset = sizeOf(part);
        console.log(`[assets] 下载失败（${url}）：`, lastError.message);
      } finally {
        clearInterval(watchdog);
      }
    }
    throw new Error(`下载失败：${lastError ? lastError.message : '没有可用的下载源'}`);
  })();
}

function findServerDir(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'llama-server.exe') return dir;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findServerDir(path.join(dir, entry.name));
      if (found) return found;
    }
  }
  return null;
}

function expandZip(zipPath) {
  return new Promise((resolve, reject) => {
    const temp = path.join(paths.runtimeRoot(), '.extract');
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(temp, { recursive: true });

    const script = `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(temp)} -Force`;
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { windowsHide: true });

    let detail = '';
    child.stderr.on('data', (chunk) => { detail += String(chunk); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        fs.rmSync(temp, { recursive: true, force: true });
        reject(new Error(`解压引擎失败：${detail.slice(0, 200) || `code ${code}`}`));
        return;
      }
      try {
        const source = findServerDir(temp) || temp;
        const target = paths.binDir();
        fs.mkdirSync(target, { recursive: true });
        // 先清掉旧版本可能留下的命令行工具，保证 runtime/bin 只有服务端必需文件。
        for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
          if (entry.isFile() && !ENGINE_FILE.test(entry.name)) {
            fs.rmSync(path.join(target, entry.name), { force: true });
          }
        }
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
          if (!entry.isFile() || !ENGINE_FILE.test(entry.name)) continue;
          const from = path.join(source, entry.name);
          const to = path.join(target, entry.name);
          fs.rmSync(to, { recursive: true, force: true });
          fs.renameSync(from, to);
        }
        fs.rmSync(temp, { recursive: true, force: true });
        if (!exists(paths.runtimePaths().binary)) throw new Error('解压后没有找到 llama-server.exe');
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

/* 补齐配置里失效的路径：引擎优先指向随包内置版本；没有内置时才指向运行目录。
 * 模型优先用已下载的档位，一个都没有时指向小模型。 */
function syncConfig() {
  const current = config.load().asr;
  const patch = {};
  if (!current.llama_bin || !exists(current.llama_bin)) {
    const bundled = paths.bundledPaths().binary;
    patch.llama_bin = exists(bundled) ? bundled : paths.runtimePaths().binary;
  }

  const modelOk = current.llama_model && exists(current.llama_model);
  const mmprojOk = current.llama_mmproj && exists(current.llama_mmproj);
  if (!modelOk || !mmprojOk) {
    const readyTier = TIER_ORDER.find((id) => {
      const p = modelPaths(id);
      return exists(p.model) && exists(p.mmproj);
    }) || 'small';
    const p = modelPaths(readyTier);
    patch.llama_model = p.model;
    patch.llama_mmproj = p.mmproj;
  }
  if (Object.keys(patch).length) config.save({ asr: patch });
}

/* 引擎下载源：显式完整地址 > 国内镜像前缀 > GitHub 官方。哈希校验在后面统一做。 */
function engineUrls() {
  const urls = [];
  const custom = String(process.env.IC_LLAMA_ZIP_URL || '').trim();
  const mirror = String(process.env.IC_LLAMA_MIRROR || '').trim().replace(/\/+$/, '');
  if (custom) urls.push(custom);
  if (mirror) urls.push(`${mirror}/${LLAMA_ZIP_URL}`);
  urls.push(LLAMA_ZIP_URL);
  return [...new Set(urls)];
}

async function downloadLlama(onProgress) {
  const zipPath = path.join(paths.runtimeRoot(), 'llama-engine.zip');
  report('llama', { received: 0, total: 0, percent: null }, onProgress);
  // 固定版本 + 固定哈希；镜像只换下载地址，不改校验标准。
  await fetchToFile(engineUrls(), zipPath, 'llama', onProgress);
  const digest = sha256File(zipPath);
  if (digest !== LLAMA_ZIP_SHA256) {
    fs.rmSync(zipPath, { force: true });
    throw new Error(`引擎安装包校验失败（${digest.slice(0, 12)}…），已删除，请重试`);
  }
  if (typeof onProgress === 'function') {
    onProgress({ id: 'llama', phase: 'extract', percent: null, received: 0, total: 0 });
  }
  await expandZip(zipPath);
  fs.rmSync(zipPath, { force: true });
  syncConfig();
}

async function fetchModelFile(meta, file, dest, expected, id, onProgress, base) {
  if (sizeOf(dest) >= expected * 0.95) return;
  const urls = MIRRORS.map((hub) => `${hub}/${meta.repo}/resolve/main/${file}?download=true`);
  const total = meta.bytes + meta.mmprojBytes;
  let last = base.offset;
  await fetchToFile(urls, dest, id, (progress) => {
    last = base.offset + (progress.received || 0);
    if (typeof onProgress !== 'function') return;
    onProgress({
      ...progress,
      id,
      received: last,
      total,
      percent: total ? (last / total) * 100 : null,
    });
  });
  const actual = sizeOf(dest);
  if (actual < expected * 0.95) {
    fs.rmSync(dest, { force: true });
    throw new Error(`${file} 大小不对，已删除，请重试`);
  }
}

async function downloadModel(id, onProgress) {
  const meta = MODELS[id];
  if (!meta) throw new Error(`未知的模型：${id}`);
  const dest = modelPaths(id);

  await fetchModelFile(meta, meta.file, dest.model, meta.bytes, id, onProgress, { offset: 0 });
  await fetchModelFile(meta, meta.mmproj, dest.mmproj, meta.mmprojBytes, id, onProgress, { offset: meta.bytes });

  // 还没有任何可用模型时，下载完成就直接用上；已有可用模型则保持不动，由用户点「使用」切换
  const current = config.load().asr;
  const hasUsable = current.llama_model && exists(current.llama_model)
    && current.llama_mmproj && exists(current.llama_mmproj);
  if (!hasUsable) config.save({ asr: { llama_model: dest.model, llama_mmproj: dest.mmproj } });
}

/* 切换到这个已下载的档位：写配置，由调用方负责重启本地 ASR。 */
function use(id) {
  const meta = MODELS[id];
  if (!meta) throw new Error(`未知的模型：${id}`);
  const dest = modelPaths(id);
  if (!exists(dest.model) || !exists(dest.mmproj)) throw new Error('这个模型还没下载完成');
  config.save({ asr: { llama_model: dest.model, llama_mmproj: dest.mmproj } });
  return status();
}

async function download(id, onProgress) {
  if (active) throw new Error('已有下载任务在进行，请先等待或取消');
  paths.ensureDirs();
  if (id === 'llama') {
    // 安装包已经内置引擎时直接复用，不因为任何校验/版本判断去联网。
    if (sizeOf(paths.bundledPaths().binary) > 0) {
      syncConfig();
      return;
    }
    return downloadLlama(onProgress);
  }
  return downloadModel(id, onProgress);
}

function cancel() {
  if (active && active.controller) {
    active.cancelled = true;
    active.controller.abort();
  }
}

module.exports = { status, download, cancel, use, syncConfig, MODELS };

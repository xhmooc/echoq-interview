/* ASR：本机 llama.cpp 跑 Qwen3-ASR（默认）；云端走官方转发；也可以自带 OpenAI 兼容转写服务。
 *
 * 本机优先，连续失败两次后 5 分钟内改用云端；本地服务第一次转写时才拉起，
 * 之后常驻复用，关掉 App 时自动回收，避免孤儿进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const config = require('./config');
const paths = require('./paths');
const auth = require('./auth');
const cloud = require('./cloud');

const MARK = '<asr_text>';
/* 本地连续失败两次就临时改用云端，5 分钟后允许再试本地。 */
const LOCAL_FAIL_LIMIT = 2;
const CLOUD_COOLDOWN_MS = 5 * 60 * 1000;
/* 服务端明确说云端识别没开时，5 分钟内不再每段都试一次，
 * 避免每句话都先白等一次云端往返再回退到本机。 */
const CLOUD_UNSUPPORTED_MS = 5 * 60 * 1000;

let server = null;
let starting = null;
let lastError = '';
let ready = false;
let localFailures = 0;
let cloudUntil = 0;
let cloudUnsupportedUntil = 0;
/* 启动代数：shutdown/killSync 时递增，用来取消还没执行到 spawn 的启动流程，
 * 否则预热中退出或切换模型时，旧启动会稍后把引擎进程拉起来变成孤儿。 */
let startEpoch = 0;
/* 服务端明确表示不接受 Ogg/Opus 后，本次运行就不再尝试，省掉每段一次多余请求。 */
let opusRejected = false;

try {
  paths.ensureDirs();
} catch (err) {
  // 目录建不了时下面的日志直接跳过
}

function log(message) {
  console.log('[asr]', message);
  try {
    fs.appendFileSync(path.join(paths.logsDir(), 'asr.log'), `${new Date().toISOString()} ${message}\n`);
  } catch (err) {
    // 日志写不进去不影响主流程
  }
}

/* 引擎：随包内置 > 用户配置 > 应用内下载 > 开发机 clipforge，谁先存在用谁。
 * 安装包自带引擎时永远用它，不会因为配置里的旧路径或版本判断去联网下载。
 * 模型不随包分发，按 用户配置 > 应用内下载 > 开发机 clipforge 的顺序取。
 * 配置里的路径必须落在白名单目录，否则忽略，避免配置文件被改成任意可执行文件。 */
function resolvePaths() {
  const settings = config.load().asr;
  const runtime = paths.runtimePaths();
  const bundled = paths.bundledPaths();
  const legacy = paths.legacyVendor();
  const safe = (value) => (value && paths.isEnginePath(value) ? value : '');
  const pick = (candidates) => {
    const list = candidates.filter(Boolean);
    return list.find((item) => fs.existsSync(item)) || list[0] || '';
  };
  return {
    binary: pick([bundled.binary, safe(settings.llama_bin), runtime.binary, legacy.binary]),
    model: pick([safe(settings.llama_model), runtime.model, legacy.model]),
    mmproj: pick([safe(settings.llama_mmproj), runtime.mmproj, legacy.mmproj]),
    port: Number(settings.llama_port) || 8091,
  };
}

function available() {
  const p = resolvePaths();
  return Boolean(p.binary && p.model && p.mmproj
    && fs.existsSync(p.binary) && fs.existsSync(p.model) && fs.existsSync(p.mmproj));
}

function status() {
  const p = resolvePaths();
  const runtime = paths.runtimePaths();
  const bundled = paths.bundledPaths();
  const isBuiltin = (p.binary === runtime.binary || p.binary === bundled.binary) && fs.existsSync(p.binary);
  const source = isBuiltin ? 'builtin' : (fs.existsSync(p.binary) ? 'custom' : 'missing');
  return {
    provider: config.load().asr.provider,
    ready,
    starting: Boolean(starting),
    available: available(),
    source,
    cloud_cooldown: Date.now() < cloudUntil,
    paths: { binary: p.binary, model: p.model, mmproj: p.mmproj },
    runtimeDir: paths.runtimeRoot(),
    error: lastError,
  };
}

async function healthy(base) {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await response.json();
    return data.status === 'ok';
  } catch (err) {
    return false;
  }
}

function ensureServer() {
  if (ready) return Promise.resolve(`http://127.0.0.1:${resolvePaths().port}`);
  if (starting) return starting;

  const p = resolvePaths();
  const base = `http://127.0.0.1:${p.port}`;
  lastError = '';
  const epoch = ++startEpoch;
  const cancelled = () => epoch !== startEpoch;

  starting = (async () => {
    if (await healthy(base)) {
      ready = true;
      return base;
    }
    if (!available()) {
      throw new Error(
        '本地 ASR 文件不完整：请在设置里检查 llama-server.exe / 模型 / mmproj 三个路径，或改成云端模式。'
      );
    }
    /* 等健康检查的间隙可能已经 shutdown / 换模型，这时不能再拉起新进程。 */
    if (cancelled()) {
      throw new Error('本地 ASR 已被停止（识别设置已更改），请重新点击「开始听面试官」');
    }
    // 线程数按实测取 4，不用更激进的 6：
    // 测试机 i5-10500（6 物理核/12 线程），Qwen3-ASR 0.6B Q8，同一段中文音频各跑 5 次取中位数。
    //   10 秒分段（常见）：4 线程 1946ms / CPU 7.95s；6 线程 1966ms / CPU 11.42s（更慢且更费 CPU）
    //   14 秒分段（应用上限）：4 线程 2045ms / CPU 8.47s；6 线程 1896ms / CPU 11.47s（快 7%，CPU 多 35%）
    //   8 线程：3766ms（24.6 秒音频），比 6 线程更慢，CPU 从 20.8s 涨到 26.3s。
    // 应用最多只送 14 秒分段，6 线程只在这条边界上快约 150ms，却明显更耗电发热，因此默认 4。
    // 逻辑核折半是物理核的上界（超线程最多 2:1），低核机器不会超过物理核；上下文保持 8192。
    const logical = (os.cpus() || []).length || 1;
    const threads = Math.max(1, Math.min(4, Math.floor(logical / 2)));
    log(`启动本地 ASR：${p.binary}（端口 ${p.port}，线程 ${threads}/${logical}，首次加载约 10-30 秒）`);
    const detail = [];
    const child = spawn(p.binary, [
      '-m', p.model,
      '--mmproj', p.mmproj,
      '--host', '127.0.0.1',
      '--port', String(p.port),
      '-c', '8192',
      '--parallel', '1',
      '-t', String(threads),
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      cwd: path.dirname(p.binary),
    });
    server = child;

    /* spawn 前后被 shutdown/换模型打断：立刻杀掉刚拉起的进程，避免孤儿引擎占住端口。 */
    if (cancelled()) {
      server = null;
      try { child.kill(); } catch (err) { /* 进程可能还没起完 */ }
      throw new Error('本地 ASR 已被停止（识别设置已更改），请重新点击「开始听面试官」');
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        const line = String(chunk).trim();
        if (!line) return;
        detail.push(line);
        if (detail.length > 12) detail.shift();
        log(line.slice(0, 300));
      });
    }

    child.on('error', (err) => {
      if (server !== child) return;
      lastError = err.message;
      log(`进程错误：${err.message}`);
    });

    /* 只有当前这个进程的退出事件才能改状态：切换识别方式时旧进程的退出
     * 会晚于新进程启动，如果不加判断，旧事件会把新进程的记录清空，
     * 导致重复拉起多个引擎、端口互相抢占。 */
    child.on('exit', (code) => {
      if (server !== child) return;
      ready = false;
      starting = null;
      server = null;
      if (code !== 0 && code !== null) {
        lastError = `本地 ASR 进程退出（code ${code}）：${detail.slice(-4).join(' | ').slice(0, 400)}`;
      }
    });

    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (cancelled() || server !== child) {
        throw new Error('本地 ASR 已被停止（识别设置已更改），请重新点击「开始听面试官」');
      }
      if (await healthy(base)) {
        ready = true;
        log('本地 ASR 就绪');
        return base;
      }
      // 本地健康检查很轻，250ms 轮询一次，模型一加载完就能立刻进入就绪。
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('本地 ASR 启动超时');
  })();

  starting.catch((err) => {
    lastError = err.message;
  }).finally(() => {
    starting = null;
  });

  return starting;
}

function decodeAudio(text) {
  if (!text) return '';
  const body = text.includes(MARK) ? text.split(MARK).pop() : text;
  return body.trim();
}

/* 岗位热词：每行一个，也支持逗号/顿号分隔，最多取 60 个，避免提示词过长拖慢识别。 */
function hotwordHint() {
  const settings = config.load();
  const job = String(settings.profile.job || '').trim().slice(0, 40);
  const words = String(settings.asr.hotwords || '')
    .split(/[\n\r,，、;；]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 60);
  if (!job && !words.length) return '';
  const parts = [];
  if (job) parts.push(`这是「${job}」岗位的面试`);
  if (words.length) parts.push(`听到下列术语或相近发音时，请优先写成这些写法：${words.join('、')}`);
  return `${parts.join('；')}。`;
}

/* 识别语言：外企或英文岗位可固定英文，默认跟随说话人。 */
function languageHint() {
  const lang = String(((config.load() || {}).asr || {}).language || 'auto');
  if (lang === 'en') return '这段语音可能是英文，请用英文忠实转写';
  if (lang === 'zh') return '这是一段中文语音，请用中文忠实转写';
  return '请按说话人实际使用的语言转写（中文或英文）';
}

/* 本地请求偶发连接中断（进程刚重启、端口瞬间不可用）时重试一次，400ms 退避。
 * 只重试网络类错误；120 秒超时不重试，避免再把用户晾两分钟。 */
function isTransientLocalError(err) {
  if (!err) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return false;
  // 只认连接层错误；代码自身的 TypeError 不能当成网络抖动重试。
  const detail = `${err.message || ''} ${(err.cause && err.cause.code) || ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR/i.test(detail);
}

async function transcribeLlamaOnce(wav) {
  const base = await ensureServer();
  const hint = hotwordHint();
  const lead = `${languageHint()}，只输出转写文本。`;
  const prompt = hint ? `${lead}${hint}` : lead;
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'input_audio',
            input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
          },
        ],
      }],
      temperature: 0.0,
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`本地 ASR 转写失败（HTTP ${response.status}）：${detail}`);
  }
  const payload = await response.json();
  return decodeAudio(payload.choices?.[0]?.message?.content || '');
}

async function transcribeLlama(wav) {
  try {
    return await transcribeLlamaOnce(wav);
  } catch (err) {
    if (!isTransientLocalError(err)) throw err;
    log(`本地识别连接中断，400ms 后重试一次：${err.message}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    return transcribeLlamaOnce(wav);
  }
}

function hotwordWords() {
  return String(config.load().asr.hotwords || '')
    .split(/[\n\r,，、;；]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .slice(0, 60);
}

/* IPC 传过来的可能是 Buffer、ArrayBuffer 或 TypedArray，统一成 Buffer。 */
function toBuffer(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/* 用户自带的转写服务：按 OpenAI 兼容的 /audio/transcriptions 上传 WAV，
 * 不经过官方，也不产生官方时长费用。 */
async function transcribeOwn(wav) {
  const settings = config.load().asr;
  const base = String(settings.base_url || '').trim().replace(/\/+$/, '');
  const key = String(settings.api_key || '').trim();
  const model = String(settings.model || '').trim();
  if (!base || !key || !model) {
    throw new Error('自定义语音识别未配置完整：请填写接口地址、API Key 和模型名');
  }

  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', model);
  const lang = String(settings.language || 'auto');
  if (lang === 'zh' || lang === 'en') form.append('language', lang);
  const hint = hotwordHint();
  if (hint) form.append('prompt', hint);

  let response;
  try {
    response = await fetch(`${base}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('自定义识别超时，请检查网络或接口地址');
    }
    throw new Error(`连不上自定义识别服务：${err.message}`);
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`自定义识别失败（HTTP ${response.status}）：${detail}`);
  }
  const data = await response.json().catch(() => ({}));
  return String(data.text || data.transcript || '').trim();
}

/* 官方云端识别走登录转发：有 Opus 就传 Opus（24kbps，带宽只有 WAV 的十分之一），没有就退回 WAV。 */
async function transcribeRelay(wav, opus) {
  const plain = auth.token();
  if (!plain) throw new Error('云端识别需要先登录账号');

  // 先看服务端开关：未开放就不发请求，直接让上层走本机。
  const conf = await cloud.asrConfig();
  if (!conf.enabled) {
    cloudUnsupportedUntil = Date.now() + CLOUD_UNSUPPORTED_MS;
    const err = new Error('云端识别暂未开放');
    err.unsupported = true;
    throw err;
  }
  if (wav.byteLength > conf.max_audio_bytes && (!opus || opus.byteLength > conf.max_audio_bytes)) {
    const err = new Error('这段音频过长，已跳过');
    err.tooLarge = true;
    throw err;
  }

  const settings = config.load().asr;
  const post = async (buffer, format) => {
    try {
      return await fetch(`${auth.baseUrl()}/api/asr/transcribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${plain}`,
        },
        body: JSON.stringify({
          audio: Buffer.from(buffer).toString('base64'),
          format,
          language: settings.language || 'auto',
          hotwords: hotwordWords(),
        }),
        signal: AbortSignal.timeout(conf.timeout_ms),
      });
    } catch (err) {
      const timeout = new Error('云端识别超时，请检查网络');
      timeout.network = true;
      timeout.timeout = true;
      throw timeout;
    }
  };

  const useOpus = Boolean(opus && opus.byteLength) && !opusRejected;
  let response = await post(useOpus ? opus : wav, useOpus ? 'ogg-opus' : 'wav');

  // 服务端只认 WAV 时补一次，宁可多花带宽也别让这段白丢。
  if (useOpus && (response.status === 400 || response.status === 415)) {
    opusRejected = true;
    log(`云端不接受 Ogg/Opus（HTTP ${response.status}），改用 WAV 重试`);
    response = await post(wav, 'wav');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const err = new Error(data.error || `云端识别失败（HTTP ${response.status}）`);
    err.status = response.status;
    if (response.status === 404) {
      err.unsupported = true;
      cloudUnsupportedUntil = Date.now() + CLOUD_UNSUPPORTED_MS;
    }
    if (response.status === 401) err.message = '登录已失效，请重新登录';
    if (response.status === 402) err.message = '剩余时长不足，请先兑换时长码或充值';
    if (response.status === 413) err.message = '这段音频过长，已跳过';
    throw err;
  }

  const data = await response.json().catch(() => ({}));
  return String(data.text || '').trim();
}

async function transcribe(input) {
  const settings = config.load().asr;
  const wav = toBuffer(input && input.wav ? input.wav : input);
  const opus = toBuffer(input && input.opus ? input.opus : null);
  if (!wav || wav.byteLength < 800) return '';

  // 用户自带转写服务：不经过官方，失败直接报给用户，不悄悄换路线。
  if (settings.provider === 'own') {
    const text = await transcribeOwn(wav);
    lastError = '';
    return text;
  }

  // 用户手动选了云端：云端失败时，本机就绪就回退，账号/余额问题直接抛给用户处理。
  if (settings.provider === 'cloud') {
    // 刚确认过服务端没开云端：直接走本机，不再每段多等一次往返。
    if (Date.now() < cloudUnsupportedUntil) {
      if (available()) return transcribeLlama(wav);
      throw new Error('云端识别暂未开放，请到设置 → 语音识别 选择本机识别');
    }
    try {
      const text = await transcribeRelay(wav, opus);
      lastError = '';
      return text;
    } catch (err) {
      lastError = err.message;
      if (err.status === 401 || err.status === 402) throw err;
      if (available()) {
        try {
          log(`云端识别失败，改用本机：${err.message}`);
          return await transcribeLlama(wav);
        } catch (localErr) {
          throw new Error(`${err.message}；本机识别也失败：${localErr.message}`);
        }
      }
      if (err.unsupported) throw new Error('云端识别暂未开放，请到设置 → 语音识别 选择本机识别');
      throw err;
    }
  }

  // 本地优先：失败进入冷却，冷却期内直接走云端，避免每段都等本地超时。
  if (Date.now() >= cloudUntil && available()) {
    try {
      const text = await transcribeLlama(wav);
      localFailures = 0;
      return text;
    } catch (err) {
      localFailures += 1;
      lastError = err.message;
      log(`本地识别失败（第 ${localFailures} 次）：${err.message}`);
      if (localFailures >= LOCAL_FAIL_LIMIT) {
        cloudUntil = Date.now() + CLOUD_COOLDOWN_MS;
        log('本地连续失败，5 分钟内改用云端识别');
      }
    }
  }

  // 刚确认过云端没开：本机也没起来时直接报清楚，不再白等一次往返。
  if (Date.now() < cloudUnsupportedUntil) {
    throw new Error(lastError || '识别暂时不可用，请到设置 → 语音识别 里检查');
  }

  try {
    const text = await transcribeRelay(wav, opus);
    lastError = '';
    return text;
  } catch (err) {
    if (err.status === 401 || err.status === 402) throw err;
    if (err.unsupported) {
      throw new Error(lastError ? `${lastError}；云端识别也不可用，请到设置里检查识别方式` : '识别暂时不可用，请到设置 → 语音识别 里检查');
    }
    lastError = lastError ? `${lastError} / 云端：${err.message}` : err.message;
    throw err;
  }
}

/* 后台预热：失败只记日志，不影响启动；真正的转写请求仍会自己排队等就绪。 */
function prewarm() {
  return ensureServer().catch((err) => {
    log(`后台预热失败：${err.message}`);
    return '';
  });
}

/* 切换识别方式 / 覆盖引擎文件前先停掉旧进程：等它真的退出再返回，
 * 否则新引擎可能撞上还没释放的端口，两个进程互相抢同一份模型。 */
function shutdown() {
  /* 让还在启动流程里的 ensureServer 感知取消，不再把引擎进程拉起来。 */
  startEpoch += 1;
  const child = server;
  const pending = starting;
  server = null;
  ready = false;
  starting = null;
  localFailures = 0;
  cloudUntil = 0;
  cloudUnsupportedUntil = 0;
  if (pending) pending.catch(() => {});
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer = null;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(done, 3000);
    child.once('exit', done);
    try {
      child.kill();
    } catch (err) {
      done();
    }
  });
}

/* 主进程异常退出时的同步兜底：只杀自己记录的 PID，不按进程名扫。 */
function killSync() {
  startEpoch += 1;
  const pid = server && server.pid;
  server = null;
  ready = false;
  starting = null;
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 3000,
    });
  } catch (err) {
    // 退出阶段不能抛错
  }
}

module.exports = { transcribe, status, available, shutdown, killSync, ensureServer, prewarm };

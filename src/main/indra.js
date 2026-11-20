/* Indra OCR（ONNX）本地识别：模型按需下载，默认走 hf-mirror，失败再回源。
 * 只做「图片 → 文字」，数学公式和翻译不在这一步。 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

const PRESET = 'v1.1';
const REVISION = 'a1283c4b42a273c09480ad50e71461daff50fcc7';

/* 中文题目主要用检测、主识别、CJK 识别；另外两组文字识别器一起下，
 * 避免截图里混进英文/符号时在识别过程中临时联网。 */
const FILES = [
  ['det', 'det.onnx'],
  ['rec', 'rec.onnx'],
  ['recCjk', 'rec_cjk.onnx'],
  ['recRtl', 'rec_rtl.onnx'],
  ['recWorld', 'rec_world.onnx'],
  ['script', 'script.onnx'],
  ['orient', 'orient.onnx'],
  ['order', 'order.onnx'],
  ['meta', 'meta.json'],
];

const HOSTS = [
  `https://hf-mirror.com/datalab-to/indra-ocr/resolve/${REVISION}`,
  `https://huggingface.co/datalab-to/indra-ocr/resolve/${REVISION}`,
  'https://github.com/PT-Perkasa-Pilar-Utama/ppu-indra-ocr/raw/main/models/v1.1',
];

let servicePromise = null;

function modelDir() {
  return path.join(app.getPath('userData'), 'models', 'indra', PRESET);
}

function filePath(name) {
  return path.join(modelDir(), name);
}

function isReady() {
  return FILES.every(([, name]) => {
    try {
      return fs.statSync(filePath(name)).size > 0;
    } catch (err) {
      return false;
    }
  });
}

async function downloadOne(name, onProgress) {
  let lastError = '';
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${name}`, { signal: AbortSignal.timeout(180000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('下载内容为空');
      // 先写临时文件再改名，下载中断不会留下半个模型。
      const tmp = `${filePath(name)}.part`;
      await fsp.writeFile(tmp, buffer);
      await fsp.rename(tmp, filePath(name));
      onProgress({ file: name, loaded: buffer.length });
      return;
    } catch (err) {
      lastError = `${host} → ${err.message}`;
    }
  }
  throw new Error(`下载 ${name} 失败：${lastError}`);
}

/* 下载缺失的模型；已存在的跳过，重复调用是安全的。 */
async function prepare(onProgress = () => {}) {
  await fsp.mkdir(modelDir(), { recursive: true });
  const missing = FILES.filter(([, name]) => {
    try {
      return !(fs.statSync(filePath(name)).size > 0);
    } catch (err) {
      return true;
    }
  });
  for (let i = 0; i < missing.length; i += 1) {
    const [role, name] = missing[i];
    onProgress({ stage: 'downloading', role, file: name, index: i + 1, total: missing.length });
    await downloadOne(name, () => {
      onProgress({ stage: 'saved', role, file: name, index: i + 1, total: missing.length });
    });
  }
  servicePromise = null;
  onProgress({ stage: 'ready' });
  return { ok: true, dir: modelDir() };
}

async function getService() {
  if (!isReady()) throw new Error('识别模型还没下载，请在「设置 → 笔试」里下载');
  if (!servicePromise) {
    servicePromise = (async () => {
      const { IndraOcrService } = await import('ppu-indra-ocr');
      const models = {};
      for (const [role, name] of FILES) models[role] = filePath(name);
      const service = new IndraOcrService({ model: PRESET, lm: false, models });
      await service.initialize();
      return service;
    })().catch((err) => {
      servicePromise = null;
      throw err;
    });
  }
  return servicePromise;
}

/* file 是裁切后的 PNG 路径；返回按阅读顺序排好的整页文字。 */
async function recognize(file) {
  const service = await getService();
  const page = await service.convert(fs.readFileSync(file));
  return String(page.text || '').trim();
}

async function destroy() {
  const pending = servicePromise;
  servicePromise = null;
  if (!pending) return;
  try {
    const service = await pending;
    await service.destroy();
  } catch (err) {
    // 初始化失败时没有会话要释放
  }
}

function status() {
  return { ready: isReady(), dir: modelDir(), preset: PRESET };
}

module.exports = { prepare, recognize, destroy, status, isReady, modelDir };

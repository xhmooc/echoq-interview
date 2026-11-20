/* 笔试模式：框选截图 → OCR / 云端视觉 → 大模型作答 → 电脑悬浮窗 + 手机副屏。
 *
 * 这里不碰考试客户端、不做抢焦点或反作弊绕过：只负责在用户主动按快捷键时截一块屏幕。
 * 识别路线：
 *   local —— Windows 自带 OCR（离线，适合纯文字题）
 *   cloud —— 服务端视觉接口 /api/vision/solve（代码、公式、复杂排版更准）
 *   auto  —— 本地优先，识别为空或像代码/公式时走云端
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, BrowserWindow, desktopCapturer, screen, ipcMain, nativeImage } = require('electron');
const llm = require('./llm');
const phone = require('./phone');
const recorder = require('./recorder');
const auth = require('./auth');
const config = require('./config');
const indra = require('./indra');

const OCR_SCRIPT = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($operation, $resultType) {
  $task = $asTask.MakeGenericMethod($resultType).Invoke($null, @($operation))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$path = $args[0]
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
# 只要中文引擎：回落到系统语言（可能是英文）会把中文识别成一堆乱码。
$engine = $null
foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'zh-Hant')) {
  $language = New-Object Windows.Globalization.Language $tag
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if ($engine) { break }
}
if (-not $engine) {
  foreach ($lang in [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages) {
    if ($lang.LanguageTag -like 'zh*') {
      $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
      if ($engine) { break }
    }
  }
}
if (-not $engine) { Write-Output '{"error":"no_ocr_engine"}'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$lines = @($result.Lines | ForEach-Object { $_.Text })
@{ text = ($lines -join "\`n"); lines = $lines; lang = $engine.RecognizerLanguage.LanguageTag } | ConvertTo-Json -Compress
`;

let getMainWindow = () => null;
let captureWin = null;
let answerWin = null;
let busy = false;
let lastPayload = null;
let answerResize = null;
let answerSaveTimer = null;
let externalSeq = 0;
const externalWaiters = new Map();

function notify(payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send('written:status', payload);
}

function tidyOcr(input) {
  return String(input || '')
    .replace(/\r/g, '')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/([\u3400-\u9fff])\s+(?=[，。！？；：、）】》”’])/g, '$1')
    .replace(/([（【《“‘])\s+(?=[\u3400-\u9fff])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ocrScriptPath() {
  const file = path.join(app.getPath('temp'), 'echoq-ocr.ps1');
  try {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== OCR_SCRIPT) {
      fs.writeFileSync(file, OCR_SCRIPT, 'utf8');
    }
  } catch (err) {
    // 写不进去时下面执行会给出明确错误
  }
  return file;
}

function localOcr(file) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', ocrScriptPath(),
      file,
    ], { timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`本地 OCR 执行失败：${String(stderr || err.message).slice(0, 200)}`));
        return;
      }
      const line = String(stdout || '').split(/\r?\n/).reverse().find((item) => item.trim().startsWith('{'));
      if (!line) {
        reject(new Error('本地 OCR 没有返回结果'));
        return;
      }
      try {
        const data = JSON.parse(line);
        if (data.error === 'no_ocr_engine') {
          reject(new Error('系统没有安装可用的 OCR 语言包'));
          return;
        }
        resolve(tidyOcr(data.text));
      } catch (parseErr) {
        reject(new Error('本地 OCR 结果解析失败'));
      }
    });
  });
}

function cloudVision(imageDataUrl) {
  const token = auth.token();
  const base = auth.baseUrl();
  const raw = String(imageDataUrl || '').split(',')[1] || '';
  if (!raw) throw new Error('截图内容为空');
  return fetch(`${base}/api/vision/solve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ image: raw, mime: 'image/png', mode: 'written' }),
    signal: AbortSignal.timeout(45000),
  }).then(async (response) => {
    if (response.status === 404 || response.status === 501) {
      throw new Error('云端视觉接口尚未上线');
    }
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`云端识别失败（HTTP ${response.status}）：${text.slice(0, 160)}`);
    }
    const data = await response.json();
    return {
      text: tidyOcr(data.text || data.recognized_text || ''),
      answer: String(data.answer || '').trim(),
      provider: 'cloud',
    };
  });
}

/* 用户自带的视觉模型：OpenAI 兼容 /chat/completions，把截图还原成题目文字。
 * 走用户自己的 Key，不经过官方服务。 */
async function customVision(imageDataUrl) {
  const w = config.load().written || {};
  const base = String(w.custom_base_url || '').trim().replace(/\/+$/, '');
  const key = String(w.custom_api_key || '').trim();
  const model = String(w.custom_model || '').trim();
  if (!base || !key || !model) {
    throw new Error('自定义视觉模型未配置完整：请填写接口地址、API Key 和模型名');
  }
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: '你负责把截图里的题目完整转成纯文字：保留题号、选项、代码和公式，不要作答，不要解释。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: '请只输出图片中的文字内容，保持原有换行。' },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        },
      ],
      temperature: 0,
      max_tokens: 2000,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`自定义视觉识别失败（HTTP ${response.status}）：${detail}`);
  }
  const data = await response.json().catch(() => ({}));
  const message = data.choices && data.choices[0] && data.choices[0].message;
  const content = message && message.content;
  return tidyOcr(typeof content === 'string' ? content : '');
}

function looksComplex(text) {
  return /[{}<>;=]|\b(def|function|class|public|static|SELECT|FROM|#include)\b|∫|√|∑|\b[A-Z]\.\s/.test(text);
}

/* 行检测失败时的典型样子：一堆一两个字的“行”（「Vu」「吗」「I」「3」）。
 * 这种结果重答也没意义，先换更大的放大倍数重新识别一次。 */
function looksFragmented(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return false;
  const total = lines.reduce((sum, line) => sum + line.length, 0);
  return total / lines.length < 2.5;
}

/* 按不同倍数重新生成送 OCR 的图：小字放大后识别率高很多，碎片结果则再放大一档。 */
function writeOcrImage(dataUrl, file, targetWidth, maxFactor) {
  let image = nativeImage.createFromDataURL(dataUrl);
  const size = image.getSize();
  if (size.width > 0 && size.width < targetWidth) {
    const factor = Math.min(maxFactor, targetWidth / size.width);
    image = image.resize({ width: Math.round(size.width * factor), quality: 'best' });
  }
  image = padForOcr(image);
  fs.writeFileSync(file, image.toPNG());
  return file;
}

/* 一张截图里常有多道题（「1. … 2. … 3. …」）。按行首题号切成多块，
 * 只有题号至少两个且严格递增时才拆，避免把选项、代码行误当成新题。 */
function splitQuestions(text) {
  const blocks = [];
  let current = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const matched = line.match(/^(?:第\s*)?([0-9]{1,3})\s*[.．、，,:：)）]\s*(.*)$/)
      || line.match(/^[（(]\s*([0-9]{1,3})\s*[)）]\s*(.*)$/);
    if (matched) {
      current = { no: matched[1], lines: [line] };
      blocks.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      return [];
    }
  }
  if (blocks.length < 2) return [];
  const numbers = blocks.map((block) => Number(block.no));
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] <= numbers[i - 1]) return [];
  }
  /* 题号断档（2 后面直接是 4）通常是被漏识别的题号：
   * 上一块最后一行如果本身就是一句完整题目，补成中间那个题号。 */
  const result = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const next = i + 1 < blocks.length ? numbers[i + 1] : null;
    const gap = next === null ? 0 : next - numbers[i] - 1;
    if (gap === 1 && block.lines.length >= 2) {
      const tail = block.lines[block.lines.length - 1];
      if (tail.length >= 6 && /[？?。.]\s*$/.test(tail)) {
        result.push({ no: block.no, text: block.lines.slice(0, -1).join('\n') });
        result.push({ no: String(numbers[i] + 1), text: tail });
        continue;
      }
    }
    result.push({ no: block.no, text: block.lines.join('\n') });
  }
  return result;
}

async function analyze(imageDataUrl, file) {
  const cfg = config.load();
  const mode = (cfg.written && cfg.written.ocr_mode) || 'auto';
  const engine = (cfg.written && cfg.written.ocr_engine) || 'windows';
  let cloudError = '';
  notify({ stage: 'recognizing' });

  /* 自带视觉模型优先：识别成功就直接作答；失败再退回本机 OCR。 */
  if (engine === 'custom') {
    try {
      const customText = await customVision(imageDataUrl);
      if (customText) {
        const items = splitQuestions(customText);
        if (items.length > 1) {
          notify({ stage: 'solving' });
          return { text: customText, items, answer: '', provider: 'custom' };
        }
        notify({ stage: 'solving' });
        const solved = await llm.solveText(customText);
        return { text: customText, answer: solved.answer, provider: 'custom' };
      }
    } catch (err) {
      cloudError = err.message;
    }
  }

  if (mode === 'cloud' && engine !== 'custom') {
    try {
      const cloud = await cloudVision(imageDataUrl);
      if (cloud.answer) return cloud;
      if (cloud.text) return { ...cloud, answer: (await llm.solveText(cloud.text)).answer };
    } catch (err) {
      cloudError = err.message;
    }
  }

  let text = '';
  let localError = '';
  if (engine === 'indra') {
    try {
      text = await indra.recognize(file);
    } catch (err) {
      localError = err.message;
    }
    if (looksFragmented(text)) {
      // 第一遍被拆成单字：放大更多再识别一次，取文字更多的结果。
      try {
        const retryFile = file.replace(/\.png$/i, '.retry.png');
        writeOcrImage(imageDataUrl, retryFile, 2000, 6);
        const retry = await indra.recognize(retryFile);
        if (retry.length > text.length) text = retry;
      } catch (err) {
        localError = `${localError} / ${err.message}`;
      }
    }
    // 模型没下好或加载失败时，别让用户卡住，退回系统 OCR。
    if (!text) {
      try {
        text = await localOcr(file);
      } catch (err) {
        localError = `${localError} / ${err.message}`;
      }
    }
  } else {
    try {
      text = await localOcr(file);
    } catch (err) {
      localError = err.message;
    }
  }

  if (text && (mode !== 'auto' || !looksComplex(text))) {
    const items = splitQuestions(text);
    if (items.length > 1) {
      /* 多题截图：交给渲染层逐题作答，这里不先拼一段大答案。 */
      notify({ stage: 'solving' });
      return { text, items, answer: '', provider: 'local' };
    }
    notify({ stage: 'solving' });
    const solved = await llm.solveText(text);
    return { text, answer: solved.answer, provider: 'local' };
  }

  /* 本地识别为空、或像代码/公式，交给官方云端视觉；云端不可用时再用本地文字硬答。
   * 选了自带视觉模型时不再回落到官方云端，避免用户以为在用自己 Key 却被计费。 */
  if (mode !== 'local' && engine !== 'custom') {
    try {
      const cloud = await cloudVision(imageDataUrl);
      if (cloud.text || cloud.answer) {
        const answer = cloud.answer || (await llm.solveText(cloud.text)).answer;
        return { text: cloud.text || text, answer, provider: 'cloud' };
      }
    } catch (err) {
      cloudError = err.message;
    }
  }

  if (!text) throw new Error(localError || cloudError || '没有识别到题目文字，请重新框选');
  notify({ stage: 'solving' });
  const solved = await llm.solveText(text);
  return { text, answer: solved.answer, provider: 'local' };
}

function cleanupCapture() {
  if (captureWin && !captureWin.isDestroyed()) captureWin.destroy();
  captureWin = null;
}

/* 答案窗当前盖住的区域（显示器坐标）。冻结帧里会带着这个窗口，
 * 框选范围正好压在它上面时不能直接裁冻结帧，否则旧答案会被烙进识别图。 */
function answerRectOn(display) {
  if (!answerWin || answerWin.isDestroyed() || !answerWin.isVisible()) return null;
  const bounds = answerWin.getBounds();
  return {
    x: bounds.x - display.bounds.x,
    y: bounds.y - display.bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function captureRegion(onReveal) {
  if (captureWin) throw new Error('正在截图，请先完成当前框选');
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = display.scaleFactor || 1;
  const avoidRect = answerRectOn(display);
  let previewImage = '';
  /* 优先用常驻桌面流取帧（30~50ms）；流没起好时退回 desktopCapturer（0.5~0.8s）。 */
  let useRecorder = recorder.isReady(display);
  const grabPromise = useRecorder ? recorder.grab() : null;
  /* 慢路径按需触发：流中途断掉时还能退回去，不会因为提前算好的 null 直接失败。 */
  let capturePromise = null;
  const captureSources = () => (capturePromise = capturePromise || desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.max(1, Math.round(display.size.width * scale)),
      height: Math.max(1, Math.round(display.size.height * scale)),
    },
    fetchWindowIcons: false,
  }));
  if (!useRecorder) captureSources();

  const result = await new Promise((resolve, reject) => {
    const overlay = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      /* 必须用构造参数 fullscreen：普通无边框窗口会被 Windows 压到工作区（高度只有 1030），
       * 冻结图会被纵向压扁。 */
      fullscreen: true,
      show: false,
      /* 先以 0 透明度的「可见」窗口创建：这样它从第一刻就参与合成，
       * 图片画好后只是把透明度调到 1，不会出现新窗口首帧的白/黑底闪烁。 */
      opacity: 0,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      backgroundColor: '#000000',
      webPreferences: {
        preload: path.join(__dirname, '../renderer/capture-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        /* 模拟隐藏窗口的后台节流会把定时器压到 1s，图片解码和 ready 都被拖慢。 */
        backgroundThrottling: false,
      },
    });
    captureWin = overlay;
    overlay.setAlwaysOnTop(true, 'screen-saver');
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    /* 不抢焦点地亮出（此时完全透明），让合成器开始出帧。 */
    overlay.showInactive();

    let settled = false;
    let revealTimer = null;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(revealTimer);
      ipcMain.removeListener('capture:done', onDone);
      ipcMain.removeListener('capture:cancel', onCancel);
      ipcMain.removeListener('capture:ready', onReady);
      cleanupCapture();
      if (error) reject(error);
      else resolve(value);
    };
    const reveal = async () => {
      if (settled || overlay.isDestroyed()) return;
      /* 内容已经画好（渲染层 ready + 下面强制出一帧），直接把透明度拉到 1：
       * 冻结图是一次性「显影」出来的，没有新窗口首帧的白底。 */
      try {
        await overlay.webContents.capturePage();
      } catch (err) {}
      if (settled || overlay.isDestroyed()) return;
      if (!overlay.isVisible()) overlay.showInactive();
      overlay.setOpacity(1);
      overlay.moveTop();
      overlay.focus();
      /* 冻结帧里本来就有答案窗的像素，先亮冻结层再藏答案窗，屏幕上的画面是连续的。 */
      setTimeout(() => {
        if (settled) return;
        if (onReveal) {
          try { onReveal(); } catch (err) {}
        }
      }, 50);
    };
    const onReady = (event) => {
      if (event.sender !== overlay.webContents) return;
      ipcMain.removeListener('capture:ready', onReady);
      clearTimeout(revealTimer);
      reveal();
    };
    const onDone = (event, rect) => {
      if (event.sender !== overlay.webContents) return;
      const x = Math.max(0, Math.round(Number(rect && rect.x) || 0));
      const y = Math.max(0, Math.round(Number(rect && rect.y) || 0));
      const width = Math.max(0, Math.round(Number(rect && rect.width) || 0));
      const height = Math.max(0, Math.round(Number(rect && rect.height) || 0));
      if (width < 8 || height < 8) {
        finish(null);
        return;
      }
      finish({ x, y, width, height, scale });
    };
    const onCancel = (event) => {
      if (event.sender !== overlay.webContents) return;
      finish(null);
    };
    const timer = setTimeout(() => finish(null, new Error('截图超时，请重试')), 120000);

    ipcMain.on('capture:done', onDone);
    ipcMain.on('capture:cancel', onCancel);
    ipcMain.on('capture:ready', onReady);
    overlay.on('closed', () => finish(null));

    const loaded = overlay.loadFile(path.join(__dirname, '../renderer/capture.html'));
    Promise.all([loaded]).then(async () => {
      let preview = '';
      if (useRecorder) {
        try {
          const frame = await grabPromise;
          preview = frame.jpeg;
        } catch (err) {
          /* 流在创建窗口期间断掉：本次退回慢路径，不打扰用户。 */
          useRecorder = false;
        }
      }
      if (!useRecorder) {
        const sources = await captureSources();
        const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
        if (!source || source.thumbnail.isEmpty()) {
          finish(null, new Error('无法截取屏幕，请检查系统录屏权限'));
          return;
        }
        /* 预览只用于显示，用 JPEG 比 PNG 小一个数量级：编码、IPC 传输、解码都更快。 */
        preview = `data:image/jpeg;base64,${source.thumbnail.toJPEG(92).toString('base64')}`;
      }
      if (settled || overlay.isDestroyed()) return;
      previewImage = preview;
      overlay.webContents.send('capture:init', {
        image: preview,
        width: display.bounds.width,
        height: display.bounds.height,
        scale,
      });
      /* 等渲染层把整屏截图解码并绘制完再显示；否则会先看到一帧黑底（闪一下）。 */
      revealTimer = setTimeout(reveal, 2500);
    }).catch((err) => finish(null, err));
  });

  if (!result) return null;
  const dir = path.join(app.getPath('temp'), 'echoq-written');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}.png`);

  /* 冻结层和框选层是同一张画面：按图片实际像素比例换算，避免缩放或多屏时切偏。 */
  const base = nativeImage.createFromDataURL(previewImage);
  const size = base.isEmpty() ? { width: 0, height: 0 } : base.getSize();
  const kx = size.width ? size.width / display.bounds.width : scale;
  const ky = size.height ? size.height / display.bounds.height : scale;
  const pixelRect = {
    x: Math.max(0, Math.round(result.x * kx)),
    y: Math.max(0, Math.round(result.y * ky)),
    width: 1,
    height: 1,
  };
  pixelRect.x = Math.min(pixelRect.x, Math.max(0, size.width - 1));
  pixelRect.y = Math.min(pixelRect.y, Math.max(0, size.height - 1));
  pixelRect.width = Math.max(1, Math.min(Math.round(result.width * kx), Math.max(1, size.width - pixelRect.x)));
  pixelRect.height = Math.max(1, Math.min(Math.round(result.height * ky), Math.max(1, size.height - pixelRect.y)));

  const coversAnswer = Boolean(useRecorder && avoidRect && rectsOverlap(result, avoidRect));
  let dataUrl = '';
  if (size.width && !coversAnswer) {
    /* 直接裁冻结那一帧：和用户框选时看到的完全一致，也不会把框选层的边框带进去。 */
    dataUrl = base.crop(pixelRect).toDataURL();
  } else if (useRecorder) {
    /* 选区压在答案窗上：等冻结层从桌面流里消失后再取一帧，保证识别图里没有上一题的答案。 */
    await new Promise((resolve) => setTimeout(resolve, 180));
    dataUrl = (await recorder.crop(pixelRect)).png;
  }
  if (!dataUrl) throw new Error('截图裁切失败，请重试');
  /* 小图放大后再交给 OCR：Windows OCR 对 11~13px 的小字很吃力，放大 2~3 倍识别率差别明显。
   * 原图（dataUrl）照旧给答案窗和手机用，只有送 OCR 的文件是放大并补边的。 */
  writeOcrImage(dataUrl, file, 1600, 4);
  return { dataUrl, file };
}

/* 紧贴文字边缘的裁切会让行检测器把每个字当成一行（Indra 在小图上尤其明显）。
 * 沿边缘补一圈和背景同色的留白，检测就能把整行连起来。 */
function padForOcr(image) {
  const size = image.getSize();
  if (!size.width || !size.height) return image;
  const pad = Math.max(12, Math.round(Math.min(size.width, size.height) * 0.15));
  const width = size.width + pad * 2;
  const height = size.height + pad * 2;
  const src = image.toBitmap();
  const out = Buffer.alloc(width * height * 4);
  // 取四条边的平均色当背景：浅色界面补白、深色界面补黑，不会给识别图加一圈突兀的边。
  const rowBytes = size.width * 4;
  let sumB = 0;
  let sumG = 0;
  let sumR = 0;
  let samples = 0;
  const sample = (offset) => {
    sumB += src[offset];
    sumG += src[offset + 1];
    sumR += src[offset + 2];
    samples += 1;
  };
  for (let x = 0; x < size.width; x += 1) {
    sample(x * 4);
    sample((size.height - 1) * rowBytes + x * 4);
  }
  for (let y = 0; y < size.height; y += 1) {
    sample(y * rowBytes);
    sample(y * rowBytes + (size.width - 1) * 4);
  }
  const b = Math.round(sumB / samples);
  const g = Math.round(sumG / samples);
  const r = Math.round(sumR / samples);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = b;
    out[i + 1] = g;
    out[i + 2] = r;
    out[i + 3] = 255;
  }
  for (let y = 0; y < size.height; y += 1) {
    src.copy(out, ((y + pad) * width + pad) * 4, y * rowBytes, (y + 1) * rowBytes);
  }
  return nativeImage.createFromBitmap(out, { width, height });
}

function answerBounds() {
  const saved = ((config.load().window || {}).answer) || {};
  const primary = screen.getPrimaryDisplay().workArea;
  const width = Math.max(300, Number(saved.width) || 380);
  const height = Math.max(180, Number(saved.height) || 320);
  const hasPos = typeof saved.x === 'number' && typeof saved.y === 'number';
  const wanted = {
    x: hasPos ? saved.x : primary.x + primary.width - width - 16,
    y: hasPos ? saved.y : primary.y + 24,
    width,
    height,
  };
  const area = screen.getDisplayMatching(wanted).workArea;
  const clampedWidth = Math.min(wanted.width, area.width);
  const clampedHeight = Math.min(wanted.height, area.height);
  return {
    x: Math.min(Math.max(wanted.x, area.x), area.x + area.width - clampedWidth),
    y: Math.min(Math.max(wanted.y, area.y), area.y + area.height - clampedHeight),
    width: clampedWidth,
    height: clampedHeight,
  };
}

function saveAnswerBounds() {
  if (!answerWin || answerWin.isDestroyed()) return;
  const bounds = answerWin.getBounds();
  try {
    config.save({
      window: {
        answer: {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        },
      },
    });
  } catch (err) {
    // 写配置失败不影响悬浮窗
  }
}

function scheduleSaveAnswerBounds() {
  clearTimeout(answerSaveTimer);
  answerSaveTimer = setTimeout(saveAnswerBounds, 250);
}

/* 无边框透明窗口没有系统自带的缩放热区，右下角手柄用屏幕坐标在主进程里算，
 * 这样鼠标拖出窗口也不会中断。 */
function startAnswerResize() {
  if (!answerWin || answerWin.isDestroyed()) return;
  stopAnswerResize(false);
  const bounds = answerWin.getBounds();
  const cursor = screen.getCursorScreenPoint();
  const poll = setInterval(() => {
    if (!answerWin || answerWin.isDestroyed()) {
      stopAnswerResize(false);
      return;
    }
    const now = screen.getCursorScreenPoint();
    const wantedWidth = bounds.width + (now.x - cursor.x);
    const wantedHeight = bounds.height + (now.y - cursor.y);
    const area = screen.getDisplayMatching({
      x: bounds.x,
      y: bounds.y,
      width: Math.max(300, wantedWidth),
      height: Math.max(180, wantedHeight),
    }).workArea;
    const width = Math.max(300, Math.min(area.x + area.width - bounds.x, wantedWidth));
    const height = Math.max(180, Math.min(area.y + area.height - bounds.y, wantedHeight));
    answerWin.setSize(Math.round(width), Math.round(height));
  }, 16);
  const safety = setTimeout(() => stopAnswerResize(true), 15000);
  answerResize = { poll, safety };
}

function stopAnswerResize(save = true) {
  if (answerResize) {
    clearInterval(answerResize.poll);
    clearTimeout(answerResize.safety);
    answerResize = null;
  }
  if (save) saveAnswerBounds();
}

function ensureAnswerWindow() {
  if (answerWin && !answerWin.isDestroyed()) return answerWin;
  const bounds = answerBounds();
  answerWin = new BrowserWindow({
    ...bounds,
    minWidth: 300,
    minHeight: 180,
    frame: false,
    transparent: false,
    backgroundColor: '#0e1118',
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../renderer/answer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  answerWin.setAlwaysOnTop(true, 'screen-saver');
  answerWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  answerWin.loadFile(path.join(__dirname, '../renderer/answer.html'));
  answerWin.once('ready-to-show', () => {
    if (answerWin && !answerWin.isDestroyed()) answerWin.showInactive();
  });
  answerWin.on('moved', scheduleSaveAnswerBounds);
  answerWin.on('resized', scheduleSaveAnswerBounds);
  answerWin.on('closed', () => {
    stopAnswerResize(false);
    answerWin = null;
  });
  return answerWin;
}

function showAnswer(payload, force = false) {
  lastPayload = payload;
  const target = (config.load().written && config.load().written.answer_target) || 'both';
  if (target === 'phone' && !force) return;
  const win = ensureAnswerWindow();
  const send = () => {
    if (win && !win.isDestroyed()) win.webContents.send('answer:data', payload);
    if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function toggleAnswer() {
  if (answerWin && !answerWin.isDestroyed() && answerWin.isVisible()) {
    answerWin.hide();
    return { ok: true, visible: false };
  }
  if (lastPayload) {
    showAnswer(lastPayload, true);
    return { ok: true, visible: true };
  }
  return { ok: false, error: '还没有答案' };
}

function hideAnswer() {
  if (answerWin && !answerWin.isDestroyed()) answerWin.hide();
}

function publish(payload) {
  const target = (config.load().written && config.load().written.answer_target) || 'both';
  if (target !== 'pc') phone.push({ text: payload.text, answer: payload.answer });
  showAnswer(payload);
}

async function captureAndSolve(source = 'main') {
  if (busy) return { ok: false, error: '正在处理上一题，请稍等' };
  busy = true;
  /* 兜底预热：正常在切到笔试模式时已经起流，这里只处理启动失败/换屏的情况。 */
  recorder.warm(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()));
  const answerWasVisible = Boolean(answerWin && !answerWin.isDestroyed() && answerWin.isVisible());
  notify({ stage: 'capturing', source });
  try {
    /* 答案窗留到冻结层亮出来的那一刻再藏（见 captureRegion 的 reveal）：
     * 提前藏会先露出真实桌面，就是那道“闪一下”。冻结图里已经带着答案窗的像素，衔接是连续的。 */
    const shot = await captureRegion(() => {
      if (answerWasVisible) hideAnswer();
    });
    if (!shot) {
      if (answerWasVisible) showAnswer(lastPayload, true);
      notify({ stage: 'idle', source });
      return { ok: false, cancelled: true };
    }
    const analyzed = await analyze(shot.dataUrl, shot.file);
    const payload = {
      text: analyzed.text,
      answer: analyzed.answer,
      provider: analyzed.provider,
      items: analyzed.items || null,
      image: shot.dataUrl,
      at: Date.now(),
    };
    if (Array.isArray(payload.items) && payload.items.length > 1) {
      /* 多题：答案由逐题作答陆续推过来，这里不推空答案覆盖掉上一题。 */
      notify({ stage: 'solving', source });
      return { ok: true, ...payload };
    }
    publish(payload);
    /* 从答案悬浮窗点「截下一题」时，用户本来就看着这个窗口，答案出来后强制回到 PC。 */
    if (source === 'answer' && answerWasVisible) showAnswer(payload, true);
    notify({ stage: 'done', source, ...payload });
    return { ok: true, ...payload };
  } catch (err) {
    if (answerWasVisible) showAnswer(lastPayload, true);
    notify({ stage: 'error', source, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
}

/* 答案悬浮窗和手机副屏都通过主界面发起截图：
 * 这样登录校验、计时和答案落库仍然只走渲染层一份逻辑，不会出现外部入口免费答题。 */
function requestExternalCapture(source = 'answer') {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return Promise.resolve({ ok: false, error: '主窗口不可用' });
  const id = ++externalSeq;
  const wasVisible = Boolean(answerWin && !answerWin.isDestroyed() && answerWin.isVisible());
  /* 不在这里提前藏答案窗：冻结层亮出时再藏，画面才是连续的。 */
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      externalWaiters.delete(id);
      if (wasVisible && lastPayload) showAnswer(lastPayload, true);
      resolve({ ok: false, error: '截图超时' });
    }, 130000);
    externalWaiters.set(id, (result) => {
      clearTimeout(timer);
      if (!result || !result.ok) {
        if (wasVisible && lastPayload) showAnswer(lastPayload, true);
      } else if (source === 'answer' && wasVisible && lastPayload) {
        /* 用户是从答案窗点的截图，即使设置成只推手机，也把新答案放回他正在看的窗口。 */
        showAnswer(lastPayload, true);
      }
      resolve(result || { ok: false, error: '截图失败' });
    });
    win.webContents.send('written:capture-request', { id, source });
  });
}

function cancelCapture() {
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.destroy();
    return { ok: true };
  }
  return { ok: false, error: '当前没有正在进行的截图' };
}

async function solve(text) {
  const question = String(text || '').trim();
  if (!question) return { ok: false, error: '题目文字为空' };
  if (busy) return { ok: false, error: '正在处理上一题，请稍等' };
  busy = true;
  notify({ stage: 'solving' });
  try {
    const solved = await llm.solveText(question);
    const payload = {
      text: question,
      answer: solved.answer,
      provider: 'text',
      image: '',
      at: Date.now(),
    };
    publish(payload);
    notify({ stage: 'done', ...payload });
    return { ok: true, ...payload };
  } catch (err) {
    notify({ stage: 'error', error: err.message });
    return { ok: false, error: err.message };
  } finally {
    busy = false;
  }
}

function init(getWin) {
  getMainWindow = typeof getWin === 'function' ? getWin : () => null;
  phone.setCaptureHandlers({
    capture: () => requestExternalCapture('phone'),
    cancel: () => cancelCapture(),
  });
}

ipcMain.on('answer:hide', (event) => {
  if (!answerWin || event.sender !== answerWin.webContents) return;
  stopAnswerResize();
  answerWin.hide();
});

ipcMain.handle('answer:capture', (event) => {
  if (!answerWin || event.sender !== answerWin.webContents) {
    return { ok: false, error: '无效窗口' };
  }
  return requestExternalCapture('answer');
});

ipcMain.on('answer:resize-start', (event) => {
  if (answerWin && event.sender === answerWin.webContents) startAnswerResize();
});

ipcMain.on('answer:resize-end', (event) => {
  if (answerWin && event.sender === answerWin.webContents) stopAnswerResize();
});

ipcMain.handle('written:external-result', (event, payload) => {
  const id = payload && payload.id;
  const waiter = externalWaiters.get(id);
  if (waiter) {
    externalWaiters.delete(id);
    waiter(payload.result);
  }
  return { ok: true };
});

function syncMode(mode) {
  /* 笔试模式常驻桌面流，按快捷键时直接取最新帧；切回面试就关掉，避免一直采集屏幕。 */
  if (mode === 'written') {
    recorder.start(screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).catch(() => {});
  } else {
    recorder.stop();
  }
}

function shutdown() {
  cleanupCapture();
  recorder.stop();
  stopAnswerResize(false);
  for (const waiter of externalWaiters.values()) {
    waiter({ ok: false, error: '应用已退出' });
  }
  externalWaiters.clear();
  if (answerWin && !answerWin.isDestroyed()) answerWin.destroy();
  answerWin = null;
  phone.stop();
}

module.exports = {
  init, captureAndSolve, solve, toggleAnswer, hideAnswer, showAnswer, syncMode, shutdown,
};

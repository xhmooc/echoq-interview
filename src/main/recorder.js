/* 常驻桌面视频流：进笔试模式时起一条隐藏的桌面采集流，按快捷键时直接取最新一帧。
 *
 * 为什么要单独做：desktopCapturer.getSources 在 Windows 上每次要 0.5~0.8s（即使不要缩略图），
 * 而界面冻结需要的是“按下快捷键那一刻”的画面，没必要每次都重新枚举/抓屏。
 * 流起来之后取一帧只要 30~50ms。流只在笔试模式期间存在，切回面试或退出应用就关闭。
 */
const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain, session } = require('electron');

const START_TIMEOUT = 6000;
const REQUEST_TIMEOUT = 2500;

let win = null;
let ready = false;
let displayId = null;
let starting = null;
let startSettlers = null;
let seq = 0;
const waiters = new Map();
let recorderSession = null;

/* 采集页单独一个 session：主窗的权限策略默认拒绝非主窗的 media 请求，
 * 这里只给采集页放行 media，不影响其它窗口的安全策略。 */
function captureSession() {
  if (recorderSession) return recorderSession;
  recorderSession = session.fromPartition('echoq-recorder');
  recorderSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(permission === 'media');
  });
  recorderSession.setPermissionCheckHandler((contents, permission) => permission === 'media');
  return recorderSession;
}

function settleStart(ok, error) {
  if (!startSettlers) return;
  const { resolve, reject, timer } = startSettlers;
  startSettlers = null;
  clearTimeout(timer);
  if (ok) resolve(true);
  else reject(error || new Error('桌面流启动失败'));
}

ipcMain.on('recorder:ready', (event) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  ready = true;
  settleStart(true);
});

ipcMain.on('recorder:error', (event, message) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  console.warn('[recorder] 采集失败：', message);
  ready = false;
  settleStart(false, new Error(String(message || '桌面流启动失败')));
});

ipcMain.on('recorder:frame', (event, payload) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const waiter = waiters.get(payload && payload.id);
  if (!waiter) return;
  waiters.delete(payload.id);
  clearTimeout(waiter.timer);
  if (payload.error) waiter.reject(new Error(payload.error));
  else waiter.resolve(payload);
});

function stop() {
  ready = false;
  displayId = null;
  settleStart(false, new Error('桌面流已关闭'));
  for (const [, waiter] of waiters) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error('桌面流已关闭'));
  }
  waiters.clear();
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

function isReady(display) {
  return Boolean(win && !win.isDestroyed() && ready && display && String(display.id) === String(displayId));
}

/* 起流（幂等）。同一块屏已经就绪就直接返回 true；切换显示器时会重建。 */
function start(display) {
  if (!display) return Promise.resolve(false);
  if (isReady(display)) return Promise.resolve(true);
  if (starting) return starting;
  if (win) stop();

  starting = (async () => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
      if (!source) throw new Error('没有找到可采集的屏幕');
      displayId = display.id;
      win = new BrowserWindow({
        show: false,
        width: 320,
        height: 180,
        skipTaskbar: true,
        webPreferences: {
          session: captureSession(),
          preload: path.join(__dirname, '../renderer/recorder-preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      win.on('closed', () => {
        win = null;
        ready = false;
        displayId = null;
      });
      await win.loadFile(path.join(__dirname, '../renderer/recorder.html'), {
        query: { source: source.id },
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          startSettlers = null;
          reject(new Error('桌面流启动超时'));
        }, START_TIMEOUT);
        startSettlers = { resolve, reject, timer };
      });
      return true;
    } catch (err) {
      stop();
      return false;
    } finally {
      starting = null;
    }
  })();
  return starting;
}

/* 预热：不等待结果，失败就下次走慢路径。 */
function warm(display) {
  if (isReady(display) || starting) return;
  start(display).catch(() => {});
}

function request(channel, payload) {
  if (!win || win.isDestroyed() || !ready) return Promise.reject(new Error('桌面流未就绪'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error('取帧超时'));
    }, REQUEST_TIMEOUT);
    waiters.set(id, { resolve, reject, timer });
    win.webContents.send(channel, { id, ...payload });
  });
}

/* 最新一帧，JPEG dataURL（只用于冻结层预览）。 */
const grab = () => request('recorder:grab', {});

/* 按选区裁切，PNG dataURL（用于 OCR 和答案窗原图）。rect 已经是物理像素。 */
const crop = (rect) => request('recorder:crop', { rect });

module.exports = { start, warm, stop, isReady, grab, crop };

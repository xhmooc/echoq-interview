const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const {
  app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, screen, session, shell, dialog,
  Tray, Menu, nativeImage, webContents,
} = require('electron');

// 固定应用名，保证开发运行和打包后的用户数据目录（模型、配置、日志）一致；
// 收费版用独立的目录，避免和开源版共用同一份配置与登录状态。
app.setName('interview-copilot-pro');

const config = require('./src/main/config');
const paths = require('./src/main/paths');
const APP_ICON = path.join(__dirname, 'build', 'icon.png');
const assets = require('./src/main/assets');
const asr = require('./src/main/asr');
const hardware = require('./src/main/hardware');
const llm = require('./src/main/llm');
const resume = require('./src/main/resume');
const auth = require('./src/main/auth');
const cloud = require('./src/main/cloud');
const orders = require('./src/main/orders');
const updater = require('./src/main/updater');
const written = require('./src/main/written');
const indra = require('./src/main/indra');
const phone = require('./src/main/phone');
const logger = require('./src/main/logger');

logger.install();

/* 启动分段计时：日志里直接给出相对进程创建的毫秒数，方便定位是哪一段变慢。 */
function bootMark(label) {
  console.log(`[boot] ${label} ${Math.round(process.uptime() * 1000)}ms`);
}

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err && err.stack ? err.stack : err);
});

let win = null;
let mini = null;
let miniMode = 'lyrics';
let lyricsHoverTimer = null;
let lyricsRevealUntil = 0;
let lyricsInside = false;
let lyricsHot = false;
let lyricsInteractive = false;
let lyricsHoverKey = '';
let lyricsPopover = false;
let lyricsGrab = false;
let lastMiniState = null;
let quitting = false;
/* 计费会话：客户端幂等键在首次开始计时时生成，失败重试沿用同一个；
 * activeUsage 只在服务端确认开始/停止后变化，退出时据此补一次结算。 */
let usageClientId = '';
let activeUsage = null;
let usageQuitSettled = false;
let onboardingPrevBounds = null;
let onboardingOpen = false;
let tray = null;
let clickThrough = false;
/* 一分钟内连续崩溃三次就不再自动重载，避免死循环。 */
const rendererCrashTimes = [];

const MINI_MIN_WIDTH = 300;
const MINI_MIN_HEIGHT = 320;
const LYRICS_MIN_WIDTH = 320;
const LYRICS_MIN_HEIGHT = 180;
// 首次引导只临时放大到四步内容实际需要的尺寸（最长一步是简历/大纲），不再占大半屏。
const ONBOARDING_WIDTH = 560;
const ONBOARDING_HEIGHT = 660;
// 歌词层默认鼠标穿透，只有光标进入顶部/底部控制带或左右边缘时才接管鼠标。
const LYRICS_EDGE_ZONE = 34;
const LYRICS_SIDE_ZONE = 8;
const LYRICS_REVEAL_MS = 3000;
// 歌词层排版版本：升级后重排一次尺寸与字号，避免旧配置继续裁字。
const LYRICS_LAYOUT_REV = 2;
const LYRICS_DEFAULT_WIDTH = 640;
const LYRICS_DEFAULT_HEIGHT = 340;
const LYRICS_DEFAULT_FONT = 24;

/* 只允许加载本应用自己的页面：渲染层的 file:// 地址必须落在 src/renderer 下。
 * Windows 的盘符大小写不固定（pathToFileURL 给小写、Chromium 可能给大写），比较时统一转小写。
 * 所有导航入口（主窗、悬浮窗、权限请求、IPC）都复用这一份判断。 */
const RENDERER_DIR = path.join(__dirname, 'src', 'renderer');
const APP_URL_PREFIX = pathToFileURL(`${RENDERER_DIR}${path.sep}`).href.toLowerCase();

function isAppUrl(url) {
  return typeof url === 'string' && url.toLowerCase().startsWith(APP_URL_PREFIX);
}

function windowRoleOf(contents) {
  if (win && !win.isDestroyed() && contents === win.webContents) return 'main';
  if (mini && !mini.isDestroyed() && contents === mini.webContents) return 'floating';
  return '';
}

function isMainSender(event) {
  return Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents);
}

function isFloatingSender(event) {
  return Boolean(mini && !mini.isDestroyed() && event && event.sender === mini.webContents);
}

/* 导航与弹窗统一收紧：不允许跳到应用外，不允许 window.open / target=_blank。 */
function hardenWebContents(contents) {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const blockForeign = (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      console.warn('[nav] 拦截外部跳转：', String(url).slice(0, 200));
    }
  };
  contents.on('will-navigate', blockForeign);
  contents.on('will-redirect', blockForeign);
  contents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isAppUrl(url)) {
      // 不在事件回调里同步 stop，避免打断当前帧的导航状态机。
      setImmediate(() => {
        if (!contents.isDestroyed()) contents.stop();
      });
      console.warn('[nav] 停止外部导航：', String(url).slice(0, 200));
    }
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
}

function visibleBounds(bounds) {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    return bounds.x + bounds.width > area.x
      && bounds.x < area.x + area.width
      && bounds.y + bounds.height > area.y
      && bounds.y < area.y + area.height;
  });
}

/* 选择与窗口重叠面积最大的屏幕；全部移出时回到主屏。 */
function displayForBounds(bounds) {
  let best = null;
  let bestArea = 0;
  for (const display of screen.getAllDisplays()) {
    const area = display.workArea;
    const width = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
    const height = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
    if (width > 0 && height > 0 && width * height > bestArea) {
      best = display;
      bestArea = width * height;
    }
  }
  return best || screen.getPrimaryDisplay();
}

/* 多显示器拔插或分辨率变化后，把窗口夹回最近的可用屏幕。 */
function clampToScreen(bounds) {
  const area = displayForBounds(bounds).workArea;
  const width = Math.min(Math.max(1, bounds.width), area.width);
  const height = Math.min(Math.max(1, bounds.height), area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

function keepWindowsOnScreen() {
  for (const target of [win, mini]) {
    if (!target || target.isDestroyed()) continue;
    const bounds = target.getBounds();
    const next = clampToScreen(bounds);
    if (next.x !== bounds.x || next.y !== bounds.y
      || next.width !== bounds.width || next.height !== bounds.height) {
      target.setBounds(next);
    }
  }
}

function placeWindow(target) {
  const area = screen.getPrimaryDisplay().workArea;
  const [width, height] = target.getSize();
  const x = area.x + Math.max(0, Math.round((area.width - width) / 2));
  const y = area.y + Math.max(0, Math.round((area.height - height) / 2));
  target.setPosition(x, y);
}

/* 记住窗口位置与大小；坐标落在屏幕外（拔掉副屏）时回退到默认位置。 */
function restoreBounds() {
  const saved = (config.load().window || {});
  const width = Math.max(400, Number(saved.width) || 460);
  const height = Math.max(480, Number(saved.height) || 660);
  /* 注意不能写 Number(saved.x)：配置里 null 会被转成 0，窗口就固定落在左上角。 */
  const x = saved.x;
  const y = saved.y;
  const hasPos = typeof x === 'number' && typeof y === 'number'
    && Number.isFinite(x) && Number.isFinite(y);
  const area = screen.getPrimaryDisplay().workArea;
  const visible = hasPos
    && x + width > area.x && x < area.x + area.width
    && y + height > area.y && y < area.y + area.height;
  return { width, height, x: visible ? x : null, y: visible ? y : null };
}

function saveBounds() {
  if (!win || win.isDestroyed() || onboardingOpen) return;
  const bounds = win.getBounds();
  try {
    config.save({ window: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } });
  } catch (err) {
    // 写配置失败不影响退出
  }
}

/* 旧默认 Ctrl+Alt+W 在部分机器上被其他软件占用，升级到可用默认值。 */
function migrateHotkeys() {
  const hotkeys = (config.load().hotkeys) || {};
  if (hotkeys.mini !== 'Control+Alt+W') return;
  config.save({ hotkeys: { ...hotkeys, mini: 'Control+Alt+O' } });
}

function floatingSpec(mode) {
  return mode === 'lyrics'
    ? {
      key: 'lyrics',
      width: LYRICS_DEFAULT_WIDTH,
      height: LYRICS_DEFAULT_HEIGHT,
      minWidth: LYRICS_MIN_WIDTH,
      minHeight: LYRICS_MIN_HEIGHT,
    }
    : { key: 'mini', width: 360, height: 430, minWidth: MINI_MIN_WIDTH, minHeight: MINI_MIN_HEIGHT };
}

/* 旧版歌词层尺寸偏小，升级后按新版排版重置一次尺寸与字号，位置保留。 */
function migrateLyricsLayout() {
  const saved = ((config.load().window || {}).lyrics) || {};
  if (saved.rev === LYRICS_LAYOUT_REV) return;
  config.save({
    window: {
      lyrics: {
        x: typeof saved.x === 'number' ? saved.x : null,
        y: typeof saved.y === 'number' ? saved.y : null,
        width: LYRICS_DEFAULT_WIDTH,
        height: LYRICS_DEFAULT_HEIGHT,
        fontSize: LYRICS_DEFAULT_FONT,
        locked: Boolean(saved.locked),
        rev: LYRICS_LAYOUT_REV,
      },
    },
  });
}

function restoreFloatingBounds(mode) {
  const spec = floatingSpec(mode);
  const saved = ((config.load().window || {})[spec.key]) || {};
  const width = Math.max(spec.minWidth, Number(saved.width) || spec.width);
  const height = Math.max(spec.minHeight, Number(saved.height) || spec.height);
  const x = typeof saved.x === 'number' ? saved.x : NaN;
  const y = typeof saved.y === 'number' ? saved.y : NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const bounds = { x, y, width, height };
  return visibleBounds(bounds) ? clampToScreen(bounds) : null;
}

function saveFloatingBounds() {
  if (!mini || mini.isDestroyed()) return;
  const bounds = mini.getBounds();
  const spec = floatingSpec(miniMode);
  const current = ((config.load().window || {})[spec.key]) || {};
  const payload = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
  if (miniMode === 'lyrics') {
    payload.fontSize = Number(current.fontSize) || LYRICS_DEFAULT_FONT;
    payload.locked = Boolean(current.locked);
    payload.rev = LYRICS_LAYOUT_REV;
  }
  try {
    config.save({ window: { [spec.key]: payload } });
  } catch (err) {
    // 写配置失败不影响悬浮窗
  }
}

function placeFloating(target, mode) {
  const area = win && !win.isDestroyed()
    ? displayForBounds(win.getBounds()).workArea
    : screen.getPrimaryDisplay().workArea;
  const [width, height] = target.getSize();
  if (mode === 'lyrics') {
    target.setPosition(
      area.x + Math.round((area.width - width) / 2),
      area.y + area.height - height - 64,
    );
  } else {
    target.setPosition(area.x + area.width - width - 24, area.y + area.height - height - 24);
  }
}

function applyUiToWindows(settings) {
  for (const target of [win, mini]) {
    if (!target || target.isDestroyed()) continue;
    target.setContentProtection(Boolean(settings.ui.content_protection));
    target.setOpacity(Number(settings.ui.opacity) || 1);
  }
}

function lyricsWindow() {
  return mini && !mini.isDestroyed() && miniMode === 'lyrics' ? mini : null;
}

/* 把「光标是否在歌词层内 / 是否落在可操作带」告诉渲染层，控制按钮据此显隐。 */
function publishLyricsHover() {
  const target = lyricsWindow();
  if (!target || target.webContents.isDestroyed()) return;
  const reveal = Date.now() < lyricsRevealUntil;
  const key = `${lyricsInside ? 1 : 0}${lyricsHot ? 1 : 0}${reveal ? 1 : 0}`;
  if (key === lyricsHoverKey) return;
  lyricsHoverKey = key;
  target.webContents.send('overlay:hover', {
    inside: lyricsInside,
    hot: lyricsHot,
    reveal,
  });
}

/* 主进程轮询光标位置：窗口本体始终穿透，只有控制带接管鼠标，避免挡住会议软件。 */
function tickLyricsHover() {
  const target = lyricsWindow();
  if (!target || !target.isVisible()) return;
  const bounds = target.getBounds();
  const point = screen.getCursorScreenPoint();
  const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
    && point.y >= bounds.y && point.y < bounds.y + bounds.height;
  const hot = inside && (
    point.y < bounds.y + LYRICS_EDGE_ZONE
    || point.y >= bounds.y + bounds.height - LYRICS_EDGE_ZONE
    || point.x < bounds.x + LYRICS_SIDE_ZONE
    || point.x >= bounds.x + bounds.width - LYRICS_SIDE_ZONE
  );
  lyricsInside = inside;
  lyricsHot = hot;
  // 拖动、调宽、题目列表打开时也要临时接管鼠标，否则拖到一半会恢复穿透。
  const interactive = hot || lyricsPopover || lyricsGrab;
  if (interactive !== lyricsInteractive) {
    lyricsInteractive = interactive;
    target.setIgnoreMouseEvents(!interactive, { forward: true });
    target.setFocusable(interactive);
    target.setSkipTaskbar(true);
  }
  publishLyricsHover();
}

function startLyricsHover() {
  stopLyricsHover();
  const target = lyricsWindow();
  if (!target) return;
  lyricsPopover = false;
  lyricsGrab = false;
  target.setIgnoreMouseEvents(true, { forward: true });
  target.setFocusable(false);
  target.setSkipTaskbar(true);
  lyricsHoverTimer = setInterval(tickLyricsHover, 90);
}

function stopLyricsHover() {
  clearInterval(lyricsHoverTimer);
  lyricsHoverTimer = null;
  lyricsRevealUntil = 0;
  lyricsInside = false;
  lyricsHot = false;
  lyricsInteractive = false;
  lyricsPopover = false;
  lyricsGrab = false;
  lyricsHoverKey = '';
}

/* 拖动/缩放/题目列表打开时接管鼠标：暂停轮询，期间不再切换穿透与可聚焦状态，
 * 否则 90ms 一次的判定会在拖拽途中把窗口改回穿透，导致 pointer capture 丢失。 */
function beginLyricsGrab() {
  const target = lyricsWindow();
  if (!target || target.isDestroyed()) return;
  clearInterval(lyricsHoverTimer);
  lyricsHoverTimer = null;
  lyricsGrab = true;
  lyricsInside = true;
  lyricsHot = true;
  if (!lyricsInteractive) {
    lyricsInteractive = true;
    target.setIgnoreMouseEvents(false);
    target.setFocusable(true);
  }
  target.setSkipTaskbar(true);
  publishLyricsHover();
}

/* 结束交互：先按当前光标立即重算一次，再恢复轮询，避免出现 90ms 的穿透空档。 */
function endLyricsGrab() {
  if (!lyricsGrab) return;
  lyricsGrab = false;
  const target = lyricsWindow();
  if (!target || target.isDestroyed()) return;
  lyricsHoverKey = '';
  tickLyricsHover();
  if (!lyricsHoverTimer) lyricsHoverTimer = setInterval(tickLyricsHover, 90);
}

/* 快捷键唤出控制：只让控制带短暂显示，窗口依旧不整块拦截鼠标。 */
function revealLyricsControls(ms = LYRICS_REVEAL_MS) {
  if (!lyricsWindow()) return;
  lyricsRevealUntil = Date.now() + ms;
  tickLyricsHover();
  publishLyricsHover();
}

function createFloatingWindow(settings, mode) {
  const spec = floatingSpec(mode);
  const saved = restoreFloatingBounds(mode);
  const lyrics = mode === 'lyrics';
  const lyricsPrefs = (settings.window && settings.window.lyrics) || {};
  miniMode = mode;
  stopLyricsHover();
  lastMiniState = null;

  const created = new BrowserWindow({
    width: saved ? saved.width : spec.width,
    height: saved ? saved.height : spec.height,
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: spec.minWidth,
    minHeight: spec.minHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: !lyrics || !lyricsPrefs.locked,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    focusable: !lyrics,
    title: '应声面试',
    ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
      additionalArguments: ['--ic-window-role=floating'],
    },
  });
  mini = created;
  hardenWebContents(created.webContents);

  created.setAlwaysOnTop(true, 'screen-saver');
  created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  created.setContentProtection(Boolean(settings.ui.content_protection));
  created.setOpacity(Number(settings.ui.opacity) || 1);
  if (lyrics) created.setIgnoreMouseEvents(true, { forward: true });
  if (!saved) placeFloating(created, mode);
  created.loadFile(path.join(__dirname, 'src', 'renderer', lyrics ? 'lyrics.html' : 'mini.html'));

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveFloatingBounds, 600);
  };
  created.on('moved', rememberBounds);
  created.on('resized', rememberBounds);
  if (lyrics) {
    created.on('show', () => startLyricsHover());
    created.on('hide', () => stopLyricsHover());
    // 手动缩放不许低于安全尺寸：再小就会裁掉正文，只剩上下控制带。
    created.on('will-resize', (event, next) => {
      if (next.width < spec.minWidth || next.height < spec.minHeight) event.preventDefault();
    });
    created.on('resized', () => {
      const current = created.getBounds();
      if (current.width < spec.minWidth || current.height < spec.minHeight) {
        created.setBounds({
          ...current,
          width: Math.max(spec.minWidth, current.width),
          height: Math.max(spec.minHeight, current.height),
        });
      }
    });
  }
  // 窗口被拖动或激活时，系统可能重新把它加回任务栏；这里随时再压回去。
  created.on('focus', () => created.setSkipTaskbar(true));
  created.on('restore', () => created.setSkipTaskbar(true));
  created.on('close', (event) => {
    if (quitting) {
      saveFloatingBounds();
      return;
    }
    event.preventDefault();
    showMainFromMini();
  });
  created.on('closed', () => {
    if (mini !== created) return;
    stopLyricsHover();
    mini = null;
    lastMiniState = null;
    if (win && !win.isDestroyed()) win.webContents.send('mini:closed');
  });
  created.webContents.on('render-process-gone', (event, details) => {
    console.error('[mini gone]', details.reason, details.exitCode);
    if (!quitting) showMainFromMini();
  });
  created.webContents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    if (isMainFrame && !quitting) showMainFromMini();
  });
  return created;
}

function openMiniWindow(mode = 'lyrics') {
  if (!win || win.isDestroyed()) return false;
  const nextMode = mode === 'panel' ? 'panel' : 'lyrics';
  const settings = config.load();

  if (mini && !mini.isDestroyed() && miniMode !== nextMode) {
    const old = mini;
    saveFloatingBounds();
    stopLyricsHover();
    mini = null;
    old.destroy();
  }

  if (!mini || mini.isDestroyed()) createFloatingWindow(settings, nextMode);

  const target = mini;
  const show = () => {
    if (!target || target.isDestroyed() || mini !== target) return;
    const bounds = target.getBounds();
    const next = clampToScreen(bounds);
    if (next.x !== bounds.x || next.y !== bounds.y
      || next.width !== bounds.width || next.height !== bounds.height) {
      target.setBounds(next);
    }
    target.setContentProtection(Boolean(settings.ui.content_protection));
    target.setOpacity(Number(settings.ui.opacity) || 1);
    if (nextMode === 'lyrics') {
      target.setIgnoreMouseEvents(true, { forward: true });
      target.setFocusable(false);
      target.showInactive();
      target.setSkipTaskbar(true);
      startLyricsHover();
    } else {
      target.show();
      target.focus();
    }
    if (win && !win.isDestroyed()) {
      win.hide();
      win.webContents.send('mini:opened');
    }
  };
  if (target.webContents.isLoading()) target.webContents.once('did-finish-load', show);
  else show();
  return true;
}

/* 回主窗：先关小窗，再恢复主窗；随时只保留一个可见窗口。 */
function showMainFromMini() {
  stopLyricsHover();
  const target = mini;
  if (target && !target.isDestroyed()) {
    saveFloatingBounds();
    target.destroy();
  }
  if (win && !win.isDestroyed()) {
    if (clickThrough) {
      clickThrough = false;
      win.setIgnoreMouseEvents(false);
      win.webContents.send('state:clickThrough', false);
    }
    win.show();
    win.focus();
  }
}

function wireScreenBounds() {
  const keepOnScreen = () => keepWindowsOnScreen();
  screen.on('display-added', keepOnScreen);
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
}

/* 首次引导内容较多，临时放大窗口；关闭引导后恢复用户原来的尺寸与位置。
 * 宽度/高度只取内容需要的最小值，超出部分由 .sheet-body 自己滚动，避免大片空白。 */
function setOnboardingSize(active) {
  if (!win || win.isDestroyed()) return false;
  if (active) {
    if (!onboardingOpen) {
      onboardingPrevBounds = win.getBounds();
      onboardingOpen = true;
    }
    const area = screen.getDisplayMatching(win.getBounds()).workArea;
    const base = onboardingPrevBounds || win.getBounds();
    const width = Math.min(Math.max(ONBOARDING_WIDTH, base.width), area.width - 24);
    const height = Math.min(Math.max(ONBOARDING_HEIGHT, base.height), area.height - 24);
    const x = Math.min(Math.max(base.x, area.x), Math.max(area.x, area.x + area.width - width));
    const y = Math.min(Math.max(base.y, area.y), Math.max(area.y, area.y + area.height - height));
    win.setBounds({ x, y, width, height });
    return true;
  }
  if (onboardingOpen) {
    onboardingOpen = false;
    const prev = onboardingPrevBounds;
    onboardingPrevBounds = null;
    if (prev) win.setBounds(prev);
  }
  return false;
}

function createWindow() {
  bootMark('window-create');
  const settings = config.load();
  const saved = restoreBounds();
  win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== null ? { x: saved.x, y: saved.y } : {}),
    minWidth: 400,
    minHeight: 480,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    ...(fs.existsSync(APP_ICON) ? { icon: APP_ICON } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      devTools: !app.isPackaged,
      additionalArguments: ['--ic-window-role=main'],
    },
  });
  hardenWebContents(win.webContents);

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(Boolean(settings.ui.content_protection));
  win.setOpacity(Number(settings.ui.opacity) || 1);

  win.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));

  win.webContents.on('console-message', (...args) => {
    const details = args[1];
    if (details && typeof details === 'object') {
      console.log('[renderer]', details.level, details.message);
    } else {
      console.log('[renderer]', args[2] ?? args[1]);
    }
  });
  win.webContents.on('render-process-gone', (event, details) => {
    console.error('[renderer gone]', details.reason, details.exitCode);
    if (quitting || details.reason === 'clean-exit') return;
    /* 界面进程没了，收音随进程结束，但计费在主线还在跑，先结算掉。 */
    if (activeUsage) {
      const sessionId = activeUsage.sessionId;
      activeUsage = null;
      usageClientId = '';
      console.warn('[usage] renderer gone, stop', sessionId);
      Promise.resolve()
        .then(() => auth.stopUsage(sessionId))
        .catch((err) => console.warn('[usage] crash stop error', err && err.message));
    }
    const now = Date.now();
    rendererCrashTimes.push(now);
    while (rendererCrashTimes.length && now - rendererCrashTimes[0] > 60000) rendererCrashTimes.shift();
    if (rendererCrashTimes.length >= 3) {
      console.error('[renderer] 一分钟内连续崩溃，停止自动重载');
      dialog.showErrorBox('界面连续崩溃', '界面进程在一分钟内连续崩溃三次。请重启应用；如果反复出现，请把日志目录里的 app 日志发给我们。');
      return;
    }
    /* 延迟一点再 reload，给计费结算和崩溃日志留出时间；渲染层会从 sessionStorage 恢复题目/答案快照。 */
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        console.warn('[renderer] 自动重载');
        win.reload();
      }
    }, 500);
  });

  win.once('ready-to-show', () => {
    if (saved.x === null) placeWindow(win);
    win.show();
    bootMark('window-shown');
    console.log('[win] shown');
  });
  win.webContents.once('did-finish-load', () => bootMark('page-loaded'));

  let boundsTimer = null;
  const rememberBounds = () => {
    clearTimeout(boundsTimer);
    boundsTimer = setTimeout(saveBounds, 600);
  };
  win.on('moved', rememberBounds);
  win.on('resized', rememberBounds);
  win.on('close', saveBounds);
  win.on('hide', () => console.log('[win] hide'));
  win.on('minimize', () => console.log('[win] minimize'));
  win.on('restore', () => console.log('[win] restore'));
  win.on('closed', () => {
    console.log('[win] closed');
    win = null;
  });
}

// 系统声音回环：面试官的声音从扬声器/耳机输出，用 loopback 抓回来最稳
function wireDisplayMedia() {
  const allowed = new Set(['media', 'audioCapture']);
  /* 权限请求必须来自本应用页面；其它 webContents / 外部 URL 一律拒绝。 */
  const trusted = (contents, details) => {
    if (!windowRoleOf(contents)) return false;
    const requested = details && details.requestingUrl;
    const url = requested || (contents.getURL ? contents.getURL() : '');
    return isAppUrl(url);
  };

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowed.has(permission) && trusted(contents, details));
  });
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => {
    return allowed.has(permission) && trusted(contents, details);
  });

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // 屏幕/系统声音采集只开放给主窗，悬浮窗和被注入的页面拿不到。
    const deny = () => {
      try { callback({}); } catch (err) { /* 拒绝时 Electron 可能抛错，忽略即可 */ }
    };
    const frame = request && request.frame;
    const contents = frame && webContents.fromFrame ? webContents.fromFrame(frame) : null;
    if (!contents || !win || win.isDestroyed() || contents !== win.webContents || !isAppUrl(contents.getURL())) {
      console.warn('[media] 拒绝非主窗的屏幕采集请求');
      deny();
      return;
    }
    const primary = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    const source = sources.find((item) => item.display_id === String(primary.id)) || sources[0];
    if (!source) {
      deny();
      return;
    }
    callback({ video: source, audio: 'loopback' });
  }, { useSystemPicker: false });
}

function toggleClickThrough() {
  // 歌词层本身就是穿透的，快捷键改为短暂唤出控制带，不改变穿透状态。
  if (lyricsWindow()) {
    revealLyricsControls();
    return false;
  }
  clickThrough = !clickThrough;
  const target = mini && !mini.isDestroyed() ? mini : win;
  if (target && !target.isDestroyed()) {
    target.setIgnoreMouseEvents(clickThrough, { forward: true });
    target.webContents.send('state:clickThrough', clickThrough);
  }
  return clickThrough;
}

function runHotkey(action) {
  switch (action) {
    case 'hide': {
      const target = mini && !mini.isDestroyed() ? mini : win;
      if (!target || target.isDestroyed()) return;
      if (target.isVisible()) {
        target.hide();
        return;
      }
      if (lyricsWindow()) {
        target.showInactive();
        revealLyricsControls();
      } else {
        target.show();
        target.focus();
      }
      return;
    }
    case 'mini': {
      if (mini && !mini.isDestroyed()) {
        showMainFromMini();
        return;
      }
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) win.show();
      win.webContents.send('hotkey:mini');
      return;
    }
    case 'ask':
      if (win && !win.isDestroyed()) win.webContents.send('hotkey:ask');
      return;
    case 'reveal':
      toggleClickThrough();
      return;
    case 'clear':
      if (win && !win.isDestroyed()) win.webContents.send('hotkey:clear');
      return;
    case 'prev':
      if (win && !win.isDestroyed()) win.webContents.send('hotkey:question', -1);
      return;
    case 'next':
      if (win && !win.isDestroyed()) win.webContents.send('hotkey:question', 1);
      return;
    case 'capture':
      if (win && !win.isDestroyed()) win.webContents.send('written:capture-request');
      return;
    case 'answer':
      written.toggleAnswer();
      return;
    default:
  }
}

/* 快捷键全部来自配置，保存后立即重新注册，不再写死在代码里。 */
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hotkeys = config.load().hotkeys || {};
  const failed = [];
  for (const action of Object.keys(hotkeys)) {
    const accel = String(hotkeys[action] || '').trim();
    if (!accel) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => runHotkey(action));
    } catch (err) {
      ok = false;
    }
    if (!ok) failed.push(accel);
  }
  console.log('[hotkeys]', { total: Object.keys(hotkeys).length, failed });
  if (failed.length && win && !win.isDestroyed() && !win.webContents.isLoading()) {
    win.webContents.send('hotkey:error', failed);
  }
  return failed;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mini && !mini.isDestroyed()) {
      showMainFromMini();
      return;
    }
    if (win) {
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    bootMark('app-ready');
    // 打包版不保留应用菜单（无边框窗口本来也看不到，但快捷键/调试入口要一并封掉）。
    if (app.isPackaged) Menu.setApplicationMenu(null);
    // 引擎来源写进日志：内置引擎存在时必须走内置，不允许默默联网下载。
    const assetState = assets.status();
    console.log(`[engine] source=${assetState.engine} ready=${assetState.items[0].ready} dir=${paths.bundledPaths().dir}`);
    // 先起本地 ASR，再开界面：模型加载和窗口/页面加载并行，点「开始」时少等一截。
    // prewarm 不阻塞，窗口该什么时候出现还是什么时候出现。
    if (config.load().asr.provider === 'llama' && asr.available()) {
      bootMark('asr-prewarm');
      asr.prewarm().then(() => bootMark('asr-ready'));
    }
    wireDisplayMedia();
    wireScreenBounds();
    migrateLyricsLayout();
    migrateHotkeys();
    createWindow();
    written.init(() => win);
    written.syncMode(config.load().ui.mode);
    createTray();
    registerHotkeys();
    // 上次退出时没吊销成功的 token，联网启动后优先补发。
    auth.flushRevocations().catch((err) => console.warn('[auth] 补发吊销失败：', err.message));

    app.on('activate', () => {
      if (mini && !mini.isDestroyed()) {
        if (!mini.isVisible()) mini.show();
        return;
      }
      if (!win) createWindow();
      else { win.show(); win.focus(); }
    });
  });
}

/* 隐藏窗口后还能从托盘找回，避免只能靠快捷键。 */
function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  if (!fs.existsSync(iconPath)) return;
  try {
    const image = nativeImage.createFromPath(iconPath);
    tray = new Tray(image.resize({ width: 16, height: 16 }));
    tray.setToolTip('应声面试');
    const showWindow = () => {
      const target = mini && !mini.isDestroyed() ? mini : win;
      if (!target || target.isDestroyed()) return;
      if (target.isVisible()) target.hide();
      else { target.show(); target.focus(); }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 / 隐藏', click: showWindow },
      {
        label: '打开设置',
        click: () => {
          if (!win) return;
          if (mini && !mini.isDestroyed()) showMainFromMini();
          win.show();
          win.focus();
          win.webContents.send('ui:open-settings');
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]));
    tray.on('click', showWindow);
  } catch (err) {
    console.error('[tray] 创建托盘失败：', err.message);
  }
}

app.on('window-all-closed', () => {
  console.log('[app] window-all-closed -> quit');
  app.quit();
});

app.on('before-quit', (event) => {
  quitting = true;
  if (usageQuitSettled) {
    /* 结算进行中又被点了退出：继续等这次结算，避免第二次退出绕过它。 */
    if (activeUsage) event.preventDefault();
    return;
  }
  if (!activeUsage) {
    console.log('[app] before-quit');
    return;
  }
  /* 退出路径补结算：最多等 1.2 秒，超时或网络失败照常退出，不能卡住关窗。 */
  usageQuitSettled = true;
  event.preventDefault();
  const sessionId = activeUsage.sessionId;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    activeUsage = null;
    usageClientId = '';
    console.log('[usage] quit settle done');
    app.quit();
  };
  const timer = setTimeout(() => {
    console.warn('[usage] quit settle timeout, continue quit');
    finish();
  }, 1200);
  console.log('[usage] before-quit stop', sessionId);
  Promise.resolve()
    .then(() => auth.stopUsage(sessionId))
    .then((result) => console.log('[usage] quit stop', result && result.ok ? 'ok' : 'failed'))
    .catch((err) => console.warn('[usage] quit stop error', err && err.message))
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
});

app.on('will-quit', () => {
  console.log('[app] will-quit');
  globalShortcut.unregisterAll();
  written.shutdown();
  asr.shutdown();
});

/* 主进程被强杀或崩溃时 will-quit 不一定执行，这里同步兜底，避免留下常驻的 llama-server。 */
process.on('exit', () => {
  try {
    asr.killSync();
  } catch (err) {
    // 退出阶段不能抛错
  }
});

app.on('child-process-gone', (event, details) => {
  console.error('[child-process-gone]', details.type, details.reason, details.exitCode);
});

/* 统一 IPC 来源校验：主窗可用全部通道；悬浮窗只允许读配置、回主窗、切换形态、
 * 调整歌词层。其它通道一律拒绝，避免小窗被注入后调用账号/配置写入等能力。 */
const FLOATING_INVOKE = new Set(['config:get', 'mini:return', 'mini:mode', 'overlay:config']);
const registerIpc = ipcMain.handle.bind(ipcMain);
function handleIpc(channel, listener) {
  registerIpc(channel, (event, ...args) => {
    if (!isMainSender(event) && !(isFloatingSender(event) && FLOATING_INVOKE.has(channel))) {
      console.warn('[ipc] 拒绝来源不明的调用：', channel);
      return { ok: false, error: '无权限' };
    }
    return listener(event, ...args);
  });
}

handleIpc('config:get', (event) => {
  const data = config.load();
  // 悬浮窗只拿界面所需的只读配置，账号、Key、路径一律不下发。
  if (isFloatingSender(event)) return { ui: data.ui, window: data.window };
  return data;
});

handleIpc('auth:status', () => auth.status());
handleIpc('auth:register', (event, payload) => {
  cloud.invalidate();
  return auth.register(payload);
});
handleIpc('auth:login', (event, payload) => {
  cloud.invalidate();
  return auth.login(payload);
});
handleIpc('auth:redeem', (event, code) => {
  cloud.invalidate();
  return auth.redeem(code);
});
handleIpc('auth:logout', () => {
  cloud.invalidate();
  return auth.logout();
});

/* 账号能力：短信登录、改密、找回、邀请、优惠码、导出与注销（后端 1.3.0）。 */
handleIpc('auth:smsSend', (event, phone) => auth.sendSms(phone));
handleIpc('auth:smsLogin', (event, payload) => {
  cloud.invalidate();
  return auth.smsLogin(payload);
});
handleIpc('auth:changePassword', (event, payload) => auth.changePassword(payload));
handleIpc('auth:resetPassword', (event, payload) => auth.resetPassword(payload));
handleIpc('auth:invite', () => auth.inviteInfo());
handleIpc('auth:promo', (event, code, planId) => auth.validatePromo(code, planId));
handleIpc('auth:delete', (event, payload) => {
  cloud.invalidate();
  return auth.deleteAccount(payload);
});

/* 导出账号数据：让用户选保存位置，写 JSON 文件。 */
handleIpc('auth:export', async () => {
  const result = await auth.exportAccount();
  if (!result.ok) return result;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出账号数据',
    defaultPath: `应声面试-账号数据-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(result.data, null, 2), 'utf-8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `写入文件失败：${err.message}` };
  }
});

/* 导出面试会话：渲染层拼好 txt，主进程只负责选路径和写文件。 */
handleIpc('session:export', async (event, text) => {
  const body = typeof text === 'string' ? text : '';
  if (!body.trim()) return { ok: false, error: '没有可导出的内容' };
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出面试会话',
    defaultPath: `应声面试-会话记录-${stamp}.txt`,
    filters: [{ name: '文本文件', extensions: ['txt'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, body, 'utf-8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `写入文件失败：${err.message}` };
  }
});

/* 配置导出 / 导入 / 恢复默认。 */
handleIpc('config:export', async () => {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出配置',
    defaultPath: '应声面试-配置.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify(config.exportable(), null, 2), 'utf-8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: `写入文件失败：${err.message}` };
  }
});

handleIpc('config:import', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '导入配置',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
  try {
    const data = JSON.parse(fs.readFileSync(filePaths[0], 'utf-8'));
    // 导入文件里的 Key 一律忽略，避免覆盖本机已保存的凭据。
    const next = config.save(config.withoutSecrets(data));
    return { ok: true, config: next };
  } catch (err) {
    return { ok: false, error: `配置文件无法读取：${err.message}` };
  }
});

handleIpc('config:reset', () => {
  try {
    const next = config.save(config.DEFAULTS);
    return { ok: true, config: next };
  } catch (err) {
    return { ok: false, error: `恢复默认失败：${err.message}` };
  }
});

/* 云端只读数据：价格、计费策略、开关、公告、官方模型。 */
handleIpc('cloud:config', (event, force) => cloud.appConfig({ force: Boolean(force) }));
handleIpc('cloud:models', (event, force) => cloud.models({ force: Boolean(force) }));
handleIpc('cloud:invalidate', () => {
  cloud.invalidate();
  return { ok: true };
});

/* 订单与支付：后端能力已就绪，界面入口由渲染层开关控制，默认不露出。 */
handleIpc('orders:plans', () => orders.plans());
handleIpc('orders:create', (event, planId, promoCode) => orders.create(planId, promoCode));
handleIpc('orders:list', () => orders.list());
handleIpc('orders:get', (event, orderNo) => orders.get(orderNo));
handleIpc('orders:pay', (event, orderNo) => orders.pay(orderNo));
handleIpc('orders:open', (event, url) => orders.openExternal(url));

handleIpc('usage:start', async () => {
  /* ASR 还没就绪时先把开始请求排队等待，而不是让用户看到「识别不可用」再手动重试。
   * 等待失败也继续计时，后续转写会给出明确错误。 */
  if (config.load().asr.provider === 'llama' && asr.available() && !asr.status().ready) {
    try {
      await asr.ensureServer();
    } catch (err) {
      console.warn('[usage] ASR 等待就绪失败，继续开始：', err.message);
    }
  }
  /* 同一次开始计时的重试（断线/响应丢失）必须复用同一个幂等键，避免新建会话顶掉旧的。 */
  if (!usageClientId) usageClientId = crypto.randomUUID();
  const result = await auth.startUsage(usageClientId);
  if (result && result.ok && result.session_id) {
    activeUsage = { sessionId: Number(result.session_id), clientId: usageClientId };
    console.log('[usage] start', activeUsage.sessionId, result.resumed ? 'resumed' : 'new');
  }
  return result;
});
handleIpc('usage:heartbeat', (event, sessionId) => auth.heartbeatUsage(sessionId));
handleIpc('usage:stop', async (event, sessionId) => {
  const result = await auth.stopUsage(sessionId);
  if (result && result.ok) {
    console.log('[usage] stop', sessionId);
    activeUsage = null;
    usageClientId = '';
  }
  return result;
});

/* 渲染层只能把引擎/模型指到应用运行目录或内置引擎目录，其它绝对路径直接丢弃。 */
const ENGINE_PATH_KEYS = ['llama_bin', 'llama_model', 'llama_mmproj'];
function sanitizeConfigPatch(patch) {
  if (!patch || typeof patch !== 'object' || !patch.asr || typeof patch.asr !== 'object') return patch;
  const asr = { ...patch.asr };
  for (const key of ENGINE_PATH_KEYS) {
    if (!(key in asr) || !asr[key]) continue;
    const value = String(asr[key]).trim();
    if (!paths.isEnginePath(value)) {
      console.warn(`[config] 拒绝白名单外的 ${key}：`, value.slice(0, 200));
      delete asr[key];
    } else {
      asr[key] = value;
    }
  }
  return { ...patch, asr };
}

handleIpc('config:save', async (event, patch) => {
  const before = config.load();
  const next = config.save(sanitizeConfigPatch(patch));
  applyUiToWindows(next);
  /* 模式切换时同步笔试的常驻桌面流（只在笔试期间采集）。 */
  if (before.ui.mode !== next.ui.mode) written.syncMode(next.ui.mode);
  const engineChanged = ['provider', 'llama_bin', 'llama_model', 'llama_mmproj', 'llama_port']
    .some((key) => before.asr[key] !== next.asr[key]);
  if (engineChanged) await asr.shutdown();
  if (JSON.stringify(before.hotkeys) !== JSON.stringify(next.hotkeys)) registerHotkeys();
  return next;
});

handleIpc('asr:status', () => asr.status());

handleIpc('hw:detect', () => hardware.detect());

handleIpc('assets:status', () => assets.status());

handleIpc('assets:download', async (event, id) => {
  // 内置引擎已就位时，引擎下载请求直接返回状态：不联网、也不打断正在跑的 ASR。
  if (id === 'llama' && fs.existsSync(paths.bundledPaths().binary)) {
    return { ok: true, status: assets.status() };
  }
  if (id === 'llama') {
    // 覆盖引擎文件前先停掉正在跑的 llama-server，否则 Windows 会锁文件
    await asr.shutdown();
  }
  const sender = event.sender;
  try {
    await assets.download(id, (progress) => {
      if (!sender.isDestroyed()) sender.send('assets:progress', progress);
    });
    // 引擎/模型就位后自动拉起本地 ASR，用户不需要再点预热
    if (config.load().asr.provider === 'llama' && asr.available()) {
      asr.ensureServer().catch((err) => console.log('[asr] 自动启动失败：', err.message));
    }
    return { ok: true, status: assets.status() };
  } catch (err) {
    return { ok: false, error: err.message, status: assets.status() };
  }
});

handleIpc('assets:cancel', () => {
  assets.cancel();
  return true;
});

/* 切换到已下载的另一档模型：先停本地 ASR，改配置后再拉起来。 */
handleIpc('assets:use', async (event, id) => {
  try {
    await asr.shutdown();
    const status = assets.use(id);
    if (config.load().asr.provider === 'llama' && asr.available()) {
      asr.ensureServer().catch((err) => console.log('[asr] 切换模型后启动失败：', err.message));
    }
    return { ok: true, status };
  } catch (err) {
    return { ok: false, error: err.message, status: assets.status() };
  }
});

handleIpc('app:info', () => ({
  version: app.getVersion(),
  platform: process.platform === 'win32' ? 'Windows' : process.platform,
  dataDir: paths.userRoot(),
  runtimeDir: paths.runtimeRoot(),
  logsDir: paths.logsDir(),
}));

/* 版本更新：检查与安装都由主进程做，渲染层只负责展示。
 * 下载进度只推给主窗，安装路径不经过渲染层参数。 */
handleIpc('update:check', () => updater.check());
handleIpc('update:download', () => updater.download((payload) => {
  if (win && !win.isDestroyed()) win.webContents.send('update:progress', payload);
}));
handleIpc('update:cancel', () => updater.cancel());
handleIpc('update:install', () => updater.install());

/* 笔试：截图、重答、答案悬浮窗、手机副屏。 */
handleIpc('written:capture', (event, source) => written.captureAndSolve(source === 'answer' || source === 'phone' ? source : 'main'));
handleIpc('written:solve', (event, text) => written.solve(text));
handleIpc('written:ocr-status', () => indra.status());
handleIpc('written:ocr-prepare', (event) => indra.prepare((progress) => {
  if (!event.sender.isDestroyed()) event.sender.send('written:ocr-progress', progress);
}));
handleIpc('written:answer-toggle', () => written.toggleAnswer());
handleIpc('written:answer-hide', () => written.hideAnswer());
handleIpc('phone:start', () => phone.start());
handleIpc('phone:stop', () => phone.stop());
handleIpc('phone:status', () => phone.status());
handleIpc('phone:push', (event, payload) => phone.push(payload));

handleIpc('app:open', (event, kind) => {
  const target = kind === 'runtime'
    ? paths.runtimeRoot()
    : (kind === 'logs' ? paths.logsDir() : paths.userRoot());
  shell.openPath(target);
  return target;
});

/* 渲染层诊断只保留结构化指标：转写原文、报错里的长文本都脱敏后再落盘。 */
function redactDiag(line) {
  const raw = String(line || '');
  const cut = raw.indexOf(' ');
  if (cut < 0) return raw.slice(0, 2000);
  const kind = raw.slice(0, cut);
  let data = null;
  try {
    data = JSON.parse(raw.slice(cut + 1));
  } catch (err) {
    const stripped = raw.slice(cut + 1)
      .replace(/"(text|transcript|content|excerpt)"\s*:\s*"(?:[^"\\]|\\.)*"/g, '"text":"[redacted]"');
    return `${kind} ${stripped}`.slice(0, 2000);
  }
  if (data && typeof data === 'object') {
    for (const key of ['text', 'transcript', 'content', 'excerpt']) delete data[key];
    if (data.error) data.error = String(data.error).replace(/\s+/g, ' ').slice(0, 160);
  }
  return `${kind} ${JSON.stringify(data)}`.slice(0, 2000);
}

/* 渲染层诊断（断句/识别）：打包后没有 DevTools，统一落到 logs/app-日期.log。 */
handleIpc('diag:log', (event, line) => {
  logger.write('diag', [redactDiag(line)]);
  return true;
});

handleIpc('resume:pick', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: '选择简历文件',
    properties: ['openFile'],
    filters: [
      { name: '简历文件', extensions: ['txt', 'md', 'docx', 'pdf'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { canceled: true };

  const file = result.filePaths[0];
  try {
    const text = await resume.parseFile(file);
    return { ok: true, name: path.basename(file), text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

handleIpc('asr:transcribe', async (event, payload) => {
  return asr.transcribe(payload);
});

handleIpc('asr:warmup', async () => {
  try {
    await asr.ensureServer();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 正在进行的回答请求：按题目 id 保存 AbortController，支持「停止生成」。 */
const answerRequests = new Map();

handleIpc('llm:answer', async (event, payload) => {
  const id = payload && payload.id;
  const sender = event.sender;
  if (answerRequests.has(id)) {
    try { answerRequests.get(id).abort(); } catch (err) { /* 旧请求已结束 */ }
  }
  const controller = new AbortController();
  answerRequests.set(id, controller);
  try {
    const text = await llm.streamAnswer(payload.question, {
      history: payload.history,
      recentQA: payload.recentQA,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!sender.isDestroyed()) sender.send('llm:delta', { id, delta });
      },
    });
    if (!sender.isDestroyed()) sender.send('llm:done', { id, text });
    return { ok: true, text };
  } catch (err) {
    if (controller.signal.aborted) {
      if (!sender.isDestroyed()) sender.send('llm:aborted', { id });
      return { ok: false, aborted: true, error: '已停止生成' };
    }
    if (!sender.isDestroyed()) sender.send('llm:error', { id, error: err.message });
    return { ok: false, error: err.message };
  } finally {
    if (answerRequests.get(id) === controller) answerRequests.delete(id);
  }
});

handleIpc('llm:cancel', (event, id) => {
  const controller = answerRequests.get(id);
  if (!controller) return { ok: false, error: '当前没有进行中的生成' };
  controller.abort();
  answerRequests.delete(id);
  return { ok: true };
});

handleIpc('llm:models', async (event, payload) => {
  try {
    return { ok: true, models: await llm.listModels(payload || {}) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 线上热词库：从账号服务拉取，失败时前端会静默回退本地词库。 */
handleIpc('hotwords:remote', () => cloud.hotwords());

/* 悬浮窗：独立小窗 + 主窗状态单向快照，小窗操作回传给主窗执行。 */
handleIpc('mini:open', () => ({ ok: openMiniWindow('lyrics') }));
handleIpc('mini:return', () => {
  showMainFromMini();
  return { ok: true };
});
/* 歌词层 / 控制面板两种形态可互相切换，默认歌词层。 */
handleIpc('mini:mode', (event, mode) => {
  if (!mini || mini.isDestroyed() || event.sender !== mini.webContents) {
    return { ok: false, mode: miniMode };
  }
  const next = mode === 'panel' ? 'panel' : 'lyrics';
  if (next === miniMode) return { ok: true, mode: next };
  return { ok: openMiniWindow(next), mode: next };
});
ipcMain.on('mini:push', (event, payload) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  lastMiniState = payload;
  if (mini && !mini.isDestroyed()) mini.webContents.send('mini:event', payload);
});
ipcMain.on('mini:ready', (event) => {
  if (!mini || mini.isDestroyed() || event.sender !== mini.webContents) return;
  if (lastMiniState) mini.webContents.send('mini:event', lastMiniState);
  if (win && !win.isDestroyed()) win.webContents.send('mini:opened');
});
ipcMain.on('mini:action', (event, action) => {
  if (!mini || mini.isDestroyed() || event.sender !== mini.webContents) return;
  if (win && !win.isDestroyed()) win.webContents.send('mini:action', action);
});
/* 歌词层字号与锁定：合并保存，必须保留当前位置和尺寸。 */
handleIpc('overlay:config', (event, patch) => {
  const target = lyricsWindow();
  if (!target || event.sender !== target.webContents) return { ok: false };
  const current = ((config.load().window || {}).lyrics) || {};
  const bounds = target.getBounds();
  const next = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    fontSize: Math.min(48, Math.max(14, Number(current.fontSize) || LYRICS_DEFAULT_FONT)),
    locked: Boolean(current.locked),
    rev: LYRICS_LAYOUT_REV,
  };
  if (patch && typeof patch === 'object') {
    const size = Number(patch.fontSize);
    if (Number.isFinite(size)) next.fontSize = Math.min(48, Math.max(14, Math.round(size)));
    if ('locked' in patch) next.locked = Boolean(patch.locked);
  }
  config.save({ window: { lyrics: next } });
  target.setResizable(!next.locked);
  return { ok: true, lyrics: next };
});
/* 歌词层右边缘拖动调宽：窗口拦不住鼠标时由主进程统一改 bounds。 */
ipcMain.on('overlay:resize', (event, width) => {
  const target = lyricsWindow();
  if (!target || event.sender !== target.webContents) return;
  // 渲染层若没赶上 grab 事件，这里兜底接管，保证整段缩放期间都不恢复穿透。
  if (!lyricsGrab) beginLyricsGrab();
  const bounds = target.getBounds();
  const area = displayForBounds(bounds).workArea;
  const next = Math.min(
    Math.max(LYRICS_MIN_WIDTH, Math.round(Number(width) || bounds.width)),
    area.width,
  );
  const x = Math.max(area.x, Math.min(bounds.x, area.x + area.width - next));
  target.setBounds({
    x,
    y: bounds.y,
    width: next,
    height: Math.max(LYRICS_MIN_HEIGHT, bounds.height),
  });
});
/* 自定义拖动：不通过系统标题栏拖拽，避免窗口被激活后重新出现在任务栏。 */
ipcMain.on('overlay:move', (event, point) => {
  const target = lyricsWindow();
  if (!target || event.sender !== target.webContents) return;
  if (!lyricsGrab) beginLyricsGrab();
  const bounds = target.getBounds();
  const area = displayForBounds(bounds).workArea;
  const x = Math.round(Number(point && point.x));
  const y = Math.round(Number(point && point.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const width = Math.max(LYRICS_MIN_WIDTH, bounds.width);
  const height = Math.max(LYRICS_MIN_HEIGHT, bounds.height);
  target.setBounds({
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width,
    height,
  });
});
ipcMain.on('overlay:grab', (event, active) => {
  const target = lyricsWindow();
  if (!target || event.sender !== target.webContents) return;
  if (active) beginLyricsGrab();
  else endLyricsGrab();
});
ipcMain.on('overlay:popover', (event, open) => {
  const target = lyricsWindow();
  if (!target || event.sender !== target.webContents) return;
  lyricsPopover = Boolean(open);
  tickLyricsHover();
});
/* 记录快捷键时先暂停全局注册，否则原组合会被全局拦截，无法录进输入框。 */
handleIpc('hotkeys:pause', (event, paused) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return { ok: false };
  if (paused) {
    globalShortcut.unregisterAll();
    return { ok: true };
  }
  registerHotkeys();
  return { ok: true };
});
/* 快捷键保存后立即重新注册，并回传被占用/无效的组合。 */
handleIpc('hotkeys:save', (event, patch) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) {
    return { ok: false, failed: [] };
  }
  const allowed = ['mini', 'reveal', 'prev', 'next', 'hide', 'ask', 'clear'];
  const current = config.load().hotkeys || {};
  const next = {};
  for (const key of allowed) {
    const value = patch && Object.prototype.hasOwnProperty.call(patch, key)
      ? String(patch[key] || '').trim().slice(0, 64)
      : String(current[key] || '');
    next[key] = value;
  }
  const saved = config.save({ hotkeys: next });
  const failed = registerHotkeys();
  return { ok: true, hotkeys: saved.hotkeys, failed };
});

handleIpc('win:set', (event, action, value) => {
  if (!win) return null;
  switch (action) {
    case 'onboarding':
      return setOnboardingSize(Boolean(value));
    case 'opacity':
      for (const target of [win, mini]) {
        if (target && !target.isDestroyed()) target.setOpacity(Number(value));
      }
      break;
    case 'protect':
      for (const target of [win, mini]) {
        if (target && !target.isDestroyed()) target.setContentProtection(Boolean(value));
      }
      break;
    case 'clickThrough':
      toggleClickThrough();
      return clickThrough;
    case 'hide':
      win.hide();
      break;
    case 'quit':
      app.quit();
      break;
    case 'minimize':
      win.minimize();
      break;
    default:
      break;
  }
  return null;
});

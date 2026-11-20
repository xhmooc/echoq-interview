const { contextBridge, ipcRenderer } = require('electron');

/* 同一个 preload 文件供主窗和悬浮窗使用，按页面/启动参数决定能拿到多少能力：
 * - main：完整能力（账号、配置写入、ASR、模型下载、窗口控制）
 * - floating：只保留推送、动作回传、自身窗口控制和只读的 ui/window 配置 */
function detectRole() {
  // 页面文件名是最可靠的判断依据；启动参数作为兜底。
  try {
    const file = String(window.location.pathname || '').split('/').pop().toLowerCase();
    if (file === 'mini.html' || file === 'lyrics.html') return 'floating';
    if (file === 'index.html') return 'main';
  } catch (err) {
    // location 不可用时看参数
  }
  const roleArg = process.argv.find((arg) => arg.startsWith('--ic-window-role='));
  return roleArg && roleArg.split('=')[1] === 'main' ? 'main' : 'floating';
}

const ROLE = detectRole();

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel, cb) => ipcRenderer.on(channel, (_event, ...args) => cb(...args));

const floatingApi = {
  // 只读配置：主进程只返回 ui / window，不包含任何 Key 或账号信息。
  getConfig: () => call('config:get'),

  // 自身窗口控制
  returnToMain: () => call('mini:return'),
  miniMode: (mode) => call('mini:mode', mode),
  overlayConfig: (patch) => call('overlay:config', patch),
  overlayResize: (width) => ipcRenderer.send('overlay:resize', width),
  overlayMove: (point) => ipcRenderer.send('overlay:move', point),
  overlayGrab: (active) => ipcRenderer.send('overlay:grab', active),
  overlayPopover: (open) => ipcRenderer.send('overlay:popover', open),

  // 主窗推送 + 动作回传
  onMiniEvent: (cb) => listen('mini:event', cb),
  miniReady: () => ipcRenderer.send('mini:ready'),
  miniAction: (action) => ipcRenderer.send('mini:action', action),
  onOverlayHover: (cb) => listen('overlay:hover', cb),
};

const mainApi = {
  getConfig: () => call('config:get'),
  saveConfig: (patch) => call('config:save', patch),

  authStatus: () => call('auth:status'),
  authRegister: (payload) => call('auth:register', payload),
  authLogin: (payload) => call('auth:login', payload),
  authRedeem: (code) => call('auth:redeem', code),
  authLogout: () => call('auth:logout'),
  smsSend: (phone) => call('auth:smsSend', phone),
  smsLogin: (payload) => call('auth:smsLogin', payload),
  changePassword: (payload) => call('auth:changePassword', payload),
  resetPassword: (payload) => call('auth:resetPassword', payload),
  inviteInfo: () => call('auth:invite'),
  validatePromo: (code, planId) => call('auth:promo', code, planId),
  deleteAccount: (payload) => call('auth:delete', payload),
  exportAccount: () => call('auth:export'),
  exportSession: (text) => call('session:export', text),
  exportConfig: () => call('config:export'),
  importConfig: () => call('config:import'),
  resetConfig: () => call('config:reset'),

  cloudConfig: (force) => call('cloud:config', force),
  cloudModels: (force) => call('cloud:models', force),
  cloudInvalidate: () => call('cloud:invalidate'),

  usageStart: () => call('usage:start'),
  usageHeartbeat: (sessionId) => call('usage:heartbeat', sessionId),
  usageStop: (sessionId) => call('usage:stop', sessionId),

  orderPlans: () => call('orders:plans'),
  orderCreate: (planId) => call('orders:create', planId),
  orderList: () => call('orders:list'),
  orderGet: (orderNo) => call('orders:get', orderNo),
  orderPay: (orderNo) => call('orders:pay', orderNo),
  openExternal: (url) => call('orders:open', url),

  asrStatus: () => call('asr:status'),
  detectHardware: () => call('hw:detect'),
  transcribe: (payload) => call('asr:transcribe', payload),
  warmupAsr: () => call('asr:warmup'),

  assetsStatus: () => call('assets:status'),
  downloadAsset: (id) => call('assets:download', id),
  cancelAsset: () => call('assets:cancel'),
  useAsset: (id) => call('assets:use', id),
  onAssetProgress: (cb) => listen('assets:progress', cb),

  appInfo: () => call('app:info'),
  updateCheck: () => call('update:check'),
  updateDownload: () => call('update:download'),
  updateCancel: () => call('update:cancel'),
  updateInstall: () => call('update:install'),
  onUpdateProgress: (cb) => listen('update:progress', cb),
  writtenCapture: (source) => call('written:capture', source),
  writtenSolve: (text) => call('written:solve', text),
  writtenOcrStatus: () => call('written:ocr-status'),
  writtenOcrPrepare: () => call('written:ocr-prepare'),
  writtenToggleAnswer: () => call('written:answer-toggle'),
  writtenHideAnswer: () => call('written:answer-hide'),
  writtenExternalResult: (id, result) => call('written:external-result', { id, result }),
  phoneStart: () => call('phone:start'),
  phoneStop: () => call('phone:stop'),
  phoneStatus: () => call('phone:status'),
  phonePush: (payload) => call('phone:push', payload),
  onWrittenStatus: (cb) => listen('written:status', cb),
  onWrittenOcrProgress: (cb) => listen('written:ocr-progress', cb),
  onWrittenCaptureRequest: (cb) => listen('written:capture-request', cb),
  openFolder: (kind) => call('app:open', kind),
  pickResume: () => call('resume:pick'),
  diag: (line) => call('diag:log', line),

  ask: (payload) => call('llm:answer', payload),
  cancelAsk: (id) => call('llm:cancel', id),
  listModels: (payload) => call('llm:models', payload),
  remoteHotwords: () => call('hotwords:remote'),
  onDelta: (cb) => listen('llm:delta', cb),
  onDone: (cb) => listen('llm:done', cb),
  onError: (cb) => listen('llm:error', cb),
  onAborted: (cb) => listen('llm:aborted', cb),

  winSet: (action, value) => call('win:set', action, value),
  openMini: () => call('mini:open'),
  returnToMain: () => call('mini:return'),
  overlayConfig: (patch) => call('overlay:config', patch),
  saveHotkeys: (hotkeys) => call('hotkeys:save', hotkeys),
  pauseHotkeys: (paused) => call('hotkeys:pause', paused),
  onHotkeyMini: (cb) => listen('hotkey:mini', cb),
  onHotkeyQuestion: (cb) => listen('hotkey:question', cb),
  miniPush: (payload) => ipcRenderer.send('mini:push', payload),
  onMiniOpened: (cb) => listen('mini:opened', cb),
  onMiniClosed: (cb) => listen('mini:closed', cb),
  onMiniAction: (cb) => listen('mini:action', cb),
  onHotkeyAsk: (cb) => listen('hotkey:ask', cb),
  onHotkeyClear: (cb) => listen('hotkey:clear', cb),
  onHotkeyError: (cb) => listen('hotkey:error', cb),
  onClickThrough: (cb) => listen('state:clickThrough', cb),
  onOpenSettings: (cb) => listen('ui:open-settings', cb),
};

contextBridge.exposeInMainWorld('api', ROLE === 'main' ? mainApi : floatingApi);

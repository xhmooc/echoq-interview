/* 配置：llm / asr / profile / audio / ui / auth / setup 七个分区，存到用户数据目录的 config.json。
 *
 * 首次运行会把项目根目录的历史 config.json（开发期）迁移过来；如果本机
 * 还留着 clipforge 的 vendor，顺手把它的模型网关和 ASR 路径借过来。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const ROOT = paths.ROOT;
const CONFIG_PATH = paths.configPath();
const LEGACY_CONFIG = paths.legacyConfigPath();

const DEFAULTS = {
  llm: {
    mode: 'official', // official = 官方接入（登录即用，按分钟扣时长，默认）；own = 自己的 Key（免费）
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: '',
    temperature: 0.4,
    answer_detail: 3, // 回答复杂度：1 极简 / 2 简洁 / 3 标准 / 4 详细 / 5 深入
    answer_oral: false, // 口语直读模式：关闭时保持原有结构化回答
    official_key: '', // 官方接入专属 Key（icp_ 开头），由运营发放
    official_model: '', // 官方接入的模型名；留空由服务端决定
  },
  asr: {
    provider: 'llama', // llama = 本地 llama.cpp 跑 Qwen3-ASR（默认）；cloud = 官方云端；own = 用户自带的转写服务
    base_url: 'https://api.openai.com/v1',
    api_key: '',
    model: '',
    llama_bin: '',
    llama_model: '',
    llama_mmproj: '',
    llama_port: 8091,
    hotwords: '',
    custom_presets: {},
    language: 'auto', // auto = 跟随说话人；zh = 中文；en = 英文
  },
  profile: {
    job: '',
    resume: '',
    syllabus: '',
  },
  audio: {
    source: 'system', // system = 系统声音（面试官）；mic = 麦克风
    silence_ms: 650,
    max_segment_s: 14,
    sensitivity: 0.012,
    auto_answer: true,
    input_device_id: '', // 麦克风设备 ID；空 = 系统默认
    output_device_id: '', // 试听输出设备 ID；空 = 系统默认
  },
  ui: {
    opacity: 1,
    theme: 'light',
    content_protection: false, // 防录屏默认关闭：Windows 下并不能可靠拦截，开着反而让用户误以为生效
    guard_rev: 2, // 防录屏默认值版本；旧配置升级时据此关掉一次
    hotkeys: true,
    mode: 'interview', // interview | written；主界面上次停留的模式
    rail_width: 76, // 右侧题目栏宽度；拖动分栏后记住
    transcript_h: 148, // 面试官转写区高度；拖动分栏后记住
  },
  written: {
    ocr_mode: 'auto', // auto | local | cloud；auto = 本地 OCR 优先，云端视觉兜底
    ocr_engine: 'windows', // windows | indra | custom；custom = 用户自带的 OpenAI 兼容视觉模型
    custom_base_url: 'https://api.openai.com/v1',
    custom_api_key: '',
    custom_model: '',
    answer_target: 'both', // pc | phone | both；答案显示位置
  },
  hotkeys: {
    mini: 'Control+Alt+O', // 打开歌词悬浮窗 / 回主窗
    reveal: 'Control+Alt+M', // 唤出悬浮控制
    prev: 'Control+Alt+Z', // 上一题
    next: 'Control+Alt+X', // 下一题
    hide: 'Control+Alt+H', // 显示 / 隐藏
    ask: 'Control+Alt+A', // 对当前题目作答
    clear: 'Control+Alt+K', // 清空记录
    capture: 'Alt+Shift+A', // 笔试：框选截图
    answer: 'Alt+Shift+S', // 笔试：显示 / 隐藏答案悬浮窗
  },
  auth: {
    // 账号服务器地址，用户界面不暴露；后端换域名后只改这一行并重新打包。
    // 开发时可用 INTERVIEW_AUTH_URL 覆盖（例如指向本机 8787）。
    base_url: 'https://job.echoq.cn',
  },
  setup: {
    done: false, // 首次启动引导是否已完成（跳过也算完成）
    hero_done: false, // 初始化后的起始页是否已经看过；看完或跳过后不再出现
  },
  update: {
    skipped_version: '', // 用户点过「稍后」的版本；同一版本不再自动弹，强制更新除外
  },
  window: {
    x: null, // 上次关闭时的窗口位置，null 表示按主屏居中摆放
    y: null,
    width: 460,
    height: 660,
    center_rev: 2, // 窗口默认位置版本；旧配置升级时清空一次坐标，让居中生效
    mini: { // 控制面板式悬浮窗的位置与尺寸
      x: null,
      y: null,
      width: 360,
      height: 430,
    },
    lyrics: { // 歌词式文字层的位置、尺寸、字号与锁定状态
      x: null,
      y: null,
      width: 640,
      height: 340,
      fontSize: 24,
      locked: false,
      rev: 2,
    },
    answer: { // 笔试答案悬浮窗；首次出现在主屏右上角，拖动后记住位置与尺寸
      x: null,
      y: null,
      width: 380,
      height: 320,
    },
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/* 落盘前要加密的 Key：与 auth.json 一样走 safeStorage，读配置的代码不用改。 */
const SECRET_FIELDS = [
  ['llm', 'api_key'],
  ['llm', 'official_key'],
  ['asr', 'api_key'],
  ['written', 'custom_api_key'],
];

function safeStorageApi() {
  try {
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch (err) {
    return null;
  }
}

function canSeal() {
  try {
    const storage = safeStorageApi();
    return Boolean(storage && storage.isEncryptionAvailable());
  } catch (err) {
    return false;
  }
}

function sealSecret(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return '';
  try {
    const storage = safeStorageApi();
    if (storage && storage.isEncryptionAvailable()) {
      return { enc: storage.encryptString(text).toString('base64') };
    }
  } catch (err) {
    // 系统加密不可用时保留明文，下一次可加密时再迁移
  }
  return text;
}

function openSecret(value) {
  if (value && typeof value === 'object' && value.enc) {
    try {
      const storage = safeStorageApi();
      return storage ? storage.decryptString(Buffer.from(value.enc, 'base64')) : '';
    } catch (err) {
      return '';
    }
  }
  return typeof value === 'string' ? value : '';
}

function mapSecrets(data, fn) {
  if (!data || typeof data !== 'object') return data;
  const copy = clone(data);
  for (const [section, key] of SECRET_FIELDS) {
    if (copy[section] && typeof copy[section] === 'object' && key in copy[section]) {
      copy[section][key] = fn(copy[section][key]);
    }
  }
  return copy;
}

function hasPlainSecret(raw) {
  return SECRET_FIELDS.some(([section, key]) => (
    raw && raw[section] && typeof raw[section][key] === 'string' && raw[section][key]
  ));
}

function writeConfig(data) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(mapSecrets(data, sealSecret), null, 2), 'utf-8');
}

function merge(base, patch) {
  const out = clone(base);
  for (const section of Object.keys(out)) {
    if (patch && typeof patch[section] === 'object' && patch[section] !== null) {
      for (const key of Object.keys(out[section])) {
        if (key in patch[section]) out[section][key] = patch[section][key];
      }
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return null;
  }
}

function seedFromClipforge(data) {
  try {
    const old = readJson(path.join(ROOT, '..', 'clipforge', 'config.json'));
    if (!old) return data;

    if (old.llm) {
      if (!data.llm.api_key && old.llm.api_key) data.llm.api_key = old.llm.api_key;
      if (!data.llm.model && old.llm.model) data.llm.model = old.llm.model;
      if (data.llm.base_url === DEFAULTS.llm.base_url && old.llm.base_url) data.llm.base_url = old.llm.base_url;
    }
    if (old.asr) {
      if (!data.asr.api_key && old.asr.api_key) data.asr.api_key = old.asr.api_key;
      if (!data.asr.model && old.asr.model) data.asr.model = old.asr.model;
      if (data.asr.base_url === DEFAULTS.asr.base_url && old.asr.base_url) data.asr.base_url = old.asr.base_url;
    }

    const vendor = paths.legacyVendor();
    if (!data.asr.llama_bin && fs.existsSync(vendor.binary)) data.asr.llama_bin = vendor.binary;
    if (!data.asr.llama_model && fs.existsSync(vendor.model)) data.asr.llama_model = vendor.model;
    if (!data.asr.llama_mmproj && fs.existsSync(vendor.mmproj)) data.asr.llama_mmproj = vendor.mmproj;
  } catch (err) {
    // 种子数据坏了不影响正常启动，用默认值继续
  }
  return data;
}

/* 首次运行：优先迁移项目根目录的旧配置，其次从 clipforge 借默认值。 */
function bootstrap() {
  if (fs.existsSync(CONFIG_PATH)) return;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (fs.existsSync(LEGACY_CONFIG)) {
      // 老用户已经配好一切，迁移后直接视为完成初始化，不再弹首次引导
      const migrated = merge(clone(DEFAULTS), readJson(LEGACY_CONFIG) || {});
      migrated.setup.done = true;
      migrated.setup.hero_done = true;
      writeConfig(migrated);
      return;
    }
  } catch (err) {
    // 目录不可写时继续，下面会尝试直接落盘
  }
  const data = seedFromClipforge(clone(DEFAULTS));
  try {
    writeConfig(data);
  } catch (err) {
    // 只读环境：用内存默认值也能跑
  }
}

function load() {
  bootstrap();
  const raw = readJson(CONFIG_PATH);
  if (!raw) return seedFromClipforge(clone(DEFAULTS));
  const data = mapSecrets(raw, openSecret);
  let migrated = false;
  // 旧版默认 0.96 会让整窗（含圆角）看起来半透明，升级后按不透明处理
  if (data.ui && data.ui.opacity === 0.96) data.ui.opacity = 1;
  // 旧版默认开启防录屏，但 Windows 下并不能可靠生效；升级后统一关掉一次
  if (data.ui && Number(data.ui.guard_rev || 0) < 2) {
    data.ui.content_protection = false;
    data.ui.guard_rev = 2;
    migrated = true;
  }
  // 老用户已经用过工作界面，不再补一次起始页
  if (data.setup && data.setup.done === true && !('hero_done' in data.setup)) {
    data.setup.hero_done = true;
    migrated = true;
  }
  /* 旧版窗口默认落在左上角，且 restoreBounds 曾把 null 当成 0；
   * 升到 center_rev 2 时清空一次坐标，让主屏居中生效。 */
  if (data.window && Number(data.window.center_rev || 0) < 2) {
    data.window.x = null;
    data.window.y = null;
    data.window.center_rev = 2;
    migrated = true;
  }
  /* 曾经隐藏过自填 Key 的入口：如果旧配置里残留 mode=own 但参数不全，
   * 直接回到官方接入，避免升级后回答一直报配置错误。 */
  if (data.llm && data.llm.mode === 'own'
    && (!String(data.llm.base_url || '').trim()
      || !String(data.llm.api_key || '').trim()
      || !String(data.llm.model || '').trim())) {
    data.llm.mode = 'official';
    migrated = true;
  }
  // 旧版可能把账号服务器地址存成空串，导致登录一直连本机 8787
  if (data.auth && !String(data.auth.base_url || '').trim()) {
    data.auth.base_url = DEFAULTS.auth.base_url;
  }
  /* 域名启用后，旧默认地址自动迁到 HTTPS 域名；用户自己改过的其他地址保持不动。 */
  if (data.auth) {
    const currentAuthBase = String(data.auth.base_url || '').trim().replace(/\/+$/, '');
    if (currentAuthBase === 'http://47.117.49.191:8787' || currentAuthBase === 'http://47.117.49.191') {
      data.auth.base_url = DEFAULTS.auth.base_url;
      migrated = true;
    }
  }
  const merged = merge(DEFAULTS, data);
  // 旧配置里的明文 Key 在系统加密可用后自动迁移成密文
  if (migrated || (canSeal() && hasPlainSecret(raw))) {
    try {
      writeConfig(merged);
    } catch (err) {
      // 迁移失败下次启动再试，不影响本次使用
    }
  }
  return merged;
}

function save(patch) {
  const next = merge(load(), patch);
  writeConfig(next);
  return next;
}

/* 导出配置：Key 一律清空，避免把凭据写进用户随手分享的文件。 */
function exportable() {
  return mapSecrets(load(), () => '');
}

/* 导入配置：直接删掉 Key 字段，保留本机原来的 Key，不被导入文件覆盖。 */
function withoutSecrets(data) {
  const copy = data && typeof data === 'object' ? clone(data) : {};
  for (const [section, key] of SECRET_FIELDS) {
    if (copy[section] && typeof copy[section] === 'object') delete copy[section][key];
  }
  return copy;
}

module.exports = {
  ROOT, CONFIG_PATH, DEFAULTS, load, save, merge, exportable, withoutSecrets,
};

/* 云端只读数据：计费策略、价格套餐、功能开关、公告、官方模型、热词库。
 *
 * 原则：服务端是唯一权威，本模块只做短时缓存，减少请求并支持断网回退。
 * 缓存过期后重新拉取；失败时返回默认值，并在 source 字段标明 default，
 * 界面据此提示「同步中 / 使用默认策略」，而不是把默认值当成服务端结论。
 */
const auth = require('./auth');

const TTL = {
  config: 10 * 60 * 1000,
  models: 30 * 60 * 1000,
  hotwords: 30 * 60 * 1000,
  failed: 60 * 1000, // 请求失败时 1 分钟内不重复打扰服务端
};

const DEFAULTS = {
  pricing: {
    currency: 'CNY',
    unit: 'minute',
    price_per_minute: null,
    plans: [],
  },
  billing: {
    low_balance_seconds: 60,
    grace_seconds: 90,
  },
  features: {
    official_relay: true,
    redeem: true,
    hotwords: true,
    sms: false,
  },
  notice: {
    text: '',
    level: 'info',
    action: '',
    min_version: '',
  },
  models: {
    default_model: '',
    items: [],
  },
};

const cache = {
  config: null,
  models: null,
  hotwords: null,
  asr: null,
};

function fresh(entry, ttl) {
  return Boolean(entry && Date.now() - entry.at < (entry.ok ? ttl : TTL.failed));
}

async function getJson(pathname, token) {
  const response = await fetch(`${auth.baseUrl()}${pathname}`, {
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

function text(value, fallback) {
  const out = String(value == null ? '' : value).trim();
  return out || fallback;
}

function numberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sanitizeConfig(data) {
  const src = data && typeof data === 'object' ? data : {};
  const pricing = src.pricing && typeof src.pricing === 'object' ? src.pricing : {};
  const billing = src.billing && typeof src.billing === 'object' ? src.billing : {};
  const features = src.features && typeof src.features === 'object' ? src.features : {};
  const notice = src.notice && typeof src.notice === 'object' ? src.notice : {};

  return {
    pricing: {
      currency: text(pricing.currency, DEFAULTS.pricing.currency),
      unit: pricing.unit === 'second' ? 'second' : 'minute',
      price_per_minute: numberOrNull(pricing.price_per_minute),
      plans: Array.isArray(pricing.plans)
        ? pricing.plans
          .filter((plan) => plan && typeof plan === 'object')
          .map((plan) => ({
            id: text(plan.id, ''),
            name: text(plan.name, ''),
            minutes: clampInt(plan.minutes, 0, 0, 1000000),
            price: numberOrNull(plan.price) != null
              ? numberOrNull(plan.price)
              : (numberOrNull(plan.price_yuan) != null
                ? numberOrNull(plan.price_yuan)
                : numberOrNull(Number(plan.amount_cents) / 100)),
            note: text(plan.note || plan.tag, ''),
          }))
          .filter((plan) => plan.id || plan.name)
        : [],
    },
    billing: {
      low_balance_seconds: clampInt(
        billing.low_balance_seconds,
        DEFAULTS.billing.low_balance_seconds,
        0,
        86400,
      ),
      grace_seconds: clampInt(
        billing.grace_seconds,
        DEFAULTS.billing.grace_seconds,
        0,
        600,
      ),
    },
    features: {
      official_relay: features.official_relay !== false,
      redeem: features.redeem !== false,
      hotwords: features.hotwords !== false,
      sms: features.sms === true,
    },
    notice: {
      text: text(notice.text, ''),
      level: text(notice.level, 'info'),
      action: text(notice.action, ''),
      min_version: text(notice.min_version, ''),
    },
  };
}

function sanitizeModels(data) {
  const src = data && typeof data === 'object' ? data : {};
  const list = Array.isArray(src.models) ? src.models : (Array.isArray(src.data) ? src.data : []);
  const items = [];
  for (const entry of list) {
    const item = typeof entry === 'string' ? { id: entry } : entry;
    if (!item || typeof item !== 'object') continue;
    const id = text(item.id || item.model, '');
    if (!id || items.some((model) => model.id === id)) continue;
    items.push({
      id,
      name: text(item.name, id),
      note: text(item.note, ''),
    });
  }
  const fallback = items.length ? items[0].id : '';
  return {
    default_model: text(src.default_model, fallback),
    items,
  };
}

async function appConfig(options) {
  const force = Boolean(options && options.force);
  if (!force && fresh(cache.config, TTL.config)) return cache.config.data;
  try {
    const data = sanitizeConfig(await getJson('/api/app/config'));
    const result = { ...data, source: 'server', error: '' };
    cache.config = { data: result, at: Date.now(), ok: true };
    return result;
  } catch (err) {
    // 后端还没提供聚合配置时，退到已有的套餐接口，至少保证价格页可用。
    try {
      const plans = await getJson('/api/plans');
      const list = Array.isArray(plans && plans.plans) ? plans.plans : [];
      const result = {
        ...DEFAULTS,
        pricing: {
          ...DEFAULTS.pricing,
          plans: list
            .filter((plan) => plan && typeof plan === 'object')
            .map((plan) => ({
              id: text(plan.id, ''),
              name: text(plan.name, ''),
              minutes: clampInt(plan.minutes, 0, 0, 1000000),
              price: numberOrNull(plan.price_yuan) != null
                ? numberOrNull(plan.price_yuan)
                : numberOrNull(Number(plan.amount_cents) / 100),
              note: text(plan.tag, ''),
            }))
            .filter((plan) => plan.id || plan.name),
        },
        source: 'plans',
        error: '',
      };
      cache.config = { data: result, at: Date.now(), ok: true };
      return result;
    } catch (planErr) {
      const result = { ...DEFAULTS, source: 'default', error: err.message || '云端配置不可用' };
      cache.config = { data: result, at: Date.now(), ok: false };
      return result;
    }
  }
}

async function models(options) {
  const force = Boolean(options && options.force);
  if (!force && fresh(cache.models, TTL.models)) return cache.models.data;
  try {
    let raw = null;
    try {
      raw = await getJson('/api/models');
    } catch (err) {
      // 官方模型清单接口未上线时，用中转的 OpenAI 兼容 /v1/models 兜底。
      const plain = auth.token();
      if (!plain) throw err;
      raw = await getJson('/v1/models', plain);
    }
    const data = sanitizeModels(raw);
    const result = { ...data, source: 'server', error: '' };
    cache.models = { data: result, at: Date.now(), ok: true };
    return result;
  } catch (err) {
    const result = { ...DEFAULTS.models, source: 'default', error: err.message || '官方模型清单不可用' };
    cache.models = { data: result, at: Date.now(), ok: false };
    return result;
  }
}

async function hotwords(options) {
  const force = Boolean(options && options.force);
  if (!force && fresh(cache.hotwords, TTL.hotwords)) return cache.hotwords.data;
  try {
    const data = await getJson('/api/hotwords');
    const libraries = data && data.libraries && typeof data.libraries === 'object' ? data.libraries : {};
    const result = { ok: true, libraries, source: 'server', error: '' };
    cache.hotwords = { data: result, at: Date.now(), ok: true };
    return result;
  } catch (err) {
    const result = {
      ok: false,
      libraries: {},
      source: 'default',
      error: `连不上在线词库（${err.message || '网络错误'}），已使用本地词库`,
    };
    cache.hotwords = { data: result, at: Date.now(), ok: false };
    return result;
  }
}

function invalidate() {
  cache.config = null;
  cache.models = null;
  cache.hotwords = null;
  cache.asr = null;
}

/* 云端识别开关与限制：404 视为未上线，直接走本机，避免每段都白跑一次请求。 */
async function asrConfig(options) {
  const force = Boolean(options && options.force);
  if (!force && fresh(cache.asr, TTL.config)) return cache.asr.data;

  const plain = auth.token();
  try {
    const raw = await getJson('/api/asr/config', plain);
    const src = raw && typeof raw === 'object' ? raw : {};
    const result = {
      enabled: src.enabled !== false,
      provider: text(src.provider, ''),
      timeout_ms: clampInt(src.timeout_ms, 8000, 2000, 20000),
      max_audio_seconds: clampInt(src.max_audio_seconds, 15, 3, 60),
      max_audio_bytes: clampInt(src.max_audio_bytes, 1048576, 65536, 8388608),
      source: 'server',
    };
    cache.asr = { data: result, at: Date.now(), ok: true };
    return result;
  } catch (err) {
    // 404 说明后端还没有这个接口；网络类错误先当作可用，让转写请求自己判定。
    const offline = err.status === 404;
    const result = {
      enabled: !offline,
      provider: '',
      timeout_ms: 8000,
      max_audio_seconds: 15,
      max_audio_bytes: 1048576,
      source: offline ? 'unsupported' : 'default',
    };
    cache.asr = { data: result, at: Date.now(), ok: false };
    return result;
  }
}

module.exports = { DEFAULTS, appConfig, models, hotwords, asrConfig, invalidate };

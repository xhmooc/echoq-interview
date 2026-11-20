/* 账号与时长钱包：主进程请求计费服务，token 用 safeStorage 加密后存在应用数据目录。
 *
 * 计费口径：服务端按秒扣减，客户端按分钟展示。
 * 登录/注册免费；余额为 0 时不允许开始使用，必须先兑换时长码。
 * 计时必须在联网状态下进行：断网时按离线处理，不允许继续使用。
 */
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const config = require('./config');
const paths = require('./paths');

const TOKEN_FILE = path.join(paths.userRoot(), 'auth.json');
/* 断网/服务端故障时没吊销成功的 token 排队，下次联网启动优先补发。 */
const REVOKE_FILE = path.join(paths.userRoot(), 'revocations.json');
const DEFAULT_BASE = 'http://127.0.0.1:8787';

function baseUrl() {
  const value = String(((config.load() || {}).auth || {}).base_url || '').trim();
  const fallback = String(((config.DEFAULTS || {}).auth || {}).base_url || '').trim() || DEFAULT_BASE;
  return (value || process.env.INTERVIEW_AUTH_URL || fallback).replace(/\/+$/, '');
}

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  } catch (err) {
    return null;
  }
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[auth] 保存登录状态失败：', err.message);
  }
}

function clearStore() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    // 文件不存在时忽略
  }
}

/* auth.json 里只把 user/wallet 当作「上次同步的快照」，不是权威账本。
 * 老版本直接把 user/wallet 写在顶层，这里做一次兼容读取。 */
function readCache(record) {
  if (!record) return { user: null, wallet: null, at: 0 };
  if (record.cached && typeof record.cached === 'object') {
    return {
      user: record.cached.user || null,
      wallet: record.cached.wallet || null,
      at: Number(record.cached.at || record.last_verified_at) || 0,
    };
  }
  return {
    user: record.user || null,
    wallet: record.wallet || null,
    at: Number(record.last_verified_at) || 0,
  };
}

function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sealToken(token) {
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return { enc: safeStorage.encryptString(token).toString('base64') };
    }
  } catch (err) {
    // 系统不支持加密时退回明文
  }
  return { plain: token };
}

function openToken(record) {
  if (!record) return '';
  if (record.enc) {
    try {
      return safeStorage.decryptString(Buffer.from(record.enc, 'base64'));
    } catch (err) {
      return '';
    }
  }
  return record.plain || '';
}

function token() {
  return openToken((readStore() || {}).token);
}

function readRevokes() {
  try {
    const data = JSON.parse(fs.readFileSync(REVOKE_FILE, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function writeRevokes(list) {
  try {
    fs.mkdirSync(path.dirname(REVOKE_FILE), { recursive: true });
    fs.writeFileSync(REVOKE_FILE, JSON.stringify(list, null, 2), 'utf-8');
  } catch (err) {
    console.error('[auth] 保存待吊销记录失败：', err.message);
  }
}

function queueRevoke(plain) {
  if (!plain) return;
  const list = readRevokes();
  list.push({ token: sealToken(plain), at: Date.now() });
  // 只留最近 20 条，避免离线反复登录把文件撑大
  writeRevokes(list.slice(-20));
}

/* 启动时补发未完成的吊销请求：网络仍不可用就继续排队，401 说明 token 已失效可丢弃。 */
async function flushRevocations() {
  const list = readRevokes();
  if (!list.length) return { ok: true, pending: 0 };
  const keep = [];
  for (const item of list) {
    const plain = openToken(item.token);
    if (!plain) continue;
    try {
      await request('/api/auth/logout', { method: 'POST', token: plain, timeout: 4000 });
    } catch (err) {
      if (!err.status || err.status >= 500) keep.push(item);
    }
  }
  writeRevokes(keep);
  if (keep.length !== list.length) console.log('[auth] 补发吊销完成，剩余', keep.length);
  return { ok: true, pending: keep.length };
}

async function request(pathname, options) {
  const opts = options || {};
  const controller = new AbortController();
  const timeoutMs = Number(opts.timeout) > 0 ? Number(opts.timeout) : 8000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${pathname}`, {
      method: opts.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败（${res.status}）`);
      err.status = res.status;
      err.payload = data;
      throw err;
    }
    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeout = new Error('连接计费服务器超时');
      timeout.network = true;
      throw timeout;
    }
    if (!err.status) err.network = true;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function friendlyError(err) {
  if (err && err.network) return '连不上计费服务器，请检查网络后重试';
  return (err && err.message) || '操作失败，请重试';
}

function walletFrom(value) {
  const seconds = Math.max(0, Math.floor(Number(value && value.balance_seconds) || 0));
  return {
    balance_seconds: seconds,
    balance_minutes: Math.floor(seconds / 60),
  };
}

function stateFrom(data) {
  const value = data || {};
  const user = value.user || null;
  const wallet = walletFrom(value.wallet);
  const billing = value.billing && typeof value.billing === 'object' ? value.billing : {};
  const source = value.wallet_source === 'cache'
    ? 'cache'
    : (user ? 'server' : 'none');
  return {
    logged_in: Boolean(user),
    email: user ? user.email : '',
    balance_seconds: wallet.balance_seconds,
    balance_minutes: wallet.balance_minutes,
    active: Boolean(user) && wallet.balance_seconds > 0 && !value.offline,
    offline: Boolean(value.offline),
    error: value.error || '',
    wallet_source: source,
    cached_at: Number(value.cached_at) || 0,
    server_time: Number(value.server_time) || Date.now(),
    low_balance_seconds: clampInt(billing.low_balance_seconds, null, 0, 86400),
    grace_seconds: clampInt(billing.grace_seconds, null, 0, 600),
    pricing: value.pricing && typeof value.pricing === 'object' ? value.pricing : null,
    entitlements: value.entitlements && typeof value.entitlements === 'object' ? value.entitlements : null,
  };
}

/* 每次和服务端交互后都把最新账号与余额写成「同步快照」，只用于离线展示。
 * 真正的余额始终以服务端 /api/me 与心跳返回为准，客户端不据此扣费。 */
function remember(data, plainToken) {
  const record = readStore() || {};
  const previous = readCache(record);
  const hasWallet = Boolean(data && data.wallet);
  const cached = {
    user: (data && data.user) || previous.user || null,
    wallet: hasWallet ? data.wallet : previous.wallet,
    at: hasWallet || (data && data.user) ? Date.now() : previous.at,
  };
  writeStore({
    token: plainToken ? sealToken(plainToken) : (record.token || null),
    cached,
    last_verified_at: cached.at,
  });
}

function persist(data) {
  remember(data, data.token);
}

async function status() {
  const record = readStore();
  const plain = openToken(record && record.token);
  if (!plain) return stateFrom({});

  try {
    // 启动阶段的登录态校验要短超时，避免首屏被网络拖住
    const data = await request('/api/me', { token: plain, timeout: 5000 });
    persist(data);
    return stateFrom({ ...data, wallet_source: 'server' });
  } catch (err) {
    if (err.status === 401) {
      clearStore();
      return stateFrom({ error: '登录已失效，请重新登录' });
    }

    const cached = readCache(record);
    const state = stateFrom({
      user: cached.user,
      wallet: cached.wallet,
      wallet_source: 'cache',
      cached_at: cached.at,
      offline: true,
      error: '当前网络连不上计费服务器，联网后才能继续使用',
    });
    // 离线时余额只是上次同步的快照，不能据此放行
    state.active = false;
    return state;
  }
}

async function register(payload) {
  try {
    const data = await request('/api/auth/register', {
      method: 'POST',
      body: {
        email: payload && payload.email,
        password: payload && payload.password,
        invite_code: (payload && payload.invite_code) || undefined,
      },
    });
    persist(data);
    return {
      ok: true,
      state: stateFrom(data),
      signup_bonus_minutes: Number(data.signup_bonus_minutes) || 0,
    };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function login(payload) {
  try {
    const data = await request('/api/auth/login', {
      method: 'POST',
      body: { email: payload && payload.email, password: payload && payload.password },
    });
    persist(data);
    return { ok: true, state: stateFrom(data) };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function redeem(code) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/wallet/redeem', {
      method: 'POST',
      token: plain,
      body: { code },
    });
    remember({ ...data, token: plain }, plain);
    return { ok: true, minutes: Number(data.minutes) || 0, state: stateFrom(data) };
  } catch (err) {
    if (err.status === 401) clearStore();
    return { ok: false, error: friendlyError(err) };
  }
}

function cachedUser() {
  return readCache(readStore()).user;
}

function usageMeta(data) {
  const src = data || {};
  const billing = src.billing && typeof src.billing === 'object' ? src.billing : null;
  return {
    billing,
    server_time: Number(src.server_time) || Date.now(),
    grace_seconds: clampInt(billing && billing.grace_seconds, null, 0, 600),
    low_balance_seconds: clampInt(billing && billing.low_balance_seconds, null, 0, 86400),
  };
}

async function startUsage(clientSessionId) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const body = clientSessionId
      ? { client_session_id: String(clientSessionId).trim().slice(0, 80) }
      : {};
    const data = await request('/api/usage/start', { method: 'POST', token: plain, body });
    const wallet = walletFrom(data);
    remember({ user: cachedUser(), wallet }, plain);
    return { ok: true, session_id: data.session_id, wallet, ...usageMeta(data) };
  } catch (err) {
    if (err.status === 401) {
      clearStore();
      return { ok: false, unauthorized: true, error: '登录已失效，请重新登录' };
    }
    if (err.payload && err.payload.wallet) {
      remember({ user: cachedUser(), wallet: err.payload.wallet }, plain);
    }
    return { ok: false, error: friendlyError(err), wallet: err.payload && err.payload.wallet };
  }
}

async function heartbeatUsage(sessionId) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/usage/heartbeat', {
      method: 'POST',
      token: plain,
      body: { session_id: sessionId },
    });
    const wallet = walletFrom(data.wallet || { balance_seconds: data.balance });
    remember({ user: cachedUser(), wallet }, plain);
    return {
      ok: true,
      charge: Number(data.charge) || 0,
      ended: Boolean(data.ended),
      wallet,
      ...usageMeta(data),
    };
  } catch (err) {
    if (err.status === 401) {
      clearStore();
      return { ok: false, unauthorized: true, error: '登录已失效，请重新登录' };
    }
    if (err.payload && err.payload.wallet) {
      remember({ user: cachedUser(), wallet: err.payload.wallet }, plain);
    }
    return {
      ok: false,
      error: friendlyError(err),
      // 纯网络故障时给客户端一个宽限窗口；余额仍以最后一次服务端返回为准。
      grace: Boolean(err.network),
      session_alive: Boolean(err.network),
      wallet: err.payload && err.payload.wallet,
    };
  }
}

async function stopUsage(sessionId) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  if (!sessionId) return { ok: true, wallet: walletFrom(readCache(readStore()).wallet) };
  try {
    const data = await request('/api/usage/stop', {
      method: 'POST',
      token: plain,
      body: { session_id: sessionId },
    });
    const wallet = walletFrom(data);
    remember({ user: cachedUser(), wallet }, plain);
    return { ok: true, wallet, ended: data.ended !== false, ...usageMeta(data) };
  } catch (err) {
    if (err.status === 401) {
      clearStore();
      return { ok: false, unauthorized: true, error: '登录已失效，请重新登录' };
    }
    if (err.payload && err.payload.wallet) {
      remember({ user: cachedUser(), wallet: err.payload.wallet }, plain);
    }
    return { ok: false, error: friendlyError(err) };
  }
}

/* 登出：先让服务端递增 token_version 撤销所有 token，再清本地。
 * 断网或服务端 5xx 时把 token 放进待吊销队列，下次联网启动补发。 */
async function logout() {
  const plain = token();
  if (plain) {
    try {
      await request('/api/auth/logout', { method: 'POST', token: plain, timeout: 4000 });
    } catch (err) {
      if (!err.status || err.status >= 500) queueRevoke(plain);
    }
  }
  clearStore();
  return { ok: true };
}

/* 手机号验证码：先发码，再登录（未注册会自动注册）。 */
async function sendSms(phone) {
  try {
    const data = await request('/api/auth/sms/send', {
      method: 'POST',
      body: { phone: String(phone || '').trim() },
    });
    return {
      ok: true,
      expires_in: Number(data.expires_in) || 300,
      resend_in: Number(data.resend_in) || 60,
      dev_code: data.dev_code || '',
    };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function smsLogin(payload) {
  const body = {
    phone: String((payload && payload.phone) || '').trim(),
    code: String((payload && payload.code) || '').trim(),
  };
  if (payload && payload.invite_code) body.invite_code = String(payload.invite_code).trim();
  try {
    const data = await request('/api/auth/sms/login', { method: 'POST', body });
    persist(data);
    return {
      ok: true,
      is_new: Boolean(data.is_new),
      signup_bonus_minutes: Number(data.signup_bonus_minutes) || 0,
      state: stateFrom(data),
    };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

/* 改密后旧 token 立即失效，必须用响应里的新 token 覆盖本地。 */
async function changePassword(payload) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/auth/password', {
      method: 'POST',
      token: plain,
      body: {
        old_password: payload && payload.old_password,
        code: payload && payload.code,
        new_password: payload && payload.new_password,
      },
    });
    if (data && data.token) {
      const cached = readCache(readStore());
      writeStore({ token: sealToken(data.token), cached, last_verified_at: cached.at });
    }
    return { ok: true };
  } catch (err) {
    if (err.status === 401) clearStore();
    return { ok: false, error: friendlyError(err) };
  }
}

async function resetPassword(payload) {
  try {
    await request('/api/auth/password/reset', {
      method: 'POST',
      body: {
        phone: String((payload && payload.phone) || '').trim(),
        code: String((payload && payload.code) || '').trim(),
        new_password: payload && payload.new_password,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function inviteInfo() {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/invite', { token: plain });
    return { ok: true, invite: data.invite || null };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function validatePromo(code, planId) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/promo/validate', {
      method: 'POST',
      token: plain,
      body: { code: String(code || '').trim(), plan_id: planId },
    });
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function exportAccount() {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/account/export', { token: plain, timeout: 20000 });
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: friendlyError(err) };
  }
}

async function deleteAccount(payload) {
  const plain = token();
  if (!plain) return { ok: false, error: '请先登录' };
  try {
    const data = await request('/api/account/delete', {
      method: 'POST',
      token: plain,
      body: {
        email: payload && payload.email,
        password: payload && payload.password,
        code: payload && payload.code,
      },
    });
    clearStore();
    return { ok: true, message: data.message || '账号已注销' };
  } catch (err) {
    if (err.status === 401) clearStore();
    return { ok: false, error: friendlyError(err) };
  }
}

module.exports = {
  status, register, login, redeem, logout, startUsage, heartbeatUsage, stopUsage,
  sendSms, smsLogin, changePassword, resetPassword, inviteInfo, validatePromo,
  exportAccount, deleteAccount, flushRevocations,
  baseUrl, token, request, friendlyError,
};

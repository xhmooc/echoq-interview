/* 订单与支付：对应后端 1.2.1 的可切换支付通道（manual 人工核销 / epay 易支付）。
 *
 * 客户端只做三件事：下单 → 展示 pay_page_url → 轮询订单状态。
 * 签名、通道选择、异步回调全在服务端，客户端不感知支付宝/微信。
 *
 * 注意：界面入口当前受渲染层 PAY_UI_ENABLED 控制，默认不显示。
 * 本模块只提供能力，不代表界面上架。
 */
const { shell } = require('electron');
const auth = require('./auth');

const ORDER_STATUS_TEXT = {
  pending: '待支付',
  paid: '已支付',
  cancelled: '已取消',
};

function friendly(err, status) {
  if (err && err.network) return '连不上计费服务器，请检查网络后重试';
  if (status === 404) return '订单不存在或不属于当前账号';
  if (status === 409) return '订单已处理，请刷新状态';
  if (status === 429) return '待支付订单过多，请先完成或取消旧订单';
  if (status === 400) return (err && err.message) || '当前无法下单';
  return (err && err.message) || '操作失败，请重试';
}

/* 统一出口：不把 token、payload 之外的内部字段抛给渲染层。 */
async function call(pathname, options) {
  const opts = options || {};
  const plain = auth.token();
  if (opts.auth !== false && !plain) {
    return { ok: false, unauthorized: true, error: '请先登录' };
  }
  try {
    const data = await auth.request(pathname, {
      method: opts.method || 'GET',
      body: opts.body,
      token: plain,
    });
    return { ok: true, ...(data || {}) };
  } catch (err) {
    const status = Number(err.status) || 0;
    return {
      ok: false,
      status,
      unauthorized: status === 401,
      error: friendly(err, status),
      // 400 / 409 会带 pay 或 order，供界面降级展示
      pay: (err.payload && err.payload.pay) || null,
      order: (err.payload && err.payload.order) || null,
    };
  }
}

/* 公开接口：套餐列表 + 当前支付通道。 */
async function plans() {
  return call('/api/plans', { auth: false });
}

async function create(planId, promoCode) {
  const id = String(planId || '').trim();
  if (!id) return { ok: false, error: '请选择套餐' };
  const body = { plan_id: id };
  const promo = String(promoCode || '').trim();
  if (promo) body.promo_code = promo;
  return call('/api/orders', { method: 'POST', body });
}

async function list() {
  return call('/api/orders');
}

async function get(orderNo) {
  const id = String(orderNo || '').trim();
  if (!id) return { ok: false, error: '订单号为空' };
  return call(`/api/orders/${encodeURIComponent(id)}`);
}

/* 每次点击支付都现签，不复用旧链接。 */
async function pay(orderNo) {
  const id = String(orderNo || '').trim();
  if (!id) return { ok: false, error: '订单号为空' };
  return call(`/api/orders/${encodeURIComponent(id)}/pay`, { method: 'POST', body: {} });
}

async function openExternal(url) {
  const value = String(url || '').trim();
  if (!/^https?:\/\//i.test(value)) return { ok: false, error: '支付地址无效' };
  try {
    await shell.openExternal(value);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: '无法打开浏览器，请手动复制链接' };
  }
}

module.exports = { plans, create, list, get, pay, openExternal, ORDER_STATUS_TEXT };

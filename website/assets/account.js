(function () {
  const TOKEN_KEY = 'ysc_token';
  const authView = document.getElementById('auth-view');
  const accountView = document.getElementById('account-view');
  const authForm = document.getElementById('auth-form');
  const authError = document.getElementById('auth-error');
  const accountError = document.getElementById('account-error');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const submitBtn = document.getElementById('auth-submit');
  const passwordHint = document.getElementById('password-hint');
  const tabs = Array.from(document.querySelectorAll('.auth-tab'));
  const emailLabel = document.getElementById('account-email');
  const minutesLabel = document.getElementById('balance-minutes');
  const balanceUnit = document.getElementById('balance-unit');
  const balanceSub = document.getElementById('balance-sub');
  const redeemBlock = document.getElementById('redeem-block');
  const redeemInput = document.getElementById('redeem-code');
  const redeemBtn = document.getElementById('redeem-btn');
  const toast = document.getElementById('toast');

  let mode = 'login';
  let toastTimer = null;

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch (e) { /* 忽略隐私模式写入失败 */ }
  }

  function clearToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function showToast(message, ok) {
    toast.textContent = message;
    toast.style.borderColor = ok === false ? 'rgba(220,38,38,.35)' : 'rgba(13,168,117,.35)';
    toast.style.background = ok === false ? '#fef2f2' : '#ffffff';
    toast.style.color = ok === false ? '#b91c1c' : '#0d1526';
    toast.style.opacity = '1';
    toast.style.transform = 'translate(-50%, 0)';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translate(-50%, 20px)';
    }, 3200);
  }

  function showError(el, message) {
    el.textContent = message || '';
    el.classList.toggle('show', Boolean(message));
  }

  async function api(path, options) {
    const opts = options || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = getToken();
    if (token && opts.auth !== false) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) {
      const err = new Error(data.error || '网络异常，请稍后再试');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function switchMode(next) {
    mode = next;
    tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.mode === next);
    });
    submitBtn.textContent = next === 'login' ? '登录' : '注册';
    passwordHint.hidden = next === 'login';
    passwordInput.autocomplete = next === 'login' ? 'current-password' : 'new-password';
    showError(authError, '');
  }

  function formatBalance(wallet) {
    if (wallet && wallet.free_mode) {
      minutesLabel.textContent = '正常';
      balanceUnit.textContent = '不限时长';
      balanceSub.textContent = '账号状态正常';
      redeemBlock.hidden = true;
      return;
    }
    redeemBlock.hidden = false;
    balanceUnit.textContent = '分钟剩余';
    const seconds = Number((wallet && wallet.balance_seconds) || 0);
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    minutesLabel.textContent = String(minutes);
    balanceSub.textContent = rest > 0
      ? '另有 ' + rest + ' 秒 · 按实际使用扣减'
      : '按实际使用秒数扣减';
  }

  function renderAccount(data) {
    const user = data.user || {};
    emailLabel.textContent = user.email || '—';
    formatBalance(data.wallet);
    authView.hidden = true;
    accountView.hidden = false;
  }

  function showAuth(message) {
    authView.hidden = false;
    accountView.hidden = true;
    showError(authError, message || '');
    showError(accountError, '');
  }

  async function loadMe(silent) {
    if (!getToken()) {
      showAuth();
      return false;
    }
    try {
      const data = await api('/me');
      renderAccount(data);
      return true;
    } catch (err) {
      if (err.status === 401) {
        clearToken();
        showAuth('登录已失效，请重新登录');
      } else if (!silent) {
        showAuth(err.message);
      }
      return false;
    }
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      switchMode(tab.dataset.mode);
    });
  });

  authForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError(authError, '');
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email) { showError(authError, '请输入邮箱'); return; }
    if (password.length < 6) { showError(authError, '密码至少 6 位'); return; }
    submitBtn.disabled = true;
    submitBtn.textContent = mode === 'login' ? '登录中…' : '注册中…';
    try {
      const data = await api(mode === 'login' ? '/auth/login' : '/auth/register', {
        method: 'POST',
        auth: false,
        body: { email: email, password: password }
      });
      setToken(data.token);
      renderAccount(data);
      showToast(mode === 'login' ? '登录成功' : '注册成功，欢迎使用');
      authForm.reset();
    } catch (err) {
      showError(authError, err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = mode === 'login' ? '登录' : '注册';
    }
  });

  redeemBtn.addEventListener('click', async function () {
    const code = redeemInput.value.trim().toUpperCase();
    showError(accountError, '');
    if (!code) { showError(accountError, '请输入时长码'); return; }
    redeemBtn.disabled = true;
    redeemBtn.textContent = '兑换中…';
    try {
      const data = await api('/wallet/redeem', { method: 'POST', body: { code: code } });
      formatBalance(data);
      redeemInput.value = '';
      showToast('兑换成功，增加 ' + (data.minutes || 0) + ' 分钟');
    } catch (err) {
      showError(accountError, err.message);
      if (err.status === 401) {
        clearToken();
        showAuth('登录已失效，请重新登录');
      }
    } finally {
      redeemBtn.disabled = false;
      redeemBtn.textContent = '兑换';
    }
  });

  redeemInput.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      redeemBtn.click();
    }
  });

  document.getElementById('refresh-btn').addEventListener('click', async function () {
    const ok = await loadMe();
    showToast(ok ? '状态已刷新' : '刷新失败，请稍后重试');
  });

  document.getElementById('logout-btn').addEventListener('click', function () {
    clearToken();
    showAuth();
    showToast('已退出登录');
  });

  if (location.hash === '#redeem') {
    setTimeout(function () { redeemInput.focus(); }, 300);
  }

  switchMode('login');
  loadMe(true);
})();

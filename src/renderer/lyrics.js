(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const STATUS_TEXT = {
    idle: '待机',
    pending: '待生成',
    connecting: '连接中',
    listening: '收音中',
    streaming: '生成中',
    done: '已完成',
    error: '失败',
  };
  const MIN_FONT = 14;
  const MAX_FONT = 48;
  const FONT_STEP = 2;
  const TEXT_GAP = 6;

  let state = null;
  let hasState = false;
  let lastAnswerId = null;
  let lastQuestion = '';
  let lastAnswer = '';
  let copyTimer = null;
  let fontSize = 24;
  let locked = false;
  let questions = [];
  let activeIndex = 0;
  let listOpen = false;

  const clampFont = (value) => Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(value)));

  function applyFont() {
    document.documentElement.style.setProperty('--lyrics-font', `${fontSize}px`);
    $('btnFontDown').disabled = fontSize <= MIN_FONT;
    $('btnFontUp').disabled = fontSize >= MAX_FONT;
    snapAnswerHeight();
  }

  function applyLock() {
    document.body.classList.toggle('locked', locked);
    const btn = $('btnLock');
    btn.classList.toggle('on', locked);
    const label = btn.querySelector('.label');
    if (label) label.textContent = locked ? '已锁' : '锁定';
    btn.title = locked ? '已锁定，点击解锁后可拖动与调整尺寸' : '锁定位置与尺寸，避免误拖';
  }

  function renderBalance(balance) {
    const info = balance || {};
    const led = $('balanceLed');
    if (led) {
      /* 连接灯优先用主窗下发的 tone（sync / offline / bad / warn），颜色与账号状态保持一致。 */
      const tone = info.tone === 'bad' || info.tone === 'warn' ? info.tone : (info.network || 'guest');
      led.className = `led ${tone}`;
    }
    const chip = $('balanceChip');
    if (chip) chip.title = info.title || '连接状态';
  }

  function renderAnswer(answer, streaming) {
    const body = $('answerBody');
    if (String(answer || '').trim()) {
      body.textContent = answer;
      return;
    }
    const label = streaming ? '…' : (state && state.listening ? '正在听…' : '待机');
    body.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'placeholder';
    span.textContent = label;
    body.appendChild(span);
  }

  /* 正文溢出时显示翻页按钮：歌词层主体是鼠标穿透的，滚轮进不来，
   * 用底部控制带上的两个短按钮保证长回答能回看前面内容。 */
  function updatePageButtons() {
    const answer = $('answer');
    const up = $('btnPageUp');
    const down = $('btnPageDown');
    if (!answer || !up || !down) return;
    const maxTop = answer.scrollHeight - answer.clientHeight;
    const overflow = maxTop > 2;
    up.classList.toggle('hidden', !overflow);
    down.classList.toggle('hidden', !overflow);
    up.disabled = !overflow || answer.scrollTop <= 1;
    down.disabled = !overflow || answer.scrollTop >= maxTop - 1;
  }

  function pageAnswer(direction) {
    const answer = $('answer');
    if (!answer) return;
    const step = Math.max(24, Math.round(answer.clientHeight * 0.85));
    answer.scrollTop = Math.max(0, Math.min(answer.scrollHeight, answer.scrollTop + direction * step));
    updatePageButtons();
  }

  /* 把回答区高度对齐到整行，避免滚动到顶部/底部时出现半行。 */
  function snapAnswerHeight() {
    const text = $('text');
    const answer = $('answer');
    const body = $('answerBody');
    const questionEl = $('question');
    if (!text || !answer) return;
    const style = getComputedStyle(answer);
    // 行高取整，配合整行高度，滚动到顶部/底部都不会切出半行。
    const line = Math.max(1, Math.round(parseFloat(style.lineHeight) || fontSize * 1.42));
    answer.style.lineHeight = `${line}px`;
    const questionVisible = getComputedStyle(questionEl).display !== 'none';
    const questionHeight = questionVisible ? questionEl.getBoundingClientRect().height : 0;
    const available = Math.max(0, text.clientHeight - questionHeight - (questionVisible ? TEXT_GAP : 0));
    const lines = Math.max(1, Math.floor((available + 0.01) / line));
    const maxHeight = lines * line;
    const scrollTop = answer.scrollTop;
    answer.style.height = 'auto';
    // 只量正文：外层元素里的缩进空白节点会把 scrollHeight 算大，滚到底会滚进空白。
    const contentHeight = body ? body.scrollHeight : answer.scrollHeight;
    answer.style.height = `${Math.min(contentHeight, maxHeight)}px`;
    // 一行都放不下时靠顶部对齐，保证文字仍在窗口内。
    text.classList.toggle('cramped', available < line);
    if (scrollTop > 0) {
      answer.scrollTop = Math.min(scrollTop, Math.max(0, answer.scrollHeight - answer.clientHeight));
    }
    updatePageButtons();
  }

  function scrollAnswerToBottom() {
    const answer = $('answer');
    answer.scrollTop = Math.max(0, answer.scrollHeight - answer.clientHeight);
  }

  function renderNav() {
    const total = questions.length;
    $('qLabel').textContent = activeIndex ? `Q${activeIndex}/${total}` : `Q—/${total}`;
    $('qLabel').title = total ? '查看全部题目' : '还没有题目';
    $('qPrev').disabled = !total || activeIndex <= 1;
    $('qNext').disabled = !total || (activeIndex >= total && activeIndex !== 0);
    if (listOpen) renderQList();
  }

  function renderQList() {
    const list = $('qList');
    list.innerHTML = '';
    if (!questions.length) {
      const empty = document.createElement('div');
      empty.className = 'qitem';
      empty.textContent = '还没有题目';
      list.appendChild(empty);
      return;
    }
    questions.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qitem' + (item.index === activeIndex ? ' active' : '');
      const idx = document.createElement('span');
      idx.className = 'qidx';
      idx.textContent = `Q${item.index}`;
      const text = document.createElement('span');
      text.className = 'qtext';
      text.textContent = item.text || '（无内容）';
      btn.appendChild(idx);
      btn.appendChild(text);
      btn.addEventListener('click', () => {
        api.miniAction({ type: 'goto-question', id: item.id });
        setListOpen(false);
      });
      list.appendChild(btn);
    });
  }

  function setListOpen(open) {
    listOpen = open;
    $('qList').classList.toggle('hidden', !open);
    $('qLabel').classList.toggle('open', open);
    api.overlayPopover(open);
    if (open) renderQList();
  }

  function applyState(next) {
    if (!next || next.type !== 'state') return;
    state = next;
    document.body.classList.toggle('light', next.theme !== 'dark');

    const dot = $('statusDot');
    const tone = next.status === 'error'
      ? 'err'
      : (next.status === 'streaming' || next.status === 'connecting'
        ? 'busy'
        : (next.status === 'listening' ? 'live' : ''));
    dot.className = `dot${tone ? ` ${tone}` : ''}`;
    $('statusText').textContent = STATUS_TEXT[next.status] || '待机';

    const listen = $('btnListen');
    listen.textContent = next.listening ? '停止' : (next.busy ? '连接中' : '开始');
    listen.classList.toggle('listening', Boolean(next.listening));
    listen.disabled = Boolean(next.busy);

    $('btnStop').classList.toggle('hidden', !next.streaming);
    $('btnCopy').disabled = !next.answer || !next.answer.trim();
    $('btnAuto').classList.toggle('on', Boolean(next.autoAnswer));
    $('autoLed').className = `led${next.autoAnswer ? ' online' : ''}`;
    $('btnProtect').classList.toggle('on', Boolean(next.protect));
    $('btnProtect').title = next.protect ? '防录屏已开启，点击关闭' : '开启防录屏隐身';

    renderBalance(next.balance);

    questions = Array.isArray(next.questions) ? next.questions : [];
    activeIndex = Math.max(0, Number(next.activeIndex) || 0);
    renderNav();

    const question = String(next.question || '').trim();
    const questionEl = $('question');
    if (question) {
      questionEl.textContent = question;
      questionEl.title = question;
      questionEl.classList.remove('empty');
    } else {
      questionEl.textContent = '';
      questionEl.removeAttribute('title');
      questionEl.classList.add('empty');
    }

    const answer = String(next.answer || '');
    const questionChanged = hasState && (question !== lastQuestion || next.answerId !== lastAnswerId);
    if (!hasState || questionChanged || answer !== lastAnswer) {
      renderAnswer(answer, Boolean(next.streaming));
      snapAnswerHeight();
      // 生成中始终跟随最新内容；回看已完成的旧回答时从开头显示。
      if (next.streaming) scrollAnswerToBottom();
      else if (questionChanged || !hasState) $('answer').scrollTop = 0;
    } else {
      snapAnswerHeight();
    }

    lastAnswer = answer;
    lastQuestion = question;
    lastAnswerId = next.answerId;
    hasState = true;
  }

  async function copyAnswer() {
    if (!state || !state.answer || !state.answer.trim()) return;
    let ok = false;
    try {
      await navigator.clipboard.writeText(state.answer);
      ok = true;
    } catch (err) {
      const area = document.createElement('textarea');
      area.value = state.answer;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      area.remove();
    }
    if (!ok) return;
    const btn = $('btnCopy');
    btn.classList.add('on');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => btn.classList.remove('on'), 900);
  }

  function changeFont(delta) {
    const next = clampFont(fontSize + delta);
    if (next === fontSize) return;
    fontSize = next;
    applyFont();
    if (state && state.streaming) scrollAnswerToBottom();
    api.overlayConfig({ fontSize });
  }

  async function toggleLock() {
    locked = !locked;
    applyLock();
    try {
      const result = await api.overlayConfig({ locked });
      if (!result || !result.ok) {
        locked = !locked;
        applyLock();
      }
    } catch (err) {
      locked = !locked;
      applyLock();
    }
  }

  $('btnMain').addEventListener('click', () => api.returnToMain());
  $('btnPanel').addEventListener('click', () => api.miniMode('panel'));
  $('btnListen').addEventListener('click', () => api.miniAction({ type: 'toggle-listen' }));
  $('btnStop').addEventListener('click', () => api.miniAction({ type: 'stop-answer' }));
  $('btnAuto').addEventListener('click', () => api.miniAction({ type: 'toggle-auto' }));
  $('btnProtect').addEventListener('click', () => api.miniAction({ type: 'toggle-protect' }));
  $('btnCopy').addEventListener('click', copyAnswer);
  $('btnLock').addEventListener('click', toggleLock);
  $('btnFontDown').addEventListener('click', () => changeFont(-FONT_STEP));
  $('btnFontUp').addEventListener('click', () => changeFont(FONT_STEP));
  $('btnPageUp').addEventListener('click', () => pageAnswer(-1));
  $('btnPageDown').addEventListener('click', () => pageAnswer(1));

  /* 控制带被唤出时窗口可交互，滚轮也交给正文；其余时间保持穿透不影响会议软件。 */
  $('answer').addEventListener('scroll', updatePageButtons);
  $('answer').addEventListener('wheel', (event) => {
    const answer = $('answer');
    if (answer.scrollHeight <= answer.clientHeight + 2) return;
    answer.scrollTop += event.deltaY;
    updatePageButtons();
    event.preventDefault();
  }, { passive: false });

  $('qPrev').addEventListener('click', () => api.miniAction({ type: 'prev-question' }));
  $('qNext').addEventListener('click', () => api.miniAction({ type: 'next-question' }));
  $('qLabel').addEventListener('click', () => setListOpen(!listOpen));
  document.addEventListener('pointerdown', (event) => {
    if (!listOpen) return;
    if (event.target.closest('#qList') || event.target.closest('#qLabel')) return;
    setListOpen(false);
  });

  /* 自定义拖动/调宽：pointerdown 明确进入 grab，pointerup/失焦/失去捕获都算结束。
   * 主进程在 grab 期间暂停光标轮询，不会再把窗口切回穿透。 */
  const topBar = $('topBar');
  const edge = $('resizeEdge');
  let session = null;
  let moveFrame = 0;

  function scheduleMove(fn) {
    if (moveFrame) return;
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      fn();
    });
  }

  function beginSession(mode, event, origin) {
    if (session || locked || event.button !== 0) return false;
    if (mode === 'move' && event.target.closest('button, input, .qlist')) return false;
    session = { mode, ...origin };
    document.body.classList.add('dragging');
    api.overlayGrab(true);
    event.preventDefault();
    return true;
  }

  function endSession() {
    if (!session) return;
    session = null;
    if (moveFrame) {
      cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    document.body.classList.remove('dragging');
    api.overlayGrab(false);
  }

  topBar.addEventListener('pointerdown', (event) => {
    if (!beginSession('move', event, {
      x: event.screenX, y: event.screenY, wx: window.screenX, wy: window.screenY,
    })) return;
    try { topBar.setPointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
  });
  edge.addEventListener('pointerdown', (event) => {
    if (!beginSession('resize', event, { x: event.screenX, width: window.innerWidth })) return;
    try { edge.setPointerCapture(event.pointerId); } catch (err) { /* 忽略 */ }
  });

  window.addEventListener('pointermove', (event) => {
    if (!session) return;
    if (session.mode === 'move') {
      const x = session.wx + Math.round(event.screenX - session.x);
      const y = session.wy + Math.round(event.screenY - session.y);
      scheduleMove(() => api.overlayMove({ x, y }));
    } else {
      const width = session.width + Math.round(event.screenX - session.x);
      scheduleMove(() => api.overlayResize(width));
    }
  });
  window.addEventListener('pointerup', endSession);
  window.addEventListener('pointercancel', endSession);
  window.addEventListener('blur', endSession);
  topBar.addEventListener('lostpointercapture', endSession);
  edge.addEventListener('lostpointercapture', endSession);

  api.onOverlayHover((data) => {
    document.body.classList.toggle('inside', Boolean(data && data.inside));
    document.body.classList.toggle('reveal', Boolean(data && data.reveal));
  });

  async function loadPrefs() {
    let cfg = null;
    try { cfg = await api.getConfig(); } catch (err) { /* 用默认值 */ }
    const prefs = (cfg && cfg.window && cfg.window.lyrics) || {};
    fontSize = clampFont(Number(prefs.fontSize) || 24);
    locked = Boolean(prefs.locked);
    applyFont();
    applyLock();
    if (cfg && cfg.ui) document.body.classList.toggle('light', cfg.ui.theme !== 'dark');
  }

  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => snapAnswerHeight());
    observer.observe($('layer'));
  }

  applyFont();
  applyLock();
  loadPrefs();
  api.onMiniEvent(applyState);
  api.miniReady();
})();

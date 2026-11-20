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

  let state = null;
  let hasState = false;
  let lastAnswerId = null;
  let lastQuestion = '';
  let lastAnswer = '';
  let followAnswer = true;
  let copyTimer = null;

  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  function renderBalance(balance) {
    const chip = $('balanceChip');
    const text = $('balanceText');
    const led = $('balanceLed');
    const info = balance || {};
    if (text) text.textContent = info.text || '';
    if (chip) chip.className = `mini-chip balance${info.tone ? ` ${info.tone}` : ''}`;
    if (led) led.className = `led ${info.network || 'guest'}`;
    if (chip) chip.title = info.title || '连接状态';
  }

  function renderAnswer(answerEl, answer, streaming) {
    if (answer.trim()) {
      answerEl.textContent = answer;
      answerEl.classList.remove('empty');
      return;
    }
    answerEl.classList.add('empty');
    answerEl.innerHTML = '<span class="empty"></span>';
    answerEl.querySelector('.empty').textContent = streaming ? '生成中…' : '识别到问题后自动生成回答';
  }

  function applyState(next) {
    if (!next || next.type !== 'state') return;
    state = next;
    document.body.classList.toggle('light', next.theme !== 'dark');

    const dot = $('statusDot');
    const dotTone = next.status === 'error'
      ? 'err'
      : (next.status === 'streaming' || next.status === 'connecting'
        ? 'busy'
        : (next.status === 'listening' ? 'live' : ''));
    dot.className = `dot${dotTone ? ` ${dotTone}` : ''}`;
    $('statusText').textContent = STATUS_TEXT[next.status] || '待机';

    const listen = $('btnListen');
    listen.textContent = next.listening ? '停止收音' : (next.busy ? '连接中' : '开始收音');
    listen.classList.toggle('listening', Boolean(next.listening));
    listen.disabled = Boolean(next.busy);

    $('btnStop').classList.toggle('hidden', !next.streaming);

    const copy = $('btnCopy');
    copy.disabled = !next.answer || !next.answer.trim();

    renderBalance(next.balance);

    $('sourceText').textContent = next.source === 'mic' ? '麦克风' : '电脑';
    $('btnSource').classList.toggle('mic', next.source === 'mic');

    $('btnAuto').classList.toggle('on', Boolean(next.autoAnswer));
    $('autoLed').className = `led${next.autoAnswer ? ' online' : ''}`;

    $('btnProtect').classList.toggle('on', Boolean(next.protect));

    const questionEl = $('question');
    const question = next.question || '';
    if (question) {
      if (question !== lastQuestion) {
        questionEl.textContent = question;
        questionEl.classList.remove('empty');
        questionEl.scrollTop = 0;
      }
    } else {
      questionEl.textContent = '等待面试官提问';
      questionEl.classList.add('empty');
    }

    const answerEl = $('answer');
    const answer = String(next.answer || '');
    const questionChanged = hasState && (question !== lastQuestion || next.answerId !== lastAnswerId);
    const freshQuestion = !hasState || questionChanged;
    const answerChanged = !hasState || answer !== lastAnswer;

    if (freshQuestion) followAnswer = Boolean(next.streaming);

    if (answerChanged || questionChanged) {
      renderAnswer(answerEl, answer, Boolean(next.streaming));
      if (freshQuestion && !next.streaming) answerEl.scrollTop = 0;
      else if (followAnswer || !hasState) answerEl.scrollTop = answerEl.scrollHeight;
    } else if (!answer.trim()) {
      const empty = answerEl.querySelector('.empty');
      const label = next.streaming ? '生成中…' : '识别到问题后自动生成回答';
      if (empty && empty.textContent !== label) empty.textContent = label;
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
    btn.classList.add('copied');
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => btn.classList.remove('copied'), 900);
  }

  $('btnMain').addEventListener('click', () => api.returnToMain());
  $('btnLyrics').addEventListener('click', () => api.miniMode('lyrics'));
  $('answer').addEventListener('scroll', () => {
    followAnswer = nearBottom($('answer'));
  });
  $('btnListen').addEventListener('click', () => api.miniAction({ type: 'toggle-listen' }));
  $('btnStop').addEventListener('click', () => api.miniAction({ type: 'stop-answer' }));
  $('btnAuto').addEventListener('click', () => api.miniAction({ type: 'toggle-auto' }));
  $('btnProtect').addEventListener('click', () => api.miniAction({ type: 'toggle-protect' }));
  $('btnSource').addEventListener('click', () => api.miniAction({ type: 'toggle-source' }));
  $('btnCopy').addEventListener('click', copyAnswer);

  api.onMiniEvent(applyState);
  api.miniReady();
})();

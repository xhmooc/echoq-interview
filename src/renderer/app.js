/* 界面编排：收音 → 转写 → 判断问题 → 流式生成回答。 */
(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.api;

  let cfg = null;
  let audio = null;
  let entries = [];
  /* entries 只保留最近 40 条给界面用；导出要完整会话，所以单独留一份不裁剪的日志。 */
  let sessionLog = [];
  let questions = [];
  let activeQid = null;
  let queueCount = 0;
  let queue = Promise.resolve();
  /* 清屏世代号：清屏时 +1，清屏前入队的识别结果回来时对不上就丢弃，避免旧内容回填。 */
  let transcriptGen = 0;
  let seq = 0;
  let currentAnswer = '';
  let currentQuestion = '';
  let renderScheduled = false;
  let editingQid = null;

  let assets = null;
  let asrState = null;
  let downloadingId = null;
  let selectedTier = '';
  let noticeHandler = null;

  let authState = null;
  let authGateOpen = false;
  let entered = false;
  let hotwordRemoteLoaded = false;
  let authTimerStarted = false;
  let confirmResolve = null;
  let registerArmed = false;
  let authSyncing = false;
  let cloud = null;
  let announceDismissed = '';
  let appVersion = '';
  let pendingUpdate = null;
  let updateDownloading = false;
  let updateAutoChecked = false;
  let listeningBusy = false;
  let askInFlight = null;
  let miniOpen = false;
  let miniSyncTimer = null;

  /* 笔试模式：截图结果只留在内存里，退出应用即清空；历史最多 20 条。 */
  let appMode = 'interview';
  let writtenBusy = false;
  let writtenItems = [];
  let writtenActive = null;
  let writtenActiveIndex = -1;
  let writtenEditOpen = false;
  let phoneInfo = null;
  /* 崩溃自动重载后从 sessionStorage 恢复现场；只保留当前窗口会话，不跨应用重启。 */
  const SNAPSHOT_KEY = 'interview-copilot:session';
  /* 自动作答排队超过这个时间就不再占用队列，让后面的新题先答。 */
  const ASK_QUEUE_TTL_MS = 25000;
  let snapshotTimer = null;

  const transcriptEl = $('transcript');
  const answerEl = $('answer');
  const answerMeta = $('answerMeta');
  const asrMeta = $('asrMeta');
  const statusDot = $('statusDot');
  const statusText = $('statusText');
  const levelBar = $('levelBar');
  const btnListen = $('btnListen');

  const QUESTION_WORDS = /[？?]|吗|呢|什么|如何|怎么|为什么|为何|哪个|哪些|是否|能不能|可不可以|有没有|多少|多久|介绍|说说|讲讲|讲一下|谈谈|聊聊|说一下|问一下|解释|分析|描述|举例|区别|差异|看法|理解|你觉得|你认为|你怎么|你会|请你|手写|遇到过|缺点|优点|优势|劣势|规划|期望/;

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' err' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => el.classList.add('hidden'), 4200);
  }

  function formatBytes(bytes) {
    if (!bytes) return '';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
  }

  function isQuestion(text) {
    const t = text.trim();
    if (t.length < 4) return false;
    // 长句只取最后一个分句判断，但不能因为超长就整句判否——那样用户会看到整句消失。
    const tail = t.length > 260 ? (t.split(/[。！!；;\n]/).filter(Boolean).pop() || t) : t;
    if (/[？?]/.test(tail)) return true;
    const probe = tail.length > 300 ? tail.slice(-160) : tail;
    return QUESTION_WORDS.test(probe);
  }

  /* 转写文本里的同音错字会让同一道题重复出现，按相似度合并。
   * 但字符重合度对 4~10 字的短问句太粗（「这个怎么实现」和「那个怎么实现」会算成 0.83），
   * 所以短问句只认规范化后完全一致；长句用「重合度 × 长度比」。
   * 保守原则：宁可多留一题，也不把两个不同问题并成一题。 */
  function similarity(a, b) {
    const clean = (value) => value.replace(/[\s，。、？！?,.!：:；;]/g, '');
    const soften = (value) => value.replace(/[啊呢吧呀哦嘛哈]+$/, '');
    const x = clean(a);
    const y = clean(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (soften(x) === soften(y)) return 1;
    if (Math.min(x.length, y.length) <= 10) return 0;
    if (x.includes(y) || y.includes(x)) return 0.95;
    const left = new Set(x);
    const right = new Set(y);
    let shared = 0;
    for (const char of left) if (right.has(char)) shared += 1;
    const overlap = shared / Math.max(left.size, right.size);
    const lenRatio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
    return overlap * lenRatio;
  }

  function updateAsrMeta() {
    if (!cfg) return;
    const mode = cfg.asr.provider === 'llama'
      ? '本地 ASR'
      : (cfg.asr.provider === 'own' ? '自定义 ASR' : '云端 ASR');
    asrMeta.textContent = queueCount > 0 ? `${mode} · 识别中 ${queueCount}` : mode;
    syncTranscriptEmpty();
  }

  /* 空态文案跟随收音状态，收音中不再提示去点一个已经变成「停止收音」的按钮。 */
  function transcriptEmptyText() {
    if (!audio || !audio.listening) return '点「开始听面试官」，面试官说话会实时转成文字。';
    return queueCount > 0 ? '识别中…' : '正在听，等待面试官说话…';
  }

  function syncTranscriptEmpty() {
    const placeholder = transcriptEl.querySelector('.empty');
    if (placeholder) placeholder.textContent = transcriptEmptyText();
  }

  /* 没有任何题目/回答时，重新生成、复制、清空都没有意义，直接禁用。 */
  function syncAnswerTools() {
    const hasQuestion = questions.length > 0;
    const hasAnswer = Boolean(String(currentAnswer || '').trim());
    const regen = $('btnRegen');
    if (regen) regen.disabled = !hasQuestion;
    const copy = $('btnCopy');
    if (copy) copy.disabled = !hasAnswer;
    const clear = $('btnClear');
    if (clear) clear.disabled = !hasQuestion && !entries.length;
    const exportBtn = $('btnExport');
    if (exportBtn) exportBtn.disabled = !hasQuestion && !sessionLog.length;
  }

  function setDot(state, text) {
    statusDot.className = 'dot' + (state ? ` ${state}` : '');
    if (text) statusText.textContent = text;
  }

  function scrollBottom(el) {
    el.scrollTop = el.scrollHeight;
  }

  /* 用户往上翻看历史时不抢滚动，只有原本就在底部才跟随最新。 */
  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  /* 生产环境没有 DevTools，诊断统一落到主进程日志（logs/app.log），
   * 用户点设置里的「打开日志」就能导出来。 */
  function logDiag(kind, data) {
    try {
      const line = `${kind} ${JSON.stringify(data)}`;
      if (api && typeof api.diag === 'function') {
        const result = api.diag(line);
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } else {
        console.log(line);
      }
    } catch (err) {
      // 诊断失败不能影响识别
    }
  }

  /* ASR 返回的是整段文本，连读时一段里可能挤了三四道题。
   * 按句末标点二次切句：一条记录=一句，一个题目=一句。 */
  function splitSentences(text) {
    const raw = String(text || '').trim();
    if (!raw) return [];
    const parts = raw
      .replace(/\r/g, '\n')
      .split(/(?<=[。！？!?；;])|\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
    if (parts.length <= 1) return [raw];
    const merged = [];
    for (const part of parts) {
      const core = part.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '');
      // 太短的碎片（「嗯」「对」）并回上一句，避免单独成条、成题
      if (core.length < 4 && merged.length) merged[merged.length - 1] += part;
      else merged.push(part);
    }
    return merged.length ? merged : [raw];
  }

  /* 段被切开时，一句话可能被拆到两段里。
   * 后半段还没到的半句先挂住，等下一段的开头接上，绝不当成独立题先作答。 */
  let pendingTail = null;

  function isUnfinishedTail(text, meta) {
    const core = String(text || '').replace(/\s/g, '');
    if (core.length < 8) return false;
    if (/[。！？!?；;]$/.test(core)) return false;
    if (/[，,、：:]$/.test(core)) return true;
    if (meta && meta.trigger === 'max') return true;
    return /(的|和|与|跟|把|被|在|是|对|给|但|而|于|就|还|更|并|因为|所以|如果|就是|还是|或者|以及|然后|而且)$/.test(core);
  }

  function submitHeld(text) {
    if (!isQuestion(text)) return;
    if (mergeFollowUp(text)) return;
    const item = registerQuestion(enrichQuestion(text));
    // 有回答正在生成时不要抢焦点，否则用户会看到答案跳到别的题下面
    if (item && !askInFlight && !item.answer) selectQuestion(item.id);
    if (item && cfg && cfg.audio && cfg.audio.auto_answer) enqueueAsk(item);
  }

  function flushPendingTail() {
    const held = pendingTail;
    if (!held) return;
    pendingTail = null;
    if (held.timer) clearTimeout(held.timer);
    submitHeld(held.text);
  }

  function holdSentence(text, ttlMs) {
    flushPendingTail();
    const view = renderTranscriptLine(text);
    const ttl = Math.max(10000, Number(ttlMs) || 0);
    const held = { text, at: Date.now(), ttl, line: view.line, entry: view.entry, timer: null };
    // 一直等不到后半段（沉默、停播）就按独立句子补判，不能把这段文本吞掉
    held.timer = setTimeout(() => {
      if (pendingTail !== held) return;
      pendingTail = null;
      submitHeld(held.text);
    }, ttl);
    pendingTail = held;
  }

  function appendTranscript(text, meta) {
    const sentences = splitSentences(text);
    if (!sentences.length) return;
    const placeholder = transcriptEl.querySelector('.empty');
    if (placeholder) placeholder.remove();

    if (pendingTail) {
      const held = pendingTail;
      pendingTail = null;
      if (held.timer) clearTimeout(held.timer);
      if (Date.now() - held.at <= held.ttl) {
        // 接上：合并成一句再判题，半句不会单独成题
        const idx = entries.indexOf(held.entry);
        if (idx >= 0) entries.splice(idx, 1);
        if (held.line && held.line.parentNode) held.line.remove();
        sentences[0] = `${held.text}${sentences[0]}`;
      } else {
        submitHeld(held.text);
      }
    }

    const asked = [];
    for (let i = 0; i < sentences.length; i += 1) {
      const sentence = sentences[i];
      if (i === sentences.length - 1 && isUnfinishedTail(sentence, meta)) {
        // 长上限切出来的半句，要等到下一段（约一个 max 周期）才算过期
        const maxMs = ((cfg && cfg.audio && cfg.audio.max_segment_s) || 14) * 1000;
        holdSentence(sentence, meta && meta.trigger === 'max' ? maxMs + 4000 : 0);
        continue;
      }
      const item = appendTranscriptLine(sentence);
      if (item) asked.push(item);
    }
    // 自动模式：这一段里的每道题都要有回答，但串行发，避免四路并发打爆模型
    if (cfg && cfg.audio && cfg.audio.auto_answer) {
      asked.forEach((item) => enqueueAsk(item));
    }
  }

  function paintTranscriptLine(text, time) {
    const line = document.createElement('div');
    line.className = 'line clickable';
    line.dataset.text = text;
    line.title = '点击用这段内容作答';
    line.innerHTML = `<span class="time">${escapeHtml(time)}</span><span class="line-text">${escapeHtml(text)}</span>`;
    const askBtn = document.createElement('button');
    askBtn.type = 'button';
    askBtn.className = 'line-ask';
    askBtn.textContent = '作答';
    line.appendChild(askBtn);
    transcriptEl.appendChild(line);
    return line;
  }

  function renderTranscriptLine(text) {
    const now = new Date();
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    const stick = nearBottom(transcriptEl);
    const line = paintTranscriptLine(text, time);

    const entry = { time, text, at: Date.now() };
    entries.push(entry);
    sessionLog.push(entry);
    if (entries.length > 40) {
      entries.shift();
      const first = transcriptEl.querySelector('.line');
      if (first) first.remove();
    }
    if (stick) scrollBottom(transcriptEl);
    scheduleSnapshot();
    syncAnswerTools();
    return { line, entry };
  }

  /* 崩溃重载时恢复题目和答案：只写 sessionStorage，正常关窗即清空。 */
  function saveSnapshot() {
    snapshotTimer = null;
    if (!questions.length && !entries.length) return;
    try {
      sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        at: Date.now(),
        seq,
        activeQid,
        entries: entries.map((entry) => ({ time: entry.time, text: entry.text, at: entry.at })),
        questions: questions.map((item) => ({
          id: item.id,
          text: item.text,
          answer: item.answer,
          status: item.status === 'streaming' ? 'pending' : item.status,
          time: item.time,
          created: item.created,
        })),
      }));
    } catch (err) {
      // 存储满了或隐私模式禁用时不影响使用
    }
  }

  function scheduleSnapshot() {
    if (snapshotTimer) return;
    snapshotTimer = setTimeout(saveSnapshot, 1500);
  }

  function restoreSnapshot() {
    if (!(cfg && cfg.setup && cfg.setup.done)) return false;
    let data = null;
    try {
      const raw = sessionStorage.getItem(SNAPSHOT_KEY);
      data = raw ? JSON.parse(raw) : null;
    } catch (err) {
      return false;
    }
    if (!data || !Array.isArray(data.questions) || !data.questions.length) return false;

    questions = data.questions.map((item) => ({
      id: Number(item.id) || 0,
      text: String(item.text || '').trim(),
      answer: String(item.answer || ''),
      status: ['pending', 'done', 'error', 'skipped'].includes(item.status) ? item.status : 'pending',
      time: String(item.time || ''),
      created: Number(item.created) || Date.now(),
    })).filter((item) => item.text);
    if (!questions.length) return false;

    seq = Math.max(seq, ...questions.map((item) => item.id));
    entries = (Array.isArray(data.entries) ? data.entries : [])
      .slice(-40)
      .map((entry) => ({
        time: String(entry.time || ''),
        text: String(entry.text || ''),
        at: Number(entry.at) || Date.now(),
      }))
      .filter((entry) => entry.text);
    sessionLog = entries.slice();

    transcriptEl.innerHTML = '';
    entries.forEach((entry) => paintTranscriptLine(entry.text, entry.time));
    syncTranscriptEmpty();

    const wanted = Number(data.activeQid);
    activeQid = questions.some((item) => item.id === wanted) ? wanted : questions[questions.length - 1].id;
    const item = questions.find((q) => q.id === activeQid);
    currentQuestion = item.text;
    currentAnswer = item.answer || '';
    renderRail();
    renderQhead();
    if (currentAnswer.trim()) renderAnswer(currentAnswer);
    else answerEl.innerHTML = '<div class="empty">这道题还没生成回答，点「重新生成」或直接点一条转写作答。</div>';
    answerMeta.textContent = item.status === 'done' ? '已完成'
      : item.status === 'skipped' ? '已跳过 · 点「重新生成」'
        : item.status === 'error' ? '失败' : '未生成';
    syncAnswerTools();
    toast('已恢复上次的题目和回答');
    return true;
  }

  /* 纯语气词（嗯/哦/啊…）不单独占一行，也不进入转写、导出和判题。
   * 只过滤去掉标点后不超过 4 个字、且全部由语气词组成的短句，
   * “有的”“有。”“嗯，我们开始吧”这类正常内容不受影响。 */
  const FILLER_RE = /^(?:嗯|哦|啊|呃|额|唔|唉|哎|哈|嘿|喔|噢|呀|呐|呵|嗯哼|um|uh|emm)+$/i;
  function isFillerOnly(text) {
    const core = String(text || '')
      .replace(/[\s\u3000，。！？、,.!?~～…—–\-"'“”‘’（）()【】\[\]]/g, '');
    if (!core) return true;
    if (core.length > 4) return false;
    return FILLER_RE.test(core);
  }

  function appendTranscriptLine(text) {
    if (isFillerOnly(text)) return null;
    renderTranscriptLine(text);
    if (isQuestion(text)) {
      // 残句/指代短问句先并回上一道题，避免题目栏出现「为什么？」这种孤题
      if (mergeFollowUp(text)) return null;
      const questionText = enrichQuestion(text);
      const item = registerQuestion(questionText);
      // 有回答正在生成时不要抢焦点，否则用户会看到答案跳到别的题下面
      if (item && !askInFlight && !item.answer) selectQuestion(item.id);
      return item;
    }
    if (!currentQuestion) {
      currentQuestion = text;
      pushMiniState();
    }
    return null;
  }

  /* 会走云端识别才需要压缩：WAV 一分钟约 2MB，服务器带宽扛不住，转成 24kbps Opus。
   * 本机就绪时不编码；编码失败也照旧传 WAV，不能因为压缩卡住识别。 */
  async function buildSegmentPayload(wav) {
    const payload = { wav };
    const localReady = Boolean(asrState && asrState.available);
    /* 自带转写服务按 WAV 上传，不需要 Opus 压缩。 */
    const useCloud = cfg && cfg.asr && cfg.asr.provider !== 'own'
      && (cfg.asr.provider === 'cloud' || !localReady);
    if (!useCloud || !window.InterviewOpus) return payload;
    try {
      const opus = await window.InterviewOpus.encodeWav(wav, 24000);
      if (opus && opus.byteLength) payload.opus = opus;
    } catch (err) {
      // 编码不可用时静默退回 WAV
    }
    return payload;
  }

  function handleSegment(wav, seconds, meta) {
    queueCount += 1;
    updateAsrMeta();
    const enqueuedAt = Date.now();
    const gen = transcriptGen;

    const line = document.createElement('div');
    line.className = 'line pending';
    line.textContent = `识别中…（${seconds.toFixed(1)}s）`;
    const placeholder = transcriptEl.querySelector('.empty');
    if (placeholder) placeholder.remove();
    const stick = nearBottom(transcriptEl);
    transcriptEl.appendChild(line);
    if (stick) scrollBottom(transcriptEl);

    queue = queue.then(async () => {
      const startedAt = Date.now();
      let encodeDone = startedAt;
      let asrDone = startedAt;
      const base = () => ({
        seg: meta && meta.seq,
        trigger: meta && meta.trigger,
        audioSec: +Number(seconds).toFixed(2),
        queueWaitMs: startedAt - enqueuedAt,
        encodeMs: encodeDone - startedAt,
        asrMs: asrDone - encodeDone,
        totalMs: Date.now() - enqueuedAt,
      });
      try {
        const payload = await buildSegmentPayload(wav);
        encodeDone = Date.now();
        const text = await api.transcribe(payload);
        asrDone = Date.now();
        line.remove();
        if (gen !== transcriptGen) return;
        if (text && text.trim()) {
          const clean = text.trim();
          const pieces = splitSentences(clean);
          appendTranscript(clean, meta);
          logDiag('ASR', {
            ...base(),
            chars: clean.length,
            sentences: pieces.length,
            questions: pieces.filter((item) => isQuestion(item)).length,
            text: clean.slice(0, 300),
          });
        } else {
          const empty = document.createElement('div');
          empty.className = 'line pending';
          empty.textContent = '（这一段没听清）';
          transcriptEl.appendChild(empty);
          logDiag('ASR', { ...base(), chars: 0, empty: true });
        }
      } catch (err) {
        line.remove();
        if (gen !== transcriptGen) return;
        const msg = err.message || '识别失败';
        logDiag('ASR', { ...base(), error: msg });
        if (/登录已失效|时长不足/.test(msg)) openAuthGate();
        toast(msg, true);
        setDot('err', '识别失败');
      } finally {
        queueCount = Math.max(0, queueCount - 1);
        updateAsrMeta();
      }
    });
  }

  /* 语音识别常把一句问题切成两段，短问句补上前半句再作答。 */
  function enrichQuestion(text) {
    const prev = entries.length >= 2 ? entries[entries.length - 2] : null;
    if (!prev || prev.text === text) return text;
    if (isQuestion(prev.text)) return text;
    if (Date.now() - prev.at > 8000) return text;
    if (text.length > 16) return text;
    return `${prev.text}，${text}`;
  }

  /* 追问残句：整体只有「为什么」「然后呢」这类追问词，离开上一句就没有主语。 */
  const FOLLOW_UP_CORE = /^(为什么|为啥|然后呢?|接着呢?|还有呢?|继续|具体(呢|点|一点|说说)?|展开(说说)?|举个例子|举例|怎么说|所以呢?)$/;
  /* 指代型短问句：开头是代词，靠上一句才能知道问的是什么。 */
  const REFERENCE_HEAD = /^(这|那|它|他|她|该|此|其|上述|上面|刚才|前面)/;

  /* 上一句是问题、当前是残句/指代短问句时，并回上一道题，而不是新开一个孤零零的「为什么？」。
   * 只处理 8 秒内、紧跟其后的情况；判不准的一律不合并，宁可多一题也不要答错题。 */
  function mergeFollowUp(text) {
    const core = String(text || '').replace(/[\s，。、？！?,.!：:；;]/g, '');
    if (!core) return '';
    const prev = entries.length >= 2 ? entries[entries.length - 2] : null;
    if (!prev || !isQuestion(prev.text)) return '';
    const item = questions[questions.length - 1];
    if (!item || Date.now() - item.created > 8000) return '';
    const followUp = FOLLOW_UP_CORE.test(core);
    const referential = core.length <= 8 && REFERENCE_HEAD.test(core);
    if (!followUp && !referential) return '';
    if (item.text.includes(core)) return '';
    item.text = `${item.text}${/[？?！!。；;]$/.test(item.text) ? '' : '，'}${text}`;
    renderQhead();
    renderRail();
    if (cfg && cfg.audio && cfg.audio.auto_answer) {
      // 已经答过的是追问，重答一次；还没答过的正常排队
      if (item.answer) enqueueAsk(item, true);
      else enqueueAsk(item);
    }
    return item.text;
  }

  function nowTime() {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  }

  function createQuestion(text) {
    const item = { id: ++seq, text, answer: '', status: 'pending', time: nowTime(), created: Date.now() };
    questions.push(item);
    // 长面试不再无限增长：只保留最近 50 题，避免重绘越来越慢。
    if (questions.length > 50) {
      const removed = questions.shift();
      if (activeQid === removed.id) activeQid = null;
    }
    return item;
  }

  function registerQuestion(text) {
    const value = String(text || '').trim();
    if (!isQuestion(value)) return null;
    const last = questions[questions.length - 1];
    if (last && Date.now() - last.created < 25000 && similarity(last.text, value) >= 0.82) {
      if (value.length > last.text.length) last.text = value;
      renderQhead();
      renderRail();
      return last;
    }
    const item = createQuestion(value);
    renderRail();
    return item;
  }

  function statusDotClass(status) {
    if (status === 'done') return 'ok';
    if (status === 'streaming') return 'stream';
    if (status === 'error' || status === 'skipped') return 'err';
    return '';
  }

  function renderRail() {
    const list = $('qrailList');
    if (!list) return;
    if (appMode === 'written') {
      renderWrittenRail(list);
      return;
    }
    if (!questions.length) {
      list.innerHTML = '<div class="qrail-empty">Q</div>';
      syncQrailFade();
      return;
    }
    list.innerHTML = '';
    questions.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qchip' + (item.id === activeQid ? ' active' : '');
      btn.dataset.qid = String(item.id);
      btn.title = item.status === 'skipped' ? `已跳过，点开后可重新生成：${item.text}` : item.text;
      const label = document.createElement('span');
      label.className = 'qchip-label';
      label.textContent = `Q${index + 1}`;
      const brief = document.createElement('span');
      brief.className = 'qchip-brief';
      brief.textContent = item.status === 'skipped' ? `待重答 · ${item.text}` : item.text;
      btn.appendChild(label);
      btn.appendChild(brief);
      const dot = document.createElement('span');
      dot.className = `qdot ${statusDotClass(item.status)}`;
      btn.appendChild(dot);
      list.appendChild(btn);
    });
    scrollRailToActive(list);
    syncQrailFade();
    scheduleSnapshot();
    pushMiniState();
  }

  /* 笔试模式的题目栏：每次截图算一道题，Q1、Q2… 最新的一条在最上面。
   * 截图本身只留 120px 宽的缩略图，和面试模式的题号卡是同一套视觉，切换模式不会像换了个软件。 */
  function renderWrittenRail(list) {
    if (!writtenItems.length) {
      list.innerHTML = '<div class="qrail-empty">Q</div>';
      syncQrailFade();
      return;
    }
    list.innerHTML = '';
    writtenItems.forEach((item, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qchip written' + (writtenActive && index === writtenActiveIndex ? ' active' : '');
      btn.dataset.windex = String(index);
      btn.title = item.no ? `第 ${item.no} 题 · ${item.text || '（无文字）'}` : item.text || '（无文字）';
      if (item.thumb) {
        const thumb = document.createElement('span');
        thumb.className = 'qchip-thumb';
        const img = document.createElement('img');
        img.src = item.thumb;
        img.alt = '';
        thumb.appendChild(img);
        btn.appendChild(thumb);
      }
      const label = document.createElement('span');
      label.className = 'qchip-label';
      label.textContent = item.no || `Q${writtenItems.length - index}`;
      const brief = document.createElement('span');
      brief.className = 'qchip-brief';
      brief.textContent = String(item.text || '（无文字）').replace(/\s+/g, ' ').trim();
      btn.appendChild(label);
      btn.appendChild(brief);
      list.appendChild(btn);
    });
    scrollRailToActive(list);
    syncQrailFade();
  }

  /* 把 1:1 截图缩成题目栏里的小图；存 480px 宽，降到卡片大小时仍然清楚。 */
  function makeThumb(dataUrl, maxWidth) {
    return new Promise((resolve) => {
      if (!dataUrl) return resolve('');
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, (maxWidth || 480) / img.naturalWidth);
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.86));
        } catch (err) {
          resolve('');
        }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    });
  }

  /* 当前题要完整露在底部头像上方。 */
  function scrollRailToActive(list) {
    const current = list.querySelector('.qchip.active');
    if (!current) return;
    const listRect = list.getBoundingClientRect();
    const chipRect = current.getBoundingClientRect();
    const reserve = 52;
    const safeBottom = listRect.bottom - reserve;
    if (chipRect.bottom > safeBottom) {
      list.scrollTop += chipRect.bottom - safeBottom;
    } else if (chipRect.top < listRect.top + 4) {
      list.scrollTop -= (listRect.top + 4) - chipRect.top;
    }
  }

  /* 题目栏可滚动时，只在被截断的一侧显示渐隐遮罩；没有溢出就完全不显示。 */
  function syncQrailFade() {
    const body = $('qrailBody');
    const list = $('qrailList');
    if (!body || !list) return;
    const scrollable = list.scrollHeight > list.clientHeight + 1;
    const atTop = list.scrollTop <= 1;
    const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    body.classList.toggle('fade-top', scrollable && !atTop);
    body.classList.toggle('fade-bottom', scrollable && !atBottom);
  }

  /* 题目栏里的截图缩略图只有指甲盖大，鼠标悬停时在左侧放大预览，能看清截的是什么。 */
  function positionRailPreview(chip) {
    const box = $('railPreview');
    if (!box) return;
    const chipRect = chip.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    box.style.left = `${Math.max(8, chipRect.left - boxRect.width - 8)}px`;
    box.style.top = `${Math.min(Math.max(8, chipRect.top), window.innerHeight - boxRect.height - 8)}px`;
  }

  function showRailPreview(event) {
    const chip = event.target.closest('.qchip.written');
    const box = $('railPreview');
    if (!chip || !box) return;
    const item = writtenItems[Number(chip.dataset.windex)];
    if (!item || !item.thumb) return;
    const img = $('railPreviewImg');
    if (img.getAttribute('src') !== item.thumb) img.src = item.thumb;
    box.classList.remove('hidden');
    positionRailPreview(chip);
  }

  function hideRailPreview() {
    const box = $('railPreview');
    if (box) box.classList.add('hidden');
  }

  /* ---------- 可拖动分栏 ---------- */
  const RAIL_MIN = 64;
  const RAIL_MAX = 320;
  const TRANSCRIPT_MIN = 90;
  const DEFAULT_RAIL = 76;
  const DEFAULT_TRANSCRIPT = 148;

  /* 启动时恢复上次拖出来的尺寸；没存过就用样式里的默认值。 */
  function applyPanelSizes() {
    const railEl = document.querySelector('.qrail');
    const transcript = document.querySelector('.transcript-panel');
    const rail = Number(cfg && cfg.ui && cfg.ui.rail_width);
    const height = Number(cfg && cfg.ui && cfg.ui.transcript_h);
    if (railEl && rail >= RAIL_MIN) railEl.style.flexBasis = `${Math.min(RAIL_MAX, rail)}px`;
    if (transcript && height >= TRANSCRIPT_MIN) transcript.style.flexBasis = `${height}px`;
  }

  async function savePanelSize(key, value) {
    if (!cfg) return;
    const patch = { ui: {} };
    patch.ui[key] = Math.round(value);
    try {
      cfg = await api.saveConfig(patch);
    } catch (err) {
      // 尺寸记不住只影响下次启动，不影响这次拖动
    }
  }

  function bindSplitters() {
    const railEl = document.querySelector('.qrail');
    const railBar = $('splitRail');
    const transcript = document.querySelector('.transcript-panel');
    const transBar = $('splitTranscript');

    const drag = (bar, cursor, begin, apply, done) => {
      let session = null;
      bar.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        bar.setPointerCapture(event.pointerId);
        session = begin(event);
        document.body.classList.add('resizing');
        document.body.style.cursor = cursor;
      });
      bar.addEventListener('pointermove', (event) => {
        if (session) apply(session, event);
      });
      const finish = (event) => {
        if (!session) return;
        session = null;
        document.body.classList.remove('resizing');
        document.body.style.cursor = '';
        if (event && bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
        done();
      };
      bar.addEventListener('pointerup', finish);
      bar.addEventListener('pointercancel', finish);
    };

    if (railBar && railEl) {
      drag(
        railBar,
        'col-resize',
        (event) => ({ x: event.clientX, base: railEl.getBoundingClientRect().width }),
        (session, event) => {
          const max = Math.min(RAIL_MAX, Math.max(RAIL_MIN + 40, window.innerWidth - 320));
          const next = Math.min(max, Math.max(RAIL_MIN, session.base - (event.clientX - session.x)));
          railEl.style.flexBasis = `${next}px`;
        },
        () => savePanelSize('rail_width', railEl.getBoundingClientRect().width),
      );
      railBar.addEventListener('dblclick', () => {
        railEl.style.flexBasis = `${DEFAULT_RAIL}px`;
        savePanelSize('rail_width', DEFAULT_RAIL);
      });
    }

    if (transBar && transcript) {
      drag(
        transBar,
        'row-resize',
        (event) => ({ y: event.clientY, base: transcript.getBoundingClientRect().height }),
        (session, event) => {
          const stage = document.querySelector('.stage-main');
          const max = Math.max(TRANSCRIPT_MIN + 60, (stage ? stage.clientHeight : 520) - 170);
          const next = Math.min(max, Math.max(TRANSCRIPT_MIN, session.base + (event.clientY - session.y)));
          transcript.style.flexBasis = `${next}px`;
        },
        () => savePanelSize('transcript_h', transcript.getBoundingClientRect().height),
      );
      transBar.addEventListener('dblclick', () => {
        transcript.style.flexBasis = `${DEFAULT_TRANSCRIPT}px`;
        savePanelSize('transcript_h', DEFAULT_TRANSCRIPT);
      });
    }
  }

  /* 3 行以上被截断时加渐隐，避免长题目看起来像被硬切掉。 */
  function markQheadClamp(el) {
    el.classList.remove('clipped');
    if (el.scrollHeight > el.clientHeight + 1) el.classList.add('clipped');
  }

  function renderQhead() {
    const el = $('qhead');
    if (!el) return;
    if (editingQid !== null) {
      pushMiniState();
      return;
    }
    const editBtn = $('btnEditQ');
    const index = questions.findIndex((item) => item.id === activeQid);
    if (editBtn) editBtn.classList.toggle('hidden', index < 0);
    const delBtn = $('btnDelQ');
    if (delBtn) delBtn.classList.toggle('hidden', index < 0);
    if (index < 0) {
      el.textContent = '识别到问题后自动编号，点右侧 Q1/Q2 可回看';
      el.classList.add('empty-q');
      el.removeAttribute('title');
      markQheadClamp(el);
      syncAnswerTools();
      pushMiniState();
      return;
    }
    el.textContent = `Q${index + 1} · ${questions[index].text}`;
    el.title = questions[index].text;
    el.classList.remove('empty-q');
    markQheadClamp(el);
    syncAnswerTools();
    pushMiniState();
  }

  /* 识别出错时允许直接改题：改完按「重新生成」就按新题作答。 */
  function editQuestion() {
    const item = questions.find((q) => q.id === activeQid);
    if (!item) {
      toast('先识别或选中一道题', true);
      return;
    }
    const el = $('qhead');
    if (!el) return;
    editingQid = item.id;
    el.classList.remove('empty-q');
    el.textContent = '';
    const input = document.createElement('input');
    input.className = 'qedit-input';
    input.value = item.text;
    el.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      if (keep && value && value !== item.text) {
        item.text = value;
        if (item.id === activeQid) currentQuestion = value;
        toast('题目已修改，点「重新生成」按新题目作答');
      }
      editingQid = null;
      renderQhead();
      renderRail();
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function deleteQuestion() {
    const index = questions.findIndex((q) => q.id === activeQid);
    if (index < 0) return;
    questions.splice(index, 1);
    if (askInFlight) {
      api.cancelAsk(askInFlight);
      askInFlight = null;
      renderStopBtn(false);
    }
    activeQid = null;
    currentQuestion = '';
    currentAnswer = '';
    answerEl.innerHTML = '<div class="empty">题目已删除，等下一道题。</div>';
    answerMeta.textContent = '';
    renderQhead();
    renderRail();
    toast('已删除这道题');
  }

  function selectQuestion(id) {
    const item = questions.find((q) => q.id === id);
    if (!item) return;
    editingQid = null;
    activeQid = id;
    currentQuestion = item.text;
    currentAnswer = item.answer || '';
    if (currentAnswer.trim()) {
      renderAnswer(currentAnswer);
    } else {
      answerEl.innerHTML = '<div class="empty">这道题还没生成回答，点「重新生成」或直接点一条转写作答。</div>';
    }
    if (item.status === 'done') answerMeta.textContent = '已完成';
    else if (item.status === 'streaming') answerMeta.textContent = '生成中';
    else if (item.status === 'error') answerMeta.textContent = '失败';
    else if (item.status === 'skipped') answerMeta.textContent = '已跳过 · 点「重新生成」';
    else answerMeta.textContent = '未生成';
    renderQhead();
    renderRail();
  }

  /* 歌词层与快捷键共用：按题号顺序切换上一题 / 下一题。 */
  function stepQuestion(delta) {
    if (!questions.length) return;
    const index = questions.findIndex((q) => q.id === activeQid);
    let next;
    if (index < 0) next = delta > 0 ? 0 : questions.length - 1;
    else next = Math.min(questions.length - 1, Math.max(0, index + delta));
    if (next === index) {
      pushMiniState();
      return;
    }
    selectQuestion(questions[next].id);
  }

  function gotoQuestion(id) {
    const item = questions.find((q) => q.id === Number(id));
    if (item) selectQuestion(item.id);
  }

  function renderAnswer(text) {
    syncAnswerTools();
    if (!text.trim()) {
      answerEl.innerHTML = '<div class="empty">生成中…</div>';
      return;
    }
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const html = lines.map((line) => {
      const clean = line.replace(/^[-*•·]\s*/, '');
      if (/^【/.test(clean) || /^(结论|核心观点)[:：]/.test(clean)) {
        return `<span class="head">${escapeHtml(clean)}</span>`;
      }
      return `<span class="point">${escapeHtml(clean)}</span>`;
    });
    const stick = nearBottom(answerEl);
    answerEl.innerHTML = html.join('');
    if (stick) scrollBottom(answerEl);
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      renderAnswer(currentAnswer);
      scheduleSnapshot();
      pushMiniState();
    });
  }

  let askQueue = Promise.resolve();

  /* 自动模式下一段可能切出好几道题：串行逐题作答。
   * 不能只答最后一题（前面的题会永远停在 pending），也不能并发（模型会被打爆）。 */
  function enqueueAsk(item, force) {
    if (!item) return;
    const id = item.id;
    if (!force) item.queuedAt = item.queuedAt || Date.now();
    askQueue = askQueue
      .catch(() => {})
      .then(() => {
        const alive = questions.find((q) => q.id === id);
        if (!alive) return;
        if (alive.status === 'streaming') return;
        // force 用于追问：已经答过的题也要带上新残句重答一次
        if (!force && (alive.answer || alive.status === 'done')) return;
        /* 排队太久、用户也没在看这道题：标记为待重答，直接跳过。
         * 这样面试官连问几题时，当前问题的答案不会一直排在旧题后面。 */
        if (!force && alive.status === 'pending' && alive.id !== activeQid
          && Date.now() - (alive.queuedAt || alive.created) > ASK_QUEUE_TTL_MS) {
          alive.status = 'skipped';
          alive.queuedAt = 0;
          renderRail();
          return;
        }
        return ask(alive.text, alive.id);
      });
  }

  async function ask(question, reuseId) {
    const text = String(question || '').trim();
    if (!text) {
      toast('还没有识别到内容，等面试官说完再试', true);
      return;
    }
    // 回答走官方中转：未登录先给一次明确引导，不要发出去再静默失败。
    if (!hasAccess()) {
      promptLogin('登录后才能生成回答，登录后即可继续');
      return;
    }

    let item = reuseId ? questions.find((q) => q.id === reuseId) : null;
    if (!item) {
      const last = questions[questions.length - 1];
      if (last && Date.now() - last.created < 25000 && similarity(last.text, text) >= 0.82) {
        if (last.status !== 'pending' && last.status !== 'error') return;
        item = last;
        if (text.length > last.text.length) item.text = text;
      } else {
        item = createQuestion(text);
      }
    }
    if (item.status === 'streaming') return;

    activeQid = item.id;
    item.status = 'streaming';
    item.answer = '';
    item.queuedAt = 0;
    currentQuestion = item.text;
    currentAnswer = '';
    renderQhead();
    renderRail();

    const id = item.id;
    answerEl.innerHTML = '<div class="empty">生成中…</div>';
    answerMeta.textContent = '生成中';
    setDot('busy', '生成回答');
    askInFlight = id;
    renderStopBtn(true);

    const history = entries
      .slice(-10)
      .map((entry) => entry.text)
      .filter((entryText) => entryText !== item.text)
      .slice(-8);
    // 追问需要知道上一轮答过什么；只带最近两组，答案各截断 400 字。
    const recentQA = questions
      .filter((q) => q.id !== item.id && q.answer && q.answer.trim())
      .slice(-2)
      .map((q) => ({ question: q.text, answer: q.answer.trim().slice(0, 400) }));

    try {
      const result = await api.ask({ id, question: item.text, history, recentQA });
      if (!result.ok) {
        if (result.aborted) {
          item.status = item.answer ? 'done' : 'pending';
          renderRail();
          selectQuestion(id);
          answerMeta.textContent = '已停止';
          setDot(audio && audio.listening ? 'live' : '', audio && audio.listening ? '正在听面试官' : '待启动');
          return;
        }
        item.status = 'error';
        renderRail();
        answerMeta.textContent = '失败';
        toast(result.error, true);
        setDot('err', '生成失败');
      }
    } catch (err) {
      item.status = 'error';
      renderRail();
      answerMeta.textContent = '失败';
      toast(err.message, true);
      setDot('err', '生成失败');
    } finally {
      if (askInFlight === id) askInFlight = null;
      renderStopBtn(false);
      pushMiniState();
    }
  }

  function renderStopBtn(show) {
    const stop = $('btnStop');
    const regen = $('btnRegen');
    if (stop) stop.classList.toggle('hidden', !show);
    if (regen) regen.classList.toggle('hidden', show);
  }

  async function stopAnswer() {
    if (!askInFlight) return;
    const id = askInFlight;
    await api.cancelAsk(id);
    const item = questions.find((q) => q.id === id);
    if (item && item.status === 'streaming') {
      item.status = item.answer ? 'done' : 'pending';
      renderRail();
    }
    askInFlight = null;
    renderStopBtn(false);
    if (item) selectQuestion(id);
    answerMeta.textContent = '已停止';
    pushMiniState();
    toast('已停止生成');
  }

  /* 点击任意一条转写：有对应题目就回看，没有就现场针对这段生成。 */
  function askLine(text, prevText) {
    const value = String(text || '').trim();
    if (!value) return;

    const existing = questions.find((q) => q.text === value);
    if (existing) {
      if (existing.status === 'pending' || existing.status === 'error') ask(existing.text, existing.id);
      else selectQuestion(existing.id);
      return;
    }

    const last = questions[questions.length - 1];
    if (last && similarity(last.text, value) >= 0.82) {
      selectQuestion(last.id);
      return;
    }

    const context = prevText && prevText !== value && !isQuestion(value) ? `${prevText}\n${value}` : value;
    ask(context);
  }

  function answerLast() {
    if (entries.length === 0) {
      toast('还没有识别到面试官的话', true);
      return;
    }
    const last = entries[entries.length - 1].text;
    const prev = entries.length > 1 ? entries[entries.length - 2].text : '';
    ask(prev && !isQuestion(last) ? `${prev}\n${last}` : last);
  }

  async function clearAll() {
    if (!(await askConfirm('清空所有题目和回答？此操作无法撤销。', '清空'))) return;
    if (askInFlight) {
      await api.cancelAsk(askInFlight);
      askInFlight = null;
      renderStopBtn(false);
    }
    // 清屏时把挂起的半句一起丢掉，否则定时器到点会补出一道已经清掉的题
    if (pendingTail) {
      if (pendingTail.timer) clearTimeout(pendingTail.timer);
      pendingTail = null;
    }
    transcriptGen += 1;
    entries = [];
    sessionLog = [];
    questions = [];
    activeQid = null;
    editingQid = null;
    currentQuestion = '';
    currentAnswer = '';
    try { sessionStorage.removeItem(SNAPSHOT_KEY); } catch (err) { /* ignore */ }
    transcriptEl.innerHTML = '<div class="empty">点「开始听面试官」，面试官说话会实时转成文字。</div>';
    syncTranscriptEmpty();
    answerEl.innerHTML = '<div class="empty">识别到问题后会自动生成，也可以点任意一条转写直接作答。</div>';
    answerMeta.textContent = '';
    renderQhead();
    renderRail();
    toast('已清空');
  }

  function setListeningUi(active) {
    btnListen.textContent = active ? '停止收音' : '开始听面试官';
    btnListen.classList.toggle('listening', active);
    setDot(active ? 'live' : '', active ? '正在听面试官' : '待启动');
    if (!active) levelBar.style.width = '0%';
    syncTranscriptEmpty();
    renderSourceBtn();
    syncIdle();
    pushMiniState();
  }

  function renderSourceBtn() {
    const btn = $('btnSource');
    if (!btn || !cfg) return;
    const mic = cfg.audio.source === 'mic';
    btn.textContent = mic ? '麦克风' : '电脑声音';
    btn.classList.toggle('mic', mic);
    btn.title = mic ? '当前收听：麦克风（点击切换为电脑声音）' : '当前收听：电脑声音（点击切换为麦克风）';
    const idleSource = $('btnIdleSource');
    if (idleSource) idleSource.textContent = btn.textContent;
    pushMiniState();
  }

  /* 切换收听来源：正在收音时自动重启，免去「停止再开始」。 */
  async function toggleSource() {
    if (!cfg) return;
    const prev = cfg.audio.source;
    const next = prev === 'mic' ? 'system' : 'mic';
    const wasListening = Boolean(audio && audio.listening);
    if (wasListening) audio.stop();
    try {
      cfg = await api.saveConfig({ audio: { source: next } });
    } catch (err) {
      // 配置没写进去：把收音恢复到原来的来源，避免界面显示「正在听」但实际没录
      if (wasListening) {
        try {
          await audio.start(prev, cfg.audio);
          setListeningUi(true);
        } catch (retryErr) {
          setListeningUi(false);
          await endUsage(true);
        }
      }
      toast(`切换音源失败：${(err && err.message) || '配置保存失败'}`, true);
      return;
    }
    renderSourceBtn();
    const voice = next === 'mic' ? '麦克风（现场面试）' : '电脑声音（面试官）';
    if (wasListening) {
      try {
        await audio.start(next, cfg.audio);
        setListeningUi(true);
      } catch (err) {
        setListeningUi(false);
        await endUsage(true);
        toast(`切换后启动收音失败：${err.message}`, true);
        return;
      }
    }
    const select = $('audioSource');
    if (select) select.value = next;
    toast(`已切换到${voice}`);
  }

  async function toggleContentProtect() {
    if (!cfg) return;
    const next = !cfg.ui.content_protection;
    try {
      cfg = await api.saveConfig({ ui: { content_protection: next } });
      const box = $('contentProtect');
      if (box) box.checked = next;
      renderHomeStatus();
      toast(next ? '防录屏隐身已开启' : '防录屏隐身已关闭');
    } catch (err) {
      toast(err.message || '防录屏设置失败', true);
    }
  }

  async function toggleAutoAnswer() {
    if (!cfg) return;
    const next = !cfg.audio.auto_answer;
    try {
      cfg = await api.saveConfig({ audio: { auto_answer: next } });
      const box = $('autoAnswer');
      if (box) box.checked = next;
      // 打开自动回答时，把之前留下的没作答的题补上，避免题目栏一直挂着空题
      if (next) {
        questions
          .filter((item) => !item.answer && item.status !== 'streaming')
          .forEach((item) => enqueueAsk(item));
      }
      renderHomeStatus();
      toast(next ? '已开启自动回答' : '已关闭自动回答');
    } catch (err) {
      toast(err.message || '自动回答设置失败', true);
    }
  }

  /* 悬浮窗状态快照：主窗是唯一状态源，小窗只负责显示和回传操作。 */
  function miniStatus() {
    if (listeningBusy) return 'connecting';
    if (askInFlight) return 'streaming';
    if (audio && audio.listening) return 'listening';
    const item = questions.find((q) => q.id === activeQid);
    if (!item) return 'idle';
    if (item.status === 'done') return 'done';
    if (item.status === 'error') return 'error';
    if (item.status === 'streaming') return 'streaming';
    return 'pending';
  }

  function miniBalance() {
    const logged = Boolean(authState && authState.logged_in);
    const seconds = Math.max(0, Number(authState && authState.balance_seconds) || 0);
    const remain = usageSession ? usageRemaining() : seconds;
    let text = '—';
    let tone = '';
    let network = 'guest';
    if (authSyncing) {
      text = '···';
      tone = 'sync';
      network = 'sync';
    } else if (!logged) {
      tone = 'guest';
    } else {
      text = formatCompactDuration(remain);
      network = authState.offline ? 'offline' : (authState.wallet_source === 'cache' ? 'cache' : 'online');
      const low = billingPolicy().lowBalance;
      if (authState.offline) tone = 'offline';
      else if (remain <= low) tone = 'bad';
      else if (remain <= low * 5) tone = 'warn';
    }
    const networkText = { sync: '同步中', offline: '离线', cache: '缓存', online: '在线' }[network];
    return {
      text: '',
      tone,
      network,
      title: logged ? (networkText || '') : '未登录',
    };
  }

  function sendMiniState() {
    if (!miniOpen || !cfg) return;
    const activeIndex = questions.findIndex((q) => q.id === activeQid);
    api.miniPush({
      type: 'state',
      status: miniStatus(),
      listening: Boolean(audio && audio.listening),
      busy: Boolean(listeningBusy),
      streaming: Boolean(askInFlight),
      question: currentQuestion,
      answer: currentAnswer,
      answerId: activeQid,
      questions: questions.map((q, index) => ({
        id: q.id,
        index: index + 1,
        text: q.text,
        status: q.status,
      })),
      activeIndex: activeIndex >= 0 ? activeIndex + 1 : 0,
      autoAnswer: Boolean(cfg.audio.auto_answer),
      protect: Boolean(cfg.ui.content_protection),
      theme: cfg.ui.theme,
      source: cfg.audio.source,
      balance: miniBalance(),
    });
  }

  function pushMiniState(force) {
    if (!miniOpen) return;
    if (force) {
      clearTimeout(miniSyncTimer);
      miniSyncTimer = null;
      sendMiniState();
      return;
    }
    if (miniSyncTimer) return;
    miniSyncTimer = setTimeout(() => {
      miniSyncTimer = null;
      sendMiniState();
    }, 80);
  }

  async function handleMiniAction(action) {
    if (!action || !action.type) return;
    if (action.type === 'toggle-listen') {
      if (listeningBusy) return;
      const usable = authState && authState.logged_in && authState.active && !authState.offline;
      if (audio && audio.listening) {
        toggleListen();
        return;
      }
      if (!usable) {
        try { await api.returnToMain(); } finally { toggleListen(); }
        return;
      }
      toggleListen();
      return;
    }
    if (action.type === 'stop-answer') {
      if (askInFlight) stopAnswer();
      return;
    }
    if (action.type === 'toggle-auto') {
      toggleAutoAnswer();
      return;
    }
    if (action.type === 'toggle-protect') {
      toggleContentProtect();
      return;
    }
    if (action.type === 'prev-question') {
      stepQuestion(-1);
      return;
    }
    if (action.type === 'next-question') {
      stepQuestion(1);
      return;
    }
    if (action.type === 'goto-question') {
      gotoQuestion(action.id);
      return;
    }
    if (action.type === 'toggle-source') toggleSource();
  }

  async function openMiniEntry() {
    if (miniOpen) {
      await api.returnToMain();
      return;
    }
    const usable = (audio && audio.listening)
      || (authState && authState.logged_in && authState.active && !authState.offline);
    if (!usable) {
      if (cfg && cfg.llm && cfg.llm.mode === 'own') toast('请先开始收音', true);
      else promptLogin('请先登录并保持可用时长');
      return;
    }
    const result = await api.openMini();
    if (result && result.ok) {
      miniOpen = true;
      pushMiniState(true);
    }
  }

  async function toggleListen() {
    if (audio.listening) {
      audio.stop();
      setListeningUi(false);
      await endUsage();
      return;
    }
    if (cfg.asr.provider === 'llama' && !(asrState && asrState.available)) {
      toast('本机识别还没准备好，可到设置里下载模型，或切换为云端识别', true);
      return;
    }
    const official = Boolean(cfg.llm && cfg.llm.mode === 'official');
    if (official) {
      if (!authState || !authState.logged_in) {
        promptLogin('登录后才能开始收音，登录后即可继续');
        return;
      }
      if (authState.offline) {
        toast('连不上计费服务器，请检查网络后重试', true);
        renderAuth();
        return;
      }
      if (!authState.active) {
        toast('时长不够了，兑换时长码后即可继续', true);
        openAuthGate();
        return;
      }
    }

    if (listeningBusy) return;
    listeningBusy = true;
    btnListen.disabled = true;
    btnListen.textContent = '连接中…';
    pushMiniState();
    try {
      // 先启动采音：音频和 ASR 都就绪后再开始计费，避免启动失败也扣时长。
      await audio.start(cfg.audio.source, cfg.audio);
      if (official) {
        const started = await beginUsage();
        if (!started) {
          audio.stop();
          setListeningUi(false);
          return;
        }
      }
      setListeningUi(true);
      if (official) usageTick();
    } catch (err) {
      setListeningUi(false);
      if (official) await endUsage(true);
      toast(`启动收音失败：${err.message}`, true);
      setDot('err', '收音失败');
    } finally {
      listeningBusy = false;
      btnListen.disabled = false;
      renderSourceBtn();
    }
  }

  function applyAudioState(state) {
    if (state === 'ended') {
      setListeningUi(false);
      endUsage(true).then(() => renderAuth()).catch(() => {});
      toast('音频源已断开（共享停止或设备拔出）', true);
    } else if (state === 'stopped') {
      setListeningUi(false);
      endUsage(true).catch(() => {});
    }
  }

  /* ---------- 提示条 ---------- */
  function showNotice(text, actionLabel, handler) {
    noticeHandler = handler || null;
    $('noticeText').textContent = text;
    $('noticeAction').textContent = actionLabel;
    $('noticeAction').classList.toggle('hidden', !handler);
    $('notice').classList.remove('hidden');
  }

  function hideNotice() {
    noticeHandler = null;
    $('notice').classList.add('hidden');
  }

  /* 用应用内确认条替代 window.confirm：原生弹窗会让无边框窗口失焦甚至被隐藏。 */
  function askConfirm(text, okText) {
    return new Promise((resolve) => {
      confirmResolve = resolve;
      $('confirmText').textContent = text;
      $('confirmOk').textContent = okText || '确认';
      $('confirmBar').classList.remove('hidden');
    });
  }

  function settleConfirm(value) {
    $('confirmBar').classList.add('hidden');
    const resolve = confirmResolve;
    confirmResolve = null;
    if (resolve) resolve(value);
  }

  function updateNotice() {
    if (!cfg) return;
    const localReady = (assets && assets.ready) || (asrState && asrState.available);
    if (cfg.asr.provider === 'llama' && !localReady) {
      showNotice('识别还没准备好，先在设置里选好识别方式。', '去设置', () => openSettings('engine'));
      return;
    }
    /* 自带 Key 的大模型不经过官方计费，不要求登录。 */
    if (cfg.llm && cfg.llm.mode === 'own') {
      hideNotice();
      return;
    }
    /* 启动时 authStatus 要访问一次 /api/me，慢的时候要几秒。
     * 这段时间 authState 还是空的，不能先下「未登录」的结论，否则每次启动都会闪一下登录提示。 */
    if (authSyncing) {
      hideNotice();
      return;
    }
    if (!authState || !authState.logged_in) {
      showNotice('请先登录账号后开始使用。', '去登录', openAuthGate);
      return;
    }
    if (authState.offline) {
      showNotice('连不上计费服务器，联网后才能使用。', '刷新', async () => {
        await refreshAuth();
        updateNotice();
      });
      return;
    }
    if (!authState.active) {
      showNotice('剩余时长不足，兑换时长码后即可继续使用。', '去兑换', openAuthGate);
      return;
    }
    hideNotice();
  }

  /* ---------- 本地资源 / ASR 状态 ---------- */
  async function refreshAssets() {
    assets = await api.assetsStatus();
    renderAssets();
    renderLocalStatus();
  }

  async function refreshAsrStatus() {
    try {
      asrState = await api.asrStatus();
    } catch (err) {
      asrState = null;
    }
    renderLocalStatus();
  }

  async function refreshAll() {
    cfg = await api.getConfig();
    await refreshAssets();
    await refreshAsrStatus();
    updateNotice();
  }

  const TIER_LABEL = { small: '小模型', medium: '中模型', large: '大模型' };

  function fillAssetList(listEl, emptyText) {
    if (!assets) return;
    listEl.innerHTML = '';
    if (!assets.items.length) {
      listEl.innerHTML = `<div class="asset-empty">${emptyText}</div>`;
      return;
    }

    for (const item of assets.items.filter((entry) => entry.kind === 'engine')) {
      const row = document.createElement('div');
      row.className = 'asset-row';

      const state = document.createElement('span');
      const busy = downloadingId === item.id;
      state.className = 'asset-state' + (item.ready ? ' ok' : (busy ? ' busy' : ''));
      row.appendChild(state);

      const main = document.createElement('div');
      main.className = 'asset-main';
      const name = document.createElement('div');
      name.className = 'asset-name';
      name.textContent = item.label;
      if (item.recommended) {
        const badge = document.createElement('span');
        badge.className = 'asset-badge';
        badge.textContent = '本机推荐';
        name.appendChild(badge);
      }
      const detail = document.createElement('div');
      detail.className = 'asset-detail';
      if (item.ready) {
        const size = item.total ? formatBytes(item.total) : '';
        detail.textContent = `已就绪${size ? ` · ${size}` : ''}${item.active ? ' · 使用中' : ''}`;
      } else if (busy) {
        detail.textContent = '下载中…';
      } else {
        detail.textContent = item.detail || '未下载';
      }
      main.appendChild(name);
      main.appendChild(detail);
      row.appendChild(main);

      const action = document.createElement('button');
      action.className = 'mini asset-action';
      action.dataset.asset = item.id;

      action.textContent = item.ready ? '已就绪' : (busy ? '下载中' : '下载');
      action.disabled = item.ready || Boolean(downloadingId);
      row.appendChild(action);

      listEl.appendChild(row);
    }
  }

  function tierItems() {
    if (!assets) return [];
    return assets.items.filter((item) => item.kind === 'model');
  }

  function currentTierItem() {
    const items = tierItems();
    if (!items.length) return null;
    const picked = items.find((item) => item.id === selectedTier);
    if (picked) return picked;
    return items.find((item) => item.active) || items.find((item) => item.recommended) || items[0];
  }

  /* 两个下拉（设置页 + 引导页）保持一致，选哪档就看哪档。 */
  function fillTierSelect() {
    const items = tierItems();
    if (!items.length) return;
    if (!items.some((item) => item.id === selectedTier)) {
      const fallback = items.find((item) => item.active) || items.find((item) => item.recommended) || items[0];
      selectedTier = fallback.id;
    }

    // 用 DOM 构造 option，档位 id 不拼进 innerHTML（数据不可信时的纵深防御）
    const options = items.map((item) => {
      const parts = [TIER_LABEL[item.id] || String(item.id)];
      if (item.total) parts.push(`约 ${formatBytes(item.total)}`);
      if (item.recommended) parts.push('本机推荐');
      if (item.active) parts.push('使用中');
      else if (item.ready) parts.push('已下载');
      else parts.push('未下载');
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = parts.join(' · ');
      return option;
    });

    for (const id of ['modelTier', 'obModelTier']) {
      const el = $(id);
      if (!el) continue;
      el.innerHTML = '';
      options.forEach((option) => el.appendChild(option.cloneNode(true)));
      el.value = selectedTier;
    }
  }

  function renderTierHint() {
    const item = currentTierItem();
    let text = '';
    if (item) {
      const label = TIER_LABEL[item.id] || '该档位';
      const size = item.total ? formatBytes(item.total) : '';
      if (item.active) {
        text = `${label}正在使用中${size ? ` · ${size}` : ''}，可完全离线运行。`;
      } else if (item.ready) {
        text = `${label}已下载${size ? ` · ${size}` : ''}，点下方按钮切换。`;
      } else if (downloadingId === item.id) {
        text = `正在下载${label}…`;
      } else {
        text = `${label}尚未下载${size ? ` · 约 ${size}` : ''}，点下方按钮开始下载。`;
      }
    }
    const hint = $('tierHint');
    const obHint = $('obTierHint');
    if (hint) hint.textContent = text;
    if (obHint) obHint.textContent = text;
  }

  function renderTierAction() {
    const item = currentTierItem();

    let text = '下载此模型';
    let disabled = Boolean(downloadingId);

    if (item && item.active) {
      text = '使用中';
      disabled = true;
    } else if (item && item.ready) {
      text = '使用此模型';
    } else if (downloadingId) {
      text = '下载中';
    }

    for (const id of ['btnDownloadAll', 'obDownloadAll']) {
      const el = $(id);
      if (!el) continue;
      el.textContent = text;
      el.disabled = disabled;
      // 已经在用这一档时按钮没有可执行的动作，收起避免和状态胶囊重复。
      el.classList.toggle('hidden', Boolean(item && item.active));
    }
  }

  /* 按钮一次只处理下拉里选中的那一档：已下载就切换，没下载就先补引擎再下载。 */
  async function tierAction() {
    if (downloadingId || !assets) return;
    const item = currentTierItem();
    if (item && item.active) return;
    if (item && item.ready) {
      await useAsset(item.id);
      return;
    }
    const engine = assets.items.find((entry) => entry.kind === 'engine');
    if (engine && !engine.ready) {
      const ok = await downloadOne('llama');
      if (!ok) return;
    }
    if (item) await downloadOne(item.id);
  }

  function renderAssets() {
    if (!assets) return;
    const listEl = $('assetList');
    if (listEl) fillAssetList(listEl, '没有可下载的资源');
    fillTierSelect();
    renderTierHint();
    renderTierAction();
    const cancel = $('btnCancelDownload');
    if (cancel) cancel.classList.toggle('hidden', !downloadingId);
    const progress = $('assetProgress');
    if (progress) progress.classList.toggle('hidden', !downloadingId);
    renderOnboardAssets();
  }

  function onTierChange(event) {
    const value = event.target.value;
    if (!value || value === selectedTier) return;
    selectedTier = value;
    for (const id of ['modelTier', 'obModelTier']) {
      const el = $(id);
      if (el && el.value !== selectedTier) el.value = selectedTier;
    }
    renderTierHint();
    renderTierAction();
  }

  function renderLocalStatus() {
    const pill = $('localPill');
    const summary = $('localSummary');
    if (!pill || !summary) return;

    const item = currentTierItem();
    const available = Boolean(asrState && asrState.available);
    const memoryHint = assets && assets.memory_gb
      ? `本机内存 ${Math.round(assets.memory_gb)} GB，推荐${TIER_LABEL[assets.recommend] || '小模型'}。`
      : '';

    if (item && item.active) {
      pill.className = 'pill ok';
      pill.textContent = '使用中';
      summary.textContent = `${TIER_LABEL[item.id] || '当前模型'}已下载，可完全离线运行。${memoryHint}`;
    } else if (downloadingId) {
      pill.className = 'pill warn';
      pill.textContent = '下载中';
      summary.textContent = '正在下载所选模型，完成后会自动生效。';
    } else if (item && item.ready) {
      pill.className = 'pill ok';
      pill.textContent = '已下载';
      summary.textContent = `${TIER_LABEL[item.id] || '所选模型'}已下载，点下方按钮切换使用。${memoryHint}`;
    } else if (available) {
      pill.className = 'pill ok';
      pill.textContent = '可用';
      summary.textContent = `检测到本机已有的识别模型，可直接使用；也可以下载到应用目录，换电脑时更省事。${memoryHint}`;
    } else {
      pill.className = 'pill warn';
      pill.textContent = '未下载';
      summary.textContent = `选择模型大小后点下方按钮下载，之后可完全离线使用。${memoryHint}`;
    }

    const engineMeta = $('engineMeta');
    if (engineMeta) {
      engineMeta.textContent = '';
    }
    renderOnboardStatus();
  }

  function paintProgress(bar, text, progress) {
    if (progress.phase === 'extract') {
      bar.style.width = '100%';
      text.textContent = '解压引擎…';
      return;
    }
    if (progress.percent === null || progress.percent === undefined) {
      bar.style.width = '0%';
      text.textContent = progress.received ? '连接下载源…' : '准备下载…';
      return;
    }
    const percent = Math.max(0, Math.min(100, progress.percent));
    bar.style.width = `${percent.toFixed(1)}%`;
    const size = progress.total
      ? `${formatBytes(progress.received)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.received);
    text.textContent = `${percent.toFixed(0)}% · ${size}`;
  }

  function setProgress(progress) {
    paintProgress($('assetBar'), $('assetProgressText'), progress);
    paintProgress($('obBar'), $('obProgressText'), progress);
  }

  function updateDownloadUi() {
    renderAssets();
    renderLocalStatus();
    updateNotice();
  }

  async function downloadOne(id) {
    if (downloadingId) return false;
    const beforeTier = assets ? assets.activeTier : '';
    downloadingId = id;
    $('assetBar').style.width = '0%';
    $('assetProgressText').textContent = '准备下载…';
    $('obBar').style.width = '0%';
    $('obProgressText').textContent = '准备下载…';
    updateDownloadUi();

    let ok = false;
    try {
      const result = await api.downloadAsset(id);
      ok = Boolean(result && result.ok);
      if (!ok) toast((result && result.error) || '下载失败', true);
    } catch (err) {
      toast(err.message, true);
    } finally {
      downloadingId = null;
      $('assetProgress').classList.add('hidden');
      await refreshAll();
      if (ok) {
        setDot('', 'ASR 资源就绪');
        const switched = assets && assets.activeTier === id && beforeTier !== id;
        const label = TIER_LABEL[id] || '';
        toast(switched ? `下载完成，已切换到${label}` : `下载完成，点按钮即可切换到${label}`);
      }
    }
    return ok;
  }

  async function useAsset(id) {
    if (downloadingId) return;
    try {
      const result = await api.useAsset(id);
      if (!result || !result.ok) {
        toast((result && result.error) || '切换失败', true);
        return;
      }
      await refreshAll();
      toast(`已切换到${TIER_LABEL[id] || '所选模型'}，正在重新加载本地识别`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  /* ---------- 简历上传识别 ---------- */
  async function uploadResume(targetId, hintId) {
    const hint = $(hintId);
    if (hint) hint.textContent = '识别中…';

    let result;
    try {
      result = await api.pickResume();
    } catch (err) {
      if (hint) hint.textContent = '识别失败';
      toast(err.message, true);
      return;
    }

    if (!result || result.canceled) {
      if (hint) hint.textContent = '支持 txt / md / docx / pdf';
      return;
    }
    if (!result.ok) {
      if (hint) hint.textContent = '识别失败';
      toast(result.error || '文件读取失败', true);
      return;
    }

    const target = $(targetId);
    if (target) target.value = result.text;
    const mirror = {
      profileResume: 'obProfileResume',
      obProfileResume: 'profileResume',
      profileSyllabus: 'obProfileSyllabus',
      obProfileSyllabus: 'profileSyllabus',
    }[targetId];
    const other = mirror ? $(mirror) : null;
    if (other) other.value = result.text;
    if (hint) hint.textContent = `已识别 ${result.text.length} 字 · ${result.name}`;
    toast(`已识别「${result.name}」，共 ${result.text.length} 字`);
  }

  /* ---------- 账号 / 时长计费 ---------- */
  /* 服务端没返回时的兜底策略，只用于展示与兜底判断，不代表真实价格。 */
  const CLOUD_FALLBACK = {
    pricing: { currency: 'CNY', unit: 'minute', price_per_minute: null, plans: [] },
    billing: { low_balance_seconds: 60, grace_seconds: 90 },
    features: { official_relay: true, redeem: true, hotwords: true, sms: false },
    notice: { text: '', level: 'info', action: '', min_version: '' },
    models: { default_model: '', items: [] },
    source: 'default',
    error: '',
  };

  function firstNumber(...values) {
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue;
      const num = Number(value);
      if (Number.isFinite(num)) return num;
    }
    return 0;
  }

  function billingPolicy() {
    const fallback = CLOUD_FALLBACK.billing;
    const remote = (cloud && cloud.config && cloud.config.billing) || fallback;
    const state = authState || {};
    return {
      lowBalance: Math.max(1, firstNumber(state.low_balance_seconds, remote.low_balance_seconds, fallback.low_balance_seconds)),
      grace: Math.max(0, firstNumber(state.grace_seconds, remote.grace_seconds, fallback.grace_seconds)),
    };
  }

  function versionLess(current, minimum) {
    const left = String(current || '').split('.').map((part) => Number(part) || 0);
    const right = String(minimum || '').split('.').map((part) => Number(part) || 0);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
      const a = left[i] || 0;
      const b = right[i] || 0;
      if (a !== b) return a < b;
    }
    return false;
  }

  /* 价格、官方模型、公告都从服务端拉；失败时用默认值并标明来源。 */
  async function refreshCloud(force) {
    let config = null;
    let models = null;
    // 云端配置与模型清单互不依赖，并行拉取，避免串行超时叠加。
    const [configResult, modelResult] = await Promise.allSettled([
      api.cloudConfig ? api.cloudConfig(Boolean(force)) : Promise.resolve(null),
      api.cloudModels ? api.cloudModels(Boolean(force)) : Promise.resolve(null),
    ]);
    if (configResult.status === 'fulfilled') config = configResult.value;
    if (modelResult.status === 'fulfilled') models = modelResult.value;
    cloud = {
      config: { ...CLOUD_FALLBACK, ...(config || {}) },
      models: { ...CLOUD_FALLBACK.models, ...(models || {}) },
      at: Date.now(),
    };
    renderCloudBits();
    applySmsAvailability();
    renderAccountPanel();
  }

  function pricingText() {
    const pricing = (cloud && cloud.config && cloud.config.pricing) || CLOUD_FALLBACK.pricing;
    const plans = Array.isArray(pricing.plans) ? pricing.plans.length : 0;
    const price = Number(pricing.price_per_minute);
    if (!Number.isFinite(price) || price <= 0) return '以服务端计费为准';
    const currency = pricing.currency === 'CNY' || !pricing.currency ? '元' : pricing.currency;
    // 购买入口没上线时不展示套餐数量，否则用户按提示也找不到购买入口。
    return `${price} ${currency}/分钟${PAY_UI_ENABLED && plans ? ` · ${plans} 种套餐` : ''}`;
  }

  function renderCloudBits() {
    const pricing = $('accountPricing');
    if (pricing) pricing.textContent = pricingText();

    const model = $('llmOfficialModel');
    if (model) {
      const list = (cloud && cloud.models && cloud.models.items) || [];
      const current = (cloud && cloud.models && cloud.models.default_model) || '';
      model.textContent = current
        ? `${current}${list.length > 1 ? `（共 ${list.length} 个可用）` : ''}`
        : '由服务端自动选择';
    }

    const bar = $('announce');
    if (!bar) return;
    const notice = (cloud && cloud.config && cloud.config.notice) || CLOUD_FALLBACK.notice;
    const outdated = Boolean(notice.min_version && appVersion && versionLess(appVersion, notice.min_version));
    const text = outdated
      ? (notice.text ? `${notice.text}（建议升级到 ${notice.min_version}）` : `当前版本过低，请升级到 ${notice.min_version}`)
      : notice.text;
    if (!text || announceDismissed === text) {
      bar.classList.add('hidden');
      return;
    }
    bar.dataset.text = text;
    bar.className = 'announce' + (notice.level === 'warn' || outdated ? ' warn' : '');
    $('announceText').textContent = text;
  }

  function dismissAnnounce() {
    const bar = $('announce');
    if (!bar) return;
    announceDismissed = bar.dataset.text || '';
    bar.classList.add('hidden');
  }

  function formatMinutes(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
    if (minutes > 0) return secs > 0 ? `${minutes} 分 ${secs} 秒` : `${minutes} 分钟`;
    return `${secs} 秒`;
  }

  function formatClock(seconds) {
    const total = Math.max(0, Math.ceil(Number(seconds) || 0));
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  function setAuthError(id, message) {
    const box = $(id);
    if (!box) return;
    box.textContent = message || '';
    box.classList.toggle('hidden', !message);
  }

  function usageRemaining() {
    if (!usageSession) return 0;
    const elapsed = (Date.now() - usageSession.syncedAt) / 1000;
    return Math.max(0, usageSession.syncedBalance - elapsed);
  }

  function updateUsageText() {
    const el = $('accountUsage');
    if (!el) return;
    if (!usageSession) {
      el.textContent = '未开始';
    } else {
      el.textContent = usageSession.graceUntil ? '计时中（网络重试中）' : '计时中';
    }
    renderHomeStatus();
  }

  function formatCompactDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total >= 3600) {
      return `${Math.floor(total / 3600)}h${Math.floor((total % 3600) / 60)}m`;
    }
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  /* 主页高频状态：防录屏与自动回答，与设置页共用同一份配置。 */
  function renderHomeStatus() {
    if (!cfg) return;
    const protect = $('btnProtect');
    if (protect) {
      const on = Boolean(cfg.ui.content_protection);
      protect.classList.toggle('on', on);
      protect.setAttribute('aria-pressed', on ? 'true' : 'false');
      protect.title = on ? '防录屏隐身：已开启' : '防录屏隐身：已关闭';
    }
    const auto = $('btnAutoAnswer');
    if (auto) {
      const on = Boolean(cfg.audio.auto_answer);
      auto.classList.toggle('on', on);
      auto.setAttribute('aria-pressed', on ? 'true' : 'false');
      auto.title = on ? '自动回答：已开启' : '自动回答：已关闭';
    }

    const idleAuto = $('btnIdleAuto');
    if (idleAuto) {
      const on = Boolean(cfg.audio.auto_answer);
      idleAuto.classList.toggle('on', on);
      idleAuto.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    pushMiniState();
  }

  function renderAccountPanel() {
    const email = $('accountEmail');
    const logged = Boolean(authState && authState.logged_in);
    const seconds = Math.max(0, Number(authState && authState.balance_seconds) || 0);
    const cached = Boolean(authState && authState.wallet_source === 'cache');
    const syncing = authSyncing;
    const usable = logged && !authState.offline && !syncing && seconds > 0;
    const official = Boolean(cfg && cfg.llm && cfg.llm.mode === 'official');
    const balanceText = syncing
      ? '同步中…'
      : (logged ? `${formatMinutes(seconds)}${cached ? '（上次同步）' : ''}` : '-');

    loadInvite();

    if (email) {
      email.textContent = logged ? (authState.email || '-') : '未登录';
      $('accountSub').textContent = syncing
        ? '正在从服务端同步余额…'
        : (official
          ? (logged
            ? (cached || authState.offline
              ? '当前显示上次同步的余额，联网后会自动更新'
              : '官方接入 · 按实际使用时长扣费')
            : '官方接入需要先登录账号')
          : '自定义 Key · 由你的服务商计费，不扣官方时长');
      const pill = $('accountPill');
      pill.className = 'pill' + (!official ? ' ok' : (usable ? ' ok' : ((logged || syncing) ? ' warn' : '')));
      pill.textContent = !official
        ? '自定义'
        : (syncing
          ? '同步中'
          : (usable ? '可用' : (logged ? (authState.offline ? '离线' : '时长不足') : '未登录')));
      $('accountBalance').textContent = balanceText;
      $('accountNetwork').textContent = syncing
        ? '同步中'
        : (!logged ? '-' : (authState.offline ? '离线 · 缓存' : (cached ? '缓存' : '在线')));
      $('btnOpenAuth').classList.toggle('hidden', logged);
      $('btnAccountLogout').classList.toggle('hidden', !logged);
    }

    const officialBalance = $('llmOfficialBalance');
    if (officialBalance) officialBalance.textContent = logged ? balanceText : '未登录';
    const officialEmail = $('llmOfficialEmail');
    if (officialEmail) officialEmail.textContent = logged ? (authState.email || '-') : '未登录';
    const officialPill = $('llmOfficialPill');
    if (officialPill) {
      officialPill.className = 'pill' + (usable ? ' ok' : ((logged || syncing) ? ' warn' : ''));
      officialPill.textContent = syncing
        ? '同步中'
        : (usable ? '可用' : (logged ? (authState.offline ? '离线' : '时长不足') : '未登录'));
    }
    const pricing = $('accountPricing');
    if (pricing) pricing.textContent = pricingText();
    updateUsageText();
    renderUserCard();
  }

  /* 题目栏底部头像：悬浮显示用户名与剩余时长，点击进入账号。 */
  const AVATAR_EMOJIS = ['🦊', '🐼', '🐨', '🦁', '🐸', '🐙', '🦄', '🐳', '🐵', '🐰', '🐯', '🦉'];
  const AVATAR_GRADIENTS = [
    'linear-gradient(135deg, #34d399, #0ea5e9)',
    'linear-gradient(135deg, #f59e0b, #ef4444)',
    'linear-gradient(135deg, #8b5cf6, #ec4899)',
    'linear-gradient(135deg, #06b6d4, #3b82f6)',
    'linear-gradient(135deg, #f97316, #eab308)',
    'linear-gradient(135deg, #10b981, #84cc16)',
    'linear-gradient(135deg, #6366f1, #14b8a6)',
    'linear-gradient(135deg, #ef4444, #a855f7)',
  ];

  function avatarHash(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  /* 头像只在首次生成时随机一次，按账号存本地；刷新、重启都不变。 */
  function renderRandomAvatar(el, identity) {
    if (!el) return;
    const key = `icp.avatar.${identity || 'guest'}`;
    let seed = '';
    try {
      seed = localStorage.getItem(key) || '';
      if (!seed) {
        const bytes = new Uint8Array(6);
        if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        seed = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(key, seed);
      }
    } catch (err) {
      seed = `${Date.now()}-${Math.random()}`;
    }
    const hash = avatarHash(seed);
    el.textContent = AVATAR_EMOJIS[hash % AVATAR_EMOJIS.length];
    el.style.background = AVATAR_GRADIENTS[(hash >>> 8) % AVATAR_GRADIENTS.length];
    el.style.color = '#fff';
  }

  /* 底部头像：点击弹出常用账号入口，界面上不再出现任何时间数值。 */
  function accountMenuItems() {
    if (authState && authState.logged_in) {
      return [
        ['account', '账号与时长'],
        ['settings', '设置'],
        ['mini', '悬浮窗'],
        ['logout', '退出登录'],
      ];
    }
    return [
      ['login', '登录'],
      ['settings', '设置'],
      ['mini', '悬浮窗'],
    ];
  }

  let accountMenuSignature = '';

  function renderAccountMenu() {
    const list = $('accountMenuList');
    if (!list) return;
    const items = accountMenuItems();
    const signature = items.map((item) => item[0]).join(',');
    if (signature === accountMenuSignature) return;
    accountMenuSignature = signature;
    list.innerHTML = items
      .map(([action, label]) => `<button type="button" class="account-menu-item${action === 'logout' ? ' danger' : ''}" data-action="${action}">${label}</button>`)
      .join('');
  }

  function closeAccountMenu() {
    const menu = $('accountMenu');
    const user = $('qrailUser');
    if (menu) menu.classList.add('hidden');
    if (user) user.setAttribute('aria-expanded', 'false');
  }

  function toggleAccountMenu() {
    const menu = $('accountMenu');
    const user = $('qrailUser');
    if (!menu) return;
    const open = menu.classList.contains('hidden');
    menu.classList.toggle('hidden', !open);
    if (user) user.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function handleAccountMenu(action) {
    closeAccountMenu();
    if (action === 'login') {
      openAuthGate();
      return;
    }
    if (action === 'logout') {
      authLogout();
      return;
    }
    if (action === 'mini') {
      openMiniEntry();
      return;
    }
    if (action === 'account') openSettings('account');
    else if (action === 'settings') openSettings(appMode === 'written' ? 'written' : undefined);
  }

  /* 低于 2 分钟给头像外圈变色；只在主窗可见，不出现任何倒计时数字。 */
  const LOW_BALANCE_SECONDS = 120;

  function renderUserCard() {
    const avatar = $('qrailAvatar');
    if (!avatar) return;
    const logged = Boolean(authState && authState.logged_in);
    avatar.classList.toggle('online', logged);
    renderRandomAvatar(avatar, logged ? (authState.email || 'user') : 'guest');

    const seconds = Math.max(0, Number(authState && authState.balance_seconds) || 0);
    const remain = usageSession ? usageRemaining() : seconds;
    const low = logged && !authState.offline && remain <= LOW_BALANCE_SECONDS;
    const dock = $('qrailUser');
    if (dock) dock.classList.toggle('low', low);

    const balanceLine = $('userMenuBalance');
    if (balanceLine) {
      let text = '';
      if (logged) {
        if (authSyncing) text = '同步中';
        else if (remain <= 0) text = '时长已用完';
        else if (remain >= 3600) text = `约 ${formatMinutes(remain)}`;
        else text = `约 ${Math.max(1, Math.round(remain / 60))} 分钟`;
      }
      balanceLine.textContent = text;
      balanceLine.classList.toggle('low', low);
    }

    const led = $('accountLed');
    if (led) {
      let network = 'guest';
      if (logged) {
        network = authSyncing
          ? 'sync'
          : (authState.offline ? 'offline' : (authState.wallet_source === 'cache' ? 'cache' : 'online'));
      }
      led.className = `account-led ${network}`;
    }
    renderAccountMenu();
  }

  /* 初始化完成后的起始页只出现一次；之后不论是否在收音，都直接展示工作界面。 */
  function heroPending() {
    return Boolean(cfg && cfg.setup && cfg.setup.done === true && cfg.setup.hero_done === false);
  }

  function syncIdle() {
    const app = $('app');
    if (!app) return;
    // 笔试模式有自己的空态，不能被面试起始页覆盖。
    if (appMode === 'written') {
      app.classList.remove('idle');
      return;
    }
    const hasLine = Boolean(transcriptEl.querySelector('.line'));
    const busy = Boolean((audio && audio.listening) || listeningBusy);
    app.classList.toggle('idle', heroPending() && !hasLine && !busy);
  }

  async function markHeroDone() {
    if (!cfg || !cfg.setup || cfg.setup.hero_done === true) return;
    cfg = { ...cfg, setup: { ...cfg.setup, hero_done: true } };
    syncIdle();
    try {
      cfg = await api.saveConfig({ setup: { hero_done: true } });
    } catch (err) {
      // 保存失败只会导致下次启动再出现一次，不影响当前操作
    }
  }

  function openAuthGate() {
    authGateOpen = true;
    renderAuth();
  }

  function closeAuthGate() {
    authGateOpen = false;
    renderAuth();
  }

  /* 未登录触发作答 / 收音时统一走这里：打开登录层当作就地入口。
   * 登录层已经开着就不再重复弹 toast，避免连续触发出多条相同提示。 */
  function promptLogin(message) {
    const wasOpen = authGateOpen;
    openAuthGate();
    if (wasOpen) return;
    toast(message, true);
  }

  function renderAuth() {
    const gate = $('authGate');
    if (!gate) return;
    applySmsAvailability();
    const logged = Boolean(authState && authState.logged_in);
    const active = Boolean(authState && authState.active);
    gate.classList.toggle('hidden', !authGateOpen);

    /* 同一个弹层承担登录与兑换两种场景，标题必须跟着状态变，避免「时长不足」却写着「先登录」。 */
    const heroTitle = $('authHeroTitle');
    const heroDesc = $('authHeroDesc');
    if (heroTitle && heroDesc) {
      if (!logged) {
        heroTitle.textContent = '先登录，再开始';
        heroDesc.textContent = '登录后即可使用，不用配置任何模型；按实际使用时长扣费，停止收音即停止计费。';
      } else if (authState && authState.offline) {
        heroTitle.textContent = '暂时连不上计费服务器';
        heroDesc.textContent = '已登录账号无需重新登录。网络恢复后即可继续使用官方接入。';
      } else if (!active) {
        heroTitle.textContent = '时长不够了';
        heroDesc.textContent = '官方接入按实际使用时长扣费。兑换时长码后即可继续，剩余时长会自动累加。';
      } else {
        heroTitle.textContent = '账号与时长';
        heroDesc.textContent = '查看剩余时长、兑换时长码，或在这里退出登录。';
      }
    }

    $('authLoginPane').classList.toggle('hidden', logged);
    $('authBalancePane').classList.toggle('hidden', !logged);

    /* 登录态无条件写入邮箱和时长：可用分支之前不写，切进来会一直停在默认的「剩余时长 0 分钟」。 */
    if (logged) {
      $('authEmailLabel').textContent = authState.email || '';
      $('authBalanceLabel').textContent = authSyncing
        ? '正在同步剩余时长…'
        : (authState.offline
          ? `当前离线 · 上次同步 ${formatMinutes(authState.balance_seconds)}`
          : `剩余时长 ${formatMinutes(authState.balance_seconds)}`);
      setAuthError('authBalanceError', active ? '' : (authState.error || ''));
    }

    if (active) {
      setAuthError('authError', '');
    } else if (!logged) {
      setAuthError('authError', authState && authState.error);
    }
    renderAccountPanel();
    renderPurchaseEntry();
  }

  async function refreshAuth() {
    authSyncing = true;
    renderAccountPanel();
    try {
      authState = await api.authStatus();
    } catch (err) {
      authState = {
        ...(authState || {}),
        logged_in: Boolean(authState && authState.logged_in),
        active: false,
        offline: true,
        wallet_source: authState && authState.logged_in ? 'cache' : 'none',
        error: err.message,
      };
    } finally {
      authSyncing = false;
    }
    renderAuth();
    updateNotice();
    return authState;
  }

  async function onAuthChanged() {
    renderAuth();
    await refreshCloud(true);
    cfg = await api.getConfig();
    await refreshAll();
    if (!entered) {
      await startAfterAuth();
      return;
    }
    // 首次引导停在登录这步时，登录成功即视为这一步完成，直接收尾进入主界面。
    const ob = $('onboarding');
    if (authState && authState.logged_in && ob && !ob.classList.contains('hidden') && obStep === OB_STEPS.length) {
      await finishOnboarding();
      return;
    }
    updateNotice();
  }

  /* 使用权限：官方接入需要登录；自带 Key 不走官方计费，不需要登录。 */
  function hasAccess() {
    if (cfg && cfg.llm && cfg.llm.mode === 'own') return true;
    return Boolean(authState && authState.logged_in);
  }

  function disarmRegister() {
    if (!registerArmed) return;
    registerArmed = false;
    $('authInviteRow').classList.add('hidden');
    $('authInvite').value = '';
    $('btnAuthRegister').textContent = '注册';
    $('btnAuthRegister').classList.remove('primary');
  }

  async function authLogin(mode) {
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    const invite = $('authInvite') ? $('authInvite').value.trim() : '';
    if (!email || !password) {
      setAuthError('authError', '请输入邮箱和密码');
      return;
    }
    const loginBtn = $('btnAuthLogin');
    const registerBtn = $('btnAuthRegister');
    loginBtn.disabled = true;
    registerBtn.disabled = true;
    setAuthError('authError', '');
    try {
      const result = mode === 'register'
        ? await api.authRegister({ email, password, invite_code: invite })
        : await api.authLogin({ email, password });
      if (!result || !result.ok) {
        setAuthError('authError', (result && result.error) || '操作失败，请重试');
        return;
      }
      authState = result.state;
      if (authState && authState.active) authGateOpen = false;
      disarmRegister();
      const bonus = Number(result.signup_bonus_minutes) || 0;
      if (mode === 'register') {
        toast(bonus > 0 ? `注册成功，已送 ${bonus} 分钟体验` : '注册成功');
      } else {
        toast('登录成功');
      }
      await onAuthChanged();
    } catch (err) {
      setAuthError('authError', err.message);
    } finally {
      loginBtn.disabled = false;
      registerBtn.disabled = false;
    }
  }

  /* ---------- 手机号验证码 / 重置密码 / 账号安全 ---------- */
  let smsTimer = null;
  let inviteLoadedFor = '';

  function switchAuthTab(mode) {
    const phone = mode === 'phone';
    $('authEmailPane').classList.toggle('hidden', phone);
    $('authPhonePane').classList.toggle('hidden', !phone);
    $('btnAuthTabEmail').classList.toggle('active', !phone);
    $('btnAuthTabPhone').classList.toggle('active', phone);
    $('authResetPane').classList.add('hidden');
    $('authLoginPane').classList.remove('hidden');
  }

  /* 服务端未配置短信时（例如备案未完成），不展示手机号登录入口，避免用户走到 503。 */
  function applySmsAvailability() {
    const enabled = Boolean(cloud && cloud.config && cloud.config.features && cloud.config.features.sms);
    const tab = $('btnAuthTabPhone');
    if (tab) tab.classList.toggle('hidden', !enabled);
    const phonePane = $('authPhonePane');
    if (!enabled && phonePane && !phonePane.classList.contains('hidden')) {
      switchAuthTab('email');
    }
  }

  async function sendSmsCode(phoneId, buttonId, errorId) {
    const phone = $(phoneId).value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      setAuthError(errorId, '请输入 11 位手机号');
      return;
    }
    const btn = $(buttonId);
    btn.disabled = true;
    let result;
    try {
      result = await api.smsSend(phone);
    } catch (err) {
      // IPC 层异常也要把按钮放出来，否则验证码按钮会一直禁用
      btn.disabled = false;
      setAuthError(errorId, (err && err.message) || '验证码发送失败');
      return;
    }
    if (!result || !result.ok) {
      btn.disabled = false;
      setAuthError(errorId, (result && result.error) || '验证码发送失败');
      return;
    }
    setAuthError(errorId, '');
    toast(result.dev_code ? `测试验证码：${result.dev_code}` : '验证码已发送');
    let left = Number(result.resend_in) || 60;
    btn.textContent = `${left}s 后重发`;
    clearInterval(smsTimer);
    smsTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(smsTimer);
        btn.disabled = false;
        btn.textContent = '获取验证码';
        return;
      }
      btn.textContent = `${left}s 后重发`;
    }, 1000);
  }

  async function authSmsLogin() {
    const phone = $('authPhone').value.trim();
    const code = $('authSmsCode').value.trim();
    if (!phone || !code) {
      setAuthError('authPhoneError', '请输入手机号和验证码');
      return;
    }
    const btn = $('btnSmsLogin');
    btn.disabled = true;
    try {
      const result = await api.smsLogin({ phone, code });
      if (!result || !result.ok) {
        setAuthError('authPhoneError', (result && result.error) || '登录失败');
        return;
      }
      authState = result.state;
      if (authState && authState.active) authGateOpen = false;
      toast(result.is_new ? '账号已创建，体验时长已到账' : '登录成功');
      await onAuthChanged();
    } finally {
      btn.disabled = false;
    }
  }

  async function submitResetPassword() {
    const phone = $('resetPhone').value.trim();
    const code = $('resetCode').value.trim();
    const password = $('resetPasswordInput').value;
    if (!phone || !code || !password) {
      setAuthError('resetError', '请填写手机号、验证码和新密码');
      return;
    }
    if (password.length < 6) {
      setAuthError('resetError', '新密码至少 6 位');
      return;
    }
    const btn = $('btnDoReset');
    btn.disabled = true;
    try {
      const result = await api.resetPassword({ phone, code, new_password: password });
      if (!result || !result.ok) {
        setAuthError('resetError', (result && result.error) || '重置失败');
        return;
      }
      toast('密码已重置，请用新密码登录');
      switchAuthTab('email');
      $('authEmail').value = phone;
      $('authPassword').value = '';
    } finally {
      btn.disabled = false;
    }
  }

  async function loadInvite() {
    if (!authState || !authState.logged_in) return;
    const email = authState.email;
    if (inviteLoadedFor === email) return;
    inviteLoadedFor = email;
    let result;
    try {
      result = await api.inviteInfo();
    } catch (err) {
      result = null;
    }
    if (!result || !result.ok) {
      // 这次没取到就撤销标记，下次进入账号页还能重试
      if (inviteLoadedFor === email) inviteLoadedFor = '';
      return;
    }
    const invite = result.invite || {};
    const code = invite.code || '-';
    if ($('accountInvite')) $('accountInvite').textContent = code;
    const count = Number(invite.invited_count ?? invite.count ?? 0);
    const reward = Number(invite.rewarded_minutes ?? invite.reward_minutes ?? 0);
    if ($('accountInviteProgress')) {
      $('accountInviteProgress').textContent = `已邀请 ${count} 人 · 已获 ${reward} 分钟`;
    }
  }

  async function copyInvite() {
    const code = ($('accountInvite') && $('accountInvite').textContent) || '';
    if (!code || code === '-') {
      toast('邀请码还没加载出来', true);
      return;
    }
    try {
      await navigator.clipboard.writeText(code);
      toast('邀请码已复制');
    } catch (err) {
      toast('复制失败，请手动选择', true);
    }
  }

  async function changePassword() {
    const oldPassword = $('oldPassword').value;
    const newPassword = $('newPassword').value;
    if (!newPassword || newPassword.length < 6) {
      setAuthError('accountSecurityError', '新密码至少 6 位');
      return;
    }
    const result = await api.changePassword({ old_password: oldPassword, new_password: newPassword });
    if (!result || !result.ok) {
      setAuthError('accountSecurityError', (result && result.error) || '修改失败');
      return;
    }
    setAuthError('accountSecurityError', '');
    $('passwordPane').classList.add('hidden');
    $('oldPassword').value = '';
    $('newPassword').value = '';
    toast('密码已修改');
  }

  async function deleteAccount() {
    const email = $('deleteEmail').value.trim();
    const password = $('deletePassword').value;
    if (!email || !password) {
      setAuthError('accountSecurityError', '请输入完整邮箱和密码');
      return;
    }
    if (!(await askConfirm(`确认注销 ${email}？此操作不可恢复。`, '注销'))) return;
    const result = await api.deleteAccount({ email, password });
    if (!result || !result.ok) {
      setAuthError('accountSecurityError', (result && result.error) || '注销失败');
      return;
    }
    setAuthError('accountSecurityError', '');
    $('deletePane').classList.add('hidden');
    authState = await api.authStatus();
    renderAuth();
    toast('账号已注销');
  }

  async function exportAccount() {
    const result = await api.exportAccount();
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      setAuthError('accountSecurityError', (result && result.error) || '导出失败');
      return;
    }
    toast(`账号数据已导出到 ${result.path}`);
  }

  async function reopenOnboarding() {
    closeSettings();
    // 从设置里重新运行时要回到第 1 步，而不是停在上次关闭时的步骤。
    obStep = 1;
    await openOnboarding();
  }

  async function exportConfig() {
    const result = await api.exportConfig();
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      toast((result && result.error) || '导出失败', true);
      return;
    }
    toast(`配置已导出到 ${result.path}`);
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function formatDateTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  /* 把本次转写和问答拼成纯文本，交给主进程选路径保存。 */
  function sessionText() {
    const now = new Date();
    const startedAt = sessionLog.length
      ? sessionLog[0].at
      : (questions.length ? questions[0].created : now.getTime());
    const lines = [
      '应声面试 · 面试会话记录',
      '',
      `导出时间：${formatDateTime(now)}`,
      `会话开始：${formatDateTime(startedAt)}`,
      `题目数量：${questions.length}`,
      `转写条数：${sessionLog.length}`,
      '',
      '========== 面试官转写 ==========',
      '',
    ];
    if (sessionLog.length) {
      sessionLog.forEach((entry) => {
        const time = entry.time || formatDateTime(entry.at).slice(11);
        lines.push(`[${time}] ${entry.text}`);
      });
    } else {
      lines.push('（本次没有转写内容）');
    }
    lines.push('', '========== 题目与回答 ==========', '');
    if (questions.length) {
      questions.forEach((item, index) => {
        lines.push(`【Q${index + 1}】${item.time ? `[${item.time}] ` : ''}${item.text}`);
        const answer = String(item.answer || '').trim();
        lines.push(answer || '（未生成回答）');
        lines.push('');
      });
    } else {
      lines.push('（本次没有生成题目）');
    }
    return lines.join('\r\n');
  }

  async function exportSession() {
    if (!sessionLog.length && !questions.length) {
      toast('还没有可导出的转写或问答', true);
      return;
    }
    const result = await api.exportSession(sessionText());
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      toast((result && result.error) || '导出失败', true);
      return;
    }
    toast(`面试会话已导出到 ${result.path}`);
  }

  async function importConfig() {
    const result = await api.importConfig();
    if (!result || !result.ok) {
      if (result && result.canceled) return;
      toast((result && result.error) || '导入失败', true);
      return;
    }
    cfg = await api.getConfig();
    fillSettings();
    applyTheme(cfg.ui.theme);
    renderSourceBtn();
    renderUserCard();
    renderHotwordLibs();
    toast('配置已导入，音频相关设置重新开始收音后生效');
  }

  async function resetConfig() {
    if (!(await askConfirm('恢复默认配置？模型 Key、简历和岗位等都会清空，且无法撤销。', '恢复默认'))) return;
    const result = await api.resetConfig();
    if (!result || !result.ok) {
      toast((result && result.error) || '恢复默认失败', true);
      return;
    }
    cfg = await api.getConfig();
    fillSettings();
    applyTheme(cfg.ui.theme);
    renderSourceBtn();
    renderUserCard();
    renderHotwordLibs();
    toast('已恢复默认配置');
  }

  /* ---------- 订单与支付（后端已就绪，界面入口暂不露出） ---------- */
  /* 改成 true 即可上线「购买时长」入口；后端 manual / epay 两种通道会自适应。 */
  const PAY_UI_ENABLED = false;
  let payInfo = null;
  let payPlans = [];
  let payOrder = null;
  let payPollTimer = null;
  let payPollAttempts = 0;
  let payPollFailures = 0;

  function planPrice(plan) {
    const yuan = Number(plan && plan.price_yuan);
    if (Number.isFinite(yuan) && yuan > 0) return `${yuan} 元`;
    const cents = Number(plan && plan.amount_cents);
    if (Number.isFinite(cents) && cents > 0) return `${(cents / 100).toFixed(2)} 元`;
    return '';
  }

  function stopPayPoll() {
    if (payPollTimer) clearInterval(payPollTimer);
    payPollTimer = null;
    payPollAttempts = 0;
    payPollFailures = 0;
  }

  function resetPayPane() {
    stopPayPoll();
    payOrder = null;
    const pane = $('purchasePay');
    if (pane) pane.classList.add('hidden');
  }

  async function loadPlans() {
    const result = await api.orderPlans();
    if (!result || !result.ok) {
      setAuthError('purchaseError', (result && result.error) || '套餐加载失败');
      return;
    }
    payPlans = Array.isArray(result.plans) ? result.plans : [];
    payInfo = result.pay || null;
    renderPlans();
  }

  function renderPlans() {
    const list = $('planList');
    if (!list) return;
    list.innerHTML = '';
    if (!payPlans.length) {
      list.innerHTML = '<div class="purchase-empty">暂时没有可购买的套餐</div>';
    } else {
      payPlans.forEach((plan) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'plan-card';
        btn.dataset.plan = plan.id;
        const price = planPrice(plan);
        btn.innerHTML = `
          <span class="plan-name">${escapeHtml(plan.name || plan.id || '')}</span>
          <span class="plan-minutes">${Number(plan.minutes) || 0} 分钟</span>
          ${price ? `<span class="plan-price">${escapeHtml(price)}</span>` : ''}
          ${plan.tag ? `<span class="plan-tag">${escapeHtml(plan.tag)}</span>` : ''}`;
        list.appendChild(btn);
      });
    }
    const note = $('purchaseNote');
    if (note) {
      note.textContent = payInfo && payInfo.online
        ? '支付成功后时长会自动到账，无需人工确认。'
        : [payInfo && payInfo.instructions, payInfo && payInfo.contact].filter(Boolean).join('　');
    }
  }

  /* 在线通道展示扫码落地页；人工通道只展示联系方式与说明。 */
  function showPayTarget(order, pageUrl, online) {
    const qr = $('purchaseQr');
    const status = $('purchaseStatus');
    if (qr) {
      qr.innerHTML = '';
      if (online && pageUrl) {
        // TODO: 接入二维码库后把 pageUrl 画成二维码；当前用短链 + 浏览器打开兜底。
        const tip = document.createElement('div');
        tip.className = 'pay-tip';
        tip.textContent = '请用支付宝或微信扫码支付';
        const link = document.createElement('code');
        link.className = 'pay-link';
        link.textContent = pageUrl;
        qr.appendChild(tip);
        qr.appendChild(link);
      }
    }
    if (status) {
      const minutes = Number(order && order.minutes) || 0;
      status.textContent = online
        ? `${minutes} 分钟 · 等待支付`
        : `${minutes} 分钟 · 转账后联系客服核销`;
    }
    $('purchasePay').classList.remove('hidden');
  }

  async function buyPlan(planId) {
    setAuthError('purchaseError', '');
    const result = await api.orderCreate(planId);
    if (!result || !result.ok) {
      if (result && result.pay) payInfo = result.pay;
      setAuthError('purchaseError', (result && result.error) || '下单失败');
      return;
    }
    payOrder = result.order || null;
    if (result.pay) payInfo = result.pay;
    const online = Boolean(result.pay && result.pay.online);
    showPayTarget(payOrder, result.pay_page_url || '', online);
    if (online && payOrder) startPayPoll(payOrder.order_no);
  }

  function startPayPoll(orderNo) {
    stopPayPoll();
    if (!orderNo) return;
    payPollTimer = setInterval(() => checkOrder(orderNo, true), 3000);
  }

  /* silent=true 用于轮询；手动点击「我已支付」时显示错误。 */
  async function checkOrder(orderNo, silent) {
    payPollAttempts += 1;
    let result;
    try {
      result = await api.orderGet(orderNo);
    } catch (err) {
      // 轮询在 setInterval 里跑，必须自己接住异常，否则每次失败都是 unhandled rejection
      result = { ok: false, error: (err && err.message) || '查询订单失败' };
    }
    if (!result || !result.ok) {
      payPollFailures += 1;
      if (!silent) setAuthError('purchaseError', (result && result.error) || '查询订单失败');
      else if (payPollFailures >= 3) setAuthError('purchaseError', '网络异常，支付结果确认中');
      return;
    }
    payPollFailures = 0;
    const order = result.order || null;
    if (order && order.status === 'paid') {
      stopPayPoll();
      setAuthError('purchaseError', '');
      toast('支付成功，时长已到账');
      resetPayPane();
      await refreshAuth();
      return;
    }
    if (order && order.status === 'cancelled') {
      stopPayPoll();
      setAuthError('purchaseError', '订单已取消，可以重新下单');
      resetPayPane();
      return;
    }
    if (!silent && $('purchaseStatus')) {
      $('purchaseStatus').textContent = `${Number(order && order.minutes) || 0} 分钟 · 支付结果确认中`;
    }
    // 最长轮询 5 分钟，之后由用户手动刷新
    if (payPollAttempts >= 100) stopPayPoll();
  }

  async function openPayPage() {
    if (!payOrder) return;
    const result = await api.orderPay(payOrder.order_no);
    if (!result || !result.ok) {
      if (result && result.pay) payInfo = result.pay;
      setAuthError('purchaseError', (result && result.error) || '无法获取支付地址');
      return;
    }
    const url = result.pay_url || result.pay_page_url;
    if (!url) {
      setAuthError('purchaseError', '当前通道不支持在线支付，请联系客服');
      return;
    }
    await api.openExternal(url);
  }

  async function openPurchase() {
    if (!PAY_UI_ENABLED) return;
    setAuthError('purchaseError', '');
    $('purchasePane').classList.remove('hidden');
    $('purchaseEntry').classList.add('hidden');
    await loadPlans();
  }

  function closePurchase() {
    stopPayPoll();
    payOrder = null;
    const pane = $('purchasePane');
    if (pane) pane.classList.add('hidden');
    const pay = $('purchasePay');
    if (pay) pay.classList.add('hidden');
    renderPurchaseEntry();
  }

  /* 入口是否露出由开关决定；关闭时连按钮都不渲染。 */
  function renderPurchaseEntry() {
    const entry = $('purchaseEntry');
    if (!entry) return;
    const logged = Boolean(authState && authState.logged_in);
    entry.classList.toggle('hidden', !(PAY_UI_ENABLED && logged));
  }

  async function authRedeem(inputId, errorId) {
    const input = $(inputId);
    const value = input ? input.value.trim() : '';
    if (!value) {
      setAuthError(errorId, '请输入时长码');
      return;
    }
    setAuthError(errorId, '');
    const result = await api.authRedeem(value);
    if (!result || !result.ok) {
      setAuthError(errorId, (result && result.error) || '兑换失败');
      return;
    }
    authState = result.state;
    if (authState && authState.active) authGateOpen = false;
    if (input) input.value = '';
    toast(`兑换成功，已增加 ${formatMinutes((result.minutes || 0) * 60)}`);
    await onAuthChanged();
  }

  async function authLogout() {
    const official = Boolean(cfg && cfg.llm && cfg.llm.mode === 'official');
    // 结算失败也要继续退出，不能把用户卡在登录态
    await endUsage(true).catch(() => {});
    if (official && audio && audio.listening) {
      audio.stop();
      setListeningUi(false);
    } else if (official) {
      setListeningUi(false);
    }
    try {
      await api.authLogout();
      authState = await api.authStatus();
    } catch (err) {
      toast('退出登录失败，请重试', true);
      return;
    }
    inviteLoadedFor = '';
    renderAuth();
    renderUserCard();
    updateNotice();
    setAuthError('authBalanceError', '');
    toast(official ? '已退出登录，官方接入已停用' : '已退出登录');
  }

  /* ---------- 使用计时（服务端按秒扣费，客户端 30 秒心跳） ---------- */
  let usageSession = null;

  function applyWallet(wallet) {
    if (!wallet) return;
    const seconds = Math.max(0, Number(wallet.balance_seconds) || 0);
    authState = {
      ...(authState || {}),
      balance_seconds: seconds,
      balance_minutes: Math.floor(seconds / 60),
      wallet_source: 'server',
      cached_at: Date.now(),
      active: Boolean(authState && authState.logged_in) && seconds > 0 && !authState.offline,
    };
  }

  /* 服务端可以在任意计费响应里下发策略，收到后覆盖本地展示值。 */
  function applyBilling(result) {
    if (!result || !result.billing) return;
    const billing = result.billing;
    const low = Number(billing.low_balance_seconds);
    const grace = Number(billing.grace_seconds);
    authState = {
      ...(authState || {}),
      low_balance_seconds: Number.isFinite(low) ? low : (authState && authState.low_balance_seconds),
      grace_seconds: Number.isFinite(grace) ? grace : (authState && authState.grace_seconds),
    };
  }

  async function beginUsage() {
    if (usageSession) return true;
    const result = await api.usageStart();
    if (!result || !result.ok) {
      if (result && result.unauthorized) {
        authState = await api.authStatus();
        renderAuth();
        openAuthGate();
      }
      toast((result && result.error) || '无法开始计时，请检查网络', true);
      if (result && result.wallet) applyWallet(result.wallet);
      applyBilling(result);
      renderAuth();
      return false;
    }
    applyWallet(result.wallet);
    applyBilling(result);
    usageSession = {
      id: result.session_id,
      syncedBalance: result.wallet.balance_seconds,
      syncedAt: Date.now(),
      lastOkAt: Date.now(),
      graceUntil: 0,
      graceWarned: false,
      lowWarned: false,
      tick: setInterval(usageTick, 1000),
      beat: setInterval(usageBeat, 30000),
    };
    updateUsageText();
    renderAccountPanel();
    return true;
  }

  function usageTick() {
    if (!usageSession) return;
    const remaining = usageRemaining();
    const policy = billingPolicy();
    updateUsageText();
    renderUserCard();
    if (audio && audio.listening) {
      setDot('live', `正在听面试官${askInFlight ? ' · 生成中' : ''}`);
    } else if (appMode === 'written') {
      setDot('live', '笔试 · 计时中');
    }
    if (!usageSession.lowWarned && remaining <= policy.lowBalance && usageSession.syncedBalance > policy.lowBalance) {
      usageSession.lowWarned = true;
      toast(`剩余时长不足 ${Math.max(1, Math.round(policy.lowBalance / 60))} 分钟`, true);
    }
    if (usageSession.graceUntil && Date.now() > usageSession.graceUntil) {
      finishUsage('网络连接中断，已停止收音');
      return;
    }
    if (remaining <= 0) {
      finishUsage('时长已用完，兑换时长码后可继续使用');
    }
  }

  async function usageBeat() {
    if (!usageSession) return;
    const id = usageSession.id;
    let result;
    try {
      result = await api.usageHeartbeat(id);
    } catch (err) {
      result = { ok: false, error: (err && err.message) || '计费连接中断' };
    }
    if (!usageSession || usageSession.id !== id) return;
    if (!result || !result.ok || !result.wallet) {
      if (result && result.unauthorized) {
        authState = await api.authStatus();
        renderAuth();
        await finishUsage('登录已失效，请重新登录');
        openAuthGate();
        return;
      }
      // 纯网络故障：在服务端宽限期内继续收音，余额仍按最后一次同步值显示。
      const grace = firstNumber(result && result.grace_seconds, billingPolicy().grace);
      const within = Boolean(result && result.grace)
        && Date.now() - usageSession.lastOkAt <= grace * 1000;
      if (within) {
        usageSession.graceUntil = usageSession.lastOkAt + grace * 1000;
        if (!usageSession.graceWarned) {
          usageSession.graceWarned = true;
          toast(`网络波动，${Math.ceil(grace)} 秒内恢复；超时将自动停止收音`, true);
        }
        updateUsageText();
        return;
      }
      finishUsage((result && result.error) || '计费连接中断，已停止收音');
      return;
    }
    usageSession.lastOkAt = Date.now();
    usageSession.graceUntil = 0;
    usageSession.graceWarned = false;
    usageSession.syncedBalance = result.wallet.balance_seconds;
    usageSession.syncedAt = Date.now();
    applyWallet(result.wallet);
    applyBilling(result);
    updateUsageText();
    if (result.ended) finishUsage('时长已用完，兑换时长码后可继续使用');
  }

  async function finishUsage(message) {
    stopListening();
    await endUsage(true);
    renderAuth();
    if (message) toast(message, true);
  }

  /* 停止收音时冲刷出来的最后一句还挂在识别队列里。
   * 服务端按「有没有未结束的计费会话」校验云端识别，如果先关会话再发请求，
   * 最后一句会被 402 挡掉、还会误报「剩余时长不足」。所以结算前先等队列清空，
   * 但要设上限：识别卡住时不能一直挂着会话继续计费。 */
  function settleTranscript() {
    return Promise.race([
      queue.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
  }

  async function endUsage(silent) {
    const session = usageSession;
    if (!session) return;
    usageSession = null;
    clearInterval(session.tick);
    clearInterval(session.beat);
    await settleTranscript();
    const result = await api.usageStop(session.id);
    if (result && result.ok && result.wallet) applyWallet(result.wallet);
    if (result && result.unauthorized) authState = await api.authStatus();
    updateUsageText();
    renderAccountPanel();
    if (!silent) renderAuth();
  }

  function stopListening() {
    if (audio && audio.listening) audio.stop();
    setListeningUi(false);
  }

  /* ---------- 笔试模式 ---------- */
  const WRITTEN_STAGE_TEXT = {
    capturing: '正在截取屏幕…',
    recognizing: '正在识别题目…',
    solving: '正在生成答案…',
  };

  function paintMode(mode) {
    const written = mode === 'written';
    document.body.classList.toggle('mode-written', written);
    for (const btn of document.querySelectorAll('#modeSwitch .mode-btn')) {
      btn.classList.toggle('active', (btn.dataset.mode === 'written') === written);
    }
    const interviewBar = $('interviewBar');
    const writtenBar = $('writtenBar');
    const stageMain = document.querySelector('#interviewStage .stage-main');
    const writtenStage = $('writtenStage');
    const railCapture = $('btnRailCapture');
    if (interviewBar) interviewBar.classList.toggle('hidden', written);
    if (writtenBar) writtenBar.classList.toggle('hidden', !written);
    /* 两种模式共用同一个 stage：只切换左半边内容，右侧题目栏和头像始终在，不会像换了个软件。 */
    if (stageMain) stageMain.classList.toggle('hidden', written);
    if (writtenStage) writtenStage.classList.toggle('hidden', !written);
    if (railCapture) railCapture.classList.toggle('hidden', !written);
    hideRailPreview();
    renderRail();
    syncAnswerTarget();
  }

  /* 切换模式：先把面试收音和计时收干净，再换界面；笔试的计时在首次使用时长按会话延续。 */
  async function setMode(mode, options) {
    const persist = !options || options.persist !== false;
    const next = mode === 'written' ? 'written' : 'interview';
    if (next === appMode) {
      paintMode(next);
      return;
    }
    if (next === 'written') {
      if (audio && audio.listening) {
        audio.stop();
        setListeningUi(false);
        await endUsage(true);
      }
      if (heroPending()) await markHeroDone();
    } else {
      if (usageSession) await endUsage(true);
      if (api.writtenHideAnswer) api.writtenHideAnswer();
      if (phoneInfo) {
        try {
          await api.phoneStop();
        } catch (err) {
          // 关闭失败不阻塞模式切换
        }
        phoneInfo = null;
        renderPhonePanel();
      }
    }
    appMode = next;
    paintMode(next);
    syncIdle();
    if (persist) {
      try {
        cfg = await api.saveConfig({ ui: { mode: next } });
      } catch (err) {
        // 记不住模式只影响下次启动，不影响本次使用
      }
    }
    if (next === 'written') {
      setDot('', '笔试 · 待截图');
    } else if (audio && audio.listening) {
      setDot('live', '正在听面试官');
    } else {
      setDot('', '待启动');
    }
  }

  /* 官方接入需要登录且有剩余时长；自己的 Key 不需要经过计费。 */
  async function writtenReady() {
    if (!cfg || !cfg.llm || cfg.llm.mode !== 'official') return true;
    /* 启动后的几秒内账号还在校验，直接点截图会误报「登录后才能使用」。
     * 这里等校验结束再判断，期间给出明确状态。 */
    if (authSyncing) {
      setWrittenStatus('auth', '正在校验账号…');
      for (let i = 0; i < 60 && authSyncing; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      setWrittenStatus('');
    }
    if (!authState) await refreshAuth();
    /* 启动时 /api/me 偶尔会超时，先记成离线；用户点截图时再补一次校验，
     * 避免网络刚好恢复却一直被挡在「连不上计费服务器」。 */
    if (authState && authState.offline) {
      setWrittenStatus('auth', '正在重新连接账号…');
      await refreshAuth();
      setWrittenStatus('');
    }
    if (authState && authState.offline) {
      toast('连不上计费服务器，请检查网络后重试', true);
      renderAuth();
      return false;
    }
    if (!authState || !authState.logged_in) {
      promptLogin('登录后才能使用笔试，登录后即可继续');
      return false;
    }
    if (!authState.active) {
      toast('时长不够了，兑换时长码后即可继续', true);
      openAuthGate();
      return false;
    }
    return true;
  }

  async function startWrittenUsage() {
    if (usageSession) return true;
    const started = await beginUsage();
    if (started) setDot('live', '笔试 · 计时中');
    return started;
  }

  function setWrittenStatus(stage, text) {
    const box = $('writtenStatus');
    const label = $('writtenStatusText');
    if (!box || !label) return;
    const message = text || WRITTEN_STAGE_TEXT[stage] || '';
    box.classList.toggle('hidden', !message);
    box.classList.toggle('error', stage === 'error');
    if (message) label.textContent = message;
  }

  function writtenProviderLabel(provider) {
    if (provider === 'cloud') return '云端视觉';
    if (provider === 'custom') return '自定义视觉';
    if (provider === 'text') return '手动重答';
    return '本地 OCR';
  }

  function writtenTime(at) {
    const date = new Date(Number(at) || Date.now());
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
  }

  function renderWrittenCurrent() {
    const empty = $('writtenEmpty');
    const current = $('writtenCurrent');
    if (!empty || !current) return;
    if (!writtenActive) {
      empty.classList.remove('hidden');
      current.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');
    current.classList.remove('hidden');
    $('writtenOcr').textContent = writtenActive.text || '（没有识别到文字）';
    const noEl = $('writtenNo');
    if (noEl) {
      if (writtenActive.no) {
        noEl.textContent = `第 ${writtenActive.no} 题`;
        noEl.classList.remove('hidden');
      } else {
        noEl.classList.add('hidden');
      }
    }
    $('writtenAnswer').textContent = writtenActive.answer || '';
    $('writtenProvider').textContent = writtenProviderLabel(writtenActive.provider);
    writtenEditOpen = false;
    $('writtenOcr').classList.remove('hidden');
    $('writtenEditText').classList.add('hidden');
    $('writtenEditActions').classList.add('hidden');
  }

  /* 历史记录统一渲染在右侧题目栏里，和面试模式的题目列表是同一套结构。 */
  function renderWrittenHistory() {
    renderRail();
  }

  /* 从 OCR 文本里猜题号：截图通常带「18.」「18、」「（3）」「第5题」这类前缀。
   * 只看前几行，避免把题干里的小序号（「1. 先初始化」）当成题号。 */
  function detectQuestionNo(text) {
    const lines = String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines.slice(0, 3)) {
      let matched = line.match(/^第\s*([0-9]{1,3})\s*[题小问]/);
      if (matched) return matched[1];
      matched = line.match(/^[（(【[]\s*([0-9]{1,3})\s*[)）】\]]/);
      if (matched) return matched[1];
      matched = line.match(/^([0-9]{1,3})\s*[.．、:：)）]/);
      if (matched) return matched[1];
      matched = line.match(/^([0-9]{1,3})\s+\S/);
      if (matched) return matched[1];
    }
    return '';
  }

  /* 历史只留文本 + 缩略图，原图不驻留，长时间使用也不会把内存占满。 */
  async function applyWrittenResult(payload) {
    if (!payload) return;
    if (Array.isArray(payload.items) && payload.items.length > 1) {
      await applyWrittenItems(payload);
      return;
    }
    const item = {
      text: payload.text || '',
      no: detectQuestionNo(payload.text),
      answer: payload.answer || '',
      provider: payload.provider || '',
      at: payload.at || Date.now(),
      thumb: '',
    };
    writtenItems.unshift(item);
    if (writtenItems.length > 20) writtenItems.length = 20;
    writtenActive = item;
    writtenActiveIndex = 0;
    renderWrittenCurrent();
    renderWrittenHistory();
    /* 大图不用留在历史里，题目栏只显示缩略图；解码完再补进去，不耽误答案先显示。 */
    if (payload.image) {
      makeThumb(payload.image).then((thumb) => {
        if (!thumb || writtenItems.indexOf(item) < 0) return;
        item.thumb = thumb;
        renderWrittenHistory();
      });
    }
  }

  /* 一张截图里的多道题：按题号拆成多条记录，再从第一题开始逐题作答。
   * 截图计时在调用方 runWrittenCapture 里，整批作答共用一个会话。 */
  async function applyWrittenItems(payload) {
    const created = [];
    const list = payload.items;
    /* 倒着插到最前面，题目栏从 1、2、3… 往下排。 */
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = {
        text: list[i].text || '',
        no: list[i].no || detectQuestionNo(list[i].text),
        answer: '',
        provider: '',
        at: payload.at || Date.now(),
        thumb: '',
      };
      writtenItems.unshift(entry);
      created.unshift(entry);
    }
    if (writtenItems.length > 20) writtenItems.length = 20;
    writtenActive = created[0];
    writtenActiveIndex = Math.max(0, writtenItems.indexOf(writtenActive));
    renderWrittenCurrent();
    renderWrittenHistory();

    if (payload.image) {
      makeThumb(payload.image).then((thumb) => {
        if (!thumb) return;
        created.forEach((entry) => {
          if (writtenItems.indexOf(entry) >= 0) entry.thumb = thumb;
        });
        renderWrittenHistory();
      });
    }

    for (let i = 0; i < created.length; i += 1) {
      const entry = created[i];
      if (writtenItems.indexOf(entry) < 0) continue;
      const label = entry.no || String(i + 1);
      setWrittenStatus('solving', `正在作答第 ${label} 题（${i + 1}/${created.length}）`);
      try {
        const result = await api.writtenSolve(entry.text);
        if (result && result.ok) {
          entry.answer = result.answer || '';
          entry.provider = 'local';
          entry.no = entry.no || detectQuestionNo(result.text || entry.text);
        } else {
          entry.answer = `（这道题没有作答成功：${(result && result.error) || '未知错误'}）`;
          entry.provider = 'local';
        }
      } catch (err) {
        entry.answer = `（这道题没有作答成功：${err.message || '网络错误'}）`;
        entry.provider = 'local';
      }
      renderWrittenHistory();
      if (writtenActive === entry) renderWrittenCurrent();
    }
  }

  async function runWrittenCapture(source = 'main') {
    if (writtenBusy) return { ok: false, error: '正在处理上一题，请稍等' };
    writtenBusy = true;
    try {
      if (!(await writtenReady())) {
        return { ok: false, error: '请先在电脑上登录并确认剩余时长' };
      }
      setWrittenStatus('capturing');
      const started = await startWrittenUsage();
      if (!started) return { ok: false, error: '无法开始计时，请检查网络或剩余时长' };
      const result = await api.writtenCapture(source);
      if (!result || result.cancelled) return { ok: false, cancelled: true };
      if (!result.ok) {
        toast(result.error || '识别失败', true);
        return result;
      }
      await applyWrittenResult(result);
      return result;
    } catch (err) {
      toast(err.message || '截图失败', true);
      return { ok: false, error: err.message || '截图失败' };
    } finally {
      writtenBusy = false;
      setWrittenStatus('');
      /* 笔试按实际处理时长结算：答案出来就停，避免用户停在笔试界面时一直计时。
       * 连续截图会在下一次点击时重新开始会话。 */
      if (usageSession) await endUsage(true);
      if (appMode === 'written') setDot('', '笔试 · 待截图');
    }
  }

  async function runWrittenSolve(text) {
    const question = String(text || '').trim();
    if (!question) {
      toast('题目文字为空', true);
      return;
    }
    if (writtenBusy) {
      toast('正在处理上一题，请稍等', true);
      return;
    }
    if (!(await writtenReady())) return;
    writtenBusy = true;
    setWrittenStatus('solving');
    try {
      const started = await startWrittenUsage();
      if (!started) return;
      const result = await api.writtenSolve(question);
      if (!result || !result.ok) {
        toast((result && result.error) || '回答失败', true);
        return;
      }
      const prev = writtenActiveIndex >= 0 ? writtenItems[writtenActiveIndex] : null;
      const item = {
        text: result.text || question,
        no: detectQuestionNo(result.text || question) || (prev && prev.no) || '',
        answer: result.answer || '',
        provider: result.provider || 'text',
        at: result.at || Date.now(),
        thumb: (prev && prev.thumb) || '',
      };
      if (writtenActiveIndex >= 0 && writtenItems[writtenActiveIndex]) {
        writtenItems[writtenActiveIndex] = item;
      } else {
        writtenItems.unshift(item);
        writtenActiveIndex = 0;
      }
      writtenActive = item;
      renderWrittenCurrent();
      renderWrittenHistory();
    } catch (err) {
      toast(err.message || '回答失败', true);
    } finally {
      writtenBusy = false;
      setWrittenStatus('');
      if (usageSession) await endUsage(true);
      if (appMode === 'written') setDot('', '笔试 · 待截图');
    }
  }

  function beginWrittenEdit() {
    if (!writtenActive || writtenEditOpen) return;
    writtenEditOpen = true;
    $('writtenOcr').classList.add('hidden');
    const input = $('writtenEditText');
    input.value = writtenActive.text || '';
    input.classList.remove('hidden');
    $('writtenEditActions').classList.remove('hidden');
    input.focus();
  }

  function cancelWrittenEdit() {
    writtenEditOpen = false;
    renderWrittenCurrent();
  }

  async function saveWrittenEdit() {
    const text = $('writtenEditText').value.trim();
    await runWrittenSolve(text);
  }

  async function copyWrittenAnswer() {
    const answer = writtenActive && String(writtenActive.answer || '').trim();
    if (!answer) {
      toast('还没有答案可以复制', true);
      return;
    }
    await navigator.clipboard.writeText(answer);
    toast('已复制');
  }

  function showPhoneQr(info) {
    const modal = $('phoneQrModal');
    if (!modal) return;
    const img = $('phoneQrModalImg');
    if (info && info.qr) {
      img.src = info.qr;
      img.classList.remove('hidden');
    } else {
      img.removeAttribute('src');
      img.classList.add('hidden');
    }
    $('phoneQrModalUrl').textContent = (info && info.url) || '';
    modal.classList.remove('hidden');
  }

  function closePhoneQr() {
    const modal = $('phoneQrModal');
    if (modal) modal.classList.add('hidden');
  }

  function renderPhonePanel() {
    const running = Boolean(phoneInfo && phoneInfo.url);
    const qr = $('phoneQr');
    const url = $('phoneUrl');
    const stop = $('btnPhoneStop');
    if (qr) {
      qr.classList.toggle('hidden', !(running && phoneInfo.qr));
      if (running && phoneInfo.qr) qr.src = phoneInfo.qr;
      else qr.removeAttribute('src');
    }
    if (url) url.textContent = running ? phoneInfo.url : '未开启';
    if (stop) stop.disabled = !running;
  }

  async function refreshPhonePanel() {
    const state = await api.phoneStatus();
    if (!state || !state.running) {
      phoneInfo = null;
      renderPhonePanel();
      return;
    }
    phoneInfo = { ...(phoneInfo || {}), url: state.url, qr: state.qr || (phoneInfo && phoneInfo.qr) || '' };
    renderPhonePanel();
  }

  /* 手机扫码：没开就自动开，直接把二维码亮出来；有答案顺手推过去，没有就只显示二维码。 */
  async function pushWrittenToPhone() {
    let info = phoneInfo || {};
    const state = await api.phoneStatus();
    if (!state || !state.running) {
      const started = await api.phoneStart();
      if (!started || !started.ok) {
        toast((started && started.error) || '手机副屏启动失败', true);
        return;
      }
      info = { url: started.url, qr: started.qr };
    } else {
      info = { url: state.url || info.url || '', qr: state.qr || info.qr || '' };
    }
    phoneInfo = info;
    renderPhonePanel();
    if (writtenActive && String(writtenActive.answer || '').trim()) {
      await api.phonePush({ text: writtenActive.text, answer: writtenActive.answer });
    }
    showPhoneQr(info);
  }

  const ANSWER_TARGET_TEXT = { both: '电脑 + 手机', pc: '只显示在电脑', phone: '只推到手机' };

  function syncAnswerTarget() {
    const select = $('writtenTargetQuick');
    if (!select || !cfg || !cfg.written) return;
    select.value = cfg.written.answer_target || 'both';
  }

  /* 工具栏上的快捷切换：答案出在电脑、手机还是两边，不用再进设置翻。 */
  async function saveAnswerTarget(value) {
    const next = value === 'pc' || value === 'phone' ? value : 'both';
    const ocrMode = (cfg && cfg.written && cfg.written.ocr_mode) || 'auto';
    cfg = await api.saveConfig({ written: { ocr_mode: ocrMode, answer_target: next } });
    syncAnswerTarget();
    toast(`答案显示：${ANSWER_TARGET_TEXT[next]}`);
  }

  /* ---------- 笔试识别引擎：Windows 自带 OCR / Indra（本地 ONNX） ---------- */
  let indraPreparing = false;

  async function refreshWrittenEngineStatus() {
    const el = $('writtenEngineStatus');
    if (!el) return;
    const rawEngine = (cfg && cfg.written && cfg.written.ocr_engine) || 'windows';
    const engine = rawEngine === 'indra' || rawEngine === 'custom' ? rawEngine : 'windows';
    if (engine === 'windows') {
      el.textContent = '使用系统自带 OCR，离线、无需下载。';
      return;
    }
    if (engine === 'custom') {
      el.textContent = '使用自定义视觉模型识别；截图会发送到你填写的接口，失败时退回系统 OCR。';
      return;
    }
    if (indraPreparing) return;
    let state = null;
    try {
      state = await api.writtenOcrStatus();
    } catch (err) {
      state = null;
    }
    el.textContent = state && state.ready
      ? 'Indra 模型已就绪：离线识别，中文印刷体更准。'
      : 'Indra 模型未下载，点「下载 / 校验模型」开始（约 30 MB）。';
  }

  async function saveWrittenEngine(value) {
    const engine = value === 'indra' || value === 'custom' ? value : 'windows';
    $('writtenCustomFields').classList.toggle('hidden', engine !== 'custom');
    const current = (cfg && cfg.written) || {};
    cfg = await api.saveConfig({
      written: {
        ocr_engine: engine,
        ocr_mode: current.ocr_mode || 'auto',
        custom_base_url: $('writtenCustomBase').value.trim(),
        custom_api_key: $('writtenCustomKey').value.trim(),
        custom_model: $('writtenCustomModel').value.trim(),
        answer_target: current.answer_target || 'both',
      },
    });
    await refreshWrittenEngineStatus();
    if (engine === 'indra') await ensureIndraModels();
    if (engine === 'custom' && !($('writtenCustomBase').value.trim() && $('writtenCustomKey').value.trim() && $('writtenCustomModel').value.trim())) {
      toast('自定义视觉模型还差参数：填好后点保存', true);
    }
  }

  async function ensureIndraModels() {
    if (indraPreparing) return;
    const el = $('writtenEngineStatus');
    let state = null;
    try {
      state = await api.writtenOcrStatus();
    } catch (err) {
      state = null;
    }
    if (state && state.ready) {
      await refreshWrittenEngineStatus();
      return;
    }
    indraPreparing = true;
    if (el) el.textContent = '正在连接模型仓库…';
    try {
      await api.writtenOcrPrepare();
      toast('识别模型已就绪');
    } catch (err) {
      toast(err.message || '模型下载失败', true);
    } finally {
      indraPreparing = false;
      await refreshWrittenEngineStatus();
    }
  }

  function clearWrittenHistory() {
    writtenItems = [];
    writtenActive = null;
    writtenActiveIndex = -1;
    renderWrittenCurrent();
    renderWrittenHistory();
  }

  function bindWritten() {
    $('modeSwitch').addEventListener('click', (event) => {
      const btn = event.target.closest('.mode-btn');
      if (btn) setMode(btn.dataset.mode, { persist: true });
    });
    $('btnWrittenCapture').addEventListener('click', runWrittenCapture);
    $('btnWrittenEmptyCapture').addEventListener('click', runWrittenCapture);
    $('btnWrittenPhone').addEventListener('click', pushWrittenToPhone);
    $('phoneQrModalClose').addEventListener('click', closePhoneQr);
    $('phoneQrModal').addEventListener('click', (event) => {
      if (event.target.dataset.close === '1') closePhoneQr();
    });
    $('writtenTargetQuick').addEventListener('change', (event) => saveAnswerTarget(event.target.value));
    $('writtenOcr').addEventListener('click', beginWrittenEdit);
    $('writtenOcr').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        beginWrittenEdit();
      }
    });
    $('btnWrittenEditCancel').addEventListener('click', cancelWrittenEdit);
    $('btnWrittenEditSave').addEventListener('click', saveWrittenEdit);
    $('btnWrittenCopy').addEventListener('click', copyWrittenAnswer);
    $('btnWrittenRetry').addEventListener('click', () => {
      if (writtenActive) runWrittenSolve(writtenActive.text);
    });
    $('btnWrittenPush').addEventListener('click', pushWrittenToPhone);
    $('btnWrittenClear').addEventListener('click', clearWrittenHistory);
    $('btnRailCapture').addEventListener('click', runWrittenCapture);

    api.onWrittenStatus((payload) => {
      if (!payload) return;
      if (payload.stage === 'error') {
        setWrittenStatus('error', payload.error || '处理失败');
        setTimeout(() => setWrittenStatus(''), 3200);
        return;
      }
      if (payload.stage === 'done' || payload.stage === 'idle') {
        setWrittenStatus('');
        return;
      }
      setWrittenStatus(payload.stage);
    });

    /* 全局快捷键、答案悬浮窗、手机副屏都从这里发起截图；
     * 外部入口带 requestId，处理完把结果回给主进程。 */
    api.onWrittenCaptureRequest(async (payload) => {
      const source = (payload && payload.source) || 'main';
      await setMode('written');
      const result = await runWrittenCapture(source);
      if (payload && payload.id) {
        await api.writtenExternalResult(payload.id, result);
      }
    });
  }

  /* ---------- 设置 ---------- */
  let settingsInitialized = false;

  function switchTab(name) {
    for (const tab of document.querySelectorAll('.tab')) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.classList.toggle('hidden', panel.dataset.panel !== name);
    }
    const accountTab = name === 'account';
    $('btnSaveSettings').classList.toggle('hidden', accountTab);
    $('btnCancelSettings').classList.toggle('wide', accountTab);
    $('btnCancelSettings').textContent = accountTab ? '关闭' : '取消';
    $('settings').querySelector('.sheet-body').scrollTop = 0;
  }

  function renderAsrMode() {
    const provider = $('asrProvider').value;
    for (const seg of document.querySelectorAll('#asrMode .seg')) {
      seg.classList.toggle('active', seg.dataset.provider === provider);
    }
    $('llamaFields').classList.toggle('hidden', provider !== 'llama');
    $('cloudFields').classList.toggle('hidden', provider !== 'cloud');
    $('ownFields').classList.toggle('hidden', provider !== 'own');
  }

  function setProvider(provider) {
    $('asrProvider').value = provider;
    renderAsrMode();
  }

  /* 岗位热词：可搜索的内置/自定义词库 + 单个词标签。 */
  const HOTWORD_PRESETS = {
    '前端': ['React', 'Vue', 'Vue3', 'TypeScript', 'JavaScript', 'v-for', 'key', 'diff', 'DOM', 'computed', 'onMounted', 'props', 'ref', 'reactive', 'Webpack', 'Vite', '闭包', '原型链', '事件循环', '虚拟 DOM', '跨域', '性能优化'],
    '后端': ['Java', 'Spring Boot', 'MySQL', 'Redis', 'Kafka', '微服务', '分布式', '高并发', 'JVM', '索引', '事务', '缓存'],
    '算法': ['机器学习', '深度学习', 'Transformer', '反向传播', '过拟合', '正则化', '梯度下降', 'PyTorch', '特征工程', '模型评估'],
    '测试': ['测试用例', '自动化测试', 'Selenium', '接口测试', '性能测试', '回归测试', '缺陷管理', '单元测试'],
    '产品': ['需求分析', '用户画像', 'PRD', '竞品分析', 'A/B 测试', '留存率', '转化率', 'MVP', '用户增长'],
    '数据': ['SQL', 'Hive', 'Spark', '数据仓库', '维度建模', 'ETL', '指标体系', '漏斗分析'],
    '运维': ['Kubernetes', 'Docker', 'Linux', 'Nginx', 'Jenkins', 'CI/CD', '监控告警', '故障排查', '负载均衡'],
    '通用': ['自我介绍', '项目经历', '职业规划', '团队协作', '沟通能力', '优缺点', '离职原因', '期望薪资'],
  };

  let hotwordWords = [];
  let hotwordCustom = {};

  function hotwordTokens(value) {
    return String(value || '')
      .split(/[\n\r,，、;；]+/)
      .map((word) => word.trim())
      .filter(Boolean);
  }

  function hotwordLibraries() {
    return { ...HOTWORD_PRESETS, ...hotwordCustom };
  }

  /* 输入/输出设备列表。设备名要授权后才能拿到，没授权时用序号兜底。 */
  async function refreshAudioDevices() {
    const input = $('audioInputDevice');
    const output = $('audioOutputDevice');
    if (!input || !output || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    let devices = [];
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (err) {
      return;
    }
    const fill = (select, kind, saved, fallback) => {
      select.innerHTML = '';
      const def = document.createElement('option');
      def.value = '';
      def.textContent = '系统默认';
      select.appendChild(def);
      devices
        .filter((device) => device.kind === kind)
        .forEach((device, index) => {
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.textContent = device.label || `${fallback} ${index + 1}`;
          select.appendChild(option);
        });
      const wanted = String(saved || '');
      select.value = Array.from(select.options).some((option) => option.value === wanted) ? wanted : '';
    };
    fill(input, 'audioinput', cfg && cfg.audio.input_device_id, '麦克风');
    fill(output, 'audiooutput', cfg && cfg.audio.output_device_id, '扬声器');
  }

  /* 用选中的输出设备播一声短提示，确认耳机/音箱接对了。 */
  async function testOutput() {
    const btn = $('btnTestOutput');
    let ctx = null;
    try {
      if (btn) btn.disabled = true;
      ctx = new AudioContext();
      const deviceId = $('audioOutputDevice') ? $('audioOutputDevice').value : '';
      if (deviceId && typeof ctx.setSinkId === 'function') {
        await ctx.setSinkId(deviceId);
      }
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.32);
      osc.frequency.value = 660;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.36);
      osc.onended = () => { if (ctx) ctx.close(); };
    } catch (err) {
      if (ctx) ctx.close();
      toast(`无法使用该输出设备：${err.message}`, true);
    } finally {
      setTimeout(() => { if (btn) btn.disabled = false; }, 500);
    }
  }

  /* 设置页试音：直接读麦克风电平，不启动正式收音，也不会计费。 */
  async function testMic() {
    const btn = $('btnTestMic');
    const bar = $('micTestBar');
    if (!btn || !bar) return;
    let stream = null;
    let ctx = null;
    try {
      const deviceId = $('audioInputDevice') ? $('audioInputDevice').value : '';
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      btn.disabled = true;
      let left = 5;
      const timer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
        bar.style.width = `${Math.min(100, Math.round((peak / 128) * 160))}%`;
        left -= 0.1;
        btn.textContent = `试音中 ${Math.max(0, left).toFixed(1)}s`;
        if (left <= 0) {
          clearInterval(timer);
          bar.style.width = '0';
          btn.disabled = false;
          btn.textContent = '试音 5 秒';
          stream.getTracks().forEach((track) => track.stop());
          ctx.close();
        }
      }, 100);
    } catch (err) {
      if (stream) stream.getTracks().forEach((track) => track.stop());
      if (ctx) ctx.close();
      btn.disabled = false;
      btn.textContent = '试音 5 秒';
      toast(`无法访问麦克风：${err.message}`, true);
    }
  }

  function bindCharCount(inputId, hintId, limit) {
    const input = $(inputId);
    const hint = $(hintId);
    if (!input || !hint) return;
    const base = hint.textContent;
    const update = () => {
      const n = input.value.length;
      hint.textContent = `${base} · ${n} / ${limit} 字${n >= limit ? '（超出部分会被截断）' : ''}`;
      hint.classList.toggle('warn-text', n >= limit);
    };
    input.addEventListener('input', update);
    update();
  }

  function renderHotwordTags() {
    const wrap = $('hotwordTags');
    if (!wrap) return;
    const input = $('hotwordInput');
    wrap.querySelectorAll('.hotword-tag, .hotword-tags-empty').forEach((el) => el.remove());
    if (!hotwordWords.length) {
      const empty = document.createElement('span');
      empty.className = 'hotword-tags-empty';
      empty.textContent = '还没有热词';
      wrap.appendChild(empty);
    }
    for (const word of hotwordWords) {
      const tag = document.createElement('span');
      tag.className = 'hotword-tag';
      tag.textContent = word;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.word = word;
      remove.title = '删除';
      remove.textContent = '×';
      tag.appendChild(remove);
      wrap.appendChild(tag);
    }
    wrap.appendChild(input);
    const count = $('hotwordCount');
    if (count) {
      count.textContent = `${hotwordWords.length} / 60`;
      count.classList.toggle('full', hotwordWords.length >= 60);
    }
  }

  function renderHotwordSuggest() {
    const wrap = $('hotwordSuggest');
    if (!wrap) return;
    const query = $('hotwordSearch').value.trim();
    const libs = hotwordLibraries();
    const lower = query.toLowerCase();
    const names = Object.keys(libs).filter((name) => !lower || name.toLowerCase().includes(lower));
    const canCreate = Boolean(query) && !names.some((name) => name === query);
    wrap.innerHTML = '';
    wrap.classList.toggle('hidden', !names.length && !canCreate);
    for (const name of names.slice(0, 12)) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hotword-suggest-item';
      btn.dataset.library = name;
      btn.innerHTML = `${escapeHtml(name)}<span>${libs[name].length}</span>`;
      wrap.appendChild(btn);
    }
    if (canCreate) {
      const create = document.createElement('button');
      create.type = 'button';
      create.className = 'hotword-suggest-item create';
      create.dataset.create = query;
      create.textContent = `+ 新建热词库「${query}」`;
      wrap.appendChild(create);
    }
  }

  function addHotwordWords(words) {
    const current = new Set(hotwordWords);
    for (const raw of words) {
      const word = String(raw || '').trim();
      if (!word || current.has(word)) continue;
      hotwordWords.push(word);
      current.add(word);
    }
    renderHotwordTags();
    renderHotwordLibs();
  }

  /* 词库标签：点一下整套加入，再点一下整套移除。 */
  function toggleHotwordLibrary(name) {
    const lib = hotwordLibraries()[name];
    if (!lib || !lib.length) return;
    const current = new Set(hotwordWords);
    const applied = lib.every((word) => current.has(word));
    if (applied) {
      const drop = new Set(lib);
      hotwordWords = hotwordWords.filter((word) => !drop.has(word));
      toast(`已移除「${name}」`);
    } else {
      const before = hotwordWords.length;
      addHotwordWords(lib);
      const added = hotwordWords.length - before;
      toast(added > 0 ? `已加入「${name}」${added} 个词` : `「${name}」的词已全部存在`);
    }
    renderHotwordTags();
    renderHotwordLibs();
    api.saveConfig({ asr: { hotwords: hotwordWords.join('、'), custom_presets: hotwordCustom } })
      .then((next) => { cfg = next; })
      .catch(() => {});
  }

  function renderHotwordLibs() {
    const wrap = $('hotwordLibs');
    if (!wrap) return;
    const libs = hotwordLibraries();
    const names = Object.keys(libs);
    const current = new Set(hotwordWords);
    if (!names.length) {
      wrap.innerHTML = '';
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = '';
    for (const name of names) {
      const words = libs[name] || [];
      const applied = words.length > 0 && words.every((word) => current.has(word));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lib-chip' + (applied ? ' active' : '');
      btn.dataset.library = name;
      btn.title = applied
        ? `再点一次移除「${name}」的 ${words.length} 个词`
        : `点击加入「${name}」的 ${words.length} 个词`;
      btn.textContent = name;
      wrap.appendChild(btn);
    }
  }

  /* 一键清空当前热词，并立即保存。 */
  async function clearHotwords() {
    hotwordWords = [];
    renderHotwordTags();
    renderHotwordLibs();
    cfg = await api.saveConfig({ asr: { hotwords: '', custom_presets: hotwordCustom } });
    toast('热词已清空');
  }

  /* 线上热词库：从服务器拉取并合并到本地词库，失败时静默回退本地。 */
  async function syncRemoteHotwords(silent) {
    if (!api.remoteHotwords) return;
    try {
      const result = await api.remoteHotwords();
      if (!result || !result.ok) {
        if (!silent) toast((result && result.error) || '在线词库暂不可用', true);
        return;
      }
      const libraries = result.libraries || {};
      let count = 0;
      for (const [name, words] of Object.entries(libraries)) {
        if (!Array.isArray(words) || !words.length) continue;
        hotwordCustom[name] = words.map((word) => String(word).trim()).filter(Boolean);
        count += 1;
      }
      hotwordRemoteLoaded = true;
      renderHotwordLibs();
      renderHotwordSuggest();
      if (!silent) toast(count ? `已更新 ${count} 个在线词库` : '在线词库暂时是空的');
    } catch (err) {
      if (!silent) toast(err.message, true);
    }
  }

  function createHotwordLibrary(name) {
    const value = String(name || '').trim();
    if (!value) return;
    if (HOTWORD_PRESETS[value]) {
      toast('这个名称已被内置岗位占用，换一个', true);
      return;
    }
    if (!hotwordWords.length) {
      toast('先添加几个热词，再新建热词库', true);
      return;
    }
    hotwordCustom[value] = [...hotwordWords];
    $('hotwordSearch').value = '';
    $('hotwordSuggest').classList.add('hidden');
    toast(`已新建热词库「${value}」，点保存后长期生效`);
  }

  function importHotwordLibraries(file) {
    const reader = new FileReader();
    const baseName = file.name.replace(/\.[^.]+$/, '') || '导入的热词库';
    reader.onload = () => {
      const text = String(reader.result || '');
      const added = [];
      let data = null;
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = null;
      }
      if (Array.isArray(data)) {
        const words = data.map((word) => String(word).trim()).filter(Boolean);
        if (words.length) {
          hotwordCustom[baseName] = words;
          added.push(baseName);
        }
      } else if (data && typeof data === 'object') {
        if (Array.isArray(data.words)) {
          const words = data.words.map((word) => String(word).trim()).filter(Boolean);
          const name = String(data.name || baseName).trim() || baseName;
          if (words.length) {
            hotwordCustom[name] = words;
            added.push(name);
          }
        } else {
          for (const [name, words] of Object.entries(data)) {
            if (!Array.isArray(words)) continue;
            const list = words.map((word) => String(word).trim()).filter(Boolean);
            if (list.length) {
              hotwordCustom[name] = list;
              added.push(name);
            }
          }
        }
      } else {
        const words = hotwordTokens(text);
        if (words.length) {
          hotwordCustom[baseName] = words;
          added.push(baseName);
        }
      }
      if (!added.length) {
        toast('文件里没有可导入的热词', true);
        return;
      }
      renderHotwordSuggest();
      const preview = added.slice(0, 3).join('、');
      toast(`已导入 ${added.length} 个热词库：${preview}${added.length > 3 ? ' 等' : ''}`);
    };
    reader.onerror = () => toast('文件读取失败', true);
    reader.readAsText(file, 'utf-8');
  }

  function applyTheme(theme) {
    document.body.classList.toggle('light', theme !== 'dark');
    pushMiniState();
  }

  /* 大模型接入方式：官方（默认）或用户自带 Key。只影响显示，不影响计费判断。 */
  function llmMode() {
    const active = document.querySelector('#llmMode .seg.active');
    return active && active.dataset.mode === 'own' ? 'own' : 'official';
  }

  function renderLlmMode() {
    const mode = llmMode();
    for (const seg of document.querySelectorAll('#llmMode .seg')) {
      seg.classList.toggle('active', seg.dataset.mode === mode);
    }
    $('llmOfficialFields').classList.toggle('hidden', mode !== 'official');
    $('llmOwnFields').classList.toggle('hidden', mode !== 'own');
  }

  function applyLlmMode() {
    renderLlmMode();
    renderAccountPanel();
  }

  /* 用当前填写的地址和 Key 拉一次模型列表，顺便验证连通性。 */
  async function fetchLlmModels() {
    const hint = $('llmModelHint');
    const base_url = $('llmBaseUrl').value.trim();
    const api_key = $('llmApiKey').value.trim();
    if (!base_url || !api_key) {
      toast('先填接口地址和 API Key', true);
      return;
    }
    hint.textContent = '正在获取模型列表…';
    try {
      const result = await api.listModels({ base_url, api_key });
      if (!result || !result.ok) throw new Error((result && result.error) || '获取失败');
      const models = Array.isArray(result.models) ? result.models : [];
      if (!models.length) {
        hint.textContent = '接口可用，但没有返回模型名，请按服务商文档手动填写。';
        return;
      }
      if (!$('llmModel').value.trim()) $('llmModel').value = models[0];
      hint.textContent = `可用模型：${models.slice(0, 6).join('、')}${models.length > 6 ? ` 等 ${models.length} 个` : ''}`;
    } catch (err) {
      hint.textContent = `获取失败：${err.message}`;
    }
  }

  const ANSWER_DETAIL_LABELS = { 1: '极简', 2: '简洁', 3: '标准', 4: '详细', 5: '深入' };

  function syncAnswerDetail() {
    const input = $('llmAnswerDetail');
    if (!input) return;
    const value = Math.max(1, Math.min(5, Number(input.value) || 3));
    input.setAttribute('aria-valuetext', ANSWER_DETAIL_LABELS[value]);
    const labels = document.querySelectorAll('#llmAnswerDetailScale span');
    labels.forEach((label, index) => label.classList.toggle('active', index === value - 1));
  }

  async function saveAnswerDetail() {
    if (!cfg) return;
    const value = Math.max(1, Math.min(5, Number($('llmAnswerDetail').value) || 3));
    try {
      cfg = await api.saveConfig({ llm: { answer_detail: value } });
      toast(`回答复杂度已设为「${ANSWER_DETAIL_LABELS[value]}」，下一次回答立即生效`);
    } catch (err) {
      toast(err.message || '回答复杂度保存失败', true);
    }
  }

  async function saveAnswerOral() {
    if (!cfg) return;
    const enabled = $('llmAnswerOral').checked;
    try {
      cfg = await api.saveConfig({ llm: { answer_oral: enabled } });
      toast(enabled ? '已开启口语直读模式，下一次回答生效' : '已关闭口语直读，恢复原回答风格');
    } catch (err) {
      toast(err.message || '口语直读设置保存失败', true);
    }
  }

  function fillSettings() {
    for (const seg of document.querySelectorAll('#llmMode .seg')) {
      seg.classList.toggle('active', seg.dataset.mode === (cfg.llm.mode === 'own' ? 'own' : 'official'));
    }
    $('llmBaseUrl').value = cfg.llm.base_url || '';
    $('llmApiKey').value = cfg.llm.api_key || '';
    $('llmModel').value = cfg.llm.model || '';
    $('llmModelHint').textContent = '兼容 OpenAI 的接口：填到 /v1 为止，模型名按服务商文档填写。';
    applyLlmMode();
    $('llmAnswerDetail').value = Math.max(1, Math.min(5, Number(cfg.llm.answer_detail) || 3));
    syncAnswerDetail();
    $('llmAnswerOral').checked = Boolean(cfg.llm.answer_oral);

    $('asrBin').value = cfg.asr.llama_bin || '';
    $('asrModelPath').value = cfg.asr.llama_model || '';
    $('asrMmproj').value = cfg.asr.llama_mmproj || '';
    $('asrPort').value = cfg.asr.llama_port;
    $('asrBaseUrl').value = cfg.asr.base_url || '';
    $('asrApiKey').value = cfg.asr.api_key || '';
    $('asrModel').value = cfg.asr.model || '';
    hotwordWords = hotwordTokens(cfg.asr.hotwords || '');
    hotwordCustom = {};
    const customPresets = cfg.asr.custom_presets;
    if (customPresets && typeof customPresets === 'object' && !Array.isArray(customPresets)) {
      for (const [name, words] of Object.entries(customPresets)) {
        if (Array.isArray(words) && words.length) {
          hotwordCustom[name] = words.map((word) => String(word).trim()).filter(Boolean);
        }
      }
    }
    $('hotwordSearch').value = '';
    $('hotwordInput').value = '';
    $('hotwordSuggest').classList.add('hidden');
    renderHotwordTags();
    renderHotwordLibs();

    $('profileJob').value = cfg.profile.job || '';
    $('profileResume').value = cfg.profile.resume || '';
    $('profileSyllabus').value = cfg.profile.syllabus || '';

    $('audioSensitivity').value = cfg.audio.sensitivity;
    $('audioSilence').value = cfg.audio.silence_ms;
    $('asrLanguage').value = cfg.asr.language || 'auto';
    $('autoAnswer').checked = Boolean(cfg.audio.auto_answer);

    $('uiOpacity').value = cfg.ui.opacity;
    $('uiTheme').value = cfg.ui.theme === 'dark' ? 'dark' : 'light';
    applyTheme(cfg.ui.theme);
    $('contentProtect').checked = Boolean(cfg.ui.content_protection);
    if (cfg.written) {
      $('writtenOcrMode').value = cfg.written.ocr_mode || 'auto';
      const engine = cfg.written.ocr_engine === 'indra' || cfg.written.ocr_engine === 'custom'
        ? cfg.written.ocr_engine
        : 'windows';
      $('writtenOcrEngine').value = engine;
      $('writtenCustomFields').classList.toggle('hidden', engine !== 'custom');
      $('writtenCustomBase').value = cfg.written.custom_base_url || '';
      $('writtenCustomKey').value = cfg.written.custom_api_key || '';
      $('writtenCustomModel').value = cfg.written.custom_model || '';
      $('writtenAnswerTarget').value = cfg.written.answer_target || 'both';
    }
    refreshWrittenEngineStatus();
    renderPhonePanel();
    refreshPhonePanel().catch(() => {});
    renderHotkeyInputs();

    $('asrProvider').value = cfg.asr.provider || 'llama';
    renderAsrMode();
    renderSourceBtn();
    renderCloudBits();
    renderAccountPanel();
    renderUserCard();
    refreshAudioDevices();
  }

  async function openSettings(tab) {
    if (!cfg) return;
    if (!authState) await refreshAuth();
    fillSettings();
    $('settings').classList.remove('hidden');
    const current = document.querySelector('.tab.active');
    switchTab(tab || (current && current.dataset.tab) || 'engine');
    await refreshAudioDevices();
    await refreshAssets();
    await refreshAsrStatus();
    renderLocalStatus();
    updateDownloadUi();
    if (!hotwordRemoteLoaded) syncRemoteHotwords(true);
  }

  function closeSettings() {
    api.winSet('opacity', cfg ? (Number(cfg.ui.opacity) || 1) : 1);
    api.winSet('protect', cfg ? Boolean(cfg.ui.content_protection) : true);
    applyTheme(cfg ? cfg.ui.theme : 'light');
    api.pauseHotkeys(false);
    $('settings').classList.add('hidden');
    renderHomeStatus();
  }

  async function saveSettings() {
    const mode = llmMode();
    const llmBaseUrl = $('llmBaseUrl').value.trim();
    const llmApiKey = $('llmApiKey').value.trim();
    const llmModel = $('llmModel').value.trim();
    if (mode === 'own' && (!llmBaseUrl || !llmApiKey || !llmModel)) {
      toast('自定义大模型需要填完整：接口地址、API Key 和模型名', true);
      return;
    }
    const provider = $('asrProvider').value;
    const asrBaseUrl = $('asrBaseUrl').value.trim();
    const asrApiKey = $('asrApiKey').value.trim();
    const asrModel = $('asrModel').value.trim();
    if (provider === 'own' && (!asrBaseUrl || !asrApiKey || !asrModel)) {
      toast('自定义语音识别需要填完整：接口地址、API Key 和模型名', true);
      return;
    }

    const patch = {
      llm: {
        base_url: llmBaseUrl,
        api_key: llmApiKey,
        model: llmModel,
        temperature: cfg.llm.temperature,
        answer_detail: Math.max(1, Math.min(5, Number($('llmAnswerDetail').value) || 3)),
        answer_oral: $('llmAnswerOral').checked,
        mode,
        official_key: cfg.llm.official_key || '',
        official_model: cfg.llm.official_model || '',
      },
      asr: {
        provider,
        base_url: asrBaseUrl,
        api_key: asrApiKey,
        model: asrModel,
        llama_bin: $('asrBin').value.trim(),
        llama_model: $('asrModelPath').value.trim(),
        llama_mmproj: $('asrMmproj').value.trim(),
        llama_port: Number($('asrPort').value) || 8091,
        hotwords: hotwordWords.join('\n'),
        custom_presets: hotwordCustom,
        language: $('asrLanguage').value || 'auto',
      },
      profile: {
        job: $('profileJob').value,
        resume: $('profileResume').value,
        syllabus: $('profileSyllabus').value,
      },
      audio: {
        source: cfg.audio.source,
        sensitivity: Number($('audioSensitivity').value),
        silence_ms: Number($('audioSilence').value),
        max_segment_s: cfg.audio.max_segment_s,
        auto_answer: $('autoAnswer').checked,
        input_device_id: $('audioInputDevice') ? $('audioInputDevice').value : (cfg.audio.input_device_id || ''),
        output_device_id: $('audioOutputDevice') ? $('audioOutputDevice').value : (cfg.audio.output_device_id || ''),
      },
      ui: {
        opacity: Number($('uiOpacity').value),
        theme: $('uiTheme').value === 'dark' ? 'dark' : 'light',
        content_protection: $('contentProtect').checked,
        mode: appMode,
      },
      written: {
        ocr_mode: $('writtenOcrMode').value || 'auto',
        ocr_engine: $('writtenOcrEngine').value === 'indra' || $('writtenOcrEngine').value === 'custom'
          ? $('writtenOcrEngine').value
          : 'windows',
        custom_base_url: $('writtenCustomBase').value.trim(),
        custom_api_key: $('writtenCustomKey').value.trim(),
        custom_model: $('writtenCustomModel').value.trim(),
        answer_target: $('writtenAnswerTarget').value || 'both',
      },
    };
    const previousMode = cfg.llm.mode;
    const previousAudio = JSON.stringify(cfg.audio);
    cfg = await api.saveConfig(patch);
    applyTheme(cfg.ui.theme);
    syncAnswerTarget();
    updateAsrMeta();
    await refreshAll();
    renderSourceBtn();
    renderUserCard();
    const audioChanged = JSON.stringify(cfg.audio) !== previousAudio;
    if (previousMode !== cfg.llm.mode && audio && audio.listening) {
      await endUsage(true);
      audio.stop();
      setListeningUi(false);
      toast('接入方式已切换，请重新开始收音');
    } else if (audioChanged && audio && audio.listening) {
      // 灵敏度、静音、收听源改了要重启音频流，否则界面变了声音没变。
      const official = cfg.llm.mode === 'official';
      await audio.stop();
      try {
        await audio.start(cfg.audio.source, cfg.audio);
        if (official) {
          const started = await beginUsage();
          if (!started) {
            audio.stop();
            setListeningUi(false);
            return;
          }
        }
        setListeningUi(true);
        if (official) usageTick();
        toast('音频设置已生效');
      } catch (err) {
        setListeningUi(false);
        toast(`音频设置已保存，但重启收音失败：${err.message}`, true);
      }
    } else if (audioChanged) {
      toast('音频设置已保存，开始收音后生效');
    } else {
      toast('已保存');
    }
    closeSettings();
  }

  async function warmup() {
    const meta = $('warmupMeta');
    if (!cfg || cfg.asr.provider !== 'llama') {
      meta.textContent = '当前使用云端识别，本地引擎不会启动。';
      return;
    }
    meta.textContent = '加载中（首次约 10-30 秒）…';
    const result = await api.warmupAsr();
    if (result.ok) {
      meta.textContent = '本地 ASR 已就绪';
      toast('ASR 已就绪');
    } else {
      meta.textContent = `失败：${result.error}`;
      toast(result.error, true);
    }
    await refreshAsrStatus();
  }

  async function loadAppInfo() {
    try {
      const info = await api.appInfo();
      appVersion = info.version || '';
      $('appVersion').textContent = info.version || '-';
      $('appPlatform').textContent = info.platform || '-';
      renderCloudBits();
    } catch (err) {
      // 信息拿不到不影响使用
    }
  }

  /* ---------- 版本更新 ---------- */
  function updateDateText(value) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw.slice(0, 10);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function closeUpdateSheet() {
    if (pendingUpdate && pendingUpdate.mandatory) return;
    $('updateSheet').classList.add('hidden');
    pendingUpdate = null;
    updateDownloading = false;
    $('updAction').classList.remove('hidden');
    $('updAction').disabled = false;
    $('updAction').textContent = '立即更新';
    $('updLater').textContent = '稍后';
    $('updProgressRow').classList.add('hidden');
  }

  function renderUpdateSheet(update) {
    const latest = update.latest || {};
    const download = latest.download || {};
    const mandatory = Boolean(update.mandatory);
    pendingUpdate = update;
    updateDownloading = false;

    $('updTitle').textContent = mandatory ? '需要更新' : '发现新版本';
    $('updVersion').textContent = latest.version ? `v${latest.version}` : '-';
    $('updHeadline').textContent = mandatory ? '当前版本已停止支持' : '有新版本可用';
    $('updDesc').textContent = mandatory
      ? '这个版本必须更新后才能继续使用，更新前请先结束当前面试。'
      : '更新包含功能改进和问题修复，下载完成后会自动启动安装程序。';
    $('updCurrent').textContent = appVersion || update.current || '-';
    $('updLatest').textContent = latest.version || '-';
    $('updSize').textContent = download.size ? formatBytes(download.size) : '未知';
    $('updDate').textContent = updateDateText(latest.published_at);
    $('updNotes').textContent = latest.notes || '本次更新包含稳定性改进和问题修复。';
    $('updHint').textContent = mandatory
      ? '更新完成前无法关闭此窗口。'
      : '建议在面试开始前更新，安装过程会关闭当前应用。';
    $('updClose').classList.toggle('hidden', mandatory);
    $('updLater').classList.toggle('hidden', mandatory);
    $('updLater').textContent = '稍后';
    $('updAction').classList.remove('hidden');
    $('updAction').disabled = false;
    $('updAction').textContent = '立即更新';
    $('updProgressRow').classList.add('hidden');
    $('updBar').style.width = '0%';
    $('updProgressText').textContent = '';
    $('updateSheet').classList.remove('hidden');
  }

  async function checkUpdate(manual) {
    if (updateDownloading) return null;
    let result = null;
    try {
      result = await api.updateCheck();
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    if (!result || !result.ok) {
      if (manual) toast((result && result.error) || '检查更新失败，请稍后再试', true);
      return result;
    }
    if (!result.available) {
      if (manual) toast('当前已是最新版本');
      return result;
    }
    /* 同一版本点过「稍后」就不再自动弹；手动检查和强制更新不受影响。 */
    const skipped = (cfg && cfg.update && cfg.update.skipped_version) || '';
    if (!manual && !result.mandatory && skipped === result.latest.version) return result;
    renderUpdateSheet(result);
    return result;
  }

  function maybeAutoCheckUpdate() {
    if (updateAutoChecked) return;
    if (!cfg || !cfg.setup || cfg.setup.done !== true || cfg.setup.hero_done !== true) return;
    const onboarding = $('onboarding');
    if (onboarding && !onboarding.classList.contains('hidden')) return;
    updateAutoChecked = true;
    setTimeout(() => {
      // 已经开始收音就不打断，等下次启动再检查。
      if (audio && (audio.listening || listeningBusy)) return;
      checkUpdate(false).catch(() => {});
    }, 1800);
  }

  async function skipUpdate() {
    if (!pendingUpdate || pendingUpdate.mandatory) return;
    const version = pendingUpdate.latest && pendingUpdate.latest.version;
    closeUpdateSheet();
    if (!version) return;
    try {
      cfg = await api.saveConfig({ update: { skipped_version: version } });
    } catch (err) {
      // 保存失败只影响下次是否再提示，不阻塞关闭
    }
  }

  async function startUpdate() {
    if (updateDownloading || !pendingUpdate) return;
    if (audio && audio.listening) {
      const ok = await askConfirm('正在收音，更新会结束本次记录和计时。确定现在更新？', '更新');
      if (!ok) return;
    }
    updateDownloading = true;
    $('updAction').disabled = true;
    $('updAction').textContent = '下载中…';
    $('updClose').classList.add('hidden');
    $('updLater').textContent = '取消下载';
    $('updProgressRow').classList.remove('hidden');
    $('updBar').style.width = '0%';
    $('updProgressText').textContent = '准备下载…';
    $('updHint').textContent = '下载完成后会自动关闭应用并启动安装程序。';

    let result = null;
    try {
      result = await api.updateDownload();
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    updateDownloading = false;
    $('updLater').textContent = '稍后';

    if (!result || !result.ok) {
      if (result && result.cancelled) {
        $('updProgressRow').classList.add('hidden');
        $('updHint').textContent = '已取消下载，可以稍后再试。';
        $('updAction').textContent = '重新下载';
      } else {
        $('updHint').textContent = `下载失败：${(result && result.error) || '未知错误'}`;
        $('updAction').textContent = '重试';
      }
      $('updAction').disabled = false;
      $('updClose').classList.toggle('hidden', Boolean(pendingUpdate && pendingUpdate.mandatory));
      return;
    }

    $('updBar').style.width = '100%';
    $('updProgressText').textContent = '下载完成';
    $('updHint').textContent = '正在启动安装程序，应用即将关闭…';
    $('updAction').classList.add('hidden');

    let installResult = null;
    try {
      installResult = await api.updateInstall();
    } catch (err) {
      installResult = { ok: false, error: err.message };
    }
    if (!installResult || !installResult.ok) {
      $('updHint').textContent = `启动安装失败：${(installResult && installResult.error) || '请手动运行安装包'}`;
      $('updAction').classList.remove('hidden');
      $('updAction').disabled = false;
      $('updAction').textContent = '重试安装';
      $('updClose').classList.toggle('hidden', Boolean(pendingUpdate && pendingUpdate.mandatory));
    }
  }

  /* ---------- 首次初始化向导 ---------- */
  const OB_STEPS = [
    {
      title: '先准备识别模型',
      desc: '第一次只需下载识别模型；也可以先用云端识别，或填自己的识别服务 Key。',
    },
    {
      title: '你的岗位',
      desc: '选择最接近的岗位，会自动补充对应的高频专业词，让识别更准确。',
    },
    {
      title: '补充个人资料（可选）',
      desc: '填上岗位，或直接上传简历自动识别，生成的回答会更贴合你的真实经历。',
    },
    {
      title: '大模型与账号',
      desc: '官方接入是默认方案，登录后按使用时长扣费；也可以填自己的大模型 Key，或点「下次再说」先进入主界面。',
    },
  ];

  let obStep = 1;
  let obProvider = 'llama';
  let obLlmMode = 'official';
  let obJob = '';
  let onboardingInitialized = false;

  function renderOnboardAssets() {
    const list = $('obAssetList');
    if (!list || !assets) return;
    fillAssetList(list, '没有可下载的资源');
    // 引擎就绪后不再重复列一行「已就绪」的禁用按钮。
    const engine = assets.items.find((entry) => entry.kind === 'engine');
    list.classList.toggle('hidden', Boolean(engine && engine.ready));
    $('obCancelDownload').classList.toggle('hidden', !downloadingId);
    $('obProgress').classList.toggle('hidden', !downloadingId);
  }

  function renderOnboardStatus() {
    const pill = $('obPill');
    const summary = $('obLocalSummary');
    if (!pill || !summary) return;
    const item = currentTierItem();
    const available = Boolean(asrState && asrState.available);
    const label = item ? (TIER_LABEL[item.id] || '所选模型') : '识别模型';
    if (item && item.active) {
      pill.className = 'pill ok';
      pill.textContent = '使用中';
      summary.textContent = `${label}已就绪，可完全离线运行。`;
    } else if (downloadingId) {
      pill.className = 'pill warn';
      pill.textContent = '下载中';
      summary.textContent = '正在下载运行文件，完成后自动生效。';
    } else if (item && item.ready) {
      pill.className = 'pill ok';
      pill.textContent = '已下载';
      summary.textContent = `${label}已下载，切换后即可离线使用。`;
    } else if (available) {
      pill.className = 'pill ok';
      pill.textContent = '可用';
      summary.textContent = '检测到本机已有的识别模型，可直接使用。';
    } else {
      pill.className = 'pill warn';
      pill.textContent = '未下载';
      summary.textContent = '选择档位后下载，完成后即可离线使用。';
    }
  }

  function obSyncMode() {
    for (const seg of document.querySelectorAll('#obAsrMode .seg')) {
      seg.classList.toggle('active', seg.dataset.provider === obProvider);
    }
    $('obLocalFields').classList.toggle('hidden', obProvider !== 'llama');
    $('obCloudFields').classList.toggle('hidden', obProvider !== 'cloud');
    $('obOwnFields').classList.toggle('hidden', obProvider !== 'own');
  }

  function obLlmFieldsComplete() {
    return Boolean(
      $('obLlmBaseUrl').value.trim()
      && $('obLlmApiKey').value.trim()
      && $('obLlmModel').value.trim()
    );
  }

  function obLastReady() {
    return obLlmMode === 'own' ? obLlmFieldsComplete() : hasAccess();
  }

  function updateObNextLabel() {
    if (obStep !== OB_STEPS.length) return;
    $('obNext').textContent = obLastReady() ? '完成配置' : '登录 / 注册';
  }

  function obSyncLlmMode() {
    for (const seg of document.querySelectorAll('#obLlmMode .seg')) {
      seg.classList.toggle('active', seg.dataset.mode === obLlmMode);
    }
    $('obLlmOfficialFields').classList.toggle('hidden', obLlmMode !== 'official');
    $('obLlmOwnFields').classList.toggle('hidden', obLlmMode !== 'own');
    $('obOfficialCard').classList.toggle('hidden', obLlmMode !== 'official');
    updateObNextLabel();
  }

  function obSetJob(job) {
    obJob = job || '';
    for (const card of document.querySelectorAll('#obJobGrid .job-card')) {
      card.classList.toggle('active', card.dataset.job === obJob);
    }
    const input = $('obProfileJob');
    if (obJob && input && !input.value.trim()) input.value = obJob;
  }

  function obSetStep(step) {
    obStep = Math.max(1, Math.min(OB_STEPS.length, step));
    const meta = OB_STEPS[obStep - 1];
    $('obStepLabel').textContent = `第 ${obStep} 步 / 共 ${OB_STEPS.length} 步`;
    $('obTitle').textContent = meta.title;
    $('obDesc').textContent = meta.desc;

    for (const dot of document.querySelectorAll('#onboarding .ob-step')) {
      const index = Number(dot.dataset.step);
      dot.classList.toggle('active', index === obStep);
      dot.classList.toggle('done', index < obStep);
    }
    for (const pane of document.querySelectorAll('#onboarding .ob-pane')) {
      pane.classList.toggle('hidden', Number(pane.dataset.pane) !== obStep);
    }

    $('obPrev').classList.toggle('hidden', obStep === 1);
    const last = obStep === OB_STEPS.length;
    $('obNext').textContent = last ? (obLastReady() ? '完成配置' : '登录 / 注册') : '下一步';
    $('obSkip').textContent = last ? '下次再说' : '稍后再说';
    renderOnboardAuth();
    $('onboarding').querySelector('.sheet-body').scrollTop = 0;
  }

  /* 最后一步只展示当前登录状态；登录入口复用主界面的登录层，不重复实现一套表单。 */
  function renderOnboardAuth() {
    const pill = $('obAuthPill');
    const summary = $('obAuthSummary');
    if (!pill || !summary) return;
    const logged = Boolean(authState && authState.logged_in);
    pill.className = 'pill' + (logged ? ' ok' : ' warn');
    pill.textContent = logged ? '已登录' : '未登录';
    summary.textContent = logged
      ? `${authState.email || '已登录'}，可以开始听面试。`
      : '登录后即可开始听面试并生成回答。';
  }

  async function openOnboarding() {
    if (!cfg) return;
    obProvider = cfg.asr.provider || 'llama';
    obLlmMode = cfg.llm && cfg.llm.mode === 'own' ? 'own' : 'official';
    $('obAsrBaseUrl').value = cfg.asr.base_url || '';
    $('obAsrApiKey').value = cfg.asr.api_key || '';
    $('obAsrModel').value = cfg.asr.model || '';
    $('obLlmBaseUrl').value = cfg.llm.base_url || '';
    $('obLlmApiKey').value = cfg.llm.api_key || '';
    $('obLlmModel').value = cfg.llm.model || '';
    $('obProfileJob').value = cfg.profile.job || '';
    $('obProfileResume').value = cfg.profile.resume || '';
    $('obProfileSyllabus').value = cfg.profile.syllabus || '';
    const matchedJob = Object.keys(HOTWORD_PRESETS).find((key) => (cfg.profile.job || '').includes(key)) || '';
    obSetJob(matchedJob);
    obSyncMode();
    obSyncLlmMode();
    obSetStep(obStep);
    await api.winSet('onboarding', true);
    $('onboarding').classList.remove('hidden');
    try {
      await refreshAssets();
      await refreshAsrStatus();
      renderOnboardAssets();
      renderOnboardStatus();
      renderHardware();
    } catch (err) {
      // 状态刷不出来也要让引导可用，不能把用户卡在空白页。
    }
  }

  /* 首次进入先看本机跑不跑得动，结果只用于给默认建议，不阻止用户选择。 */
  async function renderHardware() {
    const el = $('obHardware');
    if (!el) return;
    el.textContent = '正在检测本机性能…';
    try {
      const hw = await api.detectHardware();
      if (!hw) {
        el.textContent = '';
        return;
      }
      // detectHardware 给的是逻辑核心数，这里按「线程」展示，不能写成核数。
      const cores = Number(hw.logical_cores) || 0;
      const mem = Number(hw.memory_gb) || 0;
      const spec = cores && mem ? `${cores} 线程 / ${mem} GB 内存` : String(hw.summary || '');
      el.textContent = spec ? `你的电脑：${spec}。${hw.reason}。` : String(hw.reason || '');
      if (hw.tier === 'cloud') {
        // 低配机器默认帮用户选云端，但仍保留本机选项
        if (!(assets && assets.ready)) {
          obProvider = 'cloud';
          $('asrProvider').value = 'cloud';
          obSyncMode();
        }
      }
    } catch (err) {
      el.textContent = '';
    }
  }

  function closeOnboarding() {
    api.winSet('opacity', cfg ? (Number(cfg.ui.opacity) || 1) : 1);
    $('onboarding').classList.add('hidden');
    api.winSet('onboarding', false);
  }

  function onboardingPatch(done) {
    const hotwords = hotwordTokens((cfg && cfg.asr && cfg.asr.hotwords) || '');
    for (const word of (HOTWORD_PRESETS[obJob] || [])) {
      if (!hotwords.includes(word)) hotwords.push(word);
    }
    const asr = {
      provider: obProvider,
      hotwords: hotwords.join('、'),
    };
    if (obProvider === 'own') {
      asr.base_url = $('obAsrBaseUrl').value.trim();
      asr.api_key = $('obAsrApiKey').value.trim();
      asr.model = $('obAsrModel').value.trim();
    }
    const llm = { mode: obLlmMode };
    if (obLlmMode === 'own') {
      llm.base_url = $('obLlmBaseUrl').value.trim();
      llm.api_key = $('obLlmApiKey').value.trim();
      llm.model = $('obLlmModel').value.trim();
    }
    return {
      // 完成初始化后重新展示一次起始页；跳过则直接进入工作界面。
      setup: { done: Boolean(done), hero_done: !done },
      asr,
      llm,
      profile: {
        job: $('obProfileJob').value,
        resume: $('obProfileResume').value,
        syllabus: $('obProfileSyllabus').value,
      },
    };
  }

  async function finishOnboarding() {
    if (obLlmMode === 'own' && !obLlmFieldsComplete()) {
      toast('自定义大模型还差参数：接口地址、API Key 和模型名', true);
      obSetStep(OB_STEPS.length);
      return;
    }
    let saved = true;
    try {
      cfg = await api.saveConfig(onboardingPatch(true));
      await refreshAll();
    } catch (err) {
      saved = false;
      toast(`配置保存失败：${err.message}`, true);
    } finally {
      // 保存或刷新失败也必须退出引导，不能让它变成常驻主界面。
      updateAsrMeta();
      closeOnboarding();
      syncIdle();
      renderSourceBtn();
      renderUserCard();
      updateNotice();
    }
    if (saved) toast('初始化完成，可以开始使用了');

    if (cfg && cfg.asr.provider === 'llama') {
      if (!(assets && assets.ready)) {
        setDot('busy', 'ASR 未就绪');
        return;
      }
      api.warmupAsr().then(async (result) => {
        if (result.ok) setDot('', 'ASR 就绪');
        else setDot('err', 'ASR 不可用');
        await refreshAsrStatus();
        updateNotice();
      });
    } else {
      setDot('', '待启动');
    }
  }

  async function skipOnboarding() {
    try {
      cfg = await api.saveConfig({ setup: { done: true, hero_done: true } });
    } catch (err) {
      // 保存失败也要退出引导，工作界面本身不受影响。
    }
    closeOnboarding();
    syncIdle();
    setDot('', '待启动');
    updateNotice();
    toast('已跳过，随时可以在设置里继续配置');
  }

  function bindOnboarding() {
    if (onboardingInitialized) return;
    onboardingInitialized = true;

    $('btnCloseOnboarding').addEventListener('click', () => {
      // 最后一步关闭等同于跳过登录：前面步骤的配置照常保存。
      if (obStep === OB_STEPS.length) finishOnboarding();
      else skipOnboarding();
    });
    $('obSkip').addEventListener('click', () => {
      // 最后一步的「下次再说」只跳过登录，前面步骤的配置照常保存。
      if (obStep === OB_STEPS.length) finishOnboarding();
      else skipOnboarding();
    });
    $('obPrev').addEventListener('click', () => obSetStep(obStep - 1));
    $('obNext').addEventListener('click', () => {
      if (obStep < OB_STEPS.length) {
        obSetStep(obStep + 1);
        return;
      }
      // 最后一步：自带 Key 填完整即可完成；官方接入需要先登录。
      if (obLlmMode === 'own') {
        if (!obLlmFieldsComplete()) {
          toast('自定义大模型还差参数：接口地址、API Key 和模型名', true);
          return;
        }
        finishOnboarding();
        return;
      }
      if (hasAccess()) {
        finishOnboarding();
        return;
      }
      openAuthGate();
    });

    $('obAsrMode').addEventListener('click', (event) => {
      const seg = event.target.closest('.seg');
      if (!seg) return;
      obProvider = seg.dataset.provider;
      obSyncMode();
    });

    $('obLlmMode').addEventListener('click', (event) => {
      const seg = event.target.closest('.seg');
      if (!seg) return;
      obLlmMode = seg.dataset.mode === 'own' ? 'own' : 'official';
      obSyncLlmMode();
    });
    for (const id of ['obLlmBaseUrl', 'obLlmApiKey', 'obLlmModel']) {
      $(id).addEventListener('input', updateObNextLabel);
    }

    $('obJobGrid').addEventListener('click', (event) => {
      const card = event.target.closest('.job-card');
      if (card) obSetJob(card.dataset.job);
    });

    $('obDownloadAll').addEventListener('click', tierAction);
    $('obCancelDownload').addEventListener('click', async () => {
      await api.cancelAsset();
      toast('已取消下载，已下载的部分会保留以便续传');
    });
    $('obAssetList').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-asset]');
      if (button && !button.disabled) downloadOne(button.dataset.asset);
    });
    $('obModelTier').addEventListener('change', onTierChange);
    $('obUploadResume').addEventListener('click', () => uploadResume('obProfileResume', 'obResumeHint'));
    $('obUploadSyllabus').addEventListener('click', () => uploadResume('obProfileSyllabus', 'obSyllabusHint'));
  }

  /* ---------- 快捷键设置 ---------- */
  const HOTKEY_LABEL = {
    Control: 'Ctrl',
    Alt: 'Alt',
    Shift: 'Shift',
    Super: 'Win',
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Space: '空格',
  };

  function prettyHotkey(accel) {
    const value = String(accel || '').trim();
    if (!value) return '未设置';
    return value.split('+').map((part) => HOTKEY_LABEL[part] || part).join(' + ');
  }

  function accelFromEvent(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Control');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Super');
    if (!parts.includes('Control') && !parts.includes('Alt')) return '';
    const raw = event.key;
    if (!raw || ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock'].includes(raw)) return '';
    let key = '';
    if (raw === ' ') key = 'Space';
    else if (raw.startsWith('Arrow')) key = raw.slice(5);
    else if (/^F([1-9]|1[0-2])$/.test(raw)) key = raw;
    else if (/^[a-zA-Z]$/.test(raw)) key = raw.toUpperCase();
    else if (/^[0-9]$/.test(raw)) key = raw;
    else if (['-', '=', '[', ']', ';', "'", ',', '.', '/', '\\', '`'].includes(raw)) key = raw;
    if (!key) return '';
    parts.push(key);
    return parts.join('+');
  }

  function renderHotkeyInputs() {
    const hotkeys = (cfg && cfg.hotkeys) || {};
    document.querySelectorAll('.hotkey-input').forEach((input) => {
      const accel = hotkeys[input.dataset.hotkey] || '';
      input.dataset.accel = accel;
      input.value = prettyHotkey(accel);
    });
    const label = (key) => prettyHotkey((cfg && cfg.hotkeys && cfg.hotkeys[key]) || '');
    const hideBtn = $('btnHide');
    if (hideBtn) hideBtn.title = `隐藏（${label('hide')}）`;
    const authHide = $('btnAuthHide');
    if (authHide) authHide.title = `隐藏（${label('hide')}）`;
    const clearBtn = $('btnClear');
    if (clearBtn) clearBtn.title = `清空所有题目和回答（${label('clear')}）`;
    const captureBtn = $('btnWrittenCapture');
    if (captureBtn) captureBtn.title = `框选题目（${label('capture')}）`;
  }

  async function saveHotkey(action, accel) {
    if (!cfg) return;
    const next = { ...(cfg.hotkeys || {}), [action]: accel };
    try {
      const result = await api.saveHotkeys(next);
      if (result && result.hotkeys) {
        cfg.hotkeys = result.hotkeys;
        renderHotkeyInputs();
      }
      if (result && result.failed && result.failed.length) {
        toast(`快捷键 ${result.failed.map(prettyHotkey).join('、')} 被其他软件占用`, true);
      } else {
        toast(accel ? '快捷键已更新' : '已清空该快捷键');
      }
    } catch (err) {
      toast(err.message || '快捷键保存失败', true);
    }
  }

  function bindHotkeyInputs() {
    document.querySelectorAll('.hotkey-input').forEach((input) => {
      input.addEventListener('focus', () => {
        api.pauseHotkeys(true);
        input.classList.add('recording');
        input.value = '按下组合键…';
      });
      input.addEventListener('blur', () => {
        input.classList.remove('recording');
        api.pauseHotkeys(false);
        renderHotkeyInputs();
      });
      input.addEventListener('keydown', (event) => {
        if (!input.classList.contains('recording')) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          input.blur();
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          saveHotkey(input.dataset.hotkey, '');
          input.blur();
          return;
        }
        const accel = accelFromEvent(event);
        if (!accel) return;
        saveHotkey(input.dataset.hotkey, accel);
        input.blur();
      });
    });
  }

  /* ---------- 启动 ---------- */
  function bindSettings() {
    if (settingsInitialized) return;
    settingsInitialized = true;

    $('btnCloseSettings').addEventListener('click', closeSettings);
    $('btnCancelSettings').addEventListener('click', closeSettings);
    $('btnSaveSettings').addEventListener('click', saveSettings);

    $('settingsTabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (tab) switchTab(tab.dataset.tab);
    });

    $('llmAnswerDetail').addEventListener('input', syncAnswerDetail);
    $('llmAnswerDetail').addEventListener('change', saveAnswerDetail);
    $('llmAnswerOral').addEventListener('change', saveAnswerOral);

    $('llmMode').addEventListener('click', (event) => {
      const seg = event.target.closest('.seg');
      if (!seg) return;
      for (const item of document.querySelectorAll('#llmMode .seg')) {
        item.classList.toggle('active', item === seg);
      }
      applyLlmMode();
    });
    $('btnLlmModels').addEventListener('click', fetchLlmModels);

    $('writtenOcrEngine').addEventListener('change', () => {
      saveWrittenEngine($('writtenOcrEngine').value).catch((err) => toast(err.message || '保存失败', true));
    });
    $('btnIndraDownload').addEventListener('click', () => {
      ensureIndraModels();
    });
    api.onWrittenOcrProgress((progress) => {
      const el = $('writtenEngineStatus');
      if (!el || !indraPreparing) return;
      if (progress && progress.stage === 'downloading') {
        el.textContent = `下载中 ${progress.index}/${progress.total}：${progress.file}`;
      } else if (progress && progress.stage === 'ready') {
        el.textContent = '模型已就绪。';
      }
    });

    $('asrMode').addEventListener('click', (event) => {
      const seg = event.target.closest('.seg');
      if (seg) setProvider(seg.dataset.provider);
    });

    $('btnDownloadAll').addEventListener('click', tierAction);
    $('btnCancelDownload').addEventListener('click', async () => {
      await api.cancelAsset();
      toast('已取消下载，已下载的部分会保留以便续传');
    });
    const assetList = $('assetList');
    if (assetList) {
      assetList.addEventListener('click', (event) => {
        const button = event.target.closest('button[data-asset]');
        if (button && !button.disabled) downloadOne(button.dataset.asset);
      });
    }
    $('modelTier').addEventListener('change', onTierChange);

    $('hotwordTags').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-word]');
      if (!button) return;
      hotwordWords = hotwordWords.filter((word) => word !== button.dataset.word);
      renderHotwordTags();
    });
    $('hotwordSearch').addEventListener('focus', renderHotwordSuggest);
    $('hotwordSearch').addEventListener('input', renderHotwordSuggest);
    $('hotwordSearch').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const query = event.target.value.trim();
      if (!query) return;
      const libs = hotwordLibraries();
      if (libs[query]) {
        toggleHotwordLibrary(query);
        return;
      }
      createHotwordLibrary(query);
    });
    $('hotwordSearch').addEventListener('blur', () => {
      setTimeout(() => $('hotwordSuggest').classList.add('hidden'), 120);
    });
    $('hotwordSuggest').addEventListener('mousedown', (event) => {
      const create = event.target.closest('button[data-create]');
      if (create) {
        event.preventDefault();
        createHotwordLibrary(create.dataset.create);
        return;
      }
      const item = event.target.closest('button[data-library]');
      if (!item) return;
      event.preventDefault();
      toggleHotwordLibrary(item.dataset.library);
    });
    $('hotwordInput').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const words = hotwordTokens(event.target.value);
      if (!words.length) return;
      addHotwordWords(words);
      event.target.value = '';
    });
    $('btnImportHotwordLib').addEventListener('click', () => $('hotwordImportFile').click());
    $('btnClearHotwords').addEventListener('click', clearHotwords);
    $('hotwordLibs').addEventListener('click', (event) => {
      const chip = event.target.closest('.lib-chip');
      if (chip) toggleHotwordLibrary(chip.dataset.library);
    });
    $('hotwordImportFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importHotwordLibraries(file);
      event.target.value = '';
    });
    $('btnUploadResume').addEventListener('click', () => uploadResume('profileResume', 'resumeHint'));
    $('btnUploadSyllabus').addEventListener('click', () => uploadResume('profileSyllabus', 'syllabusHint'));
    $('btnWarmup').addEventListener('click', warmup);
    $('btnOpenRuntime').addEventListener('click', () => api.openFolder('runtime'));

    $('btnOpenData').addEventListener('click', () => api.openFolder('data'));
    $('btnOpenLogs').addEventListener('click', () => api.openFolder('logs'));

    $('btnAuthHide').addEventListener('click', () => api.winSet('hide'));
    $('btnAuthQuit').addEventListener('click', () => api.winSet('quit'));
    $('btnReopenOnboarding').addEventListener('click', reopenOnboarding);
    $('confirmOk').addEventListener('click', () => settleConfirm(true));
    $('confirmCancel').addEventListener('click', () => settleConfirm(false));

    $('btnAuthLogin').addEventListener('click', () => {
      disarmRegister();
      authLogin('login');
    });
    $('btnAuthRegister').addEventListener('click', () => {
      if (!registerArmed) {
        registerArmed = true;
        $('authInviteRow').classList.remove('hidden');
        $('btnAuthRegister').textContent = '确认注册';
        $('btnAuthRegister').classList.add('primary');
        $('authInvite').focus();
        return;
      }
      authLogin('register');
    });
    $('btnAuthRedeem').addEventListener('click', () => authRedeem('authCode', 'authBalanceError'));
    $('btnAuthRefresh').addEventListener('click', async () => {
      await refreshAuth();
      toast('已刷新账号状态');
    });
    $('btnAuthLogout').addEventListener('click', authLogout);
    $('btnAuthClose').addEventListener('click', closeAuthGate);

    /* 手机号登录 / 找回密码 / 账号安全 */
    $('btnAuthTabEmail').addEventListener('click', () => switchAuthTab('email'));
    $('btnAuthTabPhone').addEventListener('click', () => switchAuthTab('phone'));
    $('btnSendSms').addEventListener('click', () => sendSmsCode('authPhone', 'btnSendSms', 'authPhoneError'));
    $('btnSmsLogin').addEventListener('click', authSmsLogin);
    $('btnForgotPassword').addEventListener('click', () => {
      $('authLoginPane').classList.add('hidden');
      $('authResetPane').classList.remove('hidden');
      setAuthError('resetError', '');
    });
    $('btnBackLogin').addEventListener('click', () => switchAuthTab('email'));
    $('btnResetSend').addEventListener('click', () => sendSmsCode('resetPhone', 'btnResetSend', 'resetError'));
    $('btnDoReset').addEventListener('click', submitResetPassword);
    $('btnCopyInvite').addEventListener('click', copyInvite);
    $('btnAccountExport').addEventListener('click', exportAccount);
    $('btnAccountPassword').addEventListener('click', () => $('passwordPane').classList.toggle('hidden'));
    $('btnCancelPassword').addEventListener('click', () => $('passwordPane').classList.add('hidden'));
    $('btnConfirmPassword').addEventListener('click', changePassword);
    $('btnAccountDelete').addEventListener('click', () => $('deletePane').classList.toggle('hidden'));
    $('btnCancelDelete').addEventListener('click', () => $('deletePane').classList.add('hidden'));
    $('btnConfirmDelete').addEventListener('click', deleteAccount);
    $('btnReopenOnboarding').addEventListener('click', reopenOnboarding);
    $('btnExportConfig').addEventListener('click', exportConfig);
    $('btnImportConfig').addEventListener('click', importConfig);
    $('btnResetConfig').addEventListener('click', resetConfig);

    /* 支付相关：入口由 PAY_UI_ENABLED 控制，关闭时按钮保持 hidden。 */
    $('btnBuyMinutes').addEventListener('click', openPurchase);
    $('btnPurchaseBack').addEventListener('click', closePurchase);
    $('planList').addEventListener('click', (event) => {
      const card = event.target.closest('.plan-card');
      if (card && card.dataset.plan) buyPlan(card.dataset.plan);
    });
    $('btnOpenPayPage').addEventListener('click', openPayPage);
    $('btnCheckPaid').addEventListener('click', () => {
      if (payOrder) checkOrder(payOrder.order_no, false);
    });
    $('btnCancelPay').addEventListener('click', resetPayPane);
    for (const id of ['authEmail', 'authPassword']) {
      $(id).addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        authLogin('login');
      });
    }
    bindCharCount('profileResume', 'resumeHint', 20000);
    bindCharCount('profileSyllabus', 'syllabusHint', 20000);
    $('btnTestMic').addEventListener('click', testMic);
    $('authCode').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      authRedeem('authCode', 'authBalanceError');
    });

    $('btnAccountRedeem').addEventListener('click', () => authRedeem('accountCode', 'accountError'));
    $('accountCode').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      authRedeem('accountCode', 'accountError');
    });
    $('btnAccountRefresh').addEventListener('click', async () => {
      await refreshAuth();
      toast('已刷新账号状态');
    });
    $('btnAccountLogout').addEventListener('click', authLogout);
    $('btnOpenAuth').addEventListener('click', openAuthGate);

    $('noticeAction').addEventListener('click', () => {
      if (noticeHandler) noticeHandler();
    });

    $('uiOpacity').addEventListener('input', (event) => {
      api.winSet('opacity', Number(event.target.value));
    });
    $('uiTheme').addEventListener('change', (event) => {
      applyTheme(event.target.value);
    });
    $('contentProtect').addEventListener('change', (event) => {
      api.winSet('protect', event.target.checked);
    });

    $('btnPhoneStart').addEventListener('click', async () => {
      const btn = $('btnPhoneStart');
      btn.disabled = true;
      btn.textContent = '生成中…';
      try {
        const result = await api.phoneStart();
        if (!result || !result.ok) {
          toast((result && result.error) || '手机副屏启动失败', true);
          return;
        }
        phoneInfo = { url: result.url, qr: result.qr };
        renderPhonePanel();
        toast('手机副屏已开启，用手机扫码即可');
      } catch (err) {
        toast(err.message || '手机副屏启动失败', true);
      } finally {
        btn.disabled = false;
        btn.textContent = '生成二维码';
      }
    });
    $('btnPhoneStop').addEventListener('click', async () => {
      await api.phoneStop();
      phoneInfo = null;
      renderPhonePanel();
    });

    bindHotkeyInputs();

    api.onAssetProgress((progress) => {
      if (!progress) return;
      setProgress(progress);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeSettings();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && authGateOpen) closeAuthGate();
    });
  }

  function markBooted() {
    const mask = $('bootMask');
    if (mask) mask.classList.add('hidden');
  }

  async function boot() {
    cfg = await api.getConfig();
    applyTheme(cfg.ui.theme);
    /* 恢复上次停留的模式；笔试模式不弹面试起始页。 */
    appMode = cfg.ui && cfg.ui.mode === 'written' ? 'written' : 'interview';
    paintMode(appMode);
    renderHotkeyInputs();
    audio = new window.InterviewAudio({
      onSegment: handleSegment,
      onSegmentDebug: (info) => logDiag('SEG', info),
      onLevel: (level) => { levelBar.style.width = `${(level * 100).toFixed(0)}%`; },
      onState: applyAudioState,
    });
    updateAsrMeta();
    restoreSnapshot();
    setInterval(saveSnapshot, 2000);

    btnListen.addEventListener('click', toggleListen);
    $('btnIdleStart').addEventListener('click', () => {
      markHeroDone();
      toggleListen();
    });
    $('btnIdleSkip').addEventListener('click', () => { markHeroDone(); });
    $('btnIdleSource').addEventListener('click', toggleSource);
    $('btnIdleAuto').addEventListener('click', toggleAutoAnswer);
    $('btnSource').addEventListener('click', toggleSource);
    $('btnProtect').addEventListener('click', toggleContentProtect);
    $('btnAutoAnswer').addEventListener('click', toggleAutoAnswer);
    $('btnClear').addEventListener('click', clearAll);
    $('btnCopy').addEventListener('click', async () => {
      if (!currentAnswer.trim()) return toast('还没有回答可以复制', true);
      await navigator.clipboard.writeText(currentAnswer);
      toast('已复制');
    });
    $('btnExport').addEventListener('click', exportSession);
    $('btnTestOutput').addEventListener('click', testOutput);
    $('btnCheckUpdate').addEventListener('click', async () => {
      const btn = $('btnCheckUpdate');
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = '检查中…';
      await checkUpdate(true);
      btn.disabled = false;
      btn.textContent = '检查更新';
    });
    $('updClose').addEventListener('click', skipUpdate);
    $('updLater').addEventListener('click', () => {
      if (updateDownloading) api.updateCancel();
      else skipUpdate();
    });
    $('updAction').addEventListener('click', startUpdate);
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', () => {
        const settings = $('settings');
        if (settings && !settings.classList.contains('hidden')) refreshAudioDevices();
      });
    }
    $('btnRegen').addEventListener('click', () => ask(currentQuestion, activeQid));
    $('btnStop').addEventListener('click', stopAnswer);
    $('btnDelQ').addEventListener('click', deleteQuestion);
    $('btnEditQ').addEventListener('click', editQuestion);
    $('btnHide').addEventListener('click', () => api.winSet('hide'));
    $('btnQuit').addEventListener('click', async () => {
      // 收音中直接退出会丢记录、也会让计费会话悬挂，先确认再退。
      if (audio && audio.listening) {
        const ok = await askConfirm('正在收音，退出会结束本次记录和计时。确定退出？', '退出');
        if (!ok) return;
      }
      api.winSet('quit');
    });
    $('qrailUser').addEventListener('click', toggleAccountMenu);
    $('accountMenuList').addEventListener('click', (event) => {
      const item = event.target.closest('[data-action]');
      if (item) handleAccountMenu(item.dataset.action);
    });
    document.addEventListener('click', (event) => {
      const dock = $('accountDock');
      if (dock && !dock.contains(event.target)) closeAccountMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') closeAccountMenu();
    });
    $('qrailList').addEventListener('click', (event) => {
      const chip = event.target.closest('.qchip');
      if (!chip) return;
      if (chip.dataset.windex !== undefined) {
        const index = Number(chip.dataset.windex);
        if (!writtenItems[index]) return;
        writtenActiveIndex = index;
        writtenActive = writtenItems[index];
        renderWrittenCurrent();
        renderWrittenRail($('qrailList'));
        return;
      }
      selectQuestion(Number(chip.dataset.qid));
    });
    $('qrailList').addEventListener('scroll', () => {
      hideRailPreview();
      syncQrailFade();
    }, { passive: true });
    /* 笔试截图卡的放大预览：进卡片显示，移出或滚动收起。 */
    $('qrailList').addEventListener('mouseover', showRailPreview);
    $('qrailList').addEventListener('mousemove', (event) => {
      const chip = event.target.closest('.qchip.written');
      if (chip) positionRailPreview(chip);
    });
    $('qrailList').addEventListener('mouseout', (event) => {
      const chip = event.target.closest('.qchip.written');
      if (!chip || chip.contains(event.relatedTarget)) return;
      hideRailPreview();
    });
    // 窗口拉高拉低、题目增减都会改变可滚动状态：跟着重新判断上下遮罩。
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(syncQrailFade).observe($('qrailList'));
    }
    transcriptEl.addEventListener('click', (event) => {
      const line = event.target.closest('.line.clickable');
      if (!line) return;
      const text = line.dataset.text || '';
      if (!text) return;
      const index = entries.findIndex((entry) => entry.text === text);
      const prev = index > 0 ? entries[index - 1].text : '';
      askLine(text, prev);
    });

    bindSettings();
    bindWritten();
    bindSplitters();
    bindOnboarding();
    applyPanelSizes();
    $('btnAnnounceClose').addEventListener('click', dismissAnnounce);
    await loadAppInfo();
    renderRail();
    renderQhead();
    syncIdle();
    new MutationObserver(() => syncIdle()).observe(transcriptEl, { childList: true });

    api.onDelta(({ id, delta }) => {
      const item = questions.find((q) => q.id === id);
      if (!item) return;
      item.answer += delta;
      if (id === activeQid) {
        currentAnswer = item.answer;
        scheduleRender();
        pushMiniState();
      }
    });
    api.onDone(({ id, text }) => {
      const item = questions.find((q) => q.id === id);
      if (!item) return;
      item.answer = text;
      item.status = 'done';
      renderRail();
      if (id === activeQid) {
        currentAnswer = text;
        answerMeta.textContent = '已完成';
        scheduleRender();
        pushMiniState();
      }
      setDot(audio.listening ? 'live' : '', audio.listening ? '正在听面试官' : '待启动');
    });
    api.onError(({ id, error }) => {
      const item = questions.find((q) => q.id === id);
      if (!item) return;
      item.status = 'error';
      renderRail();
      if (id === activeQid) answerMeta.textContent = '失败';
      toast(error, true);
      setDot('err', '生成失败');
      pushMiniState();
    });
    api.onAborted(({ id }) => {
      const item = questions.find((q) => q.id === id);
      if (item && item.status === 'streaming') {
        item.status = item.answer ? 'done' : 'pending';
        renderRail();
      }
      if (item) selectQuestion(id);
      if (id === activeQid) answerMeta.textContent = '已停止';
      if (askInFlight === id) {
        askInFlight = null;
        renderStopBtn(false);
      }
      pushMiniState();
    });

    api.onHotkeyAsk(answerLast);
    api.onHotkeyMini(openMiniEntry);
    api.onHotkeyQuestion((delta) => stepQuestion(Number(delta) < 0 ? -1 : 1));
    api.onHotkeyClear(() => {
      if (!miniOpen) {
        clearAll();
        return;
      }
      api.returnToMain().then(clearAll);
    });
    api.onClickThrough((value) => {
      const badge = $('throughBadge');
      if (badge) badge.classList.toggle('hidden', !value);
      const revealKey = (cfg && cfg.hotkeys && cfg.hotkeys.reveal) || 'Ctrl+Alt+M';
      toast(value ? `已开启鼠标穿透，${revealKey} 恢复` : '已恢复鼠标操作');
    });
    api.onHotkeyError((keys) => {
      if (!keys || !keys.length) return;
      toast(`快捷键 ${keys.join('、')} 被其他软件占用，可用界面按钮代替`, true);
    });
    api.onOpenSettings(() => openSettings('appearance'));
    api.onUpdateProgress((payload) => {
      if (!updateDownloading || !payload) return;
      const percent = Number.isFinite(payload.percent) ? Math.max(0, Math.min(100, payload.percent)) : 0;
      $('updBar').style.width = `${percent}%`;
      $('updProgressText').textContent = payload.text
        || (payload.total ? `${formatBytes(payload.received)} / ${formatBytes(payload.total)}` : formatBytes(payload.received));
    });

    api.onMiniOpened(() => {
      miniOpen = true;
      pushMiniState(true);
    });
    api.onMiniClosed(() => {
      miniOpen = false;
      clearTimeout(miniSyncTimer);
      miniSyncTimer = null;
    });
    api.onMiniAction(handleMiniAction);

    // 云端配置不阻塞首屏：先渲染本地状态，云端在后台补齐。
    authSyncing = true;
    renderAccountPanel();
    const cloudTask = refreshCloud();
    await refreshAll();
    renderSourceBtn();
    renderUserCard();
    cloudTask.catch(() => {});

    /* 首屏已经可交互，不再等 auth 网络。
     * 只有首次引导（setup 未完成）需要登录态来区分「升级老用户 / 真新用户」，这一种情况才等。 */
    if (cfg.setup && cfg.setup.done === true) {
      markBooted();
      refreshAuth().catch(() => {});
    } else {
      await refreshAuth();
      renderAccountPanel();
      markBooted();
    }

    if (!authTimerStarted) {
      authTimerStarted = true;
      setInterval(async () => {
        if (!cfg || !cfg.llm || cfg.llm.mode !== 'official') return;
        if (!authState || !authState.logged_in || usageSession) return;
        const wasActive = Boolean(authState.active);
        await refreshCloud();
        await refreshAuth();
        if (wasActive && authState && !authState.active && !authState.offline) {
          toast('剩余时长已用完，兑换时长码后可继续使用', true);
        }
      }, 10 * 60 * 1000);
    }

    if (!authState || !authState.active) {
      setDot('', '待启动');
    }

    await startAfterAuth();
    maybeAutoCheckUpdate();
  }

  /* 启动流程：登录不再是启动门槛，直接进入主界面；未登录时由引导的登录步骤和后续操作提示补上。 */
  async function startAfterAuth() {
    if (entered) return;
    await continueStartup();
  }

  /* 旧版本配置里没有 setup 字段，合并默认值后会变成「未完成」。
   * 只要已经留下真实使用痕迹，就按老用户处理，不再把首次引导当成主界面。 */
  function isReturningUser() {
    if (!cfg) return false;
    if (authState && authState.logged_in) return true;
    const profile = cfg.profile || {};
    if (profile.job || profile.resume || profile.syllabus) return true;
    const asr = cfg.asr || {};
    if (String(asr.hotwords || '').trim()) return true;
    if (asr.custom_presets && Object.keys(asr.custom_presets).length) return true;
    const llm = cfg.llm || {};
    return Boolean(llm.model || llm.api_key);
  }

  async function continueStartup() {
    if (entered) return;
    entered = true;
    closeAuthGate();
    renderSourceBtn();
    renderUserCard();

    if (!(cfg.setup && cfg.setup.done)) {
      if (isReturningUser()) {
        // 升级用户补一次完成标记，下次启动不再判断。
        try {
          cfg = await api.saveConfig({ setup: { done: true, hero_done: true } });
        } catch (err) {
          // 写不进去也不阻塞进入工作界面。
        }
      } else {
        setDot('busy', '首次初始化');
        await openOnboarding();
        return;
      }
    }

    if (cfg.asr.provider === 'llama') {
      if (assets && !assets.ready && !(asrState && asrState.available)) {
        setDot('busy', 'ASR 未就绪');
        updateNotice();
        return;
      }
      setDot('busy', '预热本地 ASR');
      api.warmupAsr().then(async (result) => {
        if (result.ok) setDot('', 'ASR 就绪');
        else setDot('err', 'ASR 不可用');
        await refreshAsrStatus();
        updateNotice();
      });
    } else {
      setDot('', '待启动');
    }
    updateNotice();
  }

  boot().catch((err) => {
    markBooted();
    console.error('[boot]', err);
    toast(`启动异常：${err.message}`, true);
  });
})();

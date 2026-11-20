(function () {
  var root = document.getElementById('demo');
  if (!root) return;

  var QUESTIONS = [
    {
      id: 'Q1',
      title: '自我介绍',
      text: '先简单做个自我介绍吧。',
      head: '【结论】3 年 AI 应用开发，做过从原型到上线的完整项目',
      points: [
        '3 年 Python 和 Node 后端经验，主要做 AI 应用落地。',
        '最近一年负责企业知识库问答，检索、重排和评测都是我做的。',
        '把回答准确率从 62% 提到 81%，首字延迟压到 1 秒以内。'
      ]
    },
    {
      id: 'Q2',
      title: '项目难点',
      text: '这个知识库项目，你觉得最难的地方是什么？',
      head: '【结论】难在召回和评测，不在模型本身',
      points: [
        '文档格式很杂，PDF、表格、扫描件都有，切片质量直接决定上限。',
        '只靠向量检索容易漏关键词，后来加了 BM25 做混合召回。',
        '没有评测集就无法判断改动有没有用，所以先补了一套 500 条的标注集。'
      ]
    },
    {
      id: 'Q3',
      title: '效果优化',
      text: '准确率是怎么从 62% 提到 81% 的？',
      head: '【结论】清洗、混合检索、重排，三步逐个验证',
      points: [
        '先做文档清洗，去掉页眉页脚和重复段落，按语义重新切片。',
        '召回改成向量加 BM25，再用小模型重排，Top5 命中率明显提升。',
        '每一步都跑同一套评测集，指标不涨就回滚，不靠感觉调参。'
      ]
    },
    {
      id: 'Q4',
      title: '线上问题',
      text: '如果模型接口超时或者被限流，你怎么处理？',
      head: '【结论】先降级保证可用，再补监控和容量',
      points: [
        '设置分级超时，超过阈值直接走缓存或更小的模型。',
        '请求排队加限流，避免一次把上游打满。',
        '把超时率、首字延迟和错误码打进监控，按天看趋势。'
      ]
    }
  ];

  var listenBtn = document.getElementById('demo-listen');
  var copyBtn = document.getElementById('demo-copy');
  var regenBtn = document.getElementById('demo-regen');
  var sourceBtn = document.getElementById('demo-source');
  var autoBtn = document.getElementById('demo-auto');
  var transcriptEl = document.getElementById('demo-transcript');
  var answerEl = document.getElementById('demo-answer');
  var qheadEl = document.getElementById('demo-qhead');
  var railList = document.getElementById('demo-rail-list');
  var stateEl = document.getElementById('demo-state');
  var transStateEl = document.getElementById('demo-trans-state');
  var answerStateEl = document.getElementById('demo-answer-state');
  var dotEl = document.getElementById('demo-dot');
  var levelEl = document.getElementById('demo-level');
  var interviewStage = root.querySelector('.app-stage-interview');
  var writtenStage = document.getElementById('demo-written');
  var ocrStateEl = document.getElementById('demo-ocr-state');
  var modeTabs = document.querySelectorAll('[data-demo-mode]');

  var HINT_TRANS = '点「开始听面试官」，面试官说话会实时转成文字。';
  var HINT_ANSWER = '识别到问题后会自动生成，也可以点右侧题号重新作答。';
  var HINT_QHEAD = '识别到问题后自动编号，点右侧 Q1/Q2 可回看';

  var timers = [];
  var levelTimer = null;
  var gen = 0;
  var answerToken = 0;
  var listening = false;
  var activeIndex = -1;
  var answerText = '';
  var clock = 0;
  var mode = 'interview';
  var source = '麦克风';

  function stopTimers() {
    timers.forEach(function (id) { clearTimeout(id); });
    timers = [];
  }

  function later(fn, ms, g) {
    var id = setTimeout(function () {
      if (g === gen) fn();
    }, ms);
    timers.push(id);
    return id;
  }

  function clearNode(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function showHint(el, text) {
    clearNode(el);
    var p = document.createElement('div');
    p.className = 'app-empty';
    p.textContent = text;
    el.appendChild(p);
  }

  function tickClock() {
    clock += 1;
    var m = Math.floor(clock / 60);
    var s = clock % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function startLevel() {
    stopLevel();
    levelTimer = setInterval(function () {
      var v = listening ? 12 + Math.random() * 52 : 0;
      levelEl.style.width = v.toFixed(0) + '%';
    }, 130);
  }

  function stopLevel() {
    if (levelTimer) clearInterval(levelTimer);
    levelTimer = null;
    levelEl.style.width = '0%';
  }

  function setQHead(text, isEmpty) {
    qheadEl.textContent = text;
    qheadEl.classList.toggle('empty', !!isEmpty);
  }

  function setAnswerHint(text) {
    showHint(answerEl, text || HINT_ANSWER);
  }

  function reset() {
    gen++;
    answerToken++;
    stopTimers();
    stopLevel();
    listening = false;
    activeIndex = -1;
    answerText = '';
    clock = 0;
    showHint(transcriptEl, HINT_TRANS);
    clearNode(railList);
    var empty = document.createElement('div');
    empty.className = 'app-qrail-empty';
    empty.textContent = 'Q';
    railList.appendChild(empty);
    setAnswerHint();
    setQHead(HINT_QHEAD, true);
    if (mode === 'interview') {
      stateEl.textContent = '待启动';
      listenBtn.textContent = '开始听面试官';
      listenBtn.classList.remove('listening');
    }
    transStateEl.textContent = '云端 ASR';
    answerStateEl.textContent = '';
    copyBtn.disabled = true;
    regenBtn.disabled = true;
    dotEl.className = 'app-dot';
  }

  function scrollBottom(el) {
    el.scrollTop = el.scrollHeight;
  }

  function typeOut(el, text, g, done) {
    var i = 0;
    var step = Math.max(1, Math.ceil(text.length / 40));
    el.textContent = '';

    function tick() {
      if (g !== gen) return;
      i = Math.min(text.length, i + step);
      el.textContent = text.slice(0, i);
      scrollBottom(transcriptEl);
      if (i < text.length) later(tick, 24, g);
      else if (done) done();
    }

    tick();
  }

  function renderRailEmptyOff() {
    var placeholder = railList.querySelector('.app-qrail-empty');
    if (placeholder && placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
  }

  function markRail(index, state) {
    var chip = railList.querySelector('[data-index="' + index + '"]');
    if (!chip) return;
    var dot = chip.querySelector('.app-qdot');
    if (dot) dot.className = 'app-qdot' + (state ? ' ' + state : '');
  }

  function setActiveChip(index) {
    Array.prototype.forEach.call(railList.querySelectorAll('.app-qchip'), function (chip) {
      chip.classList.toggle('active', Number(chip.dataset.index) === index);
    });
  }

  function generateAnswer(index, g, fromUser) {
    var q = QUESTIONS[index];
    if (!q) return;

    answerToken++;
    var token = answerToken;
    activeIndex = index;
    setActiveChip(index);
    setQHead(q.id + ' · ' + q.text, false);

    clearNode(answerEl);
    var head = document.createElement('span');
    head.className = 'a-head';
    head.textContent = q.head;
    answerEl.appendChild(head);

    answerStateEl.textContent = '生成中';
    markRail(index, 'stream');
    answerText = '';

    var i = 0;

    function nextPoint() {
      if (g !== gen || token !== answerToken) return;
      if (i >= q.points.length) {
        answerStateEl.textContent = '已完成';
        markRail(index, 'ok');
        copyBtn.disabled = false;
        regenBtn.disabled = false;
        if (listening) dotEl.className = 'app-dot live';
        return;
      }
      var p = document.createElement('span');
      p.className = 'a-point';
      p.textContent = q.points[i];
      answerEl.appendChild(p);
      answerText += (answerText ? '\n' : '') + q.points[i];
      scrollBottom(answerEl);
      i++;
      later(nextPoint, fromUser ? 260 : 520, g);
    }

    later(nextPoint, fromUser ? 90 : 200, g);
  }

  function askQuestion(index, g) {
    var q = QUESTIONS[index];

    if (transcriptEl.querySelector('.app-empty')) clearNode(transcriptEl);

    var line = document.createElement('div');
    line.className = 't-line live';

    var time = document.createElement('span');
    time.className = 'time';
    time.textContent = tickClock();

    var textEl = document.createElement('span');
    textEl.className = 't-text';

    var caret = document.createElement('span');
    caret.className = 'caret';

    line.appendChild(time);
    line.appendChild(textEl);
    line.appendChild(caret);
    transcriptEl.appendChild(line);
    scrollBottom(transcriptEl);

    renderRailEmptyOff();
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'app-qchip';
    chip.dataset.index = String(index);
    chip.textContent = q.id;
    var dot = document.createElement('span');
    dot.className = 'app-qdot';
    chip.appendChild(dot);
    chip.addEventListener('click', function () {
      generateAnswer(index, gen, true);
    });
    railList.appendChild(chip);
    markRail(index, 'stream');

    activeIndex = index;
    setActiveChip(index);
    transStateEl.textContent = '云端 ASR · 转写中';

    typeOut(textEl, q.text, g, function () {
      line.classList.remove('live');
      if (caret.parentNode) caret.parentNode.removeChild(caret);
      generateAnswer(index, g, false);
    });
  }

  function startDemo() {
    reset();
    var g = gen;
    listening = true;
    clock = 0;
    stateEl.textContent = '收听中';
    transStateEl.textContent = '云端 ASR · 监听中';
    listenBtn.textContent = '停止收听';
    listenBtn.classList.add('listening');
    dotEl.className = 'app-dot live';
    startLevel();

    QUESTIONS.forEach(function (_, index) {
      later(function () {
        if (!listening) return;
        askQuestion(index, g);
      }, index * 2900 + 400, g);
    });

    later(function () {
      listening = false;
      stateEl.textContent = '已暂停';
      transStateEl.textContent = '已暂停';
      answerStateEl.textContent = '已生成';
      listenBtn.textContent = '重新开始';
      listenBtn.classList.remove('listening');
      dotEl.className = 'app-dot';
      stopLevel();
    }, QUESTIONS.length * 2900 + 3600, g);
  }

  function stopDemo() {
    listening = false;
    stopTimers();
    stopLevel();
    Array.prototype.forEach.call(transcriptEl.querySelectorAll('.caret'), function (c) {
      if (c.parentNode) c.parentNode.removeChild(c);
    });
    Array.prototype.forEach.call(transcriptEl.querySelectorAll('.t-line.live'), function (line) {
      line.classList.remove('live');
    });
    stateEl.textContent = '已暂停';
    transStateEl.textContent = '已暂停';
    listenBtn.textContent = '继续收听';
    listenBtn.classList.remove('listening');
    dotEl.className = 'app-dot';
  }

  function copyAnswer() {
    if (!answerText) return;
    var done = function () {
      var prev = answerStateEl.textContent;
      answerStateEl.textContent = '已复制';
      setTimeout(function () {
        if (answerStateEl.textContent === '已复制') answerStateEl.textContent = prev || '已生成';
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(answerText).then(done, done);
      return;
    }
    var area = document.createElement('textarea');
    area.value = answerText;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(area);
    done();
  }

  function runWrittenDemo() {
    if (!ocrStateEl) return;
    ocrStateEl.textContent = '识别中…';
    setTimeout(function () {
      if (mode === 'written') ocrStateEl.textContent = '已识别 · 0.8s';
    }, 900);
  }

  var WRITTEN = [
    {
      title: 'Q1 · 第 1 题 / 共 2 题',
      question: '给定一个整数数组 nums 和一个目标值 target，请返回和为 target 的两个元素的下标。',
      sample: '输入：nums = [2,7,11,15], target = 9\n输出：[0,1]',
      code: '<span class="kw">def</span> two_sum(nums, target):\n    seen = {}\n    <span class="kw">for</span> i, n <span class="kw">in</span> enumerate(nums):\n        <span class="kw">if</span> target - n <span class="kw">in</span> seen:\n            <span class="kw">return</span> [seen[target - n], i]\n        seen[n] = i\n    <span class="kw">return</span> []',
      note: '哈希表一次遍历，时间 O(n)，空间 O(n)。'
    },
    {
      title: 'Q2 · 第 2 题 / 共 2 题',
      question: '给定一个单链表的头节点 head，请反转链表并返回新的头节点。',
      sample: '输入：1 → 2 → 3 → 4 → 5\n输出：5 → 4 → 3 → 2 → 1',
      code: '<span class="kw">def</span> reverse_list(head):\n    prev = <span class="kw">None</span>\n    <span class="kw">while</span> head:\n        nxt = head.next\n        head.next = prev\n        prev = head\n        head = nxt\n    <span class="kw">return</span> prev',
      note: '原地反转，时间 O(n)，空间 O(1)。'
    }
  ];

  var writtenIndex = 0;
  var writtenRail = document.getElementById('demo-written-rail');
  var writtenTitleEl = document.getElementById('demo-written-title');
  var writtenQuestionEl = document.getElementById('demo-written-question');
  var writtenSampleEl = document.getElementById('demo-written-sample');
  var writtenCodeEl = document.getElementById('demo-written-code');
  var writtenNoteEl = document.getElementById('demo-written-note');

  function renderWritten(index) {
    var item = WRITTEN[index];
    if (!item || !writtenTitleEl) return;
    writtenIndex = index;
    writtenTitleEl.textContent = item.title;
    writtenQuestionEl.textContent = item.question;
    writtenSampleEl.textContent = item.sample;
    writtenCodeEl.innerHTML = item.code;
    writtenNoteEl.textContent = item.note;
    if (ocrStateEl) ocrStateEl.textContent = '已识别 · 0.8s';
    if (writtenRail) {
      Array.prototype.forEach.call(writtenRail.querySelectorAll('[data-written]'), function (chip) {
        chip.classList.toggle('active', Number(chip.dataset.written) === index);
      });
    }
  }

  if (writtenRail) {
    writtenRail.addEventListener('click', function (event) {
      var chip = event.target.closest('[data-written]');
      if (chip) renderWritten(Number(chip.dataset.written));
    });
  }

  function setMode(next) {
    mode = next;
    Array.prototype.forEach.call(modeTabs, function (tab) {
      tab.classList.toggle('active', tab.dataset.demoMode === next);
    });
    if (interviewStage) interviewStage.classList.toggle('app-hidden', next !== 'interview');
    if (writtenStage) writtenStage.classList.toggle('app-hidden', next !== 'written');
    if (root) root.classList.toggle('is-written', next === 'written');

    if (next === 'written') {
      stopDemo();
      stateEl.textContent = '笔试';
      transStateEl.textContent = '云端 ASR';
      listenBtn.textContent = '框选题目';
      listenBtn.classList.remove('listening');
      renderWritten(writtenIndex);
    } else {
      reset();
    }
  }

  Array.prototype.forEach.call(modeTabs, function (tab) {
    tab.addEventListener('click', function () {
      if (tab.dataset.demoMode !== mode) setMode(tab.dataset.demoMode);
    });
  });

  listenBtn.addEventListener('click', function () {
    if (mode === 'written') {
      runWrittenDemo();
      return;
    }
    if (listening) stopDemo();
    else startDemo();
  });

  if (sourceBtn) {
    sourceBtn.addEventListener('click', function () {
      source = source === '麦克风' ? '电脑声音' : '麦克风';
      sourceBtn.querySelector('span').textContent = source;
      if (listening) transStateEl.textContent = '云端 ASR · 监听中';
    });
  }

  if (autoBtn) {
    autoBtn.addEventListener('click', function () {
      autoBtn.classList.toggle('off');
    });
  }

  copyBtn.addEventListener('click', copyAnswer);
  regenBtn.addEventListener('click', function () {
    if (activeIndex >= 0) generateAnswer(activeIndex, gen, true);
  });

  var themeBtn = document.getElementById('demo-theme');
  var shotEl = root.querySelector('.app-shot');
  if (themeBtn && shotEl) {
    themeBtn.addEventListener('click', function () {
      var dark = shotEl.getAttribute('data-theme') === 'dark';
      shotEl.setAttribute('data-theme', dark ? 'light' : 'dark');
      themeBtn.title = dark ? '切换到深色' : '切换到浅色';
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-demo-start]'), function (el) {
    el.addEventListener('click', function (event) {
      event.preventDefault();
      root.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (!listening) startDemo();
    });
  });

  reset();
})();

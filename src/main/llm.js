/* 大模型：流式生成候选人可以照着说的回答。
 *
 * 网关是 OpenAI 兼容的，直接走 /chat/completions + stream。
 */
const config = require('./config');
const auth = require('./auth');

const STRUCTURED_SYSTEM = `你是候选人面试现场的回答提词器，适用于任何行业和岗位：互联网、金融、销售、市场、教育、医疗、制造、行政、设计、客服、运营、公务员、事业单位等。面试官刚说完问题，候选人需要在 2 秒内开口回答。

写作要求：
1. 面试官的话来自语音识别，可能有同音错字、漏字或断句，先结合上下文还原真实问题再回答。
2. 先按岗位和行业判断题型：专业题给出该行业的关键术语和可验证结论，行为题用 STAR 压缩，开放题给出有取舍的观点。判断不出行业时，用通用可迁移经验回答。单一事实题（姓名、年龄、学历、工作年限、薪资等）只回答事实本身，不要扩展成自我介绍或项目经历；只有明确问「介绍一下自己 / 优势 / 项目」时才展开。
3. 第一行先用【结论】给出一句话核心观点，必须能直接说出口。
4. 再按下方【回答详略】给要点：极简只留 1 条，简洁 / 标准给 2-3 条，详细 / 深入可到 4-5 条；每条一句话，不超过 30 字；尽量带具体动作、对象和结果，不要空话套话。
5. 第一人称口语，像真人在说话。不要“首先/其次/综上所述”这种播音腔，不要复述问题，不要写“你可以回答”之类的旁白。
6. 背景里没有的姓名、年龄、学校、公司、项目、年限、数字、指标，绝对不要编造。问姓名而背景里没有时，只写「[姓名]」，不要给自己起名，也不要复用面试官提到的任何名字；自我介绍只用背景里已有的信息，缺失的项用「[学校]」「[公司]」「[年限]」占位，不要编具体内容。需要案例但背景里没有真实细节时，直接用概括的第一人称说法（如「之前有个项目里，我遇到过类似情况」），绝对不要输出「（换成你经历里的真实案例）」这类占位符，也不要在答案里写任何给人看的提示、括号备注或说明。
7. 没有真实数据时用「不多」「占比较低」「明显下降」这类定性说法，不要编造具体数量或比例（如「几十笔」「大概三成」）。追问涉及量级、金额、人数、时长而背景里没有数据时，先说定性判断再转去讲做法，一个数字都不要给。
8. 全文长度按下方【回答详略】控制，宁短勿长。
9. 面试官用英文提问时用英文回答；中英混合时跟随主要语言。回答语言必须和提问一致。

只输出一份答案正文：第一行【结论】，随后每行一条要点。全文只出现一次【结论】，不要输出【回答详略】【要点】这类小标题，不要重复两遍答案，不要前言、后记、括号备注。`;

const ORAL_SYSTEM = `你是候选人面试现场的回答提词器，适用于任何行业和岗位：互联网、金融、销售、市场、教育、医疗、制造、行政、设计、客服、运营、公务员、事业单位等。面试官刚说完问题，候选人需要在 2 秒内开口，而且答案要能直接照着念出来。

回答要求：
1. 面试官的话来自语音识别，可能有同音错字、漏字或断句，先结合上下文还原真实问题再回答。
2. 开口第一句直接给结论，用第一人称口语，像真人刚开口；不要复述问题。
3. 全部用短句。一句话只表达一个意思，尽量不超过 25 个字，能断句就断句。
4. 用口语词，不要书面腔的过渡语：不要“首先、其次、此外、综上所述、值得注意的是、总的来说、由此可见”等；不要“你可以回答、建议你、希望对你有帮助”等旁白。
5. 只输出可以直接念出来的正文。不要 Markdown、列表符号、编号、加粗、【】标签、括号备注、结尾总结或反问。
6. 专业题带行业术语和可验证结论；行为题用 STAR 讲清情境、动作、结果；开放题给出有取舍的观点。判断不出行业时，用通用可迁移经验。单一事实题（姓名、年龄、学历、工作年限、薪资等）只回答事实本身，不要扩展成自我介绍或项目经历。
7. 背景里没有的姓名、年龄、学校、公司、项目、年限、数字、指标不要编造。问姓名而背景里没有时，只念「我叫[姓名]」，不要自己起名，也不要复用面试官提到的名字；自我介绍只用背景里有的信息，缺失的用「[学校]」「[公司]」「[年限]」占位。没有真实数据时用「不多」「占比较低」这类定性说法，不要编具体数量（如「几十笔」「大概三成」）。需要举例但没有真实细节时，用概括说法，不要留“（换成你的经历）”之类占位符。
8. 口语化不等于丢信息：题干或参考答案里的关键前提、阈值和数字（例如「容量≥64」）必须说全，条件不能省略或含糊成「容量比较大」。
9. 面试官用英文提问就用英文回答；中英混合时跟随主要语言。回答语言必须和提问一致。
10. 不要输出解释、前言、后记或任何格式说明。`;

const DETAIL_RULES = {
  1: '回答详略：极简。控制在 1-2 句、40 字以内，只给结论和一个最关键的理由。',
  2: '回答详略：简洁。控制在 2-3 句、60-100 字，只保留结论和一条支撑。',
  3: '回答详略：标准。控制在 3-5 句、100-160 字，结论之后给两三个具体做法。',
  4: '回答详略：详细。控制在 5-7 句、160-260 字，补一个具体做法或结果。',
  5: '回答详略：深入。控制在 6-9 句、260-360 字，除了结论和做法，再讲清取舍、风险或结果，不要空泛。',
};

function detailRule(detail) {
  const value = Math.max(1, Math.min(5, Number(detail) || 3));
  return DETAIL_RULES[value];
}

function profileBlock(profile) {
  const lines = [];
  if (profile && profile.job && profile.job.trim()) {
    lines.push(`【岗位 / 面试背景】\n${profile.job.trim()}`);
  }
  if (profile && profile.resume && profile.resume.trim()) {
    lines.push(`【候选人简历】\n${profile.resume.trim()}`);
  }
  if (profile && profile.syllabus && profile.syllabus.trim()) {
    lines.push(`【考试大纲 / 考试范围】\n${profile.syllabus.trim().slice(0, 4000)}`);
  }
  return lines.join('\n\n');
}

function buildMessages(profile, history, question, answerDetail, answerOral, recentQA) {
  const context = [];
  const block = profileBlock(profile);
  if (block) context.push({ role: 'system', content: `${block}\n\n以上是候选人的真实背景与考试范围，回答必须与之吻合。` });
  if (Array.isArray(history) && history.length) {
    const lines = history.slice(-8).map((item) => `面试官：${item}`).join('\n');
    context.push({ role: 'user', content: `【面试官前面说过的话，供理解上下文】\n${lines}` });
  }
  // 追问时要知道上一轮已经答过什么，否则容易重复或前后矛盾；只带最近两组，答案截断控制 token。
  if (Array.isArray(recentQA) && recentQA.length) {
    const rounds = recentQA.slice(-2).map((item) => {
      const q = String((item && item.question) || '').trim().slice(0, 200);
      const a = String((item && item.answer) || '').trim().slice(0, 400);
      return q && a ? `问：${q}\n答：${a}` : '';
    }).filter(Boolean);
    if (rounds.length) {
      context.push({ role: 'user', content: `【最近已回答过的问题，供保持前后一致，不要重复】\n${rounds.join('\n\n')}` });
    }
  }
  return [
    { role: 'system', content: `${answerOral ? ORAL_SYSTEM : STRUCTURED_SYSTEM}\n\n${detailRule(answerDetail)}` },
    ...context,
    { role: 'user', content: `【面试官刚说的内容】\n${question}\n\n请直接给出回答提词。` },
  ];
}

/* 模型偶尔会把「【结论】」当小标题再写一遍，或者行尾多出空格。
 * 这里只做确定性清理，不改内容：重复的【结论】前缀去掉保留句子，口语模式压掉空行。 */
function tidyAnswer(text, oral) {
  const lines = String(text || '').replace(/[ \t]+$/gm, '').split('\n');
  let seenHead = false;
  const out = [];
  for (const line of lines) {
    if (line.startsWith('【结论】')) {
      const body = line.slice(4).trim();
      if (seenHead && body) {
        out.push(body);
        continue;
      }
      seenHead = true;
      out.push(body ? `【结论】${body}` : '【结论】');
      continue;
    }
    out.push(line);
  }
  let joined = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (oral) joined = joined.replace(/\n{2,}/g, '\n');
  return joined;
}

function joinUrl(base) {
  return `${String(base || '').replace(/\/$/, '')}/chat/completions`;
}

function modelsUrl(base) {
  return `${String(base || '').replace(/\/$/, '')}/models`;
}

/* 用接口地址和 Key 拉取可用模型列表，供设置页「获取模型」使用。 */
async function listModels(payload = {}) {
  const base = String(payload.base_url || '').trim();
  const key = String(payload.api_key || '').trim();
  if (!base) throw new Error('先填接口地址');
  if (!key) throw new Error('先填 API Key');

  const response = await fetch(modelsUrl(base), {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(await describeError(response));

  const data = await response.json().catch(() => ({}));
  const list = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const ids = list
    .map((item) => String((item && item.id) || item || '').trim())
    .filter(Boolean);
  return Array.from(new Set(ids));
}

/* 两种接入方式：
 *   official —— 默认。登录后用官方中转，按使用时长扣费；
 *   own      —— 高级选项。用户自己的 OpenAI 兼容网关，客户端直连、不产生官方费用。
 * 中转地址跟随账号服务地址，用户不需要知道也不需要填域名。 */
function resolveAccess(llm) {
  if (llm.mode === 'own') {
    const base = String(llm.base_url || '').trim();
    const key = String(llm.api_key || '').trim();
    const model = String(llm.model || '').trim();
    if (!base || !key || !model) {
      throw new Error('自定义大模型未配置完整：请填写接口地址、API Key 和模型名');
    }
    return { base_url: base, api_key: key, model };
  }
  /* 官方接入：登录态优先，旧的、手填过的 official_key 只作为未登录时的兜底。 */
  const key = auth.token() || llm.official_key;
  if (!key) {
    throw new Error('请先登录账号后再使用（设置 → 大模型 → 登录 / 查看余额）');
  }
  return {
    base_url: `${auth.baseUrl()}/v1`,
    api_key: key,
    model: llm.official_model || 'interview-copilot',
  };
}

/* 官方接入中转发的是 OpenAI 兼容错误体（{ error: { message, type } }），
 * 自己接入的网关多半也是这种结构，统一取 message；按 type 给出能直接照做的提示。 */
const RELAY_HINTS = {
  usage_not_started: '官方接入需要先点「开始听面试官」，点开始后才按分钟扣时长',
  insufficient_quota: '剩余时长不足，请在账号页兑换时长码后再用',
  invalid_api_key: '官方接入登录已失效，请在设置 → 大模型中重新登录账号',
  relay_disabled: '官方接入暂未开启，请先在设置里改用自己的模型',
};

async function describeError(response) {
  const raw = (await response.text()).slice(0, 500);
  let message = raw;
  let type = '';
  try {
    const json = JSON.parse(raw);
    const error = json && json.error;
    if (error && typeof error === 'object') {
      message = String(error.message || message);
      type = String(error.type || '');
    } else if (typeof error === 'string') {
      message = error;
    }
  } catch (err) {
    // 非 JSON 响应（HTML 网关错误页等），保留原文
  }
  if (RELAY_HINTS[type]) return RELAY_HINTS[type];
  if (response.status === 401) return '大模型 Key 无效或已过期，请检查设置';
  return `大模型调用失败（HTTP ${response.status}）：${message}`;
}

/* 流式回答的两道看门狗：网关连上但不吐字、或吐到一半卡住，都不能让界面无限等。
 * 首字 12 秒、总时长 60 秒，超时用独立的 AbortController 中断，和用户手动停止区分开。 */
const FIRST_TOKEN_MS = 12000;
const ANSWER_TOTAL_MS = 60000;

async function streamAnswer(question, opts = {}) {
  const settings = config.load();
  const llm = settings.llm;
  const access = resolveAccess(llm);
  const model = access.model;
  const detail = Math.max(1, Math.min(5, Number(llm.answer_detail) || 3));
  const oral = Boolean(llm.answer_oral);

  const messages = buildMessages(settings.profile, opts.history || [], question, detail, oral, opts.recentQA || []);
  const userSignal = opts.signal;
  const controller = new AbortController();
  let timedOut = '';
  const abortFromUser = () => controller.abort();
  if (userSignal) {
    if (userSignal.aborted) controller.abort();
    else userSignal.addEventListener('abort', abortFromUser, { once: true });
  }
  const firstTokenTimer = setTimeout(() => {
    if (timedOut) return;
    timedOut = 'first';
    controller.abort();
  }, FIRST_TOKEN_MS);
  const totalTimer = setTimeout(() => {
    if (timedOut) return;
    timedOut = 'total';
    controller.abort();
  }, ANSWER_TOTAL_MS);

  try {
    const response = await fetch(joinUrl(access.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.api_key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: Number(llm.temperature) || 0.4,
        max_tokens: [140, 220, 320, 420, 500][detail - 1],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await describeError(response));
    }

    const onDelta = opts.onDelta || (() => {});
    let full = '';
    let gotFirst = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            if (!gotFirst) {
              gotFirst = true;
              clearTimeout(firstTokenTimer);
            }
            full += delta;
            onDelta(delta);
          }
        } catch (err) {
          // 半截 JSON 忽略即可，下一帧会补上
        }
      }
    }

    return tidyAnswer(full, oral);
  } catch (err) {
    if (timedOut) {
      const seconds = Math.round((timedOut === 'first' ? FIRST_TOKEN_MS : ANSWER_TOTAL_MS) / 1000);
      const message = timedOut === 'first'
        ? `回答生成超时：${seconds} 秒内没有开始返回，请重试`
        : `回答生成超时：超过 ${seconds} 秒未完成，请重试`;
      const timeout = new Error(message);
      timeout.timeout = true;
      timeout.code = timedOut === 'first' ? 'first_token_timeout' : 'total_timeout';
      throw timeout;
    }
    if (userSignal && userSignal.aborted) {
      const stopped = new Error('已停止生成');
      stopped.aborted = true;
      throw stopped;
    }
    throw err;
  } finally {
    clearTimeout(firstTokenTimer);
    clearTimeout(totalTimer);
    if (userSignal) userSignal.removeEventListener('abort', abortFromUser);
  }
}

/* 笔试题：输入是 OCR / 视觉模型还原出的题目文字，输出答案。与非流式接口共用同一套鉴权与中转。 */
const WRITTEN_SYSTEM = `你是笔试答题助手。用户给的是从屏幕截图识别出的题目，可能有错别字、断行或排版错误。
先还原题意，再给出可直接作答的答案：
- 选择题：先给正确选项，再给一句理由；多选题列全。
- 代码题：给出完整可运行代码，注明语言，关键处短注释。
- 问答题：结论先行，分点，控制篇幅。
- 数学/公式：给出推导关键步骤和最终结果。
识别文字明显有错时，按最合理的原题理解，并在开头用一句话说明你的理解。
不要编造题目中没有的条件；无法确定时给出最可能的解法并说明假设。
只输出答案，不要客套。`;

async function solveText(text, opts = {}) {
  const settings = config.load();
  const access = resolveAccess(settings.llm);
  const model = access.model;
  const question = String(text || '').trim();
  if (!question) throw new Error('没有识别到题目文字');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(joinUrl(access.base_url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${access.api_key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: WRITTEN_SYSTEM },
          { role: 'user', content: question },
        ],
        temperature: 0.3,
        max_tokens: 1200,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await describeError(response));
    const data = await response.json();
    const answer = String(data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content || '').trim();
    if (!answer) throw new Error('模型没有返回内容，请重试');
    return { answer, usage: data.usage || null };
  } catch (err) {
    if (controller.signal.aborted) throw new Error('回答超时，请重试');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { streamAnswer, buildMessages, listModels, solveText };

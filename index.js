/**
 * dsh-judge — 「审判员」插件
 *
 * 在 agent 想结束一轮对话（即将把最终答案交给用户）之前，由一个独立的
 * 审判模型复核这份答案；不通过就通过 `agent.steer()` 把「驳回意见」塞回
 * 下一步，让主模型补齐证据 / 降级表述后重新作答。轮次在通过前不会关闭。
 *
 * 关键扩展点（来自 @deepseek-ai/dsh-agent-loop 的实现）：
 *   loop 在 `turnEnds && inbox.nextStep.length === 0` 时 dispatch
 *   `agent/turn-stopping`；dispatch 之后会重新检查 nextStep 长度——
 *   监听器只要在 hook 里 steer 一条消息，循环就不会 break，而是进入
 *   `target = 'next-step'` 的下一轮，模型会看到这条消息。
 *   事件 payload 由 dsh-agent 的 `agentEvents` 融合注入：{ turn, signal, agent }。
 *
 * 本文件刻意不 import 任何 @deepseek-ai/* 包：外部插件位于 profile 的
 * node_modules 之外，裸导入 core 包并不可靠；这里只依赖 ctx 服务。
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const name = 'dsh-judge';

/** 需要的宿主服务：模型调用、系统提示词、工具注册表。 */
export const inject = ['llm', 'systemPrompt', 'tools'];

const DEFAULTS = {
  enabled: true,
  /** 只记录判定、不真正驳回（首次部署建议先开 dryRun 观察几天）。 */
  dryRun: false,
  /** 低于这个字符数的答案不审（寒暄、一句确认）。 */
  minAnswerChars: 40,
  /** 同一轮最多驳回几次；到上限后放行并记录 warn，防止死循环。设为 0 等于只看不拦。 */
  maxAttempts: 1,
  /** 审判调用失败时的策略：'allow' 放行（可用优先）/ 'revise' 驳回（正确优先）。 */
  onJudgeError: 'allow',
  /** 跳过子代理会话（子代理的答案会汇总到父代理，父代理那层还会再审）。 */
  skipSubagents: true,
  /** 驳回意见语言：'zh' | 'en'。 */
  language: 'zh',
  /** 审判模型路由；留空则沿用当前会话的 provider/model。 */
  judgeProvider: '',
  judgeModel: '',
  judgeMaxTokens: 3000,
  /** 送进审判员的转录总字符预算（保留最近的）。 */
  transcriptChars: 8000,
  /** 单条工具结果最多保留多少字符。 */
  toolResultChars: 1200,
  /** 是否注册 `judge_review` 工具，让模型在“写正文之前”先送审草稿。 */
  submitTool: true,
  /** 系统提示词段落在组装顺序里的位置（越大越靠后）。 */
  promptOrder: 900,
  /** 覆盖内置的审判员契约文本（留空用内置）。 */
  contract: '',
  /** 整个会话最多驳回几次（跨轮累计）；超过后只判定不打断，避免复杂任务里反复拉扯。 */
  sessionRejectBudget: 4,
  /** 跳过寒暄/纯确认类答案（不调用审判模型）。 */
  skipTrivial: true,
  /**
   * Jev（TypeSafe System One）廉价预筛。开启后先用 Noul 概率判断"这份答案有没有
   * 缺证据/自相矛盾的事实断言"：低风险直接放行、不调用大模型审判；高风险才升级。
   * 默认关闭，先用真实数据校准 riskThreshold 再打开。
   */
  jev: {
    enabled: false,
    baseUrl: 'https://api.typesafe.ai',
    model: 'jev-latest',
    /** 空 = 直连；本机被区域限制时填本地代理，如 http://127.0.0.1:10809 */
    proxyUrl: '',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    apiKeyFile: 'C:/Users/XY/.typesafe/api-key.txt',
    /** 送给 Jev 的 state 截断长度（字符）。 */
    stateChars: 4000,
    /** 风险概率 >= 该值才升级到大模型审判；Noul 0.5 表示是非各半。 */
    riskThreshold: 0.5,
    timeoutMs: 12000,
    /** Jev 调用失败时：judge = 回退到大模型审判（默认）/ pass = 放行。 */
    onError: 'judge',
  },
};

const JUDGE_POLICY = `你是 DeepSeek Harness 的「审判员」。你在主模型即将把答案交给用户之前，对这份答案做事实核查。你不与用户对话，只输出一个 JSON 判定。

核查目标：答案里的事实性断言必须有证据，没有证据的必须被降级为「不确定/未核实」，不能以确定语气输出。

判定规则：
1. 事实性断言 = 具体的版本号、API/函数签名、参数名、文件路径、数字、日期、人名、引文、规范条文、兼容性结论、"官方文档说…"之类的二手说法。
2. 只要一条事实性断言出现在答案里，就必须满足以下之一，否则记一条 issue：
   a) 本会话的工具结果直接支持它（read / grep / web_fetch / web_search / 命令输出等）；
   b) 它属于稳定的常识，写错也不会造成实际损失；
   c) 答案已明确标注「未核实 / 不确定 / 需确认」并说明原因。
3. 特别注意"二手答案"：模型声称"文档说""我知道""一般来说""某处提到"而不能指向本会话里的工具证据时，一律算 unsupported。
4. 检查答案与工具结果是否矛盾（contradicted）：例如工具输出报错/为空，而答案却说成功或存在。
5. 检查过度外推（overreach）：工具只验证了 A，答案却断言 A+B+C。
6. 不评判风格、长度、语气，也不要求答案更啰嗦。
7. 如果答案本身是拒绝、澄清提问、或明确表示无法完成，且没有捏造事实，判 pass。

只输出一个 JSON 对象，不要 Markdown 代码围栏，不要解释：
{"verdict":"pass","confidence":0.9}
或
{"verdict":"revise","confidence":0.8,"issues":[{"claim":"原文断言","kind":"unsupported|contradicted|overreach|stale","why":"为什么不算被证据支持"}],"must_do":["可执行的最小修复动作，例如：用 web_fetch 打开 X 核实版本号；或删除该断言；或标注未核实"]}

issues 最多 3 条，must_do 最多 3 条，且必须是最小必要动作。
成本约束（重要）：每驳回一次，主模型都要带着全部上下文重跑一步，代价远高于你这次调用。因此：
- 只列会真正误导用户的断言；措辞不精确、措辞保守、明显常识都不要列。
- must_do 优先写「把结论降级为不确定 / 删除该断言 / 标注未核实」，只有该事实是答案核心且缺失会导致用户做错决定时，才要求去补证据（那会额外触发工具往返）。
- 如果问题只是"语气太确定"而不是"事实错误"，must_do 只写降级，不要要求重新查证。`;

const CONTRACT_ZH = `[审判员模式 · dsh-judge]
在你把答案交付给用户之前，会有一位「审判员」复核事实性断言。为了通过复核：
1. 任何具体事实（版本号、API 签名、路径、数字、日期、引文、兼容性、"文档说…"）都必须来自本会话的工具结果，或明确标注「未核实」。不要把记忆或二手说法写成确定结论。
2. 工具输出为空、报错、或与你的结论不一致时，如实说明，不要补全成成功叙事。
3. 被驳回时，会收到一条「审判员·第N次复核」的消息：按其中的 must_do 补齐证据或降级表述，然后重新输出**完整**答案；不要向用户解释这条驳回消息。
4. 如果本轮提供了 judge_review 工具：先把候选答案提交给它，approved=true 后原样输出；未通过则按报告修改后再次提交。`;

const CONTRACT_EN = `[Reviewer mode · dsh-judge]
Before your answer reaches the user, a reviewer checks its factual claims. To pass:
1. Every specific fact (versions, API signatures, paths, numbers, dates, quotes, compatibility, "the docs say…") must come from a tool result in this session, or be explicitly marked unverified. Never present memory or second-hand claims as established fact.
2. If a tool result is empty, errored, or contradicts your conclusion, say so; do not narrate it as success.
3. If rejected you will receive a "Reviewer · attempt N" message: follow its must_do list (fetch evidence or downgrade the claim), then output the complete revised answer. Do not explain the rejection to the user.
4. If the judge_review tool is available, submit your draft first and output it verbatim once approved.`;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function normalizeConfig(config) {
  const cfg = { ...DEFAULTS };
  if (config && typeof config === 'object') {
    for (const [k, v] of Object.entries(config)) {
      if (v !== undefined && k in DEFAULTS) cfg[k] = v;
    }
  }
  cfg.maxAttempts = Math.max(0, Number(cfg.maxAttempts) || 0);
  cfg.transcriptChars = Math.max(2000, Number(cfg.transcriptChars) || DEFAULTS.transcriptChars);
  cfg.toolResultChars = Math.max(200, Number(cfg.toolResultChars) || DEFAULTS.toolResultChars);
  cfg.minAnswerChars = Math.max(0, Number(cfg.minAnswerChars) || 0);
  cfg.language = cfg.language === 'en' ? 'en' : 'zh';
  cfg.onJudgeError = cfg.onJudgeError === 'revise' ? 'revise' : 'allow';
  cfg.sessionRejectBudget = Math.max(0, Number(cfg.sessionRejectBudget) || 0);
  cfg.skipTrivial = cfg.skipTrivial !== false;
  cfg.judgeMaxTokens = Math.max(500, Number(cfg.judgeMaxTokens) || DEFAULTS.judgeMaxTokens);
  const rawJev = config && typeof config === 'object' && config.jev && typeof config.jev === 'object' ? config.jev : {};
  cfg.jev = { ...DEFAULTS.jev, ...rawJev };
  cfg.jev.enabled = cfg.jev.enabled === true;
  cfg.jev.stateChars = Math.max(1000, Number(cfg.jev.stateChars) || DEFAULTS.jev.stateChars);
  cfg.jev.riskThreshold = Math.min(0.95, Math.max(0.05, Number(cfg.jev.riskThreshold) || DEFAULTS.jev.riskThreshold));
  cfg.jev.timeoutMs = Math.max(1000, Number(cfg.jev.timeoutMs) || DEFAULTS.jev.timeoutMs);
  cfg.jev.onError = cfg.jev.onError === 'pass' ? 'pass' : 'judge';
  cfg.jev.proxyUrl = String(cfg.jev.proxyUrl || '').trim();
  cfg.jev.model = String(cfg.jev.model || DEFAULTS.jev.model);
  cfg.jev.baseUrl = String(cfg.jev.baseUrl || DEFAULTS.jev.baseUrl).replace(/\/+$/, '');
  cfg.contract = String(cfg.contract || '').trim() || (cfg.language === 'en' ? CONTRACT_EN : CONTRACT_ZH);
  return cfg;
}

/** 纯寒暄 / 纯确认：不值得为它调用审判模型。 */
const TRIVIAL_ANSWER = /^(好的|收到|已完成|完成了|已处理|已发送|已更新|没问题|OK|Okay|Done|Sure)[。.!！,，\s]*$/i;

/* ---------------- 可编辑配置（插件页表单写入这里） ---------------- */

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(PLUGIN_DIR, 'config.json');

/** 表单允许改写的顶层字段 */
const EDITABLE_FIELDS = {
  enabled: 'bool',
  dryRun: 'bool',
  maxAttempts: 'int',
  sessionRejectBudget: 'int',
  minAnswerChars: 'int',
  judgeProvider: 'str',
  judgeModel: 'str',
  judgeMaxTokens: 'int',
  transcriptChars: 'int',
  toolResultChars: 'int',
  submitTool: 'bool',
  skipTrivial: 'bool',
};
/** 表单允许改写的 jev.* 字段 */
const EDITABLE_JEV = {
  enabled: 'bool',
  model: 'str',
  proxyUrl: 'str',
  riskThreshold: 'num',
  onError: 'str',
  timeoutMs: 'int',
  stateChars: 'int',
};

function readOverrides() {
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function writeOverrides(next) {
  writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

function coerce(kind, value) {
  if (kind === 'bool') return value === true || value === 'true' || value === 1;
  if (kind === 'int' || kind === 'num') {
    const n = Number(value);
    return Number.isFinite(n) ? (kind === 'int' ? Math.trunc(n) : n) : undefined;
  }
  return value === undefined || value === null ? '' : String(value);
}

/** 只接受已知字段，避免表单/接口写入任意配置。 */
function sanitizeOverrides(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, kind] of Object.entries(EDITABLE_FIELDS)) {
    if (!Object.hasOwn(input, key)) continue;
    const value = coerce(kind, input[key]);
    if (value !== undefined) out[key] = value;
  }
  const jev = input.jev;
  if (jev && typeof jev === 'object' && !Array.isArray(jev)) {
    out.jev = {};
    for (const [key, kind] of Object.entries(EDITABLE_JEV)) {
      if (!Object.hasOwn(jev, key)) continue;
      const value = coerce(kind, jev[key]);
      if (value !== undefined) out.jev[key] = value;
    }
  }
  return out;
}

/** 从一个内容块数组里取出纯文本。 */
function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'reasoning' && typeof block.text === 'string') { /* 不要推理草稿 */ }
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'file') parts.push('[file]');
  }
  return parts.join('\n');
}

function callToText(block) {
  const raw = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
  const args = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
  return `[tool→${block.name ?? '?'}] ${args}`;
}

function clip(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…[已截断 ${s.length - max} 字符]`;
}

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'assistant') continue;
    const text = blocksToText(m.content).trim();
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * 把会话里「模型看到的东西」渲染成审判员可读的转录。
 * 从最新往前收集，保证最近的工具证据一定在预算内。
 */
function renderTranscript(messages, cfg, draft) {
  const chunks = [];
  let budget = cfg.transcriptChars;
  for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
    const m = messages[i];
    if (!m || typeof m !== 'object') continue;
    let line = '';
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      line = `TOOL(${m.toolCallId ?? '?'}): ${clip(blocksToText(m.content), cfg.toolResultChars)}`;
    } else if (m.role === 'assistant') {
      const text = blocksToText(m.content);
      const calls = (Array.isArray(m.content) ? m.content : [])
        .filter((b) => b && b.type === 'tool-call')
        .map(callToText)
        .join('\n');
      if (!text && !calls) continue;
      line = `ASSISTANT: ${text}${calls ? `\n${calls}` : ''}`;
      if (text.trim() === draft.trim()) line = `DRAFT_ANSWER(待审): ${text}`;
    } else if (m.role === 'user') {
      const text = blocksToText(m.content).trim();
      if (!text) continue;
      line = `USER: ${text}`;
    } else continue;
    line = clip(line, Math.max(600, Math.min(4000, budget)));
    chunks.push(line);
    budget -= line.length + 2;
  }
  chunks.reverse();
  return chunks.join('\n\n');
}

/** 从可能带围栏/前后废话的输出里抠出第一个完整 JSON 对象。 */
function extractJson(text) {
  const s = String(text ?? '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeVerdict(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('judge: verdict is not an object');
  const verdict = value.verdict === 'pass' ? 'pass' : value.verdict === 'revise' ? 'revise' : undefined;
  if (!verdict) throw new Error('judge: verdict must be "pass" or "revise"');
  const issues = Array.isArray(value.issues)
    ? value.issues
        .filter((it) => it && typeof it === 'object')
        .slice(0, 6)
        .map((it) => ({
          claim: String(it.claim ?? '').slice(0, 400),
          kind: String(it.kind ?? 'unsupported').slice(0, 32),
          why: String(it.why ?? '').slice(0, 600),
        }))
    : [];
  const mustDo = Array.isArray(value.must_do)
    ? value.must_do.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4).map((s) => s.slice(0, 400))
    : [];
  return { verdict, confidence: Number(value.confidence) || 0, issues, mustDo };
}

/** 解析当前会话的路由（审判模型默认跟随主模型）。 */
function resolveRoute(agent, cfg) {
  let provider = cfg.judgeProvider;
  let model = cfg.judgeModel;
  if (!provider || !model) {
    let header;
    try {
      header = agent?.session?.requestHeader?.();
    } catch {
      header = undefined;
    }
    const config = header?.config;
    if (!provider && config?.provider) provider = config.provider;
    if (!model && config?.model) model = config.model;
  }
  if (!provider || !model) {
    const opts = agent?.options;
    if (!provider && opts?.provider) provider = opts.provider;
    if (!model && opts?.model) model = opts.model;
  }
  if (!provider || !model) throw new Error('judge: no provider/model route available');
  return { provider, model };
}

/* ---------------- Jev（TypeSafe System One）廉价预筛 ---------------- */

let jevKeyCache = new Map();

/** 取 TypeSafe key：先环境变量，再兜底文件；都没有就返回空串。 */
function jevApiKey(cfg) {
  const cacheKey = `${cfg.jev.apiKeyEnv}|${cfg.jev.apiKeyFile}`;
  if (jevKeyCache.has(cacheKey)) return jevKeyCache.get(cacheKey);
  const fromEnv = process.env[cfg.jev.apiKeyEnv];
  if (fromEnv && fromEnv.trim()) {
    jevKeyCache.set(cacheKey, fromEnv.trim());
    return fromEnv.trim();
  }
  try {
    const fromFile = readFileSync(cfg.jev.apiKeyFile, 'utf8').trim();
    jevKeyCache.set(cacheKey, fromFile);
    return fromFile;
  } catch {
    jevKeyCache.set(cacheKey, '');
    return '';
  }
}

/** 通过 HTTP CONNECT 代理发 HTTPS JSON（Node 自带模块，无第三方依赖）。 */
function httpsJsonViaProxy(proxyUrl, url, payload, headers, timeoutMs) {
  const proxy = new URL(proxyUrl);
  const target = new URL(url);
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  return new Promise((resolve, reject) => {
    const connectReq = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:443`,
      headers: { host: `${target.hostname}:443` },
      timeout: timeoutMs,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
        const agent = new https.Agent({ keepAlive: false });
        agent.createConnection = () => tlsSocket;
        const req = https.request(
          {
            host: target.hostname,
            path: target.pathname + target.search,
            method: 'POST',
            agent,
            headers: { ...headers, 'content-type': 'application/json', 'content-length': body.length },
            timeout: timeoutMs,
          },
          (resp) => {
            const chunks = [];
            resp.on('data', (chunk) => chunks.push(chunk));
            resp.on('end', () => resolve({ status: resp.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('jev request timeout')));
        req.end(body);
      });
      tlsSocket.on('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.on('timeout', () => connectReq.destroy(new Error('jev proxy timeout')));
    connectReq.end();
  });
}

/** 发一次 Jev 请求：有 proxyUrl 走 CONNECT 隧道，否则直连 fetch。 */
async function jevRequest(cfg, key, body) {
  const url = `${cfg.jev.baseUrl}/v1/systemone`;
  const headers = { authorization: `Bearer ${key}` };
  if (cfg.jev.proxyUrl) {
    return httpsJsonViaProxy(cfg.jev.proxyUrl, url, body, headers, cfg.jev.timeoutMs);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.jev.timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 Jev 做一次预筛：三个 Noul 问句，取最大概率作为"需要深审"的风险分。
 * 成功返回 { ok:true, risk, probs, usage }；失败返回 { ok:false, reason }。
 */
async function jevScreen(cfg, transcript, draft) {
  const key = jevApiKey(cfg);
  if (!key) return { ok: false, reason: 'no-api-key' };
  const state = `${clip(transcript, cfg.jev.stateChars)}\n\nDRAFT_ANSWER:\n${draft}`;
  const body = {
    model: cfg.jev.model,
    state,
    questions: {
      unsupported: {
        type: 'noul',
        instructions: '答案包含至少一条具体事实性断言，而提供的会话工具结果不足以支持它。',
        criteria: { true: '存在缺少证据支撑的具体断言', false: '断言都有工具结果支撑，或没有具体断言' },
      },
      contradicted: {
        type: 'noul',
        instructions: '答案与提供的会话工具结果矛盾。',
        criteria: { true: '存在矛盾', false: '没有矛盾' },
      },
      overreach: {
        type: 'noul',
        instructions: '答案的结论强于提供的工具结果能支持的范围。',
        criteria: { true: '结论超出证据', false: '结论与证据范围一致' },
      },
    },
  };
  const res = await jevRequest(cfg, key, body);
  if (res.status !== 200) return { ok: false, reason: `http-${res.status}` };
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    return { ok: false, reason: 'bad-json' };
  }
  const probs = {};
  for (const [name, answer] of Object.entries(json.answers ?? {})) {
    if (typeof answer?.noul === 'number') probs[name] = answer.noul;
  }
  if (Object.keys(probs).length === 0) return { ok: false, reason: 'no-answers' };
  return { ok: true, risk: Math.max(...Object.values(probs)), probs, usage: json.usage, model: json.model };
}

/** 调一次审判模型，返回结构化判定。 */
async function callJudge(ctx, route, userText, signal, cfg, budget = cfg.judgeMaxTokens) {
  let text = '';
  let finish;
  const seen = {};
  const stream = ctx.llm.stream({
    provider: route.provider,
    model: route.model,
    system: JUDGE_POLICY,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    temperature: 0,
    maxTokens: budget,
    ...(signal ? { signal } : {}),
  });
  for await (const chunk of stream) {
    if (!chunk || typeof chunk !== 'object') continue;
    seen[chunk.type] = (seen[chunk.type] ?? 0) + 1;
    if (chunk.type === 'text-delta') text += chunk.text ?? '';
    else if (chunk.type === 'finish') finish = chunk;
  }
  const diag = `chunks=${JSON.stringify(seen)} finish=${JSON.stringify(finish?.reason ?? null)} budget=${budget}`;
  if (!finish) throw new Error(`judge: stream ended without a finish chunk (${diag})`);
  const kind = finish.reason?.kind;
  if (kind === 'error' || kind === 'aborted') {
    const failure = finish.reason?.failure ?? {};
    throw new Error(`judge: stream ${kind} ${failure.code ?? ''} ${failure.message ?? ''}`.trim());
  }
  // 推理型模型（reasoningEffort=high）会用光输出预算只产出推理、没有正文：
  // 这是配置问题而不是判定结果，加倍预算重试一次。
  if (!text.trim() && budget < 12000) {
    return callJudge(ctx, route, userText, signal, cfg, Math.min(12000, budget * 2));
  }
  const parsed = extractJson(text) ?? verdictFallback(text);
  if (!parsed) throw new Error(`judge: could not parse verdict JSON: ${text.slice(0, 200)} (${diag})`);
  return normalizeVerdict(parsed);
}

/**
 * 判定 JSON 被截断（长推理/长 issues）时的兜底：只捞 verdict 字段。
 * 宁可给出"未通过但无细节"的通用驳回，也不要因为解析失败把整轮判成错误。
 */
function verdictFallback(text) {
  const match = /"verdict"\s*:\s*"(pass|revise)"/.exec(String(text ?? ''));
  if (!match) return null;
  return { verdict: match[1], confidence: 0, issues: [], must_do: [] };
}

function judgeUserText(transcript, draft, cfg) {
  return [
    'TASK: 对 DRAFT_ANSWER 做事实核查，按系统提示里的规则只输出 JSON。',
    'SESSION_TRANSCRIPT（模型本轮看到的内容，工具证据以此为准）:',
    transcript || '(空)',
    'DRAFT_ANSWER（待审答案）:',
    draft,
    cfg.language === 'zh' ? '只输出 JSON。' : 'Output JSON only.',
  ].join('\n\n');
}

/* ------------------------------------------------------------------ */
/* plugin                                                              */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const baseConfig = config && typeof config === 'object' ? config : {};
  let overrides = readOverrides();
  const merged = () => {
    const stored = overrides ?? {};
    const baseJev = baseConfig.jev && typeof baseConfig.jev === 'object' ? baseConfig.jev : {};
    const storedJev = stored.jev && typeof stored.jev === 'object' ? stored.jev : {};
    return { ...baseConfig, ...stored, jev: { ...baseJev, ...storedJev } };
  };
  let cfg = normalizeConfig(merged());
  if (!cfg.enabled) ctx.logger?.info?.('dsh-judge: disabled (can be enabled from the plugin page)');

  /** `${sessionId}:${turn}` -> 已驳回次数 */
  const attempts = new Map();
  /** `${sessionId}:${turn}` -> 上次被驳回的草稿（归一化后），用于识别"模型没改就重交" */
  const lastRejected = new Map();
  /** sessionId -> 本会话累计驳回次数（跨轮），用于成本上限 */
  const sessionRejects = new Map();
  /** sessionId -> 已经通过 judge_review 的草稿文本 */
  const approvedDrafts = new Map();

  const sessionIdOf = (agent) => String(agent?.session?.id ?? agent?.id ?? 'unknown');
  const attemptKey = (agent, turn) => `${sessionIdOf(agent)}:${turn ?? '?'}`;

  const normalizeDraft = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
  /** 通过 judge_review 的草稿若被原样输出，就不再重复审判一次。 */
  const matchesApproved = (sessionId, draft) => {
    const approved = approvedDrafts.get(sessionId);
    if (!approved || !draft) return false;
    const a = normalizeDraft(approved);
    const b = normalizeDraft(draft);
    if (a === b) return true;
    const head = a.slice(0, Math.min(300, a.length));
    return head.length >= 80 && b.startsWith(head);
  };

  const log = (level, message, data) => {
    const fn = ctx.logger?.[level];
    if (typeof fn === 'function') {
      try {
        data === undefined ? fn.call(ctx.logger, `dsh-judge: ${message}`) : fn.call(ctx.logger, `dsh-judge: ${message}`, data);
      } catch {
        /* logging must never break the turn */
      }
    }
  };

  /** 审一份草稿。返回 { ok, verdict } 或 { ok:false, error }。 */
  async function review(agent, turn, signal, draftOverride) {
    const messages = agent?.session?.deriveMessages?.() ?? [];
    const draft = String(draftOverride ?? lastAssistantText(messages) ?? '').trim();
    if (!draft) return { ok: false, empty: true };
    if (cfg.skipTrivial && TRIVIAL_ANSWER.test(draft)) return { ok: false, trivial: true };
    if (draft.length < cfg.minAnswerChars) return { ok: false, tooShort: true };
    if (signal?.aborted) return { ok: false, aborted: true };
    const route = resolveRoute(agent, cfg);
    const transcript = renderTranscript(messages, cfg, draft);

    let jevInfo;
    if (cfg.jev.enabled) {
      try {
        const screen = await jevScreen(cfg, transcript, draft);
        if (screen.ok) {
          jevInfo = { risk: screen.risk, probs: screen.probs, usage: screen.usage, model: screen.model };
          if (screen.risk < cfg.jev.riskThreshold) {
            return {
              ok: true,
              verdict: { verdict: 'pass', confidence: Number((1 - screen.risk).toFixed(3)), issues: [], mustDo: [] },
              draft,
              jev: jevInfo,
              skippedJudge: true,
            };
          }
        } else if (cfg.jev.onError === 'pass') {
          return { ok: true, verdict: { verdict: 'pass', confidence: 0, issues: [], mustDo: [] }, draft, jev: { error: screen.reason }, skippedJudge: true };
        }
      } catch (error) {
        if (cfg.jev.onError === 'pass') {
          return { ok: true, verdict: { verdict: 'pass', confidence: 0, issues: [], mustDo: [] }, draft, jev: { error: String(error?.message ?? error) }, skippedJudge: true };
        }
      }
    }

    try {
      const verdict = await callJudge(ctx, route, judgeUserText(transcript, draft, cfg), signal, cfg);
      return { ok: true, verdict, draft, jev: jevInfo };
    } catch (error) {
      return { ok: false, error, draft };
    }
  }

  function reviseMessage(verdict, attempt) {
    const issueLines = verdict.issues
      .map((it, i) => `${i + 1}. [${it.kind}] ${it.claim || '(见 must_do)'} —— ${it.why}`)
      .join('\n');
    const mustDo = verdict.mustDo.map((s, i) => `${i + 1}. ${s}`).join('\n');
    const text =
      cfg.language === 'en'
        ? [
            `Reviewer · attempt ${attempt}: REJECTED`,
            issueLines ? `Issues:\n${issueLines}` : '',
            mustDo ? `Required actions:\n${mustDo}` : 'Required action: fetch evidence for every factual claim, or downgrade it to "unverified".',
            'Now output the complete corrected answer. Do not mention this review message to the user.',
          ]
            .filter(Boolean)
            .join('\n\n')
        : [
            `【审判员 · 第 ${attempt} 次复核：未通过】`,
            issueLines ? `问题：\n${issueLines}` : '',
            mustDo ? `必须完成：\n${mustDo}` : '必须完成：为每条事实性断言补充工具证据，或把结论降级为「未核实」。',
            '现在直接输出修正后的完整答案。不要向用户解释这条复核消息。',
          ]
            .filter(Boolean)
            .join('\n\n');
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'judge-reviewer', form: 'notice', summary: `审判员驳回（第 ${attempt} 次）` },
    };
  }

  /* ---------------- 1) 系统提示词：告诉模型规则 ---------------- */
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'dsh-judge:contract',
      order: cfg.promptOrder,
      text: cfg.contract,
    }),
  );

  /* ---------------- 2) 轮次结束前的闸门 ---------------- */
  ctx.effect(() =>
    ctx.on('agent/turn-stopping', async (payload) => {
      const agent = payload?.agent;
      const turn = payload?.turn;
      const signal = payload?.signal;
      if (!agent?.session) return;
      if (!cfg.enabled) return;
      const header = agent.session.header ?? {};
      if (cfg.skipSubagents && (header.origin === 'subagent' || header.parentSession !== undefined)) return;

      // 已经通过 judge_review 的草稿原样输出：视为已通过。
      const sessionId = sessionIdOf(agent);
      if (approvedDrafts.has(sessionId)) {
        const finalText = lastAssistantText(agent.session.deriveMessages?.() ?? []);
        if (matchesApproved(sessionId, finalText)) {
          approvedDrafts.delete(sessionId);
          attempts.delete(attemptKey(agent, turn));
          log('info', 'approved draft echoed; skipping re-review', { turn });
          return;
        }
      }

      // 驳回后模型没有改动就重交：直接放行，连审判调用都省掉。
      const key = attemptKey(agent, turn);
      const preDraft = String(lastAssistantText(agent.session.deriveMessages?.() ?? [])).trim();
      if (preDraft && lastRejected.get(key) === normalizeDraft(preDraft)) {
        log('warn', 'draft unchanged after rejection; skipping re-judge and letting it through', { turn });
        attempts.set(key, cfg.maxAttempts);
        return;
      }

      const result = await review(agent, turn, signal);
      if (result.aborted) return;
      if (!result.ok) {
        if (result.error) {
          log('warn', 'judge call failed', { error: String(result.error?.message ?? result.error) });
          if (cfg.onJudgeError === 'revise') {
            const used = attempts.get(key) ?? 0;
            if (used < cfg.maxAttempts) {
              attempts.set(key, used + 1);
              if (!cfg.dryRun) agent.steer(reviseMessage({ issues: [], mustDo: [] }, used + 1));
            }
          }
        }
        return;
      }

      const { verdict, draft } = result;
      const normDraft = normalizeDraft(draft);
      if (verdict.verdict === 'pass') {
        attempts.delete(key);
        lastRejected.delete(key);
        log('info', result.skippedJudge ? 'answer passed by jev pre-screen' : 'answer passed', {
          turn,
          confidence: verdict.confidence,
          ...(result.jev ? { jev: result.jev.risk !== undefined ? { risk: result.jev.risk, usage: result.jev.usage } : { error: result.jev.error } } : {}),
        });
        return;
      }

      // 模型被驳回后没有实质性修改：不再重复驳回（每次驳回都是一次完整的主模型重跑）。
      if (lastRejected.get(key) === normDraft) {
        log('warn', 'draft unchanged after rejection; letting it through to avoid a loop', { turn });
        attempts.set(key, cfg.maxAttempts);
        return;
      }

      // 会话级驳回预算：复杂任务里防止一轮接一轮地烧 token。
      if ((sessionRejects.get(sessionId) ?? 0) >= cfg.sessionRejectBudget) {
        log('warn', 'session reject budget exhausted; judging only, not steering', {
          turn,
          budget: cfg.sessionRejectBudget,
          issues: verdict.issues.map((i) => i.kind),
        });
        attempts.set(key, cfg.maxAttempts);
        return;
      }

      const used = attempts.get(key) ?? 0;
      if (used >= cfg.maxAttempts) {
        log('warn', 'answer still rejected but attempt budget exhausted; letting it through', {
          turn,
          attempts: used,
          issues: verdict.issues.map((i) => i.kind),
        });
        // 保留计数（不删），否则同一 turn 再次收尾会重新开始驳回。
        attempts.set(key, used);
        return;
      }
      attempts.set(key, used + 1);

      if (cfg.dryRun) {
        log('warn', 'DRY RUN: would reject answer', {
          turn,
          issues: verdict.issues,
          mustDo: verdict.mustDo,
          draft: draft.slice(0, 200),
        });
        return;
      }

      sessionRejects.set(sessionId, (sessionRejects.get(sessionId) ?? 0) + 1);
      lastRejected.set(key, normDraft);
      log('info', 'answer rejected; steering revision', { turn, attempt: used + 1, issues: verdict.issues.length });
      agent.steer(reviseMessage(verdict, used + 1));
    }),
  );

  /* ---------------- 3) 可选的“先送审再作答”工具 ---------------- */
  if (cfg.submitTool) {
    const tool = {
      name: 'judge_review',
      description:
        '在给出最终答案前，把候选答案提交给「审判员」复核。返回 approved=true 后，把这份答案原样作为最终回答输出；approved=false 时按 report 补齐证据或降级表述，再次提交。纯寒暄/一句确认不需要提交。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answer: { type: 'string', description: '完整的候选答案（markdown）' },
        },
        required: ['answer'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            approved: { type: 'boolean' },
            report: { type: 'string' },
          },
          required: ['approved', 'report'],
        },
        render: (_args, value) =>
          value.approved
            ? [{ type: 'text', text: '审判员通过。现在把这份答案作为最终回答输出（可原样输出，无需再改写）。' }]
            : [{ type: 'text', text: `审判员未通过：\n${value.report}\n\n按上面的要求补齐证据或降级表述后，再次调用 judge_review，通过后再输出最终答案。` }],
      },
      async execute(args, exec) {
        if (!cfg.enabled) return { approved: false, report: '审判员当前已关闭（可在插件页重新启用）。' };
        const agent = exec?.agent;
        if (!agent?.session) return { approved: false, report: '没有可用的 agent 会话上下文，无法复核。' };
        const result = await review(agent, 'submit', exec?.signal, args?.answer);
        if (!result.ok) {
          if (result.error) return { approved: false, report: `审判员调用失败：${String(result.error?.message ?? result.error)}` };
          return { approved: false, report: '草稿为空或过短，未做复核。' };
        }
        const { verdict, draft } = result;
        if (verdict.verdict === 'pass') {
          approvedDrafts.set(sessionIdOf(agent), draft);
          return { approved: true, report: 'pass' };
        }
        const report = [
          ...verdict.issues.map((it, i) => `${i + 1}. [${it.kind}] ${it.claim} —— ${it.why}`),
          ...verdict.mustDo.map((s, i) => `${verdict.issues.length + i + 1}. 必须：${s}`),
        ].join('\n');
        return { approved: false, report: report || '存在未核实的事实性断言。' };
      },
    };
    ctx.effect(() => ctx.tools.register(tool));
  }

  // 清理：会话被销毁时丢掉状态，避免 Map 无限增长。
  ctx.effect(() =>
    ctx.on('session/disposed', (sessionOrId) => {
      const id = typeof sessionOrId === 'string' ? sessionOrId : String(sessionOrId?.id ?? '');
      if (!id) return;
      approvedDrafts.delete(id);
      sessionRejects.delete(id);
      for (const key of [...attempts.keys()]) if (key.startsWith(`${id}:`)) attempts.delete(key);
      for (const key of [...lastRejected.keys()]) if (key.startsWith(`${id}:`)) lastRejected.delete(key);
    }),
  );

  /* ---------------- 4) 插件页配置接口（浏览器半读写它） ---------------- */
  const sendJson = (res, code, obj) => {
    const data = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': data.length,
      'Cache-Control': 'no-store',
    });
    res.end(data);
  };
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  const publicConfig = () => ({ ...cfg, jev: { ...cfg.jev } });

  async function handleApi(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/dsh-judge/api/config') {
        return sendJson(res, 200, { ok: true, config: publicConfig(), configFile: CONFIG_FILE });
      }
      if (req.method === 'POST' && url.pathname === '/dsh-judge/api/config') {
        const body = await readBody(req);
        const next = sanitizeOverrides(body?.config ?? body);
        overrides = {
          ...overrides,
          ...next,
          jev: { ...(overrides.jev ?? {}), ...(next.jev ?? {}) },
        };
        writeOverrides(overrides);
        cfg = normalizeConfig(merged());
        log('info', 'config updated from plugin page', { enabled: cfg.enabled, jevEnabled: cfg.jev.enabled });
        return sendJson(res, 200, { ok: true, config: publicConfig(), configFile: CONFIG_FILE });
      }
      return sendJson(res, 404, { ok: false, message: 'not found' });
    } catch (error) {
      return sendJson(res, 500, { ok: false, message: String(error?.message ?? error) });
    }
  }

  ctx.inject(['webServer'], (child) => {
    child.effect(
      () => child.webServer.register({ kind: 'prefix', path: '/dsh-judge', handler: handleApi }),
      'dsh-judge: config api',
    );
  });

  log('info', 'ready', {
    dryRun: cfg.dryRun,
    maxAttempts: cfg.maxAttempts,
    submitTool: cfg.submitTool,
    sessionRejectBudget: cfg.sessionRejectBudget,
    jevEnabled: cfg.jev.enabled,
  });
}

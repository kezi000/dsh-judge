/**
 * 离线自测：用假 ctx / 假 agent 驱动插件，验证闸门逻辑（不调用真实模型）。
 * 运行：node test/simulate.mjs
 */
import assert from 'node:assert/strict';
import { apply } from '../index.js';

const PASS = JSON.stringify({ verdict: 'pass', confidence: 0.9 });
const REVISE = JSON.stringify({
  verdict: 'revise',
  confidence: 0.8,
  issues: [{ claim: '库版本是 0.2.1', kind: 'unsupported', why: '本会话没有读取过 package.json' }],
  must_do: ['用 read 打开 package.json 核实版本号，或把版本号标注为未核实'],
});

const DRAFT = '这个库的版本是 0.2.1，配置项写在 cordis.yml 的 plugins 字段里，改完重启即可。';

function stream(text, kind = 'stop') {
  return (async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind } };
  })();
}

function harness({ replies = [PASS], config = {}, messages = defaultMessages(), header = {} } = {}) {
  const handlers = new Map();
  const registered = [];
  const logs = [];
  let calls = 0;
  const ctx = {
    effect(fn) {
      const disposable = fn();
      return typeof disposable === 'function' ? disposable : () => {};
    },
    on(event, handler) {
      handlers.set(event, handler);
      return () => {};
    },
    // 测试里没有 webServer：直接跳过可选的配置 API 注册
    inject() {},
    logger: {
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
    },
    systemPrompt: { section: (spec) => (registered.push({ kind: 'section', spec }), () => {}) },
    tools: { register: (def) => (registered.push({ kind: 'tool', def }), () => {}) },
    llm: {
      stream() {
        const reply = replies[Math.min(calls, replies.length - 1)];
        calls += 1;
        if (reply instanceof Error) throw reply;
        return typeof reply === 'function' ? reply() : stream(reply);
      },
    },
  };
  apply(ctx, config);

  const steers = [];
  let currentMessages = messages;
  const session = {
    id: 'sess-1',
    header,
    deriveMessages: () => currentMessages,
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
  };
  const agent = { id: 'sess-1', session, options: { provider: 'p', model: 'm' }, steer: (m) => steers.push(m) };

  return {
    ctx,
    registered,
    logs,
    steers,
    agent,
    calls: () => calls,
    setMessages: (next) => {
      currentMessages = next;
    },
    stop: (turn = 1) => handlers.get('agent/turn-stopping')({ agent, turn, signal: new AbortController().signal }),
    tool: () => registered.find((r) => r.kind === 'tool')?.def,
  };
}

function defaultMessages(draft = DRAFT) {
  return [
    { role: 'user', content: [{ type: 'text', text: '这个库怎么配置？' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"cordis.yml"}' }] },
    { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: '[]\n' }] },
    { role: 'assistant', content: [{ type: 'text', text: draft }] },
  ];
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('revise → steer 一条驳回消息，且形状合法', async () => {
  const h = harness({ replies: [REVISE] });
  await h.stop(3);
  assert.equal(h.steers.length, 1);
  const msg = h.steers[0];
  assert.equal(msg.role, 'user');
  assert.ok(msg.id && msg.id.length > 10, 'message needs an id');
  assert.equal(msg.source.kind, 'judge-reviewer');
  const text = msg.content[0].text;
  assert.match(text, /未通过/);
  assert.match(text, /问题/);
  assert.match(text, /必须完成/);
});

test('pass → 不打断轮次', async () => {
  const h = harness({ replies: [PASS] });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.equal(h.calls(), 1);
});

test('dryRun → 只记录，不 steer', async () => {
  const h = harness({ replies: [REVISE], config: { dryRun: true } });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.ok(h.logs.some((l) => String(l[1]).includes('DRY RUN')));
});

test('审判调用失败 + onJudgeError=allow → 放行', async () => {
  const h = harness({
    replies: [async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'boom' } } }; }],
  });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.ok(h.logs.some((l) => l[0] === 'warn'), 'should warn');
});

test('审判调用失败 + onJudgeError=revise → 驳回（受预算约束）', async () => {
  const h = harness({
    replies: [async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TRANSPORT', message: 'boom' } } }; }],
    config: { onJudgeError: 'revise', maxAttempts: 1 },
  });
  await h.stop(1);
  assert.equal(h.steers.length, 1);
});

test('maxAttempts 用尽后放行，不无限驳回', async () => {
  const h = harness({ replies: [REVISE], config: { maxAttempts: 1 } });
  await h.stop(7);
  await h.stop(7);
  await h.stop(7);
  assert.equal(h.steers.length, 1);
  assert.ok(
    h.logs.some((l) => String(l[1]).includes('unchanged') || String(l[1]).includes('budget exhausted')),
    'should log why it stopped rejecting',
  );
});

test('另一个 turn 重新计数', async () => {
  const h = harness({ replies: [REVISE], config: { maxAttempts: 1 } });
  await h.stop(1);
  await h.stop(2);
  assert.equal(h.steers.length, 2);
});

test('短答案不审', async () => {
  const h = harness({ replies: [REVISE], messages: defaultMessages('好的。') });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.equal(h.calls(), 0);
});

test('子代理会话跳过', async () => {
  const h = harness({ replies: [REVISE], header: { origin: 'subagent', parentSession: 'parent' } });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.equal(h.calls(), 0);
});

test('驳回后模型原样重交：不再第二次驳回、不再调审判', async () => {
  const h = harness({ replies: [REVISE], config: { maxAttempts: 2 } });
  await h.stop(1);
  const callsAfterFirst = h.calls();
  await h.stop(1);
  assert.equal(h.steers.length, 1, 'second unchanged draft must not steer');
  assert.equal(h.calls(), callsAfterFirst, 'second identical draft must not be re-judged');
  assert.ok(h.logs.some((l) => String(l[1]).includes('unchanged')), 'should log unchanged');
});

test('会话级驳回预算：超预算后只判定不打断', async () => {
  const h = harness({ replies: [REVISE], config: { maxAttempts: 2, sessionRejectBudget: 1 } });
  await h.stop(1);
  assert.equal(h.steers.length, 1);
  // 换一轮、换一份草稿，避免命中"原样重交"去重
  const other = defaultMessages('另一份完全不同的答案：这里的版本号是 9.9.9，配置文件在 zzz.yml 的 plugins 段，改完需要重启一次才生效。');
  h.setMessages(other);
  await h.stop(2);
  assert.equal(h.steers.length, 1, 'budget exhausted must not steer');
  assert.ok(h.logs.some((l) => String(l[1]).includes('budget exhausted')), 'should log budget');
});

test('skipTrivial：纯确认不调审判', async () => {
  const h = harness({ replies: [REVISE], config: { skipTrivial: true, minAnswerChars: 0 }, messages: defaultMessages('收到！') });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.equal(h.calls(), 0);
});

/* ---------------- Jev 预筛（stub 掉 global fetch，不联网） ---------------- */

function jevConfig(overrides = {}) {
  return {
    jev: {
      enabled: true,
      proxyUrl: '',
      apiKeyEnv: 'DSH_JUDGE_TEST_KEY',
      apiKeyFile: 'C:/definitely-not-here/api-key.txt',
      riskThreshold: 0.5,
      ...overrides,
    },
  };
}

function stubJev(noul, { fail = false } = {}) {
  globalThis.fetch = async () => {
    if (fail) throw new Error('network down');
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'jev-test',
          answers: { unsupported: { type: 'noul', noul }, contradicted: { type: 'noul', noul: 0.1 }, overreach: { type: 'noul', noul: 0.2 } },
          usage: { input_tokens: 500, output_tokens: 40 },
        }),
    };
  };
}

test('Jev 低风险 → 直接放行，不调大模型审判', async () => {
  process.env.DSH_JUDGE_TEST_KEY = 'test-key';
  stubJev(0.12);
  const h = harness({ replies: [REVISE], config: jevConfig() });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
  assert.equal(h.calls(), 0, 'jev pass must skip the LLM judge');
  assert.ok(h.logs.some((l) => String(l[1]).includes('jev pre-screen')), 'should log jev pass');
});

test('Jev 高风险 → 升级到大模型审判', async () => {
  process.env.DSH_JUDGE_TEST_KEY = 'test-key';
  stubJev(0.9);
  const h = harness({ replies: [PASS], config: jevConfig() });
  await h.stop(1);
  assert.equal(h.calls(), 1, 'high risk must escalate');
  assert.equal(h.steers.length, 0);
});

test('Jev 调用失败 → 默认回退大模型审判', async () => {
  process.env.DSH_JUDGE_TEST_KEY = 'test-key';
  stubJev(0, { fail: true });
  const h = harness({ replies: [PASS], config: jevConfig() });
  await h.stop(1);
  assert.equal(h.calls(), 1, 'error must fall back to the judge');
});

test('Jev 调用失败 + onError=pass → 放行', async () => {
  process.env.DSH_JUDGE_TEST_KEY = 'test-key';
  stubJev(0, { fail: true });
  const h = harness({ replies: [PASS], config: jevConfig({ onError: 'pass' }) });
  await h.stop(1);
  assert.equal(h.calls(), 0);
  assert.equal(h.steers.length, 0);
});

test('Jev 没有 key → 回退大模型审判', async () => {
  delete process.env.DSH_JUDGE_TEST_KEY;
  const h = harness({
    replies: [PASS],
    config: { jev: { enabled: true, proxyUrl: '', apiKeyEnv: 'DSH_JUDGE_TEST_KEY_NONE', apiKeyFile: 'C:/definitely-not-here/x.txt' } },
  });
  await h.stop(1);
  assert.equal(h.calls(), 1);
});

test('系统提示词段落已注册', async () => {
  const h = harness({});
  const section = h.registered.find((r) => r.kind === 'section');
  assert.ok(section, 'section registered');
  assert.equal(section.spec.name, 'dsh-judge:contract');
  assert.match(section.spec.text, /审判员/);
});

test('judge_review 工具：通过后记录草稿，轮次收尾不再重复审判', async () => {
  const h = harness({ replies: [PASS] });
  const tool = h.tool();
  assert.ok(tool, 'tool registered');
  const result = await tool.execute({ answer: DRAFT }, { agent: h.agent, signal: new AbortController().signal });
  assert.equal(result.approved, true);
  const before = h.calls();
  await h.stop(4);
  assert.equal(h.calls(), before, 'no extra judge call for an approved draft');
  assert.equal(h.steers.length, 0);
});

test('judge_review 工具：驳回时返回报告且不记录', async () => {
  const h = harness({ replies: [REVISE] });
  const tool = h.tool();
  const result = await tool.execute({ answer: DRAFT }, { agent: h.agent, signal: new AbortController().signal });
  assert.equal(result.approved, false);
  assert.match(result.report, /unsupported/);
  await h.stop(5);
  assert.equal(h.steers.length, 1, 'gate still rejects the echoed draft');
});

test('JSON 解析：容忍代码围栏与前后废话', async () => {
  const fenced = '复核结果如下：\n```json\n{"verdict":"pass"}\n```\n以上。';
  const h = harness({ replies: [fenced] });
  await h.stop(1);
  assert.equal(h.steers.length, 0);
});

test('判定 JSON 被截断：仍能捞到 verdict 并驳回', async () => {
  const truncated = '{"verdict":"revise","confidence":0.7,"issues":[{"claim":"版本号 9.9.9","kind":"unsupported","why":"工具结果里没有版本号';
  const h = harness({ replies: [truncated] });
  await h.stop(1);
  assert.equal(h.steers.length, 1, 'truncated JSON should still reject');
  assert.match(h.steers[0].content[0].text, /未通过/);
});

test('传给审判员的输入包含工具证据与草稿', async () => {
  let seen = '';
  const h = harness({
    replies: [() => (async function* () { yield { type: 'text-delta', text: PASS }; yield { type: 'finish', reason: { kind: 'stop' } }; })()],
  });
  const original = h.ctx.llm.stream;
  h.ctx.llm.stream = (options) => {
    seen = options.messages[0].content[0].text;
    return original.call(h.ctx.llm, options);
  };
  await h.stop(1);
  assert.match(seen, /SESSION_TRANSCRIPT/);
  assert.match(seen, /TOOL\(c1\)/);
  assert.match(seen, /DRAFT_ANSWER/);
  assert.match(seen, /这个库的版本是 0\.2\.1/);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}`);
    console.log(`      ${error?.stack?.split('\n').slice(0, 4).join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed === 0 ? 0 : 1);

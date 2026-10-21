# dsh-judge · 审判员

给 DSH 加一道「交付前事实核查」：模型想结束一轮对话（= 即将把答案交给用户）时，
先由审判模型复核这份答案；**没通过就不许结束**——审判员会通过 `agent.steer()`
把驳回意见塞回下一步，主模型必须补齐证据或把结论降级，然后重新作答。

针对你遇到的问题：``没有核实就给出确定结论、二手说法当事实''。

---

## 1. 核心机制（为什么这套能真的拦住，而不是靠提示词自觉）

DSH 的 agent loop 在 `@deepseek-ai/dsh-agent-loop` 里是这样收尾的（`lib/index.js`）：

```js
if (turnEnds && this.inbox.nextStep.length === 0) {
    await this.dispatch.serial("agent/turn-stopping", { turn, signal });
    signal.throwIfAborted();
}
if (turnEnds && this.inbox.nextStep.length === 0) break;   // ← 只有这里才会结束轮次
target = "next-step";
```

- `agent/turn-stopping` 只在「模型这一步没有工具调用、轮次本来要结束」时触发；
- 事件 payload 由 `dsh-agent` 的 `agentEvents` 融合：`{ turn, signal, agent }`；
- **dispatch 之后会重新检查 `inbox.nextStep.length`**。监听器只要在这个 hook 里
  `agent.steer(消息)`，长度就不为 0，循环不会 break，而是进入下一步——模型会在
  历史里看到这条驳回消息。

所以这是一条**强制闸门**，不是「请模型自查」的口头约定。

## 2. 两条防线

| 防线 | 触发点 | 作用 |
|---|---|---|
| **收尾闸门**（必须） | `agent/turn-stopping` | 任何想交付的答案都会被审；不通过就 steer 驳回，最多 `maxAttempts` 次 |
| **先送审再作答**（可选，`submitTool: true`） | `judge_review` 工具 | 让模型把草稿放进工具参数里先审，通过后再输出正文——草稿不会作为正文被流式显示 |

审判员只看「模型本轮看到的东西」：`session.deriveMessages()` 里的用户请求、工具调用、
工具结果（证据），加上待审草稿。它会逐条判定：

- `unsupported`：断言没有本会话工具结果支撑（二手说法、"文档说"、记忆）；
- `contradicted`：与工具输出矛盾（报错/为空却说成功）；
- `overreach`：工具只验证了 A，答案却断言 A+B+C；
- `stale`：版本/时间类信息可能过期。

判定输出是严格 JSON，插件解析后把 `issues` + `must_do` 变成一条
`【审判员 · 第 N 次复核：未通过】` 的用户消息 steer 回模型。

## 3. 一个必须说清的局限：草稿仍然会被流式显示

DSH 的答案文本是边生成边推给前端的（`agent/assistant-stream` 只读、且消息在
settlement 时已提交到 surface），插件**无法撤回**已经流出的文字。所以：

- 拦得住的是「**最终结论**」：没通过的答案不会成为这一轮的终点，模型必须继续修；
- 拦不住的是「**你已经看到了草稿**」。

如果你的目标是「审核通过前一个字都不显示」，用 `submitTool` 模式：系统提示词要求
模型把答案放进 `judge_review` 的参数里，正文只留一句"正在核查"。工具参数不是正文
流，用户看到的第一次完整答案就是通过后的版本（工具卡片里仍可能看到草稿，但这属于
操作细节而不是交付物）。

## 4. 安装

本仓库内容即插件（`index.js` + `package.json` + `cordis.patch.yml`）。安装方式二选一：

### 方式 A：作为 profile 组合包（推荐，会出现在侧边栏「插件」页）

1. 复制到插件目录：

   ```bat
   xcopy /E /I <本仓库目录> %USERPROFILE%\.dsh\plugins\dsh-judge
   ```

2. 在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里：

   - `dependencies` 增加 `"dsh-judge": "file:<你的用户目录>/.dsh/plugins/dsh-judge"`
   - `dsh.profile.bundles` 增加 `"dsh-judge"`

3. 让 Node 能解析到包名（任选其一）：在 `<profile>\node_modules` 下建 junction
   `mklink /J node_modules\dsh-judge %USERPROFILE%\.dsh\plugins\dsh-judge`，
   或在 profile 目录跑 `pnpm install`。

4. 重启 DSH。组合包列表在启动期组合，重启后才会以组合包形态加载并显示在插件页。

### 方式 B：home patch 手动挂载（立刻生效，但不出现在插件页）

把本仓库 `cordis.patch.yml` 里的 `- insert:` 段整段抄进
`%USERPROFILE%\.dsh\cordis.patch.yml`，保存即热加载。注意 `name` 要么写成包名
`dsh-judge`（需先让 profile 能解析到），要么写成
`"file:///C:/Users/<你的用户名>/.dsh/plugins/dsh-judge/index.js"`。

> 两种方式不要同时用：同一个 `id` 挂两次属于未定义行为，建议只保留一种。

### 首次运行建议

先设 `dryRun: true` 跑几天：只记录「本应驳回」的判定（含 issues / must_do / 草稿片段），
不真正打断回答。确认误判率可接受后再改成 `dryRun: false`。

## 5. 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `false` | 只判定不驳回；首次部署建议 `true` |
| `maxAttempts` | `1` | 同一轮最多驳回几次（防死循环；到上限放行并 warn） |
| `sessionRejectBudget` | `4` | 整个会话累计最多驳回几次；超过后只判定不打断 |
| `skipTrivial` | `true` | 纯寒暄/纯确认不调审判模型 |
| `minAnswerChars` | `40` | 太短的答案不审 |
| `onJudgeError` | `allow` | 审判调用失败时：`allow` 放行（可用优先）/ `revise` 驳回（正确优先） |
| `skipSubagents` | `true` | 跳过子代理（父代理那层会再审） |
| `language` | `zh` | 驳回意见语言：`zh` / `en` |
| `judgeProvider` / `judgeModel` | 空 | 审判模型路由；空 = 跟随当前会话 |
| `judgeMaxTokens` | `3000` | 审判输出上限（推理型模型会把推理也算进这个预算；正文为空会自动加倍重试一次） |
| `transcriptChars` | `8000` | 送审转录总预算（保留最近的） |
| `toolResultChars` | `1200` | 单条工具结果保留长度 |
| `submitTool` | `true` | 是否注册 `judge_review` 工具 |
| `promptOrder` | `900` | 系统提示词段落位置 |
| `contract` | 空 | 覆盖内置「审判员模式」契约文本 |
| `jev.enabled` | `false` | 是否先用 Jev 做廉价预筛（见 §6.1） |
| `jev.riskThreshold` | `0.5` | Jev 风险概率 ≥ 该值才升级到大模型审判 |
| `jev.proxyUrl` | 空 | Jev 直连被区域限制时需要本地代理，例如 `http://127.0.0.1:10809` |

## 6. 成本控制与调参建议

一次驳回的真实代价不是审判调用，而是**主模型带着全部上下文重跑一步**（工具结果、历史全量重发），
再加上后续可能的新工具往返。审判调用本身是"定长"的：输入≈`transcriptChars`，输出≤`judgeMaxTokens`。

成本旋钮，按性价比排序：

1. **`maxAttempts: 1`**（默认）：最多打断一次。原先的 2 会让最坏情况翻倍。
2. **`sessionRejectBudget: 4`**（默认）：整个会话的驳回总额度，复杂任务里防止一轮接一轮地烧。
3. **原样重交去重**（代码内置）：模型被驳回后没实质修改就重交时，直接放行且**不再调审判**。
4. **`skipTrivial` + `minAnswerChars`**：寒暄/短答不调模型。事实密集的复杂任务可把 `minAnswerChars` 调到 120～200。
5. **`transcriptChars: 8000`**（默认）：审判输入的主要成本；证据密集时再调到 12000～16000。
6. **`judgeMaxTokens: 3000`**：推理型模型的 reasoning 也吃这个预算，压太低会只出推理不出正文（会自动加倍重试一次）。
7. **审判模型**：默认跟随主模型；改成更便宜的小模型通常更省，但同源盲区需要自己评估。
8. **`dryRun: true`**：只判定不打断——复杂任务里先观察几天再开启拦截。
9. **`maxAttempts: 0`**：等价于"只看不拦"，适合完全不想付主模型重跑成本的场景。

### 6.1 可选：Jev（TypeSafe）廉价预筛

Jev 是 TypeSafe 的 System One 模型：输入 state + 若干 Noul（是/否）问题，返回**概率**而不生成文本，
单次调用毫秒级、单价远低于推理模型。用法是两级过滤：

1. 先用 Jev 问三条：`存在缺证据的具体断言？`、`与工具结果矛盾？`、`结论超出证据范围？`；
2. 三条概率的最大值 < `jev.riskThreshold` → **直接放行**，不调用大模型审判；
3. 否则升级到原来的大模型审判，由它产出 `issues` / `must_do` 的驳回理由。

Jev 不给驳回文案，所以它不能单独承担"驳回并说明原因"，只适合做放行闸门。

本机实测（2026-10-21）：

| 项目 | 结果 |
|---|---|
| 直连 `POST https://api.typesafe.ai/v1/systemone` | **HTTP 451** `Typesafe is not available in your region.` |
| 走本地代理 `127.0.0.1:10809` | **HTTP 200**，`model: jev-1.13.0` |
| 样例判定（草稿写了未核实的版本号） | `unsupported = 0.96`、`contradicted = 0.28` ✅ |
| 用量 | 496 input / 39 output tokens，约 1.1s（另一条 369 / 20，约 1.07s） |

所以启用前要先准备：`TYPESAFE_API_KEY`（或 `apiKeyFile` 指向的 key 文件）+ 一个能出海的本地代理。
阈值 0.5 只是起点（Noul 0.5 = 是非各半），请用一批真实答案 + 标签跑 sweep 再定。

### 6.2 插件页配置表单（v0.2.0）

浏览器半（`client.js`）通过 `plugins.bundle.config` slot 注册在「插件 → dsh-judge」详情页里，
渲染总开关 / 驳回预算 / 审判模型 / Jev 四组字段；保存走同源接口
`GET|POST /dsh-judge/api/config`（由 `index.js` 用 `ctx.webServer` 注册）。

- 保存写入插件目录的 `config.json`，它覆盖 bundle 里的默认值；无需重启即可生效（节点半是同一进程）；
- 想回到默认值，删掉 `config.json` 再重启；
- 客户端半随宿主启动加载，首次安装/更新后需要重启一次才能在页面看到表单。

## 7. 验证

```bat
cd F:\data\test\dsh-judge
node --check index.js
node test\simulate.mjs
```

`test/simulate.mjs` 用假 ctx / 假 agent 覆盖：驳回→steer、通过→放行、dryRun、
审判失败两种策略、attempt 预算、子代理跳过、工具送审后不重复审判、JSON 围栏容错。

上线后最快的端到端验证：问一个「需要查证才能答对」的问题（例如某个本地文件的
版本号），故意让答案里出现没有依据的断言——`dryRun: false` 时应该看到一条
「【审判员 · 第 1 次复核：未通过】」以及模型随后补齐证据/降级表述。

## 8. 已知限制

- 草稿的流式显示无法撤回（见 §3）。
- 审判员自己也会错：`maxAttempts` + `dryRun` 观察期是必要的缓冲带。
- 只覆盖「通过 DSH agent loop 结束的轮次」；子代理默认跳过。
- 不写入自定义 session 事件（外部插件不允许），判定只进 logger 与驳回消息。
- 审计信息依赖 `transcriptChars` 预算：预算过小可能把关键工具证据截掉，
  导致误判 `unsupported`；证据密集的会话可调到 24000～32000。

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

插件目录：`C:\Users\XY\.dsh\plugins\dsh-judge`

1. **放进插件目录**（本仓库内容即插件）：

   ```bat
   xcopy /E /I F:\data\test\dsh-judge C:\Users\XY\.dsh\plugins\dsh-judge
   ```

2. **让 profile 能解析到包名**（二选一）：

   ```bat
   :: A. 直接建 junction（立刻生效）
   mklink /J C:\Users\XY\.dsh\profiles\desktop\node_modules\dsh-judge C:\Users\XY\.dsh\plugins\dsh-judge
   ```
   或在 profile 的 `package.json` 依赖里加
   `"dsh-judge": "file:C:/Users/XY/.dsh/plugins/dsh-judge"` 后 `pnpm install`。

3. **挂载**：在 `C:\Users\XY\.dsh\profiles\desktop\cordis.patch.yml` 追加

   ```yaml
   - id: dsh-judge
     name: dsh-judge
     config:
       enabled: true
       dryRun: true      # 先观察，确认判定合理后改成 false
       maxAttempts: 2
       submitTool: true
   ```

   profile 是 `"patchReload": "live"`，保存即热加载，无需重启。

4. **观察**：先跑几天 `dryRun: true`，日志里会出现
   `dsh-judge: DRY RUN: would reject answer`（含 issues / must_do / 草稿片段）。
   确认误判率可接受后改 `dryRun: false`。

## 5. 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `dryRun` | `false` | 只判定不驳回；首次部署建议 `true` |
| `maxAttempts` | `2` | 同一轮最多驳回几次（防死循环；到上限放行并 warn） |
| `minAnswerChars` | `40` | 太短的答案不审 |
| `onJudgeError` | `allow` | 审判调用失败时：`allow` 放行（可用优先）/ `revise` 驳回（正确优先） |
| `skipSubagents` | `true` | 跳过子代理（父代理那层会再审） |
| `language` | `zh` | 驳回意见语言：`zh` / `en` |
| `judgeProvider` / `judgeModel` | 空 | 审判模型路由；空 = 跟随当前会话 |
| `judgeMaxTokens` | `6000` | 审判输出上限（推理型模型会把推理也算进这个预算；正文为空会自动加倍重试一次） |
| `transcriptChars` | `14000` | 送审转录总预算（保留最近的） |
| `toolResultChars` | `1500` | 单条工具结果保留长度 |
| `submitTool` | `true` | 是否注册 `judge_review` 工具 |
| `promptOrder` | `900` | 系统提示词段落位置 |
| `contract` | 空 | 覆盖内置「审判员模式」契约文本 |

## 6. 调参建议

- **审判模型**：默认跟随主模型，省钱但可能有同源盲区。更严格时给
  `judgeProvider/judgeModel` 指一个不同家族的模型；更强但不省钱。
- **严格度**：改 `index.js` 顶部的 `JUDGE_POLICY`。最有效的两条是：
  - 把「必须满足 a/b/c 之一」改成只允许 a（必须工具证据，常识豁免取消）；
  - 把 `must_do` 从「降级表述」改成「必须补证据，否则不许输出该断言」。
- **只审"事实密集"的轮次**：把 `minAnswerChars` 调到 200，并给审判员加一条
  「若答案不含具体事实（版本/签名/路径/数字/日期/引文），直接 pass」。
- **成本**：每轮多一次审判调用（输入 ≈ 转录预算，输出 ≤ `judgeMaxTokens`）。
  一轮被驳回会再多一次主模型请求。

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

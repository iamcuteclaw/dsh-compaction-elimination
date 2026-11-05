# dsh-compaction-elimination

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的一个压缩策略插件：**先剔除垃圾，垃圾不够剔才压缩，而且压缩时只压前段、保留最近一段原文。**

一个包里塞了两件事，因为它们共用同一个闸门：

1. **Elimination** —— 把 `tool/result` 的整段回显换成一行 `[pwsh 输出已剔除 · 5000 字符]`。输入参数、思考链、回复、用户原话一个字不动。
2. **Tiered compaction** —— 剔完如果还是太满，按剔除收益分三档决定压多少、留多少。

## 为什么做这个

对一段真实的 404,191 tokens 会话历史做过统计（只算进入 surface 的节点）：

| 组成 | 占比 |
|---|---:|
| **工具输出回显** | **65.6%** |
| 用户原话 | 14.2% |
| 助手思考链 | 7.9% |
| 工具调用参数 | 6.2% |
| 助手回复正文 | 3.5% |
| 压缩摘要本身 | 1.6% |
| 助手输出文字 | 1.0% |

**实质内容只有 26.6%。** 也就是说官方 compaction 每次花一个 LLM 调用把几千行历史揉成摘要，揉掉的绝大部分是命令回显——那些东西本来就不该进上下文。

把它剔掉之后，800K 的会话直接落到 270K，根本轮不到压缩。

## 分档表

设 `U` = 触发时的实际占用，`R` = 剔除去掉的量：

| R 落在 | 动作 |
|---|---|
| `R > 55% U` | 只剔除 |
| `25% U < R ≤ 55% U` | 剔除 + 前 60% 压成摘要 + 后 40% 留原文 |
| `R ≤ 25% U` | 剔除 + 前 70% 压成摘要 + 后 30% 留原文 |

三档加起来都是 100%：压的和留的正好把已用量吃完，不留空洞。

收益越小说明垃圾越少、东西越实，那就压得越狠、留得越少。这样做的目的是**压到低水位**——只剔不压会让上下文永远卡在阈值线上反复横跳。

## 怎么用

### 1. 装

```bash
cd <dsh profile dir>   # 例如 ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-compaction-elimination
```

### 2. 配

在 agent preset 的 `plugins` 列表里加（或替换掉官方 pruner）：

```yaml
- id: tool-result-pruner
  name: 'dsh-compaction-elimination'
  config:
    minElideChars: 400
```

同时让官方 compaction 退休，免得两套逻辑打架：

```yaml
- id: compaction-basic
  name: '@deepseek-ai/dsh-compaction-basic'
  config:
    thresholdRatio: 0.99
```

### 3. 看

决策日志写到 `logFile`（默认 `C:/Users/Administrator/qq-bridge/state/agents/tiered-compaction.log`，**记得改成你自己的路径**）：

```
[info] pre-step: U=851759 window=1000000 threshold=800000 (85.2%)
[info] 低档(留30%) U=851759 R=0(0.0%) 压 1999 条/159324 token，留 1835 条 → 现 694014
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `minElideChars` | 400 | 单条回显超过多少字符才剔 |
| `keepErrorHeadChars` | 800 | 报错结果保留开头多少字符 |
| `elideErrors` | false | 是否连报错内容也剔干净 |
| `marker` | `[{name} 输出已剔除 · {chars} 字符{flag}]` | 替换文本模板 |
| `logFile` | 见上 | 决策日志路径 |

分档参数（`thresholdRatio` / `highRatio` / `midRatio` / `keepMid` / `keepLow`）目前硬编码在 `lib/host.js` 的 `TIER` 常量里，要调直接改。**没有走 config 是有原因的，见下面第 3 条。**

## 踩过的坑（这一段比代码值钱）

写这个插件的全过程里把会话日志写坏过三次，每次都是「这轮没压成」变成「整个会话打不开」。三条都是硬规则：

### 1. 必须走官方三段式事务

```
compaction/start  (turn 必须等于当前打开的 turn)
  → compaction/summary
  → 替换 surface 的 user/message
  → compaction/end
```

- 只写 `summary` 不写 `start/end` → `compaction/summary has no matching compaction/start`，日志作废
- `summary` 的 `shadowedSeqs` 不能遮住受保护的 system head → `compaction cannot shadow the protected system head`
- 任何一步失败都要补一条带 `error` 的 `compaction/end` 把闸关掉（官方允许 error 的 end 没有 summary），这样日志仍然合法，只是「这轮没压成」

### 2. `node 0` 是 system prompt

替换范围的 `startSeq` 不能是 `nodes[0]`，否则 `surface replace: node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node`。从 `nodes[1]` 开始。

### 3. checkpoint 必须有 `id`

替换 surface 的那条 `user/message` 如果没 `id`，**格式校验器能过，运行时过不了**：

```
session event at seq N lacks an identified message
```

而且这个错会让 qq-bridge 之类的消费者每 3 秒重连一次刷屏。用 `randomUUID()` 补上。

### 4. cordis 会按 schema 过滤未知配置字段

插件没导出 `Config` schema，preset 里写的自定义字段（比如 `logFile`）会被静默丢掉，`dump-config` 里也看不到。要传自定义配置就必须声明 schema，或者像本项目一样硬编码。

### 5. 不要指望 `ctx.logger`

DSH web 的 stdout 只在启动阶段刷屏，跑起来之后 `ctx.logger.info()` 既不回显到终端、也不落盘。要留痕只能自己 `appendFileSync`。

## 验证过什么

- `node --check` 语法
- 裸 cordis Context 里 `apply()` 能跑、能注册服务
- 影子实例（另一端口同一套 profile）能正常启动
- headless profile 里真跑通过完整链路：`compaction/prune: 2`、`compaction/summary: 0`，模型收到的工具结果只剩 `[pwsh 输出已剔除 · 899 字符]`

## 许可

MIT

# dsh-compaction-elimination

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的一个压缩策略插件：**先剔除垃圾，垃圾不够剔才压缩，而且压缩时只压前段、保留最近一段原文。**

一个包里塞了两件事，因为它们共用同一个闸门：

1. **Elimination** —— 把 `tool/result` 的整段回显换成一行 `[pwsh 输出已剔除 · 5000 字符]`。输入参数、思考链、回复、用户原话一个字不动。
2. **Tiered compaction** —— 剔完如果还是太满，按剔除收益分三档决定压多少、留多少。
3. **System-prompt elimination** —— 旧的系统提示词（保留最近 5 条非空）在同一个闸门里自动剔除，收益并入上面的 `R`；`/elimination -s` 是它的手动入口。

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

自动闸门在每个 step 触发（`U ≥ 80%·window` 时），先做**两级剔除**，再按剔除总收益决定压不压。

设 `U` = 触发时的实际占用，`R` = 两级剔除（工具回显 + 旧系统提示词）一共去掉的量：

| `R/U` | 动作 |
|---|---|
| `> 25%` | 只剔除，不压 |
| `10% ~ 25%` | 剔除 + 前 **30%** 压成摘要 + 后 **70%** 留原文 |
| `≤ 10%` | 剔除 + 前 **40%** 压成摘要 + 后 **60%** 留原文 |

- **收益并入系统提示词**：`R` 是工具回显剔除和旧系统提示词剔除的合计。大会话里系统提示词常是大头，只算工具回显会把收益比压低、误判成低档去压缩。
- **免压线**：剔除后如果已经低于窗口的 30%（中档）/ 45%（低档），就不再压——别为了走流程去压一段本来已经很轻的历史。
- 收益越小说明垃圾越少、内容越实，那就压得越狠、留得越少。

`TIER = { thresholdRatio: 0.8, highRatio: 0.25, midRatio: 0.1, keepMid: 0.7, keepLow: 0.6, maxTokens: 4096 }`，硬编码在 `lib/host.js`。

## 手动剔除命令 `/elimination`

两条用法：

- `/elimination` —— 手动剔一次工具回显（即自动闸门里工具回显那一路的同一套逻辑：只剔 `tool/result`，输入/思考/回复不动）。不压缩、不摘要。
- `/elimination -dr` —— 只读报告当前可剔除详情（见下）。
- `/elimination -s` —— 剔除旧系统提示词（自动闸门里也会做这件事，这条是手动入口）。会话里的 `system/message` 会随系统提示词变更逐条累积（路由支持 in-history 时，每步文本一变就追加一条），历史版本不再生效却仍占着上下文。这条命令**保留最近 5 条非空系统提示词**，更早的每条替换成一行：

  ```
  [elimination]已剔除 - 系统提示词总X字
  ```

  其中 `X` 是该条系统提示词自身的字符数。只有**非空（有效）**节点参与计数；空 `system/message` 是休眠态、不占上下文，不参与计数也不被替换。

两条硬约束（改这个功能前先看 `dsh-session/lib/index.js` · `assertSystemHeadRewrite`）：

1. **node 0 受保护**：覆盖 node0 的替换必须是 `system/message`，且恰好只盖它自己。命令正是逐条替换，满足此约束。
2. **`system/message` 的替换不要求打开的 turn**（要求打开 turn 的是 `tool/result`）；node0 那条的 `turn`/`step` 直接复用被替换节点自己的值，天然合法。
3. **替换形态分两种（为了让 UI 占用即时反映）**：
   - **node0**（受保护的系统头）→ 只能 `system/message` 覆盖它自己，**且不能配计量事件**（token-meter 的 `contextBreakdown` 对「有 claim 的 system 替换」直接抛错）。这条的 UI 扣减要等下一次真实请求的 usage 采样。
   - **其余旧节点** → `user/message` 标记 + 紧邻前面一条 `compaction/prune`。这样 `contextPressure` 投影（UI 右上角那个百分比）会**即时**把剔除计入扣减，`contextBreakdown` 也接受（替换物不是 `system/message`）。

   如果全用 `system/message` 无 claim，`measure().totalTokens`（插件日志里的 `U=`）会立刻降，但 UI 的 `projectedTokens` 要等下一次请求才刷新——这就是「日志里降了、UI 没动」的由来。`measure()` 是全量重算，`projectedTokens` 锚定「最近一次真实请求」，两者口径不同。

保留数量 `8` 目前硬编码在 `lib/host.js` 的 `保留系统提示词数`，要调直接改。

注意：`/elimination -s` 只剔**旧的**系统提示词，当前生效的（最近一条非空）永远保留，因此不会改变模型当下看到的系统提示词。

### `/elimination -dr`（只读详情）

报告当前可剔除量，**不改 surface、不花模型调用**：

```
当前可剔除量:工具输出 X token(Y%);系统提示词 Z token(W%).
```

- 分子 = 各类可剔除内容的**净 token**（原节点价 − 替换标记价），取的是 `tokenMeter.measure()` 的**节点价** —— 和分档的 `R` **同一把尺**。工具输出按现有门槛与替换规则判定（`minElideChars`、报错保留、标记更短才剔），系统提示词按「保留最近 5 条非空」判定。
- 分母 = **当前占用 `U`**（`measure().totalTokens`）。所以这个百分比可以直接预判档位：`>25%` → high，`>10%` → mid。
- 百分比保留一位小数；两项**不需要**相加为 100%。

### `/elimination-debug`（手动触发 / 开关自动）

不需要任何环境变量，命令**总是可用**：

| 参数 | 作用 |
|---|---|
| `high` | 立即按**高档**跑一次：只剔除，不压缩 |
| `mid` | 立即按**中档**跑一次：剔除 + 压 30% · 留 70% |
| `low` | 立即按**低档**跑一次：剔除 + 压 40% · 留 60% |
| `off` | **关闭自动剔除**（`agent/pre-step` 不再触发） |
| `on` | 重新开启自动剔除 |

- `high / mid / low` 是**一次性**的：只跑这一下，不改自动开关，也不常驻任何强制档。
- 强制档会**跳过阈值判断**（`U < 80%·window` 也照跑）并**跳过免压线**（否则小会话上 mid/low 压不动）。
- 跑之前要求有打开的 turn（分档会替换 `tool/result`，turn 外会写坏日志），没有就报错拒绝。
- `off` 只关自动闸门；手动 `/elimination`、`/elimination -s` 不受影响，照常可用。

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

决策日志默认写到 `~/.dsh/elimination.log`，可以用环境变量 `DSH_ELIMINATION_LOG` 换位置：

```
[info] pre-step: U=851759 window=1000000 threshold=800000 (85.2%)
[info] 中档(压30%·留70%) U=851759 R=238000(27.9%) 压 1999 条/159324 token，留 1835 条 → 现 552000
```

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `minElideChars` | 400 | 单条回显超过多少字符才剔 |
| `keepErrorHeadChars` | 800 | 报错结果保留开头多少字符 |
| `elideErrors` | false | 是否连报错内容也剔干净 |
| `marker` | `[{name} 输出已剔除 · {chars} 字符{flag}]` | 替换文本模板 |
| `logFile` | 见上 | 决策日志路径（环境变量 `DSH_ELIMINATION_LOG`） |

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
- 离线回归（`C:\Users\Administrator\AppData\Local\Temp\opencode\` 下的 `elimination-*.mjs`）：
  - `elimination-tier-test`：TIER 常量 + 闸门先剔工具回显再剔系统提示词再测 U2
  - `elimination-sysprompt-test`：`-s`/`-dr` 的口径（保留 5 条、head 走 system、尾部走 user+claim、`选旧系统提示词`、`全文字数`）
  - `elimination-sysprompt-fold`：用真实 `foldSurface` 验证替换形态（node0 保护的正反例、非头节点换 user/message 合法）
  - `elimination-tokenmeter-test`：锁死「有 claim 的 system 替换会被 contextBreakdown 拒绝」这条约束
  - `elimination-handler-smoke`：真加载插件端到端跑 `/elimination`、`-s`、`-dr`、`-debug`

## 附带的修复工具（tools/）

万一会话日志已经被写坏了，这两个脚本能把它救回来。

- **`restore_transform.py`** —— 从 zstd 日志里恢复被压缩掉的原文，同时把工具回显剔除。原理是把那条摘要的 `type` 改成未知类型并标 `ignorable: true`，让 `foldSurface` 忽略它，被遮蔽的原文就全部回到 surface。**seq 一个都不动**。
- **`restore-manual.ps1`** —— 手动执行版：确认 DSH web 已停 → 备份 → 跑 transform → 产物 >1MB 才覆盖。**不碰任何进程**，因为「用自己的进程去终结自己的宿主」这件事天然不可靠。

两条硬要求（踩过才知道）：

1. 读日志必须 `bytes.split(b'\n')`，**不要用 `TextIOWrapper`** —— universal newlines 会把 `\r` 也当行尾，把行拆碎，JSON 全解析失败。
2. 写日志必须**两帧**：第一帧只装 session 头那一行，第二帧装其余全部。整个文件压成一帧会报 `corrupt Zstandard session log: first frame is not exactly one header line`。

## 许可

MIT

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

// @deepseek-ai/dsh-* 这些包不在 profile 的解析路径里，只能按宿主的安装位置去找。
// 找的顺序：DSH_MODULES_ROOT 环境变量 → 从 dsh 的 bin.js 往上推 → require.resolve。
// 全都找不到就返回 null，由调用方决定是兜底还是报错——绝不拿它当前置条件。
function 找宿主模块(包名, 相对入口) {
  const 候选 = []
  const 根 = process.env.DSH_MODULES_ROOT
  if (根) 候选.push(join(根, '@deepseek-ai', 包名, 相对入口))
  const bin = process.argv[1] ?? ''
  const m = bin.match(/^(.*?)[\\/]lib[\\/]bin\.js$/i)
  if (m) 候选.push(join(m[1], 'node_modules', '@deepseek-ai', 包名, 相对入口))
  try { 候选.push(require_.resolve(`${包名}/${相对入口}`)) } catch { /* 没有就算了 */ }
  for (const p of 候选) if (existsSync(p)) return pathToFileURL(p).href
  return null
}

// CommandDefinitionId 在 brand.js 里就是 `(id) => id`，不做任何校验。
// 所以这里直接用等价的兜底，不去动态 import——少一个能崩的地方。
const CommandDefinitionId = (id) => id

// dsh-compaction-elimination · 宿主半边
//
// 要解决的事只有一件：
//   **在「压缩」发生之前，先把不是话的东西剔干净。**
//
// 为什么这么做：
//   实测一段 404191 tokens 的会话历史里，tool/result 的回显占 65.6%，
//   而真正的「他说的 + 我说的 + 我思考的」只有 26.6%。
//   也就是说，官方 compaction 每次花一个 LLM 调用、把四千行历史揉成一段摘要，
//   揉掉的绝大部分是命令回显和搜索结果——那些东西本来就不值得进上下文。
//
// 官方 compaction-basic 里已经留好了这个口子（`compactIfNeeded`）：
//
//     if (measurement.totalTokens < spec.thresholdTokens) return null;
//     const prune = this.ctx.get("toolResultPruner");
//     if (prune !== void 0) {
//         prune.pruneSession(agent.session);      // ← 先剔除
//         measurement = meter.measure(agent.session);
//     }
//     if (measurement.totalTokens < spec.thresholdTokens) return null;   // ← 降下来了就不压缩
//     ... 还是超，才真正 compaction
//
// 所以本插件不碰 compaction，只把 `toolResultPruner` 这个服务名接管过来，
// 换成一个够狠的实现。官方那套「Compaction」于是自动变成「先 Elimination、
// 实在不行才 Compaction」。
//
// 剔什么、留什么（这是本插件唯一的主张）：
//   剔除①：`tool/result` 的整段回显（命令输出、搜索结果、文件内容……）
//   剔除②：旧的系统提示词——只保留最近 8 条非空 `system/message`，更早的逐条替换成一行标记
//          （`system` 头那条走无计量替换，其余走 `compaction/prune` + `user/message` 标记）。
//   保留：`assistant.reasoning`（思考链）、`assistant.text`（回复）、
//         `user/message`（他说的话）、**`tool/call` 的完整输入参数**
//   替换后只留一行：什么工具、跑了多少字符、是不是报错
//
// 刻意没有的东西：按比例压缩、保留头部 N 千字、分类白名单、按工具名区分。
// 回显就是回显，留一行足够我知道「我调过它、它回了多少」。

/** 插件对外名字。 */
export const name = 'compaction-elimination'

/** 需要宿主提供的服务。拿不到 tokenMeter 就不要加载，免得记账算错。
 *  commands 用来注册 /elimination（手动剔一次）。 */
export const inject = ['tokenMeter', 'commands']

const 默认配置 = {
  /** 小于这个字符数的回显不动（短结果留着比剔掉更省事）。 */
  minElideChars: 400,
  /** 报错的结果保留开头这么多字符，方便回溯失败原因。 */
  keepErrorHeadChars: 800,
  /** 是否连报错内容也剔（true 时只看得到「报错了」）。 */
  elideErrors: false,
  /** 替换文本的模板（{name} 工作名 / {chars} 原字符数 / {flag} 错误标记）。 */
  marker: '[{name} 输出已剔除 · {chars} 字符{flag}]',
}

function 解析配置(config = {}) {
  const c = { ...默认配置, ...config }
  if (!Number.isInteger(c.minElideChars) || c.minElideChars < 0) throw new Error('compaction-elimination: minElideChars 必须是非负整数')
  if (!Number.isInteger(c.keepErrorHeadChars) || c.keepErrorHeadChars < 0) throw new Error('compaction-elimination: keepErrorHeadChars 必须是非负整数')
  if (typeof c.marker !== 'string' || c.marker.length === 0) throw new Error('compaction-elimination: marker 必须是非空字符串')
  return c
}

/** 数 Unicode 码点，别把代理对劈开。 */
function 长度(text) {
  return Array.from(text).length
}

/** 深冻结，对齐官方 freezeMessage 的语义（官方实现是 deepFreeze(structuredClone(x))）。 */
function 深冻结(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) 深冻结(value[key])
  }
  return value
}

/** 产生一条不可变的消息副本，行为与官方 freezeMessage 一致。 */
function 冻结消息(message) {
  return 深冻结(structuredClone(message))
}

function 量内容(blocks) {
  let n = 0
  for (const b of blocks || []) if (b && b.type === 'text') n += 长度(b.text || '')
  return n
}

function 是文本(b) {
  return b && b.type === 'text'
}

/**
 * 找出这次 surface 里每个 tool-call 的名字，用来给回显贴标签。
 * 工具名只存在于 `assistant/message` 的 tool-call 块里，`tool/result` 自己不带。
 */
function 建工具名表(session) {
  const 表 = new Map()
  for (const seq of [...session.surface.nodes]) {
    const ev = session.eventAt(seq)
    if (ev?.type !== 'assistant/message') continue
    for (const c of ev.data?.message?.content ?? []) {
      if (c && c.type === 'tool-call' && c.id) 表.set(c.id, c.name || 'tool')
    }
  }
  return 表
}

// ───────────── /elimination -s：剔除旧系统提示词 ─────────────
// 会话里 system/message 节点会随「系统提示词变更」累积（路由支持 in-history 时，每步文本一变就追加一条）。
// 这些历史版本不再生效，却仍然占着上下文。这里保留最近 8 条「非空」的系统提示词，其余每条替换成一行标记。
//
// 两条硬约束（读 dsh-session 源码确认）：
//   1. node 0 受保护：覆盖 node0 的替换必须是 system/message，且恰好只盖它自己
//      （surface.js · assertSystemHeadRewrite）。我们逐条替换、类型就是 system/message，正好满足。
//   2. 只有非空节点才算「提示词」：空 system 节点是休眠态，投影成空、不占上下文，不需要也不该被替换。
//
// 与工具回显不同：system/message 的 surface replace 不要求打开的 turn（那是 tool/result 的规矩），
// 且 turn/step 直接复用被替换节点自己的值，天然合法。
const 保留系统提示词数 = 5

/** 一条 system/message 的可见文本（拼接所有 text 块）。 */
function 系统提示词文本(msg) {
  let text = ''
  for (const b of msg?.content ?? []) if (b && b.type === 'text') text += (b.text || '')
  return text
}

/**
 * 当前打开的 turn + step，两者都有才返回，否则 null。
 *
 * `system/message` 属于 persistence 的 STEP_EVENT_TYPES：任何一条 system/message 事件的
 * `turn`/`step` 都必须等于「此刻打开的 turn 和 step」，否则加载会话时报
 * `system/message does not match an open turn and step`，整个日志判损坏。所以覆盖系统头
 * 之前必须能取到这两个值；取不到就放弃覆盖头（保留 node0）。
 */
function 找开放turn步(session) {
  let turn = null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const ev = session.eventAt(seq)
    if (!ev) continue
    if (ev.type === 'turn/end') return null
    if (ev.type === 'turn/start') { turn = ev.data?.turn ?? null; break }
  }
  if (turn === null) return null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const ev = session.eventAt(seq)
    if (!ev) continue
    if (ev.type === 'step/end') return null
    if (ev.type === 'step/start') {
      const step = ev.data?.step ?? null
      return step === null ? null : { turn, step }
    }
    if (ev.type === 'turn/start') return null
  }
  return null
}

/**
 * 选出「保留最近 N 条非空系统提示词」之后应当被剔除的那些（只读，不改 surface）。
 * 供 /elimination -s 与 /elimination -dr 共用，保证两者口径永远一致。
 * @returns {{ 全部: Array, 剔除数: number }}
 */
function 选旧系统提示词(session) {
  const nodes = session.surface.nodes
  const 全部 = []
  for (let index = 0; index < nodes.length; index += 1) {
    const seq = nodes[index]
    const ev = session.eventAt(seq)
    if (ev?.type !== 'system/message') continue
    const msg = ev.data?.message
    const text = 系统提示词文本(msg)
    if (text.length === 0) continue
    全部.push({ seq, index, ev, msg, chars: 长度(text) })
  }
  const 剔除数 = Math.max(0, 全部.length - 保留系统提示词数)
  return { 全部, 剔除数 }
}

/**
 * 保留最近「保留系统提示词数」条非空系统提示词，把更早的逐条替换成标记。
 * 每条标记里的 X 是该条系统提示词自身的字符数。
 *
 * 替换形态分两种：
 *   1. 受保护的系统头（surface 索引 0）：只能用 `system/message` 覆盖它自己，且不能配
 *      计量事件（token-meter 的 contextBreakdown 对「有 claim 的 system 替换」抛错）。
 *      它属于 STEP_EVENT_TYPES，`turn`/`step` 必须取**当前打开的**那对，不能沿用原节点的；
 *      取不到当前 turn/step 就跳过它（保留 node0），否则会把日志写坏。
 *   2. 其余旧节点：替换成 `user/message` 标记，并在紧邻前面写一条 `compaction/prune`，
 *      让 contextPressure（UI 那个百分比）即时扣减。`user/message` 不要求 turn/step。
 *
 * @param session - 当前会话
 * @param 估token - 返回一条消息启发式 token 数的函数（= tokenMeter.estimateMessage）
 * @returns {{ total:number, kept:number, eliminated:number, skippedHeads:number, chars:number, items:Array }}
 */
function 剔除旧系统提示词(session, 估token) {
  const { 全部, 剔除数 } = 选旧系统提示词(session)
  const 待剔 = 全部.slice(0, 剔除数)
  const 开放 = 待剔.some((x) => x.index === 0) ? 找开放turn步(session) : null
  const items = []
  let chars = 0
  let skippedHeads = 0
  for (const { seq, index, ev, msg, chars: 原字数 } of 待剔) {
    const marker = `[elimination]已剔除 - 系统提示词总${原字数}字`
    if (index === 0) {
      if (开放 === null) { skippedHeads += 1; continue }
      const message = 冻结消息({ ...msg, content: [{ type: 'text', text: marker }] })
      session.append('system/message', { turn: 开放.turn, step: 开放.step, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
    } else {
      // 影子价协议：先 compaction/prune 声明被遮盖节点的启发式价格，
      // 紧邻的 user/message 替换才会被 contextPressure 计入扣减（UI 即时反映）。
      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: 估token(msg),
      })
      const message = 冻结消息({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: marker }],
        source: { kind: 'elimination' },
      })
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
    }
    items.push({ seq, chars: 原字数, head: index === 0 })
    chars += 原字数
  }
  return { total: 全部.length, kept: 全部.length - items.length, eliminated: items.length, skippedHeads, chars, items }
}

/** 当前 surface 里所有可见文本块的字符总数——/elimination -dr 里百分比的分母。 */
function 全文字数(session) {
  let n = 0
  for (const seq of [...session.surface.nodes]) {
    const ev = session.eventAt(seq)
    if (!ev) continue
    const msg = session.deriveEventMessage(ev)
    if (msg) n += 量内容(msg.content)
  }
  return n
}

export function apply(ctx, config) {
  const cfg = 解析配置(config)

  /**
   * 自动剔除开关。true 时 `agent/pre-step` 会触发 `分档`；`/elimination-debug off` 关、`on` 开。
   * 只影响自动闸门；手动命令（`/elimination`、`/elimination -s`）不受它影响。
   */
  let 自动开启 = true

  /**
   * 把当前 surface 里所有超长的 tool/result 回显替换成一行痕迹。
   * 每个替换都会先写一条 `compaction/prune` 记账事件（官方纯消费者靠它算省了多少），
   * 再 append 一条带 `surfaceOp: replace` 的新 tool/result 把原节点遮蔽掉。
   */
  function pruneSession(session, 干跑 = false) {
    const 工具表 = 建工具名表(session)
    const 待处理 = []

    for (const seq of [...session.surface.nodes]) {
      const ev = session.eventAt(seq)
      if (ev?.type === 'tool/result') 待处理.push({ seq, ev })
    }

    const pruned = []
    let charsRemoved = 0
    let charsEligible = 0
    // token 口径：替换前后的启发式价差（和 measure()/分档 同一把尺）。
    let tokensEligible = 0
    const 净token = (msg, 新content) => {
      try {
        const before = ctx.tokenMeter.estimateMessage(msg)
        const after = ctx.tokenMeter.estimateMessage({ ...msg, content: 新content })
        return Math.max(0, (before ?? 0) - (after ?? 0))
      } catch {
        return 0
      }
    }

    for (const { seq, ev } of 待处理) {
      const original = session.deriveEventMessage(ev)
      if (!original || !Array.isArray(original.content)) continue

      const 原字符 = 量内容(original.content)
      if (原字符 < cfg.minElideChars) continue

      const 报错 = ev.data?.isError === true || ev.data?.message?.isError === true
      if (报错 && cfg.elideErrors === false) {
        // 报错保留开头，剩下的照剔——既知道错了，也不留几十屏堆栈。
        const 保留 = []
        let 已留 = 0
        for (const b of original.content) {
          if (!是文本(b)) continue
          const 点 = Array.from(b.text || '')
          const 可留 = Math.max(0, cfg.keepErrorHeadChars - 已留)
          const 片段 = 点.slice(0, 可留).join('')
          已留 += 长度(片段)
          if (片段) 保留.push(`[${片段}]`)
        }
        const callId = ev.data?.message?.source?.callId || ev.data?.message?.toolCallId
        const 名 = 工具表.get(callId) || 'tool'
        const 新文本 = `${cfg.marker.replace('{name}', 名).replace('{chars}', String(原字符)).replace('{flag}', ' · 报错')}\n${保留.join('')}`
        const 新content = [{ type: 'text', text: 新文本 }]
        const 新字符 = 长度(新文本)
        if (新字符 >= 原字符) continue

        charsEligible += 原字符
        tokensEligible += 净token(original, 新content)
        let replacementSeq
        if (!干跑) {
          session.append('compaction/prune', {
            shadowedRange: { start: seq, end: seq },
            shadowedSeqs: [seq],
            shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
          })
          const message = 冻结消息({ ...original, content: 新content })
          replacementSeq = session.append('tool/result', { ...ev.data, message }, {
            surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
            sourceEventSeqs: [seq],
          }).seq
        }
        pruned.push({ originalSeq: seq, replacementSeq, tool: 名, charsBefore: 原字符, charsAfter: 新字符 })
        charsRemoved += 原字符 - 新字符
        continue
      }

      const callId = ev.data?.message?.source?.callId || ev.data?.message?.toolCallId
      const 名 = 工具表.get(callId) || 'tool'
      const 新文本 = cfg.marker
        .replace('{name}', 名)
        .replace('{chars}', String(原字符))
        .replace('{flag}', 报错 ? ' · 报错' : '')
      const 新content = [{ type: 'text', text: 新文本 }]
      const 新字符 = 长度(新文本)
      if (新字符 >= 原字符) continue

      charsEligible += 原字符
      tokensEligible += 净token(original, 新content)
      let replacementSeq
      if (!干跑) {
        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
        })
        const message = 冻结消息({ ...original, content: 新content })
        replacementSeq = session.append('tool/result', { ...ev.data, message }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        }).seq
      }
      pruned.push({ originalSeq: seq, replacementSeq, tool: 名, charsBefore: 原字符, charsAfter: 新字符 })
      charsRemoved += 原字符 - 新字符
    }

    if (!干跑 && pruned.length > 0) {
      ctx.logger?.info?.(
        `elimination: 剔除 ${pruned.length} 条工具回显，省下 ${charsRemoved} 字符（约 ${Math.round(charsRemoved * 0.183)} tokens）`,
      )
    }

    return { pruned, charsRemoved, charsEligible, tokensEligible }
  }


  // ───────────── 分档压缩（原本打算单独一个插件，但它加载不了，并进来） ─────────────
  // 剔除和压缩是同一个闸门的两级：到阈值 → 先剔 → 剔完够就收工，
  // 不够就压到低水位。只剔不压会在阈值附近反复横跳。
  // 分档（口径：按两级剔除的总收益比 R/U）：
  //   R > 25%U        → 只剔除，不压
  //   10%U < R ≤ 25%U → 剔除 + 前 30% 压成摘要 + 后 70% 留原文
  //   R ≤ 10%U        → 剔除 + 前 40% 压成摘要 + 后 60% 留原文
  // 收益 R 计入两级剔除：① 工具回显 ② 旧系统提示词（保留最近 8 条）。
  const TIER = { thresholdRatio: 0.8, highRatio: 0.25, midRatio: 0.1, keepMid: 0.7, keepLow: 0.6, maxTokens: 4096 }
  const LOG = process.env.DSH_ELIMINATION_LOG ?? join(homedir(), '.dsh', 'elimination.log')
try { mkdirSync(dirname(LOG), { recursive: true }) } catch { /* 建不了就只是不写日志 */ }

  function 记(级别, 行) {
    const text = `[${new Date().toISOString()}] [${级别}] ${行}`
    try { appendFileSync(LOG, text + '\n', 'utf8') } catch {}
    try { console.log(`[elimination] ${行}`) } catch {}
  }

  记('info', 'loaded: elimination + tiered merged')

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (!自动开启) return next()
    try { await 分档(ctx, agent, signal) } catch (e) { 记('warn', `skipped: ${e?.message ?? e}`) }
    return next()
  }, true)

  function 量消息(meter, msg) {
    try { const n = meter.estimateMessage(msg); if (typeof n === 'number' && n > 0) return n } catch {}
    let chars = 0
    for (const b of msg?.content ?? []) if (b && b.type === 'text') chars += (b.text || '').length
    return Math.ceil(chars / 2)
  }

  /**
   * 从日志尾部往回找当前打开的 turn；没有打开的 turn 返回 null。
   * 官方 compaction/start 的 turn 字段必须等于当前打开的 turn（或者事件本来就写在 turn 外时才允许 null），
   * 对不上就是 "compaction/start does not match the open turn"。
   */
  function 找开放turn(session) {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const ev = session.eventAt(seq)
      if (ev?.type === 'turn/start') return ev.data?.turn ?? null
      if (ev?.type === 'turn/end') return null
    }
    return null
  }

  async function 分档(ctx, agent, signal, 强制档 = null) {
    const session = agent.session
    const 路由 = session.requestHeader?.()?.config
    const provider = 路由?.provider
    const model = 路由?.model
    if (!provider || !model) return
    const llm = ctx.get('llm')
    const meter = ctx.get('tokenMeter')
    if (!llm || !meter) return

    const info = await llm.resolveModelInfo(provider, model, signal)
    const window = info?.context?.contextWindow
    if (!window) return

    const 阈值 = Math.floor(window * TIER.thresholdRatio)
    const U = meter.measure(session).totalTokens
    记('info', `pre-step: U=${U} window=${window} threshold=${阈值} (${((U / window) * 100).toFixed(1)}%)`)

    // 强制档由 /elimination-debug high|mid|low 一次性传入，跳过阈值判断，也不看免压线。
    // 自动闸门不传它，走正常的「阈值 + 收益比」判档。
    if (强制档) 记('info', `强制档=${强制档}（跳过阈值判断）`)
    if (!强制档 && U < 阈值) return

    // 两级剔除都算进收益：① 工具回显 ② 旧系统提示词（保留最近 5 条）。
    // 分别在两级之间各测一次，把各自的收益打进日志——否则"系统提示词那部分到底进没进 R"
    // 从日志上看不出来。只在真有条目可剔时才多测一次，避免每步多付一次全量重放。
    pruneSession(session)
    const 系统可剔 = 选旧系统提示词(session).剔除数
    const U1 = 系统可剔 > 0 ? meter.measure(session).totalTokens : null
    const 系统结果 = 剔除旧系统提示词(session, (m) => 量消息(meter, m))
    const 后 = meter.measure(session)
    const U2 = 后.totalTokens
    const R = U - U2
    const 收益比 = R / U
    if (U1 !== null) {
      记('info', `两级剔除: 工具回显 -${U - U1} token；系统提示词 -${U1 - U2} token（剔 ${系统结果.eliminated} 条 / ${系统结果.chars} 字${系统结果.skippedHeads > 0 ? `，跳过受保护头 ${系统结果.skippedHeads}` : ''}）`)
    }

    // 档位：有强制档就用它，没有才按剔除收益比判。
    const 判定档 = 强制档 ?? (收益比 > TIER.highRatio ? 'high' : 收益比 > TIER.midRatio ? 'mid' : 'low')

    if (判定档 === 'high') {
      记('info', `只剔除: U=${U} R=${R}(${(收益比 * 100).toFixed(1)}%) → 现 ${U2}${强制档 ? ' [强制]' : ''}`)
      return
    }

    const 保留比 = 判定档 === 'mid' ? TIER.keepMid : TIER.keepLow
    const 档位 = 判定档 === 'mid' ? '中档(压30%·留70%)' : '低档(压40%·留60%)'

    // 免压线（他定的，与上面的压/留比例相互独立）：剔除已经把量降到足够低就不再压，
    // 别为了走流程去压一段本来已经很轻的历史。
    //   中档：剔完低于窗口 30% 就别压了
    //   低档：剔完低于窗口 45% 就别压了
    const 免压比 = 判定档 === 'mid' ? 0.30 : 0.45
    const 免压线 = Math.floor(window * 免压比)
    if (!强制档 && U2 < 免压线) {
      记('info', `剔除后 U=${U2} 已低于免压线 ${免压线}（${(免压比 * 100).toFixed(0)}%），跳过压缩`)
      return
    }

    // measure().nodes 不是 seq 数组（拿它当 seq 去 eventAt 会全空）——
    // 用 surface.nodes，那才是事件 seq 列表，pruneSession 里就是这么用的。
    const nodes = [...session.surface.nodes]
    const 消息表 = new Map()
    for (const seq of nodes) {
      const ev = session.eventAt(seq)
      if (!ev) continue
      const msg = session.deriveEventMessage(ev)
      if (msg) 消息表.set(seq, msg)
    }

    // 两把尺子必须统一：measure().totalTokens 和逐条 estimateMessage 口径差了约 40%，
    // 拿 A 尺的总量当目标、用 B 尺逐条累加去凑，会切得太靠前（压不够）。
    // 所以先用同一把尺（estimateMessage）把整条 surface 估一遍，再按比例切。
    let 估算总量 = 0
    for (const seq of nodes) {
      const msg = 消息表.get(seq)
      if (msg) 估算总量 += 量消息(meter, msg)
    }
    const 目标 = Math.floor(估算总量 * 保留比)
    let acc = 0
    let 保留起点 = 0
    for (let i = nodes.length - 1; i >= 0; i--) {
      const msg = 消息表.get(nodes[i])
      if (!msg) continue
      acc += 量消息(meter, msg)
      if (acc >= 目标) { 保留起点 = i; break }
    }
    if (保留起点 <= 0) { 记('warn', `算不出可切边界: nodes=${nodes.length} 估算总量=${估算总量} acc=${acc} 目标=${目标} 消息表=${消息表.size}`); return }

    // node 0 是 system prompt，只能由 system/message 覆盖它，用别的类型替换会被拒：
    // "node 0 holds the system prompt and may be rewritten only by a system/message over exactly that node"
    // 所以压缩范围从 nodes[1] 开始，system prompt 永远不动。
    if (保留起点 <= 1) { 记('warn', `保留起点=${保留起点} 太小（system prompt 占 node 0），放弃`); return }
    // 再确认一次 node 0 确实是 system prompt。遮住 head 的话官方会直接判日志损坏
    // （"compaction cannot shadow the protected system head"），一次就把会话写废，不能靠猜。
    const 节点零 = session.eventAt(nodes[0])
    if (节点零?.type !== 'system/message') {
      记('warn', `node0 不是 system prompt（${节点零?.type ?? 'missing'}），放弃`)
      return
    }
    const startSeq = nodes[1]
    const endSeq = nodes[保留起点 - 1]
    const shadowedSeqs = nodes.slice(1, 保留起点)

    let 前段token = 0
    for (const seq of shadowedSeqs) {
      const msg = 消息表.get(seq)
      if (msg) 前段token += 量消息(meter, msg)
    }
    if (前段token <= 0) return

    const 前段消息 = []
    for (let i = 0; i < 保留起点; i++) {
      const msg = 消息表.get(nodes[i])
      if (msg) 前段消息.push(msg)
    }

    const 指令 = '把上面这段对话压缩成摘要。保留事实：用户说过的话、约定、偏好、决定、事件及其时间；保留未完成事项和未解决问题。丢弃过程细节：命令输出、试错、被推翻的中间方案、寒暄。用第三人称陈述，不要评价。直接输出摘要正文。'
    const 宿主LLM = 找宿主模块('dsh-llm', 'lib/index.js')
    if (!宿主LLM) throw new Error('找不到 @deepseek-ai/dsh-llm；把 DSH_MODULES_ROOT 指向 dsh 安装目录下的 node_modules')
    const { BlockAssembler } = await import(宿主LLM)
    const 组装 = new BlockAssembler()
    const 类型集 = new Set()
    for await (const chunk of llm.stream({
      provider, model,
      messages: [...前段消息, { role: 'user', content: [{ type: 'text', text: 指令 }] }],
      toolHistory: session.toolHistory?.(),
      maxTokens: TIER.maxTokens,
      sessionId: session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    })) {
      类型集.add(chunk?.type)
      组装.push(chunk)
    }
    let text = ''
    try {
      for (const b of 组装.blocks() ?? []) if (b && typeof b.text === 'string') text += b.text
    } catch (e) {
      记('warn', `assembler.blocks() 失败: ${e?.message ?? e}`)
    }
    if (!text.trim()) { 记('warn', `摘要没产出，chunk 类型: ${[...类型集].join(',')}`); return }

    // 官方 Session 运行时要求每条 user/message 有 id（"session event at seq N lacks an identified message"），
    // 格式校验器不查这条，但网关加载会话时会查——漏了就是整仓打不开。
    const checkpoint = {
      role: 'user',
      id: randomUUID(),
      content: [{ type: 'text', text: `[历史压缩 · 前 ${((保留起点 / nodes.length) * 100).toFixed(0)}% 已摘要]\n\n${text.trim()}` }],
      source: { kind: 'compaction-checkpoint' },
    }
    const 摘要token = 量消息(meter, checkpoint)
    if (摘要token >= 前段token) { 记('warn', `摘要${摘要token} >= 原文${前段token}，放弃`); return }

    // 官方 compaction 是三段式：compaction/start → summary →（替换 surface）→ compaction/end。
    // 只写 summary 不写 start 会被判 "compaction/summary has no matching compaction/start"，
    // 整个会话一样打不开。所以这里整段包在 start/end 里，失败也补一条带 error 的 end 把闸关掉。
    const turn = 找开放turn(session)
    if (turn === null) { 记('warn', '当前没有打开的 turn，压缩事件无处安放，放弃'); return }
    const compactionId = `tiered-${Date.now()}`
    const lifecycle = { compactionId, turn }
    session.append('compaction/start', lifecycle)
    try {
      // 顺序不能反：summary 的 shadowedSeqs 必须命中「此刻仍是 surface 的那段」，
      // 所以先写 summary，再写替换；替换的 sourceEventSeqs 带上 summary 自己（对齐官方）。
      const 摘要事件 = session.append('compaction/summary', {
        compactionId,
        summary: [{ type: 'text', text: text.trim() }],
        shadowedRange: { start: startSeq, end: endSeq },
        shadowedSeqs,
        shadowedTokenCount: 前段token,
        provider, model,
      })
      session.append('user/message', checkpoint, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: [摘要事件.seq, ...shadowedSeqs],
      })
    } catch (e) {
      记('error', `CRITICAL 压缩事务失败（start 已写，补 end 收尾）：${e?.message ?? e}`)
      try {
        session.append('compaction/end', { ...lifecycle, error: String(e?.message ?? e) })
      } catch (closeError) {
        记('error', `CRITICAL 连 compaction/end 都写不进去，日志很可能已经不一致：${closeError?.message ?? closeError}`)
      }
      throw e
    }
    session.append('compaction/end', lifecycle)

    const 终 = meter.measure(session).totalTokens
    记('info', `${档位} U=${U} R=${R}(${(收益比 * 100).toFixed(1)}%) 压 ${shadowedSeqs.length} 条/${前段token} token，留 ${nodes.length - 保留起点} 条 → 现 ${终}`)
  }

  // 刻意不 provide('toolResultPruner')：剔除只由上面 agent/pre-step 的分档流程触发一次。
  // 暴露成服务会让 compaction-basic 之类在别处再调一遍，等于同一批回显被剔两次。

  // /elimination —— 手动剔一次，不压缩。
  // 有些时候上下文还没到阈值，但我知道里面堆了一堆没用的回显，想当场清掉。
  // 写法对齐 dsh-pet 的 /chat：ctx.effect(() => ctx.commands.register({...}))。
  // （先前用 ctx.inject + generator 的写法能跑通日志，但命令进不了 list，UI 里看不见。）
  记('info', '/elimination: 开始注册')
  try {
    ctx.effect(() => ctx.commands.register({
      definitionId: CommandDefinitionId('@qq/dsh-compaction-elimination'),
      name: 'elimination',
      description: '手动剔除：默认剔工具回显；-s 剔旧系统提示词（保留最近 8 条）；-dr 只读报告可剔除详情',
      input: { hint: '-s 剔旧系统提示词；-dr 看可剔除详情；留空剔工具回显' },
      handler: async (invocation) => {
        const session = invocation?.agent?.session
        if (!session) return { kind: 'error', text: '拿不到当前会话，剔不了。' }

        // 命令参数：/elimination -s（也接受带引号的 "-s" / '「-s」'）。
        const 参数 = String(invocation?.rawInput ?? '').trim().replace(/^["'「」]+|["'「」]+$/gu, '')

        // -dr：只读报告当前可剔除详情，不改 surface。
        //   口径 = **token**，和分档同一把尺（measure() 的节点价）：
        //     分子 = 各类可剔除内容的净 token（原节点价 − 替换标记价）
        //     分母 = 当前占用 U（measure().totalTokens）
        //   所以百分比可以直接预判档位：>25% → high，>10% → mid。
        if (参数 === '-dr') {
          const meter = ctx.get('tokenMeter')
          let 测算 = null
          try { 测算 = meter ? meter.measure(session) : null } catch (e) { 记('warn', `-dr measure 失败: ${e?.message ?? e}`) }
          const U = 测算 ? 测算.totalTokens : 0
          const 工具 = pruneSession(session, true)
          const 价 = new Map((测算?.nodes ?? []).map((n) => [n.seq, n.tokens]))
          const { 全部, 剔除数 } = 选旧系统提示词(session)
          const 系统token = 全部.slice(0, 剔除数).reduce((sum, x) => {
            let 新价 = 0
            try {
              新价 = meter ? meter.estimateMessage({ role: 'user', content: [{ type: 'text', text: `[elimination]已剔除 - 系统提示词总${x.chars}字` }] }) : 0
            } catch { 新价 = 0 }
            return sum + Math.max(0, (价.get(x.seq) ?? 0) - 新价)
          }, 0)
          const 百分比 = (n) => (U > 0 ? ((n / U) * 100).toFixed(1) : '0.0')
          const 文本 = `当前可剔除量:工具输出 ${工具.tokensEligible} token(${百分比(工具.tokensEligible)}%);系统提示词 ${系统token} token(${百分比(系统token)}%).`
          记('info', `/elimination -dr: U=${U} ${文本}`)
          return { kind: 'success', text: 文本 }
        }

        // -s：剔除旧系统提示词。
        // system/message 的替换不要求打开的 turn（那是 tool/result 的规矩），所以这条分支不做 turn 检查。
        if (参数 === '-s') {
          const meter = ctx.get('tokenMeter')
          const 前 = meter ? meter.measure(session).totalTokens : null
          const 估token = (m) => {
            try { const n = meter?.estimateMessage(m); return typeof n === 'number' && n > 0 ? n : 0 } catch { return 0 }
          }
          let 结果
          try {
            结果 = 剔除旧系统提示词(session, 估token)
          } catch (e) {
            记('error', `/elimination -s 失败: ${e?.message ?? e}`)
            return { kind: 'error', text: `剔除系统提示词失败：${e?.message ?? e}` }
          }
          if (结果.eliminated === 0) {
            if (结果.skippedHeads > 0) {
              return { kind: 'success', text: `有 ${结果.skippedHeads} 条待剔的受保护系统头：system/message 必须带「当前打开的 turn/step」，现在取不到，已跳过。等对话进行中再试。` }
            }
            return { kind: 'success', text: `当前非空系统提示词 ${结果.total} 条，不超过 ${保留系统提示词数} 条，无需剔除。` }
          }
          const 后 = meter ? meter.measure(session).totalTokens : null
          const 省 = 前 !== null && 后 !== null ? `（${前} → ${后} token，省 ${前 - 后}）` : ''
          const 头跳过 = 结果.skippedHeads > 0 ? `；另有 ${结果.skippedHeads} 条受保护系统头因取不到打开的 turn/step 跳过` : ''
          记('info', `/elimination -s: 剔除 ${结果.eliminated} 条旧系统提示词（共 ${结果.chars} 字），保留 ${结果.kept} 条${头跳过}${省}`)
          return { kind: 'success', text: `已剔除 ${结果.eliminated} 条旧系统提示词（共 ${结果.chars} 字），保留最近 ${结果.kept} 条${头跳过}${省}` }
        }

        // 默认：剔除工具回显。
        // 必须有打开的 turn。替换出来的 tool/result 如果落在 turn 外面，整个会话日志会被判
        // "tool/result is outside an open turn"，从此打不开（实测踩过一次，2026-11-07 22:21）。
        // 分档压缩那条路本来就有这道闸，命令这条之前抄漏了。
        if (找开放turn(session) === null) {
          return { kind: 'error', text: '现在不在一个打开的 turn 里，这会儿剔除会写坏会话日志。等对话进行中再试。' }
        }
        const meter = ctx.get('tokenMeter')
        const 前 = meter ? meter.measure(session).totalTokens : null
        try {
          pruneSession(session)
        } catch (e) {
          记('error', `/elimination 失败: ${e?.message ?? e}`)
          return { kind: 'error', text: `剔除失败：${e?.message ?? e}` }
        }
        const 后 = meter ? meter.measure(session).totalTokens : null
        if (前 !== null && 后 !== null) {
          记('info', `/elimination 手动剔除: ${前} → ${后}（省 ${前 - 后}）`)
          return { kind: 'success', text: `剔除完成：${前} → ${后} token（省 ${前 - 后}）` }
        }
        return { kind: 'success', text: '剔除完成（这次没拿到 tokenMeter，没法报数）。' }
      },
    }))
    console.log(`[elimination] /elimination 注册完成`)
  } catch (e) {
    记('warn', `/elimination 注册失败: ${e?.message ?? e}`)
  }

  // /elimination-debug —— 手动控制自动剔除。
  //   /elimination-debug high → 立即按 high 档跑一次（只剔除，不压）
  //   /elimination-debug mid  → 立即按 mid  档跑一次（剔除 + 压30% · 留70%）
  //   /elimination-debug low  → 立即按 low  档跑一次（剔除 + 压40% · 留60%）
  //   /elimination-debug off  → 关闭自动剔除（pre-step 不再触发）
  //   /elimination-debug on   → 重新开启自动剔除
  // high/mid/low 是一次性的：只跑这一下，不改自动开关、也不常驻强制档。
  // 强制档跳过阈值判断，也跳过免压线（否则小会话上 mid/low 压不动）。
  记('info', '/elimination-debug: 开始注册')
  try {
    ctx.effect(() => ctx.commands.register({
      definitionId: CommandDefinitionId('@qq/dsh-compaction-elimination-debug'),
      name: 'elimination-debug',
      description: '手动：high/mid/low 立即按档跑一次；off 关自动剔除，on 开',
      input: { hint: 'high | mid | low | off | on' },
      handler: async (invocation) => {
        const 参数 = String(invocation?.rawInput ?? '').trim().toLowerCase()

        if (参数 === 'off' || 参数 === 'on') {
          自动开启 = 参数 === 'on'
          记('info', `/elimination-debug: 自动剔除已${自动开启 ? '开启' : '关闭'}`)
          return { kind: 'success', text: `自动剔除已${自动开启 ? '开启' : '关闭'}${自动开启 ? '' : '（手动 /elimination、/elimination -s 仍可用）'}。` }
        }

        if (!['high', 'mid', 'low'].includes(参数)) {
          return { kind: 'error', text: `只认 high / mid / low / off / on，收到的是「${参数}」` }
        }

        const agent = invocation?.agent
        if (!agent?.session) return { kind: 'error', text: `按 ${参数} 档跑不了：拿不到当前会话。` }
        // 分档里会替换 tool/result，必须有打开的 turn，否则会写坏会话日志。
        if (找开放turn(agent.session) === null) {
          return { kind: 'error', text: '现在不在一个打开的 turn 里，这会儿跑分档会写坏会话日志。等对话进行中再试。' }
        }
        try {
          await 分档(ctx, agent, undefined, 参数)
        } catch (e) {
          记('error', `/elimination-debug ${参数} 跑分档失败: ${e?.message ?? e}`)
          return { kind: 'error', text: `按 ${参数} 档跑失败：${e?.message ?? e}` }
        }
        return { kind: 'success', text: `已按 ${参数} 档跑完一次，看 elimination.log。` }
      },
    }))
    记('info', '/elimination-debug: 注册完成')
  } catch (e) {
    记('warn', `/elimination-debug 注册失败: ${e?.message ?? e}`)
  }
}


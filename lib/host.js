import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// @deepseek-ai/dsh-llm 不在 profile 的解析路径里，只能按安装位置动态 import。
const DSH_LLM = 'file:///C:/Users/Administrator/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js'

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
//   剔除：`tool/result` 的整段回显（命令输出、搜索结果、文件内容……）
//   保留：`assistant.reasoning`（思考链）、`assistant.text`（回复）、
//         `user/message`（他说的话）、**`tool/call` 的完整输入参数**
//   替换后只留一行：什么工具、跑了多少字符、是不是报错
//
// 刻意没有的东西：按比例压缩、保留头部 N 千字、分类白名单、按工具名区分。
// 回显就是回显，留一行足够我知道「我调过它、它回了多少」。

/** 插件对外名字。 */
export const name = 'compaction-elimination'

/** 需要宿主提供的服务。拿不到 tokenMeter 就不要加载，免得记账算错。 */
export const inject = ['tokenMeter']

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

export function apply(ctx, config) {
  const cfg = 解析配置(config)

  /**
   * 把当前 surface 里所有超长的 tool/result 回显替换成一行痕迹。
   * 每个替换都会先写一条 `compaction/prune` 记账事件（官方纯消费者靠它算省了多少），
   * 再 append 一条带 `surfaceOp: replace` 的新 tool/result 把原节点遮蔽掉。
   */
  function pruneSession(session) {
    const 工具表 = 建工具名表(session)
    const 待处理 = []

    for (const seq of [...session.surface.nodes]) {
      const ev = session.eventAt(seq)
      if (ev?.type === 'tool/result') 待处理.push({ seq, ev })
    }

    const pruned = []
    let charsRemoved = 0

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

        session.append('compaction/prune', {
          shadowedRange: { start: seq, end: seq },
          shadowedSeqs: [seq],
          shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
        })
        const message = 冻结消息({ ...original, content: 新content })
        const replacement = session.append('tool/result', { ...ev.data, message }, {
          surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
          sourceEventSeqs: [seq],
        })
        pruned.push({
          originalSeq: seq,
          replacementSeq: replacement.seq,
          tool: 名,
          charsBefore: 原字符,
          charsAfter: 新字符,
        })
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

      session.append('compaction/prune', {
        shadowedRange: { start: seq, end: seq },
        shadowedSeqs: [seq],
        shadowedTokenCount: ctx.tokenMeter.estimateMessage(original),
      })
      const message = 冻结消息({ ...original, content: 新content })
      const replacement = session.append('tool/result', { ...ev.data, message }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      })
      pruned.push({
        originalSeq: seq,
        replacementSeq: replacement.seq,
        tool: 名,
        charsBefore: 原字符,
        charsAfter: 新字符,
      })
      charsRemoved += 原字符 - 新字符
    }

    if (pruned.length > 0) {
      ctx.logger?.info?.(
        `elimination: 剔除 ${pruned.length} 条工具回显，省下 ${charsRemoved} 字符（约 ${Math.round(charsRemoved * 0.183)} tokens）`,
      )
    }

    return { pruned, charsRemoved }
  }


  // ───────────── 分档压缩（原本打算单独一个插件，但它加载不了，并进来） ─────────────
  // 剔除和压缩是同一个闸门的两级：到阈值 → 先剔 → 剔完够就收工，
  // 不够就压到低水位。只剔不压会在阈值附近反复横跳。
  const TIER = { thresholdRatio: 0.8, highRatio: 0.55, midRatio: 0.25, keepMid: 0.4, keepLow: 0.3, maxTokens: 4096 }
  const LOG = 'C:/Users/Administrator/qq-bridge/state/agents/tiered-compaction.log'

  function 记(级别, 行) {
    const text = `[${new Date().toISOString()}] [${级别}] ${行}`
    try { appendFileSync(LOG, text + '\n', 'utf8') } catch {}
    try { console.log(`[elimination] ${行}`) } catch {}
  }

  记('info', 'loaded: elimination + tiered merged')

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
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

  async function 分档(ctx, agent, signal) {
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
    if (U < 阈值) return

    pruneSession(session)
    const 后 = meter.measure(session)
    const U2 = 后.totalTokens
    const R = U - U2
    const 收益比 = R / U

    if (收益比 > TIER.highRatio) {
      记('info', `只剔除: U=${U} R=${R}(${(收益比 * 100).toFixed(1)}%) → 现 ${U2}`)
      return
    }

    const 保留比 = 收益比 > TIER.midRatio ? TIER.keepMid : TIER.keepLow
    const 档位 = 收益比 > TIER.midRatio ? '中档(留40%)' : '低档(留30%)'

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
    const { BlockAssembler } = await import(DSH_LLM)
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
}


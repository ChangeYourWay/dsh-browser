/**
 * Pure conversation-rendering logic: maps session events (live and history)
 * to display rows. Kept framework-free so the wire shapes are unit-tested
 * against the REAL SessionEvent contract: `{ type, seq, time, data }` — the
 * payload always lives in `data`, never on the event root.
 *
 * @module
 */

/** One rendered conversation row. */
export interface Row {
  seq: number
  kind: 'user' | 'assistant' | 'tool' | 'info'
  text: string
}

/** Minimal view of a SessionEvent (payload in `data`). */
export interface SessionEventView {
  type: string
  data?: {
    content?: unknown
    message?: { content?: unknown }
    name?: string
    arguments?: string
  }
}

/** Extract model-visible text from content blocks (defensive: unknown block shapes degrade to markers). */
export function textFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  const parts: string[] = []
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as { type?: string; text?: unknown }
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

/** Map one session event to a row (user/assistant only; tools handled separately). */
export function rowFromEvent(event: SessionEventView): Row | null {
  switch (event.type) {
    case 'user/message': {
      // dsh 每轮把运行时常量上下文作为 source.kind='plugin' 的 user/message
      // 记入日志（如 <system-reminder> 注入内容）——它们不是用户消息，
      // 渲染会污染对话流，必须跳过。
      const source = (event.data as { source?: { kind?: string } } | undefined)?.source
      if (source?.kind !== 'user') return null
      return { seq: 0, kind: 'user', text: textFromBlocks(event.data?.content) }
    }
    case 'assistant/message':
      return { seq: 0, kind: 'assistant', text: textFromBlocks(event.data?.message?.content) }
    default:
      return null
  }
}

/** 工具调用的展示名：带 index 参数时附上（如 browser_click #7）。 */
export function toolSummary(name: string, argsJson: unknown): string {
  let summary = `⚙ ${name}`
  try {
    const args = JSON.parse(String(argsJson ?? '{}')) as unknown
    if (typeof args === 'object' && args !== null && 'index' in args) {
      summary += ` #${String((args as { index?: unknown }).index)}`
    }
  } catch {
    // 模型参数不可解析：只显示工具名。
  }
  return summary
}

/** live 合并：若最后一行是工具行则并入（连续工具调用不刷屏），否则新增一行。 */
export function appendLiveRow(rows: Row[], kind: Row['kind'], text: string, seq: number): Row[] {
  if (kind === 'tool') {
    const last = rows[rows.length - 1]
    if (last?.kind === 'tool') {
      return [...rows.slice(0, -1), { seq, kind: 'tool', text: `${last.text} → ${text}` }]
    }
  }
  return [...rows, { seq, kind, text }]
}

/** 标记最后一行工具调用已完成（并入，不新增行）。 */
export function completeLastTool(rows: Row[], seq: number): Row[] {
  const last = rows[rows.length - 1]
  if (last?.kind === 'tool') {
    return [...rows.slice(0, -1), { ...last, seq, text: `${last.text} ✓` }]
  }
  return rows
}

/** 历史渲染：连续工具调用归并成一行（tool/call..result 不逐条刷屏；超 3 个折叠计数）。 */
export function mergeHistoryRows(events: SessionEventView[], nextSeq: () => number): Row[] {
  const rows: Row[] = []
  let pendingTool: { items: string[]; total: number } | null = null
  const flushTool = (): void => {
    if (pendingTool === null) return
    const shown = pendingTool.items.slice(0, 3)
    const label = pendingTool.total > shown.length
      ? `${shown.join(' → ')} 等${pendingTool.total}个工具`
      : shown.join(' → ')
    rows.push({ seq: nextSeq(), kind: 'tool', text: label })
    pendingTool = null
  }
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const summary = toolSummary(ev.data?.name ?? 'tool', ev.data?.arguments)
      if (pendingTool === null) pendingTool = { items: [summary], total: 1 }
      else {
        pendingTool.items.push(summary)
        pendingTool.total += 1
      }
      continue
    }
    if (ev.type === 'tool/result') continue
    flushTool()
    const row = rowFromEvent(ev)
    if (row !== null) rows.push({ ...row, seq: nextSeq() })
  }
  flushTool()
  return rows
}

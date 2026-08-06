/**
 * Tool dispatch: executes `tool.call` frames in the user's active tab via the
 * content script and answers with the text-only result.
 *
 * Only the active, last-focused window's tab is ever targeted — the bridge
 * never switches tabs or acts in the background.
 *
 * @module
 */

import type { ToolError } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'

/** A tool call from the bridge. */
export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
}

/** The wire answer for one tool call. */
export interface ToolAnswer {
  ok: boolean
  result?: unknown
  error?: ToolError
}

/**
 * Dispatch one tool call to the active tab's content script.
 * @param call - the tool call to execute.
 * @param sharePageContent - the user's page-sharing preference ('off' blocks
 *   every page-content read).
 * @returns the content script's answer, or a stable error when no tab or
 *   content script is available.
 */
export async function dispatchToolCall(call: ToolCall, sharePageContent: 'ask' | 'auto' | 'off'): Promise<ToolAnswer> {
  // Privacy boundary: with sharing off, no page content may leave the page.
  if (sharePageContent === 'off' && (call.name === 'browser_snapshot' || call.name === 'browser_get_text')) {
    return { ok: false, error: { code: 'action-failed', message: '页面内容共享已关闭（设置 → 页面内容共享）' } }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id === undefined) {
    return { ok: false, error: { code: 'no-active-tab', message: '没有活动的标签页可操作' } }
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'DSH_ACTION', action: call.name, args: call.args })
    if (typeof response !== 'object' || response === null || typeof (response as { ok?: unknown }).ok !== 'boolean') {
      return { ok: false, error: { code: 'content-unavailable', message: '页面没有响应（内容脚本未加载？请刷新页面后重试）' } }
    }
    return response as ToolAnswer
  } catch {
    return { ok: false, error: { code: 'content-unavailable', message: '无法连接页面内容脚本（请刷新页面后重试）' } }
  }
}

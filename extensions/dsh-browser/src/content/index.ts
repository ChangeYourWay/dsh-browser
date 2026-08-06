/**
 * Content script entry: listens for DSH_ACTION messages from the background
 * service worker, runs the action against the real page, and answers with a
 * text-only result. Starts the DOM watcher that marks the snapshot dirty.
 *
 * The content script is the only part that touches the page; the bridge and
 * the model never see page internals beyond the structured text snapshots.
 *
 * @module
 */

import { runAction, ActionError } from './actions.ts'
import { ElementIds } from './ids.ts'
import type { SnapshotBudget } from './snapshot.ts'

/** Negotiated snapshot budgets, patched in from the background via message. */
let budget: SnapshotBudget = { maxItems: 60, maxForms: 30, maxChars: 12_000 }

const ids = new ElementIds()

/** A tool-call result for the bridge. */
export interface ToolResult {
  ok: boolean
  result?: { text: string }
  error?: { code: string; message: string }
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: ToolResult) => void) => {
  if (typeof message !== 'object' || message === null) return
  const msg = message as { type?: string }
  if (msg.type === 'DSH_BUDGET') {
    const incoming = (message as { budget?: Partial<SnapshotBudget> }).budget
    if (incoming !== undefined) {
      budget = { ...budget, ...incoming }
      sendResponse({ ok: true, result: { text: `快照预算已更新: ${JSON.stringify(budget)}` } })
    }
    return
  }
  if (msg.type !== 'DSH_ACTION') return
  const actionMsg = message as { action?: string; args?: Record<string, unknown> }
  const action = actionMsg.action ?? ''
  const args = actionMsg.args ?? {}
  void runAction(action, args, { ids, budget }).then(
    (result) => { sendResponse({ ok: true, result }) },
    (error: unknown) => {
      const code = error instanceof ActionError ? error.code : 'action-failed'
      const messageText = error instanceof Error ? error.message : String(error)
      sendResponse({ ok: false, error: { code, message: messageText } })
    },
  )
  return true // async response
})

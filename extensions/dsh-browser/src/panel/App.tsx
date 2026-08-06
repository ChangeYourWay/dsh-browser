/**
 * Side panel application: chat with the local dsh agent, plus a settings
 * view. Renders conversation from session history and live session events;
 * browser actions are driven by the model through the bridge tools (the panel
 * only shows tool activity cards).
 *
 * @module
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { BridgeCaps } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { ServerFrame } from '@deepseek-ai/dsh-bridge-browser/src/protocol.ts'
import type { BridgeState } from '../background/bridge.ts'
import { connectPanel, type PanelApi, type PanelSettings } from './api.ts'
import { renderMarkdown } from './markdown.ts'
import whaleUrl from '../../assets/icons/deepseek-256.png'

/** One rendered conversation row. */
import {
  appendLiveRow,
  completeLastTool,
  mergeHistoryRows,
  rowFromEvent,
  toolSummary,
  type Row,
  type SessionEventView,
} from './events.ts'

const STATE_LABEL: Record<BridgeState, string> = {
  connected: '已连接',
  connecting: '连接中…',
  reconnecting: '重连中…',
  stopped: '未连接',
}

/**
 * One conversation row body. Memoized: rows are immutable (append/merge copy
 * the array but reuse row objects), so markdown is re-parsed only when a
 * row's text actually changes — typing must not re-render every message.
 */
const MessageBody = memo(function MessageBody({ row }: { row: Row }): React.JSX.Element {
  if (row.kind === 'user' || row.kind === 'assistant') {
    return <div className="body md" dangerouslySetInnerHTML={{ __html: renderMarkdown(row.text) }} />
  }
  return <pre>{row.text}</pre>
})

export function App(): React.JSX.Element {
  const [api] = useState<PanelApi>(() => connectPanel())
  const [state, setState] = useState<BridgeState>('stopped')
  const [caps, setCaps] = useState<BridgeCaps | null>(null)
  const [settings, setSettings] = useState<PanelSettings | null>(null)
  const [pageInfo, setPageInfo] = useState<string | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)
  const sessionRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  const nextSeq = (): number => { seqRef.current += 1; return seqRef.current }


  // Settings: seed from storage, then let the panel own the form.
  useEffect(() => {
    void chrome.storage.local.get('dshSettings').then((stored) => {
      const raw = stored.dshSettings as Partial<PanelSettings> | undefined
      setSettings({
        bridgeUrl: raw?.bridgeUrl ?? 'ws://127.0.0.1:3080',
        token: raw?.token ?? '',
        sharePageContent: raw?.sharePageContent ?? 'ask',
      })
    })
  }, [])

  // 每次连接重启（设置变更/断线重连）都新建会话。状态消息逐条监听：
  // React 会把 stopped/connecting 等瞬时状态合并进同一帧渲染，依赖渲染
  // 状态无法可靠观察到"连接已重置"，因此在这里按消息粒度判定。
  const [sessionEpoch, setSessionEpoch] = useState(0)
  const lastStateRef = useRef<BridgeState | null>(null)
  useEffect(() => {
    const offStatus = api.onStatus((next, nextCaps) => {
      setState(next)
      setCaps(nextCaps)
      const previous = lastStateRef.current
      lastStateRef.current = next
      if (previous !== null && next !== previous && next === 'stopped') {
        sessionRef.current = null
        setRows([])
        setSessionEpoch((epoch) => epoch + 1)
      }
    })
    const offEvent = api.onEvent((frame) => { void onFrame(frame) })
    api.requestStatus()
    return () => { offStatus(); offEvent() }
  }, [api])

  useEffect(() => {
    if (state === 'connected' && sessionRef.current === null) {
      void ensureSession()
    }
  }, [state, sessionEpoch])

  // 页面芯片显示浏览器当前活动标签页（标题，缺省退回 URL）；切换/更新时刷新。
  useEffect(() => {
    const refresh = (): void => {
      void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((tabs) => {
        const tab = tabs[0]
        setPageInfo(
          tab !== undefined && tab.title !== undefined && tab.title !== ''
            ? tab.title
            : tab !== undefined && tab.url !== undefined && tab.url !== ''
              ? tab.url
              : null,
        )
      }).catch(() => setPageInfo(null))
    }
    refresh()
    chrome.tabs.onActivated.addListener(refresh)
    chrome.tabs.onUpdated.addListener(refresh)
    return () => {
      chrome.tabs.onActivated.removeListener(refresh)
      chrome.tabs.onUpdated.removeListener(refresh)
    }
  }, [])

  // Auto-scroll to the newest row.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [rows])

  /** Live frame handling: session events append rows; turn/end reconciles with history. */
  async function onFrame(frame: ServerFrame): Promise<void> {
    if (frame.t !== 'event') return
    const payload = frame.frame.payload as { sessionId?: string; event?: SessionEventView } | undefined
    if (payload?.sessionId !== sessionRef.current || payload.event === undefined) return
    const row = rowFromEvent(payload.event)
    if (row !== null) {
      setRows((prev) => appendLiveRow(prev, row.kind, row.text, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/call') {
      const summary = toolSummary(payload.event.data?.name ?? 'tool', payload.event.data?.arguments)
      setRows((prev) => appendLiveRow(prev, 'tool', summary, nextSeq()))
      return
    }
    if (payload.event.type === 'tool/result') {
      // 并入最后一行工具行：调用已完成（不新增行）。
      setRows((prev) => completeLastTool(prev, nextSeq()))
      return
    }
    if (payload.event.type === 'turn/end') await refreshHistory()
  }

  async function refreshHistory(): Promise<void> {
    const id = sessionRef.current
    if (id === null) return
    try {
      const result = await api.rpc<{ events: { event: SessionEventView }[] }>('session.history', { sessionId: id })
      setRows(mergeHistoryRows(result.events.map((entry) => entry.event), nextSeq))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** 每次打开侧边栏都新建一个会话（与 GUI/其他界面的历史完全隔离）。 */
  async function ensureSession(): Promise<void> {
    try {
      const created = await api.rpc<{ sessionId: string }>('session.create', {})
      sessionRef.current = created.sessionId
      await refreshHistory()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (state === 'connected' && sessionRef.current === null) {
      void ensureSession()
    }
  }, [state, sessionEpoch])

  const sendingRef = useRef(false)
  async function send(textOverride?: string): Promise<void> {
    const text = (textOverride ?? input).trim()
    // busy state 是异步的：连续回车可能都通过 state 检查——用 ref 同步锁。
    if (text === '' || busy || sendingRef.current || sessionRef.current === null) return
    sendingRef.current = true
    setInput('')
    setBusy(true)
    setError(null)
    // 不渲染乐观行：live user/message 事件即时回显，避免同一消息出现两行。
    try {
      await api.rpc('session.prompt', {
        sessionId: sessionRef.current,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
      sendingRef.current = false
    }
  }

  function saveSettings(): void {
    if (settings === null) return
    api.updateSettings(settings)
    setShowSettings(false)
  }

  // 状态栏只显示连接状态；快照上限是技术细节，在设置页说明（见 hint）。
  const statusText = useMemo(() => STATE_LABEL[state], [state])

  if (showSettings) {
    return (
      <div className="settings">
        <h1>设置</h1>
        <label>
          桥地址
          <input
            value={settings?.bridgeUrl ?? ''}
            onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, bridgeUrl: e.target.value })}
            placeholder="留空自动检测本机 dsh（3080/3081/3090）"
          />
        </label>
        <label>
          Token
          <input
            type="password"
            value={settings?.token ?? ''}
            onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, token: e.target.value })}
            placeholder="本地回环可留空；远程部署时填写"
          />
        </label>
        <label>
          页面内容共享
          <select
            value={settings?.sharePageContent ?? 'ask'}
            onChange={(e) => setSettings((prev) => prev === null ? prev : { ...prev, sharePageContent: e.target.value as PanelSettings['sharePageContent'] })}
          >
            <option value="ask">每次询问</option>
            <option value="auto">自动共享</option>
            <option value="off">关闭</option>
          </select>
        </label>
        <button onClick={saveSettings}>保存并连接</button>
        <button onClick={() => setShowSettings(false)}>返回</button>
        <p className="hint">默认零配置：地址留空时扩展自动探测本机 dsh，本地回环连接无需 token。
          「页面快照」= 模型每次请求能看到的当前页面文字；当前上限 {caps?.snapshotMaxChars ?? 12000} 字符（dsh 插件配置 snapshotMaxChars 可调），超出部分会被截断。</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header>
        <span className={`dot ${state}`} />
        <span className="status" role="status">{statusText}</span>
        <button className="ghost" onClick={() => setShowSettings(true)}>设置</button>
      </header>
      <div className="page-chip">
        <span title={pageInfo ?? undefined}>📄 当前页面: {pageInfo ?? '—'}</span>
        <button className="ghost" disabled={state !== 'connected' || busy}
          onClick={() => { void send('请用 browser_snapshot 读取当前页面，然后告诉我页面上有什么，并等待我的指令。') }}>
          读取页面
        </button>
      </div>
      <div className="messages" ref={scrollRef}>
        {rows.length === 0 && (
          <div className="empty">
            <img className="empty-logo" src={whaleUrl} alt="DeepSeek" />
            <p>连接 dsh 后开始对话。模型可读取并操作当前页面（纯文本模式）。</p>
          </div>
        )}
        {rows.map((row) => (
          <div key={row.seq} className={`row ${row.kind}`}>
            <MessageBody row={row} />
          </div>
        ))}
        {busy && <div className="row assistant"><div className="body md">…</div></div>}
      </div>
      {error !== null && <div className="error">{error}</div>}
      <footer>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // isComposing：输入法组词中的回车是确认选字，不是发送。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={state === 'connected' ? '输入消息，Enter 发送' : '请先在设置中配置并连接 dsh'}
          disabled={state !== 'connected'}
          rows={3}
        />
        <button onClick={() => void send()} disabled={state !== 'connected' || busy || input.trim() === ''}>发送</button>
      </footer>
    </div>
  )
}

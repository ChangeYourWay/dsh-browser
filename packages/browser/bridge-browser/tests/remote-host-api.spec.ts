import { describe, expect, it, vi } from 'vitest'
import {
  createRemoteHostApi,
  type HostConnectionLike,
  type TypertGatewayLike,
} from '../src/remote-host-api.ts'
import type { HostRpcCall } from '../src/host-api.ts'

function call(method: string, payload: unknown, rpcId = 'rpc-1'): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

function abortWait(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
}

function harness(options: {
  invoke?: TypertGatewayLike['invoke']
  open?: TypertGatewayLike['wireStream']['open']
  fetch?: (request: Request) => Promise<Response>
} = {}) {
  const invoke = vi.fn(options.invoke ?? (async () => ({ accepted: true })))
  const open = vi.fn(options.open ?? (async (_endpoint, _payload, signal) => ({
    async *[Symbol.asyncIterator]() { await abortWait(signal) },
  })))
  const fetch = vi.fn(options.fetch ?? (async (request: Request) => {
    const body = await request.clone().json() as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true } })
  }))
  const gateway: TypertGatewayLike = {
    invoke,
    wireStream: {
      open,
      failure: (error: unknown) => {
        const value = error as { code?: unknown; message?: unknown; details?: unknown }
        return {
          code: typeof value.code === 'string' ? value.code : 'internal',
          message: typeof value.message === 'string' ? value.message : String(error),
          details: typeof value.details === 'object' && value.details !== null ? value.details : {},
        }
      },
    },
  }
  const connection: HostConnectionLike = {
    createSharedFetchHandler: () => ({ fetch }),
  }
  return { api: createRemoteHostApi(gateway, connection), invoke, open, fetch }
}

describe('dsh 0.1.2 Remote Host adapter', () => {
  it('maps unary extension calls to exact Typert namespaces and named args', async () => {
    const { api, invoke } = harness({
      invoke: async ({ namespace, method }) => {
        if (`${namespace}/${method}` === 'credentials/describe') return { TOKEN: { configured: true } }
        if (`${namespace}/${method}` === 'llm/discoverModels') return [{ id: 'deepseek-chat' }]
        return { accepted: true }
      },
    })

    await api.call(call('session.list', {}))
    await api.call(call('session.prompt', { sessionId: 'session-1', mode: 'queue', content: [] }, 'prompt-id'))
    await api.call(call('settings.mutate', { ns: 'llm-pi-ai', ops: [] }))
    await expect(api.call(call('credentials.describe', { refs: ['TOKEN'] }))).resolves.toEqual({
      ok: true, value: { credentials: { TOKEN: { configured: true } } },
    })
    await expect(api.call(call('llm.discoverModels', {
      settingsNs: 'llm-pi-ai', provider: 'relay', baseURL: 'https://relay.example',
    }))).resolves.toEqual({ ok: true, value: { models: [{ id: 'deepseek-chat' }] } })

    expect(invoke).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'session', method: 'list', args: { _request: {} },
    }))
    expect(invoke).toHaveBeenNthCalledWith(2, expect.objectContaining({
      namespace: 'session',
      method: 'prompt',
      args: { request: { requestId: 'prompt-id', sessionId: 'session-1', mode: 'queue', content: [] } },
    }))
    expect(invoke).toHaveBeenNthCalledWith(3, expect.objectContaining({
      namespace: 'settings', method: 'mutate', args: { ns: 'llm-pi-ai', ops: [] },
    }))
    expect(invoke).toHaveBeenNthCalledWith(5, expect.objectContaining({
      namespace: 'llm',
      method: 'discoverModels',
      args: {
        settingsNs: 'llm-pi-ai',
        request: { provider: 'relay', baseURL: 'https://relay.example' },
      },
    }))
  })

  it('uses a session/follow snapshot for history and keeps that iterator for live events', async () => {
    const { api, open } = harness({
      open: async (endpoint, _payload, signal) => {
        if (endpoint === '$events') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
              await abortWait(signal)
            },
          }
        }
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield {
                type: 'snapshot',
                cursor: 3,
                records: [
                  { type: 'event', event: { type: 'user/message', seq: 0, time: 1, data: {} } },
                  {
                    type: 'chunks',
                    event: {
                      type: 'chunkrow/text-chunks',
                      seq: 1,
                      time: 2,
                      data: { turn: 0, step: 0, index: 0, dt: [2, -1], texts: ['Hel', 'lo', '!'] },
                    },
                  },
                ],
                hasMore: false,
                projections: { asOfSeq: 1, values: { imageLimits: { maxImageBytes: 10 } } },
              }
              yield { type: 'event', event: { type: 'turn/start', seq: 2, time: 3, data: {} } }
              await abortWait(signal)
            },
          }
        }
        throw new Error(endpoint)
      },
    })
    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()
    const live = events.next()
    await vi.waitFor(() => { expect(open).toHaveBeenCalledWith('$events', { args: {} }, expect.any(AbortSignal)) })

    await expect(api.call(call('session.history', { sessionId: 'session-1' }))).resolves.toEqual({
      ok: true,
      value: {
        events: [
          { event: { type: 'user/message', seq: 0, time: 1, data: {} } },
          {
            event: {
              type: 'assistant/chunk', seq: 1, time: 2,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Hel' } },
            },
          },
          {
            event: {
              type: 'assistant/chunk', seq: 2, time: 4,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: 'lo' } },
            },
          },
          {
            event: {
              type: 'assistant/chunk', seq: 3, time: 3,
              data: { turn: 0, step: 0, chunk: { type: 'text-delta', index: 0, text: '!' } },
            },
          },
        ],
        hasMore: false,
        projections: { asOfSeq: 1, values: { imageLimits: { maxImageBytes: 10 } } },
      },
    })
    await expect(live).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        method: 'session/event',
        payload: {
          type: 'session/event',
          sessionId: 'session-1',
          event: { type: 'turn/start', seq: 2, time: 3, data: {} },
        },
      }),
    })
    expect(open).toHaveBeenCalledWith('session/follow', {
      args: { request: { address: { kind: 'session', sessionId: 'session-1' } } },
    }, expect.any(AbortSignal))
    abort.abort()
    await events.return?.()
  })

  it('pages older history with a Host-legal throughSeq, never MAX_SAFE_INTEGER', async () => {
    const { api, invoke, open } = harness({
      invoke: async ({ namespace, method, args }) => {
        if (`${namespace}/${method}` !== 'session/page') throw new Error(`${namespace}/${method}`)
        expect(args).toEqual({
          request: {
            address: { kind: 'session', sessionId: 'session-1' },
            throughSeq: 42,
            beforeSeq: 10,
            maxMessages: 20,
          },
        })
        return {
          records: [{ type: 'event', event: { type: 'user/message', seq: 9, time: 1, data: {} } }],
          hasMore: true,
        }
      },
      open: async (endpoint) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: 42, records: [], hasMore: false }
            },
          }
        }
        throw new Error(endpoint)
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: 10,
      maxMessages: 20,
    }))).resolves.toEqual({
      ok: true,
      value: {
        events: [{ event: { type: 'user/message', seq: 9, time: 1, data: {} } }],
        hasMore: true,
      },
    })
    expect(open).toHaveBeenCalledWith('session/follow', {
      args: { request: { address: { kind: 'session', sessionId: 'session-1' } } },
    }, expect.any(AbortSignal))
    expect(invoke).toHaveBeenCalledOnce()
    const pageArgs = invoke.mock.calls[0]?.[0]?.args as { request: { throughSeq: number } }
    expect(pageArgs.request.throughSeq).toBe(42)
    expect(pageArgs.request.throughSeq).not.toBe(Number.MAX_SAFE_INTEGER)
  })

  it('fails closed when session/page returns a malformed history page', async () => {
    const { api } = harness({
      invoke: async ({ namespace, method }) => {
        if (`${namespace}/${method}` !== 'session/page') throw new Error(`${namespace}/${method}`)
        return { records: 'not-an-array' }
      },
      open: async (endpoint) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: 5, records: [], hasMore: false }
            },
          }
        }
        throw new Error(endpoint)
      },
    })

    await expect(api.call(call('session.history', {
      sessionId: 'session-1',
      beforeSeq: 3,
    }))).resolves.toEqual({
      ok: false,
      error: {
        code: 'internal',
        message: 'session/page returned an invalid history page',
        details: {},
      },
    })
  })

  it('reads workspace.list from the workspace/follow baseline', async () => {
    const { api, open } = harness({
      open: async (endpoint) => ({
        async *[Symbol.asyncIterator]() {
          if (endpoint === 'workspace/follow') {
            yield { type: 'baseline', value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: ['s1'] } }
          }
        },
      }),
    })

    await expect(api.call(call('workspace.list', {}))).resolves.toEqual({
      ok: true,
      value: { items: [{ workspaceId: 'w1' }], archivedSessionIds: ['s1'] },
    })
    expect(open).toHaveBeenCalledWith('workspace/follow', { args: {} }, expect.any(AbortSignal))
  })

  it('bridges user questions through $events/result and unwraps the extension answer', async () => {
    let releaseCancel: (() => void) | undefined
    const { api, fetch } = harness({
      open: async (endpoint, _payload, signal) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
              await abortWait(signal)
            },
          }
        }
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-questions', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-1',
              agentId: 'session-1',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await new Promise<void>((resolve) => { releaseCancel = resolve })
            yield { type: 'cancel', eventId: 'question-1' }
            await abortWait(signal)
          },
        }
      },
    })
    // Extension ownership is claimed only after a successful prompt/create.
    await expect(api.call(call('session.prompt', {
      sessionId: 'session-1',
      mode: 'queue',
      content: [],
    }, 'prompt-id'))).resolves.toEqual({ ok: true, value: { accepted: true } })

    const abort = new AbortController()
    const events = api.events(abort.signal)[Symbol.asyncIterator]()

    await expect(events.next()).resolves.toEqual({
      done: false,
      value: {
        rpcId: 'question-1',
        method: 'question/requested',
        payload: {
          type: 'question/requested',
          sessionId: 'session-1',
          questions: [{ id: 'db', question: 'Database?' }],
        },
      },
    })
    await expect(api.respond('question-1', {
      ok: true,
      value: {
        sessionId: 'session-1',
        answer: { answers: [{ id: 'db', selected: ['SQLite'] }] },
      },
    }, abort.signal)).resolves.toEqual({ accepted: true })

    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://dsh.internal/api/$events/result')
    expect(await request.clone().json()).toMatchObject({
      type: 'client-request',
      method: '$events/result',
      payload: {
        args: {
          clientId: 'client-questions',
          eventId: 'question-1',
          outcome: { kind: 'result', value: { answers: [{ id: 'db', selected: ['SQLite'] }] } },
        },
      },
    })

    const resolved = events.next()
    releaseCancel?.()
    await expect(resolved).resolves.toEqual({
      done: false,
      value: expect.objectContaining({
        method: 'question/resolved',
        payload: {
          type: 'question/resolved', sessionId: 'session-1', questionRpcId: 'question-1',
        },
      }),
    })
    abort.abort()
    await events.return?.()
  })

  it('declines Desktop user-question waterfalls so the native UI can answer', async () => {
    const { api, fetch } = harness({
      open: async (endpoint, _payload, signal) => {
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-desktop', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-desktop',
              agentId: 'desktop-session',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await abortWait(signal)
          },
        }
      },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    expect(await (fetch.mock.calls[0]?.[0] as Request).clone().json()).toMatchObject({
      payload: { args: { eventId: 'question-desktop', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not claim session ownership when prompt fails', async () => {
    const error = Object.assign(new Error('rejected'), { code: 'bad-request', details: {} })
    const { api, fetch } = harness({
      invoke: async () => { throw error },
      open: async (endpoint, _payload, signal) => {
        if (endpoint === 'session/follow') {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'snapshot', cursor: -1, records: [], hasMore: false }
              await abortWait(signal)
            },
          }
        }
        if (endpoint !== '$events') throw new Error(endpoint)
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: 'ready', clientId: 'client-fail', host: { home: '/home/test' } }
            yield {
              type: 'waterfall',
              event: 'user-questions/request',
              eventId: 'question-fail',
              agentId: 'session-fail',
              request: { questions: [{ id: 'db', question: 'Database?' }] },
            }
            await abortWait(signal)
          },
        }
      },
    })

    await expect(api.call(call('session.prompt', {
      sessionId: 'session-fail',
      mode: 'queue',
      content: [],
    }))).resolves.toEqual({
      ok: false,
      error: { code: 'bad-request', message: 'rejected', details: {} },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    expect(await (fetch.mock.calls[0]?.[0] as Request).clone().json()).toMatchObject({
      payload: { args: { eventId: 'question-fail', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })

  it('delegates unhandled waterfalls and preserves Gateway failure fields', async () => {
    const error = Object.assign(new Error('gone'), { code: 'session-not-found', details: { sessionId: 's1' } })
    const { api, fetch } = harness({
      invoke: async () => { throw error },
      open: async (endpoint, _payload, signal) => ({
        async *[Symbol.asyncIterator]() {
          if (endpoint === '$events') {
            yield { type: 'ready', clientId: 'client-1', host: { home: '/home/test' } }
            yield { type: 'waterfall', event: 'approval/request', eventId: 'approval-1', agentId: 's1', request: {} }
            await abortWait(signal)
          }
        },
      }),
    })

    await expect(api.call(call('session.cancel', { sessionId: 's1' }))).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: { sessionId: 's1' } },
    })

    const abort = new AbortController()
    const iterator = api.events(abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })
    expect(await (fetch.mock.calls[0]?.[0] as Request).clone().json()).toMatchObject({
      payload: { args: { eventId: 'approval-1', outcome: { kind: 'next' } } },
    })
    abort.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
  })
})

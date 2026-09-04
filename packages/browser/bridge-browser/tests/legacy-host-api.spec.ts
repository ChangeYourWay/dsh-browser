import { describe, expect, it, vi } from 'vitest'
import type { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  createLegacyHostApi,
  type LegacyApiProxyLike,
  type LegacyFetchHandler,
} from '../src/legacy-host-api.ts'
import type { HostRpcCall } from '../src/host-api.ts'

function call(method: string, payload: unknown, rpcId = 'rpc-1'): HostRpcCall {
  return { rpcId, method, payload, signal: new AbortController().signal }
}

function harness(options: {
  fetch?: LegacyFetchHandler['fetch']
  mux?: LegacyApiProxyLike['events']['mux']
} = {}) {
  const fetch = vi.fn(options.fetch ?? (async (request: Request) => {
    const envelope = await request.clone().json() as { rpcId: string }
    return Response.json({
      type: 'server-response',
      rpcId: envelope.rpcId,
      result: { ok: true, value: { accepted: true } },
    })
  }))
  const mux = vi.fn(options.mux ?? ((_request, signal) => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    },
  })))
  const proxy = { events: { mux } } as unknown as LegacyApiProxyLike
  return { api: createLegacyHostApi(proxy, { fetch }), fetch, mux }
}

describe('dsh 0.1.1-rc.2 ApiProxy Host adapter', () => {
  it('round-trips unary requests through the legacy envelope', async () => {
    const { api, fetch } = harness()
    await expect(api.call(call('session.list', {}))).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    })
    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://dsh.internal/api/session.list')
    await expect(request.clone().json()).resolves.toEqual({
      type: 'client-request', rpcId: 'rpc-1', method: 'session.list', payload: {},
    })
  })

  it('preserves business failures and rejects malformed responses', async () => {
    const failed = harness({
      fetch: async () => Response.json({
        type: 'server-response',
        rpcId: 'rpc-1',
        result: {
          ok: false,
          error: { code: 'session-not-found', message: 'gone', details: { sessionId: 's1' } },
        },
      }),
    })
    await expect(failed.api.call(call('session.history', { sessionId: 's1' }))).resolves.toEqual({
      ok: false,
      error: { code: 'session-not-found', message: 'gone', details: { sessionId: 's1' } },
    })

    const malformed = harness({ fetch: async () => new Response('not json') })
    await expect(malformed.api.call(call('session.list', {}))).resolves.toEqual({
      ok: false,
      error: { code: 'internal', message: 'ApiProxy returned non-JSON content', details: {} },
    })
  })

  it('projects mux frames and submits waterfall responses', async () => {
    const mux = (_request: { rpcId: RpcId; payload: object }, _signal: AbortSignal) => ({
      async *[Symbol.asyncIterator]() {
        yield {
          rpcId: 'question-1',
          payload: { type: 'question/requested', sessionId: 'session-1', questions: [] },
        }
      },
    })
    const { api, fetch } = harness({
      mux: mux as LegacyApiProxyLike['events']['mux'],
      fetch: async (request) => request.url.endsWith('/api/respond')
        ? Response.json({ accepted: true })
        : new Response('unexpected', { status: 500 }),
    })
    const signal = new AbortController().signal
    await expect(api.events(signal)[Symbol.asyncIterator]().next()).resolves.toEqual({
      done: false,
      value: {
        rpcId: 'question-1',
        method: 'question/requested',
        payload: { type: 'question/requested', sessionId: 'session-1', questions: [] },
      },
    })
    await expect(api.respond('question-1', { ok: true, value: { answers: [] } }, signal))
      .resolves.toEqual({ accepted: true })
    const request = fetch.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('http://dsh.internal/api/respond')
    await expect(request.clone().json()).resolves.toEqual({
      type: 'client-response',
      rpcId: 'question-1',
      result: { ok: true, value: { answers: [] } },
    })
  })
})

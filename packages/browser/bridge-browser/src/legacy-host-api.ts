/**
 * TEMPORARY COMPATIBILITY ISLAND — remove when minimum dsh is >= 0.1.2.
 *
 * At that point delete this file and its tests, remove the optional
 * dsh-host-apiproxy peer/dev dependency, and delete the capability branch in
 * `index.ts`. Do not add 0.1.2 behavior here.
 *
 * Host adapter for the ApiProxy transport retained by dsh 0.1.1-rc.2.
 *
 * dsh 0.1.2 moves unary calls, streams, and waterfalls to Typert Gateway and
 * Connection services. Keeping the old transport behind BrowserHostApi lets
 * the bridge select one coherent contract at runtime without leaking either
 * release line into the WebSocket server.
 *
 * @module @yuxianglin/dsh-bridge-browser/src/legacy-host-api
 */

import { randomUUID } from 'node:crypto'
import type { ApiProxy, RpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import type {
  BrowserHostApi,
  HostEventFrame,
  HostRpcCall,
  HostRpcFailure,
  HostRpcResult,
} from './host-api.ts'
import { hostFailure, isRecord } from './host-api.ts'
import type { RespondResult } from './protocol.ts'

/** The legacy surface used by this adapter. */
export type LegacyApiProxyLike = Pick<ApiProxy, 'events'>

/** Fetch carrier created by `@deepseek-ai/dsh-host-apiproxy.toFetchHandler`. */
export interface LegacyFetchHandler {
  fetch(request: Request): Promise<Response>
}

/** Wrap dsh 0.1.1-rc.2 ApiProxy as the bridge-owned Host API. */
export function createLegacyHostApi(
  apiProxy: LegacyApiProxyLike,
  fetchHandler: LegacyFetchHandler,
): BrowserHostApi {
  return new LegacyHostApi(apiProxy, fetchHandler)
}

class LegacyHostApi implements BrowserHostApi {
  constructor(
    private readonly apiProxy: LegacyApiProxyLike,
    private readonly fetchHandler: LegacyFetchHandler,
  ) {}

  async call(call: HostRpcCall): Promise<HostRpcResult> {
    const request = new Request(`http://dsh.internal/api/${call.method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: call.rpcId,
        method: call.method,
        payload: call.payload,
      }),
      signal: call.signal,
    })
    try {
      const response = await this.fetchHandler.fetch(request)
      const body = await response.text()
      if (!response.ok) return httpFailure(response.status, body)
      return parseServerResponse(body, call.rpcId)
    } catch (error: unknown) {
      return { ok: false, error: hostFailure(error) }
    }
  }

  async *events(signal: AbortSignal): AsyncIterable<HostEventFrame> {
    const source = this.apiProxy.events.mux({ rpcId: randomUUID() as RpcId, payload: {} }, signal)
    for await (const envelope of source) {
      if (!isRecord(envelope) || typeof envelope.rpcId !== 'string' || !isRecord(envelope.payload)
        || typeof envelope.payload.type !== 'string') {
        throw new TypeError('ApiProxy events.mux yielded an invalid server request')
      }
      yield {
        rpcId: envelope.rpcId,
        method: envelope.payload.type,
        payload: envelope.payload,
      }
    }
  }

  async respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown> {
    const request = new Request('http://dsh.internal/api/respond', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-response', rpcId, result }),
      signal,
    })
    const response = await this.fetchHandler.fetch(request)
    const body = await response.text()
    if (!response.ok) throw new Error(`ApiProxy respond failed with HTTP ${String(response.status)}: ${body}`)
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new TypeError('ApiProxy respond returned non-JSON content')
    }
  }
}

function parseServerResponse(body: string, rpcId: string): HostRpcResult {
  let envelope: unknown
  try {
    envelope = JSON.parse(body) as unknown
  } catch {
    return invalidResponse('ApiProxy returned non-JSON content')
  }
  if (!isRecord(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
    || !isRecord(envelope.result) || typeof envelope.result.ok !== 'boolean') {
    return invalidResponse('ApiProxy returned an invalid server response')
  }
  if (envelope.result.ok) return { ok: true, value: envelope.result.value }
  return { ok: false, error: hostFailure(envelope.result.error) }
}

function httpFailure(status: number, message: string): HostRpcResult {
  return {
    ok: false,
    error: { code: 'http', message, details: { status } },
  }
}

function invalidResponse(message: string): HostRpcResult {
  const error: HostRpcFailure = { code: 'internal', message, details: {} }
  return { ok: false, error }
}

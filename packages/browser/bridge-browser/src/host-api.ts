/**
 * Bridge-owned Host API consumed by the WebSocket carrier.
 *
 * dsh 0.1.2 exposes Typert Remote services plus Connection-owned carriers.
 * This boundary keeps that Host topology out of the browser wire server; it
 * is deliberately implemented only by the 0.1.2 Remote adapter.
 *
 * @module
 */

import type { RespondResult } from './protocol.ts'

/** Stable failure envelope understood by the extension panel. */
export interface HostRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Business result returned by the dsh 0.1.2 Host adapter. */
export type HostRpcResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: HostRpcFailure }

/** One extension-originated unary call after WebSocket decoding. */
export interface HostRpcCall {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
  readonly signal: AbortSignal
}

/** Event retained as the private bridge-to-extension protocol. */
export interface HostEventFrame {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/** API surface the WebSocket carrier needs from a dsh Host. */
export interface BrowserHostApi {
  call(call: HostRpcCall): Promise<HostRpcResult>
  events(signal: AbortSignal): AsyncIterable<HostEventFrame>
  respond(rpcId: string, result: RespondResult, signal: AbortSignal): Promise<unknown>
}

/** Convert an arbitrary Host rejection to the open wire failure vocabulary. */
export function hostFailure(error: unknown): HostRpcFailure {
  if (isRecord(error)) {
    const code = typeof error.code === 'string' ? error.code : 'internal'
    const message = typeof error.message === 'string' ? error.message : String(error)
    const details = isRecord(error.details) ? error.details : {}
    return { code, message, details }
  }
  return {
    code: 'internal',
    message: error instanceof Error ? error.message : String(error),
    details: {},
  }
}

/** Narrow unknown JSON-like data without accepting arrays. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

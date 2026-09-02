export const PROVIDER_OPERATIONS = [
  'tts',
  'audio-avatar',
  'text-avatar',
  'lip-sync',
  'image-to-video',
  'video-to-video',
  'background-replace',
  'camera-motion',
] as const

export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number]

/**
 * Estimated cost only. The observed (post-execution) cost travels with the
 * result bundle so estimates and actual charges are never conflated.
 */
export interface ProviderEstimate {
  currency: string
  costMinorUnits: number
  estimatedLatencyMs: number
}

/** Observed cost reported by the provider once the effect has happened. */
export interface ProviderObservedCost {
  currency: string
  costMinorUnits: number
}

/**
 * Runtime companion to `ProviderStatus`. Untrusted input — a provider callback
 * body, an MCP tool result — has to be checked against real values, and a bare
 * union type disappears at compile time.
 */
export const PROVIDER_STATUS_VALUES = [
  'queued',
  'processing',
  'retrieving',
  'completed',
  'failed',
  'cancelled',
] as const

export type ProviderStatus = (typeof PROVIDER_STATUS_VALUES)[number]

/**
 * How a provider finishes a job, declared truthfully per adapter:
 * - `synchronous`: the submission response itself carries the finished
 *   result; there is no durable provider-side job to poll (ElevenLabs TTS).
 * - `polling`: Apollo must query a provider job handle until it finishes.
 * - `webhook`: the provider notifies Apollo; a verification path exists.
 * - `both`: polling and webhook are officially supported and verified.
 */
export const PROVIDER_COMPLETION_MODES = [
  'synchronous',
  'polling',
  'webhook',
  'both',
] as const

export type ProviderCompletionMode = (typeof PROVIDER_COMPLETION_MODES)[number]

/**
 * Result of submitting a job to a provider. The durable Apollo ProviderJob
 * exists in either case; what differs is whether the provider accepted the
 * work for later retrieval or completed it inside the submission itself.
 */
export type ProviderSubmissionResult<Result> =
  | Readonly<{ kind: 'accepted'; providerJobId: string }>
  | Readonly<{
      kind: 'completed'
      bundle: Readonly<ProviderResultBundle<Result>>
    }>

/**
 * The finished result of a synchronous submission. `providerJobRef` is the
 * provider's own identifier for exactly this effect (a request/history id),
 * never an Apollo invention; `result` carries the adapter-specific payload
 * whose artifacts are ingested into controlled storage before approval.
 */
export interface ProviderResultBundle<Result> {
  providerJobRef: string
  result: Readonly<Result>
  completedAt: string
  observedCost?: Readonly<ProviderObservedCost>
}

/**
 * Normalized adapter failure. Adapters must throw this (or a subclass) so
 * the worker can persist a redacted, machine-readable failure without ever
 * storing upstream diagnostics, bodies, or credentials.
 */
export class ProviderAdapterError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    code: string,
    retryable: boolean,
    retryAfterMs?: number,
    message = 'Provider operation failed',
  ) {
    super(message)
    this.name = 'ProviderAdapterError'
    this.code = code
    this.retryable = retryable
    this.retryAfterMs = retryAfterMs
  }
}

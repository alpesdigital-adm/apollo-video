import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { ProviderCompletionMode } from './provider-contract.ts'

/**
 * Durable transport state for a canonical `ProviderJob`.
 *
 * Two kinds of fact live around a provider job and they must not share a
 * lifecycle:
 *
 * - The transport *identity* — which of the four transports carries this job —
 *   is decided once, before any paid call, and never changes. It belongs in the
 *   immutable, content-addressed job body (`ProviderJob.transport`).
 * - The transport *schedule* — when to poll next, how long the callback wait may
 *   last, whether somebody asked for cancellation — changes on every tick. If it
 *   lived inside the hashed body, every poll would rewrite the job identity and
 *   `jobHash` would stop meaning "this is the same job".
 *
 * So the schedule lives here, in its own record, keyed by the job it belongs to.
 * It is mutable by construction and carries its own monotonic `revision` for
 * compare-and-swap; it is never content-addressed and never claims to be.
 */
export const PROVIDER_JOB_TRANSPORT_STATE_SCHEMA_VERSION = 'provider-job-transport-state/v1' as const

export const PROVIDER_JOB_TRANSPORTS = ['api', 'polling', 'webhook', 'mcp'] as const
export type ProviderJobTransport = (typeof PROVIDER_JOB_TRANSPORTS)[number]

/**
 * Which transports a declared completion mode may legitimately use. The
 * adapter declares how the provider finishes work; the job declares how Apollo
 * carries it. A `synchronous` provider cannot be driven by webhook, and a
 * `webhook`-only provider cannot be polled into completion.
 */
const TRANSPORTS_BY_COMPLETION: Readonly<Record<ProviderCompletionMode, readonly ProviderJobTransport[]>> = Object.freeze({
  synchronous: Object.freeze(['api', 'mcp'] as const),
  polling: Object.freeze(['polling', 'mcp'] as const),
  webhook: Object.freeze(['webhook'] as const),
  both: Object.freeze(['polling', 'webhook', 'mcp'] as const),
})

export function transportsForCompletion(mode: ProviderCompletionMode): readonly ProviderJobTransport[] {
  return TRANSPORTS_BY_COMPLETION[mode]
}

export const PROVIDER_JOB_WAIT_KINDS = ['none', 'poll', 'callback', 'retry'] as const
export type ProviderJobWaitKind = (typeof PROVIDER_JOB_WAIT_KINDS)[number]

export const PROVIDER_JOB_INTENT_STATES = ['none', 'requested', 'acknowledged', 'unsupported'] as const
export type ProviderJobIntentState = (typeof PROVIDER_JOB_INTENT_STATES)[number]

export interface ProviderJobRetryPolicy {
  maxAttempts: number
  initialBackoffMs: number
  maximumBackoffMs: number
  backoffMultiplier: number
  policyHash: string
}

export interface ProviderJobTransportState {
  schemaVersion: typeof PROVIDER_JOB_TRANSPORT_STATE_SCHEMA_VERSION
  workspaceId: string
  projectId: string
  jobId: string
  transport: ProviderJobTransport
  completion: ProviderCompletionMode
  retryPolicy: Readonly<ProviderJobRetryPolicy>
  waitKind: ProviderJobWaitKind
  /** When the worker may next touch this job. Never null while waiting. */
  nextAttemptAt: string | null
  /** Hard stop. A job past its deadline fails closed instead of waiting forever. */
  deadlineAt: string
  /** Consecutive transport-level attempts (polls or submissions), for backoff. */
  transportAttempts: number
  /** The most recent provider-declared Retry-After, in milliseconds. */
  retryAfterMs: number | null
  /** Callback transports record the exact instant the wait started. */
  waitStartedAt: string | null
  cancellation: ProviderJobIntentState
  cancellationRequestedAt: string | null
  resume: ProviderJobIntentState
  resumeRequestedAt: string | null
  /**
   * The MCP session that submitted the work, when the transport is `mcp`.
   * Recorded so a later disconnect is visibly irrelevant: the job is ours, the
   * session was only the wire.
   */
  mcpSessionId: string | null
  mcpSessionClosedAt: string | null
  revision: number
  updatedAt: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const MAXIMUM_DEADLINE_MS = 24 * 60 * 60 * 1_000
const MAXIMUM_RETRY_AFTER_MS = 60 * 60 * 1_000

function id(value: string, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function instant(value: string, field: string): string {
  assertDomain(
    typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

export function createProviderJobRetryPolicy(input: {
  maxAttempts: number
  initialBackoffMs: number
  maximumBackoffMs: number
  backoffMultiplier: number
}): Readonly<ProviderJobRetryPolicy> {
  assertDomain(Number.isSafeInteger(input.maxAttempts) && input.maxAttempts >= 1 && input.maxAttempts <= 20, 'INVALID_ARGUMENT', 'maxAttempts is invalid')
  assertDomain(Number.isSafeInteger(input.initialBackoffMs) && input.initialBackoffMs >= 100 && input.initialBackoffMs <= 600_000, 'INVALID_ARGUMENT', 'initialBackoffMs is invalid')
  assertDomain(Number.isSafeInteger(input.maximumBackoffMs) && input.maximumBackoffMs >= input.initialBackoffMs && input.maximumBackoffMs <= MAXIMUM_RETRY_AFTER_MS, 'INVALID_ARGUMENT', 'maximumBackoffMs is invalid')
  assertDomain(Number.isSafeInteger(input.backoffMultiplier) && input.backoffMultiplier >= 1 && input.backoffMultiplier <= 10, 'INVALID_ARGUMENT', 'backoffMultiplier must be a small integer factor')
  const body = Object.freeze({
    maxAttempts: input.maxAttempts,
    initialBackoffMs: input.initialBackoffMs,
    maximumBackoffMs: input.maximumBackoffMs,
    backoffMultiplier: input.backoffMultiplier,
  })
  return Object.freeze({ ...body, policyHash: calculateCanonicalHash(body) })
}

export const DEFAULT_PROVIDER_JOB_RETRY_POLICY = createProviderJobRetryPolicy({
  maxAttempts: 5,
  initialBackoffMs: 1_000,
  maximumBackoffMs: 300_000,
  backoffMultiplier: 2,
})

/**
 * Deterministic backoff. Integer arithmetic only: the same attempt always
 * yields the same delay, on every machine, in every process. Jitter would make
 * the schedule unreproducible and is deliberately absent — the durable claim,
 * not randomness, is what keeps two workers off the same job.
 */
export function providerJobBackoffMs(policy: Readonly<ProviderJobRetryPolicy>, attempt: number): number {
  assertDomain(Number.isSafeInteger(attempt) && attempt >= 0, 'INVALID_ARGUMENT', 'attempt is invalid')
  let delay = policy.initialBackoffMs
  for (let step = 0; step < attempt; step += 1) {
    delay *= policy.backoffMultiplier
    if (delay >= policy.maximumBackoffMs) return policy.maximumBackoffMs
  }
  return Math.min(delay, policy.maximumBackoffMs)
}

/**
 * The provider's Retry-After always wins over our own backoff when it is
 * longer: honouring a smaller delay than the provider asked for is how a 429
 * becomes a ban.
 */
export function providerJobNextAttemptMs(input: {
  policy: Readonly<ProviderJobRetryPolicy>
  attempt: number
  retryAfterMs?: number | null
}): number {
  const backoff = providerJobBackoffMs(input.policy, input.attempt)
  if (input.retryAfterMs === undefined || input.retryAfterMs === null) return backoff
  assertDomain(Number.isSafeInteger(input.retryAfterMs) && input.retryAfterMs >= 0 && input.retryAfterMs <= MAXIMUM_RETRY_AFTER_MS, 'INVALID_ARGUMENT', 'retryAfterMs is invalid')
  return Math.max(backoff, input.retryAfterMs)
}

export function createProviderJobTransportState(input: {
  workspaceId: string
  projectId: string
  jobId: string
  transport: ProviderJobTransport
  completion: ProviderCompletionMode
  retryPolicy?: Readonly<ProviderJobRetryPolicy>
  deadlineAt: string
  createdAt: string
  mcpSessionId?: string | null
}): Readonly<ProviderJobTransportState> {
  assertDomain(PROVIDER_JOB_TRANSPORTS.includes(input.transport), 'INVALID_ARGUMENT', 'transport is unsupported')
  assertDomain(
    transportsForCompletion(input.completion).includes(input.transport),
    'PRECONDITION_REQUIRED',
    `Transport ${input.transport} cannot carry a ${input.completion} provider`,
  )
  const createdAt = instant(input.createdAt, 'createdAt')
  const deadlineAt = instant(input.deadlineAt, 'deadlineAt')
  const window = Date.parse(deadlineAt) - Date.parse(createdAt)
  assertDomain(window > 0 && window <= MAXIMUM_DEADLINE_MS, 'INVALID_ARGUMENT', 'deadlineAt must be ahead of creation and within 24h')
  if (input.transport !== 'mcp') {
    assertDomain(!input.mcpSessionId, 'INVALID_ARGUMENT', 'Only the MCP transport may record a session')
  }
  return Object.freeze({
    schemaVersion: PROVIDER_JOB_TRANSPORT_STATE_SCHEMA_VERSION,
    workspaceId: id(input.workspaceId, 'workspaceId'),
    projectId: id(input.projectId, 'projectId'),
    jobId: id(input.jobId, 'jobId'),
    transport: input.transport,
    completion: input.completion,
    retryPolicy: input.retryPolicy ?? DEFAULT_PROVIDER_JOB_RETRY_POLICY,
    waitKind: 'none',
    nextAttemptAt: createdAt,
    deadlineAt,
    transportAttempts: 0,
    retryAfterMs: null,
    waitStartedAt: null,
    cancellation: 'none',
    cancellationRequestedAt: null,
    resume: 'none',
    resumeRequestedAt: null,
    mcpSessionId: input.mcpSessionId ? id(input.mcpSessionId, 'mcpSessionId') : null,
    mcpSessionClosedAt: null,
    revision: 1,
    updatedAt: createdAt,
  })
}

function advance(
  state: Readonly<ProviderJobTransportState>,
  patch: Partial<ProviderJobTransportState>,
  occurredAt: string,
): Readonly<ProviderJobTransportState> {
  const at = instant(occurredAt, 'occurredAt')
  assertDomain(Date.parse(at) >= Date.parse(state.updatedAt), 'VERSION_CONFLICT', 'Transport state time regressed')
  return Object.freeze({ ...state, ...patch, revision: state.revision + 1, updatedAt: at })
}

/** Schedule the next poll or retry, honouring the provider's Retry-After. */
export function scheduleProviderJobAttempt(input: {
  state: Readonly<ProviderJobTransportState>
  waitKind: Extract<ProviderJobWaitKind, 'poll' | 'retry'>
  occurredAt: string
  retryAfterMs?: number | null
}): Readonly<ProviderJobTransportState> {
  const attempt = input.state.transportAttempts
  const delay = providerJobNextAttemptMs({ policy: input.state.retryPolicy, attempt, retryAfterMs: input.retryAfterMs })
  const at = instant(input.occurredAt, 'occurredAt')
  const nextAttemptAt = new Date(Date.parse(at) + delay).toISOString()
  return advance(input.state, {
    waitKind: input.waitKind,
    transportAttempts: attempt + 1,
    retryAfterMs: input.retryAfterMs ?? null,
    // A schedule may not run past the deadline; the deadline is what fails the
    // job closed instead of letting it wait forever.
    nextAttemptAt: Date.parse(nextAttemptAt) > Date.parse(input.state.deadlineAt) ? input.state.deadlineAt : nextAttemptAt,
  }, at)
}

/**
 * Park the job on a durable callback wait. `nextAttemptAt` still moves to the
 * deadline so a callback that never arrives is reaped by the same worker loop
 * rather than by a timer nobody owns.
 */
export function awaitProviderJobCallback(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
}): Readonly<ProviderJobTransportState> {
  assertDomain(input.state.transport === 'webhook', 'PRECONDITION_REQUIRED', 'Only the webhook transport waits for callbacks')
  const at = instant(input.occurredAt, 'occurredAt')
  return advance(input.state, {
    waitKind: 'callback',
    waitStartedAt: at,
    nextAttemptAt: input.state.deadlineAt,
  }, at)
}

/** A callback arrived and verified: wake the job for the worker to advance it. */
export function wakeProviderJob(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
}): Readonly<ProviderJobTransportState> {
  const at = instant(input.occurredAt, 'occurredAt')
  return advance(input.state, { waitKind: 'none', nextAttemptAt: at, retryAfterMs: null }, at)
}

export function requestProviderJobCancellation(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
  supported: boolean
}): Readonly<ProviderJobTransportState> {
  assertDomain(input.state.cancellation === 'none', 'VERSION_CONFLICT', 'Cancellation was already requested')
  const at = instant(input.occurredAt, 'occurredAt')
  return advance(input.state, {
    // An unsupported cancellation is recorded, not swallowed: the operator asked,
    // the provider cannot, and the job keeps running with that fact on the record.
    cancellation: input.supported ? 'requested' : 'unsupported',
    cancellationRequestedAt: at,
    ...(input.supported ? { waitKind: 'none' as const, nextAttemptAt: at } : {}),
  }, at)
}

export function acknowledgeProviderJobCancellation(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
}): Readonly<ProviderJobTransportState> {
  assertDomain(input.state.cancellation === 'requested', 'VERSION_CONFLICT', 'No cancellation is pending')
  const at = instant(input.occurredAt, 'occurredAt')
  return advance(input.state, { cancellation: 'acknowledged', waitKind: 'none', nextAttemptAt: at }, at)
}

export function requestProviderJobResume(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
  deadlineAt: string
}): Readonly<ProviderJobTransportState> {
  const at = instant(input.occurredAt, 'occurredAt')
  const deadlineAt = instant(input.deadlineAt, 'deadlineAt')
  assertDomain(Date.parse(deadlineAt) > Date.parse(at), 'INVALID_ARGUMENT', 'A resumed job needs a deadline ahead of now')
  assertDomain(Date.parse(deadlineAt) - Date.parse(at) <= MAXIMUM_DEADLINE_MS, 'INVALID_ARGUMENT', 'Resume deadline exceeds the 24h ceiling')
  return advance(input.state, {
    resume: 'requested',
    resumeRequestedAt: at,
    waitKind: 'none',
    nextAttemptAt: at,
    transportAttempts: 0,
    retryAfterMs: null,
    deadlineAt,
  }, at)
}

export function acknowledgeProviderJobResume(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
}): Readonly<ProviderJobTransportState> {
  assertDomain(input.state.resume === 'requested', 'VERSION_CONFLICT', 'No resume is pending')
  return advance(input.state, { resume: 'acknowledged' }, instant(input.occurredAt, 'occurredAt'))
}

/**
 * The MCP session that submitted the work went away. This is bookkeeping, not a
 * failure: the durable job, its provider job id and its schedule are Apollo's.
 * Nothing about the job's future depends on the session that opened it.
 */
export function closeProviderJobMcpSession(input: {
  state: Readonly<ProviderJobTransportState>
  occurredAt: string
}): Readonly<ProviderJobTransportState> {
  assertDomain(input.state.transport === 'mcp', 'PRECONDITION_REQUIRED', 'Only an MCP-carried job has a session to close')
  return advance(input.state, { mcpSessionClosedAt: instant(input.occurredAt, 'occurredAt') }, input.occurredAt)
}

export function providerJobDeadlineExceeded(state: Readonly<ProviderJobTransportState>, now: string): boolean {
  return Date.parse(instant(now, 'now')) > Date.parse(state.deadlineAt)
}

export function providerJobAttemptsExhausted(state: Readonly<ProviderJobTransportState>): boolean {
  return state.transportAttempts >= state.retryPolicy.maxAttempts
}

export function assertProviderJobTransportState(state: Readonly<ProviderJobTransportState>): Readonly<ProviderJobTransportState> {
  assertDomain(state.schemaVersion === PROVIDER_JOB_TRANSPORT_STATE_SCHEMA_VERSION, 'PERSISTENCE_CONFLICT', 'Stored transport state schema is invalid')
  assertDomain(PROVIDER_JOB_TRANSPORTS.includes(state.transport), 'PERSISTENCE_CONFLICT', 'Stored transport is invalid')
  assertDomain(PROVIDER_JOB_WAIT_KINDS.includes(state.waitKind), 'PERSISTENCE_CONFLICT', 'Stored wait kind is invalid')
  assertDomain(transportsForCompletion(state.completion).includes(state.transport), 'PERSISTENCE_CONFLICT', 'Stored transport contradicts the completion mode')
  assertDomain(state.revision >= 1, 'PERSISTENCE_CONFLICT', 'Stored transport revision is invalid')
  assertDomain(
    state.retryPolicy.policyHash === calculateCanonicalHash({
      maxAttempts: state.retryPolicy.maxAttempts,
      initialBackoffMs: state.retryPolicy.initialBackoffMs,
      maximumBackoffMs: state.retryPolicy.maximumBackoffMs,
      backoffMultiplier: state.retryPolicy.backoffMultiplier,
    }),
    'PERSISTENCE_CONFLICT',
    'Stored retry policy hash does not match its body',
  )
  assertDomain(state.waitKind === 'none' || state.nextAttemptAt !== null, 'PERSISTENCE_CONFLICT', 'A waiting job must know when to wake')
  return state
}

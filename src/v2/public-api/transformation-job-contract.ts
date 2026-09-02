import type {
  PersistedProviderCallbackEvent,
  PersistedProviderJob,
} from '../application/ports/provider-job-repository.ts'
import { assertDomain } from '../domain/errors.ts'
import { PROVIDER_JOB_TRANSPORTS, type ProviderJobTransportState } from '../domain/provider-job-transport.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

/**
 * Request a transformation.
 *
 * There is deliberately no `providerInput` here. The payload the provider sees
 * is projected from the persisted brief; a caller that could supply it directly
 * could send the provider anything while the brief said something else — and
 * the brief is what the critic later judges the result against.
 *
 * `preferredTransport` is a preference, not an instruction: the provider's
 * declared completion mode decides what is possible, and an impossible pairing
 * is refused rather than accepted and left to time out.
 */
export function parseRequestTransformationJobBody(raw: unknown) {
  const body = record(raw, 'body')
  const requiredKeys = ['briefId', 'selectionId', 'use', 'market', 'locale']
  const keys = [...requiredKeys, 'preferredTransport', 'maskId', 'outputSpecId']
  assertDomain(
    Object.keys(body).every((key) => keys.includes(key)) && requiredKeys.every((key) => key in body),
    'INVALID_ARGUMENT',
    'body contains missing or unsupported properties',
  )
  if (body.preferredTransport !== undefined) {
    assertDomain(
      typeof body.preferredTransport === 'string' &&
        PROVIDER_JOB_TRANSPORTS.includes(body.preferredTransport as (typeof PROVIDER_JOB_TRANSPORTS)[number]),
      'INVALID_ARGUMENT',
      'body.preferredTransport is unsupported',
    )
  }
  return Object.freeze({
    briefId: string(body.briefId, 'body.briefId'),
    selectionId: string(body.selectionId, 'body.selectionId'),
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
    locale: string(body.locale, 'body.locale'),
    ...(body.maskId !== undefined ? { maskId: string(body.maskId, 'body.maskId') } : {}),
    ...(body.outputSpecId !== undefined ? { outputSpecId: string(body.outputSpecId, 'body.outputSpecId') } : {}),
    ...(body.preferredTransport ? { preferredTransport: body.preferredTransport as (typeof PROVIDER_JOB_TRANSPORTS)[number] } : {}),
  })
}

/**
 * Public projection of the durable schedule.
 *
 * `mcpSessionId` never crosses this boundary. It identifies a wire, not a job,
 * and publishing it would invite exactly the confusion this wave exists to
 * prevent: that the session is where the work lives.
 */
export function presentTransformationTransport(state: Readonly<ProviderJobTransportState> | null | undefined) {
  if (!state) return undefined
  return Object.freeze({
    transport: state.transport,
    completion: state.completion,
    waiting: state.waitKind,
    nextAttemptAt: state.nextAttemptAt,
    deadlineAt: state.deadlineAt,
    attempts: state.transportAttempts,
    maxAttempts: state.retryPolicy.maxAttempts,
    retryAfterMs: state.retryAfterMs,
    cancellation: state.cancellation,
    resume: state.resume,
    mcpSessionClosed: state.mcpSessionClosedAt !== null,
    revision: state.revision,
  })
}

export function presentTransformationJob(persisted: Readonly<PersistedProviderJob>) {
  const { job } = persisted
  return Object.freeze({
    id: job.id,
    projectId: job.projectId,
    originProjectVersionId: job.originProjectVersionId,
    operation: job.operation,
    adapter: Object.freeze({ id: job.adapterId, version: job.adapterVersion }),
    status: job.status,
    attempt: job.attempt,
    ...(job.transformation
      ? {
          transformation: Object.freeze({
            briefId: job.transformation.briefId,
            briefHash: job.transformation.briefHash,
            selectionId: job.transformation.selectionId,
            selectionHash: job.transformation.selectionHash,
            providerId: job.transformation.providerId,
            capabilityId: job.transformation.capabilityId,
          }),
        }
      : {}),
    ...(presentTransformationTransport(persisted.transportState)
      ? { transport: presentTransformationTransport(persisted.transportState) }
      : {}),
    ...(job.estimate ? { estimate: job.estimate } : {}),
    ...(job.observedCost ? { observedCost: job.observedCost } : {}),
    ...(job.resultArtifact ? { resultArtifact: job.resultArtifact } : {}),
    // The normalized error only. Upstream diagnostics never reach here: they
    // routinely echo the request, which for a transformation means the prompt.
    ...(job.normalizedError ? { error: job.normalizedError } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  })
}

/**
 * Redacted callback history.
 *
 * The payload digest travels; the payload does not. A provider body may carry
 * signed URLs or tokens, and the digest is enough to prove which bytes were
 * accepted and which were refused.
 */
export function presentProviderCallbackEvent(entry: Readonly<PersistedProviderCallbackEvent>) {
  return Object.freeze({
    eventId: entry.event.eventId,
    providerId: entry.event.providerId,
    status: entry.event.status,
    outcome: entry.outcome,
    ...(entry.rejectionReason ? { rejectedBecause: entry.rejectionReason } : {}),
    payloadSha256: entry.event.payloadSha256,
    occurredAt: entry.event.occurredAt,
    receivedAt: entry.event.receivedAt,
  })
}

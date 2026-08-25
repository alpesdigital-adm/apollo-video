import type { PersistedProviderJob } from '../application/ports/provider-job-repository.ts'
import { assertDomain } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

export function parseEnqueueProviderJobBody(raw: unknown) {
  const body = record(raw, 'body')
  const requiredKeys = ['projectVersionId', 'profileSnapshotId', 'operation', 'adapterId', 'adapterVersion', 'providerInput', 'sourceArtifactIds', 'use', 'market', 'locale']
  const keys = [...requiredKeys, 'audioMasterId', 'audioRange']
  assertDomain(Object.keys(body).every((key) => keys.includes(key)) && requiredKeys.every((key) => key in body), 'INVALID_ARGUMENT', 'body contains missing or unsupported properties')
  assertDomain(body.operation === 'tts' || body.operation === 'audio-avatar', 'INVALID_ARGUMENT', 'body.operation is unsupported')
  const providerInput = record(body.providerInput, 'body.providerInput')
  assertDomain(Array.isArray(body.sourceArtifactIds) && body.sourceArtifactIds.length <= 64, 'INVALID_ARGUMENT', 'body.sourceArtifactIds must be a bounded array')
  assertDomain(new Set(body.sourceArtifactIds).size === body.sourceArtifactIds.length, 'INVALID_ARGUMENT', 'body.sourceArtifactIds must contain unique values')
  let audioFirst: Readonly<{ audioMasterId: string; audioRange: Readonly<{ startWordIndex: number; endWordIndex: number }> }> | undefined
  if (body.operation === 'audio-avatar') {
    const range = record(body.audioRange, 'body.audioRange')
    assertDomain(Object.keys(range).every((key) => ['startWordIndex', 'endWordIndex'].includes(key)) && ['startWordIndex', 'endWordIndex'].every((key) => key in range), 'INVALID_ARGUMENT', 'body.audioRange is invalid')
    assertDomain(Number.isSafeInteger(range.startWordIndex) && Number.isSafeInteger(range.endWordIndex) && (range.startWordIndex as number) >= 0 && (range.endWordIndex as number) > (range.startWordIndex as number) && (range.endWordIndex as number) <= 100_000, 'INVALID_ARGUMENT', 'body.audioRange indexes must identify a bounded forward range')
    assertDomain(body.sourceArtifactIds.length === 1, 'INVALID_ARGUMENT', 'audio-avatar requires exactly one canonical audio source')
    assertDomain(Object.keys(providerInput).every((key) => key === 'aspectRatio'), 'INVALID_ARGUMENT', 'audio-avatar providerInput may only select aspectRatio')
    assertDomain(providerInput.aspectRatio === undefined || ['16:9', '9:16'].includes(providerInput.aspectRatio as string), 'INVALID_ARGUMENT', 'body.providerInput.aspectRatio is unsupported')
    audioFirst = Object.freeze({ audioMasterId: string(body.audioMasterId, 'body.audioMasterId'), audioRange: Object.freeze({ startWordIndex: range.startWordIndex as number, endWordIndex: range.endWordIndex as number }) })
  } else {
    assertDomain(body.audioMasterId === undefined && body.audioRange === undefined, 'INVALID_ARGUMENT', 'TTS jobs cannot reference an audio master')
  }
  return Object.freeze({
    projectVersionId: string(body.projectVersionId, 'body.projectVersionId'),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
    operation: body.operation,
    adapterId: string(body.adapterId, 'body.adapterId'),
    adapterVersion: string(body.adapterVersion, 'body.adapterVersion'),
    providerInput: Object.freeze({ ...providerInput }),
    sourceArtifactIds: Object.freeze(body.sourceArtifactIds.map((value, index) => string(value, `body.sourceArtifactIds[${index}]`))),
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
    locale: string(body.locale, 'body.locale'),
    ...audioFirst,
  })
}

export function presentProviderJob(persisted: Readonly<PersistedProviderJob>) {
  const { job } = persisted
  return Object.freeze({
    id: job.id,
    projectId: job.projectId,
    originProjectVersionId: job.originProjectVersionId,
    operation: job.operation,
    adapter: Object.freeze({ id: job.adapterId, version: job.adapterVersion }),
    status: job.status,
    attempt: job.attempt,
    ...(job.estimate ? { estimate: job.estimate } : {}),
    ...(job.resultArtifact ? { resultArtifact: job.resultArtifact } : {}),
    ...(job.normalizedError ? { error: job.normalizedError } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
  })
}

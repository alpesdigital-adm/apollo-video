import { calculateCanonicalHash, stableSerialize } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  PROVIDER_OPERATIONS,
  type ProviderEstimate,
  type ProviderOperation,
  type ProviderStatus,
} from './provider-contract.ts'

export const PROVIDER_JOB_SCHEMA_VERSION = 'provider-job/v1' as const

export const PROVIDER_JOB_STATUSES = [
  'planned',
  'estimated',
  'submitting',
  'submitted',
  'queued',
  'processing',
  'suspected-stalled',
  'retrieving',
  'evaluating',
  'approved',
  'rejected',
  'failed',
  'canceled',
  'expired',
  'superseded',
] as const

export type ProviderJobStatus = (typeof PROVIDER_JOB_STATUSES)[number]

export const TERMINAL_PROVIDER_JOB_STATUSES = [
  'approved',
  'rejected',
  'failed',
  'canceled',
  'expired',
  'superseded',
] as const satisfies readonly ProviderJobStatus[]

export interface ProviderJobError {
  code: string
  message: string
  retryable: boolean
  retryAfterMs?: number
}

export interface ProviderJobAuthorization {
  id: string
  profileSnapshotId: string
  profileSnapshotHash: string
  artifactDecisions: readonly Readonly<{
    artifactId: string
    rightsSnapshotId: string
    rightsSnapshotHash: string
    validUntil: string
  }>[]
  evaluatedAt: string
  expiresAt: string
  authorizationHash: string
}

export interface ProviderJobResultArtifact {
  artifactId: string
  artifactSha256: string
  mediaType: 'audio' | 'video' | 'image' | 'data'
  byteSize: number
}

export interface ProviderJob {
  schemaVersion: typeof PROVIDER_JOB_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  originProjectVersionId: string
  operation: ProviderOperation
  adapterId: string
  adapterVersion: string
  input: Readonly<Record<string, unknown>>
  inputHash: string
  idempotencyKey: string
  authorization: Readonly<ProviderJobAuthorization>
  estimate?: Readonly<ProviderEstimate>
  estimateHash?: string
  providerJobId?: string
  attempt: number
  status: ProviderJobStatus
  providerStatus?: ProviderStatus
  resultArtifact?: Readonly<ProviderJobResultArtifact>
  criticResultHash?: string
  normalizedError?: Readonly<ProviderJobError>
  submittedAt?: string
  heartbeatAt?: string
  completedAt?: string
  createdAt: string
  updatedAt: string
  jobHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const SECRET_KEY = /(?:secret|password|credential|api[-_]?key|authorization|bearer|token)/i

function validDate(value: string, field: string): number {
  const timestamp = Date.parse(value)
  assertDomain(Number.isFinite(timestamp), 'INVALID_ARGUMENT', `${field} is invalid`)
  return timestamp
}

function id(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function assertSafeProviderInput(value: unknown, path = 'input'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    assertDomain(Number.isFinite(value), 'INVALID_ARGUMENT', `${path} contains a non-finite number`)
    return
  }
  if (Array.isArray(value)) {
    assertDomain(value.length <= 10_000, 'INVALID_ARGUMENT', `${path} is too large`)
    value.forEach((entry, index) => assertSafeProviderInput(entry, `${path}[${index}]`))
    return
  }
  assertDomain(
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype,
    'INVALID_ARGUMENT',
    `${path} must be portable JSON`,
  )
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    assertDomain(!SECRET_KEY.test(key), 'INVALID_ARGUMENT', `${path}.${key} may not contain credentials`)
    assertSafeProviderInput(entry, `${path}.${key}`)
  }
}

function hashless(job: Omit<ProviderJob, 'jobHash'>): Omit<ProviderJob, 'jobHash'> {
  return job
}

function seal(job: Omit<ProviderJob, 'jobHash'>): Readonly<ProviderJob> {
  return Object.freeze({
    ...job,
    jobHash: calculateCanonicalHash(hashless(job)),
  })
}

function assertAuthorization(value: Readonly<ProviderJobAuthorization>, createdAt: string): void {
  id(value.id, 'authorization.id')
  id(value.profileSnapshotId, 'authorization.profileSnapshotId')
  assertDomain(HASH.test(value.profileSnapshotHash), 'INVALID_ARGUMENT', 'authorization.profileSnapshotHash is invalid')
  const evaluatedAt = validDate(value.evaluatedAt, 'authorization.evaluatedAt')
  const expiresAt = validDate(value.expiresAt, 'authorization.expiresAt')
  assertDomain(evaluatedAt <= validDate(createdAt, 'createdAt') && expiresAt > validDate(createdAt, 'createdAt'), 'ASSET_RIGHTS_BLOCKED', 'Provider authorization is not valid at creation time')
  assertDomain(value.artifactDecisions.length <= 500, 'INVALID_ARGUMENT', 'authorization has too many artifacts')
  assertDomain(new Set(value.artifactDecisions.map((entry) => entry.artifactId)).size === value.artifactDecisions.length, 'INVALID_ARGUMENT', 'authorization contains duplicate artifacts')
  for (const entry of value.artifactDecisions) {
    id(entry.artifactId, 'authorization.artifactId')
    id(entry.rightsSnapshotId, 'authorization.rightsSnapshotId')
    assertDomain(HASH.test(entry.rightsSnapshotHash), 'INVALID_ARGUMENT', 'authorization rights hash is invalid')
    assertDomain(validDate(entry.validUntil, 'authorization.validUntil') > validDate(createdAt, 'createdAt'), 'ASSET_RIGHTS_BLOCKED', 'Provider artifact authorization expired')
  }
  const body = {
    id: value.id,
    profileSnapshotId: value.profileSnapshotId,
    profileSnapshotHash: value.profileSnapshotHash,
    artifactDecisions: value.artifactDecisions,
    evaluatedAt: value.evaluatedAt,
    expiresAt: value.expiresAt,
  }
  assertDomain(calculateCanonicalHash(body) === value.authorizationHash, 'INVALID_ARGUMENT', 'authorization hash is invalid')
}

export function createProviderJob(input: {
  id: string
  workspaceId: string
  projectId: string
  originProjectVersionId: string
  operation: ProviderOperation
  adapterId: string
  adapterVersion: string
  providerInput: Readonly<Record<string, unknown>>
  idempotencyKey: string
  authorization: Readonly<ProviderJobAuthorization>
  createdAt: string
}): Readonly<ProviderJob> {
  const createdAt = new Date(validDate(input.createdAt, 'createdAt')).toISOString()
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    originProjectVersionId: input.originProjectVersionId,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
  })) id(value, field)
  assertDomain(input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'idempotencyKey is invalid')
  assertSafeProviderInput(input.providerInput)
  assertDomain(PROVIDER_OPERATIONS.includes(input.operation), 'INVALID_ARGUMENT', 'operation is invalid')
  assertAuthorization(input.authorization, createdAt)
  const providerInput = JSON.parse(stableSerialize(input.providerInput)) as Record<string, unknown>
  return seal({
    schemaVersion: PROVIDER_JOB_SCHEMA_VERSION,
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    originProjectVersionId: input.originProjectVersionId,
    operation: input.operation,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    input: Object.freeze(providerInput),
    inputHash: calculateCanonicalHash(providerInput),
    idempotencyKey: input.idempotencyKey,
    authorization: input.authorization,
    attempt: 0,
    status: 'planned',
    createdAt,
    updatedAt: createdAt,
  })
}

const ALLOWED_TRANSITIONS: Readonly<Record<ProviderJobStatus, readonly ProviderJobStatus[]>> = Object.freeze({
  planned: ['estimated', 'failed', 'canceled', 'expired', 'superseded'],
  estimated: ['submitting', 'failed', 'canceled', 'expired', 'superseded'],
  submitting: ['submitted', 'failed', 'canceled', 'expired', 'superseded'],
  submitted: ['queued', 'processing', 'retrieving', 'suspected-stalled', 'failed', 'canceled', 'expired', 'superseded'],
  queued: ['queued', 'processing', 'retrieving', 'suspected-stalled', 'failed', 'canceled', 'expired', 'superseded'],
  processing: ['processing', 'retrieving', 'suspected-stalled', 'failed', 'canceled', 'expired', 'superseded'],
  'suspected-stalled': ['queued', 'processing', 'retrieving', 'suspected-stalled', 'failed', 'canceled', 'expired', 'superseded'],
  retrieving: ['evaluating', 'failed', 'canceled', 'expired', 'superseded'],
  evaluating: ['approved', 'rejected', 'failed', 'canceled', 'expired', 'superseded'],
  approved: [], rejected: [], failed: [], canceled: [], expired: [], superseded: [],
})

export function transitionProviderJob(job: Readonly<ProviderJob>, input: {
  status: ProviderJobStatus
  occurredAt: string
  estimate?: Readonly<ProviderEstimate>
  providerJobId?: string
  providerStatus?: ProviderStatus
  resultArtifact?: Readonly<ProviderJobResultArtifact>
  criticResultHash?: string
  normalizedError?: Readonly<ProviderJobError>
}): Readonly<ProviderJob> {
  assertProviderJob(job)
  assertDomain(ALLOWED_TRANSITIONS[job.status].includes(input.status), 'VERSION_CONFLICT', `Provider job cannot transition from ${job.status} to ${input.status}`)
  const occurredAt = new Date(validDate(input.occurredAt, 'occurredAt')).toISOString()
  assertDomain(Date.parse(occurredAt) >= Date.parse(job.updatedAt), 'VERSION_CONFLICT', 'Provider transition time regressed')
  if (input.status === 'estimated') {
    assertDomain(Boolean(input.estimate) && input.estimate!.costMinorUnits >= 0 && input.estimate!.estimatedLatencyMs >= 0 && /^[A-Z]{3}$/.test(input.estimate!.currency), 'INVALID_ARGUMENT', 'Provider estimate is invalid')
  }
  if (input.status === 'submitted') id(input.providerJobId ?? '', 'providerJobId')
  if (input.status === 'evaluating') {
    assertDomain(Boolean(input.resultArtifact), 'INVALID_ARGUMENT', 'Locally ingested result artifact is required before evaluation')
    assertDomain(HASH.test(input.resultArtifact!.artifactSha256) && Number.isSafeInteger(input.resultArtifact!.byteSize) && input.resultArtifact!.byteSize > 0, 'INVALID_ARGUMENT', 'Provider result artifact is invalid')
  }
  if (input.status === 'approved' || input.status === 'rejected') {
    assertDomain(HASH.test(input.criticResultHash ?? ''), 'INVALID_ARGUMENT', 'Critic result hash is required')
    assertDomain(Boolean(job.resultArtifact), 'INVALID_ARGUMENT', 'Provider result must be ingested before critic outcome')
  }
  if (input.status === 'failed') {
    assertDomain(Boolean(input.normalizedError?.code && input.normalizedError.message), 'INVALID_ARGUMENT', 'Normalized provider error is required')
  }
  const estimate = input.estimate ?? job.estimate
  const providerJobId = input.providerJobId ?? job.providerJobId
  const resultArtifact = input.resultArtifact ?? job.resultArtifact
  const terminal = TERMINAL_PROVIDER_JOB_STATUSES.includes(input.status as typeof TERMINAL_PROVIDER_JOB_STATUSES[number])
  const { jobHash: _jobHash, ...prior } = job
  return seal({
    ...prior,
    status: input.status,
    ...(estimate ? { estimate, estimateHash: calculateCanonicalHash(estimate) } : {}),
    ...(providerJobId ? { providerJobId } : {}),
    ...(input.providerStatus ? { providerStatus: input.providerStatus } : {}),
    ...(resultArtifact ? { resultArtifact } : {}),
    ...(input.criticResultHash ? { criticResultHash: input.criticResultHash } : {}),
    ...(input.normalizedError ? { normalizedError: input.normalizedError } : {}),
    attempt: input.status === 'submitting' ? job.attempt + 1 : job.attempt,
    ...(input.status === 'submitted' ? { submittedAt: occurredAt } : {}),
    ...(['submitting', 'queued', 'processing', 'suspected-stalled', 'retrieving'].includes(input.status) ? { heartbeatAt: occurredAt } : {}),
    ...(terminal ? { completedAt: occurredAt } : {}),
    updatedAt: occurredAt,
  })
}

export function normalizeProviderStatus(status: ProviderStatus): ProviderJobStatus {
  if (status === 'completed') return 'retrieving'
  if (status === 'cancelled') return 'canceled'
  return status
}

export function assertProviderJob(job: Readonly<ProviderJob>): void {
  assertDomain(job.schemaVersion === PROVIDER_JOB_SCHEMA_VERSION, 'PERSISTENCE_CONFLICT', 'Stored provider job schema is invalid')
  assertDomain(PROVIDER_JOB_STATUSES.includes(job.status), 'PERSISTENCE_CONFLICT', 'Stored provider job status is invalid')
  assertDomain(job.inputHash === calculateCanonicalHash(job.input), 'PERSISTENCE_CONFLICT', 'Stored provider job input hash is invalid')
  assertAuthorization(job.authorization, job.createdAt)
  const { jobHash, ...body } = job
  if (calculateCanonicalHash(body) !== jobHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored provider job hash is invalid')
  }
}

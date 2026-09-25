import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION,
  type ProviderRuntimeClass,
  type ProviderTransportObservation,
  type ProviderTransportPhase,
  PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  type ProviderTransportEvidence,
  type ProviderExecutionReceipt,
} from './ports/provider-execution-provenance-repository.ts'

const HASH = /^[a-f0-9]{64}$/
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/

export function createProviderTransportObservation(input: {
  phase: ProviderTransportPhase
  runtimeClass: ProviderRuntimeClass
  adapterId: string
  adapterVersion: string
  adapterConfigHash: string
  endpointClass: string
  method: string
  requestHash: string
  responseHash: string
  responseStatus: number
  providerJobRef?: string
  observedAt: string
}): Readonly<ProviderTransportObservation> {
  assertDomain(NAME.test(input.adapterId) && NAME.test(input.adapterVersion) && NAME.test(input.endpointClass), 'PERSISTENCE_CONFLICT', 'Provider transport observation identity is invalid')
  assertDomain(HASH.test(input.adapterConfigHash) && HASH.test(input.requestHash) && HASH.test(input.responseHash), 'PERSISTENCE_CONFLICT', 'Provider transport observation hashes are invalid')
  assertDomain(/^[A-Z]{3,10}$/.test(input.method), 'PERSISTENCE_CONFLICT', 'Provider transport observation method is invalid')
  assertDomain(Number.isSafeInteger(input.responseStatus) && input.responseStatus >= 100 && input.responseStatus <= 599, 'PERSISTENCE_CONFLICT', 'Provider transport observation status is invalid')
  assertDomain(Number.isFinite(Date.parse(input.observedAt)), 'PERSISTENCE_CONFLICT', 'Provider transport observation time is invalid')
  const body = Object.freeze({
    schemaVersion: PROVIDER_TRANSPORT_OBSERVATION_SCHEMA_VERSION,
    phase: input.phase,
    runtimeClass: input.runtimeClass,
    adapterId: input.adapterId,
    adapterVersion: input.adapterVersion,
    adapterConfigHash: input.adapterConfigHash,
    endpointClass: input.endpointClass,
    method: input.method,
    requestHash: input.requestHash,
    responseHash: input.responseHash,
    responseStatus: input.responseStatus,
    ...(input.providerJobRef === undefined ? {} : { providerJobRef: input.providerJobRef }),
    observedAt: input.observedAt,
  })
  return Object.freeze({ ...body, observationHash: calculateCanonicalHash(body) })
}

/** createdAt is a database ingestion clock, so concurrent retries converge. */
export function providerExecutionReceiptBody(value: Readonly<ProviderExecutionReceipt> | Omit<ProviderExecutionReceipt, 'receiptHash'>) {
  const { createdAt: _createdAt, ...withPossibleHash } = value
  // Lease fields fence the write transaction but are operational capabilities,
  // not immutable execution identity. Excluding them lets a post-commit worker
  // restart converge on the receipt written by the previous claim.
  const { receiptHash: _receiptHash, leaseOwner: _leaseOwner, leaseToken: _leaseToken, ...body } = withPossibleHash as ProviderExecutionReceipt
  return body
}

export function createProviderExecutionReceipt(input: Omit<ProviderExecutionReceipt, 'receiptHash'>): Readonly<ProviderExecutionReceipt> {
  return Object.freeze({ ...input, receiptHash: calculateCanonicalHash(providerExecutionReceiptBody(input)) })
}

export function bindProviderTransportEvidence(input: {
  observation: Readonly<ProviderTransportObservation>
  workspaceId: string
  projectId: string
  jobId: string
  attempt: number
  inputHash: string
  authorizationHash: string
  jobHash: string
  leaseOwner: string
  leaseToken: string
}): Readonly<ProviderTransportEvidence> {
  const body = Object.freeze({
    schemaVersion: PROVIDER_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
    id: `provider-evidence-${calculateCanonicalHash({ jobId: input.jobId, attempt: input.attempt, phase: input.observation.phase, observationHash: input.observation.observationHash }).slice(0, 48)}`,
    workspaceId: input.workspaceId, projectId: input.projectId, jobId: input.jobId,
    attempt: input.attempt, phase: input.observation.phase, runtimeClass: input.observation.runtimeClass,
    adapterId: input.observation.adapterId, adapterVersion: input.observation.adapterVersion,
    adapterConfigHash: input.observation.adapterConfigHash, endpointClass: input.observation.endpointClass,
    method: input.observation.method, requestHash: input.observation.requestHash,
    responseHash: input.observation.responseHash, responseStatus: input.observation.responseStatus,
    ...(input.observation.providerJobRef === undefined ? {} : { providerJobRef: input.observation.providerJobRef }),
    observedAt: input.observation.observedAt, observationHash: input.observation.observationHash,
    inputHash: input.inputHash, authorizationHash: input.authorizationHash,
    jobHash: input.jobHash,
    leaseOwner: input.leaseOwner, leaseToken: input.leaseToken,
  })
  return Object.freeze({ ...body, evidenceHash: calculateCanonicalHash(body) })
}

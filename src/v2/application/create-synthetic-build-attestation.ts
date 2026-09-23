import type {
  SyntheticBuildAttestationRepository,
  SyntheticBuildAttestationRunner,
} from './ports/synthetic-build-attestation-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  assertSyntheticBuildAttestation,
  calculateSyntheticBuildAttestationHash,
  SYNTHETIC_BUILD_ATTESTATION_SCHEMA_VERSION,
} from '../domain/synthetic-build-attestation.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

export function createSyntheticBuildAttestationService(dependencies: {
  repository: SyntheticBuildAttestationRepository
  runner: SyntheticBuildAttestationRunner
  createId: () => string
}) {
  return async function create(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    productionRunId: string
    publicOperationId: string
    renderManifestId: string
    idempotencyKey: string
    signal?: AbortSignal
  }) {
    const normalized = Object.freeze({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      projectVersionId: identity(request.projectVersionId, 'projectVersionId'),
      productionRunId: identity(request.productionRunId, 'productionRunId'),
      publicOperationId: identity(request.publicOperationId, 'publicOperationId'),
      renderManifestId: identity(request.renderManifestId, 'renderManifestId'),
    })
    assertDomain(
      typeof request.idempotencyKey === 'string' &&
        IDEMPOTENCY_PATTERN.test(request.idempotencyKey.trim()),
      'INVALID_ARGUMENT',
      'Synthetic build attestation idempotencyKey is invalid',
    )
    const idempotencyKey = request.idempotencyKey.trim()
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'synthetic-build-attestation-request/v1',
      ...normalized,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId: normalized.workspaceId,
      projectId: normalized.projectId,
      idempotencyKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with another build attestation binding',
        )
      }
      return Object.freeze({ record: replay, replayed: true })
    }
    const binding = await dependencies.repository.readBinding(normalized)
    if (!binding) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Synthetic render binding for build attestation was not found',
      )
    }
    const result = await dependencies.runner.run({ signal: request.signal })
    assertDomain(
      result.identity.commitSha === binding.runtimeCommitSha &&
        result.identity.contractGraphHash === binding.runtimeContractGraphHash &&
        result.identity.renderBundleHash === binding.runtimeRenderBundleHash,
      'VERSION_CONFLICT',
      'Build identity differs from the runtime that produced the render binding',
    )
    const content = Object.freeze({
      schemaVersion: SYNTHETIC_BUILD_ATTESTATION_SCHEMA_VERSION,
      id: identity(dependencies.createId(), 'attestation.id'),
      workspaceId: binding.workspaceId,
      projectId: binding.projectId,
      projectVersionId: binding.projectVersionId,
      projectVersionHash: binding.projectVersionHash,
      productionRunId: binding.productionRunId,
      publicOperationId: binding.publicOperationId,
      planSnapshotId: binding.planSnapshotId,
      planSnapshotHash: binding.planSnapshotHash,
      renderManifestId: binding.renderManifestId,
      renderManifestHash: binding.renderManifestHash,
      identity: result.identity,
      checks: result.checks,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
    })
    const attestation = Object.freeze({
      ...content,
      attestationHash: calculateSyntheticBuildAttestationHash(content),
    })
    assertSyntheticBuildAttestation(attestation)
    return dependencies.repository.create({
      attestation,
      requestFingerprint,
      idempotencyKey,
    })
  }
}

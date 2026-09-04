import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  PersistedSyntheticPhaseGate,
  SyntheticPhaseGateRepository,
} from './ports/synthetic-phase-gate-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { evaluateSyntheticPhaseGate } from '../domain/synthetic-phase-gate.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/

export type SyntheticPhaseGateReport =
  ReturnType<typeof evaluateSyntheticPhaseGate>

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      SHA_256_PATTERN.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value.trim().toLowerCase()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

export function calculateSyntheticPhaseGateRecordHash(
  gate: Omit<PersistedSyntheticPhaseGate, 'recordHash'>,
): string {
  return calculateCanonicalHash(gate)
}

export function runSyntheticPhaseGateService(dependencies: {
  repository: SyntheticPhaseGateRepository
  clock: () => Date
  createId: () => string
}) {
  return async function run(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(
      request.projectVersionId,
      'projectVersionId',
    )
    const projectVersionHash = sha256(
      request.projectVersionHash,
      'projectVersionHash',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Synthetic phase gate actor does not belong to the workspace',
    )
    const actorId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'synthetic-phase-gate-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      actorContextHash: authenticationAudit.contextHash,
    })

    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different synthetic phase gate request',
        )
      }
      return Object.freeze({ gate: replay, replayed: true })
    }

    const context = await dependencies.repository.readEvidence({
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      actorId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Synthetic phase gate project evidence was not found',
      )
    }
    if (
      context.projectVersionId !== projectVersionId ||
      context.projectVersionHash !== projectVersionHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Synthetic phase gate project version changed before evaluation',
        {
          currentProjectVersionId: context.projectVersionId,
          currentProjectVersionHash: context.projectVersionHash,
        },
      )
    }

    const now = dependencies.clock()
    assertDomain(
      !Number.isNaN(now.getTime()),
      'INVALID_ARGUMENT',
      'Synthetic phase gate clock is invalid',
    )
    const report = evaluateSyntheticPhaseGate({
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      evidence: context.evidence,
      evaluatedAt: now.toISOString(),
    })
    const content = Object.freeze({
      schemaVersion: 'synthetic-phase-gate/v1' as const,
      id: identity(dependencies.createId(), 'gate.id'),
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      report,
      reportFingerprint: report.fingerprint,
      idempotencyKey: key,
      requestFingerprint,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt: now.toISOString(),
    })
    const gate = Object.freeze({
      ...content,
      recordHash: calculateSyntheticPhaseGateRecordHash(content),
    })
    return dependencies.repository.persist(gate, authenticationAudit)
  }
}

export function listSyntheticPhaseGatesService(dependencies: {
  repository: SyntheticPhaseGateRepository
}) {
  return async function list(request: {
    workspaceId: string
    projectId: string
    limit?: number
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({ workspaceId, projectId, limit })
  }
}

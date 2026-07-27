import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  evaluateMvpCoreGate,
} from '../domain/mvp-core-gate.ts'
import type {
  MvpCoreGateRepository,
  PersistedMvpCoreGate,
} from './ports/mvp-core-gate-repository.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/

export type MvpCoreGateReport = ReturnType<typeof evaluateMvpCoreGate>

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

export function calculateMvpCoreGateRecordHash(
  gate: Omit<PersistedMvpCoreGate, 'recordHash'>,
): string {
  return calculateCanonicalHash(gate)
}

export function runMvpCoreGateService(dependencies: {
  repository: MvpCoreGateRepository
  clock: () => Date
  createId: () => string
}) {
  return async function run(request: {
    workspaceId: string
    primaryProjectId: string
    primaryVersionId: string
    primaryVersionHash: string
    companionProjectId: string
    companionVersionId: string
    companionVersionHash: string
    duplicateProjectId: string
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const primaryProjectId = identity(
      request.primaryProjectId,
      'primaryProjectId',
    )
    const primaryVersionId = identity(
      request.primaryVersionId,
      'primaryVersionId',
    )
    const primaryVersionHash = sha256(
      request.primaryVersionHash,
      'primaryVersionHash',
    )
    const companionProjectId = identity(
      request.companionProjectId,
      'companionProjectId',
    )
    const companionVersionId = identity(
      request.companionVersionId,
      'companionVersionId',
    )
    const companionVersionHash = sha256(
      request.companionVersionHash,
      'companionVersionHash',
    )
    const duplicateProjectId = identity(
      request.duplicateProjectId,
      'duplicateProjectId',
    )
    assertDomain(
      primaryProjectId !== companionProjectId &&
        primaryProjectId !== duplicateProjectId &&
        companionProjectId !== duplicateProjectId,
      'INVALID_ARGUMENT',
      'MVP gate projects must have distinct identities',
    )
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'MVP gate requires an authenticated API client',
    )
    const actorId = identity(request.actor.id, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'mvp-core-gate-request/v1',
      workspaceId,
      primaryProjectId,
      primaryVersionId,
      primaryVersionHash,
      companionProjectId,
      companionVersionId,
      companionVersionHash,
      duplicateProjectId,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      primaryProjectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different MVP gate request',
        )
      }
      return Object.freeze({ gate: replay, replayed: true })
    }

    const context = await dependencies.repository.readEvidence({
      workspaceId,
      primaryProjectId,
      primaryVersionId,
      primaryVersionHash,
      companionProjectId,
      companionVersionId,
      companionVersionHash,
      duplicateProjectId,
      actorId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'MVP gate project evidence was not found',
      )
    }
    if (
      context.primaryVersionId !== primaryVersionId ||
      context.primaryVersionHash !== primaryVersionHash ||
      context.companionVersionId !== companionVersionId ||
      context.companionVersionHash !== companionVersionHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'MVP gate project versions changed before evaluation',
        {
          currentPrimaryVersionId: context.primaryVersionId,
          currentPrimaryVersionHash: context.primaryVersionHash,
          currentCompanionVersionId: context.companionVersionId,
          currentCompanionVersionHash: context.companionVersionHash,
        },
      )
    }
    const now = dependencies.clock()
    assertDomain(
      !Number.isNaN(now.getTime()),
      'INVALID_ARGUMENT',
      'MVP gate clock is invalid',
    )
    const report = evaluateMvpCoreGate({
      workspaceId,
      primaryProjectId,
      companionProjectId,
      evidence: context.evidence,
      evaluatedAt: now.toISOString(),
    })
    const content = Object.freeze({
      schemaVersion: 'mvp-core-gate/v1' as const,
      id: identity(dependencies.createId(), 'gate.id'),
      workspaceId,
      primaryProjectId,
      companionProjectId,
      primaryVersionId,
      companionVersionId,
      primaryVersionHash,
      companionVersionHash,
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
      recordHash: calculateMvpCoreGateRecordHash(content),
    })
    return dependencies.repository.persist(gate)
  }
}

export function listMvpCoreGatesService(dependencies: {
  repository: MvpCoreGateRepository
}) {
  return async function list(request: {
    workspaceId: string
    primaryProjectId: string
    limit?: number
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const primaryProjectId = identity(
      request.primaryProjectId,
      'primaryProjectId',
    )
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId,
      primaryProjectId,
      limit,
    })
  }
}

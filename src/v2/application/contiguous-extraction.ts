import type {
  ContiguousExtractionRepository,
  PersistedContiguousExtraction,
} from './ports/contiguous-extraction-repository.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import {
  calculateCanonicalHash,
} from '../domain/canonical-hash.ts'
import {
  extractContiguous,
} from '../domain/contiguous-extraction.ts'
import { DomainError } from '../domain/errors.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$/

function identity(value: string, field: string): string {
  const normalized = value.trim()
  if (!ID_PATTERN.test(normalized)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return normalized
}

function text(
  value: string,
  field: string,
  maximum: number,
): string {
  const normalized = value.trim().replace(/\s+/g, ' ')
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return normalized
}

function integer(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return value
}

function instant(value: Date, field: string): string {
  const milliseconds = value.getTime()
  if (!Number.isFinite(milliseconds)) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} is invalid`,
    )
  }
  return new Date(milliseconds).toISOString()
}

export interface CreateContiguousExtractionRequest {
  workspaceId: string
  projectId: string
  objective: string
  topic: string
  targetDurationMs: number
  toleranceMs: number
  fps: number
  actor: Readonly<AuthenticatedExternalActor>
  idempotencyKey: string
}

export function createContiguousExtractionService(dependencies: {
  repository: ContiguousExtractionRepository
  createId: () => string
  clock?: () => Date
  candidateLimit?: number
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const candidateLimit = dependencies.candidateLimit ?? 500
  if (
    !Number.isSafeInteger(candidateLimit) ||
    candidateLimit < 1 ||
    candidateLimit > 10_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'contiguous extraction candidate limit is invalid',
    )
  }

  return async function create(
    request: Readonly<CreateContiguousExtractionRequest>,
  ): Promise<Readonly<{
    extraction: Readonly<PersistedContiguousExtraction>
    replayed: boolean
  }>> {
    const workspaceId = identity(
      request.workspaceId,
      'workspaceId',
    )
    const projectId = identity(request.projectId, 'projectId')
    const objective = text(request.objective, 'objective', 240)
    const topic = text(request.topic, 'topic', 500)
    const targetDurationMs = integer(
      request.targetDurationMs,
      'targetDurationMs',
      1_000,
      60 * 60 * 1_000,
    )
    const toleranceMs = integer(
      request.toleranceMs,
      'toleranceMs',
      0,
      targetDurationMs,
    )
    const fps = integer(request.fps, 'fps', 1, 120)
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    if (authenticationAudit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Contiguous extraction actor does not belong to the workspace')
    const createdByClientId = identity(
      authenticationAudit.clientId,
      'actor.id',
    )
    const idempotencyKey = request.idempotencyKey.trim()
    if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'idempotencyKey is invalid',
      )
    }
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-contiguous-extraction-request/v1',
      workspaceId,
      projectId,
      objective,
      topic,
      targetDurationMs,
      toleranceMs,
      fps,
      createdByClientId,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      createdByClientId,
      idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with another contiguous extraction request',
        )
      }
      return Object.freeze({
        extraction: replay,
        replayed: true,
      })
    }
    const createdAt = instant(clock(), 'clock')
    const moments =
      await dependencies.repository.readCandidateMoments({
        workspaceId,
        projectId,
        topic,
        objective,
        targetDurationMs,
        toleranceMs,
        limit: candidateLimit,
        now: createdAt,
      })
    const result = extractContiguous({
      id: identity(dependencies.createId(), 'extractionId'),
      workspaceId,
      projectId,
      objective,
      topic,
      targetDurationMs,
      toleranceMs,
      fps,
      moments,
    })
    const extraction = Object.freeze({
      result,
      requestFingerprint,
      idempotencyKey,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: createdByClientId,
      }),
      createdAt,
    })
    const persisted = await dependencies.repository.persist(extraction, authenticationAudit)
    if (
      persisted.extraction.requestFingerprint !==
        requestFingerprint ||
      persisted.extraction.idempotencyKey !== idempotencyKey
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Persisted contiguous extraction diverged from its request',
      )
    }
    return persisted
  }
}

export function readContiguousExtractionService(dependencies: {
  repository: ContiguousExtractionRepository
}) {
  return async function read(input: {
    workspaceId: string
    projectId: string
    extractionId: string
  }): Promise<Readonly<PersistedContiguousExtraction>> {
    const normalized = {
      workspaceId: identity(input.workspaceId, 'workspaceId'),
      projectId: identity(input.projectId, 'projectId'),
      extractionId: identity(input.extractionId, 'extractionId'),
    }
    const extraction = await dependencies.repository.read(normalized)
    if (!extraction) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Contiguous extraction was not found',
      )
    }
    return extraction
  }
}

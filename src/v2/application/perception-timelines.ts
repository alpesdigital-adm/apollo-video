import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { PerceptionTimelineRepository, PersistedPerceptionTimeline } from './ports/perception-timeline-repository.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { createPerceptionTimeline, queryPerceptionRange, type PerceptionKind, type PerceptionObservation, type PerceptionRange } from '../domain/perception-timeline.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7e]{8,128}$/
function identity(value: string, field: string) {
  const normalized = value?.trim()
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

export function calculatePerceptionTimelineRecordHash(
  value: Omit<PersistedPerceptionTimeline, 'recordHash'>,
) { return calculateCanonicalHash(value) }

export function putPerceptionTimelineService(dependencies: {
  repository: PerceptionTimelineRepository
  clock: () => Date
  createId: () => string
}) {
  return async (request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    baseRevision: string | null
    durationMs: number
    observations: readonly PerceptionObservation[]
    coverage: readonly Readonly<{ kind: PerceptionKind; ranges: readonly PerceptionRange[] }>[]
    idempotencyKey: string
    actor: Readonly<AuthenticatedExternalActor>
  }) => {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    if (request.baseRevision !== null && !SHA256.test(request.baseRevision)) {
      throw new DomainError('INVALID_ARGUMENT', 'baseRevision must be null or a SHA-256 hash')
    }
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!IDEMPOTENCY.test(idempotencyKey)) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    if (authenticationAudit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Perception actor belongs to another workspace')
    const timeline = createPerceptionTimeline({
      durationMs: request.durationMs,
      observations: request.observations,
      coverage: request.coverage,
    })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'put-perception-timeline-request/v1',
      workspaceId, projectId, projectVersionId, baseRevision: request.baseRevision, timeline,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId, projectId, idempotencyKey,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another perception timeline')
      return Object.freeze({ timeline: replay, replayed: true })
    }
    const createdAt = dependencies.clock().toISOString()
    if (Number.isNaN(Date.parse(createdAt))) throw new DomainError('INVALID_ARGUMENT', 'Perception clock is invalid')
    const content = Object.freeze({
      schemaVersion: 'persisted-perception-timeline/v1' as const,
      id: identity(dependencies.createId(), 'perceptionTimelineId'),
      workspaceId, projectId, projectVersionId, baseRevision: request.baseRevision, timeline,
      requestFingerprint, idempotencyKey, authenticationAudit,
      createdByClientId: authenticationAudit.clientId, createdAt,
    })
    return dependencies.repository.persist(Object.freeze({
      ...content, recordHash: calculatePerceptionTimelineRecordHash(content),
    }))
  }
}

export function readPerceptionTimelineRangeService(dependencies: {
  repository: PerceptionTimelineRepository
}) {
  return async (request: {
    workspaceId: string
    projectId: string
    startMs?: number
    endMs?: number
    kinds?: readonly PerceptionKind[]
  }) => {
    const persisted = await dependencies.repository.findLatest({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
    })
    if (!persisted) throw new DomainError('PROJECT_NOT_FOUND', 'Project perception timeline was not found')
    const startMs = request.startMs ?? 0
    const endMs = request.endMs ?? persisted.timeline.durationMs
    return Object.freeze({
      id: persisted.id,
      workspaceId: persisted.workspaceId,
      projectId: persisted.projectId,
      projectVersionId: persisted.projectVersionId,
      createdAt: persisted.createdAt,
      result: queryPerceptionRange(persisted.timeline, { startMs, endMs, kinds: request.kinds }),
    })
  }
}

import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import type {
  PublicOperationPersistenceResult,
  PublicOperationRepository,
} from './ports/public-operation-repository.ts'
import { projectDirectorRequestFingerprint } from './run-project-director.ts'
import { calculateVersionHash } from './version-hash.ts'
import { createDesiredAction } from '../domain/desired-action.ts'
import {
  bindDirectorObjective,
  resolveStrategicObjective,
  type StrategicObjectiveId,
} from '../domain/strategic-objective.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export interface EnqueueProjectDirectorRunRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  actor: AuthenticatedExternalActor
  idempotencyKey: string
  reason?: string
  objective?: StrategicObjectiveId
  destination?: string
  traceId?: string
}

export function enqueueProjectDirectorRunService(dependencies: {
  directorRuns: DirectorRunRepository
  operations: PublicOperationRepository
  clock?: () => Date
  createId: (kind: 'operation' | 'project-version') => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function enqueue(
    request: EnqueueProjectDirectorRunRequest,
  ): Promise<Readonly<PublicOperationPersistenceResult>> {
    const workspaceId = request.workspaceId.trim()
    const projectId = request.projectId.trim()
    const baseVersionId = request.baseVersionId.trim()
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match Director request')
    const clientId = audit.clientId.trim()
    const idempotencyKey = request.idempotencyKey.trim()
    const reason = request.reason?.trim()
    assertDomain(
      [workspaceId, projectId, baseVersionId, clientId].every((value) =>
        ID_PATTERN.test(value)),
      'INVALID_PUBLIC_OPERATION',
      'Director operation identifiers are invalid',
    )
    assertDomain(
      /^[a-f0-9]{64}$/.test(request.baseHash),
      'INVALID_PUBLIC_OPERATION',
      'Director operation baseHash is invalid',
    )
    assertDomain(
      idempotencyKey.length >= 1 && idempotencyKey.length <= 128,
      'INVALID_PUBLIC_OPERATION',
      'Idempotency-Key is invalid',
    )
    assertDomain(
      reason === undefined || (reason.length >= 1 && reason.length <= 1000),
      'INVALID_PUBLIC_OPERATION',
      'Director operation reason is invalid',
    )
    assertDomain(
      audit.delegatedUserId === undefined ||
        ID_PATTERN.test(audit.delegatedUserId),
      'INVALID_PUBLIC_OPERATION',
      'Director delegated user is invalid',
    )
    const requestFingerprint = calculateVersionHash({
      request: projectDirectorRequestFingerprint({
        workspaceId,
        projectId,
        baseVersionId,
        baseHash: request.baseHash,
        actorContextHash: audit.contextHash,
        objective: request.objective,
        destination: request.destination,
        ...(reason ? { reason } : {}),
      }),
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId,
      clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay

    const context = await dependencies.directorRuns.readContext({
      workspaceId,
      projectId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project with aligned media was not found',
      )
    }
    if (
      context.currentVersion.id !== baseVersionId ||
      context.currentVersion.baseHash !== request.baseHash
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Director base version is stale', {
        currentVersionId: context.currentVersion.id,
        currentBaseHash: context.currentVersion.baseHash,
      })
    }
    const objective = resolveStrategicObjective(
      request.objective ?? context.project.objective,
    )
    const objectiveBinding = bindDirectorObjective({
      objective: objective.id,
      ...(context.latestDirectorObjective
        ? { previous: context.latestDirectorObjective }
        : {}),
    })
    const objectiveChanged = objective.id !== context.project.objective
    assertDomain(
      !objectiveChanged || Boolean(reason),
      'PRECONDITION_REQUIRED',
      'Changing the strategic objective requires an explicit reason',
    )
    assertDomain(
      objectiveChanged || request.destination === undefined,
      'INVALID_ARGUMENT',
      'destination is only accepted when the strategic objective changes',
    )
    if (objectiveChanged) {
      createDesiredAction({
        objective: objective.id,
        ...(request.destination?.trim()
          ? { destination: request.destination.trim() }
          : {}),
      })
    }

    const resultVersionId = dependencies.createId('project-version')
    const createdAt = clock().toISOString()
    const operation = createQueuedPublicOperation({
      id: dependencies.createId('operation'),
      workspaceId,
      projectId,
      clientId,
      type: 'project-director-run',
      target: { type: 'project-version', id: resultVersionId },
      createdAt,
    })
    return dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: {
        kind: 'project-director-run',
        projectId,
        baseVersionId,
        baseHash: request.baseHash,
        resultVersionId,
        baseObjective: context.project.objective,
        objective: objective.id,
        objectiveVersion: objectiveBinding.objectiveVersion,
        rubricRef: objectiveBinding.rubricRef,
        ...(objectiveBinding.supersedesRunId
          ? { supersedesRunId: objectiveBinding.supersedesRunId }
          : {}),
        ...(request.destination?.trim()
          ? { destination: request.destination.trim() }
          : {}),
        ...(audit.delegatedUserId
          ? { delegatedUserId: audit.delegatedUserId }
          : {}),
        ...(reason ? { reason } : {}),
      },
      idempotencyKey,
      requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
  }
}

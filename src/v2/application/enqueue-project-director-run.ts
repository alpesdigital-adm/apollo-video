import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type { DirectorRunRepository } from './ports/director-run-repository.ts'
import type {
  PublicOperationPersistenceResult,
  PublicOperationRepository,
} from './ports/public-operation-repository.ts'
import { projectDirectorRequestFingerprint } from './run-project-director.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

export interface EnqueueProjectDirectorRunRequest {
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  actor: Readonly<{
    type: 'api-client'
    id: string
    delegatedUserId?: string
  }>
  idempotencyKey: string
  reason?: string
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
    const clientId = request.actor.id.trim()
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
      request.actor.delegatedUserId === undefined ||
        ID_PATTERN.test(request.actor.delegatedUserId),
      'INVALID_PUBLIC_OPERATION',
      'Director delegated user is invalid',
    )
    const requestFingerprint = projectDirectorRequestFingerprint({
      workspaceId,
      projectId,
      baseVersionId,
      baseHash: request.baseHash,
      ...(reason ? { reason } : {}),
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId,
      clientId,
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
      context: {
        kind: 'project-director-run',
        projectId,
        baseVersionId,
        baseHash: request.baseHash,
        resultVersionId,
        ...(request.actor.delegatedUserId
          ? { delegatedUserId: request.actor.delegatedUserId }
          : {}),
        ...(reason ? { reason } : {}),
      },
      idempotencyKey,
      requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
  }
}

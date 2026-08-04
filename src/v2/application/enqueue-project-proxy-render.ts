import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../domain/public-operation.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import { projectProxyRenderInputHash } from './project-render-sources.ts'
import { resolveRenderColorPipelineBindings } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(normalized.length >= 3 && normalized.length <= 128, 'INVALID_ARGUMENT', `${field} must contain 3 to 128 characters`)
  return normalized
}

export function enqueueProjectProxyRenderService(dependencies: {
  projects: ProjectProxyRenderRepository
  operations: PublicOperationRepository
  colorPipelines: ColorPipelineCompilationRepository
  clock: () => Date
  createId: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    expectedProjectVersionId?: string
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const expectedProjectVersionId = request.expectedProjectVersionId
      ? validateId(request.expectedProjectVersionId, 'expectedProjectVersionId')
      : undefined
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match proxy request')
    const clientId = validateId(audit.clientId, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    const source = await dependencies.projects.readCurrentSource({ workspaceId, projectId })
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Project with a compiled EditPlan and source master was not found')
    if (expectedProjectVersionId && source.projectVersionId !== expectedProjectVersionId) {
      throw new DomainError('VERSION_CONFLICT', 'Project changed before proxy enqueue', {
        expectedProjectVersionId,
        currentProjectVersionId: source.projectVersionId,
      })
    }
    if (source.unchangedReuseRequired && !source.unchangedReuse) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Render-free project change requires a completed proxy from its base version',
      )
    }
    const colorPipelineBindings = source.unchangedReuse
      ? Object.freeze([])
      : await resolveRenderColorPipelineBindings({
          repository: dependencies.colorPipelines, workspaceId, projectId, sources: source.renderSources,
        })
    const inputHash = projectProxyRenderInputHash({ source, colorPipelineBindings })
    const requestFingerprint = calculateVersionHash({ type: 'project-proxy-render', projectId, inputHash, actorContextHash: audit.contextHash })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint })
    if (replay) return replay
    const operationId = dependencies.createId('operation')
    const outputArtifactId = source.unchangedReuse?.artifactId ?? dependencies.createId('artifact')
    const outputManifestId = source.unchangedReuse?.manifestId ?? dependencies.createId('manifest')
    const now = dependencies.clock().toISOString()
    let operation = createQueuedPublicOperation({
      id: operationId, workspaceId, projectId, clientId, type: 'project-proxy-render',
      target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId }, createdAt: now,
    })
    if (source.unchangedReuse) {
      operation = startPublicOperationAttempt(operation, now)
      operation = advancePublicOperationPhase(operation, 'persisting', now)
      operation = succeedPublicOperation(operation, now)
    }
    return dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: source.unchangedReuse ? {
        kind: 'project-proxy-reuse', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId,
        commandId: source.unchangedReuse.commandId,
        impactHash: source.unchangedReuse.impactHash,
        baseVersionId: source.unchangedReuse.baseVersionId,
        reusedFromOperationId: source.unchangedReuse.operationId,
        sourceArtifactId: source.sourceArtifactId, sourceManifestId: source.sourceManifestId,
        inputHash, outputArtifactId, outputManifestId,
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      } : {
        kind: 'project-proxy-render', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId, sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId, inputHash, outputArtifactId, outputManifestId,
        colorPipelineBindings,
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      },
      idempotencyKey,
      requestFingerprint,
      traceId: request.traceId,
    })
  }
}

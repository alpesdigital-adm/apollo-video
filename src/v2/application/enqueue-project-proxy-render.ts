import { assertDomain, DomainError } from '../domain/errors.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import type { ProjectProxyRenderRepository } from './ports/project-proxy-render-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(normalized.length >= 3 && normalized.length <= 128, 'INVALID_ARGUMENT', `${field} must contain 3 to 128 characters`)
  return normalized
}

export function enqueueProjectProxyRenderService(dependencies: {
  projects: ProjectProxyRenderRepository
  operations: PublicOperationRepository
  clock: () => Date
  createId: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    actor: { type: 'api-client'; id: string }
    idempotencyKey: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const clientId = validateId(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length > 0 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    const source = await dependencies.projects.readCurrentSource({ workspaceId, projectId })
    if (!source) throw new DomainError('PROJECT_NOT_FOUND', 'Project with a compiled EditPlan and source master was not found')
    const inputHash = calculateVersionHash({
      kind: 'project-proxy-render/v1', projectId, projectVersionId: source.projectVersionId,
      editPlanSnapshotId: source.editPlanSnapshotId, editPlanHash: source.editPlanHash,
      sourceArtifactId: source.sourceArtifactId, sourceManifestId: source.sourceManifestId,
      sourceSha256: source.sourceSha256, format: source.format,
    })
    const requestFingerprint = calculateVersionHash({ type: 'project-proxy-render', projectId, inputHash })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, idempotencyKey, requestFingerprint })
    if (replay) return replay
    const operationId = dependencies.createId('operation')
    const outputArtifactId = dependencies.createId('artifact')
    const outputManifestId = dependencies.createId('manifest')
    const now = dependencies.clock().toISOString()
    const operation = createQueuedPublicOperation({
      id: operationId, workspaceId, clientId, type: 'project-proxy-render',
      target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId }, createdAt: now,
    })
    return dependencies.operations.createOrReplay({
      operation,
      context: {
        kind: 'project-proxy-render', projectId, projectVersionId: source.projectVersionId,
        editPlanSnapshotId: source.editPlanSnapshotId, sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId, inputHash, outputArtifactId, outputManifestId,
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 200)}-editorial.mp4`,
      },
      idempotencyKey,
      requestFingerprint,
    })
  }
}

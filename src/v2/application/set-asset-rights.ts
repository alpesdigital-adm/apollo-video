import {
  createAssetRightsSnapshot,
  type AssetRightsDraft,
} from '../domain/asset-rights.ts'
import {
  createAssetRightsChangeIntent,
  type AssetRightsChangeActor,
} from '../domain/asset-rights-change.ts'
import { assertDomain } from '../domain/errors.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  AssetRightsRepository,
  SetAssetRightsResult,
} from './ports/asset-rights-repository.ts'

export function setAssetRightsService(dependencies: {
  repository: AssetRightsRepository
  clock: () => Date
  createId: () => string
}) {
  return async function setAssetRights(request: {
    workspaceId: string
    artifactId: string
    baseRevision: string
    draft: AssetRightsDraft
    actor: { type: 'api-client' | 'user' | 'system'; id: string }
  }): Promise<SetAssetRightsResult> {
    return setAssetRightsWithActor(dependencies, request, {
      kind: 'internal',
      actorType: request.actor.type,
      actorId: request.actor.id,
    })
  }
}

export function setExternalAssetRightsService(dependencies: {
  repository: AssetRightsRepository
  clock: () => Date
  createId: () => string
}) {
  return async function setExternalAssetRights(request: {
    workspaceId: string
    artifactId: string
    baseRevision: string
    draft: AssetRightsDraft
    actor: AuthenticatedExternalActor
  }): Promise<SetAssetRightsResult> {
    requireScope(request.actor, 'artifacts:rights')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(
      audit.workspaceId === request.workspaceId,
      'MEDIA_ARTIFACT_NOT_FOUND',
      'Media artifact was not found',
    )
    return setAssetRightsWithActor(
      dependencies,
      { ...request, actor: request.actor.auditContext.actor },
      { kind: 'external', audit },
    )
  }
}

async function setAssetRightsWithActor(
  dependencies: {
    repository: AssetRightsRepository
    clock: () => Date
    createId: () => string
  },
  request: {
    workspaceId: string
    artifactId: string
    baseRevision: string
    draft: AssetRightsDraft
    actor: { type: 'api-client' | 'user' | 'system'; id: string }
  },
  changeActor: AssetRightsChangeActor,
): Promise<SetAssetRightsResult> {
    const baseRevision = request.baseRevision.trim().toLowerCase()
    assertDomain(
      /^[a-f0-9]{64}$/.test(baseRevision),
      'INVALID_ARGUMENT',
      'Asset rights base revision is invalid',
    )
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const snapshot = createAssetRightsSnapshot({
      id: dependencies.createId(),
      workspaceId: request.workspaceId,
      artifactId: request.artifactId,
      sequence: 1,
      draft: request.draft,
      createdBy: request.actor,
      createdAt: now.toISOString(),
    })
    const change = createAssetRightsChangeIntent({
      workspaceId: request.workspaceId,
      artifactId: request.artifactId,
      snapshotHash: snapshot.snapshotHash,
      baseRevision,
      actor: changeActor,
      changedAt: now.toISOString(),
    })
    return dependencies.repository.setCurrent(snapshot, baseRevision, change)
}

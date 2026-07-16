import {
  createAssetRightsSnapshot,
  type AssetRightsDraft,
} from '../domain/asset-rights.ts'
import { assertDomain } from '../domain/errors.ts'
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
    return dependencies.repository.setCurrent(snapshot, baseRevision)
  }
}

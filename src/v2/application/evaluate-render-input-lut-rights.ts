import type { AssetUseDecision } from '../domain/asset-rights.ts'
import type { RenderInputAsset } from '../domain/render-input.ts'
import { parseRenderInputLutIdentity } from '../domain/render-input-lut-asset.ts'
import type { WorkspaceLutRepository } from './ports/workspace-lut-repository.ts'

export async function evaluateRenderInputLutRights(
  repository: WorkspaceLutRepository,
  workspaceId: string,
  asset: RenderInputAsset,
): Promise<AssetUseDecision> {
  const identity = parseRenderInputLutIdentity(asset)
  if (!identity) return Object.freeze({ outcome: 'deny', reasonCodes: Object.freeze(['RIGHTS_MISSING'] as const) })
  const version = await repository.readVersion({ workspaceId, lutId: identity.lutId, version: identity.version })
  if (!version || version.id !== asset.artifactId) {
    return Object.freeze({ outcome: 'deny', reasonCodes: Object.freeze(['RIGHTS_MISSING'] as const) })
  }
  if (version.license.policy === 'restricted') {
    return Object.freeze({
      outcome: 'deny',
      reasonCodes: Object.freeze(['RIGHTS_STATUS_RESTRICTED'] as const),
      rightsSnapshotId: version.id,
      rightsSnapshotHash: version.recordHash,
    })
  }
  return Object.freeze({
    outcome: 'allow',
    reasonCodes: Object.freeze([] as const),
    rightsSnapshotId: version.id,
    rightsSnapshotHash: version.recordHash,
  })
}

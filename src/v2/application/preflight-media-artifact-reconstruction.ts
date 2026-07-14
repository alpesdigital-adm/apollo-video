import { DomainError } from '../domain/errors.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProtectedRenderInputStore } from './ports/protected-render-input-store.ts'
import type {
  RenderInputAssetAvailability,
  RenderTargetRegistry,
} from './ports/render-reconstruction-readiness.ts'

export function preflightMediaArtifactReconstructionService(dependencies: {
  repository: MediaArtifactQueryRepository
  protectedRenderInputs: ProtectedRenderInputStore
  assetAvailability: RenderInputAssetAvailability
  targets: RenderTargetRegistry
}) {
  return async function preflightMediaArtifactReconstruction(
    workspaceId: string,
    artifactId: string,
    manifestId: string,
  ) {
    const normalizedArtifactId = artifactId.trim()
    const normalizedManifestId = manifestId.trim()
    if (normalizedArtifactId.length < 3 || normalizedArtifactId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'artifactId must contain 3 to 128 characters')
    }
    if (normalizedManifestId.length < 3 || normalizedManifestId.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'manifestId must contain 3 to 128 characters')
    }

    const artifact = await dependencies.repository.findById(
      workspaceId,
      normalizedArtifactId,
    )
    if (!artifact) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    const manifest = artifact.manifests.find((item) => item.id === normalizedManifestId)
    if (!manifest) {
      throw new DomainError(
        'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
        'Media artifact manifest was not found',
      )
    }

    const base = {
      artifactId: artifact.id,
      manifestId: manifest.id,
      schemaVersion: manifest.schemaVersion,
      manifestHash: manifest.manifestHash,
      validationScope: 'protected-input-and-asset-identity' as const,
      rightsValidationRequired: true,
      materializationRequired: true,
    }
    if (!manifest.renderInput) {
      return {
        ...base,
        payloadAuthenticated: false,
        eligible: false,
        assets: { total: 0, available: 0 },
        issues: [
          {
            code: 'RENDER_INPUT_MISSING' as const,
            message: 'Manifest predates protected RenderInput',
          },
        ],
      }
    }

    const input = await dependencies.protectedRenderInputs.read(
      workspaceId,
      manifest.renderInput.ref,
      manifest.renderInput.inputHash,
    )
    if (!input) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Protected RenderInput linked by the manifest was not found',
      )
    }

    const issues: Array<{
      code: string
      message: string
      assetOrdinal?: number
      assetKind?: string
    }> = []
    const rendererSupported = dependencies.targets.supportsRenderer(input.renderer)
    if (!rendererSupported) {
      issues.push({
        code: 'RENDERER_UNAVAILABLE',
        message: 'The exact renderer identity is not available',
      })
    }
    const compositionSupported = dependencies.targets.supportsComposition(input.composition)
    if (!compositionSupported) {
      issues.push({
        code: 'COMPOSITION_UNAVAILABLE',
        message: 'The exact composition contract is not available',
      })
    }

    let availableAssets = 0
    for (const asset of input.assets) {
      const availability = await dependencies.assetAvailability.inspect(workspaceId, asset)
      if (availability.available) {
        availableAssets += 1
      } else {
        issues.push({
          code: availability.code ?? 'ASSET_UNAVAILABLE',
          message: 'A required render asset is not available with its immutable identity',
          assetOrdinal: asset.ordinal,
          assetKind: asset.kind,
        })
      }
    }

    return {
      ...base,
      payloadAuthenticated: true,
      eligible: issues.length === 0,
      inputHash: input.inputHash,
      renderer: { ...input.renderer, supported: rendererSupported },
      composition: {
        id: input.composition.id,
        version: input.composition.version,
        propsSchemaRef: input.composition.propsSchemaRef,
        supported: compositionSupported,
      },
      assets: { total: input.assets.length, available: availableAssets },
      issues,
    }
  }
}

import {
  evaluateAssetUse,
  normalizeAssetUseContext,
} from '../domain/asset-rights.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import {
  createMaterializationAuthorization,
  type MaterializationAuthorizationIssue,
} from '../domain/materialization-authorization.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MaterializationAuthorizationRepository } from './ports/materialization-authorization-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProtectedRenderInputStore } from './ports/protected-render-input-store.ts'
import type {
  RenderInputAssetAvailability,
  RenderTargetRegistry,
} from './ports/render-reconstruction-readiness.ts'
import { calculateVersionHash } from './version-hash.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    normalized.length >= 3 && normalized.length <= 128,
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 characters`,
  )
  return normalized
}

export function authorizeRenderInputMaterializationService(dependencies: {
  artifactRepository: MediaArtifactQueryRepository
  protectedRenderInputs: ProtectedRenderInputStore
  assetAvailability: RenderInputAssetAvailability
  targets: RenderTargetRegistry
  rights: AssetRightsRepository
  authorizations: MaterializationAuthorizationRepository
  clock: () => Date
  createId: () => string
}) {
  return async function authorizeRenderInputMaterialization(request: {
    workspaceId: string
    artifactId: string
    manifestId: string
    use: string
    market?: string
    syntheticOperations?: readonly string[]
    actor: { type: 'api-client'; id: string }
    idempotencyKey: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const artifactId = validateId(request.artifactId, 'artifactId')
    const manifestId = validateId(request.manifestId, 'manifestId')
    const clientId = validateId(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(
      idempotencyKey.length > 0 && idempotencyKey.length <= 128,
      'INVALID_ARGUMENT',
      'Idempotency-Key must contain 1 to 128 characters',
    )
    const requestContext = normalizeAssetUseContext({
      workspaceId,
      use: request.use,
      locale: 'und',
      ...(request.market ? { market: request.market } : {}),
      ...(request.syntheticOperations
        ? { syntheticOperations: request.syntheticOperations }
        : {}),
    })
    const requestFingerprint = calculateVersionHash({
      artifactId,
      manifestId,
      use: requestContext.use,
      market: requestContext.market,
      syntheticOperations: requestContext.syntheticOperations ?? [],
    })
    const replay = await dependencies.authorizations.findReplay({
      workspaceId,
      clientId,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return replay

    const artifact = await dependencies.artifactRepository.findById(workspaceId, artifactId)
    if (!artifact) {
      throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    }
    const manifest = artifact.manifests.find((item) => item.id === manifestId)
    if (!manifest) {
      throw new DomainError(
        'MEDIA_ARTIFACT_MANIFEST_NOT_FOUND',
        'Media artifact manifest was not found',
      )
    }
    if (!manifest.renderInput) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Manifest does not contain a protected RenderInput',
      )
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

    const context = normalizeAssetUseContext({
      ...requestContext,
      locale: input.output.locale,
    })
    const now = dependencies.clock()
    assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const issues: MaterializationAuthorizationIssue[] = []
    if (!dependencies.targets.supportsRenderer(input.renderer)) {
      issues.push({ code: 'RENDERER_UNAVAILABLE' })
    }
    if (!dependencies.targets.supportsComposition(input.composition)) {
      issues.push({ code: 'COMPOSITION_UNAVAILABLE' })
    }

    const rightsByArtifact = await dependencies.rights.findCurrentForArtifacts(
      workspaceId,
      input.assets.map((asset) => asset.artifactId),
    )
    const decisions = []
    for (const asset of input.assets) {
      const availability = await dependencies.assetAvailability.inspect(workspaceId, asset)
      if (!availability.available) {
        issues.push({
          code: availability.code ?? 'ASSET_UNAVAILABLE',
          assetOrdinal: asset.ordinal,
          assetKind: asset.kind,
        })
      }
      const evaluated = evaluateAssetUse(
        rightsByArtifact.get(asset.artifactId) ?? null,
        context,
        now,
      )
      decisions.push({
        artifactId: asset.artifactId,
        assetOrdinal: asset.ordinal,
        assetKind: asset.kind,
        ...evaluated,
      })
      if (evaluated.outcome === 'deny') {
        issues.push({
          code: 'ASSET_RIGHTS_DENIED',
          assetOrdinal: asset.ordinal,
          assetKind: asset.kind,
        })
      }
    }

    const authorization = createMaterializationAuthorization({
      id: dependencies.createId(),
      workspaceId,
      artifactId,
      manifestId,
      inputHash: input.inputHash,
      use: context.use,
      ...(context.market ? { market: context.market } : {}),
      locale: context.locale,
      syntheticOperations: context.syntheticOperations ?? [],
      issues,
      decisions,
      evaluatedAt: now.toISOString(),
      actor: { type: 'api-client', id: clientId },
    })
    return dependencies.authorizations.createOrReplay({
      authorization,
      clientId,
      idempotencyKey,
      requestFingerprint,
    })
  }
}

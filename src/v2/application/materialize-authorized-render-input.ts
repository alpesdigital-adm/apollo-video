import {
  evaluateAssetUse,
  normalizeAssetUseContext,
} from '../domain/asset-rights.ts'
import { DomainError, assertDomain } from '../domain/errors.ts'
import type { MaterializationAuthorization } from '../domain/materialization-authorization.ts'
import type {
  MaterializedRenderInputV1,
} from '../domain/render-input.ts'
import { materializeRenderInputService } from './materialize-render-input.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { MaterializationAuthorizationRepository } from './ports/materialization-authorization-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { ProtectedRenderInputStore } from './ports/protected-render-input-store.ts'
import type { RenderInputAssetResolver } from './ports/render-input-asset-resolver.ts'
import type {
  RenderInputAssetAvailability,
  RenderTargetRegistry,
} from './ports/render-reconstruction-readiness.ts'
import { calculateVersionHash } from './version-hash.ts'

export interface MaterializedRenderInputReceipt {
  schemaVersion: 'materialized-render-input-receipt/v1'
  authorizationId: string
  artifactId: string
  manifestId: string
  inputHash: string
  revalidationHash: string
  assetCount: number
  revalidatedAt: string
  validUntil: string
}

/**
 * Internal worker lease. JSON serialization intentionally exposes only the
 * safe receipt; storage locations and protected render props remain captured
 * by getRenderInput() for the renderer adapter.
 */
export interface AuthorizedMaterializedRenderInput {
  readonly receipt: Readonly<MaterializedRenderInputReceipt>
  getRenderInput(): MaterializedRenderInputV1
  toJSON(): Readonly<MaterializedRenderInputReceipt>
}

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(
    normalized.length >= 3 && normalized.length <= 128,
    'INVALID_ARGUMENT',
    `${field} must contain 3 to 128 characters`,
  )
  return normalized
}

function revalidationFailure(
  reasonCode: string,
  asset?: { ordinal: number; kind: string },
): never {
  throw new DomainError(
    'MATERIALIZATION_REVALIDATION_FAILED',
    'Materialization authorization no longer matches current render requirements',
    {
      reasonCode,
      ...(asset ? { assetOrdinal: asset.ordinal, assetKind: asset.kind } : {}),
    },
  )
}

function assertAuthorizationActive(
  authorization: MaterializationAuthorization,
  now: Date,
): asserts authorization is MaterializationAuthorization & { validUntil: string } {
  if (authorization.status !== 'authorized' || !authorization.validUntil) {
    throw new DomainError(
      'MATERIALIZATION_AUTHORIZATION_REJECTED',
      'Materialization authorization is not authorized',
    )
  }
  if (new Date(authorization.validUntil).getTime() <= now.getTime()) {
    throw new DomainError(
      'MATERIALIZATION_AUTHORIZATION_EXPIRED',
      'Materialization authorization has expired',
    )
  }
}

function createLease(
  receipt: MaterializedRenderInputReceipt,
  renderInput: MaterializedRenderInputV1,
): AuthorizedMaterializedRenderInput {
  const safeReceipt = Object.freeze({ ...receipt })
  return Object.freeze({
    receipt: safeReceipt,
    getRenderInput() {
      return renderInput
    },
    toJSON() {
      return safeReceipt
    },
  })
}

export function materializeAuthorizedRenderInputService(dependencies: {
  artifacts: MediaArtifactQueryRepository
  protectedRenderInputs: ProtectedRenderInputStore
  assetAvailability: RenderInputAssetAvailability
  targets: RenderTargetRegistry
  rights: AssetRightsRepository
  authorizations: MaterializationAuthorizationRepository
  resolverForWorkspace: (workspaceId: string) => RenderInputAssetResolver
  clock: () => Date
}) {
  return async function materializeAuthorizedRenderInput(request: {
    workspaceId: string
    authorizationId: string
  }): Promise<AuthorizedMaterializedRenderInput> {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const authorizationId = validateId(request.authorizationId, 'authorizationId')
    const authorization = await dependencies.authorizations.findById(
      workspaceId,
      authorizationId,
    )
    if (!authorization) {
      throw new DomainError(
        'MATERIALIZATION_AUTHORIZATION_NOT_FOUND',
        'Materialization authorization was not found',
      )
    }

    const revalidatedAt = dependencies.clock()
    assertDomain(
      !Number.isNaN(revalidatedAt.getTime()),
      'INVALID_ARGUMENT',
      'clock returned an invalid date',
    )
    assertAuthorizationActive(authorization, revalidatedAt)

    const targetArtifact = await dependencies.artifacts.findById(
      workspaceId,
      authorization.artifactId,
    )
    if (!targetArtifact) revalidationFailure('TARGET_ARTIFACT_MISSING')
    const manifest = targetArtifact.manifests.find(
      (candidate) => candidate.id === authorization.manifestId,
    )
    if (!manifest?.renderInput) revalidationFailure('TARGET_MANIFEST_CHANGED')
    const input = await dependencies.protectedRenderInputs.read(
      workspaceId,
      manifest.renderInput.ref,
      manifest.renderInput.inputHash,
    )
    if (!input || input.inputHash !== authorization.inputHash) {
      revalidationFailure('RENDER_INPUT_CHANGED')
    }
    if (!dependencies.targets.supportsRenderer(input.renderer)) {
      revalidationFailure('RENDERER_UNAVAILABLE')
    }
    if (!dependencies.targets.supportsComposition(input.composition)) {
      revalidationFailure('COMPOSITION_UNAVAILABLE')
    }
    if (
      input.output.locale !== authorization.locale ||
      authorization.decisions.length !== input.assets.length
    ) {
      revalidationFailure('AUTHORIZATION_CONTEXT_CHANGED')
    }

    const useContext = normalizeAssetUseContext({
      workspaceId,
      use: authorization.use,
      ...(authorization.market ? { market: authorization.market } : {}),
      locale: authorization.locale,
      syntheticOperations: authorization.syntheticOperations,
    })
    const currentRights = await dependencies.rights.findCurrentForArtifacts(
      workspaceId,
      input.assets.map((asset) => asset.artifactId),
    )
    const snapshotIdentities: Array<{ ordinal: number; id: string; hash: string }> = []
    for (const asset of input.assets) {
      const availability = await dependencies.assetAvailability.inspect(workspaceId, asset)
      if (!availability.available) {
        revalidationFailure(availability.code ?? 'ASSET_UNAVAILABLE', asset)
      }
      const authorizedDecision = authorization.decisions[asset.ordinal]
      if (
        !authorizedDecision ||
        authorizedDecision.outcome !== 'allow' ||
        authorizedDecision.artifactId !== asset.artifactId ||
        authorizedDecision.assetOrdinal !== asset.ordinal ||
        authorizedDecision.assetKind !== asset.kind
      ) {
        revalidationFailure('ASSET_AUTHORIZATION_MISMATCH', asset)
      }
      const snapshot = currentRights.get(asset.artifactId) ?? null
      const currentDecision = evaluateAssetUse(snapshot, useContext, revalidatedAt)
      if (currentDecision.outcome !== 'allow') {
        revalidationFailure('ASSET_RIGHTS_DENIED', asset)
      }
      if (
        !snapshot ||
        authorizedDecision.rightsSnapshotId !== snapshot.id ||
        authorizedDecision.rightsSnapshotHash !== snapshot.snapshotHash
      ) {
        revalidationFailure('ASSET_RIGHTS_SNAPSHOT_CHANGED', asset)
      }
      snapshotIdentities.push({
        ordinal: asset.ordinal,
        id: snapshot.id,
        hash: snapshot.snapshotHash,
      })
    }

    const renderInput = await materializeRenderInputService({
      resolver: dependencies.resolverForWorkspace(workspaceId),
    })(input)
    const completedAt = dependencies.clock()
    assertDomain(
      !Number.isNaN(completedAt.getTime()),
      'INVALID_ARGUMENT',
      'clock returned an invalid date',
    )
    assertAuthorizationActive(authorization, completedAt)

    return createLease(
      {
        schemaVersion: 'materialized-render-input-receipt/v1',
        authorizationId: authorization.id,
        artifactId: authorization.artifactId,
        manifestId: authorization.manifestId,
        inputHash: input.inputHash,
        revalidationHash: calculateVersionHash({
          authorizationId: authorization.id,
          inputHash: input.inputHash,
          use: useContext,
          rights: snapshotIdentities,
        }),
        assetCount: input.assets.length,
        revalidatedAt: revalidatedAt.toISOString(),
        validUntil: authorization.validUntil,
      },
      renderInput,
    )
  }
}

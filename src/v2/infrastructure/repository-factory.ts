import type { PrismaClient as SqlitePrismaClient } from '@prisma/client'

import { materializeAuthorizedRenderInputService } from '../application/materialize-authorized-render-input.ts'
import { renderAuthorizedInputService } from '../application/render-authorized-input.ts'
import { calculateVersionHash } from '../application/version-hash.ts'
import type { ApiClientRepository } from '../application/ports/api-client-repository.ts'
import type { ApiClientAdministrationRepository } from '../application/ports/api-client-administration-repository.ts'
import type { AssetRightsRepository } from '../application/ports/asset-rights-repository.ts'
import type { MaterializationAuthorizationRepository } from '../application/ports/materialization-authorization-repository.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { ProtectedRenderInputStore } from '../application/ports/protected-render-input-store.ts'
import type { RenderInputAssetResolver } from '../application/ports/render-input-asset-resolver.ts'
import type { RenderInputAssetAvailability } from '../application/ports/render-reconstruction-readiness.ts'
import type { ProjectCreationRepository } from '../application/ports/project-creation-repository.ts'
import type { ProjectQueryRepository } from '../application/ports/project-query-repository.ts'
import type { PublicOperationRepository } from '../application/ports/public-operation-repository.ts'
import type { WorkspaceRepository } from '../application/ports/workspace-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { prisma } from '../../lib/db.ts'
import { resolveV2PersistenceMode } from './persistence-mode.ts'
import { PrismaApiClientRepository } from './prisma/api-client-repository.ts'
import { PrismaAssetRightsRepository } from './prisma/asset-rights-repository.ts'
import { PrismaMaterializationAuthorizationRepository } from './prisma/materialization-authorization-repository.ts'
import { PrismaMediaArtifactRepository } from './prisma/media-artifact-repository.ts'
import { PrismaProtectedRenderInputStore } from './prisma/protected-render-input-store.ts'
import { PrismaRenderInputAssetAvailability } from './prisma/render-input-asset-availability.ts'
import { PrismaProjectCreationRepository } from './prisma/project-creation-repository.ts'
import { PrismaProjectQueryRepository } from './prisma/project-query-repository.ts'
import { PrismaPublicOperationRepository } from './prisma/public-operation-repository.ts'
import { PrismaWorkspaceRepository } from './prisma/workspace-repository.ts'
import { getV2PostgresClient } from './prisma-postgres/client.ts'
import { LocalArtifactRenderInputResolver } from './local-artifact-render-input-resolver.ts'
import { RemotionRenderInputRenderer } from './remotion-render-input-renderer.ts'
import { createConfiguredRenderTargetRegistry } from './render-target-registry.ts'
import { createProtectedPayloadCipherFromEnvironment } from './security/recipe-parameter-cipher.ts'

// The two generated clients expose the same v2 model delegates. This cast is
// kept at the persistence boundary so application and public API code remain
// provider-agnostic while the SQLite prototype still exists.
function resolveV2Client(): SqlitePrismaClient {
  if (resolveV2PersistenceMode() === 'postgres') {
    return getV2PostgresClient() as unknown as SqlitePrismaClient
  }

  return prisma
}

export function createApiClientRepository(): ApiClientRepository {
  return new PrismaApiClientRepository(resolveV2Client())
}

export function createApiClientAdministrationRepository(): ApiClientAdministrationRepository {
  return new PrismaApiClientRepository(resolveV2Client())
}

export function createAssetRightsRepository(): AssetRightsRepository {
  return new PrismaAssetRightsRepository(resolveV2Client())
}

export function createMaterializationAuthorizationRepository(): MaterializationAuthorizationRepository {
  return new PrismaMaterializationAuthorizationRepository(resolveV2Client())
}

export function createMediaArtifactQueryRepository(): MediaArtifactQueryRepository {
  return new PrismaMediaArtifactRepository(resolveV2Client())
}

export function createPublicOperationRepository(): PublicOperationRepository {
  return new PrismaPublicOperationRepository(resolveV2Client())
}

export function createProtectedRenderInputStore(): ProtectedRenderInputStore {
  return new PrismaProtectedRenderInputStore(
    resolveV2Client(),
    createProtectedPayloadCipherFromEnvironment(),
  )
}

export function createRenderInputAssetAvailability(): RenderInputAssetAvailability {
  return new PrismaRenderInputAssetAvailability(resolveV2Client())
}

export function createRenderInputAssetResolver(
  workspaceId: string,
  environment: NodeJS.ProcessEnv = process.env,
): RenderInputAssetResolver {
  const root = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!root) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Local artifact storage is not configured for the render worker',
    )
  }
  return new LocalArtifactRenderInputResolver(resolveV2Client(), {
    root,
    workspaceId,
  })
}

export function createAuthorizedRenderInputMaterializer(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  return materializeAuthorizedRenderInputService({
    artifacts: createMediaArtifactQueryRepository(),
    protectedRenderInputs: createProtectedRenderInputStore(),
    assetAvailability: createRenderInputAssetAvailability(),
    targets: createConfiguredRenderTargetRegistry(environment),
    rights: createAssetRightsRepository(),
    authorizations: createMaterializationAuthorizationRepository(),
    resolverForWorkspace: (workspaceId) =>
      createRenderInputAssetResolver(workspaceId, environment),
    clock,
  })
}

export function createAuthorizedRenderExecutor(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const outputRoot = environment.APOLLO_V2_RENDER_OUTPUT_ROOT?.trim()
  if (!outputRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Render output storage is not configured for the render worker',
    )
  }
  const configuredTimeout = Number(environment.APOLLO_V2_RENDER_TIMEOUT_MS)
  const renderer = new RemotionRenderInputRenderer({
    projectRoot: process.cwd(),
    outputRoot,
    ...(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? { timeoutMs: configuredTimeout }
      : {}),
    clock,
  })
  return renderAuthorizedInputService({
    materialize: createAuthorizedRenderInputMaterializer(environment, clock),
    renderer,
    outputKeyFor: ({ workspaceId, authorizationId, inputHash }) => {
      const workspaceNamespace = calculateVersionHash({ workspaceId }).slice(0, 32)
      const outputIdentity = calculateVersionHash({ authorizationId, inputHash })
      return `workspaces/${workspaceNamespace}/renders/${outputIdentity}.mp4`
    },
  })
}

export function createProjectCreationRepository(): ProjectCreationRepository {
  return new PrismaProjectCreationRepository(resolveV2Client())
}

export function createProjectQueryRepository(): ProjectQueryRepository {
  return new PrismaProjectQueryRepository(resolveV2Client())
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return new PrismaWorkspaceRepository(resolveV2Client())
}

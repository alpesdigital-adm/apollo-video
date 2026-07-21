import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '../../../generated/prisma-v2/index.js'

import { activateWebhookEndpointConvergentlyService } from '../application/secure-webhook.ts'
import { materializeNextWebhookEventService } from '../application/materialize-webhook-deliveries.ts'
import {
  claimNextWebhookDeliveryService,
  heartbeatWebhookDeliveryService,
  settleWebhookDeliveryService,
} from '../application/manage-webhook-delivery.ts'
import { dispatchWebhookDeliveryService } from '../application/dispatch-webhook-delivery.ts'
import { runNextWebhookDeliveryService } from '../application/run-webhook-delivery-worker.ts'
import { discoverRunnableWebhookWorkspacesService } from '../application/discover-webhook-workspaces.ts'
import { replayWebhookDeliveryService } from '../application/replay-webhook-delivery.ts'
import { replayWebhookEventService } from '../application/replay-webhook-event.ts'
import { coordinateWebhookWorkerShardService } from '../application/coordinate-webhook-worker-shard.ts'
import { materializeAuthorizedRenderInputService } from '../application/materialize-authorized-render-input.ts'
import { renderAuthorizedInputService } from '../application/render-authorized-input.ts'
import { runNextPublicOperationService } from '../application/run-public-operation-worker.ts'
import { runNextMediaIngestOperationService } from '../application/run-media-ingest-worker.ts'
import { runNextProjectProxyRenderOperationService } from '../application/run-project-proxy-render-worker.ts'
import { runNextProjectFinalExportOperationService } from '../application/run-project-final-export-worker.ts'
import { calculateVersionHash } from '../application/version-hash.ts'
import type { ApiClientRepository } from '../application/ports/api-client-repository.ts'
import type { ApiClientAdministrationRepository } from '../application/ports/api-client-administration-repository.ts'
import type { AssetRightsRepository } from '../application/ports/asset-rights-repository.ts'
import type { MaterializationAuthorizationRepository } from '../application/ports/materialization-authorization-repository.ts'
import type { MediaTransferRepository } from '../application/ports/media-transfer-repository.ts'
import type { MediaDownloadGrantRepository } from '../application/ports/media-download-grant-repository.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { MediaArtifactPersistenceRepository } from '../application/ports/media-artifact-repository.ts'
import type { ProjectMediaRepository } from '../application/ports/media-ingest.ts'
import type { ProtectedRenderInputStore } from '../application/ports/protected-render-input-store.ts'
import type { RenderInputAssetResolver } from '../application/ports/render-input-asset-resolver.ts'
import type { RenderInputAssetAvailability } from '../application/ports/render-reconstruction-readiness.ts'
import type { ProjectCreationRepository } from '../application/ports/project-creation-repository.ts'
import type { ProjectQueryRepository } from '../application/ports/project-query-repository.ts'
import type { ProjectWorkspaceQueryRepository } from '../application/ports/project-workspace-query-repository.ts'
import type { ReviewAnnotationRepository } from '../application/ports/review-annotation-repository.ts'
import type { RenderElementMapRepository } from '../application/ports/render-element-map-repository.ts'
import type { EditorialCommandRepository } from '../application/ports/editorial-command-repository.ts'
import type { DirectorRunRepository } from '../application/ports/director-run-repository.ts'
import type { ProjectProxyRenderRepository } from '../application/ports/project-proxy-render-repository.ts'
import type { ProjectFinalExportRepository } from '../application/ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from '../application/ports/public-operation-repository.ts'
import type { WorkspaceRepository } from '../application/ports/workspace-repository.ts'
import type { WebhookRegistrationRepository } from '../application/ports/webhook-registration-repository.ts'
import type { WebhookFanoutRepository } from '../application/ports/webhook-fanout-repository.ts'
import type { WebhookDeliveryRepository } from '../application/ports/webhook-delivery-repository.ts'
import type {
  WebhookDeliveryDispatchTargetRepository,
  WebhookSigningSecretProvider,
} from '../application/ports/webhook-delivery-dispatch.ts'
import type {
  WebhookWorkspaceDiscoveryRepository,
} from '../application/ports/webhook-workspace-discovery-repository.ts'
import type {
  WebhookDeliveryQueryRepository,
} from '../application/ports/webhook-delivery-query-repository.ts'
import type {
  WebhookDeliveryReplayRepository,
} from '../application/ports/webhook-delivery-replay-repository.ts'
import type {
  WebhookEventReplayRepository,
} from '../application/ports/webhook-event-replay-repository.ts'
import type { WebhookWorkerShardRepository } from '../application/ports/webhook-worker-shard-repository.ts'
import type { WebhookAdministrationQueryRepository } from '../application/ports/webhook-administration-query-repository.ts'
import type { WebhookSubscriptionCommandRepository } from '../application/ports/webhook-subscription-command-repository.ts'
import type { WebhookSubscriptionCreationRepository } from '../application/ports/webhook-subscription-creation-repository.ts'
import type { WebhookEndpointCommandRepository } from '../application/ports/webhook-endpoint-command-repository.ts'
import type { WebhookEndpointCreationRepository } from '../application/ports/webhook-endpoint-creation-repository.ts'
import type { WebhookSigningSecretProvisioningRepository } from '../application/ports/webhook-signing-secret-provisioning-repository.ts'
import type { WebhookSigningSecretRotationRepository } from '../application/ports/webhook-signing-secret-rotation-repository.ts'
import type { WebhookSigningSecretHygieneRepository } from '../application/ports/webhook-signing-secret-hygiene-repository.ts'
import type {
  WebhookChallengeRepository,
  WebhookChallengeTargetRepository,
  WebhookEndpointActivationLeaseRepository,
  WebhookEndpointActivationStateRepository,
  WebhookReplayReceiptRepository,
} from '../application/ports/webhook-security-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { PrismaApiClientRepository } from './prisma/api-client-repository.ts'
import { PrismaArtifactRenderCheckpointRepository } from './prisma/artifact-render-checkpoint-repository.ts'
import { PrismaAssetRightsRepository } from './prisma/asset-rights-repository.ts'
import { PrismaMaterializationAuthorizationRepository } from './prisma/materialization-authorization-repository.ts'
import { PrismaMediaTransferRepository } from './prisma/media-transfer-repository.ts'
import { PrismaMediaDownloadGrantRepository } from './prisma/media-download-grant-repository.ts'
import { PrismaMediaArtifactRepository } from './prisma/media-artifact-repository.ts'
import { PrismaProtectedRenderInputStore } from './prisma/protected-render-input-store.ts'
import { PrismaRenderInputAssetAvailability } from './prisma/render-input-asset-availability.ts'
import { PrismaProjectCreationRepository } from './prisma/project-creation-repository.ts'
import { PrismaProjectQueryRepository } from './prisma/project-query-repository.ts'
import { PrismaProjectWorkspaceQueryRepository } from './prisma/project-workspace-query-repository.ts'
import { PrismaReviewAnnotationRepository } from './prisma/review-annotation-repository.ts'
import { PrismaRenderElementMapRepository } from './prisma/render-element-map-repository.ts'
import { PrismaProjectMediaRepository } from './prisma/project-media-repository.ts'
import { PrismaEditorialCommandRepository } from './prisma/editorial-command-repository.ts'
import { PrismaDirectorRunRepository } from './prisma/director-run-repository.ts'
import { PrismaProjectProxyRenderRepository } from './prisma/project-proxy-render-repository.ts'
import { PrismaProjectFinalExportRepository } from './prisma/project-final-export-repository.ts'
import { PrismaPublicOperationRepository } from './prisma/public-operation-repository.ts'
import { PrismaWorkspaceRepository } from './prisma/workspace-repository.ts'
import { PrismaWebhookRegistrationRepository } from './prisma/webhook-registration-repository.ts'
import { PrismaWebhookFanoutRepository } from './prisma/webhook-fanout-repository.ts'
import { PrismaWebhookDeliveryRepository } from './prisma/webhook-delivery-repository.ts'
import { PrismaWebhookEventReplayRepository } from './prisma/webhook-event-replay-repository.ts'
import { PrismaWebhookWorkerShardRepository } from './prisma/webhook-worker-shard-repository.ts'
import { PrismaWebhookAdministrationQueryRepository } from './prisma/webhook-administration-query-repository.ts'
import { PrismaWebhookSubscriptionCommandRepository } from './prisma/webhook-subscription-command-repository.ts'
import { PrismaWebhookSubscriptionCreationRepository } from './prisma/webhook-subscription-creation-repository.ts'
import { PrismaWebhookEndpointCommandRepository } from './prisma/webhook-endpoint-command-repository.ts'
import { PrismaWebhookEndpointCreationRepository } from './prisma/webhook-endpoint-creation-repository.ts'
import { PrismaWebhookSigningSecretProvisioningRepository } from './prisma/webhook-signing-secret-provisioning-repository.ts'
import { PrismaWebhookSigningSecretRotationRepository } from './prisma/webhook-signing-secret-rotation-repository.ts'
import { PrismaWebhookSigningSecretHygieneRepository } from './prisma/webhook-signing-secret-hygiene-repository.ts'
import { PrismaWebhookSigningSecretProvider } from './prisma/webhook-signing-secret-provider.ts'
import { PrismaWebhookSecurityRepository } from './prisma/webhook-security-repository.ts'
import { SafeWebhookChallengeTransport } from './webhook/safe-webhook-challenge-transport.ts'
import { SafeWebhookDeliveryTransport } from './webhook/safe-webhook-delivery-transport.ts'
import { getV2PostgresClient } from './prisma-postgres/client.ts'
import { LocalArtifactRenderInputResolver } from './local-artifact-render-input-resolver.ts'
import { RemotionRenderInputRenderer } from './remotion-render-input-renderer.ts'
import { createLocalMediaUploadStorageFromEnvironment } from './media/local-media-upload-storage.ts'
import { createLocalArtifactContentStorageFromEnvironment } from './media/local-artifact-content-storage.ts'
import { createFfmpegIngestProcessorFromEnvironment } from './media/ffmpeg-ingest-processor.ts'
import { createFfmpegEditorialProxyRendererFromEnvironment } from './media/ffmpeg-editorial-proxy-renderer.ts'
import { createMediaTranscriberFromEnvironment } from './media/groq-media-transcriber.ts'
import { createConfiguredRenderTargetRegistry } from './render-target-registry.ts'
import { createProtectedPayloadCipherFromEnvironment } from './security/recipe-parameter-cipher.ts'
import { createWebhookSigningSecretProtector } from './security/webhook-signing-secret-protector.ts'
export { createMediaUploadSessionSignerFromEnvironment } from './security/media-upload-session-signer.ts'
export { createMediaUploadVerifierFromEnvironment } from './media-upload-verifier.ts'
export { createMediaDownloadGrantSignerFromEnvironment } from './security/media-download-grant-signer.ts'

function resolveV2Client(): PrismaClient {
  return getV2PostgresClient()
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

export function createMediaArtifactPersistenceRepository(
  environment: NodeJS.ProcessEnv = process.env,
): MediaArtifactPersistenceRepository {
  return new PrismaMediaArtifactRepository(
    resolveV2Client(),
    createProtectedPayloadCipherFromEnvironment(environment),
  )
}

export function createArtifactContentStorage(environment: NodeJS.ProcessEnv = process.env) {
  return createLocalArtifactContentStorageFromEnvironment(environment)
}

export function createProjectMediaRepository(): ProjectMediaRepository {
  return new PrismaProjectMediaRepository(resolveV2Client())
}

export function createProjectProxyRenderRepository(): ProjectProxyRenderRepository {
  return new PrismaProjectProxyRenderRepository(resolveV2Client())
}

export function createProjectFinalExportRepository(): ProjectFinalExportRepository {
  return new PrismaProjectFinalExportRepository(resolveV2Client())
}

export function createMediaTransferRepository(): MediaTransferRepository {
  return new PrismaMediaTransferRepository(resolveV2Client())
}

export function createMediaDownloadGrantRepository(): MediaDownloadGrantRepository {
  return new PrismaMediaDownloadGrantRepository(resolveV2Client())
}

export function createPublicOperationRepository(): PublicOperationRepository {
  return new PrismaPublicOperationRepository(resolveV2Client())
}

export function createWebhookRegistrationRepository(): WebhookRegistrationRepository {
  return new PrismaWebhookRegistrationRepository(resolveV2Client())
}

export function createWebhookAdministrationQueryRepository(): WebhookAdministrationQueryRepository {
  return new PrismaWebhookAdministrationQueryRepository(resolveV2Client())
}

export function createWebhookSubscriptionCommandRepository(): WebhookSubscriptionCommandRepository {
  return new PrismaWebhookSubscriptionCommandRepository(resolveV2Client())
}

export function createWebhookSubscriptionCreationRepository(): WebhookSubscriptionCreationRepository {
  return new PrismaWebhookSubscriptionCreationRepository(resolveV2Client())
}

export function createWebhookEndpointCommandRepository(): WebhookEndpointCommandRepository {
  return new PrismaWebhookEndpointCommandRepository(resolveV2Client())
}

export function createWebhookEndpointCreationRepository(): WebhookEndpointCreationRepository {
  return new PrismaWebhookEndpointCreationRepository(resolveV2Client())
}

export function createWebhookSigningSecretProvisioningRepository(): WebhookSigningSecretProvisioningRepository {
  return new PrismaWebhookSigningSecretProvisioningRepository(resolveV2Client())
}

export function createWebhookSigningSecretRotationRepository(): WebhookSigningSecretRotationRepository {
  return new PrismaWebhookSigningSecretRotationRepository(resolveV2Client())
}

export function createWebhookSigningSecretHygieneRepository(): WebhookSigningSecretHygieneRepository {
  return new PrismaWebhookSigningSecretHygieneRepository(resolveV2Client())
}

export function createConfiguredWebhookSigningSecretProtector() {
  return createWebhookSigningSecretProtector(createProtectedPayloadCipherFromEnvironment())
}

export function createWebhookFanoutRepository(): WebhookFanoutRepository {
  return new PrismaWebhookFanoutRepository(resolveV2Client())
}

export function createWebhookDeliveryRepository(): WebhookDeliveryRepository &
  WebhookDeliveryDispatchTargetRepository &
  WebhookWorkspaceDiscoveryRepository &
  WebhookDeliveryQueryRepository &
  WebhookDeliveryReplayRepository {
  return new PrismaWebhookDeliveryRepository(resolveV2Client())
}

export function createWebhookDeliveryQueryRepository(): WebhookDeliveryQueryRepository {
  return new PrismaWebhookDeliveryRepository(resolveV2Client())
}

export function createWebhookDeliveryReplayRepository(): WebhookDeliveryReplayRepository {
  return new PrismaWebhookDeliveryRepository(resolveV2Client())
}

export function createWebhookDeliveryReplay(
  clock: () => Date = () => new Date(),
) {
  return replayWebhookDeliveryService({
    deliveries: createWebhookDeliveryReplayRepository(),
    clock,
  })
}

export function createWebhookEventReplayRepository(): WebhookEventReplayRepository {
  return new PrismaWebhookEventReplayRepository(resolveV2Client())
}

export function createWebhookEventReplay(
  clock: () => Date = () => new Date(),
) {
  return replayWebhookEventService({
    replays: createWebhookEventReplayRepository(),
    clock,
  })
}

export function createWebhookWorkspaceDiscovery(
  clock: () => Date = () => new Date(),
) {
  return discoverRunnableWebhookWorkspacesService({
    repository: createWebhookDeliveryRepository(),
    clock,
  })
}

export function createWebhookDeliveryDispatcher(
  secrets: WebhookSigningSecretProvider,
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredTimeout = Number(environment.APOLLO_V2_WEBHOOK_DELIVERY_TIMEOUT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WEBHOOK_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WEBHOOK_RETRY_MAX_MS)
  return dispatchWebhookDeliveryService({
    repository: createWebhookDeliveryRepository(),
    secrets,
    transport: new SafeWebhookDeliveryTransport({
      ...(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
        ? { timeoutMs: configuredTimeout }
        : {}),
    }),
    clock,
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0
      ? { retryBaseDelayMs: configuredRetryBase }
      : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0
      ? { retryMaxDelayMs: configuredRetryMax }
      : {}),
  })
}

export function createConfiguredWebhookSigningSecretProvider(
  environment: NodeJS.ProcessEnv = process.env,
): WebhookSigningSecretProvider {
  return new PrismaWebhookSigningSecretProvider(
    createProtectedPayloadCipherFromEnvironment(environment),
    resolveV2Client(),
  )
}

export function createWebhookWorkerShardRepository(): WebhookWorkerShardRepository {
  return new PrismaWebhookWorkerShardRepository(resolveV2Client())
}

export function createWebhookWorkerShardCoordinator(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_WEBHOOK_SHARD_LEASE_MS)
  return coordinateWebhookWorkerShardService({
    repository: createWebhookWorkerShardRepository(),
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0
      ? { leaseDurationMs: configuredLease }
      : {}),
  })
}

export function createWebhookDeliveryWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_WEBHOOK_DELIVERY_LEASE_MS)
  const leaseDurationMs = Number.isSafeInteger(configuredLease) && configuredLease > 0
    ? configuredLease
    : 30_000
  const repository = createWebhookDeliveryRepository()
  return Object.freeze({
    claim: claimNextWebhookDeliveryService({ repository, clock, leaseDurationMs }),
    heartbeat: heartbeatWebhookDeliveryService({ repository, clock, leaseDurationMs }),
    settle: settleWebhookDeliveryService({ repository, clock }),
  })
}

export function createWebhookDeliveryRunner(
  secrets: WebhookSigningSecretProvider,
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_WEBHOOK_DELIVERY_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_WEBHOOK_HEARTBEAT_MS)
  const configuredTimeout = Number(environment.APOLLO_V2_WEBHOOK_DELIVERY_TIMEOUT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WEBHOOK_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WEBHOOK_RETRY_MAX_MS)
  const leaseDurationMs = Number.isSafeInteger(configuredLease) && configuredLease > 0
    ? configuredLease
    : 30_000
  const heartbeatIntervalMs = Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0
    ? configuredHeartbeat
    : 10_000
  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new DomainError(
      'INVALID_WEBHOOK',
      'Webhook heartbeat interval must be shorter than its lease',
    )
  }
  const repository = createWebhookDeliveryRepository()
  return runNextWebhookDeliveryService({
    claim: claimNextWebhookDeliveryService({ repository, clock, leaseDurationMs }),
    heartbeat: heartbeatWebhookDeliveryService({ repository, clock, leaseDurationMs }),
    dispatch: dispatchWebhookDeliveryService({
      repository,
      secrets,
      transport: new SafeWebhookDeliveryTransport({
        ...(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
          ? { timeoutMs: configuredTimeout }
          : {}),
      }),
      clock,
      ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0
        ? { retryBaseDelayMs: configuredRetryBase }
        : {}),
      ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0
        ? { retryMaxDelayMs: configuredRetryMax }
        : {}),
    }),
    heartbeatIntervalMs,
  })
}

export function createWebhookDeliveryScheduler(
  secrets: WebhookSigningSecretProvider,
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  return Object.freeze({
    discover: createWebhookWorkspaceDiscovery(clock),
    runNext: createWebhookDeliveryRunner(secrets, environment, clock),
  })
}

export function createWebhookFanoutMaterializer(
  clock: () => Date = () => new Date(),
) {
  return materializeNextWebhookEventService({
    repository: createWebhookFanoutRepository(),
    clock,
  })
}

export function createWebhookSecurityRepository(): WebhookChallengeRepository &
  WebhookChallengeTargetRepository &
  WebhookEndpointActivationLeaseRepository &
  WebhookEndpointActivationStateRepository &
  WebhookReplayReceiptRepository {
  return new PrismaWebhookSecurityRepository(resolveV2Client())
}

export function createWebhookEndpointActivator(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredTimeout = Number(environment.APOLLO_V2_WEBHOOK_CHALLENGE_TIMEOUT_MS)
  const effectiveTimeout =
    Number.isSafeInteger(configuredTimeout) && configuredTimeout >= 1_000 && configuredTimeout <= 10_000
      ? configuredTimeout
      : 5_000
  const transport = new SafeWebhookChallengeTransport({
    ...(Number.isSafeInteger(configuredTimeout) && configuredTimeout > 0
      ? { timeoutMs: configuredTimeout }
      : {}),
  })
  return activateWebhookEndpointConvergentlyService({
    repository: createWebhookSecurityRepository(),
    transport,
    clock,
    createId: randomUUID,
    activationLeaseMs: effectiveTimeout + 5_000,
    followerMaxWaitMs: effectiveTimeout + 6_000,
  })
}

export function createArtifactRenderCheckpointRepository() {
  return new PrismaArtifactRenderCheckpointRepository(resolveV2Client())
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

export function createPublicOperationWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextPublicOperationService({
    operations: createPublicOperationRepository(),
    checkpoints: createArtifactRenderCheckpointRepository(),
    render: createAuthorizedRenderExecutor(environment, clock),
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0
      ? { leaseDurationMs: configuredLease }
      : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0
      ? { heartbeatIntervalMs: configuredHeartbeat }
      : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0
      ? { retryBaseDelayMs: configuredRetryBase }
      : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0
      ? { retryMaxDelayMs: configuredRetryMax }
      : {}),
  })
}

export function createMediaIngestWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_INGEST_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_INGEST_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextMediaIngestOperationService({
    operations: createPublicOperationRepository(),
    uploads: createMediaTransferRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    projectMedia: createProjectMediaRepository(),
    storage: createLocalMediaUploadStorageFromEnvironment(environment),
    processor: createFfmpegIngestProcessorFromEnvironment(environment),
    transcriber: createMediaTranscriberFromEnvironment(environment),
    rights: createAssetRightsRepository(),
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createProjectProxyRenderWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  const configuredLease = Number(environment.APOLLO_V2_RENDER_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_RENDER_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextProjectProxyRenderOperationService({
    operations: createPublicOperationRepository(), projects: createProjectProxyRenderRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment), storage: createLocalMediaUploadStorageFromEnvironment(environment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(environment), artifactRoot, clock,
    renderElementMaps: createRenderElementMapRepository(),
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createProjectFinalExportWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  const configuredLease = Number(environment.APOLLO_V2_RENDER_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_RENDER_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextProjectFinalExportOperationService({
    operations: createPublicOperationRepository(),
    projects: createProjectFinalExportRepository(),
    rights: createAssetRightsRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    storage: createLocalMediaUploadStorageFromEnvironment(environment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(environment),
    renderElementMaps: createRenderElementMapRepository(),
    artifactRoot,
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createProjectCreationRepository(): ProjectCreationRepository {
  return new PrismaProjectCreationRepository(resolveV2Client())
}

export function createProjectQueryRepository(): ProjectQueryRepository {
  return new PrismaProjectQueryRepository(resolveV2Client())
}

export function createProjectWorkspaceQueryRepository(): ProjectWorkspaceQueryRepository {
  return new PrismaProjectWorkspaceQueryRepository(resolveV2Client())
}

export function createReviewAnnotationRepository(): ReviewAnnotationRepository {
  return new PrismaReviewAnnotationRepository(resolveV2Client())
}

export function createRenderElementMapRepository(): RenderElementMapRepository {
  return new PrismaRenderElementMapRepository(resolveV2Client())
}

export function createEditorialCommandRepository(): EditorialCommandRepository {
  return new PrismaEditorialCommandRepository(resolveV2Client())
}

export function createDirectorRunRepository(): DirectorRunRepository {
  return new PrismaDirectorRunRepository(resolveV2Client())
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return new PrismaWorkspaceRepository(resolveV2Client())
}

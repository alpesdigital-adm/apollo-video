import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

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
import { runNextSourceCleanupOperationService } from '../application/run-source-cleanup-worker.ts'
import { runNextLongFormIndexOperationService } from '../application/run-long-form-index-worker.ts'
import { runNextProjectDirectorOperationService } from '../application/run-project-director-operation-worker.ts'
import { createEvidenceBoundBriefCompiler } from './brief/evidence-bound-brief-compiler-model.ts'
import { produceContiguousEvidenceService } from '../application/contiguous-evidence.ts'
import {
  produceContiguousEvaluationsService,
} from '../application/contiguous-evaluation.ts'
import {
  createSpeakerDiarizationStageProcessor,
} from '../application/speaker-diarization-stage-processor.ts'
import {
  createLongFormTranscriptStageProcessor,
} from '../application/long-form-transcript-stage-processor.ts'
import {
  createLongFormDerivedStageProcessor,
  createLongFormIndexStageRouter,
  DEFAULT_LONG_FORM_DERIVED_STAGE_CONFIGURATION,
} from '../application/long-form-derived-stage-processor.ts'
import { calculateVersionHash } from '../application/version-hash.ts'
import type { ApiClientRepository } from '../application/ports/api-client-repository.ts'
import type { ApiClientAdministrationRepository } from '../application/ports/api-client-administration-repository.ts'
import type { GovernanceAdmissionRepository } from '../application/ports/governance-admission-repository.ts'
import type { SandboxProviderExecutionRepository } from '../application/ports/sandbox-provider-execution-repository.ts'
import type { GovernancePolicyRepository } from '../application/ports/governance-policy-repository.ts'
import type { ApiAccessControlRepository } from '../application/ports/api-access-control-repository.ts'
import type { AssetRightsRepository } from '../application/ports/asset-rights-repository.ts'
import type { AssetSelectionRepository } from '../application/ports/asset-selection-repository.ts'
import type { QualityIterationRepository } from '../application/ports/quality-iteration-repository.ts'
import type { MvpCoreGateRepository } from '../application/ports/mvp-core-gate-repository.ts'
import type { SpeechSegmentCatalogRepository } from '../application/ports/speech-segment-catalog-repository.ts'
import type { EvidenceSegmentRepository } from '../application/ports/evidence-segment-repository.ts'
import type { LongFormIndexRepository } from '../application/ports/long-form-index-repository.ts'
import type { ContiguousExtractionRepository } from '../application/ports/contiguous-extraction-repository.ts'
import type { ColorPipelineCompilationRepository } from '../application/ports/color-pipeline-compilation-repository.ts'
import type { WorkspaceLutRepository } from '../application/ports/workspace-lut-repository.ts'
import type { ProjectLutSelectionRepository } from '../application/ports/project-lut-selection-repository.ts'
import type { ProjectPolicyOverridesRepository } from '../application/ports/project-policy-overrides-repository.ts'
import type { ContiguousEvidenceRepository } from '../application/ports/contiguous-evidence-repository.ts'
import type { ContiguousEvaluationRepository } from '../application/ports/contiguous-evaluation-provider.ts'
import type { LongFormIndexWorkflowRepository } from '../application/ports/long-form-index-workflow-repository.ts'
import type { SpeakerDiarizationRepository } from '../application/ports/speaker-diarization-repository.ts'
import type { ValidatedSegmentRepository } from '../application/ports/validated-segment-repository.ts'
import type { SemanticSearchRepository } from '../application/ports/semantic-search-repository.ts'
import type { HierarchicalProcessingRepository } from '../application/ports/hierarchical-processing-repository.ts'
import type { ProductionBatchRepository } from '../application/ports/production-batch-repository.ts'
import type { ScriptAlignmentRepository } from '../application/ports/script-alignment-repository.ts'
import type { TakeLibraryRepository } from '../application/ports/take-library-repository.ts'
import type { CompatibilityGraphRepository } from '../application/ports/compatibility-graph-repository.ts'
import type { VariantRecipeRepository } from '../application/ports/variant-recipe-repository.ts'
import type { VariantPortfolioPreflightRepository } from '../application/ports/variant-portfolio-preflight-repository.ts'
import type { BatchEditRepository } from '../application/ports/batch-edit-repository.ts'
import type { SourceDeconstructionRepository } from '../application/ports/source-deconstruction-repository.ts'
import type { ContaminationReportRepository } from '../application/ports/contamination-report-repository.ts'
import type { SourceCleanupRepository } from '../application/ports/source-cleanup-repository.ts'
import type { ValidationEnvelopeRepository } from '../application/ports/validation-envelope-repository.ts'
import type { ProofNeedRepository } from '../application/ports/proof-need-repository.ts'
import type { MontageAlternativeRepository } from '../application/ports/montage-alternative-repository.ts'
import type { ProofIntegrityRepository } from '../application/ports/proof-integrity-repository.ts'
import type { ProofModeRepository } from '../application/ports/proof-mode-repository.ts'
import type { MaterializationAuthorizationRepository } from '../application/ports/materialization-authorization-repository.ts'
import type { MediaTransferRepository } from '../application/ports/media-transfer-repository.ts'
import type { MediaDownloadGrantRepository } from '../application/ports/media-download-grant-repository.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { MediaLibraryRepository } from '../application/ports/media-library-repository.ts'
import type { MediaSegmentRepository } from '../application/ports/media-segment-repository.ts'
import type { ImageAnalysisRepository } from '../application/ports/image-analysis-repository.ts'
import type { MediaArtifactPersistenceRepository } from '../application/ports/media-artifact-repository.ts'
import type { MediaArtifactLifecycleRepository } from '../application/ports/media-artifact-lifecycle-repository.ts'
import type { ProjectMediaRepository } from '../application/ports/media-ingest.ts'
import type { ProtectedRenderInputStore } from '../application/ports/protected-render-input-store.ts'
import type { RenderInputAssetResolver } from '../application/ports/render-input-asset-resolver.ts'
import type { RenderInputAssetAvailability } from '../application/ports/render-reconstruction-readiness.ts'
import type { ProjectCreationRepository } from '../application/ports/project-creation-repository.ts'
import type { ProjectDuplicationRepository } from '../application/ports/project-duplication-repository.ts'
import type { ProjectAdministrationRepository } from '../application/ports/project-administration-repository.ts'
import type { ProjectQueryRepository } from '../application/ports/project-query-repository.ts'
import type { ProjectWorkspaceQueryRepository } from '../application/ports/project-workspace-query-repository.ts'
import type { ReviewAnnotationRepository } from '../application/ports/review-annotation-repository.ts'
import type { RenderElementMapRepository } from '../application/ports/render-element-map-repository.ts'
import type { EditorialCommandRepository } from '../application/ports/editorial-command-repository.ts'
import type { ManualEditRepository } from '../application/ports/manual-edit-repository.ts'
import type { SourceTranscriptReplacementRepository } from '../application/ports/source-transcript-replacement-repository.ts'
import type { VersionCompareRepository } from '../application/ports/version-compare-repository.ts'
import type { DirectorRunRepository } from '../application/ports/director-run-repository.ts'
import type { ProjectProxyRenderRepository } from '../application/ports/project-proxy-render-repository.ts'
import type { ProxyReviewRepository } from '../application/ports/proxy-review-repository.ts'
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
import { PrismaGovernanceAdmissionRepository } from './prisma/governance-admission-repository.ts'
import { PrismaSandboxProviderExecutionRepository } from './prisma/sandbox-provider-execution-repository.ts'
import { PrismaGovernancePolicyRepository } from './prisma/governance-policy-repository.ts'
import { PrismaApiAccessControlRepository } from './prisma/api-access-control-repository.ts'
import { PrismaArtifactRenderCheckpointRepository } from './prisma/artifact-render-checkpoint-repository.ts'
import { PrismaAssetRightsRepository } from './prisma/asset-rights-repository.ts'
import { PrismaAssetSelectionRepository } from './prisma/asset-selection-repository.ts'
import { PrismaQualityIterationRepository } from './prisma/quality-iteration-repository.ts'
import { PrismaMvpCoreGateRepository } from './prisma/mvp-core-gate-repository.ts'
import { PrismaSpeechSegmentCatalogRepository } from './prisma/speech-segment-catalog-repository.ts'
import { PrismaEvidenceSegmentRepository } from './prisma/evidence-segment-repository.ts'
import { PrismaLongFormIndexRepository } from './prisma/long-form-index-repository.ts'
import { PrismaContiguousExtractionRepository } from './prisma/contiguous-extraction-repository.ts'
import { PrismaColorPipelineCompilationRepository } from './prisma/color-pipeline-compilation-repository.ts'
import { PrismaWorkspaceLutRepository } from './prisma/workspace-lut-repository.ts'
import { PrismaProjectLutSelectionRepository } from './prisma/project-lut-selection-repository.ts'
import { PrismaProjectPolicyOverridesRepository } from './prisma/project-policy-overrides-repository.ts'
import { PrismaContiguousEvidenceRepository } from './prisma/contiguous-evidence-repository.ts'
import { PrismaContiguousEvaluationRepository } from './prisma/contiguous-evaluation-repository.ts'
import {
  RightsIntegrityContiguousEvidenceAnalyzer,
} from './analysis/rights-integrity-contiguous-evidence-analyzer.ts'
import {
  TranscriptBoundaryContiguousEvidenceAnalyzer,
  TranscriptDensityContiguousEvidenceAnalyzer,
} from './analysis/transcript-contiguous-evidence-analyzers.ts'
import {
  AudioContiguousEvidenceAnalyzer,
} from './analysis/audio-contiguous-evidence-analyzer.ts'
import {
  createFfmpegContiguousAudioEvidenceProviderFromEnvironment,
} from './analysis/ffmpeg-contiguous-audio-evidence-provider.ts'
import {
  VisualContiguousEvidenceAnalyzer,
} from './analysis/visual-contiguous-evidence-analyzer.ts'
import {
  createFfmpegContiguousVisualEvidenceProviderFromEnvironment,
} from './analysis/ffmpeg-contiguous-visual-evidence-provider.ts'
import {
  DeterministicContiguousEvaluationProvider,
} from './analysis/deterministic-contiguous-evaluation-provider.ts'
import { PrismaLongFormIndexWorkflowRepository } from './prisma/long-form-index-workflow-repository.ts'
import { PrismaSpeakerDiarizationRepository } from './prisma/speaker-diarization-repository.ts'
import { PrismaValidatedSegmentRepository } from './prisma/validated-segment-repository.ts'
import { PrismaSemanticSearchRepository } from './prisma/semantic-search-repository.ts'
import { PrismaHierarchicalProcessingRepository } from './prisma/hierarchical-processing-repository.ts'
import { PrismaProductionBatchRepository } from './prisma/production-batch-repository.ts'
import { PrismaScriptAlignmentRepository } from './prisma/script-alignment-repository.ts'
import { PrismaTakeLibraryRepository } from './prisma/take-library-repository.ts'
import { PrismaCompatibilityGraphRepository } from './prisma/compatibility-graph-repository.ts'
import { PrismaVariantRecipeRepository } from './prisma/variant-recipe-repository.ts'
import { PrismaVariantPortfolioPreflightRepository } from './prisma/variant-portfolio-preflight-repository.ts'
import { PrismaBatchEditRepository } from './prisma/batch-edit-repository.ts'
import { PrismaSourceDeconstructionRepository } from './prisma/source-deconstruction-repository.ts'
import { PrismaContaminationReportRepository } from './prisma/contamination-report-repository.ts'
import { PrismaSourceCleanupRepository } from './prisma/source-cleanup-repository.ts'
import { PrismaValidationEnvelopeRepository } from './prisma/validation-envelope-repository.ts'
import { PrismaProofNeedRepository } from './prisma/proof-need-repository.ts'
import { PrismaMontageAlternativeRepository } from './prisma/montage-alternative-repository.ts'
import { PrismaProofIntegrityRepository } from './prisma/proof-integrity-repository.ts'
import { PrismaProofModeRepository } from './prisma/proof-mode-repository.ts'
import { PrismaMaterializationAuthorizationRepository } from './prisma/materialization-authorization-repository.ts'
import { PrismaMediaTransferRepository } from './prisma/media-transfer-repository.ts'
import { PrismaMediaDownloadGrantRepository } from './prisma/media-download-grant-repository.ts'
import { PrismaMediaArtifactRepository } from './prisma/media-artifact-repository.ts'
import { PrismaMediaLibraryRepository } from './prisma/media-library-repository.ts'
import { PrismaMediaSegmentRepository } from './prisma/media-segment-repository.ts'
import { PrismaImageAnalysisRepository } from './prisma/image-analysis-repository.ts'
import { PrismaMediaArtifactLifecycleRepository } from './prisma/media-artifact-lifecycle-repository.ts'
import { PrismaProtectedRenderInputStore } from './prisma/protected-render-input-store.ts'
import { PrismaRenderInputAssetAvailability } from './prisma/render-input-asset-availability.ts'
import { PrismaProjectCreationRepository } from './prisma/project-creation-repository.ts'
import { PrismaProjectDuplicationRepository } from './prisma/project-duplication-repository.ts'
import { PrismaProjectAdministrationRepository } from './prisma/project-administration-repository.ts'
import { PrismaProjectQueryRepository } from './prisma/project-query-repository.ts'
import { PrismaProjectWorkspaceQueryRepository } from './prisma/project-workspace-query-repository.ts'
import { PrismaReviewAnnotationRepository } from './prisma/review-annotation-repository.ts'
import { PrismaReviewPatchRepository } from './prisma/review-patch-repository.ts'
import { PrismaReviewPatchBatchRepository } from './prisma/review-patch-batch-repository.ts'
import { PrismaRenderElementMapRepository } from './prisma/render-element-map-repository.ts'
import { PrismaProjectMediaRepository } from './prisma/project-media-repository.ts'
import { PrismaEditorialCommandRepository } from './prisma/editorial-command-repository.ts'
import { PrismaManualEditRepository } from './prisma/manual-edit-repository.ts'
import { PrismaSourceTranscriptReplacementRepository } from './prisma/source-transcript-replacement-repository.ts'
import { PrismaVersionCompareRepository } from './prisma/version-compare-repository.ts'
import { PrismaDirectorRunRepository } from './prisma/director-run-repository.ts'
import { PrismaProjectProxyRenderRepository } from './prisma/project-proxy-render-repository.ts'
import { PrismaProxyReviewRepository } from './prisma/proxy-review-repository.ts'
import { PrismaProjectFinalExportRepository } from './prisma/project-final-export-repository.ts'
import { PrismaPublicOperationRepository } from './prisma/public-operation-repository.ts'
import { TelemetryPublicOperationRepository } from './telemetry-public-operation-repository.ts'
import { CompositeOperationTelemetry, StructuredConsoleOperationTelemetry } from './structured-console-operation-telemetry.ts'
import {
  AlertingOperationTelemetry,
  operationAlertThresholdsFromEnvironment,
} from './alerting-operation-telemetry.ts'
import type { OperationTelemetrySink } from '../application/ports/operation-telemetry.ts'
import type { OperationTelemetryQueryRepository } from '../application/ports/operation-telemetry-query-repository.ts'
import type { UiSessionSecurityRepository } from '../application/ports/ui-session-security-repository.ts'
import type { WorkspaceMemberRepository } from '../application/ports/workspace-member-repository.ts'
import { PrismaOperationTelemetryRepository } from './prisma/operation-telemetry-repository.ts'
import { PrismaUiSessionSecurityRepository } from './prisma/ui-session-security-repository.ts'
import { PrismaWorkspaceMemberRepository } from './prisma/workspace-member-repository.ts'
import type { OidcAuthorizationRepository } from '../application/ports/oidc-authorization-repository.ts'
import { PrismaOidcAuthorizationRepository } from './prisma/oidc-authorization-repository.ts'
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
import { S3ArtifactRenderInputResolver } from './s3-artifact-render-input-resolver.ts'
import {
  AwsS3RenderInputObjectClient,
  type S3RenderInputObjectClient,
} from './s3-render-input-object-client.ts'
import { RemotionRenderInputRenderer } from './remotion-render-input-renderer.ts'
import {
  createLocalMediaUploadStorageFromEnvironment,
  LocalArtifactSourceMaterializer,
} from './media/local-media-upload-storage.ts'
import {
  createArtifactS3ClientFromEnvironment,
  S3ArtifactContentStorage,
  S3ArtifactSourceMaterializer,
  S3VerifiedMediaStorage,
} from './media/s3-artifact-storage.ts'
import { createLocalArtifactContentStorageFromEnvironment } from './media/local-artifact-content-storage.ts'
import { createFfmpegIngestProcessorFromEnvironment } from './media/ffmpeg-ingest-processor.ts'
import { calculateFileSha256 } from './media/local-artifact-manifest.ts'
import { FfmpegMediaSegmentExtractor } from './media/ffmpeg-media-segment-extractor.ts'
import { SharpImageAnalysisProcessor } from './media/sharp-image-analysis-processor.ts'
import { TesseractImageVisionProvider } from './image/tesseract-image-vision-provider.ts'
import { inspectUploadedMedia, probeVideo } from './media/video-probe.ts'
import { createFfmpegEditorialProxyRendererFromEnvironment } from './media/ffmpeg-editorial-proxy-renderer.ts'
import { LocalProjectLutRenderMaterializer } from './media/local-project-lut-render-materializer.ts'
import { createFfmpegSourceCleanupProcessorFromEnvironment } from './media/ffmpeg-source-cleanup-processor.ts'
import {
  createFfmpegSpeakerDiarizationAudioPreparerFromEnvironment,
} from './media/ffmpeg-speaker-diarization-audio-preparer.ts'
import { EnvironmentProviderRuntimeRouter } from './provider-runtime-router.ts'
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

export function createGovernanceAdmissionRepository(): GovernanceAdmissionRepository {
  return new PrismaGovernanceAdmissionRepository(resolveV2Client())
}

export function createSandboxProviderExecutionRepository(): SandboxProviderExecutionRepository {
  return new PrismaSandboxProviderExecutionRepository(resolveV2Client())
}

export function createGovernancePolicyRepository(): GovernancePolicyRepository {
  return new PrismaGovernancePolicyRepository(resolveV2Client())
}

export function createApiClientAdministrationRepository(): ApiClientAdministrationRepository {
  return new PrismaApiClientRepository(resolveV2Client())
}

export function createApiAccessControlRepository(): ApiAccessControlRepository {
  return new PrismaApiAccessControlRepository(resolveV2Client())
}

export function createAssetRightsRepository(): AssetRightsRepository {
  return new PrismaAssetRightsRepository(resolveV2Client())
}

export function createAssetSelectionRepository(): AssetSelectionRepository {
  return new PrismaAssetSelectionRepository(resolveV2Client())
}

export function createQualityIterationRepository(): QualityIterationRepository {
  return new PrismaQualityIterationRepository(resolveV2Client())
}

export function createMvpCoreGateRepository(): MvpCoreGateRepository {
  return new PrismaMvpCoreGateRepository(resolveV2Client())
}

export function createSpeechSegmentCatalogRepository(): SpeechSegmentCatalogRepository {
  return new PrismaSpeechSegmentCatalogRepository(resolveV2Client())
}

export function createEvidenceSegmentRepository(): EvidenceSegmentRepository {
  return new PrismaEvidenceSegmentRepository(resolveV2Client())
}

export function createLongFormIndexRepository(): LongFormIndexRepository {
  return new PrismaLongFormIndexRepository(resolveV2Client())
}

export function createContiguousExtractionRepository():
ContiguousExtractionRepository {
  return new PrismaContiguousExtractionRepository(resolveV2Client())
}

export function createColorPipelineCompilationRepository():
ColorPipelineCompilationRepository {
  return new PrismaColorPipelineCompilationRepository(resolveV2Client())
}

export function createWorkspaceLutRepository(): WorkspaceLutRepository {
  return new PrismaWorkspaceLutRepository(resolveV2Client())
}

export function createProjectLutSelectionRepository(): ProjectLutSelectionRepository {
  return new PrismaProjectLutSelectionRepository(resolveV2Client())
}

export function createProjectPolicyOverridesRepository(): ProjectPolicyOverridesRepository {
  return new PrismaProjectPolicyOverridesRepository(resolveV2Client())
}

export function createContiguousEvidenceRepository():
ContiguousEvidenceRepository {
  return new PrismaContiguousEvidenceRepository(resolveV2Client())
}

export function createRightsIntegrityContiguousEvidenceProducer() {
  return produceContiguousEvidenceService({
    repository: createContiguousEvidenceRepository(),
    analyzer: new RightsIntegrityContiguousEvidenceAnalyzer(),
    createRunId: () => randomUUID(),
    createEvidenceId: () => randomUUID(),
  })
}

export function createTranscriptBoundaryContiguousEvidenceProducer() {
  return produceContiguousEvidenceService({
    repository: createContiguousEvidenceRepository(),
    analyzer:
      new TranscriptBoundaryContiguousEvidenceAnalyzer(),
    createRunId: () => randomUUID(),
    createEvidenceId: () => randomUUID(),
  })
}

export function createTranscriptDensityContiguousEvidenceProducer() {
  return produceContiguousEvidenceService({
    repository: createContiguousEvidenceRepository(),
    analyzer:
      new TranscriptDensityContiguousEvidenceAnalyzer(),
    createRunId: () => randomUUID(),
    createEvidenceId: () => randomUUID(),
  })
}

export function createAudioContiguousEvidenceProducer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return produceContiguousEvidenceService({
    repository: createContiguousEvidenceRepository(),
    analyzer: new AudioContiguousEvidenceAnalyzer(
      createFfmpegContiguousAudioEvidenceProviderFromEnvironment(
        environment,
      ),
    ),
    createRunId: () => randomUUID(),
    createEvidenceId: () => randomUUID(),
  })
}

export function createVisualContiguousEvidenceProducer(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return produceContiguousEvidenceService({
    repository: createContiguousEvidenceRepository(),
    analyzer: new VisualContiguousEvidenceAnalyzer(
      createFfmpegContiguousVisualEvidenceProviderFromEnvironment(
        environment,
      ),
    ),
    createRunId: () => randomUUID(),
    createEvidenceId: () => randomUUID(),
  })
}

export function createContiguousEvaluationRepository():
ContiguousEvaluationRepository {
  return new PrismaContiguousEvaluationRepository(resolveV2Client())
}

export function createContiguousEvaluationProducer() {
  return produceContiguousEvaluationsService({
    repository: createContiguousEvaluationRepository(),
    provider: new DeterministicContiguousEvaluationProvider(),
    createRunId: () => randomUUID(),
    createEvaluationId: () => randomUUID(),
  })
}

export function createValidatedSegmentRepository(): ValidatedSegmentRepository {
  return new PrismaValidatedSegmentRepository(resolveV2Client())
}

export function createSemanticSearchRepository(): SemanticSearchRepository {
  return new PrismaSemanticSearchRepository(resolveV2Client())
}

export function createHierarchicalProcessingRepository():
HierarchicalProcessingRepository {
  return new PrismaHierarchicalProcessingRepository(resolveV2Client())
}

export function createProductionBatchRepository():
ProductionBatchRepository {
  return new PrismaProductionBatchRepository(resolveV2Client())
}

export function createScriptAlignmentRepository():
ScriptAlignmentRepository {
  return new PrismaScriptAlignmentRepository(resolveV2Client())
}

export function createTakeLibraryRepository():
TakeLibraryRepository {
  return new PrismaTakeLibraryRepository(resolveV2Client())
}

export function createCompatibilityGraphRepository():
CompatibilityGraphRepository {
  return new PrismaCompatibilityGraphRepository(resolveV2Client())
}

export function createVariantRecipeRepository():
VariantRecipeRepository {
  return new PrismaVariantRecipeRepository(resolveV2Client())
}

export function createVariantPortfolioPreflightRepository():
VariantPortfolioPreflightRepository {
  return new PrismaVariantPortfolioPreflightRepository(resolveV2Client())
}

export function createBatchEditRepository(): BatchEditRepository {
  return new PrismaBatchEditRepository(resolveV2Client())
}

export function createSourceDeconstructionRepository():
SourceDeconstructionRepository {
  return new PrismaSourceDeconstructionRepository(resolveV2Client())
}

export function createContaminationReportRepository():
ContaminationReportRepository {
  return new PrismaContaminationReportRepository(resolveV2Client())
}

export function createSourceCleanupRepository():
SourceCleanupRepository {
  return new PrismaSourceCleanupRepository(resolveV2Client())
}

export function createValidationEnvelopeRepository():
ValidationEnvelopeRepository {
  return new PrismaValidationEnvelopeRepository(resolveV2Client())
}

export function createProofNeedRepository(): ProofNeedRepository {
  return new PrismaProofNeedRepository(resolveV2Client())
}

export function createMontageAlternativeRepository(): MontageAlternativeRepository {
  return new PrismaMontageAlternativeRepository(resolveV2Client())
}

export function createProofIntegrityRepository():
ProofIntegrityRepository {
  return new PrismaProofIntegrityRepository(resolveV2Client())
}

export function createProofModeRepository(): ProofModeRepository {
  return new PrismaProofModeRepository(resolveV2Client())
}

export function createLongFormIndexWorkflowRepository():
LongFormIndexWorkflowRepository {
  return new PrismaLongFormIndexWorkflowRepository(resolveV2Client())
}

export function createSpeakerDiarizationRepository():
SpeakerDiarizationRepository {
  return new PrismaSpeakerDiarizationRepository(resolveV2Client())
}

export function createProviderRuntimeRouter(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return new EnvironmentProviderRuntimeRouter(
    environment,
    createSandboxProviderExecutionRepository(),
  )
}

export function createSpeakerDiarizationStageProcessorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  return createSpeakerDiarizationStageProcessor({
    repository: createSpeakerDiarizationRepository(),
    providers: createProviderRuntimeRouter(environment),
    audio:
      createFfmpegSpeakerDiarizationAudioPreparerFromEnvironment(
        environment,
      ),
    createRunId: () => `diarization-run-${randomUUID()}`,
    clock,
  })
}

export function createLongFormTranscriptStageProcessorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  return createLongFormTranscriptStageProcessor({
    repository: createLongFormIndexWorkflowRepository(),
    providers: createProviderRuntimeRouter(environment),
    audio:
      createFfmpegSpeakerDiarizationAudioPreparerFromEnvironment(
        environment,
      ),
    createTranscriptId: (transcriptHash) =>
      `transcript-${transcriptHash}`,
    clock,
  })
}

export function createLongFormDerivedStageProcessorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const defaults =
    DEFAULT_LONG_FORM_DERIVED_STAGE_CONFIGURATION
  const produceRightsEvidence =
    createRightsIntegrityContiguousEvidenceProducer()
  const produceTranscriptBoundaryEvidence =
    createTranscriptBoundaryContiguousEvidenceProducer()
  const produceTranscriptDensityEvidence =
    createTranscriptDensityContiguousEvidenceProducer()
  const produceAudioEvidence =
    createAudioContiguousEvidenceProducer(environment)
  const produceVisualEvidence =
    createVisualContiguousEvidenceProducer(environment)
  const produceEvaluation =
    createContiguousEvaluationProducer()
  const numberFromEnvironment = (
    name: string,
    fallback: number,
  ): number => {
    const raw = environment[name]?.trim()
    if (!raw) return fallback
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        `${name} must be a finite number`,
      )
    }
    return parsed
  }
  return createLongFormDerivedStageProcessor({
    hierarchical: createHierarchicalProcessingRepository(),
    longForm: createLongFormIndexRepository(),
    diarization: createSpeakerDiarizationRepository(),
    contiguousEvidenceProducers: Object.freeze([
      Object.freeze({
        kind: 'transcript-boundary' as const,
        produce: produceTranscriptBoundaryEvidence,
      }),
      Object.freeze({
        kind: 'transcript-density' as const,
        produce: produceTranscriptDensityEvidence,
      }),
      Object.freeze({
        kind: 'rights-integrity' as const,
        produce: produceRightsEvidence,
      }),
      Object.freeze({
        kind: 'audio-analysis' as const,
        produce: produceAudioEvidence,
      }),
      Object.freeze({
        kind: 'visual-analysis' as const,
        produce: produceVisualEvidence,
      }),
    ]),
    contiguousEvaluation: Object.freeze({
      produce: produceEvaluation,
    }),
    createId: (kind, sourceId) =>
      sourceId
        ? `${kind}-${calculateVersionHash({
            sourceId,
            nonce: randomUUID(),
          }).slice(0, 40)}`
        : `${kind}-${randomUUID()}`,
    clock,
    configuration: Object.freeze({
      chunks: Object.freeze({
        ...defaults.chunks,
        chunkDurationMs: numberFromEnvironment(
          'APOLLO_LONG_FORM_CHUNK_DURATION_MS',
          defaults.chunks.chunkDurationMs,
        ),
        overlapMs: numberFromEnvironment(
          'APOLLO_LONG_FORM_CHUNK_OVERLAP_MS',
          defaults.chunks.overlapMs,
        ),
        maximumWorkingSetBytes: numberFromEnvironment(
          'APOLLO_LONG_FORM_MAX_WORKING_SET_BYTES',
          defaults.chunks.maximumWorkingSetBytes,
        ),
      }),
      moments: Object.freeze({
        ...defaults.moments,
        producerConfidence: numberFromEnvironment(
          'APOLLO_LONG_FORM_PRODUCER_CONFIDENCE',
          defaults.moments.producerConfidence,
        ),
      }),
    }),
  })
}

export function createTranscribedLongFormStageProcessorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const transcript =
    createLongFormTranscriptStageProcessorFromEnvironment(
      environment,
      clock,
    )
  const diarization =
    createSpeakerDiarizationStageProcessorFromEnvironment(
      environment,
      clock,
    )
  const derived =
    createLongFormDerivedStageProcessorFromEnvironment(
      environment,
      clock,
    )
  return createLongFormIndexStageRouter({
    transcript,
    diarization,
    chunks: derived,
    moments: derived,
  })
}

export function createMaterializationAuthorizationRepository(): MaterializationAuthorizationRepository {
  return new PrismaMaterializationAuthorizationRepository(resolveV2Client())
}

export function createMediaArtifactQueryRepository(): MediaArtifactQueryRepository {
  return new PrismaMediaArtifactRepository(resolveV2Client())
}

export function createMediaLibraryRepository(): MediaLibraryRepository {
  return new PrismaMediaLibraryRepository(resolveV2Client())
}

export function createMediaSegmentRepository(): MediaSegmentRepository {
  return new PrismaMediaSegmentRepository(resolveV2Client())
}

export function createImageAnalysisRepository(): ImageAnalysisRepository {
  return new PrismaImageAnalysisRepository(resolveV2Client())
}

export function createMediaArtifactLifecycleRepository(): MediaArtifactLifecycleRepository {
  return new PrismaMediaArtifactLifecycleRepository(resolveV2Client())
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
  if (artifactStorageDriver(environment) === 'local') {
    return createLocalArtifactContentStorageFromEnvironment(environment)
  }
  return new S3ArtifactContentStorage(createArtifactS3ClientFromEnvironment(environment))
}

export function createProjectMediaRepository(): ProjectMediaRepository {
  return new PrismaProjectMediaRepository(resolveV2Client())
}

function artifactStorageDriver(environment: NodeJS.ProcessEnv): 'local' | 's3' {
  const driver = environment.APOLLO_V2_ARTIFACT_STORAGE_DRIVER?.trim().toLowerCase() || 'local'
  if (driver !== 'local' && driver !== 's3') throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact storage driver is invalid')
  return driver
}

function createVerifiedMediaStorage(environment: NodeJS.ProcessEnv) {
  const local = createLocalMediaUploadStorageFromEnvironment(environment)
  if (artifactStorageDriver(environment) === 'local') return local
  const s3 = createArtifactS3ClientFromEnvironment(environment)
  return new S3VerifiedMediaStorage(local, s3)
}

function createArtifactSourceMaterializer(environment: NodeJS.ProcessEnv) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  if (artifactStorageDriver(environment) === 'local') return new LocalArtifactSourceMaterializer(artifactRoot)
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  if (!workRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Render work root is required for S3 artifact materialization')
  return new S3ArtifactSourceMaterializer(workRoot, createArtifactS3ClientFromEnvironment(environment))
}

export function createMediaSegmentMaterializationDependencies(environment: NodeJS.ProcessEnv = process.env) {
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  if (!workRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Render work root is required for media segment extraction')
  return {
    repository: createMediaSegmentRepository(), artifacts: createMediaArtifactPersistenceRepository(environment),
    sources: createArtifactSourceMaterializer(environment), storage: createVerifiedMediaStorage(environment),
    extractor: new FfmpegMediaSegmentExtractor(join(resolve(workRoot), 'media-segments')),
    integrity: { sha256: calculateFileSha256 },
  }
}

export function createProjectProxyRenderRepository(): ProjectProxyRenderRepository {
  return new PrismaProjectProxyRenderRepository(resolveV2Client())
}

export function createProxyReviewRepository(): ProxyReviewRepository {
  return new PrismaProxyReviewRepository(resolveV2Client())
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

export function createPublicOperationRepository(
  telemetry: OperationTelemetrySink = createConfiguredOperationTelemetry(),
): PublicOperationRepository {
  return new TelemetryPublicOperationRepository(
    new PrismaPublicOperationRepository(resolveV2Client()),
    telemetry,
  )
}

function createConfiguredOperationTelemetry(environment: NodeJS.ProcessEnv = process.env): OperationTelemetrySink {
  const persistent = new PrismaOperationTelemetryRepository(resolveV2Client())
  return new AlertingOperationTelemetry(
    new CompositeOperationTelemetry([new StructuredConsoleOperationTelemetry(), persistent]),
    operationAlertThresholdsFromEnvironment(environment),
    console,
    persistent,
  )
}

export function createOperationTelemetryQueryRepository(): OperationTelemetryQueryRepository {
  return new PrismaOperationTelemetryRepository(resolveV2Client())
}

export function createUiSessionSecurityRepository(): UiSessionSecurityRepository {
  return new PrismaUiSessionSecurityRepository(resolveV2Client())
}

export function createWorkspaceMemberRepository(): WorkspaceMemberRepository {
  return new PrismaWorkspaceMemberRepository(resolveV2Client())
}

export function createOidcAuthorizationRepository(): OidcAuthorizationRepository {
  return new PrismaOidcAuthorizationRepository(resolveV2Client())
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
  return new PrismaRenderInputAssetAvailability(resolveV2Client(), createWorkspaceLutRepository())
}

export function createRenderInputAssetResolver(
  workspaceId: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: Readonly<{
    validUntil?: string
    s3Objects?: S3RenderInputObjectClient
  }> = {},
): RenderInputAssetResolver {
  const driver = environment.APOLLO_V2_ARTIFACT_STORAGE_DRIVER?.trim().toLowerCase() || 'local'
  if (driver === 's3') {
    const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
    if (!workRoot) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Render work root is required for S3-backed LUT materialization',
      )
    }
    const client = resolveV2Client()
    const luts = createWorkspaceLutRepository()
    const nonMediaResolver = new LocalArtifactRenderInputResolver(client, {
      root: workRoot,
      workspaceId,
      luts,
    })
    const forcePathStyle = environment.APOLLO_V2_S3_FORCE_PATH_STYLE?.trim().toLowerCase()
    if (forcePathStyle && !['true', 'false'].includes(forcePathStyle)) {
      throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'S3 path-style setting is invalid')
    }
    if (!options.validUntil) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Materialization authorization expiry is required for S3 render assets',
      )
    }
    return new S3ArtifactRenderInputResolver(
      client,
      workspaceId,
      options.s3Objects ?? new AwsS3RenderInputObjectClient({
        endpoint: environment.APOLLO_V2_S3_ENDPOINT ?? '',
        region: environment.APOLLO_V2_S3_REGION ?? '',
        bucket: environment.APOLLO_V2_S3_BUCKET ?? '',
        accessKeyId: environment.APOLLO_V2_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: environment.APOLLO_V2_S3_SECRET_ACCESS_KEY ?? '',
        ...(environment.APOLLO_V2_S3_SESSION_TOKEN?.trim()
          ? { sessionToken: environment.APOLLO_V2_S3_SESSION_TOKEN }
          : {}),
        forcePathStyle: forcePathStyle !== 'false',
        allowInsecureHttp: environment.APOLLO_V2_S3_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === 'true',
        signedUrlTtlSeconds: Number(environment.APOLLO_V2_S3_SIGNED_URL_TTL_SECONDS || 120),
      }),
      nonMediaResolver,
      options.validUntil,
    )
  }
  if (driver !== 'local') {
    throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact storage driver is invalid')
  }
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
    luts: createWorkspaceLutRepository(),
  })
}

export function createAuthorizedRenderInputMaterializer(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const driver = environment.APOLLO_V2_ARTIFACT_STORAGE_DRIVER?.trim().toLowerCase() || 'local'
  const s3Objects = driver === 's3'
    ? new AwsS3RenderInputObjectClient({
        endpoint: environment.APOLLO_V2_S3_ENDPOINT ?? '',
        region: environment.APOLLO_V2_S3_REGION ?? '',
        bucket: environment.APOLLO_V2_S3_BUCKET ?? '',
        accessKeyId: environment.APOLLO_V2_S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: environment.APOLLO_V2_S3_SECRET_ACCESS_KEY ?? '',
        ...(environment.APOLLO_V2_S3_SESSION_TOKEN?.trim()
          ? { sessionToken: environment.APOLLO_V2_S3_SESSION_TOKEN }
          : {}),
        forcePathStyle: environment.APOLLO_V2_S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
        allowInsecureHttp: environment.APOLLO_V2_S3_ALLOW_INSECURE_HTTP?.trim().toLowerCase() === 'true',
        signedUrlTtlSeconds: Number(environment.APOLLO_V2_S3_SIGNED_URL_TTL_SECONDS || 120),
        clock,
      })
    : undefined
  return materializeAuthorizedRenderInputService({
    artifacts: createMediaArtifactQueryRepository(),
    protectedRenderInputs: createProtectedRenderInputStore(),
    assetAvailability: createRenderInputAssetAvailability(),
    targets: createConfiguredRenderTargetRegistry(environment),
    rights: createAssetRightsRepository(),
    luts: createWorkspaceLutRepository(),
    authorizations: createMaterializationAuthorizationRepository(),
    resolverForWorkspace: (workspaceId, authorization) =>
      createRenderInputAssetResolver(workspaceId, environment, {
        validUntil: authorization.validUntil,
        ...(s3Objects ? { s3Objects } : {}),
      }),
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
  const telemetry = createConfiguredOperationTelemetry(environment)
  const configuredLease = Number(environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextPublicOperationService({
    operations: createPublicOperationRepository(telemetry),
    telemetry,
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
  const telemetry = createConfiguredOperationTelemetry(environment)
  const configuredLease = Number(environment.APOLLO_V2_INGEST_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_INGEST_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextMediaIngestOperationService({
    operations: createPublicOperationRepository(telemetry),
    telemetry,
    uploads: createMediaTransferRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    projectMedia: createProjectMediaRepository(),
    storage: createVerifiedMediaStorage(environment),
    processor: createFfmpegIngestProcessorFromEnvironment(environment),
    prober: { probe: probeVideo },
    inspector: { inspect: inspectUploadedMedia },
    providers: createProviderRuntimeRouter(environment),
    rights: createAssetRightsRepository(),
    imageAnalysis: {
      processor: new SharpImageAnalysisProcessor(
        join(resolve(environment.APOLLO_V2_RENDER_WORK_ROOT ?? '.apollo/work'), 'image-analysis'),
        environment.APOLLO_TESSERACT_PATH?.trim() ? new TesseractImageVisionProvider({ binary: environment.APOLLO_TESSERACT_PATH.trim() }) : undefined,
      ),
      repository: createImageAnalysisRepository(), integrity: { sha256: calculateFileSha256 },
    },
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createLongFormIndexWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const telemetry = createConfiguredOperationTelemetry(environment)
  const configuredLease = Number(
    environment.APOLLO_V2_LONG_FORM_LEASE_MS ??
      environment.APOLLO_V2_WORKER_LEASE_MS,
  )
  const configuredHeartbeat = Number(
    environment.APOLLO_V2_LONG_FORM_HEARTBEAT_MS ??
      environment.APOLLO_V2_WORKER_HEARTBEAT_MS,
  )
  const configuredRetryBase = Number(
    environment.APOLLO_V2_WORKER_RETRY_BASE_MS,
  )
  const configuredRetryMax = Number(
    environment.APOLLO_V2_WORKER_RETRY_MAX_MS,
  )
  return runNextLongFormIndexOperationService({
    operations: createPublicOperationRepository(telemetry),
    telemetry,
    workflows: createLongFormIndexWorkflowRepository(),
    processor:
      createTranscribedLongFormStageProcessorFromEnvironment(
        environment,
        clock,
      ),
    clock,
    ...(Number.isSafeInteger(configuredLease) &&
      configuredLease > 0
      ? { leaseDurationMs: configuredLease }
      : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) &&
      configuredHeartbeat > 0
      ? { heartbeatIntervalMs: configuredHeartbeat }
      : {}),
    ...(Number.isSafeInteger(configuredRetryBase) &&
      configuredRetryBase > 0
      ? { retryBaseDelayMs: configuredRetryBase }
      : {}),
    ...(Number.isSafeInteger(configuredRetryMax) &&
      configuredRetryMax > 0
      ? { retryMaxDelayMs: configuredRetryMax }
      : {}),
  })
}

export function createProjectProxyRenderWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const telemetry = createConfiguredOperationTelemetry(environment)
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  const configuredLease = Number(environment.APOLLO_V2_RENDER_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_RENDER_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextProjectProxyRenderOperationService({
    operations: createPublicOperationRepository(telemetry), projects: createProjectProxyRenderRepository(),
    telemetry,
    artifacts: createMediaArtifactPersistenceRepository(environment), storage: createVerifiedMediaStorage(environment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(environment),
    sources: createArtifactSourceMaterializer(environment), clock,
    renderElementMaps: createRenderElementMapRepository(),
    proxyReviews: createProxyReviewRepository(),
    colorPipelines: createColorPipelineCompilationRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work')),
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createProjectDirectorWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const configuredLease = Number(environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextProjectDirectorOperationService({
    operations: createPublicOperationRepository(
      createConfiguredOperationTelemetry(environment),
    ),
    directorRuns: createDirectorRunRepository(),
    clock,
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
    compileBrief: createEvidenceBoundBriefCompiler(),
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

export function createProjectFinalExportWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const telemetry = createConfiguredOperationTelemetry(environment)
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  const configuredLease = Number(environment.APOLLO_V2_RENDER_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS)
  const configuredHeartbeat = Number(environment.APOLLO_V2_RENDER_HEARTBEAT_MS ?? environment.APOLLO_V2_WORKER_HEARTBEAT_MS)
  const configuredRetryBase = Number(environment.APOLLO_V2_WORKER_RETRY_BASE_MS)
  const configuredRetryMax = Number(environment.APOLLO_V2_WORKER_RETRY_MAX_MS)
  return runNextProjectFinalExportOperationService({
    operations: createPublicOperationRepository(telemetry),
    telemetry,
    projects: createProjectFinalExportRepository(),
    rights: createAssetRightsRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    storage: createVerifiedMediaStorage(environment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(environment),
    renderElementMaps: createRenderElementMapRepository(),
    colorPipelines: createColorPipelineCompilationRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work')),
    sources: createArtifactSourceMaterializer(environment),
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseDurationMs: configuredLease } : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) && configuredHeartbeat > 0 ? { heartbeatIntervalMs: configuredHeartbeat } : {}),
    ...(Number.isSafeInteger(configuredRetryBase) && configuredRetryBase > 0 ? { retryBaseDelayMs: configuredRetryBase } : {}),
    ...(Number.isSafeInteger(configuredRetryMax) && configuredRetryMax > 0 ? { retryMaxDelayMs: configuredRetryMax } : {}),
  })
}

export function createSourceCleanupWorker(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const telemetry = createConfiguredOperationTelemetry(environment)
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Artifact root is not configured',
    )
  }
  const configuredLease = Number(
    environment.APOLLO_V2_RENDER_LEASE_MS ??
    environment.APOLLO_V2_WORKER_LEASE_MS,
  )
  const configuredHeartbeat = Number(
    environment.APOLLO_V2_RENDER_HEARTBEAT_MS ??
    environment.APOLLO_V2_WORKER_HEARTBEAT_MS,
  )
  const configuredRetryBase = Number(
    environment.APOLLO_V2_WORKER_RETRY_BASE_MS,
  )
  const configuredRetryMax = Number(
    environment.APOLLO_V2_WORKER_RETRY_MAX_MS,
  )
  return runNextSourceCleanupOperationService({
    operations: createPublicOperationRepository(telemetry),
    telemetry,
    cleanups: createSourceCleanupRepository(),
    mediaArtifacts: createMediaArtifactQueryRepository(),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    rights: createAssetRightsRepository(),
    projects: createProjectWorkspaceQueryRepository(),
    storage: createVerifiedMediaStorage(environment),
    processor:
      createFfmpegSourceCleanupProcessorFromEnvironment(environment),
    sources: createArtifactSourceMaterializer(environment),
    integrity: { sha256: calculateFileSha256 },
    clock,
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0
      ? { leaseDurationMs: configuredLease }
      : {}),
    ...(Number.isSafeInteger(configuredHeartbeat) &&
      configuredHeartbeat > 0
      ? { heartbeatIntervalMs: configuredHeartbeat }
      : {}),
    ...(Number.isSafeInteger(configuredRetryBase) &&
      configuredRetryBase > 0
      ? { retryBaseDelayMs: configuredRetryBase }
      : {}),
    ...(Number.isSafeInteger(configuredRetryMax) &&
      configuredRetryMax > 0
      ? { retryMaxDelayMs: configuredRetryMax }
      : {}),
  })
}

export function createProjectCreationRepository(): ProjectCreationRepository {
  return new PrismaProjectCreationRepository(resolveV2Client())
}

export function createProjectDuplicationRepository(): ProjectDuplicationRepository {
  return new PrismaProjectDuplicationRepository(resolveV2Client())
}

export function createProjectAdministrationRepository(): ProjectAdministrationRepository {
  return new PrismaProjectAdministrationRepository(resolveV2Client())
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

export function createReviewPatchRepository() {
  return new PrismaReviewPatchRepository(resolveV2Client())
}

export function createReviewPatchBatchRepository() {
  return new PrismaReviewPatchBatchRepository(resolveV2Client())
}

export function createRenderElementMapRepository(): RenderElementMapRepository {
  return new PrismaRenderElementMapRepository(resolveV2Client())
}

export function createEditorialCommandRepository(): EditorialCommandRepository {
  return new PrismaEditorialCommandRepository(resolveV2Client())
}

export function createManualEditRepository(): ManualEditRepository {
  return new PrismaManualEditRepository(resolveV2Client())
}

export function createSourceTranscriptReplacementRepository(): SourceTranscriptReplacementRepository {
  return new PrismaSourceTranscriptReplacementRepository(resolveV2Client())
}

export function createVersionCompareRepository(): VersionCompareRepository {
  return new PrismaVersionCompareRepository(resolveV2Client())
}

export function createDirectorRunRepository(): DirectorRunRepository {
  return new PrismaDirectorRunRepository(resolveV2Client())
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return new PrismaWorkspaceRepository(resolveV2Client())
}

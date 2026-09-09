import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
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
import { catalogApprovedOutputService } from '../application/catalog-approved-output.ts'
import { runNextSourceCleanupOperationService } from '../application/run-source-cleanup-worker.ts'
import { runNextLongFormIndexOperationService } from '../application/run-long-form-index-worker.ts'
import { enqueueProviderJobService, runProviderJobWorkerOnce } from '../application/provider-jobs.ts'
import { runNextProjectDirectorOperationService } from '../application/run-project-director-operation-worker.ts'
import { runCaptureSyncWorker } from '../application/run-capture-sync-worker.ts'
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
import type { TreatmentPlanRepository } from '../application/ports/treatment-plan-repository.ts'
import type { CaptureProtocolRepository } from '../application/ports/capture-protocol-repository.ts'
import type { SyncDiagnosticRepository } from '../application/ports/sync-diagnostic-repository.ts'
import type { ColorCriticReportRepository } from '../application/ports/color-critic-report-repository.ts'
import type {
  MulticamDiarizationSource,
  MulticamSilenceEvidenceProvider,
  MulticamVisualEvidenceProvider,
} from '../application/ports/multicam-evidence-sources.ts'
import type { MulticamDirectionCommandRepository } from '../application/ports/multicam-direction-command-repository.ts'
import type { MulticamDirectionRepository } from '../application/ports/multicam-direction-repository.ts'
import type {
  CameraColorMeasurementRepository,
  MulticamMatchPlanRepository,
} from '../application/ports/multicam-match-plan-repository.ts'
import type { PlaybackMapRepository } from '../application/ports/playback-map-repository.ts'
import type { RenderablePlanSnapshotRepository } from '../application/ports/renderable-plan-snapshot-repository.ts'
import type {
  LegacyRuntimeAuditPort,
  MulticamLongformGateRepository,
} from '../application/ports/multicam-longform-gate-repository.ts'
import type { CaptureSessionRepository } from '../application/ports/capture-session-repository.ts'
import type { CaptureSyncRunRepository } from '../application/ports/capture-sync-run-repository.ts'
import type { EditorialSynthesisRepository } from '../application/ports/editorial-synthesis-repository.ts'
import type { StoryPlanRepository } from '../application/ports/story-plan-repository.ts'
import type { WorkspaceLutRepository } from '../application/ports/workspace-lut-repository.ts'
import type { ProjectLutSelectionRepository } from '../application/ports/project-lut-selection-repository.ts'
import type { ProjectColorPlanRepository } from '../application/ports/project-color-plan-repository.ts'
import type { ProjectSubtitleConfigurationRepository } from '../application/ports/project-subtitle-configuration-repository.ts'
import type { SubtitleSegmentOverrideRepository } from '../application/ports/subtitle-segment-override-repository.ts'
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
import type { SyntheticProductionRepository } from '../application/ports/synthetic-production-repository.ts'
import type { SyntheticAudioMasterRepository } from '../application/ports/synthetic-audio-master-repository.ts'
import type { SyntheticScriptPlanRepository } from '../application/ports/synthetic-script-plan-repository.ts'
import type { SyntheticBlockGenerationRepository } from '../application/ports/synthetic-block-generation-repository.ts'
import type { NoveltyBudgetRepository } from '../application/ports/novelty-budget-repository.ts'
import type { TransformationProviderRegistryRepository } from '../application/ports/transformation-provider-registry-repository.ts'
import type { TransformationQualityRepository } from '../application/ports/transformation-quality-repository.ts'
import { PersistedTransformationResultCritic } from '../application/transformation-quality.ts'
import type { SyntheticBlockConcatenationRepository } from '../application/ports/synthetic-block-concatenation-repository.ts'
import type { SyntheticCacheDecisionRepository } from '../application/ports/synthetic-cache-decision-repository.ts'
import type { SyntheticCacheSubmissionClaimRepository } from '../application/ports/synthetic-cache-submission-claim-repository.ts'
import type { SyntheticCriticReportRepository } from '../application/ports/synthetic-critic-report-repository.ts'
import type { SyntheticMasterAssetRepository } from '../application/ports/synthetic-master-asset-repository.ts'
import type { SyntheticSpeechSegmentRepository } from '../application/ports/synthetic-speech-segment-repository.ts'
import type { SyntheticPhaseGateRepository } from '../application/ports/synthetic-phase-gate-repository.ts'
import type { ProviderJobRepository } from '../application/ports/provider-job-repository.ts'
import type { ProviderAdapterRegistry } from '../application/ports/provider-job-runtime.ts'
import type { MaterializationAuthorizationRepository } from '../application/ports/materialization-authorization-repository.ts'
import type { MediaTransferRepository } from '../application/ports/media-transfer-repository.ts'
import type { MediaDownloadGrantRepository } from '../application/ports/media-download-grant-repository.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { MediaLibraryRepository } from '../application/ports/media-library-repository.ts'
import type { MediaSegmentRepository } from '../application/ports/media-segment-repository.ts'
import type { ImageAnalysisRepository } from '../application/ports/image-analysis-repository.ts'
import type { PerceptionTimelineRepository } from '../application/ports/perception-timeline-repository.ts'
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
import type { ReviewCleanupMaskRepository } from '../application/ports/review-cleanup-mask-repository.ts'
import type { RenderElementMapRepository } from '../application/ports/render-element-map-repository.ts'
import type { SubtitleSidecarRepository } from '../application/ports/subtitle-sidecar-repository.ts'
import type { EditorialCommandRepository } from '../application/ports/editorial-command-repository.ts'
import type { NarrativeSafetyRepository } from '../application/ports/narrative-safety-repository.ts'
import type { ManualEditRepository } from '../application/ports/manual-edit-repository.ts'
import type { SourceTranscriptReplacementRepository } from '../application/ports/source-transcript-replacement-repository.ts'
import type { VersionCompareRepository } from '../application/ports/version-compare-repository.ts'
import type { DirectorRunRepository } from '../application/ports/director-run-repository.ts'
import type { DirectorDecisionLogRepository } from '../application/ports/director-decision-log-repository.ts'
import type { DirectorBudgetRepository } from '../application/ports/director-budget-repository.ts'
import type { ProjectProxyRenderRepository } from '../application/ports/project-proxy-render-repository.ts'
import type { ProxyReviewRepository } from '../application/ports/proxy-review-repository.ts'
import type { ProjectFinalExportRepository } from '../application/ports/project-final-export-repository.ts'
import type { ExportMatrixRepository } from '../application/ports/export-matrix-repository.ts'
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
import { compileSyntheticBlockAudioService } from '../application/synthetic-block-audio-compilation.ts'
import {
  createSyntheticScriptPlanService,
  mutateSyntheticScriptPlanService,
  readSyntheticScriptPlanService,
} from '../application/synthetic-script-plans.ts'
import {
  ensureSyntheticBlockGenerationsService,
  settleSyntheticBlockGenerationsService,
} from '../application/synthetic-block-generations.ts'
import { createSyntheticAudioMasterService } from '../application/synthetic-audio-masters.ts'
import { promoteSyntheticMasterAssetService } from '../application/synthetic-master-assets.ts'
import { searchSyntheticSpeechSegmentsService } from '../application/synthetic-speech-segments.ts'
import {
  listSyntheticMasterAssetsService,
  listSyntheticSpeechSegmentsService,
  readSyntheticMasterAssetService,
} from '../application/synthetic-master-asset-queries.ts'
import {
  listSyntheticCacheDecisionsService,
  summarizeSyntheticCacheDecisionsService,
  traceSyntheticCacheDecisionsService,
} from '../application/synthetic-cache-decision-queries.ts'
import {
  listSyntheticCriticReportsService,
  readSyntheticCriticBlockEvidenceService,
  readSyntheticCriticReportService,
} from '../application/synthetic-critic-report-queries.ts'
import {
  evaluateColorCriticService,
  listColorCriticIssuesService,
  listColorCriticReportsService,
  readColorCriticReportService,
  selectRenderMatchPlan,
} from '../application/color-critic.ts'
import {
  evaluateMulticamLongformGateService,
  explainMulticamLongformGateService,
  listMulticamLongformGatesService,
  readLatestMulticamLongformGateService,
  readMulticamLongformGateService,
} from '../application/multicam-longform-gate.ts'
import type { MulticamMatchPlan } from '../domain/multicam-match-plan.ts'
import {
  addMulticamMatchRangeOverrideService,
  deriveMulticamMatchPlanService,
  readMulticamMatchPlanService,
} from '../application/multicam-color-match.ts'
import type { DeriveMulticamEvidenceDependencies } from '../application/multicam-direction.ts'
import {
  deriveMulticamEvidenceService,
  directMulticamSessionService,
  listMulticamAngleCandidatesService,
  listMulticamShotDecisionsService,
  readMulticamDirectionService,
} from '../application/multicam-direction.ts'
import { setProjectColorPlanService } from '../application/project-color-plans.ts'
import { concatenateBlockAudio } from './media/audio-concatenation.ts'
import { CaptureMediaResolver } from './media/capture-media-resolver.ts'
import { resolveFfmpegBinary, resolveFfprobeBinaryPath } from './media/ffmpeg-binary.ts'
import { FfmpegColorCriticEvaluator } from './media/ffmpeg-color-critic-evaluator.ts'
import { FfmpegColorMeasurement } from './media/ffmpeg-color-measurement.ts'
import { FfmpegAudioSyncSignalSource } from './media/ffmpeg-audio-sync-signal-source.ts'
import { createMarkerMediaAdapter } from './media/marker-media-adapter.ts'
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
import { PrismaEditorialBeatRepository } from './prisma/editorial-beat-repository.ts'
import { PrismaEvidenceSegmentRepository } from './prisma/evidence-segment-repository.ts'
import { PrismaLongFormIndexRepository } from './prisma/long-form-index-repository.ts'
import { PrismaContiguousExtractionRepository } from './prisma/contiguous-extraction-repository.ts'
import { PrismaColorPipelineCompilationRepository } from './prisma/color-pipeline-compilation-repository.ts'
import { PrismaTreatmentPlanRepository } from './prisma/treatment-plan-repository.ts'
import { PrismaCaptureProtocolRepository } from './prisma/capture-protocol-repository.ts'
import { PrismaSyncDiagnosticRepository } from './prisma/sync-diagnostic-repository.ts'
import { PrismaColorCriticReportRepository } from './prisma/color-critic-report-repository.ts'
import { FfmpegMulticamSilenceProvider } from './analysis/ffmpeg-multicam-silence-provider.ts'
import { FfmpegMulticamVisualEvidenceProvider } from './analysis/ffmpeg-multicam-visual-evidence-provider.ts'
import { PrismaMulticamDiarizationSource } from './prisma/multicam-diarization-source.ts'
import { PrismaMulticamDirectionCommandRepository } from './prisma/multicam-direction-command-repository.ts'
import { PrismaMulticamDirectionRepository } from './prisma/multicam-direction-repository.ts'

import {
  PrismaCameraColorMeasurementRepository,
  PrismaMulticamMatchPlanRepository,
} from './prisma/multicam-match-plan-repository.ts'
import { PrismaPlaybackMapRepository } from './prisma/playback-map-repository.ts'
import { PrismaRenderablePlanSnapshotRepository } from './prisma/renderable-plan-snapshot-repository.ts'
import { PrismaMulticamLongformGateRepository } from './prisma/multicam-longform-gate-repository.ts'
import { ModuleGraphLegacyRuntimeAudit } from './audit/module-graph-legacy-runtime-audit.ts'
import { PrismaRenderSourceRepository } from './prisma/render-source-repository.ts'
import { FfmpegPlaybackFingerprinter } from './media/ffmpeg-playback-fingerprint.ts'
import {
  buildReactPlaybackMapService,
  compileReactPlaybackPlanService,
  editReactPlaybackAnchorService,
  listReactPlaybackMapVersionsService,
  listReactPlaybackPiecesService,
  listReferenceDependentsService,
  readReactPlaybackMapService,
  type PlaybackMediaPort,
  type PlaybackObservationSource,
} from '../application/react-playback-map.ts'
import { compileSynthesisRenderPlanService } from '../application/compile-synthesis-to-directed-plan.ts'
import { PrismaCaptureSessionRepository } from './prisma/capture-session-repository.ts'
import { PrismaCaptureSyncRunRepository } from './prisma/capture-sync-run-repository.ts'
import { PrismaEditorialSynthesisRepository } from './prisma/editorial-synthesis-repository.ts'
import { PrismaStoryPlanRepository } from './prisma/story-plan-repository.ts'
import { PrismaWorkspaceLutRepository } from './prisma/workspace-lut-repository.ts'
import { PrismaProjectLutSelectionRepository } from './prisma/project-lut-selection-repository.ts'
import { PrismaProjectColorPlanRepository } from './prisma/project-color-plan-repository.ts'
import { PrismaProjectSubtitleConfigurationRepository } from './prisma/project-subtitle-configuration-repository.ts'
import { PrismaSubtitleSegmentOverrideRepository } from './prisma/subtitle-segment-override-repository.ts'
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
import { PrismaSyntheticProductionRepository } from './prisma/synthetic-production-repository.ts'
import { PrismaSyntheticAudioMasterRepository } from './prisma/synthetic-audio-master-repository.ts'
import { PrismaSyntheticScriptPlanRepository } from './prisma/synthetic-script-plan-repository.ts'
import { PrismaSyntheticBlockGenerationRepository } from './prisma/synthetic-block-generation-repository.ts'
import { PrismaNoveltyBudgetRepository } from './prisma/novelty-budget-repository.ts'
import { PrismaTransformationProviderRegistryRepository } from './prisma/transformation-provider-registry-repository.ts'
import { PrismaTransformationQualityRepository } from './prisma/transformation-quality-repository.ts'
import { HttpTransformationProviderAdapter } from './transformation/http-transformation-provider.ts'
import { McpTransformationProviderAdapter } from './transformation/mcp-transformation-provider.ts'
import { VerifiedTransformationResultIngestor } from './transformation/transformation-result-ingestion.ts'
import { FfmpegTransformationCriticEvaluator } from './transformation/ffmpeg-transformation-critic.ts'
import { PrismaSyntheticBlockConcatenationRepository } from './prisma/synthetic-block-concatenation-repository.ts'
import { PrismaSyntheticCacheDecisionRepository } from './prisma/synthetic-cache-decision-repository.ts'
import { PrismaSyntheticCriticReportRepository } from './prisma/synthetic-critic-report-repository.ts'
import { PrismaSyntheticCacheSubmissionClaimRepository } from './prisma/synthetic-cache-submission-claim-repository.ts'
import { PrismaSyntheticMasterAssetRepository } from './prisma/synthetic-master-asset-repository.ts'
import { PrismaSyntheticSpeechSegmentRepository } from './prisma/synthetic-speech-segment-repository.ts'
import { PrismaSyntheticPhaseGateRepository } from './prisma/synthetic-phase-gate-repository.ts'
import {
  PrismaPromotableProviderJobReader,
  PrismaStoredArtifactIdentityReader,
} from './prisma/synthetic-master-promotion-readers.ts'
import { PrismaProviderJobRepository } from './prisma/provider-job-repository.ts'
import { AuthorizedProviderSubmissionInputMaterializer } from './provider-submission-input-materializer.ts'
import { ElevenLabsTtsProviderAdapter } from './elevenlabs-tts-provider.ts'
import { HeyGenV3AsyncMediaProviderAdapter } from './heygen-v3-provider.ts'
import { PrismaProviderResultArtifactRepository } from './prisma/provider-result-artifact-repository.ts'
import {
  PersistedProviderResultCritic,
  PersistedTtsResultCritic,
  SafeProviderResultDownloader,
  VerifiedProviderResultIngestor,
  VerifiedTtsResultIngestor,
} from './provider-result-ingestion.ts'
import { PrismaMaterializationAuthorizationRepository } from './prisma/materialization-authorization-repository.ts'
import { PrismaMediaTransferRepository } from './prisma/media-transfer-repository.ts'
import { PrismaMediaDownloadGrantRepository } from './prisma/media-download-grant-repository.ts'
import { PrismaMediaArtifactRepository } from './prisma/media-artifact-repository.ts'
import { PrismaMediaLibraryRepository } from './prisma/media-library-repository.ts'
import { PrismaAutomaticCatalogRepository } from './prisma/automatic-catalog-repository.ts'
import { PrismaMediaSegmentRepository } from './prisma/media-segment-repository.ts'
import { PrismaImageAnalysisRepository } from './prisma/image-analysis-repository.ts'
import { PrismaPerceptionTimelineRepository } from './prisma/perception-timeline-repository.ts'
import { PrismaMediaArtifactLifecycleRepository } from './prisma/media-artifact-lifecycle-repository.ts'
import { PrismaProtectedRenderInputStore } from './prisma/protected-render-input-store.ts'
import { PrismaRenderInputAssetAvailability } from './prisma/render-input-asset-availability.ts'
import { PrismaProjectCreationRepository } from './prisma/project-creation-repository.ts'
import { PrismaProjectDuplicationRepository } from './prisma/project-duplication-repository.ts'
import { PrismaProjectAdministrationRepository } from './prisma/project-administration-repository.ts'
import { PrismaProjectQueryRepository } from './prisma/project-query-repository.ts'
import { PrismaProjectWorkspaceQueryRepository } from './prisma/project-workspace-query-repository.ts'
import { PrismaReviewAnnotationRepository } from './prisma/review-annotation-repository.ts'
import { PrismaReviewCleanupMaskRepository } from './prisma/review-cleanup-mask-repository.ts'
import { PrismaReviewPatchRepository } from './prisma/review-patch-repository.ts'
import { PrismaReviewPatchBatchRepository } from './prisma/review-patch-batch-repository.ts'
import { PrismaRenderElementMapRepository } from './prisma/render-element-map-repository.ts'
import { PrismaSubtitleSidecarRepository } from './prisma/subtitle-sidecar-repository.ts'
import { TemporaryFileSubtitleSidecarStaging } from './media/subtitle-sidecar-staging.ts'
import { PrismaProjectMediaRepository } from './prisma/project-media-repository.ts'
import { PrismaEditorialCommandRepository } from './prisma/editorial-command-repository.ts'
import { PrismaNarrativeSafetyRepository } from './prisma/narrative-safety-repository.ts'
import { PrismaManualEditRepository } from './prisma/manual-edit-repository.ts'
import { PrismaSourceTranscriptReplacementRepository } from './prisma/source-transcript-replacement-repository.ts'
import { PrismaVersionCompareRepository } from './prisma/version-compare-repository.ts'
import { PrismaDirectorRunRepository } from './prisma/director-run-repository.ts'
import { PrismaDirectorDecisionLogRepository } from './prisma/director-decision-log-repository.ts'
import { PrismaDirectorBudgetRepository } from './prisma/director-budget-repository.ts'
import { PrismaProjectProxyRenderRepository } from './prisma/project-proxy-render-repository.ts'
import { PrismaProxyReviewRepository } from './prisma/proxy-review-repository.ts'
import { PrismaProjectFinalExportRepository } from './prisma/project-final-export-repository.ts'
import { PrismaExportMatrixRepository } from './prisma/export-matrix-repository.ts'
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
import { createConfiguredImageVisionProvider } from './image/composite-image-vision-provider.ts'
import { inspectUploadedMedia, probeAudioDurationSeconds, probeVideo } from './media/video-probe.ts'
import {
  ArtifactContentSyntheticMasterByteVerifier,
  FfprobeSyntheticMasterDurationProber,
} from './media/synthetic-master-media.ts'
import { createFfmpegEditorialProxyRendererFromEnvironment } from './media/ffmpeg-editorial-proxy-renderer.ts'
import { LocalProjectLutRenderMaterializer } from './media/local-project-lut-render-materializer.ts'
import { createFfmpegSourceCleanupProcessorFromEnvironment } from './media/ffmpeg-source-cleanup-processor.ts'
import { createElevenLabsVoiceIsolationProviderFromEnvironment } from './elevenlabs-voice-isolation-provider.ts'
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

export function createAutomaticCatalogService(clock: () => Date = () => new Date()) {
  return catalogApprovedOutputService({
    repository: new PrismaAutomaticCatalogRepository(resolveV2Client()),
    rights: createAssetRightsRepository(),
    clock,
  })
}

export function createAutomaticCatalogRepository() {
  return new PrismaAutomaticCatalogRepository(resolveV2Client())
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

export function createEditorialBeatRepository() {
  return new PrismaEditorialBeatRepository(resolveV2Client())
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

export function createTreatmentPlanRepository(): TreatmentPlanRepository {
  return new PrismaTreatmentPlanRepository(resolveV2Client())
}

export function createStoryPlanRepository(): StoryPlanRepository {
  return new PrismaStoryPlanRepository(resolveV2Client())
}

export function createWorkspaceLutRepository(): WorkspaceLutRepository {
  return new PrismaWorkspaceLutRepository(resolveV2Client())
}

export function createProjectLutSelectionRepository(): ProjectLutSelectionRepository {
  return new PrismaProjectLutSelectionRepository(resolveV2Client())
}

export function createProjectColorPlanRepository(): ProjectColorPlanRepository {
  return new PrismaProjectColorPlanRepository(resolveV2Client())
}

export function createProjectSubtitleConfigurationRepository(): ProjectSubtitleConfigurationRepository {
  return new PrismaProjectSubtitleConfigurationRepository(resolveV2Client())
}

export function createSubtitleSegmentOverrideRepository(): SubtitleSegmentOverrideRepository {
  return new PrismaSubtitleSegmentOverrideRepository(resolveV2Client())
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

export function createSyntheticProductionRepository(): SyntheticProductionRepository {
  return new PrismaSyntheticProductionRepository(resolveV2Client())
}

export function createSyntheticPhaseGateRepository(): SyntheticPhaseGateRepository {
  return new PrismaSyntheticPhaseGateRepository(resolveV2Client())
}

export function createSyntheticAudioMasterRepository(): SyntheticAudioMasterRepository {
  return new PrismaSyntheticAudioMasterRepository(resolveV2Client())
}

export function createProviderJobRepository(): ProviderJobRepository {
  return new PrismaProviderJobRepository(resolveV2Client())
}

export function createSyntheticScriptPlanRepository(): SyntheticScriptPlanRepository {
  return new PrismaSyntheticScriptPlanRepository(resolveV2Client())
}

export function createSyntheticBlockGenerationRepository(): SyntheticBlockGenerationRepository {
  return new PrismaSyntheticBlockGenerationRepository(resolveV2Client())
}

export function createNoveltyBudgetRepository(): NoveltyBudgetRepository {
  return new PrismaNoveltyBudgetRepository(resolveV2Client())
}

export function createTransformationProviderRegistryRepository(): TransformationProviderRegistryRepository {
  return new PrismaTransformationProviderRegistryRepository(resolveV2Client())
}

export function createTransformationQualityRepository(): TransformationQualityRepository {
  return new PrismaTransformationQualityRepository(resolveV2Client())
}

export function createSyntheticBlockConcatenationRepository(): SyntheticBlockConcatenationRepository {
  return new PrismaSyntheticBlockConcatenationRepository(resolveV2Client())
}

export function createProviderResultArtifactRepository() {
  return new PrismaProviderResultArtifactRepository(resolveV2Client())
}

/** One wiring for every synthetic-script-plan route: plan commands plus the
 * per-block generation ensure/settle pipeline over the same repositories. */
export function createSyntheticScriptPlanServices(environment: NodeJS.ProcessEnv = process.env) {
  const plans = createSyntheticScriptPlanRepository()
  const projects = createProjectWorkspaceQueryRepository()
  const profiles = createSyntheticProductionRepository()
  const generations = createSyntheticBlockGenerationRepository()
  const artifacts = createMediaArtifactQueryRepository()
  const rights = createAssetRightsRepository()
  const providerJobs = createProviderJobRepository()
  const planDependencies = {
    plans, projects, profiles,
    clock: () => new Date(),
    createId: (kind: 'script-plan' | 'script-plan-version' | 'script-block') => `${kind}-${randomUUID()}`,
  }
  return {
    plans,
    generations,
    createPlan: createSyntheticScriptPlanService(planDependencies),
    mutatePlan: mutateSyntheticScriptPlanService(planDependencies),
    readPlan: readSyntheticScriptPlanService({ plans }),
    ensure: ensureSyntheticBlockGenerationsService({
      plans, generations, profiles, artifacts, rights, providerJobs,
      cacheDecisions: createSyntheticCacheDecisionRepository(),
      resultArtifacts: createProviderResultArtifactRepository(),
      criticReports: createSyntheticCriticReportRepository(),
      submissionClaims: createSyntheticCacheSubmissionClaimRepository(),
      enqueueProviderJob: enqueueProviderJobService({
        jobs: providerJobs,
        adapters: createProviderAdapterRegistry(environment),
        profiles,
        audioMasters: createSyntheticAudioMasterRepository(),
        projects,
        artifacts,
        rights,
        clock: () => new Date(),
        createJobId: () => `provider-job-${randomUUID()}`,
        createTransitionId: () => `provider-transition-${randomUUID()}`,
      }),
      clock: () => new Date(),
    }),
    settle: settleSyntheticBlockGenerationsService({
      generations,
      providerJobs,
      resultArtifacts: createProviderResultArtifactRepository(),
      clock: () => new Date(),
    }),
  }
}

export function createSyntheticMasterAssetRepository(): SyntheticMasterAssetRepository {
  return new PrismaSyntheticMasterAssetRepository(resolveV2Client())
}

export function createSyntheticCacheSubmissionClaimRepository(): SyntheticCacheSubmissionClaimRepository {
  return new PrismaSyntheticCacheSubmissionClaimRepository(resolveV2Client())
}

export function createSyntheticCacheDecisionRepository(): SyntheticCacheDecisionRepository {
  return new PrismaSyntheticCacheDecisionRepository(resolveV2Client())
}

export function createSyntheticCriticReportRepository(): SyntheticCriticReportRepository {
  return new PrismaSyntheticCriticReportRepository(resolveV2Client())
}

/** Read-only wiring for the critic evidence routes: the verdicts themselves,
 * their per-dimension measurements and the issues they localized. */
export function createSyntheticCriticReportQueryServices() {
  const reports = createSyntheticCriticReportRepository()
  return {
    reports,
    list: listSyntheticCriticReportsService({ reports }),
    read: readSyntheticCriticReportService({ reports }),
    readBlockEvidence: readSyntheticCriticBlockEvidenceService({ reports }),
  }
}

export function createSyntheticSpeechSegmentRepository(): SyntheticSpeechSegmentRepository {
  return new PrismaSyntheticSpeechSegmentRepository(resolveV2Client())
}

/** Read-only wiring for the cache decision ledger routes: the evidence of what
 * the cache reused, regenerated or blocked, and what that avoided paying. */
export function createSyntheticCacheDecisionQueryServices() {
  const decisions = createSyntheticCacheDecisionRepository()
  return {
    decisions,
    list: listSyntheticCacheDecisionsService({ decisions }),
    summarize: summarizeSyntheticCacheDecisionsService({ decisions }),
    trace: traceSyntheticCacheDecisionsService({ decisions }),
  }
}

/** One wiring for every synthetic-master route: the promotion gate plus the
 * read side over the same immutable master and speech-segment catalog. */
export function createSyntheticMasterAssetServices(environment: NodeJS.ProcessEnv = process.env) {
  const masters = createSyntheticMasterAssetRepository()
  const segments = createSyntheticSpeechSegmentRepository()
  const artifacts = createMediaArtifactQueryRepository()
  const profiles = createSyntheticProductionRepository()
  const assetRights = createAssetRightsRepository()
  return {
    masters,
    segments,
    promote: promoteSyntheticMasterAssetService({
      masters,
      jobs: new PrismaPromotableProviderJobReader(resolveV2Client()),
      resultArtifacts: createProviderResultArtifactRepository(),
      artifacts,
      profiles,
      rights: {
        async currentSnapshot(input: { workspaceId: string; artifactId: string }) {
          const current = await assetRights.findCurrent(input.workspaceId, input.artifactId)
          return current?.snapshot ?? null
        },
      },
      criticReports: createSyntheticCriticReportRepository(),
      bytes: new ArtifactContentSyntheticMasterByteVerifier(createArtifactContentStorage(environment)),
      durations: new FfprobeSyntheticMasterDurationProber(
        createArtifactSourceMaterializer(environment),
        new PrismaStoredArtifactIdentityReader(resolveV2Client()),
        environment,
      ),
      clock: () => new Date(),
      createId: () => `synthetic-master-${randomUUID()}`,
    }),
    readMaster: readSyntheticMasterAssetService({ masters }),
    listMasters: listSyntheticMasterAssetsService({ masters }),
    listSpeechSegments: listSyntheticSpeechSegmentsService({ masters, segments }),
    searchSpeechSegments: searchSyntheticSpeechSegmentsService({ segments }),
  }
}

const audioToolsRequire = createRequire(import.meta.url)

export function createSyntheticBlockAudioCompilationService(environment: NodeJS.ProcessEnv = process.env) {
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  if (!workRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Audio compilation requires APOLLO_V2_RENDER_WORK_ROOT')
  // Both binaries through the shared resolver: inside a bundled Next server the
  // *-static packages compute paths from a rewritten `__dirname` and answer
  // with files that are not on disk. This composition root knew that and said
  // so only for itself; the resolver says it for every spawn site.
  const ffmpegPath = resolveFfmpegBinary(undefined, environment)
  // `null` for the fallback: this composition root refused an unresolvable
  // ffprobe before the shared resolver existed, and it keeps refusing. The
  // resolver's bare-name last resort belongs to the callers that were written
  // against a probe which never threw; this is not one of them.
  const ffprobePath = resolveFfprobeBinaryPath(
    (audioToolsRequire('ffprobe-static') as { path?: string }).path, undefined, environment, undefined, null,
  )
  const artifacts = new PrismaMediaArtifactRepository(resolveV2Client())
  const plans = createSyntheticScriptPlanRepository()
  const projects = createProjectWorkspaceQueryRepository()
  const profiles = createSyntheticProductionRepository()
  return compileSyntheticBlockAudioService({
    plans,
    generations: createSyntheticBlockGenerationRepository(),
    profiles,
    artifacts,
    artifactPersistence: artifacts,
    rights: createAssetRightsRepository(),
    concatenations: createSyntheticBlockConcatenationRepository(),
    sources: createArtifactSourceMaterializer(environment),
    storage: createVerifiedMediaStorage(environment),
    mutatePlan: mutateSyntheticScriptPlanService({
      plans, projects, profiles, clock: () => new Date(),
      createId: (kind) => `${kind}-${randomUUID()}`,
    }),
    createAudioMaster: createSyntheticAudioMasterService({
      repository: createSyntheticAudioMasterRepository(),
      projects,
      profiles,
      providerJobs: createProviderJobRepository(),
      artifacts,
      rights: createAssetRightsRepository(),
      clock: () => new Date(),
      createId: () => `synthetic-audio-master-${randomUUID()}`,
    }),
    concatenate: (input) => concatenateBlockAudio({ ...input, ffmpegPath, ffprobePath }),
    workRoot: join(workRoot, 'block-audio-compilation'),
    clock: () => new Date(),
  })
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

export function createPerceptionTimelineRepository(): PerceptionTimelineRepository {
  return new PrismaPerceptionTimelineRepository(resolveV2Client())
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

export function createArtifactSourceMaterializer(environment: NodeJS.ProcessEnv = process.env) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  if (artifactStorageDriver(environment) === 'local') return new LocalArtifactSourceMaterializer(artifactRoot)
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  if (!workRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Render work root is required for S3 artifact materialization')
  return new S3ArtifactSourceMaterializer(workRoot, createArtifactS3ClientFromEnvironment(environment))
}

function nonNegativeInteger(value: string | undefined, field: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${field} is invalid`)
  return parsed
}

export function createProviderSubmissionInputMaterializer(environment: NodeJS.ProcessEnv = process.env) {
  return new AuthorizedProviderSubmissionInputMaterializer({
    profiles: createSyntheticProductionRepository(),
    artifacts: createMediaArtifactQueryRepository(),
    sources: createArtifactSourceMaterializer(environment),
  })
}

export function createProviderAdapterRegistry(environment: NodeJS.ProcessEnv = process.env): ProviderAdapterRegistry {
  return Object.freeze({
    get(input: { adapterId: string; adapterVersion: string }) {
      // Adapters are constructed lazily per lookup so the application boots
      // without any provider credential; a job that targets an unconfigured
      // adapter fails closed at claim time instead of at startup.
      if (input.adapterId === 'heygen-v3' && input.adapterVersion === '3.1.0') {
        return new HeyGenV3AsyncMediaProviderAdapter({
          apiKey: environment.APOLLO_V2_HEYGEN_API_KEY ?? '',
          costMinorUnitsPerMinute: nonNegativeInteger(
            environment.APOLLO_V2_HEYGEN_COST_MINOR_UNITS_PER_MINUTE,
            'HeyGen cost per minute',
          ),
        })
      }
      if (input.adapterId === 'elevenlabs-tts' && input.adapterVersion === '1.0.0') {
        return new ElevenLabsTtsProviderAdapter({
          apiKey: environment.APOLLO_V2_ELEVENLABS_API_KEY ?? '',
          costMinorUnitsPerThousandCharacters: nonNegativeInteger(
            environment.APOLLO_V2_ELEVENLABS_COST_MINOR_UNITS_PER_THOUSAND_CHARACTERS,
            'ElevenLabs cost per thousand characters',
          ),
          ...(environment.APOLLO_V2_ELEVENLABS_BASE_URL?.trim() ? { baseUrl: environment.APOLLO_V2_ELEVENLABS_BASE_URL.trim() } : {}),
          ...(environment.APOLLO_V2_ELEVENLABS_TIMEOUT_MS ? { requestTimeoutMs: nonNegativeInteger(environment.APOLLO_V2_ELEVENLABS_TIMEOUT_MS, 'ElevenLabs timeout') } : {}),
          ...(environment.APOLLO_V2_ELEVENLABS_MAX_AUDIO_BYTES ? { maxAudioBytes: nonNegativeInteger(environment.APOLLO_V2_ELEVENLABS_MAX_AUDIO_BYTES, 'ElevenLabs audio limit') } : {}),
          ...(environment.APOLLO_V2_ELEVENLABS_MAX_CHARACTERS ? { maxCharacters: nonNegativeInteger(environment.APOLLO_V2_ELEVENLABS_MAX_CHARACTERS, 'ElevenLabs text limit') } : {}),
        })
      }
      // Generative transformation providers. Every one of them is declared in
      // the persisted registry with its own adapter id; the credential and base
      // URL come from the environment so the application boots without them and
      // an unconfigured provider fails closed at claim time.
      const httpTransformation = transformationAdapterEnvironment(environment, input.adapterId)
      if (httpTransformation && input.adapterVersion === httpTransformation.adapterVersion) {
        if (httpTransformation.transport === 'mcp') {
          return new McpTransformationProviderAdapter({
            id: input.adapterId,
            adapterVersion: httpTransformation.adapterVersion,
            endpoint: httpTransformation.baseUrl,
            apiKey: httpTransformation.apiKey,
            modes: httpTransformation.modes,
          })
        }
        return new HttpTransformationProviderAdapter({
          id: input.adapterId,
          adapterVersion: httpTransformation.adapterVersion,
          baseUrl: httpTransformation.baseUrl,
          apiKey: httpTransformation.apiKey,
          completion: httpTransformation.completion,
          modes: httpTransformation.modes,
          ...(httpTransformation.callbackSecret ? { callbackSecret: httpTransformation.callbackSecret } : {}),
        })
      }
      return null
    },
  })
}

/**
 * Read one transformation provider's runtime configuration from the
 * environment. The adapter id is normalized into an env prefix so a workspace
 * can register several providers without a code change:
 *
 *   APOLLO_V2_TRANSFORMATION_<ID>_BASE_URL
 *   APOLLO_V2_TRANSFORMATION_<ID>_API_KEY
 *   APOLLO_V2_TRANSFORMATION_<ID>_COMPLETION      synchronous|polling|webhook|both|mcp
 *   APOLLO_V2_TRANSFORMATION_<ID>_MODES           comma separated
 *   APOLLO_V2_TRANSFORMATION_<ID>_CALLBACK_SECRET hex, >= 32 bytes
 *   APOLLO_V2_TRANSFORMATION_<ID>_ADAPTER_VERSION
 */
export function transformationAdapterEnvironment(environment: NodeJS.ProcessEnv, adapterId: string) {
  const prefix = `APOLLO_V2_TRANSFORMATION_${adapterId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`
  const baseUrl = environment[`${prefix}_BASE_URL`]?.trim()
  const apiKey = environment[`${prefix}_API_KEY`]?.trim()
  if (!baseUrl || !apiKey) return null
  const declared = (environment[`${prefix}_COMPLETION`]?.trim() ?? 'polling') as string
  const transport = declared === 'mcp' ? 'mcp' : 'http'
  const completion = (declared === 'mcp' ? 'polling' : declared) as 'synchronous' | 'polling' | 'webhook' | 'both'
  const secretHex = environment[`${prefix}_CALLBACK_SECRET`]?.trim()
  return Object.freeze({
    adapterVersion: environment[`${prefix}_ADAPTER_VERSION`]?.trim() || '1.0.0',
    baseUrl,
    apiKey,
    transport,
    completion,
    modes: Object.freeze((environment[`${prefix}_MODES`]?.trim() || 'video-to-video').split(',').map((mode) => mode.trim()).filter(Boolean)),
    ...(secretHex ? { callbackSecret: Buffer.from(secretHex, 'hex') } : {}),
  })
}

export function createProviderJobWorker(environment: NodeJS.ProcessEnv = process.env) {
  const workRoot = environment.APOLLO_V2_PROVIDER_WORK_ROOT?.trim()
  if (!workRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Provider result work root is required')
  const allowedHosts = (environment.APOLLO_V2_HEYGEN_RESULT_HOSTS ?? 'files.heygen.ai')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean)
  const artifactQuery = createMediaArtifactQueryRepository()
  const downloader = new SafeProviderResultDownloader({ workRoot, allowedHosts })
  const resultArtifacts = new PrismaProviderResultArtifactRepository(resolveV2Client())
  const videoIngestor = new VerifiedProviderResultIngestor({
    downloader,
    storage: createVerifiedMediaStorage(environment),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    artifactQuery,
    prober: {
      probe(sourcePath, options) {
        return probeVideo(sourcePath, { ...options, environment, requireAudio: true })
      },
    },
  })
  const ttsIngestor = new VerifiedTtsResultIngestor({
    workRoot,
    storage: createVerifiedMediaStorage(environment),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    artifactQuery,
    resultArtifacts,
    audioProber: {
      probeDurationSeconds(path, options) {
        return probeAudioDurationSeconds(path, { ...options, environment })
      },
    },
  })
  const transformationIngestor = new VerifiedTransformationResultIngestor({
    workRoot,
    storage: createVerifiedMediaStorage(environment),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    artifactQuery,
    resultArtifacts,
    prober: {
      probe(sourcePath, options) {
        return probeVideo(sourcePath, { ...options, environment, requireAudio: false })
      },
    },
  })
  const videoCritic = new PersistedProviderResultCritic(artifactQuery)
  const ttsCritic = new PersistedTtsResultCritic(artifactQuery, resultArtifacts)
  const transformationCritic = new PersistedTransformationResultCritic({
    registry: createTransformationProviderRegistryRepository(),
    quality: createTransformationQualityRepository(),
    artifacts: artifactQuery,
    novelty: createNoveltyBudgetRepository(),
    evaluator: new FfmpegTransformationCriticEvaluator({
      sources: createArtifactSourceMaterializer(environment),
      prober: {
        probe(sourcePath, options) {
          return probeVideo(sourcePath, { ...options, environment, requireAudio: false })
        },
      },
    }),
  })
  // A transformation job is recognised by the binding it carries, not by its
  // operation: operations are shared with the synthetic path, the brief is not.
  const isTransformation = (job: { transformation?: unknown }) => job.transformation !== undefined
  return runProviderJobWorkerOnce({
    jobs: createProviderJobRepository(),
    adapters: createProviderAdapterRegistry(environment),
    materializer: createProviderSubmissionInputMaterializer(environment),
    ingestor: {
      ingest(input) {
        if (isTransformation(input.job)) return transformationIngestor.ingest(input)
        return (input.job.operation === 'tts' ? ttsIngestor : videoIngestor).ingest(input)
      },
    },
    critic: {
      evaluate(input) {
        if (isTransformation(input.job)) return transformationCritic.evaluate(input)
        return (input.job.operation === 'tts' ? ttsCritic : videoCritic).evaluate(input)
      },
    },
    clock: () => new Date(),
    createLeaseToken: () => `provider-lease-${randomUUID()}`,
    createTransitionId: () => `provider-transition-${randomUUID()}`,
  })
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

export function createExportMatrixRepository(): ExportMatrixRepository {
  return new PrismaExportMatrixRepository(resolveV2Client())
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
  const imageVision = createConfiguredImageVisionProvider(environment)
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
        imageVision,
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
    perceptionTimelines: createPerceptionTimelineRepository(),
    proxyReviews: createProxyReviewRepository(),
    catalogOutput: createAutomaticCatalogService(clock),
    colorPipelines: createColorPipelineCompilationRepository(),
    colorPlans: createProjectColorPlanRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work'), createWorkspaceLutRepository()),
    // F4.014. The colour verdict is taken on the bytes this worker just wrote
    // and lands on the review it is about to persist. Assembled here because it
    // needs the three things a worker has no business knowing: where FFmpeg is,
    // where scratch space lives, and which storage driver this deployment uses.
    // Judging, locating and cleaning up arrive together, so no deployment can
    // wire the verdict and leave its intermediates behind.
    colorCritic: createColorCriticRuntime(environment, clock),
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
    catalogOutput: createAutomaticCatalogService(clock),
    artifacts: createMediaArtifactPersistenceRepository(environment),
    storage: createVerifiedMediaStorage(environment),
    renderer: createFfmpegEditorialProxyRendererFromEnvironment(environment),
    renderElementMaps: createRenderElementMapRepository(),
    colorPipelines: createColorPipelineCompilationRepository(),
    colorPlans: createProjectColorPlanRepository(),
    luts: new LocalProjectLutRenderMaterializer(createProjectLutSelectionRepository(), join(resolve(artifactRoot), '.lut-work'), createWorkspaceLutRepository()),
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
  const separationProvider =
    createElevenLabsVoiceIsolationProviderFromEnvironment(environment)
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
      createFfmpegSourceCleanupProcessorFromEnvironment(
        environment,
        separationProvider,
      ),
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

export function createReviewCleanupMaskRepository(): ReviewCleanupMaskRepository {
  return new PrismaReviewCleanupMaskRepository(resolveV2Client())
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

export function createSubtitleSidecarRepository(): SubtitleSidecarRepository {
  return new PrismaSubtitleSidecarRepository(resolveV2Client())
}

/** FR-175 — the sidecar export wired to the real storage, artifacts and staging. */
export function createSubtitleSidecarExportDependencies(
  environment: NodeJS.ProcessEnv = process.env,
) {
  return {
    sidecars: createSubtitleSidecarRepository(),
    artifacts: createMediaArtifactQueryRepository(),
    persistence: createMediaArtifactPersistenceRepository(environment),
    storage: createVerifiedMediaStorage(environment),
    staging: new TemporaryFileSubtitleSidecarStaging(),
  }
}

export function createEditorialCommandRepository(): EditorialCommandRepository {
  return new PrismaEditorialCommandRepository(resolveV2Client())
}

export function createNarrativeSafetyRepository(): NarrativeSafetyRepository {
  return new PrismaNarrativeSafetyRepository(resolveV2Client())
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

export function createDirectorDecisionLogRepository(): DirectorDecisionLogRepository {
  return new PrismaDirectorDecisionLogRepository(resolveV2Client())
}

export function createDirectorBudgetRepository(): DirectorBudgetRepository {
  return new PrismaDirectorBudgetRepository(resolveV2Client())
}

export function createWorkspaceRepository(): WorkspaceRepository {
  return new PrismaWorkspaceRepository(resolveV2Client())
}

export function createCaptureSessionRepository(): CaptureSessionRepository {
  return new PrismaCaptureSessionRepository(resolveV2Client())
}

export function createCaptureSyncRunRepository(): CaptureSyncRunRepository {
  return new PrismaCaptureSyncRunRepository(resolveV2Client())
}

export function createEditorialSynthesisRepository(): EditorialSynthesisRepository {
  return new PrismaEditorialSynthesisRepository(resolveV2Client())
}

export function createCaptureProtocolRepository(): CaptureProtocolRepository {
  return new PrismaCaptureProtocolRepository(resolveV2Client())
}

export function createSyncDiagnosticRepository(): SyncDiagnosticRepository {
  return new PrismaSyncDiagnosticRepository(resolveV2Client())
}

export function createMulticamDirectionRepository(): MulticamDirectionRepository {
  return new PrismaMulticamDirectionRepository(resolveV2Client())
}

export function createMulticamDirectionCommandRepository(): MulticamDirectionCommandRepository {
  return new PrismaMulticamDirectionCommandRepository(resolveV2Client())
}

/**
 * The persisted diarization the direction reads as speech evidence.
 *
 * This comment used to say that this factory,
 * `createMulticamDirectionCommandRepository` above and
 * `createMulticamVisualEvidenceProvider` below had no call site because no HTTP
 * route existed for `direct-multicam-session`. Two do:
 * `src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/`
 * `route.ts` and its `protected-selections/route.ts`, both through
 * `createDirectMulticamSessionService`. What was still true until phase 9 is
 * that nothing EXECUTED that assembly — see
 * `multicamDirectionCompositionDependencies` below. The adapters themselves are
 * executed on their own: the diarization source against real rows in
 * `multicam-direction.e2e.mjs`, the visual provider against real pixels in
 * `multicam-visual-evidence.integration.mjs`, the silence provider against real
 * samples in `multicam-silence-evidence.integration.mjs`.
 */
export function createMulticamDiarizationSource(): MulticamDiarizationSource {
  return new PrismaMulticamDiarizationSource(resolveV2Client())
}

/**
 * The FFmpeg pass that measures screen activity and technical quality.
 *
 * It takes paths rather than artifact keys: the caller materializes the media
 * through `createCaptureMediaResolver()` and releases it in `finally`, which is
 * where the release discipline belongs (CONTRACT §2) and what keeps this class
 * testable without an artifact store.
 */
export function createMulticamVisualEvidenceProvider(
  environment: NodeJS.ProcessEnv = process.env,
): MulticamVisualEvidenceProvider {
  const timeoutMs = Number(environment.APOLLO_V2_MULTICAM_VISUAL_TIMEOUT_MS)
  return new FfmpegMulticamVisualEvidenceProvider({
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim() ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() } : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  })
}

/**
 * The FFmpeg pass that listens for silence.
 *
 * Only the timeout and the binary are configurable. The threshold and the
 * minimum duration are the definition of the measurement, so they stay in
 * `MULTICAM_SILENCE_DEFAULTS` where a deployment cannot move them: an
 * environment variable that lowers the bar for "silent" would change what the
 * evidence says while every observation kept claiming it was measured.
 */
export function createMulticamSilenceEvidenceProvider(
  environment: NodeJS.ProcessEnv = process.env,
): MulticamSilenceEvidenceProvider {
  const timeoutMs = Number(environment.APOLLO_V2_MULTICAM_SILENCE_TIMEOUT_MS)
  return new FfmpegMulticamSilenceProvider({
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim() ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() } : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
  })
}

export function createCameraColorMeasurementRepository(): CameraColorMeasurementRepository {
  return new PrismaCameraColorMeasurementRepository(resolveV2Client())
}

export function createMulticamMatchPlanRepository(): MulticamMatchPlanRepository {
  return new PrismaMulticamMatchPlanRepository(resolveV2Client())
}

export function createColorCriticReportRepository(): ColorCriticReportRepository {
  return new PrismaColorCriticReportRepository(resolveV2Client())
}

export function createPlaybackMapRepository(): PlaybackMapRepository {
  return new PrismaPlaybackMapRepository(resolveV2Client())
}

export function createRenderablePlanSnapshotRepository(): RenderablePlanSnapshotRepository {
  return new PrismaRenderablePlanSnapshotRepository(resolveV2Client())
}

export function createMulticamLongformGateRepository(): MulticamLongformGateRepository {
  return new PrismaMulticamLongformGateRepository(resolveV2Client())
}

/**
 * Criterion 10's evidence producer (F4.016).
 *
 * A separate factory from the repository because it reads the module graph
 * rather than PostgreSQL, and because a caller that wants to scan a different
 * entry set — a worker, say — should be able to say so without a database.
 */
export function createLegacyRuntimeAudit(
  repositoryRoot: string = process.cwd(),
): LegacyRuntimeAuditPort {
  // The root is passed, not baked in. Inside `next build` webpack replaces
  // `import.meta.url` with the build machine's absolute source path, so a
  // scanner that resolved its own location froze the build directory into the
  // bundle and accused ten pure-V2 modules the moment the app ran anywhere
  // else. `process.cwd()` is the directory `next start`, `npm test` and the
  // scripts all run from.
  return new ModuleGraphLegacyRuntimeAudit({ repositoryRoot })
}

/**
 * The F4.016 phase gate, assembled.
 *
 * The signature the API lane needs: `evaluate({ workspaceId, projectId,
 * sessionId?, actor, idempotencyKey })`. Everything the evaluation reads is
 * fetched by these two dependencies; the request carries no evidence.
 */
export function createMulticamLongformGateRuntime(clock: () => Date = () => new Date()) {
  const repository = createMulticamLongformGateRepository()
  // One scanner, not two. The exposed `legacyAudit` used to be a second
  // instance the evaluation never touched, so a caller that inspected or
  // configured it changed nothing about what the gate read — and every
  // evaluation re-walked the module graph from disk twice over.
  const legacyAudit = createLegacyRuntimeAudit()
  return Object.freeze({
    repository,
    legacyAudit,
    evaluate: evaluateMulticamLongformGateService({
      repository,
      legacyAudit,
      clock,
      createId: () => `mlg-${randomUUID()}`,
    }),
    read: readMulticamLongformGateService({ repository }),
    readLatest: readLatestMulticamLongformGateService({ repository }),
    list: listMulticamLongformGatesService({ repository }),
    explain: explainMulticamLongformGateService({ repository }),
  })
}

/**
 * The durable synchronization worker, assembled (F4.004/F4.006/F4.007).
 *
 * Everything the worker needs that a route has no business knowing: which
 * storage driver materializes a capture part, where FFmpeg is, and where the
 * operator's own anchors and confirmed markers are kept. The signal source is
 * given the diagnostic repository so manual anchors and marker detections enter
 * the cascade as evidence read from the record, never as something a caller
 * could assert.
 */
export function createCaptureSyncWorker(environment: NodeJS.ProcessEnv = process.env) {
  const sessions = createCaptureSessionRepository()
  const runs = createCaptureSyncRunRepository()
  const signals = new FfmpegAudioSyncSignalSource({
    media: createCaptureMediaResolver(environment),
    diagnostics: createSyncDiagnosticRepository(),
  })
  // Read the way every sibling worker factory reads it. Without this the lease
  // was whatever the module declared and no deployment could raise it, while
  // one audio correlation at the adapter's analysis cap measures over a minute
  // of uninterruptible CPU — long enough for a second worker to reclaim the run
  // mid-flight and fail it permanently three attempts later.
  const configuredLease = Number(
    environment.APOLLO_V2_CAPTURE_SYNC_LEASE_MS ?? environment.APOLLO_V2_WORKER_LEASE_MS,
  )
  return async (owner: string) => runCaptureSyncWorker({
    sessions,
    runs,
    signals,
    owner,
    clock: () => new Date(),
    ...(Number.isSafeInteger(configuredLease) && configuredLease > 0 ? { leaseMs: configuredLease } : {}),
  })()
}

/**
 * The media side of sync markers (F4.010).
 *
 * Assembled here rather than inside a route because it needs three things the
 * route has no business knowing: where FFmpeg is, where scratch space lives,
 * and which storage driver this deployment uses.
 */
export function createMarkerMediaPort(environment: NodeJS.ProcessEnv = process.env) {
  return createMarkerMediaAdapter(createVerifiedMediaStorage(environment), environment)
}

/**
 * Turns a capture track's file into a path a detector can open.
 *
 * The materializer verifies the bytes against the artifact's recorded hash, so
 * a detector never reads a file whose identity nobody checked.
 */
export function createCaptureMediaResolver(environment: NodeJS.ProcessEnv = process.env) {
  return new CaptureMediaResolver(resolveV2Client(), createArtifactSourceMaterializer(environment))
}

/**
 * The colour critic, assembled (F4.014).
 *
 * The evaluator writes its "before" intermediates under the artifact root's
 * scratch space and promotes its evidence crops through the same verified
 * storage every other derived artifact goes through — object storage, never a
 * database column, because a crop is media.
 */
export function createColorCriticEvaluator(environment: NodeJS.ProcessEnv = process.env) {
  const artifactRoot = environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Artifact root is not configured')
  return new FfmpegColorCriticEvaluator({
    workRoot: join(resolve(artifactRoot), '.color-critic-work'),
    storage: createVerifiedMediaStorage(environment),
    ...(environment.FFMPEG_PATH?.trim() ? { ffmpegPath: environment.FFMPEG_PATH.trim() } : {}),
  })
}

/**
 * The colour critic as the render worker takes it: judge, locate, clean up.
 *
 * One object, built around one evaluator instance, because the evaluator's
 * intermediates can only be removed by the evaluator that wrote them. Splitting
 * them into separate factory calls is what let a deployment wire the judging
 * and leave a full re-encode of every source on disk after every render.
 */
export function createColorCriticRuntime(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const evaluator = createColorCriticEvaluator(environment)
  return Object.freeze({
    evaluate: evaluateColorCriticService({
      evaluator,
      reports: createColorCriticReportRepository(),
      matchPlans: createMulticamMatchPlanRepository(),
      clock,
    }),
    cleanup: (operationId: string) => evaluator.cleanup(operationId),
    locateSession: createProjectCaptureSessionLocator(),
  })
}

/**
 * Which capture session a project's colour verdict should read its reference
 * camera from.
 *
 * Not "the most recently updated head": a project can hold several capture
 * sessions, and an unrelated session touched last would hand the critic a
 * reference camera nobody approved for these frames. The session is the one
 * whose match plan knows every camera the render actually cut to, and only when
 * exactly one does — zero or several is `null`, which makes the critic report
 * the cross-camera comparison unavailable rather than measure it against a
 * guess.
 */
export function createProjectCaptureSessionLocator() {
  const sessions = createCaptureSessionRepository()
  const plans = createMulticamMatchPlanRepository()
  return async (context: {
    workspaceId: string
    projectId: string
    cameraIds: readonly string[]
  }): Promise<string | null> => {
    if (context.cameraIds.length === 0) return null
    const heads = await sessions.listHeads({
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      limit: COLOR_CRITIC_SESSION_CANDIDATE_LIMIT,
    })
    const candidates: { sessionId: string; plan: MulticamMatchPlan }[] = []
    for (const head of heads) {
      const stored = await plans.readHead({
        workspaceId: context.workspaceId,
        projectId: context.projectId,
        sessionId: head.sessionId,
      })
      if (stored) candidates.push({ sessionId: head.sessionId, plan: stored.plan })
    }
    return selectRenderMatchPlan({ cameraIds: context.cameraIds, candidates })?.sessionId ?? null
  }
}

/** How many of a project's capture sessions the locator will consider. */
const COLOR_CRITIC_SESSION_CANDIDATE_LIMIT = 25

/**
 * The multicam colour match, assembled (F4.013).
 *
 * The reference camera is a human decision the service checks for itself; every
 * number in the plan is measured here by a real instrument, and the resulting
 * layers are written into the project's ColorPlan through the same command a
 * person's edit would use.
 */
export function createDeriveMulticamMatchPlanService(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  return deriveMulticamMatchPlanService({
    sessions: createCaptureSessionRepository(),
    media: createCaptureMediaResolver(environment),
    probe: new FfmpegColorMeasurement(
      environment.FFMPEG_PATH?.trim() ? { ffmpegPath: environment.FFMPEG_PATH.trim() } : {},
    ),
    measurements: createCameraColorMeasurementRepository(),
    plans: createMulticamMatchPlanRepository(),
    criticReports: createColorCriticReportRepository(),
    colorPlans: createProjectColorPlanRepository(),
    setProjectColorPlan: createSetProjectColorPlanService(clock),
    clock,
  })
}

export function createAddMulticamMatchRangeOverrideService(clock: () => Date = () => new Date()) {
  return addMulticamMatchRangeOverrideService({
    plans: createMulticamMatchPlanRepository(),
    colorPlans: createProjectColorPlanRepository(),
    setProjectColorPlan: createSetProjectColorPlanService(clock),
    clock,
  })
}

function createSetProjectColorPlanService(clock: () => Date) {
  return setProjectColorPlanService({
    repository: createProjectColorPlanRepository(),
    luts: createWorkspaceLutRepository(),
    createId: (kind) => `${kind}-${randomUUID()}`,
    createEventId: randomUUID,
    clock,
  })
}

/**
 * The react playback map, assembled from the adapters that already exist
 * (F4.015).
 *
 * Two of the three dependencies were built in earlier slices and had no caller:
 * `CaptureMediaResolver` verifies a part's bytes against the artifact's
 * recorded hash before handing over a path, and `FfmpegPlaybackFingerprinter`
 * reports where each window of the reaction matched inside the reference. This
 * is where they meet the services — and where the compiler proves the adapters
 * satisfy the ports, which no test with a fake can.
 *
 * `workRoot` reads `APOLLO_V2_RENDER_WORK_ROOT`, the same variable the marker
 * adapter reads (`marker-media-adapter.ts:130`), so one deployment setting
 * governs the scratch directories FFmpeg writes into. Absent, the fingerprinter
 * falls back to its own `mkdtemp` — which is correct on a developer machine and
 * is why the variable is optional here rather than a refusal.
 */
export function createReactPlaybackMapServices(environment: NodeJS.ProcessEnv = process.env) {
  const repository = createPlaybackMapRepository()
  const sessions = createCaptureSessionRepository()
  const snapshots = createRenderablePlanSnapshotRepository()
  const clock = () => new Date()
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  const media: PlaybackMediaPort = createCaptureMediaResolver(environment)
  const observations: PlaybackObservationSource = new FfmpegPlaybackFingerprinter(
    workRoot ? { workRoot } : {},
  )
  return Object.freeze({
    build: buildReactPlaybackMapService({ repository, sessions, media, observations, snapshots, clock }),
    anchor: editReactPlaybackAnchorService({ repository, snapshots, clock }),
    read: readReactPlaybackMapService({ repository }),
    listVersions: listReactPlaybackMapVersionsService({ repository }),
    listReferenceDependents: listReferenceDependentsService({ repository }),
  })
}


/**
 * The multicam direction, assembled (F4.012).
 *
 * This is the composition root the phase-3 hand-off named as missing: the
 * diarization source, the visual provider and the command repository existed
 * and nothing pulled them. `MulticamPerceptionSource` still has no adapter, so
 * reaction evidence is absent rather than zero — a session nobody ran
 * perception over produces no reaction observations at all, which the direction
 * reads as "nobody measured" and answers by holding the current angle.
 *
 * The silence provider IS wired here, and that is the whole point of it being
 * here: `silence` was a modelled, validated and persisted evidence kind that no
 * adapter produced, so a production run could never emit one. `demonstration`
 * and `attention` are still in that state and cannot be lifted out of it with
 * FFmpeg — see PRD FR-150 and spec 05 §29.1, where both are recorded as not
 * delivered rather than left to look wired.
 *
 * Deliberately separate from `createMulticamDirectionReadServices` below. This
 * one builds an FFmpeg provider and a media materializer that need a configured
 * artifact root; a route that only reads a stored direction must not be able to
 * fail on a deployment setting it never uses.
 */
export function createDirectMulticamSessionService(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const { evidence, ...session } = multicamDirectionCompositionDependencies(environment, clock)
  return directMulticamSessionService({
    ...session,
    deriveEvidence: deriveMulticamEvidenceService(evidence),
    createId: (prefix: string) => `${prefix}-${randomUUID()}`,
    createEventId: randomUUID,
  })
}

/**
 * The dependency set above, built and returned instead of only being spread
 * into a closure — so that something can read it.
 *
 * This split exists because of a measured hole, not for tidiness. The whole
 * point of wiring `silence` here is "a production run could never emit one, and
 * now it can", and until this function existed nothing in the repository
 * executed the assembly that carries it: `createDirectMulticamSessionService`
 * is imported only by the two `/v1` route files, `silence` is optional on
 * `DeriveMulticamEvidenceDependencies`, and deleting the line that supplies it
 * left typecheck, both lints, every case in `tests/v2` and the silence media
 * suite green. `multicam-direction-composition.integration.mjs` now builds this
 * set and looks at the classes in it, and falsification 10 of
 * `wave20-falsification.test.mjs` refuses a source where the listening pass —
 * or the visual one, which had the same hole — has left it.
 *
 * `evidence` is a member rather than a flattened field because the two halves
 * have different readers: `directMulticamSessionService` takes the
 * repositories, `deriveMulticamEvidenceService` takes the adapters, and the
 * three things they share (`sessions`, `directions`, `clock`) are shared on
 * purpose.
 */
export function multicamDirectionCompositionDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  clock: () => Date = () => new Date(),
) {
  const directions = createMulticamDirectionRepository()
  const sessions = createCaptureSessionRepository()
  const evidence: DeriveMulticamEvidenceDependencies = {
    sessions,
    directions,
    diarization: createMulticamDiarizationSource(),
    visual: createMulticamVisualEvidenceProvider(environment),
    silence: createMulticamSilenceEvidenceProvider(environment),
    media: createCaptureMediaResolver(environment),
    clock,
  }
  return Object.freeze({
    sessions,
    diagnostics: createSyncDiagnosticRepository(),
    protocols: createCaptureProtocolRepository(),
    directions,
    commands: createMulticamDirectionCommandRepository(),
    evidence: Object.freeze(evidence),
    clock,
  })
}

/** The three reads over a stored direction. Repository only, no media. */
export function createMulticamDirectionReadServices() {
  const directions = createMulticamDirectionRepository()
  return Object.freeze({
    read: readMulticamDirectionService({ directions }),
    listCandidates: listMulticamAngleCandidatesService({ directions }),
    listShots: listMulticamShotDecisionsService({ directions }),
  })
}

/** The read over a stored match plan. Repository only, no probe. */
export function createMulticamMatchPlanReadService() {
  return readMulticamMatchPlanService({ plans: createMulticamMatchPlanRepository() })
}

/**
 * The reads over stored colour verdicts (F4.014).
 *
 * There is no `evaluate` here on purpose. The critic runs inside the proxy
 * render, where the server measures the delivered file, its sha and the clips
 * the timeline was cut from; a route that took those from a request would let a
 * caller supply the evidence for a verdict about their own render.
 */
export function createColorCriticReportReadServices() {
  const reports = createColorCriticReportRepository()
  return Object.freeze({
    list: listColorCriticReportsService({ reports }),
    read: readColorCriticReportService({ reports }),
    listIssues: listColorCriticIssuesService({ reports }),
  })
}

/**
 * The compile, assembled without a decoder (F4.015).
 *
 * Deliberately separate from `createReactPlaybackMapServices`, for the reason
 * `createMulticamDirectionReadServices` is separate from the direction runner:
 * that root builds a `CaptureMediaResolver` and an FFmpeg fingerprinter, both
 * of which refuse to be constructed without a configured artifact root, so a
 * route that only compiles a map that has already been measured would answer
 * `PERSISTENCE_NOT_CONFIGURED` on a deployment setting it never uses. Measured,
 * not guessed: the published compile route returned exactly that 503 the first
 * time it ran against a database with no media configuration.
 *
 * Compiling reads the stored map, the session it was derived under and the
 * project's media-asset links. It opens no file.
 */
export function createReactPlaybackPlanCompileService() {
  return compileReactPlaybackPlanService({
    repository: createPlaybackMapRepository(),
    sessions: createCaptureSessionRepository(),
    sources: createRenderSourceRepository(),
    snapshots: createRenderablePlanSnapshotRepository(),
    clock: () => new Date(),
  })
}

/** The two reads over a stored playback map. Repository only, no fingerprinter. */
export function createReactPlaybackMapReadServices() {
  const repository = createPlaybackMapRepository()
  return Object.freeze({
    read: readReactPlaybackMapService({ repository }),
    listPieces: listReactPlaybackPiecesService({ repository }),
  })
}
/**
 * The files a compiled plan may cut from, resolved the way the renderer will.
 *
 * Deliberately the project's media-asset links rather than `media_artifacts`
 * directly: `PrismaProjectProxyRenderRepository` resolves a plan's sources
 * through those links, so an artifact this returns is one the render path can
 * find, and one it omits is a compile-time refusal instead of a render-time one.
 */
export function createRenderSourceRepository() {
  return new PrismaRenderSourceRepository(resolveV2Client())
}

/**
 * The synthesis-to-render bridge, assembled (F4.016 condition 6).
 *
 * The synthesis is read from its own repository, the sources it cuts from are
 * measured by the server through the project's media-asset links, and the plan
 * is kept beside the synthesis. The caller brings ids and nothing else.
 */
export function createSynthesisRenderPlanService() {
  return compileSynthesisRenderPlanService({
    syntheses: createEditorialSynthesisRepository(),
    sources: createRenderSourceRepository(),
    snapshots: createRenderablePlanSnapshotRepository(),
    clock: () => new Date(),
  })
}

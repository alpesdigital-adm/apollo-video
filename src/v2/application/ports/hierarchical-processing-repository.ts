import type {
  HierarchicalAggregation,
  HierarchicalChunk,
  HierarchicalEvidenceSpan,
  HierarchicalLanguageCandidate,
  HierarchicalProcessingPlan,
  HierarchicalTierVersions,
  HierarchicalVisionObservation,
  ProcessingTier,
} from '../../domain/hierarchical-processing.ts'
import type {
  LongFormStagePersistenceFence,
} from './long-form-stage-persistence.ts'

export interface HierarchicalProcessingSourceContext {
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  durationMs: number
  probe: Readonly<{
    width: number
    height: number
    fps: number
  }>
  transcriptSegments: readonly Readonly<{
    id: number
    startMs: number
    endMs: number
    text: string
  }>[]
  catalogedVisualObservationCount: number
  rights: Readonly<{
    id: string
    status: string
    consentStatus: string
    expiresAt?: string
    consentExpiresAt?: string
  }>
  previousRun?: Readonly<PersistedHierarchicalProcessingRun>
}

export interface HierarchicalProcessingBudget {
  currency: 'USD'
  maxCostMinorUnits: number
  maxWorkingSetBytes: number
  maxElapsedMs: number
}

export interface HierarchicalTierExecution {
  tier: ProcessingTier
  sequence: number
  version: Readonly<{
    provider: string
    model: string
    version: string
  }>
  prerequisites: readonly ProcessingTier[]
  status: 'processed' | 'reused'
  reusedFromRunId?: string
  startedAt: string
  completedAt: string
  elapsedMs: number
  workingSetBytes: number
  costMinorUnits: number
  outputHash: string
}

export interface HierarchicalProcessingMeasurement {
  schemaVersion: 'hierarchical-processing-measurement/v1'
  durationMs: number
  chunkCount: number
  evidenceSpanCount: number
  processedTierCount: number
  reusedTierCount: number
  workingSetBytes: number
  cost: Readonly<{
    policyVersion: 'hierarchical-cost-policy/v1'
    currency: 'USD'
    minorUnits: number
  }>
  elapsedMs: number
  bounded: boolean
  measurementHash: string
}

export interface PersistedHierarchicalProcessingRun {
  schemaVersion: 'hierarchical-processing-run/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceTranscriptId: string
  sourceTranscriptHash: string
  durationMs: number
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  processingPolicyVersion: 'hierarchical-processing/v1'
  chunkPolicyVersion: 'overlapping-time-chunks/v1'
  chunkDurationMs: number
  overlapMs: number
  tierVersions: HierarchicalTierVersions
  previousRunId?: string
  previousRunHash?: string
  plan: Readonly<HierarchicalProcessingPlan>
  chunks: readonly Readonly<HierarchicalChunk>[]
  evidenceSpans: readonly Readonly<HierarchicalEvidenceSpan>[]
  visionObservations:
    readonly Readonly<HierarchicalVisionObservation>[]
  languageCandidates:
    readonly Readonly<HierarchicalLanguageCandidate>[]
  aggregation: Readonly<HierarchicalAggregation>
  tierExecutions: readonly Readonly<HierarchicalTierExecution>[]
  budget: Readonly<HierarchicalProcessingBudget>
  measurement: Readonly<HierarchicalProcessingMeasurement>
  physicalMaterialized: false
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  runHash: string
  active: boolean
}

export interface HierarchicalProcessingRepository {
  readSourceContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceTranscriptId: string
    previousRunId?: string
  }): Promise<Readonly<HierarchicalProcessingSourceContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedHierarchicalProcessingRun> | null>
  findRun(input: {
    workspaceId: string
    projectId: string
    runId: string
  }): Promise<Readonly<PersistedHierarchicalProcessingRun> | null>
  persist(
    run: Readonly<PersistedHierarchicalProcessingRun>,
  ): Promise<Readonly<{
    run: Readonly<PersistedHierarchicalProcessingRun>
    replayed: boolean
  }>>
  persistWithLongFormLease(input: {
    run: Readonly<PersistedHierarchicalProcessingRun>
    fence: Readonly<LongFormStagePersistenceFence>
  }): Promise<Readonly<{
    run: Readonly<PersistedHierarchicalProcessingRun>
    replayed: boolean
  }> | null>
}

import type {
  ContiguousEvaluationEvidence,
  ContiguousEvaluationEvidenceKind,
} from '../../domain/contiguous-evaluation-evidence.ts'
import type {
  ContiguousQualityDimension,
} from '../../domain/contiguous-extraction.ts'
import type {
  LongFormStagePersistenceFence,
  ProjectAnalysisExecutionContext,
} from './long-form-stage-persistence.ts'
import type {
  LongFormMomentTranscriptEvidence,
} from '../../domain/long-form-transcript-evidence.ts'

export interface ContiguousEvidenceMomentSource {
  id: string
  momentHash: string
  recommendedRangeMs: readonly [number, number]
  transcriptEvidence?:
    Readonly<LongFormMomentTranscriptEvidence>
}

export interface ContiguousEvidenceSource {
  workspaceId: string
  projectId: string
  indexRunId: string
  indexRunHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceArtifactKey?: string
  sourceArtifactByteSize?: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceDurationMs: number
  rightsSnapshotId: string
  rightsStatus: 'approved' | 'blocked'
  consentStatus: 'approved' | 'not-required' | 'blocked'
  moments: readonly Readonly<ContiguousEvidenceMomentSource>[]
}

export function portableContiguousEvidenceSource(
  source: Readonly<ContiguousEvidenceSource>,
): Readonly<Omit<
  ContiguousEvidenceSource,
  'sourceArtifactKey' | 'sourceArtifactByteSize'
>> {
  const {
    sourceArtifactKey: _sourceArtifactKey,
    sourceArtifactByteSize: _sourceArtifactByteSize,
    ...portable
  } = source
  return Object.freeze(portable)
}

export interface ContiguousEvidenceObservation {
  momentId: string
  rangeMs: readonly [number, number]
  dimensions: readonly ContiguousQualityDimension[]
  facts: Readonly<Record<string, string | number | boolean>>
}

export interface ContiguousEvidenceAnalyzer {
  identity: Readonly<{
    provider: string
    model: string
    version: string
    kind: ContiguousEvaluationEvidenceKind
  }>
  analyze(
    source: Readonly<ContiguousEvidenceSource>,
    signal: AbortSignal,
  ): Promise<readonly Readonly<ContiguousEvidenceObservation>[]>
}

export interface PersistedContiguousEvidenceRun
extends ProjectAnalysisExecutionContext {
  id: string
  workspaceId: string
  projectId: string
  sourceIndexRunId: string
  sourceIndexRunHash: string
  analyzer: ContiguousEvidenceAnalyzer['identity']
  evidence: readonly Readonly<ContiguousEvaluationEvidence>[]
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{
    type: 'api-client'
    id: string
  }>
  createdAt: string
  runHash: string
}

export interface ContiguousEvidenceRepository {
  readSource(input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    now: string
  }): Promise<Readonly<ContiguousEvidenceSource> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    sourceIndexRunId: string
    createdByClientId: string
    actorContextHash: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedContiguousEvidenceRun> | null>
  persistWithLongFormLease(input: {
    run: Readonly<PersistedContiguousEvidenceRun>
    fence: Readonly<LongFormStagePersistenceFence>
  }): Promise<Readonly<{
    run: Readonly<PersistedContiguousEvidenceRun>
    replayed: boolean
  }> | null>
}

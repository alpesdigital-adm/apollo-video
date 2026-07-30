import type {
  ContiguousEvaluationProducer,
  ContiguousQualityDimension,
  ContiguousQualityObservation,
  ContiguousSourceMoment,
} from '../../domain/contiguous-extraction.ts'
import type {
  ContiguousEvaluationEvidence,
} from '../../domain/contiguous-evaluation-evidence.ts'

export type {
  ContiguousEvaluationEvidence,
  ContiguousEvaluationEvidenceKind,
} from '../../domain/contiguous-evaluation-evidence.ts'

export interface ContiguousEvaluationMomentSource {
  id: string
  momentHash: string
  chapterId: string
  topic: string
  recommendedRangeMs: readonly [number, number]
  evidence: readonly Readonly<ContiguousEvaluationEvidence>[]
}

export interface ContiguousEvaluationSource {
  workspaceId: string
  projectId: string
  indexRunId: string
  indexRunHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  sourceDurationMs: number
  rightsSnapshotId: string
  rightsStatus: 'approved' | 'blocked'
  consentStatus: 'approved' | 'not-required' | 'blocked'
  moments: readonly Readonly<ContiguousEvaluationMomentSource>[]
}

export interface ContiguousEvaluatedDecision {
  status: 'evaluated'
  momentId: string
  objectiveTags: readonly string[]
  semanticRangeMs: readonly [number, number]
  scores: Readonly<
    Record<
      ContiguousQualityDimension,
      Readonly<ContiguousQualityObservation>
    >
  >
}

export interface ContiguousRejectedDecision {
  status: 'rejected'
  momentId: string
  reason:
    | 'NO_SEMANTIC_WINDOW'
    | 'INSUFFICIENT_TRANSCRIPT_EVIDENCE'
    | 'INSUFFICIENT_AUDIO_EVIDENCE'
    | 'INSUFFICIENT_VISUAL_EVIDENCE'
    | 'INTEGRITY_BLOCKED'
  evidenceRefs: readonly string[]
}

export type ContiguousEvaluationDecision =
  | ContiguousEvaluatedDecision
  | ContiguousRejectedDecision

export interface ContiguousEvaluationProvider {
  identity: Readonly<{
    provider: string
    model: string
    version: string
  }>
  evaluate(
    source: Readonly<ContiguousEvaluationSource>,
    signal: AbortSignal,
  ): Promise<readonly Readonly<ContiguousEvaluationDecision>[]>
}

export interface PersistedContiguousEvaluationRun {
  id: string
  workspaceId: string
  projectId: string
  sourceIndexRunId: string
  sourceIndexRunHash: string
  producer: Readonly<ContiguousEvaluationProducer>
  decisions: readonly Readonly<ContiguousEvaluationDecision>[]
  evaluations: readonly Readonly<ContiguousSourceMoment>[]
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{
    type: 'api-client'
    id: string
  }>
  createdAt: string
  runHash: string
}

export interface ContiguousEvaluationRepository {
  readSource(input: {
    workspaceId: string
    projectId: string
    indexRunId: string
    now: string
  }): Promise<Readonly<ContiguousEvaluationSource> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    sourceIndexRunId: string
    createdByClientId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedContiguousEvaluationRun> | null>
  persist(
    run: Readonly<PersistedContiguousEvaluationRun>,
  ): Promise<Readonly<{
    run: Readonly<PersistedContiguousEvaluationRun>
    replayed: boolean
  }>>
}

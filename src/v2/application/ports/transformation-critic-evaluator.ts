import type { MediaArtifactRecord } from './media-artifact-query-repository.ts'
import type { TransformationBrief } from '../../domain/transformation-brief.ts'
import type { AvatarAudioComparison } from '../../domain/avatar-output-speech-evidence.ts'
import type {
  TransformationCriticAction,
  TransformationCriticDecision,
  TransformationCriticDimension,
  TransformationCriticEvaluator as CriticEvaluatorDescriptor,
  TransformationCriticIssue,
  TransformationCriticMeasurement,
  TransformationCriticRegion,
} from '../../domain/transformation-critic-report.ts'

export interface TransformationCriticEvaluation {
  evaluators: readonly Readonly<CriticEvaluatorDescriptor>[]
  measurements: readonly Readonly<TransformationCriticMeasurement>[]
  issues: readonly Readonly<TransformationCriticIssue>[]
  hardGates: readonly TransformationCriticDimension[]
  decision: TransformationCriticDecision
  action: TransformationCriticAction
  confidenceBps: number | null
  intentScoreBps: number | null
}

export interface TransformationCriticEvaluator {
  evaluate(input: {
    brief: Readonly<TransformationBrief>
    source: Readonly<MediaArtifactRecord>
    result: Readonly<MediaArtifactRecord>
    changeRegion?: Readonly<TransformationCriticRegion>
    intentThresholdBps: number
    operationId: string
    signal?: AbortSignal
  }): Promise<Readonly<TransformationCriticEvaluation>>
}

export interface TransformationAudioPreservationEvaluator {
  compare(input: {
    sourcePath: string
    resultPath: string
    sourceStartMs: number
    sourceDurationMs: number
    signal?: AbortSignal
  }): Promise<Readonly<AvatarAudioComparison>>
}

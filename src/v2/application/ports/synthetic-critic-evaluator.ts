import type {
  SyntheticCriticDimension,
  SyntheticCriticEvaluator,
  SyntheticCriticMeasurement,
} from '../../domain/synthetic-critic-report.ts'
import type { SyntheticCriticFinding } from '../../domain/synthetic-critic-thresholds.ts'

/**
 * The bytes an evaluator is allowed to judge, named by their content address so
 * a measurement always describes the artifact the report will point at.
 */
export interface SyntheticCriticArtifactRef {
  artifactId: string
  artifactKey: string
  sha256: string
  byteSize: number
}

/**
 * What the block was approved to be. Every field is something the pipeline
 * already knows before generation; nothing here is derived from the take under
 * judgment, or the critic would be grading the answer against itself.
 */
export interface SyntheticCriticExpectation {
  durationMs: number | null
  fps: number | null
  videoCodec: string | null
  audioCodec: string | null
  audioSampleRateHz: number | null
  /** The presenter snapshot's approved avatar identity reference. */
  identityRef: string
  /** The identity reference the adapter says it rendered, when it reports one. */
  declaredIdentityRef: string | null
  /** Whether this generation stayed inside the consent and rights envelope. */
  rights: Readonly<{ withinGrantedScope: boolean; reason: string | null }>
  /**
   * The media parameters of the previously approved block of the same take.
   * Absent for the first block — the critic then has nothing to compare and
   * says so rather than inventing a baseline.
   */
  previousBlock: Readonly<{
    width: number
    height: number
    fps: number
    videoCodec: string
    audioCodec: string
    container: string
  }> | null
}

export interface SyntheticCriticSubject {
  workspaceId: string
  projectId: string
  blockId: string
  capability: string
  adapterId: string
  adapterVersion: string
  modelRef: string | null
  /** The rendered take. Null for capabilities that produce no picture. */
  video: Readonly<SyntheticCriticArtifactRef> | null
  audio: Readonly<SyntheticCriticArtifactRef> | null
  alignmentArtifactId: string | null
  /** The approved text, exactly as approved. */
  scriptText: string
  expected: Readonly<SyntheticCriticExpectation>
}

/**
 * Facts read straight off the artifact by a probe. They are shared between
 * evaluators so the file is decoded once, and they are `null` when no probe
 * could read the bytes at all.
 */
export interface SyntheticCriticMediaFacts {
  durationMs: number
  audioDurationMs: number | null
  fps: number
  frameCount: number | null
  videoCodec: string
  audioCodec: string | null
  audioSampleRateHz: number | null
  container: string
  width: number
  height: number
}

export interface SyntheticCriticEvaluationContext {
  subject: Readonly<SyntheticCriticSubject>
  /** What the probe could read. Null means the artifact did not decode. */
  media: Readonly<SyntheticCriticMediaFacts> | null
}

export interface SyntheticCriticEvaluationOutcome {
  evaluator: Readonly<SyntheticCriticEvaluator>
  /** Only the dimensions this evaluator answers for. Never a full report. */
  measurements: readonly Readonly<SyntheticCriticMeasurement>[]
  findings: readonly Readonly<SyntheticCriticFinding>[]
}

export interface SyntheticCriticDimensionEvaluator {
  readonly dimensions: readonly SyntheticCriticDimension[]
  evaluate(
    context: Readonly<SyntheticCriticEvaluationContext>,
  ): Promise<Readonly<SyntheticCriticEvaluationOutcome>>
}

/**
 * The probing evaluator runs first: it produces the shared media facts every
 * other evaluator reads, and it is the only one allowed to report that the
 * bytes did not decode.
 */
export interface SyntheticCriticMediaEvaluator extends SyntheticCriticDimensionEvaluator {
  evaluate(
    context: Readonly<SyntheticCriticEvaluationContext>,
  ): Promise<Readonly<SyntheticCriticEvaluationOutcome & { media: Readonly<SyntheticCriticMediaFacts> | null }>>
}

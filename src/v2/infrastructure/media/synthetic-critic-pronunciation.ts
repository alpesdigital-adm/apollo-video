import type {
  SyntheticCriticDimensionEvaluator,
  SyntheticCriticEvaluationContext,
  SyntheticCriticEvaluationOutcome,
} from '../../application/ports/synthetic-critic-evaluator.ts'
import type { MasterAlignmentReader } from '../../application/synthetic-speech-segments.ts'
import { DomainError } from '../../domain/errors.ts'
import type {
  SyntheticCriticDimension,
  SyntheticCriticEvaluator,
  SyntheticCriticMeasurement,
} from '../../domain/synthetic-critic-report.ts'
import type { SyntheticCriticFinding } from '../../domain/synthetic-critic-thresholds.ts'
import {
  normalizeSyntheticSpeechText,
  type SyntheticSpeechSegmentWord,
} from '../../domain/synthetic-speech-segment.ts'

export const SYNTHETIC_CRITIC_PRONUNCIATION_EVALUATOR: Readonly<SyntheticCriticEvaluator> = Object.freeze({
  id: 'alignment-pronunciation',
  version: '1.0.0',
  kind: 'measured' as const,
  scope:
    'words actually spoken, read from the persisted alignment and compared to the approved script word by word; it judges which words are there, never how they sound',
})

const DIMENSIONS: readonly SyntheticCriticDimension[] = Object.freeze(['pronunciation'])

/**
 * Above this many tokens on either side the positional diff is replaced by a
 * count comparison. A block is a sentence, so the cap is never reached in
 * practice; it exists so a malformed alignment cannot allocate an unbounded
 * matrix.
 */
const POSITIONAL_DIFF_LIMIT = 1_500

export interface SyntheticCriticWordDeviation {
  kind: 'omitted' | 'added'
  word: string
  /** Position in the approved script (omitted) or in the alignment (added). */
  index: number
  range: Readonly<{ startMs: number; endMs: number }> | null
}

/**
 * Compares the approved words to the spoken words, in order.
 *
 * The longest common subsequence is what both sides agree on; everything the
 * script has outside it was omitted, and everything the alignment has outside
 * it was added. Positions survive the comparison so an omission can be pointed
 * at instead of merely counted.
 */
export function diffSyntheticCriticWords(
  approved: readonly string[],
  spoken: readonly Readonly<SyntheticSpeechSegmentWord>[],
): readonly Readonly<SyntheticCriticWordDeviation>[] {
  const spokenTokens = spoken.map((word) => normalizeSyntheticSpeechText(word.word))
  if (approved.length > POSITIONAL_DIFF_LIMIT || spokenTokens.length > POSITIONAL_DIFF_LIMIT) {
    const counts = new Map<string, number>()
    for (const token of approved) counts.set(token, (counts.get(token) ?? 0) + 1)
    for (const token of spokenTokens) counts.set(token, (counts.get(token) ?? 0) - 1)
    const deviations: Readonly<SyntheticCriticWordDeviation>[] = []
    for (const [token, balance] of counts) {
      for (let repeat = 0; repeat < Math.abs(balance); repeat += 1) {
        deviations.push(Object.freeze({
          kind: balance > 0 ? ('omitted' as const) : ('added' as const),
          word: token,
          index: -1,
          range: null,
        }))
      }
    }
    return Object.freeze(deviations)
  }

  const rows = approved.length + 1
  const columns = spokenTokens.length + 1
  const table = new Int32Array(rows * columns)
  for (let row = approved.length - 1; row >= 0; row -= 1) {
    for (let column = spokenTokens.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] = approved[row] === spokenTokens[column]
        ? table[(row + 1) * columns + column + 1]! + 1
        : Math.max(table[(row + 1) * columns + column]!, table[row * columns + column + 1]!)
    }
  }

  const deviations: Readonly<SyntheticCriticWordDeviation>[] = []
  let row = 0
  let column = 0
  while (row < approved.length && column < spokenTokens.length) {
    if (approved[row] === spokenTokens[column]) {
      row += 1
      column += 1
      continue
    }
    if (table[(row + 1) * columns + column]! >= table[row * columns + column + 1]!) {
      deviations.push(Object.freeze({ kind: 'omitted' as const, word: approved[row]!, index: row, range: null }))
      row += 1
    } else {
      const word = spoken[column]!
      deviations.push(Object.freeze({
        kind: 'added' as const,
        word: spokenTokens[column]!,
        index: column,
        range: Object.freeze({ startMs: word.startMs, endMs: word.endMs }),
      }))
      column += 1
    }
  }
  while (row < approved.length) {
    deviations.push(Object.freeze({ kind: 'omitted' as const, word: approved[row]!, index: row, range: null }))
    row += 1
  }
  while (column < spokenTokens.length) {
    const word = spoken[column]!
    deviations.push(Object.freeze({
      kind: 'added' as const,
      word: spokenTokens[column]!,
      index: column,
      range: Object.freeze({ startMs: word.startMs, endMs: word.endMs }),
    }))
    column += 1
  }
  return Object.freeze(deviations)
}

/**
 * Measures pronunciation as "did the take say the approved words".
 *
 * This is a real measurement of the persisted alignment against the approved
 * script — it is not a phonetic model, and its scope says so. A block with no
 * alignment is not silently passed: the dimension is reported `unavailable`,
 * which is a fail-closed verdict for a capability that requires it.
 */
export class AlignmentSyntheticCriticPronunciationEvaluator implements SyntheticCriticDimensionEvaluator {
  readonly dimensions = DIMENSIONS

  private readonly alignment: MasterAlignmentReader

  constructor(dependencies: { alignment: MasterAlignmentReader }) {
    this.alignment = dependencies.alignment
  }

  async evaluate(
    context: Readonly<SyntheticCriticEvaluationContext>,
  ): Promise<Readonly<SyntheticCriticEvaluationOutcome>> {
    const subject = context.subject
    const approved = normalizeSyntheticSpeechText(subject.scriptText).split(' ').filter(Boolean)

    const unmeasured = (note: string): Readonly<SyntheticCriticEvaluationOutcome> => Object.freeze({
      evaluator: SYNTHETIC_CRITIC_PRONUNCIATION_EVALUATOR,
      measurements: Object.freeze([Object.freeze({
        dimension: 'pronunciation' as const,
        status: 'unavailable' as const,
        evaluatorId: null,
        value: null,
        unit: null,
        threshold: null,
        confidence: null,
        evidenceRefs: Object.freeze([] as readonly string[]),
        range: null,
        note,
      } as SyntheticCriticMeasurement)]),
      findings: Object.freeze([] as readonly Readonly<SyntheticCriticFinding>[]),
    })

    if (approved.length === 0) {
      return unmeasured('the approved script carries no speakable words, so nothing could be compared')
    }
    if (!subject.alignmentArtifactId) {
      return unmeasured('the block has no persisted alignment, so the spoken words could not be read')
    }

    let spoken: readonly Readonly<SyntheticSpeechSegmentWord>[]
    try {
      spoken = await this.alignment.readWords({
        workspaceId: subject.workspaceId,
        artifactId: subject.alignmentArtifactId,
      })
    } catch (error) {
      const reason = error instanceof DomainError ? error.message : 'the alignment artifact could not be read'
      return unmeasured(`the persisted alignment could not be read: ${reason}`)
    }
    if (spoken.length === 0) {
      return unmeasured('the persisted alignment carries no words, so the take could not be compared to the script')
    }

    const deviations = diffSyntheticCriticWords(approved, spoken)
    const findings = deviations.map((deviation) => Object.freeze({
      cause: deviation.kind === 'omitted' ? ('word-omitted' as const) : ('word-added' as const),
      dimension: 'pronunciation' as const,
      detail: deviation.kind === 'omitted'
        ? `the approved word "${deviation.word}" at position ${deviation.index} is not in the alignment`
        : `the alignment carries "${deviation.word}" at position ${deviation.index}, which the approved script does not`,
      range: deviation.range,
      observed: 1,
      limit: 0,
    } as SyntheticCriticFinding))

    return Object.freeze({
      evaluator: SYNTHETIC_CRITIC_PRONUNCIATION_EVALUATOR,
      measurements: Object.freeze([Object.freeze({
        dimension: 'pronunciation' as const,
        status: 'measured' as const,
        evaluatorId: SYNTHETIC_CRITIC_PRONUNCIATION_EVALUATOR.id,
        value: deviations.length,
        unit: 'word-deviations',
        threshold: null,
        // A word-by-word comparison is exact, not probable: no confidence model
        // produced a number here, so none is reported.
        confidence: null,
        evidenceRefs: Object.freeze([`artifact://${subject.alignmentArtifactId}`]),
        range: null,
        note: null,
      } as SyntheticCriticMeasurement)]),
      findings: Object.freeze(findings),
    })
  }
}

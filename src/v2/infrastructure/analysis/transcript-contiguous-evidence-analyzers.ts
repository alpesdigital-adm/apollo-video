import type {
  ContiguousEvidenceAnalyzer,
  ContiguousEvidenceSource,
} from '../../application/ports/contiguous-evidence-repository.ts'
import { DomainError } from '../../domain/errors.ts'

export const TRANSCRIPT_BOUNDARY_ANALYZER_IDENTITY =
  Object.freeze({
    provider: 'apollo',
    model: 'aligned-transcript-boundaries',
    version: '1.0.0',
    kind: 'transcript-boundary' as const,
  })

export const TRANSCRIPT_DENSITY_ANALYZER_IDENTITY =
  Object.freeze({
    provider: 'apollo',
    model: 'aligned-transcript-density',
    version: '1.0.0',
    kind: 'transcript-density' as const,
  })

function transcriptMoment(
  source: Readonly<ContiguousEvidenceSource>,
  moment: ContiguousEvidenceSource['moments'][number],
) {
  const evidence = moment.transcriptEvidence
  if (
    !evidence ||
    evidence.indexRunId !== source.indexRunId ||
    evidence.indexRunHash !== source.indexRunHash ||
    evidence.momentId !== moment.id ||
    evidence.momentHash !== moment.momentHash
  ) {
    throw new DomainError(
      'PRECONDITION_REQUIRED',
      'Contiguous transcript evidence is unavailable',
    )
  }
  return evidence
}

function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Transcript evidence analysis was aborted',
    )
  }
}

function coveredSpeechMs(
  spans: ReadonlyArray<
    Readonly<{ rangeMs: readonly [number, number] }>
  >,
): number {
  let coveredMs = 0
  let rangeStartMs = spans[0]!.rangeMs[0]
  let rangeEndMs = spans[0]!.rangeMs[1]
  for (const span of spans.slice(1)) {
    if (span.rangeMs[0] <= rangeEndMs) {
      rangeEndMs = Math.max(rangeEndMs, span.rangeMs[1])
      continue
    }
    coveredMs += rangeEndMs - rangeStartMs
    rangeStartMs = span.rangeMs[0]
    rangeEndMs = span.rangeMs[1]
  }
  return coveredMs + rangeEndMs - rangeStartMs
}

export class TranscriptBoundaryContiguousEvidenceAnalyzer
implements ContiguousEvidenceAnalyzer {
  readonly identity = TRANSCRIPT_BOUNDARY_ANALYZER_IDENTITY

  async analyze(
    source: Readonly<ContiguousEvidenceSource>,
    signal: AbortSignal,
  ) {
    assertActive(signal)
    return Object.freeze(source.moments.map((moment) => {
      assertActive(signal)
      const evidence = transcriptMoment(source, moment)
      const spans = evidence.spans
      const first = spans[0]!
      const last = spans.at(-1)!
      const gaps = spans.slice(1).map((span, index) =>
        Math.max(0, span.rangeMs[0] - spans[index]!.rangeMs[1]))
      return Object.freeze({
        momentId: moment.id,
        rangeMs: evidence.rangeMs,
        dimensions: Object.freeze([
          'selfContained',
          'integrity',
        ] as const),
        facts: Object.freeze({
          alignedStart:
            evidence.rangeMs[0] ===
              moment.recommendedRangeMs[0],
          alignedEnd:
            evidence.rangeMs[1] ===
              moment.recommendedRangeMs[1],
          startBoundaryDeltaMs:
            moment.recommendedRangeMs[0] -
              evidence.rangeMs[0],
          endBoundaryDeltaMs:
            moment.recommendedRangeMs[1] -
              evidence.rangeMs[1],
          startsWithCapitalOrNumber:
            /^[\p{Lu}\p{Lt}\p{N}]/u.test(first.text),
          endsWithTerminalPunctuation:
            /[.!?…]["'”’)]?$/u.test(last.text),
          spanCount: evidence.spanCount,
          wordCount: evidence.wordCount,
          internalGapCount:
            gaps.filter((gapMs) => gapMs > 0).length,
          maximumInternalGapMs:
            gaps.length > 0 ? Math.max(...gaps) : 0,
          evidencePreserved: true,
        }),
      })
    }))
  }
}

export class TranscriptDensityContiguousEvidenceAnalyzer
implements ContiguousEvidenceAnalyzer {
  readonly identity = TRANSCRIPT_DENSITY_ANALYZER_IDENTITY

  async analyze(
    source: Readonly<ContiguousEvidenceSource>,
    signal: AbortSignal,
  ) {
    assertActive(signal)
    return Object.freeze(source.moments.map((moment) => {
      assertActive(signal)
      const evidence = transcriptMoment(source, moment)
      const durationMs =
        evidence.rangeMs[1] - evidence.rangeMs[0]
      const speechMs = coveredSpeechMs(evidence.spans)
      return Object.freeze({
        momentId: moment.id,
        rangeMs: evidence.rangeMs,
        dimensions: Object.freeze(['density'] as const),
        facts: Object.freeze({
          spanCount: evidence.spanCount,
          wordCount: evidence.wordCount,
          durationMs,
          speechMs,
          wordsPerMinute:
            Math.round(
              evidence.wordCount * 60_000 / durationMs * 1_000,
            ) / 1_000,
          speechCoverageRatio:
            Math.round(
              Math.min(1, speechMs / durationMs) * 1_000_000,
            ) / 1_000_000,
        }),
      })
    }))
  }
}

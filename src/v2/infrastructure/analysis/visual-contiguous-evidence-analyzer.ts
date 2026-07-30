import type {
  ContiguousVisualEvidenceProvider,
} from '../../application/ports/contiguous-visual-evidence-provider.ts'
import type {
  ContiguousEvidenceAnalyzer,
  ContiguousEvidenceSource,
} from '../../application/ports/contiguous-evidence-repository.ts'
import { DomainError } from '../../domain/errors.ts'

export const VISUAL_CONTIGUOUS_EVIDENCE_ANALYZER_IDENTITY =
  Object.freeze({
    provider: 'ffmpeg',
    model: 'signalstats-black-freeze-scene',
    version: '1.0.0',
    kind: 'visual-analysis' as const,
  })

export class VisualContiguousEvidenceAnalyzer
implements ContiguousEvidenceAnalyzer {
  readonly identity =
    VISUAL_CONTIGUOUS_EVIDENCE_ANALYZER_IDENTITY
  private readonly provider:
    Readonly<ContiguousVisualEvidenceProvider>

  constructor(
    provider: Readonly<ContiguousVisualEvidenceProvider>,
  ) {
    this.provider = provider
  }

  async analyze(
    source: Readonly<ContiguousEvidenceSource>,
    signal: AbortSignal,
  ) {
    if (
      signal.aborted ||
      !source.sourceArtifactKey ||
      !source.sourceArtifactByteSize
    ) {
      throw new DomainError(
        signal.aborted
          ? 'VERSION_CONFLICT'
          : 'PRECONDITION_REQUIRED',
        signal.aborted
          ? 'Contiguous visual analysis was aborted'
          : 'Contiguous visual source bytes are unavailable',
      )
    }
    const measurements = await this.provider.measure({
      sourceArtifactKey: source.sourceArtifactKey,
      sourceArtifactSha256: source.sourceArtifactSha256,
      sourceArtifactByteSize: source.sourceArtifactByteSize,
      sourceDurationMs: source.sourceDurationMs,
      windows: Object.freeze(source.moments.map((moment) =>
        Object.freeze({
          momentId: moment.id,
          rangeMs: moment.recommendedRangeMs,
        }))),
      signal,
    })
    if (
      signal.aborted ||
      measurements.length !== source.moments.length ||
      new Set(measurements.map((item) => item.momentId)).size !==
        measurements.length
    ) {
      throw new DomainError(
        signal.aborted
          ? 'VERSION_CONFLICT'
          : 'RENDER_OUTPUT_INVALID',
        signal.aborted
          ? 'Contiguous visual analysis was aborted'
          : 'Contiguous visual measurement is incomplete',
      )
    }
    return Object.freeze(source.moments.map((moment) => {
      const measurement = measurements.find(
        (candidate) => candidate.momentId === moment.id,
      )
      if (
        !measurement ||
        measurement.rangeMs[0] !==
          moment.recommendedRangeMs[0] ||
        measurement.rangeMs[1] !==
          moment.recommendedRangeMs[1]
      ) {
        throw new DomainError(
          'RENDER_OUTPUT_INVALID',
          'Contiguous visual measurement range changed',
        )
      }
      return Object.freeze({
        momentId: moment.id,
        rangeMs: measurement.rangeMs,
        dimensions: Object.freeze(['visual'] as const),
        facts: Object.freeze({
          durationMs: measurement.durationMs,
          sampledFrameCount: measurement.sampledFrameCount,
          averageLuma: measurement.averageLuma,
          averageSaturation: measurement.averageSaturation,
          averageTemporalDifference:
            measurement.averageTemporalDifference,
          temporalOutlierRatio:
            measurement.temporalOutlierRatio,
          repeatedPixelRatio: measurement.repeatedPixelRatio,
          broadcastRangeViolationRatio:
            measurement.broadcastRangeViolationRatio,
          blackDurationMs: measurement.blackDurationMs,
          blackRatio: measurement.blackRatio,
          freezeDurationMs: measurement.freezeDurationMs,
          freezeRatio: measurement.freezeRatio,
          sceneChangeCount: measurement.sceneChangeCount,
          sourceChecksumVerified: true,
        }),
      })
    }))
  }
}

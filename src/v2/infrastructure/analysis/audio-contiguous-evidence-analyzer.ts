import type {
  ContiguousAudioEvidenceProvider,
} from '../../application/ports/contiguous-audio-evidence-provider.ts'
import type {
  ContiguousEvidenceAnalyzer,
  ContiguousEvidenceSource,
} from '../../application/ports/contiguous-evidence-repository.ts'
import { DomainError } from '../../domain/errors.ts'

export const AUDIO_CONTIGUOUS_EVIDENCE_ANALYZER_IDENTITY =
  Object.freeze({
    provider: 'ffmpeg',
    model: 'ebur128-volumedetect-silencedetect',
    version: '1.0.0',
    kind: 'audio-analysis' as const,
  })

export class AudioContiguousEvidenceAnalyzer
implements ContiguousEvidenceAnalyzer {
  readonly identity =
    AUDIO_CONTIGUOUS_EVIDENCE_ANALYZER_IDENTITY
  private readonly provider:
    Readonly<ContiguousAudioEvidenceProvider>

  constructor(
    provider: Readonly<ContiguousAudioEvidenceProvider>,
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
          ? 'Contiguous audio analysis was aborted'
          : 'Contiguous audio source bytes are unavailable',
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
          ? 'Contiguous audio analysis was aborted'
          : 'Contiguous audio measurement is incomplete',
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
          'Contiguous audio measurement range changed',
        )
      }
      return Object.freeze({
        momentId: moment.id,
        rangeMs: measurement.rangeMs,
        dimensions: Object.freeze(['audio'] as const),
        facts: Object.freeze({
          durationMs: measurement.durationMs,
          integratedLufs: measurement.integratedLufs,
          truePeakDbfs: measurement.truePeakDbfs,
          meanVolumeDb: measurement.meanVolumeDb,
          maximumVolumeDb: measurement.maximumVolumeDb,
          silenceDurationMs: measurement.silenceDurationMs,
          silenceRatio: measurement.silenceRatio,
          audibleSignal: measurement.audibleSignal,
          clippingRisk: measurement.clippingRisk,
          sourceChecksumVerified: true,
        }),
      })
    }))
  }
}

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'

import type { ArtifactSourceMaterializer } from '../../application/ports/media-ingest.ts'
import type {
  SyntheticCriticArtifactRef,
  SyntheticCriticEvaluationContext,
  SyntheticCriticEvaluationOutcome,
  SyntheticCriticMediaEvaluator,
  SyntheticCriticMediaFacts,
} from '../../application/ports/synthetic-critic-evaluator.ts'
import { DomainError } from '../../domain/errors.ts'
import type {
  SyntheticCriticDimension,
  SyntheticCriticEvaluator,
  SyntheticCriticMeasurement,
} from '../../domain/synthetic-critic-report.ts'
import type { SyntheticCriticFinding } from '../../domain/synthetic-critic-thresholds.ts'
import { probeAudioDurationSeconds, probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const execFileAsync = promisify(execFile)
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
/** A dead signal that covers this much of the take is a dead take, not a pause. */
const DEAD_TAKE_RATIO = 0.99
const FPS_TOLERANCE = 0.01

export const SYNTHETIC_CRITIC_MEDIA_EVALUATOR: Readonly<SyntheticCriticEvaluator> = Object.freeze({
  id: 'ffprobe-media-integrity',
  version: '1.0.0',
  kind: 'measured' as const,
  scope:
    'duration, frame rate, frame count, codecs, sample rate, audio presence, silence and freeze windows read from the artifact itself with ffprobe and ffmpeg',
})

const DIMENSIONS: readonly SyntheticCriticDimension[] = Object.freeze([
  'temporal-integrity',
  'audiovisual-integrity',
])

interface DetectedWindow {
  startMs: number
  endMs: number
}

interface StreamDetails {
  frameCount: number | null
  audioSampleRateHz: number | null
  audioCodec: string | null
  /** The audio stream's own duration, which is not the container's duration. */
  audioStreamSeconds: number | null
  hasAudioStream: boolean
}

function resolveFfprobe(environment: NodeJS.ProcessEnv): string {
  const configured = environment.FFPROBE_PATH?.trim()
  if (configured) return configured
  const bundled = typeof ffprobeStatic?.path === 'string' ? ffprobeStatic.path.trim() : ''
  return bundled || 'ffprobe'
}

function resolveFfmpeg(environment: NodeJS.ProcessEnv): string {
  return environment.APOLLO_V2_FFMPEG_PATH?.trim() || environment.FFMPEG_PATH?.trim() || ffmpegStatic || 'ffmpeg'
}

function finiteNumber(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function milliseconds(seconds: number): number {
  return Math.round(seconds * 1_000)
}

/**
 * Reads the entries `probeVideo` does not project: the declared frame count and
 * the audio sample rate. Both are optional in real containers, so an absent
 * value stays absent instead of becoming a zero that would look measured.
 */
async function probeStreamDetails(
  filePath: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<Readonly<StreamDetails>> {
  let stdout: string
  try {
    ({ stdout } = await execFileAsync(resolveFfprobe(environment), [
      '-v', 'error',
      '-show_entries', 'stream=codec_type,codec_name,nb_frames,sample_rate,channels,duration',
      '-of', 'json',
      filePath,
    ], { windowsHide: true, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, signal, encoding: 'utf8' }))
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Critic stream probe failed')
  }
  let payload: { streams?: Array<Record<string, unknown>> }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new DomainError('RENDER_OUTPUT_INVALID', 'Critic stream probe returned invalid JSON')
  }
  const video = payload.streams?.find((stream) => stream.codec_type === 'video')
  const audio = payload.streams?.find((stream) => stream.codec_type === 'audio')
  return Object.freeze({
    frameCount: finiteNumber(video?.nb_frames),
    audioSampleRateHz: finiteNumber(audio?.sample_rate),
    audioCodec: typeof audio?.codec_name === 'string' ? audio.codec_name.trim() : null,
    audioStreamSeconds: finiteNumber(audio?.duration),
    hasAudioStream: Boolean(audio),
  })
}

function collectWindows(report: string, marker: string, durationMs: number): readonly DetectedWindow[] {
  const windows: DetectedWindow[] = []
  let open: number | null = null
  const pattern = new RegExp(`${marker}_(start|end):\\s*(-?[0-9]+(?:\\.[0-9]+)?)`, 'g')
  for (const match of report.matchAll(pattern)) {
    const at = Math.max(0, milliseconds(Number(match[2])))
    if (match[1] === 'start') {
      open = at
      continue
    }
    if (open !== null && at > open) windows.push({ startMs: open, endMs: Math.min(at, durationMs) })
    open = null
  }
  // ffmpeg omits the closing marker when the condition holds to the last frame.
  if (open !== null && durationMs > open) windows.push({ startMs: open, endMs: durationMs })
  return windows
}

function coveredMilliseconds(windows: readonly DetectedWindow[]): number {
  const sorted = [...windows].sort((left, right) => left.startMs - right.startMs)
  let covered = 0
  let cursor = -1
  for (const window of sorted) {
    const start = Math.max(window.startMs, cursor)
    if (window.endMs > start) {
      covered += window.endMs - start
      cursor = window.endMs
    }
  }
  return covered
}

/**
 * Measures temporal and audiovisual integrity against the bytes themselves.
 *
 * Everything reported here was read from the artifact: ffprobe answers for the
 * timeline and the codecs, and a single ffmpeg pass with `silencedetect` and
 * `freezedetect` answers for whether the take carries a live signal. Nothing is
 * estimated — when the file does not decode, the evaluator says the bytes are
 * undecodable and leaves the timeline unmeasured rather than guessing it.
 */
export class FfprobeSyntheticCriticMediaEvaluator implements SyntheticCriticMediaEvaluator {
  readonly dimensions = DIMENSIONS

  private readonly sources: ArtifactSourceMaterializer
  private readonly environment: NodeJS.ProcessEnv

  constructor(dependencies: {
    sources: ArtifactSourceMaterializer
    environment?: NodeJS.ProcessEnv
  }) {
    this.sources = dependencies.sources
    this.environment = dependencies.environment ?? process.env
  }

  private async materialize(operationId: string, artifact: Readonly<SyntheticCriticArtifactRef>): Promise<string> {
    const materialized = await this.sources.materialize({
      operationId,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize: artifact.byteSize,
    })
    if (!isAbsolute(materialized.path)) {
      throw new DomainError('INVALID_ARGUMENT', 'Materialized critic artifact path must be absolute')
    }
    return materialized.path
  }

  private async detectDeadSignal(
    filePath: string,
    durationMs: number,
    hasVideo: boolean,
    hasAudio: boolean,
  ): Promise<Readonly<{ silence: readonly DetectedWindow[]; freeze: readonly DetectedWindow[] }>> {
    if (!hasVideo && !hasAudio) return Object.freeze({ silence: [], freeze: [] })
    const filters = [
      ...(hasAudio ? ['-af', 'silencedetect=noise=-50dB:d=0.5'] : []),
      ...(hasVideo ? ['-vf', 'freezedetect=noise=-60dB:duration=0.5'] : []),
    ]
    let report: string
    try {
      const { stderr } = await execFileAsync(resolveFfmpeg(this.environment), [
        '-nostdin', '-hide_banner', '-nostats', '-v', 'info',
        '-i', filePath,
        ...filters,
        '-f', 'null', '-',
      ], { windowsHide: true, timeout: DEFAULT_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' })
      report = stderr
    } catch (error) {
      // A detector that could not run must not be reported as "no dead signal".
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        `Critic signal detection failed: ${(error as Error).message}`,
      )
    }
    return Object.freeze({
      silence: hasAudio ? collectWindows(report, 'silence', durationMs) : [],
      freeze: hasVideo ? collectWindows(report, 'freeze', durationMs) : [],
    })
  }

  async evaluate(
    context: Readonly<SyntheticCriticEvaluationContext>,
  ): Promise<Readonly<SyntheticCriticEvaluationOutcome & { media: Readonly<SyntheticCriticMediaFacts> | null }>> {
    const subject = context.subject
    const target = subject.video ?? subject.audio
    if (!target) {
      throw new DomainError('INVALID_ARGUMENT', 'A critic subject must carry the bytes it is judged on')
    }
    const expected = subject.expected
    const evidence = Object.freeze([`artifact://${target.artifactId}`])
    const findings: Readonly<SyntheticCriticFinding>[] = []
    const operationId = `synthetic-critic-probe-${randomUUID()}`

    let media: Readonly<SyntheticCriticMediaFacts> | null = null
    let deadSignal: Readonly<{ silence: readonly DetectedWindow[]; freeze: readonly DetectedWindow[] }> | null = null
    let undecodable: string | null = null

    try {
      const filePath = await this.materialize(operationId, target)
      try {
        const details = await probeStreamDetails(filePath, this.environment)
        if (subject.video) {
          const probe = await probeVideo(filePath, { environment: this.environment, requireAudio: false })
          // The audio timeline must come from the audio itself. Reading the
          // container duration twice would make every offset zero by
          // construction, which is a measurement that cannot fail — and
          // therefore is not a measurement.
          const separateAudio = subject.audio && subject.audio.artifactId !== subject.video.artifactId
            ? await this.materialize(operationId, subject.audio)
            : null
          const audioDurationMs = separateAudio
            ? milliseconds(await probeAudioDurationSeconds(separateAudio, { environment: this.environment }))
            : details.audioStreamSeconds !== null
              ? milliseconds(details.audioStreamSeconds)
              : null
          media = Object.freeze({
            durationMs: milliseconds(probe.duration),
            audioDurationMs,
            fps: probe.fps,
            frameCount: details.frameCount,
            videoCodec: probe.codec,
            audioCodec: details.audioCodec,
            audioSampleRateHz: details.audioSampleRateHz,
            container: probe.container,
            width: probe.width,
            height: probe.height,
          })
        } else {
          const audioSeconds = await probeAudioDurationSeconds(filePath, { environment: this.environment })
          const audioDurationMs = milliseconds(audioSeconds)
          media = Object.freeze({
            durationMs: audioDurationMs,
            audioDurationMs,
            fps: 0,
            frameCount: null,
            videoCodec: '',
            audioCodec: details.audioCodec,
            audioSampleRateHz: details.audioSampleRateHz,
            container: '',
            width: 0,
            height: 0,
          })
        }
        deadSignal = await this.detectDeadSignal(
          filePath,
          media.durationMs,
          Boolean(subject.video),
          details.hasAudioStream,
        )
      } catch (error) {
        if (error instanceof DomainError && error.code === 'RENDER_EXECUTION_FAILED') throw error
        undecodable = error instanceof Error ? error.message : 'the artifact could not be decoded'
      }
    } finally {
      await this.sources.cleanup(operationId).catch(() => undefined)
    }

    const measurements: Readonly<SyntheticCriticMeasurement>[] = []

    if (!media || !deadSignal) {
      findings.push(Object.freeze({
        cause: 'blob-undecodable' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `${target.artifactId} (sha256 ${target.sha256}) did not decode: ${undecodable ?? 'unknown probe failure'}`,
        range: null,
        observed: 0,
        limit: 1,
      }))
      // The bytes are unreadable, so neither dimension has a number. Saying so
      // is the honest answer; a zero here would read as a passing measurement.
      for (const dimension of DIMENSIONS) {
        measurements.push(Object.freeze({
          dimension,
          status: 'unavailable' as const,
          evaluatorId: null,
          value: null,
          unit: null,
          threshold: null,
          confidence: null,
          evidenceRefs: Object.freeze([] as readonly string[]),
          range: null,
          note: 'the artifact did not decode, so nothing could be measured from it',
        }))
      }
      return Object.freeze({
        evaluator: SYNTHETIC_CRITIC_MEDIA_EVALUATOR,
        measurements: Object.freeze(measurements),
        findings: Object.freeze(findings),
        media: null,
      })
    }

    // --- temporal integrity -------------------------------------------------
    if (expected.durationMs === null) {
      measurements.push(Object.freeze({
        dimension: 'temporal-integrity' as const,
        status: 'unavailable' as const,
        evaluatorId: null,
        value: null,
        unit: null,
        threshold: null,
        confidence: null,
        evidenceRefs: Object.freeze([] as readonly string[]),
        range: null,
        note: 'the block declares no expected duration, so there is nothing to measure the take against',
      }))
    } else {
      // The drift is the number; whether it is too much is the policy's call,
      // not this evaluator's.
      measurements.push(Object.freeze({
        dimension: 'temporal-integrity' as const,
        status: 'measured' as const,
        evaluatorId: SYNTHETIC_CRITIC_MEDIA_EVALUATOR.id,
        value: Math.abs(media.durationMs - expected.durationMs),
        unit: 'ms-drift',
        threshold: null,
        // ffprobe reports a reading, not a probability; there is no confidence
        // model behind it, so none is claimed.
        confidence: null,
        evidenceRefs: evidence,
        range: null,
        note: null,
      }))
    }

    if (expected.fps !== null && media.fps > 0 && Math.abs(media.fps - expected.fps) > FPS_TOLERANCE) {
      findings.push(Object.freeze({
        cause: 'frame-rate-mismatch' as const,
        dimension: 'temporal-integrity' as const,
        detail: `measured ${media.fps.toFixed(3)}fps against an expected ${expected.fps.toFixed(3)}fps`,
        range: null,
        observed: media.fps,
        limit: expected.fps,
      }))
    }
    if (media.frameCount !== null && media.fps > 0) {
      const implied = Math.round((media.durationMs / 1_000) * media.fps)
      if (Math.abs(media.frameCount - implied) > 1) {
        findings.push(Object.freeze({
          cause: 'frame-count-mismatch' as const,
          dimension: 'temporal-integrity' as const,
          detail: `the container declares ${media.frameCount} frames but ${media.durationMs}ms at ${media.fps.toFixed(3)}fps implies ${implied}`,
          range: null,
          observed: media.frameCount,
          limit: implied,
        }))
      }
    }
    if (
      expected.audioSampleRateHz !== null &&
      media.audioSampleRateHz !== null &&
      media.audioSampleRateHz !== expected.audioSampleRateHz
    ) {
      findings.push(Object.freeze({
        cause: 'sample-rate-mismatch' as const,
        dimension: 'temporal-integrity' as const,
        detail: `measured ${media.audioSampleRateHz}Hz against an expected ${expected.audioSampleRateHz}Hz`,
        range: null,
        observed: media.audioSampleRateHz,
        limit: expected.audioSampleRateHz,
      }))
    }
    for (const [label, measured, wanted] of [
      ['video codec', media.videoCodec, expected.videoCodec],
      ['audio codec', media.audioCodec, expected.audioCodec],
    ] as const) {
      if (wanted !== null && measured !== null && measured !== '' && measured !== wanted) {
        findings.push(Object.freeze({
          cause: 'codec-mismatch' as const,
          dimension: 'temporal-integrity' as const,
          detail: `measured ${label} ${measured} against an expected ${wanted}`,
          range: null,
          observed: null,
          limit: null,
        }))
      }
    }

    // --- audiovisual integrity ---------------------------------------------
    const silentMs = coveredMilliseconds(deadSignal.silence)
    const frozenMs = coveredMilliseconds(deadSignal.freeze)
    const audioMissing = media.audioCodec === null
    const wholeTake = Math.max(1, media.durationMs) * DEAD_TAKE_RATIO
    const audioDead = audioMissing || silentMs >= wholeTake
    const videoDead = Boolean(subject.video) && frozenMs >= wholeTake
    const live = audioDead || videoDead ? 0 : 1

    measurements.push(Object.freeze({
      dimension: 'audiovisual-integrity' as const,
      status: 'measured' as const,
      evaluatorId: SYNTHETIC_CRITIC_MEDIA_EVALUATOR.id,
      value: live,
      unit: 'live-signal',
      threshold: null,
      confidence: null,
      evidenceRefs: evidence,
      range: null,
      note: null,
    }))

    if (audioMissing) {
      findings.push(Object.freeze({
        cause: 'audio-track-missing' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `${target.artifactId} carries no audio stream at all`,
        range: null,
        observed: 0,
        limit: 1,
      }))
    } else if (silentMs >= wholeTake) {
      findings.push(Object.freeze({
        cause: 'audio-silent' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `${silentMs}ms of the ${media.durationMs}ms take is below -50dB`,
        range: Object.freeze({ startMs: 0, endMs: Math.max(1, media.durationMs) }),
        observed: silentMs,
        limit: 0,
      }))
    } else {
      findings.push(...deadSignal.silence.map((window) => Object.freeze({
        cause: 'audio-silence-window' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `audio below -50dB between ${window.startMs}ms and ${window.endMs}ms`,
        range: Object.freeze({ ...window }),
        observed: window.endMs - window.startMs,
        limit: null,
      })))
    }

    if (videoDead) {
      findings.push(Object.freeze({
        cause: 'video-frozen' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `${frozenMs}ms of the ${media.durationMs}ms take shows no motion`,
        range: Object.freeze({ startMs: 0, endMs: Math.max(1, media.durationMs) }),
        observed: frozenMs,
        limit: 0,
      }))
    } else {
      findings.push(...deadSignal.freeze.map((window) => Object.freeze({
        cause: 'video-freeze-window' as const,
        dimension: 'audiovisual-integrity' as const,
        detail: `no motion between ${window.startMs}ms and ${window.endMs}ms`,
        range: Object.freeze({ ...window }),
        observed: window.endMs - window.startMs,
        limit: null,
      })))
    }

    return Object.freeze({
      evaluator: SYNTHETIC_CRITIC_MEDIA_EVALUATOR,
      measurements: Object.freeze(measurements),
      findings: Object.freeze(findings),
      media,
    })
  }
}

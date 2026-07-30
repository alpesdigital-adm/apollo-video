import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { stat } from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { promisify } from 'node:util'

import type {
  ContiguousAudioEvidenceMeasurement,
  ContiguousAudioEvidenceProvider,
} from '../../application/ports/contiguous-audio-evidence-provider.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from '../media/local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const BYTE_SIZE = /^[1-9][0-9]{0,18}$/
const MEASUREMENT_FLOOR_DB = -120
const SILENCE_THRESHOLD_DB = -40
const SILENCE_MINIMUM_SECONDS = 0.35

function contained(root: string, candidate: string): boolean {
  const nested = relative(root, candidate)
  return !nested.startsWith('..') && !isAbsolute(nested)
}

function artifactPath(root: string, artifactKey: string): string {
  if (
    !artifactKey ||
    artifactKey.length > 512 ||
    artifactKey.startsWith('/') ||
    artifactKey.includes('\\') ||
    artifactKey.split('/').some(
      (part) => !part || part === '.' || part === '..',
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous audio artifact key is invalid',
    )
  }
  const candidate = join(root, ...artifactKey.split('/'))
  if (!contained(root, candidate)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Contiguous audio artifact escaped storage',
    )
  }
  return candidate
}

function rounded(value: number, decimals = 3): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

function lastMetric(
  output: string,
  pattern: RegExp,
  field: string,
): number {
  const matches = [...output.matchAll(pattern)]
  const raw = matches.at(-1)?.[1]
  if (!raw) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      `FFmpeg contiguous audio ${field} is unavailable`,
    )
  }
  if (raw === '-inf') return MEASUREMENT_FLOOR_DB
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      `FFmpeg contiguous audio ${field} is invalid`,
    )
  }
  return rounded(Math.max(MEASUREMENT_FLOOR_DB, value))
}

function silenceDurationMs(output: string, durationMs: number): number {
  const durations = [...output.matchAll(
    /silence_duration:\s*([0-9]+(?:\.[0-9]+)?)/g,
  )].map((match) => Number(match[1]))
  if (durations.some((duration) => !Number.isFinite(duration))) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'FFmpeg contiguous audio silence evidence is invalid',
    )
  }
  return Math.min(
    durationMs,
    Math.max(
      0,
      Math.round(
        durations.reduce((total, duration) => total + duration, 0) *
          1_000,
      ),
    ),
  )
}

function validateInput(
  input: Parameters<ContiguousAudioEvidenceProvider['measure']>[0],
): void {
  if (
    !HASH.test(input.sourceArtifactSha256) ||
    !BYTE_SIZE.test(input.sourceArtifactByteSize) ||
    !Number.isSafeInteger(input.sourceDurationMs) ||
    input.sourceDurationMs < 1_000 ||
    input.sourceDurationMs > 43_200_000 ||
    !Array.isArray(input.windows) ||
    input.windows.length === 0 ||
    input.windows.length > 10_000 ||
    new Set(input.windows.map((window) => window.momentId)).size !==
      input.windows.length ||
    input.windows.some((window) =>
      !ID.test(window.momentId) ||
      !Array.isArray(window.rangeMs) ||
      window.rangeMs.length !== 2 ||
      !Number.isSafeInteger(window.rangeMs[0]) ||
      !Number.isSafeInteger(window.rangeMs[1]) ||
      window.rangeMs[0] < 0 ||
      window.rangeMs[1] <= window.rangeMs[0] ||
      window.rangeMs[1] > input.sourceDurationMs,
    )
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Contiguous audio measurement input is invalid',
    )
  }
}

export class FfmpegContiguousAudioEvidenceProvider
implements ContiguousAudioEvidenceProvider {
  private readonly artifactRoot: string
  private readonly ffmpegPath: string
  private readonly timeoutMs: number

  constructor(options: {
    artifactRoot: string
    ffmpegPath?: string
    timeoutMs?: number
  }) {
    this.artifactRoot = resolve(options.artifactRoot.trim())
    this.ffmpegPath =
      options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    if (
      !options.artifactRoot.trim() ||
      !isAbsolute(this.artifactRoot) ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 10_000 ||
      this.timeoutMs > 60 * 60_000
    ) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Contiguous audio measurement is not configured',
      )
    }
  }

  async measure(
    input: Parameters<ContiguousAudioEvidenceProvider['measure']>[0],
  ): ReturnType<ContiguousAudioEvidenceProvider['measure']> {
    validateInput(input)
    if (input.signal.aborted) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Contiguous audio measurement was cancelled',
      )
    }
    const source = artifactPath(
      this.artifactRoot,
      input.sourceArtifactKey,
    )
    const metadata = await stat(source).catch(() => null)
    if (
      !metadata?.isFile() ||
      metadata.size.toString() !== input.sourceArtifactByteSize
    ) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Contiguous audio source bytes were not found',
      )
    }
    if (
      await calculateFileSha256(source) !==
        input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Contiguous audio source checksum does not match the catalog',
      )
    }

    const measurements: ContiguousAudioEvidenceMeasurement[] = []
    for (const window of input.windows) {
      if (input.signal.aborted) {
        throw new DomainError(
          'VERSION_CONFLICT',
          'Contiguous audio measurement was cancelled',
        )
      }
      const durationMs = window.rangeMs[1] - window.rangeMs[0]
      let stderr: string
      try {
        const result = await execFileAsync(
          this.ffmpegPath,
          [
            '-hide_banner',
            '-nostats',
            '-loglevel',
            'info',
            '-ss',
            (window.rangeMs[0] / 1_000).toFixed(3),
            '-t',
            (durationMs / 1_000).toFixed(3),
            '-i',
            source,
            '-map',
            '0:a:0',
            '-af',
            `ebur128=peak=true:framelog=quiet,volumedetect,silencedetect=noise=${SILENCE_THRESHOLD_DB}dB:d=${SILENCE_MINIMUM_SECONDS}`,
            '-f',
            'null',
            '-',
          ],
          {
            windowsHide: true,
            timeout: this.timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
            signal: input.signal,
            encoding: 'utf8',
          },
        )
        stderr = result.stderr
      } catch {
        throw new DomainError(
          input.signal.aborted
            ? 'VERSION_CONFLICT'
            : 'RENDER_EXECUTION_FAILED',
          input.signal.aborted
            ? 'Contiguous audio measurement was cancelled'
            : 'FFmpeg contiguous audio measurement failed',
        )
      }
      const integratedLufs = lastMetric(
        stderr,
        /\bI:\s*(-inf|-?[0-9]+(?:\.[0-9]+)?)\s+LUFS/g,
        'integrated loudness',
      )
      const truePeakDbfs = lastMetric(
        stderr,
        /\bPeak:\s*(-inf|-?[0-9]+(?:\.[0-9]+)?)\s+dBFS/g,
        'true peak',
      )
      const meanVolumeDb = lastMetric(
        stderr,
        /mean_volume:\s*(-inf|-?[0-9]+(?:\.[0-9]+)?)\s+dB/g,
        'mean volume',
      )
      const maximumVolumeDb = lastMetric(
        stderr,
        /max_volume:\s*(-inf|-?[0-9]+(?:\.[0-9]+)?)\s+dB/g,
        'maximum volume',
      )
      const silentMs = silenceDurationMs(stderr, durationMs)
      measurements.push(Object.freeze({
        momentId: window.momentId,
        rangeMs: Object.freeze([...window.rangeMs]) as
          readonly [number, number],
        durationMs,
        integratedLufs,
        truePeakDbfs,
        meanVolumeDb,
        maximumVolumeDb,
        silenceDurationMs: silentMs,
        silenceRatio: rounded(silentMs / durationMs, 6),
        audibleSignal:
          meanVolumeDb > -70 && silentMs < durationMs,
        clippingRisk:
          truePeakDbfs >= -0.1 || maximumVolumeDb >= -0.1,
      }))
    }
    if (
      await calculateFileSha256(source) !==
        input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Contiguous audio source changed during measurement',
      )
    }
    return Object.freeze(measurements)
  }
}

export function createFfmpegContiguousAudioEvidenceProviderFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const artifactRoot =
    environment.APOLLO_V2_ARTIFACT_ROOT?.trim()
  if (!artifactRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Artifact root is not configured',
    )
  }
  const timeoutMs = Number(
    environment.APOLLO_V2_CONTIGUOUS_AUDIO_TIMEOUT_MS,
  )
  return new FfmpegContiguousAudioEvidenceProvider({
    artifactRoot,
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim()
      ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() }
      : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
  })
}

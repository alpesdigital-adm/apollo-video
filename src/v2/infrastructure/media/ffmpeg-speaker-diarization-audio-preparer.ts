import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat } from 'node:fs/promises'
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path'
import { promisify } from 'node:util'

import type {
  SpeakerDiarizationAudioPreparer,
} from '../../application/ports/speaker-diarization-audio-preparer.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const ffprobeStatic = require('ffprobe-static') as { path?: string }
const execFileAsync = promisify(execFile)

const AUDIO_CONFIGURATION = Object.freeze({
  schemaVersion: 'speaker-diarization-audio-preparation/v1',
  codec: 'libmp3lame',
  bitrate: '24k',
  channels: 1,
  sampleRateHz: 16_000,
  variableBitrate: false,
})

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function safeDirectory(root: string, operationId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(operationId)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Diarization operation ID is invalid',
    )
  }
  const directory = join(root, operationId)
  if (!contained(root, directory)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Diarization work path escaped its root',
    )
  }
  return directory
}

function sourcePath(root: string, artifactKey: string): string {
  if (
    artifactKey.startsWith('/') ||
    artifactKey.includes('\\') ||
    artifactKey.split('/').some(
      (part) => !part || part === '.' || part === '..',
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Diarization source artifact key is invalid',
    )
  }
  const candidate = join(root, ...artifactKey.split('/'))
  if (!contained(root, candidate)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Diarization source escaped artifact storage',
    )
  }
  return candidate
}

async function probeAudio(input: {
  ffprobePath: string
  audioPath: string
  signal: AbortSignal
  timeoutMs: number
}) {
  let stdout: string
  try {
    const result = await execFileAsync(
      input.ffprobePath,
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration,format_name:stream=codec_type,codec_name,channels,sample_rate',
        '-of',
        'json',
        input.audioPath,
      ],
      {
        windowsHide: true,
        timeout: Math.min(input.timeoutMs, 10 * 60_000),
        maxBuffer: 2 * 1024 * 1024,
        signal: input.signal,
        encoding: 'utf8',
      },
    )
    stdout = result.stdout
  } catch {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Prepared diarization audio could not be inspected',
    )
  }
  let payload: {
    streams?: Array<Record<string, unknown>>
    format?: Record<string, unknown>
  }
  try {
    payload = JSON.parse(stdout) as typeof payload
  } catch {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Prepared diarization audio probe is invalid',
    )
  }
  const audio = payload.streams?.find(
    (stream) => stream.codec_type === 'audio',
  )
  const durationMs = Math.round(
    Number(payload.format?.duration) * 1_000,
  )
  if (
    audio?.codec_name !== 'mp3' ||
    Number(audio.channels) !== AUDIO_CONFIGURATION.channels ||
    Number(audio.sample_rate) !==
      AUDIO_CONFIGURATION.sampleRateHz ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1_000 ||
    typeof payload.format?.format_name !== 'string' ||
    !payload.format.format_name.split(',').includes('mp3')
  ) {
    throw new DomainError(
      'RENDER_OUTPUT_INVALID',
      'Prepared diarization audio metadata is invalid',
    )
  }
  return durationMs
}

export class FfmpegSpeakerDiarizationAudioPreparer
implements SpeakerDiarizationAudioPreparer {
  private readonly artifactRoot: string
  private readonly workRoot: string
  private readonly ffmpegPath: string
  private readonly ffprobePath: string
  private readonly timeoutMs: number

  constructor(options: {
    artifactRoot: string
    workRoot: string
    ffmpegPath?: string
    ffprobePath?: string
    timeoutMs?: number
  }) {
    this.artifactRoot = resolve(options.artifactRoot.trim())
    this.workRoot = resolve(options.workRoot.trim())
    this.ffmpegPath =
      options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
    this.ffprobePath =
      options.ffprobePath?.trim() ||
      ffprobeStatic?.path?.trim() ||
      'ffprobe'
    this.timeoutMs = options.timeoutMs ?? 90 * 60_000
    if (
      !options.artifactRoot.trim() ||
      !isAbsolute(this.artifactRoot) ||
      !options.workRoot.trim() ||
      !isAbsolute(this.workRoot) ||
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 60_000 ||
      this.timeoutMs > 12 * 60 * 60_000
    ) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'Diarization audio preparation is not configured',
      )
    }
  }

  async prepare(
    input: Parameters<
      SpeakerDiarizationAudioPreparer['prepare']
    >[0],
  ) {
    if (
      !/^[a-f0-9]{64}$/.test(input.sourceArtifactSha256) ||
      input.sourceArtifactByteSize < BigInt(1) ||
      !Number.isSafeInteger(input.expectedDurationMs) ||
      input.expectedDurationMs < 1_000 ||
      input.expectedDurationMs > 43_200_000
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Diarization source identity is invalid',
      )
    }
    const source = sourcePath(
      this.artifactRoot,
      input.sourceArtifactKey,
    )
    const metadata = await stat(source).catch(() => null)
    if (
      !metadata?.isFile() ||
      BigInt(metadata.size) !== input.sourceArtifactByteSize
    ) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Diarization source bytes were not found',
      )
    }
    if (
      await calculateFileSha256(source) !==
      input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Diarization source checksum does not match the catalog',
      )
    }
    const directory = safeDirectory(
      this.workRoot,
      input.operationId,
    )
    const audioPath = join(directory, 'provider-input.mp3')
    await mkdir(directory, { recursive: true })
    await rm(audioPath, { force: true })
    try {
      await execFileAsync(
        this.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          source,
          '-vn',
          '-map',
          '0:a:0',
          '-ac',
          String(AUDIO_CONFIGURATION.channels),
          '-ar',
          String(AUDIO_CONFIGURATION.sampleRateHz),
          '-c:a',
          AUDIO_CONFIGURATION.codec,
          '-b:a',
          AUDIO_CONFIGURATION.bitrate,
          audioPath,
        ],
        {
          windowsHide: true,
          timeout: this.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
          signal: input.signal,
        },
      )
    } catch {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        input.signal.aborted
          ? 'Diarization audio preparation was cancelled'
          : 'FFmpeg diarization audio preparation failed',
      )
    }
    const [output, durationMs, sourceShaAfter] =
      await Promise.all([
        stat(audioPath),
        probeAudio({
          ffprobePath: this.ffprobePath,
          audioPath,
          signal: input.signal,
          timeoutMs: this.timeoutMs,
        }),
        calculateFileSha256(source),
      ])
    if (
      !output.isFile() ||
      output.size < 1 ||
      output.size > 512 * 1024 * 1024 ||
      Math.abs(durationMs - input.expectedDurationMs) > 3_000 ||
      sourceShaAfter !== input.sourceArtifactSha256
    ) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Prepared diarization audio failed integrity validation',
      )
    }
    return Object.freeze({
      audioPath,
      sha256: await calculateFileSha256(audioPath),
      byteSize: output.size,
      durationMs,
      preparation: Object.freeze({
        toolId: 'ffmpeg',
        toolVersion: 'ffmpeg-static-5.3.0',
        configurationHash:
          calculateCanonicalHash(AUDIO_CONFIGURATION),
      }),
    })
  }

  async cleanup(operationId: string): Promise<void> {
    await rm(
      safeDirectory(this.workRoot, operationId),
      { recursive: true, force: true },
    )
  }
}

export function createFfmpegSpeakerDiarizationAudioPreparerFromEnvironment(
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
  const workRoot =
    environment.APOLLO_V2_DIARIZATION_WORK_ROOT?.trim() ||
    join(resolve(artifactRoot), '.work', 'diarization')
  const timeoutMs = Number(
    environment.APOLLO_V2_DIARIZATION_PREPARATION_TIMEOUT_MS,
  )
  return new FfmpegSpeakerDiarizationAudioPreparer({
    artifactRoot,
    workRoot,
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim()
      ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() }
      : {}),
    ...(environment.FFPROBE_PATH?.trim()
      ? { ffprobePath: environment.FFPROBE_PATH.trim() }
      : {}),
    ...(Number.isSafeInteger(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
  })
}

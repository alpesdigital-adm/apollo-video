import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

import type {
  SourceCleanupProcessor,
} from '../../application/ports/source-cleanup-processor.ts'
import { DomainError } from '../../domain/errors.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { probeVideo } from './video-probe.ts'

const require = createRequire(import.meta.url)
const ffmpegStatic = require('ffmpeg-static') as string | null
const execFileAsync = promisify(execFile)

function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Source cleanup work path escaped its root',
    )
  }
}

function evenFloor(value: number, minimum = 2): number {
  return Math.max(minimum, Math.floor(value / 2) * 2)
}

function boundedCoordinate(
  value: number,
  size: number,
  maximum: number,
): number {
  return Math.max(0, Math.min(maximum - size, evenFloor(value, 0)))
}

export class FfmpegSourceCleanupProcessor
implements SourceCleanupProcessor {
  private readonly workRoot: string
  private readonly ffmpegPath: string

  constructor(options: {
    workRoot: string
    ffmpegPath?: string
  }) {
    this.workRoot = resolve(options.workRoot)
    this.ffmpegPath =
      options.ffmpegPath?.trim() || ffmpegStatic || 'ffmpeg'
  }

  private directory(operationId: string): string {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
        .test(operationId)
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'operationId is invalid',
      )
    }
    const directory = join(this.workRoot, operationId)
    assertContained(this.workRoot, directory)
    return directory
  }

  async process(
    input: Parameters<SourceCleanupProcessor['process']>[0],
  ) {
    if (
      !isAbsolute(input.sourcePath) ||
      !Number.isSafeInteger(input.sourceDurationMs) ||
      input.sourceDurationMs < 1
    ) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        'Source cleanup processing input is invalid',
      )
    }
    const sourceProbe = await probeVideo(input.sourcePath, {
      signal: input.signal,
      requireAudio: false,
    })
    const directory = this.directory(input.operationId)
    const outputPath = join(directory, 'cleaned-source.mp4')
    await mkdir(directory, { recursive: true })
    await rm(outputPath, { force: true })

    const action = input.action
    if (
      !['trim', 'crop-reframe', 'cover'].includes(action.strategy)
    ) {
      throw new DomainError(
        'INVALID_RENDER_INPUT',
        'Rejected source cleanup plans cannot be rendered',
      )
    }
    const args = ['-hide_banner', '-loglevel', 'error', '-y']
    let expectedDurationMs = input.sourceDurationMs
    let residualQuality = 1
    let videoFilter = 'setsar=1,format=yuv420p'
    if (action.strategy === 'trim') {
      const startSeconds = action.keepRangeMs[0] / 1_000
      const durationSeconds =
        (action.keepRangeMs[1] - action.keepRangeMs[0]) / 1_000
      if (
        startSeconds < 0 ||
        durationSeconds <= 0 ||
        action.keepRangeMs[1] > input.sourceDurationMs
      ) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          'Source cleanup trim range is invalid',
        )
      }
      args.push(
        '-ss',
        startSeconds.toFixed(6),
        '-t',
        durationSeconds.toFixed(6),
      )
      expectedDurationMs = Math.round(durationSeconds * 1_000)
      residualQuality =
        expectedDurationMs / input.sourceDurationMs
    }
    args.push('-i', input.sourcePath)
    if (action.strategy === 'crop-reframe') {
      const width = evenFloor(
        action.crop.width * sourceProbe.width,
      )
      const height = evenFloor(
        action.crop.height * sourceProbe.height,
      )
      const x = boundedCoordinate(
        action.crop.x * sourceProbe.width,
        width,
        sourceProbe.width,
      )
      const y = boundedCoordinate(
        action.crop.y * sourceProbe.height,
        height,
        sourceProbe.height,
      )
      if (
        width > sourceProbe.width ||
        height > sourceProbe.height
      ) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          'Source cleanup crop is outside the source frame',
        )
      }
      videoFilter =
        `crop=${width}:${height}:${x}:${y},` +
        `scale=${evenFloor(sourceProbe.width)}:` +
        `${evenFloor(sourceProbe.height)}:flags=lanczos,` +
        'setsar=1,format=yuv420p'
      residualQuality = action.crop.width * action.crop.height
    }
    if (action.strategy === 'cover') {
      const width = evenFloor(
        action.region.width * sourceProbe.width,
      )
      const height = evenFloor(
        action.region.height * sourceProbe.height,
      )
      const x = boundedCoordinate(
        action.region.x * sourceProbe.width,
        width,
        sourceProbe.width,
      )
      const y = boundedCoordinate(
        action.region.y * sourceProbe.height,
        height,
        sourceProbe.height,
      )
      const start = (action.rangeMs[0] / 1_000).toFixed(6)
      const end = (action.rangeMs[1] / 1_000).toFixed(6)
      const color = `0x${action.color.slice(1)}`
      videoFilter =
        `drawbox=x=${x}:y=${y}:w=${width}:h=${height}:` +
        `color=${color}:t=fill:enable='between(t,${start},${end})',` +
        'setsar=1,format=yuv420p'
      residualQuality = Math.max(
        0,
        1 - action.region.width * action.region.height * 1.5,
      )
    }
    args.push(
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-vf',
      videoFilter,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-ar',
      '48000',
      '-movflags',
      '+faststart',
      outputPath,
    )
    try {
      await execFileAsync(this.ffmpegPath, args, {
        windowsHide: true,
        timeout: 30 * 60_000,
        maxBuffer: 2 * 1024 * 1024,
        signal: input.signal,
      })
    } catch (error) {
      if (input.signal?.aborted) {
        throw new DomainError(
          'RENDER_EXECUTION_FAILED',
          'Source cleanup render was aborted',
        )
      }
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        'FFmpeg source cleanup failed',
        { cause: error instanceof Error ? error.message : 'unknown' },
      )
    }
    const probe = await probeVideo(outputPath, {
      signal: input.signal,
      requireAudio: false,
    })
    const toleranceMs = Math.max(
      250,
      Math.ceil(2_000 / Math.max(1, sourceProbe.fps)),
    )
    const durationAligned =
      Math.abs(probe.duration * 1_000 - expectedDurationMs) <=
      toleranceMs
    const framingPreserved =
      probe.width === sourceProbe.width &&
      probe.height === sourceProbe.height
    const outputPlayable =
      probe.width > 0 &&
      probe.height > 0 &&
      probe.duration > 0 &&
      probe.fps > 0
    const contaminationRemoved =
      action.strategy === 'trim'
        ? durationAligned
        : framingPreserved
    const reasonCodes = [
      ...(!outputPlayable ? ['OUTPUT_NOT_PLAYABLE'] : []),
      ...(!durationAligned ? ['OUTPUT_DURATION_MISMATCH'] : []),
      ...(!framingPreserved ? ['OUTPUT_FRAMING_CHANGED'] : []),
      ...(!contaminationRemoved
        ? ['CONTAMINATION_REMOVAL_NOT_VERIFIED']
        : []),
    ]
    const outputStat = await stat(outputPath)
    if (!outputStat.isFile() || outputStat.size <= 0) {
      throw new DomainError(
        'RENDER_OUTPUT_INVALID',
        'Source cleanup output is empty',
      )
    }
    return Object.freeze({
      outputPath,
      sha256: await calculateFileSha256(outputPath),
      byteSize: outputStat.size,
      probe: Object.freeze(probe),
      visual: Object.freeze({
        passed:
          outputPlayable &&
          durationAligned &&
          framingPreserved &&
          contaminationRemoved,
        contaminationRemoved,
        outputPlayable,
        durationAligned,
        framingPreserved,
        residualQuality: Number(
          Math.max(0, Math.min(1, residualQuality)).toFixed(4),
        ),
        reasonCodes: Object.freeze(reasonCodes),
      }),
    })
  }

  async cleanup(operationId: string): Promise<void> {
    const directory = this.directory(operationId)
    await rm(directory, { recursive: true, force: true })
  }
}

export function createFfmpegSourceCleanupProcessorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const workRoot =
    environment.APOLLO_V2_SOURCE_CLEANUP_WORK_ROOT?.trim() ||
    environment.APOLLO_V2_RENDER_OUTPUT_ROOT?.trim()
  if (!workRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Source cleanup work storage is not configured',
    )
  }
  return new FfmpegSourceCleanupProcessor({
    workRoot,
    ...(environment.APOLLO_V2_FFMPEG_PATH?.trim()
      ? { ffmpegPath: environment.APOLLO_V2_FFMPEG_PATH.trim() }
      : {}),
  })
}

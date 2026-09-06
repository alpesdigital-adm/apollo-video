import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import type { ColorMetadata, ColorTransform, resolveColorPlan } from '../../domain/color-and-export.ts'
import type { CameraColorMeasurement } from '../../domain/color-measurement.ts'
import { DomainError } from '../../domain/errors.ts'
import { createTickInterval } from '../../domain/session-time.ts'
import { colorCriticSourceKey } from '../../application/ports/color-critic-evaluator.ts'
import type {
  ColorCriticEvaluator,
  ColorCriticEvidenceCrop,
  ColorCriticSourceRef,
  ColorCriticStageMeasurements,
  ColorCriticSubjectClip,
} from '../../application/ports/color-critic-evaluator.ts'
import type { VerifiedMediaStorage } from '../../application/ports/media-ingest.ts'
import { FfmpegColorMeasurement } from './ffmpeg-color-measurement.ts'
import { FfmpegColorPipelineProcessor } from './ffmpeg-color-pipeline-processor.ts'
import { calculateFileSha256 } from './local-artifact-manifest.ts'
import { resolveFfmpegBinary } from './ffmpeg-binary.ts'

const execFileAsync = promisify(execFile)

type ResolvedPipeline = Readonly<ReturnType<typeof resolveColorPlan>>

/**
 * Both sides of the output transform, measured with real FFmpeg (F4.014).
 *
 * The renderer's colour pre-pass writes one whole-file intermediate per
 * (source × pipelineHash) and throws it away with the scratch directory
 * (`ffmpeg-editorial-proxy-renderer.ts:528-553`), so "before the output
 * transform" is not a file anybody can be handed. This adapter re-runs the same
 * chain with the `output` stage disabled and measures that. Measuring the
 * delivered file twice and reporting the difference as zero would have been the
 * cheaper lie.
 *
 * The disabled stage is built here rather than asked for, and its pipeline hash
 * is recomputed over the modified content, because `assertResolvedExecution`
 * recomputes it too: a pipeline whose hash did not cover its own stages would
 * be a pipeline anybody could edit between the plan and the render.
 *
 * Evidence crops are single frames scaled to 320 px wide, promoted into
 * content-addressed object storage. They exist so a person can see what the
 * critic saw; they are deliberately not a second master and deliberately not
 * database rows.
 */

export const COLOR_CRITIC_EVALUATOR_VERSION = '1.0.0' as const
export const COLOR_CRITIC_CROP_WIDTH = 320
/** Frames aimed at per measured range; matches the probe's confidence target. */
const TARGET_SAMPLES = 8
const MIN_SAMPLE_EVERY_MS = 20
const MAX_SAMPLE_EVERY_MS = 250
const DEFAULT_TIMEOUT_MS = 120_000

function assertContained(root: string, candidate: string): void {
  const normalizedRoot = resolve(root)
  const normalized = resolve(candidate)
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}${normalizedRoot.endsWith('\\') || normalizedRoot.endsWith('/') ? '' : '/'}`) &&
      !normalized.startsWith(`${normalizedRoot}\\`)) {
    throw new DomainError('INVALID_RENDER_INPUT', 'Colour critic work path escaped its root')
  }
}

/**
 * The same pipeline with its output transform switched off.
 *
 * The disabled stage keeps the identity of the one it replaces — same id, same
 * provider, same version — so the two pipelines are recognisably the same
 * chain, and it declares `mode: 'identity'` with input equal to output, which
 * is what the processor and `createColorPlan` both require of a bypass.
 */
export function pipelineWithoutOutputTransform(pipeline: ResolvedPipeline): ResolvedPipeline {
  const stages = pipeline.stages
  if (stages.length !== 4 || stages.map((stage) => stage.kind).join('>') !== 'technical>match>creative-lut>output') {
    throw new DomainError('INVALID_RENDER_INPUT', 'Colour critic needs the canonical four-stage pipeline')
  }
  const creative = stages[2]!
  const output = stages[3]!
  const metadata: Readonly<ColorMetadata> = creative.output
  const parameters = Object.freeze({ mode: 'identity' as const })
  const bypass: Readonly<ColorTransform> = Object.freeze({
    id: output.id,
    kind: 'output' as const,
    version: output.version,
    enabled: false,
    input: metadata,
    output: metadata,
    implementation: Object.freeze({
      provider: output.implementation.provider,
      version: output.implementation.version,
      parameters,
      parametersHash: calculateCanonicalHash(parameters),
    }),
  })
  const transforms = Object.freeze([stages[0]!, stages[1]!, creative, bypass])
  const content = Object.freeze({
    schemaVersion: 'resolved-color-pipeline/v1' as const,
    sourceMetadata: pipeline.sourceMetadata,
    outputMetadata: metadata,
    stages: transforms,
    target: pipeline.target,
  })
  return Object.freeze({
    ...content,
    manifestKey: transforms
      .map((item) => `${item.kind}:${item.id}@${item.version}:${item.implementation.parametersHash}`)
      .join('>'),
    pipelineHash: calculateCanonicalHash(content),
  }) as ResolvedPipeline
}

/** One clip per camera — the longest one, which is the most of that camera anybody sees. */
function representativeClips(
  clips: readonly Readonly<ColorCriticSubjectClip>[],
): readonly Readonly<ColorCriticSubjectClip>[] {
  const byCamera = new Map<string, Readonly<ColorCriticSubjectClip>>()
  for (const clip of clips) {
    if (clip.timelineOutFrame <= clip.timelineInFrame || clip.sourceOutFrame <= clip.sourceInFrame) continue
    const held = byCamera.get(clip.cameraId)
    const length = clip.timelineOutFrame - clip.timelineInFrame
    if (!held || length > held.timelineOutFrame - held.timelineInFrame) byCamera.set(clip.cameraId, clip)
  }
  return Object.freeze([...byCamera.values()].sort((left, right) => left.cameraId.localeCompare(right.cameraId)))
}

function sampleEveryMs(frames: number, fps: number): number {
  const durationMs = (frames / fps) * 1_000
  return Math.min(MAX_SAMPLE_EVERY_MS, Math.max(MIN_SAMPLE_EVERY_MS, Math.floor(durationMs / TARGET_SAMPLES) || MIN_SAMPLE_EVERY_MS))
}

/**
 * Infrastructure class in the repository's plain-`node` style: fields are
 * declared and assigned in the constructor, never as parameter properties.
 */
export class FfmpegColorCriticEvaluator implements ColorCriticEvaluator {
  private readonly workRoot: string
  private readonly ffmpegPath: string
  private readonly storage: VerifiedMediaStorage
  private readonly processor: FfmpegColorPipelineProcessor
  private readonly measurement: FfmpegColorMeasurement
  private readonly timeoutMs: number

  constructor(options: {
    workRoot: string
    storage: VerifiedMediaStorage
    ffmpegPath?: string
    timeoutMs?: number
  }) {
    this.workRoot = resolve(options.workRoot)
    this.storage = options.storage
    this.ffmpegPath = resolveFfmpegBinary(options.ffmpegPath)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.processor = new FfmpegColorPipelineProcessor(
      options.ffmpegPath?.trim() ? { ffmpegPath: options.ffmpegPath.trim() } : {},
    )
    this.measurement = new FfmpegColorMeasurement(
      options.ffmpegPath?.trim() ? { ffmpegPath: options.ffmpegPath.trim() } : {},
    )
  }

  private directory(operationId: string): string {
    const directory = join(this.workRoot, `color-critic-${operationId}`)
    assertContained(this.workRoot, directory)
    return directory
  }

  async measureStages(input: {
    workspaceId: string
    operationId: string
    fps: number
    clips: readonly Readonly<ColorCriticSubjectClip>[]
    sources: readonly Readonly<ColorCriticSourceRef>[]
    deliveredPath: string
    deliveredArtifactId: string
    deliveredSha256: string
    lutPaths?: Readonly<Record<string, string>>
    signal?: AbortSignal
  }): Promise<Readonly<ColorCriticStageMeasurements>> {
    if (!isAbsolute(input.deliveredPath)) {
      throw new DomainError('INVALID_RENDER_INPUT', 'Colour critic delivered path must be absolute')
    }
    const directory = this.directory(input.operationId)
    await mkdir(directory, { recursive: true })
    const clips = representativeClips(input.clips)
    if (clips.length === 0) {
      throw new DomainError(
        'COLOR_MEASUREMENT_INSUFFICIENT',
        'No clip of the delivered timeline names both a camera and a forward frame range',
      )
    }
    // Keyed by (source × pipelineHash), the key the renderer's colour pre-pass
    // dedups its own executions by: a per-segment override gives two clips of
    // one file two different chains, and each is a different "before".
    const sourcesByKey = new Map(
      input.sources.map((source) => [colorCriticSourceKey(source.artifactId, source.pipeline.pipelineHash), source]),
    )
    const before: Readonly<CameraColorMeasurement>[] = []
    const after: Readonly<CameraColorMeasurement>[] = []
    const evidence: Readonly<ColorCriticEvidenceCrop>[] = []
    // One intermediate per (source × pipeline), reused by every clip cut from it
    // through the same chain: the colour chain is a whole-file pre-pass, so
    // running it once per clip would burn the same seconds again for the same
    // bytes.
    const intermediates = new Map<string, Readonly<{ path: string; sha256: string; fps: number }>>()

    for (const [ordinal, clip] of clips.entries()) {
      const sourceKey = colorCriticSourceKey(clip.sourceArtifactId, clip.pipelineHash)
      const source = sourcesByKey.get(sourceKey)
      if (!source) {
        throw new DomainError(
          'INVALID_RENDER_INPUT',
          `Clip ${clip.clipId} names source ${clip.sourceArtifactId} under pipeline ${clip.pipelineHash}, which was not materialized for this render`,
        )
      }
      let intermediate = intermediates.get(sourceKey)
      if (!intermediate) {
        const outputPath = join(directory, `color-before-${String(ordinal).padStart(3, '0')}.mp4`)
        await rm(outputPath, { force: true })
        const produced = await this.processor.process({
          sourcePath: source.path,
          outputPath,
          execution: {
            pipeline: pipelineWithoutOutputTransform(source.pipeline),
            executionHash: calculateCanonicalHash({
              kind: 'color-critic-before/v1',
              pipelineHash: source.pipeline.pipelineHash,
            }),
          },
          ...(input.lutPaths ? { lutPaths: input.lutPaths } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
        // The intermediate keeps the SOURCE's frame rate — the processor passes
        // no `-r`. Converting a source frame index to seconds through the
        // timeline rate would point the crop at a different instant than the one
        // the measurement resolved, and would do it without ever failing.
        intermediate = Object.freeze({
          path: produced.outputPath,
          sha256: produced.sha256,
          fps: produced.probe.fps,
        })
        intermediates.set(sourceKey, intermediate)
      }

      // Both sides carry the SAME range — the shot's place on the delivered
      // timeline, counted in output frames. That is what makes the critic's
      // stage pairing meaningful: it pairs a camera with itself over one
      // moment, not with whatever else happened to overlap.
      const range = createTickInterval(BigInt(clip.timelineInFrame), BigInt(clip.timelineOutFrame))
      const sourceFrames = clip.sourceOutFrame - clip.sourceInFrame
      const timelineFrames = clip.timelineOutFrame - clip.timelineInFrame
      const beforeMeasured = await this.measurement.measureCameraColor({
        mediaPath: intermediate.path,
        cameraId: clip.cameraId,
        sourceAssetId: source.artifactId,
        sourceSha256: intermediate.sha256,
        sessionId: null,
        sampleEveryMs: sampleEveryMs(sourceFrames, intermediate.fps),
        ranges: [{ sessionRange: range, sourceStartFrame: clip.sourceInFrame, sourceEndFrame: clip.sourceOutFrame }],
        ...(input.signal ? { signal: input.signal } : {}),
      })
      before.push(...beforeMeasured)
      const afterMeasured = await this.measurement.measureCameraColor({
        mediaPath: input.deliveredPath,
        cameraId: clip.cameraId,
        sourceAssetId: input.deliveredArtifactId,
        sourceSha256: input.deliveredSha256,
        sessionId: null,
        sampleEveryMs: sampleEveryMs(timelineFrames, input.fps),
        ranges: [{ sessionRange: range, sourceStartFrame: clip.timelineInFrame, sourceEndFrame: clip.timelineOutFrame }],
        ...(input.signal ? { signal: input.signal } : {}),
      })
      after.push(...afterMeasured)

      evidence.push(await this.crop({
        workspaceId: input.workspaceId,
        directory,
        stage: 'before-output-transform',
        clip,
        mediaPath: intermediate.path,
        atSeconds: (clip.sourceInFrame + sourceFrames / 2) / intermediate.fps,
        ...(input.signal ? { signal: input.signal } : {}),
      }))
      evidence.push(await this.crop({
        workspaceId: input.workspaceId,
        directory,
        stage: 'after-output-transform',
        clip,
        mediaPath: input.deliveredPath,
        atSeconds: (clip.timelineInFrame + timelineFrames / 2) / input.fps,
        ...(input.signal ? { signal: input.signal } : {}),
      }))
    }
    return Object.freeze({
      before: Object.freeze(before),
      after: Object.freeze(after),
      evidence: Object.freeze(evidence),
    })
  }

  /** One inspectable frame, scaled down and promoted content-addressed. */
  private async crop(input: {
    workspaceId: string
    directory: string
    stage: ColorCriticEvidenceCrop['stage']
    clip: Readonly<ColorCriticSubjectClip>
    mediaPath: string
    atSeconds: number
    signal?: AbortSignal
  }): Promise<Readonly<ColorCriticEvidenceCrop>> {
    const outputPath = join(input.directory, `crop-${input.stage}-${input.clip.clipId}.png`)
    await rm(outputPath, { force: true })
    try {
      await execFileAsync(this.ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-ss', Math.max(0, input.atSeconds).toFixed(6),
        '-i', input.mediaPath,
        '-frames:v', '1',
        '-vf', `scale=${COLOR_CRITIC_CROP_WIDTH}:-2:flags=area`,
        '-f', 'image2', outputPath,
      ], {
        windowsHide: true,
        timeout: this.timeoutMs,
        maxBuffer: 1024 * 1024,
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } catch {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        'Colour critic could not extract an evidence crop',
        { stage: input.stage, clipId: input.clip.clipId },
      )
    }
    const sha256 = await calculateFileSha256(outputPath)
    const promoted = await this.storage.promoteDerived({
      workspaceId: input.workspaceId,
      sourcePath: outputPath,
      sha256,
      extension: 'png',
      prefix: 'color-critic-evidence',
    })
    return Object.freeze({
      stage: input.stage,
      cameraId: input.clip.cameraId,
      clipId: input.clip.clipId,
      artifactKey: promoted.key,
      sha256: promoted.sha256,
      byteSize: promoted.byteSize,
      width: COLOR_CRITIC_CROP_WIDTH,
      // The height follows the source aspect through `scale=-2`. Nothing here
      // probed the written file, so it is null rather than a number nobody
      // measured.
      height: null,
    })
  }

  async cleanup(operationId: string): Promise<void> {
    await rm(this.directory(operationId), { recursive: true, force: true })
  }
}

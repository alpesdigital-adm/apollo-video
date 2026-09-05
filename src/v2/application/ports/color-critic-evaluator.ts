import type { resolveColorPlan } from '../../domain/color-and-export.ts'
import type { ColorCriticStage } from '../../domain/color-critic-report.ts'
import type { CameraColorMeasurement } from '../../domain/color-measurement.ts'

/**
 * The two stages a colour critic report compares (F4.014 / FR-184).
 *
 * "Before the output transform" is not a file the renderer keeps: the colour
 * pre-pass writes one `color-source-NNN-MMM.mp4` per (source × pipelineHash)
 * and deletes it with the rest of the scratch directory
 * (`ffmpeg-editorial-proxy-renderer.ts:528-553`). So the evaluator re-runs the
 * same chain with the `output` stage disabled and measures that, rather than
 * measuring the delivered file twice and calling the difference zero.
 *
 * Everything here is a position — which clip, which source, which delivered
 * file. The numbers come back measured; there is no field with which a caller
 * could state what the frames look like.
 */

/**
 * One shot of the timeline: where it came from, which colour chain the render
 * applied to it, and where it landed.
 *
 * `pipelineHash` is part of the identity and not a decoration: a per-segment
 * match override gives two clips of the same file different chains, and the
 * renderer writes one intermediate per (source × pipelineHash). A clip that
 * named only its source would be measured against whichever of those chains
 * happened to be built first.
 */
export interface ColorCriticSubjectClip {
  readonly clipId: string
  readonly cameraId: string
  readonly sourceArtifactId: string
  readonly pipelineHash: string
  readonly sourceInFrame: number
  readonly sourceOutFrame: number
  readonly timelineInFrame: number
  readonly timelineOutFrame: number
}

/** A materialized render source and the pipeline the render actually applied to it. */
export interface ColorCriticSourceRef {
  readonly artifactId: string
  readonly path: string
  readonly sha256: string
  readonly pipeline: Readonly<ReturnType<typeof resolveColorPlan>>
}

/**
 * The key a clip and its source ref meet on: one materialized file put through
 * one resolved pipeline. It lives in the port because both sides depend on it
 * being the same key — the service builds the refs with it and the adapter
 * caches its intermediates by it — and because it is the key the renderer's own
 * pre-pass dedups by.
 */
export function colorCriticSourceKey(artifactId: string, pipelineHash: string): string {
  return `${artifactId}|${pipelineHash}`
}

/**
 * A small PNG a person can open.
 *
 * Content-addressed in object storage, never in the database: a crop is media,
 * and media bytes do not belong in a row. It is deliberately small — a few
 * frames scaled down — because its job is to let somebody see what the critic
 * saw, not to be a second master.
 */
export interface ColorCriticEvidenceCrop {
  readonly stage: ColorCriticStage
  readonly cameraId: string
  readonly clipId: string
  readonly artifactKey: string
  readonly sha256: string
  readonly byteSize: number
  readonly width: number
  /**
   * Null when the crop's height followed the source aspect and nothing probed
   * the result. A zero here would claim a measured height of nothing.
   */
  readonly height: number | null
}

export interface ColorCriticStageMeasurements {
  /** Measurements of the chain up to and excluding the output transform. */
  readonly before: readonly Readonly<CameraColorMeasurement>[]
  /** Measurements of the delivered render. */
  readonly after: readonly Readonly<CameraColorMeasurement>[]
  readonly evidence: readonly Readonly<ColorCriticEvidenceCrop>[]
}

export interface ColorCriticEvaluator {
  measureStages(input: {
    readonly workspaceId: string
    readonly operationId: string
    readonly fps: number
    readonly clips: readonly Readonly<ColorCriticSubjectClip>[]
    readonly sources: readonly Readonly<ColorCriticSourceRef>[]
    readonly deliveredPath: string
    readonly deliveredArtifactId: string
    readonly deliveredSha256: string
    readonly lutPaths?: Readonly<Record<string, string>>
    readonly signal?: AbortSignal
  }): Promise<Readonly<ColorCriticStageMeasurements>>

  /** Remove the intermediates this operation wrote. Reports, never throws. */
  cleanup(operationId: string): Promise<void>
}

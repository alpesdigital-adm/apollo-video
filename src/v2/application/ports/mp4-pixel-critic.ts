import type {
  Mp4PixelIssueV1, Mp4QualityReportV1, Mp4ReportIdentity,
} from '../../domain/mp4-pixel-quality.ts'
import type { OracleModelReading, PixelOracleModelId } from '../../domain/pixel-face-oracle.ts'
import type { NormalizedInsets } from '../../domain/output-spec.ts'

/** One frame image (PNG, lossless) the oracle reads, identified inside one directory. */
export type PixelOracleFrameFile = Readonly<{ id: string; file: string }>
export type PixelOracleRegistration = Readonly<{
  id: string
  sourceId: string
  outputId: string
  status: 'ok' | 'failed'
  reason: string | null
  matches: number
  inliers: number
  /** Similarity transform source pixels -> output pixels, `[[a, b, tx], [c, d, ty]]`. */
  matrix: readonly [readonly [number, number, number], readonly [number, number, number]] | null
  medianResidualPixels: number | null
  scale: number | null
  rotationDegrees: number | null
}>
export type PixelOracleFrameResult = Readonly<{
  id: string
  sha256: string
  status: 'ok' | 'error'
  reason: string | null
  width: number | null
  height: number | null
  /** One reading per model; empty when the frame itself could not be read. */
  readings: readonly OracleModelReading[]
}>
export type PixelOracleReceipt = Readonly<{
  protocol: string
  bridgeSha256: string
  pythonSha256: string
  runtime: Readonly<Record<string, string>>
}>
export type PixelOracleAnalysis = Readonly<{
  receipt: PixelOracleReceipt
  frames: readonly PixelOracleFrameResult[]
  registrations: readonly PixelOracleRegistration[]
}>

/**
 * The independent eyes of the MP4 critic. It reads lossless frames of the overlay-free output (and of the source) with two face
 * detectors whose raw tensors it decodes itself, and registers each source frame onto its output frame on their pixels. It is not the
 * product's detector alone, and a frame on which it finds nothing certifies nothing.
 */
export interface PixelOracle {
  analyze(request: Readonly<{
    framesDirectory: string
    frames: readonly PixelOracleFrameFile[]
    pairs: readonly Readonly<{ id: string; sourceId: string; outputId: string }>[]
    signal?: AbortSignal
  }>): Promise<Readonly<PixelOracleAnalysis>>
  readonly models: ReadonlyArray<Readonly<{ id: PixelOracleModelId }>>
}

export type Mp4ControlKind = 'captions-off' | 'cta-off' | 'overlays-off'

/** A clip of the delivered timeline: where it plays in which source (the critic reads source frames to register the output). */
export type Mp4CriticClip = Readonly<{
  sourceArtifactId: string
  timelineInFrame: number
  timelineOutFrame: number
  sourceInFrame: number
  sourceOutFrame: number
  rate: number
}>

export type Mp4PixelCriticRequest = Readonly<{
  identity: Mp4ReportIdentity
  deliveredPath: string
  outputSpec: Readonly<{ width: number; height: number; safeArea: Readonly<NormalizedInsets> }>
  /** Source video files by artifact id, as the renderer read them. */
  sources: Readonly<Record<string, Readonly<{ path: string; sha256: string }>>>
  clips: readonly Mp4CriticClip[]
  /** Which overlays the RenderInput draws; a control is only rendered for an overlay that exists. Default: both. */
  overlays?: Readonly<{ captions: boolean; cta: boolean }>
  /** Renders the SAME input without the named overlay (captions, CTA, or both) and returns where the MP4 is. */
  renderControl: (kind: Mp4ControlKind) => Promise<Readonly<{ path: string }>>
  signal?: AbortSignal
}>

export type Mp4PixelVerification = Readonly<{
  report: Readonly<Mp4QualityReportV1>
  /** The issues of the report, in the shape the format critic lifts into the variant's own verdict. */
  issues: readonly Readonly<Mp4PixelIssueV1>[]
}>

/** Verifies, on the delivered MP4, everything the plan cannot prove: captions, CTA, safe area, subject, density. */
export interface Mp4PixelCritic {
  verify(request: Mp4PixelCriticRequest): Promise<Readonly<Mp4PixelVerification>>
}

import type { EditorialProxyRenderer } from './editorial-proxy-renderer.ts'
import type { RenderInputSpecV1 } from '../../domain/render-input.ts'
import type { OutputSpecRevision } from '../../domain/output-spec-revision.ts'
import type { MediaArtifactManifest } from '../../domain/media-artifact.ts'
import type { ObservedClockFrame } from '../../domain/materialized-subtitle-clock.ts'
import type { RenderReframeRangeV1 } from '../../domain/render-reframe-plan.ts'

type RenderRequest = Parameters<EditorialProxyRenderer['render']>[0]
/** Explicit effective context after source preparation. No format/dimension,
 * source-clock, normalized-artifact identity or database authority is inferred. */
export interface PreparedEditorialComposition {
  clips: RenderRequest['clips']
  transitions: NonNullable<RenderRequest['transitions']>
  fps: number; outputFps: number
  width: number; height: number; stagingWidth: number; stagingHeight: number
  renderSources: readonly Readonly<{ artifactId: string; path: string; mediaType: 'video' | 'audio' }>[]
  sourceIndex: Readonly<Record<string, number>>
  clipVideoIndex: Readonly<Record<string, number>>
  videoProbeByArtifactId: Readonly<Record<string, Readonly<{ width: number; height: number }>>>
  reframeRangeByClipId: Readonly<Record<string, Readonly<RenderReframeRangeV1>>>
  backgroundMusic: NonNullable<RenderRequest['backgroundMusic']> | null
  compositionLayout: NonNullable<RenderRequest['composition']> | null
  placementPlan: NonNullable<RenderRequest['placementPlan']> | null
  placementInputs: readonly Readonly<{ elementId: string; path: string; sha256: string }>[]
  assetInputIndexByElementId: Readonly<Record<string, number>>
}
export interface EditorialCompositionPrefix {
  filters: readonly string[]
  videoInputs: readonly Readonly<{ path: string; ss: string; t: string }>[]
  inputArgs: readonly string[]
  videoLabel: 'composed' | 'placed'
  audioLabel: 'outa'
}
export interface LocalPinnedFile { path: string; sha256: string; byteSize: number }
export type ClockConsumptionReference = Readonly<
  { kind: 'video-clip' | 'clip-audio'; clipId: string; trackId: string } |
  { kind: 'music-track'; trackId: string } |
  { kind: 'placement'; elementId: string }
>
export interface ClockConsumedSourceBinding {
  reference: ClockConsumptionReference
  role: string
  inputOrdinal: number
  original: Readonly<LocalPinnedFile & {
    artifactId: string; manifestId: string; manifest: Readonly<MediaArtifactManifest>; probeHash: string
  }>
  consumed: Readonly<LocalPinnedFile & (
    { kind: 'original' } |
    { kind: 'staged-color-derivative'; compilationId: string; compilationHash: string; pipelineHash: string;
      sourceSha256: string; executionReceiptHash: string }
  )>
}
export interface ClockCollectorToolchain {
  ffmpeg: Readonly<LocalPinnedFile & { expectedVersionLine: string }>
  ffprobe: Readonly<LocalPinnedFile & { expectedVersionLine: string }>
  buildManifest: Readonly<LocalPinnedFile>
  libass: Readonly<{ linkage: 'embedded'; version: string; configurationHash: string; implementationEvidenceHash: string }>
  libraries: readonly Readonly<LocalPinnedFile & { name: string; version: string }>[]
  fonts: readonly Readonly<LocalPinnedFile & { artifactId: string; family: string; face: string }>[]
  fontConfig: Readonly<LocalPinnedFile>
  fontsDirectory: string
}
export interface ClockCollectorScope {
  workspaceId: string; projectId: string; projectVersionId: string; variantId: string
  outputStateHash: string; outputSpecRevisionId: string; outputSpecHash: string
}
export interface ClockCaptureLimits {
  maxFrames: number; maxTraceBytes: number; maxProbeBytes: number; maxOutputBytes: number
  maxProcessMs: number
}
export interface ClockTraceFile { filename: string; sha256: string; byteSize: number }
export interface ObservedEditorialClockTrace {
  schemaVersion: 'observed-editorial-subtitle-clock/v1'
  authorityStage: 'process-observation-only'
  integration: 'blocked'
  missingAuthority: readonly string[]
  runId: string
  scope: Readonly<ClockCollectorScope>
  role: 'proxy' | 'final'
  renderInputHash: string; specRevisionHash: string
  compositionHash: string; prefixHash: string; semanticTraceHash: string
  prefix: Readonly<EditorialCompositionPrefix>
  sourceBindings: readonly Readonly<ClockConsumedSourceBinding>[]
  auxiliaryAssets: readonly Readonly<LocalPinnedFile & { assetId: string }>[]
  toolchain: Readonly<ClockCollectorToolchain>
  fragment: Readonly<{ id: string; globalStartFrame: number; globalEndFrame: number;
    parentCompositionTraceHash: string | null; globalOrigin: Readonly<ObservedClockFrame> | null }>
  frames: readonly Readonly<ObservedClockFrame>[]
  mp4Clock: Readonly<{ timeBase: Readonly<{ numerator: string; denominator: string }>; frames: readonly Readonly<ObservedClockFrame>[] }>
  files: readonly Readonly<ClockTraceFile>[]
  execution: Readonly<{ pid: number; spawnObserved: true; closeObserved: true; exitCode: 0; signal: null }>
  traceHash: string
}
export interface CaptureEditorialClockRequest {
  runId: string
  scope: Readonly<ClockCollectorScope>
  role: 'proxy' | 'final'
  renderInput: Readonly<RenderInputSpecV1>
  specRevision: Readonly<OutputSpecRevision>
  prepared: Readonly<PreparedEditorialComposition>
  sourceBindings: readonly Readonly<ClockConsumedSourceBinding>[]
  toolchain: Readonly<ClockCollectorToolchain>
  auxiliaryAssets: readonly Readonly<LocalPinnedFile & { assetId: string }>[]
  fragment: Readonly<{ id: string; globalStartFrame: number; globalEndFrame: number }>
  parentComposition: Readonly<ObservedEditorialClockTrace> | null
  /** Optional diagnostic ASS bytes, observed on the replay. This does not
   * activate emission policy or confer facial/CTA/render approval. */
  diagnosticAss: Readonly<{ text: string; sha256: string }> | null
  limits: Readonly<ClockCaptureLimits>
  /** Absolute work/process deadline. Reserved archive IO may use hardEnd,
   * declared at the same admission; neither value is renewed by a stage. */
  deadlineMonotonicMs: number
  hardEndMonotonicMs: number
  signal?: AbortSignal
}
export interface SubtitleClockCollector {
  capture(request: CaptureEditorialClockRequest): Promise<Readonly<ObservedEditorialClockTrace>>
  assertReplay(prepared: ObservedEditorialClockTrace, replay: ObservedEditorialClockTrace): void
  /** Evidence remains until the owner explicitly archives and cleans its run. */
  cleanup(runId: string, deadlines: Readonly<{ workEndMonotonicMs: number; hardEndMonotonicMs: number }>): Promise<void>
}

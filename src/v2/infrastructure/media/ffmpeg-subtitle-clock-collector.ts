import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { TextDecoder } from 'node:util'
import type { CaptureEditorialClockRequest, ClockTraceFile, ObservedEditorialClockTrace,
  LocalPinnedFile, SubtitleClockCollector } from '../../application/ports/subtitle-clock-collector.ts'
import { assertRenderInputSpec } from '../../domain/render-input.ts'
import { assertMediaArtifactManifest } from '../../domain/media-artifact.ts'
import { sealOutputSpecRevision } from '../../domain/output-spec-revision.ts'
import { assertClipRate, timelineSpanForRate } from '../../domain/clip-timing.ts'
import { validateRenderPlacementPlan } from '../../domain/render-placement-plan.ts'
import { calculateOutputCanonicalHash, serializeOutputCanonicalJson, OUTPUT_CANONICAL_POLICY_VERSION } from '../../domain/output-canonical-policy.ts'
import { DomainError } from '../../domain/errors.ts'
import type { ObservedClockFrame, ClockTimeBase } from '../../domain/materialized-subtitle-clock.ts'
import { buildEditorialCompositionPrefix, buildPreLibassClockStage } from './ffmpeg-editorial-composition-graph.ts'
import { OwnedDeadlineIo, OwnedIoInconclusive, assertOwnedIoAdmission, pendingOwnedIo, type OwnedIoPhase } from './ffmpeg-owned-io.ts'
import { NodeOwnedFfmpegExecutor, OwnedFfmpegProcessFailure, OwnedFfmpegAdmissionFailure, OwnedFfmpegTerminalInconclusive, assertOwnedFfmpegAdmission, pendingOwnedFfmpegTerminations, type OwnedFfmpegExecutor,
  type OwnedFfmpegProcessObservation } from './ffmpeg-owned-process.ts'

const MAX_TRACE_BYTES = 128 * 1024 * 1024, MAX_PROBE_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024, MAX_PROCESS_MS = 30_000
const MIN_I64 = -(BigInt(1) << BigInt(63)), MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1)
const MAX_I32 = BigInt(2147483647)
const SHA = /^[a-f0-9]{64}$/, RUN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TAG = 'showinfo@apollo_preass'
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new DomainError('INVALID_RENDER_INPUT', message) }
function text(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new DomainError('INVALID_RENDER_INPUT', 'Clock evidence is not complete UTF-8') }
}
function int64(value: string): bigint {
  check(/^(?:0|-?[1-9][0-9]{0,18})$/.test(value), 'Observed PTS is not canonical int64')
  const result = BigInt(value)
  check(result > MIN_I64 && result <= MAX_I64, 'Observed PTS is absent or overflows int64')
  return result
}
function rational(value: string): Readonly<ClockTimeBase> {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(value)
  check(match && BigInt(match[1]!) <= MAX_I32 && BigInt(match[2]!) <= MAX_I32, 'Observed time_base is not positive AVRational int32')
  return Object.freeze({ numerator: match[1]!, denominator: match[2]! })
}
function ordered(frames: readonly ObservedClockFrame[]): void {
  let previous: ObservedClockFrame | undefined
  for (const [index, frame] of frames.entries()) {
    check(frame.frame === index, 'Observed frame indices are not complete and contiguous')
    rational(frame.timeBase.numerator + '/' + frame.timeBase.denominator)
    const pts = int64(frame.pts)
    if (previous) check(pts * BigInt(frame.timeBase.numerator) * BigInt(previous.timeBase.denominator) >
      int64(previous.pts) * BigInt(previous.timeBase.numerator) * BigInt(frame.timeBase.denominator), 'Observed PTS is duplicate or nonmonotonic')
    previous = frame
  }
}
/** Parse every record from one named filter instance; no pts_time/float/FPS
 * reconstruction, truncation, sampling or fallback to another showinfo filter. */
export function parseEditorialPreAssTrace(bytes: Buffer, expectedFrames: number, maxBytes: number): readonly Readonly<ObservedClockFrame>[] {
  check(Number.isSafeInteger(expectedFrames) && expectedFrames > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0 && bytes.length > 0 && bytes.length <= maxBytes,
    'Clock trace count/byte bound is invalid')
  const lines = text(bytes).split(/\r?\n/), frames: ObservedClockFrame[] = []
  let tb: Readonly<ClockTimeBase> | undefined, instance: string | undefined
  for (const line of lines) {
    if (!line.includes(TAG)) continue
    const header = /^\[showinfo@apollo_preass @ ([^\]\s]+)\]\s*(.*)$/.exec(line)
    check(header, 'Named pre-libass trace header is malformed')
    if (instance === undefined) instance = header[1]
    check(instance === header[1], 'Clock trace combines different filter instances')
    const record = header[2]!
    if (record.startsWith('config in time_base:')) {
      check(tb === undefined && frames.length === 0, 'Clock trace reconfigures an observed stream')
      const value = /^config in time_base:\s*([^, ]+),/.exec(record)
      check(value, 'Clock trace time_base header is missing'); tb = rational(value[1]!)
    } else if (/^n:\s*/.test(record)) {
      check(tb !== undefined, 'Clock frame precedes its time_base config')
      const value = /^n:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/.exec(record)
      check(value && /^(?:0|[1-9][0-9]*)$/.test(value[1]!) && Number(value[1]) === frames.length && frames.length < expectedFrames,
        'Clock frame is malformed, missing, duplicate or outside its bound')
      int64(value[2]!); frames.push(Object.freeze({ frame: frames.length, pts: value[2]!, timeBase: tb }))
    } else check(!record.includes('pts:') && !record.includes('config in'), 'Clock trace contains an unparsed clock record')
  }
  check(tb !== undefined && frames.length === expectedFrames, 'Clock trace is incomplete or has an unexpected full frame count')
  ordered(frames); return Object.freeze(frames)
}
/** MP4 presentation timestamps are a separate measured clock. FFprobe numbers
 * outside the exact safe integer range fail instead of losing int64 precision. */
export function parseEditorialMp4Clock(bytes: Buffer, expectedFrames: number, maxBytes: number) {
  check(Number.isSafeInteger(expectedFrames) && expectedFrames > 0 && Number.isSafeInteger(maxBytes) && maxBytes > 0 && bytes.length > 0 && bytes.length <= maxBytes, 'MP4 clock probe exceeds its byte bound')
  let data: { streams?: Array<{ codec_type?: string; time_base?: string }>; frames?: Array<{ pts?: number | string; best_effort_timestamp?: number | string }> }
  try { data = JSON.parse(text(bytes)) } catch { throw new DomainError('INVALID_RENDER_INPUT', 'MP4 clock probe JSON is invalid') }
  check(data !== null && typeof data === 'object' && !Array.isArray(data), 'MP4 clock probe is not an object')
  check(Array.isArray(data.streams) && data.streams.length === 1 && data.streams[0]?.codec_type === 'video' &&
    typeof data.streams[0].time_base === 'string' && Array.isArray(data.frames) && data.frames.length === expectedFrames,
  'MP4 clock stream or full frame count differs')
  const tb = rational(data.streams[0].time_base), frames = data.frames.map((item, frame) => {
    check(item !== null && typeof item === 'object' && !Array.isArray(item), 'MP4 frame is not an object')
    check(typeof item.pts === 'string' || Number.isSafeInteger(item.pts), 'MP4 frame lacks an exact presentation timestamp')
    const pts = String(item.pts); int64(pts)
    check(item.best_effort_timestamp === undefined || String(item.best_effort_timestamp) === pts, 'MP4 PTS disagrees with decoded presentation timestamp')
    return Object.freeze({ frame, pts, timeBase: tb })
  })
  ordered(frames); return Object.freeze({ timeBase: tb, frames: Object.freeze(frames) })
}
function semanticBody(trace: Omit<ObservedEditorialClockTrace, 'traceHash'> | ObservedEditorialClockTrace) {
  return { ...policy, schemaVersion: 'observed-editorial-clock-sequence/v1', scope: trace.scope, role: trace.role,
    renderInputHash: trace.renderInputHash, specRevisionHash: trace.specRevisionHash,
    compositionHash: trace.compositionHash, prefixHash: trace.prefixHash, prefix: trace.prefix,
    sourceBindings: trace.sourceBindings, auxiliaryAssets: trace.auxiliaryAssets, toolchain: trace.toolchain, fragment: trace.fragment, frames: trace.frames }
}
export function assertObservedEditorialClockReplay(before: ObservedEditorialClockTrace, after: ObservedEditorialClockTrace): void {
  for (const item of [before, after]) {
    const { traceHash, ...body } = item
    check(item.schemaVersion === 'observed-editorial-subtitle-clock/v1' && item.authorityStage === 'process-observation-only' &&
      item.integration === 'blocked' && calculateOutputCanonicalHash(body) === traceHash &&
      calculateOutputCanonicalHash(semanticBody(item)) === item.semanticTraceHash, 'Observed clock receipt seal differs')
    check(item.frames.length === item.fragment.globalEndFrame - item.fragment.globalStartFrame && item.frames.length > 0, 'Replay full sequence count differs from its fragment')
    ordered(item.frames)
  }
  check(before.runId !== after.runId, 'Clock replay requires a different run identity')
  check(before.semanticTraceHash === after.semanticTraceHash, 'Whole pre-libass sequence or dependencies changed during replay')
}
function contains(root: string, path: string): boolean {
  const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel)
}
function record(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'Clock binding requires an object')
  return value as Record<string, unknown>
}
function hash(value: string): void { check(SHA.test(value), 'Clock binding hash is missing') }
function localFile(value: LocalPinnedFile): void {
  check(isAbsolute(value.path) && SHA.test(value.sha256) && Number.isSafeInteger(value.byteSize) && value.byteSize > 0, 'Clock local byte binding is incomplete')
}
export function validateEditorialClockRequest(input: CaptureEditorialClockRequest) {
  const metadata = { ...input, signal: null, deadlineMonotonicMs: null, hardEndMonotonicMs: null }
  serializeOutputCanonicalJson(metadata)
  check(RUN.test(input.runId) && Number.isFinite(input.deadlineMonotonicMs) && Number.isFinite(input.hardEndMonotonicMs) &&
    input.hardEndMonotonicMs > input.deadlineMonotonicMs && input.hardEndMonotonicMs <= input.deadlineMonotonicMs + 5000, 'Clock owner/deadlines are missing or exceed archive reserve')
  for (const [key, value] of Object.entries(input.scope)) {
    if (key.endsWith('Hash')) hash(value); else check(typeof value === 'string' && value.length >= 3, 'Clock scope identity is missing')
  }
  hash(input.scope.outputStateHash)
  assertRenderInputSpec(input.renderInput)
  const revision = sealOutputSpecRevision(input.specRevision.document, input.specRevision.createdCommand)
  check(revision.specHash === input.specRevision.specHash && revision.specHash === input.scope.outputSpecHash &&
    revision.document.id === input.scope.outputSpecRevisionId && revision.document.variantId === input.scope.variantId &&
    revision.document.workspaceId === input.scope.workspaceId && revision.document.projectId === input.scope.projectId &&
    input.renderInput.plan.versionId === input.scope.projectVersionId && input.renderInput.output.id === input.scope.variantId,
  'Clock request scope/spec/RenderInput binding differs')
  check(input.role === 'proxy' || input.role === 'final', 'Clock role is missing')
  const encoding = revision.document.profile[input.role], prepared = input.prepared
  check(prepared.width === encoding.width && prepared.height === encoding.height && prepared.outputFps === encoding.fps &&
    input.renderInput.output.width === encoding.width && input.renderInput.output.height === encoding.height &&
    input.renderInput.output.fps === encoding.fps && prepared.fps === input.renderInput.output.fps, 'Clock effective output differs from materialized spec')
  for (const size of [prepared.width, prepared.height, prepared.stagingWidth, prepared.stagingHeight]) check(Number.isSafeInteger(size) && size >= 2 && size % 2 === 0, 'Clock composition dimensions are invalid')
  const expectedFrames = input.fragment.globalEndFrame - input.fragment.globalStartFrame
  check(RUN.test(input.fragment.id) && Number.isSafeInteger(input.fragment.globalStartFrame) && input.fragment.globalStartFrame >= 0 &&
    Number.isSafeInteger(input.fragment.globalEndFrame) && expectedFrames > 0 && input.fragment.globalEndFrame <= input.renderInput.output.durationInFrames, 'Clock fragment is outside its materialized plan')
  check(input.parentComposition !== null || input.fragment.globalStartFrame === 0 && input.fragment.globalEndFrame === input.renderInput.output.durationInFrames, 'Fragment capture requires the observed whole composition')
  const limits = input.limits
  check(Number.isSafeInteger(limits.maxFrames) && limits.maxFrames >= expectedFrames && limits.maxFrames <= input.renderInput.output.durationInFrames &&
    Number.isSafeInteger(limits.maxTraceBytes) && limits.maxTraceBytes > 0 && limits.maxTraceBytes <= MAX_TRACE_BYTES &&
    Number.isSafeInteger(limits.maxProbeBytes) && limits.maxProbeBytes > 0 && limits.maxProbeBytes <= MAX_PROBE_BYTES &&
    Number.isSafeInteger(limits.maxOutputBytes) && limits.maxOutputBytes > 0 && limits.maxOutputBytes <= MAX_OUTPUT_BYTES &&
    Number.isSafeInteger(limits.maxProcessMs) && limits.maxProcessMs > 0 && limits.maxProcessMs <= MAX_PROCESS_MS, 'Clock capture limits are invalid')
  const plan = record(input.renderInput.props.editPlan)
  check(plan.id === input.renderInput.plan.id && plan.projectVersionId === input.scope.projectVersionId && Array.isArray(plan.videoTracks), 'Clock request lacks its actual materialized EditPlan props')
  const tracks = new Map<string, string>(), sourceClips = new Map<string, Record<string, unknown>>()
  for (const trackValue of plan.videoTracks) { const track = record(trackValue); check(typeof track.id === 'string' && Array.isArray(track.clips), 'Clock plan track is incomplete')
    for (const clipValue of track.clips) { const clip = record(clipValue); check(typeof clip.id === 'string' && !sourceClips.has(clip.id), 'Clock plan repeats a clip')
      tracks.set(clip.id, track.id); sourceClips.set(clip.id, clip) } }
  let cursor = 0
  check(new Set(prepared.clips.map((clip) => clip.id)).size === prepared.clips.length, 'Clock preparation repeats a clip identity')
  for (const clip of prepared.clips) {
    const original = sourceClips.get(clip.id); assertClipRate(clip.rate)
    const dimensions = prepared.videoProbeByArtifactId[clip.sourceArtifactId]
    check(dimensions && Number.isSafeInteger(dimensions.width) && dimensions.width >= 2 && Number.isSafeInteger(dimensions.height) && dimensions.height >= 2, 'Clock preparation lacks its consumed video dimensions')
    check(original && original.sourceArtifactId === clip.sourceArtifactId && original.rate === clip.rate &&
      (original.audioSourceArtifactId ?? original.sourceArtifactId) === (clip.audioSourceArtifactId ?? clip.sourceArtifactId) &&
      Number.isSafeInteger(clip.sourceInFrame) && Number.isSafeInteger(clip.sourceOutFrame) && clip.sourceInFrame >= Number(original.sourceInFrame) &&
      clip.sourceOutFrame <= Number(original.sourceOutFrame) && clip.sourceOutFrame > clip.sourceInFrame &&
      calculateOutputCanonicalHash(clip.crop ?? null) === calculateOutputCanonicalHash(original.crop ?? null) &&
      (clip.audioSourceInFrame ?? clip.sourceInFrame) >= Number(original.audioSourceInFrame ?? original.sourceInFrame) &&
      (clip.audioSourceOutFrame ?? clip.sourceOutFrame) <= Number(original.audioSourceOutFrame ?? original.sourceOutFrame) &&
      clip.timelineInFrame === cursor && timelineSpanForRate(clip.sourceOutFrame - clip.sourceInFrame, clip.rate) === clip.timelineOutFrame - cursor, 'Clock clip/source/rate/interval binding differs')
    cursor = clip.timelineOutFrame
  }
  check(prepared.clips.length > 0 && cursor === expectedFrames, 'Clock composition does not cover its exact fragment')
  if (prepared.placementPlan) validateRenderPlacementPlan(prepared.placementPlan)
  for (const range of Object.values(prepared.reframeRangeByClipId)) {
    check(prepared.clips.some((clip) => clip.id === range.clipId), 'Clock reframe binds an absent clip')
  }
  // Reframe ranges come from the renderer's already validated complete plan;
  // this observer does not invent a full plan/hash around the selected ranges.
  const prefix = buildEditorialCompositionPrefix(prepared)
  check(Buffer.byteLength(prefix.filters.join(';')) <= 524288 && prefix.inputArgs.length <= 4096, 'Clock prefix exceeds its graph/argv budget')
  const inputPaths = [...prepared.renderSources.map((source) => source.path), ...prefix.videoInputs.map((source) => source.path), ...prepared.placementInputs.map((source) => source.path)]
  const expected = new Map<string, Readonly<{ ordinal: number; artifactId: string; trackId?: string }>>()
  prepared.clips.forEach((clip, index) => {
    const videoIndex = prepared.clipVideoIndex[clip.id], audioIndex = prepared.sourceIndex[clip.audioSourceArtifactId ?? clip.sourceArtifactId]
    check(Number.isSafeInteger(videoIndex) && prepared.renderSources[videoIndex!]?.artifactId === clip.sourceArtifactId && Number.isSafeInteger(audioIndex) && prepared.renderSources[audioIndex!]?.artifactId === (clip.audioSourceArtifactId ?? clip.sourceArtifactId), 'Clock prepared source indices differ')
    expected.set('video-clip:' + clip.id, { ordinal: prepared.renderSources.length + index, artifactId: clip.sourceArtifactId, trackId: tracks.get(clip.id)! })
    expected.set('clip-audio:' + clip.id, { ordinal: audioIndex!, artifactId: clip.audioSourceArtifactId ?? clip.sourceArtifactId, trackId: tracks.get(clip.id)! })
  })
  if (prepared.backgroundMusic) { const music = prepared.backgroundMusic
    check(Array.isArray(plan.audioTracks) && plan.audioTracks.some((value) => record(value).id === music.id && calculateOutputCanonicalHash(value) === calculateOutputCanonicalHash(music)), 'Clock music is not its materialized track')
    expected.set('music-track:' + music.id, { ordinal: prepared.sourceIndex[music.artifactId]!, artifactId: music.artifactId }) }
  for (const placement of prepared.placementPlan?.placements ?? []) if (placement.assetArtifactId !== null) {
    expected.set('placement:' + placement.elementId, { ordinal: prepared.assetInputIndexByElementId[placement.elementId]!, artifactId: placement.assetArtifactId }) }
  const seen = new Set<string>()
  for (const binding of input.sourceBindings) {
    const ref = binding.reference, key = ref.kind + ':' + (ref.kind === 'placement' ? ref.elementId : ref.kind === 'music-track' ? ref.trackId : ref.clipId)
    const use = expected.get(key), asset = input.renderInput.assets.find((item) => item.artifactId === binding.original.artifactId)
    check(use && !seen.has(key) && use.ordinal === binding.inputOrdinal && use.artifactId === binding.original.artifactId &&
      (ref.kind !== 'video-clip' && ref.kind !== 'clip-audio' || ref.trackId === use.trackId) &&
      asset && asset.role === binding.role && asset.sha256 === binding.original.sha256 && asset.byteSize === binding.original.byteSize, 'Clock source role/reference/asset binding differs')
    seen.add(key); localFile(binding.original); localFile(binding.consumed); hash(binding.original.probeHash)
    check(typeof binding.original.manifestId === 'string' && binding.original.manifestId.length >= 3, 'Clock source manifest identity is missing')
    assertMediaArtifactManifest(binding.original.manifest)
    check(binding.original.manifest.artifact.sha256 === asset.sha256 && binding.original.manifest.artifact.byteSize === asset.byteSize &&
      binding.original.manifest.artifact.artifactKey === asset.artifactKey &&
      binding.original.manifest.artifact.mediaType === (asset.kind === 'image' ? 'image' : asset.kind), 'Clock manifest contradicts RenderInput bytes/type/key')
    check(binding.consumed.path === inputPaths[binding.inputOrdinal], 'Clock consumed file differs from its exact FFmpeg input ordinal')
    if (binding.consumed.kind === 'original') check(binding.consumed.sha256 === binding.original.sha256 && binding.consumed.byteSize === binding.original.byteSize, 'Clock original input bytes differ')
    else { check(binding.consumed.kind === 'staged-color-derivative' && binding.consumed.sourceSha256 === binding.original.sha256, 'Clock derivative source lineage differs')
      for (const value of [binding.consumed.compilationHash, binding.consumed.pipelineHash, binding.consumed.executionReceiptHash]) hash(value)
      check(binding.consumed.compilationId.length >= 3, 'Clock staged color compilation is absent') }
  }
  check(seen.size === expected.size && inputPaths.every((path) => isAbsolute(path) && input.sourceBindings.some((binding) => binding.consumed.path === path)), 'Clock consumption inventory omits inputs')
  check(input.renderInput.assets.filter((asset) => ['video', 'audio', 'image'].includes(asset.kind)).every((asset) => input.sourceBindings.some((binding) => binding.original.artifactId === asset.artifactId)), 'Clock original source inventory is incomplete')
  for (const file of [input.toolchain.ffmpeg, input.toolchain.ffprobe, input.toolchain.buildManifest, input.toolchain.fontConfig, ...input.toolchain.libraries, ...input.toolchain.fonts, ...input.auxiliaryAssets]) localFile(file)
  check(input.toolchain.libass.linkage === 'embedded' && isAbsolute(input.toolchain.fontsDirectory), 'Clock collector requires pinned embedded libass and explicit font directory')
  hash(input.toolchain.libass.configurationHash); hash(input.toolchain.libass.implementationEvidenceHash)
  check(input.toolchain.ffmpeg.expectedVersionLine.length > 0 && input.toolchain.ffprobe.expectedVersionLine.length > 0, 'Clock executable version pins are missing')
  check(new Set(input.toolchain.fonts.map((file) => file.artifactId)).size === input.toolchain.fonts.length && new Set(input.auxiliaryAssets.map((file) => file.assetId)).size === input.auxiliaryAssets.length, 'Clock font/auxiliary identity inventory repeats a member')
  const fonts = revision.document.profile.subtitles.fontAssets
  check(fonts.length === input.toolchain.fonts.length && input.toolchain.fonts.every((font) => fonts.some((asset) => asset.artifactId === font.artifactId && asset.sha256 === font.sha256) &&
    input.renderInput.assets.some((asset) => asset.kind === 'font' && asset.artifactId === font.artifactId && asset.sha256 === font.sha256 && asset.byteSize === font.byteSize)), 'Clock font bytes do not match the exact materialized profile')
  const auxiliary = input.renderInput.assets.filter((asset) => asset.kind === 'lut' || asset.kind === 'data')
  check(auxiliary.length === input.auxiliaryAssets.length && input.auxiliaryAssets.every((file) => auxiliary.some((asset) => asset.id === file.assetId && asset.sha256 === file.sha256 && asset.byteSize === file.byteSize)), 'Clock auxiliary asset byte bindings are incomplete')
  if (input.diagnosticAss) check(sha(input.diagnosticAss.text) === input.diagnosticAss.sha256 && Buffer.byteLength(input.diagnosticAss.text) <= 16 * 1024 * 1024, 'Diagnostic ASS bytes differ or exceed their bound')
  return { expectedFrames, prefix, revision }
}

interface OwnedCapture { workEndMonotonicMs: number; hardEndMonotonicMs: number; lateFacts: Array<Readonly<{ ownerKey: OwnedFfmpegProcessObservation['ownerKey']; closeObserved: boolean; stdoutSha256: string; stderrSha256: string; stdoutBytes: number; stderrBytes: number }>>; io: OwnedDeadlineIo; directory: string; terminal: boolean; archiveComplete: boolean; archiveWrites: Promise<void>; receipt: ObservedEditorialClockTrace | null }
/** Functional process observer only. The current c779 source union cannot carry
 * all audio/music/placement or staged-color facts. This adapter never creates
 * MaterializedSubtitleClock, receipt publication, cache admission or approval. */
export class FfmpegSubtitleClockCollector implements SubtitleClockCollector {
  private static active = false
  private readonly root: string
  private readonly executor: OwnedFfmpegExecutor
  private readonly captures = new Map<string, OwnedCapture>()
  private readonly ioOwners = new Map<string, OwnedDeadlineIo>()
  retainedIoFacts(runId: string) { return this.ioOwners.get(runId)?.facts() ?? [] }
  retainedLateCloseFacts(runId: string) { return [...(this.captures.get(runId)?.lateFacts ?? [])] }
  constructor(input: { evidenceRoot: string; executor?: OwnedFfmpegExecutor }) {
    check(isAbsolute(input.evidenceRoot), 'Clock evidence root must be absolute')
    this.root = resolve(input.evidenceRoot); this.executor = input.executor ?? new NodeOwnedFfmpegExecutor()
  }
  assertReplay(before: ObservedEditorialClockTrace, after: ObservedEditorialClockTrace): void { check(this.captures.get(before.runId)?.receipt?.traceHash === before.traceHash && this.captures.get(after.runId)?.receipt?.traceHash === after.traceHash, 'Replay receipts are not captures owned by this collector'); assertObservedEditorialClockReplay(before, after) }
  async cleanup(runId: string, deadlines: Readonly<{ workEndMonotonicMs: number; hardEndMonotonicMs: number }>): Promise<void> {
    assertOwnedFfmpegAdmission(); assertOwnedIoAdmission()
    const owned = this.captures.get(runId)
    check(owned && owned.terminal && owned.archiveComplete, "Clock cleanup requires this owner's terminal capture")
    check(deadlines && Number.isFinite(deadlines.workEndMonotonicMs) && Number.isFinite(deadlines.hardEndMonotonicMs) &&
      deadlines.workEndMonotonicMs <= owned.workEndMonotonicMs && deadlines.hardEndMonotonicMs <= owned.hardEndMonotonicMs, 'Clock cleanup cannot extend the captured owner deadlines')
    owned.io.assertCleanup()
    const cleanupIo = new OwnedDeadlineIo({ runId, ...deadlines, otherAdmission: assertOwnedFfmpegAdmission })
    await cleanupIo.wait('archive-settlement', owned.archiveWrites, 'cleanup')
    const root = await cleanupIo.realpath(this.root, 'cleanup'), directory = await cleanupIo.realpath(owned.directory, 'cleanup')
    check(contains(root, directory) && directory === resolve(root, runId), 'Clock cleanup root/identity differs')
    await cleanupIo.rm(directory); this.captures.delete(runId); this.ioOwners.delete(runId)
  }

  async capture(input: CaptureEditorialClockRequest): Promise<Readonly<ObservedEditorialClockTrace>> {
    // The deadline belongs to the caller; no stage or retry can extend it.
    check(Number.isFinite(input.deadlineMonotonicMs) && Number.isFinite(input.hardEndMonotonicMs), 'Clock owner/deadlines are missing')
    const { signal, deadlineMonotonicMs, ...supplied } = input
    input = { ...JSON.parse(serializeOutputCanonicalJson(supplied)), signal, deadlineMonotonicMs } as CaptureEditorialClockRequest
    const validated = validateEditorialClockRequest(input)
    assertOwnedFfmpegAdmission()
    check(!FfmpegSubtitleClockCollector.active, 'Another collector capture is still admitted')
    const budget = () => {
      if (input.signal?.aborted || performance.now() >= input.deadlineMonotonicMs)
        throw new OwnedFfmpegAdmissionFailure('RENDER_EXECUTION_FAILED', 'Clock capture owner budget expired or was cancelled')
    }
    budget()
    const io = new OwnedDeadlineIo({ runId: input.runId, workEndMonotonicMs: input.deadlineMonotonicMs,
      hardEndMonotonicMs: input.hardEndMonotonicMs, signal: input.signal, otherAdmission: assertOwnedFfmpegAdmission })
    FfmpegSubtitleClockCollector.active = true
    this.ioOwners.set(input.runId, io)
    let ioPhase: OwnedIoPhase = 'work'
    let owned: OwnedCapture | undefined, primary: unknown, receipt: ObservedEditorialClockTrace | undefined
    const files: ClockTraceFile[] = [], executions: Array<Omit<OwnedFfmpegProcessObservation, 'stdout' | 'stderr'>> = []
    let unknownChild = false, opaqueUnknownChild = false, captureFinished = false
    let archiveFailed = false
    const captureIoFailures: Error[] = []
    const pendingStages = new Map<string, OwnedFfmpegTerminalInconclusive>()
    const describe = (error: unknown) => {
      const value = error instanceof Error ? error : new Error(String(error))
      const message = value.message
      return { name: value.name, code: error instanceof DomainError ? error.code : null,
        messageSha256: sha(message), messageBytes: Buffer.byteLength(message),
        terminalInconclusive: error instanceof OwnedFfmpegTerminalInconclusive ? { ownerKey: error.ownerKey, closeObserved: false } : null,
        ioInconclusive: error instanceof OwnedIoInconclusive ? { ownerKey: error.ownerKey, ioSettled: false, closeObserved: false } : null,
        primaryProcessError: error instanceof OwnedFfmpegProcessFailure || error instanceof OwnedFfmpegTerminalInconclusive
          ? error.primaryProcessError && { name: error.primaryProcessError.name, messageSha256: sha(error.primaryProcessError.message), messageBytes: Buffer.byteLength(error.primaryProcessError.message) } : null,
        ioFailures: error instanceof OwnedFfmpegProcessFailure || error instanceof OwnedFfmpegTerminalInconclusive
          ? error.ioFailures.map((failure) => ({ name: failure.name, messageSha256: sha(failure.message), messageBytes: Buffer.byteLength(failure.message) })) : [] }
    }
    const save = async (filename: string, bytes: Buffer | string) => {
      check(owned && /^[a-z0-9][a-z0-9.-]*$/.test(filename), 'Clock evidence filename is not owned')
      await io.writeExclusive(resolve(owned.directory, filename), bytes, ioPhase)
      files.push({ filename, sha256: sha(bytes), byteSize: Buffer.byteLength(bytes) })
    }
    const retainIoFailure = (primaryError: unknown, failure: unknown) => {
      const value = failure instanceof Error ? failure : new Error(String(failure))
      captureIoFailures.push(value)
      if (primaryError instanceof OwnedFfmpegProcessFailure || primaryError instanceof OwnedFfmpegTerminalInconclusive || primaryError instanceof OwnedIoInconclusive) primaryError.recordIoFailure(value)
    }
    const refreshTerminal = () => {
      unknownChild = opaqueUnknownChild || pendingStages.size > 0 || pendingOwnedFfmpegTerminations().some((item) => item.ownerKey.runId === input.runId) || io.isRetained()
      if (owned) owned.terminal = !unknownChild && executions.every((execution) => execution.closeObserved)
    }
    const authenticate = async (file: LocalPinnedFile) => {
      budget(); const before = await io.stat(file.path)
      check(before.isFile() && before.size === BigInt(file.byteSize), 'Clock input byte size differs from its external pin')
      const digest = await io.hashFile(file.path, file.byteSize)
      const after = await io.stat(file.path); budget()
      check(digest.byteSize === file.byteSize && digest.sha256 === file.sha256 && before.dev === after.dev &&
        before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs,
      'Clock input bytes or identity changed during authentication')
    }
    // The deliberately minimal child environment omits NODE_ENV, which the ambient ProcessEnv declaration requires.
    const environment = { LC_ALL: 'C', LANG: 'C',
      FONTCONFIG_FILE: input.toolchain.fontConfig.path, FONTCONFIG_PATH: resolve(input.toolchain.fontConfig.path, '..') } as unknown as NodeJS.ProcessEnv
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'HOME']) {
      if (process.env[name] !== undefined) environment[name] = process.env[name]
    }
    const execute = async (stage: string, executable: string, args: readonly string[], limit: number) => {
      budget(); await save(stage + '.argv.json', serializeOutputCanonicalJson({ executable, args }))
      let observation: Readonly<OwnedFfmpegProcessObservation> | undefined, error: unknown
      try {
        observation = await this.executor.execute({ executable, args, owner: { runId: input.runId, operation: stage },
          deadlineMonotonicMs: input.deadlineMonotonicMs, timeoutMs: input.limits.maxProcessMs,
          maxOutputBytes: limit, environment, signal: input.signal, observe: (value) => { observation = value },
          observeLateClose: (value) => {
            observation = value
            if (!owned) return
            pendingStages.delete(stage)
            owned.lateFacts.push(Object.freeze({ ownerKey: value.ownerKey, closeObserved: value.closeObserved, stdoutSha256: sha(value.stdout),
              stderrSha256: sha(value.stderr), stdoutBytes: value.stdoutBytes, stderrBytes: value.stderrBytes }))
            const { stdout: _stdout, stderr: _stderr, ...metadata } = value; executions.push(metadata)
            refreshTerminal()
            // Explicit memory-only late observation. No evidence write starts.
            if (captureFinished && owned.terminal && owned.archiveComplete) FfmpegSubtitleClockCollector.active = false
          } })
      } catch (failure) {
        error = failure
        if (failure instanceof OwnedFfmpegProcessFailure) observation = failure.observation
        else if (failure instanceof OwnedFfmpegTerminalInconclusive) {
          if (!observation?.closeObserved) pendingStages.set(stage, failure)
          unknownChild = pendingStages.size > 0 || pendingOwnedFfmpegTerminations().some((item) => item.ownerKey.runId === input.runId)
        } else if (!(failure instanceof OwnedFfmpegAdmissionFailure)) { unknownChild = true; opaqueUnknownChild = true }
      }
      if (observation) {
        unknownChild ||= !observation.closeObserved
        const { stdout, stderr, ...metadata } = observation; executions.push(metadata)
        try {
          await save(stage + '.stdout', stdout); await save(stage + '.stderr', stderr)
          await save(stage + '.execution.json', serializeOutputCanonicalJson(metadata))
        } catch (failure) {
          retainIoFailure(error, failure)
          if (error === undefined) error = failure
        }
      }
      if (error) throw error
      check(observation && observation.closeObserved && observation.spawnObserved && observation.exitCode === 0 &&
        observation.signal === null && !observation.aborted && !observation.timedOut && !observation.outputExceeded &&
        observation.stdoutBytes === observation.capturedStdoutBytes && observation.stderrBytes === observation.capturedStderrBytes,
      'Clock executor did not prove complete successful close')
      budget(); return observation
    }
    try {
      await io.mkdir(this.root, { recursive: true }); const root = await io.realpath(this.root)
      const directory = resolve(root, input.runId)
      check(contains(root, directory), 'Clock run identity escapes evidence root')
      await io.mkdir(directory, { recursive: false, mode: 0o700 })
      owned = { workEndMonotonicMs: input.deadlineMonotonicMs, hardEndMonotonicMs: input.hardEndMonotonicMs, lateFacts: [], io, directory, terminal: false, archiveComplete: false, archiveWrites: Promise.resolve(), receipt: null }; this.captures.set(input.runId, owned)
      await save('request.json', serializeOutputCanonicalJson({ ...input, signal: null, deadlineMonotonicMs: input.deadlineMonotonicMs }))
      const pinned = new Map<string, LocalPinnedFile>()
      for (const file of [input.toolchain.ffmpeg, input.toolchain.ffprobe, input.toolchain.buildManifest, input.toolchain.fontConfig,
        ...input.toolchain.libraries, ...input.toolchain.fonts, ...input.auxiliaryAssets,
        ...input.sourceBindings.flatMap((binding) => [binding.original, binding.consumed])]) {
        const previous = pinned.get(file.path)
        check(!previous || previous.sha256 === file.sha256 && previous.byteSize === file.byteSize, 'One path has contradictory byte pins')
        pinned.set(file.path, file)
      }
      for (const file of pinned.values()) await authenticate(file)
      // Do not let fontconfig silently enumerate a different font directory.
      const fontRoot = await io.realpath(input.toolchain.fontsDirectory)
      for (const font of input.toolchain.fonts) check(contains(fontRoot, await io.realpath(font.path)), 'Pinned font is outside the explicit font directory')
      for (const [stage, binary] of [['ffmpeg-version', input.toolchain.ffmpeg], ['ffprobe-version', input.toolchain.ffprobe]] as const) {
        const version = await execute(stage, binary.path, ['-version'], input.limits.maxProbeBytes)
        check(text(version.stdout).split(/\r?\n/)[0] === binary.expectedVersionLine, 'Clock executable version differs from its external pin')
      }
      const probed = new Map<string, { streams: Array<{ codec_type: string; width?: number; height?: number }> }>()
      for (const binding of input.sourceBindings) {
        let probe = probed.get(binding.consumed.path)
        if (!probe) {
          const result = await execute('source-probe-' + probed.size, input.toolchain.ffprobe.path,
            ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-of', 'json', binding.consumed.path], input.limits.maxProbeBytes)
          try { probe = JSON.parse(text(result.stdout)) } catch { throw new DomainError('INVALID_RENDER_INPUT', 'Consumed source probe JSON is invalid') }
          check(probe && Array.isArray(probe.streams) && probe.streams.every((stream) => stream !== null && typeof stream === 'object' && typeof stream.codec_type === 'string'), 'Consumed source probe has no valid streams')
          probed.set(binding.consumed.path, probe)
        }
        if (binding.reference.kind === 'video-clip') {
          const expected = input.prepared.videoProbeByArtifactId[binding.original.artifactId]
          const video = probe.streams.find((stream) => stream.codec_type === 'video')
          check(expected && video && video.width === expected.width && video.height === expected.height,
            'Prepared crop dimensions differ from the consumed source probe')
        } else if (binding.reference.kind === 'clip-audio' || binding.reference.kind === 'music-track') {
          check(probe.streams.some((stream) => stream.codec_type === 'audio'), 'Consumed audio source has no observed audio stream')
        }
      }
      let globalOrigin: Readonly<ObservedClockFrame> | null = null
      if (input.parentComposition) {
        const parent = input.parentComposition, registered = this.captures.get(parent.runId)
        check(registered?.terminal && registered.receipt?.traceHash === parent.traceHash && parent.fragment.globalStartFrame === 0 &&
          parent.fragment.parentCompositionTraceHash === null && parent.frames.length === input.renderInput.output.durationInFrames &&
          calculateOutputCanonicalHash(Object.fromEntries(Object.entries(parent).filter(([key]) => key !== 'traceHash'))) === parent.traceHash &&
          parent.renderInputHash === input.renderInput.inputHash && parent.specRevisionHash === input.specRevision.specHash &&
          calculateOutputCanonicalHash(parent.scope) === calculateOutputCanonicalHash(input.scope), 'Fragment parent is not the exact owned full trace')
        for (const file of parent.files) await authenticate({ path: resolve(registered.directory, file.filename), ...file })
        globalOrigin = parent.frames[input.fragment.globalStartFrame]!
      }
      // Observe exactly what libass receives: the renderer places `fps=<rate>` (ass-frame-clock/v2) last before the filter.
      const prefix = validated.prefix, clockStage = buildPreLibassClockStage({ inputLabel: prefix.videoLabel, outputFps: input.prepared.outputFps })
      const graph = [...prefix.filters, ...clockStage.filters, '[' + clockStage.outputLabel + ']showinfo@apollo_preass[clock_preass]']
      const escape = (path: string) => path.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
      if (input.diagnosticAss) {
        await save('diagnostic.ass', input.diagnosticAss.text)
        graph.push("[clock_preass]subtitles=filename='" + escape(resolve(directory, 'diagnostic.ass')) + "':fontsdir='" + escape(fontRoot) + "'[outv]")
      } else graph.push('[clock_preass]null[outv]')
      await save('composition.ffgraph', graph.join(';'))
      const outputPath = resolve(directory, 'composition.mp4')
      // Historical output tail is deliberately retained. In particular -r is
      // downstream of the observed filter, and MP4 PTS are not called ASS PTS.
      const args = ['-hide_banner', '-loglevel', 'info', '-nostdin', '-nostats', '-y', ...prefix.inputArgs,
        '-filter_complex', graph.join(';'), '-map', '[outv]', '-map', '[outa]', '-r', String(input.prepared.outputFps),
        '-c:v', 'libx264', '-preset', input.role === 'final' ? 'medium' : 'veryfast', '-crf', input.role === 'final' ? '18' : '23',
        '-c:a', 'aac', '-b:a', input.role === 'final' ? '192k' : '160k', '-ar', '48000', '-movflags', '+faststart',
        '-fs', String(input.limits.maxOutputBytes), outputPath]
      const rendered = await execute('composition', input.toolchain.ffmpeg.path, args, input.limits.maxTraceBytes)
      const frames = parseEditorialPreAssTrace(rendered.stderr, validated.expectedFrames, input.limits.maxTraceBytes)
      budget(); const outputStat = await io.stat(outputPath)
      check(outputStat.isFile() && outputStat.size > BigInt(0) && outputStat.size < BigInt(input.limits.maxOutputBytes), 'Clock composition hit its output size bound')
      const outputHash = await io.hashFile(outputPath, input.limits.maxOutputBytes)
      check(BigInt(outputHash.byteSize) === outputStat.size, 'Clock composition changed during hashing')
      files.push({ filename: 'composition.mp4', sha256: outputHash.sha256, byteSize: outputHash.byteSize })
      const probe = await execute('mp4-clock', input.toolchain.ffprobe.path,
        ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-show_frames', '-show_entries',
          'stream=codec_type,time_base:frame=pts,best_effort_timestamp', '-of', 'json', outputPath], input.limits.maxProbeBytes)
      const mp4Clock = parseEditorialMp4Clock(probe.stdout, validated.expectedFrames, input.limits.maxProbeBytes)
      const encodingProbe = await execute('mp4-encoding', input.toolchain.ffprobe.path,
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,width,height,sample_rate,channels', '-of', 'json', outputPath], input.limits.maxProbeBytes)
      let encoding: { streams?: Array<{ codec_type: string; codec_name: string; pix_fmt?: string; width?: number; height?: number; sample_rate?: string; channels?: number }> }
      try { encoding = JSON.parse(text(encodingProbe.stdout)) } catch { throw new DomainError('INVALID_RENDER_INPUT', 'MP4 encoding probe JSON is invalid') }
      check(encoding && Array.isArray(encoding.streams) && encoding.streams.every((stream) => stream !== null && typeof stream === 'object' && typeof stream.codec_type === 'string'), 'MP4 encoding streams are malformed')
      const video = encoding.streams.filter((stream) => stream.codec_type === 'video'), audio = encoding?.streams?.filter((stream) => stream.codec_type === 'audio')
      const profile = input.specRevision.document.profile[input.role]
      check(video?.length === 1 && video[0]?.codec_name === 'h264' && video[0].pix_fmt === profile.pixelFormat &&
        video[0].width === profile.width && video[0].height === profile.height && audio?.length === 1 &&
        audio[0]?.codec_name === 'aac' && audio[0].sample_rate === String(profile.audio.sampleRateHz) && audio[0].channels === profile.audio.channels,
        'MP4 effective encoding differs from the declared materialized profile')
      for (const file of pinned.values()) await authenticate(file)
      const body: Omit<ObservedEditorialClockTrace, 'traceHash'> = {
        schemaVersion: 'observed-editorial-subtitle-clock/v1', authorityStage: 'process-observation-only', integration: 'blocked',
        missingAuthority: ['persisted-output-state-and-rights', 'materializer-authority-and-source-frame-domains', 'render-input-to-prepared-reframe-materializer', 'staged-color-execution-authority',
          'effective-loaded-library-and-font-selection', 'libass-effective-ms-pixel-validation', 'atomic-output-publication'],
        runId: input.runId, scope: input.scope, role: input.role, renderInputHash: input.renderInput.inputHash,
        specRevisionHash: input.specRevision.specHash, compositionHash: calculateOutputCanonicalHash({ ...policy, prepared: input.prepared }),
        prefixHash: calculateOutputCanonicalHash({ ...policy, prefix }), semanticTraceHash: '', prefix,
        sourceBindings: input.sourceBindings, auxiliaryAssets: input.auxiliaryAssets, toolchain: input.toolchain,
        fragment: { ...input.fragment, parentCompositionTraceHash: input.parentComposition?.traceHash ?? null, globalOrigin },
        frames, mp4Clock, files: [...files], execution: { pid: rendered.pid!, spawnObserved: true, closeObserved: true, exitCode: 0, signal: null },
      }
      check(Number.isSafeInteger(rendered.pid) && rendered.pid! > 0, 'Clock process identity is absent')
      body.semanticTraceHash = calculateOutputCanonicalHash(semanticBody(body))
      receipt = Object.freeze({ ...body, traceHash: calculateOutputCanonicalHash(body) })
      await save('trace.json', serializeOutputCanonicalJson(receipt)); owned.receipt = receipt
    } catch (error) { primary = error }
    finally {
      ioPhase = 'archive'
      if (owned) {
        try { await io.wait('archive-settlement', owned.archiveWrites) } catch (error) { primary ??= error }
        refreshTerminal()
        try {
          const outcome = serializeOutputCanonicalJson({ outcome: primary === undefined ? 'observed-pending-owner-confirmation' : 'failed', candidateOutcome: primary === undefined ? 'passed' : 'failed',
            authorityStage: 'process-observation-only', terminal: owned.terminal, error: primary === undefined ? null : describe(primary),
            executions, ioLedger: io.facts(), pendingIo: pendingOwnedIo(), ioFailures: captureIoFailures.map(describe), limits: input.limits, deadlineMonotonicMs: input.deadlineMonotonicMs, hardEndMonotonicMs: input.hardEndMonotonicMs })
          const outcomeFile = { filename: 'outcome.json', sha256: sha(outcome), byteSize: Buffer.byteLength(outcome) }
          // The completion marker is written LAST. A failed manifest write must
          // never leave a passed outcome marker behind.
          await io.writeExclusive(resolve(owned.directory, 'manifest.json'), serializeOutputCanonicalJson({ schemaVersion: 'editorial-clock-evidence/v1',
            ...policy, runId: input.runId, outcome: primary === undefined ? 'observed-pending-owner-confirmation' : 'failed', candidateOutcome: primary === undefined ? 'passed' : 'failed', terminal: owned.terminal,
            completionMarker: outcomeFile, files: [...files, outcomeFile] }), 'archive')
          await save('outcome.json', outcome); owned.archiveComplete = !archiveFailed
        } catch (error) {
          retainIoFailure(primary, error); primary ??= error
          archiveFailed = true; owned.receipt = null; owned.archiveComplete = false
        }
      }
      // Unknown child state retains both evidence and closed collector admission.
      captureFinished = true

      refreshTerminal()
      if (!unknownChild && !io.isRetained() && (!owned || owned.archiveComplete)) FfmpegSubtitleClockCollector.active = false
    }
    if (primary !== undefined) throw primary
    check(receipt, 'Clock capture has no receipt'); return receipt
  }
}

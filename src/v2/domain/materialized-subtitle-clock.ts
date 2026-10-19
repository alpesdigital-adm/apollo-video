import { assertDomain } from './errors.ts'
import { assertClipRate, timelineSpanForRate } from './clip-timing.ts'
import { assertRenderInputSpec, type RenderInputSpecV1 } from './render-input.ts'
import { sealOutputSpecRevision, freezeOutputJson, requireOutputHash, requireOutputId,
  type OutputSpecRevision, type OutputJson } from './output-spec-revision.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION } from './output-canonical-policy.ts'
import { LIBASS_NOW_CONVERSION_POLICY, assCentisecondTimestamp, createAssBoundaryBinder, derivePinnedLibassNowMs,
  legalAssCentisecondPreimage, parseClockInt64 as signed, parseClockTimeBase as timeBase,
  type ClockTimeBase } from './libass-clock-model.ts'

export { assCentisecondTimestamp, derivePinnedLibassNowMs, legalAssCentisecondPreimage }
export type { ClockTimeBase }

/** Isolated contract only. No recipe/renderer/cache/publication activation.
 * nowMs is derived from pinned FFmpeg conversion, not observed inside libass.
 * FFmpeg n8.1.1 vf_subtitles.c: double time_ms = pts * av_q2d(tb) * 1000;
 * implicit conversion at ass_render_frame truncates to signed long long.
 * Each binary/build must prove this FP64 policy before an adapter may use it. */
export const MATERIALIZED_SUBTITLE_CLOCK_VERSION = 'materialized-subtitle-clock/v1' as const
export const SUBTITLE_CLOCK_CONVERSION_POLICY = LIBASS_NOW_CONVERSION_POLICY
export interface ObservedClockFrame {
  frame: number
  pts: string
  timeBase: Readonly<ClockTimeBase>
}
export interface ClockFileFact { sha256: string; byteSize: number }
export interface SubtitleFrameDomain {
  schemaVersion: 'subtitle-frame-domain/v1'
  id: string
  fps: Readonly<ClockTimeBase>
}
/** Authority must be measured by the future collector, never inferred from equal FPS.
 * A graph normalization does not invent an intermediate artifact. */
export type SubtitleFrameNormalization = Readonly<{
  schemaVersion: 'subtitle-frame-normalization/v1'
  sourceFrameDomainId: string
  rangeFrameDomainId: string
  sourceProbeHash: string
  traceSha256: string
} & ({ kind: 'identity' } | { kind: 'graph-prefix'; graphHash: string } |
  { kind: 'artifact'; artifactId: string; sha256: string; byteSize: number; probeHash: string })>
export interface SubtitleClockAuthority {
  ffmpeg: Readonly<ClockFileFact & { version: string; buildManifestHash: string }>
  libraries: readonly Readonly<ClockFileFact & { name: string; version: string }>[]
  libass: Readonly<ClockFileFact & { linkage: 'embedded' | 'dynamic'; version: string; configurationHash: string }>
  fonts: readonly Readonly<ClockFileFact & { artifactId: string; family: string; face: string }>[]
  conversion: Readonly<{ version: typeof SUBTITLE_CLOCK_CONVERSION_POLICY
    fpMode: 'binary64-nearest-even-each-operation'; implementationEvidenceHash: string }>
}
export interface SubtitleClockSource {
  clipId: string
  trackId: string
  artifactId: string
  manifestId: string
  manifestHash: string
  probeHash: string
  sha256: string
  byteSize: number
  sourceClock: Readonly<{ timeBase: Readonly<ClockTimeBase>; firstPts: string; lastPts: string }>
  sourceInFrame: number
  sourceOutFrame: number
  timelineInFrame: number
  timelineOutFrame: number
  rate: number
  orientation: number
  nativeFrameDomain: Readonly<SubtitleFrameDomain>
  /** In/OutFrame are in this explicitly normalized domain, not native decoded frame ordinals. */
  rangeFrameDomain: Readonly<SubtitleFrameDomain>
  timelineFrameDomain: Readonly<SubtitleFrameDomain>
  normalization: SubtitleFrameNormalization
  rateMap: Readonly<{ schemaVersion: 'subtitle-clock-rate-map/v1';
    document: Readonly<Omit<SubtitleClockSource, 'rateMap'> & {
      schemaVersion: 'subtitle-clock-rate-map/v1'; canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION }>;
    hash: string }>
}
/** A structural seal is not acquisition authority. Before consuming this contract,
 * the collector/DB must authenticate exact State/version/spec and composition against
 * the materialized RenderInput; source/manifest/probe and normalization/rate-map facts
 * against actual consumed bytes; binary/library/font/build identity and conversion
 * implementation evidence against the executing process. Each run must hash/count its
 * own complete raw trace and parse every PTS/timeBase from those bytes, binding any
 * identity/graph-prefix normalization trace to that capture. GlobalOrigin and explicit
 * domain limits must match the measured full composition and fragment rebase, not an
 * inferred n/fps origin. This pure contract cannot authenticate those external facts. */
export interface SubtitleClockBody {
  schemaVersion: typeof MATERIALIZED_SUBTITLE_CLOCK_VERSION
  canonicalPolicyVersion: typeof OUTPUT_CANONICAL_POLICY_VERSION
  scope: Readonly<{ workspaceId: string; projectId: string; projectVersionId: string; variantId: string
    outputSpecRevisionId: string; outputSpecHash: string; outputStateHash: string }>
  role: 'proxy' | 'final'
  renderInput: Readonly<RenderInputSpecV1>
  specRevision: Readonly<OutputSpecRevision>
  authority: Readonly<SubtitleClockAuthority>
  sources: readonly Readonly<SubtitleClockSource>[]
  prefix: Readonly<{ graph: string; graphHash: string; argv: readonly string[]
    compositionHash: string; emissionParametersHash: string }>
  fragment: Readonly<{ id: string; globalStartFrame: number; globalEndFrame: number
    globalOrigin: Readonly<{ pts: string; timeBase: Readonly<ClockTimeBase> }>
    domain: Readonly<{ beforeFirstNowMs: string; endExclusiveNowMs: string; authorityHash: string }> }>
  limits: Readonly<{ maxFrames: number; maxTraceBytes: number; maxDurationMs: string }>
  capture: Readonly<{ provider: 'ffmpeg-showinfo-pre-libass/v1'; runId: string
    complete: true; exitCode: 0; traceSha256: string; traceByteSize: number }>
  frames: readonly Readonly<ObservedClockFrame>[]
}
export interface MaterializedSubtitleClock extends SubtitleClockBody { clockHash: string }

const MIN_I64 = -(BigInt(1) << BigInt(63)), MAX_I64 = (BigInt(1) << BigInt(63)) - BigInt(1)
const MAX_I32 = BigInt(2147483647)
const check = (value: unknown, message: string) => assertDomain(Boolean(value), 'INVALID_RENDER_INPUT', message)
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function exact(value: object, keys: readonly string[]): void {
  check(Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key)), 'Clock document has missing or unsupported fields')
}
function file(value: ClockFileFact): void {
  requireOutputHash(value.sha256, 'clock bytes')
  check(integer(value.byteSize) && value.byteSize > 0, 'Clock binary/font bytes must be materialized')
}
function named(value: unknown, field: string): void {
  check(typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value), field)
}

function immutable<T>(value: T): Readonly<T> {
  return freezeOutputJson(value as unknown as OutputJson) as unknown as Readonly<T>
}
function frameMs(frame: ObservedClockFrame): bigint { return derivePinnedLibassNowMs(frame.pts, frame.timeBase) }

export function createMaterializedSubtitleClock(input: SubtitleClockBody): Readonly<MaterializedSubtitleClock> {
  // Strict JSON freezes reject sparse arrays, getters, malformed Unicode and extras with undefined before reads.
  const body = immutable(input)
  exact(body, ['schemaVersion', 'canonicalPolicyVersion', 'scope', 'role', 'renderInput', 'specRevision', 'authority',
    'sources', 'prefix', 'fragment', 'limits', 'capture', 'frames'])
  exact(body.scope, ['workspaceId', 'projectId', 'projectVersionId', 'variantId', 'outputSpecRevisionId', 'outputSpecHash', 'outputStateHash'])
  exact(body.authority, ['ffmpeg', 'libraries', 'libass', 'fonts', 'conversion'])
  exact(body.authority.ffmpeg, ['sha256', 'byteSize', 'version', 'buildManifestHash'])
  exact(body.authority.libass, ['sha256', 'byteSize', 'linkage', 'version', 'configurationHash'])
  exact(body.authority.conversion, ['version', 'fpMode', 'implementationEvidenceHash'])
  exact(body.prefix, ['graph', 'graphHash', 'argv', 'compositionHash', 'emissionParametersHash'])
  exact(body.fragment, ['id', 'globalStartFrame', 'globalEndFrame', 'globalOrigin', 'domain'])
  exact(body.fragment.globalOrigin, ['pts', 'timeBase'])
  exact(body.fragment.domain, ['beforeFirstNowMs', 'endExclusiveNowMs', 'authorityHash'])
  exact(body.limits, ['maxFrames', 'maxTraceBytes', 'maxDurationMs'])
  exact(body.capture, ['provider', 'runId', 'complete', 'exitCode', 'traceSha256', 'traceByteSize'])
  check(body.schemaVersion === MATERIALIZED_SUBTITLE_CLOCK_VERSION &&
    body.canonicalPolicyVersion === OUTPUT_CANONICAL_POLICY_VERSION, 'Unsupported materialized subtitle clock policy')
  for (const [field, value] of Object.entries(body.scope)) {
    if (field.endsWith('Hash')) requireOutputHash(value, field)
    else requireOutputId(value, field)
  }
  assertRenderInputSpec(body.renderInput)
  const revision = sealOutputSpecRevision(body.specRevision.document, body.specRevision.createdCommand)
  check(revision.specHash === body.specRevision.specHash && revision.specHash === body.scope.outputSpecHash &&
    revision.document.id === body.scope.outputSpecRevisionId && revision.document.variantId === body.scope.variantId &&
    revision.document.workspaceId === body.scope.workspaceId && revision.document.projectId === body.scope.projectId,
  'Subtitle clock output revision scope/seal mismatch')
  check(body.role === 'proxy' || body.role === 'final', 'Subtitle clock canvas role is required')
  const encoding = revision.document.profile[body.role]
  check(body.renderInput.plan.versionId === body.scope.projectVersionId &&
    body.renderInput.output.id === body.scope.variantId && body.renderInput.output.width === encoding.width &&
    body.renderInput.output.height === encoding.height && body.renderInput.output.fps === encoding.fps,
  'Subtitle clock RenderInput scope/canvas differs from the exact spec revision')
  file(body.authority.ffmpeg); named(body.authority.ffmpeg.version, 'FFmpeg version missing')
  requireOutputHash(body.authority.ffmpeg.buildManifestHash, 'FFmpeg build manifest')
  file(body.authority.libass); named(body.authority.libass.version, 'libass version missing')
  requireOutputHash(body.authority.libass.configurationHash, 'libass effective parameters')
  check(body.authority.libass.linkage === 'embedded' || body.authority.libass.linkage === 'dynamic', 'libass linkage missing')
  if (body.authority.libass.linkage === 'embedded') check(body.authority.libass.sha256 === body.authority.ffmpeg.sha256 &&
    body.authority.libass.byteSize === body.authority.ffmpeg.byteSize, 'Embedded libass must bind exact FFmpeg bytes')
  check(body.authority.conversion.version === SUBTITLE_CLOCK_CONVERSION_POLICY &&
    body.authority.conversion.fpMode === 'binary64-nearest-even-each-operation', 'Unknown clock conversion policy')
  requireOutputHash(body.authority.conversion.implementationEvidenceHash, 'Pinned clock conversion implementation evidence')
  const names = new Set<string>()
  for (const library of body.authority.libraries) {
    exact(library, ['sha256', 'byteSize', 'name', 'version'])
    file(library); named(library.name, 'Library name missing'); named(library.version, 'Library version missing')
    check(!names.has(library.name), 'Duplicate library identity'); names.add(library.name)
  }
  const fonts = revision.document.profile.subtitles.fontAssets
  check(body.authority.fonts.length === fonts.length, 'Clock fonts differ from materialized subtitle profile')
  const fontIds = new Set<string>()
  for (const font of body.authority.fonts) {
    exact(font, ['sha256', 'byteSize', 'artifactId', 'family', 'face'])
    file(font); requireOutputId(font.artifactId, 'font artifact')
    named(font.family, 'Font family missing'); named(font.face, 'Font face missing')
    check(!fontIds.has(font.artifactId) && fonts.some((item) => item.artifactId === font.artifactId && item.sha256 === font.sha256),
      'Clock font identity differs from revision'); fontIds.add(font.artifactId)
    check(body.renderInput.assets.some((asset) => asset.kind === 'font' && asset.artifactId === font.artifactId &&
      asset.sha256 === font.sha256 && asset.byteSize === font.byteSize), 'Clock font bytes are absent from RenderInput')
  }
  const clips = new Set<string>(), consumed = new Set<string>()
  const sourceAssets = body.renderInput.assets.filter((asset) => ['video', 'audio', 'image'].includes(asset.kind))
  for (const source of body.sources) {
    exact(source, ['clipId', 'trackId', 'artifactId', 'manifestId', 'manifestHash', 'probeHash', 'sha256', 'byteSize',
      'sourceClock', 'sourceInFrame', 'sourceOutFrame', 'timelineInFrame', 'timelineOutFrame', 'rate', 'orientation',
      'nativeFrameDomain', 'rangeFrameDomain', 'timelineFrameDomain', 'normalization', 'rateMap'])
    exact(source.sourceClock, ['timeBase', 'firstPts', 'lastPts'])
    for (const [name, value] of Object.entries({ clipId: source.clipId, trackId: source.trackId,
      artifactId: source.artifactId, manifestId: source.manifestId })) requireOutputId(value, name)
    for (const hash of [source.manifestHash, source.probeHash, source.sha256]) requireOutputHash(hash, 'clock source seal')
    file(source)
    check(!clips.has(source.clipId), 'Duplicate clock clip identity'); clips.add(source.clipId)
    for (const domain of [source.nativeFrameDomain, source.rangeFrameDomain, source.timelineFrameDomain]) {
      exact(domain, ['schemaVersion', 'id', 'fps'])
      check(domain.schemaVersion === 'subtitle-frame-domain/v1', 'Unknown source frame domain')
      requireOutputId(domain.id, 'source frame domain'); timeBase(domain.fps)
    }
    const [rangeNum, rangeDen] = timeBase(source.rangeFrameDomain.fps)
    const [timelineNum, timelineDen] = timeBase(source.timelineFrameDomain.fps)
    check(source.rangeFrameDomain.id === source.timelineFrameDomain.id && rangeNum * timelineDen === timelineNum * rangeDen &&
      timelineNum === BigInt(body.renderInput.output.fps) * timelineDen, 'Frame ranges require the exact shared normalized timeline domain')
    const normalization = source.normalization
    check(normalization !== null && typeof normalization === 'object', 'Missing source frame normalization authority')
    const normalizationKeys = ['schemaVersion', 'kind', 'sourceFrameDomainId', 'rangeFrameDomainId', 'sourceProbeHash', 'traceSha256']
    check(['identity', 'graph-prefix', 'artifact'].includes(normalization.kind), 'Missing source frame normalization authority')
    exact(normalization, [...normalizationKeys, ...(normalization.kind === 'graph-prefix' ? ['graphHash'] :
      normalization.kind === 'artifact' ? ['artifactId', 'sha256', 'byteSize', 'probeHash'] : [])])
    check(normalization.schemaVersion === 'subtitle-frame-normalization/v1' &&
      normalization.sourceFrameDomainId === source.nativeFrameDomain.id && normalization.rangeFrameDomainId === source.rangeFrameDomain.id &&
      normalization.sourceProbeHash === source.probeHash, 'Source frame normalization binding differs')
    requireOutputHash(normalization.traceSha256, 'Measured source normalization trace')
    if (normalization.kind === 'identity') {
      const [nativeNum, nativeDen] = timeBase(source.nativeFrameDomain.fps)
      check(source.nativeFrameDomain.id === source.rangeFrameDomain.id && nativeNum * rangeDen === rangeNum * nativeDen &&
        normalization.traceSha256 === body.capture.traceSha256,
        'Identity normalization requires one materialized frame domain')
    } else if (normalization.kind === 'graph-prefix') {
      check(normalization.graphHash === body.prefix.graphHash && normalization.traceSha256 === body.capture.traceSha256,
        'Source normalization differs from measured graph prefix/trace')
    } else {
      requireOutputId(normalization.artifactId, 'Normalized source artifact'); file(normalization)
      requireOutputHash(normalization.probeHash, 'Normalized source probe')
    }
    const bytes = normalization.kind === 'artifact' ? normalization : source
    check(sourceAssets.some((asset) => asset.artifactId === bytes.artifactId && asset.sha256 === bytes.sha256 &&
      asset.byteSize === bytes.byteSize), 'Consumed clock source bytes differ from RenderInput')
    consumed.add(bytes.artifactId)
    exact(source.rateMap, ['schemaVersion', 'document', 'hash'])
    requireOutputHash(source.rateMap.hash, 'Materialized rate-map document')
    const { rateMap: _rateMap, ...mappedFacts } = source
    const expectedMap = { schemaVersion: 'subtitle-clock-rate-map/v1', canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION, ...mappedFacts }
    check(source.rateMap.schemaVersion === 'subtitle-clock-rate-map/v1' &&
      calculateOutputCanonicalHash(source.rateMap.document) === source.rateMap.hash &&
      calculateOutputCanonicalHash(expectedMap) === source.rateMap.hash, 'Materialized rate map contradicts source/domain/range facts')
    assertClipRate(source.rate); timeBase(source.sourceClock.timeBase)
    const firstPts = signed(source.sourceClock.firstPts), lastPts = signed(source.sourceClock.lastPts)
    check(firstPts !== MIN_I64 && lastPts !== MIN_I64 && lastPts >= firstPts, 'Invalid source clock range')
    check([source.sourceInFrame, source.sourceOutFrame, source.timelineInFrame, source.timelineOutFrame].every(integer) &&
      source.sourceOutFrame > source.sourceInFrame && source.timelineOutFrame > source.timelineInFrame &&
      source.timelineOutFrame <= body.renderInput.output.durationInFrames &&
      timelineSpanForRate(source.sourceOutFrame - source.sourceInFrame, source.rate) === source.timelineOutFrame - source.timelineInFrame &&
      Number.isFinite(source.orientation), 'Invalid source ranges/orientation')
  }
  check(sourceAssets.every((asset) => consumed.has(asset.artifactId)), 'Missing consumed clock source provenance')
  check(typeof body.prefix.graph === 'string' && Buffer.byteLength(body.prefix.graph, 'utf8') <= 524288 &&
    Array.isArray(body.prefix.argv) && body.prefix.argv.length > 0 && body.prefix.argv.length <= 4096 &&
    body.prefix.argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')), 'Exact pre-libass graph/argv missing')
  requireOutputHash(body.prefix.graphHash, 'graph hash')
  check(calculateOutputCanonicalHash({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    graph: body.prefix.graph, argv: body.prefix.argv }) === body.prefix.graphHash, 'Graph bytes/argv seal mismatch')
  for (const hash of [body.prefix.compositionHash, body.prefix.emissionParametersHash]) requireOutputHash(hash, 'clock composition seal')
  const fragment = body.fragment
  requireOutputId(fragment.id, 'fragment id')
  check(integer(fragment.globalStartFrame) && integer(fragment.globalEndFrame) && fragment.globalEndFrame > fragment.globalStartFrame &&
    fragment.globalEndFrame <= body.renderInput.output.durationInFrames, 'Invalid global fragment range')
  signed(fragment.globalOrigin.pts); timeBase(fragment.globalOrigin.timeBase)
  const count = fragment.globalEndFrame - fragment.globalStartFrame
  check(integer(body.limits.maxFrames) && body.limits.maxFrames >= count &&
    integer(body.limits.maxTraceBytes) && body.limits.maxTraceBytes > 0, 'Clock capture limits missing')
  const before = signed(fragment.domain.beforeFirstNowMs), end = signed(fragment.domain.endExclusiveNowMs)
  requireOutputHash(fragment.domain.authorityHash, 'Explicit composition domain bounds authority')
  const maxDuration = signed(body.limits.maxDurationMs)
  check(maxDuration > BigInt(0) && end > before && end - before <= maxDuration, 'Clock duration limit exceeded')
  check(body.capture.provider === 'ffmpeg-showinfo-pre-libass/v1' && body.capture.complete === true && body.capture.exitCode === 0 &&
    integer(body.capture.traceByteSize) && body.capture.traceByteSize > 0 && body.capture.traceByteSize <= body.limits.maxTraceBytes,
  'Clock capture is incomplete or exceeds its byte budget')
  requireOutputId(body.capture.runId, 'clock owner run'); requireOutputHash(body.capture.traceSha256, 'clock trace bytes')
  check(body.frames.length === count && count <= body.limits.maxFrames, 'Clock frame count differs from fragment')
  let previous: ObservedClockFrame | undefined, previousMs = before
  for (const [index, frame] of body.frames.entries()) {
    exact(frame, ['frame', 'pts', 'timeBase'])
    check(frame.frame === index && integer(frame.frame), 'Clock frames are missing, duplicated or out of order')
    const [num, den] = timeBase(frame.timeBase), pts = signed(frame.pts)
    if (previous) {
      const [oldNum, oldDen] = timeBase(previous.timeBase)
      check(pts * num * oldDen > signed(previous.pts) * oldNum * den, 'Clock PTS is duplicate or nonmonotonic')
    }
    const now = frameMs(frame)
    check((index === 0 ? now > before : now >= previousMs) && now < end,
      'Millisecond clock is nonmonotonic or outside explicit composition domain')
    previous = frame; previousMs = now
  }
  return immutable({ ...body, clockHash: calculateOutputCanonicalHash(body) })
}
export function requireMaterializedSubtitleClock(clock: MaterializedSubtitleClock): Readonly<MaterializedSubtitleClock> {
  const { clockHash, ...body } = clock
  const recreated = createMaterializedSubtitleClock(body)
  check(clockHash === recreated.clockHash, 'Materialized subtitle clock seal differs')
  return recreated
}
/** The closure owns one completely validated immutable clock and its integer
 * index. There is no unchecked constructor, flag or externally supplied index. */
export function createMaterializedAssClockLookup(input: MaterializedSubtitleClock): Readonly<{
  clock: Readonly<MaterializedSubtitleClock>
  boundary(frame: number): bigint
  interval(start: number, end: number): Readonly<{ startCs: bigint; endCs: bigint }>
}> {
  const clock = requireMaterializedSubtitleClock(input)
  const now = clock.frames.map(frameMs)
  // One implementation of the representable-interval binder serves this observed
  // clock and the closed-form clock of the pre-libass stage (see libass-clock-model.ts).
  const { boundary, interval } = createAssBoundaryBinder({ frameCount: now.length, nowMsAt: (frame) => now[frame]!,
    beforeFirstNowMs: signed(clock.fragment.domain.beforeFirstNowMs), endExclusiveNowMs: signed(clock.fragment.domain.endExclusiveNowMs) })
  return Object.freeze({ clock, boundary, interval })
}
export function materializedAssBoundary(clock: MaterializedSubtitleClock, frame: number): bigint {
  return createMaterializedAssClockLookup(clock).boundary(frame)
}
export function materializedAssInterval(clock: MaterializedSubtitleClock, start: number, end: number): Readonly<{ startCs: bigint; endCs: bigint }> {
  return createMaterializedAssClockLookup(clock).interval(start, end)
}
function replaySemanticBody(clock: Readonly<MaterializedSubtitleClock>): object {
  const { capture: _capture, clockHash: _seal, sources, ...body } = clock
  return { ...body, sources: sources.map((source) => {
    // Both full rate-map documents/digests were independently checked before this
    // projection. Only the capture trace and the digest derived from it differ;
    // retain the complete map document and envelope schema for semantic comparison.
    const { rateMap, normalization, ...facts } = source
    if (normalization.kind === 'artifact') return source
    const { traceSha256: _runTrace, ...normalizedFacts } = normalization
    return { ...facts, normalization: normalizedFacts, rateMap: { schemaVersion: rateMap.schemaVersion,
      document: { ...rateMap.document, normalization: normalizedFacts } } }
  }) }
}
/** Whole-sequence replay comparison after independently validating both captures.
 * Distinct run identity is mandatory; proof bytes may differ while all parsed PTS/TB
 * and semantic dependencies must agree. Neither sampled PTS nor equal FPS suffices. */
export function assertSubtitleClockReplay(prepared: MaterializedSubtitleClock, replayed: MaterializedSubtitleClock): void {
  const before = requireMaterializedSubtitleClock(prepared), after = requireMaterializedSubtitleClock(replayed)
  check(before.capture.runId !== after.capture.runId, 'Subtitle clock replay requires a distinct capture run')
  check(calculateOutputCanonicalHash(replaySemanticBody(before)) === calculateOutputCanonicalHash(replaySemanticBody(after)),
    'Definitive pre-libass clock or dependencies changed')
}

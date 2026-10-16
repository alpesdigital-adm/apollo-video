import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { createOutputSpecRevisionBody, sealOutputSpecRevision } from '../../src/v2/domain/output-spec-revision.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'
import { createMaterializedSubtitleClock, requireMaterializedSubtitleClock, derivePinnedLibassNowMs,
  legalAssCentisecondPreimage, materializedAssInterval, materializedAssBoundary, assCentisecondTimestamp, createMaterializedAssClockLookup,
  assertSubtitleClockReplay, MATERIALIZED_SUBTITLE_CLOCK_VERSION, SUBTITLE_CLOCK_CONVERSION_POLICY } from '../../src/v2/domain/materialized-subtitle-clock.ts'
import { serializeMaterializedAssEvents, materializedAssParametersHash } from '../../src/v2/domain/materialized-ass-events.ts'

// Metadata/numeric fixtures only. These tests never read private evidence, pixels or FFmpeg.
const h = 'a'.repeat(64), sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex')
const policy = { canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION }
const tb = (denominator) => ({ numerator: '1', denominator: String(denominator) })
const domain = (id, fps) => ({ schemaVersion: 'subtitle-frame-domain/v1', id, fps: { numerator: String(fps), denominator: '1' } })
function resealRateMap(source) {
  const { rateMap: _old, ...facts } = source
  const document = { schemaVersion: 'subtitle-clock-rate-map/v1', ...policy, ...facts }
  source.rateMap = { schemaVersion: document.schemaVersion, document, hash: calculateOutputCanonicalHash(document) }
  return source
}
const clockSource = (rate = 1, trackId = 'track-alpha', clipId = 'clip-alpha', fps = 30) => resealRateMap({
  clipId, trackId, artifactId: 'source-alpha', manifestId: 'manifest-alpha', manifestHash: h,
  probeHash: h, sha256: h, byteSize: 1024, sourceClock: { timeBase: tb(240), firstPts: '0', lastPts: '1439' },
  sourceInFrame: 0, sourceOutFrame: 6, timelineInFrame: 0, timelineOutFrame: Math.round(6 / rate), rate,
  orientation: 90, nativeFrameDomain: domain('native-alpha', 60),
  rangeFrameDomain: domain('normalized-timeline-alpha', fps), timelineFrameDomain: domain('normalized-timeline-alpha', fps),
  normalization: { schemaVersion: 'subtitle-frame-normalization/v1', kind: 'graph-prefix', sourceFrameDomainId: 'native-alpha',
    rangeFrameDomainId: 'normalized-timeline-alpha', sourceProbeHash: h, traceSha256: h,
    graphHash: calculateOutputCanonicalHash({ ...policy, graph: `[0:v]fps=${fps},setpts=PTS-STARTPTS[preass]`, argv: ['-threads', '1'] }) },
})
function body({ fps = 30, frames = [0, 1, 2, 3, 4, 5], timeBase = tb(fps), rate = 1 } = {}) {
  const configuration = { schemaVersion: 'controlled-subtitle-configuration/v1', ...policy, purpose: 'contract fixture, no face approval' }
  const encoding = (kind) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
    width: 320, height: 320, fps, quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
    audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
  const document = createOutputSpecRevisionBody({ ...policy,
    id: 'revision-alpha', variantId: 'variant-alpha', workspaceId: 'workspace-alpha', projectId: 'project-alpha', revisionNumber: 1,
    output: { id: 'variant-alpha', locale: 'pt-BR', aspectRatio: '1:1', width: 320, height: 320, fps,
      safeArea: { top: .05, bottom: .05, left: .05, right: .05 }, deliveryProfileId: 'profile-alpha' },
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: 'profile-alpha', version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final'), proxy: encoding('proxy'),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 1, scaleY: 1 },
      subtitles: { mode: 'burn-in', configuration: { schemaVersion: configuration.schemaVersion, document: configuration,
        hash: calculateOutputCanonicalHash(configuration) }, fontAssets: [{ artifactId: 'font-alpha', sha256: h }] } },
    preset: null, createdAt: '2026-10-12T00:00:00.000Z',
  })
  const specRevision = sealOutputSpecRevision(document, { kind: 'edit-command', id: 'command-output-alpha', hash: h })
  const { schemaVersion: _schema, ...output } = document.output
  const renderInput = createRenderInputSpec({ schemaVersion: 'render-input/v1',
    renderer: { id: 'controlled-editorial', version: 'clock-contract-v1', digest: h },
    composition: { id: 'composition-alpha', version: 'clock-v1', propsSchemaRef: 'apollo://render-props/clock-contract/v1' },
    plan: { id: 'plan-alpha', versionId: 'version-alpha', hash: h },
    output: { ...output, durationInFrames: Math.max(frames.length, Math.round(6 / rate)) },
    assets: [{ id: 'asset-alpha', artifactId: 'source-alpha', artifactKey: 'source/alpha', kind: 'video',
      role: 'source-master', ordinal: 0, sha256: h, byteSize: 1024 },
    { id: 'font-asset-alpha', artifactId: 'font-alpha', artifactKey: 'font/alpha', kind: 'font',
      role: 'subtitle-font', ordinal: 1, sha256: h, byteSize: 1024 }], props: { scope: 'controlled-contract-only' },
  })
  const fonts = [{ artifactId: 'font-alpha', sha256: h, byteSize: 1024, family: 'Arial', face: 'ArialMT' }]
  const prefix = { graph: `[0:v]fps=${fps},setpts=PTS-STARTPTS[preass]`, argv: ['-threads', '1'], compositionHash: h,
    emissionParametersHash: materializedAssParametersHash({ preamble, fonts, libassConfigurationHash: h, width: 320, height: 320 }) }
  return { schemaVersion: MATERIALIZED_SUBTITLE_CLOCK_VERSION, ...policy,
    scope: { workspaceId: 'workspace-alpha', projectId: 'project-alpha', projectVersionId: 'version-alpha',
      variantId: 'variant-alpha', outputSpecRevisionId: 'revision-alpha', outputSpecHash: specRevision.specHash, outputStateHash: h },
    role: 'final', renderInput, specRevision,
    authority: { ffmpeg: { sha256: h, byteSize: 1024, version: 'controlled-pin', buildManifestHash: h },
      libraries: [], libass: { sha256: h, byteSize: 1024, linkage: 'embedded', version: 'controlled-libass-pin', configurationHash: h },
      fonts,
      conversion: { version: SUBTITLE_CLOCK_CONVERSION_POLICY, fpMode: 'binary64-nearest-even-each-operation', implementationEvidenceHash: h } },
    sources: [clockSource(rate, 'track-alpha', 'clip-alpha', fps)],
    prefix: { ...prefix, graphHash: calculateOutputCanonicalHash({ ...policy, graph: prefix.graph, argv: prefix.argv }) },
    fragment: { id: 'fragment-alpha', globalStartFrame: 0, globalEndFrame: frames.length,
      globalOrigin: { pts: '0', timeBase },
      domain: { beforeFirstNowMs: '-1', endExclusiveNowMs: '1000', authorityHash: h } },
    limits: { maxFrames: frames.length, maxTraceBytes: 65536, maxDurationMs: '2000' },
    capture: { provider: 'ffmpeg-showinfo-pre-libass/v1', runId: 'controlled-prepare-alpha', complete: true, exitCode: 0,
      traceSha256: h, traceByteSize: 1024 },
    frames: frames.map((pts, frame) => ({ frame, pts: String(pts), timeBase })),
  }
}
const clock = (options) => createMaterializedSubtitleClock(body(options))
const cue = (overrides = {}) => ({ cueId: 'cue-alpha', kind: 'subtitle', localStartFrame: 1, localEndFrame: 2,
  originalText: 'Hello world', sourceTextSha256: sha('Hello world'), wrappedLines: ['Hello', 'world'],
  wrapPolicyHash: h, suppressed: false, anchorDecisionHash: h, point: { x: 160, y: 250 }, ...overrides })
const preamble = ['[Script Info]', 'ScriptType: v4.00+', 'WrapStyle: 2', 'PlayResX: 320', 'PlayResY: 320', '',
  '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
  'Style: Default,Arial,32,&H00FFFFFF,&H0038AFE1,&H00111111,&H78000000,-1,0,0,0,100,100,0,0,3,1,0,2,20,20,20,1',
  'Style: CTA,Arial,28,&H00111111,&H00111111,&H00FFFFFF,&H00E1AF38,-1,0,0,0,100,100,0,0,3,2,0,8,20,20,20,1', '',
  '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text', ''].join('\n')
const emit = (cues, observed = clock(), overrides = {}) => serializeMaterializedAssEvents({
  clock: observed, preamble, emissionParametersHash: observed.prefix.emissionParametersHash, cues, ...overrides,
})

test('v5 independent observed PTS/TB vectors preserve 6/111/803 physical discriminations', () => {
  // Authenticated v5 proof SHA d3d41f5befabb32b612e621e553163136eb7676d8ac2c6eabb43b57431ed0931.
  // raw pixels were reviewed in that historical FAIL; nowMs below is inferred, never internally measured.
  const vectors = [
    { file: 'execution-032.json', sha256: '98ac35fcbdb3ee734b4a9e0b53cb954c812046001a3e8be5b846fac7ba4d16cb',
      target: 6, pts: '6', tb: tb(60), expectedMs: 100n, beforePixels: [], afterPixels: [6] },
    { file: 'execution-039.json', sha256: '52a22c09d0cb109d5b063bfea99a61b00693d1eecf476c1deed4a8650af5ca3f',
      target: 6, pts: '100000', tb: tb(1000000), expectedMs: 99n, beforePixels: [6], afterPixels: [] },
    { file: 'execution-046.json', sha256: '271acb2b074a1d5cbe8e6a8069a4d1fae1f6712265961a0b39c12a50e8cdcf24',
      target: 111, pts: '111', tb: tb(30), expectedMs: 3699n, beforePixels: [111], afterPixels: [] },
    { file: 'execution-053.json', sha256: '77c153ecdcf33b27655923fcecbebf8bc3560bfd6364b8120d54902416f722bd',
      target: 111, pts: '3700000', tb: tb(1000000), expectedMs: 3699n, beforePixels: [111], afterPixels: [] },
    { file: 'execution-060.json', sha256: 'cf86475821d6c7ceb4d16d1f69459a8133dc2086b5a70aa6d1c34b0e7c310d22',
      target: 803, pts: '803', tb: tb(100), expectedMs: 8029n, beforePixels: [802, 803], afterPixels: [] },
    { file: 'execution-067.json', sha256: 'f3f4c2240601b2f7cb9921f314240f4f33468ecb67f396a933e6ef005ed3d87a',
      target: 803, pts: '8030000', tb: tb(1000000), expectedMs: 8029n, beforePixels: [802, 803], afterPixels: [804] },
  ]
  for (const vector of vectors) assert.equal(derivePinnedLibassNowMs(vector.pts, vector.tb), vector.expectedMs, vector.file)
  assert.deepEqual(vectors[1].beforePixels, [6])
  assert.deepEqual(vectors[2].beforePixels, [111])
  assert.deepEqual(vectors[5].beforePixels, [802, 803])
  assert.deepEqual(vectors[5].afterPixels, [804])
  // Requested physical oracle remains exactly [803], not changed to neighboring lit frames.
  const requested = [803]
  assert.notDeepEqual(vectors[5].beforePixels, requested); assert.notDeepEqual(vectors[5].afterPixels, requested)
  assert.throws(() => legalAssCentisecondPreimage(8020n, 8029n), /not representable/)
})

test('integer preimage uses strict predecessor and inclusive current with no epsilon', () => {
  assert.deepEqual(legalAssCentisecondPreimage(83n, 99n), { minimum: 9n, maximum: 9n })
  assert.deepEqual(legalAssCentisecondPreimage(83n, 100n), { minimum: 9n, maximum: 10n })
  assert.deepEqual(legalAssCentisecondPreimage(-1n, 0n), { minimum: 0n, maximum: 0n })
  assert.throws(() => legalAssCentisecondPreimage(100n, 100n), /ordered/)
  assert.equal(assCentisecondTimestamp(360123n), '1:00:01.23')
  for (const [pts, timeBase] of [['NOPTS', tb(30)], ['-9223372036854775808', tb(30)],
    ['9223372036854775808', tb(30)], ['1', tb(0)], ['1', { numerator: '2147483648', denominator: '1' }],
    ['9223372036854775807', { numerator: '2147483647', denominator: '1' }]])
    assert.throws(() => derivePinnedLibassNowMs(pts, timeBase))
})

test('30fps [1,2), first/last explicit domain boundaries, 120fps capacity per interval', () => {
  const observed = clock()
  assert.deepEqual(materializedAssInterval(observed, 1, 2), { startCs: 3n, endCs: 6n })
  assert.equal(materializedAssBoundary(observed, 0), 0n)
  assert.equal(materializedAssBoundary(observed, 6), 100n)
  const fast = clock({ fps: 120 })
  assert.throws(() => materializedAssInterval(fast, 1, 2), /not representable/)
  assert.deepEqual(materializedAssInterval(fast, 2, 3), { startCs: 1n, endCs: 2n })
  assert.equal(fast.renderInput.output.fps, 120)
})

test('rates .25–4, mixed source timebases, rotation and distinct multilayer tracks remain admitted', () => {
  for (const rate of [.25, 1, 4]) assert.equal(clock({ rate }).sources[0].rate, rate)
  const input = body()
  input.sources.push(clockSource(1, 'track-overlay', 'clip-overlay'))
  input.sources[1].orientation = 89.75
  input.sources[1].sourceClock.timeBase = tb(1001)
  resealRateMap(input.sources[1])
  assert.equal(createMaterializedSubtitleClock(input).sources.length, 2)
})

test('native FPS differs only with explicit measured normalization and exact sealed frame-domain rate map', () => {
  const input = body(), observed = createMaterializedSubtitleClock(input)
  assert.equal(observed.sources[0].nativeFrameDomain.fps.numerator, '60')
  assert.equal(observed.sources[0].rangeFrameDomain.fps.numerator, '30')
  assert.equal(observed.sources[0].normalization.kind, 'graph-prefix')
  assert.deepEqual(observed.renderInput.assets.map((asset) => asset.artifactId), ['source-alpha', 'font-alpha'])
  // Controlled declaration only: these assertions do not prove renderer normalization.
  for (const mutate of [
    (source) => { source.rateMap.document.sourceOutFrame = 7; source.rateMap.hash = calculateOutputCanonicalHash(source.rateMap.document) },
    (source) => { source.sourceOutFrame = 7; resealRateMap(source) },
    (source) => { source.normalization.sourceProbeHash = 'b'.repeat(64); resealRateMap(source) },
    (source) => { source.timelineFrameDomain = domain('unrelated-timeline', 30); resealRateMap(source) },
    (source) => { source.normalization.graphHash = 'b'.repeat(64); resealRateMap(source) },
    (source) => { source.normalization = { schemaVersion: 'subtitle-frame-normalization/v1', kind: 'identity',
      sourceFrameDomainId: 'native-alpha', rangeFrameDomainId: 'normalized-timeline-alpha', sourceProbeHash: h, traceSha256: h }; resealRateMap(source) },
    (source) => { delete source.normalization },
  ]) { const value = body(); mutate(value.sources[0]); assert.throws(() => createMaterializedSubtitleClock(value)) }
  const identity = body()
  identity.sources[0].nativeFrameDomain = domain('normalized-timeline-alpha', 30)
  identity.sources[0].normalization = { schemaVersion: 'subtitle-frame-normalization/v1', kind: 'identity',
    sourceFrameDomainId: 'normalized-timeline-alpha', rangeFrameDomainId: 'normalized-timeline-alpha', sourceProbeHash: h, traceSha256: h }
  resealRateMap(identity.sources[0])
  assert.equal(createMaterializedSubtitleClock(identity).sources[0].normalization.kind, 'identity')
  const artifact = body()
  artifact.sources[0].normalization = { schemaVersion: 'subtitle-frame-normalization/v1', kind: 'artifact',
    sourceFrameDomainId: 'native-alpha', rangeFrameDomainId: 'normalized-timeline-alpha', sourceProbeHash: h, traceSha256: h,
    artifactId: 'normalized-alpha', sha256: 'b'.repeat(64), byteSize: 2048, probeHash: 'c'.repeat(64) }
  resealRateMap(artifact.sources[0])
  const { inputHash: _hash, composition, output, ...rest } = artifact.renderInput
  const { propsHash: _props, ...compositionInput } = composition
  const { schemaVersion: _output, ...outputInput } = output
  artifact.renderInput = createRenderInputSpec({ ...rest, composition: compositionInput, output: outputInput,
    assets: rest.assets.map((asset) => asset.kind === 'video' ? { ...asset, artifactId: 'normalized-alpha', sha256: 'b'.repeat(64), byteSize: 2048 } : asset) })
  assert.equal(createMaterializedSubtitleClock(artifact).renderInput.assets[0].artifactId, 'normalized-alpha')
  artifact.sources[0].normalization.byteSize = 2049; resealRateMap(artifact.sources[0])
  assert.throws(() => createMaterializedSubtitleClock(artifact), /Consumed clock source bytes/)
})

test('distinct PTS collapsed to one libass millisecond block only an unrepresentable requested boundary', () => {
  const observed = clock({ fps: 120, timeBase: tb(1000000) })
  assert.equal(observed.frames.length, 6)
  assert.throws(() => materializedAssInterval(observed, 1, 2), /ordered/)
  assert.deepEqual(materializedAssInterval(observed, 0, 6), { startCs: 0n, endCs: 100n })
})

test('missing/duplicate/nonmonotonic/incomplete/overflow clocks fail before ASS emission', () => {
  const mutations = [
    (value) => value.frames.pop(),
    (value) => { value.frames[2].frame = 1 },
    (value) => { value.frames[2].pts = value.frames[1].pts },
    (value) => { value.frames[2].pts = '0' },
    (value) => { value.frames[1].pts = 'NOPTS' },
    (value) => { value.capture.complete = false },
    (value) => { value.capture.exitCode = 1 },
    (value) => { value.outputSha256 = h },
    (value) => { value.capture.futureReceiptHash = h },
    (value) => { delete value.scope.outputStateHash },
    (value) => { value.capture.traceByteSize = value.limits.maxTraceBytes + 1 },
    (value) => { value.fragment.domain.endExclusiveNowMs = '9223372036854775808' },
    (value) => { delete value.fragment.domain.beforeFirstNowMs },
    (value) => { value.authority.conversion.version = 'ass-frame-clock/v1' },
    (value) => { value.authority.ffmpeg.sha256 = 'changed' },
    (value) => { value.scope.variantId = 'sister-variant' },
    (value) => { value.scope.projectVersionId = 'sister-version' },
    (value) => { value.prefix.graph += ',fps=1' },
    (value) => { value.sources[0].sha256 = 'b'.repeat(64) },
    (value) => { value.specRevision.document.output.width = 322 },
  ]
  for (const mutate of mutations) { const value = structuredClone(body()); mutate(value); assert.throws(() => createMaterializedSubtitleClock(value)) }
  const altered = structuredClone(clock()); altered.frames[1].pts = '2'
  assert.throws(() => requireMaterializedSubtitleClock(altered))
})

test('definitive execution must replay whole clock and exact dependency identity, not sample/FPS', () => {
  const capture = (input, runId) => {
    // Independent controlled raw bytes, not a native showinfo acquisition or a copied
    // proof hash. The future collector must parse/bind authenticated real traces.
    const rawTrace = JSON.stringify({ scope: 'controlled-trace-fixture', runId, frames: input.frames }) + '\n'
    input.capture.runId = runId
    input.capture.traceSha256 = sha(rawTrace); input.capture.traceByteSize = Buffer.byteLength(rawTrace, 'utf8')
    for (const source of input.sources) {
      if (source.normalization.kind !== 'artifact') source.normalization.traceSha256 = input.capture.traceSha256
      resealRateMap(source)
    }
    return { observed: createMaterializedSubtitleClock(input), rawTrace }
  }
  const first = capture(body(), 'controlled-prepare-alpha'), second = capture(body(), 'controlled-replay-alpha')
  const prepared = first.observed, replayed = second.observed
  assert.notEqual(first.rawTrace, second.rawTrace)
  assert.notEqual(prepared.capture.traceSha256, replayed.capture.traceSha256)
  for (const { observed, rawTrace } of [first, second]) {
    assert.equal(observed.capture.traceSha256, sha(rawTrace))
    assert.equal(observed.capture.traceByteSize, Buffer.byteLength(rawTrace, 'utf8'))
    assert.equal(observed.sources[0].normalization.traceSha256, observed.capture.traceSha256)
  }
  assertSubtitleClockReplay(prepared, replayed)
  assert.throws(() => assertSubtitleClockReplay(prepared, prepared), /distinct capture run/)
  assert.throws(() => assertSubtitleClockReplay(prepared, capture(body(), prepared.capture.runId).observed), /distinct capture run/)
  const incoherent = body()
  incoherent.capture.runId = 'controlled-incoherent-alpha'
  incoherent.capture.traceSha256 = sha('controlled distinct but unbound raw trace\n')
  incoherent.sources[0].normalization.traceSha256 = h
  resealRateMap(incoherent.sources[0])
  assert.throws(() => createMaterializedSubtitleClock(incoherent), /normalization.*prefix\/trace/)
  for (const mutate of [
    (value) => { value.frames[1].pts = '2'; value.frames[2].pts = '3'; value.frames[3].pts = '4'; value.frames[4].pts = '5'; value.frames[5].pts = '6' },
    (value) => { value.authority.ffmpeg.version = 'different-build-version' },
    (value) => { value.fragment.globalOrigin.pts = '1' },
    (value) => { value.sources[0].orientation = 89.75 },
  ]) { const value = body(); mutate(value); const changed = capture(value, 'controlled-replay-changed').observed
    assert.throws(() => assertSubtitleClockReplay(prepared, changed), /changed/) }
})

test('post-wrap subtitle/CTA events are bijective, centisecond exact and sealed without future MP4 identity', () => {
  const receipt = emit([cue(), cue({ cueId: 'cta-alpha', kind: 'cta', localStartFrame: 2, localEndFrame: 3, point: { x: 160, y: 32 } })])
  assert.equal(receipt.emitted[0].assEventLine, 'Dialogue: 0,0:00:00.03,0:00:00.06,Default,,0,0,0,,{\\an5\\pos(160,250)}Hello\\Nworld')
  assert.equal(receipt.emitted[1].assEventLine, 'Dialogue: 1,0:00:00.06,0:00:00.10,CTA,,0,0,0,,{\\an8\\pos(160,32)}Hello\\Nworld')
  assert.equal(receipt.emitted[0].displayText, 'Hello\nworld')
  assert.equal(receipt.assSha256, sha(receipt.assText))
  assert.equal(Object.hasOwn(receipt, 'outputSha256'), false)
  assert.equal(emit([]).emitted.length, 0)
  assert.deepEqual(emit([cue({ suppressed: true, wrappedLines: [], point: null })]).suppressedCueIds, ['cue-alpha'])
})

test('post-wrap corruption, control characters, duplicates and unknown bounds fail instead of repairing text/clock', () => {
  for (const character of ['\0', '\x01', '\r', '\x7f']) {
    const originalText = 'Hello' + character + 'world'
    assert.throws(() => emit([cue({ originalText, sourceTextSha256: sha(originalText) })]), /control/)
  }
  for (const overrides of [
    { wrappedLines: ['Hello'] }, { wrappedLines: [] }, { wrappedLines: ['{\\pos(0,0)}Hello world'] },
    { point: null }, { point: { x: 320, y: 30 } }, { originalText: '' }, { sourceTextSha256: 'b'.repeat(64) },
  ]) assert.throws(() => emit([cue(overrides)]))
  assert.throws(() => emit([cue(), cue()]), /Duplicate/)
  assert.throws(() => emit([cue(), cue({ cueId: 'cue-sister' })]), /bijective/)
  assert.throws(() => emit([cue()], clock(), { emissionParametersHash: 'b'.repeat(64) }), /parameters/)
  assert.throws(() => emit([cue()], clock(), { preamble: preamble + 'Dialogue: 0,already\n' }), /preamble/)
})

test('fully resealed ASS preambles reject field reinterpretation, duplicate canvas and duplicate/reordered sections', () => {
  const mutations = [
    preamble.replace('Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
      'Format: Start,Layer,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text'),
    preamble.replace('Format: Name,Fontname,Fontsize', 'Format: Fontname,Name,Fontsize'),
    preamble.replace('PlayResX: 320', 'PlayResX: 320\n  playresx : 320'),
    preamble.replace('PlayResY: 320', 'PlayResY: 320\n PLAYRESY: 320'),
    preamble.replace('[Events]', '[Events]\n[Events]'),
    preamble.replace('[V4+ Styles]', '[v4+ styles]'),
    preamble.replace('[Script Info]', '[Events]'),
    preamble + ' dialogue: 0,already\n',
    preamble.replace('Format: Layer,', 'Format: Layer,Layer,'),
  ]
  for (const changed of mutations) {
    const value = body()
    value.prefix.emissionParametersHash = materializedAssParametersHash({ preamble: changed, fonts: value.authority.fonts,
      libassConfigurationHash: value.authority.libass.configurationHash, width: 320, height: 320 })
    const prepared = createMaterializedSubtitleClock(value)
    assert.throws(() => emit([cue()], prepared, { preamble: changed }), /ASS (?:Format|Script Info|preamble)/)
  }
})

test('one validated immutable clock lookup preserves multiple cue boundaries and rejects a forged clock', () => {
  const observed = clock(), lookup = createMaterializedAssClockLookup(observed)
  assert.deepEqual([lookup.interval(1, 2), lookup.interval(2, 3), lookup.interval(3, 4)],
    [{ startCs: 3n, endCs: 6n }, { startCs: 6n, endCs: 10n }, { startCs: 10n, endCs: 13n }])
  const emitted = emit([cue(), cue({ cueId: 'cue-beta', localStartFrame: 2, localEndFrame: 3 }),
    cue({ cueId: 'cue-gamma', localStartFrame: 3, localEndFrame: 4 })], observed)
  assert.deepEqual(emitted.emitted.map((event) => event.assEventLine.split(',').slice(1, 3)),
    [['0:00:00.03', '0:00:00.06'], ['0:00:00.06', '0:00:00.10'], ['0:00:00.10', '0:00:00.13']])
  const forged = structuredClone(observed); forged.clockHash = 'b'.repeat(64)
  assert.throws(() => createMaterializedAssClockLookup(forged), /seal/)
  assert.throws(() => emit([cue(), cue({ cueId: 'cue-beta', localStartFrame: 2, localEndFrame: 3 })], forged), /seal/)
})

test('clipped/rebased fragments revalidate local intervals and retain global cue identities', () => {
  const value = body()
  const input = value.renderInput
  const { inputHash: _inputHash, composition, output, ...rest } = input
  const { propsHash: _propsHash, ...compositionInput } = composition
  const { schemaVersion: _outputSchema, ...outputInput } = output
  value.renderInput = createRenderInputSpec({ ...rest, composition: compositionInput, output: { ...outputInput, durationInFrames: 12 } })
  value.fragment.globalStartFrame = 5; value.fragment.globalEndFrame = 11
  value.fragment.globalOrigin.pts = '5'
  const fragment = createMaterializedSubtitleClock(value)
  const document = emit([cue({ localStartFrame: 0, localEndFrame: 3 })], fragment)
  assert.equal(document.emitted[0].globalStartFrame, 5)
  assert.equal(document.emitted[0].globalEndFrame, 8)
  assert.equal(document.emitted[0].assEventLine.split(',')[1], '0:00:00.00')
  const fast = clock({ fps: 120 })
  assert.throws(() => emit([cue({ localStartFrame: 1, localEndFrame: 2 })], fast), /not representable/)
})

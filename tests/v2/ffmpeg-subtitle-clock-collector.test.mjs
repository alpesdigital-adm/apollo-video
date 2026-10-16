import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { buildEditorialCompositionPrefix } from '../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts'

import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { createMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { createOutputSpecRevisionBody, sealOutputSpecRevision } from '../../src/v2/domain/output-spec-revision.ts'
import { OUTPUT_CANONICAL_POLICY_VERSION } from '../../src/v2/domain/output-canonical-policy.ts'
import { FfmpegSubtitleClockCollector, parseEditorialPreAssTrace, parseEditorialMp4Clock,
  validateEditorialClockRequest } from '../../src/v2/infrastructure/media/ffmpeg-subtitle-clock-collector.ts'
import { NodeOwnedFfmpegExecutor, OwnedFfmpegProcessFailure, OwnedFfmpegTerminalInconclusive, INSPECTOR_PROCESS_TIMEOUT_MS,
  INSPECTOR_PROCESS_MAX_OUTPUT_BYTES } from '../../src/v2/infrastructure/media/ffmpeg-owned-process.ts'

// Pre-extraction declarations read from the original closure, never produced by
// buildEditorialCompositionPrefix. Original renderer source SHA before edits:
const HISTORICAL_RENDERER_SHA256 = '939e24d69989741dc8ab99c170b65796750a844ec702995e0342311eca78bc3d'
const BACKGROUND_LITERAL = [
  '[joinedv]split=2[background0][foreground0]',
  '[background0]scale=320:180:force_original_aspect_ratio=increase,crop=320:180,gblur=sigma=28[background]',
  '[foreground0]scale=320:180:force_original_aspect_ratio=decrease,scale=iw*1.0000:ih*1.0000[foreground]',
  '[background][foreground]overlay=(W-w)/2:max(0\\,min(H-h\\,H*0.5000-h/2)):shortest=1,format=yuv420p[composed]',
]
const VIDEO_INPUT_LITERAL = [{ path: '/staged/source.mp4', ss: '0.000000', t: '0.300000' }]
function goldenContext(rate = 1, musicAndPlacement = false) {
  const preset = readOutputFormatPreset('16:9')
  const placementBody = { schemaVersion: 'render-placement-plan/v1', outputSpecId: preset.spec.id,
    outputPresetHash: preset.presetHash, format: '16:9', canvas: { width: 320, height: 180 }, durationFrames: 8,
    subtitleRegion: null, subtitleAnchorPlan: null,
    placements: [{ elementId: 'logo-golden', kind: 'logo', bounds: { x: .1, y: .1, width: .2, height: .2 },
      assetArtifactId: 'artifact-logo', assetSha256: 'a'.repeat(64), zIndex: 1, timeRange: { startFrame: 1, endFrame: 4 } }], issues: [] }
  return { clips: [{ id: 'clip-golden', sourceArtifactId: 'artifact-video', sourceInFrame: 0, sourceOutFrame: 8,
    timelineInFrame: 0, timelineOutFrame: rate === .25 ? 32 : rate === 4 ? 2 : 8, rate }], transitions: [],
    fps: 30, outputFps: 30, width: 320, height: 180, stagingWidth: 320, stagingHeight: 180,
    renderSources: [{ artifactId: 'artifact-video', path: '/staged/source.mp4', mediaType: 'video' },
      ...(musicAndPlacement ? [{ artifactId: 'artifact-music', path: '/staged/music.wav', mediaType: 'audio' }] : [])],
    sourceIndex: { 'artifact-video': 0, ...(musicAndPlacement ? { 'artifact-music': 1 } : {}) },
    clipVideoIndex: { 'clip-golden': 0 }, videoProbeByArtifactId: { 'artifact-video': { width: 320, height: 180 } },
    reframeRangeByClipId: {}, compositionLayout: null,
    backgroundMusic: musicAndPlacement ? { id: 'music-golden', kind: 'background-music', artifactId: 'artifact-music',
      analysisId: 'analysis-music', analysisHash: 'a'.repeat(64), rightsSnapshotId: 'rights-music', sourceInFrame: 0,
      sourceOutFrame: 90, timelineInFrame: 0, timelineOutFrame: 8, gainDb: -24, fadeInFrames: 0, fadeOutFrames: 0 } : null,
    placementPlan: musicAndPlacement ? { ...placementBody, placementPlanHash: calculateCanonicalHash(placementBody) } : null,
    placementInputs: musicAndPlacement ? [{ elementId: 'logo-golden', path: '/assets/logo.png', sha256: 'a'.repeat(64) }] : [],
    assetInputIndexByElementId: musicAndPlacement ? { 'logo-golden': 3 } : {},
  }
}
export const HISTORICAL_GRAPH_GOLDENS = [
  { name: 'real-time', context: goldenContext(), expected: { filters: [
    '[1:v:0]trim=start_frame=0:end_frame=8,setpts=PTS-STARTPTS,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1,format=yuv420p[v0]',
    '[0:a:0]atrim=start=0.000000:end=0.266667,asetpts=PTS-STARTPTS[a0]',
    '[v0][a0]concat=n=1:v=1:a=1[joinedv][joineda]',
    '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]', ...BACKGROUND_LITERAL,
  ], videoInputs: VIDEO_INPUT_LITERAL, inputArgs: ['-i', '/staged/source.mp4', '-ss', '0.000000', '-t', '0.300000', '-i', '/staged/source.mp4'], videoLabel: 'composed', audioLabel: 'outa' } },
  { name: 'quarter-speed', context: goldenContext(.25), expected: { filters: [
    '[1:v:0]trim=start_frame=0:end_frame=8,setpts=(PTS-STARTPTS)/0.250000,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,trim=start_frame=0:end_frame=32,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v0]',
    '[0:a:0]atrim=start=0.000000:end=0.266667,asetpts=PTS-STARTPTS,atempo=0.500000,atempo=0.500000,atrim=start=0:end=1.066667,asetpts=PTS-STARTPTS[a0]',
    '[v0][a0]concat=n=1:v=1:a=1[joinedv][joineda]',
    '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]', ...BACKGROUND_LITERAL,
  ], videoInputs: VIDEO_INPUT_LITERAL, inputArgs: ['-i', '/staged/source.mp4', '-ss', '0.000000', '-t', '0.300000', '-i', '/staged/source.mp4'], videoLabel: 'composed', audioLabel: 'outa' } },
  { name: 'quadruple-speed', context: goldenContext(4), expected: { filters: [
    '[1:v:0]trim=start_frame=0:end_frame=8,setpts=(PTS-STARTPTS)/4.000000,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,trim=start_frame=0:end_frame=2,setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v0]',
    '[0:a:0]atrim=start=0.000000:end=0.266667,asetpts=PTS-STARTPTS,atempo=2.000000,atempo=2.000000,atrim=start=0:end=0.066667,asetpts=PTS-STARTPTS[a0]',
    '[v0][a0]concat=n=1:v=1:a=1[joinedv][joineda]',
    '[joineda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]', ...BACKGROUND_LITERAL,
  ], videoInputs: VIDEO_INPUT_LITERAL, inputArgs: ['-i', '/staged/source.mp4', '-ss', '0.000000', '-t', '0.300000', '-i', '/staged/source.mp4'], videoLabel: 'composed', audioLabel: 'outa' } },
  { name: 'music-and-placement', context: goldenContext(1, true), expected: { filters: [
    '[2:v:0]trim=start_frame=0:end_frame=8,setpts=PTS-STARTPTS,scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1,format=yuv420p[v0]',
    '[0:a:0]atrim=start=0.000000:end=0.266667,asetpts=PTS-STARTPTS[a0]',
    '[v0][a0]concat=n=1:v=1:a=1[joinedv][joineda]',
    '[1:a:0]atrim=start=0.000000:end=3.000000,asetpts=PTS-STARTPTS,atrim=start=0:end=0.266667,volume=-24.00dB[musicbed]',
    '[joineda][musicbed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixeda]',
    '[mixeda]alimiter=limit=0.794328:attack=5:release=50:level=false:latency=true[outa]', ...BACKGROUND_LITERAL,
    '[3:v]scale=64:36,format=rgba,setsar=1[plc0]',
    "[composed][plc0]overlay=32:18:enable='between(n,1,3)':eof_action=repeat[placed]",
  ], videoInputs: VIDEO_INPUT_LITERAL, inputArgs: ['-i', '/staged/source.mp4', '-i', '/staged/music.wav', '-ss', '0.000000', '-t', '0.300000', '-i', '/staged/source.mp4', '-i', '/assets/logo.png'], videoLabel: 'placed', audioLabel: 'outa' } },
]

test('W69 prefix extraction preserves declared pre-extraction historical graph/input argv bytes', () => {
  assert.equal(HISTORICAL_RENDERER_SHA256, '939e24d69989741dc8ab99c170b65796750a844ec702995e0342311eca78bc3d')
  for (const fixture of HISTORICAL_GRAPH_GOLDENS) assert.deepEqual(buildEditorialCompositionPrefix(fixture.context), fixture.expected, fixture.name)
})




const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const invalid = (error) => error.code === 'INVALID_RENDER_INPUT'
const traceBytes = (pts, tb = '1/1000000') => Buffer.from('[showinfo@apollo_preass @ 0x123] config in time_base: ' + tb + ', frame_rate: 60/1\n' +
  pts.map((value, n) => '[showinfo@apollo_preass @ 0x123] n: ' + n + ' pts: ' + value + ' pts_time: 0 fmt:yuv420p\n').join(''))

test('named pre-libass parser retains integer PTS instead of computing n/fps', () => {
  const result = parseEditorialPreAssTrace(traceBytes(['83333', '100000', '116667']), 3, 8192)
  assert.deepEqual(result.map((frame) => frame.pts), ['83333', '100000', '116667'])
  assert.deepEqual(result[1].timeBase, { numerator: '1', denominator: '1000000' })
  for (const pts of [['3666667', '3700000', '3733333'], ['8020000', '8030000', '8040000']])
    assert.deepEqual(parseEditorialPreAssTrace(traceBytes(pts), 3, 8192).map((frame) => frame.pts), pts)
})
test('full trace rejects missing/extra/nonmonotonic/ambiguous/invalid records', () => {
  const original = traceBytes(['0', '16667'])
  const cases = [
    ['truncated frame sequence', original.subarray(0, original.indexOf('n: 1'))],
    ['extra frame', traceBytes(['0', '16667', '33333'])],
    ['duplicate PTS', traceBytes(['0', '0'])],
    ['negative order', traceBytes(['1', '0'])],
    ['AV_NOPTS', traceBytes(['0', '-9223372036854775808'])],
    ['int64 overflow', traceBytes(['0', '9223372036854775808'])],
    ['second instance', Buffer.from(original.toString().replace('n: 1', 'n: 1').replace('0x123] n: 1', '0x124] n: 1'))],
    ['noncanonical index', Buffer.from(original.toString().replace('n: 1', 'n: 01'))],
    ['missing config', Buffer.from(original.toString().split('\n').slice(1).join('\n'))],
    ['bad AVRational', Buffer.from(original.toString().replace('1/1000000', '0/1000000'))],
    ['bad UTF8', Buffer.concat([original, Buffer.from([255])])],
  ]
  for (const [label, bytes] of cases) assert.throws(() => parseEditorialPreAssTrace(bytes, 2, 8192), invalid, label)
  assert.throws(() => parseEditorialPreAssTrace(original, 2, original.length - 1), invalid, 'bounded raw trace')
})
test('MP4 is a separate exact clock and unsafe JSON integers fail', () => {
  const bytes = (pts) => Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', time_base: '1/15360' }], frames: pts.map((value) => ({ pts: value })) }))
  assert.deepEqual(parseEditorialMp4Clock(bytes([0, 256]), 2, 8192).frames.map((frame) => frame.pts), ['0', '256'])
  for (const pts of [[0, 0], [0, Number.MAX_SAFE_INTEGER + 1], [0, '-9223372036854775808']])
    assert.throws(() => parseEditorialMp4Clock(bytes(pts), 2, 8192), invalid)
  assert.throws(() => parseEditorialMp4Clock(bytes([0]), 2, 8192), invalid)
})

async function controlledRequest(root, runId = 'trace-unit-one') {
  // Metadata-only in-memory executor fixture; no pixel/FFmpeg/PG evidence.
  const path = join(root, 'controlled-source'), bytes = Buffer.from('controlled-byte-pin')
  await writeFile(path, bytes); await mkdir(join(root, 'fonts'), { recursive: true })
  const pin = { path, sha256: digest(bytes), byteSize: bytes.length }
  const output = { id: 'variant-controlled', locale: 'pt-BR', aspectRatio: '16:9', width: 320, height: 180, fps: 30,
    safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, deliveryProfileId: 'profile-controlled' }
  const encoding = (kind) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
    width: 320, height: 180, fps: 30, quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
    audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
  const document = createOutputSpecRevisionBody({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    id: 'revision-controlled', variantId: output.id, workspaceId: 'workspace-controlled', projectId: 'project-controlled', revisionNumber: 1,
    output, profile: { schemaVersion: 'materialized-delivery-profile/v1', id: output.deliveryProfileId, version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final'), proxy: encoding('proxy'),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 1, scaleY: 1 }, subtitles: { mode: 'none', configuration: null, fontAssets: [] } },
    preset: null, createdAt: '2026-10-12T12:00:00.000Z' })
  const specRevision = sealOutputSpecRevision(document, { kind: 'edit-command', id: 'command-controlled', hash: 'a'.repeat(64) })
  const prepared = { ...goldenContext(), renderSources: [{ artifactId: 'artifact-video', path, mediaType: 'video' }],
    clipVideoIndex: { 'clip-golden': 0 }, sourceIndex: { 'artifact-video': 0 } }
  const plan = { id: 'plan-controlled', projectVersionId: 'version-controlled', fps: 30, durationFrames: 8,
    videoTracks: [{ id: 'track-controlled', kind: 'base-video', clips: prepared.clips }] }
  const manifest = createMediaArtifactManifest({ artifactKey: 'controlled/source.mp4', artifactSha256: pin.sha256,
    byteSize: pin.byteSize, mediaType: 'video', container: 'mp4', recipe: { id: 'controlled-source', version: '1', parameters: { metadataOnly: true } }, sources: [] })
  const renderInput = createRenderInputSpec({ schemaVersion: 'render-input/v1', renderer: { id: 'controlled-renderer', version: '1', digest: 'b'.repeat(64) },
    composition: { id: 'editorial-controlled', version: '1', propsSchemaRef: 'apollo://render-props/editorial/v1' },
    plan: { id: plan.id, versionId: plan.projectVersionId, hash: calculateCanonicalHash(plan) }, output: { ...output, durationInFrames: 8 },
    assets: [{ id: 'asset-video', artifactId: 'artifact-video', artifactKey: manifest.artifact.artifactKey, kind: 'video', role: 'source-master',
      ordinal: 0, sha256: pin.sha256, byteSize: pin.byteSize }], props: { editPlan: plan } })
  const original = { ...pin, artifactId: 'artifact-video', manifestId: 'manifest-controlled', manifest, probeHash: 'c'.repeat(64) }
  const workEnd = performance.now() + 30000
  return { runId, scope: { workspaceId: document.workspaceId, projectId: document.projectId, projectVersionId: plan.projectVersionId,
    variantId: output.id, outputStateHash: 'd'.repeat(64), outputSpecRevisionId: document.id, outputSpecHash: specRevision.specHash },
    role: 'proxy', renderInput, specRevision, prepared, sourceBindings: [
      { reference: { kind: 'video-clip', clipId: 'clip-golden', trackId: 'track-controlled' }, role: 'source-master', inputOrdinal: 1, original, consumed: { ...pin, kind: 'original' } },
      { reference: { kind: 'clip-audio', clipId: 'clip-golden', trackId: 'track-controlled' }, role: 'source-master', inputOrdinal: 0, original, consumed: { ...pin, kind: 'original' } },
    ], auxiliaryAssets: [], toolchain: { ffmpeg: { ...pin, expectedVersionLine: 'controlled ffmpeg' }, ffprobe: { ...pin, expectedVersionLine: 'controlled ffprobe' },
      buildManifest: pin, fontConfig: pin, fontsDirectory: join(root, 'fonts'), fonts: [], libraries: [],
      libass: { linkage: 'embedded', version: 'controlled', configurationHash: 'e'.repeat(64), implementationEvidenceHash: 'f'.repeat(64) } },
    fragment: { id: 'whole-controlled', globalStartFrame: 0, globalEndFrame: 8 }, parentComposition: null, diagnosticAss: null,
    limits: { maxFrames: 8, maxTraceBytes: 65536, maxProbeBytes: 65536, maxOutputBytes: 65536, maxProcessMs: 30000 },
    deadlineMonotonicMs: workEnd, hardEndMonotonicMs: workEnd + 5000 }
}

test('closed request binds sources, roles, ordinals, spec and fragments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-request-unit-'))
  try {
    const request = await controlledRequest(root)
    assert.equal(validateEditorialClockRequest(request).expectedFrames, 8)
    const cases = [
      ['different variant', (input) => { input.scope.variantId = 'variant-other' }],
      ['wrong track', (input) => { input.sourceBindings[0].reference.trackId = 'track-other' }],
      ['wrong ordinal', (input) => { input.sourceBindings[0].inputOrdinal = 0 }],
      ['wrong role', (input) => { input.sourceBindings[0].role = 'selected-insert' }],
      ['missing audio', (input) => { input.sourceBindings.pop() }],
      ['wrong source bytes', (input) => { input.sourceBindings[0].original.sha256 = 'e'.repeat(64) }],
      ['wrong derivative source', (input) => { input.sourceBindings[0].consumed = { ...input.sourceBindings[0].consumed, kind: 'staged-color-derivative', compilationId: 'compilation-real', compilationHash: 'a'.repeat(64), pipelineHash: 'b'.repeat(64), executionReceiptHash: 'c'.repeat(64), sourceSha256: 'd'.repeat(64) } }],
      ['fragment without full clock', (input) => { input.fragment.globalStartFrame = 1 }],
      ['missing hardEnd', (input) => { delete input.hardEndMonotonicMs }],
      ['archive budget expansion', (input) => { input.hardEndMonotonicMs = input.deadlineMonotonicMs + 5001 }],
      ['hardEnd before work', (input) => { input.hardEndMonotonicMs = input.deadlineMonotonicMs }],
      ['process bound expansion', (input) => { input.limits.maxProcessMs = 30001 }],
    ]
    for (const [label, alter] of cases) { const input = structuredClone(request); alter(input); assert.throws(() => validateEditorialClockRequest(input), invalid, label) }
  } finally { await rm(root, { recursive: true, force: true }) }
})

function controlledExecutor(failComposition = false) {
  const calls = []
  return { calls, async execute(input) {
    calls.push(input)
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exitCode = 0
    if (input.owner.operation.endsWith('-version')) stdout = Buffer.from('controlled ' + (input.owner.operation.startsWith('ffmpeg') ? 'ffmpeg' : 'ffprobe') + '\n')
    else if (input.owner.operation === 'composition') {
      await writeFile(input.args.at(-1), Buffer.from('controlled MP4 bytes'))
      stderr = traceBytes(Array.from({ length: 8 }, (_, index) => String(index * 1000)), '1/30000')
      if (failComposition) exitCode = 1
    } else if (input.owner.operation.startsWith('source-probe-')) stdout = Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width: 320, height: 180 }, { codec_type: 'audio' }] }))
    else if (input.owner.operation === 'mp4-encoding') stdout = Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 320, height: 180 }, { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 1 }] }))
    else if (input.owner.operation === 'mp4-clock') stdout = Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', time_base: '1/15360' }], frames: Array.from({ length: 8 }, (_, index) => ({ pts: index * 512 })) }))
    const result = { ...input.owner, ownerKey: { ...input.owner, executionId: 'controlled-' + calls.length }, pid: 1234, spawnObserved: true, closeObserved: true, exitCode, signal: null,
      stdoutBytes: stdout.length, stderrBytes: stderr.length, capturedStdoutBytes: stdout.length, capturedStderrBytes: stderr.length,
      stdout, stderr, aborted: false, timedOut: false, outputExceeded: false }
    input.observe?.(result)
    if (exitCode) throw new OwnedFfmpegProcessFailure('RENDER_OUTPUT_INVALID', 'Controlled process failure', result)
    return result
  } }
}
test('controlled executor exercises serial capture/replay and distinct MP4 clock without claiming physical evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-capture-unit-'))
  const executor = controlledExecutor(), collector = new FfmpegSubtitleClockCollector({ evidenceRoot: join(root, 'evidence'), executor })
  try {
    const request = await controlledRequest(root), before = await collector.capture(request)
    const after = await collector.capture({ ...request, runId: 'trace-unit-two' })
    collector.assertReplay(before, after)
    assert.equal(before.integration, 'blocked'); assert.equal(before.authorityStage, 'process-observation-only')
    assert.equal(before.frames[1].pts, '1000'); assert.equal(before.mp4Clock.frames[1].pts, '512')
    assert.equal(executor.calls.length, 12)
    assert(executor.calls.every((call) => call.deadlineMonotonicMs === request.deadlineMonotonicMs && call.timeoutMs <= 30000))
    assert.equal(JSON.parse(await readFile(join(root, 'evidence', before.runId, 'manifest.json'), 'utf8')).outcome, 'observed-pending-owner-confirmation')
    assert.throws(() => collector.assertReplay(before, before), invalid)
    await assert.rejects(() => collector.cleanup(before.runId, { workEndMonotonicMs: request.deadlineMonotonicMs + 1, hardEndMonotonicMs: request.hardEndMonotonicMs + 1 }),
      (error) => error.code === 'INVALID_RENDER_INPUT' && error.message === 'Clock cleanup cannot extend the captured owner deadlines')
    assert.equal(JSON.parse(await readFile(join(root, 'evidence', before.runId, 'manifest.json'), 'utf8')).candidateOutcome, 'passed', 'extension did not remove evidence')
    await collector.cleanup(before.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs }); await collector.cleanup(after.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('owned process failure archives raw trace and FAIL before explicit owner cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-failure-unit-'))
  const executor = controlledExecutor(true), collector = new FfmpegSubtitleClockCollector({ evidenceRoot: join(root, 'evidence'), executor })
  try {
    const request = await controlledRequest(root)
    await assert.rejects(() => collector.capture(request), (error) => error instanceof OwnedFfmpegProcessFailure && error.code === 'RENDER_OUTPUT_INVALID')
    const manifest = JSON.parse(await readFile(join(root, 'evidence', request.runId, 'manifest.json'), 'utf8'))
    assert.equal(manifest.outcome, 'failed'); assert.equal(manifest.terminal, true)
    assert(manifest.files.some((file) => file.filename === 'composition.stderr'))
    assert.equal(executor.calls.length, 4, 'no process admitted after primary failure')
    await collector.cleanup(request.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs })
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('inspector defaults remain literal and expired owner cannot spawn', async () => {
  assert.equal(INSPECTOR_PROCESS_TIMEOUT_MS, 120000)
  assert.equal(INSPECTOR_PROCESS_MAX_OUTPUT_BYTES, 1048576)
  await assert.rejects(() => new NodeOwnedFfmpegExecutor().execute({ executable: 'never-run', args: [], owner: { runId: 'expired', operation: 'unit' },
    deadlineMonotonicMs: performance.now() - 1, timeoutMs: 30000 }), (error) => error.noChildStarted === true && error.code === 'RENDER_EXECUTION_FAILED')
})

test('collector retains FAIL and denies capture/cleanup until controlled late close is observed in memory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-retained-unit-'))
  const delegate = controlledExecutor(); let lateClose, retainedFailure
  const executor = { execute: async (input) => {
    if (input.owner.operation !== 'composition') return delegate.execute(input)
    delegate.calls.push(input)
    const ownerKey = { ...input.owner, executionId: 'controlled-retained-composition' }
    retainedFailure = new OwnedFfmpegTerminalInconclusive(ownerKey, new Error('controlled timeout cause'), [])
    lateClose = async () => {
      const stderr = traceBytes(Array.from({ length: 8 }, (_, index) => String(index * 1000)), '1/30000')
      input.observeLateClose({ ...input.owner, ownerKey, pid: 1234, spawnObserved: true, closeObserved: true, exitCode: 1, signal: null,
        stdoutBytes: 0, stderrBytes: stderr.length, capturedStdoutBytes: 0, capturedStderrBytes: stderr.length,
        stdout: Buffer.alloc(0), stderr, aborted: false, timedOut: true, outputExceeded: false })
    }
    throw retainedFailure
  } }
  const collector = new FfmpegSubtitleClockCollector({ evidenceRoot: join(root, 'evidence'), executor })
  let closed = false
  try {
    const request = await controlledRequest(root)
    await assert.rejects(() => collector.capture(request), (error) => error === retainedFailure)
    const directory = join(root, 'evidence', request.runId)
    const original = JSON.parse(await readFile(join(directory, 'outcome.json'), 'utf8'))
    assert.equal(original.outcome, 'failed'); assert.equal(original.terminal, false)
    assert.equal(original.error.terminalInconclusive.closeObserved, false)
    assert.equal(delegate.calls.length, 4)
    await assert.rejects(() => collector.capture({ ...request, runId: 'denied-until-close' }), (error) => error.code === 'INVALID_RENDER_INPUT' && error.message === 'Another collector capture is still admitted')
    await assert.rejects(() => collector.cleanup(request.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs }), (error) => error.code === 'INVALID_RENDER_INPUT' && error.message === "Clock cleanup requires this owner's terminal capture")
    assert.equal(delegate.calls.length, 4, 'retained capture does not admit another fake process')
    await lateClose(); closed = true
    const late = collector.retainedLateCloseFacts(request.runId)
    assert.equal(late.length, 1); assert.equal(late[0].closeObserved, true)
    await assert.rejects(() => readFile(join(directory, 'late-terminal.json')), (error) => error.code === 'ENOENT', 'memory-only late close creates no late evidence file')
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'outcome.json'), 'utf8')), original, 'no rewriting of original failed marker')
    await collector.cleanup(request.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs })
  } finally {
    if (!closed && lateClose) await lateClose()
    await rm(root, { recursive: true, force: true })
  }
})

test('rejected IO budget before admission leaves the next valid capture available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-pre-admission-unit-'))
  const executor = controlledExecutor(), collector = new FfmpegSubtitleClockCollector({ evidenceRoot: join(root, 'evidence'), executor })
  try {
    const request = await controlledRequest(root), excessiveWorkEnd = performance.now() + 360000
    await assert.rejects(() => collector.capture({ ...request, deadlineMonotonicMs: excessiveWorkEnd,
      hardEndMonotonicMs: excessiveWorkEnd + 1000 }), (error) => error.code === 'INVALID_RENDER_INPUT' && error.noIoStarted === true)
    assert.equal(executor.calls.length, 0, 'rejected owner creates no controlled process')
    const valid = await collector.capture(request)
    assert.equal(valid.runId, request.runId); assert.equal(executor.calls.length, 6, 'valid capture remains admitted')
    await collector.cleanup(valid.runId, { workEndMonotonicMs: request.deadlineMonotonicMs, hardEndMonotonicMs: request.hardEndMonotonicMs })
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('fractional represented archive boundary uses addition, keeping full 5000ms and rejecting plus one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clock-fractional-deadline-unit-'))
  try {
    const request = await controlledRequest(root), work = 30000.0001, hard = work + 5000
    assert.equal(hard, 35000.000100000005)
    assert(hard - work > 5000, 'independent IEEE subtraction regression vector')
    const boundary = { ...request, deadlineMonotonicMs: work, hardEndMonotonicMs: hard }
    assert.equal(validateEditorialClockRequest(boundary).expectedFrames, 8)
    assert.throws(() => validateEditorialClockRequest({ ...boundary, hardEndMonotonicMs: work + 5001 }), invalid, 'represented ceiling plus one remains forbidden')
  } finally { await rm(root, { recursive: true, force: true }) }
})

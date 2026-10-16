import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRenderInputSpec } from '../../src/v2/domain/render-input.ts'
import { createMediaArtifactManifest } from '../../src/v2/domain/media-artifact.ts'
import { createOutputSpecRevisionBody, sealOutputSpecRevision } from '../../src/v2/domain/output-spec-revision.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { calculateOutputCanonicalHash, OUTPUT_CANONICAL_POLICY_VERSION, serializeOutputCanonicalJson } from '../../src/v2/domain/output-canonical-policy.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { FfmpegSubtitleClockCollector, validateEditorialClockRequest } from '../../src/v2/infrastructure/media/ffmpeg-subtitle-clock-collector.ts'
import { OwnedDeadlineIo, OwnedIoInconclusive, pendingOwnedIo, assertOwnedIoAdmission } from '../../src/v2/infrastructure/media/ffmpeg-owned-io.ts'
import { NodeOwnedFfmpegExecutor, OwnedFfmpegProcessFailure, OwnedFfmpegTerminalInconclusive, OwnedFfmpegAdmissionFailure, assertOwnedFfmpegAdmission, pendingOwnedFfmpegTerminations } from '../../src/v2/infrastructure/media/ffmpeg-owned-process.ts'

// Mandatory explicit owner pins, never derived as expected from the binary being
// tested. No download/package fallback or skip. This suite collects a controlled
// product-prefix trace; it does NOT validate libass effective milliseconds or
// publish a MaterializedSubtitleClock. Existing boundary FAILs stay authoritative.
const HASH = /^[a-f0-9]{64}$/
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const CASES = Object.freeze([
  { name: 'concat-audio-60-frame-6', fps: 60, spans: [4, 5], rate: 1, frames: 9, target: 6, musicPlacement: false },
  { name: 'concat-audio-30-frame-111', fps: 30, spans: [60, 54], rate: 1, frames: 114, target: 111, musicPlacement: false },
  { name: 'concat-audio-100-frame-803', fps: 100, spans: [400, 406], rate: 1, frames: 806, target: 803, musicPlacement: false },
  { name: 'concat-audio-quarter-rate', fps: 30, spans: [4, 4], rate: .25, frames: 32, target: 16, musicPlacement: false },
  { name: 'concat-audio-fourfold-rate', fps: 30, spans: [16, 16], rate: 4, frames: 8, target: 4, musicPlacement: false },
  { name: 'concat-audio-music-placement', fps: 30, spans: [4, 4], rate: 1, frames: 8, target: 6, musicPlacement: true },
])
const LIMITS = Object.freeze({ maxTraceBytes: 4 * 1024 * 1024, maxProbeBytes: 4 * 1024 * 1024,
  maxOutputBytes: 32 * 1024 * 1024, maxProcessMs: 30000 })
const sanitized = (error) => ({ name: error?.name ?? 'Unknown', code: error?.code ?? null,
  messageSha256: digest(String(error?.message ?? error)), messageBytes: Buffer.byteLength(String(error?.message ?? error)),
  ioInconclusive: error instanceof OwnedIoInconclusive ? { ownerKey: error.ownerKey, ioSettled: false, closeObserved: false } : null,
  terminalInconclusive: error instanceof OwnedFfmpegTerminalInconclusive ? { ownerKey: error.ownerKey, closeObserved: false } : null,
  primaryProcessError: error instanceof OwnedFfmpegProcessFailure || error instanceof OwnedFfmpegTerminalInconclusive
    ? error.primaryProcessError && { name: error.primaryProcessError.name, messageSha256: digest(error.primaryProcessError.message), messageBytes: Buffer.byteLength(error.primaryProcessError.message) } : null })

async function filePin(path, io) {
  const metadata = await io.stat(path)
  assert(metadata.isFile() && metadata.size > BigInt(0) && metadata.size <= BigInt(256 * 1024 * 1024))
  const result = await io.hashFile(path, 256 * 1024 * 1024)
  assert.equal(BigInt(result.byteSize), metadata.size, 'bounded full hash and real stream close')
  return { path, ...result }
}
function requestFor(vector, source, music, placement, toolchain, deadline, hardEnd, runId) {
  const variantId = 'controlled-variant-' + vector.name, versionId = 'controlled-version-' + vector.name
  const output = { id: variantId, locale: 'pt-BR', aspectRatio: '16:9', width: 320, height: 180, fps: vector.fps,
    safeArea: { top: .05, right: .05, bottom: .05, left: .05 }, deliveryProfileId: 'controlled-profile' }
  const encoding = (kind) => ({ codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', container: 'mp4', faststart: true,
    width: 320, height: 180, fps: vector.fps, quality: { mode: 'crf', value: kind === 'final' ? 18 : 23, preset: kind === 'final' ? 'medium' : 'veryfast' },
    audio: { codec: 'aac', bitrateKbps: kind === 'final' ? 192 : 160, sampleRateHz: 48000, channels: 1 } })
  // Sealed dependencies carry the new canonical policy in their own document,
  // independently of the enclosing revision; this remains controlled metadata.
  const config = { schemaVersion: 'controlled-font-config/v1', canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    family: toolchain.fonts[0].family }
  const spec = createOutputSpecRevisionBody({ canonicalPolicyVersion: OUTPUT_CANONICAL_POLICY_VERSION,
    id: 'controlled-spec-' + vector.name, variantId, workspaceId: 'controlled-workspace', projectId: 'controlled-project', revisionNumber: 1, output,
    profile: { schemaVersion: 'materialized-delivery-profile/v1', id: output.deliveryProfileId, version: 1,
      rendererContractVersion: 'ffmpeg-editorial-output/v1', final: encoding('final'), proxy: encoding('proxy'),
      proxyToFinal: { schemaVersion: 'output-canvas-transform/v1', scaleX: 1, scaleY: 1 },
      subtitles: { mode: 'burn-in', configuration: { schemaVersion: config.schemaVersion, document: config, hash: calculateOutputCanonicalHash(config) },
        fontAssets: toolchain.fonts.map((font) => ({ artifactId: font.artifactId, sha256: font.sha256 })) } }, preset: null,
    createdAt: '2026-10-12T12:00:00.000Z' })
  const specRevision = sealOutputSpecRevision(spec, { kind: 'edit-command', id: 'controlled-command-' + vector.name,
    hash: calculateCanonicalHash({ vector, output }) })
  let cursor = 0
  const clips = vector.spans.map((span, index) => {
    const clip = { id: 'controlled-clip-' + index, sourceArtifactId: 'controlled-video', sourceInFrame: 0, sourceOutFrame: span,
      timelineInFrame: cursor, timelineOutFrame: cursor + span / vector.rate, rate: vector.rate }; cursor = clip.timelineOutFrame; return clip
  })
  assert.equal(cursor, vector.frames, 'predeclared full frame count')
  const backgroundMusic = vector.musicPlacement ? { id: 'controlled-music-track', kind: 'background-music', artifactId: 'controlled-music',
    analysisId: 'controlled-music-analysis', analysisHash: calculateCanonicalHash({ metadataOnly: true }),
    rightsSnapshotId: 'controlled-rights-not-admission-evidence', sourceInFrame: 0, sourceOutFrame: 90,
    timelineInFrame: 0, timelineOutFrame: 8, gainDb: -24, fadeInFrames: 0, fadeOutFrames: 0 } : null
  const plan = { id: 'controlled-plan-' + vector.name, projectVersionId: versionId, fps: vector.fps, durationFrames: vector.frames,
    videoTracks: [{ id: 'controlled-track', kind: 'base-video', clips }], ...(backgroundMusic ? { audioTracks: [backgroundMusic] } : {}) }
  const records = [{ artifactId: 'controlled-video', ...source, role: 'source-master', mediaType: 'video', container: 'mp4' },
    ...(backgroundMusic ? [{ artifactId: 'controlled-music', ...music, role: 'music-track', mediaType: 'audio', container: 'wav' }] : []),
    ...(vector.musicPlacement ? [{ artifactId: 'controlled-placement', ...placement, role: 'logo', mediaType: 'image', container: 'ppm' }] : [])]
  const originals = new Map(records.map((record) => [record.artifactId, { path: record.path, sha256: record.sha256, byteSize: record.byteSize,
    artifactId: record.artifactId, manifestId: 'controlled-manifest-' + record.artifactId,
    manifest: createMediaArtifactManifest({ artifactKey: 'controlled/' + record.artifactId + '.' + record.container,
      artifactSha256: record.sha256, byteSize: record.byteSize, mediaType: record.mediaType, container: record.container,
      recipe: { id: 'controlled-clock-source', version: '1', parameters: { controlled: true, vector: vector.name } }, sources: [] }),
    probeHash: calculateCanonicalHash({ controlledSourceBytes: record.sha256 }) }]))
  const renderInput = createRenderInputSpec({ schemaVersion: 'render-input/v1',
    renderer: { id: 'ffmpeg-editorial-controlled-collector', version: '1', digest: toolchain.ffmpeg.sha256 },
    composition: { id: 'editorial-controlled', version: '1', propsSchemaRef: 'apollo://render-props/editorial/v1' },
    plan: { id: plan.id, versionId, hash: calculateCanonicalHash(plan) }, output: { ...output, durationInFrames: vector.frames }, props: { editPlan: plan },
    assets: [...records.map((record, ordinal) => ({ id: 'asset-' + record.artifactId, artifactId: record.artifactId,
      artifactKey: originals.get(record.artifactId).manifest.artifact.artifactKey, kind: record.mediaType, role: record.role, ordinal,
      sha256: record.sha256, byteSize: record.byteSize })), ...toolchain.fonts.map((font, index) => ({ id: 'asset-' + font.artifactId,
      artifactId: font.artifactId, artifactKey: 'controlled/fonts/' + font.artifactId, kind: 'font', role: 'subtitle-font',
      ordinal: records.length + index, sha256: font.sha256, byteSize: font.byteSize }))] })
  const renderSources = records.filter((record) => record.mediaType !== 'image').map((record) => ({ artifactId: record.artifactId, path: record.path, mediaType: record.mediaType }))
  const sourceBindings = clips.flatMap((clip, index) => [{ kind: 'video-clip', ordinal: renderSources.length + index }, { kind: 'clip-audio', ordinal: 0 }].map(({ kind, ordinal }) => ({
    reference: { kind, clipId: clip.id, trackId: 'controlled-track' }, inputOrdinal: ordinal, role: 'source-master', original: originals.get('controlled-video'), consumed: { ...source, kind: 'original' } })))
  if (backgroundMusic) sourceBindings.push({ reference: { kind: 'music-track', trackId: backgroundMusic.id }, inputOrdinal: 1,
    role: 'music-track', original: originals.get('controlled-music'), consumed: { ...music, kind: 'original' } })
  const preset = readOutputFormatPreset('16:9')
  const placementBody = { schemaVersion: 'render-placement-plan/v1', outputSpecId: preset.spec.id, outputPresetHash: preset.presetHash,
    format: '16:9', canvas: { width: 320, height: 180 }, durationFrames: vector.frames, subtitleRegion: null, subtitleAnchorPlan: null,
    placements: [{ elementId: 'controlled-logo', kind: 'logo', bounds: { x: .1, y: .1, width: .2, height: .2 },
      assetArtifactId: 'controlled-placement', assetSha256: placement.sha256, zIndex: 1, timeRange: { startFrame: 1, endFrame: 4 } }], issues: [] }
  const placementPlan = vector.musicPlacement ? { ...placementBody, placementPlanHash: calculateCanonicalHash(placementBody) } : null
  if (placementPlan) sourceBindings.push({ reference: { kind: 'placement', elementId: 'controlled-logo' }, inputOrdinal: renderSources.length + clips.length,
    role: 'logo', original: originals.get('controlled-placement'), consumed: { ...placement, kind: 'original' } })
  return { runId, scope: { workspaceId: spec.workspaceId, projectId: spec.projectId, projectVersionId: versionId, variantId,
    // Controlled declared scope only, explicitly NOT a persisted output State.
    outputStateHash: calculateOutputCanonicalHash({ controlledScope: vector.name, persisted: false }), outputSpecRevisionId: spec.id, outputSpecHash: specRevision.specHash },
    role: 'proxy', renderInput, specRevision, sourceBindings, auxiliaryAssets: [], toolchain,
    prepared: { clips, transitions: [], fps: vector.fps, outputFps: vector.fps, width: 320, height: 180, stagingWidth: 320, stagingHeight: 180,
      renderSources, sourceIndex: Object.fromEntries(renderSources.map((record, index) => [record.artifactId, index])), clipVideoIndex: Object.fromEntries(clips.map((clip) => [clip.id, 0])),
      videoProbeByArtifactId: { 'controlled-video': { width: 320, height: 180 } }, reframeRangeByClipId: {}, backgroundMusic,
      compositionLayout: { foregroundScale: .9, verticalPosition: .5 }, placementPlan,
      placementInputs: placementPlan ? [{ elementId: 'controlled-logo', path: placement.path, sha256: placement.sha256 }] : [],
      assetInputIndexByElementId: placementPlan ? { 'controlled-logo': renderSources.length + clips.length } : {} },
    fragment: { id: 'whole-' + vector.name, globalStartFrame: 0, globalEndFrame: vector.frames }, parentComposition: null, diagnosticAss: null,
    limits: { ...LIMITS, maxFrames: vector.frames }, deadlineMonotonicMs: deadline, hardEndMonotonicMs: hardEnd }
}

test('owned product-prefix collector records full observed clocks; emission and persisted authority remain blocked', { timeout: 180000 }, async () => {
  const ownerDeadline = performance.now() + 180000, deadline = ownerDeadline - 5000, owner = 'collector-physical-' + randomUUID()
  const io = new OwnedDeadlineIo({ runId: owner, workEndMonotonicMs: deadline, hardEndMonotonicMs: ownerDeadline, otherAdmission: assertOwnedFfmpegAdmission })
  let ioPhase = 'work'
  const configPath = process.env.APOLLO_CLOCK_TOOLCHAIN_JSON, configHash = process.env.APOLLO_CLOCK_TOOLCHAIN_SHA256
  const evidenceRoot = process.env.APOLLO_CLOCK_EVIDENCE_ROOT
  assert(configPath && isAbsolute(configPath) && HASH.test(configHash ?? ''), 'owner must supply an explicit externally pinned toolchain document')
  assert(evidenceRoot && isAbsolute(evidenceRoot), 'owner must supply private evidence root')
  const configSize = await io.stat(configPath); assert(configSize.isFile() && configSize.size > BigInt(0) && configSize.size <= BigInt(1024 * 1024))
  const configBytes = await io.readBounded(configPath, 1024 * 1024); assert.equal(BigInt(configBytes.length), configSize.size); assert.equal(digest(configBytes), configHash)
  const toolchain = JSON.parse(configBytes.toString('utf8')); assert.equal(toolchain.libass.linkage, 'embedded')
  assert(toolchain.fonts.length > 0 && toolchain.fonts.every((font) => typeof font.family === 'string' && !/[,\r\n]/.test(font.family)), 'explicit pinned font inventory with ASS-safe family fields')
  const root = join(evidenceRoot, owner); await io.mkdir(root, { recursive: false })
  const executor = new NodeOwnedFfmpegExecutor(), collector = new FfmpegSubtitleClockCollector({ evidenceRoot: join(root, 'captures'), executor })
  const files = [], results = [], preflights = [], ioFailures = [], executions = [], lateCloseFacts = []; let primary, sequence = 0, batchStopped = false, opaqueTerminal = false
  let archiveWrites = Promise.resolve()
  async function save(name, bytes) {
    await io.writeExclusive(join(root, name), bytes, ioPhase); files.push({ name, sha256: digest(bytes), byteSize: Buffer.byteLength(bytes) })
  }
  function retainIoFailure(failure, error) {
    ioFailures.push(sanitized(error))
    if (failure instanceof OwnedFfmpegProcessFailure || failure instanceof OwnedFfmpegTerminalInconclusive || failure instanceof OwnedIoInconclusive) failure.recordIoFailure(error)
  }
  async function execute(stage, executable, args, maxOutputBytes = LIMITS.maxTraceBytes) {
    assert(!batchStopped, 'collector batch retained after inconclusive terminality or evidence failure')
    assertOwnedFfmpegAdmission(); assertOwnedIoAdmission()
    assert(performance.now() < deadline, 'global owner deadline, including source generation')
    const prefix = String(sequence++).padStart(3, '0') + '-' + stage
    try { await save(prefix + '.argv.json', serializeOutputCanonicalJson({ executable, args })) }
    catch (error) { batchStopped = true; retainIoFailure(null, error); throw error }
    let observation, failure
    try { observation = await executor.execute({ executable, args, owner: { runId: owner, operation: stage }, deadlineMonotonicMs: deadline,
      timeoutMs: LIMITS.maxProcessMs, maxOutputBytes, observe: (value) => { observation = value },
      observeLateClose: (value) => {
        observation = value
        const { stdout: _stdout, stderr: _stderr, ...metadata } = value; executions.push(metadata)
        lateCloseFacts.push({ ownerKey: value.ownerKey, closeObserved: true, stdoutSha256: digest(value.stdout),
          stderrSha256: digest(value.stderr), stdoutBytes: value.stdoutBytes, stderrBytes: value.stderrBytes })
        // Memory-only: no new file/manifest is admitted by late close.
      } }) }
    catch (error) {
      failure = error
      if (error instanceof OwnedFfmpegProcessFailure) observation = error.observation
      else if (error instanceof OwnedFfmpegTerminalInconclusive) batchStopped = true
      else if (!(error instanceof OwnedFfmpegAdmissionFailure)) { batchStopped = true; opaqueTerminal = true }
    }
    if (observation) {
      const { stdout, stderr, ...metadata } = observation; executions.push(metadata)
      try {
        await save(prefix + '.stdout', stdout); await save(prefix + '.stderr', stderr)
        await save(prefix + '.execution.json', serializeOutputCanonicalJson(metadata))
      } catch (error) { batchStopped = true; retainIoFailure(failure, error); failure ??= error }
    }
    if (failure) throw failure
    assert(observation?.closeObserved && observation.exitCode === 0 && observation.signal === null)
    return observation
  }
  try {
    // Cheap schema/geometry/ordinal preflight only: these declared byte pins are
    // metadata, never file evidence or capture inputs. No binary has run yet.
    const preflightSource = { path: join(root, 'preflight-source.mp4'), sha256: 'a'.repeat(64), byteSize: 1 }
    const preflightMusic = { path: join(root, 'preflight-music.wav'), sha256: 'b'.repeat(64), byteSize: 1 }
    const preflightPlacement = { path: join(root, 'preflight-logo.ppm'), sha256: 'c'.repeat(64), byteSize: 1 }
    for (const vector of CASES) {
      const record = { case: vector.name, stage: 'controlled-metadata-only', outcome: 'attempted', error: null }; preflights.push(record)
      try {
        const request = requestFor(vector, preflightSource, preflightMusic, preflightPlacement, toolchain,
          deadline, ownerDeadline, owner + '-' + vector.name + '-preflight')
        const validated = validateEditorialClockRequest(request)
        assert.equal(validated.expectedFrames, vector.frames, 'all six full requests validate before any FFmpeg')
        record.outcome = 'validated'
      } catch (error) { record.outcome = 'failed'; record.error = sanitized(error); throw error }
    }
    // Reauthenticate explicit binary pins BEFORE any source-generation process.
    for (const binary of [toolchain.ffmpeg, toolchain.ffprobe]) assert.deepEqual(await filePin(binary.path, io), { path: binary.path, sha256: binary.sha256, byteSize: binary.byteSize })
    const musicPath = join(root, 'music.wav')
    await execute('generate-music', toolchain.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=4', '-c:a', 'pcm_s16le', musicPath])
    const music = await filePin(musicPath, io)
    const placementPath = join(root, 'logo.ppm'), ppm = Buffer.concat([Buffer.from('P6\n16 16\n255\n'), Buffer.alloc(16 * 16 * 3, 220)])
    await io.writeExclusive(placementPath, ppm); const placement = await filePin(placementPath, io)
    for (const vector of CASES) {
      const record = { case: vector.name, target: vector.target, rate: vector.rate, outcome: 'not-executed',
        persistedAuthority: 'absent', emissionProof: 'pending-original-boundary-oracle', captures: [], error: null }; results.push(record)
      if (batchStopped) { record.outcome = 'not-executed-terminal-inconclusive-or-evidence-retained'; continue }
      try {
        assertOwnedFfmpegAdmission()
        if (performance.now() >= deadline) { record.outcome = 'not-executed-budget-exhausted'; throw new Error('Collector batch owner budget exhausted') }
        const sourcePath = join(root, vector.name + '.mp4')
        const seconds = Math.max(2, Math.max(...vector.spans) / vector.fps + 1)
        await execute('generate-source', toolchain.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=' + vector.fps + ':duration=' + seconds,
          '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=' + seconds,
          '-vf', 'format=gbrp,zscale=matrixin=gbr:primariesin=709:transferin=linear:matrix=709:primaries=709:transfer=709:range=limited,format=yuv420p',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
          '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:fullrange=off',
          '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', 'aac', '-ar', '48000', '-shortest', sourcePath])
        const probe = await execute('inspect-source-color', toolchain.ffprobe.path, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_range,color_space,color_transfer,color_primaries', '-of', 'json', sourcePath], LIMITS.maxProbeBytes)
        const color = JSON.parse(probe.stdout.toString('utf8')).streams?.[0]
        assert(color && color.color_range === 'tv' && color.color_space === 'bt709' && color.color_transfer === 'bt709' && color.color_primaries === 'bt709', 'observed synthetic source VUI, no coerced color approval')
        const source = await filePin(sourcePath, io), request = requestFor(vector, source, music, placement, toolchain, deadline, ownerDeadline, owner + '-' + vector.name + '-prepare')
        const preparation = { runId: request.runId, traceHash: null, outcome: 'attempted' }; record.captures.push(preparation)
        const prepared = await collector.capture(request); preparation.traceHash = prepared.traceHash; preparation.outcome = 'captured'
        const emptyAss = '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,' + toolchain.fonts[0].family + ',24,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,5,5,5,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n'
        const replayAttempt = { runId: owner + '-' + vector.name + '-replay', traceHash: null, outcome: 'attempted' }; record.captures.push(replayAttempt)
        const replay = await collector.capture({ ...request, runId: replayAttempt.runId, diagnosticAss: { text: emptyAss, sha256: digest(emptyAss) } }); replayAttempt.traceHash = replay.traceHash; replayAttempt.outcome = 'captured'
        collector.assertReplay(prepared, replay)
        assert.equal(prepared.frames.length, vector.frames); assert.equal(prepared.frames[vector.target].frame, vector.target)
        assert.equal(prepared.mp4Clock.frames.length, vector.frames)
        assert.equal(prepared.integration, 'blocked')
        if (vector.name === 'concat-audio-60-frame-6') {
          // Actual second clip, source interval preserved; global origin comes
          // from full observed frame 4, never 4/fps or an invented predecessor.
          const originalClip = request.prepared.clips[1], clipped = { ...originalClip, timelineInFrame: 0, timelineOutFrame: 5 }
          const fragmentRequest = { ...request, runId: owner + '-fragment-prepare', parentComposition: prepared,
            fragment: { id: 'controlled-fragment-second-clip', globalStartFrame: 4, globalEndFrame: 9 },
            prepared: { ...request.prepared, clips: [clipped], clipVideoIndex: { [clipped.id]: 0 } },
            sourceBindings: request.sourceBindings.filter((binding) => binding.reference.clipId === clipped.id)
              .map((binding) => ({ ...binding, inputOrdinal: binding.reference.kind === 'video-clip' ? 1 : 0 })) }
          const attempts = [{ runId: fragmentRequest.runId, traceHash: null, outcome: 'attempted' },
            { runId: owner + '-fragment-replay', traceHash: null, outcome: 'not-executed' }]; record.captures.push(...attempts)
          const fragment = await collector.capture(fragmentRequest); attempts[0].traceHash = fragment.traceHash; attempts[0].outcome = 'captured'
          attempts[1].outcome = 'attempted'
          const fragmentReplay = await collector.capture({ ...fragmentRequest, runId: attempts[1].runId, diagnosticAss: { text: emptyAss, sha256: digest(emptyAss) } })
          attempts[1].traceHash = fragmentReplay.traceHash; attempts[1].outcome = 'captured'
          collector.assertReplay(fragment, fragmentReplay)
          assert.deepEqual(fragment.fragment.globalOrigin, prepared.frames[4]); assert.equal(fragment.frames.length, 5)
        }
        record.outcome = 'trace-observed-and-replayed'
        // Persist exact RGB bytes of a target window as inspection evidence,
        // with no lossy-MP4 comparison passed off as a libass boundary oracle.
        const path = join(root, 'captures', replay.runId, 'composition.mp4')
        const first = vector.target - 1, last = vector.target + 1, bytes = 3 * 320 * 180 * 3
        const rgb = await execute('inspect-rgb', toolchain.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', path,
          '-vf', 'select=between(n\\,' + first + '\\,' + last + ')', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], bytes + 65536)
        assert.equal(rgb.stdout.length, bytes, 'three exact decoded inspection frames')
      } catch (error) {
        if (error instanceof OwnedFfmpegTerminalInconclusive || error instanceof OwnedIoInconclusive || pendingOwnedFfmpegTerminations().length || pendingOwnedIo().length) batchStopped = true
        if (record.outcome !== 'not-executed-budget-exhausted') record.outcome = 'failed'; record.error = sanitized(error); primary ??= error
      }
    }
  } catch (error) { primary ??= error }
  finally {
    ioPhase = 'archive'
    // Evidence retained for external owner archive. No automatic deletion on
    // unknown child state; capture manifests themselves record terminality.
    try { await io.wait('archive-settlement', archiveWrites) } catch (error) { primary ??= error }
    for (const vector of CASES) if (!results.some((record) => record.case === vector.name)) results.push({
      case: vector.name, target: vector.target, rate: vector.rate, outcome: 'not-executed-before-setup-failure',
      persistedAuthority: 'absent', emissionProof: 'pending-original-boundary-oracle', captures: [], error: null })
    const pendingTerminations = pendingOwnedFfmpegTerminations()
    try {
      const proof = serializeOutputCanonicalJson({ schemaVersion: 'controlled-editorial-clock-proof/v1', owner,
        outcome: primary ? 'failed' : 'observed-pending-owner-confirmation', candidateOutcome: primary ? 'failed' : 'passed', authorityStage: 'process-observation-only', persistedAuthority: 'absent',
        emissionProof: 'pending', replayAss: 'zero-cue-control', ownerDeadlineMonotonicMs: ownerDeadline, executionDeadlineMonotonicMs: deadline, finallyReserveMs: 5000, limits: LIMITS,
        harnessProcessesTerminal: !opaqueTerminal && pendingTerminations.length === 0 && executions.every((execution) => execution.closeObserved),
        collectorTerminality: 'capture-outcome-plus-owner-memory-late-close-facts',
        batchStopped, pendingTerminations, lateCloseFacts, pendingIo: pendingOwnedIo(), ioLedger: io.facts(),
        preflights, captureIoLedger: results.flatMap((item) => item.captures.map((capture) => ({ runId: capture.runId, facts: collector.retainedIoFacts(capture.runId), lateCloseFacts: collector.retainedLateCloseFacts(capture.runId) }))), executions, ioFailures, cases: results, error: primary ? sanitized(primary) : null })
      const proofFile = { name: 'proof.json', sha256: digest(proof), byteSize: Buffer.byteLength(proof) }
      await io.writeExclusive(join(root, 'manifest.json'), serializeOutputCanonicalJson({ schemaVersion: 'controlled-editorial-clock-files/v1', owner,
        configPath, configSha256: configHash, files: [...files, proofFile], completionMarker: proofFile,
        captureDirectories: results.flatMap((item) => item.captures.map((capture) => capture.runId)) }), 'archive')
      // Completion marker last: a failed manifest cannot leave a passed proof.
      await save('proof.json', proof)
      const confirmation = JSON.stringify({ evidenceRoot: root, outcome: primary ? 'failed' : 'passed', stage: 'process-observation-only' })
      assert(primary || performance.now() < ownerDeadline, 'absolute hardEnd before successful owner stdout confirmation')
      console.log(confirmation)
    } catch (error) {
      retainIoFailure(primary, error); primary ??= error
      // No late evidence write. External owner can retain these sanitized facts.
      console.log(JSON.stringify({ owner, outcome: 'failed', evidenceRetained: true, pendingIo: pendingOwnedIo(), ioLedger: io.facts(), error: sanitized(primary) }))
    }
  }
  if (primary) throw primary
})

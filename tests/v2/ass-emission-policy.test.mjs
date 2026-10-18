import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASS_EMISSION_POLICY, assFrameClockBinder, assertAssFrameInterval, assertAssCueText } from '../../src/v2/domain/ass-emission-policy.ts'
import { isAssBoundaryUnrepresentable } from '../../src/v2/domain/libass-clock-model.ts'
import { FfmpegEditorialProxyRenderer, assertEditorialAssEmission, buildAssSubtitles } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { buildPreLibassClockStage } from '../../src/v2/infrastructure/media/ffmpeg-editorial-composition-graph.ts'
import { EDITORIAL_FINAL_RECIPE_VERSION, EDITORIAL_PROXY_RECIPE_VERSION, FFMPEG_EDITORIAL_RENDERER_VERSION } from '../../src/v2/application/ports/editorial-proxy-renderer.ts'
import { projectFinalRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'

test('ASS boundaries are centiseconds inside the libass window of the closed stage clock, half-open', () => {
  for (const [fps, startCs, endCs] of [[30, 3n, 6n], [60, 1n, 3n], [100, 1n, 2n]]) {
    assertAssFrameInterval(1, 2, fps, 6)
    assert.deepEqual(assFrameClockBinder(fps, 6).interval(1, 2), { startCs, endCs })
  }
  assert.deepEqual(assFrameClockBinder(30, 6).timestamps(1, 2), { start: '0:00:00.03', end: '0:00:00.06' })
  // The frames the v5 proof showed arriving one millisecond low are bound below the ideal centisecond.
  const at60 = assFrameClockBinder(60, 12), at30 = assFrameClockBinder(30, 150)
  assert.deepEqual([at60.nowMs(5), at60.nowMs(6), at60.nowMs(7)], [83n, 100n, 116n])
  assert.deepEqual(at60.interval(6, 7), { startCs: 10n, endCs: 11n })
  assert.deepEqual([at30.nowMs(110), at30.nowMs(111), at30.nowMs(112)], [3666n, 3699n, 3733n])
  assert.deepEqual(at30.timestamps(111, 112), { start: '0:00:03.69', end: '0:00:03.73' })
  assert.deepEqual(assFrameClockBinder({ numerator: 30000, denominator: 1001 }, 12).interval(1, 2), { startCs: 3n, endCs: 6n })
  // One hour of 30 fps is bound without a ceiling on the frame index.
  assert.deepEqual(assFrameClockBinder(30, 30 * 3600).timestamps(30 * 3600 - 1, 30 * 3600),
    { start: '0:59:59.96', end: '0:59:59.97' })
})

test('100 fps frame 803 is genuinely unrepresentable: typed refusal, proven by brute force over every centisecond pair', () => {
  const binder = assFrameClockBinder(100, 810)
  const now = Array.from({ length: 810 }, (_unused, frame) => Number(binder.nowMs(frame)))
  assert.deepEqual(now.slice(801, 806), [8010, 8020, 8029, 8040, 8050])
  // Frame 803 reaches libass at 8029 ms: the only centisecond after frame 802 (8020) and not past 8029 does not exist.
  assert.throws(() => binder.interval(803, 804), (error) => isAssBoundaryUnrepresentable(error) &&
    error.details.frame === 803 && error.details.previousMs === '8020' && error.details.currentMs === '8029')
  const lit = (start, end) => now.flatMap((value, frame) => (start * 10 <= value && value < end * 10 ? [frame] : []))
  for (let start = 790; start <= 820; start += 1) for (let end = start + 1; end <= 821; end += 1) {
    assert.notDeepEqual(lit(start, end), [803], `[${start},${end}) cs lights exactly frame 803`)
  }
  // Starting at 8030 lights nothing at frame 803 (8029) and ends before frame 804 (8040); starting at 8020 also lights 802.
  assert.deepEqual(lit(803, 804), []); assert.deepEqual(lit(802, 803), [802, 803])
  // Every cue with a boundary at frame 803 shares the same empty window, as a start and as an end.
  for (const [start, end] of [[803, 805], [800, 803], [803, 804], [802, 803]].filter(([a, b]) => a === 803 || b === 803)) {
    assert.throws(() => binder.interval(start, end), isAssBoundaryUnrepresentable, `[${start},${end})`)
  }
  // Cues whose boundaries fall on other frames remain bindable, including one that covers frame 803.
  const covering = binder.interval(802, 804)
  assert.deepEqual(lit(Number(covering.startCs), Number(covering.endCs)), [802, 803])
  const before = binder.interval(801, 802)
  assert.deepEqual(lit(Number(before.startCs), Number(before.endCs)), [801])
})

test('rates above 120 fps are not banned by the emission policy; each interval is bound or refused', () => {
  for (const fps of [121, 144, 240, 1000]) assert.doesNotThrow(() => assFrameClockBinder(fps, 60))
  assert.throws(() => assertAssFrameInterval(1, 2, 240, 60), isAssBoundaryUnrepresentable)
  assert.doesNotThrow(() => assertAssFrameInterval(0, 60, 240, 60))
  assert.throws(() => assertAssFrameInterval(1, 2, 120, 60), (error) => isAssBoundaryUnrepresentable(error) && error.details.frame === 1)
  assert.doesNotThrow(() => assertAssFrameInterval(2, 3, 120, 60))
  const global = { fps: 120, durationFrames: 60, ctaOverlays: [{ id: 'cta', startFrame: 2, endFrame: 3, text: 'CTA' }] }
  assert.doesNotThrow(() => assertEditorialAssEmission(global))
  assert.throws(() => assertEditorialAssEmission({ ...global,
    ctaOverlays: [{ ...global.ctaOverlays[0], startFrame: 1, endFrame: 2 }],
  }), /not representable/)
  for (const fps of [0, 29.97, Number.NaN, -30]) assert.throws(() => assertAssFrameInterval(0, 2, fps, 6), (error) => error.code === 'INVALID_RENDER_INPUT')
  assert.throws(() => assertAssFrameInterval(0, Number.MAX_SAFE_INTEGER + 1, 30, 6))
  assert.throws(() => assertAssFrameInterval(2, 2, 30, 6))
  assert.throws(() => assertAssFrameInterval(0, 7, 30, 6), /ends after the fragment/)
  assert.throws(() => assertAssFrameInterval(0, 1, 30, 0), /positive fragment frame count/)
})

test('ASS text gate rejects C0 and DEL before suppression or whitespace rewriting, LF is explicit', () => {
  for (let code = 0; code <= 0x7f; code += 1) {
    if (code >= 0x20 && code !== 0x7f || code === 0x0a) continue
    const text = `A${String.fromCharCode(code)}B`
    assert.throws(() => assertAssCueText(text), /control characters/)
    assert.throws(() => assertEditorialAssEmission({ fps: 30, durationFrames: 6,
      subtitleCues: [{ id: 'cue', startFrame: 0, endFrame: 1, text }],
      placementPlan: { subtitleAnchorPlan: { decisions: [{ cueId: 'cue', suppressed: true }] } },
    }), /control characters/)
  }
  assert.doesNotThrow(() => assertAssCueText('A\nB'))
  const ass = buildAssSubtitles({ width: 320, height: 240, fps: 30, durationFrames: 6, cues: [],
    ctaOverlays: [{ id: 'cta', startFrame: 1, endFrame: 2, text: 'A\nB' }],
  })
  assert.ok(ass.includes('Dialogue: 1,0:00:00.03,0:00:00.06,CTA'))
  assert.ok(ass.includes('}A B'))
  assert.throws(() => assertEditorialAssEmission({ fps: 30, durationFrames: 6, ctaOverlays: [{ startFrame: 0, endFrame: 1, text: '{}\\' }] }), /empty/)
})

test('buildAssSubtitles binds each fragment to its own clock and refuses an unrepresentable cue with a typed error', () => {
  const cta = (startFrame, endFrame) => ({ id: 'cta', startFrame, endFrame, text: 'CTA' })
  // 30 fps frame 111 reaches libass at 3699 ms: the event starts at 3.69 and ends one frame later at 3.73.
  assert.ok(buildAssSubtitles({ width: 320, height: 240, fps: 30, durationFrames: 150, cues: [], ctaOverlays: [cta(111, 112)] })
    .includes('Dialogue: 1,0:00:03.69,0:00:03.73,CTA'))
  // No events: the clock is not needed and a fragment length is not enforced.
  assert.doesNotThrow(() => buildAssSubtitles({ width: 320, height: 240, fps: 100, durationFrames: 810, cues: [], ctaOverlays: [] }))
  assert.throws(() => buildAssSubtitles({ width: 320, height: 240, fps: 100, durationFrames: 810, cues: [], ctaOverlays: [cta(803, 804)] }),
    isAssBoundaryUnrepresentable)
  // The same cue after a rebase is a different local interval with its own clock.
  assert.throws(() => buildAssSubtitles({ width: 320, height: 240, fps: 120, durationFrames: 56, cues: [], ctaOverlays: [cta(1, 2)] }),
    isAssBoundaryUnrepresentable)
  assert.ok(buildAssSubtitles({ width: 320, height: 240, fps: 120, durationFrames: 60, cues: [], ctaOverlays: [cta(5, 6)] })
    .includes('Dialogue: 1,0:00:00.04,0:00:00.05,CTA'))
})

test('the pre-libass clock stage is the fps filter on the composed stream', () => {
  assert.deepEqual(buildPreLibassClockStage({ inputLabel: 'placed', outputFps: 60 }), { filters: ['[placed]settb=1/60,setpts=N[clocked]'], outputLabel: 'clocked' })
  for (const outputFps of [0, -1, 29.97, Number.NaN]) assert.throws(() => buildPreLibassClockStage({ inputLabel: 'composed', outputFps }))
  assert.throws(() => buildPreLibassClockStage({ inputLabel: 'a;b', outputFps: 30 }))
})

test('pre-render identity pins emission policy and cannot replay old arithmetic', () => {
  assert.equal(ASS_EMISSION_POLICY.version, 'ass-frame-clock/v3')
  assert.equal(ASS_EMISSION_POLICY.clock, 'settb-setpts-consecutive-pts/v1')
  assert.equal(ASS_EMISSION_POLICY.unrepresentable, 'typed-refusal-before-render')
  const inputs = { projectId: 'p', projectVersionId: 'v', outputSpec: { fps: 30 } }
  const oldHash = calculateVersionHash({ kind: 'project-final-export/v1', ...inputs })
  const expected = calculateVersionHash({ kind: 'project-final-export/v1', ...inputs, assEmissionPolicy: ASS_EMISSION_POLICY })
  const reprobated = calculateVersionHash({ kind: 'project-final-export/v1', ...inputs,
    assEmissionPolicy: { ...ASS_EMISSION_POLICY, version: 'ass-frame-clock/v1' } })
  assert.equal(projectFinalRenderInputHash(inputs), expected)
  assert.notEqual(expected, oldHash)
  assert.notEqual(expected, reprobated)
  assert.equal(projectFinalRenderInputHash({ ...inputs, assEmissionPolicy: { version: 'old' } }), expected)
})

test('renderer rejects a valid global CTA rebased into an unrepresentable 120 fps local clock before source I/O', async () => {
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(tmpdir(), 'apollo-clock-preflight-never-created') })
  await assert.rejects(renderer.render({
    operationId: 'clock-rebase-preflight', renderKind: 'proxy', fps: 120, format: '9:16', lutPaths: {},
    sources: [{ artifactId: 'source-clock', mediaType: 'video', path: join(tmpdir(), 'apollo-clock-source-does-not-exist.mp4'), colorPipelineCompilation: {} }],
    clips: [{ id: 'clip-clock', sourceArtifactId: 'source-clock', sourceInFrame: 0, sourceOutFrame: 6,
      timelineInFrame: 0, timelineOutFrame: 6, rate: 1 }],
    ctaOverlays: [{ id: 'cta-clock', startFrame: 2, endFrame: 3, text: 'CTA' }],
    rangeReuse: { schemaVersion: 'project-proxy-range-reuse/v1', path: join(tmpdir(), 'apollo-clock-base-does-not-exist.mp4'),
      sha256: 'a'.repeat(64), byteSize: 111, ranges: [{ startFrame: 1, endFrame: 4 }] },
  }), (error) => isAssBoundaryUnrepresentable(error) && /not representable/.test(error.message) && error.details.frame === 1)
})

test('the pre-libass stage closes the clock without the fps filter, which dropped the final frame on FFmpeg 6.1.1', () => {
  // Evidence: BASE/w69-clock-stage-candidates-v1-b40105d5 and docs/quality/w69-materialized-subtitle-clock-v2.md. On
  // ffmpeg-static 6.1.1 `fps=<rate>` after concat/overlay(shortest) lost the last frame at 24..120 fps (T-FR-227: 899/900).
  for (const outputFps of [24, 25, 30, 50, 60, 90, 100, 120]) {
    const { filters, outputLabel } = buildPreLibassClockStage({ inputLabel: 'composed', outputFps })
    assert.deepEqual(filters, [`[composed]settb=1/${outputFps},setpts=N[clocked]`])
    assert.equal(outputLabel, 'clocked')
    assert.equal(filters.some((filter) => /(^|[,\]])fps=/.test(filter)), false)
  }
})

test('renderer and recipe versions moved past the fps-stage contract so renders of the old stage are never reused', () => {
  assert.equal(FFMPEG_EDITORIAL_RENDERER_VERSION, '1.15.0')
  assert.equal(EDITORIAL_PROXY_RECIPE_VERSION, '1.16.0')
  assert.equal(EDITORIAL_FINAL_RECIPE_VERSION, '1.11.0')
})

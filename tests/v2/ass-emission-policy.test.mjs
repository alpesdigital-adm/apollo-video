import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASS_EMISSION_POLICY, assFrameCentiseconds, assFrameTimestamp, assertAssFrameInterval, assertAssCueText } from '../../src/v2/domain/ass-emission-policy.ts'
import { FfmpegEditorialProxyRenderer, assertEditorialAssEmission, buildAssSubtitles } from '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
import { projectFinalRenderInputHash } from '../../src/v2/application/project-render-sources.ts'
import { calculateVersionHash } from '../../src/v2/application/version-hash.ts'

test('ASS floor clock preserves half-open frame boundaries at 30/60/100 fps', () => {
  for (const [fps, startCs, endCs] of [[30, 3n, 6n], [60, 1n, 3n], [100, 1n, 2n]]) {
    assertAssFrameInterval(1, 2, fps)
    assert.equal(assFrameCentiseconds(1, fps), startCs)
    assert.equal(assFrameCentiseconds(2, fps), endCs)
  }
  assert.equal(assFrameTimestamp(1, 30), '0:00:00.03')
  assert.equal(assFrameTimestamp(2, 30), '0:00:00.06')
  assert.equal(assFrameTimestamp(30 * 3600, 30), '1:00:00.00')
  assert.equal(assFrameCentiseconds(1, { numerator: 30000, denominator: 1001 }), 3n)
  const large = Number.MAX_SAFE_INTEGER - 1
  assert.equal(assFrameCentiseconds(large, 1), BigInt(large) * 100n)
})

test('120 fps remains supported but an unrepresentable boundary fails closed including rebase', () => {
  assert.throws(() => assertAssFrameInterval(1, 2, 120), /cannot represent/)
  assert.doesNotThrow(() => assertAssFrameInterval(2, 3, 120))
  const global = { fps: 120, ctaOverlays: [{ id: 'cta', startFrame: 2, endFrame: 3, text: 'CTA' }] }
  assert.doesNotThrow(() => assertEditorialAssEmission(global))
  assert.throws(() => assertEditorialAssEmission({ ...global,
    ctaOverlays: [{ ...global.ctaOverlays[0], startFrame: 1, endFrame: 2 }],
  }), /cannot represent/)
  for (const fps of [0, 121, 29.97, Number.NaN]) assert.throws(() => assertAssFrameInterval(0, 2, fps))
  assert.throws(() => assertAssFrameInterval(0, Number.MAX_SAFE_INTEGER + 1, 30))
  assert.throws(() => assertAssFrameInterval(2, 2, 30))
})

test('ASS text gate rejects C0 and DEL before suppression or whitespace rewriting, LF is explicit', () => {
  for (let code = 0; code <= 0x7f; code += 1) {
    if (code >= 0x20 && code !== 0x7f || code === 0x0a) continue
    const text = `A${String.fromCharCode(code)}B`
    assert.throws(() => assertAssCueText(text), /control characters/)
    assert.throws(() => assertEditorialAssEmission({ fps: 30,
      subtitleCues: [{ id: 'cue', startFrame: 0, endFrame: 1, text }],
      placementPlan: { subtitleAnchorPlan: { decisions: [{ cueId: 'cue', suppressed: true }] } },
    }), /control characters/)
  }
  assert.doesNotThrow(() => assertAssCueText('A\nB'))
  const ass = buildAssSubtitles({ width: 320, height: 240, fps: 30, cues: [],
    ctaOverlays: [{ id: 'cta', startFrame: 1, endFrame: 2, text: 'A\nB' }],
  })
  assert.ok(ass.includes('Dialogue: 1,0:00:00.03,0:00:00.06,CTA'))
  assert.ok(ass.includes('}A B'))
  assert.throws(() => assertEditorialAssEmission({ fps: 30, ctaOverlays: [{ startFrame: 0, endFrame: 1, text: '{}\\' }] }), /empty/)
})

test('pre-render identity pins emission policy and cannot replay old arithmetic', () => {
  const inputs = { projectId: 'p', projectVersionId: 'v', outputSpec: { fps: 30 } }
  const oldHash = calculateVersionHash({ kind: 'project-final-export/v1', ...inputs })
  const expected = calculateVersionHash({ kind: 'project-final-export/v1', ...inputs, assEmissionPolicy: ASS_EMISSION_POLICY })
  assert.equal(projectFinalRenderInputHash(inputs), expected)
  assert.notEqual(expected, oldHash)
  assert.equal(projectFinalRenderInputHash({ ...inputs, assEmissionPolicy: { version: 'old' } }), expected)
})

test('renderer rejects a valid global CTA rebased into an invalid 120 fps clock before source I/O', async () => {
  const renderer = new FfmpegEditorialProxyRenderer({ workRoot: join(tmpdir(), 'apollo-clock-preflight-never-created') })
  await assert.rejects(renderer.render({
    operationId: 'clock-rebase-preflight', renderKind: 'proxy', fps: 120, format: '9:16', lutPaths: {},
    sources: [{ artifactId: 'source-clock', mediaType: 'video', path: join(tmpdir(), 'apollo-clock-source-does-not-exist.mp4'), colorPipelineCompilation: {} }],
    clips: [{ id: 'clip-clock', sourceArtifactId: 'source-clock', sourceInFrame: 0, sourceOutFrame: 6,
      timelineInFrame: 0, timelineOutFrame: 6, rate: 1 }],
    ctaOverlays: [{ id: 'cta-clock', startFrame: 2, endFrame: 3, text: 'CTA' }],
    rangeReuse: { schemaVersion: 'project-proxy-range-reuse/v1', path: join(tmpdir(), 'apollo-clock-base-does-not-exist.mp4'),
      sha256: 'a'.repeat(64), byteSize: 111, ranges: [{ startFrame: 1, endFrame: 4 }] },
  }), /cannot represent the exact frame/)
})

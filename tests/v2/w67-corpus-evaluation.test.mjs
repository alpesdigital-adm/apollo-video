import assert from 'node:assert/strict'
import test from 'node:test'

import { CLASSES, evaluateOutput, flaggedFrames, summarize } from './w67/corpus-evaluate.mjs'
import { bandsOf, coveringBands, FORMATS, framingOf, goodWindow, lostWindow, toOutput, visibleShare } from './w67/corpus-geometry.mjs'

const { createMp4QualityReport, MP4_PIXEL_CRITIC_POLICY } = await import('../../src/v2/domain/mp4-pixel-quality.ts')
const { pixelOracleModelPins } = await import('../../src/v2/domain/pixel-face-oracle.ts')

const sha = (character) => character.repeat(64)
const SAFE = FORMATS['9:16'].safeArea
const NO_INK = { pixels: 0, bbox: null, touchesCanvasEdge: false }
const ink = (x0, y0, x1, y1, edge = false) => ({ pixels: 4000, bbox: { x0, y0, x1, y1 }, touchesCanvasEdge: edge })
const region = (captionInkPixels = 0, ctaInkPixels = 0) => ({ origin: 'oracle-0204-v9', box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, captionInkPixels, ctaInkPixels })
const VISIBLE = { state: 'measured', visibleFraction: 1, outputConfirmed: true, projected: { x0: 0.3, y0: 0.3, x1: 0.5, y1: 0.5 } }
const CLIPPED = { state: 'measured', visibleFraction: 0.35, outputConfirmed: false, projected: { x0: -0.1, y0: 0.3, x1: 0.1, y1: 0.5 } }

/** A 90-frame all-frames report whose per-frame facts are chosen by the caller. */
function report(factsAt) {
  const samples = Array.from({ length: 90 }, (_unused, frameIndex) => ({
    sampleId: `s-${frameIndex}`, frameIndex, ptsTicks: frameIndex * 512, frameSha256: sha('a'),
    caption: NO_INK, cta: NO_INK, inkDensity: 0, oracle: { state: 'observed', outputFaceCount: 1, sourceFaceCount: 1 }, registration: null,
    protectedRegions: [region()], subject: VISIBLE, ...factsAt(frameIndex),
  }))
  return createMp4QualityReport({
    identity: { workspaceId: 'workspace-w67', projectId: 'project-w67', projectVersionId: 'version-w67', variantId: 'variant-9x16', outputSpecId: 'preset-9x16', format: '9:16', operationId: 'operation-w67', renderInputHash: sha('c') },
    artifact: { sha256: sha('d'), byteSize: 99, container: 'mp4', videoCodec: 'h264', pixelFormat: 'yuv420p', width: 540, height: 960, frameRate: { num: 30, den: 1 }, timeBase: { num: 1, den: 15360 }, frameCount: 90, durationTicks: 46080 },
    decode: { status: 'complete', framesExpected: 90, framesDecoded: 90, frameListSha256: sha('e'), stderrSha256: sha('f'), ffmpegBinarySha256: null },
    outputSpec: { width: 540, height: 960, safeArea: SAFE }, controls: [], noiseProbe: null,
    oracle: { protocol: 'apollo-pixel-oracle/v1', models: pixelOracleModelPins(), bridgeSha256: sha('1'), pythonSha256: sha('2'), runtime: {}, registration: MP4_PIXEL_CRITIC_POLICY.registration, perSample: [] },
    samples,
  })
}
const inRange = (frame, [start, end]) => frame >= start && frame < end
const LABELS = [
  { defect: 'caption-over-face', startFrame: 8, endFrame: 28 },
  { defect: 'crop-lost', startFrame: 45, endFrame: 90 },
  { defect: 'cta-outside-safe-area', startFrame: 31, endFrame: 44 },
]
const evaluate = (labels, factsAt) => evaluateOutput({ outputId: 'o', format: '9:16', variant: 'v', labels, report: report(factsAt) })

/** What a perfect critic sees on an output with exactly `defects` seeded. */
const world = (defects) => (frame) => ({
  ...(inRange(frame, [8, 28]) ? { caption: ink(60, 800, 480, 840), inkDensity: 0.04, protectedRegions: [region(defects.includes('caption-over-face') ? 200 : 0)] } : {}),
  ...(inRange(frame, [31, 44]) ? defects.includes('cta-outside-safe-area') ? { cta: ink(0, 90, 539, 140, true), inkDensity: 0.08 } : { cta: ink(100, 90, 400, 140), inkDensity: 0.03 } : {}),
  ...(inRange(frame, [45, 90]) && defects.includes('crop-lost') ? { subject: CLIPPED } : {}),
})
const labelsFor = (defects) => LABELS.filter((label) => defects.includes(label.defect))

test('a perfect critic: every labelled unit is detected exactly, nothing else is flagged, no unknown - accepted', () => {
  const all = ['caption-over-face', 'crop-lost', 'cta-outside-safe-area']
  const evaluations = [[], ['caption-over-face'], ['crop-lost'], ['cta-outside-safe-area'], all].map((defects) => evaluate(labelsFor(defects), world(defects)))
  for (const evaluation of evaluations) for (const unit of evaluation.units) assert.equal(unit.exact || !unit.labelled, true, `${evaluation.outputId} ${unit.className}`)
  const summary = summarize(evaluations)
  assert.equal(summary.totals.labelledUnits, 6)
  assert.equal(summary.totals.detectedUnits, 6)
  assert.equal(summary.totals.exactUnits, 6)
  assert.equal(summary.totals.falseSafeUnits, 0)
  assert.equal(summary.totals.falsePositiveUnits, 0)
  assert.equal(summary.totals.unknownFrames, 0)
  assert.equal(summary.accepted, true)
  assert.equal(summary.totals.recallExact, 1)
  assert.equal(summary.totals.precisionExact, 1)
})

test('a miss is a failure: the labelled defect judged safe is a FALSE-SAFE unit, not a smaller recall', () => {
  const blind = evaluate(labelsFor(['caption-over-face']), world([]))
  const unit = blind.units.find((entry) => entry.className === 'caption-over-face')
  assert.equal(unit.detected, false)
  assert.equal(unit.falseSafe, true)
  assert.equal(unit.falseSafeFrames, 20)
  const summary = summarize([blind])
  assert.equal(summary.accepted, false)
  assert.equal(summary.totals.falseSafeUnits, 1)
  assert.equal(summary.totals.recallDetected, 0)
})

test('a defect found one frame late, or flagged one frame too long, is not an exact detection and pollutes the adjacent negatives', () => {
  const late = (frame) => { const base = world(['caption-over-face'])(frame); return frame === 8 ? { ...base, protectedRegions: [region(0)] } : base }
  const lateUnit = evaluate(labelsFor(['caption-over-face']), late).units.find((entry) => entry.className === 'caption-over-face')
  assert.equal(lateUnit.detected, true)
  assert.equal(lateUnit.exact, false, 'the first frame of the cue was judged safe')
  assert.equal(lateUnit.falseSafe, true)
  const long = (frame) => (frame === 28 ? { caption: ink(60, 800, 480, 840), inkDensity: 0.04, protectedRegions: [region(50)] } : world(['caption-over-face'])(frame))
  const longUnit = evaluate(labelsFor(['caption-over-face']), long).units.find((entry) => entry.className === 'caption-over-face')
  assert.equal(longUnit.exact, false)
  assert.equal(longUnit.outsideFrames, 1)
  assert.equal(longUnit.falsePositiveUnit, true)
  assert.equal(summarize([evaluate(labelsFor(['caption-over-face']), long)]).accepted, false)
})

test('a flagged class with no label is a false positive; a hard issue of an unmapped code is too; unknown frames fail the acceptance', () => {
  const clean = evaluate([], world(['cta-outside-safe-area']))
  assert.equal(clean.units.find((entry) => entry.className === 'cta-outside-safe-area').falsePositiveUnit, true)
  assert.equal(summarize([clean]).accepted, false)
  const dense = evaluate([], (frame) => (inRange(frame, [8, 28]) ? { caption: ink(60, 800, 480, 840), inkDensity: 0.04, protectedRegions: [region(0)], cta: ink(100, 90, 400, 140) } : {}))
  assert.equal(dense.unmappedHard.length, 0)
  const unknown = evaluate([], (frame) => (inRange(frame, [8, 28]) ? { caption: ink(60, 800, 480, 840), inkDensity: 0.04, protectedRegions: [], oracle: { state: 'observed', outputFaceCount: 0, sourceFaceCount: 0 }, subject: { state: 'not-applicable', reason: 'NO_SOURCE_FACE' } } : {}))
  assert.ok(Object.values(unknown.unknownByCheck).reduce((a, b) => a + b, 0) >= 20)
  assert.equal(summarize([unknown]).accepted, false, 'an unknown is never a pass')
  const emptyCorpus = summarize([])
  assert.equal(emptyCorpus.accepted, false, 'no labelled unit, no acceptance')
})

test('classes are separated by code and, for ink codes, by overlay kind', () => {
  const caption = report((frame) => (inRange(frame, [8, 28]) ? { caption: ink(0, 800, 539, 840, true), inkDensity: 0.04 } : {}))
  assert.equal(flaggedFrames(caption, 'cta-outside-safe-area').size, 0, 'a caption leaving the safe area is not the CTA defect')
  assert.deepEqual(Object.keys(CLASSES), ['caption-over-face', 'crop-lost', 'cta-outside-safe-area'])
  const evaluation = evaluateOutput({ outputId: 'o', format: '9:16', variant: 'v', labels: [], report: caption })
  assert.ok(evaluation.unmappedHard.length > 0, 'an unlabelled caption overflow is a hard issue no label explains')
})

// ---- the framing geometry (independent of the product) ---------------------------------------------------------------------
test('framing: the good window puts the face at the rules\' size and place; the lost window leaves a third of it; a band covers it', () => {
  const source = { width: 1024, height: 1024 }
  const face = { x0: 0.408, y0: 0.2, x1: 0.518, y1: 0.332 }
  const derived = { top: { x: 0.07, y: 0.08, width: 0.86, height: 0.0775 }, 'upper-third': { x: 0.07, y: 0.340833333, width: 0.86, height: 0.0775 }, center: { x: 0.07, y: 0.47125, width: 0.86, height: 0.0775 }, 'lower-third': { x: 0.07, y: 0.601666667, width: 0.86, height: 0.0775 }, bottom: { x: 0.07, y: 0.8025, width: 0.86, height: 0.0775 } }
  const bands = bandsOf('9:16', derived)
  const good = goodWindow(face, '9:16', source)
  assert.equal(good.feasible, true)
  assert.ok(Math.abs((good.window.width * source.width) / (good.window.height * source.height) - 9 / 16) < 1e-9, 'the window has the canvas aspect')
  assert.ok(Math.abs((good.placed.y1 - good.placed.y0) * 960 - 170) < 1, 'the face is 170 px tall in the 960 px canvas')
  const lost = lostWindow(face, good.window, '9:16', source)
  assert.equal(lost.feasible, true)
  assert.ok(Math.abs(visibleShare(toOutput(face, lost.window)) - 0.35) <= 0.02)
  assert.deepEqual(coveringBands(good.placed, bands), ['upper-third'])
  const framing = framingOf(face, '9:16', source, bands)
  assert.equal(framing.feasible, true)
  assert.equal(framing.target, 'upper-third')
  assert.deepEqual(framing.blockers, ['bottom', 'lower-third'])
  assert.equal(goodWindow({ x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 }, '9:16', source).reason, 'FACE_TOO_LARGE_FOR_TARGET_SCALE')
  assert.equal(goodWindow({ x0: 0.5, y0: 0.5, x1: 0.52, y1: 0.52 }, '9:16', source).reason, 'UPSCALE_TOO_HIGH')
})

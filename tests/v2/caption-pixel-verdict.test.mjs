import assert from 'node:assert/strict'
import test from 'node:test'

import { createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { captionSampleFrames, CAPTION_BAND_TOLERANCE_PX, evaluateCaptionPixels } from '../../src/v2/domain/caption-pixel-verdict.ts'
import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { critiqueOutputFormat } from '../../src/v2/domain/format-quality-critic.ts'
import { createRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { buildRenderElementMap } from '../../src/v2/domain/review-system.ts'
import { captionFootprintOf, MIN_CHANGED_PIXELS } from '../../src/v2/infrastructure/media/ffmpeg-caption-pixel-critic.ts'
import { expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

/**
 * W65: the pixel verdict compares MEASURED footprints with the plan, and never trusts the renderer's own element map or the
 * detector behind the clearance.
 */
const CANVAS = Object.freeze({ width: 960, height: 540 })
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const clip = { id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 300 }
const projection = createCaptionProjection({ layout: { canvas: CANVAS }, sources: [SOURCE], clips: [clip] })
const cleanStream = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 300, rowsAt: () => [[0.9, 0, 0, 0.03, 0.05]] })], expectation())
const CUE = { id: 'cue-1', startFrame: 100, endFrame: 130 }
const planFor = ({ evidence = [{ sourceArtifactId: 'source-1', stream: cleanStream }], elements = [], cues = [CUE] } = {}) => createRenderPlacementPlan({
  format: '16:9', canvas: CANVAS, durationFrames: 300, subtitlePresetId: 'kinetic', elements,
  subtitleAnchor: { fps: 30, cues, faceClearance: { projection, evidence } },
})
const plan = planFor()
const band = plan.subtitleAnchorPlan.decisions[0].bounds
const inside = { x: band.x + 0.1, y: band.y + 0.02, width: 0.3, height: band.height - 0.04 }
const sample = (frame, footprint, extra = {}) => ({ frame, footprint, changedPixels: footprint ? 500 : 0, ...extra })
const codes = (issues) => issues.map((issue) => [issue.code, issue.severity])

test('a caption inside the decided band is accepted, with the honest warning that no independent face check ran', () => {
  const samples = [sample(100, inside), sample(115, inside), sample(129, inside), sample(50, null), sample(200, null)]
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples, faceVeto: 'ran' })), [])
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples, faceVeto: 'unavailable' })), [['FACE_PIXEL_CHECK_UNAVAILABLE', 'warning']])
})

test('a drawn cue that left no pixels, or drew outside its band, is a hard mismatch', () => {
  const missing = evaluateCaptionPixels({ plan, samples: [sample(115, null)], faceVeto: 'ran' })
  assert.deepEqual(codes(missing), [['CAPTION_PLACEMENT_MISMATCH', 'hard']])
  assert.match(missing[0].message, /left no caption pixels/)
  const elsewhere = { x: band.x, y: Math.max(0, band.y - 0.2), width: 0.3, height: 0.05 }
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples: [sample(115, elsewhere)], faceVeto: 'ran' })), [['CAPTION_PLACEMENT_MISMATCH', 'hard']])
  // the slack is the tolerance, not a free pass
  const justOut = { ...inside, y: band.y - (CAPTION_BAND_TOLERANCE_PX + 3) / CANVAS.height }
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples: [sample(115, justOut)], faceVeto: 'ran' })), [['CAPTION_PLACEMENT_MISMATCH', 'hard']])
  const withinSlack = { ...inside, y: band.y - (CAPTION_BAND_TOLERANCE_PX - 2) / CANVAS.height }
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples: [sample(115, withinSlack)], faceVeto: 'ran' })), [])
})

test('pixels where the plan draws nothing - a frame outside every cue, or a withheld cue - are a hard mismatch', () => {
  const stray = evaluateCaptionPixels({ plan, samples: [sample(50, inside)], faceVeto: 'ran' })
  assert.deepEqual(codes(stray), [['CAPTION_PLACEMENT_MISMATCH', 'hard']])
  assert.equal(stray[0].cueId, null)
  const withheld = planFor({ evidence: [] })
  assert.equal(withheld.subtitleAnchorPlan.decisions[0].disposition, 'review-required')
  assert.deepEqual(codes(evaluateCaptionPixels({ plan: withheld, samples: [sample(115, null)], faceVeto: 'unavailable' })), [])
  const burned = evaluateCaptionPixels({ plan: withheld, samples: [sample(115, inside)], faceVeto: 'unavailable' })
  assert.deepEqual(codes(burned), [['CAPTION_PLACEMENT_MISMATCH', 'hard']])
  assert.match(burned[0].message, /withholds cue cue-1/)
})

test('a caption over a drawn placement is a mismatch unless the plan itself recorded the compromise', () => {
  const logo = { id: 'logo-1', kind: 'logo', anchor: 'auto', priority: 90, readingOrder: 0, minWidth: 0.1, maxWidth: 0.2, minHeight: 0.1, maxHeight: 0.2,
    timeRange: { startFrame: 0, endFrame: 300 }, assetArtifactId: 'artifact-logo-1', assetSha256: 'a'.repeat(64) }
  const withLogo = planFor({ elements: [logo] })
  const placement = withLogo.placements.find((entry) => entry.elementId === 'logo-1')
  assert.ok(placement)
  const decision = withLogo.subtitleAnchorPlan.decisions[0]
  const onTheLogo = { x: placement.bounds.x, y: placement.bounds.y, width: placement.bounds.width, height: placement.bounds.height }
  const issues = evaluateCaptionPixels({ plan: withLogo, samples: [sample(115, onTheLogo)], faceVeto: 'ran' })
  assert.ok(issues.some((issue) => issue.code === 'CAPTION_PLACEMENT_MISMATCH' && issue.elementIds.includes('logo-1')), 'the covered logo is named')
  // a footprint that is inside the band and clear of the logo is accepted
  const clear = { x: decision.bounds.x + 0.4, y: decision.bounds.y + 0.02, width: 0.1, height: decision.bounds.height - 0.04 }
  const logoClear = placement.bounds.x + placement.bounds.width < clear.x || clear.x + clear.width < placement.bounds.x ||
    placement.bounds.y + placement.bounds.height < clear.y || clear.y + clear.height < placement.bounds.y
  assert.ok(logoClear, 'the solver keeps the logo out of the band the subtitles own')
  assert.deepEqual(codes(evaluateCaptionPixels({ plan: withLogo, samples: [sample(115, clear)], faceVeto: 'ran' })), [])
})

test('a face the veto detector finds under the measured caption is a hard overlap; elsewhere it changes nothing', () => {
  const under = [{ x: inside.x + 0.05, y: inside.y, width: 0.1, height: inside.height }]
  const overlap = evaluateCaptionPixels({ plan, samples: [sample(115, inside, { faceBoxes: under })], faceVeto: 'ran' })
  assert.deepEqual(codes(overlap), [['SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'hard']])
  const far = [{ x: 0.05, y: 0.05, width: 0.1, height: 0.1 }]
  assert.deepEqual(codes(evaluateCaptionPixels({ plan, samples: [sample(115, inside, { faceBoxes: far })], faceVeto: 'ran' })), [])
})

test('a measurement that failed is reported as unavailable for every drawn cue - never as a pass', () => {
  const failed = evaluateCaptionPixels({ plan, samples: [], faceVeto: 'unavailable', measurementFailed: true })
  assert.deepEqual(codes(failed), [['FACE_PIXEL_CHECK_UNAVAILABLE', 'warning']])
  assert.match(failed[0].message, /could not be measured/)
  assert.deepEqual(evaluateCaptionPixels({ plan: planFor({ evidence: [] }), samples: [], faceVeto: 'unavailable', measurementFailed: true }), [], 'nothing drawn, nothing to verify')
})

test('the frames worth measuring: first, middle and last of a drawn cue, the middle of a withheld one, and one frame of each gap', () => {
  assert.deepEqual([...captionSampleFrames(plan)], [50, 100, 115, 129, 215])
  const two = planFor({ cues: [CUE, { id: 'cue-2', startFrame: 140, endFrame: 170 }] })
  assert.deepEqual([...captionSampleFrames(two)], [50, 100, 115, 129, 135, 140, 155, 169, 235])
  assert.equal(captionSampleFrames(two, 4).length, 4)
  assert.deepEqual([...captionSampleFrames(createRenderPlacementPlan({ format: '16:9', canvas: CANVAS, durationFrames: 300, subtitlePresetId: null, elements: [] }))], [])
})

test('the footprint is the box around the pixels that differ, and codec noise is not a caption', () => {
  const width = 64, height = 48
  const control = new Uint8Array(width * height * 3).fill(60)
  const delivered = new Uint8Array(control)
  const paint = (x0, y0, x1, y1, value) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) delivered.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3) }
  // isolated differences are noise
  paint(2, 2, 3, 3, 255); paint(50, 40, 51, 41, 255)
  assert.deepEqual(captionFootprintOf(delivered, control, width, height), { footprint: null, changedPixels: 0 })
  // a glyph-sized block is the caption
  paint(10, 20, 30, 30, 255)
  const measured = captionFootprintOf(delivered, control, width, height)
  assert.deepEqual(measured.footprint, { x: 10 / width, y: 20 / height, width: 20 / width, height: 10 / height })
  assert.ok(measured.changedPixels >= MIN_CHANGED_PIXELS)
  // a small difference in brightness is below the threshold
  const dim = new Uint8Array(control); for (let y = 20; y < 30; y += 1) for (let x = 10; x < 30; x += 1) dim.fill(90, (y * width + x) * 3, (y * width + x) * 3 + 3)
  assert.equal(captionFootprintOf(dim, control, width, height).footprint, null)
})

test('the format critic lifts the pixel issues into the variant report: a mismatch or an overlap blocks the output, an unavailable check warns', () => {
  const map = buildRenderElementMap({ proxyHash: 'a'.repeat(64), fps: 30, durationFrames: 300, canvas: CANVAS, source: { width: 1280, height: 720 },
    clips: [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: 300 }] })
  const critique = (captionPixelIssues) => critiqueOutputFormat({ outputSpecId: plan.outputSpecId, format: '16:9', proxyHash: 'a'.repeat(64), map,
    placementPlanHash: plan.placementPlanHash, subtitleAnchorPlan: plan.subtitleAnchorPlan, captionPixelIssues })
  const mismatch = critique(evaluateCaptionPixels({ plan, samples: [sample(115, null)], faceVeto: 'ran' }))
  assert.equal(mismatch.status, 'blocked'); assert.equal(mismatch.exportAllowed, false)
  assert.deepEqual(mismatch.issues.map((issue) => issue.code), ['CAPTION_PLACEMENT_MISMATCH'])
  assert.equal(mismatch.issues[0].placementPlanHash, plan.placementPlanHash)
  const warned = critique(evaluateCaptionPixels({ plan, samples: [sample(115, inside)], faceVeto: 'unavailable' }))
  assert.equal(warned.status, 'warning'); assert.equal(warned.exportAllowed, true)
  assert.deepEqual(warned.issues.map((issue) => issue.code), ['FACE_PIXEL_CHECK_UNAVAILABLE'])
})

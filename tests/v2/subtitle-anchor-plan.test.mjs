import test from 'node:test'
import assert from 'node:assert/strict'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { PERCEPTION_GOLDEN_FIXTURES } from '../../src/v2/domain/perception-timeline.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import {
  createSubtitleAnchorPlan,
  deriveSubtitleAnchorBands,
  SUBTITLE_ANCHOR_BLOCKER_KINDS,
  SUBTITLE_ANCHOR_PERCEPTION_FIXTURES,
  SUBTITLE_ANCHOR_PREFERENCE,
  subtitleAnchorDecisionFor,
  validateSubtitleAnchorPlan,
} from '../../src/v2/domain/subtitle-anchor-plan.ts'

const FORMAT = '9:16'
const FPS = 30
const DURATION_FRAMES = 90
const preset = readOutputFormatPreset(FORMAT)
const region = deriveSubtitleRegion({ spec: preset.spec, presetId: 'kinetic' })
const bands = deriveSubtitleAnchorBands({ region, safeArea: preset.spec.safeArea })
const canvas = { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height }

const planFor = (perceptionTimeline, cues, extra = {}) => createSubtitleAnchorPlan({
  spec: preset.spec, format: FORMAT, canvas, fps: FPS, durationFrames: DURATION_FRAMES,
  region, cues, ...(perceptionTimeline ? { perceptionTimeline } : {}), ...extra,
})

test('T-FR-173 derives five eligible bands from the preset and the safe area, never from a literal', () => {
  assert.deepEqual([...SUBTITLE_ANCHOR_PREFERENCE].toSorted(), ['bottom', 'center', 'lower-third', 'top', 'upper-third'])
  assert.deepEqual([...SUBTITLE_ANCHOR_BLOCKER_KINDS], ['face', 'ocr', 'insert', 'cta', 'logo'])
  // Every band is the *same* box the preset authored, only moved: change the preset and all five move.
  for (const anchor of SUBTITLE_ANCHOR_PREFERENCE) {
    assert.equal(bands[anchor].width, region.bounds.width)
    assert.equal(bands[anchor].height, region.bounds.height)
    assert.equal(bands[anchor].x, region.bounds.x)
    assert.ok(bands[anchor].y >= preset.spec.safeArea.top - 1e-9)
    assert.ok(bands[anchor].y + bands[anchor].height <= 1 - preset.spec.safeArea.bottom + 1e-9)
  }
  assert.equal(bands.bottom.y, region.bounds.y)
  // A different preset (different font/limits) must not reuse this geometry.
  const other = deriveSubtitleRegion({ spec: preset.spec, presetId: 'caps-stroke' })
  assert.notEqual(
    calculateCanonicalHash(deriveSubtitleAnchorBands({ region: other, safeArea: preset.spec.safeArea })),
    calculateCanonicalHash(bands),
  )
})

test('T-FR-173 climbs off a low face and consults the content-addressed perception evidence', () => {
  const timeline = SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace
  const plan = planFor(timeline, [{ id: 'cue-1', startFrame: 0, endFrame: 45 }])
  const decision = subtitleAnchorDecisionFor(plan, 'cue-1')
  assert.equal(plan.perceptionTimelineHash, timeline.timelineHash)
  assert.equal(decision.anchor, 'upper-third')
  assert.deepEqual(decision.bounds, bands['upper-third'])
  // The bottom bands were the preferred ones and were rejected by the face, with the evidence named.
  assert.ok(!decision.eligibleAnchors.includes('bottom'))
  assert.ok(!decision.eligibleAnchors.includes('lower-third'))
  assert.deepEqual(decision.blockerIds, ['face-lower'])
  assert.equal(decision.suppressed, false)
  assert.equal(plan.issues.length, 0)
  validateSubtitleAnchorPlan(plan, {
    region, safeArea: preset.spec.safeArea, outputSpecId: preset.spec.id,
    format: FORMAT, canvas, durationFrames: DURATION_FRAMES,
  })
})

test('T-FR-173 preserves the previous anchor by hysteresis instead of taking the first candidate', () => {
  // Frames 0-29 have the low face; from frame 30 on nothing blocks the preferred `bottom` band.
  const timeline = SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace
  const plan = planFor(timeline, [
    { id: 'cue-1', startFrame: 0, endFrame: 30 },
    { id: 'cue-2', startFrame: 30, endFrame: 60 },
    { id: 'cue-3', startFrame: 60, endFrame: 90 },
  ])
  const anchors = plan.decisions.map((decision) => decision.anchor)
  assert.deepEqual(anchors, ['upper-third', 'upper-third', 'upper-third'])
  assert.deepEqual(plan.decisions.map((decision) => decision.stable), [false, true, true])
  assert.equal(plan.decisions.filter((decision) => decision.changedFromPrevious).length, 0)
})

test('T-FR-173 keeps adjacent cues on one band across a flicker in the evidence', () => {
  // The face disappears for frames 30-35. Without the stability window cue-2 would fall back to
  // `bottom` and cue-3 would jump back up — a visible flip-flop on a one-second span.
  const plan = planFor(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.flickeringFace, [
    { id: 'cue-1', startFrame: 0, endFrame: 30 },
    { id: 'cue-2', startFrame: 30, endFrame: 36 },
    { id: 'cue-3', startFrame: 36, endFrame: 90 },
  ])
  assert.deepEqual(plan.decisions.map((decision) => decision.anchor), ['upper-third', 'upper-third', 'upper-third'])
  assert.equal(plan.issues.length, 0)
})

test('T-FR-173 relaxes onto non-critical evidence with a recorded warning, never onto a face', () => {
  const plan = planFor(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.fullScreenOcr, [{ id: 'cue-1', startFrame: 0, endFrame: 45 }])
  const decision = subtitleAnchorDecisionFor(plan, 'cue-1')
  assert.deepEqual(decision.eligibleAnchors, [])
  assert.equal(decision.anchor, 'bottom')
  assert.equal(decision.suppressed, false)
  assert.deepEqual(plan.issues.map((issue) => issue.code), ['SUBTITLE_ANCHOR_FALLBACK'])
  assert.equal(plan.issues[0].severity, 'warning')
  assert.deepEqual(plan.issues[0].evidenceIds, ['ocr-fullscreen'])
  assert.deepEqual(plan.issues[0].elementIds, ['subtitle:cue-1'])
})

test('T-FR-173 suppresses a cue and emits a hard localized reason code when a face owns every band', () => {
  const plan = planFor(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.noSafeRegion, [{ id: 'cue-1', startFrame: 15, endFrame: 60 }])
  const decision = subtitleAnchorDecisionFor(plan, 'cue-1')
  assert.equal(decision.anchor, null)
  assert.equal(decision.bounds, null)
  assert.equal(decision.suppressed, true)
  assert.deepEqual(plan.issues.map((issue) => issue.code), ['NO_SAFE_SUBTITLE_REGION'])
  assert.equal(plan.issues[0].severity, 'hard')
  assert.deepEqual(plan.issues[0].evidenceRange, { startFrame: 15, endFrame: 60 })
  assert.deepEqual(plan.issues[0].rangeMs, [500, 2_000])
  // The other policy refuses to render at all rather than shipping a variant with a missing cue.
  assert.throws(
    () => planFor(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.noSafeRegion, [{ id: 'cue-1', startFrame: 15, endFrame: 60 }], { policy: { onNoSafeRegion: 'fail-closed' } }),
    /No safe subtitle region/,
  )
})

test('T-FR-173 treats a face without geometry as unavoidable instead of guessing a band', () => {
  assert.deepEqual(
    planFor(SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace, [{ id: 'cue-1', startFrame: 0, endFrame: 45 }]).evidenceWithoutGeometry,
    [],
  )
  // `PERCEPTION_GOLDEN_FIXTURES.talkingHead` records faces as `{ trackId }` with no box at all.
  // An unlocalizable face cannot prove any band is free, so the decision refuses to draw.
  const blind = planFor(PERCEPTION_GOLDEN_FIXTURES.talkingHead, [{ id: 'cue-1', startFrame: 0, endFrame: 45 }])
  const decision = subtitleAnchorDecisionFor(blind, 'cue-1')
  assert.deepEqual(blind.evidenceWithoutGeometry, ['face-1'])
  assert.equal(decision.anchor, null)
  assert.equal(decision.suppressed, true)
  assert.deepEqual(blind.issues.map((issue) => issue.code), ['NO_SAFE_SUBTITLE_REGION'])
  // A non-face observation without geometry is recorded but blocks nothing.
  const insert = planFor(PERCEPTION_GOLDEN_FIXTURES.insertedImage, [{ id: 'cue-1', startFrame: 0, endFrame: 40 }])
  assert.equal(subtitleAnchorDecisionFor(insert, 'cue-1').anchor, 'bottom')
  assert.ok(insert.evidenceWithoutGeometry.includes('ocr-1'))
})

test('T-FR-173 reads cta and logo geometry from the solved plan, not from a caller-supplied box', () => {
  const plan = createRenderPlacementPlan({
    format: FORMAT, canvas, durationFrames: DURATION_FRAMES, subtitlePresetId: 'kinetic',
    elements: [{
      id: 'cta-hero', kind: 'cta', anchor: 'auto', priority: 80, readingOrder: 0,
      minWidth: 0.5, maxWidth: 0.9, minHeight: 0.3, maxHeight: 0.6,
      timeRange: { startFrame: 0, endFrame: DURATION_FRAMES },
    }],
    subtitleAnchor: {
      fps: FPS,
      cues: [{ id: 'cue-1', startFrame: 0, endFrame: 45 }],
      perceptionTimeline: SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.multipleOverlays,
    },
  })
  validateRenderPlacementPlan(plan)
  const anchorPlan = plan.subtitleAnchorPlan
  const decision = subtitleAnchorDecisionFor(anchorPlan, 'cue-1')
  const cta = plan.placements.find((placement) => placement.elementId === 'cta-hero')
  // Face, insert and the solved CTA all took part; the decision names each blocker it consulted.
  assert.ok(decision.blockerIds.includes('face-upper'))
  assert.ok(decision.blockerIds.includes('insert-middle'))
  assert.ok(decision.blockerIds.includes('cta-hero'))
  assert.ok(decision.anchor !== null)
  // Whatever band won, it does not intersect the CTA the plan actually reserved.
  const band = decision.bounds
  const disjoint = band.x >= cta.bounds.x + cta.bounds.width || band.x + band.width <= cta.bounds.x ||
    band.y >= cta.bounds.y + cta.bounds.height || band.y + band.height <= cta.bounds.y
  assert.equal(disjoint, true)
  // There is no way to inject an occupied region: the option does not exist on the input.
  assert.equal('occupied' in plan, false)
})

test('T-FR-173 fails closed on a tampered anchor plan before a frame is rendered', () => {
  const plan = createRenderPlacementPlan({
    format: FORMAT, canvas, durationFrames: DURATION_FRAMES, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [{ id: 'cue-1', startFrame: 0, endFrame: 45 }], perceptionTimeline: SUBTITLE_ANCHOR_PERCEPTION_FIXTURES.lowerFace },
  })
  validateRenderPlacementPlan(plan)
  const moved = {
    ...plan,
    subtitleAnchorPlan: {
      ...plan.subtitleAnchorPlan,
      decisions: plan.subtitleAnchorPlan.decisions.map((decision) => ({ ...decision, bounds: bands.bottom })),
    },
  }
  assert.throws(() => validateRenderPlacementPlan(moved), /hash is inconsistent|does not sit on its declared band/)
  const rehashed = { ...plan, subtitleAnchorPlan: { ...plan.subtitleAnchorPlan, anchorPlanHash: '0'.repeat(64) } }
  assert.throws(() => validateRenderPlacementPlan(rehashed), /hash is inconsistent/)
})

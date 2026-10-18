import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { canvasBandSourceAreas, createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { collectFaceEvidenceStream } from '../../src/v2/domain/face-evidence-stream.ts'
import { FACE_EVIDENCE_POLICY_SHA256 } from '../../src/v2/domain/face-evidence-policy.ts'
import { readOutputFormatPreset } from '../../src/v2/domain/output-format-registry.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { deriveSubtitleAnchorBands, subtitleAnchorDecisionFor, validateSubtitleAnchorPlan } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { createSubtitleAnchorPlanV3, validateSubtitleAnchorPlanV3 } from '../../src/v2/domain/subtitle-anchor-plan-v3.ts'
import { deriveSubtitleRegion } from '../../src/v2/domain/subtitle-region.ts'
import { expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

/**
 * W65: the anchor of every cue is decided from the three-state clearance of each of the five bands, per variant canvas.
 * `unknown` never becomes a drawn caption, and nothing here ever claims facial safety.
 */
const FPS = 30
const DURATION = 300
const SOURCE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const setup = (format) => {
  const preset = readOutputFormatPreset(format)
  const region = deriveSubtitleRegion({ spec: preset.spec, presetId: 'kinetic' })
  const canvas = { width: preset.exportDefaults.proxy.width, height: preset.exportDefaults.proxy.height }
  const projection = createCaptionProjection({ layout: { canvas }, sources: [SOURCE],
    clips: [{ id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: DURATION }] })
  const bands = deriveSubtitleAnchorBands({ region, safeArea: preset.spec.safeArea })
  return { preset, region, canvas, projection, bands }
}
const LANDSCAPE = setup('16:9')
const PORTRAIT = setup('9:16')
const stream = (rowsAt) => collectFaceEvidenceStream([sealedWindow({ start: 0, end: DURATION, rowsAt })], expectation())
const FAR = [0.9, 0.0, 0.0, 0.03, 0.05]
const evidenceOf = (built) => [{ sourceArtifactId: 'source-1', stream: built }]
const plan = (world, cues, { evidence = [], projection = world.projection, placements, perceptionTimeline } = {}) => createSubtitleAnchorPlanV3({
  spec: world.preset.spec, format: world === PORTRAIT ? '9:16' : '16:9', canvas: world.canvas, fps: FPS, durationFrames: DURATION,
  region: world.region, cues, projection, faceEvidence: evidence, ...(placements ? { placements } : {}),
  ...(perceptionTimeline ? { perceptionTimeline } : {}),
})
const expectedFor = (world, extra = {}) => ({ region: world.region, safeArea: world.preset.spec.safeArea, outputSpecId: world.preset.spec.id,
  format: world === PORTRAIT ? '9:16' : '16:9', canvas: world.canvas, durationFrames: DURATION, ...extra })
/** A detection (score, xmin, ymin, xmax, ymax) centred in the source area `anchor` maps to on this world's canvas. */
function rowUnder(world, anchor, cue) {
  const [segment] = canvasBandSourceAreas(world.projection, world.bands[anchor], cue)
  assert.equal(segment.kind, 'source', `${anchor} must be over the picture on this canvas`)
  const cx = segment.area.x + segment.area.width / 2, cy = segment.area.y + segment.area.height / 2
  return [0.9, cx - 0.02, cy - 0.03, cx + 0.02, cy + 0.03]
}
const CUE_A = { id: 'cue-a', startFrame: 100, endFrame: 130 }

test('with complete clean evidence the preferred band is placed and the plan still never claims facial safety', () => {
  const result = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream(() => [FAR])) })
  const decision = subtitleAnchorDecisionFor(result, 'cue-a')
  assert.equal(result.schemaVersion, 'subtitle-anchor-plan/v3')
  assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom'); assert.equal(decision.suppressed, false)
  assert.deepEqual(decision.bounds, LANDSCAPE.bands.bottom)
  assert.deepEqual([...decision.eligibleAnchors], ['bottom', 'lower-third', 'upper-third', 'top', 'center'])
  assert.equal(result.issues.length, 0)
  assert.equal(result.faceClearance.faceSafety, 'unknown')
  assert.match(result.faceClearance.meaning, /not a statement that no face is present/)
  assert.equal(result.faceClearance.policySha256, FACE_EVIDENCE_POLICY_SHA256)
  assert.equal(result.faceClearance.projectionHash, LANDSCAPE.projection.projectionHash)
  assert.deepEqual(result.faceClearance.streams.map((entry) => entry.sourceArtifactId), ['source-1'])
  assert.equal(decision.stabilityWindow.endFrame, 130, 'a 30-frame cue already spans the stability window')
  validateSubtitleAnchorPlanV3(result, expectedFor(LANDSCAPE, { projectionHash: LANDSCAPE.projection.projectionHash }))
})

test('a detected face under the bottom band moves the caption to the first band that is certified clear', () => {
  const row = rowUnder(LANDSCAPE, 'bottom', CUE_A)
  const result = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR]))) })
  const decision = subtitleAnchorDecisionFor(result, 'cue-a')
  assert.equal(decision.bandAssessments.bottom.face.state, 'occupied')
  assert.notEqual(decision.anchor, 'bottom')
  assert.equal(decision.disposition, 'placed')
  assert.equal(decision.bandAssessments[decision.anchor].face.state, 'free-certified')
  assert.ok(decision.blockerIds.some((id) => id.startsWith('face-clearance:')), 'the occupying clearance is named')
  assert.ok(!decision.eligibleAnchors.includes('bottom'))
  validateSubtitleAnchorPlanV3(result, expectedFor(LANDSCAPE))
})

test('unknown coverage is never drawn: the cue is review-required with the hard reason code and its band candidates as data', () => {
  const result = plan(LANDSCAPE, [CUE_A])
  const decision = subtitleAnchorDecisionFor(result, 'cue-a')
  assert.equal(decision.disposition, 'review-required')
  assert.equal(decision.anchor, null); assert.equal(decision.bounds, null); assert.equal(decision.suppressed, true)
  assert.deepEqual(decision.issues.map((issue) => [issue.code, issue.severity]), [['FACE_PERCEPTION_UNAVAILABLE', 'hard']])
  assert.match(decision.issues[0].message, /NO_FACE_EVIDENCE_FOR_SOURCE/)
  // the review UI reads the candidates from the plan, not from burned pixels
  assert.deepEqual(Object.keys(decision.bandAssessments).sort(), ['bottom', 'center', 'lower-third', 'top', 'upper-third'])
  assert.deepEqual(Object.values(decision.bandAssessments).map((entry) => entry.face.state), ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
  assert.deepEqual(decision.issues[0].evidenceRange, { startFrame: 100, endFrame: 130 })
  validateSubtitleAnchorPlanV3(result, expectedFor(LANDSCAPE))
  // an unmeasurable render (a source dimension is unknown) is the same answer, with its own reason
  const unprojectable = plan(LANDSCAPE, [CUE_A], { projection: null })
  assert.equal(subtitleAnchorDecisionFor(unprojectable, 'cue-a').disposition, 'review-required')
  assert.equal(unprojectable.faceClearance.projectionHash, null)
  assert.match(subtitleAnchorDecisionFor(unprojectable, 'cue-a').issues[0].message, /PROJECTION_UNAVAILABLE/)
})

test('when faces own every band the cue is blocked with NO_SAFE_SUBTITLE_REGION; one unknown band keeps it review-required', () => {
  const everywhere = LANDSCAPE.bands
  const rows = Object.keys(everywhere).map((anchor) => rowUnder(LANDSCAPE, anchor, CUE_A))
  const blocked = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream((frame) => (frame === 115 ? rows : [FAR]))) })
  const decision = subtitleAnchorDecisionFor(blocked, 'cue-a')
  assert.equal(decision.disposition, 'blocked'); assert.equal(decision.anchor, null)
  assert.deepEqual(decision.issues.map((issue) => [issue.code, issue.severity]), [['NO_SAFE_SUBTITLE_REGION', 'hard']])
  assert.deepEqual(Object.values(decision.bandAssessments).map((entry) => entry.face.state), ['occupied', 'occupied', 'occupied', 'occupied', 'occupied'])
  validateSubtitleAnchorPlanV3(blocked, expectedFor(LANDSCAPE))
  // faces under four bands, but the evidence stops before the cue ends: the bands that are not occupied could not be
  // certified, so the cue is not "blocked" (a band might still be free) - it needs review, and is not drawn
  const partial = collectFaceEvidenceStream([sealedWindow({ start: 0, end: 110, rowsAt: (frame) => (frame === 105 ? rows.slice(0, 4) : [FAR]) })], expectation())
  const review = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(partial) })
  const reviewDecision = subtitleAnchorDecisionFor(review, 'cue-a')
  const states = Object.values(reviewDecision.bandAssessments).map((entry) => entry.face.state)
  assert.ok(states.includes('occupied') && states.includes('unknown') && !states.includes('free-certified'), states.join(','))
  assert.equal(reviewDecision.disposition, 'review-required'); assert.equal(reviewDecision.anchor, null)
  assert.deepEqual(reviewDecision.issues.map((issue) => issue.code), ['FACE_PERCEPTION_UNAVAILABLE'])
  validateSubtitleAnchorPlanV3(review, expectedFor(LANDSCAPE))
})

test('9:16: a band over the blurred copy is placed without detector evidence, a band over the strip needs it', () => {
  const noEvidence = plan(PORTRAIT, [CUE_A])
  const decision = subtitleAnchorDecisionFor(noEvidence, 'cue-a')
  assert.equal(decision.bandAssessments.bottom.face.evaluations[0].kind, 'geometry-outside-foreground')
  assert.equal(decision.bandAssessments.center.face.state, 'unknown', 'the centre band is over the picture strip and has no evidence')
  assert.equal(decision.anchor, 'bottom'); assert.equal(decision.disposition, 'placed')
  assert.deepEqual([...decision.bandAssessments.bottom.face.reasons], ['GEOMETRY_NO_FOREGROUND_OVERLAP'])
  assert.equal(noEvidence.faceClearance.faceSafety, 'unknown')
  validateSubtitleAnchorPlanV3(noEvidence, expectedFor(PORTRAIT, { projectionHash: PORTRAIT.projection.projectionHash }))
})

test('hysteresis: the previous band is kept while it stays certified, even when a preferred one became free', () => {
  const lowFace = rowUnder(LANDSCAPE, 'bottom', { startFrame: 100, endFrame: 130 })
  const evidence = evidenceOf(stream((frame) => (frame >= 95 && frame <= 135 ? [lowFace] : [FAR])))
  const result = plan(LANDSCAPE, [CUE_A, { id: 'cue-b', startFrame: 140, endFrame: 170 }], { evidence })
  const first = subtitleAnchorDecisionFor(result, 'cue-a'), second = subtitleAnchorDecisionFor(result, 'cue-b')
  assert.notEqual(first.anchor, 'bottom')
  assert.ok(second.bandAssessments.bottom.face.state === 'free-certified', 'the bottom band is clear for the second cue')
  assert.equal(second.anchor, first.anchor, 'the caption does not chase the layout')
  assert.equal(second.stable, true); assert.equal(second.changedFromPrevious, false)
  validateSubtitleAnchorPlanV3(result, expectedFor(LANDSCAPE))
})

test('a CTA or logo overlapping every certified band relaxes with a warning, never onto a face', () => {
  const cta = { elementId: 'cta-1', kind: 'cta', bounds: { x: 0, y: 0, width: 1, height: 1 }, timeRange: { startFrame: 0, endFrame: DURATION } }
  const result = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream(() => [FAR])), placements: [cta] })
  const decision = subtitleAnchorDecisionFor(result, 'cue-a')
  assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom')
  assert.deepEqual(decision.issues.map((issue) => [issue.code, issue.severity]), [['SUBTITLE_ANCHOR_FALLBACK', 'warning']])
  assert.deepEqual([...decision.eligibleAnchors], [])
  // the same CTA over an occupied band does not rescue it
  const row = rowUnder(LANDSCAPE, 'bottom', CUE_A)
  const occupied = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR]))), placements: [cta] })
  assert.notEqual(subtitleAnchorDecisionFor(occupied, 'cue-a').anchor, 'bottom')
})

test('the validator re-derives everything: a rewritten band state, a moved anchor or an edited identity fails closed', () => {
  const row = rowUnder(LANDSCAPE, 'bottom', CUE_A)
  const good = plan(LANDSCAPE, [CUE_A], { evidence: evidenceOf(stream((frame) => (frame === 115 ? [row] : [FAR]))) })
  const expected = expectedFor(LANDSCAPE, { projectionHash: LANDSCAPE.projection.projectionHash })
  validateSubtitleAnchorPlanV3(good, expected)
  const rehash = (mutated) => {
    const { anchorPlanHash: _unused, ...body } = mutated
    return { ...mutated, anchorPlanHash: calculateCanonicalHash(body) }
  }
  const clone = () => structuredClone(good)
  const forged = clone()
  forged.decisions[0].bandAssessments.bottom.face.state = 'free-certified'
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(forged), expected), /does not follow from its clearance evaluations/)
  const moved = clone()
  moved.decisions[0].anchor = 'bottom'; moved.decisions[0].bounds = LANDSCAPE.bands.bottom
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(moved), expected), /does not follow from its band assessments/)
  const suppressedLie = clone()
  suppressedLie.decisions[0].suppressed = true
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(suppressedLie), expected), /does not follow from its band assessments/)
  const staleHash = clone(); staleHash.decisions[0].disposition = 'blocked'
  assert.throws(() => validateSubtitleAnchorPlanV3(staleHash, expected), /hash is inconsistent|does not follow/)
  const wrongPolicy = clone(); wrongPolicy.faceClearance.policySha256 = 'a'.repeat(64)
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(wrongPolicy), expected), /face clearance evidence is invalid/)
  const claimsSafety = clone(); claimsSafety.faceClearance.faceSafety = 'verified'
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(claimsSafety), expected), /face clearance evidence is invalid/)
  const evidenceEdited = clone(); evidenceEdited.faceClearance.streams[0].streamHash = 'b'.repeat(64)
  assert.throws(() => validateSubtitleAnchorPlanV3(rehash(evidenceEdited), expected), /evidence hash is inconsistent/)
  assert.throws(() => validateSubtitleAnchorPlanV3(good, { ...expected, projectionHash: PORTRAIT.projection.projectionHash }), /not bound to this render/)
  assert.throws(() => validateSubtitleAnchorPlanV3(good, expectedFor(PORTRAIT)), /does not describe this render/)
  // v3 has its own validator: the v1/v2 one refuses it
  assert.throws(() => validateSubtitleAnchorPlan(good, expected), /unsupported/)
})

test('the placement plan carries the v3 anchor plan, binds its hash, and refuses an ambiguous declaration', () => {
  const evidence = evidenceOf(stream(() => [FAR]))
  const build = (extra = {}) => createRenderPlacementPlan({
    format: '16:9', canvas: LANDSCAPE.canvas, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A], faceClearance: { projection: LANDSCAPE.projection, evidence }, ...extra },
  })
  const placement = build()
  assert.equal(placement.schemaVersion, 'render-placement-plan/v3')
  assert.equal(placement.subtitleAnchorPlan.schemaVersion, 'subtitle-anchor-plan/v3')
  validateRenderPlacementPlan(placement)
  assert.equal(build().placementPlanHash, placement.placementPlanHash, 'deterministic')
  const withoutEvidence = createRenderPlacementPlan({
    format: '16:9', canvas: LANDSCAPE.canvas, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A], faceClearance: { projection: LANDSCAPE.projection, evidence: [] } },
  })
  assert.notEqual(withoutEvidence.placementPlanHash, placement.placementPlanHash, 'the evidence is part of the placement identity')
  assert.throws(() => build({ faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' } }), /exactly one/)
  assert.throws(() => createRenderPlacementPlan({
    format: '16:9', canvas: LANDSCAPE.canvas, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A] },
  }), /requires explicit unknown facial coverage/)
  const tampered = structuredClone(placement)
  tampered.subtitleAnchorPlan.decisions[0].bandAssessments.bottom.face.state = 'occupied'
  const { placementPlanHash: _hash, ...body } = tampered
  assert.throws(() => validateRenderPlacementPlan({ ...tampered, placementPlanHash: calculateCanonicalHash(body) }), /does not follow|hash is inconsistent/)
  // a v2 plan keeps validating exactly as before
  const legacy = createRenderPlacementPlan({
    format: '16:9', canvas: LANDSCAPE.canvas, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A], faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' } },
  })
  assert.equal(legacy.schemaVersion, 'render-placement-plan/v2'); validateRenderPlacementPlan(legacy)
})

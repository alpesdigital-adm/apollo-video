import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createCaptionProjection } from '../../src/v2/domain/caption-canvas-projection.ts'
import { evaluateCaptionPixels } from '../../src/v2/domain/caption-pixel-verdict.ts'
import {
  admitDirectorQualityForFinal, certifyFinalCaptions, FINAL_CAPTION_ANCHOR_POLICY, FINAL_CAPTION_CERTIFICATION_POLICY,
  FINAL_CAPTION_CERTIFICATION_POLICY_SHA256,
} from '../../src/v2/domain/final-caption-certification.ts'
import { collectFaceSourceEvidenceStream } from '../../src/v2/domain/face-source-evidence-stream.ts'
import { createRenderPlacementPlan, validateRenderPlacementPlan } from '../../src/v2/domain/render-placement-plan.ts'
import { sealedSourceWindow, sourceExpectation } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65b: the final is admissible without ever granting a global face safety. The Director's quality report may stay
 * `review-required` with `faceSafety: unknown` when that is the ONLY thing it reports; admission is decided per BURNED cue
 * (placed in a free-certified band, by trusted evidence or by geometry, and confirmed by the pixel critic); a cue that cannot
 * be certified is omitted and listed as a review item.
 */
const FPS = 30
const DURATION = 300
const LANDSCAPE = Object.freeze({ artifactId: 'source-1', width: 1280, height: 720 })
const PORTRAIT = Object.freeze({ artifactId: 'source-1', width: 720, height: 1280 })
const clip = { id: 'clip-1', sourceArtifactId: 'source-1', timelineInFrame: 0, timelineOutFrame: DURATION, sourceInFrame: 0, sourceOutFrame: DURATION, rate: 1 }
const CLEAN = [0.9, 0, 0, 0.03, 0.05]
const cleanStream = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: DURATION, rowsAt: () => [CLEAN] })], sourceExpectation({ sourceDurationFrames: DURATION }))
const CUE_A = { id: 'cue-a', startFrame: 20, endFrame: 60 }
const CUE_B = { id: 'cue-b', startFrame: 100, endFrame: 130 }

/** A 9:16 canvas: a landscape picture is a strip, so the bottom band is certified by geometry; a portrait one fills it. */
function plan({ source = LANDSCAPE, evidence = [], cues = [CUE_A, CUE_B], policy = FINAL_CAPTION_ANCHOR_POLICY } = {}) {
  const canvas = { width: 540, height: 960 }
  const projection = createCaptionProjection({ layout: { canvas }, sources: [source], clips: [clip] })
  return createRenderPlacementPlan({
    format: '9:16', canvas, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues, ...(policy ? { policy } : {}), faceClearance: { projection, evidence } },
  })
}
const completed = (issues) => ({ measurement: 'completed', issues })
const quality = (overrides = {}) => ({
  schemaVersion: 'director-quality-report/v3', id: 'quality-1', status: 'review-required',
  faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
  strategic: { passed: true, score: 91, gateFailures: [], rubric: { threshold: 70 } },
  hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true, subtitlesFaceSafe: false, subtitlesBounded: true, forbiddenSpeechAbsent: true, timelineContinuous: true },
  issues: [{ code: 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED', severity: 'warning', category: 'editorial', message: 'x', correctable: true }],
  score: 0.91, ...overrides,
})
const pixelHard = (code, cueId = 'cue-a') => ({ code, severity: 'hard', cueId, evidenceRange: { startFrame: 30, endFrame: 31 },
  elementIds: [`subtitle:${cueId}`], evidenceIds: [], message: 'x' })

test('the policy is pinned and versioned, and it never claims a global face safety', () => {
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.id, 'final-caption-certification/v1')
  assert.match(FINAL_CAPTION_CERTIFICATION_POLICY_SHA256, /^[a-f0-9]{64}$/)
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY_SHA256, calculateCanonicalHash(FINAL_CAPTION_CERTIFICATION_POLICY))
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.claims.faceSafety, 'unknown')
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.uncertifiedCue.action, 'omit')
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.uncertifiedCue.listedAs, 'review-item')
  assert.equal(FINAL_CAPTION_CERTIFICATION_POLICY.burnedCue.pixelCritic, 'required')
  assert.deepEqual({ ...FINAL_CAPTION_CERTIFICATION_POLICY.anchorPolicy }, { onNoSafeRegion: 'omit-and-list' })
  assert.deepEqual({ ...FINAL_CAPTION_ANCHOR_POLICY }, { onNoSafeRegion: 'omit-and-list' })
  assert.throws(() => { FINAL_CAPTION_CERTIFICATION_POLICY.claims.faceSafety = 'verified' }, TypeError)
  assert.throws(() => { FINAL_CAPTION_CERTIFICATION_POLICY.burnedCue.certifiedBy.push('anything') }, TypeError)
})

test('a Director report that is review-required ONLY because face safety is unknown is admitted per cue; anything else is not', () => {
  assert.deepEqual(admitDirectorQualityForFinal(quality()), { admitted: true, basis: 'per-cue-caption-certification' })
  const refused = (report, pattern) => {
    const verdict = admitDirectorQualityForFinal(report)
    assert.equal(verdict.admitted, false)
    assert.match(verdict.reason, pattern)
  }
  refused(quality({ status: 'blocked' }), /status/)
  refused(quality({ hardChecks: { ...quality().hardChecks, timelineContinuous: false } }), /hard check/)
  refused(quality({ hardChecks: { ...quality().hardChecks, subtitlesBounded: false } }), /hard check/)
  refused(quality({ hardChecks: { ...quality().hardChecks, forbiddenSpeechAbsent: false } }), /hard check/)
  refused(quality({ strategic: { ...quality().strategic, passed: false } }), /strategic/)
  refused(quality({ issues: [{ code: 'STRATEGIC_RIGHTS_FAILED', severity: 'hard', category: 'policy', message: 'x', correctable: true }] }), /hard issue/)
  // the unknown claim must be exactly that: a report that says unknown but also claims face-safe subtitles is inconsistent
  refused(quality({ hardChecks: { ...quality().hardChecks, subtitlesFaceSafe: true } }), /face safety/)
  refused(quality({ faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: ['perception-1'] } }), /face safety/)
  // approved without a verified face safety is not a thing
  refused(quality({ status: 'approved' }), /status/)
  refused(quality({ status: 'approved-with-warnings' }), /status/)
  // a verified one keeps its own (legacy) basis
  assert.deepEqual(admitDirectorQualityForFinal(quality({
    status: 'approved', faceSafety: { status: 'verified', reasonCode: 'FACE_VERIFIED', evidenceRefs: ['perception-1'] },
    hardChecks: { ...quality().hardChecks, subtitlesFaceSafe: true },
  })), { admitted: true, basis: 'verified-face-safety' })
})

test('every burned cue is placed in a free-certified band and confirmed in pixels; the receipt names how each band was certified', () => {
  const geometry = plan()
  const pixels = completed(evaluateCaptionPixels({ plan: geometry, samples: [], faceVeto: 'unavailable' }))
  const result = certifyFinalCaptions({ plan: geometry, pixelCheck: pixels })
  assert.equal(result.admissible, true)
  assert.deepEqual(result.failures, [])
  assert.deepEqual(result.receipt.burned.map((entry) => [entry.cueId, entry.anchor, entry.certification]), [
    ['cue-a', 'bottom', 'geometry-outside-foreground'], ['cue-b', 'bottom', 'geometry-outside-foreground']])
  assert.deepEqual(result.receipt.omitted, [])
  assert.equal(result.receipt.schemaVersion, 'final-caption-certification-receipt/v1')
  assert.equal(result.receipt.policyId, 'final-caption-certification/v1')
  assert.equal(result.receipt.policySha256, FINAL_CAPTION_CERTIFICATION_POLICY_SHA256)
  assert.equal(result.receipt.faceSafety, 'unknown')
  assert.equal(result.receipt.placementPlanHash, geometry.placementPlanHash)
  assert.equal(result.receipt.anchorPlanHash, geometry.subtitleAnchorPlan.anchorPlanHash)
  assert.equal(result.receipt.pixelCritic, 'ran')
  assert.match(result.receipt.receiptHash, /^[a-f0-9]{64}$/)
  const { receiptHash, ...body } = result.receipt
  assert.equal(receiptHash, calculateCanonicalHash(body))
  assert.equal(certifyFinalCaptions({ plan: geometry, pixelCheck: pixels }).receipt.receiptHash, receiptHash, 'deterministic')
  assert.deepEqual(result.receipt.pixelWarnings.map((entry) => [entry.code, entry.cueId]), [
    ['FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-a'], ['FACE_PIXEL_CHECK_UNAVAILABLE', 'cue-b']], 'an unavailable independent check is recorded, not hidden')
})

test('evidence-certified cues say so, and the clearance seals are in the receipt', () => {
  const withEvidence = plan({ source: PORTRAIT, cues: [CUE_A], evidence: [{ sourceArtifactId: 'source-1', stream: cleanStream }] })
  const result = certifyFinalCaptions({ plan: withEvidence, pixelCheck: completed([]) })
  assert.equal(result.admissible, true)
  assert.equal(result.receipt.burned[0].certification, 'face-clearance')
  assert.deepEqual([...result.receipt.burned[0].sourceArtifactIds], ['source-1'])
  assert.match(result.receipt.burned[0].clearanceHashes[0], /^[a-f0-9]{64}$/)
  assert.deepEqual({ ...result.receipt.burned[0].window }, { ...withEvidence.subtitleAnchorPlan.decisions[0].stabilityWindow })
})

test('a cue that cannot be certified is omitted and listed; the final does not depend on it', () => {
  // a portrait picture fills the canvas: every band is over it, and without face windows none can be certified
  const unknown = plan({ source: PORTRAIT })
  assert.deepEqual(unknown.subtitleAnchorPlan.issues.map((issue) => [issue.code, issue.severity]), [
    ['FACE_PERCEPTION_UNAVAILABLE', 'warning'], ['FACE_PERCEPTION_UNAVAILABLE', 'warning']], 'review items, not blockers')
  const result = certifyFinalCaptions({ plan: unknown, pixelCheck: null })
  assert.equal(result.admissible, true, 'omitting is the sanctioned remedy, not a failure')
  assert.deepEqual(result.receipt.burned, [])
  assert.deepEqual(result.receipt.omitted.map((entry) => [entry.cueId, entry.code, entry.disposition]), [
    ['cue-a', 'FACE_PERCEPTION_UNAVAILABLE', 'review-required'], ['cue-b', 'FACE_PERCEPTION_UNAVAILABLE', 'review-required']])
  assert.ok(result.receipt.omitted[0].reasons.includes('NO_FACE_EVIDENCE_FOR_SOURCE'))
  assert.equal(result.receipt.pixelCritic, 'not-needed', 'nothing is burned, so there is nothing to confirm in pixels')
})

test('a mix: the certifiable cue is burned, the other omitted, and both are accounted for', () => {
  // cue-b sits over a frame-filling detection: every band is taken
  const occupied = sealedSourceWindow({ start: 90, end: 140, rowsAt: () => [[0.9, 0.0, 0.0, 1.0, 1.0]] })
  const stream = collectFaceSourceEvidenceStream([sealedSourceWindow({ start: 0, end: 90, rowsAt: () => [CLEAN] }), occupied], sourceExpectation({ sourceDurationFrames: DURATION }))
  const mixed = plan({ source: PORTRAIT, evidence: [{ sourceArtifactId: 'source-1', stream }] })
  const result = certifyFinalCaptions({ plan: mixed, pixelCheck: completed([]) })
  assert.deepEqual(result.receipt.burned.map((entry) => entry.cueId), ['cue-a'])
  assert.deepEqual(result.receipt.omitted.map((entry) => [entry.cueId, entry.code, entry.disposition]), [['cue-b', 'NO_SAFE_SUBTITLE_REGION', 'blocked']])
  assert.equal(result.admissible, true)
  assert.equal(result.receipt.pixelCritic, 'ran')
})

test('the pixel critic is part of the rule: a hard pixel issue, or a critic that did not measure, makes a burned cue inadmissible', () => {
  const geometry = plan()
  const mismatch = certifyFinalCaptions({ plan: geometry, pixelCheck: completed([pixelHard('CAPTION_PLACEMENT_MISMATCH')]) })
  assert.equal(mismatch.admissible, false)
  assert.match(mismatch.failures[0], /cue-a.*CAPTION_PLACEMENT_MISMATCH/)
  const overlap = certifyFinalCaptions({ plan: geometry, pixelCheck: completed([pixelHard('SUBTITLE_FACE_OVERLAP_IN_PIXELS', 'cue-b')]) })
  assert.equal(overlap.admissible, false)
  assert.match(overlap.failures[0], /cue-b.*SUBTITLE_FACE_OVERLAP_IN_PIXELS/)
  const notRun = certifyFinalCaptions({ plan: geometry, pixelCheck: null })
  assert.equal(notRun.admissible, false)
  assert.match(notRun.failures[0], /pixel critic/)
  assert.equal(notRun.receipt.pixelCritic, 'not-run')
  const failed = certifyFinalCaptions({ plan: geometry, pixelCheck: { measurement: 'failed', issues: evaluateCaptionPixels({ plan: geometry, samples: [], faceVeto: 'unavailable', measurementFailed: true }) } })
  assert.equal(failed.admissible, false)
  assert.match(failed.failures[0], /could not measure/)
  assert.equal(failed.receipt.pixelCritic, 'measurement-failed')
  // a hard pixel issue anywhere on the delivered pixels is a disagreement with the plan, even about a cue the plan does not list
  const unrelated = certifyFinalCaptions({ plan: geometry, pixelCheck: completed([pixelHard('CAPTION_PLACEMENT_MISMATCH', 'cue-zzz')]) })
  assert.equal(unrelated.admissible, false)
})

test('defence in depth: a placed decision whose band is not free-certified is refused even if a plan is handed in altered', () => {
  const altered = structuredClone(plan())
  altered.subtitleAnchorPlan.decisions[0].bandAssessments.bottom.face.state = 'occupied'
  const result = certifyFinalCaptions({ plan: altered, pixelCheck: completed([]) })
  assert.equal(result.admissible, false)
  assert.match(result.failures[0], /cue-a.*free-certified/)
})

test('a plan that was not decided under the omit-and-list policy, or by a face clearance, is not a final plan', () => {
  const blocking = plan({ policy: null })
  assert.equal(blocking.subtitleAnchorPlan.policy.onNoSafeRegion, 'suppress-cue')
  const refused = certifyFinalCaptions({ plan: blocking, pixelCheck: completed([]) })
  assert.equal(refused.admissible, false)
  assert.match(refused.failures[0], /omit-and-list/)
  // a legacy plan decided without any face clearance never certifies a burned cue
  const legacy = createRenderPlacementPlan({
    format: '9:16', canvas: { width: 540, height: 960 }, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A], faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' } },
  })
  assert.equal(certifyFinalCaptions({ plan: legacy, pixelCheck: null }).admissible, false)
})

test('with no cues at all the certification is vacuous and admissible', () => {
  const none = createRenderPlacementPlan({ format: '9:16', canvas: { width: 540, height: 960 }, durationFrames: DURATION, subtitlePresetId: null, elements: [] })
  const result = certifyFinalCaptions({ plan: none, pixelCheck: null })
  assert.equal(result.admissible, true)
  assert.deepEqual(result.receipt.burned, [])
  assert.deepEqual(result.receipt.omitted, [])
  assert.equal(result.receipt.anchorPlanHash, null)
  assert.equal(result.receipt.pixelCritic, 'not-needed')
})

test('omit-and-list is only an anchor policy of the v3 plan: it is validated, hashed and re-derived', () => {
  const listed = plan({ source: PORTRAIT })
  validateRenderPlacementPlan(listed)
  assert.equal(listed.subtitleAnchorPlan.policy.onNoSafeRegion, 'omit-and-list')
  assert.notEqual(listed.placementPlanHash, plan({ source: PORTRAIT, policy: null }).placementPlanHash, 'the policy is part of the placement identity')
  // flipping the policy back (or to something unknown) cannot pass the validator: the severities were derived under it
  const tampered = structuredClone(listed)
  tampered.subtitleAnchorPlan.policy.onNoSafeRegion = 'suppress-cue'
  assert.throws(() => validateRenderPlacementPlan(tampered))
  const unknownPolicy = structuredClone(listed)
  unknownPolicy.subtitleAnchorPlan.policy.onNoSafeRegion = 'ignore'
  assert.throws(() => validateRenderPlacementPlan(unknownPolicy))
  // v1/v2 plans keep refusing it: they were never decided by clearance
  assert.throws(() => createRenderPlacementPlan({
    format: '9:16', canvas: { width: 540, height: 960 }, durationFrames: DURATION, subtitlePresetId: 'kinetic', elements: [],
    subtitleAnchor: { fps: FPS, cues: [CUE_A], policy: { onNoSafeRegion: 'omit-and-list' }, faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE' } },
  }))
})

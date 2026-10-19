import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createReframePlan, parseReframeObservationSet, validateReframePlan } from '../../src/v2/domain/reframe-plan.ts'
import { REFRAME_POLICY, REFRAME_POLICY_SHA256, reframeIssueDisposition, reframeVariantDisposition } from '../../src/v2/domain/reframe-policy.ts'
import { projectFaceEvidenceToReframeObservations } from '../../src/v2/domain/server-reframe-roi.ts'
import { parseVariantReframePlanRecord } from '../../src/v2/domain/variant-reframe-plan.ts'
import {
  assertReframeOverrideDoesNotOverlap, createVariantReframeOverride, parseVariantReframeOverride, reframeClipBindingHash,
  selectReframeOverridesForClips,
} from '../../src/v2/domain/variant-reframe-overrides.ts'
import { measureReframeTrajectory } from '../../src/v2/domain/variant-reframe-render-plan.ts'
import {
  buildRecord, clipFacts, cropAt, cropShows, faceAt, faceStream, observedSample, sampledStream, SOURCE, SPECS, sha, unknownSample, VERTICAL_CROP,
} from './helpers/reframe-trajectory-fixtures.mjs'

const MARGIN = REFRAME_POLICY.tracking.safetyMargin
const roi = (stream, clips, durationFrames) => projectFaceEvidenceToReframeObservations({
  id: 'observations-test-1', fps: 30, durationFrames, source: SOURCE, stream, policy: REFRAME_POLICY,
  clips: clips.map((clip) => ({ id: clip.clipId, sourceArtifactId: clip.sourceArtifactId, sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame,
    timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate })),
})
const vertical = (observationSet) => createReframePlan({ format: '9:16', observationSet, policy: REFRAME_POLICY, variant: {
  variantId: SPECS.vertical.variantId, outputSpecRevisionId: SPECS.vertical.outputSpecRevisionId, specHash: SPECS.vertical.specHash, aspectRatio: '9:16', safeArea: SPECS.vertical.safeArea } })
/** A face moving right at `speed` (normalized widths per second) from x0, standing still after `stopFrame`. */
const movingFace = (speed, x0 = 0.1, stopFrame = 60) => (frame) => [faceAt(x0 + speed * Math.min(frame, stopFrame) / 30)]
const trueBox = (speed, x0 = 0.1, stopFrame = 60) => (frame) => faceAt(x0 + speed * Math.min(frame, stopFrame) / 30)

test('W66r the policy is one frozen object whose hash is sealed into every plan and record', () => {
  assert.equal(REFRAME_POLICY.schemaVersion, 'reframe-policy/v1')
  assert.equal(REFRAME_POLICY_SHA256, calculateCanonicalHash(REFRAME_POLICY))
  assert.ok(Object.isFrozen(REFRAME_POLICY) && Object.isFrozen(REFRAME_POLICY.tracking) && Object.isFrozen(REFRAME_POLICY.roi.face))
  // The limits the planner shipped with were not loosened when they moved into the policy.
  assert.deepEqual([REFRAME_POLICY.tracking.maxVelocityPerSecond, REFRAME_POLICY.tracking.maxAccelerationPerSecondSquared, REFRAME_POLICY.tracking.safetyMargin, REFRAME_POLICY.tracking.minObservationConfidence], [0.35, 0.8, 0.02, 0.6])
  const set = roi(sampledStream(movingFace(0.2)), [clipFacts()], 150)
  const plan = vertical(set)
  assert.equal(plan.schemaVersion, 'reframe-plan/v2')
  assert.equal(plan.policyHash, REFRAME_POLICY_SHA256)
  assert.equal(plan.maxVelocityPerSecond, 0.35)
  const record = buildRecord({ stream: sampledStream(movingFace(0.2)) })
  assert.equal(record.policy.hash, REFRAME_POLICY_SHA256)
  // a policy with one number changed is not the pinned policy, even with the pinned id
  const loosened = { ...REFRAME_POLICY, tracking: { ...REFRAME_POLICY.tracking, maxVelocityPerSecond: 1 } }
  assert.throws(() => createReframePlan({ format: '9:16', observationSet: set, policy: loosened, variant: plan.variant }), /pinned reframe-policy/)
  // the caller cannot pass its own limit next to the policy, nor a caller-shaped set
  assert.throws(() => createReframePlan({ format: '9:16', observationSet: set, policy: REFRAME_POLICY, variant: plan.variant, maxVelocityPerSecond: 2 }), /takes its limits from the policy/)
  assert.throws(() => createReframePlan({ format: '9:16', observationSet: { ...set, authority: 'caller' }, policy: REFRAME_POLICY, variant: plan.variant }), /server-owned/)
  // a plan resealed under another policy hash is refused by the validator
  const resealed = { ...plan, policyHash: sha('0') }
  const { planHash: _unused, ...body } = resealed
  assert.throws(() => validateReframePlan({ ...resealed, planHash: calculateCanonicalHash(body) }, set), /pinned reframe policy/)
})

test('W66r ROI projects the sealed face evidence through the clips of the EditPlan, never across a cut', () => {
  // timeline [0,60) plays source [60,120); timeline [60,120) plays source [200,260). A box moves with the SOURCE frame.
  const boxAt = (frame) => [faceAt(0.1 + frame / 1000)]
  const clips = [
    clipFacts({ clipId: 'clip-a', sourceInFrame: 60, sourceOutFrame: 120, timelineInFrame: 0, timelineOutFrame: 60 }),
    clipFacts({ clipId: 'clip-b', sourceInFrame: 200, sourceOutFrame: 260, timelineInFrame: 60, timelineOutFrame: 120 }),
  ]
  const set = roi(sampledStream(boxAt, { from: 0, to: 300, duration: 300 }), clips, 120)
  assert.deepEqual(set.trackingBreaks, [60], 'the second clip restarts the tracking')
  assert.deepEqual(set.unknownRanges, [])
  assert.equal(set.authority, 'server-owned')
  assert.deepEqual(set.roi.object, { status: 'absent', reasonCode: 'NO_VERIFIED_DETECTOR' })
  assert.deepEqual(set.roi.screen, { status: 'absent', reasonCode: 'NO_VERIFIED_PRODUCER' })
  const at = (frame) => set.observations.filter((item) => item.startFrame <= frame && frame < item.endFrame)
  // timeline 3 plays source 63: the slot of sample 60 pairs it with sample 65, so its box is their envelope
  const [early] = at(3)
  assert.ok(Math.abs(early.bounds.x - (0.1 + 60 / 1000)) < 1e-9 && Math.abs(early.bounds.width - (0.1 + 5 / 1000)) < 1e-9, JSON.stringify(early.bounds))
  // the last stride of the first clip stops at its end: sample 115 is held alone, it is NOT paired with sample 200 of the next clip
  const [tail] = at(57)
  assert.ok(Math.abs(tail.bounds.x - (0.1 + 115 / 1000)) < 1e-9, 'the held box is the sample of its own clip')
  assert.ok(Math.abs(tail.bounds.width - 0.1) < 1e-9, `one box only, not an envelope that reaches the next clip: ${tail.bounds.width}`)
  assert.ok(set.observations.every((item) => item.startFrame >= 60 || item.endFrame <= 60), 'no observation straddles the cut')
  // the first stride of the second clip is paired inside the second clip
  const [head] = at(61)
  assert.ok(Math.abs(head.bounds.x - (0.1 + 200 / 1000)) < 1e-9 && Math.abs(head.bounds.width - (0.1 + 5 / 1000)) < 1e-9)
  // every observation names the sealed envelope it came from
  assert.ok(set.observations.every((item) => item.evidenceIds.length >= 1 && item.evidenceIds.every((id) => id === `face-envelope:${sha('e')}`)))
  assert.equal(set.evidence[0].streamHash, sha('9'))
  const plan = vertical(set)
  assert.deepEqual(plan.trackingBreaks, [60])
  const startOfSecond = plan.segments.find((segment) => segment.startFrame === 60)
  assert.deepEqual(startOfSecond.velocity, { x: 0, y: 0 }, 'the tracking restarts at rest after a cut')
})

test('W66r hold and interpolation stop at an unknown sample, a gap between windows, refused evidence and the edge of the clip', () => {
  const samples = []
  for (let frame = 0; frame < 150; frame += 5) {
    if (frame === 30) samples.push(unknownSample(frame))
    else if (frame >= 60 && frame < 75) continue
    else if (frame >= 90 && frame < 100) continue
    else samples.push(observedSample(frame, [faceAt(0.4)]))
  }
  const stream = faceStream(samples, { duration: 150, untrusted: [{ envelopeHash: sha('f'), startSourceFrame: 90, endSourceFrame: 100, reasons: ['SOURCE_MISMATCH'] }] })
  const set = roi(stream, [clipFacts()], 150)
  assert.deepEqual(set.unknownRanges.map((range) => [range.startFrame, range.endFrame, range.reasonCode]), [
    [30, 35, 'UNKNOWN_SAMPLE'], [60, 75, 'WINDOW_GAP'], [90, 100, 'UNTRUSTED_EVIDENCE'],
  ])
  assert.deepEqual(set.unknownRanges[2].evidenceIds, [`face-envelope:${sha('f')}`])
  // nothing is claimed about an unknown stretch: no observation overlaps it, and the stride before it holds ONE box (no pairing across)
  for (const range of set.unknownRanges) assert.ok(set.observations.every((item) => item.endFrame <= range.startFrame || item.startFrame >= range.endFrame))
  const before = set.observations.find((item) => item.startFrame === 25)
  assert.ok(Math.abs(before.bounds.width - 0.1) < 1e-9, 'sample 25 is held alone: its neighbour is unknown')
  // the plan reports each unknown stretch as uncertain, with its reason and evidence, and shows the whole frame there
  const plan = vertical(set)
  const uncertain = plan.issues.filter((issue) => issue.code === 'PERCEPTION_UNCERTAIN')
  assert.deepEqual(uncertain.map((issue) => [issue.startFrame, issue.endFrame, issue.reasonCode]), [[30, 35, 'UNKNOWN_SAMPLE'], [60, 75, 'WINDOW_GAP'], [90, 100, 'UNTRUSTED_EVIDENCE']])
  assert.ok(plan.segments.filter((segment) => segment.startFrame >= 60 && segment.endFrame <= 75).every((segment) => segment.mode === 'contain'))
  // a clip that ends inside a stride holds its last sample to the edge and nothing beyond (no unknown range)
  const edge = roi(sampledStream(() => [faceAt(0.4)], { from: 0, to: 150, duration: 150 }), [clipFacts({ sourceOutFrame: 148, timelineOutFrame: 148 })], 148)
  assert.deepEqual(edge.unknownRanges, [])
  assert.equal(edge.observations.at(-1).endFrame, 148)
  // a clip that starts inside a stride is covered backwards from its first sample, by at most stride - 1 frames
  const lead = roi(sampledStream(() => [faceAt(0.4)], { from: 0, to: 150, duration: 150 }), [clipFacts({ sourceInFrame: 3, sourceOutFrame: 100, timelineInFrame: 0, timelineOutFrame: 97 })], 97)
  assert.deepEqual(lead.unknownRanges, [])
  assert.equal(lead.observations[0].startFrame, 0)
  // a retimed clip, or one with a static crop of its own, is not reframed automatically
  const retimed = roi(sampledStream(() => [faceAt(0.4)]), [clipFacts({ rate: 2 })], 150)
  assert.deepEqual(retimed.unknownRanges.map((range) => range.reasonCode), ['UNSUPPORTED_CLIP'])
  assert.deepEqual(retimed.observations, [])
  // observed absence is not unknown: an empty frame is evidence of no subject
  const empty = roi(sampledStream(() => []), [clipFacts()], 150)
  assert.deepEqual([empty.unknownRanges.length, empty.observations.length, empty.roi.face.status], [0, 0, 'present'])
  assert.deepEqual(vertical(empty).issues.map((issue) => issue.code), ['NO_SUBJECT_OBSERVATION'])
})

test('W66r a background face and a below-floor detection are not subjects, a low-confidence large face is reported uncertain', () => {
  const stream = sampledStream((frame) => frame < 75
    ? [faceAt(0.4), [0.8, 0.1, 0.84, 0.15, 0.9]] // the second box is 5% of the frame high: background
    : [faceAt(0.4), [0.7, 0.2, 0.8, 0.5, 0.35]]) // a large face detected at 0.35: a candidate, not accepted evidence
  const set = roi(stream, [clipFacts()], 150)
  const early = set.observations.filter((item) => item.startFrame < 70)
  assert.ok(early.every((item) => item.bounds.x < 0.6), 'the background face is ignored')
  const late = set.observations.filter((item) => item.startFrame >= 80)
  assert.ok(late.some((item) => item.confidence < 0.6 && !item.critical), 'the low-confidence face is kept, non-critical and under the confidence floor')
  const plan = vertical(set)
  assert.ok(plan.issues.some((issue) => issue.code === 'PERCEPTION_UNCERTAIN' && issue.reasonCode === 'LOW_CONFIDENCE' && issue.startFrame >= 75))
})

test('W66r each variant gets its own plan on its own canvas; a crop that is the whole frame needs no evidence', () => {
  const stream = sampledStream(movingFace(0.2))
  const verticalRecord = buildRecord({ spec: SPECS.vertical, stream })
  const wideRecord = buildRecord({ spec: SPECS.wide, stream })
  assert.equal(verticalRecord.variantId, SPECS.vertical.variantId)
  assert.equal(wideRecord.variantId, SPECS.wide.variantId)
  assert.notEqual(verticalRecord.recordHash, wideRecord.recordHash)
  assert.equal(verticalRecord.renderPlan.variantId, SPECS.vertical.variantId, 'the render plan names the stable variant, not the aspect ratio')
  assert.equal(verticalRecord.renderPlan.format, '9:16')
  assert.equal(wideRecord.renderPlan.format, '16:9')
  // the vertical crop has a different size than the wide one and they never share an absolute coordinate
  const verticalRange = verticalRecord.renderPlan.ranges[0], wideRange = wideRecord.renderPlan.ranges[0]
  assert.ok(Math.abs(verticalRange.keyframes[0].crop.width - VERTICAL_CROP.width) < 1e-9)
  assert.deepEqual(wideRange.keyframes.map((keyframe) => keyframe.crop), [{ x: 0, y: 0, width: 1, height: 1 }], 'a 16:9 crop of a 16:9 source is the whole frame: one keyframe')
  assert.equal(wideRecord.disposition, 'ready')
  // evidence that does not exist cannot make the whole frame uncertain
  const blind = buildRecord({ spec: SPECS.wide, stream: faceStream([], { duration: 150 }) })
  assert.deepEqual([blind.disposition, blind.issues.length], ['ready', 0])
  const blindVertical = buildRecord({ spec: SPECS.vertical, stream: faceStream([], { duration: 150 }) })
  assert.equal(blindVertical.disposition, 'review-required')
  assert.deepEqual(blindVertical.renderPlan.ranges.map((range) => [range.source, range.keyframes.length]), [['fallback', 0]], 'an untracked clip is shown whole')
  // identical inputs give the identical record
  assert.equal(buildRecord({ spec: SPECS.vertical, stream }).recordHash, verticalRecord.recordHash)
  assert.deepEqual(parseVariantReframePlanRecord(JSON.parse(JSON.stringify(verticalRecord))), verticalRecord)
})

test('W66r the trajectory respects the velocity and acceleration limits and shows the subject with the safety margin on every frame', () => {
  const slow = buildRecord({ stream: sampledStream(movingFace(0.2)) })
  assert.deepEqual(slow.issues, [])
  const range = slow.renderPlan.ranges[0]
  const measured = measureReframeTrajectory(range, 30)
  assert.ok(measured.maxSpeed <= REFRAME_POLICY.tracking.maxVelocityPerSecond + 1e-9, `speed ${measured.maxSpeed}`)
  assert.ok(measured.maxAccelerationExcess <= 1e-9, `acceleration excess ${measured.maxAccelerationExcess}`)
  const box = trueBox(0.2)
  for (let frame = 0; frame < 150; frame += 1) {
    assert.ok(cropShows(cropAt(range, frame), box(frame), MARGIN), `frame ${frame}: the crop hides the subject`)
  }
  // a subject faster than the policy allows cannot be followed: the lag is reported as a blocking issue, never rendered as a success
  const fast = buildRecord({ stream: sampledStream((frame) => [faceAt(0.05 + 0.8 * Math.min(frame, 60) / 60)]) })
  assert.ok(fast.issues.some((issue) => issue.code === 'TRACKING_LIMIT_EXCEEDED'), JSON.stringify(fast.issues.map((issue) => issue.code)))
  assert.equal(fast.disposition, 'blocked')
  const fastRange = fast.renderPlan.ranges[0]
  if (fastRange.source === 'plan') assert.ok(measureReframeTrajectory(fastRange, 30).maxSpeed <= REFRAME_POLICY.tracking.maxVelocityPerSecond + 1e-9, 'even when it cannot keep up the crop never moves faster than the limit')
})

test('W66r two subjects that do not fit are one localized blocking issue; the clip is shown whole', () => {
  const stream = sampledStream(() => [faceAt(0.05), faceAt(0.85)])
  const record = buildRecord({ stream })
  assert.deepEqual(record.issues.map((issue) => [issue.code, issue.startFrame, issue.endFrame, issue.clipId, issue.disposition, issue.variantId]),
    [['SUBJECTS_DO_NOT_FIT', 0, 150, 'clip-1', 'blocked', SPECS.vertical.variantId]])
  assert.ok(record.issues[0].evidenceIds.includes(`face-envelope:${sha('e')}`) && record.issues[0].observationIds.length > 0)
  assert.equal(record.disposition, 'blocked')
  assert.deepEqual(record.renderPlan.ranges.map((range) => range.source), ['fallback'])
  // the other variant of the same footage is unaffected: its crop is the whole frame
  const wide = buildRecord({ spec: SPECS.wide, stream })
  assert.deepEqual([wide.disposition, wide.issues.length], ['ready', 0])
})

test('W66r issue codes map to the variant state, and one blocking code outranks any review code', () => {
  assert.deepEqual(['SUBJECTS_DO_NOT_FIT', 'TRACKING_LIMIT_EXCEEDED', 'PERCEPTION_UNCERTAIN', 'NO_SUBJECT_OBSERVATION'].map(reframeIssueDisposition),
    ['blocked', 'blocked', 'review-required', 'review-required'])
  assert.equal(reframeVariantDisposition([]), 'ready')
  assert.equal(reframeVariantDisposition(['NO_SUBJECT_OBSERVATION', 'PERCEPTION_UNCERTAIN']), 'review-required')
  assert.equal(reframeVariantDisposition(['NO_SUBJECT_OBSERVATION', 'SUBJECTS_DO_NOT_FIT']), 'blocked')
  const record = buildRecord({ stream: sampledStream((frame) => (frame >= 60 && frame < 90 ? [] : [faceAt(0.4)])) })
  // the stride of sample 85 is owned by the face that appears at sample 90 (held backward for at most one stride), so the absence ends at 85
  assert.deepEqual(record.issues.map((issue) => [issue.code, issue.startFrame, issue.endFrame]), [['NO_SUBJECT_OBSERVATION', 60, 85]])
  assert.equal(record.disposition, 'review-required')
  // a record whose disposition does not follow from its issues is refused on hydration
  const tampered = JSON.parse(JSON.stringify(record))
  tampered.disposition = 'ready'
  const { recordHash: _recordHash, ...body } = tampered
  assert.throws(() => parseVariantReframePlanRecord({ ...tampered, recordHash: calculateCanonicalHash(body) }), /disposition/)
})

test('W66r a manual override sits on top of the server plan: precedence, exact hold, reset, and the raw evidence is untouched', () => {
  const stream = sampledStream(movingFace(0.2))
  const clip = clipFacts()
  const make = (extra = {}) => createVariantReframeOverride({
    id: 'override-1', workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', resultVersionId: 'version-2', commandId: 'command-1',
    variantId: SPECS.vertical.variantId, aspectRatio: '9:16', clip, startFrame: 60, endFrame: 120, action: 'set',
    crop: { x: 0.45, y: 0, ...VERTICAL_CROP }, previous: null, createdAt: '2026-10-19T00:00:00.000Z', ...extra,
  })
  const base = buildRecord({ stream })
  const set = make()
  const withOverride = buildRecord({ stream, overrideHeads: [set] })
  // precedence: the editor's crop wins on its range and nowhere else
  const range = withOverride.renderPlan.ranges[0]
  assert.deepEqual(range.manualSpans, [{ id: 'override-1', startFrame: 60, endFrame: 120 }])
  for (const frame of [60, 90, 119]) assert.ok(Math.abs(cropAt(range, frame).x - 0.45) < 1e-12, `frame ${frame} holds the manual crop`)
  assert.ok(Math.abs(cropAt(range, 145).x - cropAt(base.renderPlan.ranges[0], 145).x) < 1e-6, 'after the span the automatic trajectory resumes where it would have been')
  assert.ok(Math.abs(cropAt(range, 20).x - cropAt(base.renderPlan.ranges[0], 20).x) < 1e-12, 'before the span nothing moved')
  // the evidence and the automatic decision are byte-identical with and without the override; only the final plan moves
  assert.equal(withOverride.observationSet.contentHash, base.observationSet.contentHash)
  assert.equal(withOverride.serverPlan.planHash, base.serverPlan.planHash)
  assert.notEqual(withOverride.finalPlan.planHash, base.finalPlan.planHash)
  assert.deepEqual(withOverride.overrides.applied.map((item) => [item.id, item.startFrame, item.endFrame]), [['override-1', 60, 120]])
  // reset returns to the inherited level: the record is the one without any override
  const reset = make({ id: 'override-2', resultVersionId: 'version-3', baseVersionId: 'version-2', commandId: 'command-2', action: 'reset', crop: null, previous: set })
  assert.equal(reset.action, 'reset')
  assert.equal(reset.previousOverrideId, 'override-1')
  const afterReset = buildRecord({ stream, overrideHeads: [reset] })
  assert.equal(afterReset.recordHash, base.recordHash, 'a reset head leaves exactly the record there was before any override')
  assert.equal(selectReframeOverridesForClips({ variantId: SPECS.vertical.variantId, heads: [reset], clips: [clip] }).applicable.length, 0)
  // another variant never sees it
  assert.deepEqual(selectReframeOverridesForClips({ variantId: SPECS.wide.variantId, heads: [set], clips: [clip] }).applicable, [])
  // an override authored against another clip is reported, never bent onto this one
  const moved = clipFacts({ sourceInFrame: 3, sourceOutFrame: 153 })
  const stale = selectReframeOverridesForClips({ variantId: SPECS.vertical.variantId, heads: [set], clips: [moved] })
  assert.deepEqual(stale.inactive.map((item) => item.reasonCode), ['CLIP_CHANGED'])
  assert.deepEqual(selectReframeOverridesForClips({ variantId: SPECS.vertical.variantId, heads: [set], clips: [clipFacts({ clipId: 'clip-other' })] }).inactive.map((item) => item.reasonCode), ['CLIP_ABSENT'])
  // an editor crop that hides a subject the server is sure of is inactive, with its reason
  const hiding = buildRecord({ stream, overrideHeads: [make({ crop: { x: 0.68, y: 0, ...VERTICAL_CROP } })] })
  assert.deepEqual(hiding.overrides.inactive.map((item) => item.reasonCode), ['HIDES_CRITICAL_SUBJECT'])
  assert.equal(hiding.finalPlan.planHash, base.finalPlan.planHash, 'an inactive override changes no plan')
  assert.deepEqual(hiding.renderPlan, base.renderPlan, 'an inactive override changes no pixel')
  // ...except where the server itself found no crop can show everyone: there the editor picks which subject to keep, and the block lifts
  const crowded = sampledStream(() => [faceAt(0.05), faceAt(0.85)])
  const blocked = buildRecord({ stream: crowded })
  assert.equal(blocked.disposition, 'blocked')
  const choose = make({ id: 'override-3', startFrame: 0, endFrame: 150, crop: { x: 0, y: 0, ...VERTICAL_CROP } })
  const resolved = buildRecord({ stream: crowded, overrideHeads: [choose] })
  assert.deepEqual([resolved.disposition, resolved.issues.length, resolved.overrides.applied.length], ['ready', 0, 1])
  assert.deepEqual(resolved.renderPlan.ranges.map((item) => item.source), ['plan'])
})

test('W66r the override document is validated, content-addressed and refuses what the renderer cannot encode', () => {
  const clip = clipFacts()
  const input = { id: 'override-1', workspaceId: 'workspace-1', projectId: 'project-1', baseVersionId: 'version-1', resultVersionId: 'version-2', commandId: 'command-1',
    variantId: SPECS.vertical.variantId, aspectRatio: '9:16', clip, startFrame: 30, endFrame: 90, action: 'set', crop: { x: 0.2, y: 0, ...VERTICAL_CROP },
    previous: null, createdAt: '2026-10-19T00:00:00.000Z' }
  const created = createVariantReframeOverride(input)
  assert.equal(created.clipBindingHash, reframeClipBindingHash(clip))
  assert.equal(created.provenance, 'manual-command')
  assert.deepEqual(parseVariantReframeOverride(JSON.parse(JSON.stringify(created))), created)
  assert.throws(() => parseVariantReframeOverride({ ...created, startFrame: 31 }), /content hash/)
  assert.throws(() => createVariantReframeOverride({ ...input, crop: { x: 0.2, y: 0, width: 0.2, height: 0.6 } }), /moved but not zoomed/)
  assert.throws(() => createVariantReframeOverride({ ...input, crop: { x: 0.8, y: 0, ...VERTICAL_CROP } }), /within source bounds/)
  assert.throws(() => createVariantReframeOverride({ ...input, startFrame: 0, endFrame: 200 }), /inside the clip/)
  assert.throws(() => createVariantReframeOverride({ ...input, action: 'reset', crop: null }), /no manual reframe/)
  assert.throws(() => createVariantReframeOverride({ ...input, clip: { ...clip, rate: 1.5 } }), /real-time/)
  assert.throws(() => createVariantReframeOverride({ ...input, resultVersionId: 'version-1' }), /new version/)
  assert.throws(() => assertReframeOverrideDoesNotOverlap([created], { variantId: created.variantId, clipId: 'clip-1', startFrame: 60, endFrame: 120 }), /partially overlap/)
  assert.doesNotThrow(() => assertReframeOverrideDoesNotOverlap([created], { variantId: created.variantId, clipId: 'clip-1', startFrame: 30, endFrame: 90 }))
  assert.doesNotThrow(() => assertReframeOverrideDoesNotOverlap([created], { variantId: 'variant-other-1', clipId: 'clip-1', startFrame: 60, endFrame: 120 }))
  // the observation set carries no caller authority: a hand-made v1 set cannot be planned under the policy
  assert.throws(() => parseReframeObservationSet({ schemaVersion: 'reframe-observations/v2', authority: 'caller' }), /server-owned|fields/)
})

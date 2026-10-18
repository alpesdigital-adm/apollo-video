import assert from 'node:assert/strict'
import test from 'node:test'

import { plannedCaptionsOverKeptFrames, planCaptionPlacement } from '../../src/v2/application/plan-caption-placement.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { faceWindowTimeMap, planRequiredFaceWindows } from '../../src/v2/domain/face-evidence-time-map.ts'
import { subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { expectation } from './helpers/face-envelope-v2.mjs'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'

/**
 * W65/W65b: the caption planner reads the sealed face windows of the SOURCES the render plays (by the source's own frames) and
 * decides the cues on the variant's canvas, whatever the cut. Everything it cannot establish is unknown - and an unknown cue is not
 * drawn.
 */
const SCOPE = Object.freeze({ workspaceId: 'workspace-1', projectId: 'project-1' })
const SOURCE = 'source-1'
const clip = { id: 'clip-1', sourceArtifactId: SOURCE, sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }
const editPlan = Object.freeze({ fps: 30, durationFrames: 300, videoTracks: [{ kind: 'base-video', clips: [clip] }] })
const portraitSource = Object.freeze({ artifactId: SOURCE, sha256: 'b'.repeat(64), mediaType: 'video', probe: Object.freeze({ width: 720, height: 1280 }) })
const CUE = Object.freeze({ id: 'cue-1', startFrame: 100, endFrame: 130 })
const FAR = [0.9, 0.0, 0.0, 0.03, 0.05]
const EVERYWHERE = [0.9, 0.0, 0.0, 1.0, 1.0]
const clean = () => sealedSourceWindow({ start: 0, end: 300, rowsAt: () => [FAR] })
const reader = (envelopes, requests = []) => ({
  async listSourceWindows(input) { requests.push(input); return envelopes.map((envelope) => ({ envelope })) },
})
const input = (extra = {}) => ({
  ...SCOPE, format: '9:16', canvas: { width: 540, height: 960 }, editPlan, clips: [clip], renderSources: [portraitSource],
  subtitleCues: [CUE], subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: SOURCE, ...extra,
})
const deps = (faceEvidence) => ({ clock: () => new Date('2026-10-18T12:00:00.000Z'), ...(faceEvidence ? { faceEvidence } : {}) })
const decisionOf = (result, cueId = 'cue-1') => subtitleAnchorDecisionFor(result.placementPlan.subtitleAnchorPlan, cueId)

test('the source\'s sealed windows are read by SOURCE frames, scoped to workspace, project and source, and a clean stream places the cue', async () => {
  const requests = []
  const result = await planCaptionPlacement(deps(reader([clean()], requests)), input())
  assert.equal(requests.length, 1)
  assert.deepEqual({ ...requests[0], now: undefined }, { ...SCOPE, sourceArtifactId: SOURCE, fromSourceFrame: 85, toSourceFrame: 145, now: undefined, limit: 200 })
  assert.equal('projectVersionId' in requests[0], false, 'evidence belongs to the source, not to a Version')
  assert.equal(result.placementPlan.schemaVersion, 'render-placement-plan/v3')
  const decision = decisionOf(result)
  assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom')
  assert.equal(result.placementPlan.subtitleAnchorPlan.faceClearance.streams.length, 1)
  assert.equal(result.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].frameDomain, 'source')
  assert.equal(result.projection.projectionHash, result.placementPlan.subtitleAnchorPlan.faceClearance.projectionHash)
  assert.deepEqual(result.requiredFaceWindows, [{ sourceArtifactId: SOURCE, windows: [{ startSourceFrame: 85, endSourceFrame: 145 }] }])
})

test('without a reader, without probes or without cues nothing is certified over the picture, and no reader is called', async () => {
  const noReader = decisionOf(await planCaptionPlacement(deps(), input()))
  assert.equal(noReader.disposition, 'review-required')
  const requests = []
  const noProbe = await planCaptionPlacement(deps(reader([clean()], requests)), input({ renderSources: [{ ...portraitSource, probe: undefined }] }))
  assert.equal(decisionOf(noProbe).disposition, 'review-required')
  assert.match(decisionOf(noProbe).issues[0].message, /SOURCE_DIMENSIONS_UNKNOWN/)
  assert.equal(noProbe.projection, null); assert.equal(noProbe.placementPlan.subtitleAnchorPlan.faceClearance.projectionHash, null)
  assert.equal(requests.length, 0, 'an unmeasurable render never reads evidence')
  const noCues = await planCaptionPlacement(deps(reader([clean()], requests)), input({ subtitleCues: [], subtitlePresetId: null }))
  assert.equal(noCues.placementPlan.subtitleAnchorPlan, null)
  assert.equal(requests.length, 0)
})

test('a fractional frame rate is an explicit "no evidence" (no reader call); a renderable snapshot needs no special case any more', async () => {
  const requests = []
  const live = reader([clean()], requests)
  const fractional = await planCaptionPlacement(deps(live), input({ editPlan: { ...editPlan, fps: 29.97 } }))
  assert.equal(decisionOf(fractional).disposition, 'review-required'); assert.equal(requests.length, 0)
  const [stream] = fractional.placementPlan.subtitleAnchorPlan.faceClearance.streams
  assert.equal(stream.streamHash, null); assert.equal(stream.unavailableReason, 'TIMELINE_FPS_NOT_INTEGER')
  assert.ok(decisionOf(fractional).bandAssessments.bottom.face.reasons.includes('TIMELINE_FPS_NOT_INTEGER'))
})

test('a Director cut - several clips, trims, a reordered source - reads the source windows and projects them onto each cue', async () => {
  // timeline 0-100 plays source 150-250; timeline 100-200 plays source 20-120 (earlier in the source)
  const first = { id: 'clip-1', sourceArtifactId: SOURCE, sourceInFrame: 150, sourceOutFrame: 250, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }
  const second = { id: 'clip-2', sourceArtifactId: SOURCE, sourceInFrame: 20, sourceOutFrame: 120, timelineInFrame: 100, timelineOutFrame: 200, rate: 1 }
  const cutPlan = { fps: 30, durationFrames: 200, videoTracks: [{ kind: 'base-video', clips: [first, second] }] }
  // a face fills the frame at SOURCE frames 40-60 only: the cue at timeline 120-140 plays exactly that, the cue at 20-40 plays source 170-190
  const evidence = [sealedSourceWindow({ start: 0, end: 150, rowsAt: (frame) => (frame >= 40 && frame < 60 ? [EVERYWHERE] : [FAR]) }),
    sealedSourceWindow({ start: 150, end: 300, rowsAt: () => [FAR] })]
  const requests = []
  const result = await planCaptionPlacement(deps(reader(evidence, requests)), input({
    editPlan: cutPlan, clips: [first, second],
    subtitleCues: [{ id: 'cue-a', startFrame: 20, endFrame: 40 }, { id: 'cue-b', startFrame: 120, endFrame: 140 }],
  }))
  assert.equal(requests.length, 1, 'one source, one listing')
  // cue-a plays source 170-200 (its stability window), cue-b plays source 40-70; each widened by the 15-frame sample gap
  assert.deepEqual({ ...requests[0], now: undefined }, { ...SCOPE, sourceArtifactId: SOURCE, fromSourceFrame: 25, toSourceFrame: 215, now: undefined, limit: 200 })
  assert.equal(decisionOf(result, 'cue-a').disposition, 'placed', 'source 170-190 is clear')
  assert.equal(decisionOf(result, 'cue-b').disposition, 'blocked', 'source 40-60 holds the face: every band is taken')
  assert.equal(decisionOf(result, 'cue-b').issues[0].code, 'NO_SAFE_SUBTITLE_REGION')
  // the numbers of the TIMELINE are not the numbers of the source: a face at source 120-140 is not under the cue at timeline 120-140
  const wrongPlace = [sealedSourceWindow({ start: 0, end: 150, rowsAt: (frame) => (frame >= 120 && frame < 145 ? [EVERYWHERE] : [FAR]) }),
    sealedSourceWindow({ start: 150, end: 300, rowsAt: () => [FAR] })]
  const unaffected = await planCaptionPlacement(deps(reader(wrongPlace)), input({
    editPlan: cutPlan, clips: [first, second], subtitleCues: [{ id: 'cue-b', startFrame: 120, endFrame: 140 }],
  }))
  assert.equal(decisionOf(unaffected, 'cue-b').disposition, 'placed')
  // what it asks the Director to produce: windows of the SOURCE for both ranges, not of the edit
  assert.deepEqual(result.requiredFaceWindows, [{ sourceArtifactId: SOURCE, windows: [
    { startSourceFrame: 25, endSourceFrame: 85 }, { startSourceFrame: 155, endSourceFrame: 215 }] }])
})

test('a cue across a cut is judged piece by piece in the source: the pieces are not one run', async () => {
  const first = { id: 'clip-1', sourceArtifactId: SOURCE, sourceInFrame: 150, sourceOutFrame: 250, timelineInFrame: 0, timelineOutFrame: 100, rate: 1 }
  const second = { id: 'clip-2', sourceArtifactId: SOURCE, sourceInFrame: 20, sourceOutFrame: 120, timelineInFrame: 100, timelineOutFrame: 200, rate: 1 }
  const cutPlan = { fps: 30, durationFrames: 200, videoTracks: [{ kind: 'base-video', clips: [first, second] }] }
  const result = await planCaptionPlacement(deps(reader([sealedSourceWindow({ start: 0, end: 150, rowsAt: () => [FAR] }),
    sealedSourceWindow({ start: 150, end: 300, rowsAt: () => [FAR] })])), input({
    editPlan: cutPlan, clips: [first, second], subtitleCues: [{ id: 'cue-cut', startFrame: 90, endFrame: 110 }],
  }))
  const decision = decisionOf(result, 'cue-cut')
  assert.equal(decision.disposition, 'placed')
  const pieces = decision.bandAssessments.bottom.face.evaluations.filter((evaluation) => evaluation.kind === 'face-clearance')
  // the stability window runs past the cue (30 frames from its start): 90..120 -> timeline 90-100 (source 240-250), then 100-120 (source 20-40)
  assert.deepEqual(pieces.map((piece) => [piece.startFrame, piece.endFrame, piece.sourceRange.startFrame, piece.sourceRange.endFrame]),
    [[90, 100, 240, 250], [100, 120, 20, 40]])
})

test('a clip whose speed is not 1 is not mapped: its cues are unknown and no window is requested for it', async () => {
  const fast = { ...clip, id: 'clip-fast', sourceOutFrame: 600, rate: 2 }
  const requests = []
  const result = await planCaptionPlacement(deps(reader([clean()], requests)), input({ clips: [fast] }))
  assert.equal(requests.length, 0)
  assert.equal(decisionOf(result).disposition, 'review-required')
  assert.ok(decisionOf(result).bandAssessments.bottom.face.evaluations.some((evaluation) => evaluation.kind === 'clip-map-unprovable' && evaluation.reasons.includes('CLIP_RATE_NOT_UNIT')))
  assert.deepEqual(result.requiredFaceWindows, [])
})

test('evidence of another workspace, another source file or another clock is untrusted: the cue is not drawn', async () => {
  for (const overrides of [{ workspaceId: 'workspace-elsewhere' }, { sourceSha256: 'f'.repeat(64) }, { sourceArtifactId: 'source-9' },
    { sourceFps: { num: 25, den: 1 }, sourceTimebase: { num: 1, den: 12800 } }]) {
    const result = await planCaptionPlacement(deps(reader([sealedSourceWindow({ start: 0, end: 300, rowsAt: () => [FAR], overrides })])), input())
    const decision = decisionOf(result)
    assert.equal(decision.disposition, 'review-required', JSON.stringify(overrides))
    assert.equal(decision.anchor, null)
    assert.ok(result.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].untrusted.length >= 1, JSON.stringify(overrides))
  }
})

test('the W62 clip map of the timeline-keyed windows is untouched and still the one those producers seal', () => {
  const map = faceWindowTimeMap(editPlan, SOURCE)
  assert.equal(calculateCanonicalHash(map), expectation().timeMapHash)
  assert.equal(faceWindowTimeMap(editPlan, 'another-source'), null)
  assert.equal(faceWindowTimeMap({ videoTracks: [{ clips: [{ ...clip, rate: 2 }] }] }, SOURCE), null)
  assert.equal(faceWindowTimeMap({ videoTracks: [{ clips: [clip, clip] }] }, SOURCE), null)
  assert.equal(faceWindowTimeMap({ videoTracks: [{ clips: [{ ...clip, sourceOutFrame: 250 }] }] }, SOURCE), null, 'source and timeline spans must agree')
  assert.equal(faceWindowTimeMap(null, SOURCE), null)
})

test('the window planner widens each span by the sample gap, merges overlaps and cuts windows of at most 300 frames', () => {
  const fps = { num: 30, den: 1 }
  assert.deepEqual(planRequiredFaceWindows({ durationFrames: 300, fps, spans: [{ startFrame: 100, endFrame: 130 }] }),
    [{ startTimelineFrame: 85, endTimelineFrame: 145 }])
  assert.deepEqual(planRequiredFaceWindows({ durationFrames: 300, fps, spans: [{ startFrame: 100, endFrame: 130 }, { startFrame: 140, endFrame: 170 }] }),
    [{ startTimelineFrame: 85, endTimelineFrame: 185 }], 'spans closer than the gap share a window')
  assert.deepEqual(planRequiredFaceWindows({ durationFrames: 300, fps, spans: [{ startFrame: 0, endFrame: 30 }, { startFrame: 270, endFrame: 300 }] }),
    [{ startTimelineFrame: 0, endTimelineFrame: 45 }, { startTimelineFrame: 255, endTimelineFrame: 300 }], 'clamped to the timeline')
  const long = planRequiredFaceWindows({ durationFrames: 1200, fps, spans: [{ startFrame: 0, endFrame: 900 }] })
  assert.deepEqual(long.map((window) => [window.startTimelineFrame, window.endTimelineFrame]), [[0, 300], [300, 600], [600, 900], [900, 915]])
  assert.deepEqual(planRequiredFaceWindows({ durationFrames: 300, fps, spans: [] }), [])
})

test('a reused range is base bytes without captions: a plan that draws a cue over a kept frame cannot use it', async () => {
  const placed = await planCaptionPlacement(deps(reader([clean()])), input())
  const unplaced = await planCaptionPlacement(deps(), input())
  // the cue is [100,130)
  assert.equal(plannedCaptionsOverKeptFrames(placed.placementPlan, [{ startFrame: 100, endFrame: 130 }]), false, 'every cue frame is re-rendered')
  assert.equal(plannedCaptionsOverKeptFrames(placed.placementPlan, [{ startFrame: 100, endFrame: 129 }]), true, 'one kept frame is enough')
  assert.equal(plannedCaptionsOverKeptFrames(placed.placementPlan, [{ startFrame: 0, endFrame: 20 }, { startFrame: 90, endFrame: 140 }]), false)
  assert.equal(plannedCaptionsOverKeptFrames(placed.placementPlan, [{ startFrame: 0, endFrame: 20 }]), true)
  assert.equal(plannedCaptionsOverKeptFrames(unplaced.placementPlan, [{ startFrame: 0, endFrame: 20 }]), false, 'a suppressed cue draws nothing')
})

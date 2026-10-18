import assert from 'node:assert/strict'
import test from 'node:test'

import { plannedCaptionsOverKeptFrames, planCaptionPlacement } from '../../src/v2/application/plan-caption-placement.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { faceWindowTimeMap, planRequiredFaceWindows } from '../../src/v2/domain/face-evidence-time-map.ts'
import { subtitleAnchorDecisionFor } from '../../src/v2/domain/subtitle-anchor-plan.ts'
import { expectation, sealedWindow } from './helpers/face-envelope-v2.mjs'

/**
 * W65: the caption planner reads the sealed face windows of the Version being rendered and decides the cues on the
 * variant's canvas. Everything it cannot establish is unknown - and an unknown cue is not drawn.
 */
const SCOPE = Object.freeze({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1' })
const SOURCE = 'source-1'
const clip = { id: 'clip-1', sourceArtifactId: SOURCE, sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }
const editPlan = Object.freeze({ fps: 30, durationFrames: 300, videoTracks: [{ kind: 'base-video', clips: [clip] }] })
const portraitSource = Object.freeze({ artifactId: SOURCE, sha256: 'b'.repeat(64), mediaType: 'video', probe: Object.freeze({ width: 720, height: 1280 }) })
const CUE = Object.freeze({ id: 'cue-1', startFrame: 100, endFrame: 130 })
const FAR = [0.9, 0.0, 0.0, 0.03, 0.05]
const clean = () => sealedWindow({ start: 0, end: 300, rowsAt: () => [FAR] })
const reader = (envelopes, requests = []) => ({
  async listWindows(input) { requests.push(input); return envelopes.map((envelope) => ({ envelope })) },
})
const input = (extra = {}) => ({
  ...SCOPE, format: '9:16', canvas: { width: 540, height: 960 }, editPlan, clips: [clip], renderSources: [portraitSource],
  subtitleCues: [CUE], subtitlePresetId: 'kinetic', placementElements: [], primarySourceArtifactId: SOURCE, faceEvidenceAllowed: true, ...extra,
})
const deps = (faceEvidence) => ({ clock: () => new Date('2026-10-18T12:00:00.000Z'), ...(faceEvidence ? { faceEvidence } : {}) })
const decisionOf = (result) => subtitleAnchorDecisionFor(result.placementPlan.subtitleAnchorPlan, 'cue-1')

test('the Version\'s sealed windows are read scoped to workspace, project, Version and source, and a clean stream places the cue', async () => {
  const requests = []
  const result = await planCaptionPlacement(deps(reader([clean()], requests)), input())
  assert.equal(requests.length, 1)
  assert.deepEqual({ ...requests[0], now: undefined }, { ...SCOPE, sourceArtifactId: SOURCE, fromTimelineFrame: 85, toTimelineFrame: 145, now: undefined, limit: 200 })
  assert.equal(result.placementPlan.schemaVersion, 'render-placement-plan/v3')
  const decision = decisionOf(result)
  assert.equal(decision.disposition, 'placed'); assert.equal(decision.anchor, 'bottom')
  assert.equal(result.placementPlan.subtitleAnchorPlan.faceClearance.streams.length, 1)
  assert.equal(result.projection.projectionHash, result.placementPlan.subtitleAnchorPlan.faceClearance.projectionHash)
  assert.deepEqual(result.requiredFaceWindows, [{ sourceArtifactId: SOURCE, windows: [{ startTimelineFrame: 85, endTimelineFrame: 145 }] }])
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

test('evidence is not read for a renderable snapshot, a fractional frame rate or a timeline that is not one real-time clip', async () => {
  const requests = []
  const live = reader([clean()], requests)
  const snapshot = await planCaptionPlacement(deps(live), input({ faceEvidenceAllowed: false }))
  assert.equal(decisionOf(snapshot).disposition, 'review-required'); assert.equal(requests.length, 0)
  const fractional = await planCaptionPlacement(deps(live), input({ editPlan: { ...editPlan, fps: 29.97 } }))
  assert.equal(decisionOf(fractional).disposition, 'review-required'); assert.equal(requests.length, 0)
  const second = { ...clip, id: 'clip-2', sourceInFrame: 300, sourceOutFrame: 400, timelineInFrame: 300, timelineOutFrame: 400 }
  const multi = await planCaptionPlacement(deps(live), input({
    editPlan: { ...editPlan, durationFrames: 400, videoTracks: [{ kind: 'base-video', clips: [clip, second] }] }, clips: [clip, second],
  }))
  assert.equal(decisionOf(multi).disposition, 'review-required'); assert.equal(requests.length, 0)
  assert.deepEqual(multi.requiredFaceWindows, [], 'a timeline with no producible window lists none')
})

test('evidence of another Version, another source file or another timeline is untrusted: the cue is not drawn', async () => {
  for (const overrides of [{ projectVersionId: 'version-elsewhere' }, { sourceSha256: 'f'.repeat(64) },
    { timeMap: [{ clipId: 'clip-9', sourceInFrame: 0, sourceOutFrame: 300, timelineInFrame: 0, timelineOutFrame: 300, rate: 1 }] }]) {
    const result = await planCaptionPlacement(deps(reader([sealedWindow({ start: 0, end: 300, rowsAt: () => [FAR], overrides })])), input())
    const decision = decisionOf(result)
    assert.equal(decision.disposition, 'review-required', JSON.stringify(overrides))
    assert.equal(decision.anchor, null)
    assert.ok(result.placementPlan.subtitleAnchorPlan.faceClearance.streams[0].untrusted.length >= 1, JSON.stringify(overrides))
  }
})

test('the clip map and the expected time-map hash are the ones the W62 producers seal', () => {
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

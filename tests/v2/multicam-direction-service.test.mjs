import assert from 'node:assert/strict'
import test from 'node:test'

import { planFrameRate } from '../../src/v2/application/multicam-direction.ts'
import { buildDirectableMulticamWorld, fixtureSeconds as sec } from './wave20-fixtures.mjs'
import {
  actor,
  baseDirectedPlan,
  CLIENT,
  PROJECT,
  request,
  SESSION,
  WORKSPACE,
  wire,
} from './helpers/multicam-direction-wiring.mjs'

/**
 * T-F4.012 — the direction COMMAND, against services rather than the domain.
 *
 * The domain suite (`multicam-direction.test.mjs`) proves what a direction
 * decides. Nothing here re-proves that. What is under test is the seam: that a
 * caller hands over ids, a fence and labelled attestations and gets back a
 * persisted direction, a compiled multi-source `DirectedEditPlan` and a project
 * version — and that everything else it might try to hand over is refused.
 *
 * The wiring lives in `helpers/multicam-direction-wiring.mjs` so the
 * falsification suite drives the same command through the same doubles.
 */

/**
 * The evidence hash the default world produces, pinned on purpose.
 *
 * The set is content-addressed, so this is the one assertion that catches a
 * change to WHAT was read rather than to how it was reported. It moves only
 * when a fixture or a derivation rule deliberately moves, and then it moves in
 * the same commit as the reason.
 */
const PINNED_EVIDENCE_HASH = '1cb6ca9bc6da3ac801f2c61976ff66f6f992a0cd5ccbf1f8d999461d4b3299f4'

test('T-F4.012 the command derives evidence, direction, plan and version from ids and a fence alone', async () => {
  const wired = wire()
  const result = await wired.execute(request())

  // Nothing in the request said which angle, how confident, or what was
  // measured. All of it came back derived.
  assert.equal(result.replayed, false)
  assert.equal(result.direction.sessionId, SESSION)
  assert.equal(result.directionVersion, 1)
  assert.ok(result.direction.shots.length >= 2, 'the session was cut into more than one shot')
  assert.equal(result.direction.uncovered.length, 0, 'every directed instant had an eligible angle')

  const clips = result.editPlan.videoTracks[0].clips
  assert.equal(result.editPlan.videoTracks.length, 1)
  assert.equal(result.editPlan.videoTracks[0].kind, 'base-video')
  assert.equal(clips.length, result.direction.shots.length, 'one shot became exactly one clip')
  assert.equal(result.editPlan.transitions.length, clips.length - 1)
  assert.ok(result.editPlan.transitions.every((transition) => transition.type === 'straight-cut'))
  assert.equal(clips[0].timelineInFrame, 0)
  assert.equal(clips.at(-1).timelineOutFrame, result.editPlan.durationFrames)

  // The plan is genuinely multi-source: more than one camera file, and every
  // clip carries the camera key a ColorPlan override will target.
  const cameras = new Set(clips.map((clip) => clip.sourceArtifactId))
  assert.ok(cameras.size >= 2, `the plan cuts ${cameras.size} camera files`)
  assert.ok(clips.every((clip) => typeof clip.cameraId === 'string' && clip.cameraId.length > 0))
  assert.ok(clips.every((clip) => clip.audioSourceArtifactId === 'asset-master'), 'every shot lies on the master audio bed')
  assert.deepEqual(
    [...new Set(result.editPlan.sources.map((source) => source.artifactId))].sort(),
    [...cameras].sort(),
    'sources[] is the superset of the picture files the clips name',
  )

  const summary = result.editPlan.director.decisions.find((decision) => decision.category === 'angle')
  assert.ok(summary, 'the run records an angle decision')
  assert.equal(summary.decisionType, 'cut')
  assert.ok(summary.evidenceRefs.some((ref) => ref.startsWith('multicam-direction:')))
  assert.ok(result.editPlan.director.decisions.some((decision) => decision.id.startsWith('decision-angle-shot-')))
  assert.equal(result.editPlan.director.plannerVersion, 'multicam-direction-planner/2026-09-v1')

  assert.equal(result.command.type, 'direct-multicam-session')
  assert.equal(result.command.payload.directionHash, result.direction.directionHash)
  assert.equal(result.command.payload.manualReviewRequired, result.direction.manualReviewRequired)
  assert.equal(result.version.sequence, 5)
  console.log(`direct shots=${result.direction.shots.length} clips=${clips.length} sources=${result.editPlan.sources.length} frames=${result.editPlan.durationFrames}`)
})

test('T-F4.012 a stale base version is refused before anything is derived', async () => {
  const wired = wire()
  await assert.rejects(
    () => wired.execute(request({ baseHash: 'b'.repeat(64) })),
    (error) => error.code === 'VERSION_CONFLICT'
      && error.details.currentVersionId === 'project-version-1'
      && error.details.currentBaseHash === 'a'.repeat(64),
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'a stale fence writes no direction')
  assert.equal(wired.commands.calls.commitOrReplay, 0)
})

test('T-F4.012 a replay returns the first plan and does no new work', async () => {
  const wired = wire()
  const first = await wired.execute(request())
  const appendsAfterFirst = wired.directions.calls.appendVersion
  const commitsAfterFirst = wired.commands.calls.commitOrReplay

  const second = await wired.execute(request())
  assert.equal(second.replayed, true)
  assert.equal(second.command.id, first.command.id)
  assert.equal(second.version.id, first.version.id)
  assert.equal(second.editPlan.audioTimelineHash, first.editPlan.audioTimelineHash)
  assert.equal(second.direction.directionHash, first.direction.directionHash)
  assert.equal(second.compilation, null, 'a replay recompiles nothing')
  assert.equal(wired.directions.calls.appendVersion, appendsAfterFirst, 'the retry appended no second direction')
  assert.equal(wired.commands.calls.commitOrReplay, commitsAfterFirst, 'the retry committed nothing')

  await assert.rejects(
    () => wired.execute(request({ format: { aspectRatio: '9:16' } })),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('T-F4.012 the caller may not declare a score, an eligibility, a measurement or an approval', async () => {
  const wired = wire()
  const cases = [
    [{ confidence: 0.99 }, 'confidence'],
    [{ shots: [] }, 'shots'],
    [{ manualReviewRequired: false }, 'manualReviewRequired'],
    [{ directionHash: 'c'.repeat(64) }, 'directionHash'],
    [{ protectedSelections: [{ selectionId: 'sel-1', trackId: 'track-camera-a', sessionStartTicks: '0', sessionEndTicks: '90000', note: 'keep', score: 1 }] }, 'protectedSelections[0].score'],
  ]
  for (const [extra, field] of cases) {
    await assert.rejects(
      () => wired.execute(request(extra)),
      (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === field,
      `${field} must be refused by name`,
    )
  }
  // The calibration is not an operator preference either.
  await assert.rejects(
    () => wired.execute(request({ policy: { weights: { speaker: 9 } } })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === 'policy.weights',
  )
  // An accepted key still goes through the domain's own bounds: a minimum shot
  // longer than the jump-cut cover is refused there, not here.
  await assert.rejects(
    () => wired.execute(request({ policy: { minimumShotMs: 2_400 } })),
    (error) => error.code === 'INVALID_ARGUMENT' && /jumpCutSameAngleMs/.test(error.message),
  )
  // …while a coherent editorial preference is accepted and changes the cut.
  const longer = await wired.execute(request({ policy: { minimumShotMs: 1_800 }, idempotency: { clientId: CLIENT, key: 'idem-policy' } }))
  assert.ok(longer.editPlan.director.decisions.length >= 4)
  assert.equal(wired.directions.calls.appendVersion, 1)
})

test('T-F4.012 a protected selection is attested by the actor, with the caller only supplying the note', async () => {
  const wired = wire()
  const result = await wired.execute(request({
    protectedSelections: [{
      selectionId: 'selection-1',
      trackId: 'track-camera-b',
      sessionStartTicks: sec(30).toString(),
      sessionEndTicks: sec(60).toString(),
      note: 'the guest holds up the prototype here',
    }],
  }))
  const held = result.direction.shots.find((shot) => shot.rule === 'protected-selection')
  assert.ok(held, 'the protected range was honoured as its own shot')
  assert.equal(held.chosen.trackId, 'track-camera-b')
  assert.ok(held.reason.includes(`${CLIENT}/member-director`), 'the shot records who attested it, not only what they said')
  assert.ok(held.reason.includes('the guest holds up the prototype here'), 'and the note they gave')
})

test('T-F4.012 a session with no sync diagnostic cannot be auto-directed', async () => {
  const wired = wire({ noDiagnostic: true })
  await assert.rejects(
    () => wired.execute(request()),
    (error) => error.code === 'SYNC_DIAGNOSTIC_NOT_FOUND',
  )
  assert.equal(wired.directions.calls.appendVersion, 0)
})

test('T-F4.012 an unmeasured dimension produces no observation, and a decode with no frames produces nothing at all', async () => {
  const wired = wire()
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })

  const kinds = new Set(evidence.set.observations.map((observation) => observation.kind))
  assert.ok(kinds.has('active-speaker'), 'the diarization runs became speech observations')
  assert.ok(kinds.has('screen-activity'), 'the screen measured activity')
  assert.ok(kinds.has('technical-quality'))

  // Camera B's decode produced no frames: no quality observation, and the
  // reason is reported rather than swallowed.
  assert.equal(
    evidence.set.observations.some((observation) => observation.trackId === 'track-camera-b' && observation.kind === 'technical-quality'),
    false,
    'a decode with no frames is not a quality of zero',
  )
  assert.ok(
    evidence.skipped.some((entry) => entry.reason === 'the decode produced no frames'),
    'and it says so',
  )
  // Sharpness was never measured by this pass, so it is null on every quality
  // observation rather than a number nobody produced.
  const quality = evidence.set.observations.filter((observation) => observation.kind === 'technical-quality')
  assert.ok(quality.length > 0)
  assert.ok(quality.every((observation) => observation.value.sharpnessBps === null))
  assert.ok(quality.every((observation) => observation.value.stabilityBps !== null))

  // Only the screen carries activity; the cameras reported null and produced no
  // screen-activity observation each.
  const activity = evidence.set.observations.filter((observation) => observation.kind === 'screen-activity')
  assert.ok(activity.length > 0)
  assert.ok(activity.every((observation) => observation.trackId === 'track-screen'))

  // Every observation says where it came from, and every materialized file was
  // handed back.
  assert.ok(evidence.set.observations.every((observation) => observation.provenance.evidenceRef.length > 0))
  assert.deepEqual([...wired.media.released].sort(), ['asset-cam-a', 'asset-cam-b', 'asset-screen'])

  const replay = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  assert.equal(replay.replayed, true, 'the same observations for the same session version are one set')
  assert.equal(replay.set.evidenceHash, evidence.set.evidenceHash)
  console.log(`evidence observations=${evidence.set.observations.length} skipped=${evidence.skipped.length} hash=${evidence.set.evidenceHash.slice(0, 12)}`)
})

test('T-F4.012 a compiled clip whose recording the project does not link is refused before it reaches a renderer', async () => {
  const wired = wire({
    commands: {
      mediaLinks: [
        { artifactId: 'asset-cam-a', role: 'source-master', status: 'available', mediaType: 'video', frameRate: null },
        { artifactId: 'asset-master', role: 'selected-insert', status: 'quarantined', mediaType: 'audio', frameRate: null },
      ],
    },
  })
  await assert.rejects(
    () => wired.execute(request()),
    (error) => error.code === 'MEDIA_ARTIFACT_SOURCE_NOT_FOUND' && error.details.artifactIds.includes('asset-master'),
  )
  // The direction itself is stored: the refusal is about the project's media
  // links, and deleting the evidence would answer "no" without saying why.
  assert.equal(wired.directions.calls.appendVersion, 1)
})

test('T-F4.012 an NTSC plan rate survives the trip through the plan float', () => {
  assert.deepEqual(planFrameRate(30000 / 1001), { num: 30000n, den: 1001n })
  assert.deepEqual(planFrameRate(24000 / 1001), { num: 24000n, den: 1001n })
  assert.deepEqual(planFrameRate(30), { num: 30n, den: 1n })
  assert.deepEqual(planFrameRate(29.97), { num: 30000n, den: 1001n })
  assert.throws(() => planFrameRate(0), (error) => error.code === 'INVALID_RENDER_INPUT')
})

test('T-F4.012 the range a caller names is a position the direction is cut to', async () => {
  const wired = wire()
  const named = await wired.execute(request({
    range: { sessionStartTicks: sec(10).toString(), sessionEndTicks: sec(120).toString() },
  }))
  assert.equal(named.direction.range.start, sec(10))
  assert.equal(named.direction.range.end, sec(120))
  // Every shot lies inside it, which is the thing a caller is actually buying
  // by naming one. (The third assertion here used to restate the two above it
  // in different words, and the title promised an omitted-range case that the
  // body never ran; that case is now its own test.)
  assert.ok(named.direction.shots.length > 0)
  assert.ok(named.direction.shots.every((shot) => shot.sessionRange.start >= sec(10) && shot.sessionRange.end <= sec(120)))
  assert.equal(named.direction.shots[0].sessionRange.start, sec(10), 'and the first one starts exactly where the caller said')
})

test('T-F4.012 the plan drops what described the timeline it replaced, and says so', async () => {
  const wired = wire()
  const result = await wired.execute(request())
  // Exclusions and retained ranges named source seconds of the single recording
  // the old timeline was trimmed from; this one is cut from several cameras, so
  // carrying them would be a description of a timeline that no longer exists.
  assert.deepEqual([...result.editPlan.editorial.retainedSourceRanges], [])
  assert.deepEqual([...result.editPlan.editorial.exclusions], [])
  // The whole plan goes in the message rather than just the field: this
  // assertion failed once, unreproduced in twelve subsequent runs, and if it
  // ever fails again the next reader needs to see WHICH object came back.
  assert.deepEqual(
    [...result.editPlan.subtitleTracks],
    [],
    `subtitleTracks survived the re-cut; plan was ${JSON.stringify(result.editPlan, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))}`,
  )
  assert.deepEqual([...result.editPlan.retimedTranscript.words], [])
  assert.deepEqual([...result.editPlan.markers], [], 'the editorial-cut markers named source seconds of a recording this cut no longer follows')
  assert.equal(result.editPlan.retimedTranscript.sourceTranscriptId, 'transcript-base', 'the transcript it came from is still named')
  for (const fragment of ['Subtitle cues', 'retimed transcript', 'editorial exclusions', 'editorial-cut markers']) {
    assert.ok(
      result.editPlan.director.assumptions.some((assumption) => assumption.includes(fragment)),
      `the plan states out loud that it dropped ${fragment}`,
    )
  }
  // Every Director decision id satisfies the validator's grammar, which is
  // narrower than the session-id grammar it is derived from.
  assert.ok(result.editPlan.director.decisions.every((decision) => /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(decision.id)))
})

test('T-F4.012 a threshold that decides eligibility is calibration, not an editorial preference', async () => {
  const wired = wire()
  // `qualityFloorBps` is the exact number `deriveCandidate` compares a measured
  // quality against before stamping `quality-below-floor`, so a request that
  // moved it moved which cameras were ELIGIBLE — caller-supplied eligibility
  // through a field that merely looked like a preference. Measured before the
  // fix, on this fixture: at the default 3000 camera B had 1 candidate and 0
  // eligible; at 0 it had 2 candidates, 2 eligible, and one more shot was cut
  // to it. The refusal names the field so an operator can remove it.
  for (const field of ['qualityFloorBps', 'reactionIntensityFloorBps']) {
    await assert.rejects(
      () => wired.execute(request({ policy: { [field]: 0 }, idempotency: { clientId: CLIENT, key: `idem-${field}` } })),
      (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === `policy.${field}`,
      `policy.${field} must be refused by name`,
    )
  }
  assert.equal(wired.directions.calls.appendVersion, 0, 'nothing was derived, so nothing was stored')
  assert.equal(wired.commands.calls.readContext, 0, 'and the project was never even read')
})

test('T-F4.012 an unknown key on a protected selection is refused rather than accepted and dropped', async () => {
  const wired = wire()
  const selection = {
    selectionId: 'selection-1',
    trackId: 'track-camera-b',
    sessionStartTicks: sec(30).toString(),
    sessionEndTicks: sec(60).toString(),
    note: 'the guest holds up the prototype here',
  }
  // `attestedBy` is the one a caller reaches for, and it is the identity of the
  // authenticated actor: accepting and dropping it would teach the next caller
  // that they get to say whose name sits on a human override.
  await assert.rejects(
    () => wired.execute(request({ protectedSelections: [{ ...selection, attestedBy: 'somebody-else' }] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === 'protectedSelections[0].attestedBy',
  )
  await assert.rejects(
    () => wired.execute(request({ protectedSelections: [{ ...selection, sessionStartTick: '0' }] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION'
      && error.details.field === 'protectedSelections[0].sessionStartTick',
    'even a typo is named, instead of silently going nowhere',
  )
  assert.equal(wired.directions.calls.appendVersion, 0)
})

test('T-F4.012 the command is refused when the actor lacks the scope, the workspace or the client', async () => {
  const wired = wire()
  // No scope at all: this command appends a project version, writes an
  // EditCommand and emits a public event, and this is the only authorization on
  // that path.
  const unscoped = actor()
  await assert.rejects(
    () => wired.execute(request({ actor: { ...unscoped, scopes: new Set(['projects:read']) } })),
    (error) => error.code === 'AUTH_SCOPE_REQUIRED' && error.details.requiredScope === 'projects:write',
  )
  // A credential authenticated against another workspace cannot direct this
  // one, however well formed the ids in the body are.
  await assert.rejects(
    () => wired.execute(request({ actor: actor({ workspaceId: 'workspace-somebody-else' }) })),
    (error) => error.code === 'AUTH_INVALID' && /workspace or idempotency client/.test(error.message),
  )
  // And the idempotency client has to be the authenticated one, or a retry
  // would be keyed to somebody who never made the request.
  await assert.rejects(
    () => wired.execute(request({ idempotency: { clientId: 'client-someone-else', key: 'idem-direction-1' } })),
    (error) => error.code === 'AUTH_INVALID',
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'an unauthorized request derives nothing')
  assert.equal(wired.commands.calls.commitOrReplay, 0)
  assert.equal(wired.commands.calls.readContext, 0, 'and never reaches the project')
})

test('T-F4.012 every transition sits on the seam it names, and the call to action moves to the new end', async () => {
  const wired = wire()
  const result = await wired.execute(request())
  const clips = result.editPlan.videoTracks[0].clips
  const byId = new Map(clips.map((clip) => [clip.id, clip]))
  assert.ok(result.editPlan.transitions.length > 0)
  for (const transition of result.editPlan.transitions) {
    const from = byId.get(transition.fromClipId)
    const to = byId.get(transition.toClipId)
    assert.ok(from && to, `${transition.id} names two clips of this plan`)
    // The renderer places the audio fade by this number
    // (`ffmpeg-editorial-proxy-renderer.ts:422-425`), so a transition that sat
    // anywhere but on its own seam would fade at the wrong instant — and the
    // plan validator only COUNTS transitions (`director-run.ts:371`).
    assert.equal(from.timelineOutFrame, transition.atFrame, `${transition.id} starts where ${from.id} ends`)
    assert.equal(to.timelineInFrame, transition.atFrame, `${transition.id} ends where ${to.id} begins`)
  }

  // The CTA keeps its length and is re-anchored to the end of the timeline this
  // direction produced. Keeping the base plan's frame numbers would leave a
  // 90-frame call to action at 27 s of a 279 s cut.
  const base = baseDirectedPlan({ versionId: 'project-version-1' }).overlayTracks[0]
  const overlay = result.editPlan.overlayTracks[0]
  assert.equal(overlay.endFrame, result.editPlan.durationFrames, 'the CTA ends with the timeline')
  assert.equal(
    overlay.endFrame - overlay.startFrame,
    base.endFrame - base.startFrame,
    'and keeps exactly the length it had',
  )
  assert.notEqual(overlay.startFrame, base.startFrame, 'which is a different frame index on a different timeline')
})

test('T-F4.012 omitting the range directs the reference hull, uncovered stretches and all', async () => {
  // The recorder runs to 300 s and the three cameras stop at 200 s, which is the
  // case the request type documents: the hull a request without `range` directs
  // includes instants no camera covered, the direction reports them as
  // `uncovered` with a warning, and the compile step then refuses to turn that
  // into clips.
  const wired = wire({
    world: buildDirectableMulticamWorld({
      workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT, endSecond: 300, cameraEndSecond: 200,
    }),
  })
  await assert.rejects(
    () => wired.execute(request({ range: undefined })),
    (error) => error.code === 'DIRECTION_RANGE_UNRESOLVABLE'
      && Array.isArray(error.details.uncovered)
      && error.details.uncovered.length > 0,
    'the refusal names the stretches that had no eligible angle',
  )
  // The direction itself is stored BEFORE the compile step, because it is the
  // artifact that says WHY the answer was no.
  assert.equal(wired.directions.calls.appendVersion, 1)
  const stored = await wired.directions.readHead({ workspaceId: WORKSPACE, sessionId: SESSION })
  assert.ok(stored.direction.uncovered.length > 0)
  assert.equal(stored.direction.manualReviewRequired, true)
  assert.ok(stored.direction.warnings.length > 0)

  // Naming the range is how an operator says "cut the part we actually filmed",
  // and then the same world compiles.
  const named = await wired.execute(request({
    range: { sessionStartTicks: sec(1).toString(), sessionEndTicks: sec(150).toString() },
    idempotency: { clientId: CLIENT, key: 'idem-named-range' },
  }))
  assert.equal(named.direction.uncovered.length, 0)
  assert.equal(named.direction.range.start, sec(1))
  assert.equal(named.direction.range.end, sec(150))
  console.log(`omitted range uncovered=${stored.direction.uncovered.length} named shots=${named.direction.shots.length}`)
})

test('T-F4.012 a recorder restart puts the second file on the timeline, and the clock map places it', async () => {
  // Camera B starts twelve seconds into the session and the microphone stopped
  // and came back as a second file. Both are what make the clock map
  // load-bearing: linearise `resolveSourceTick` away and camera B's evidence
  // lands twelve seconds early, while the second microphone file is a recording
  // the producer never even asks about unless it walks parts.
  const world = buildDirectableMulticamWorld({
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    projectId: PROJECT,
    endSecond: 300,
    cameraBOffsetSeconds: 12,
    restart: { trackId: 'track-mic-a', assetId: 'asset-mic-a-2', stopSecond: 100, resumeSecond: 130 },
  })
  const asked = []
  const diarization = {
    async listLatestRunsForArtifacts({ sourceArtifactIds }) {
      asked.push(...sourceArtifactIds)
      return [
        {
          runId: 'diarization-mic-a-1', sourceArtifactId: 'asset-mic-a', provider: 'fixture',
          producedAt: '2029-04-01T09:02:00.000Z',
          segments: [
            { segmentId: 'seg-1', ordinal: 0, speakerKey: 'cluster-1', startMs: 1_000, endMs: 60_000 },
            // Runs past the end of the first FILE, which stopped at 100 s: it
            // describes an instant the recorder never produced.
            { segmentId: 'seg-straddle', ordinal: 1, speakerKey: 'cluster-1', startMs: 95_000, endMs: 140_000 },
          ],
        },
        {
          runId: 'diarization-mic-a-2', sourceArtifactId: 'asset-mic-a-2', provider: 'fixture',
          producedAt: '2029-04-01T09:02:00.000Z',
          segments: [{ segmentId: 'seg-2', ordinal: 0, speakerKey: 'cluster-1', startMs: 0, endMs: 40_000 }],
        },
      ].filter((run) => sourceArtifactIds.includes(run.sourceArtifactId))
    },
  }
  // Every camera decodes here, camera B included: the default fake gives camera
  // B no frames, and a track with no observation cannot show where its map put
  // it.
  const visual = {
    async measure({ windows }) {
      return windows.map((window) => ({
        trackId: window.trackId,
        partId: window.partId,
        sourceArtifactId: window.sourceArtifactId,
        sourceStartMs: window.sourceStartMs,
        sourceEndMs: window.sourceEndMs,
        sampledFrameCount: 30,
        activityBps: window.trackId === 'track-screen' ? 103 : null,
        sharpnessBps: null,
        stabilityBps: 9_100,
        exposureBps: 8_800,
        method: 'fixture/signalstats',
        evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}`,
      }))
    },
  }
  const wired = wire({ world, diarization, visual })
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })

  assert.ok(asked.includes('asset-mic-a-2'), 'the second file of the restarted track was asked about at all')
  assert.ok(asked.includes('asset-mic-a'), 'and so was the first')
  const fromSecondFile = evidence.set.observations.filter((observation) => observation.provenance.evidenceRef.includes('diarization-mic-a-2'))
  assert.ok(fromSecondFile.length > 0, "the second file's speech became observations rather than being dropped as unknown")
  assert.ok(
    fromSecondFile.every((observation) => observation.trackId === 'track-mic-a'),
    'on the track that carries it, which is the track its first file identifies',
  )
  // Its milliseconds are relative to ITS file, so 0 ms of the second file is
  // 130 s of the session, not 0 s.
  assert.equal(fromSecondFile[0].range.start, sec(130), 'placed through the part it belongs to, not through the first part')

  // The straddling segment is refused and SAID so: stretching it across the
  // recorder gap would assert speech in a stretch nothing recorded.
  assert.ok(
    evidence.skipped.some((entry) => entry.source.includes('seg-straddle')
      && entry.reason === 'the segment does not map onto one piece of the session clock'),
    'the segment that ran past the end of its file is reported, not stretched',
  )

  // Camera B's map is anchored twelve seconds in, and the map — not a linear
  // conversion — is what places its evidence.
  const cameraB = evidence.set.observations.filter((observation) => observation.trackId === 'track-camera-b')
  assert.ok(cameraB.length > 0, 'camera B was measured')
  assert.equal(
    cameraB[0].range.start,
    sec(12),
    "camera B's first window sits where its clock map puts it, not where its file starts",
  )
  console.log(`restart asked=${new Set(asked).size} secondFile=${fromSecondFile.length} cameraBStart=${cameraB[0].range.start} skipped=${evidence.skipped.length}`)
})

test('T-F4.012 the derived evidence set is pinned: a silent change to what was read changes the hash', async () => {
  const wired = wire()
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  // Content-addressed and therefore assertable. Both counts and the hash are
  // pinned because the whole set is derived, and a change that adds or removes
  // observations without a test failing is a change nobody reviewed —
  // linearising the clock map away, for one, silently added three.
  assert.equal(evidence.set.observations.length, 15, 'the exact observations this world produces')
  assert.equal(evidence.skipped.length, 7, 'and the exact number of reads that produced none')
  assert.equal(evidence.set.evidenceHash, PINNED_EVIDENCE_HASH)
  assert.ok(
    evidence.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0),
    'every one of them says why',
  )
})

test('T-F4.012 persisted perception becomes reaction evidence, and a project with none gets no zeros', async () => {
  const timeline = {
    sourceArtifactId: 'asset-cam-b',
    timelineId: 'perception-timeline-1',
    producedAt: '2029-04-01T09:03:00.000Z',
    method: 'fixture/perception',
    entries: [
      { entryId: 'entry-1', startMs: 10_000, endMs: 40_000, intensityBps: 7_200, confidence: 0.8 },
      { entryId: 'entry-2', startMs: 40_000, endMs: 70_000, intensityBps: 1_100, confidence: 0.8 },
    ],
  }
  const withPerception = wire({
    perception: {
      async listReactionIntensities({ sourceArtifactIds }) {
        return sourceArtifactIds.includes(timeline.sourceArtifactId) ? [timeline] : []
      },
    },
  })
  const seen = await withPerception.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  const reactions = seen.set.observations.filter((observation) => observation.kind === 'reaction')
  assert.equal(reactions.length, 2, "both entries became observations — the floor is the direction's business, not the producer's")
  assert.ok(reactions.every((observation) => observation.trackId === 'track-camera-b'))
  assert.deepEqual(reactions.map((observation) => observation.value.intensityBps).sort((left, right) => left - right), [1_100, 7_200])
  assert.ok(reactions.every((observation) => observation.provenance.method === 'fixture/perception'))

  // A project nobody has run perception over produces no reaction observations
  // at all, which is the truth. A stub returning intensity zero would instead
  // assert "measured, and there was no reaction".
  const without = wire()
  const none = await without.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  assert.equal(none.set.observations.filter((observation) => observation.kind === 'reaction').length, 0)
  assert.notEqual(seen.set.evidenceHash, none.set.evidenceHash)
})

test('T-F4.012 the sweep says what its ceiling and its short tail did not measure', async () => {
  // Two windows per 300 s part, then the ceiling. The direction reads an
  // unmeasured stretch as "nobody measured", and a sweep that truncated
  // silently would leave nothing anywhere saying a policy rather than the
  // footage caused it — in the one function whose result field is documented
  // "reported, never silently dropped".
  const wired = wire({ evidenceWindowMs: 60_000, maxVisualWindowsPerPart: 2 })
  const evidence = await wired.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  const ceilings = evidence.skipped.filter((entry) => entry.reason.includes('the sweep stopped at its ceiling'))
  assert.equal(ceilings.length, 3, 'one report per video part that was cut short')
  assert.ok(ceilings.every((entry) => /180000 ms of this part were not measured/.test(entry.reason)))
  assert.deepEqual(
    ceilings.map((entry) => entry.source).sort(),
    ['track-camera-a:part-track-camera-a', 'track-camera-b:part-track-camera-b', 'track-screen:part-track-screen'],
    'and it names the part, so an operator knows which recording is only partly read',
  )
  assert.equal(wired.visual.seen.length, 6, 'the ceiling really did stop the sweep at two windows per part')

  // A part whose tail is shorter than a measurable window says so too, rather
  // than ending the loop with nothing written down.
  const tail = wire({ evidenceWindowMs: 100_000 })
  const withTail = await tail.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  assert.equal(
    withTail.skipped.filter((entry) => entry.reason.includes('shorter than one measurable window')).length,
    0,
    'a part that divides evenly has no tail to report',
  )
  const uneven = wire({ evidenceWindowMs: 99_950 })
  const withUneven = await uneven.deriveEvidence({ workspaceId: WORKSPACE, projectId: PROJECT, sessionId: SESSION })
  const tails = withUneven.skipped.filter((entry) => entry.reason.includes('shorter than one measurable window'))
  assert.equal(tails.length, 3, 'a 300 s part swept in 99.95 s windows leaves 150 ms nobody can measure')
  assert.ok(tails.every((entry) => /the last 150 ms/.test(entry.reason)))
  console.log(`sweep ceilings=${ceilings.length} windows=${wired.visual.seen.length} tails=${tails.length}`)
})

test('T-F4.012 a capture session of another project cannot re-cut this project timeline', async () => {
  // `/v1/projects/{projectId}/capture-sessions/{sessionId}/direction` asserts a
  // containment the workspace-scoped session port cannot check. Without this
  // the EditPlan, the project version and the outbox event all came from the
  // project in the path while the shots came from somebody else's session —
  // one workspace, two projects, one silently re-cut timeline.
  const wired = wire({ sessionProjectId: 'project-somebody-else' })
  await assert.rejects(
    () => wired.execute(request()),
    (error) => {
      assert.equal(error.code, 'INVALID_ARGUMENT')
      assert.match(error.message, /belongs to another project/)
      return true
    },
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'a session of another project writes no direction')
  assert.equal(wired.commands.calls.commitOrReplay, 0, 'and commits no project version')

  // The same request against the session that does belong here still runs.
  const same = wire()
  assert.equal((await same.execute(request())).direction.sessionId, SESSION)
})

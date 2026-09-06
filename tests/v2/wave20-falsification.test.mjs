import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { captureSessionDerivationRef } from '../../src/v2/domain/capture-session.ts'
import { COLOR_TRANSFORM_ORDER, createColorPlan, resolveColorPlan } from '../../src/v2/domain/color-and-export.ts'
import {
  COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS,
  DEFAULT_COLOR_CRITIC_POLICY,
  DEFAULT_COLOR_CRITIC_THRESHOLDS,
  evaluateColorCritic,
} from '../../src/v2/domain/color-critic-report.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  assertMulticamDirectionIntegrity,
  calculateMulticamDirectionHash,
  compileShotsToSourceRanges,
  deriveAngleCandidates,
  directMulticam,
} from '../../src/v2/domain/multicam-direction.ts'
import { createMulticamEvidenceSet } from '../../src/v2/domain/multicam-evidence.ts'
import {
  evaluateMulticamLongformGate,
  MULTICAM_LONGFORM_CRITERIA,
  MULTICAM_LONGFORM_CRITERION_CHECKS,
} from '../../src/v2/domain/multicam-longform-gate.ts'
import { assertMatchStagePosition } from '../../src/v2/domain/multicam-match-plan.ts'
import { createPlaybackMap } from '../../src/v2/domain/playback-map.ts'
import { createTickInterval, rational } from '../../src/v2/domain/session-time.ts'
import { AUTO_EDIT_MINIMUM_CONFIDENCE_BPS, createTrackCoverage } from '../../src/v2/domain/track-coverage.ts'
import { resolveFfmpegBinary } from '../../src/v2/infrastructure/media/ffmpeg-binary.ts'
import {
  buildDirectionWorld,
  buildMeasurement,
  buildPlaybackWorld,
  fixtureInstant as at,
  fixtureSeconds as sec,
  fixtureSha as sha,
  fixtureTicks as tick,
} from './wave20-fixtures.mjs'
import { request, wire } from './helpers/multicam-direction-wiring.mjs'

/**
 * Wave 20 falsification — every protection, refusing and permitting.
 *
 * A test that only watches a guard refuse proves nothing about the guard: an
 * implementation that refuses everything passes it. So each case here states
 * both halves. The guarded input is refused, and an input identical in every
 * respect except the one fact the guard reads is accepted — which is what makes
 * the guard, rather than some accident of the fixture, the thing that decided.
 *
 * Where the protection is structural rather than a value — an ordering rule, a
 * call site that must exist — the structure is asserted instead. Nothing here
 * edits a source file at test time: a suite that rewrites the tree it is
 * testing leaves a working copy nobody can trust, and a failure halfway through
 * leaves the mutation behind.
 *
 * The nine protections are BRIEF-E2E §"testes de falsificação": the coverage
 * gate, the active speaker, match before the creative LUT, clipping against a
 * declared intent, the piecewise playback map, the two recordings' durations,
 * caller-supplied derivations, the hash on read, and the phase gate's evidence.
 */

const WORKSPACE = 'workspace-falsify'
const SESSION = 'session-falsify'
const PROJECT = 'project-falsify'
const HZ = 90_000
const seconds = (ticks) => Number(ticks) / HZ
const root = resolve(import.meta.dirname, '../..')

/** The same coverage the fixture derives, at a confidence this test chooses. */
function coverageAt(session, trackId, confidenceBps) {
  const track = session.tracks.find((entry) => entry.trackId === trackId)
  return createTrackCoverage({
    workspaceId: WORKSPACE,
    trackId,
    derivedFrom: captureSessionDerivationRef(session),
    timebase: track.timebase,
    claims: track.parts.map((piece) => ({
      partId: piece.partId,
      ordinal: piece.ordinal,
      timebase: piece.timebase,
      interval: piece.coverage,
      confidenceBps,
      evidence: { kind: 'packet-scan', ref: `probe-${piece.partId}` },
    })),
  })
}

function speaks(trackId, [fromSecond, toSecond]) {
  const observationId = `obs-active-speaker-${trackId}-${fromSecond}-${toSecond}`
  return {
    observationId,
    trackId,
    range: createTickInterval(sec(fromSecond), sec(toSecond)),
    kind: 'active-speaker',
    value: { kind: 'active-speaker', speakerKey: `cluster-${trackId}`, identityResolved: false },
    confidence: 0.9,
    provenance: {
      method: 'fixture/active-speaker',
      evaluatorKind: 'controlled',
      evidenceRef: `run:${observationId}`,
      producedAt: at(0),
    },
  }
}

/** Which angle the direction is on at a session instant, or null. */
function chosenAt(direction, atTick) {
  const shot = direction.shots.find((entry) => entry.sessionRange.start <= atTick && atTick < entry.sessionRange.end)
  return shot ? shot.chosen.trackId : null
}

function refusalOf(run) {
  try {
    run()
  } catch (error) {
    if (error instanceof DomainError) return error
    throw error
  }
  return null
}

const directionWorld = () => buildDirectionWorld({ workspaceId: WORKSPACE, sessionId: SESSION, projectId: PROJECT })

/** The fixture's own direction call, with whatever this test wants to vary. */
function direct(world, overrides = {}) {
  return directMulticam({
    session: world.session,
    coverages: world.coverages,
    clockMaps: world.clockMaps,
    diagnostic: world.diagnostic,
    protocolCeiling: null,
    evidence: world.evidence,
    format: { aspectRatio: '16:9' },
    range: createTickInterval(sec(1), sec(400)),
    generatedAt: at(140),
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// 1. The coverage gate
// ---------------------------------------------------------------------------

test('T-FR-150 falsification 1: without the coverage gate the same cameras would have been cut to', () => {
  const world = directionWorld()

  // The control: this call reproduces the fixture exactly, so a difference
  // below is the coverage and not a differently-built direction.
  assert.equal(direct(world).directionHash, world.direction.directionHash)

  const belowFloor = AUTO_EDIT_MINIMUM_CONFIDENCE_BPS - 1_000
  const doubted = world.coverages.map((coverage) => (
    coverage.trackId === 'track-master-audio'
      ? coverage
      : coverageAt(world.session, coverage.trackId, belowFloor)
  ))
  const refused = direct(world, { coverages: doubted })

  // Refused: the recorder's own claim is intact — same files, same intervals,
  // same clock maps, same speech — and every camera is out of the automatic
  // cut because the only thing that changed is the confidence the gate reads.
  assert.equal(refused.shots.length, 0, 'a camera nobody verified was still cut to')
  assert.deepEqual(
    refused.uncovered.map((entry) => [seconds(entry.start), seconds(entry.end)]), [[1, 400]],
    'the whole directed range should be uncovered when no angle is selectable',
  )
  assert.ok(refused.warnings.some((warning) => warning.code === 'no-eligible-candidate'))
  assert.equal(refused.manualReviewRequired, true)

  // Candidate by candidate, in one window both cameras are inside: the reason
  // each was refused is the coverage floor and nothing else.
  const candidatesWith = (coverages) => deriveAngleCandidates({
    session: world.session,
    coverages,
    clockMaps: world.clockMaps,
    diagnostic: world.diagnostic,
    protocolCeiling: null,
    evidence: world.evidence,
    window: createTickInterval(sec(60), sec(61)),
    previousShot: null,
  })
  const doubtedCandidates = candidatesWith(doubted).filter((candidate) => candidate.trackId.startsWith('track-camera'))
  assert.equal(doubtedCandidates.length, 2)
  for (const candidate of doubtedCandidates) {
    assert.equal(candidate.eligible, false, `${candidate.trackId} stayed eligible below the floor`)
    assert.deepEqual(
      [...candidate.rejectionReasons], ['coverage-below-floor'],
      `${candidate.trackId} was refused for something other than its coverage`,
    )
    assert.equal(candidate.coverage.confidenceBps, belowFloor)
  }
  for (const candidate of candidatesWith(world.coverages).filter((entry) => entry.trackId.startsWith('track-camera'))) {
    assert.equal(candidate.eligible, true, `${candidate.trackId} was refused with the coverage that was measured`)
    assert.deepEqual([...candidate.rejectionReasons], [])
  }

  // Accepted: the identical call with the measured confidence cuts the session.
  const accepted = direct(world)
  assert.ok(accepted.shots.length >= 2, 'the measured world must produce a cut, or the refusal proves nothing')
  assert.equal(chosenAt(accepted, sec(60)), 'track-camera-a')
  assert.equal(chosenAt(accepted, sec(200)), 'track-camera-b')
  assert.notEqual(accepted.directionHash, refused.directionHash)

  // And the gate is applied again where the shots become frames: a direction
  // derived when the coverage was trusted cannot be compiled once it is not.
  // Over a range both cameras cover, so what refuses the compile is the
  // coverage and not the fixture's uncovered tail.
  const inside = direct(world, { range: createTickInterval(sec(1), sec(280)) })
  assert.deepEqual([...inside.uncovered], [])
  const compiled = compileShotsToSourceRanges(inside, {
    session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: world.coverages,
  })
  assert.ok(compiled.clips.length >= 2)
  const atCompile = refusalOf(() => compileShotsToSourceRanges(inside, {
    session: world.session, clockMaps: world.clockMaps, planFps: rational(30, 1), coverages: doubted,
  }))
  assert.ok(atCompile, 'the compiler accepted shots whose coverage no longer holds')
  assert.equal(atCompile.code, 'DIRECTION_RANGE_UNRESOLVABLE')
  assert.equal(atCompile.details.cause, 'coverage-below-floor', 'the compile refused for some other reason')

  // Structural: the two call sites and the floor itself. Deleting either one
  // is the mutation this case exists for, and it is caught here rather than by
  // a test that rewrote the file.
  const source = readFileSync(join(root, 'src/v2/domain/multicam-direction.ts'), 'utf8')
  const callSites = source.match(/assertCoverageSelectable\(/g) ?? []
  assert.ok(callSites.length >= 3, `only ${callSites.length} coverage gate call sites remain`)
  assert.equal(AUTO_EDIT_MINIMUM_CONFIDENCE_BPS, 7_000)

  console.log(
    `falsification-1 coverage: ${accepted.shots.length} shots at ${9_800} bps, `
    + `${refused.shots.length} at ${belowFloor} bps; the compile of ${compiled.clips.length} clips refused with `
    + `${atCompile.code}/${atCompile.details.cause}`,
  )
})

// ---------------------------------------------------------------------------
// 2. The active speaker
// ---------------------------------------------------------------------------

test('T-FR-150 falsification 2: swapping who spoke swaps the angles, so the direction is reading the speech', () => {
  const world = directionWorld()
  const evidenceFrom = (observations) => createMulticamEvidenceSet({
    session: world.session, observations, generatedAt: at(130),
  })
  const spoken = [speaks('track-mic-a', [1, 120]), speaks('track-mic-b', [120, 250]), speaks('track-mic-a', [250, 300])]
  const swapped = [speaks('track-mic-b', [1, 120]), speaks('track-mic-a', [120, 250]), speaks('track-mic-b', [250, 300])]

  const original = direct(world, { evidence: evidenceFrom(spoken) })
  const mutated = direct(world, { evidence: evidenceFrom(swapped) })

  // The control: the rebuilt evidence is the fixture's own.
  assert.equal(original.directionHash, world.direction.directionHash)

  // Both cameras are eligible over [120 s, 250 s) — the window is inside both
  // recordings and after camera B's clock map opens — so the ONLY reason the
  // angle differs is which microphone carried the speech.
  assert.equal(chosenAt(original, sec(200)), 'track-camera-b')
  assert.equal(chosenAt(mutated, sec(200)), 'track-camera-a')
  assert.equal(chosenAt(original, sec(280)), 'track-camera-a')
  assert.equal(chosenAt(mutated, sec(280)), 'track-camera-b')
  assert.notEqual(original.directionHash, mutated.directionHash)

  // And it says so: the shot cites the observation it followed, and the rule
  // that decided it is the speaker rule rather than a hold.
  for (const shot of original.shots) {
    if (shot.rule !== 'speech-prefers-active-speaker') continue
    assert.ok(
      shot.evidenceRefs.some((ref) => ref.startsWith('observation:')),
      `${shot.shotId} followed the speaker and cited nothing`,
    )
  }
  const spokenRules = original.shots.filter((shot) => shot.rule === 'speech-prefers-active-speaker')
  assert.ok(spokenRules.length >= 2, 'the fixture must decide at least two shots by the speaker')

  console.log(
    `falsification-2 speaker: ${spokenRules.length} shots decided by speech; `
    + `at 200 s ${chosenAt(original, sec(200))} -> ${chosenAt(mutated, sec(200))} when the microphones swap`,
  )
})

// ---------------------------------------------------------------------------
// 3. Match before the creative LUT
// ---------------------------------------------------------------------------

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8,
})

function colorTransform(kind, id, parameters) {
  const sorted = Object.fromEntries(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right)))
  return {
    id,
    kind,
    version: 'v1',
    enabled: true,
    input: COLOR_METADATA,
    output: COLOR_METADATA,
    implementation: {
      provider: 'apollo-test', version: 'v1', parameters: sorted, parametersHash: calculateCanonicalHash(sorted),
    },
  }
}

test('T-FR-183 falsification 3: a match after the creative LUT is refused, and would otherwise be silently reordered', () => {
  const technical = colorTransform('technical', 'technical-1', { mode: 'identity' })
  const match = colorTransform('match', 'match-1', { brightness: 0.1, contrast: 1, saturation: 1 })
  const creative = {
    ...colorTransform('creative-lut', 'creative-1', { mode: 'look' }),
    lut: { artifactId: 'lut-warm-look', sha256: sha('f') },
  }
  const output = colorTransform('output', 'output-1', { mode: 'identity' })

  // Refused where the mistake was made, by name, naming what it came after.
  const refusal = refusalOf(() => assertMatchStagePosition([technical, creative, match, output]))
  assert.ok(refusal, 'a match applied after the creative LUT was accepted')
  assert.equal(refusal.code, 'COLOR_STAGE_VIOLATION')
  assert.equal(refusal.details.after, 'creative-lut')
  assert.equal(refusal.details.position, 2)

  // Accepted: the same four transforms in the order the pipeline declares.
  assert.equal(assertMatchStagePosition([technical, match, creative, output]), undefined)

  // Why the position check has to exist at all: the plan resolver keys layers
  // by stage, so the wrong order resolves to the right one and the mistake
  // leaves no trace downstream. Without this refusal the plan is accepted and
  // the render applies a pipeline the plan did not describe.
  const plan = {
    schemaVersion: 'color-plan/v1',
    metadata: COLOR_METADATA,
    outputMetadata: COLOR_METADATA,
    global: [technical, creative, match, output],
    sources: {},
    cameras: {},
    segments: {},
  }
  assert.equal(createColorPlan(plan).planHash.length, 64, 'the misordered layer was refused by the plan constructor')
  const resolved = resolveColorPlan(plan, {})
  assert.deepEqual(resolved.stages.map((stage) => stage.kind), [...COLOR_TRANSFORM_ORDER])

  // And that the order is not cosmetic, measured on pixels rather than argued.
  // Two stages that do not commute, applied both ways to one mid-grey frame by
  // the real ffmpeg this repository ships. This is not the match/LUT chain —
  // that chain is proved in `ffmpeg-color-pipeline.integration.mjs`; what is
  // measured here is that stage order changes the bytes at all, which is what
  // makes an accepted misordering a defect rather than a formality.
  const ffmpeg = resolveFfmpegBinary()
  const workRoot = mkdtempSync(join(tmpdir(), 'apollo-falsify-color-'))
  try {
    const sample = (filters) => {
      const out = join(workRoot, `${filters.replace(/[^a-z0-9]/gi, '')}.rgb`)
      execFileSync(ffmpeg, [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x808080:s=2x2:r=1:d=1',
        '-vf', `${filters},scale=1:1`,
        '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', out,
      ], { timeout: 60_000 })
      return [...readFileSync(out)]
    }
    const brightThenContrast = sample('eq=brightness=0.2,eq=contrast=2.0')
    const contrastThenBright = sample('eq=contrast=2.0,eq=brightness=0.2')
    assert.notDeepEqual(
      brightThenContrast, contrastThenBright,
      'two orders of the same two stages produced identical pixels, so nothing here measures order',
    )
    console.log(
      `falsification-3 stage order: refused ${refusal.code} after ${refusal.details.after}; `
      + `pixels rgb(${brightThenContrast.join(',')}) vs rgb(${contrastThenBright.join(',')})`,
    )
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Clipping against a declared creative intent
// ---------------------------------------------------------------------------

function criticReport({ declared, blacks, afterROverG }) {
  const stage = (suffix, artifactId, digest, extra) => [
    buildMeasurement({ measurementId: `falsify-${suffix}-a`, cameraId: 'camera-a', sourceAssetId: artifactId, sourceSha256: digest }),
    buildMeasurement({
      measurementId: `falsify-${suffix}-b`, cameraId: 'camera-b', sourceAssetId: artifactId, sourceSha256: digest, ...extra,
    }),
  ]
  return evaluateColorCritic({
    reportId: `falsify-critic-${declared ? 'declared' : 'undeclared'}`,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    projectVersionId: 'project-version-falsify',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before: stage('before', 'artifact-intermediate', sha('d'), { rOverG: 1, blacks: 0.001 }),
    after: stage('after', 'artifact-output', sha('e'), { rOverG: afterROverG, blacks }),
    creativeIntent: declared
      ? { declared: true, castAllowedDelta: 0.15, lutId: 'lut-warm-look' }
      : { declared: false },
    evaluatedAt: at(100),
  })
}

test('T-FR-184 falsification 4: a declared look excuses the cast it declared and never the crushed blacks', () => {
  const undeclared = criticReport({ declared: false, blacks: 0.09, afterROverG: 1.15 })
  const declaredIntent = criticReport({ declared: true, blacks: 0.09, afterROverG: 1.15 })

  const dimension = (report, name) => report.dimensions.find((entry) => entry.dimension === name)
  const issuesFor = (report, name) => report.issues.filter((entry) => entry.dimension === name)

  // The half that proves the declaration is honoured where it may be: the same
  // cast, measured identically, is a defect undeclared and documented intent
  // when it was declared and stayed inside its budget.
  const castUndeclared = dimension(undeclared, 'cast')
  const castDeclared = dimension(declaredIntent, 'cast')
  assert.equal(castUndeclared.status, 'measured')
  assert.equal(castDeclared.value, castUndeclared.value, 'the declaration changed the measurement itself')
  assert.ok(castUndeclared.value > DEFAULT_COLOR_CRITIC_THRESHOLDS.values.cast.hard)
  assert.ok(castUndeclared.value <= DEFAULT_COLOR_CRITIC_POLICY.maxDeclaredCastAllowance)
  assert.ok(issuesFor(undeclared, 'cast').length > 0, 'an undeclared cast past the hard threshold raised nothing')
  assert.deepEqual(issuesFor(declaredIntent, 'cast'), [], 'a declared cast inside its budget was still an issue')
  assert.equal(castDeclared.classification, 'documented-intent')

  // And the half the case exists for: the same declaration cannot buy the
  // crushed blacks. A clipped sample carries no value to restore, so the
  // verdict is the same with the intent as without it.
  for (const report of [undeclared, declaredIntent]) {
    const crushed = issuesFor(report, 'crushedBlacks')
    assert.ok(crushed.length > 0, 'crushed blacks disappeared')
    assert.equal(crushed[0].severity, 'hard')
    assert.equal(report.action, 'reject')
  }
  assert.ok(COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS.includes('crushedBlacks'))
  assert.ok(COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS.includes('clipping'))

  // A declaration wide enough to excuse anything is refused rather than obeyed.
  const overreach = refusalOf(() => criticReportWithAllowance(0.5))
  assert.ok(overreach, 'a caller could declare an allowance that decides the verdict')
  assert.equal(overreach.code, 'INVALID_ARGUMENT')
  assert.match(overreach.message, /castAllowedDelta/)

  console.log(
    `falsification-4 intent: cast ${castUndeclared.value} (hard ${DEFAULT_COLOR_CRITIC_THRESHOLDS.values.cast.hard}) `
    + `-> ${issuesFor(undeclared, 'cast').length} issue undeclared, ${issuesFor(declaredIntent, 'cast').length} declared; `
    + `crushed blacks stays hard in both and the action is ${declaredIntent.action}`,
  )
})

function criticReportWithAllowance(castAllowedDelta) {
  return evaluateColorCritic({
    reportId: 'falsify-critic-overreach',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    projectVersionId: 'project-version-falsify',
    subject: { kind: 'output', artifactId: 'artifact-output' },
    before: [buildMeasurement({ measurementId: 'falsify-over-before', cameraId: 'camera-a', sourceAssetId: 'artifact-intermediate', sourceSha256: sha('d') })],
    after: [buildMeasurement({ measurementId: 'falsify-over-after', cameraId: 'camera-a', sourceAssetId: 'artifact-output', sourceSha256: sha('e') })],
    creativeIntent: { declared: true, castAllowedDelta },
    evaluatedAt: at(100),
  })
}

// ---------------------------------------------------------------------------
// 5 and 6. The playback map: pauses, movements, and two different durations
// ---------------------------------------------------------------------------

const playbackWorld = () => buildPlaybackWorld({ workspaceId: WORKSPACE, sessionId: 'session-react-falsify', projectId: PROJECT })

/** The map's own pieces, as constructor input, with one of them changed. */
function piecesOf(map, mutate = (piece) => piece) {
  return map.pieces.map((piece) => mutate({
    pieceId: piece.pieceId,
    mode: piece.mode,
    reactionRange: piece.reactionRange,
    referenceRange: piece.referenceRange,
    rate: piece.rate,
    direction: piece.direction,
    confidence: piece.confidence,
    evidenceRefs: [...piece.evidenceRefs],
    detectionMethod: piece.detectionMethod,
    residualTicks: piece.residualTicks,
    discontinuityReason: piece.discontinuityReason,
  }))
}

function rebuild(world, pieces, uncovered) {
  const map = world.map
  return createPlaybackMap({
    mapId: map.mapId,
    workspaceId: map.workspaceId,
    sessionId: map.sessionId,
    sessionVersion: map.sessionVersion,
    referenceEpoch: map.referenceEpoch,
    reactionTrackId: map.reactionTrackId,
    referenceTrackId: map.referenceTrackId,
    referenceMedia: map.referenceMedia,
    reactionMedia: map.reactionMedia,
    pieces,
    uncovered: uncovered ?? map.uncovered,
    anchors: map.anchors,
  })
}

test('T-F4.015 falsification 5: a pause that is made to advance, and a replay made to run forward, are refused', () => {
  const world = playbackWorld()

  // The control: the same pieces rebuild the same map, so a refusal below is
  // the mutation and not the reconstruction.
  assert.equal(rebuild(world, piecesOf(world.map)).mapHash, world.map.mapHash)

  const paused = world.map.pieces.find((piece) => piece.mode === 'paused')
  const replay = world.map.pieces.find((piece) => piece.mode === 'replay')
  assert.ok(paused && replay, 'the react fixture must carry a pause and a replay')

  // Linearising the pause: the reference is said to have kept running while it
  // was stopped. Refused, and the message names the piece and the mode.
  const advancingPause = refusalOf(() => rebuild(world, piecesOf(world.map, (piece) => (
    piece.pieceId !== paused.pieceId ? piece : {
      ...piece,
      referenceRange: createTickInterval(sec(6), sec(10)),
      direction: 'forward',
      rate: rational(1),
    }
  ))))
  assert.ok(advancingPause, 'a paused stretch was allowed to claim the reference produced time')
  assert.equal(advancingPause.code, 'INVALID_ARGUMENT')
  assert.match(advancingPause.message, /cannot claim the reference produced time/)

  // Linearising the movement: the replay is said to have been reached going
  // forward, which is what a monotone model has to claim.
  const forwardReplay = refusalOf(() => rebuild(world, piecesOf(world.map, (piece) => (
    piece.pieceId !== replay.pieceId ? piece : { ...piece, direction: 'forward' }
  ))))
  assert.ok(forwardReplay, 'a replay was allowed to be reached going forward')
  assert.match(forwardReplay.message, /must be reached by going backwards/)

  // Collapsing two pieces into one run: the reactor would have lived an
  // instant twice.
  const overlapping = refusalOf(() => rebuild(world, piecesOf(world.map, (piece) => (
    piece.pieceId !== replay.pieceId ? piece : {
      ...piece,
      reactionRange: createTickInterval(piece.reactionRange.start - sec(2), piece.reactionRange.end),
    }
  ))))
  assert.ok(overlapping, 'two pieces were allowed to cover the same reaction instant')
  assert.match(overlapping.message, /overlaps the piece before it/)

  // What a linear reading would have had to say, in numbers. At the replay the
  // reference is 26 seconds behind where a 1:1 model puts it, and the pause and
  // the commentary produce no reference time at all.
  const before = world.map.pieces[replay.ordinal - 1]
  const backwardsSeconds = seconds(before.referenceRange.end - replay.referenceRange.start)
  assert.ok(backwardsSeconds > 0, 'the replay must actually go backwards')
  const linearPrediction = seconds(replay.reactionRange.start)
  const measured = seconds(replay.referenceRange.start)
  assert.notEqual(linearPrediction, measured)
  const withoutReference = world.map.pieces.filter((piece) => piece.referenceRange === null)
  assert.ok(withoutReference.length >= 2)
  assert.ok(withoutReference.every((piece) => piece.rate === null))

  console.log(
    `falsification-5 playback: ${world.map.pieces.length} pieces, ${withoutReference.length} with no reference time; `
    + `the replay goes back ${backwardsSeconds}s (linear would say ${linearPrediction}s, measured ${measured}s)`,
  )
})

test('T-F4.015 falsification 6: assuming the reaction and the reference last the same is refused by name', () => {
  const world = playbackWorld()
  const reactionSeconds = seconds(world.reactionMedia.durationTicks)
  const referenceSeconds = seconds(world.referenceMedia.durationTicks)
  assert.notEqual(reactionSeconds, referenceSeconds, 'the react fixture must have two different durations')

  const onePiece = (referenceEnd) => [{
    pieceId: 'piece-linear',
    mode: 'playing',
    reactionRange: createTickInterval(tick(0), world.reactionMedia.durationTicks),
    referenceRange: createTickInterval(tick(0), referenceEnd),
    rate: rational(1),
    direction: 'forward',
    confidence: 0.9,
    evidenceRefs: ['fingerprint:linear'],
    detectionMethod: 'audio-fingerprint',
    residualTicks: null,
    discontinuityReason: null,
  }]

  // The assumption, stated as the map it implies: the reaction played the
  // reference start to finish, so both last forty seconds.
  // One piece and no uncovered stretch: the linear reading has nothing it
  // cannot account for, which is exactly what makes it a lie.
  const assumed = refusalOf(() => rebuild(world, onePiece(world.reactionMedia.durationTicks), []))
  assert.ok(assumed, 'a reference that never had forty seconds was allowed to play forty')
  assert.equal(assumed.code, 'INVALID_ARGUMENT')
  assert.match(assumed.message, /plays reference time the reference does not have/)
  assert.equal(assumed.details.referenceDurationTicks, world.referenceMedia.durationTicks.toString())

  // The same single piece inside the reference that was actually measured is
  // accepted — so what the constructor refused is the assumed duration and not
  // the shape of the map.
  const honest = rebuild(world, onePiece(world.referenceMedia.durationTicks), [])
  assert.equal(honest.pieces.length, 1)
  assert.equal(honest.pieces[0].referenceRange.end, world.referenceMedia.durationTicks)

  console.log(
    `falsification-6 durations: reaction ${reactionSeconds}s vs reference ${referenceSeconds}s; `
    + `the equal-duration map was refused as "${assumed.message.slice(0, 60)}…"`,
  )
})

// ---------------------------------------------------------------------------
// 7. Caller-supplied derivations
// ---------------------------------------------------------------------------

test('T-F4.012 falsification 7: the same command is refused with a caller evidence ref and accepted without it', async () => {
  const wired = wire()

  // Refused, by name, with the field the caller has to remove.
  await assert.rejects(
    () => wired.execute(request({ evidenceRefs: ['media-artifact:asset-cam-a:0-1000'] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION' && error.details.field === 'evidenceRefs',
  )
  await assert.rejects(
    () => wired.execute(request({ protectedSelections: [{
      selectionId: 'sel-1',
      trackId: 'track-camera-a',
      sessionStartTicks: '0',
      sessionEndTicks: '90000',
      note: 'keep this angle',
      evidenceRefs: ['observation:obs-1'],
    }] })),
    (error) => error.code === 'DIRECTION_CALLER_SUPPLIED_DERIVATION'
      && error.details.field === 'protectedSelections[0].evidenceRefs',
    'a derivation nested inside a protected selection has to be refused with its path',
  )
  assert.equal(wired.directions.calls.appendVersion, 0, 'a refused request wrote a direction')
  assert.equal(wired.commands.calls.commitOrReplay, 0, 'a refused request committed a command')

  // Accepted: the identical request without that one key runs the command and
  // comes back with the evidence refs the SERVER derived.
  const accepted = await wired.execute(request())
  assert.equal(accepted.replayed, false)
  assert.equal(wired.directions.calls.appendVersion, 1)
  const cited = accepted.direction.shots.flatMap((shot) => shot.evidenceRefs)
  assert.ok(cited.length > 0, 'the direction cited no evidence at all')
  // Every one of them names a projection the server read, and none of them is
  // the string the refused request tried to put there.
  assert.deepEqual(
    [...new Set(cited.map((ref) => ref.split(':')[0]))].sort(),
    ['observation', 'sync-diagnostic', 'track-coverage'],
  )
  assert.ok(!cited.includes('media-artifact:asset-cam-a:0-1000'))

  console.log(
    `falsification-7 derivations: 2 refused by name with no write; the accepted twin derived `
    + `${cited.length} evidence refs across ${accepted.direction.shots.length} shots`,
  )
})

// ---------------------------------------------------------------------------
// 8. The hash on read
// ---------------------------------------------------------------------------

test('T-F4.012 falsification 8: an edited row is refused on read, and the same edit resealed is not', () => {
  const world = directionWorld()
  const stored = world.direction
  assert.equal(assertMulticamDirectionIntegrity(stored), stored)

  // The edit a doctored row would make: the review a person owes is switched
  // off. Every other field still agrees with itself.
  const tampered = { ...stored, manualReviewRequired: !stored.manualReviewRequired }
  const refusal = refusalOf(() => assertMulticamDirectionIntegrity(tampered))
  assert.ok(refusal, 'an edited direction was hydrated as if it were the stored one')
  assert.equal(refusal.code, 'PERSISTENCE_CONFLICT')
  assert.match(refusal.message, /hash does not match its body/)

  // The reason a reviewer can trust a rejection: editing why an angle lost
  // changes the shot's own hash, not only the aggregate's.
  const [firstShot] = stored.shots
  const alternative = firstShot.alternatives[0]
  assert.ok(alternative, 'the fixture must carry an angle that lost')
  const editedReason = {
    ...stored,
    shots: [
      {
        ...firstShot,
        alternatives: [{ ...alternative, rejectedBecause: 'looked fine to me' }, ...firstShot.alternatives.slice(1)],
      },
      ...stored.shots.slice(1),
    ],
  }
  const shotRefusal = refusalOf(() => assertMulticamDirectionIntegrity({
    ...editedReason,
    directionHash: calculateMulticamDirectionHash({ ...editedReason, directionHash: undefined, ...withoutHash(editedReason) }),
  }))
  assert.ok(shotRefusal, 'the reason an angle lost was edited and the read accepted it')
  assert.equal(shotRefusal.code, 'PERSISTENCE_CONFLICT')
  assert.match(shotRefusal.message, /hash does not match its body/)

  // And the other half: the hash is the only thing standing between the edit
  // and the reader. Reseal the aggregate and the same doctored body passes.
  const resealed = { ...withoutHash(tampered), directionHash: calculateMulticamDirectionHash(withoutHash(tampered)) }
  assert.equal(assertMulticamDirectionIntegrity(resealed).manualReviewRequired, tampered.manualReviewRequired)
  assert.notEqual(resealed.directionHash, stored.directionHash)

  console.log(
    `falsification-8 hydration: manualReviewRequired ${stored.manualReviewRequired} -> ${tampered.manualReviewRequired} `
    + `refused as ${refusal.code}; resealed under ${resealed.directionHash.slice(0, 12)} it is accepted, which is why the `
    + 'chain and not the row is the record',
  )
})

function withoutHash(direction) {
  const { directionHash: _directionHash, ...body } = direction
  return body
}

// ---------------------------------------------------------------------------
// 9. The phase gate's evidence
// ---------------------------------------------------------------------------

const GATE_REFERENCE = (criterion) => ({
  type: 'sync-diagnostic',
  id: `evidence-${criterion}`,
  hash: sha('a'),
  verified: true,
})

function gateEvidence(criteria = MULTICAM_LONGFORM_CRITERIA) {
  return criteria.map((criterion) => ({
    criterion,
    checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      failureReason: null,
      detail: `${code} observed on ${criterion}`,
      references: [GATE_REFERENCE(criterion)],
    })),
  }))
}

function evaluateGate(evidence) {
  return evaluateMulticamLongformGate({
    workspaceId: WORKSPACE, projectId: PROJECT, sessionId: null, evidence, evaluatedAt: at(200),
  })
}

test('T-F4.016 falsification 9: deleting one row of evidence fails the gate, and nothing may pass without it', () => {
  const approved = evaluateGate(gateEvidence())
  assert.equal(approved.approved, true)
  assert.equal(approved.satisfied, MULTICAM_LONGFORM_CRITERIA.length)

  // Deleting the evidence of one criterion — the row, not the criterion — must
  // fail that criterion and the gate, and leave the other nine saying what they
  // found.
  for (const criterion of MULTICAM_LONGFORM_CRITERIA) {
    const report = evaluateGate(gateEvidence().filter((entry) => entry.criterion !== criterion))
    assert.equal(report.approved, false, `${criterion}: the gate approved without its evidence`)
    assert.deepEqual([...report.failed], [criterion])
    const failed = report.criteria.find((entry) => entry.criterion === criterion)
    assert.equal(failed.missingCheckCount, MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].length)
    assert.ok(report.criteria.filter((entry) => entry.criterion !== criterion).every((entry) => entry.passed))
  }

  // And the deletion cannot be papered over: a check that read nothing may not
  // report that it passed, and a reference whose hash did not verify may not
  // back one either.
  const [first] = MULTICAM_LONGFORM_CRITERIA
  const emptyPass = refusalOf(() => evaluateGate(gateEvidence().map((entry) => (
    entry.criterion !== first ? entry : { ...entry, checks: entry.checks.map((check) => ({ ...check, references: [] })) }
  ))))
  assert.ok(emptyPass, 'a check with no evidence at all was allowed to pass')
  assert.equal(emptyPass.code, 'INVALID_ARGUMENT')

  const unverified = evaluateGate(gateEvidence().map((entry) => (
    entry.criterion !== first ? entry : {
      ...entry,
      checks: entry.checks.map((check, index) => (index !== 0 ? check : {
        ...check,
        passed: false,
        failureReason: 'evidence-unverified',
        detail: 'the stored row did not re-derive to its hash',
        references: [{ ...GATE_REFERENCE(first), verified: false }],
      })),
    }
  )))
  assert.equal(unverified.approved, false)
  assert.equal(unverified.blocking[0].reason, 'evidence-unverified')
  assert.equal(unverified.criteria.find((entry) => entry.criterion === first).unverifiedReferenceCount, 1)

  console.log(
    `falsification-9 gate: ${approved.satisfied}/${approved.total} approved; each of the `
    + `${MULTICAM_LONGFORM_CRITERIA.length} criteria fails alone when its evidence is deleted, and a check with `
    + `no reference is refused as ${emptyPass.code}`,
  )
})

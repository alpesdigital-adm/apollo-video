import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { captureSessionDerivationRef } from '../../src/v2/domain/capture-session.ts'
import {
  COLOR_TRANSFORM_ORDER,
  createColorPlan,
  createMediaColorProbe,
  resolveColorPlan,
} from '../../src/v2/domain/color-and-export.ts'
import { createColorPipelineCompilation } from '../../src/v2/domain/color-pipeline-compilation.ts'
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
import { FfmpegColorMeasurement } from '../../src/v2/infrastructure/media/ffmpeg-color-measurement.ts'
import { buildFfmpegColorPipelineFilter } from '../../src/v2/infrastructure/media/ffmpeg-color-pipeline-processor.ts'
import { probeVideo } from '../../src/v2/infrastructure/media/video-probe.ts'
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
 *
 * ## What this file is, and what it is not
 *
 * It is a DOMAIN-level suite, deliberately, and it is registered as one
 * (`test:unit:wave20-falsification`) so nothing about its name suggests
 * otherwise. BRIEF-E2E asks that its journeys run through the published `/v1`
 * routes against PostgreSQL; these cases are not journeys. A falsification has
 * to vary one fact and hold everything else identical — one camera's
 * confidence, which microphone carried the speech, the position of one stage —
 * and a route hands back an answer produced from a whole world it also
 * assembled, which is the wrong instrument for that.
 *
 * So the two halves live in two places, and this comment names both:
 *
 * - the DECISION is falsified here, on the function that makes it;
 * - the SAME protection is exercised through the routes and the database by
 *   `wave20-persistence.e2e.mjs`, `multicam-direction.e2e.mjs`,
 *   `color-critic.e2e.mjs`, `playback-map.e2e.mjs`,
 *   `multicam-longform-gate.e2e.mjs` and the operator journey in
 *   `wave20-operator-browser.e2e.mjs`, each behind its own `APOLLO_*_E2E` gate.
 *
 * Where a protection's product boundary is somewhere other than the function
 * this file calls — the hydration of a stored direction, the gate's row reader
 * — the boundary is pinned structurally here as well, because a check deleted
 * at the boundary used to leave this suite and the whole repository suite green
 * and be caught only by a database E2E that neither `npm test` nor this lane's
 * CI steps run. Case 3 goes further and renders: the stage order it refuses is
 * measured on the pixels of two real MP4s, read back with ffprobe and judged by
 * the colour critic.
 */

const WORKSPACE = 'workspace-falsify'
const SESSION = 'session-falsify'
const PROJECT = 'project-falsify'
const HZ = 90_000
const seconds = (ticks) => Number(ticks) / HZ
const root = resolve(import.meta.dirname, '../..')

/**
 * A source with its comments removed.
 *
 * Every structural assertion below reads this rather than the file, because the
 * first version of case 1 counted a doc comment among the coverage gate's call
 * sites: `assertCoverageSelectable(` appears four times in
 * `multicam-direction.ts` and one of them is prose, so with a floor of three
 * one real gate could be deleted with this suite, `npm test` and `tsc` all
 * green. Measured, before this was written: deleting the gate in `audioForShot`
 * left 9/9 here and 2145/2145 in the repository suite.
 */
function codeOf(relativePath) {
  return readFileSync(join(root, relativePath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Executable calls of `name(` in that source, comments already gone. */
function callSitesOf(relativePath, name) {
  return codeOf(relativePath).match(new RegExp(String.raw`\b${name}\(`, 'g')) ?? []
}

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

  // The third gate, behaviourally: doubt ONLY the final-mix audio and every
  // camera keeps the confidence that was measured, so the cut is identical and
  // the one thing that changes is whether a shot may be given an audio track
  // whose coverage nobody verified. This is the gate a call-site count let be
  // deleted, and it is the one that decides what a viewer hears.
  const audioDoubted = world.coverages.map((coverage) => (
    coverage.trackId === 'track-master-audio'
      ? coverageAt(world.session, coverage.trackId, belowFloor)
      : coverage
  ))
  const mute = direct(world, { coverages: audioDoubted })
  assert.deepEqual(
    mute.shots.map((shot) => [shot.shotId, shot.chosen.trackId]),
    accepted.shots.map((shot) => [shot.shotId, shot.chosen.trackId]),
    'doubting the audio changed which cameras were cut, so this measures more than the audio gate',
  )
  assert.ok(accepted.shots.length > 0)
  for (const shot of accepted.shots) {
    assert.equal(shot.audioTrackId, 'track-master-audio', `${shot.shotId} had no audio bed when the coverage held`)
  }
  for (const shot of mute.shots) {
    assert.equal(shot.audioTrackId, null, `${shot.shotId} was given audio whose coverage was never verified`)
  }
  const muteWarning = mute.warnings.find((warning) => warning.code === 'audio-master-unavailable')
  assert.ok(muteWarning, 'the direction dropped the audio bed and said nothing')
  assert.match(muteWarning.detail, /coverage-below-floor/)
  assert.deepEqual([...accepted.warnings.filter((warning) => warning.code === 'audio-master-unavailable')], [])

  // Structural: the three call sites and the floor itself. Deleting any one of
  // them is the mutation this case exists for. The count is exact and read off
  // a source with its comments stripped, because a doc comment used to be
  // counted as a fourth site and let one real gate go.
  const callSites = callSitesOf('src/v2/domain/multicam-direction.ts', 'assertCoverageSelectable')
  assert.equal(
    callSites.length, 3,
    `the coverage gate has ${callSites.length} executable call sites, not the three this case names: `
    + 'deriveCandidate (which angle is eligible), audioForShot (which track a shot is heard on) '
    + 'and compileShotsToSourceRanges (which frames are cut)',
  )
  for (const enclosing of ['function deriveCandidate(', 'function audioForShot(', 'const resolveOrRefuse = (']) {
    const body = codeOf('src/v2/domain/multicam-direction.ts')
    const from = body.indexOf(enclosing)
    assert.ok(from > 0, `${enclosing} is gone; the case names a gate that no longer exists`)
    assert.ok(
      body.slice(from, from + 4_000).includes('assertCoverageSelectable('),
      `${enclosing} no longer asks the coverage gate`,
    )
  }
  assert.equal(AUTO_EDIT_MINIMUM_CONFIDENCE_BPS, 7_000)

  console.log(
    `falsification-1 coverage: ${accepted.shots.length} shots at ${9_800} bps, `
    + `${refused.shots.length} at ${belowFloor} bps; the compile of ${compiled.clips.length} clips refused with `
    + `${atCompile.code}/${atCompile.details.cause}; doubting only the audio kept ${mute.shots.length} shots `
    + `and left every one of them without an audio track (${muteWarning.detail})`,
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

/**
 * A shoulder LUT: identity to mid-grey, then compressed so nothing it produces
 * can reach white. It is the ordinary shape of a film look, and it is why the
 * order matters — a match applied before it is rolled off by it, and a match
 * applied after it walks straight out the top.
 */
function shoulderCube() {
  const curve = [0, 0.5, 0.75]
  const lines = ['LUT_3D_SIZE 3']
  for (let blue = 0; blue < 3; blue += 1) {
    for (let green = 0; green < 3; green += 1) {
      for (let red = 0; red < 3; red += 1) {
        lines.push(`${curve[red].toFixed(6)} ${curve[green].toFixed(6)} ${curve[blue].toFixed(6)}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

const RENDER_COLOR = Object.freeze({
  colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8,
})

function pipelineStage(id, kind, provider, parameters, extra = {}) {
  return {
    id, kind, version: 'v1', enabled: true, input: RENDER_COLOR, output: RENDER_COLOR,
    implementation: {
      provider, version: 'v1', parameters: Object.freeze(parameters), parametersHash: calculateCanonicalHash(parameters),
    },
    ...extra,
  }
}

test('T-FR-183 falsification 3: a match after the creative LUT is refused, and clips the delivered frame when it is not', async (t) => {
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

  // And the plan constructor applies the same rule to every layer it stores.
  // It used to apply it to none of them: `resolveColorPlan` keys layers by
  // stage, so a plan declaring `[technical, creative-lut, match, output]` was
  // accepted, silently re-sorted, and rendered in an order it did not describe.
  const plan = {
    schemaVersion: 'color-plan/v1',
    metadata: COLOR_METADATA,
    outputMetadata: COLOR_METADATA,
    global: [technical, creative, match, output],
    sources: {},
    cameras: {},
    segments: {},
  }
  const planRefusal = refusalOf(() => createColorPlan(plan))
  assert.ok(planRefusal, 'a ColorPlan whose global layer applies the match after the LUT was stored')
  assert.equal(planRefusal.code, 'COLOR_STAGE_VIOLATION')
  assert.equal(planRefusal.details.after, 'creative-lut')
  assert.ok(refusalOf(() => resolveColorPlan(plan, {})), 'the resolver still re-sorted the layer it should refuse')

  // The accepted twin, resolved: the stages come back in the pipeline's order,
  // compared against the four names written out rather than against the
  // constant the resolver itself maps over.
  const ordered = { ...plan, global: [technical, match, creative, output] }
  assert.equal(createColorPlan(ordered).planHash.length, 64)
  assert.deepEqual(
    resolveColorPlan(ordered, {}).stages.map((stage) => stage.kind),
    ['technical', 'match', 'creative-lut', 'output'],
  )
  assert.deepEqual([...COLOR_TRANSFORM_ORDER], ['technical', 'match', 'creative-lut', 'output'])

  // ---- and on pixels, with the product's own filter -----------------------
  // Two renders of one recording that differ in nothing but the position of the
  // match. Both filters are the ones `buildFfmpegColorPipelineFilter` emits for
  // the same compilation; the second is that filter with its two middle links
  // swapped, which is the pipeline the misordered plan above would have been
  // resolved into. What the critic then reads is the delivered frame.
  const ffmpeg = resolveFfmpegBinary()
  const workRoot = mkdtempSync(join(tmpdir(), 'apollo-falsify-color-'))
  t.after(() => rmSync(workRoot, { recursive: true, force: true }))

  const sourcePath = join(workRoot, 'ramp.mp4')
  execFileSync(ffmpeg, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', "nullsrc=s=320x180:r=24:d=1,geq=lum='16+219*X/W':cb=128:cr=128",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
    sourcePath,
  ], { timeout: 120_000 })
  const lutPath = join(workRoot, 'shoulder.cube')
  writeFileSync(lutPath, shoulderCube(), 'utf8')

  const compilation = createColorPipelineCompilation({
    id: 'compilation-falsify-order',
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sourceArtifactId: 'artifact-ramp',
    sourceManifestId: 'manifest-ramp',
    probe: createMediaColorProbe({
      id: 'probe-falsify-order',
      workspaceId: WORKSPACE,
      artifactId: 'artifact-ramp',
      manifestId: 'manifest-ramp',
      detection: { state: 'ready', metadata: RENDER_COLOR, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
      producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: sha('9') },
      createdAt: at(0),
    }),
    outputMetadata: RENDER_COLOR,
    stages: [
      pipelineStage('technical-render', 'technical', 'ffmpeg-zscale', { mode: 'identity' }),
      pipelineStage('match-render', 'match', 'apollo-match', { mode: 'adjust', brightness: 0.35, contrast: 1, saturation: 1 }),
      pipelineStage('creative-render', 'creative-lut', 'apollo-lut', { mode: 'lut3d', intensity: 1 },
        { lut: { artifactId: 'lut-shoulder', sha256: sha('f') } }),
      pipelineStage('output-render', 'output', 'ffmpeg-zscale', { dither: true }),
    ],
    createdByClientId: 'client-falsify',
    createdAt: at(0),
  })
  const compiled = buildFfmpegColorPipelineFilter({ compilation, lutPaths: { 'lut-shoulder': lutPath } })
  const links = compiled.filter.split(',')
  assert.equal(links.length, 5, `the product filter is not four stages and a format: ${compiled.filter}`)
  assert.match(links[1], /^eq=brightness=0\.350000/, 'the second link is not the match the compilation declared')
  assert.match(links[2], /^lut3d=file=/, 'the third link is not the creative LUT')
  const swapped = [links[0], links[2], links[1], ...links.slice(3)].join(',')

  const render = (name, filter) => {
    const path = join(workRoot, `${name}.mp4`)
    execFileSync(ffmpeg, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', sourcePath, '-vf', filter,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', compiled.pixelFormat,
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
      path,
    ], { timeout: 180_000 })
    return path
  }
  const declaredPath = render('match-before-lut', compiled.filter)
  const misorderedPath = render('match-after-lut', swapped)

  // Both files read back with the real ffprobe before anything is claimed
  // about them, and reported with their numbers.
  const [declaredProbe, misorderedProbe] = await Promise.all([
    probeVideo(declaredPath, { requireAudio: false }),
    probeVideo(misorderedPath, { requireAudio: false }),
  ])
  for (const [name, probed] of [['declared', declaredProbe], ['misordered', misorderedProbe]]) {
    assert.equal(probed.color.state, 'ready', `${name} render carries no colour metadata`)
    assert.equal(probed.color.hdrMode, 'sdr')
    assert.ok(probed.duration > 0, `${name} render has no duration`)
    assert.equal(probed.width, 320)
    assert.equal(probed.height, 180)
  }

  const measurement = new FfmpegColorMeasurement({ ffmpegPath: ffmpeg })
  const measure = async (path, measurementId, sourceAssetId) => {
    const [one] = await measurement.measureCameraColor({
      mediaPath: path,
      cameraId: 'camera-a',
      sourceAssetId,
      sourceSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
      ranges: [{
        sessionRange: createTickInterval(0n, BigInt(HZ)),
        sourceStartFrame: 0, sourceEndFrame: 24, measurementId,
      }],
    })
    return one
  }
  const declaredMeasured = await measure(declaredPath, 'falsify-order-declared', 'artifact-declared')
  const misorderedMeasured = await measure(misorderedPath, 'falsify-order-misordered', 'artifact-misordered')

  const clipping = DEFAULT_COLOR_CRITIC_THRESHOLDS.values.clipping
  assert.ok(
    declaredMeasured.dimensions.highlights.value < clipping.warn,
    `the declared order clipped ${declaredMeasured.dimensions.highlights.value} of the frame`,
  )
  assert.ok(
    misorderedMeasured.dimensions.highlights.value > clipping.hard,
    'swapping the two stages changed nothing the critic can read, so nothing here measures order',
  )

  // The visual evaluation itself, on the delivered bytes: the same recording,
  // the same two stages, the same declared look — and the misordered render is
  // rejected for highlights that no grade can bring back.
  const criticFor = (delivered, previous, reportId, artifactId) => evaluateColorCritic({
    reportId,
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    projectVersionId: 'project-version-falsify',
    subject: { kind: 'output', artifactId },
    before: [previous],
    after: [delivered],
    creativeIntent: { declared: true, castAllowedDelta: 0.15, lutId: 'lut-shoulder' },
    evaluatedAt: at(100),
  })
  const rejected = criticFor(misorderedMeasured, declaredMeasured, 'falsify-order-after', 'artifact-misordered')
  const accepted = criticFor(declaredMeasured, misorderedMeasured, 'falsify-order-before', 'artifact-declared')
  const clippingIssues = (report) => report.issues.filter((entry) => entry.dimension === 'clipping')

  assert.equal(rejected.action, 'reject', 'the misordered render was not refused by the critic')
  assert.equal(clippingIssues(rejected).length, 1)
  assert.equal(clippingIssues(rejected)[0].severity, 'hard')
  assert.equal(clippingIssues(rejected)[0].cause, 'irreversible-technical-defect')
  assert.deepEqual(clippingIssues(accepted), [], 'the declared order was also charged with clipping')
  assert.notEqual(accepted.action, 'reject')
  assert.ok(COLOR_CRITIC_IRREVERSIBLE_DIMENSIONS.includes('clipping'))

  console.log(
    `falsification-3 stage order: refused ${refusal.code} after ${refusal.details.after}, `
    + `plan refused ${planRefusal.code}; two ${declaredProbe.duration.toFixed(3)}s `
    + `${misorderedProbe.width}x${misorderedProbe.height} @${misorderedProbe.fps}fps renders clipped `
    + `${declaredMeasured.dimensions.highlights.value} of the frame with the match before the LUT and `
    + `${misorderedMeasured.dimensions.highlights.value} after it (critic hard band ${clipping.hard}), `
    + `so the critic answers ${accepted.action} and ${rejected.action}`,
  )
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

  // The check is proved above against the domain function. This pins it to the
  // boundary the protection is NAMED after: the row-to-aggregate reader. With
  // the assertion deleted there, `assertMulticamDirectionIntegrity` still
  // refuses everything it is handed and nothing hands it anything — measured,
  // that mutation left this suite 9/9 and the repository suite 2145/2145, and
  // was caught only by the gated database E2E.
  const hydration = codeOf('src/v2/infrastructure/prisma/multicam-direction-repository.ts')
  const reader = hydration.indexOf('function hydrateDirection(')
  assert.ok(reader > 0, 'the direction repository no longer has the row reader this case pins')
  assert.match(
    hydration.slice(reader, reader + 12_000), /assertMulticamDirectionIntegrity\(/,
    'hydrateDirection turns a row into an aggregate without recomputing its hash',
  )
  assert.equal(
    callSitesOf('src/v2/infrastructure/prisma/multicam-direction-repository.ts', 'assertMulticamDirectionIntegrity').length,
    1, 'the direction repository verifies the hash somewhere other than where it hydrates',
  )

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

  // Where the protection actually stands in the product: the gate's row
  // reader. The case above filters an in-memory array; deleting the checks in
  // `hydrateGate` would leave that green while a doctored row was handed back
  // as an approval, so the reader is pinned here too — the report's own
  // integrity, the cross-check that ties the ordering column to the signed
  // report, and the record hash.
  const gateReader = codeOf('src/v2/infrastructure/prisma/multicam-longform-gate-repository.ts')
  const reader = gateReader.indexOf('function hydrateGate(')
  assert.ok(reader > 0, 'the gate repository no longer has the row reader this case pins')
  const body = gateReader.slice(reader, reader + 12_000)
  for (const required of [
    'assertMulticamLongformGateReportIntegrity(',
    'report.evaluatedAt !== row.evaluatedAt.toISOString()',
    'calculateMulticamLongformGateRecordHash(content) !== row.recordHash',
  ]) {
    assert.ok(body.includes(required), `hydrateGate no longer checks: ${required}`)
  }

  console.log(
    `falsification-9 gate: ${approved.satisfied}/${approved.total} approved; each of the `
    + `${MULTICAM_LONGFORM_CRITERIA.length} criteria fails alone when its evidence is deleted, and a check with `
    + `no reference is refused as ${emptyPass.code}`,
  )
})

/**
 * The direct-multicam composition root, read as source.
 *
 * The behavioural half of this guarantee is
 * `multicam-direction-composition.integration.mjs`, which builds the real
 * dependency set and looks at the classes in it. It cannot run in this gate:
 * `repository-factory.ts` pulls modules with TypeScript parameter properties
 * that Node's strip-only loader refuses, so it runs under `tsx` in a CI step of
 * its own. This rule is the half that runs everywhere, and it exists because
 * the hole it closes was measured: with `silence:` deleted from the root,
 * `typecheck`, `lint`, `lint:code`, every case in `tests/v2/*.test.mjs` and the
 * silence media suite all stayed green, because the field is optional on
 * `DeriveMulticamEvidenceDependencies` and the factory's only importers are the
 * two `/v1` route files.
 */
const COMPOSITION_EVIDENCE_WIRING = Object.freeze([
  ['silence: createMulticamSilenceEvidenceProvider(', 'the listening pass'],
  ['visual: createMulticamVisualEvidenceProvider(', 'the looking pass'],
  ['media: createCaptureMediaResolver(', 'the verified materializer'],
  ['diarization: createMulticamDiarizationSource(', 'the persisted speech'],
])

/** One exported function's text, from its signature to the `}` in column 0. */
function exportedBodyOf(source, name) {
  const start = source.indexOf(`export function ${name}(`)
  if (start < 0) return undefined
  const end = source.indexOf('\n}\n', start)
  return end < 0 ? source.slice(start) : source.slice(start, end + 2)
}

function multicamCompositionViolations(source) {
  const violations = []
  const builder = exportedBodyOf(source, 'multicamDirectionCompositionDependencies')
  if (builder === undefined) return ['multicamDirectionCompositionDependencies is no longer exported']
  for (const [fragment, what] of COMPOSITION_EVIDENCE_WIRING) {
    if (!builder.includes(fragment)) violations.push(`the assembled evidence set no longer carries ${what}`)
  }
  const root = exportedBodyOf(source, 'createDirectMulticamSessionService')
  if (root === undefined) return [...violations, 'createDirectMulticamSessionService is no longer exported']
  if (!root.includes('multicamDirectionCompositionDependencies(')) {
    violations.push('createDirectMulticamSessionService must take its dependencies from multicamDirectionCompositionDependencies, or the builder is a set nobody uses')
  }
  if (/deriveMulticamEvidenceService\(\s*\{/.test(root)) {
    violations.push('createDirectMulticamSessionService must not rebuild the evidence dependency literal in place')
  }
  return violations
}

test('T-F4.012 falsification 10: a composition root without the listening pass is refused, and the wired one is not', () => {
  const source = codeOf('src/v2/infrastructure/repository-factory.ts')
  assert.deepEqual(
    multicamCompositionViolations(source),
    [],
    'the shipped composition root assembles both FFmpeg passes and the root takes them from it',
  )

  // Exactly the edit that was measured to leave everything green.
  const unwired = source.replace('silence: createMulticamSilenceEvidenceProvider(environment),', '')
  assert.notEqual(unwired, source, 'the line this case exists for is still there to be removed')
  assert.deepEqual(
    multicamCompositionViolations(unwired),
    ['the assembled evidence set no longer carries the listening pass'],
    'and removing it is refused by name',
  )

  // The sibling hole, closed in the same rule: the visual provider had shipped
  // wired and unexecuted for a whole wave before anything measured it.
  assert.deepEqual(
    multicamCompositionViolations(source.replace('visual: createMulticamVisualEvidenceProvider(environment),', '')),
    ['the assembled evidence set no longer carries the looking pass'],
  )

  // A builder nobody calls proves nothing about production, so the root has to
  // keep deriving from it...
  const detached = source.replace(
    'multicamDirectionCompositionDependencies(environment, clock)',
    '{ evidence: {}, sessions: undefined }',
  )
  assert.notEqual(detached, source, 'the root still calls the builder')
  assert.match(
    multicamCompositionViolations(detached).join(' | '),
    /must take its dependencies from multicamDirectionCompositionDependencies/,
  )

  // ...and must not quietly build a second, different set beside it.
  const rebuilt = source.replace(
    'deriveEvidence: deriveMulticamEvidenceService(evidence),',
    'deriveEvidence: deriveMulticamEvidenceService({ sessions, directions, clock }),',
  )
  assert.notEqual(rebuilt, source, 'the root still passes the assembled set through')
  assert.match(
    multicamCompositionViolations(rebuilt).join(' | '),
    /must not rebuild the evidence dependency literal in place/,
  )

  console.log(
    `falsification-10 composition: ${COMPOSITION_EVIDENCE_WIRING.length} adapters required in the assembled set, `
    + '4 doctored sources refused (silence, visual, detached builder, rebuilt literal), shipped source clean',
  )
})

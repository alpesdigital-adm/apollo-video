import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  buildReactPlaybackMapService,
  compileReactPlaybackPlanService,
  editReactPlaybackAnchorService,
  listReferenceDependentsService,
  readReactPlaybackMapService,
} from '../../src/v2/application/react-playback-map.ts'
import { RENDERABLE_PLAN_ORIGINS } from '../../src/v2/application/renderable-edit-plan.ts'
import { createCaptureSession } from '../../src/v2/domain/capture-session.ts'
import { validateDirectedEditPlan } from '../../src/v2/domain/director-run.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { assertPlaybackMapIntegrity } from '../../src/v2/domain/playback-map.ts'
import { rational, timebaseFromRate } from '../../src/v2/domain/session-time.ts'
import { buildPlaybackWorld } from './wave20-fixtures.mjs'

/**
 * F4.015 — the react playback map over its real services, with fakes for the
 * two things a unit test has no business owning: the files and the detector.
 *
 * The fixture is the slice C one (`wave20-fixtures.mjs`), which is deliberately
 * the unhealthy case: a reaction with a pause, a commentary, a replay, a seek
 * and a stretch where the player was hidden. A healthy fixture is the one case
 * a naive implementation also gets right.
 *
 * What each test proves is named in its title. What none of them prove is the
 * SQL — the fence as a constraint, the bigint through the driver and the
 * workspace boundary as a foreign key are `playback-map.e2e.mjs`.
 */

const WORKSPACE = 'w-playback-service'
const OTHER_WORKSPACE = 'w-playback-other'
const PROJECT = 'p-playback-service'
const SESSION = 's-playback-service'
const REACTION_TRACK = 'track-reaction'
const REFERENCE_ASSET = 'asset-reference-1'
// The ids the render path resolves by: `CaptureTrackPart.evidence.ingestArtifactId`,
// not the capture asset the recorder wrote.
const REACTION_ARTIFACT = 'artifact-track-reaction'
const REFERENCE_ARTIFACT = 'artifact-track-reference'

const at = (second) => new Date(Date.parse('2029-06-01T09:00:00.000Z') + second * 1_000).toISOString()

function clockFrom(start = 0) {
  let seconds = start
  return () => new Date(at((seconds += 1)))
}

const actor = Object.freeze({
  workspaceId: WORKSPACE,
  kind: 'human',
  id: 'operator-ana',
  credentialId: 'credential-1',
  authenticationKind: 'ui-session',
})

function baseOf(session) {
  return {
    baseVersionId: `${session.sessionId}:v${session.version}`,
    baseHash: session.sessionHash,
  }
}

function fakeSessions(session) {
  return {
    async readHead({ workspaceId }) {
      return workspaceId === session.workspaceId ? session : null
    },
    async readVersion() { return session },
    async listVersions() { return [session] },
    async listHeads() { return [] },
    async persistClock() { throw new Error('unused') },
    async readClock() { return null },
    async persistClockMap() { throw new Error('unused') },
    async readClockMap() { return null },
    async listClockMaps() { return [] },
    async persistCoverage() { throw new Error('unused') },
    async readCoverage() { return null },
    async listCoverage() { return [] },
    async persistSyncEvidence() { throw new Error('unused') },
    async readSyncEvidence() { return null },
    async listSyncEvidence() { return [] },
    async appendVersion() { throw new Error('unused') },
  }
}

/**
 * Behaves like the Prisma repository: the head fence is a predicate, a repeated
 * version with the same hash is a replay, and every read re-verifies the hash.
 */
function memoryPlaybackMaps() {
  const versions = new Map()
  const heads = new Map()
  const key = (input) => `${input.workspaceId}/${input.sessionId}/${input.reactionTrackId}`
  const read = (stored) => (stored ? assertPlaybackMapIntegrity(stored) : null)
  return {
    stored: versions,
    async appendVersion({ map, expectedVersion, expectedHash }) {
      const head = key(map)
      const slot = `${head}/v${map.version}`
      const existing = versions.get(slot)
      if (existing) {
        if (existing.mapHash === map.mapHash) return { map: read(existing), replayed: true }
        throw new DomainError('PERSISTENCE_CONFLICT', `version ${map.version} already exists with a different hash`)
      }
      const current = heads.get(head) ?? null
      if (map.version === 1) {
        if (current) {
          throw new DomainError('PERSISTENCE_CONFLICT', 'a head already exists for this reaction track')
        }
      } else {
        const wantVersion = expectedVersion ?? map.version - 1
        const wantHash = expectedHash ?? map.previousVersionHash
        if (!current || current.version !== wantVersion || current.mapHash !== wantHash) {
          throw new DomainError(
            'PLAYBACK_MAP_VERSION_STALE',
            `the playback map is at version ${current?.version ?? 'none'}`,
            { currentVersion: current?.version ?? null, currentHash: current?.mapHash ?? null },
          )
        }
      }
      versions.set(slot, map)
      heads.set(head, { version: map.version, mapHash: map.mapHash, mapId: map.mapId })
      return { map: read(map), replayed: false }
    },
    async readHead(input) {
      const current = heads.get(key(input))
      return current ? read(versions.get(`${key(input)}/v${current.version}`)) : null
    },
    async readVersion(input) {
      return read(versions.get(`${key(input)}/v${input.version}`) ?? null)
    },
    async listVersions(input) {
      return [...versions.entries()]
        .filter(([slot]) => slot.startsWith(`${key(input)}/v`))
        .map(([, map]) => read(map))
        .sort((left, right) => right.version - left.version)
    },
    async findDependentsOfReference({ workspaceId, referenceAssetId, referenceSha256 }) {
      return [...versions.values()]
        .filter((map) =>
          map.workspaceId === workspaceId &&
          map.referenceMedia.assetId === referenceAssetId &&
          map.referenceMedia.sha256 === referenceSha256)
        .map((map) => ({
          sessionId: map.sessionId,
          reactionTrackId: map.reactionTrackId,
          mapId: map.mapId,
          version: map.version,
          mapHash: map.mapHash,
          status: map.status,
          isHead: heads.get(key(map))?.mapHash === map.mapHash,
        }))
    },
  }
}

function memorySnapshots() {
  const rows = []
  return {
    rows,
    async persist({ snapshot, createdAt }) {
      const existing = rows.find((row) =>
        row.workspaceId === snapshot.workspaceId && row.origin === snapshot.origin &&
        row.sourceId === snapshot.sourceId && row.sourceHash === snapshot.sourceHash &&
        row.plan.projectVersionId === snapshot.plan.projectVersionId)
      if (existing) {
        if (existing.planHash === snapshot.planHash) {
          return { snapshot: existing, replayed: true }
        }
        throw new DomainError('PERSISTENCE_CONFLICT', 'a different plan is stored for that source hash')
      }
      const stored = Object.freeze({ ...snapshot, createdAt })
      rows.push(stored)
      return { snapshot: stored, replayed: false }
    },
    async readLatestForSource({ workspaceId, origin, sourceId }) {
      return [...rows].reverse().find((row) =>
        row.workspaceId === workspaceId && row.origin === origin && row.sourceId === sourceId) ?? null
    },
    async listForProject({ workspaceId, projectId }) {
      return rows.filter((row) => row.workspaceId === workspaceId && row.projectId === projectId)
    },
  }
}

/**
 * The project's media-asset links, as the compiler will ask for them.
 *
 * Derived from the session rather than typed in: the artifact id is the part's
 * `evidence.ingestArtifactId` — the id `CaptureMediaResolver` fetches the bytes
 * by and the id the render path resolves a plan's sources by — and the duration
 * is the part's own measured coverage. A fixture that repeated the numbers by
 * hand would agree with a compiler that had them wrong.
 */
function renderSourcesFor(session) {
  return session.tracks.map((track) => {
    const part = track.parts[0]
    return {
      artifactId: part.evidence.ingestArtifactId,
      sha256: part.evidence.ingestSha256,
      byteSize: 4_096,
      mediaType: 'video',
      durationSeconds: Number(part.coverage.end - part.coverage.start) /
        (Number(part.timebase.secondsPerTick.den) / Number(part.timebase.secondsPerTick.num)),
    }
  })
}

function fakeRenderSources(entries) {
  const rows = new Map(entries.map((entry) => [entry.artifactId, entry]))
  const asked = []
  return {
    rows,
    asked,
    async resolveForProject({ workspaceId, projectId, artifactIds }) {
      asked.push({ workspaceId, projectId, artifactIds: [...artifactIds] })
      return artifactIds.flatMap((artifactId) => {
        const row = rows.get(artifactId)
        return row ? [row] : []
      })
    },
  }
}

/** Counts what it hands out, so a forgotten `release` is a failing number. */
function fakeMedia() {
  const state = { opened: 0, released: 0, paths: [] }
  return {
    state,
    async resolve({ part }) {
      state.opened += 1
      const path = `/fixtures/${part.sourceAssetId}.mp4`
      state.paths.push(path)
      return {
        path,
        release: async () => { state.released += 1 },
      }
    },
  }
}

function fakeDetector(observations) {
  const seen = []
  return {
    seen,
    async detectPlaybackObservations(input) {
      seen.push(input)
      return typeof observations === 'function' ? observations(input) : observations
    },
  }
}

function wire(world, {
  observations,
  snapshots = memorySnapshots(),
  maps = memoryPlaybackMaps(),
  sources = fakeRenderSources(renderSourcesFor(world.session)),
  compileSession = world.session,
} = {}) {
  const media = fakeMedia()
  const detector = fakeDetector(observations ?? world.observations)
  const clock = clockFrom()
  return {
    maps,
    snapshots,
    sources,
    media,
    detector,
    build: buildReactPlaybackMapService({
      repository: maps,
      sessions: fakeSessions(world.session),
      media,
      observations: detector,
      snapshots,
      clock,
    }),
    anchor: editReactPlaybackAnchorService({ repository: maps, snapshots, clock }),
    read: readReactPlaybackMapService({ repository: maps }),
    dependents: listReferenceDependentsService({ repository: maps }),
    compile: compileReactPlaybackPlanService({
      repository: maps,
      // Separately nameable so a test can compile against a session that moved
      // past the one the map was derived from — the fence at the top of the
      // compiler, which nothing reached while both stubs returned one session.
      sessions: fakeSessions(compileSession),
      sources,
      snapshots,
      clock,
    }),
  }
}

function world(overrides = {}) {
  return buildPlaybackWorld({
    workspaceId: WORKSPACE,
    projectId: PROJECT,
    sessionId: SESSION,
    ...overrides,
  })
}

test('T-F4.015 the service derives a map from what the detector saw, and leaves the hidden player for a person', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const result = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })

  assert.equal(result.replayed, false)
  assert.equal(result.map.version, 1)
  assert.equal(result.map.sessionVersion, fixture.session.version)
  // The domain's own reading of this fixture, reached through the service.
  assert.deepEqual(
    [...new Set(result.map.pieces.map((piece) => piece.mode))].sort(),
    ['commentary-only', 'paused', 'playing', 'replay', 'seek'],
  )
  assert.equal(result.map.status, 'needs-input')
  assert.equal(result.manualReviewRequired, true)
  assert.deepEqual(result.map.uncovered.map((entry) => entry.reason), ['manual-anchor-required'])
  // Both files were opened and both were given back.
  assert.equal(kit.media.state.opened, 2)
  assert.equal(kit.media.state.released, 2)
  // The detector was handed the session's clock for the reaction and the
  // reference part's own timebase for the reference — not one clock for both.
  assert.equal(kit.detector.seen.length, 1)
  assert.deepEqual(kit.detector.seen[0].reactionTimebase, fixture.session.clock.timebase)
  assert.deepEqual(kit.detector.seen[0].referenceTimebase, timebaseFromRate(90_000))
})

test('T-F4.015 a build computed against a session version that moved is refused with the current pair', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const error = await kit.build({
    actor,
    sessionId: SESSION,
    baseVersionId: `${SESSION}:v1`,
    baseHash: 'f'.repeat(64),
  }).then(() => null, (caught) => caught)

  assert.equal(error?.code, 'CAPTURE_SESSION_VERSION_STALE')
  assert.equal(error.details.currentHash, fixture.session.sessionHash)
  assert.equal(error.details.currentVersion, fixture.session.version)
})

test('T-F4.015 re-running detection over an unchanged session is a replay, not a second version', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const first = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  const second = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })

  assert.equal(second.replayed, true)
  assert.equal(second.map.version, 1)
  assert.equal(second.map.mapHash, first.map.mapHash)
  const versions = await kit.maps.listVersions({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  assert.equal(versions.length, 1, 'the chain must not grow a version that repeats the one before it')
  // The detector ran twice: the replay is decided on what it found, not by
  // skipping the measurement.
  assert.equal(kit.detector.seen.length, 2)
})

test('T-F4.015 an anchor names the operator in its evidence, and a stale one loses to the version fence', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  const head = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })

  const stale = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: head.versionRef,
    baseHash: 'a'.repeat(64),
    anchor: {
      anchorId: 'anchor-stale',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  }).then(() => null, (caught) => caught)
  assert.equal(stale?.code, 'PLAYBACK_MAP_VERSION_STALE')
  assert.equal(stale.details.currentVersion, 1)
  assert.equal(stale.details.currentHash, built.map.mapHash)

  const resolved = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: head.versionRef,
    baseHash: built.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-1',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
      note: 'O player estava escondido; a reação segue falando.',
    },
  })
  assert.equal(resolved.map.version, 2)
  assert.equal(resolved.map.status, 'resolved')
  assert.equal(resolved.manualReviewRequired, false)
  // The actor comes first and the note is in brackets after it. A note alone
  // would erase who overrode the measurement.
  assert.equal(
    resolved.map.anchors[0].evidenceRef,
    'operator:operator-ana (O player estava escondido; a reação segue falando.)',
  )
  assert.equal(resolved.map.previousVersionHash, built.map.mapHash)
  // Nothing had been compiled from this map, so nothing was invalidated.
  assert.equal(resolved.invalidated, null)
})

test('T-F4.015 the compiled plan runs the reaction, never the reference, and passes the authority validator', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  const head = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: head.versionRef,
    baseHash: built.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-1',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  })

  const compiled = await kit.compile({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    projectVersionId: 'version-react-1',
    objective: 'discovery',
    planFps: rational(BigInt(30), BigInt(1)),
  })

  // The validator is the authority, and it is run again here on the returned
  // document: a plan that only validated inside the compiler proves nothing
  // about what the caller received.
  validateDirectedEditPlan(compiled.plan)
  assert.equal(compiled.plan.durationFrames, 40 * 30, 'the reaction is 40 s at 30 fps')
  assert.notEqual(compiled.plan.durationFrames, 30 * 30, 'the reference is 30 s and is not the output length')

  // The sources are the two artifacts, each declaring the duration the SERVER
  // measured on that file. This is the assertion a mutation battery walked
  // through: replacing the reference's duration with the reaction's — "the two
  // recordings are the same length by assumption", the exact falsifier ADR-135
  // names — changed the stored provenance of the cut and no test noticed.
  assert.deepEqual(
    compiled.plan.sources.map((source) => source.artifactId).sort(),
    [REACTION_ARTIFACT, REFERENCE_ARTIFACT].sort(),
  )
  const declared = new Map(compiled.plan.sources.map((source) => [source.artifactId, source.durationSeconds]))
  assert.equal(declared.get(REACTION_ARTIFACT), 40)
  assert.equal(declared.get(REFERENCE_ARTIFACT), 30)
  assert.notEqual(
    declared.get(REACTION_ARTIFACT),
    declared.get(REFERENCE_ARTIFACT),
    'a sixty-minute reaction to a thirty-minute video is the normal case, not a defect',
  )
  // And the assumption the plan carries quotes both numbers, so a compiler that
  // took one from the other would write a sentence that contradicts the sources.
  const adr135 = compiled.plan.director.assumptions.find((entry) => entry.includes('ADR-135'))
  assert.ok(adr135, `assumptions were ${compiled.plan.director.assumptions.join(' | ')}`)
  assert.match(adr135, /reaction's 40\.000 s/)
  assert.match(adr135, /reference's 30\.000 s/)
  // The compiler asked the project for exactly the two artifacts it declares.
  assert.equal(kit.sources.asked.length, 1)
  assert.equal(kit.sources.asked[0].projectId, PROJECT)
  assert.deepEqual(
    [...kit.sources.asked[0].artifactIds].sort(),
    [REACTION_ARTIFACT, REFERENCE_ARTIFACT].sort(),
  )
  assert.equal(compiled.plan.transitions.length, compiled.plan.videoTracks[0].clips.length - 1)
  assert.ok(compiled.plan.videoTracks[0].clips.every((clip) => clip.rate === 1))
  // Every clip's audio is the reaction's, whatever its picture is — and it is
  // named by MEDIA ARTIFACT id, which is what the render path resolves a plan's
  // sources by. The capture asset id the map carries (`asset-reaction-1`) would
  // have made every source in this plan unresolvable.
  assert.deepEqual(
    [...new Set(compiled.plan.videoTracks[0].clips.map((clip) => clip.audioSourceArtifactId))],
    [REACTION_ARTIFACT],
  )
  // A paused stretch shows the reactor: its picture comes from the reaction.
  const pausedPiece = built.map.pieces.find((piece) => piece.mode === 'paused')
  const pausedClip = compiled.plan.videoTracks[0].clips.find((clip) => clip.id === `clip-${pausedPiece.pieceId}`)
  assert.equal(pausedClip.sourceArtifactId, REACTION_ARTIFACT)
  // The rewind and the seek survive into the plan as markers a person can find.
  const ruleIds = compiled.plan.markers.flatMap((marker) => marker.ruleIds)
  assert.ok(ruleIds.includes('playback:replay'), `markers were ${ruleIds.join(', ')}`)
  assert.ok(ruleIds.includes('playback:seek'), `markers were ${ruleIds.join(', ')}`)
  // The provenance fields say what produced this, and do not impersonate a run.
  assert.equal(compiled.plan.directorRunId, `react-playback:${built.map.mapId}`)
  assert.equal(compiled.plan.director.decisions.length, 0)

  // The falsifier for "the compiler linearised the playback". A map read as a
  // straight run through the reference would produce clips whose reference
  // frames only ever increase and whose reference span equals the timeline.
  // This one does neither: the replay goes back, and the paused and
  // commentary stretches contribute no reference time at all.
  const referenceClips = compiled.plan.videoTracks[0].clips
    .filter((clip) => clip.sourceArtifactId === REFERENCE_ARTIFACT)
  const referenceFrames = referenceClips
    .reduce((total, clip) => total + (clip.sourceOutFrame - clip.sourceInFrame), 0)
  assert.ok(
    referenceFrames < compiled.plan.durationFrames,
    `the reference contributed ${referenceFrames} of ${compiled.plan.durationFrames} frames`,
  )
  assert.ok(
    referenceClips.some((clip, index) => index > 0 && clip.sourceInFrame < referenceClips[index - 1].sourceInFrame),
    'a rewind or replay must appear as a reference frame number that goes backwards',
  )

  const again = await kit.compile({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    projectVersionId: 'version-react-1',
    objective: 'discovery',
    planFps: rational(BigInt(30), BigInt(1)),
  })
  assert.equal(again.replayed, true)
  assert.equal(again.planHash, compiled.planHash)
  assert.equal(kit.snapshots.rows.length, 1)
})

test('T-F4.015 an unresolved map cannot be compiled, and the refusal names the stretch', async () => {
  const fixture = world()
  const kit = wire(fixture)
  await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })

  const error = await kit.compile({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    projectVersionId: 'version-react-1',
    objective: 'discovery',
    planFps: rational(BigInt(30), BigInt(1)),
  }).then(() => null, (caught) => caught)

  assert.equal(error?.code, 'PLAYBACK_MAP_UNRESOLVED')
  assert.equal(error.details.uncovered.length, 1)
  assert.equal(kit.snapshots.rows.length, 0, 'a refused compile must not leave a snapshot behind')
})

test('T-F4.015 a reaction the detector never locked onto is refused by name, not resolved by guess', async () => {
  const fixture = world()
  const silent = fixture.observations.map((observation) => ({
    ...observation,
    referenceTick: null,
    confidence: 0.2,
    peakRatio: 1,
  }))
  const kit = wire(fixture, { observations: silent })

  const error = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
    .then(() => null, (caught) => caught)

  assert.equal(error?.code, 'PLAYBACK_EVIDENCE_INSUFFICIENT')
  assert.equal(error.details.locked, 0)
  assert.equal(
    await kit.maps.readHead({ workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK }),
    null,
    'a map nothing could ever anchor must not become the head',
  )
  // The files were still released on the way out.
  assert.equal(kit.media.state.released, 2)
})

test('T-F4.015 two producers that disagree leave the stretch uncovered instead of picking a winner', async () => {
  const fixture = world()
  const disputed = fixture.observations.flatMap((observation) => {
    if (observation.referenceTick === null) return [observation]
    const second = observation.reactionTick >= BigInt(90_000) * BigInt(2) &&
      observation.reactionTick < BigInt(90_000) * BigInt(4)
    if (!second) return [observation]
    return [observation, {
      ...observation,
      // Eight seconds away: far past the continuity tolerance, so this is two
      // incompatible claims about one instant rather than measurement noise.
      referenceTick: observation.referenceTick + BigInt(90_000) * BigInt(8),
      evidenceRef: `${observation.evidenceRef}:second-producer`,
    }]
  })
  const kit = wire(fixture, { observations: disputed })
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })

  assert.ok(
    built.map.uncovered.some((entry) => entry.reason === 'conflicting-evidence'),
    `uncovered reasons were ${built.map.uncovered.map((entry) => entry.reason).join(', ')}`,
  )
  assert.ok(built.map.warnings.includes('conflicting-evidence'))
  assert.equal(built.map.status, 'needs-input')
})

test('T-F4.015 replacing the reference supersedes the map and drops the anchors that pointed into the old bytes', async () => {
  const fixture = world()
  const shared = memoryPlaybackMaps()
  const kit = wire(fixture, { maps: shared })
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  const head = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  const anchored = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: head.versionRef,
    baseHash: built.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-1',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  })
  assert.equal(anchored.map.anchors.length, 1)

  // The same session, with different bytes behind the reference recording.
  const replacedSession = {
    ...fixture.session,
    tracks: fixture.session.tracks.map((track) =>
      track.role !== 'reference-video' ? track : {
        ...track,
        parts: track.parts.map((part) => ({
          ...part,
          evidence: { ...part.evidence, ingestSha256: 'e'.repeat(64) },
        })),
      }),
  }
  const rebuilt = await wire({ ...fixture, session: replacedSession }, { maps: shared })
    .build({ actor, sessionId: SESSION, ...baseOf(replacedSession) })

  assert.equal(rebuilt.map.version, 3, 'the chain continues; the head is one pointer per reaction track')
  assert.notEqual(rebuilt.map.mapId, built.map.mapId, 'different reference bytes are a different map')
  assert.equal(rebuilt.supersededMapId, built.map.mapId)
  assert.equal(rebuilt.droppedAnchors, 1)
  assert.equal(rebuilt.map.anchors.length, 0)
  assert.equal(rebuilt.manualReviewRequired, true, 'the stretch a person answered is unanswered again')

  const dependents = await kit.dependents({
    workspaceId: WORKSPACE,
    referenceAssetId: REFERENCE_ASSET,
    referenceSha256: fixture.referenceMedia.sha256,
  })
  assert.equal(dependents.length, 2, 'both versions built on the old bytes are listed')
  assert.ok(dependents.every((entry) => entry.isHead === false), 'none of them is the head any more')
})

test('T-F4.015 the stored plan names the version that was compiled, not the one that was built', async () => {
  const fixture = world()
  const kit = wire(fixture)
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  const first = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  const resolved = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: first.versionRef,
    baseHash: built.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-1',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  })
  const compiled = await kit.compile({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    projectVersionId: 'version-react-1',
    objective: 'discovery',
    planFps: rational(BigInt(30), BigInt(1)),
  })

  // A second anchor cannot be placed — the map is resolved — so the staleness
  // is proved by asking the snapshot store what the head no longer matches.
  const latest = await kit.snapshots.readLatestForSource({
    workspaceId: WORKSPACE, origin: 'react-playback', sourceId: built.map.mapId,
  })
  assert.equal(latest.sourceHash, resolved.map.mapHash)
  assert.equal(latest.planHash, compiled.planHash)
  assert.equal(latest.sourceVersion, 2)
  assert.notEqual(latest.sourceHash, built.map.mapHash, 'version 1 is not what was compiled')
})

test('T-F4.015 another workspace cannot read or build over this session', async () => {
  const fixture = world()
  const kit = wire(fixture)
  await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })

  const foreign = { ...actor, workspaceId: OTHER_WORKSPACE }
  const denied = await kit.build({ actor: foreign, sessionId: SESSION, ...baseOf(fixture.session) })
    .then(() => null, (caught) => caught)
  assert.equal(denied?.code, 'CAPTURE_SESSION_NOT_FOUND')

  const missing = await kit.read({
    workspaceId: OTHER_WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  }).then(() => null, (caught) => caught)
  assert.equal(missing?.code, 'PLAYBACK_MAP_NOT_FOUND')
})

test('T-F4.015 a map compiled against a session that has moved past it is refused, naming the session', async () => {
  for (const [what, moved] of [
    ['version', (session) => ({ ...session, version: session.version + 1 })],
    ['referenceEpoch', (session) => ({ ...session, referenceEpoch: session.referenceEpoch + 1 })],
  ]) {
    const fixture = world()
    const kit = wire(fixture, { compileSession: moved(fixture.session) })
    const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
    const head = await kit.read({
      workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
    })
    await kit.anchor({
      actor,
      sessionId: SESSION,
      reactionTrackId: REACTION_TRACK,
      baseVersionId: head.versionRef,
      baseHash: built.map.mapHash,
      anchor: {
        anchorId: 'anchor-ana-1',
        reactionTick: built.map.uncovered[0].range.start,
        referenceTick: null,
        mode: 'commentary-only',
      },
    })

    const error = await kit.compile({
      actor,
      sessionId: SESSION,
      reactionTrackId: REACTION_TRACK,
      projectVersionId: 'version-react-1',
      objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    }).then(() => null, (caught) => caught)

    // The SESSION moved, so the refusal is the session's: a UI told the map was
    // stale would reload the map, which is exactly where it already is.
    assert.equal(error?.code, 'CAPTURE_SESSION_VERSION_STALE', `moving ${what} must be refused`)
    assert.equal(error.details.mapSessionVersion, fixture.session.version)
    assert.equal(error.details.mapReferenceEpoch, fixture.session.referenceEpoch)
    assert.equal(error.details.currentVersion, moved(fixture.session).version)
    assert.equal(kit.snapshots.rows.length, 0, 'a refused compile must not leave a snapshot behind')
  }
})

test('T-F4.015 a recording the project cannot render from is refused before a plan is assembled', async () => {
  const complete = renderSourcesFor(world().session)
  const cases = [
    [
      'not linked to the project',
      complete.filter((entry) => entry.artifactId !== REFERENCE_ARTIFACT),
      'MEDIA_ARTIFACT_NOT_FOUND',
    ],
    [
      'holding different bytes than the map measured',
      complete.map((entry) => entry.artifactId === REFERENCE_ARTIFACT
        ? { ...entry, sha256: 'd'.repeat(64) }
        : entry),
      'MEDIA_ARTIFACT_IDENTITY_MISMATCH',
    ],
    [
      'carrying no measured duration',
      complete.map((entry) => entry.artifactId === REFERENCE_ARTIFACT
        ? { ...entry, durationSeconds: null }
        : entry),
      'INVALID_RENDER_INPUT',
    ],
    [
      'shorter than the cut reads from it',
      complete.map((entry) => entry.artifactId === REFERENCE_ARTIFACT
        ? { ...entry, durationSeconds: 5 }
        : entry),
      'INVALID_RENDER_INPUT',
    ],
  ]
  for (const [what, entries, code] of cases) {
    const fixture = world()
    const kit = wire(fixture, { sources: fakeRenderSources(entries) })
    const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
    const head = await kit.read({
      workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
    })
    await kit.anchor({
      actor,
      sessionId: SESSION,
      reactionTrackId: REACTION_TRACK,
      baseVersionId: head.versionRef,
      baseHash: built.map.mapHash,
      anchor: {
        anchorId: 'anchor-ana-1',
        reactionTick: built.map.uncovered[0].range.start,
        referenceTick: null,
        mode: 'commentary-only',
      },
    })

    const error = await kit.compile({
      actor,
      sessionId: SESSION,
      reactionTrackId: REACTION_TRACK,
      projectVersionId: 'version-react-1',
      objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    }).then(() => null, (caught) => caught)

    assert.equal(error?.code, code, `a reference ${what} must be refused`)
    assert.equal(kit.snapshots.rows.length, 0, 'a refused compile must not leave a snapshot behind')
  }
})

test('T-F4.015 a rebuild reports the compiled plan it stranded, and so does the anchor that follows it', async () => {
  const fixture = world()
  const maps = memoryPlaybackMaps()
  const snapshots = memorySnapshots()
  const kit = wire(fixture, { maps, snapshots })
  const built = await kit.build({ actor, sessionId: SESSION, ...baseOf(fixture.session) })
  assert.equal(built.invalidated, null, 'the first build had nothing to strand')
  const head = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  const resolved = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: head.versionRef,
    baseHash: built.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-1',
      reactionTick: built.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  })
  assert.equal(resolved.invalidated, null, 'nothing had been compiled yet')
  const compiled = await kit.compile({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    projectVersionId: 'version-react-1',
    objective: 'discovery',
    planFps: rational(BigInt(30), BigInt(1)),
  })

  // The session gains a version — a track added, a lineage event — without the
  // two recordings changing. The rebuild therefore keeps the map id, advances
  // the chain, and leaves the stretch the operator answered uncovered again.
  const moved = { ...fixture.session, version: fixture.session.version + 1 }
  const rebuilt = await wire({ ...fixture, session: moved }, { maps, snapshots })
    .build({ actor, sessionId: SESSION, ...baseOf(moved) })
  assert.equal(rebuilt.map.version, 3)
  assert.equal(rebuilt.manualReviewRequired, true, 'the answered stretch is unanswered again')
  assert.ok(rebuilt.invalidated, 'the rebuild moved the head out from under a compiled plan')
  assert.equal(rebuilt.invalidated.planId, compiled.plan.id)
  assert.equal(rebuilt.invalidated.planHash, compiled.planHash)
  assert.equal(
    rebuilt.invalidated.compiledFromHash,
    resolved.map.mapHash,
    'the plan still describes version 2, which is no longer the head',
  )

  // And the anchor that answers the rebuilt map says the same thing, which is
  // the case the old comparison — "compiled from exactly this version" — could
  // never reach: compiling refuses an uncovered map and anchoring refuses an
  // instant that is not inside an uncovered stretch, so the two were mutually
  // exclusive and the field was always null.
  const rebuiltHead = await kit.read({
    workspaceId: WORKSPACE, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
  })
  const answered = await kit.anchor({
    actor,
    sessionId: SESSION,
    reactionTrackId: REACTION_TRACK,
    baseVersionId: rebuiltHead.versionRef,
    baseHash: rebuilt.map.mapHash,
    anchor: {
      anchorId: 'anchor-ana-2',
      reactionTick: rebuilt.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
    },
  })
  assert.equal(answered.map.version, 4)
  assert.ok(answered.invalidated, 'the stored plan describes neither version 3 nor version 4')
  assert.equal(answered.invalidated.planId, compiled.plan.id)
  assert.equal(answered.invalidated.compiledFromHash, resolved.map.mapHash)
})

test('T-F4.015 a session id at the domain limit still yields a map id the domain accepts', async () => {
  // `createPlaybackMap` refuses an id outside this, and a session id may be 128
  // characters on its own, so `<session>:<track>:playback-<n>` overflows.
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
  const shared = 'a'.repeat(111)
  const ids = [`${shared}${'x'.repeat(17)}`, `${shared}${'y'.repeat(17)}`]
  const produced = []
  for (const sessionId of ids) {
    assert.equal(sessionId.length, 128)
    const fixture = world()
    const long = createCaptureSession({
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      sessionId,
      clock: { timebase: fixture.session.clock.timebase, rounding: fixture.session.clock.rounding },
      referenceTrackId: 'track-reference',
      tracks: fixture.session.tracks,
      lineage: {
        commandId: 'command-create-long',
        operation: 'create-session',
        actorKind: 'human',
        actorId: 'operator-ana',
        occurredAt: at(0),
        note: null,
      },
      createdAt: at(0),
    })
    const kit = wire({ ...fixture, session: long })
    const built = await kit.build({ actor, sessionId, ...baseOf(long) })
    produced.push(built.map.mapId)
    assert.ok(built.map.mapId.length <= 128, `the map id was ${built.map.mapId.length} characters`)
    assert.match(built.map.mapId, ID)
    assert.ok(
      built.map.mapId.startsWith(shared),
      'the id keeps a readable head; a digest alone would name nothing',
    )
  }
  // Two sessions sharing the first 111 characters are the collision truncation
  // alone would create. The digest is what keeps them two maps.
  assert.notEqual(produced[0], produced[1])
})

test('T-F4.015 the migration CHECK names exactly the origins the compilers can produce', () => {
  const sql = readFileSync(
    'prisma/v2/migrations/20260905150000_renderable_plan_snapshots/migration.sql',
    'utf8',
  )
  const clause = /"origin" IN \(([^)]+)\)/.exec(sql)
  assert.ok(clause, 'the origin CHECK must exist')
  const named = clause[1].split(',').map((entry) => entry.trim().replaceAll("'", ''))
  // Spread from the domain constant rather than retyped: on Wave 19 every enum
  // written from memory was wrong.
  assert.deepEqual(named.sort(), [...RENDERABLE_PLAN_ORIGINS].sort())
})

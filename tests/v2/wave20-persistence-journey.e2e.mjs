import assert from 'node:assert/strict'
import test from 'node:test'

import { createMemoryPrismaClient } from './memory-prisma.mjs'

/**
 * F4.012–F4.015 — the Wave 20 repositories, read back.
 *
 * The PostgreSQL suite beside this one cannot run without a database, and the
 * machine this was written on has none. What that leaves unproven is not the
 * SQL — it is the mapping: whether every field of an aggregate reaches a column
 * and comes back into the same field, in the same order, with the optional keys
 * still absent. A round trip that loses one number fails its own hash, so the
 * repository would refuse everything it ever wrote, and nothing else in the
 * build would notice.
 *
 * So the client here is backed by the real `Prisma.dmmf`: the columns and their
 * NOT NULL flags, the unique key sets, and the relation joins all come from the
 * schema rather than from this file's opinion of it. A forgotten column is a
 * named failure, a duplicate natural key raises P2002 so the replay branch is
 * the real one, and the head fence's `updateMany` returns a real count.
 *
 * It cannot check the CHECK and EXCLUDE constraints, the foreign keys, the
 * driver's 64-bit integers, or two writers racing. Those are what
 * `wave20-persistence.e2e.mjs` is for, and they remain unrun.
 */

const A = 'w20j-workspace-a'
const B = 'w20j-workspace-b'
const SESSION = 'w20j-session'
const REACT = 'w20j-react'
const REACTION_TRACK = 'track-reaction'
const PROJECT_A = 'w20j-project-a'
const PROJECT_B = 'w20j-project-b'
const VERSION_A = 'w20j-version-a'
const VERSION_B = 'w20j-version-b'

const at = (second) => new Date(Date.parse('2029-05-03T09:00:00.000Z') + second * 1_000).toISOString()
const digest = (character) => character.repeat(64)

async function load() {
  const { stringifyWithTicks } = await import('../../src/v2/infrastructure/prisma/bigint-json.ts')
  const { calculateMulticamDirectionHash } = await import('../../src/v2/domain/multicam-direction.ts')
  const { calculateMulticamMatchPlanHash } = await import('../../src/v2/domain/multicam-match-plan.ts')
  const { PrismaMulticamDirectionRepository } = await import(
    '../../src/v2/infrastructure/prisma/multicam-direction-repository.ts'
  )
  const {
    PrismaCameraColorMeasurementRepository,
    PrismaMulticamMatchPlanRepository,
  } = await import('../../src/v2/infrastructure/prisma/multicam-match-plan-repository.ts')
  const { PrismaColorCriticReportRepository } = await import(
    '../../src/v2/infrastructure/prisma/color-critic-report-repository.ts'
  )
  const { PrismaPlaybackMapRepository } = await import(
    '../../src/v2/infrastructure/prisma/playback-map-repository.ts'
  )
  const fixtures = await import('./wave20-fixtures.mjs')
  return {
    stringifyWithTicks,
    calculateMulticamDirectionHash,
    calculateMulticamMatchPlanHash,
    PrismaMulticamDirectionRepository,
    PrismaCameraColorMeasurementRepository,
    PrismaMulticamMatchPlanRepository,
    PrismaColorCriticReportRepository,
    PrismaPlaybackMapRepository,
    ...fixtures,
  }
}

/** Byte-identity, not "looks the same": the canonical bytes and the shape. */
function identical(stringifyWithTicks, stored, built, what) {
  assert.equal(stringifyWithTicks(stored), stringifyWithTicks(built), `${what} did not survive the round trip`)
  assert.deepEqual(stored, built, `${what} came back structurally different`)
}

async function refusedOnRead(read, what) {
  await assert.rejects(read, (error) => {
    assert.equal(error.code, 'PERSISTENCE_CONFLICT', `${what}: ${error.code} — ${error.message}`)
    return true
  }, `${what} was believed after being edited underneath`)
}

test('T-F4.012 a multicam direction and its evidence come back as they were written', async () => {
  const kit = await load()
  const client = createMemoryPrismaClient()
  const directions = new kit.PrismaMulticamDirectionRepository(client)
  const worldA = kit.buildDirectionWorld({ workspaceId: A, sessionId: SESSION, projectId: PROJECT_A })
  const worldB = kit.buildDirectionWorld({ workspaceId: B, sessionId: SESSION, projectId: PROJECT_B })

  // The fixture is the unhealthy one: the cameras stop before the directed
  // range does, so this is not the happy path a naive mapping also survives.
  assert.ok(worldA.direction.uncovered.length >= 1, 'the fixture must carry an uncovered stretch')
  assert.ok(worldA.direction.manualReviewRequired, 'the fixture must need a person')
  assert.ok(
    worldA.direction.shots.some((shot) => shot.chosen.activeSpeaker !== null) &&
      worldA.direction.shots.some((shot) => shot.chosen.activeSpeaker === null),
    'both candidate evidence shapes must be present, so the JSON column is exercised either way',
  )

  assert.equal((await directions.persistEvidenceSet({ set: worldA.evidence, createdAt: at(1) })).replayed, false)
  assert.equal(
    (await directions.persistEvidenceSet({ set: worldA.evidence, createdAt: at(2) })).replayed,
    true,
    'the same evidence written twice is one set',
  )
  identical(
    kit.stringifyWithTicks,
    await directions.readEvidenceSet({ workspaceId: A, evidenceHash: worldA.evidence.evidenceHash }),
    worldA.evidence,
    'the evidence set',
  )
  assert.equal(
    await directions.readEvidenceSet({ workspaceId: B, evidenceHash: worldA.evidence.evidenceHash }),
    null,
    'workspace B could read workspace A evidence by its hash',
  )

  const first = await directions.appendVersion({ direction: worldA.direction, base: null, occurredAt: at(3) })
  assert.equal(first.stored.version, 1)
  assert.equal(first.replayed, false)
  identical(kit.stringifyWithTicks, first.stored.direction, worldA.direction, 'direction version 1')
  assert.equal(
    (await directions.appendVersion({ direction: worldA.direction, base: null, occurredAt: at(4) })).replayed,
    true,
    'the same direction written twice is one version',
  )

  // The same decisions generated a second later: a different body, a different
  // hash, and nothing else changed.
  const { directionHash: _replaced, ...body } = worldA.direction
  const moved = { ...body, generatedAt: new Date(Date.parse(body.generatedAt) + 1_000).toISOString() }
  const laterVersion = Object.freeze({ ...moved, directionHash: kit.calculateMulticamDirectionHash(moved) })
  assert.notEqual(laterVersion.directionHash, worldA.direction.directionHash)

  // The fence is the pair, not the number: a version alone can be handed out
  // again after a write that failed halfway, and this names the right version
  // with the wrong hash.
  await assert.rejects(
    () => directions.appendVersion({
      direction: laterVersion,
      base: { version: 1, directionHash: digest('9') },
      occurredAt: at(5),
    }),
    (error) => {
      assert.equal(error.code, 'PERSISTENCE_CONFLICT')
      assert.equal(error.details.currentVersion, 1)
      assert.equal(error.details.currentHash, worldA.direction.directionHash)
      return true
    },
    'a stale base hash advanced the head',
  )
  assert.equal(
    await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 2 }),
    null,
    'the refused append left a version 2 behind',
  )
  const advanced = await directions.appendVersion({
    direction: laterVersion,
    base: { version: 1, directionHash: worldA.direction.directionHash },
    occurredAt: at(6),
  })
  assert.equal(advanced.stored.version, 2)
  assert.equal(advanced.stored.previousVersionHash, worldA.direction.directionHash)
  identical(
    kit.stringifyWithTicks,
    (await directions.readHead({ workspaceId: A, sessionId: SESSION })).direction,
    laterVersion,
    'the direction head',
  )
  identical(
    kit.stringifyWithTicks,
    (await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 })).direction,
    worldA.direction,
    'direction version 1 after version 2 arrived',
  )

  // Workspace B keeps its own chain for a session with the same id.
  await directions.persistEvidenceSet({ set: worldB.evidence, createdAt: at(7) })
  await directions.appendVersion({ direction: worldB.direction, base: null, occurredAt: at(7) })
  const headB = await directions.readHead({ workspaceId: B, sessionId: SESSION })
  assert.equal(headB.version, 1, 'workspace B saw the chain next door instead of its own')
  identical(kit.stringifyWithTicks, headB.direction, worldB.direction, 'the workspace B direction')

  const dependents = await directions.findDependents({
    workspaceId: A, diagnosticHash: worldA.direction.diagnosticHash,
  })
  assert.equal(dependents.length, 2, 'both versions name the diagnostic they were computed from')
  assert.deepEqual(dependents.map((entry) => entry.isHead).sort(), [false, true])

  // A shot whose confidence and band were edited together is still a legal row
  // — the band really is the confidence read through the floors — and is still
  // refused, because the hash covers both.
  const shotRow = client.rows('V2MulticamShotDecision')
    .find((row) => row.workspaceId === A && row.directionId.endsWith('md1') && row.ordinal === 0)
  const original = { confidence: shotRow.confidence, confidenceBand: shotRow.confidenceBand }
  shotRow.confidence = 0.95
  shotRow.confidenceBand = 'high'
  await refusedOnRead(
    () => directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 }),
    'a shot whose confidence was raised underneath the reader',
  )
  Object.assign(shotRow, original)
  identical(
    kit.stringifyWithTicks,
    (await directions.readVersion({ workspaceId: A, sessionId: SESSION, version: 1 })).direction,
    worldA.direction,
    'direction version 1 once the edit was undone',
  )

  console.log(
    `direction round trip: ${worldA.direction.shots.length} shots, ` +
      `${worldA.direction.uncovered.length} uncovered, ` +
      `${client.rows('V2MulticamAngleScoreComponent').length} score components stored`,
  )
})

test('T-F4.013 a colour measurement and a clamped match plan come back as they were written', async () => {
  const kit = await load()
  const client = createMemoryPrismaClient()
  const measurements = new kit.PrismaCameraColorMeasurementRepository(client)
  const plans = new kit.PrismaMulticamMatchPlanRepository(client)
  const matchA = kit.buildMatchWorld({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION })
  const matchB = kit.buildMatchWorld({ workspaceId: B, projectId: PROJECT_B, sessionId: SESSION })

  // Camera B is two and a half stops under its reference: the correction is
  // clamped and a person is asked, so `humanReviewRequired` is derived here
  // rather than declared.
  assert.ok(matchA.plan.humanReviewRequired)
  assert.ok(matchA.plan.issues.some((issue) => issue.humanReviewRequired))

  assert.equal(
    (await measurements.persist({ workspaceId: A, measurement: matchA.measurements[0], createdAt: at(10) })).replayed,
    false,
  )
  assert.equal(
    (await measurements.persist({ workspaceId: A, measurement: matchA.measurements[0], createdAt: at(11) })).replayed,
    true,
    'the same measurement written twice is one measurement',
  )
  const storedMeasurement = await measurements.read({
    workspaceId: A, measurementId: matchA.measurements[0].measurementId,
  })
  identical(kit.stringifyWithTicks, storedMeasurement, matchA.measurements[0], 'the camera colour measurement')
  // Not measured is the absence of a number, and the absence survives: the skin
  // dimension comes back with a reason and no `value` key at all.
  assert.equal(storedMeasurement.dimensions.skin.status, 'not-applicable')
  assert.equal(Object.hasOwn(storedMeasurement.dimensions.skin, 'value'), false)
  assert.equal(
    await measurements.read({ workspaceId: B, measurementId: matchA.measurements[0].measurementId }),
    null,
    'workspace B could read a workspace A measurement',
  )

  const stored = await plans.appendVersion({ plan: matchA.plan, base: null, occurredAt: at(12) })
  assert.equal(stored.stored.version, 1)
  identical(kit.stringifyWithTicks, stored.stored.plan, matchA.plan, 'match plan version 1')
  assert.equal(
    (await plans.appendVersion({ plan: matchA.plan, base: null, occurredAt: at(13) })).replayed,
    true,
    'the same plan written twice is one version',
  )

  // The next version has to be a different body: the chain is unique on
  // (workspace, planHash), so re-offering version 1's bytes as version 2 is
  // refused by the index before the head fence is ever consulted.
  const { planHash: _replaced, ...planBody } = matchA.plan
  const movedPlan = { ...planBody, createdAt: new Date(Date.parse(planBody.createdAt) + 1_000).toISOString() }
  const laterPlan = Object.freeze({ ...movedPlan, planHash: kit.calculateMulticamMatchPlanHash(movedPlan) })
  assert.notEqual(laterPlan.planHash, matchA.plan.planHash)

  await assert.rejects(
    () => plans.appendVersion({
      plan: laterPlan, base: { version: 1, planHash: digest('9') }, occurredAt: at(14),
    }),
    (error) => {
      assert.equal(error.code, 'PERSISTENCE_CONFLICT')
      assert.equal(error.details.currentVersion, 1)
      assert.equal(error.details.currentHash, matchA.plan.planHash)
      return true
    },
    'a stale base hash advanced the match plan head',
  )
  assert.equal(
    await plans.readVersion({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION, version: 2 }),
    null,
    'the refused append left a version 2 behind',
  )

  const advancedPlan = await plans.appendVersion({
    plan: laterPlan, base: { version: 1, planHash: matchA.plan.planHash }, occurredAt: at(16),
  })
  assert.equal(advancedPlan.stored.version, 2)
  assert.equal(advancedPlan.stored.previousVersionHash, matchA.plan.planHash)
  identical(
    kit.stringifyWithTicks,
    (await plans.readVersion({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION, version: 1 })).plan,
    matchA.plan,
    'match plan version 1 after version 2 arrived',
  )

  await plans.appendVersion({ plan: matchB.plan, base: null, occurredAt: at(15) })
  identical(
    kit.stringifyWithTicks,
    (await plans.readHead({ workspaceId: B, projectId: PROJECT_B, sessionId: SESSION })).plan,
    matchB.plan,
    'the workspace B match plan',
  )
  assert.equal(
    await plans.readHead({ workspaceId: A, projectId: PROJECT_B, sessionId: SESSION }),
    null,
    'workspace A could read a workspace B plan by naming its project',
  )
  const dependents = await plans.findDependents({
    workspaceId: A, measurementId: matchA.measurements[1].measurementId,
  })
  assert.equal(dependents.length, 2, 'both versions were built on that measurement')
  assert.deepEqual(dependents.map((entry) => entry.isHead).sort(), [false, true])

  const transformRow = client.rows('V2CameraMatchTransform').find((row) => row.workspaceId === A)
  const confidence = transformRow.confidence
  transformRow.confidence = 0.5
  await refusedOnRead(
    () => plans.readVersion({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION, version: 1 }),
    'a match transform whose confidence was lowered underneath the reader',
  )
  transformRow.confidence = confidence

  console.log(
    `match round trip: ${matchA.plan.cameraTransforms.length} transform(s), ` +
      `${matchA.plan.issues.length} issues, ` +
      `${client.rows('V2ColorMeasurementComponent').length} measurement components stored`,
  )
})

test('T-F4.014 a colour critic report is content-addressed and comes back as it was written', async () => {
  const kit = await load()
  const client = createMemoryPrismaClient()
  const reports = new kit.PrismaColorCriticReportRepository(client)
  const matchA = kit.buildMatchWorld({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION })
  const matchB = kit.buildMatchWorld({ workspaceId: B, projectId: PROJECT_B, sessionId: SESSION })
  const reportA = kit.buildCriticReport({
    workspaceId: A, projectId: PROJECT_A, projectVersionId: VERSION_A,
    reportId: 'w20j-report-a', matchPlan: matchA.plan,
  })
  const reportB = kit.buildCriticReport({
    workspaceId: B, projectId: PROJECT_B, projectVersionId: VERSION_B,
    reportId: 'w20j-report-b', matchPlan: matchB.plan,
  })

  assert.equal(reportA.dimensions.length, 12, 'every dimension answers, even when the answer is "not read"')
  assert.ok(reportA.dimensions.some((dimension) => dimension.status !== 'measured'))

  assert.equal((await reports.persist({ report: reportA, createdAt: at(20) })).replayed, false)
  assert.equal(
    (await reports.persist({ report: reportA, createdAt: at(21) })).replayed,
    true,
    'the same bytes judged against the same thresholds are one report',
  )
  identical(
    kit.stringifyWithTicks,
    await reports.read({ workspaceId: A, reportId: reportA.reportId }),
    reportA,
    'the colour critic report',
  )
  identical(
    kit.stringifyWithTicks,
    await reports.readByHash({ workspaceId: A, reportHash: reportA.reportHash }),
    reportA,
    'the colour critic report read by hash',
  )
  // The dimensions come back in COLOR_CRITIC_DIMENSIONS order, not the
  // alphabetical order a column sort would give: `cast` is third, not first.
  assert.equal(
    (await reports.read({ workspaceId: A, reportId: reportA.reportId })).dimensions[0].dimension,
    'clipping',
  )
  assert.equal(
    await reports.read({ workspaceId: B, reportId: reportA.reportId }),
    null,
    'workspace B could read a workspace A verdict',
  )

  await reports.persist({ report: reportB, createdAt: at(22) })
  assert.equal(
    (await reports.listForProjectVersion({
      workspaceId: A, projectId: PROJECT_A, projectVersionId: VERSION_A,
    })).length,
    1,
    'the project version listing crossed a workspace',
  )
  const dependents = await reports.findDependentsOfMatchPlan({
    workspaceId: A, matchPlanId: reportA.matchPlanId,
  })
  assert.equal(dependents.length, 1)
  assert.equal(dependents[0].action, reportA.action)

  // A second verdict about a different subject is a second row, not an edit of
  // the first: the report before it must still read back unchanged.
  const secondReport = kit.buildCriticReport({
    workspaceId: A, projectId: PROJECT_A, projectVersionId: VERSION_A,
    reportId: 'w20j-report-a2', matchPlan: matchA.plan,
  })
  assert.notEqual(secondReport.reportHash, reportA.reportHash)
  await reports.persist({ report: secondReport, createdAt: at(23) })
  identical(
    kit.stringifyWithTicks,
    await reports.read({ workspaceId: A, reportId: reportA.reportId }),
    reportA,
    'the first report after a second one was stored',
  )

  const reportRow = client.rows('V2ColorCriticReport').find((row) => row.reportId === reportA.reportId)
  const original = { confidence: reportRow.confidence, confidenceBand: reportRow.confidenceBand }
  reportRow.confidence = 0.9
  reportRow.confidenceBand = 'high'
  await refusedOnRead(
    () => reports.read({ workspaceId: A, reportId: reportA.reportId }),
    'a verdict whose confidence was edited underneath the reader',
  )
  Object.assign(reportRow, original)
  identical(
    kit.stringifyWithTicks,
    await reports.read({ workspaceId: A, reportId: reportA.reportId }),
    reportA,
    'the restored report',
  )

  console.log(
    `critic round trip: cause=${reportA.cause} action=${reportA.action} ` +
      `dimensions=${reportA.dimensions.length} issues=${reportA.issues.length}`,
  )
})

test('T-F4.015 a react playback map survives its own anchor and keeps the version before it', async () => {
  const kit = await load()
  const client = createMemoryPrismaClient()
  const maps = new kit.PrismaPlaybackMapRepository(client)
  const playbackA = kit.buildPlaybackWorld({ workspaceId: A, sessionId: REACT, projectId: PROJECT_A })
  const playbackB = kit.buildPlaybackWorld({ workspaceId: B, sessionId: REACT, projectId: PROJECT_B })

  // A pause, a commentary, a replay, a seek and a stretch where the player was
  // hidden. Continuous playback is the one case a naive mapping also gets right.
  assert.equal(playbackA.map.status, 'needs-input')
  assert.ok(playbackA.map.pieces.some((piece) => piece.mode === 'paused' && piece.rate === null))
  assert.ok(playbackA.map.pieces.some((piece) => piece.mode === 'replay' && piece.direction === 'backward'))
  assert.ok(playbackA.map.pieces.some((piece) => piece.mode === 'seek' && piece.discontinuityReason === 'seek'))

  assert.equal((await maps.appendVersion({ map: playbackA.map, occurredAt: at(30) })).replayed, false)
  identical(
    kit.stringifyWithTicks,
    await maps.readHead({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK }),
    playbackA.map,
    'playback map version 1',
  )
  assert.equal(
    (await maps.appendVersion({ map: playbackA.map, occurredAt: at(31) })).replayed,
    true,
    'the same map written twice is one version',
  )

  const anchored = kit.anchorPlaybackMap(playbackA.map, {
    anchorId: 'w20j-anchor-1',
    actorId: 'operator-7',
    note: 'the player was off screen for this stretch',
    createdAt: at(32),
  })
  assert.equal(anchored.version, 2)
  assert.equal(anchored.previousVersionHash, playbackA.map.mapHash)
  await assert.rejects(
    () => maps.appendVersion({
      map: anchored, expectedVersion: 1, expectedHash: digest('9'), occurredAt: at(33),
    }),
    (error) => {
      assert.equal(error.code, 'PLAYBACK_MAP_VERSION_STALE')
      assert.equal(error.details.currentVersion, 1)
      assert.equal(error.details.currentHash, playbackA.map.mapHash)
      return true
    },
    'a stale expected hash advanced the playback head',
  )
  await maps.appendVersion({ map: anchored, occurredAt: at(34) })
  identical(
    kit.stringifyWithTicks,
    await maps.readHead({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK }),
    anchored,
    'playback map version 2',
  )
  identical(
    kit.stringifyWithTicks,
    await maps.readVersion({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK, version: 1 }),
    playbackA.map,
    'playback map version 1 after the anchor',
  )

  // CONTRACT §2: the actor is projected out of the evidence string the domain
  // wrote, never invented, and the note never replaces it.
  const anchorRow = client.rows('V2PlaybackAnchor').find((row) => row.anchorId === 'w20j-anchor-1')
  assert.equal(anchorRow.actorKind, 'human')
  assert.equal(anchorRow.actorId, 'operator-7')
  assert.equal(anchorRow.note, 'the player was off screen for this stretch')
  assert.equal(anchorRow.evidenceRef, 'operator:operator-7 (the player was off screen for this stretch)')

  await maps.appendVersion({ map: playbackB.map, occurredAt: at(35) })
  assert.equal(
    (await maps.readHead({ workspaceId: B, sessionId: REACT, reactionTrackId: REACTION_TRACK })).version,
    1,
    'workspace B saw the chain next door instead of its own',
  )
  const dependents = await maps.findDependentsOfReference({
    workspaceId: A,
    referenceAssetId: playbackA.map.referenceMedia.assetId,
    referenceSha256: playbackA.map.referenceMedia.sha256,
  })
  assert.equal(dependents.length, 2, 'both versions depend on the same reference bytes')
  assert.deepEqual(dependents.map((entry) => entry.isHead).sort(), [false, true])

  const pieceRow = client.rows('V2PlaybackPiece')
    .find((row) => row.workspaceId === A && row.mapId.endsWith('pm1') && row.ordinal === 0)
  assert.equal(typeof pieceRow.reactionEndTicks, 'bigint')
  const confidence = pieceRow.confidence
  pieceRow.confidence = 0.5
  await refusedOnRead(
    () => maps.readVersion({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK, version: 1 }),
    'a playback piece whose confidence was edited underneath the reader',
  )
  pieceRow.confidence = confidence

  console.log(
    `playback round trip: v1 pieces=${playbackA.map.pieces.length} status=${playbackA.map.status}, ` +
      `v2 pieces=${anchored.pieces.length} status=${anchored.status}`,
  )
})

test('T-F4.015 anchors answered out of tick order come back in the order they were placed', async () => {
  const kit = await load()
  const client = createMemoryPrismaClient()
  const maps = new kit.PrismaPlaybackMapRepository(client)

  // Two stretches the map refuses to guess at, and an operator who answers the
  // LATER one first — the ordinary case where the second stretch is the one on
  // screen. `applyPlaybackAnchor` appends, so the anchor array is [late, early]
  // and the map hash covers it in exactly that order. Storing the anchors
  // without their position and re-deriving the order on read by
  // `(reactionTick, anchorId)` handed back [early, late]: a different hash, a
  // PERSISTENCE_CONFLICT, and a version that was written successfully and could
  // never be read again.
  const world = kit.buildPlaybackWorld({
    workspaceId: A, sessionId: REACT, projectId: PROJECT_A, uncoveredStretches: 2,
  })
  assert.equal(world.map.uncovered.length, 2, 'the fixture must leave two stretches for a person')

  const late = kit.anchorPlaybackMap(world.map, {
    anchorId: 'w20j-anchor-late', actorId: 'operator-7',
    note: 'the player was off screen here', createdAt: at(40), stretch: 1,
  })
  const both = kit.anchorPlaybackMap(late, {
    anchorId: 'w20j-anchor-early', actorId: 'operator-7',
    note: 'phone rang, player hidden', createdAt: at(41), stretch: 0,
  })
  assert.deepEqual(
    both.anchors.map((anchor) => anchor.anchorId),
    ['w20j-anchor-late', 'w20j-anchor-early'],
    'the domain appends anchors; it does not sort them',
  )
  assert.ok(
    both.anchors[0].reactionTick > both.anchors[1].reactionTick,
    'the stored order must not be tick order, or this test proves nothing',
  )

  for (const [map, second] of [[world.map, 42], [late, 43], [both, 44]]) {
    await maps.appendVersion({ map, occurredAt: at(second) })
  }
  for (const [version, expected] of [[1, world.map], [2, late], [3, both]]) {
    identical(
      kit.stringifyWithTicks,
      await maps.readVersion({ workspaceId: A, sessionId: REACT, reactionTrackId: REACTION_TRACK, version }),
      expected,
      `playback map version ${version} with anchors out of tick order`,
    )
  }

  // The position is a stored column, not a re-derivation: row 0 is the late
  // anchor because that is where the map put it.
  const stored = client.rows('V2PlaybackAnchor')
    .filter((row) => row.workspaceId === A && row.mapId.endsWith('pm3'))
    .sort((left, right) => left.ordinal - right.ordinal)
  assert.deepEqual(
    stored.map((row) => [row.ordinal, row.anchorId]),
    [[0, 'w20j-anchor-late'], [1, 'w20j-anchor-early']],
  )

  console.log(
    `playback anchor order: stored ${stored.map((row) => `${row.ordinal}:${row.anchorId}`).join(' ')}`,
  )
})

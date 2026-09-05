import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * F4.015 — the react playback journey against a real PostgreSQL.
 *
 * The in-memory suite beside this one (`playback-map-service.test.mjs`) proves
 * the decisions. It cannot prove any of the four things below, and neither can
 * a fake that was written by the same person as the repository:
 *
 * - **Hydration is verified by hash.** A piece edited underneath the
 *   application makes the map unreadable rather than making the compiler cut
 *   from numbers nobody derived.
 * - **The refusal of a second writer is a constraint.** Two operators anchoring
 *   the same stretch from two machines both compute version 2; one of them has
 *   to lose to the database, not to a `SELECT` somebody remembered to run.
 * - **Workspace isolation is a key, not a `WHERE`.** Workspace B reads nothing
 *   of workspace A's map even asking for it by name.
 * - **The CHECKs on the plan snapshot refuse what the application refuses.**
 *   A row whose `clipCount` disagrees with the plan it stores, or whose origin
 *   is a compiler nobody wrote, is rejected by the server.
 *
 * The domain arrives through `await import` inside the test, never a static
 * specifier: tsx resolves a static `.ts` import before it transforms the target
 * and the file dies at link time.
 */

const RUN = process.env.APOLLO_PLAYBACK_MAP_E2E === '1'

const A = 'pm-e2e-workspace-a'
const B = 'pm-e2e-workspace-b'
const PROJECT_A = 'pm-e2e-project-a'
const PROJECT_B = 'pm-e2e-project-b'
const SESSION = 'pm-e2e-session'
const REACTION_TRACK = 'track-reaction'
const VERSION_A = 'pm-e2e-version-a'

const at = (second) => new Date(Date.parse('2029-07-01T09:00:00.000Z') + second * 1_000)
const iso = (second) => at(second).toISOString()
const hash = (character) => character.repeat(64)

test(
  'E2E-F4.015 a react playback map is derived, anchored, compiled and read back from PostgreSQL',
  { skip: RUN ? false : 'set APOLLO_PLAYBACK_MAP_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { PrismaPlaybackMapRepository } = await import(
      '../../src/v2/infrastructure/prisma/playback-map-repository.ts'
    )
    const { PrismaRenderablePlanSnapshotRepository } = await import(
      '../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'
    )
    const {
      buildReactPlaybackMapService,
      compileReactPlaybackPlanService,
      editReactPlaybackAnchorService,
      readReactPlaybackMapService,
    } = await import('../../src/v2/application/react-playback-map.ts')
    const { validateDirectedEditPlan } = await import('../../src/v2/domain/director-run.ts')
    const { applyPlaybackAnchor } = await import('../../src/v2/domain/playback-map.ts')
    const { rational } = await import('../../src/v2/domain/session-time.ts')
    const { buildPlaybackWorld } = await import('./wave20-fixtures.mjs')

    const client = new PrismaClient()
    const clean = async () => {
      for (const table of [
        client.v2RenderablePlanSnapshot,
        client.v2PlaybackUncoveredRange, client.v2PlaybackAnchor, client.v2PlaybackPiece,
        client.v2PlaybackMapHead, client.v2PlaybackMap,
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      }
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2Project.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2Workspace.deleteMany({ where: { id: { in: [A, B] } } })
    }

    t.after(async () => {
      // Reported rather than rethrown: a cleanup failure that masks the real
      // assertion turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })
    await clean()

    const workspaces = new PrismaWorkspaceRepository(client)
    for (const id of [A, B]) {
      await workspaces.create(createWorkspace({
        id, slug: id, name: 'Playback E2E', status: 'active', createdAt: iso(0),
      }))
    }
    for (const [projectId, workspaceId] of [[PROJECT_A, A], [PROJECT_B, B]]) {
      await client.v2Project.create({
        data: {
          id: projectId, workspaceId, name: 'Playback E2E', status: 'reviewing-proxy',
          objective: 'discovery', format: '9:16', locale: 'pt-BR',
          createdByType: 'api-client', createdById: 'pm-e2e-client',
          createdAt: at(0), updatedAt: at(0),
        },
      })
    }
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `pm-e2e-snapshot-${kind}`, workspaceId: A, projectId: PROJECT_A, kind,
          schemaVersion: 1, contentJson: JSON.stringify({ kind }), contentHash: hash('1'),
          createdAt: at(0),
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: VERSION_A, workspaceId: A, projectId: PROJECT_A, sequence: 1,
        briefSnapshotId: 'pm-e2e-snapshot-brief',
        editPlanSnapshotId: 'pm-e2e-snapshot-edit-plan',
        policiesSnapshotId: 'pm-e2e-snapshot-policies',
        baseHash: hash('2'), createdBy: 'pm-e2e-client', createdAt: at(0),
      },
    })
    for (const [workspaceId, projectId] of [[A, PROJECT_A], [B, PROJECT_B]]) {
      await client.v2CaptureSessionHead.create({
        data: {
          id: `${workspaceId}:${SESSION}`, workspaceId, projectId, sessionId: SESSION,
          version: 1, sessionHash: hash('3'), status: 'synced',
          createdAt: at(0), updatedAt: at(0),
        },
      })
    }

    // The slice C fixture: a reaction with a pause, a commentary, a replay, a
    // seek and a stretch where the player was hidden.
    const world = buildPlaybackWorld({ workspaceId: A, projectId: PROJECT_A, sessionId: SESSION })
    const maps = new PrismaPlaybackMapRepository(client)
    const snapshots = new PrismaRenderablePlanSnapshotRepository(client)
    let seconds = 0
    const clock = () => at((seconds += 1))
    const sessions = {
      async readHead({ workspaceId }) { return workspaceId === A ? world.session : null },
      async readVersion() { return world.session },
      async listVersions() { return [world.session] },
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
    const released = { count: 0 }
    const media = {
      async resolve({ part }) {
        return {
          path: `/fixtures/${part.sourceAssetId}.mp4`,
          release: async () => { released.count += 1 },
        }
      },
    }
    const detector = {
      async detectPlaybackObservations() { return world.observations },
    }
    const actor = {
      workspaceId: A, kind: 'human', id: 'operator-ana',
      credentialId: 'credential-1', authenticationKind: 'ui-session',
    }
    const base = {
      baseVersionId: `${SESSION}:v${world.session.version}`,
      baseHash: world.session.sessionHash,
    }

    const build = buildReactPlaybackMapService({
      repository: maps, sessions, media, observations: detector, clock,
    })
    const anchor = editReactPlaybackAnchorService({ repository: maps, snapshots, clock })
    const read = readReactPlaybackMapService({ repository: maps })
    const compile = compileReactPlaybackPlanService({
      repository: maps, sessions, snapshots, clock,
    })

    const first = await build({ actor, sessionId: SESSION, ...base })
    assert.equal(first.map.version, 1)
    assert.equal(first.manualReviewRequired, true)
    assert.equal(released.count, 2, 'both files were given back')

    // BigInt survives the driver: the tick columns come back as bigints holding
    // the exact reaction bounds, not as doubles that happen to look right.
    const pieceRows = await client.v2PlaybackPiece.findMany({
      where: { workspaceId: A },
      orderBy: { ordinal: 'asc' },
    })
    assert.equal(pieceRows.length, first.map.pieces.length)
    assert.equal(typeof pieceRows[0].reactionEndTicks, 'bigint')
    assert.equal(
      pieceRows[pieceRows.length - 1].reactionEndTicks,
      world.map.reactionMedia.durationTicks,
    )

    const head = await read({ workspaceId: A, sessionId: SESSION, reactionTrackId: REACTION_TRACK })
    assert.equal(head.versionRef, `${SESSION}:playback:${REACTION_TRACK}:v1`)

    const answer = {
      anchorId: 'anchor-e2e-1',
      reactionTick: first.map.uncovered[0].range.start,
      referenceTick: null,
      mode: 'commentary-only',
      note: 'Player escondido; a reação continua falando.',
    }
    const resolved = await anchor({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      baseVersionId: head.versionRef, baseHash: first.map.mapHash, anchor: answer,
    })
    assert.equal(resolved.map.version, 2)
    assert.equal(resolved.map.status, 'resolved')
    assert.equal(
      resolved.map.anchors[0].evidenceRef,
      'operator:operator-ana (Player escondido; a reação continua falando.)',
    )
    // The actor and the note reached their own columns, projected out of the
    // evidence string rather than taken from a second source of truth.
    const anchorRow = await client.v2PlaybackAnchor.findFirstOrThrow({ where: { workspaceId: A } })
    assert.equal(anchorRow.actorId, 'operator-ana')
    assert.equal(anchorRow.actorKind, 'human')
    assert.equal(anchorRow.note, 'Player escondido; a reação continua falando.')

    // A second operator still holding version 1 is refused by the SERVICE,
    // which re-reads the head before it edits. Measured, not assumed: this one
    // never reaches the database.
    const lost = await anchor({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      baseVersionId: head.versionRef, baseHash: first.map.mapHash,
      anchor: { ...answer, anchorId: 'anchor-e2e-2', note: 'outra pessoa, outra máquina' },
    }).then(() => null, (error) => error)
    assert.ok(lost, 'the second writer must not also succeed')
    assert.equal(lost.code, 'PLAYBACK_MAP_VERSION_STALE')
    assert.equal(lost.details.currentVersion, 2)

    // And the database refuses it too, which is the part no fake can prove.
    // This bypasses the service on purpose: both operators computed version 2
    // from version 1, so the losing write is offered to PostgreSQL exactly as
    // the winner's was. The refusal is the map row's own unique key on
    // (workspace, session, reaction track, version), which trips inside the
    // transaction before the head fence is evaluated.
    const rival = applyPlaybackAnchor(first.map, {
      expectedVersion: first.map.version,
      expectedHash: first.map.mapHash,
      anchor: {
        anchorId: 'anchor-e2e-rival',
        reactionTick: answer.reactionTick,
        referenceTick: null,
        mode: 'commentary-only',
        actorId: 'operator-bruno',
        createdAt: iso(90),
      },
    })
    assert.equal(rival.version, 2)
    assert.notEqual(rival.mapHash, resolved.map.mapHash)
    const rejected = await maps.appendVersion({
      map: rival,
      expectedVersion: first.map.version,
      expectedHash: first.map.mapHash,
      occurredAt: iso(91),
    }).then(() => null, (error) => error)
    assert.ok(rejected, 'PostgreSQL must refuse the second version 2')
    assert.equal(rejected.code, 'PERSISTENCE_CONFLICT')

    const headRow = await client.v2PlaybackMapHead.findFirstOrThrow({ where: { workspaceId: A } })
    assert.equal(headRow.mapHash, resolved.map.mapHash, 'the head still names the winner')
    assert.equal(headRow.version, 2)
    assert.equal(
      await client.v2PlaybackMap.count({ where: { workspaceId: A, version: 2 } }),
      1,
      'the loser left no row behind',
    )

    // The old version is preserved, byte for byte, and still verifies.
    const stillThere = await read({
      workspaceId: A, sessionId: SESSION, reactionTrackId: REACTION_TRACK, version: 1,
    })
    assert.equal(stillThere.map.mapHash, first.map.mapHash)
    assert.equal(stillThere.map.status, 'needs-input')
    assert.equal(stillThere.map.anchors.length, 0)

    // Workspace B asks for the same session by name and finds nothing.
    const denied = await read({
      workspaceId: B, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
    }).then(() => null, (error) => error)
    assert.equal(denied?.code, 'PLAYBACK_MAP_NOT_FOUND')

    const compiled = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      projectVersionId: VERSION_A, objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    })
    validateDirectedEditPlan(compiled.plan)
    assert.equal(compiled.plan.durationFrames, 40 * 30)
    assert.equal(compiled.mapVersion, 2)
    const snapshotRow = await client.v2RenderablePlanSnapshot.findFirstOrThrow({
      where: { workspaceId: A },
    })
    assert.equal(snapshotRow.sourceHash, resolved.map.mapHash)
    assert.equal(snapshotRow.clipCount, compiled.plan.videoTracks[0].clips.length)
    assert.equal(snapshotRow.durationFrames, compiled.plan.durationFrames)

    // Recompiling is a replay: the same derivation at the same hash is one row.
    const again = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      projectVersionId: VERSION_A, objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    })
    assert.equal(again.replayed, true)
    assert.equal(
      await client.v2RenderablePlanSnapshot.count({ where: { workspaceId: A } }),
      1,
    )

    // The CHECKs are constraints, not comments.
    const refuse = async (name, write) => {
      const error = await write().then(() => null, (caught) => caught)
      assert.ok(error, `${name} accepted a row it must refuse`)
      assert.match(String(error.message ?? ''), new RegExp(name), `refused, but not by ${name}`)
    }
    await refuse('renderable_plan_snapshots_origin_check', () =>
      client.v2RenderablePlanSnapshot.create({
        data: {
          ...snapshotRow,
          id: `${snapshotRow.id}-origin`,
          origin: 'hand-made',
          planHash: hash('7'),
        },
      }))
    await refuse('renderable_plan_snapshots_plan_check', () =>
      client.v2RenderablePlanSnapshot.create({
        data: {
          ...snapshotRow,
          id: `${snapshotRow.id}-clips`,
          clipCount: snapshotRow.clipCount + 1,
          planHash: hash('8'),
        },
      }))

    // Hash-verified hydration: a piece edited underneath the application makes
    // the map unreadable rather than making the compiler cut from numbers
    // nobody derived.
    await client.v2PlaybackPiece.updateMany({
      where: { workspaceId: A, ordinal: 0 },
      data: { confidence: 0.11 },
    })
    const tampered = await read({
      workspaceId: A, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
    }).then(() => null, (error) => error)
    assert.equal(tampered?.code, 'PERSISTENCE_CONFLICT')

    console.log(
      `E2E-F4.015 playback map: v1 ${first.map.pieces.length} pieces / ` +
      `${first.map.uncovered.length} uncovered -> v2 ${resolved.map.status}, ` +
      `plan ${compiled.plan.durationFrames} frames over ` +
      `${compiled.plan.videoTracks[0].clips.length} clips, 1 snapshot row, ` +
      `second writer refused by ${lost.code} at the service and ${rejected.code} at the database`,
    )
  },
)

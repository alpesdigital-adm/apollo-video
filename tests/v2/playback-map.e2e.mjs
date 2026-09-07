import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
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
 *   from numbers nobody derived — and so does an edited `planJson`, which is
 *   the guard that had none: the CHECKs accept a clip shifted three hundred
 *   frames deeper into the master, and the reader does not.
 * - **The plan names files this project can render from.** Every artifact the
 *   compiled plan declares is resolved through the project's media-asset links
 *   — the lookup the render path itself performs — and unlinking one refuses
 *   the next compile instead of storing a plan nothing can open.
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
    const { PrismaRenderSourceRepository } = await import(
      '../../src/v2/infrastructure/prisma/render-source-repository.ts'
    )
    const { calculateRenderablePlanHash } = await import(
      '../../src/v2/application/renderable-edit-plan.ts'
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
      // Links and manifests first: both reference the artifact with RESTRICT.
      await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: { in: [A, B] } } })
      await client.v2MediaArtifact.deleteMany({ where: { workspaceId: { in: [A, B] } } })
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

    // The two recordings as ingested artifacts, linked to the project. The ids
    // are the parts' own `evidence.ingestArtifactId` and the durations their own
    // measured coverage, both read off the fixture rather than retyped: a plan
    // that declared the capture ASSET id instead would resolve to none of these.
    const ticksPerSecond = (part) =>
      Number(part.timebase.secondsPerTick.den) / Number(part.timebase.secondsPerTick.num)
    const recordings = world.session.tracks.map((track) => {
      const part = track.parts[0]
      return {
        trackId: track.trackId,
        artifactId: part.evidence.ingestArtifactId,
        sha256: part.evidence.ingestSha256,
        durationSeconds: Number(part.coverage.end - part.coverage.start) / ticksPerSecond(part),
      }
    })
    for (const [index, recording] of recordings.entries()) {
      const artifactKey = `workspaces/${A}/sources/${recording.trackId}.mp4`
      await client.v2MediaArtifact.create({
        data: {
          id: recording.artifactId, workspaceId: A, artifactKey, sha256: recording.sha256,
          byteSize: BigInt(4_096 * (index + 1)), mediaType: 'video', container: 'mp4',
          status: 'available', createdAt: at(0),
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: `manifest-${recording.artifactId}`, workspaceId: A, artifactId: recording.artifactId,
          schemaVersion: 'media-artifact-manifest/v1', manifestHash: hash(String(index)),
          recipeId: 'source-master', recipeVersion: '1.0.0', parametersHash: hash('b'),
          manifestJson: JSON.stringify({
            schemaVersion: 'media-artifact-manifest/v1',
            artifact: {
              artifactKey, sha256: recording.sha256, byteSize: 4_096 * (index + 1),
              mediaType: 'video', container: 'mp4',
            },
            recipe: { id: 'source-master', version: '1.0.0', parametersHash: hash('b') },
            sources: [],
            // The measurement the compiler is not allowed to take from a caller.
            probe: { width: 1_920, height: 1_080, duration: recording.durationSeconds, fps: 30 },
          }),
          createdAt: at(0),
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(), workspaceId: A, projectId: PROJECT_A,
          artifactId: recording.artifactId, role: 'source-master',
          originalFileName: `${recording.trackId}.mp4`, createdAt: at(0),
        },
      })
    }

    const maps = new PrismaPlaybackMapRepository(client)
    const snapshots = new PrismaRenderablePlanSnapshotRepository(client)
    const renderSources = new PrismaRenderSourceRepository(client)
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
      repository: maps, sessions, media, observations: detector, snapshots, clock,
    })
    const anchor = editReactPlaybackAnchorService({ repository: maps, snapshots, clock })
    const read = readReactPlaybackMapService({ repository: maps })
    const compile = compileReactPlaybackPlanService({
      repository: maps, sessions, sources: renderSources, snapshots, clock,
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

    // The map pair the compile is fenced on: version 2, the one the anchor
    // produced and the only one that is resolved enough to compile.
    const resolvedFence = {
      baseVersionId: `${SESSION}:playback:${REACTION_TRACK}:v${resolved.map.version}`,
      baseHash: resolved.map.mapHash,
    }
    const stalePlan = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      baseVersionId: head.versionRef, baseHash: first.map.mapHash,
      projectVersionId: VERSION_A, objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    }).then(() => null, (error) => error)
    assert.equal(stalePlan?.code, 'PLAYBACK_MAP_VERSION_STALE')
    assert.equal(stalePlan.details.currentVersion, 2)
    assert.equal(
      await client.v2RenderablePlanSnapshot.count({ where: { workspaceId: A } }),
      0,
      'a compile refused by the fence must not leave a snapshot behind',
    )

    const compiled = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      ...resolvedFence,
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

    // Every artifact the plan declares is one this project is linked to, which
    // is the lookup `PrismaProjectProxyRenderRepository` performs before it
    // renders: `project.mediaAssets.find(item => item.artifactId === artifactId)`.
    // A plan naming the capture asset ids would resolve to none of these rows.
    const linked = new Set((await client.v2ProjectMediaAsset.findMany({
      where: { workspaceId: A, projectId: PROJECT_A },
      select: { artifactId: true },
    })).map((row) => row.artifactId))
    assert.deepEqual(
      compiled.plan.sources.map((source) => source.artifactId).sort(),
      recordings.map((recording) => recording.artifactId).sort(),
    )
    for (const clip of compiled.plan.videoTracks[0].clips) {
      assert.ok(linked.has(clip.sourceArtifactId), `${clip.sourceArtifactId} is not a source of this project`)
      assert.ok(linked.has(clip.audioSourceArtifactId), `${clip.audioSourceArtifactId} is not a source of this project`)
    }
    // And the durations are the ones the manifests carry, not the timeline's:
    // the reaction runs forty seconds over a thirty-second reference.
    assert.deepEqual(
      Object.fromEntries(compiled.plan.sources.map((source) => [source.artifactId, source.durationSeconds])),
      Object.fromEntries(recordings.map((recording) => [recording.artifactId, recording.durationSeconds])),
    )

    // Recompiling is a replay: the same derivation at the same hash is one row.
    const again = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      ...resolvedFence,
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
    // `projectVersionId` decides which rows replay and which cut a row belongs
    // to, and it referenced nothing. The row below passes every CHECK — the JSON
    // agrees with the column and the hash is recomputed over it — so only the
    // foreign key can refuse it.
    const absentVersionPlan = JSON.parse(snapshotRow.planJson)
    absentVersionPlan.projectVersionId = 'pm-e2e-version-absent'
    await refuse('renderable_plan_snapshots_projectVersionId_projectId_works_fkey', () =>
      client.v2RenderablePlanSnapshot.create({
        data: {
          ...snapshotRow,
          id: `${snapshotRow.id}-version`,
          projectVersionId: 'pm-e2e-version-absent',
          planJson: JSON.stringify(absentVersionPlan),
          planHash: calculateRenderablePlanHash(absentVersionPlan),
        },
      }))

    // The composition root, executed rather than only type-checked.
    //
    // `createReactPlaybackMapServices` and the two repository factories had no
    // caller anywhere — not a route, not a worker, not a test — so the claim
    // that this is "where the compiler proves the adapters satisfy the ports"
    // was a `tsc` structural check and nothing more. Three of them now run
    // against this database. The build/anchor/compile half of the factory still
    // has no caller: it needs a capture session read from PostgreSQL, and this
    // journey seeds only the session head, which is phase 3's work.
    const {
      createReactPlaybackMapServices,
      createRenderSourceRepository,
      createRenderablePlanSnapshotRepository,
    } = await import('../../src/v2/infrastructure/repository-factory.ts')
    const { disconnectV2PostgresClient } = await import(
      '../../src/v2/infrastructure/prisma-postgres/client.ts'
    )
    t.after(async () => { await disconnectV2PostgresClient() })

    const assembled = createReactPlaybackMapServices({
      ...process.env,
      // The media resolver is constructed here even though this test never
      // opens a file; without a root it refuses at construction time.
      APOLLO_V2_ARTIFACT_ROOT: tmpdir(),
    })
    const viaFactory = await assembled.read({
      workspaceId: A, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
    })
    assert.equal(viaFactory.map.mapHash, resolved.map.mapHash)
    const dependents = await assembled.listReferenceDependents({
      workspaceId: A,
      referenceAssetId: world.map.referenceMedia.assetId,
      referenceSha256: world.map.referenceMedia.sha256,
    })
    assert.equal(dependents.length, 2, 'both versions are built on the reference bytes')
    const factoryPlans = createRenderablePlanSnapshotRepository()
    assert.equal(
      (await factoryPlans.readLatestForSource({
        workspaceId: A, origin: 'react-playback', sourceId: resolved.map.mapId,
      })).planHash,
      compiled.planHash,
    )
    assert.deepEqual(
      (await createRenderSourceRepository().resolveForProject({
        workspaceId: A, projectId: PROJECT_A,
        artifactIds: recordings.map((recording) => recording.artifactId),
      })).map((source) => [source.artifactId, source.durationSeconds]),
      recordings.map((recording) => [recording.artifactId, recording.durationSeconds]),
    )

    // Hash-verified hydration of the PLAN, which is the guard commit fc11d484
    // is named after and which no test exercised: removing the recompute left
    // every suite green, this journey included.
    //
    // The edit is chosen to pass every CHECK on the table: same plan id, same
    // state, same schema version, same project version, same duration, same clip
    // count — only the first clip moved three hundred frames deeper into the
    // master, which is exactly the kind of edit a repair script makes and the
    // kind that changes what gets rendered.
    const storedPlan = JSON.parse(snapshotRow.planJson)
    const movedPlan = JSON.parse(snapshotRow.planJson)
    movedPlan.videoTracks[0].clips[0].sourceInFrame += 300
    movedPlan.videoTracks[0].clips[0].sourceOutFrame += 300
    await client.v2RenderablePlanSnapshot.update({
      where: { id: snapshotRow.id },
      data: { planJson: JSON.stringify(movedPlan) },
    })
    const shifted = await snapshots.readLatestForSource({
      workspaceId: A, origin: 'react-playback', sourceId: resolved.map.mapId,
    }).then(() => null, (error) => error)
    assert.equal(shifted?.code, 'PERSISTENCE_CONFLICT', 'the CHECKs accepted the edit; the reader must not')
    assert.match(String(shifted.message), /does not match its hash/)
    assert.equal(shifted.details.storedHash, snapshotRow.planHash)

    // A tamperer who recomputes the hash — the algorithm is in the repository —
    // still cannot store a document the domain refuses: nine clips with no
    // transitions between them is not a plan, and every CHECK still passes.
    const unrenderable = JSON.parse(snapshotRow.planJson)
    unrenderable.transitions = []
    await client.v2RenderablePlanSnapshot.update({
      where: { id: snapshotRow.id },
      data: {
        planJson: JSON.stringify(unrenderable),
        planHash: calculateRenderablePlanHash(unrenderable),
      },
    })
    const invalid = await snapshots.readLatestForSource({
      workspaceId: A, origin: 'react-playback', sourceId: resolved.map.mapId,
    }).then(() => null, (error) => error)
    assert.equal(invalid?.code, 'PERSISTENCE_CONFLICT')
    assert.match(String(invalid.message), /not a renderable plan any more/)

    // The other two refusals in `hydrate` need the table's own CHECKs out of the
    // way — which is the point: they are the reader's defence for the day a
    // repair script drops a constraint, and the constraint definition is read
    // back from the catalogue so restoring it cannot drift from the migration.
    const withoutConstraint = async (name, run) => {
      const [{ def }] = await client.$queryRawUnsafe(
        'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint ' +
        `WHERE conrelid = 'renderable_plan_snapshots'::regclass AND conname = $1`,
        name,
      )
      await client.$executeRawUnsafe(`ALTER TABLE "renderable_plan_snapshots" DROP CONSTRAINT "${name}"`)
      try {
        await run()
      } finally {
        await client.v2RenderablePlanSnapshot.update({
          where: { id: snapshotRow.id },
          data: {
            planJson: snapshotRow.planJson,
            planHash: snapshotRow.planHash,
            origin: snapshotRow.origin,
          },
        })
        await client.$executeRawUnsafe(
          `ALTER TABLE "renderable_plan_snapshots" ADD CONSTRAINT "${name}" ${def}`,
        )
      }
    }

    await withoutConstraint('renderable_plan_snapshots_plan_check', async () => {
      await client.v2RenderablePlanSnapshot.update({
        where: { id: snapshotRow.id },
        data: { planJson: 'this is not a plan' },
      })
      const broken = await snapshots.listForProject({ workspaceId: A, projectId: PROJECT_A })
        .then(() => null, (error) => error)
      assert.equal(broken?.code, 'PERSISTENCE_CONFLICT')
      assert.match(String(broken.message), /is not valid JSON/)
    })
    await withoutConstraint('renderable_plan_snapshots_origin_check', async () => {
      await client.v2RenderablePlanSnapshot.update({
        where: { id: snapshotRow.id },
        data: { origin: 'hand-made' },
      })
      const foreign = await snapshots.listForProject({ workspaceId: A, projectId: PROJECT_A })
        .then(() => null, (error) => error)
      assert.equal(foreign?.code, 'PERSISTENCE_CONFLICT')
      assert.match(String(foreign.message), /names an unknown origin/)
    })

    // Restored, and readable again — so the refusals above were the tampering
    // and not a repository that cannot read its own rows.
    const restored = await snapshots.readLatestForSource({
      workspaceId: A, origin: 'react-playback', sourceId: resolved.map.mapId,
    })
    assert.equal(restored.planHash, compiled.planHash)
    assert.deepEqual(restored.plan.videoTracks[0].clips[0], storedPlan.videoTracks[0].clips[0])

    // Unlinking a recording refuses the next compile instead of storing a plan
    // whose sources the renderer cannot resolve. A different project version, so
    // the refusal cannot be the idempotency key answering for it.
    const referenceLink = await client.v2ProjectMediaAsset.findFirstOrThrow({
      where: { workspaceId: A, artifactId: recordings[1].artifactId },
    })
    await client.v2ProjectMediaAsset.delete({ where: { id: referenceLink.id } })
    const unresolvable = await compile({
      actor, sessionId: SESSION, reactionTrackId: REACTION_TRACK,
      ...resolvedFence,
      projectVersionId: VERSION_A, objective: 'discovery',
      planFps: rational(BigInt(30), BigInt(1)),
    }).then(() => null, (error) => error)
    assert.equal(unresolvable?.code, 'MEDIA_ARTIFACT_NOT_FOUND')
    assert.equal(unresolvable.details.artifactId, recordings[1].artifactId)
    await client.v2ProjectMediaAsset.create({ data: { ...referenceLink } })

    // Hash-verified hydration of the MAP: a piece edited underneath the
    // application makes it unreadable rather than making the compiler cut from
    // numbers nobody derived.
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
      `second writer refused by ${lost.code} at the service and ${rejected.code} at the database; ` +
      `sources ${compiled.plan.sources.map((source) => `${source.artifactId}@${source.durationSeconds}s`).join(' + ')} ` +
      `all linked to ${PROJECT_A}; stored plan refused after a CHECK-passing clip shift ` +
      `(${shifted.code}), after a rehashed unrenderable document (${invalid.code}) ` +
      `and after unlinking the reference (${unresolvable.code}); ` +
      `composition root executed: read v${viaFactory.map.version} and ` +
      `${dependents.length} reference dependents through createReactPlaybackMapServices`,
    )
  },
)

import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E-FR-150 — a direction through the real repository and a real PostgreSQL.
 *
 * The service suite proves the decisions with in-memory doubles. Doubles cannot
 * prove the three things this one exists for:
 *
 * - **Hydration is verified by hash.** A rejection reason edited in the database
 *   passes every CHECK the row has and still comes back refused, because the
 *   candidate hash covers it and `assertMulticamDirectionIntegrity` recomputes
 *   every candidate on the way out — not only the chosen one.
 * - **The fence is a constraint.** Two writers that both derived a direction
 *   against version 1 do not both win. The loser is refused by the database —
 *   in practice by the direction row's PRIMARY KEY, which is derived from
 *   (workspace, session, version) and therefore fires before the head's UPDATE
 *   predicate — and is told the current version and hash so a UI can offer a
 *   reload.
 * - **Every evaluated candidate survives the round trip.** ADR-118 asks that a
 *   rejected angle stay inspectable; this is the test that a rejected angle
 *   comes back with its `rejectionReasons` intact rather than as an eligible
 *   row nobody can distinguish from the winner.
 *
 * Plus the two facts a single-workspace suite would miss: a superseded
 * direction is still readable (marked not-head, never deleted), and workspace B
 * cannot see any of it.
 */

const RUN = process.env.APOLLO_MULTICAM_DIRECTION_E2E === '1'

test(
  'E2E-FR-150 a direction round-trips through PostgreSQL with every evaluated angle it rejected',
  { skip: RUN ? false : 'set APOLLO_MULTICAM_DIRECTION_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaMulticamDirectionRepository } = await import('../../src/v2/infrastructure/prisma/multicam-direction-repository.ts')
    const { directMulticam } = await import('../../src/v2/domain/multicam-direction.ts')
    const { createMulticamEvidenceSet } = await import('../../src/v2/domain/multicam-evidence.ts')
    const { createTickInterval } = await import('../../src/v2/domain/session-time.ts')
    const { createSyncDiagnostic, deriveTrackStatus } = await import('../../src/v2/domain/sync-diagnostic.ts')
    const { buildDirectableMulticamWorld, fixtureInstant, fixtureSeconds } = await import('./wave20-fixtures.mjs')

    const client = new PrismaClient()
    const workspaceId = 'md-e2e-workspace'
    const otherWorkspaceId = 'md-e2e-other-workspace'
    const projectId = 'md-e2e-project'
    const sessionId = 'md-e2e-session'
    const at = (second) => new Date(Date.parse('2029-06-01T09:00:00.000Z') + second * 1_000)

    const clean = async () => {
      for (const table of [
        client.v2MulticamAngleScoreComponent, client.v2MulticamAngleCandidate,
        client.v2MulticamShotAlternative, client.v2MulticamShotDecision,
        client.v2MulticamDirectionHead, client.v2MulticamDirection,
        client.v2MulticamObservation, client.v2MulticamEvidenceSet,
        client.v2CaptureSessionHead,
      ]) {
        await table.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
      }
      await client.v2Project.deleteMany({ where: { workspaceId: { in: [workspaceId, otherWorkspaceId] } } })
      await client.v2Workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } })
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
    for (const id of [workspaceId, otherWorkspaceId]) {
      await workspaces.create(createWorkspace({
        id, slug: id, name: 'Multicam direction E2E', status: 'active', createdAt: at(0).toISOString(),
      }))
    }
    for (const [id, workspace] of [[projectId, workspaceId], [`${projectId}-other`, otherWorkspaceId]]) {
      await client.v2Project.create({
        data: {
          id, workspaceId: workspace, name: 'Multicam direction E2E', status: 'reviewing-proxy',
          objective: 'discovery', format: '16:9', locale: 'pt-BR',
          createdByType: 'api-client', createdById: 'md-e2e-client', createdAt: at(0), updatedAt: at(0),
        },
      })
    }
    for (const [workspace, project] of [[workspaceId, projectId], [otherWorkspaceId, `${projectId}-other`]]) {
      await client.v2CaptureSessionHead.create({
        data: {
          id: `${workspace}:${sessionId}`, workspaceId: workspace, projectId: project, sessionId,
          version: 1, sessionHash: 'a'.repeat(64), status: 'synced', createdAt: at(0), updatedAt: at(0),
        },
      })
    }

    // Camera B starts twelve seconds into the session, so the opening of the
    // directed range has no camera-B picture at all. Without it the ONLY
    // rejection this fixture can produce is `not-a-video-source` — the whole
    // coverage gate and the whole sync gate could be deleted with every lane-E
    // test green, and the ADR-118 record this suite exists to prove would only
    // ever say "this track is a microphone".
    const world = buildDirectableMulticamWorld({ workspaceId, sessionId, projectId, endSecond: 60, cameraBOffsetSeconds: 12 })
    const speaks = (trackId, [from, to], speakerKey) => ({
      observationId: `obs-${trackId}-${from}`,
      trackId,
      range: createTickInterval(fixtureSeconds(from), fixtureSeconds(to)),
      kind: 'active-speaker',
      value: { kind: 'active-speaker', speakerKey, identityResolved: false },
      confidence: 0.92,
      provenance: {
        method: 'fixture/diarization',
        evaluatorKind: 'controlled',
        evidenceRef: `run:${trackId}:${from}`,
        producedAt: fixtureInstant(0),
      },
    })
    /**
     * A silence observation, because `silence` used to be a kind nothing wrote.
     *
     * `levelDbfs` is negative, which is the value the column's `CHECK` and the
     * aggregate's validator both have an opinion about, and it is a DOUBLE that
     * has to survive JSON on the way down and back. The kind was modelled,
     * validated and accepted by `multicam_observations_kind_check` while no
     * producer in the repository emitted one, so nothing had ever put such a row
     * in a table.
     */
    const quiet = (trackId, [from, to], levelDbfs) => ({
      observationId: `obs-quiet-${trackId}-${from}`,
      trackId,
      range: createTickInterval(fixtureSeconds(from), fixtureSeconds(to)),
      kind: 'silence',
      value: { kind: 'silence', levelDbfs },
      confidence: 1,
      provenance: {
        method: 'ffmpeg/silencedetect+astats',
        evaluatorKind: 'measured',
        evidenceRef: `media-artifact:asset-mic-a:${from * 1_000}-${to * 1_000}:audio`,
        producedAt: fixtureInstant(0),
      },
    })
    const evidence = createMulticamEvidenceSet({
      session: world.session,
      observations: [
        speaks('track-mic-a', [1, 25], 'cluster-a'),
        speaks('track-mic-b', [25, 50], 'cluster-b'),
        quiet('track-mic-a', [50, 55], -74.82),
      ],
      generatedAt: fixtureInstant(60),
    })
    const direction = directMulticam({
      session: world.session,
      coverages: world.coverages,
      clockMaps: world.clockMaps,
      diagnostic: world.diagnostic,
      protocolCeiling: null,
      evidence,
      format: { aspectRatio: '16:9' },
      range: createTickInterval(fixtureSeconds(1), fixtureSeconds(55)),
      generatedAt: fixtureInstant(70),
    })

    const repository = new PrismaMulticamDirectionRepository(client)
    const storedEvidence = await repository.persistEvidenceSet({ set: evidence, createdAt: at(10).toISOString() })
    assert.equal(storedEvidence.replayed, false)
    const replayedEvidence = await repository.persistEvidenceSet({ set: evidence, createdAt: at(11).toISOString() })
    assert.equal(replayedEvidence.replayed, true, 'the same observations for the same session version are one set')

    const appended = await repository.appendVersion({ direction, base: null, occurredAt: at(20).toISOString() })
    assert.equal(appended.stored.version, 1)
    assert.equal(appended.stored.direction.directionHash, direction.directionHash)

    // ---------------------------------------------------------------------
    // ADR-118 — the rejected angles came back, with their reasons
    // ---------------------------------------------------------------------
    const head = await repository.readHead({ workspaceId, sessionId })
    assert.ok(head, 'the head is readable')
    assert.equal(head.direction.directionHash, direction.directionHash, 'hydration reproduced the hash byte for byte')

    const shot = head.direction.shots[0]
    const original = direction.shots[0]
    assert.equal(shot.evaluated.length, original.evaluated.length, 'every evaluated candidate survived')
    assert.deepEqual(
      shot.evaluated.map((candidate) => candidate.candidateId),
      original.evaluated.map((candidate) => candidate.candidateId),
      'in the order the shot hash covers',
    )
    const rejected = shot.evaluated.filter((candidate) => !candidate.eligible)
    assert.ok(rejected.length > 0, 'this shot really did reject angles')
    for (const candidate of rejected) {
      const before = original.evaluated.find((entry) => entry.candidateId === candidate.candidateId)
      assert.deepEqual(
        [...candidate.rejectionReasons],
        [...before.rejectionReasons],
        `${candidate.candidateId} kept the reasons it was rejected for`,
      )
      assert.equal(candidate.candidateHash, before.candidateHash)
      assert.equal(candidate.sessionRange.start, before.sessionRange.start, 'ticks are bigint on the way back')
      assert.equal(candidate.sessionRange.end, before.sessionRange.end)
    }
    const audioOnly = rejected.find((candidate) => candidate.rejectionReasons.includes('not-a-video-source'))
    assert.ok(audioOnly, 'the recorder is stored as a rejected candidate, saying it is not a picture')
    // The reason a reviewer actually opens this table for. "This track is a
    // microphone" is a fact about the session that never changes; "camera B has
    // no picture here" is a fact about THIS stretch, and it is the one that
    // answers "why could I not cut to camera B there?".
    const notYetRecording = rejected.find((candidate) => candidate.rejectionReasons.some((reason) => reason.startsWith('sync-') || reason.startsWith('coverage-')))
    assert.ok(notYetRecording, 'a camera rejected for its own coverage, not for being audio, survived the round trip')
    assert.equal(notYetRecording.trackId, 'track-camera-b')
    assert.deepEqual([...notYetRecording.rejectionReasons], ['sync-uncovered'])
    // And the same camera is eligible once it starts recording, so the record
    // is per shot rather than a property of the track.
    const laterShot = head.direction.shots.find((entry) => entry.ordinal === 1)
    const laterCameraB = laterShot.evaluated.find((candidate) => candidate.trackId === 'track-camera-b')
    assert.equal(laterCameraB.eligible, true, 'camera B is eligible in the shot where it was recording')
    assert.deepEqual([...laterCameraB.rejectionReasons], [])
    const cameraBRows = await client.v2MulticamAngleCandidate.findMany({
      where: { workspaceId, trackId: 'track-camera-b' },
      select: { eligible: true, rejectionCount: true, rejectionReasonsJson: true },
      orderBy: { eligible: 'asc' },
    })
    assert.deepEqual(
      cameraBRows.map((row) => [row.eligible, row.rejectionCount, row.rejectionReasonsJson]),
      [[false, 1, JSON.stringify(['sync-uncovered'])], [true, 0, '[]']],
      'both halves of the fact are rows the database can be asked about',
    )
    assert.equal(head.direction.shots[0].chosen.eligible, true)
    assert.deepEqual([...head.direction.shots[0].chosen.rejectionReasons], [])

    // ---------------------------------------------------------------------
    // The silence observation is a row, and it comes back as the number it was
    // ---------------------------------------------------------------------
    const silenceRows = await client.v2MulticamObservation.findMany({
      where: { workspaceId, kind: 'silence' },
      select: { id: true, kind: true, valueJson: true, method: true, evaluatorKind: true },
      orderBy: { id: 'asc' },
    })
    assert.equal(silenceRows.length, 1, 'the silence observation is a row the database accepted')
    assert.deepEqual(
      JSON.parse(silenceRows[0].valueJson),
      { kind: 'silence', levelDbfs: -74.82 },
      'and the measured ceiling survived JSON with its sign and its decimals',
    )
    assert.equal(silenceRows[0].method, 'ffmpeg/silencedetect+astats', 'naming the pass that measured it')
    assert.equal(silenceRows[0].evaluatorKind, 'measured')
    const hydratedEvidence = await repository.readEvidenceSet({ workspaceId, evidenceHash: evidence.evidenceHash })
    assert.ok(hydratedEvidence, 'the set is readable by its own hash')
    const hydratedSilence = hydratedEvidence.observations.filter((observation) => observation.kind === 'silence')
    assert.equal(hydratedSilence.length, 1)
    assert.equal(hydratedSilence[0].value.levelDbfs, -74.82, 'hydration re-derives the level, not a rounded copy of it')
    assert.equal(hydratedSilence[0].range.end - hydratedSilence[0].range.start > 0n, true, 'and its ticks are bigint on the way back')

    const storedCandidates = await client.v2MulticamAngleCandidate.count({ where: { workspaceId } })
    const storedRejected = await client.v2MulticamAngleCandidate.count({ where: { workspaceId, eligible: false } })
    assert.ok(storedRejected > 0, 'rejected candidates are rows, not a comment')
    console.log(`multicam direction e2e shots=${head.direction.shots.length} candidates=${storedCandidates} rejected=${storedRejected} evidence=${evidence.observations.length}`)

    // ---------------------------------------------------------------------
    // Hydration is verified by hash, including on a REJECTED candidate
    // ---------------------------------------------------------------------
    const target = await client.v2MulticamAngleCandidate.findFirst({
      where: { workspaceId, eligible: false, rejectionCount: 1 },
      select: { id: true, rejectionReasonsJson: true },
    })
    assert.ok(target, 'there is a rejected candidate with exactly one reason to rewrite')
    await client.v2MulticamAngleCandidate.update({
      where: { id: target.id },
      // Still one reason, still ineligible: the eligibility CHECK is satisfied
      // and the row is perfectly well formed. Only the hash knows.
      data: { rejectionReasonsJson: JSON.stringify(['sync-missing']) },
    })
    await assert.rejects(
      () => repository.readHead({ workspaceId, sessionId }),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && /hash does not match/.test(error.message),
      'a rejection reason edited under the aggregate is refused on read',
    )
    await client.v2MulticamAngleCandidate.update({
      where: { id: target.id },
      data: { rejectionReasonsJson: target.rejectionReasonsJson },
    })
    const restored = await repository.readHead({ workspaceId, sessionId })
    assert.equal(restored.direction.directionHash, direction.directionHash, 'and accepted again once the reason is back')

    // ---------------------------------------------------------------------
    // The fence is a constraint: the second writer loses in the predicate
    // ---------------------------------------------------------------------
    const laterDiagnostic = createSyncDiagnostic({
      workspaceId,
      sessionId,
      referenceTrackId: world.session.referenceTrackId,
      version: 2,
      previousVersionHash: world.diagnostic.diagnosticHash,
      sessionVersion: world.session.version,
      referenceEpoch: world.session.referenceEpoch,
      tracks: ['track-camera-a', 'track-camera-b', 'track-screen', 'track-mic-a', 'track-mic-b'].map((trackId) => {
        const base = {
          trackId, methods: ['apollo-marker'], confidence: 0.8, offsetMs: 0, residualMs: 14,
          driftPpm: null, coverageBps: 9_500, gaps: [], automaticAnchors: [], manualAnchors: [],
          pieceIds: [], warnings: [], previewSampleMs: [],
        }
        return { ...base, status: deriveTrackStatus({ ...base, hasContradictoryAnchors: false }) }
      }),
      protocolCeiling: 'automatic',
      generatedAt: fixtureInstant(200),
    })
    const resynced = directMulticam({
      session: world.session,
      coverages: world.coverages,
      clockMaps: world.clockMaps,
      diagnostic: laterDiagnostic,
      protocolCeiling: null,
      evidence,
      format: { aspectRatio: '16:9' },
      range: createTickInterval(fixtureSeconds(1), fixtureSeconds(55)),
      generatedAt: fixtureInstant(210),
    })
    assert.notEqual(resynced.directionHash, direction.directionHash, 'a new diagnostic is a different direction')
    const second = await repository.appendVersion({
      direction: resynced,
      base: { version: 1, directionHash: direction.directionHash },
      occurredAt: at(30).toISOString(),
    })
    assert.equal(second.stored.version, 2)

    // The other writer computed against version 1 too, and arrives late.
    const stale = directMulticam({
      session: world.session,
      coverages: world.coverages,
      clockMaps: world.clockMaps,
      diagnostic: world.diagnostic,
      protocolCeiling: null,
      evidence,
      format: { aspectRatio: '9:16' },
      range: createTickInterval(fixtureSeconds(1), fixtureSeconds(55)),
      generatedAt: fixtureInstant(220),
    })
    // The direction row id is derived from (workspace, session, version), so the
    // loser collides on the PRIMARY KEY before it reaches the head's UPDATE
    // predicate. The fence holds either way; what this asserts is that the
    // refusal still carries the current version and hash, which is what a UI
    // needs to offer a reload — the branch that did not, until this suite ran.
    await assert.rejects(
      () => repository.appendVersion({
        direction: stale,
        base: { version: 1, directionHash: direction.directionHash },
        occurredAt: at(31).toISOString(),
      }),
      (error) => error.code === 'PERSISTENCE_CONFLICT'
        && error.details.currentVersion === 2
        && error.details.currentHash === resynced.directionHash,
      'the loser is told which version is current',
    )

    // ---------------------------------------------------------------------
    // Superseded, never deleted
    // ---------------------------------------------------------------------
    const first = await repository.readVersion({ workspaceId, sessionId, version: 1 })
    assert.ok(first, 'version 1 is still readable after version 2 replaced it')
    assert.equal(first.direction.directionHash, direction.directionHash)
    const dependents = await repository.findDependents({ workspaceId, diagnosticHash: world.diagnostic.diagnosticHash })
    assert.equal(dependents.length, 1, 'exactly one direction named the old diagnostic')
    assert.equal(dependents[0].version, 1)
    assert.equal(dependents[0].isHead, false, 'and it is superseded rather than current')
    const current = await repository.findDependents({ workspaceId, diagnosticHash: laterDiagnostic.diagnosticHash })
    assert.equal(current.length, 1)
    assert.equal(current[0].isHead, true)
    assert.equal(current[0].manualReviewRequired, resynced.manualReviewRequired)

    // ---------------------------------------------------------------------
    // Workspace B sees none of it
    // ---------------------------------------------------------------------
    assert.equal(await repository.readHead({ workspaceId: otherWorkspaceId, sessionId }), null)
    assert.equal((await repository.listVersions({ workspaceId: otherWorkspaceId, sessionId })).length, 0)
    assert.equal((await repository.findDependents({ workspaceId: otherWorkspaceId })).length, 0)
    assert.equal(
      await repository.readEvidenceSet({ workspaceId: otherWorkspaceId, evidenceHash: evidence.evidenceHash }),
      null,
      'the evidence is scoped by workspace, not by whoever remembered to filter',
    )
    console.log(`multicam direction e2e versions=${(await repository.listVersions({ workspaceId, sessionId })).length} superseded=${dependents[0].version} head=${current[0].version}`)
  },
)

test(
  'E2E-FR-150 the direction command writes a version, a plan and a Command that the database agrees with',
  { skip: RUN ? false : 'set APOLLO_MULTICAM_DIRECTION_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { randomUUID } = await import('node:crypto')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaCaptureSessionRepository } = await import('../../src/v2/infrastructure/prisma/capture-session-repository.ts')
    const { PrismaSyncDiagnosticRepository } = await import('../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts')
    const { PrismaCaptureProtocolRepository } = await import('../../src/v2/infrastructure/prisma/capture-protocol-repository.ts')
    const { PrismaMulticamDirectionRepository } = await import('../../src/v2/infrastructure/prisma/multicam-direction-repository.ts')
    const { PrismaMulticamDirectionCommandRepository } = await import('../../src/v2/infrastructure/prisma/multicam-direction-command-repository.ts')
    const { PrismaProjectProxyRenderRepository } = await import('../../src/v2/infrastructure/prisma/project-proxy-render-repository.ts')
    const { deriveMulticamEvidenceService, directMulticamSessionService } = await import('../../src/v2/application/multicam-direction.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
    const { createDesiredAction, createDesiredActionReference } = await import('../../src/v2/domain/desired-action.ts')
    const { createEditorialAudioTimelineHash } = await import('../../src/v2/domain/production-modes.ts')
    const { buildDirectableMulticamWorld, fixtureSeconds } = await import('./wave20-fixtures.mjs')

    const client = new PrismaClient()
    const workspaceId = 'md-journey-workspace'
    const projectId = 'md-journey-project'
    const sessionId = 'md-journey-session'
    const versionId = 'md-journey-version-1'
    const clientId = 'md-journey-client'
    const at = (second) => new Date(Date.parse('2029-07-01T09:00:00.000Z') + second * 1_000)

    // A project version names the Command that produced it and a Command names
    // the version it was based on, so neither table can be emptied while the
    // other still points at it. The two references are cleared first; this is
    // the order a fresh reader gets wrong, which is why it is written down.
    const clean = async () => {
      await client.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await client.v2ProjectVersion.updateMany({ where: { workspaceId }, data: { commandId: null } })
      for (const table of [
        client.v2MulticamAngleScoreComponent, client.v2MulticamAngleCandidate,
        client.v2MulticamShotAlternative, client.v2MulticamShotDecision,
        client.v2MulticamDirectionHead, client.v2MulticamDirection,
        client.v2MulticamObservation, client.v2MulticamEvidenceSet,
        client.v2SyncDiagnosticHead, client.v2SyncDiagnostic,
        client.v2CaptureClockMap, client.v2CaptureTrackCoverage,
        client.v2CaptureSessionClock, client.v2CaptureSyncEvidence,
        client.v2CaptureSessionVersion, client.v2CaptureSessionHead,
        client.v2CommandArtifactInvalidation, client.v2PublicEventOutbox,
        client.v2EditCommand, client.v2ProjectVersion,
        client.v2ProjectMediaAsset, client.v2ProjectSnapshot,
        client.v2MediaArtifactManifest, client.v2MediaArtifact,
        client.v2Project,
      ]) {
        await table.deleteMany({ where: { workspaceId } })
      }
      await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }
    t.after(async () => {
      try {
        await clean()
      } catch (error) {
        console.error('journey cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })
    await clean()

    const world = buildDirectableMulticamWorld({ workspaceId, sessionId, projectId, endSecond: 60 })

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Multicam journey', status: 'active', createdAt: at(0).toISOString(),
    }))
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'Multicam journey', status: 'reviewing-proxy',
        objective: 'warming', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: clientId, createdAt: at(0), updatedAt: at(0),
      },
    })
    // Every recording the direction may cut has to be a linked, available
    // project asset with a probed cadence, or `hydrateSource` refuses the render
    // that follows (`prisma/project-proxy-render-repository.ts:111-141`).
    for (const track of world.session.tracks) {
      const artifactId = track.sourceAssetId
      const mediaType = ['microphone', 'master-audio', 'scratch-audio'].includes(track.role) ? 'audio' : 'video'
      await client.v2MediaArtifact.create({
        data: {
          id: artifactId, workspaceId, artifactKey: `artifacts/${artifactId}.mp4`,
          sha256: 'b'.repeat(64), byteSize: BigInt(4096), mediaType, container: 'mp4',
          status: 'available', createdAt: at(0),
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: `manifest-${artifactId}`, workspaceId, artifactId, schemaVersion: 'media-artifact-manifest/v1',
          manifestHash: 'c'.repeat(64), recipeId: 'capture-ingest', recipeVersion: '1.0.0',
          parametersHash: 'd'.repeat(64),
          manifestJson: JSON.stringify({
            artifact: { artifactKey: `artifacts/${artifactId}.mp4` },
            probe: { duration: 60, fps: 30, rFrameRate: '30/1' },
          }),
          createdAt: at(0),
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(), workspaceId, projectId, artifactId,
          role: artifactId === 'asset-cam-a' ? 'source-master' : 'selected-insert',
          originalFileName: `${artifactId}.mp4`, createdAt: at(0),
        },
      })
    }

    const desiredActionRef = createDesiredActionReference(createDesiredAction({ objective: 'warming' }))
    const baseClips = [{
      id: 'clip-base-0001', sourceArtifactId: 'asset-cam-a',
      sourceInFrame: 0, sourceOutFrame: 900, timelineInFrame: 0, timelineOutFrame: 900, rate: 1,
    }]
    const basePlan = {
      schemaVersion: 2, state: 'compiled', id: `edit-plan-${versionId}`, projectVersionId: versionId,
      storyPlanId: 'story-journey', treatmentPlanId: 'treatment-journey', directorRunId: 'director-run-journey',
      fps: 30, durationFrames: 900,
      sources: [{ id: 'asset-cam-a', artifactId: 'asset-cam-a', kind: 'video', durationSeconds: 60 }],
      videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: baseClips }],
      overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], transitions: [],
      markers: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
      lineageRefs: ['asset-cam-a'],
      editorial: { commandType: 'source-ingest', exclusions: [], retainedSourceRanges: [] },
      retimedTranscript: { sourceTranscriptId: 'transcript-journey', words: [] },
      movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
      composition: {
        layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
        faceSafeFallback: [0.14, 0.08, 0.72, 0.56], subtitleSafeRegion: [0.08, 0.7, 0.84, 0.24],
      },
      director: { plannerVersion: 'journey-planner/v1', decisions: [], assumptions: [] },
      desiredActionRef,
      audioTimelineHash: createEditorialAudioTimelineHash({ fps: 30, clips: baseClips }),
      createdAt: at(0).toISOString(),
    }
    for (const [kind, content] of [['brief', { kind: 'brief' }], ['policies', { kind: 'policies' }]]) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `md-journey-snapshot-${kind}`, workspaceId, projectId, kind, schemaVersion: 1,
          contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt: at(0),
        },
      })
    }
    await client.v2ProjectSnapshot.create({
      data: {
        id: 'md-journey-snapshot-edit-plan', workspaceId, projectId, kind: 'edit-plan', schemaVersion: 2,
        contentJson: stableSerialize(basePlan), contentHash: calculateVersionHash(basePlan), createdAt: at(0),
      },
    })
    const baseHash = calculateVersionHash({ projectId, sequence: 1, editPlanHash: calculateVersionHash(basePlan) })
    await client.v2ProjectVersion.create({
      data: {
        id: versionId, workspaceId, projectId, sequence: 1,
        briefSnapshotId: 'md-journey-snapshot-brief',
        editPlanSnapshotId: 'md-journey-snapshot-edit-plan',
        policiesSnapshotId: 'md-journey-snapshot-policies',
        baseHash, createdBy: clientId, createdAt: at(0),
      },
    })
    await client.v2Project.update({ where: { id: projectId }, data: { currentVersionId: versionId } })

    // The session and its derivations, through the repositories Wave 18/19 own.
    const sessions = new PrismaCaptureSessionRepository(client)
    for (const version of world.versions) {
      await sessions.appendVersion({
        session: version,
        ...(version.version > 1 ? { expectedVersion: version.version - 1 } : {}),
        occurredAt: at(1).toISOString(),
      })
    }
    await sessions.persistClock({ workspaceId, clock: world.clock, createdAt: at(1).toISOString() })
    for (const map of world.clockMaps) await sessions.persistClockMap({ map, createdAt: at(1).toISOString() })
    for (const coverage of world.coverages) {
      await sessions.persistCoverage({ coverage, sessionId, createdAt: at(1).toISOString() })
    }
    const diagnostics = new PrismaSyncDiagnosticRepository(client)
    await diagnostics.appendVersion({ diagnostic: world.diagnostic, occurredAt: at(2).toISOString() })

    const directions = new PrismaMulticamDirectionRepository(client)
    const commands = new PrismaMulticamDirectionCommandRepository(client)
    const released = []
    const deriveEvidence = deriveMulticamEvidenceService({
      sessions,
      directions,
      diarization: {
        async listLatestRunsForArtifacts({ sourceArtifactIds }) {
          return [
            {
              runId: 'md-journey-diarization-a', sourceArtifactId: 'asset-mic-a', provider: 'fixture',
              producedAt: at(3).toISOString(),
              segments: [{ segmentId: 'seg-1', ordinal: 0, speakerKey: 'cluster-a', startMs: 1000, endMs: 25000 }],
            },
            {
              runId: 'md-journey-diarization-b', sourceArtifactId: 'asset-mic-b', provider: 'fixture',
              producedAt: at(3).toISOString(),
              segments: [{ segmentId: 'seg-2', ordinal: 0, speakerKey: 'cluster-b', startMs: 25000, endMs: 50000 }],
            },
          ].filter((run) => sourceArtifactIds.includes(run.sourceArtifactId))
        },
      },
      visual: {
        async measure({ windows }) {
          return windows.map((window) => ({
            ...window,
            sampledFrameCount: 30,
            // 103 bps is what the production pass measures over a moving test
            // pattern; see multicam-visual-evidence.integration.mjs.
            activityBps: window.trackId === 'track-screen' ? 103 : null,
            sharpnessBps: null,
            stabilityBps: 9000,
            exposureBps: 8500,
            method: 'fixture/signalstats',
            evidenceRef: `media-artifact:${window.sourceArtifactId}:${window.sourceStartMs}-${window.sourceEndMs}`,
          }))
        },
      },
      media: {
        async resolve({ part }) {
          return {
            path: `C:/materialized/${part.sourceAssetId}.mp4`,
            release: async () => { released.push(part.sourceAssetId) },
          }
        },
      },
      clock: () => at(4),
      evidenceWindowMs: 30000,
    })
    let issued = 0
    const execute = directMulticamSessionService({
      sessions,
      diagnostics,
      protocols: new PrismaCaptureProtocolRepository(client),
      directions,
      commands,
      deriveEvidence,
      clock: () => at(10),
      createId: (prefix) => `${prefix}-md-journey-${(issued += 1)}`,
      createEventId: () => randomUUID(),
    })
    const identity = {
      clientId, credentialId: 'md-journey-credential', workspaceId, environment: 'sandbox',
      delegatedUserId: 'md-journey-member', delegatedIdentityId: 'md-journey-identity', workspaceRole: 'administrator',
    }
    const actor = {
      ...identity, scopes: new Set(['projects:write']), authenticationKind: 'ui-session',
      clientAccessStatus: 'active', workspaceAccessStatus: 'active',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      auditContext: createExternalAuditContext(identity),
    }
    const request = {
      workspaceId, projectId, sessionId, baseVersionId: versionId, baseHash,
      format: { aspectRatio: '16:9' },
      range: { sessionStartTicks: fixtureSeconds(1).toString(), sessionEndTicks: fixtureSeconds(55).toString() },
      actor, idempotency: { clientId, key: 'md-journey-idem-1' },
    }

    const result = await execute(request)
    assert.equal(result.replayed, false)
    assert.equal(result.version.sequence, 2)
    assert.ok(result.editPlan.sources.length >= 2, 'the stored plan really is multi-source')
    assert.ok(released.length > 0, 'every materialized recording was handed back')

    // The database agrees with what came back.
    const project = await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })
    assert.equal(project.currentVersionId, result.version.id, 'the project advanced to the new version')
    const storedVersion = await client.v2ProjectVersion.findUniqueOrThrow({
      where: { id: result.version.id }, include: { editPlanSnapshot: true },
    })
    const storedPlan = JSON.parse(storedVersion.editPlanSnapshot.contentJson)
    assert.equal(
      storedVersion.editPlanSnapshot.contentHash,
      calculateVersionHash(storedPlan),
      'the snapshot hash covers the bytes stored',
    )
    assert.equal(storedPlan.director.plannerVersion, 'multicam-direction-planner/2026-09-v1')
    assert.ok(storedPlan.director.decisions.some((decision) => decision.category === 'angle'))
    const storedClips = storedPlan.videoTracks[0].clips
    assert.equal(storedClips.length, result.direction.shots.length)
    assert.ok(new Set(storedClips.map((clip) => clip.sourceArtifactId)).size >= 2)
    // The union `hydrateSource` will build, against the links the project has.
    const referenced = [...new Set(storedClips.flatMap((clip) => [
      clip.sourceArtifactId,
      clip.audioSourceArtifactId ?? clip.sourceArtifactId,
    ]))]
    const linked = await client.v2ProjectMediaAsset.findMany({
      where: { workspaceId, projectId, artifactId: { in: referenced } },
      include: { artifact: true },
    })
    assert.equal(linked.length, referenced.length, 'every referenced recording is a linked project asset')
    assert.ok(linked.every((asset) => asset.artifact.status === 'available'))

    const storedCommand = await client.v2EditCommand.findUniqueOrThrow({ where: { id: result.command.id } })
    assert.equal(storedCommand.type, 'direct-multicam-session')
    assert.equal(JSON.parse(storedCommand.payloadJson).directionHash, result.direction.directionHash)
    const storedDirection = await directions.readHead({ workspaceId, sessionId })
    assert.equal(storedDirection.direction.directionHash, result.direction.directionHash)
    const events = await client.v2PublicEventOutbox.findMany({ where: { workspaceId } })
    assert.equal(events.length, 1)
    assert.equal(JSON.parse(events[0].dataJson).sessionId, sessionId)

    // A retry of the same request returns the same version and writes nothing.
    const replay = await execute(request)
    assert.equal(replay.replayed, true)
    assert.equal(replay.version.id, result.version.id)
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 2, 'no third version appeared')
    assert.equal(await client.v2EditCommand.count({ where: { workspaceId } }), 1)

    // And the fence: the old base is stale now that the project moved.
    await assert.rejects(
      () => execute({ ...request, idempotency: { clientId, key: 'md-journey-idem-2' } }),
      (error) => error.code === 'VERSION_CONFLICT' && error.details.currentVersionId === result.version.id,
    )

    // ---------------------------------------------------------------------
    // The plan the direction produced is one a renderer can actually be given
    // ---------------------------------------------------------------------
    // BRIEF item 5, and the one thing the render integration cannot prove
    // because it hand-writes the renderer's `sources[]`. `hydrateSource` is the
    // runtime path: it re-verifies the snapshot hash, derives the render
    // sources from the union of every clip's video AND audio artifact, and
    // refuses when the project's `source-master` link is not among them
    // (`prisma/project-proxy-render-repository.ts:144-149`). A multicam plan is the
    // first plan that puts more than one picture through it.
    const renders = new PrismaProjectProxyRenderRepository(client)
    const hydrated = await renders.readCurrentSource({ workspaceId, projectId })
    assert.ok(hydrated, 'the stored multi-source plan hydrates into a render source')
    assert.equal(hydrated.projectVersionId, result.version.id, 'at the version this direction created')
    assert.equal(hydrated.editPlanHash, storedVersion.editPlanSnapshot.contentHash)
    assert.deepEqual(
      hydrated.renderSources.map((source) => source.artifactId).toSorted(),
      [...referenced].sort(),
      "the render sources are exactly the union of the clips' video and audio artifacts",
    )
    assert.ok(
      hydrated.renderSources.filter((source) => source.mediaType === 'video').length >= 2,
      'more than one picture, which is what makes it a multicam render',
    )
    assert.ok(
      hydrated.renderSources.some((source) => source.role === 'source-master'),
      "and the project's source master is among them, or the render would be refused",
    )
    console.log(`hydrateSource sources=${hydrated.renderSources.length} video=${hydrated.renderSources.filter((source) => source.mediaType === 'video').length} master=${hydrated.sourceArtifactId} version=${hydrated.projectVersionId}`)

    // ---------------------------------------------------------------------
    // The fences INSIDE the commit transaction, which the service check hides
    // ---------------------------------------------------------------------
    // Every predicate in `commitOrReplay` could be deleted with this suite
    // green, because the only fence it exercised is the service-level one at
    // `application/multicam-direction.ts:1255-1260` — which fires first and
    // stops the request
    // from ever reaching the transaction. These call the repository directly
    // with a bundle whose world moved underneath it, which is the state a
    // concurrent writer actually leaves. Each refusal happens before the
    // transaction writes anything, and the row counts at the end prove it.
    const bundleFor = async () => {
      const context = await commands.readContext({ workspaceId, projectId })
      const nextVersionId = 'project-version-md-fence'
      return {
        command: {
          ...result.command,
          id: 'edit-command-md-fence',
          idempotencyKey: 'md-journey-fence',
          baseVersionId: context.currentVersion.id,
          baseHash: context.currentVersion.baseHash,
        },
        authenticationAudit: materializeActorAuditContext(actor),
        requestFingerprint: 'f'.repeat(64),
        snapshot: {
          id: 'project-snapshot-md-fence', workspaceId, projectId, kind: 'edit-plan',
          contentSchemaVersion: 2, contentJson: storedVersion.editPlanSnapshot.contentJson,
          contentHash: storedVersion.editPlanSnapshot.contentHash, createdAt: at(50).toISOString(),
        },
        version: {
          ...result.version,
          id: nextVersionId,
          sequence: context.currentVersion.sequence + 1,
          parentVersionId: context.currentVersion.id,
          snapshotRefs: { ...result.version.snapshotRefs, editPlan: 'project-snapshot-md-fence' },
        },
        editPlan: { ...result.editPlan, id: `edit-plan-${nextVersionId}`, projectVersionId: nextVersionId },
        event: {
          id: randomUUID(), type: 'project.version.created', version: '1.0.0', workspaceId,
          occurredAt: at(50).toISOString(), sequence: context.currentVersion.sequence + 1,
          actor: { clientId },
          resource: { type: 'project-version', id: nextVersionId },
          data: { projectId, sessionId },
        },
        directionEvidence: {
          sessionId,
          sessionVersion: result.direction.sessionVersion,
          directionVersion: result.directionVersion,
          directionHash: result.direction.directionHash,
        },
      }
    }

    // (a) the Command names a direction that is not the one stored. The
    //     direction lives in its own chain, so it can be replaced between the
    //     service deriving it and this transaction opening.
    const wrongDirection = await bundleFor()
    await assert.rejects(
      () => commands.commitOrReplay({
        ...wrongDirection,
        directionEvidence: { ...wrongDirection.directionEvidence, directionHash: 'e'.repeat(64) },
      }),
      (error) => error.code === 'PERSISTENCE_CONFLICT'
        && /not the one stored/.test(error.message)
        && error.details.expectedDirectionHash === 'e'.repeat(64),
      'a Command compiled from a direction that is no longer stored is refused inside the transaction',
    )

    // (b) the project's head hash moved while the bundle was in flight. Its id
    //     did not, so the `updateMany` predicate at the end would still fire;
    //     only the version predicate at the top of the transaction sees this.
    const movedHash = await bundleFor()
    await client.v2ProjectVersion.update({
      where: { id: result.version.id },
      data: { baseHash: 'd'.repeat(64) },
    })
    await assert.rejects(
      () => commands.commitOrReplay(movedHash),
      (error) => error.code === 'VERSION_CONFLICT'
        && error.details.currentVersionId === result.version.id
        && error.details.currentBaseHash === 'd'.repeat(64),
      'a head whose hash moved is refused, and the refusal says what is current',
    )
    await client.v2ProjectVersion.update({
      where: { id: result.version.id },
      data: { baseHash: result.version.baseHash },
    })

    // (c) the render outputs of the base version are no longer the ones the
    //     Command's impact was computed against, so the invalidations it
    //     carries would name artifacts nobody has to invalidate — or miss ones
    //     somebody does.
    const staleOutputs = await bundleFor()
    await assert.rejects(
      () => commands.commitOrReplay({
        ...staleOutputs,
        command: {
          ...staleOutputs.command,
          payload: {
            ...staleOutputs.command.payload,
            impact: {
              ...staleOutputs.command.payload.impact,
              affectedArtifacts: [{
                artifactId: 'md-journey-vanished-proxy', kind: 'proxy',
                sourceVersionId: staleOutputs.command.baseVersionId, variantId: '16:9',
              }],
            },
          },
        },
      }),
      (error) => error.code === 'VERSION_CONFLICT' && /render outputs changed/.test(error.message),
      'a Command whose impact describes outputs the project no longer has is refused',
    )

    // (d) and the fence the service saw first is still a fence here: a bundle
    //     built against a version that is not the head at all.
    const staleBase = await bundleFor()
    await assert.rejects(
      () => commands.commitOrReplay({
        ...staleBase,
        command: { ...staleBase.command, baseVersionId: versionId, baseHash },
        version: { ...staleBase.version, parentVersionId: versionId, sequence: 2 },
      }),
      (error) => error.code === 'VERSION_CONFLICT' && error.details.currentVersionId === result.version.id,
      'and a bundle built on a version the project has moved past never reaches a write',
    )

    // Nothing above committed: the project is still on the version the journey
    // produced, and no third version or second Command appeared.
    assert.equal(await client.v2ProjectVersion.count({ where: { workspaceId } }), 2)
    assert.equal(await client.v2EditCommand.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2ProjectSnapshot.count({ where: { workspaceId, id: 'project-snapshot-md-fence' } }), 0)
    assert.equal(
      (await client.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId,
      result.version.id,
    )

    // ---------------------------------------------------------------------
    // The EditPlan the direction is derived on top of is verified by hash
    // ---------------------------------------------------------------------
    // `readContext` returns the plan the whole direction is built from. One
    // byte of it, edited under the `contentHash` stored beside it, must not be
    // the thing the next direction re-cuts — nor what a retry hands back.
    const snapshotRow = await client.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: result.version.snapshotRefs.editPlan },
    })
    const edited = JSON.parse(snapshotRow.contentJson)
    edited.durationFrames = edited.durationFrames + 1
    await client.v2ProjectSnapshot.update({
      where: { id: snapshotRow.id },
      data: { contentJson: stableSerialize(edited) },
    })
    await assert.rejects(
      () => commands.readContext({ workspaceId, projectId }),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && /contentHash stored beside it/.test(error.message),
      'a plan edited under its own hash is refused before a direction is derived on it',
    )
    await assert.rejects(
      () => commands.findIdempotentResult({
        workspaceId,
        projectId,
        idempotencyKey: 'md-journey-idem-1',
        actorContextHash: materializeActorAuditContext(actor).contextHash,
      }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
      'and a retry will not hand those bytes back either',
    )
    await client.v2ProjectSnapshot.update({
      where: { id: snapshotRow.id },
      data: { contentJson: snapshotRow.contentJson },
    })
    assert.ok(await commands.readContext({ workspaceId, projectId }), 'and both accept it again once it is back')

    console.log(`multicam journey version=${result.version.sequence} clips=${storedClips.length} sources=${storedPlan.sources.length} decisions=${storedPlan.director.decisions.length} events=${events.length}`)
  },
)

test(
  'E2E-FR-150 the direction reads persisted diarization through the real adapter, and refuses a row edited underneath it',
  { skip: RUN ? false : 'set APOLLO_MULTICAM_DIRECTION_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    // The adapter the slice's speech evidence comes from was executed by
    // nothing: both the unit suite and the journey below substituted a
    // hand-written double, so neither the query nor the hash verification had
    // ever run. This is that adapter, against real rows.
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaMulticamDiarizationSource } = await import('../../src/v2/infrastructure/prisma/multicam-diarization-source.ts')
    const { createSpeakerDiarizationRun } = await import('../../src/v2/domain/speaker-diarization.ts')
    const { stableSerialize } = await import('../../src/v2/application/version-hash.ts')
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')

    const client = new PrismaClient()
    const workspaceId = 'md-diar-workspace'
    const projectId = 'md-diar-project'
    const clientId = 'md-diar-client'
    const artifactId = 'md-diar-artifact'
    const at = (second) => new Date(Date.parse('2029-08-01T09:00:00.000Z') + second * 1_000)
    const sha = (seed) => seed.repeat(64).slice(0, 64)

    const clean = async () => {
      for (const table of [
        client.v2SpeakerDiarizationSegment, client.v2SpeakerDiarizationRun,
        client.v2LongFormIndexWorkflow, client.v2PublicOperation,
        client.v2MediaTranscript, client.v2MediaArtifactManifest, client.v2MediaArtifact,
        client.v2Project, client.v2ApiClient,
      ]) {
        await table.deleteMany({ where: { workspaceId } })
      }
      await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }
    t.after(async () => {
      try {
        await clean()
      } catch (error) {
        console.error('diarization cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })
    await clean()

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Multicam diarization', status: 'active', createdAt: at(0).toISOString(),
    }))
    await client.v2ApiClient.create({
      data: {
        id: clientId, workspaceId, name: 'Multicam diarization client',
        allowedEnvironmentsJson: JSON.stringify(['sandbox']), scopeGrantsJson: JSON.stringify([]),
        createdBy: 'md-diar-operator', createdAt: at(0), updatedAt: at(0),
      },
    })
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'Multicam diarization', status: 'reviewing-proxy',
        objective: 'discovery', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: clientId, createdAt: at(0), updatedAt: at(0),
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId, workspaceId, artifactKey: `artifacts/${artifactId}.wav`,
        sha256: sha('a'), byteSize: BigInt(8192), mediaType: 'audio', container: 'wav',
        status: 'available', createdAt: at(0),
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: 'md-diar-manifest', workspaceId, artifactId, schemaVersion: 'media-artifact-manifest/v1',
        manifestHash: sha('b'), recipeId: 'capture-ingest', recipeVersion: '1.0.0', parametersHash: sha('c'),
        manifestJson: JSON.stringify({ probe: { duration: 60 } }), createdAt: at(0),
      },
    })
    await client.v2MediaTranscript.create({
      data: {
        id: 'md-diar-transcript', workspaceId, projectId, sourceArtifactId: artifactId,
        sourceManifestId: 'md-diar-manifest', schemaVersion: 'media-transcript/v1', language: 'pt-BR',
        provider: 'openai', model: 'whisper-1', providerVersion: 'v1',
        transcriptHash: sha('d'), transcriptJson: JSON.stringify({ words: [] }), createdAt: at(0),
      },
    })
    await client.v2PublicOperation.create({
      data: {
        id: 'md-diar-operation', workspaceId, projectId, clientId, type: 'long-form-index',
        status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: artifactId,
        // `public_operations_progress_check` ties status, phase and progress
        // together: a long-form index that succeeded has all six stages done.
        progressUnit: 'stage', progressTotal: 6, progressCompleted: 6,
        // `public_operations_state_check` completes the picture: a succeeded
        // operation started, finished, carries a result and can no longer be
        // cancelled or retried.
        attempt: 1, startedAt: at(0), completedAt: at(1),
        resultJson: JSON.stringify({ workflowId: 'md-diar-workflow' }),
        cancelable: false, retryable: false,
        idempotencyKey: 'md-diar-operation-key', requestFingerprint: sha('e'),
        createdAt: at(0), updatedAt: at(0),
      },
    })
    await client.v2LongFormIndexWorkflow.create({
      data: {
        id: 'md-diar-workflow', workspaceId, projectId, operationId: 'md-diar-operation',
        sourceArtifactId: artifactId, sourceArtifactSha256: sha('a'),
        sourceManifestId: 'md-diar-manifest', sourceManifestHash: sha('b'),
        sourceTranscriptId: 'md-diar-transcript',
        durationMs: 60_000, schemaVersion: 'long-form-index-workflow/v1',
        policyVersion: 'long-form-index-workflow-policy/v1',
        // The budget and state CHECKs on this table are strict about their own
        // vocabulary: USD, five stages at most, and a workflow that is always
        // resumable and never carries duplicate segments.
        status: 'succeeded', budgetCurrency: 'USD', maximumCostMinorUnits: 10_000,
        maximumElapsedMs: 600_000, maximumConcurrency: 2, completedStageCount: 5,
        searchableStageCount: 5, resultCount: 1, costMinorUnits: 10, elapsedMs: 1_000,
        duplicateSegments: false, resumable: true,
        workflowJson: JSON.stringify({ id: 'md-diar-workflow' }), runHash: sha('f'),
        requestFingerprint: sha('e'), idempotencyKey: 'md-diar-workflow-key',
        createdByClientId: clientId, createdAt: at(0), updatedAt: at(0),
      },
    })

    // Two runs of the same file, the second newer: the adapter must return the
    // newest and treat the older as the superseded opinion it is.
    const makeRun = (id, createdAtSecond, segments) => createSpeakerDiarizationRun({
      id,
      workspaceId,
      projectId,
      workflowId: 'md-diar-workflow',
      sourceArtifactId: artifactId,
      sourceArtifactSha256: sha('a'),
      sourceManifestId: 'md-diar-manifest',
      sourceManifestHash: sha('b'),
      sourceTranscriptId: 'md-diar-transcript',
      sourceTranscriptHash: sha('d'),
      durationMs: 60_000,
      providerInput: {
        sha256: sha('9'),
        byteSize: 8192,
        durationMs: 60_000,
        preparation: { toolId: 'ffmpeg', toolVersion: 'static', configurationHash: sha('8') },
      },
      provider: { id: 'openai', model: 'gpt-4o-transcribe-diarize', version: 'v1' },
      segments,
      usageSeconds: 60,
      costMinorUnits: 10,
      elapsedMs: 1_000,
      requestFingerprint: sha('e'),
      idempotencyKey: `md-diar-workflow:diarization:${id}`,
      createdByClientId: clientId,
      createdAt: at(createdAtSecond).toISOString(),
    })
    const store = async (run) => {
      await client.v2SpeakerDiarizationRun.create({
        data: {
          id: run.id, workspaceId, projectId, workflowId: 'md-diar-workflow',
          sourceArtifactId: artifactId, sourceArtifactSha256: run.sourceArtifactSha256,
          sourceManifestId: run.sourceManifestId, sourceManifestHash: run.sourceManifestHash,
          sourceTranscriptId: run.sourceTranscriptId, sourceTranscriptHash: run.sourceTranscriptHash,
          durationMs: run.durationMs,
          providerInputJson: stableSerialize(run.providerInput),
          providerInputHash: calculateCanonicalHash(run.providerInput),
          schemaVersion: run.schemaVersion, policyVersion: run.policyVersion,
          providerId: run.provider.id, providerModel: run.provider.model, providerVersion: run.provider.version,
          speakerCount: run.speakerCount, segmentCount: run.segmentCount,
          usageSeconds: run.usageSeconds, costMinorUnits: run.costMinorUnits, elapsedMs: run.elapsedMs,
          identityResolved: run.identityResolved, physicalMaterialized: run.physicalMaterialized,
          requestFingerprint: run.requestFingerprint, idempotencyKey: run.idempotencyKey,
          createdByClientId: clientId, createdAt: new Date(run.createdAt),
          runJson: stableSerialize(run), runHash: run.runHash,
        },
      })
      // Written separately rather than nested: `workspaceId` and `projectId`
      // are half of the segment's composite foreign key back to its run, so a
      // nested create refuses to be told them.
      await client.v2SpeakerDiarizationSegment.createMany({
        data: run.segments.map((segment) => ({
          id: segment.id, workspaceId, projectId, runId: run.id, ordinal: segment.ordinal,
          providerSegmentId: segment.providerSegmentId, providerLabel: segment.providerLabel,
          speakerKey: segment.speakerKey, startMs: segment.startMs, endMs: segment.endMs,
          text: segment.text, textHash: segment.textHash,
          segmentJson: stableSerialize(segment), segmentHash: segment.segmentHash,
        })),
      })
    }
    const superseded = makeRun('md-diar-run-old', 10, [
      { providerSegmentId: 'old-1', providerLabel: 'A', startMs: 0, endMs: 30_000, text: 'Uma leitura antiga.' },
    ])
    const current = makeRun('md-diar-run-new', 20, [
      { providerSegmentId: 'new-1', providerLabel: 'A', startMs: 1_000, endMs: 25_000, text: 'Primeira fala.' },
      { providerSegmentId: 'new-2', providerLabel: 'B', startMs: 25_000, endMs: 50_000, text: 'Resposta do convidado.' },
    ])
    await store(superseded)
    await store(current)

    const source = new PrismaMulticamDiarizationSource(client)
    const read = await source.listLatestRunsForArtifacts({
      workspaceId, projectId, sourceArtifactIds: [artifactId, 'md-diar-absent'],
    })
    assert.equal(read.length, 1, 'one run per artifact, and the absent artifact contributes nothing')
    assert.equal(read[0].runId, current.id, 'the newest opinion about the file, not the superseded one')
    assert.equal(read[0].provider, 'openai/gpt-4o-transcribe-diarize')
    assert.equal(read[0].producedAt, current.createdAt)
    assert.deepEqual(
      read[0].segments.map((segment) => [segment.ordinal, segment.speakerKey, segment.startMs, segment.endMs]),
      current.segments.map((segment) => [segment.ordinal, segment.speakerKey, segment.startMs, segment.endMs]),
      'the milliseconds stay relative to the file, and the cluster key stays a cluster key',
    )
    assert.equal(new Set(read[0].segments.map((segment) => segment.speakerKey)).size, 2, 'two voices, still anonymous')

    // ---------------------------------------------------------------------
    // A row edited underneath is refused, not returned
    // ---------------------------------------------------------------------
    const segmentRow = await client.v2SpeakerDiarizationSegment.findFirstOrThrow({
      where: { workspaceId, runId: current.id, ordinal: 0 },
    })
    await client.v2SpeakerDiarizationSegment.update({
      where: { id: segmentRow.id },
      // A perfectly well-formed row: still inside the file, still before its
      // own end. Only the segment hash knows it moved — and this projection
      // used to read `startMs` straight off the column, so the direction would
      // have cited a speech instant nobody measured.
      data: { startMs: segmentRow.startMs + 500 },
    })
    await assert.rejects(
      () => source.listLatestRunsForArtifacts({ workspaceId, projectId, sourceArtifactIds: [artifactId] }),
      (error) => error.code === 'PERSISTENCE_CONFLICT' && /does not match its verified body/.test(error.message),
      'a segment moved under the aggregate is refused on read',
    )
    await client.v2SpeakerDiarizationSegment.update({
      where: { id: segmentRow.id },
      data: { startMs: segmentRow.startMs },
    })
    const restored = await source.listLatestRunsForArtifacts({ workspaceId, projectId, sourceArtifactIds: [artifactId] })
    assert.equal(restored[0].segments[0].startMs, current.segments[0].startMs, 'and accepted again once it is back')

    // The same for the run body itself: a `runJson` that no longer reproduces
    // its stored `runHash`.
    const tamperedBody = JSON.parse(stableSerialize(current))
    tamperedBody.durationMs = current.durationMs + 1
    await client.v2SpeakerDiarizationRun.update({
      where: { id: current.id },
      data: { runJson: JSON.stringify(tamperedBody) },
    })
    await assert.rejects(
      () => source.listLatestRunsForArtifacts({ workspaceId, projectId, sourceArtifactIds: [artifactId] }),
      (error) => error.code === 'PERSISTENCE_CONFLICT',
      'a run body edited under its own hash is refused',
    )
    await client.v2SpeakerDiarizationRun.update({
      where: { id: current.id },
      data: { runJson: stableSerialize(current) },
    })

    // Workspace scoping is the query's, not the caller's memory.
    assert.equal(
      (await source.listLatestRunsForArtifacts({ workspaceId: 'md-diar-other', projectId, sourceArtifactIds: [artifactId] })).length,
      0,
    )
    assert.equal(
      (await source.listLatestRunsForArtifacts({ workspaceId, projectId, sourceArtifactIds: [] })).length,
      0,
      'an empty artifact list is an empty answer, not a table scan',
    )
    console.log(`diarization source runs=${read.length} segments=${read[0].segments.length} speakers=${new Set(read[0].segments.map((segment) => segment.speakerKey)).size} superseded=${superseded.id}`)
  },
)

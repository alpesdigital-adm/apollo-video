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

    const world = buildDirectableMulticamWorld({ workspaceId, sessionId, projectId, endSecond: 60 })
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
    const evidence = createMulticamEvidenceSet({
      session: world.session,
      observations: [speaks('track-mic-a', [1, 25], 'cluster-a'), speaks('track-mic-b', [25, 50], 'cluster-b')],
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
    assert.equal(head.direction.shots[0].chosen.eligible, true)
    assert.deepEqual([...head.direction.shots[0].chosen.rejectionReasons], [])

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
    const { deriveMulticamEvidenceService, directMulticamSessionService } = await import('../../src/v2/application/multicam-direction.ts')
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
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
    // that follows (`project-proxy-render-repository.ts:111-141`).
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
    console.log(`multicam journey version=${result.version.sequence} clips=${storedClips.length} sources=${storedPlan.sources.length} decisions=${storedPlan.director.decisions.length} events=${events.length}`)
  },
)

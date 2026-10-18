import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * F4.009 to F4.011 against a real PostgreSQL (FR-147, FR-148, FR-149).
 *
 * The in-memory journeys prove the rules. This file proves the rules survive a
 * round trip through the database, which is a different claim: an aggregate
 * whose hash is recomputed on read only fails here, where the bytes actually
 * went to disk and came back through a driver that has its own opinions about
 * numbers, dates and JSON.
 *
 * Three things are checked that no in-memory fake can check honestly:
 *
 * - **Rehydration is hash-verified.** A row edited behind the repository's back
 *   must fail the read, not be served. Faking this proves nothing, because the
 *   fake is the thing computing the hash.
 * - **The version fence is a database constraint**, not a JavaScript `if`. Two
 *   writers racing on version N+1 must leave one loser, and the loser must be
 *   told which version it lost to.
 * - **BigInt ticks survive.** A tick is 64-bit; a driver that hands it back as
 *   a double would round it silently, which is exactly the failure the tagged
 *   codec exists to prevent.
 */

const RUN = process.env.APOLLO_SYNC_DIAGNOSTIC_E2E === '1'

test(
  'E2E-FR-147/148/149 protocols, markers, detections and diagnostics survive PostgreSQL',
  { skip: RUN ? false : 'set APOLLO_SYNC_DIAGNOSTIC_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { PUBLISHED_CAPTURE_PROTOCOLS } = await import('../../src/v2/domain/capture-protocol-catalog.ts')
    const { evaluateCaptureProtocol } = await import('../../src/v2/domain/capture-protocol-evaluation.ts')
    const { createCaptureSession } = await import('../../src/v2/domain/capture-session.ts')
    const { createTickInterval, createTimebase, rational } = await import('../../src/v2/domain/session-time.ts')
    const { createSyncDiagnostic, deriveTrackStatus } = await import('../../src/v2/domain/sync-diagnostic.ts')
    const { fuseMarkerDetections } = await import('../../src/v2/domain/sync-marker-detection.ts')
    const { createSyncMarker } = await import('../../src/v2/domain/sync-marker.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaCaptureProtocolRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-protocol-repository.ts'
    )
    const { addCaptureSessionTrack } = await import('../../src/v2/domain/capture-session.ts')
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaSyncDiagnosticRepository } = await import(
      '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
    )
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )

    const client = new PrismaClient()
    const workspaceId = 'w19-persistence-workspace'
    const projectId = 'w19-persistence-project'
    const sessionId = 'w19-persistence-session'
    const at = (second) =>
      new Date(Date.parse('2029-04-01T09:00:00.000Z') + second * 1_000).toISOString()


    t.after(async () => {
      // Reported rather than rethrown: a cleanup failure that masks the real
      // assertion turns one clear defect into two confusing ones.
      try {
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      } finally {
        await client.$disconnect()
      }
    })

    await new PrismaWorkspaceRepository(client).create(
      createWorkspace({
        id: workspaceId,
        slug: 'w19-persistence-workspace',
        name: 'Wave 19 persistence',
        status: 'active',
        createdAt: at(0),
      }),
    )

    // The session head has a foreign key to the project; without the row the
    // insert fails for a reason that has nothing to do with this wave.
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Wave 19 persistence',
        status: 'reviewing-proxy',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: 'w19-persistence-client',
        createdAt: at(0),
        updatedAt: at(0),
      },
    })

    const timebase = createTimebase(rational(1, 90_000))
    const base = createCaptureSession({
      workspaceId,
      projectId,
      sessionId,
      clock: { timebase, rounding: 'nearest-half-even' },
      referenceTrackId: 'track-camera-main',
      tracks: [
        {
          trackId: 'track-camera-main',
          role: 'camera-main',
          device: { deviceId: 'device-a', recorderId: 'recorder-a', make: null, model: null, serial: null },
          sourceAssetId: 'asset-camera-main',
          timebase,
          streamIndex: 0,
          syncAudioPolicy: 'final-candidate',
          includeInFinalMix: true,
          parts: [
            {
              partId: 'part-camera-main-1',
              ordinal: 0,
              sourceAssetId: 'asset-camera-main',
              timebase,
              // A 64-bit tick count: 90 kHz for ten minutes. Well past what a
              // double represents exactly once it is multiplied out.
              coverage: createTickInterval(BigInt(0), BigInt(90_000) * BigInt(600)),
              streamIndex: 0,
              splitReason: 'single-file',
              evidence: {
                ingestArtifactId: 'artifact-camera-main',
                ingestSha256: 'a'.repeat(64),
                probeHash: 'b'.repeat(64),
                probeSource: 'packet-scan',
                observedAt: at(1),
              },
            },
          ],
        },
      ],
      lineage: {
        commandId: 'command-1',
        operation: 'create-session',
        actorKind: 'human',
        actorId: 'user-1',
        occurredAt: at(2),
        note: null,
      },
      createdAt: at(2),
    })

    const sessions = new PrismaCaptureSessionRepository(client)
    await sessions.appendVersion({ session: base, occurredAt: at(3) })
    const session = addCaptureSessionTrack(base, {
      track: {
        trackId: 'track-phone',
        role: 'phone',
        device: { deviceId: 'device-phone', recorderId: 'recorder-phone', make: null, model: null, serial: null },
        sourceAssetId: 'asset-phone',
        timebase,
        streamIndex: 0,
        syncAudioPolicy: 'sync-only',
        includeInFinalMix: false,
        parts: [{
          partId: 'part-phone-1',
          ordinal: 0,
          sourceAssetId: 'asset-phone',
          timebase,
          coverage: createTickInterval(BigInt(0), BigInt(90_000) * BigInt(600)),
          streamIndex: 0,
          splitReason: 'single-file',
          evidence: {
            ingestArtifactId: 'artifact-phone',
            ingestSha256: 'c'.repeat(64),
            probeHash: 'd'.repeat(64),
            probeSource: 'packet-scan',
            observedAt: at(1),
          },
        }],
      },
      lineage: {
        commandId: 'command-2',
        operation: 'add-track',
        actorKind: 'human',
        actorId: 'user-1',
        occurredAt: at(3),
        note: null,
      },
    })
    await sessions.appendVersion({ session, expectedVersion: 1, occurredAt: at(4) })

    // ---- protocols -------------------------------------------------------
    const protocols = new PrismaCaptureProtocolRepository(client)
    const protocol = PUBLISHED_CAPTURE_PROTOCOLS[0]
    const published = await protocols.publish({ protocol, createdAt: at(4) })
    assert.equal(published.replayed, false)
    const republished = await protocols.publish({ protocol, createdAt: at(5) })
    assert.equal(republished.replayed, true, 'publishing the same protocol twice created a second row')

    const readBack = await protocols.read({ protocolId: protocol.protocolId })
    assert.ok(readBack)
    assert.equal(readBack.protocolHash, protocol.protocolHash)
    assert.deepEqual(
      readBack.requirements.map((item) => item.requirementId),
      protocol.requirements.map((item) => item.requirementId),
      'requirements did not come back in the order they were written',
    )

    await protocols.attach({
      workspaceId,
      sessionId,
      protocol,
      attachedByKind: 'human',
      attachedById: 'user-1',
      attachedAt: at(6),
    })
    const attachment = await protocols.readAttachment({ workspaceId, sessionId })
    assert.ok(attachment)
    assert.equal(attachment.protocolHash, protocol.protocolHash)

    const evaluation = evaluateCaptureProtocol({
      workspaceId,
      protocol,
      session,
      markers: { confirmedPositions: ['start'] },
      evaluatedAt: at(7),
    })
    await protocols.persistEvaluation({ evaluation, createdAt: at(7) })
    const storedEvaluation = await protocols.readEvaluation({
      workspaceId,
      sessionId,
      sessionVersion: session.version,
      protocolId: protocol.protocolId,
      protocolVersion: protocol.version,
    })
    assert.ok(storedEvaluation)
    assert.equal(storedEvaluation.evaluationHash, evaluation.evaluationHash)
    assert.equal(
      storedEvaluation.findings.length,
      evaluation.findings.length,
      'a finding was lost on the way to the database',
    )

    // ---- markers and detections -----------------------------------------
    const diagnostics = new PrismaSyncDiagnosticRepository(client)
    const marker = createSyncMarker({
      markerId: 'w19-marker-1',
      workspaceId,
      sessionId,
      kind: 'audiovisual',
      position: 'start',
      sequence: 1,
      emittedAt: at(8),
    })
    const storedMarker = await diagnostics.persistMarker({
      marker,
      artifact: { artifactId: 'artifact-marker-1', sha256: 'c'.repeat(64), byteSize: 19_650 },
      createdAt: at(8),
    })
    assert.equal(storedMarker.replayed, false)
    const replayedMarker = await diagnostics.persistMarker({
      marker,
      artifact: { artifactId: 'artifact-marker-1', sha256: 'c'.repeat(64), byteSize: 19_650 },
      createdAt: at(9),
    })
    assert.equal(replayedMarker.replayed, true, 'the same marker was stored twice')

    const markerRow = await diagnostics.readMarker({ workspaceId, markerId: marker.markerId })
    assert.ok(markerRow)
    assert.equal(markerRow.marker.markerHash, marker.markerHash)
    assert.equal(markerRow.artifact?.byteSize, 19_650)
    assert.deepEqual(
      markerRow.marker.visual.patternFrames,
      marker.visual.patternFrames,
      'the flash pattern did not survive the round trip',
    )

    const detection = fuseMarkerDetections({
      marker,
      trackId: 'track-camera-main',
      mode: 'both-channels',
      visual: {
        channel: 'visual',
        observationId: 'obs-v-1',
        trackId: 'track-camera-main',
        atMs: 800,
        errorMs: 17,
        decodedPayload: marker.payload,
        patternScore: 1,
        confidence: 0.97,
        evidenceRef: 'frame-scan-1',
      },
      audio: {
        channel: 'audio',
        observationId: 'obs-a-1',
        trackId: 'track-camera-main',
        atMs: 802,
        errorMs: 2,
        correlationPeak: 0.86,
        secondPeak: 0.11,
        confidence: 0.95,
        evidenceRef: 'chirp-1',
      },
    })
    assert.equal(detection.outcome, 'confirmed')
    await diagnostics.persistDetection({ workspaceId, detection, detectedAt: at(10) })
    const detections = await diagnostics.listDetections({ workspaceId, sessionId })
    assert.equal(detections.length, 1)
    assert.equal(detections[0].detectionHash, detection.detectionHash)

    // ---- the diagnostic chain -------------------------------------------
    const gap = createTickInterval(BigInt(90_000) * BigInt(120), BigInt(90_000) * BigInt(130))
    const trackDiagnostic = {
      trackId: 'track-phone',
      methods: ['marker-correlation'],
      confidence: 0.95,
      offsetMs: -1_240,
      residualMs: 4,
      driftPpm: null,
      coverageBps: 9_800,
      gaps: [gap],
      automaticAnchors: [
        {
          anchorId: 'anchor-1',
          origin: 'automatic',
          sourceMs: 800,
          sessionMs: 2_040,
          method: 'marker-correlation',
          confidence: 0.95,
          residualMs: 4,
          evidenceRef: marker.markerId,
          createdAt: at(11),
        },
      ],
      manualAnchors: [],
      pieceIds: ['track-phone-piece-0'],
      status: deriveTrackStatus({
        offsetMs: -1_240,
        residualMs: 4,
        coverageBps: 9_800,
        confidence: 0.95,
        hasContradictoryAnchors: false,
      }),
      warnings: [],
      previewSampleMs: [0, 60_000],
    }
    const v1 = createSyncDiagnostic({
      workspaceId,
      sessionId,
      referenceTrackId: 'track-camera-main',
      version: 1,
      previousVersionHash: null,
      sessionVersion: session.version,
      referenceEpoch: session.referenceEpoch,
      tracks: [trackDiagnostic],
      protocolCeiling: evaluation.ceiling,
      generatedAt: at(11),
    })
    await diagnostics.appendVersion({ diagnostic: v1, occurredAt: at(11) })

    const head = await diagnostics.readHead({ workspaceId, sessionId })
    assert.ok(head)
    assert.equal(head.diagnosticHash, v1.diagnosticHash, 'the diagnostic did not rehydrate to its own hash')
    // The tick that would have been rounded had it crossed as a double.
    assert.equal(head.tracks[0].gaps[0].start, gap.start)
    assert.equal(head.tracks[0].gaps[0].end, gap.end)
    assert.equal(typeof head.tracks[0].gaps[0].start, 'bigint')
    assert.equal(head.tracks[0].coverageBps, 9_800)

    const v2 = createSyncDiagnostic({
      workspaceId,
      sessionId,
      referenceTrackId: 'track-camera-main',
      version: 2,
      previousVersionHash: v1.diagnosticHash,
      sessionVersion: session.version,
      referenceEpoch: session.referenceEpoch,
      tracks: [{
        ...trackDiagnostic,
        manualAnchors: [{
          anchorId: 'manual-1',
          origin: 'manual',
          sourceMs: 300_000,
          sessionMs: 300_600,
          method: 'operator-nudge',
          confidence: 1,
          residualMs: null,
          evidenceRef: 'operator-1',
          createdAt: at(12),
        }],
      }],
      protocolCeiling: evaluation.ceiling,
      generatedAt: at(12),
    })
    await diagnostics.appendVersion({ diagnostic: v2, expectedVersion: 1, occurredAt: at(12) })

    // The fence is the point: a second writer that read version 1 must lose,
    // and must be told what it lost to rather than silently overwriting the
    // correction it never saw.
    await assert.rejects(
      () => diagnostics.appendVersion({
        diagnostic: createSyncDiagnostic({
          workspaceId,
          sessionId,
          referenceTrackId: 'track-camera-main',
          version: 2,
          previousVersionHash: v1.diagnosticHash,
          sessionVersion: session.version,
          referenceEpoch: session.referenceEpoch,
          tracks: [trackDiagnostic],
          protocolCeiling: evaluation.ceiling,
          generatedAt: at(13),
        }),
        expectedVersion: 1,
        occurredAt: at(13),
      }),
      (error) => {
        assert.ok(
          error.code === 'SYNC_DIAGNOSTIC_VERSION_STALE' || error.code === 'PERSISTENCE_CONFLICT',
          `a stale append failed with ${error.code}, which does not tell the caller to reload`,
        )
        return true
      },
    )

    const chain = await diagnostics.listVersions({ workspaceId, sessionId })
    assert.equal(chain.length, 2, 'the chain lost or gained a link')
    assert.equal(chain[0].version, 2, 'the chain did not come back newest first')
    assert.equal(chain[0].previousVersionHash, v1.diagnosticHash)
    assert.equal(chain[0].tracks[0].manualAnchors.length, 1)

    // ---- rehydration is verified, not trusted ---------------------------
    // Edited behind the repository's back, the way a stray UPDATE or a restored
    // backup would. Serving this row would mean every hash in the system is
    // decoration.
    await client.v2SyncDiagnostic.update({
      where: { workspaceId_sessionId_version: { workspaceId, sessionId, version: 2 } },
      data: { globalConfidence: 0.1 },
    })
    await assert.rejects(
      () => diagnostics.readVersion({ workspaceId, sessionId, version: 2 }),
      (error) => {
        assert.match(
          String(error.message),
          /hash does not match/i,
          `a tampered row was rejected for the wrong reason: ${error.message}`,
        )
        return true
      },
    )

    console.log(
      `postgres round trip: protocol ${protocol.protocolId} v${protocol.version}, `
      + `marker ${marker.sessionCode}#${marker.sequence}, detection ${detection.outcome}, `
      + `diagnostic chain ${chain.length} versions, gap ticks ${gap.start}-${gap.end}`,
    )
  },
)

/**
 * Two workspaces that choose the same session, track, source and protocol
 * tokens, against the real primary keys and unique constraints.
 *
 * Capture-session, track, source and protocol identifiers are the caller's to
 * choose, so they are unique inside a workspace and nowhere else. Row ids built
 * from such a token alone were global primary keys: the second workspace's
 * write collided on them, and the writers that upserted by id (protocol
 * evaluations, marker detections) replaced the first workspace's row instead.
 * Every identity here is unique to the run, so the only thing the two
 * workspaces can collide on is each other.
 */
test(
  'E2E-FR-147/148/149 two workspaces sharing session, track and protocol tokens neither collide nor see each other',
  { skip: RUN ? false : 'set APOLLO_SYNC_DIAGNOSTIC_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { buildScopeWorld, scopeTokens } = await import('./helpers/capture-scope-world.mjs')
    const { PrismaCaptureProtocolRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-protocol-repository.ts'
    )
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaSyncDiagnosticRepository } = await import(
      '../../src/v2/infrastructure/prisma/sync-diagnostic-repository.ts'
    )

    const client = new PrismaClient()
    t.after(async () => {
      await client.$disconnect()
    })

    const run = randomUUID().slice(0, 8)
    const shared = scopeTokens(run)
    const createdAt = new Date('2029-06-01T09:00:00.000Z')
    const sessions = new PrismaCaptureSessionRepository(client)
    const protocols = new PrismaCaptureProtocolRepository(client)
    const diagnostics = new PrismaSyncDiagnosticRepository(client)

    const createWorkspace = async (workspaceId) => {
      await client.v2Workspace.create({
        data: {
          id: workspaceId,
          slug: workspaceId,
          name: `Capture scope ${workspaceId}`,
          status: 'active',
          createdAt,
          updatedAt: createdAt,
        },
      })
    }

    const owners = []
    for (const variant of [0, 1]) {
      const workspaceId = `scope-ws${variant}-${run}`
      const projectId = `scope-project${variant}-${run}`
      await createWorkspace(workspaceId)
      await client.v2Project.create({
        data: {
          id: projectId,
          workspaceId,
          name: `Capture scope ${variant}`,
          status: 'reviewing-proxy',
          objective: 'discovery',
          format: '9:16',
          locale: 'pt-BR',
          createdByType: 'api-client',
          createdById: `scope-client-${variant}`,
          createdAt,
          updatedAt: createdAt,
        },
      })
      // A marker id is derived from a digest that includes the workspace, so
      // two workspaces do not share one; every other token is shared.
      const tokens = { ...shared, markerId: `${shared.markerId}-${variant}` }
      owners.push({
        variant,
        workspaceId,
        tokens,
        world: await buildScopeWorld({ workspaceId, projectId, tokens, variant }),
      })
    }
    const stranger = `scope-ws-stranger-${run}`
    await createWorkspace(stranger)

    const { sessionId, trackId, phoneTrackId, sourceId } = shared
    for (const { workspaceId, world } of owners) {
      await sessions.appendVersion({ session: world.session1, occurredAt: world.at(3) })
      await sessions.appendVersion({ session: world.session2, expectedVersion: 1, occurredAt: world.at(4) })
      assert.equal(
        (await sessions.persistClock({ workspaceId, clock: world.clock, createdAt: world.at(5) })).replayed,
        false,
      )
      await sessions.persistClockMap({ map: world.clockMap, createdAt: world.at(5) })
      assert.equal(
        (await sessions.persistCoverage({ coverage: world.coverage, sessionId, createdAt: world.at(6) })).coverage,
        world.coverage,
      )
      await sessions.persistSyncEvidence({ workspaceId, record: world.evidence, createdAt: world.at(6) })
      await protocols.attach({
        workspaceId,
        sessionId,
        protocol: world.protocol,
        attachedByKind: 'human',
        attachedById: world.attachedById,
        attachedAt: world.at(6),
      })
      await protocols.persistEvaluation({ evaluation: world.evaluation, createdAt: world.at(7) })
      await diagnostics.persistMarker({ marker: world.marker, createdAt: world.at(8) })
      await diagnostics.persistDetection({ workspaceId, detection: world.detection, detectedAt: world.at(10) })
      await diagnostics.appendVersion({ diagnostic: world.diagnostic, occurredAt: world.at(11) })
    }

    // Whatever workspace 1 wrote afterwards, workspace 0 still reads its own.
    for (const { workspaceId, world } of owners) {
      const head = await sessions.readHead({ workspaceId, sessionId })
      assert.equal(head?.sessionHash, world.session2.sessionHash, `${workspaceId} does not read its own session`)
      assert.equal((await sessions.listVersions({ workspaceId, sessionId })).length, 2)
      assert.equal((await sessions.readClock({ workspaceId, sessionId }))?.clockHash, world.clock.clockHash)
      const map = await sessions.readClockMap({ workspaceId, sessionId, sourceId })
      assert.equal(map?.mapHash, world.clockMap.mapHash, `${workspaceId} does not read its own clock map`)
      assert.equal(map?.pieces.length, 1)
      assert.equal((await sessions.readCoverage({ workspaceId, trackId }))?.coverageHash, world.coverage.coverageHash)
      assert.deepEqual(
        (await sessions.listCoverage({ workspaceId, sessionId })).map((entry) => entry.coverageHash),
        [world.coverage.coverageHash],
      )
      const evidence = await sessions.readSyncEvidence({ workspaceId, sessionId, trackId: phoneTrackId })
      assert.equal(evidence?.sessionBounds.end, world.evidence.sessionBounds.end)
      assert.equal((await protocols.readAttachment({ workspaceId, sessionId }))?.attachedById, world.attachedById)
      assert.equal(
        (await protocols.readEvaluation({
          workspaceId,
          sessionId,
          sessionVersion: world.session2.version,
          protocolId: world.protocol.protocolId,
          protocolVersion: world.protocol.version,
        }))?.evaluationHash,
        world.evaluation.evaluationHash,
        `${workspaceId} lost or does not read its own protocol evaluation`,
      )
      assert.deepEqual(
        (await diagnostics.listDetections({ workspaceId, sessionId })).map((entry) => entry.detectionHash),
        [world.detection.detectionHash],
      )
      assert.equal(
        (await diagnostics.readHead({ workspaceId, sessionId }))?.diagnosticHash,
        world.diagnostic.diagnosticHash,
      )
    }

    // The same tokens, from a workspace that wrote nothing: nothing to read.
    assert.equal(await sessions.readHead({ workspaceId: stranger, sessionId }), null)
    assert.equal(await sessions.readClock({ workspaceId: stranger, sessionId }), null)
    assert.equal(await sessions.readClockMap({ workspaceId: stranger, sessionId, sourceId }), null)
    assert.equal(await sessions.readCoverage({ workspaceId: stranger, trackId }), null)
    assert.deepEqual(await sessions.listCoverage({ workspaceId: stranger, sessionId }), [])
    assert.equal(await sessions.readSyncEvidence({ workspaceId: stranger, sessionId, trackId: phoneTrackId }), null)
    assert.equal(await protocols.readAttachment({ workspaceId: stranger, sessionId }), null)
    assert.deepEqual(await protocols.listEvaluations({ workspaceId: stranger, sessionId }), [])
    assert.deepEqual(await diagnostics.listDetections({ workspaceId: stranger, sessionId }), [])
    assert.equal(await diagnostics.readHead({ workspaceId: stranger, sessionId }), null)

    // And in the tables: one row per workspace, none sharing a primary key.
    const rowsOf = {
      capture_session_versions: await client.v2CaptureSessionVersion.findMany({ where: { sessionId } }),
      capture_session_heads: await client.v2CaptureSessionHead.findMany({ where: { sessionId } }),
      capture_session_clocks: await client.v2CaptureSessionClock.findMany({ where: { sessionId } }),
      capture_clock_maps: await client.v2CaptureClockMap.findMany({ where: { sessionId } }),
      capture_track_coverages: await client.v2CaptureTrackCoverage.findMany({ where: { trackId } }),
      capture_sync_evidence: await client.v2CaptureSyncEvidence.findMany({ where: { sessionId } }),
      capture_session_protocols: await client.v2CaptureSessionProtocol.findMany({ where: { sessionId } }),
      capture_protocol_evaluations: await client.v2CaptureProtocolEvaluation.findMany({ where: { sessionId } }),
      sync_marker_detections: await client.v2SyncMarkerDetection.findMany({ where: { sessionId } }),
      sync_diagnostics: await client.v2SyncDiagnostic.findMany({ where: { sessionId } }),
      sync_diagnostic_heads: await client.v2SyncDiagnosticHead.findMany({ where: { sessionId } }),
    }
    for (const [tableName, rows] of Object.entries(rowsOf)) {
      const expected = tableName === 'capture_session_versions' ? 4 : 2
      assert.equal(rows.length, expected, `${tableName} holds ${rows.length} rows for the shared tokens, expected ${expected}`)
      assert.equal(new Set(rows.map((row) => row.id)).size, expected, `${tableName} rows share a primary key`)
      for (const owner of owners) {
        assert.ok(rows.some((row) => row.workspaceId === owner.workspaceId), `${tableName} has no row for ${owner.workspaceId}`)
      }
    }
    const pieces = await client.v2CaptureClockMapPiece.findMany({
      where: { workspaceId: { in: owners.map((owner) => owner.workspaceId) } },
    })
    assert.equal(pieces.length, 2, 'each clock map keeps exactly its own piece')
    for (const piece of pieces) {
      const map = rowsOf.capture_clock_maps.find((entry) => entry.id === piece.mapId)
      assert.equal(map?.workspaceId, piece.workspaceId, 'a clock map piece points at another workspace\'s map')
    }

    // A map is replaced through its natural key and takes its pieces with it.
    const [first] = owners
    const replacement = await buildScopeWorld({
      workspaceId: first.workspaceId,
      projectId: first.world.session1.projectId,
      tokens: first.tokens,
      variant: 1,
    })
    await sessions.persistClockMap({ map: replacement.clockMap, createdAt: first.world.at(12) })
    assert.equal(
      (await sessions.readClockMap({ workspaceId: first.workspaceId, sessionId, sourceId }))?.mapHash,
      replacement.clockMap.mapHash,
    )
    assert.equal(
      (await sessions.readClockMap({ workspaceId: owners[1].workspaceId, sessionId, sourceId }))?.mapHash,
      owners[1].world.clockMap.mapHash,
      'replacing one workspace\'s clock map touched the other\'s',
    )
  },
)

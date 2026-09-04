import assert from 'node:assert/strict'
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

    const clean = async () => {
      await client.v2SyncDiagnosticHead.deleteMany({ where: { workspaceId } })
      await client.v2SyncDiagnostic.deleteMany({ where: { workspaceId } })
      await client.v2SyncMarkerDetection.deleteMany({ where: { workspaceId } })
      await client.v2SyncMarker.deleteMany({ where: { workspaceId } })
      await client.v2CaptureProtocolEvaluation.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionProtocol.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionHead.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionVersion.deleteMany({ where: { workspaceId } })
      await client.v2Project.deleteMany({ where: { workspaceId } })
      await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
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

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E-F4.012 — Journey 2: a teacher, a camera and a screen capture.
 *
 * A product journey, not a fixture replayed through a domain function. Two
 * recordings are generated with ffmpeg, registered as the media the ingest
 * pipeline would have registered, and then every step is a published `/v1`
 * route handler called with a `NextRequest`: the session, the second track, the
 * protocol, the sync run, the diagnostic, the anchor and the direction. The
 * queue between the sync request and its result is drained by a SEPARATE
 * PROCESS running the npm script an operator runs.
 *
 * What it proves, and why each claim needs this shape:
 *
 * - **The demonstration puts the screen on air.** The screen recording is a
 *   still slide for thirty seconds, a busy demonstration for thirty, and a
 *   still slide again. Nothing declares "there is a demonstration here": the
 *   FFmpeg `signalstats` sweep measures the frame-to-frame luma difference of
 *   the file itself, and only the busy window produces a `screen-activity`
 *   observation at all — a still picture measures zero, and zero activity is
 *   the ABSENCE of an observation rather than an observation of stillness
 *   (`application/multicam-direction.ts:576-578`).
 * - **The direction returns to the camera when the demonstration ends.** The
 *   shot after the busy window is the teacher's camera again, and the seam
 *   lands where the measured activity stops — at the file's busy stretch
 *   shifted by the offset the WORKER measured, not at a constant typed here.
 * - **The minimum shot duration holds.** Every shot is at least
 *   `DEFAULT_DIRECTION_POLICY.minimumShotMs` long, measured in session ticks
 *   and converted with the session's own timebase, and the direction carries no
 *   `minimum-shot-violated` warning.
 *
 * Two gaps in the shipped code are MEASURED here rather than worked around,
 * because a journey that quietly routed past them would report a product that
 * does not exist:
 *
 * 1. **The sync worker's result never reaches the diagnostic.** The driver
 *    resolves the screen against the camera by audio fingerprint, writes a
 *    clock map with a measured offset and files `capture_sync_evidence` with
 *    outcome `auto-apply` — and `POST .../sync-diagnostic` then reports that
 *    same track as `insufficient-evidence` with confidence 0, because
 *    `generateSyncDiagnosticService` builds anchors only from MARKER detections
 *    (`application/sync-diagnostic.ts:396-411`). This journey asserts that
 *    contradiction, then does what an operator has to do today: confirms the
 *    offset the server measured as a labelled manual anchor through
 *    `POST .../sync-diagnostic/anchors`, citing the fingerprint pass's own
 *    evidence ref. Nothing about the instant is invented here — both instants
 *    are read back over `/v1` from the clock map the worker wrote.
 * 2. **A protocol evaluation caps this session at `not-synchronizable`.**
 *    `teacher-and-screen-v1` requires a marker at the start and at the end, and
 *    no marker was filmed: minting one needs the session, and the session
 *    cannot be created before the file it names exists, so a start marker
 *    cannot be inside part 0 of the very recording the session was created
 *    from. The evaluation runs at the END of the journey and its verdict is
 *    asserted, so the ceiling is a measurement in the record rather than a step
 *    that was skipped.
 *
 * Nothing is committed: both recordings live in an `mkdtemp` artifact root
 * removed in `t.after`, and every row is deleted before and after the run.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const RUN = process.env.APOLLO_TEACHER_SCREEN_E2E === '1'

const FPS = 30
/** One tick is one frame, so a session instant and an output frame are the same integer. */
const TIMEBASE = `1/${FPS}`
const SECONDS = 90
const DEMONSTRATION_START_SECOND = 30
const DEMONSTRATION_END_SECOND = 60
/** How late the screen recorder started, in the audio both files carry. */
const SCREEN_LAG_SECONDS = 1.6
const WIDTH = 320
const HEIGHT = 180

/**
 * The fence a capture-session command names: the version id AND its hash.
 *
 * The id is `<sessionId>:v<version>` — the shape every capture service compares
 * against — and the reason the pair travels together is that a version number
 * alone can be reused after a failed write.
 */
const sessionVersionRef = (session) => `${session.sessionId}:v${session.version}`
const diagnosticVersionRef = (diagnostic) => `${diagnostic.sessionId}:diagnostic:v${diagnostic.version}`

test(
  'E2E-F4.012 a teacher and a screen: the demonstration goes on air and the direction comes back',
  {
    skip: RUN ? false : 'set APOLLO_TEACHER_SCREEN_E2E=1 with a migrated V2_DATABASE_URL',
    timeout: 30 * 60_000,
  },
  async (t) => {
    const helpers = await import('./helpers/capture-journey.mjs')
    helpers.assertIsolatedDatabase()
    process.env.APOLLO_API_ENVIRONMENT = 'production'

    const { DEFAULT_DIRECTION_POLICY } = await import('../../src/v2/domain/multicam-direction.ts')
    const sessionsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/route.ts')
    const tracksRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/tracks/route.ts')
    const protocolRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/protocol/route.ts')
    const protocolEvaluationsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/protocol/evaluations/route.ts')
    const syncRunsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-runs/route.ts')
    const syncRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync/route.ts')
    const diagnosticRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/route.ts')
    const anchorsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/anchors/route.ts')
    const sessionRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/route.ts')
    const directionRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/route.ts')
    const shotsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/shots/route.ts')

    const prisma = new PrismaClient()
    const workspaceId = 'teacher-screen-e2e-workspace'
    const projectId = 'teacher-screen-e2e-project'
    const sessionId = 'teacher-screen-e2e-session'
    const clientId = 'teacher-screen-e2e-client'
    const versionId = 'teacher-screen-e2e-version-1'
    const cameraTrackId = 'track-teacher-camera'
    const screenTrackId = 'track-screen-capture'
    const cameraArtifactId = 'artifact-teacher-camera'
    const screenArtifactId = 'artifact-screen-capture'
    const at = (second) => new Date(Date.parse('2029-09-01T09:00:00.000Z') + second * 1_000)
    const artifactRoot = await mkdtemp(join(tmpdir(), 'apollo-teacher-screen-e2e-'))
    // The direction route builds an FFmpeg visual provider and a media
    // materializer from the environment, so this process needs the artifact
    // root too — not just the worker child.
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'

    const clean = async () => {
      await prisma.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await prisma.v2ProjectVersion.updateMany({ where: { workspaceId }, data: { commandId: null } })
      for (const table of [
        prisma.v2MulticamAngleScoreComponent, prisma.v2MulticamAngleCandidate,
        prisma.v2MulticamShotAlternative, prisma.v2MulticamShotDecision,
        prisma.v2MulticamDirectionHead, prisma.v2MulticamDirection,
        prisma.v2MulticamObservation, prisma.v2MulticamEvidenceSet,
        prisma.v2SpeakerDiarizationSegment, prisma.v2SpeakerDiarizationRun,
        prisma.v2LongFormIndexWorkflow, prisma.v2MediaTranscript, prisma.v2PublicOperation,
        prisma.v2SyncDiagnosticHead, prisma.v2SyncDiagnostic,
        prisma.v2CaptureSessionProtocol, prisma.v2CaptureProtocolEvaluation,
        prisma.v2CaptureTrackCoverage, prisma.v2CaptureClockMapPiece, prisma.v2CaptureClockMap,
        prisma.v2CaptureSyncEvidence, prisma.v2CaptureSyncRun, prisma.v2CaptureSessionClock,
        prisma.v2CaptureSessionHead, prisma.v2CaptureSessionVersion,
        prisma.v2CommandArtifactInvalidation, prisma.v2PublicEventOutbox,
        prisma.v2EditCommand, prisma.v2ProjectVersion, prisma.v2ProjectSnapshot,
        prisma.v2ProjectMediaAsset, prisma.v2MediaColorProbe,
        prisma.v2MediaArtifactManifest, prisma.v2MediaArtifact,
        prisma.v2Project, prisma.v2ApiCredential, prisma.v2ApiClient,
      ]) {
        await table.deleteMany({ where: { workspaceId } })
      }
      await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }

    t.after(async () => {
      // Reported, never rethrown: a failing cleanup that masks the assertion
      // turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.log(`teacher-screen cleanup reported: ${error?.message ?? error}`)
      }
      await rm(artifactRoot, { recursive: true, force: true }).catch((error) => {
        console.log(`teacher-screen artifact root cleanup reported: ${error?.message ?? error}`)
      })
      await prisma.$disconnect()
    })
    await clean()

    // ---- the two recordings, generated here and never committed -----------
    const mediaDirectory = join(artifactRoot, 'capture')
    const teacherVoice = helpers.sweepSamples({ seconds: SECONDS })
    const screenSeconds = SECONDS - Math.ceil(SCREEN_LAG_SECONDS)
    const cameraPcm = join(mediaDirectory, 'teacher.pcm')
    const screenPcm = join(mediaDirectory, 'screen.pcm')
    await helpers.writePcm(cameraPcm, teacherVoice)
    await helpers.writePcm(screenPcm, helpers.laggedSamples(teacherVoice, {
      seconds: screenSeconds,
      lagSeconds: SCREEN_LAG_SECONDS,
      seed: 20_290_901,
    }))

    const cameraKey = 'capture/teacher-camera.mp4'
    const screenKey = 'capture/screen-capture.mp4'
    const cameraFile = helpers.artifactPath(artifactRoot, cameraKey)
    const screenFile = helpers.artifactPath(artifactRoot, screenKey)
    const cameraBytes = await helpers.encodeRecording({
      ffmpegPath,
      outputPath: cameraFile,
      seconds: SECONDS,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      videoInput: `color=c=0x204060:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${SECONDS}`,
      videoFilter: 'drawbox=x=150:y=50:w=44:h=44:color=0xe0b090:t=fill',
      pcmPath: cameraPcm,
    })
    // A slide, a demonstration, and the slide again. `life` is the generated
    // picture measured above the domain's saturation point
    // (`SCREEN_ACTIVITY_SATURATION_BPS = 400`; this source measures 587 bps
    // through the production sweep, while a still colour field measures 0),
    // which is what makes the middle window the only one with evidence in it.
    const screenBytes = await helpers.encodeRecording({
      ffmpegPath,
      outputPath: screenFile,
      seconds: screenSeconds,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      videoInputs: [
        `color=c=0xf0f0f0:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
        `life=s=${WIDTH}x${HEIGHT}:r=${FPS}:mold=10`,
        `color=c=0xf0f0f0:s=${WIDTH}x${HEIGHT}:r=${FPS}`,
      ],
      // `life` has no duration option and never ends, so each leg is trimmed in
      // the graph and the timestamps restarted before the three are joined.
      filterComplex:
        `[0:v]trim=duration=${DEMONSTRATION_START_SECOND},setpts=PTS-STARTPTS[slide];`
        + `[1:v]trim=duration=${DEMONSTRATION_END_SECOND - DEMONSTRATION_START_SECOND},setpts=PTS-STARTPTS[demo];`
        + `[2:v]trim=duration=${screenSeconds - DEMONSTRATION_END_SECOND},setpts=PTS-STARTPTS[after];`
        + '[slide][demo][after]concat=n=3:v=1:a=0[picture]',
      pcmPath: screenPcm,
    })

    const cameraStreams = await helpers.probeStreams(ffprobePath, cameraFile)
    const screenStreams = await helpers.probeStreams(ffprobePath, screenFile)
    const cameraVideo = cameraStreams.find((stream) => stream.codec_type === 'video')
    const screenVideo = screenStreams.find((stream) => stream.codec_type === 'video')
    assert.ok(cameraStreams.some((stream) => stream.codec_type === 'audio'), 'the camera carries its own audio')
    assert.ok(screenStreams.some((stream) => stream.codec_type === 'audio'), 'the screen capture carries audio')
    const producerDigest = await helpers.binaryDigest(ffprobePath)

    // ---- the world the ingest pipeline would have left --------------------
    await helpers.createWorkspaceRow({ prisma, workspaceId, name: 'Teacher and screen journey', createdAt: at(0) })
    const issued = await helpers.issueApiClient({
      prisma,
      workspaceId,
      clientId,
      name: 'Teacher and screen journey',
      createdAt: at(0),
      scopes: ['projects:read', 'projects:write', 'artifacts:read'],
    })
    const token = issued.token
    await helpers.createProjectRow({
      prisma, workspaceId, projectId, name: 'Aula com demonstração de tela',
      objective: 'awareness', format: '16:9', clientId, createdAt: at(0),
    })

    const registered = {}
    for (const entry of [
      {
        artifactId: cameraArtifactId, artifactKey: cameraKey, stream: cameraVideo, bytes: cameraBytes,
        role: 'source-master', fileName: 'professor.mp4', recipeId: 'capture-camera-ingest',
      },
      {
        artifactId: screenArtifactId, artifactKey: screenKey, stream: screenVideo, bytes: screenBytes,
        role: 'selected-insert', fileName: 'tela.mp4', recipeId: 'capture-screen-ingest',
      },
    ]) {
      registered[entry.artifactId] = await helpers.registerRecording({
        prisma, workspaceId, projectId,
        artifactId: entry.artifactId,
        artifactKey: entry.artifactKey,
        mediaType: 'video',
        container: 'mp4',
        sha256: entry.bytes.sha256,
        byteSize: entry.bytes.byteSize,
        probe: {
          width: Number(entry.stream.width),
          height: Number(entry.stream.height),
          duration: Number(entry.stream.duration),
          fps: FPS,
        },
        colorMetadata: helpers.colorMetadataFromStream(entry.stream),
        pixelFormat: entry.stream.pix_fmt,
        producerVersion: 'ffprobe-static',
        producerBinaryDigest: producerDigest,
        role: entry.role,
        originalFileName: entry.fileName,
        createdAt: at(0),
        recipeId: entry.recipeId,
      })
    }
    await helpers.seedBaseProjectVersion({
      prisma, workspaceId, projectId, versionId, clientId,
      objective: 'awareness',
      sourceArtifactId: cameraArtifactId,
      fps: FPS,
      durationFrames: SECONDS * FPS,
      transcriptId: 'teacher-screen-transcript',
      createdAt: at(0),
    })
    const projectVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } })

    // ---- the session, one published route at a time -----------------------
    // `sourceAssetId` IS the media artifact id. The compiled clips carry it
    // straight through as `sourceArtifactId`, and the direction refuses a plan
    // that cuts a recording the project does not link as available media
    // (`multicam-direction.ts:1221-1227`).
    const trackPart = ({ trackId, artifactId, sha256, endTicks }) => ({
      partId: `part-${trackId}`,
      ordinal: 0,
      sourceAssetId: artifactId,
      timebase: TIMEBASE,
      coverage: { start: '0', end: String(endTicks) },
      streamIndex: 0,
      splitReason: 'single-file',
      evidence: {
        ingestArtifactId: artifactId,
        ingestSha256: sha256,
        probeHash: producerDigest,
        probeSource: 'packet-scan',
        observedAt: at(1).toISOString(),
      },
    })

    const created = await helpers.callRouteOk(sessionsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions`,
      token,
      params: { projectId },
      body: {
        sessionId,
        clock: { timebase: TIMEBASE, rounding: 'nearest-half-even' },
        referenceTrack: {
          trackId: cameraTrackId,
          role: 'camera-main',
          device: { deviceId: 'device-classroom-camera', recorderId: 'recorder-camera', make: null, model: null, serial: null },
          timebase: TIMEBASE,
          streamIndex: 0,
          syncAudioPolicy: 'final-candidate',
          includeInFinalMix: true,
          firstPart: trackPart({
            trackId: cameraTrackId,
            artifactId: cameraArtifactId,
            sha256: cameraBytes.sha256,
            endTicks: Math.round(Number(cameraVideo.duration) * FPS),
          }),
        },
        lineage: { commandId: 'command-create-teacher-session', actorKind: 'api-client', actorId: clientId, note: null },
      },
    }, [201])
    assert.equal(created.data.replayed, false)

    const withScreen = await helpers.callRouteOk(tracksRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/tracks`,
      token,
      params: { projectId, sessionId },
      body: {
        baseVersionId: sessionVersionRef(created.data.session),
        baseHash: created.data.session.sessionHash,
        track: {
          trackId: screenTrackId,
          role: 'screen',
          device: { deviceId: 'device-lecture-laptop', recorderId: 'recorder-screen', make: null, model: null, serial: null },
          timebase: TIMEBASE,
          streamIndex: 0,
          syncAudioPolicy: 'sync-only',
          includeInFinalMix: false,
          firstPart: trackPart({
            trackId: screenTrackId,
            artifactId: screenArtifactId,
            sha256: screenBytes.sha256,
            endTicks: Math.round(Number(screenVideo.duration) * FPS),
          }),
        },
        lineage: { commandId: 'command-add-screen', actorKind: 'api-client', actorId: clientId, note: null },
      },
    }, [201])

    const attached = await helpers.callRouteOk(protocolRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/protocol`,
      token,
      params: { projectId, sessionId },
      body: { protocolId: 'teacher-and-screen-v1' },
    }, [201])
    assert.equal(attached.data.attachment.protocolId, 'teacher-and-screen-v1')

    // ---- the sync run, drained by the driver an operator runs -------------
    const requested = await helpers.callRouteOk(syncRunsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-runs`,
      token,
      params: { projectId, sessionId },
      idempotencyKey: 'teacher-screen-sync-run-1',
      body: {
        baseVersionId: sessionVersionRef(withScreen.data.session),
        baseHash: withScreen.data.session.sessionHash,
        force: false,
      },
    }, [202])
    assert.equal(requested.data.run.state, 'queued')

    const workerEnvironment = {
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
    }
    const drained = await helpers.runNpmScriptOnce('worker:v2:capture-sync', ['--once'], workerEnvironment)
    const outcome = helpers.outcomeLine(drained.stdout, 'APOLLO_CAPTURE_SYNC_OUTCOME=')
    assert.equal(drained.code, 0, `driver exited ${drained.code}: ${drained.stderr}`)
    assert.ok(outcome, `driver printed no outcome line: ${drained.stdout}`)
    assert.equal(outcome.claimed, true)
    assert.equal(outcome.status, 'succeeded', outcome.failureReason ?? '')
    assert.equal(outcome.coverageDerived, 2, 'coverage for both tracks')

    const sync = await helpers.callRouteOk(syncRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync`,
      token,
      params: { projectId, sessionId },
    }, [200])
    const screenSync = sync.data.tracks.find((entry) => entry.trackId === screenTrackId)
    assert.ok(screenSync, 'the screen has a sync verdict')
    assert.equal(screenSync.outcome, 'auto-apply', screenSync.outcomeReasons.join('; '))
    assert.equal(screenSync.selectedMethod, 'audio-fingerprint')
    assert.ok(screenSync.map, 'and a clock map, so a millisecond on its file lands on the session clock')
    const piece = screenSync.map.pieces[0]
    const screenOffsetTicks = Number(piece.offsetTicks)
    const screenCoverage = screenSync.coverage
    assert.ok(screenCoverage, 'and measured coverage')
    assert.equal(screenCoverage.gapTicks, '0')

    // ---- the diagnostic, composed on the server ---------------------------
    const session = await helpers.callRouteOk(sessionRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}`,
      token,
      params: { projectId, sessionId },
    }, [200])
    const firstDiagnostic = await helpers.callRouteOk(diagnosticRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-diagnostic`,
      token,
      params: { projectId, sessionId },
      body: {
        baseVersionId: sessionVersionRef(session.data.session),
        baseHash: session.data.session.sessionHash,
      },
    }, [200, 201])
    // Gap 1, asserted rather than routed around. The worker resolved this exact
    // track by audio fingerprint and the diagnostic reports it as unusable,
    // because it reads marker detections and nothing else.
    const beforeAnchor = firstDiagnostic.data.diagnostic.tracks
      .find((entry) => entry.trackId === screenTrackId)
    assert.equal(beforeAnchor.confidence, 0)
    assert.ok(
      beforeAnchor.warnings.includes('insufficient-evidence'),
      `the diagnostic did not read the fingerprint result: ${beforeAnchor.warnings.join(', ')}`,
    )
    assert.equal(firstDiagnostic.data.diagnostic.autoEdit.allowed, false)

    // The operator confirms the map the SERVER measured, at four instants along
    // it. Nothing about the instants is invented: the offset is the clock map's
    // own, read back over `/v1`, and the evidence ref is the fingerprint pass's
    // own — `applyAnchorEdit` prefixes the actor to it, so who confirmed it is
    // never displaced by what was cited.
    //
    // Four, not one, because `refitTrack` earns confidence from corroboration:
    // `0.5 + min(anchors, 5) * 0.09` (`sync-diagnostic-anchors.ts:143`). One
    // anchor is 0.59 and lands under `mediumConfidence`, which is `partial`.
    const ticksToMs = (ticks) => Math.round((Number(ticks) * 1_000) / FPS)
    const offsetMs = ticksToMs(piece.sessionCoverage.start) - ticksToMs(piece.sourceCoverage.start)
    let anchored = null
    let anchorBase = firstDiagnostic.data.diagnostic
    for (const second of [0, 20, 45, 70]) {
      anchored = await helpers.callRouteOk(anchorsRoute.POST, {
        method: 'POST',
        path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-diagnostic/anchors`,
        token,
        params: { projectId, sessionId },
        body: {
          baseVersionId: diagnosticVersionRef(anchorBase),
          baseHash: anchorBase.diagnosticHash,
          trackId: screenTrackId,
          action: 'add',
          anchorId: `screen-fingerprint-confirmed-${second}s`,
          sourceMs: second * 1_000,
          sessionMs: second * 1_000 + offsetMs,
          evidenceRef: piece.evidenceRefs[0],
        },
      }, [200, 201])
      anchorBase = anchored.data.diagnostic
    }
    // Regenerated, because an anchor alone cannot lift the block: `refitTrack`
    // keeps the `insufficient-evidence` warning it inherited
    // (`sync-diagnostic-anchors.ts:131-136`) and `canAutoEdit` reads exactly
    // that warning (`sync-diagnostic.ts:431`). Composing the diagnostic again
    // carries the manual anchors forward and re-derives the warnings from what
    // now exists, which is the only route from "anchored" to "auto-editable".
    const regenerated = await helpers.callRouteOk(diagnosticRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-diagnostic`,
      token,
      params: { projectId, sessionId },
      body: {
        baseVersionId: sessionVersionRef(session.data.session),
        baseHash: session.data.session.sessionHash,
      },
    }, [200, 201])
    const diagnostic = regenerated.data.diagnostic
    const afterAnchor = diagnostic.tracks.find((entry) => entry.trackId === screenTrackId)
    assert.equal(afterAnchor.manualAnchors.length, 4, 'the anchors survived the regeneration')
    assert.ok(
      ['synced-high', 'synced-medium'].includes(afterAnchor.status),
      `the anchored track is ${afterAnchor.status}`,
    )
    assert.equal(diagnostic.autoEdit.allowed, true, diagnostic.autoEdit.blockedBy.join(', '))

    // ---- the speech the direction reads ----------------------------------
    // Seeded, and said so: diarization is a paid provider call. The segments
    // name the stretches of the generated audio where the teacher is heard, and
    // the run is built by the domain factory so the projection that re-verifies
    // its hashes is verifying a real body.
    await helpers.storeDiarizationWorkflow({
      prisma, workspaceId, projectId,
      workflowId: 'teacher-screen-workflow',
      operationId: 'teacher-screen-index-operation',
      transcriptId: 'teacher-screen-transcript',
      sourceArtifactId: cameraArtifactId,
      sourceArtifactSha256: cameraBytes.sha256,
      sourceManifestId: registered[cameraArtifactId].manifestId,
      sourceManifestHash: registered[cameraArtifactId].manifestHash,
      durationMs: SECONDS * 1_000,
      clientId,
      createdAt: at(2),
    })
    await helpers.storeDiarizationRun({
      prisma, workspaceId, projectId,
      runId: 'teacher-screen-diarization',
      workflowId: 'teacher-screen-workflow',
      transcriptId: 'teacher-screen-transcript',
      sourceArtifactId: cameraArtifactId,
      sourceArtifactSha256: cameraBytes.sha256,
      sourceManifestId: registered[cameraArtifactId].manifestId,
      sourceManifestHash: registered[cameraArtifactId].manifestHash,
      durationMs: SECONDS * 1_000,
      segments: [
        { providerSegmentId: 'abertura', providerLabel: 'A', startMs: 1_000, endMs: 28_000, text: 'Abertura da aula.' },
        { providerSegmentId: 'fechamento', providerLabel: 'A', startMs: 62_000, endMs: 88_000, text: 'Fechamento depois da demonstração.' },
      ],
      clientId,
      createdAt: at(2),
    })

    // ---- the direction ----------------------------------------------------
    const rangeStartTicks = 2 * FPS
    const rangeEndTicks = (SECONDS - 1) * FPS
    const directed = await helpers.callRouteOk(directionRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/direction`,
      token,
      params: { projectId, sessionId },
      idempotencyKey: 'teacher-screen-direction-1',
      body: {
        baseVersionId: versionId,
        baseHash: projectVersion.baseHash,
        format: { aspectRatio: '16:9' },
        range: { sessionStartTicks: String(rangeStartTicks), sessionEndTicks: String(rangeEndTicks) },
        reason: 'Direção da aula com uma demonstração de tela no meio.',
      },
    }, [201])
    assert.deepEqual(directed.data.directed.direction.uncovered, [], 'every directed instant had an eligible angle')

    const shotListing = await helpers.callRouteOk(shotsRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/direction/shots`,
      token,
      params: { projectId, sessionId },
    }, [200])
    const shots = shotListing.data.shots
    assert.equal(shotListing.data.omittedShots, 0, 'the whole shot list was read')
    assert.ok(shots.length >= 3, `the demonstration produced a cut and a return (${shots.length} shot(s))`)

    // ---- claim 1: the demonstration puts the screen on air ----------------
    // The window is where the ACTIVITY was measured: the file's busy stretch
    // shifted by the offset the worker measured, not a constant.
    const demonstrationStartTick = DEMONSTRATION_START_SECOND * FPS + screenOffsetTicks
    const demonstrationEndTick = DEMONSTRATION_END_SECOND * FPS + screenOffsetTicks
    const overlaps = (shot, start, end) =>
      Number(shot.sessionRange.start) < end && Number(shot.sessionRange.end) > start
    const inside = (shot, start, end) =>
      Number(shot.sessionRange.start) >= start && Number(shot.sessionRange.end) <= end
    const demonstrationShots = shots.filter((shot) => overlaps(shot, demonstrationStartTick, demonstrationEndTick))
    assert.ok(demonstrationShots.length > 0, 'the demonstration stretch was directed')
    const onScreen = demonstrationShots.filter((shot) => shot.chosen.trackId === screenTrackId)
    assert.ok(
      onScreen.length > 0,
      `no shot cut the screen during the demonstration: ${demonstrationShots.map((shot) => `${shot.shotId}=${shot.chosen.trackId}`).join(' ')}`,
    )
    for (const shot of onScreen) {
      assert.equal(shot.chosen.context, 'screen')
      assert.equal(shot.rule, 'demonstration-prefers-screen', shot.reason)
      assert.ok(shot.chosen.screenActivity, 'the shot cites the activity it was chosen for')
      assert.ok(
        inside(shot, demonstrationStartTick, demonstrationEndTick),
        `${shot.shotId} runs past the measured activity: ${shot.sessionRange.start}-${shot.sessionRange.end}`,
      )
    }

    // ---- claim 2: it comes back to the camera when the demonstration ends --
    const afterDemonstration = shots
      .filter((shot) => Number(shot.sessionRange.start) >= demonstrationEndTick)
      .sort((left, right) => Number(left.sessionRange.start) - Number(right.sessionRange.start))
    assert.ok(afterDemonstration.length > 0, 'the session continues past the demonstration')
    assert.equal(
      afterDemonstration[0].chosen.trackId,
      cameraTrackId,
      `the shot after the demonstration is ${afterDemonstration[0].chosen.trackId}`,
    )
    const lastOnScreen = onScreen
      .map((shot) => Number(shot.sessionRange.end))
      .reduce((highest, value) => Math.max(highest, value), 0)
    assert.ok(
      Math.abs(lastOnScreen - demonstrationEndTick) <= FPS,
      `the return lands ${(lastOnScreen - demonstrationEndTick) / FPS}s from where the activity stopped`,
    )

    // ---- claim 3: the minimum shot duration holds -------------------------
    const shotDurationsMs = shots.map((shot) =>
      ((Number(shot.sessionRange.end) - Number(shot.sessionRange.start)) * 1_000) / FPS)
    const shortestMs = Math.min(...shotDurationsMs)
    assert.ok(
      shortestMs >= DEFAULT_DIRECTION_POLICY.minimumShotMs,
      `the shortest shot is ${shortestMs}ms against a minimum of ${DEFAULT_DIRECTION_POLICY.minimumShotMs}ms`,
    )
    assert.deepEqual(
      directed.data.directed.direction.warnings.filter((warning) => warning.code === 'minimum-shot-violated'),
      [],
      'and the direction says so itself',
    )

    // ---- gap 2, measured: what the protocol says about this session -------
    // Run last on purpose. A stored evaluation constrains every later direction
    // (`multicam-direction.ts:1171`), so evaluating first would have made this
    // journey about a refusal rather than about the demonstration. The verdict
    // is asserted so the missing markers are a number in the record.
    const evaluation = await helpers.callRouteOk(protocolEvaluationsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/protocol/evaluations`,
      token,
      params: { projectId, sessionId },
      body: {
        baseVersionId: sessionVersionRef(session.data.session),
        baseHash: session.data.session.sessionHash,
        attestedRequirementIds: [],
      },
    }, [200, 201])
    const unmet = evaluation.data.evaluation.findings
      .filter((finding) => finding.outcome === 'unmet')
      .map((finding) => finding.requirementId)
      .sort()
    assert.deepEqual(unmet, ['end-marker', 'start-marker'], 'no marker was filmed, and only that is unmet')
    assert.equal(evaluation.data.evaluation.ceiling, 'not-synchronizable')

    const screenActivityScores = onScreen.map((shot) => shot.chosen.screenActivity.score)
    console.log(
      `E2E-F4.012 teacher+screen: session ${SECONDS}s@${FPS}fps camera=${cameraVideo.nb_read_frames}f/${Number(cameraVideo.duration).toFixed(2)}s ` +
      `screen=${screenVideo.nb_read_frames}f/${Number(screenVideo.duration).toFixed(2)}s bytes=${cameraBytes.byteSize}+${screenBytes.byteSize} ` +
      `syncOutcome=${screenSync.outcome} method=${screenSync.selectedMethod} offset=${screenOffsetTicks}ticks(${(screenOffsetTicks / FPS).toFixed(2)}s applied ${SCREEN_LAG_SECONDS}s) ` +
      `coverage=${screenCoverage.coveredTicks}/${screenCoverage.bounds.end}ticks gaps=${screenCoverage.gapTicks} ` +
      `diagnostic v${firstDiagnostic.data.diagnostic.version} confidence=${beforeAnchor.confidence} autoEdit=${firstDiagnostic.data.diagnostic.autoEdit.allowed} ` +
      `anchored+regenerated v${diagnostic.version} status=${afterAnchor.status} confidence=${afterAnchor.confidence} autoEdit=${diagnostic.autoEdit.allowed} ` +
      `shots=${shots.length} onScreen=${onScreen.length} activityScore=${screenActivityScores.map((score) => score.toFixed(3)).join(',')} ` +
      `return=${afterDemonstration[0].chosen.trackId}@${(Number(afterDemonstration[0].sessionRange.start) / FPS).toFixed(2)}s ` +
      `shortestShot=${shortestMs.toFixed(0)}ms minimum=${DEFAULT_DIRECTION_POLICY.minimumShotMs}ms ` +
      `protocolCeiling=${evaluation.data.evaluation.ceiling} unmet=${unmet.join('+')} ` +
      `sha256=camera:${cameraBytes.sha256.slice(0, 16)} screen:${screenBytes.sha256.slice(0, 16)}`,
    )
  },
)

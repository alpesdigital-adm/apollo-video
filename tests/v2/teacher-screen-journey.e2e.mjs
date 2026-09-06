import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
 * - **The offset the worker measured is the lag the fixture applied.** The
 *   screen recorder started `SCREEN_LAG_SECONDS` late in the audio both files
 *   carry, and the clock map read back over `/v1` has to say so to within one
 *   session tick. Everything else in this journey is DERIVED from that offset —
 *   the demonstration window, the sample instants — so without this one
 *   comparison against ground truth the journey would be self-consistent for
 *   any measurement whatsoever, including a wrong one.
 * - **No shot is shorter than the minimum.** Every shot is at least
 *   `DEFAULT_DIRECTION_POLICY.minimumShotMs` long, measured in session ticks
 *   and converted with the session's own timebase, and the direction carries no
 *   `minimum-shot-violated` warning. This fixture does not EXERCISE the policy
 *   and the journey says so where it asserts it: screen activity is measured in
 *   30 s windows, so the shortest shot here is 27.4 s. The falsifiable version
 *   of the claim lives in the podcast journey, whose evidence has millisecond
 *   boundaries.
 * - **The decision reaches an MP4, and the screen is IN it.** The LUT decision
 *   enqueues a render of the directed cut, the render worker drains it in its
 *   own process, and the delivered file is read back with `ffprobe
 *   -count_frames` and sampled at three instants. What the file IS — its
 *   `sha256` and `byteSize` — comes back through `GET /v1/artifacts/{id}`; only
 *   the storage key, which that reader deliberately does not publish, is read
 *   from the row. The teacher's room is a blue field and the demonstration is
 *   achromatic `life`, so "the screen went to air at 30 s and the camera came
 *   back at 60 s" is a colour measurement on the delivered bytes rather than a
 *   row in a shot table.
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
 * Two reads in this file do NOT go through a published route, and both are
 * labelled where they happen: `v2MediaArtifact` for the delivered file's
 * STORAGE key — `presentMediaArtifactV4` replaces it with a public reference on
 * purpose, so there is no published way to find the bytes on disk — and
 * `v2ProjectVersion` for the `baseHash` the next command has to fence against,
 * which the version reader does not publish either.
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
/**
 * The initial grid of the demonstration, pinned.
 *
 * `life` seeds itself from the clock by default (`random_seed` -1), so without
 * this the screen recording is a different file on every run: three executions
 * of this journey produced 8396665, 8676309 and 8569470 bytes and three
 * different sha256s, which makes a golden hash of the delivered MP4 a number
 * nobody can check. Everything ELSE about the run was identical across those
 * three, so the only thing this pins is the fixture.
 */
const LIFE_SEED = 20_260_203
const WIDTH = 320
const HEIGHT = 180

/**
 * What ffprobe reported for both recordings, in the tokens the render path
 * consumes. `colorMetadataFromStream` refuses anything it did not measure, so
 * this is the shape those measurements take, not a plausible default.
 */
const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

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
    const { COLOR_TRANSFORM_ORDER } = await import('../../src/v2/domain/color-and-export.ts')
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
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
    const compilationsRoute = await import('../../src/app/v1/projects/[projectId]/color-pipeline-compilations/route.ts')
    const lutSelectionRoute = await import('../../src/app/v1/projects/[projectId]/lut-selection/route.ts')
    const operationRoute = await import('../../src/app/v1/operations/[operationId]/route.ts')
    const artifactRoute = await import('../../src/app/v1/artifacts/[artifactId]/route.ts')

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
    // In the PAST, and load-bearing: `evaluateRenderedProxy` refuses a proxy
    // whose completion predates the upload it was rendered from
    // (`render-workflow.ts:221`), and the render worker stamps completion from
    // the real clock. This journey renders, so a lesson filmed in 2029 could
    // never be cut.
    const at = (second) => new Date(Date.parse('2026-02-03T09:00:00.000Z') + second * 1_000)
    const artifactRoot = await mkdtemp(join(tmpdir(), 'apollo-teacher-screen-e2e-'))
    // The direction route builds an FFmpeg visual provider and a media
    // materializer from the environment, so this process needs the artifact
    // root too — not just the worker child.
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'
    // A lesson's worth of `/v1` calls arrives in one burst from a workspace
    // created seconds earlier, and the request-anomaly detector compares a
    // burst against a baseline that does not exist yet (`requestMinimum` 20
    // with a 3x multiplier, `admit-governed-capability.ts:45-46`). Only the
    // anomaly floor moves; `requestsPerMinute` and the quotas keep their
    // shipped defaults, so a journey that genuinely exceeded them is still
    // refused.
    process.env.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM = '400'

    const clean = async () => {
      await prisma.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await prisma.v2ProjectVersion.updateMany({ where: { workspaceId }, data: { commandId: null } })
      for (const table of [
        prisma.v2MulticamAngleScoreComponent, prisma.v2MulticamAngleCandidate,
        prisma.v2MulticamShotAlternative, prisma.v2MulticamShotDecision,
        prisma.v2MulticamDirectionHead, prisma.v2MulticamDirection,
        prisma.v2MulticamObservation, prisma.v2MulticamEvidenceSet,
        prisma.v2SpeakerDiarizationSegment, prisma.v2SpeakerDiarizationRun,
        prisma.v2LongFormIndexWorkflow, prisma.v2MediaTranscript,
        prisma.v2SyncDiagnosticHead, prisma.v2SyncDiagnostic,
        prisma.v2CaptureSessionProtocol, prisma.v2CaptureProtocolEvaluation,
        prisma.v2CaptureTrackCoverage, prisma.v2CaptureClockMapPiece, prisma.v2CaptureClockMap,
        prisma.v2CaptureSyncEvidence, prisma.v2CaptureSyncRun, prisma.v2CaptureSessionClock,
        prisma.v2CaptureSessionHead, prisma.v2CaptureSessionVersion,
        prisma.v2ColorCriticProposedDelta, prisma.v2ColorCriticIssue,
        prisma.v2ColorCriticDimensionResult, prisma.v2ColorCriticReportMeasurement,
        prisma.v2ColorCriticReport,
        // The critic measures the cameras it judged, and those rows outlive the
        // report: `camera_color_measurements_workspaceId_fkey` otherwise blocks
        // the workspace delete at the very end of the teardown.
        prisma.v2ColorMeasurementComponent, prisma.v2ColorMeasurementDimension,
        prisma.v2CameraColorMeasurement,
        prisma.v2ProxyReviewDecision, prisma.v2ProxyReview, prisma.v2RenderElementMap,
        prisma.v2ProjectProxyRenderOperation,
        prisma.v2ProjectLutSelectionHead, prisma.v2ProjectLutSelection,
        prisma.v2CommandArtifactInvalidation, prisma.v2PublicEventOutbox,
        prisma.v2EditCommand, prisma.v2ProjectVersion, prisma.v2ProjectSnapshot,
        prisma.v2ColorPipelineCompilation, prisma.v2MediaColorProbe,
        // After the review and the render operation that point at it: an
        // operation deleted first violates
        // `proxy_reviews_operationId_projectId_workspaceId_fkey`.
        prisma.v2ProjectMediaAsset, prisma.v2PublicOperation,
        // The render's manifest records what it was derived from, and the
        // lineage row outlives the operation that wrote it: deleting manifests
        // first violates `media_artifact_lineage_manifestId_workspaceId_fkey`.
        prisma.v2MediaArtifactLineage,
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
        `life=s=${WIDTH}x${HEIGHT}:r=${FPS}:mold=10:random_seed=${LIFE_SEED}`,
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
      // `operations:read` is what `GET /v1/operations/{id}` requires; without
      // it the render's own outcome is unreadable to the client that asked
      // for it, which is a 403 rather than anything about the file.
      scopes: ['projects:read', 'projects:write', 'artifacts:read', 'operations:read'],
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
      // The render worker seals its recipe parameters before it writes a
      // manifest; without a key it refuses to start rather than storing them
      // in the clear.
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'teacher-screen-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url'),
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
    // The measurement against the ground truth, which is the only assertion in
    // this journey that can tell a correlator from a random number generator.
    // Everything downstream — the demonstration window, the sample instants —
    // is DERIVED from `screenOffsetTicks`, so the journey is self-consistent for
    // any offset whatsoever unless the offset itself is checked against the lag
    // the fixture applied. One tick of tolerance, because the correlator works
    // on 2 s windows of 16 kHz audio and reports in session ticks: a lag that is
    // an exact number of frames may still land on either side of a rounding.
    assert.ok(
      Math.abs(screenOffsetTicks - SCREEN_LAG_SECONDS * FPS) <= 1,
      `the worker measured ${screenOffsetTicks} ticks where the fixture delayed the screen by ${SCREEN_LAG_SECONDS}s (${SCREEN_LAG_SECONDS * FPS} ticks)`,
    )
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

    // ---- claim 3: no shot is shorter than the minimum ---------------------
    // Said exactly, because this fixture cannot exercise the policy that
    // enforces it. Every cut here is driven by `screen-activity`, and the
    // evidence sweep measures screen activity in 30 s windows
    // (`deriveMulticamEvidenceService`'s `evidenceWindowMs` default, which
    // nothing configures), so the finest boundary this session can produce is
    // 30 s: the shortest shot comes out at 27.4 s, 22 times the 1 200 ms
    // minimum. Deleting rule 8 would leave both assertions below green HERE.
    // The falsifiable version of the claim is in the podcast journey, whose
    // evidence is diarization segments and therefore has millisecond
    // boundaries: it carries a 700 ms interjection that becomes a sub-minimum
    // shot the moment the minimum-shot hold stops holding.
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
    // The margin is reported rather than asserted: a number nobody can read
    // cannot be recognised as an unexercised policy by the next reader.
    const minimumShotMargin = shortestMs / DEFAULT_DIRECTION_POLICY.minimumShotMs

    // ---- claim 4: the decision becomes an MP4, and the screen is IN it ----
    // Everything above is a decision the server recorded. This is the file the
    // decision produced, and it is reached with two more published routes and
    // nothing else: the colorimetry of each recording, then the LUT decision.
    // `set-project-lut-selection` is `renderPolicy: 'full-timeline'`
    // (`edit-command-registry.ts:109`) and its route enqueues the render, so
    // choosing "no creative grade" is what puts the directed cut on the queue.
    // The queue is drained by `scripts/run-v2-render-worker-once.mjs` in its
    // own process, exactly as the sync queue was.
    const stage = (id, kind, provider, enabled, parameters) => ({
      id,
      kind,
      version: 'v1',
      enabled,
      output: COLOR_METADATA,
      implementation: {
        provider,
        version: 'v1',
        parameters,
        parametersHash: calculateCanonicalHash(parameters),
      },
    })
    const technicalStage = stage('technical-rec709', 'technical', 'ffmpeg-zscale', true, { mode: 'identity' })
    const matchStage = stage('match-bypass', 'match', 'apollo-match', false, { mode: 'bypass' })
    const creativeStage = stage('creative-none', 'creative-lut', 'apollo-lut', false, { mode: 'none' })
    const outputStage = stage('output-rec709', 'output', 'ffmpeg-zscale', true, { mode: 'identity' })
    // Where the match sits is the domain's decision and not this request's, and
    // the domain says so by REFUSING rather than by re-sorting: `normalizeLayer`
    // calls `assertMatchStagePosition`, so a body that declares the creative LUT
    // ahead of the match is answered `422 COLOR_STAGE_VIOLATION` and no
    // compilation is written. That is proved once, here, before the two
    // compilations this journey depends on are sent in canonical order.
    const refused = await helpers.callRouteOk(compilationsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/color-pipeline-compilations`,
      token,
      params: { projectId },
      idempotencyKey: `teacher-screen-compilation-${cameraArtifactId}-misordered`,
      body: {
        sourceArtifactId: cameraArtifactId,
        sourceManifestId: registered[cameraArtifactId].manifestId,
        outputMetadata: COLOR_METADATA,
        // Deliberately out of order: creative LUT first, match last.
        stages: [creativeStage, outputStage, technicalStage, matchStage],
      },
    }, [422])
    // The public envelope carries the catalogued message, not the domain's, so
    // the code and its classification are what can be read here: a policy
    // refusal that will not become true on a retry, rather than a 400 blaming
    // the shape of the body.
    assert.equal(
      refused.payload.error.code,
      'COLOR_STAGE_VIOLATION',
      `a match declared after the creative LUT was refused as ${JSON.stringify(refused.payload.error)}`,
    )
    assert.equal(refused.payload.error.category, 'policy')
    assert.equal(refused.payload.error.retryable, false)
    for (const artifactId of [cameraArtifactId, screenArtifactId]) {
      const compiled = await helpers.callRouteOk(compilationsRoute.POST, {
        method: 'POST',
        path: `/v1/projects/${projectId}/color-pipeline-compilations`,
        token,
        params: { projectId },
        idempotencyKey: `teacher-screen-compilation-${artifactId}`,
        body: {
          sourceArtifactId: artifactId,
          sourceManifestId: registered[artifactId].manifestId,
          outputMetadata: COLOR_METADATA,
          stages: [technicalStage, matchStage, creativeStage, outputStage],
        },
      }, [201])
      const kinds = compiled.data.compilation.pipeline.stages.map((entry) => entry.kind)
      // The literal, not the constant under test. `[...COLOR_TRANSFORM_ORDER]`
      // compares the server's answer with the very array that defines it, so no
      // reordering of the colour pipeline could make it fail; the two positional
      // assertions below are what actually holds the order in place.
      assert.deepEqual(
        kinds,
        ['technical', 'match', 'creative-lut', 'output'],
        'the compiled pipeline is ordered by the domain',
      )
      assert.deepEqual(kinds, [...COLOR_TRANSFORM_ORDER], 'and the domain still publishes that order')
      assert.ok(
        kinds.indexOf('technical') < kinds.indexOf('match'),
        `the technical conversion precedes the camera match: ${kinds.join('>')}`,
      )
      assert.ok(
        kinds.indexOf('match') < kinds.indexOf('creative-lut'),
        `the camera match precedes the creative LUT: ${kinds.join('>')}`,
      )
    }

    const directedVersionId = directed.data.directed.projectVersion.id
    await helpers.callRouteOk(lutSelectionRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/lut-selection`,
      token,
      params: { projectId },
      idempotencyKey: 'teacher-screen-lut-selection-1',
      body: {
        baseVersionId: directedVersionId,
        baseHash: (await prisma.v2ProjectVersion.findUniqueOrThrow({
          where: { id: directedVersionId },
        })).baseHash,
        // `none` is a decision like any other -- this lesson gets no creative
        // grade -- and it is recorded as one rather than defaulted to.
        selection: { mode: 'none' },
        reason: 'Sem LUT criativa nesta aula.',
      },
    }, [200, 201])
    const renderOutcomes = await helpers.drainProxyRenders({
      prisma, workspaceId, environment: workerEnvironment, expected: 1,
    })
    const operationId = renderOutcomes[0].operationId
    const operation = await helpers.callRouteOk(operationRoute.GET, {
      path: `/v1/operations/${operationId}`,
      token,
      params: { operationId },
    }, [200])
    assert.equal(operation.data.operation.status, 'succeeded', JSON.stringify(operation.data.operation))

    // What the delivered file IS comes back over `/v1`, not out of a row: the
    // client that asked for the render is scoped for `artifacts:read` and the
    // reader publishes `sha256` and `byteSize`, so the comparison against the
    // bytes on disk is a comparison against the published answer. The Prisma
    // read that remains is for `artifactKey` alone — the STORAGE key, which
    // `presentMediaArtifactV4` deliberately replaces with a public reference,
    // so there is no published way to find the file on disk.
    const outputArtifactId = operation.data.operation.target.id
    const publishedArtifact = await helpers.callRouteOk(artifactRoute.GET, {
      path: `/v1/artifacts/${outputArtifactId}`,
      token,
      params: { artifactId: outputArtifactId },
    }, [200])
    const outputArtifact = await prisma.v2MediaArtifact.findFirstOrThrow({
      where: { workspaceId, id: outputArtifactId },
      select: { artifactKey: true },
    })
    const outputPath = helpers.artifactPath(artifactRoot, outputArtifact.artifactKey)
    const outputSha256 = helpers.sha256Of(await readFile(outputPath))
    const outputByteSize = Number(publishedArtifact.data.artifact.byteSize)
    assert.equal(
      outputSha256,
      publishedArtifact.data.artifact.sha256,
      'the bytes on disk are the bytes `GET /v1/artifacts/{id}` claims',
    )
    assert.equal((await stat(outputPath)).size, outputByteSize)
    const outputStreams = await helpers.probeStreams(ffprobePath, outputPath)
    const outputVideo = outputStreams.find((stream) => stream.codec_type === 'video')
    const outputAudio = outputStreams.find((stream) => stream.codec_type === 'audio')
    assert.ok(outputVideo, 'the render wrote a picture')
    assert.ok(outputAudio, 'and the lesson audio reached the output')
    const outputFrames = Number(outputVideo.nb_read_frames)
    const plannedFrames = rangeEndTicks - rangeStartTicks
    assert.ok(
      Math.abs(outputFrames - plannedFrames) <= 3,
      `the file holds ${outputFrames} frames against the ${plannedFrames} the direction planned`,
    )
    assert.ok(Math.abs(Number(outputVideo.duration) - outputFrames / FPS) < 0.2)

    // Three instants decoded to raw RGB, and the discriminator is a property of
    // the fixtures rather than a threshold picked to make the run pass: the
    // teacher's room is a blue field (0x204060) with one warm patch, so its
    // blue channel sits far above its red; the demonstration is `life`, which
    // is achromatic, so its channels agree. "The screen went to air" becomes a
    // colour measurement on the delivered file rather than a row in a table.
    const secondOf = (tick) => (tick - rangeStartTicks) / FPS
    const beforeDemonstration = shots
      .filter((shot) => Number(shot.sessionRange.end) <= demonstrationStartTick)
      .sort((left, right) => Number(right.sessionRange.start) - Number(left.sessionRange.start))[0]
    assert.ok(beforeDemonstration, 'the lesson opened on the teacher before the demonstration')
    assert.equal(beforeDemonstration.chosen.trackId, cameraTrackId)
    const middleOf = (shot) =>
      secondOf((Number(shot.sessionRange.start) + Number(shot.sessionRange.end)) / 2)
    const sampleSeconds = {
      before: middleOf(beforeDemonstration),
      screen: middleOf(onScreen[0]),
      after: middleOf(afterDemonstration[0]),
    }
    const sampled = {}
    for (const [label, second] of Object.entries(sampleSeconds)) {
      sampled[label] = await helpers.meanRgbAt(ffmpegPath, outputPath, second)
    }
    const chroma = (pixel) => pixel.blue - pixel.red
    for (const label of ['before', 'after']) {
      assert.ok(
        chroma(sampled[label]) > 25,
        `the ${label} instant should be the teacher's blue room: r=${sampled[label].red.toFixed(1)} b=${sampled[label].blue.toFixed(1)}`,
      )
    }
    assert.ok(
      Math.abs(chroma(sampled.screen)) < 15,
      `the demonstration instant should be the achromatic screen: r=${sampled.screen.red.toFixed(1)} b=${sampled.screen.blue.toFixed(1)}`,
    )
    assert.ok(
      sampled.screen.red < 210,
      `the demonstration instant is the busy stretch, not the still slide: ${sampled.screen.red.toFixed(1)}`,
    )

    // The file itself, kept only when a run asks for it. `t.after` removes the
    // artifact root, so a CI run that wants to look at the MP4 afterwards has
    // to be handed a copy while it exists. Unset locally, so nothing piles up.
    const retentionRoot = process.env.APOLLO_TEACHER_SCREEN_OUTPUT?.trim()
    let retainedPath = null
    if (retentionRoot) {
      await mkdir(retentionRoot, { recursive: true })
      retainedPath = join(retentionRoot, 'teacher-screen-journey.mp4')
      await copyFile(outputPath, retainedPath)
      await writeFile(join(retentionRoot, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 'teacher-screen-journey-evidence/v1',
        renderedThrough: 'POST /v1/projects/{projectId}/lut-selection + run-v2-render-worker-once.mjs',
        file: 'teacher-screen-journey.mp4',
        sha256: outputSha256,
        byteSize: outputByteSize,
        width: Number(outputVideo.width),
        height: Number(outputVideo.height),
        videoCodec: outputVideo.codec_name,
        audioCodec: outputAudio.codec_name,
        durationInFrames: outputFrames,
        durationSeconds: Number(outputVideo.duration),
        plannedFrames,
        measuredOffsetTicks: screenOffsetTicks,
        appliedLagSeconds: SCREEN_LAG_SECONDS,
        sampleSeconds,
        sampledMeanRgb: sampled,
      }, null, 2)}\n`)
    }

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
      `shortestShot=${shortestMs.toFixed(0)}ms minimum=${DEFAULT_DIRECTION_POLICY.minimumShotMs}ms margin=${minimumShotMargin.toFixed(1)}x(policy not exercised here) ` +
      `protocolCeiling=${evaluation.data.evaluation.ceiling} unmet=${unmet.join('+')} ` +
      `sha256=camera:${cameraBytes.sha256.slice(0, 16)} screen:${screenBytes.sha256.slice(0, 16)} ` +
      `render=${operation.data.operation.status} frames=${outputFrames}/${plannedFrames} ` +
      `duration=${Number(outputVideo.duration).toFixed(3)}s ${outputVideo.width}x${outputVideo.height} ` +
      `vcodec=${outputVideo.codec_name} acodec=${outputAudio.codec_name} bytes=${outputByteSize} ` +
      `mp4sha256=${outputSha256.slice(0, 16)} ` +
      `pixels=[${Object.entries(sampled).map(([label, pixel]) => `${label}@${sampleSeconds[label].toFixed(2)}s(r${pixel.red.toFixed(0)},g${pixel.green.toFixed(0)},b${pixel.blue.toFixed(0)})`).join(' ')}]` +
      `${retainedPath ? ` retained=${retainedPath}` : ''}`,
    )
  },
)

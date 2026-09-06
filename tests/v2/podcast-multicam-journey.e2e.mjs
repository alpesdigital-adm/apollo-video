import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E-F4.012/F4.013/F4.014 — Journey 1: a two-camera podcast on a master audio
 * recorder, from ingest to an inspected MP4.
 *
 * Every step is a published `/v1` route handler called with a `NextRequest`,
 * and both queues are drained by SEPARATE PROCESSES running the npm scripts an
 * operator runs: `worker:v2:capture-sync -- --once` for the synchronization and
 * `scripts/run-v2-render-worker-once.mjs` for the proxy render. Three
 * recordings are generated with ffmpeg into an `mkdtemp` artifact root and
 * removed in `t.after`; nothing is committed.
 *
 * What it proves:
 *
 * - **The angle follows the active speaker.** Two diarization runs put one
 *   voice on each camera, in turn. The stretch each voice occupies in SESSION
 *   time is computed from the offset the sync worker measured — read back over
 *   `/v1` from the clock map — and at the middle of every such stretch the shot
 *   on air is that speaker's camera.
 * - **No clip lies outside measured coverage.** Every shot's source range sits
 *   inside the coverage bounds the worker derived for that track, the coverage
 *   has no gaps, and the direction leaves no uncovered stretch.
 * - **The colour match is a match-stage transform, before the creative LUT.**
 *   The plan the server derived from the pixels declares `pipelineStage:
 *   'match'` and every camera transform is a `match` transform. The compilation
 *   the renderer executes is then built with its four stages DELIBERATELY OUT
 *   OF ORDER — creative LUT before match — and comes back ordered
 *   `technical > match > creative-lut > output`: the position is the domain's,
 *   not the caller's.
 * - **The MP4 exists and says so.** The proxy render worker writes it, and it is
 *   read back with `ffprobe -count_frames`: frames, duration, video and audio
 *   codec, byte size and sha256 against the artifact row, plus two decoded
 *   frames — one inside a camera-A shot, one inside a camera-B shot — whose
 *   mean RGB must differ in the direction the direction chose. Camera A is red
 *   and camera B is blue precisely so "the angle changed" is a measurement.
 * - **The critic ran on the bytes.** The colour critic runs inside the proxy
 *   render over the file it just wrote, and its report is read back through
 *   `GET /v1/projects/{id}/color-critic-reports`.
 *
 * Two shipped gaps are measured here rather than routed around, as in the
 * teacher-and-screen journey:
 *
 * 1. `POST .../sync-diagnostic` ignores what the sync worker measured — it
 *    builds anchors from marker detections only
 *    (`application/sync-diagnostic.ts:396-411`) — so a session the worker
 *    resolved by audio fingerprint reads as `insufficient-evidence` with
 *    confidence 0. The journey asserts that, then confirms the server's own
 *    measured offsets as manual anchors and regenerates the diagnostic, which
 *    is the only route from "synchronized" to "auto-editable" today.
 * 2. `podcast-v1` requires a marker at the start and at the end; none was
 *    filmed, because minting a marker needs the session and the session cannot
 *    be created before the file it names exists. The evaluation runs last, and
 *    its `not-synchronizable` ceiling is asserted rather than skipped.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const RUN = process.env.APOLLO_PODCAST_MULTICAM_E2E === '1'

const FPS = 30
/** One tick is one frame, so a session instant and an output frame are the same integer. */
const TIMEBASE = `1/${FPS}`
const MASTER_SECONDS = 45
const CAMERA_SECONDS = 36
/** How late each camera started, in the audio all three files carry. */
const CAMERA_A_LAG_SECONDS = 1.2
const CAMERA_B_LAG_SECONDS = 2.4
const WIDTH = 320
const HEIGHT = 180

/**
 * Who is heard, and when, in each camera's OWN file.
 *
 * Session instants are derived from these with the offset the worker measured,
 * never typed: the whole point of the run is that the server found the offset.
 */
const SPEECH = Object.freeze([
  Object.freeze({ camera: 'a', speakerKey: 'cluster-anfitria', startMs: 1_000, endMs: 10_000, text: 'Abertura do episódio.' }),
  Object.freeze({ camera: 'b', speakerKey: 'cluster-convidado', startMs: 10_000, endMs: 20_000, text: 'Resposta do convidado.' }),
  Object.freeze({ camera: 'a', speakerKey: 'cluster-anfitria', startMs: 22_000, endMs: 31_000, text: 'Réplica da anfitriã.' }),
])

const sessionVersionRef = (session) => `${session.sessionId}:v${session.version}`
const diagnosticVersionRef = (diagnostic) => `${diagnostic.sessionId}:diagnostic:v${diagnostic.version}`

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

test(
  'E2E-F4.012 a two-camera podcast on a master recorder becomes an inspected MP4',
  {
    skip: RUN ? false : 'set APOLLO_PODCAST_MULTICAM_E2E=1 with a migrated V2_DATABASE_URL',
    timeout: 45 * 60_000,
  },
  async (t) => {
    const helpers = await import('./helpers/capture-journey.mjs')
    helpers.assertIsolatedDatabase()
    process.env.APOLLO_API_ENVIRONMENT = 'production'

    const { COLOR_TRANSFORM_ORDER, resolveColorPlan } = await import('../../src/v2/domain/color-and-export.ts')
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
    const colorMatchRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/color-match/route.ts')
    const compilationsRoute = await import('../../src/app/v1/projects/[projectId]/color-pipeline-compilations/route.ts')
    const lutSelectionRoute = await import('../../src/app/v1/projects/[projectId]/lut-selection/route.ts')
    const colorPlanRoute = await import('../../src/app/v1/projects/[projectId]/color-plan/route.ts')
    const proxyRendersRoute = await import('../../src/app/v1/projects/[projectId]/proxy-renders/route.ts')
    const operationRoute = await import('../../src/app/v1/operations/[operationId]/route.ts')
    const criticReportsRoute = await import('../../src/app/v1/projects/[projectId]/color-critic-reports/route.ts')
    const sessionLoginRoute = await import('../../src/app/v1/session/route.ts')
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')

    const prisma = new PrismaClient()
    const workspaceId = 'podcast-multicam-e2e-workspace'
    const projectId = 'podcast-multicam-e2e-project'
    const sessionId = 'podcast-multicam-e2e-session'
    const clientId = 'podcast-multicam-e2e-client'
    const versionId = 'podcast-multicam-e2e-version-1'
    const masterTrackId = 'track-master-audio'
    const cameraTrackIds = Object.freeze({ a: 'track-camera-a', b: 'track-camera-b' })
    const masterArtifactId = 'artifact-master-audio'
    const cameraArtifactIds = Object.freeze({ a: 'artifact-camera-a', b: 'artifact-camera-b' })
    const at = (second) => new Date(Date.parse('2029-10-01T09:00:00.000Z') + second * 1_000)
    const artifactRoot = await mkdtemp(join(tmpdir(), 'apollo-podcast-multicam-e2e-'))
    // The direction route and the render worker both build FFmpeg providers and
    // a media materializer from the environment, so this process needs the
    // artifact root too — not just the worker children.
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'
    // Bootstrap login, for the one decision an unattended credential may not
    // make. Same env block the Wave 19 browser journey uses.
    const uiUsername = 'podcast-operator'
    const uiPassword = 'podcast-operator-password'
    process.env.APOLLO_AUTH_MODE = 'bootstrap'
    process.env.APOLLO_ALLOW_BOOTSTRAP_AUTH = 'true'
    process.env.APOLLO_UI_BOOTSTRAP_ROLE = 'operator'
    process.env.APOLLO_UI_USERNAME = uiUsername
    process.env.APOLLO_UI_SESSION_SECRET = 'podcast-multicam-session-secret-at-least-32'
    process.env.APOLLO_UI_API_CLIENT_ID = clientId

    const clean = async () => {
      await prisma.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await prisma.v2ProjectVersion.updateMany({ where: { workspaceId }, data: { commandId: null } })
      for (const table of [
        prisma.v2ColorCriticProposedDelta, prisma.v2ColorCriticIssue,
        prisma.v2ColorCriticDimensionResult, prisma.v2ColorCriticReportMeasurement,
        prisma.v2ColorCriticReport,
        prisma.v2MatchPlanIssue, prisma.v2MatchNonComparableRange,
        prisma.v2MatchRangeOverride, prisma.v2CameraMatchTransform,
        prisma.v2MatchPlanMeasurement, prisma.v2MulticamMatchPlanHead,
        prisma.v2MulticamMatchPlan,
        prisma.v2ColorMeasurementComponent, prisma.v2ColorMeasurementDimension,
        prisma.v2CameraColorMeasurement,
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
        prisma.v2ProxyReviewDecision, prisma.v2ProxyReview, prisma.v2RenderElementMap,
        prisma.v2ProjectProxyRenderOperation,
        prisma.v2ProjectColorPlanHead, prisma.v2ProjectColorPlan,
        prisma.v2ProjectLutSelectionHead, prisma.v2ProjectLutSelection,
        prisma.v2CommandArtifactInvalidation, prisma.v2PublicEventOutbox,
        prisma.v2EditCommand, prisma.v2ProjectVersion, prisma.v2ProjectSnapshot,
        prisma.v2ColorPipelineCompilation, prisma.v2MediaColorProbe,
        prisma.v2ProjectMediaAsset, prisma.v2PublicOperation,
        prisma.v2MediaArtifactManifest, prisma.v2MediaArtifact,
        prisma.v2Project, prisma.v2UiSession, prisma.v2WorkspaceUiPrincipal,
        prisma.v2WorkspaceMember, prisma.v2ApiCredential, prisma.v2ApiClient,
      ]) {
        await table.deleteMany({ where: { workspaceId } })
      }
      await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }

    t.after(async () => {
      try {
        await clean()
      } catch (error) {
        console.log(`podcast cleanup reported: ${error?.message ?? error}`)
      }
      await rm(artifactRoot, { recursive: true, force: true }).catch((error) => {
        console.log(`podcast artifact root cleanup reported: ${error?.message ?? error}`)
      })
      await prisma.$disconnect()
    })
    await clean()

    // ---- the three recordings ---------------------------------------------
    const mediaDirectory = join(artifactRoot, 'capture')
    const room = helpers.sweepSamples({ seconds: MASTER_SECONDS })
    const masterPcm = join(mediaDirectory, 'master.pcm')
    await helpers.writePcm(masterPcm, room)
    const cameraPcm = {}
    for (const [camera, lag] of [['a', CAMERA_A_LAG_SECONDS], ['b', CAMERA_B_LAG_SECONDS]]) {
      cameraPcm[camera] = join(mediaDirectory, `camera-${camera}.pcm`)
      await helpers.writePcm(cameraPcm[camera], helpers.laggedSamples(room, {
        seconds: CAMERA_SECONDS,
        lagSeconds: lag,
        seed: camera === 'a' ? 20_291_001 : 20_291_002,
      }))
    }

    const keys = Object.freeze({
      master: 'capture/master-audio.m4a',
      a: 'capture/camera-a.mp4',
      b: 'capture/camera-b.mp4',
    })
    const files = Object.freeze({
      master: helpers.artifactPath(artifactRoot, keys.master),
      a: helpers.artifactPath(artifactRoot, keys.a),
      b: helpers.artifactPath(artifactRoot, keys.b),
    })
    const masterBytes = await helpers.encodeAudioRecording({
      ffmpegPath, outputPath: files.master, pcmPath: masterPcm, seconds: MASTER_SECONDS,
    })
    // Camera B is darker than camera A on purpose: a match plan derived from two
    // identically exposed pictures has nothing to correct, and a colour journey
    // whose transform is a bypass proves nothing about matching.
    const cameraBytes = {
      a: await helpers.encodeRecording({
        ffmpegPath, outputPath: files.a, seconds: CAMERA_SECONDS, fps: FPS, width: WIDTH, height: HEIGHT,
        videoInput: `color=c=0xc02020:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${CAMERA_SECONDS}`,
        pcmPath: cameraPcm.a,
      }),
      b: await helpers.encodeRecording({
        ffmpegPath, outputPath: files.b, seconds: CAMERA_SECONDS, fps: FPS, width: WIDTH, height: HEIGHT,
        videoInput: `color=c=0x2020c0:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${CAMERA_SECONDS}`,
        pcmPath: cameraPcm.b,
      }),
    }

    const masterStreams = await helpers.probeStreams(ffprobePath, files.master)
    const cameraStreams = {
      a: await helpers.probeStreams(ffprobePath, files.a),
      b: await helpers.probeStreams(ffprobePath, files.b),
    }
    const masterAudio = masterStreams.find((stream) => stream.codec_type === 'audio')
    assert.ok(masterAudio, 'the recorder wrote an audio stream')
    assert.equal(masterStreams.some((stream) => stream.codec_type === 'video'), false, 'and no picture')
    const cameraVideo = {
      a: cameraStreams.a.find((stream) => stream.codec_type === 'video'),
      b: cameraStreams.b.find((stream) => stream.codec_type === 'video'),
    }
    for (const camera of ['a', 'b']) {
      assert.ok(
        cameraStreams[camera].some((stream) => stream.codec_type === 'audio'),
        `camera ${camera} kept its scratch audio, which is what the protocol synchronizes on`,
      )
    }
    const producerDigest = await helpers.binaryDigest(ffprobePath)

    // ---- the world the ingest pipeline would have left --------------------
    await helpers.createWorkspaceRow({ prisma, workspaceId, name: 'Podcast multicam journey', createdAt: at(0) })
    const issued = await helpers.issueApiClient({
      prisma, workspaceId, clientId, name: 'Podcast multicam journey', createdAt: at(0),
      scopes: ['projects:read', 'projects:write', 'artifacts:read', 'operations:read'],
    })
    const token = issued.token
    process.env.APOLLO_UI_PASSWORD_HASH = createUiPasswordHash(uiPassword, 'podcast-multicam-salt')
    await helpers.createProjectRow({
      prisma, workspaceId, projectId, name: 'Episódio com duas câmeras',
      objective: 'warming', format: '16:9', clientId, createdAt: at(0),
    })

    const registered = {}
    registered[masterArtifactId] = await helpers.registerRecording({
      prisma, workspaceId, projectId,
      artifactId: masterArtifactId,
      artifactKey: keys.master,
      mediaType: 'audio',
      container: 'm4a',
      sha256: masterBytes.sha256,
      byteSize: masterBytes.byteSize,
      probe: { duration: Number(masterAudio.duration) },
      colorMetadata: null,
      pixelFormat: null,
      producerVersion: 'ffprobe-static',
      producerBinaryDigest: producerDigest,
      role: 'selected-insert',
      originalFileName: 'gravador.m4a',
      createdAt: at(0),
      recipeId: 'capture-recorder-ingest',
    })
    for (const camera of ['a', 'b']) {
      registered[cameraArtifactIds[camera]] = await helpers.registerRecording({
        prisma, workspaceId, projectId,
        artifactId: cameraArtifactIds[camera],
        artifactKey: keys[camera],
        mediaType: 'video',
        container: 'mp4',
        sha256: cameraBytes[camera].sha256,
        byteSize: cameraBytes[camera].byteSize,
        probe: {
          width: Number(cameraVideo[camera].width),
          height: Number(cameraVideo[camera].height),
          duration: Number(cameraVideo[camera].duration),
          fps: FPS,
        },
        colorMetadata: helpers.colorMetadataFromStream(cameraVideo[camera]),
        pixelFormat: cameraVideo[camera].pix_fmt,
        producerVersion: 'ffprobe-static',
        producerBinaryDigest: producerDigest,
        role: camera === 'a' ? 'source-master' : 'selected-insert',
        originalFileName: `camera-${camera}.mp4`,
        createdAt: at(0),
        recipeId: 'capture-camera-ingest',
      })
    }
    await helpers.seedBaseProjectVersion({
      prisma, workspaceId, projectId, versionId, clientId,
      objective: 'warming',
      sourceArtifactId: cameraArtifactIds.a,
      fps: FPS,
      durationFrames: CAMERA_SECONDS * FPS,
      transcriptId: 'podcast-multicam-transcript',
      createdAt: at(0),
    })
    const projectVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: versionId } })

    // ---- the session, one published route at a time -----------------------
    const trackPart = ({ trackId, artifactId, sha256, endTicks }) => ({
      partId: `part-${trackId}`,
      ordinal: 0,
      // `sourceAssetId` IS the media artifact id: the compiled clips carry it
      // straight through as `sourceArtifactId`, and the direction refuses a plan
      // that cuts a recording the project does not link as available media.
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
        // The recorder is the reference and the audio bed: the sound that
        // synchronizes and the sound that goes to air are the same track here,
        // which is what `podcast-v1` is about.
        referenceTrack: {
          trackId: masterTrackId,
          role: 'master-audio',
          device: { deviceId: 'device-recorder', recorderId: 'recorder-master', make: null, model: null, serial: null },
          timebase: TIMEBASE,
          streamIndex: 0,
          syncAudioPolicy: 'final-candidate',
          includeInFinalMix: true,
          firstPart: trackPart({
            trackId: masterTrackId,
            artifactId: masterArtifactId,
            sha256: masterBytes.sha256,
            endTicks: Math.round(Number(masterAudio.duration) * FPS),
          }),
        },
        lineage: { commandId: 'command-create-podcast-session', actorKind: 'api-client', actorId: clientId, note: null },
      },
    }, [201])

    let head = created.data.session
    for (const camera of ['a', 'b']) {
      const added = await helpers.callRouteOk(tracksRoute.POST, {
        method: 'POST',
        path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/tracks`,
        token,
        params: { projectId, sessionId },
        body: {
          baseVersionId: sessionVersionRef(head),
          baseHash: head.sessionHash,
          track: {
            trackId: cameraTrackIds[camera],
            role: 'camera-main',
            device: {
              deviceId: `device-camera-${camera}`,
              recorderId: `recorder-camera-${camera}`,
              make: null, model: null, serial: null,
            },
            timebase: TIMEBASE,
            streamIndex: 0,
            // Scratch audio: it lines the clocks up and never goes to air.
            syncAudioPolicy: 'sync-only',
            includeInFinalMix: false,
            firstPart: trackPart({
              trackId: cameraTrackIds[camera],
              artifactId: cameraArtifactIds[camera],
              sha256: cameraBytes[camera].sha256,
              endTicks: Math.round(Number(cameraVideo[camera].duration) * FPS),
            }),
          },
          lineage: { commandId: `command-add-camera-${camera}`, actorKind: 'api-client', actorId: clientId, note: null },
        },
      }, [201])
      head = added.data.session
    }
    assert.equal(head.trackCount, 3)

    await helpers.callRouteOk(protocolRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/protocol`,
      token,
      params: { projectId, sessionId },
      body: { protocolId: 'podcast-v1' },
    }, [201])

    // ---- the sync run, drained by the driver an operator runs -------------
    const requested = await helpers.callRouteOk(syncRunsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-runs`,
      token,
      params: { projectId, sessionId },
      idempotencyKey: 'podcast-multicam-sync-run-1',
      body: { baseVersionId: sessionVersionRef(head), baseHash: head.sessionHash, force: false },
    }, [202])
    assert.equal(requested.data.run.state, 'queued')

    const workerEnvironment = {
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      // The render worker seals its recipe parameters before it writes a
      // manifest; without a key it refuses to start rather than storing them in
      // the clear.
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'podcast-multicam-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 11).toString('base64url'),
    }
    /**
     * Empty the proxy render queue, one claim at a time, and say what each one
     * did. `--once` claims at most one operation, so a queue holding three
     * needs three passes; an empty queue prints an outcome with no operation
     * and is the only way "the queue is empty" is observable.
     */
    const drainProxyRenders = async () => {
      const outcomes = []
      for (let pass = 0; pass < 6; pass += 1) {
        const run = await helpers.runNodeScriptOnce(
          'scripts/run-v2-render-worker-once.mjs',
          { ...workerEnvironment, APOLLO_V2_WORKER_ONCE_KIND: 'proxy' },
        )
        assert.equal(run.code, 0, `render worker exited ${run.code}: ${run.stderr}`)
        const outcome = helpers.outcomeLine(run.stdout, 'APOLLO_WORKER_OUTCOME=')
        assert.ok(outcome, `render worker printed no outcome: ${run.stdout}`)
        if (!outcome.operationId) return outcomes
        outcomes.push(outcome)
      }
      throw new Error('the proxy render queue never emptied')
    }

    const drained = await helpers.runNpmScriptOnce('worker:v2:capture-sync', ['--once'], workerEnvironment)
    const syncOutcome = helpers.outcomeLine(drained.stdout, 'APOLLO_CAPTURE_SYNC_OUTCOME=')
    assert.equal(drained.code, 0, `driver exited ${drained.code}: ${drained.stderr}`)
    assert.ok(syncOutcome, `driver printed no outcome line: ${drained.stdout}`)
    assert.equal(syncOutcome.claimed, true)
    assert.equal(syncOutcome.status, 'succeeded', syncOutcome.failureReason ?? '')
    assert.equal(syncOutcome.coverageDerived, 3, 'coverage for all three tracks')

    const sync = await helpers.callRouteOk(syncRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync`,
      token,
      params: { projectId, sessionId },
    }, [200])
    const syncByTrack = new Map(sync.data.tracks.map((entry) => [entry.trackId, entry]))
    const offsetTicks = {}
    for (const camera of ['a', 'b']) {
      const entry = syncByTrack.get(cameraTrackIds[camera])
      assert.ok(entry, `camera ${camera} has a sync verdict`)
      assert.equal(entry.outcome, 'auto-apply', entry.outcomeReasons.join('; '))
      assert.equal(entry.selectedMethod, 'audio-fingerprint')
      assert.ok(entry.map, `camera ${camera} has a clock map`)
      assert.equal(entry.coverage.gapTicks, '0', `camera ${camera} coverage has no holes`)
      offsetTicks[camera] = Number(entry.map.pieces[0].offsetTicks)
    }
    assert.ok(
      offsetTicks.b > offsetTicks.a,
      `camera B started later than camera A: ${offsetTicks.a} vs ${offsetTicks.b} ticks`,
    )

    // ---- the diagnostic ---------------------------------------------------
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
    // Gap 1, asserted rather than routed around: the worker resolved both
    // cameras and the diagnostic calls them unusable.
    for (const camera of ['a', 'b']) {
      const entry = firstDiagnostic.data.diagnostic.tracks.find((track) => track.trackId === cameraTrackIds[camera])
      assert.equal(entry.confidence, 0)
      assert.ok(entry.warnings.includes('insufficient-evidence'), entry.warnings.join(', '))
    }
    assert.equal(firstDiagnostic.data.diagnostic.autoEdit.allowed, false)

    // The operator confirms each map the SERVER measured, at four instants
    // along it. `refitTrack` earns confidence as `0.5 + min(anchors,5) * 0.09`
    // (`sync-diagnostic-anchors.ts:143`), so one confirmation lands at 0.59 —
    // under `mediumConfidence` — and the track would read `partial`.
    const ticksToMs = (ticks) => Math.round((Number(ticks) * 1_000) / FPS)
    let anchorBase = firstDiagnostic.data.diagnostic
    for (const camera of ['a', 'b']) {
      const entry = syncByTrack.get(cameraTrackIds[camera])
      const piece = entry.map.pieces[0]
      const offsetMs = ticksToMs(piece.sessionCoverage.start) - ticksToMs(piece.sourceCoverage.start)
      for (const second of [0, 10, 20, 30]) {
        const anchored = await helpers.callRouteOk(anchorsRoute.POST, {
          method: 'POST',
          path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/sync-diagnostic/anchors`,
          token,
          params: { projectId, sessionId },
          body: {
            baseVersionId: diagnosticVersionRef(anchorBase),
            baseHash: anchorBase.diagnosticHash,
            trackId: cameraTrackIds[camera],
            action: 'add',
            anchorId: `camera-${camera}-fingerprint-confirmed-${second}s`,
            sourceMs: second * 1_000,
            sessionMs: second * 1_000 + offsetMs,
            evidenceRef: piece.evidenceRefs[0],
          },
        }, [200, 201])
        anchorBase = anchored.data.diagnostic
      }
    }
    // Regenerated, because an anchor alone cannot lift the block: `refitTrack`
    // keeps the `insufficient-evidence` warning it inherited and `canAutoEdit`
    // reads exactly that warning (`sync-diagnostic.ts:431`).
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
    assert.equal(diagnostic.autoEdit.allowed, true, diagnostic.autoEdit.blockedBy.join(', '))

    // ---- the speech the direction reads -----------------------------------
    // Seeded, and said so: diarization is a paid provider call. Each segment
    // names a stretch of the generated audio, in that camera's own file.
    for (const camera of ['a', 'b']) {
      const artifactId = cameraArtifactIds[camera]
      await helpers.storeDiarizationWorkflow({
        prisma, workspaceId, projectId,
        workflowId: `podcast-workflow-${camera}`,
        operationId: `podcast-index-operation-${camera}`,
        transcriptId: `podcast-transcript-${camera}`,
        sourceArtifactId: artifactId,
        sourceArtifactSha256: cameraBytes[camera].sha256,
        sourceManifestId: registered[artifactId].manifestId,
        sourceManifestHash: registered[artifactId].manifestHash,
        durationMs: CAMERA_SECONDS * 1_000,
        clientId,
        createdAt: at(2),
      })
      await helpers.storeDiarizationRun({
        prisma, workspaceId, projectId,
        runId: `podcast-diarization-${camera}`,
        workflowId: `podcast-workflow-${camera}`,
        transcriptId: `podcast-transcript-${camera}`,
        sourceArtifactId: artifactId,
        sourceArtifactSha256: cameraBytes[camera].sha256,
        sourceManifestId: registered[artifactId].manifestId,
        sourceManifestHash: registered[artifactId].manifestHash,
        durationMs: CAMERA_SECONDS * 1_000,
        segments: SPEECH
          .filter((turn) => turn.camera === camera)
          .map((turn, index) => ({
            providerSegmentId: `${camera}-${index}`,
            providerLabel: camera.toUpperCase(),
            startMs: turn.startMs,
            endMs: turn.endMs,
            text: turn.text,
          })),
        clientId,
        createdAt: at(2),
      })
    }

    // ---- the direction ----------------------------------------------------
    const rangeStartTicks = 4 * FPS
    const rangeEndTicks = 36 * FPS
    const directed = await helpers.callRouteOk(directionRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/direction`,
      token,
      params: { projectId, sessionId },
      idempotencyKey: 'podcast-multicam-direction-1',
      body: {
        baseVersionId: versionId,
        baseHash: projectVersion.baseHash,
        format: { aspectRatio: '16:9' },
        range: { sessionStartTicks: String(rangeStartTicks), sessionEndTicks: String(rangeEndTicks) },
        reason: 'Corte do episódio seguindo quem está falando.',
      },
    }, [201])
    const direction = directed.data.directed.direction
    assert.deepEqual(direction.uncovered, [], 'every directed instant had an eligible angle')
    const directedVersionId = directed.data.directed.projectVersion.id

    const shotListing = await helpers.callRouteOk(shotsRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/direction/shots`,
      token,
      params: { projectId, sessionId },
    }, [200])
    const shots = shotListing.data.shots
    assert.equal(shotListing.data.omittedShots, 0)

    // ---- claim 1: the angle follows the active speaker --------------------
    const shotAt = (tick) => shots.find((shot) =>
      Number(shot.sessionRange.start) <= tick && tick < Number(shot.sessionRange.end))
    const followed = []
    const citedKeys = new Map()
    for (const turn of SPEECH) {
      const offset = offsetTicks[turn.camera]
      const startTick = Math.round((turn.startMs * FPS) / 1_000) + offset
      const endTick = Math.round((turn.endMs * FPS) / 1_000) + offset
      const middle = Math.round((startTick + endTick) / 2)
      if (middle < rangeStartTicks || middle >= rangeEndTicks) continue
      const shot = shotAt(middle)
      assert.ok(shot, `no shot covers ${middle} ticks, where ${turn.speakerKey} is speaking`)
      assert.equal(
        shot.chosen.trackId,
        cameraTrackIds[turn.camera],
        `${turn.speakerKey} speaks into camera ${turn.camera} and the shot on air is ${shot.chosen.trackId}`,
      )
      assert.ok(shot.chosen.activeSpeaker, 'the shot cites the speech it was chosen for')
      // The cluster key is the server's, derived from the provider's label
      // (`speaker-diarization.ts`) — never the one this file wrote. What is
      // asserted is what the key MEANS: one voice per camera, the same one
      // across that camera's turns, and not the other camera's.
      const keys = [...shot.chosen.activeSpeaker.speakerKeys].sort()
      assert.equal(keys.length, 1, `one voice on air, not ${keys.join(',')}`)
      const already = citedKeys.get(turn.camera)
      if (already === undefined) citedKeys.set(turn.camera, keys[0])
      else assert.equal(keys[0], already, `camera ${turn.camera} was two different voices`)
      followed.push(`${turn.camera}@${(middle / FPS).toFixed(1)}s=${shot.chosen.trackId}:${keys[0].slice(0, 22)}`)
    }
    assert.equal(followed.length, SPEECH.length, 'every turn fell inside the directed range')
    assert.equal(new Set(citedKeys.values()).size, 2, 'the two cameras carried two different voices')
    assert.equal(
      new Set(shots.map((shot) => shot.chosen.trackId)).size,
      2,
      'the cut used both cameras',
    )

    // ---- claim 2: no clip lies outside measured coverage ------------------
    const outsideCoverage = []
    for (const shot of shots) {
      const entry = syncByTrack.get(shot.chosen.trackId)
      assert.ok(entry?.coverage, `${shot.chosen.trackId} has measured coverage`)
      assert.ok(shot.chosen.sourceRange, `${shot.shotId} resolved onto its source`)
      const start = Number(shot.chosen.sourceRange.start)
      const end = Number(shot.chosen.sourceRange.end)
      const bounds = [Number(entry.coverage.bounds.start), Number(entry.coverage.bounds.end)]
      if (start < bounds[0] || end > bounds[1] || entry.coverage.gapTicks !== '0') {
        outsideCoverage.push(`${shot.shotId}:${start}-${end} vs ${bounds[0]}-${bounds[1]} gaps=${entry.coverage.gapTicks}`)
      }
      assert.equal(shot.chosen.coverage.availability, 'available')
    }
    assert.deepEqual(outsideCoverage, [], 'every clip lies inside the coverage the worker measured')

    // ---- claim 3: the colour match is a match stage, before the LUT -------
    // The compilations come first: `readContext` refuses to derive a match plan
    // for a project whose ColorPlan sources have no unambiguous trusted
    // compilation (`Every ColorPlan source requires one unambiguous trusted
    // color compilation`), which is the server saying the colorimetry of each
    // recording has to be settled before anything is corrected against it.
    //
    // Each one is built with its four stages DELIBERATELY OUT OF ORDER —
    // creative LUT first, match last — and comes back ordered by
    // `COLOR_TRANSFORM_ORDER`: the position of the match is a property of the
    // domain, not of whoever wrote the request.
    const stage = (id, kind, provider, version, enabled, parameters) => ({
      id,
      kind,
      version: 'v1',
      enabled,
      output: COLOR_METADATA,
      implementation: {
        provider,
        version,
        parameters,
        parametersHash: calculateCanonicalHash(parameters),
      },
    })
    const compilations = {}
    for (const camera of ['a', 'b']) {
      const artifactId = cameraArtifactIds[camera]
      const compiled = await helpers.callRouteOk(compilationsRoute.POST, {
        method: 'POST',
        path: `/v1/projects/${projectId}/color-pipeline-compilations`,
        token,
        params: { projectId },
        idempotencyKey: `podcast-compilation-${camera}-1`,
        body: {
          sourceArtifactId: artifactId,
          sourceManifestId: registered[artifactId].manifestId,
          outputMetadata: COLOR_METADATA,
          stages: [
            stage('creative-none', 'creative-lut', 'apollo-lut', 'v1', false, { mode: 'none' }),
            stage('output-rec709', 'output', 'ffmpeg-zscale', 'v1', true, { mode: 'identity' }),
            stage('technical-rec709', 'technical', 'ffmpeg-zscale', 'v1', true, { mode: 'identity' }),
            stage('match-bypass', 'match', 'apollo-match', 'v1', false, { mode: 'bypass' }),
          ],
        },
      }, [201])
      compilations[camera] = compiled.data.compilation
      const kinds = compilations[camera].pipeline.stages.map((entry) => entry.kind)
      assert.deepEqual(kinds, [...COLOR_TRANSFORM_ORDER], 'the compiled pipeline is ordered by the domain')
      assert.ok(kinds.indexOf('match') < kinds.indexOf('creative-lut'))
    }

    // A LUT selection, because the render worker refuses a version that has not
    // made one: `ProjectVersion has no explicit LUT selection`. `none` is a
    // decision like any other — this episode gets no creative grade — and it is
    // recorded as such rather than defaulted to.
    const lutSet = await helpers.callRouteOk(lutSelectionRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/lut-selection`,
      token,
      params: { projectId },
      idempotencyKey: 'podcast-lut-selection-1',
      body: {
        baseVersionId: directedVersionId,
        baseHash: (await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: directedVersionId } })).baseHash,
        selection: { mode: 'none' },
        reason: 'Sem LUT criativa neste episódio.',
      },
    }, [200, 201])
    const lutVersionId = lutSet.data.version.id

    // The project's own colour pipeline, which a camera match is a LAYER inside
    // rather than a pipeline of its own: without it the match is refused with
    // `PRECONDITION_REQUIRED`. Setting it also queues a proxy render, so the
    // queue is drained here — the cut before any camera correction — and the
    // measured render below is the one taken after the match.
    const planLayer = (id, kind, provider, enabled, parameters) => ({
      id,
      kind,
      version: 'v1',
      enabled,
      input: COLOR_METADATA,
      output: COLOR_METADATA,
      implementation: {
        provider,
        version: 'v1',
        parameters,
        parametersHash: calculateCanonicalHash(parameters),
      },
    })
    const planSet = await helpers.callRouteOk(colorPlanRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/color-plan`,
      token,
      params: { projectId },
      idempotencyKey: 'podcast-color-plan-1',
      body: {
        baseVersionId: lutVersionId,
        baseHash: (await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: lutVersionId } })).baseHash,
        plan: {
          schemaVersion: 'color-plan/v1',
          metadata: COLOR_METADATA,
          outputMetadata: COLOR_METADATA,
          global: [
            planLayer('technical-rec709', 'technical', 'ffmpeg-zscale', true, { mode: 'identity' }),
            planLayer('match-bypass', 'match', 'apollo-match', false, { mode: 'bypass' }),
            planLayer('creative-none', 'creative-lut', 'apollo-lut', false, { mode: 'none' }),
            planLayer('output-rec709', 'output', 'ffmpeg-zscale', true, { mode: 'identity' }),
          ],
          // One entry per recording the timeline cuts, and it has to equal the
          // trusted probe: the service refuses a plan whose source metadata
          // disagrees with what ffprobe reported for that file.
          sourceMetadata: {
            [cameraArtifactIds.a]: COLOR_METADATA,
            [cameraArtifactIds.b]: COLOR_METADATA,
          },
          sources: {},
          cameras: {},
          segments: {},
        },
        reason: 'Pipeline de cor do episódio antes de igualar as câmeras.',
      },
    }, [200, 201])
    const planVersionId = planSet.data.version.id
    // Both `lut-selection` and `color-plan` queue a proxy render of their own.
    // They are drained here — the cut before any camera correction — so the
    // measured render below is unambiguously the one taken after the match.
    const preMatchRenders = await drainProxyRenders()
    for (const outcome of preMatchRenders) {
      assert.equal(outcome.status, 'succeeded', JSON.stringify(outcome))
    }

    const currentAfterDirection = await prisma.v2ProjectVersion.findUniqueOrThrow({
      where: { id: planVersionId },
    })
    // Choosing the reference camera is refused to an unattended credential by
    // name (`multicam-color-match.ts:166`), so this one call is made as the
    // person the bootstrap login authenticates.
    const operatorCookie = await helpers.loginUiSession(sessionLoginRoute, {
      username: uiUsername,
      password: uiPassword,
    })
    const matched = await helpers.callRouteOk(colorMatchRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/color-match`,
      cookie: operatorCookie,
      params: { projectId, sessionId },
      body: {
        referenceCameraId: cameraTrackIds.a,
        baseVersionId: sessionVersionRef(session.data.session),
        baseHash: session.data.session.sessionHash,
        projectBaseVersionId: planVersionId,
        projectBaseHash: currentAfterDirection.baseHash,
        note: 'Câmera A é a referência de cor do episódio.',
      },
    }, [200, 201])
    const matchPlan = matched.data.plan
    assert.equal(matchPlan.pipelineStage, 'match')
    assert.equal(matchPlan.referenceCameraId, cameraTrackIds.a)
    assert.ok(matchPlan.cameraTransforms.length >= 1, 'the darker camera was given a correction')
    for (const entry of matchPlan.cameraTransforms) {
      assert.equal(entry.transform.kind, 'match')
      assert.equal(entry.transform.implementation.provider, 'apollo-match')
    }
    const correctedCameraIds = matchPlan.cameraTransforms.map((entry) => entry.cameraId)
    assert.ok(
      correctedCameraIds.includes(cameraTrackIds.b),
      `the darker camera is corrected, not ${correctedCameraIds.join(',')}`,
    )

    // Where the correction actually lands at render time: the project ColorPlan.
    // `resolveColorPlan` selects one transform per kind and emits them in
    // `COLOR_TRANSFORM_ORDER`, so the camera's match overrides the global match
    // at index 1 and the creative LUT stays after it.
    const colorPlanRead = await helpers.callRouteOk(colorPlanRoute.GET, {
      path: `/v1/projects/${projectId}/color-plan`,
      token,
      params: { projectId },
    }, [200])
    // The read returns the ProjectColorPlan aggregate; the ColorPlan itself is
    // the `plan` inside it.
    const colorPlan = colorPlanRead.data.result.colorPlan.plan
    const cameraLayer = colorPlan.cameras[cameraTrackIds.b] ?? []
    assert.ok(cameraLayer.length > 0, 'the corrected camera has its own layer')
    assert.deepEqual(
      [...new Set(cameraLayer.map((transform) => transform.kind))],
      ['match'],
      'a camera layer written by the match is nothing but match transforms',
    )
    const resolved = resolveColorPlan(colorPlan, { cameraId: cameraTrackIds.b })
    const resolvedKinds = resolved.stages.map((entry) => entry.kind)
    assert.deepEqual(resolvedKinds, [...COLOR_TRANSFORM_ORDER])
    assert.ok(resolvedKinds.indexOf('match') < resolvedKinds.indexOf('creative-lut'))
    assert.equal(
      resolved.stages[resolvedKinds.indexOf('match')].id,
      cameraLayer.find((transform) => transform.kind === 'match').id,
      "the resolved match stage is the camera's own, not the global default",
    )

    // ---- the render, through the queue and the worker an operator runs ----
    // The version the render is taken from: the colour match wrote a ColorPlan
    // and therefore advanced the project past the direction's own version.
    const renderVersionId = (await prisma.v2Project.findUniqueOrThrow({
      where: { id: projectId },
      select: { currentVersionId: true },
    })).currentVersionId
    const enqueued = await helpers.callRouteOk(proxyRendersRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/proxy-renders`,
      token,
      params: { projectId },
      idempotencyKey: 'podcast-proxy-render-1',
      body: {},
    }, [202])
    const operationId = enqueued.data.operation.id
    const renderOutcomes = await drainProxyRenders()
    assert.equal(renderOutcomes.length, 1, 'exactly one render was queued by the request above')
    assert.equal(renderOutcomes[0].operationId, operationId)

    const operation = await helpers.callRouteOk(operationRoute.GET, {
      path: `/v1/operations/${operationId}`,
      token,
      params: { operationId },
    }, [200])
    assert.equal(
      operation.data.operation.status,
      'succeeded',
      JSON.stringify(operation.data.operation),
    )

    // ---- the MP4, measured -------------------------------------------------
    const outputArtifactId = operation.data.operation.target.id
    const outputArtifact = await prisma.v2MediaArtifact.findFirstOrThrow({
      where: { workspaceId, id: outputArtifactId },
    })
    const outputPath = helpers.artifactPath(artifactRoot, outputArtifact.artifactKey)
    const outputBytes = await readFile(outputPath)
    const outputSha256 = helpers.sha256Of(outputBytes)
    assert.equal(outputSha256, outputArtifact.sha256, 'the bytes on disk are the bytes the row claims')
    assert.equal((await stat(outputPath)).size, Number(outputArtifact.byteSize))

    const outputStreams = await helpers.probeStreams(ffprobePath, outputPath)
    const outputVideo = outputStreams.find((stream) => stream.codec_type === 'video')
    const outputAudio = outputStreams.find((stream) => stream.codec_type === 'audio')
    assert.ok(outputVideo, 'the render wrote a picture')
    assert.ok(outputAudio, 'and the recorder audio reached the output')
    const outputFrames = Number(outputVideo.nb_read_frames)
    const expectedFrames = rangeEndTicks - rangeStartTicks
    assert.ok(
      Math.abs(outputFrames - expectedFrames) <= 3,
      `the file holds ${outputFrames} frames against the ${expectedFrames} the direction planned`,
    )
    assert.ok(Math.abs(Number(outputVideo.duration) - outputFrames / FPS) < 0.2)

    // Two instants, one in a shot of each camera, decoded to raw RGB. They must
    // differ, and they must differ in the direction the direction chose.
    const sampleSeconds = {}
    for (const camera of ['a', 'b']) {
      const shot = shots.find((entry) => entry.chosen.trackId === cameraTrackIds[camera])
      assert.ok(shot, `the cut used camera ${camera}`)
      const middleTick = (Number(shot.sessionRange.start) + Number(shot.sessionRange.end)) / 2
      sampleSeconds[camera] = (middleTick - rangeStartTicks) / FPS
    }
    const sampled = {
      a: await helpers.meanRgbAt(ffmpegPath, outputPath, sampleSeconds.a),
      b: await helpers.meanRgbAt(ffmpegPath, outputPath, sampleSeconds.b),
    }
    assert.ok(
      sampled.a.red > sampled.a.blue,
      `camera A is the red one: r=${sampled.a.red.toFixed(1)} b=${sampled.a.blue.toFixed(1)}`,
    )
    assert.ok(
      sampled.b.blue > sampled.b.red,
      `camera B is the blue one: r=${sampled.b.red.toFixed(1)} b=${sampled.b.blue.toFixed(1)}`,
    )
    assert.ok(
      Math.abs(sampled.a.red - sampled.b.red) > 20,
      'the two sampled instants are genuinely different pictures',
    )

    // ---- the critic, on the bytes the render just wrote -------------------
    const reports = await helpers.callRouteOk(criticReportsRoute.GET, {
      path: `/v1/projects/${projectId}/color-critic-reports?projectVersionId=${encodeURIComponent(renderVersionId)}`,
      token,
      params: { projectId },
    }, [200])
    const report = reports.data.reports[0] ?? null

    // ---- gap 2, measured: what the protocol says about this session -------
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

    console.log(
      `E2E-F4.012 podcast 2 cameras + master: master=${Number(masterAudio.duration).toFixed(2)}s/${masterBytes.byteSize}B ` +
      `cameras=${cameraVideo.a.nb_read_frames}f+${cameraVideo.b.nb_read_frames}f offsets=a:${offsetTicks.a}ticks(${(offsetTicks.a / FPS).toFixed(2)}s applied ${CAMERA_A_LAG_SECONDS}s) ` +
      `b:${offsetTicks.b}ticks(${(offsetTicks.b / FPS).toFixed(2)}s applied ${CAMERA_B_LAG_SECONDS}s) ` +
      `diagnostic v${firstDiagnostic.data.diagnostic.version} autoEdit=${firstDiagnostic.data.diagnostic.autoEdit.allowed} ` +
      `anchored+regenerated v${diagnostic.version} autoEdit=${diagnostic.autoEdit.allowed} ` +
      `shots=${shots.length} follows=[${followed.join(' ')}] outsideCoverage=${outsideCoverage.length} ` +
      `match=${matchPlan.cameraTransforms.map((entry) => `${entry.cameraId}:ev${entry.deltas.exposureEv === null ? 'null' : entry.deltas.exposureEv.toFixed(3)}`).join(',')} ` +
      `confidence=${matchPlan.confidence} humanReview=${matchPlan.humanReviewRequired} ` +
      `pipeline=${resolvedKinds.join('>')} compiled=${compilations.b.pipeline.stages.map((entry) => entry.kind).join('>')} ` +
      `render=${operation.data.operation.status} frames=${outputFrames}/${expectedFrames} duration=${Number(outputVideo.duration).toFixed(3)}s ` +
      `vcodec=${outputVideo.codec_name} acodec=${outputAudio.codec_name} bytes=${outputArtifact.byteSize} sha256=${outputSha256.slice(0, 16)} ` +
      `pixels=a@${sampleSeconds.a.toFixed(2)}s(r${sampled.a.red.toFixed(0)},b${sampled.a.blue.toFixed(0)}) b@${sampleSeconds.b.toFixed(2)}s(r${sampled.b.red.toFixed(0)},b${sampled.b.blue.toFixed(0)}) ` +
      `critic=${report ? `${report.reportId}:${report.action}:${report.cause}:hard${report.hardIssues}/warn${report.warningIssues}` : 'none'} ` +
      `protocolCeiling=${evaluation.data.evaluation.ceiling} unmet=${unmet.join('+')}`,
    )
    assert.ok(report, 'the proxy render filed a colour critic report on the bytes it wrote')
    assert.deepEqual(unmet, ['end-marker', 'start-marker'], 'no marker was filmed, and only that is unmet')
  },
)

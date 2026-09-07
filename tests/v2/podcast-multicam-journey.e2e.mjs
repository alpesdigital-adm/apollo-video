import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  closeJourneyObjectStore,
  journeyStorageDriver,
  journeyStorageEnvironment,
  openJourneyObjectStore,
  storedArtifactPath,
} from './helpers/journey-object-storage.mjs'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * E2E-F4.012/F4.013/F4.014 — Journey 1: a two-camera podcast on a master audio
 * recorder, one of the cameras on two cards, from ingest to an inspected MP4.
 *
 * Every step is a published `/v1` route handler called with a `NextRequest`,
 * and both queues are drained by SEPARATE PROCESSES running the npm scripts an
 * operator runs: `worker:v2:capture-sync -- --once` for the synchronization and
 * `scripts/run-v2-render-worker-once.mjs` for the proxy render. Four recordings
 * are generated with ffmpeg into an `mkdtemp` artifact root and removed in
 * `t.after`; nothing is committed.
 *
 * What it proves:
 *
 * - **The offsets the worker measured are the lags the fixtures applied.** Each
 *   camera started a known number of seconds late in the audio all four files
 *   carry, and the clock maps read back over `/v1` have to say so to within one
 *   session tick. Every other instant in this journey is DERIVED from those
 *   offsets, so without this comparison against ground truth the run would be
 *   self-consistent for any measurement at all, including a wrong one.
 * - **The angle follows the diarization projection, turn by turn.** Two
 *   diarization runs — one per camera, over that camera's OWN scratch audio —
 *   put the near voice of each camera on that camera. At the middle of each
 *   turn the shot on air is the camera whose run carries the turn, the cluster
 *   key the shot cites is the key that camera's run produced for that exact
 *   segment, and the observation cited is that segment's own. Swapping the two
 *   runs between the two tracks — which the old "two different voices" count
 *   could not see, because a cluster key is derived from the FILE and two files
 *   can never share one — fails here.
 * - **A 500 ms interjection is not a cut.** The guest's aparte would open a
 *   500 ms shot and the host's answer would close it 1 000 ms later; the
 *   minimum-shot hold keeps the angle for 1 500 ms instead, so the shortest
 *   shot in the cut is a number the POLICY produced rather than one the fixture
 *   happened to contain. Delete rule 8 and this journey reports two
 *   `minimum-shot-violated` warnings and a 500 ms shot.
 * - **A card nobody opened is never cut to.** Camera B stopped and restarted
 *   and wrote two cards; only the first was ever read. The second part carries
 *   `probeSource: 'operator-report'` — a duration somebody wrote on a label —
 *   so `deriveTrackCoverage` marks exactly those ticks `unverified`, and the
 *   candidates read back over `/v1` show the SAME camera eligible on card one
 *   and refused on card two, with `coverage-unverified` as its only reason,
 *   while it is synchronized and resolved onto its own file. Remove the gates
 *   and this journey fails at the direction request itself: the run merges
 *   across the card boundary and `sealShot` refuses a shot that spans two
 *   parts.
 * - **No clip lies outside measured coverage.** Twice over: every shot's source
 *   range sits inside the coverage bounds the worker derived for that track,
 *   and so does every CLIP of the plan the renderer was actually handed — a
 *   shot is a decision, a clip is what got decoded. The coverage has no gaps
 *   and the direction leaves no uncovered stretch.
 * - **The master recorder is the audio bed.** Four recordings, one of which
 *   goes to air as sound: every clip of the rendered cut names the recorder as
 *   its audio, whichever camera it shows.
 * - **The colour match is a match-stage transform, before the creative LUT.**
 *   The plan the server derived from the pixels declares `pipelineStage:
 *   'match'` and every camera transform is a `match` transform. The compilation
 *   the renderer executes is then built with its four stages DELIBERATELY OUT
 *   OF ORDER — creative LUT before match — and comes back ordered
 *   `technical > match > creative-lut > output`: the position is the domain's,
 *   not the caller's.
 * - **The match reached the frames.** The two cameras are sampled in the
 *   delivered MP4 and in their own rushes, at the instants the shots resolve
 *   onto. Camera B, the one the plan corrects, is lifted, and the two cameras
 *   are closer together in the render than they were in the rushes. An inverted
 *   correction fails both.
 * - **The MP4 exists, says so, and shows the right MOMENT.** The proxy render
 *   worker writes it, and it is read back with `ffprobe -count_frames`: frames,
 *   duration, video and audio codec, plus byte size and sha256 against
 *   `GET /v1/artifacts/{id}`. Each camera carries a marker column that advances
 *   with its own clock, so the sampled frame reports which SECOND of which file
 *   was decoded, not merely which camera.
 * - **The critic ran on these bytes.** The colour critic runs inside the proxy
 *   render over the file it just wrote; the summary is read through
 *   `GET .../color-critic-reports` and the verdict itself through
 *   `GET .../color-critic-reports/{reportId}`, where `bytesEvaluated` has to
 *   name the delivered sha256 this journey hashed off disk and the confidence
 *   has to be above zero — a report that measured nothing would satisfy neither.
 *
 * Four shipped gaps are measured here rather than routed around, as in the
 * teacher-and-screen journey. The first two the journey works around in the
 * open; the last two it can only report, because they bound what the journey
 * is able to do at all:
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
 *    be created before the file it names exists. The evaluation runs last —
 *    a stored one constrains every later direction — and its ceiling is
 *    asserted rather than skipped: `manual-anchors-required`, which is one
 *    step better than the teacher-and-screen journey's `not-synchronizable`
 *    precisely because the manual anchors above exist by then.
 * 3. Two renders of one project that produce IDENTICAL bytes cannot both be
 *    stored. Media artifacts are content-addressed by `(workspaceId,
 *    artifactKey)`, so the second render finds the first one's row, gets that
 *    row's id back from `persistOrReplay`, and the worker fails with `Project
 *    render artifact identity did not converge` — after ffmpeg has written the
 *    file and the verify pass has passed it. Re-rendering an unchanged version
 *    therefore fails rather than replaying. The journey has to give its colour
 *    plan a visible effect for that reason and says so at the plan.
 * 4. The reference track's measured coverage has no published reader.
 *    `GET .../sync` builds its listing from sync EVIDENCE records and the
 *    reference track has none — there is nothing to synchronize it against —
 *    even though the worker derives coverage for it like any other track. The
 *    recorder's bounds are read from the projection here, and that read is
 *    labelled where it happens.
 *
 * Three reads in this file do NOT go through a published route, and each is
 * labelled where it happens with the reason there is no route to use:
 * `v2CaptureTrackCoverage` (gap 4 above), `v2ProjectSnapshot` for the compiled
 * plan the renderer consumed (no reader publishes a version's edit plan), and
 * `v2MediaArtifact` for the delivered file's STORAGE key
 * (`presentMediaArtifactV4` replaces it with a public reference on purpose, so
 * there is no published way to find the bytes on disk — everything else about
 * the artifact comes from `GET /v1/artifacts/{id}`). Two more reads take a
 * version's `baseHash` from `v2ProjectVersion` to fence the next command.
 *
 * And one limit of the product is stated rather than hidden, because the shape
 * of the diarization fixture is a consequence of it: the direction's speaker
 * rule keys off WHICH FILE carries a segment, never off which voice. A cluster
 * key is `calculateSpeakerKey({ sourceArtifactSha256, provider, providerLabel })`
 * (`speaker-diarization.ts:150`), so two runs over two files can never share a
 * key even when the same human spoke into both microphones, and a diarizer that
 * (correctly) reported both people on both cameras' scratch audio would leave
 * the direction with identical evidence on both angles and nothing to choose
 * with. So each run here carries only its own camera's near voice, which is
 * what a near-mic pass over that file would return: the fixtures' gain envelope
 * puts the far voice at 0.3 of the near one.
 */

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const RUN = process.env.APOLLO_PODCAST_MULTICAM_E2E === '1'
/**
 * Local disk or versioned MinIO, chosen by the runtime env the composition
 * root reads — never pinned in this file. Read once, at load, so the value the
 * worker children get is the value this process opened its bucket with.
 */
const storageDriver = journeyStorageDriver()

const FPS = 30
/** One tick is one frame, so a session instant and an output frame are the same integer. */
const TIMEBASE = `1/${FPS}`
const MASTER_SECONDS = 45
const CAMERA_SECONDS = 36
const CAMERAS = Object.freeze(['a', 'b'])
/** How late each camera started, in the audio all four files carry. */
const CAMERA_LAG_SECONDS = Object.freeze({ a: 1.2, b: 2.4 })
/**
 * Camera B stopped and restarted: it wrote two cards, and only the first was
 * ever opened.
 *
 * The second card is the whole point of it. Its part carries
 * `probeSource: 'operator-report'` — a duration somebody wrote on a label —
 * which `deriveTrackCoverage` turns into an `unverified` defect over exactly
 * those ticks, and `assertCoverageSelectable(..., 'auto-edit')` then refuses by
 * SHAPE rather than by comparing a confidence. Putting it on a camera the cut
 * DOES use, rather than on a spare angle, is what makes the refusal legible:
 * the same camera goes to air before 28 s of its own clock and is refused
 * after it, and nothing but the probe source changed.
 */
const CAMERA_B_CARD_ONE_SECONDS = 28
const CAMERA_B_CARD_TWO_SECONDS = 8
const WIDTH = 320
const HEIGHT = 180

/**
 * The marker burnt into every camera picture: one lit column of eight, stepping
 * once every four seconds of that camera's OWN clock.
 *
 * A constant colour field is the same frame at every instant, so a pixel sample
 * of it can say which ANGLE went to air and never which MOMENT. With the marker
 * the brightest column of a delivered frame is a reading of the source second
 * the renderer decoded, which is the difference between "this is camera A" and
 * "this is camera A at 6.1 s of camera A's file".
 */
const BAR_COLUMNS = 8
const BAR_STEP_SECONDS = 4
const BAR_COLOR = '0x909090'

/**
 * Who spoke, and when, in the ROOM.
 *
 * Room time IS session time here: the master recorder is the reference track
 * and it started first, so tick zero of the session is sample zero of the
 * recorder. Each camera's own file time is `roomMs - lag`, which is how the
 * diarization segments below and the gain envelope of each camera's audio are
 * both derived — one description of one afternoon, told twice, instead of two
 * unrelated tables that only look consistent.
 *
 * `onAir` is what the direction is expected to show at the middle of the turn.
 * It is the speaker's own camera everywhere except `retomada`, where it is
 * deliberately the OTHER camera: the aparte before it opened a shot 500 ms
 * earlier, and rule 8 holds that shot until it has lasted the minimum. A cut
 * back for one second is not an edit, it is a flicker, and the policy is what
 * says so.
 */
const ROOM_TURNS = Object.freeze([
  Object.freeze({ id: 'abertura', camera: 'a', label: 'ANFITRIA', startMs: 3_000, endMs: 11_500, onAir: 'a', text: 'Abertura do episódio.' }),
  Object.freeze({ id: 'aparte', camera: 'b', label: 'CONVIDADO', startMs: 11_500, endMs: 12_000, onAir: 'b', text: 'Posso comentar uma coisa?' }),
  Object.freeze({ id: 'retomada', camera: 'a', label: 'ANFITRIA', startMs: 12_000, endMs: 13_000, onAir: 'b', text: 'Deixa eu terminar essa parte.' }),
  Object.freeze({ id: 'continuacao', camera: 'a', label: 'ANFITRIA', startMs: 13_000, endMs: 20_000, onAir: 'a', text: 'Continuação da abertura.' }),
  Object.freeze({ id: 'resposta', camera: 'b', label: 'CONVIDADO', startMs: 21_000, endMs: 30_000, onAir: 'b', text: 'Resposta do convidado.' }),
  Object.freeze({ id: 'replica', camera: 'a', label: 'ANFITRIA', startMs: 31_000, endMs: 35_000, onAir: 'a', text: 'Réplica da anfitriã.' }),
])
const APARTE = ROOM_TURNS.find((turn) => turn.id === 'aparte')

/**
 * How loud each camera's microphone hears the near voice, the far voice and the
 * room between turns. Ordered the way a room is ordered — silence is quietest,
 * the far voice is audible, the near voice dominates — because `turnGain` takes
 * the loudest window that covers an instant and an inverted order would make
 * the ambient level swallow the turns it is supposed to sit under.
 */
const NEAR_GAIN = 1
const FAR_GAIN = 0.35
const AMBIENT_GAIN = 0.2

/** The turn windows one camera's microphone is near to, in ROOM seconds. */
const gainWindowsFor = (camera) => ROOM_TURNS.map((turn) => Object.freeze({
  startSeconds: turn.startMs / 1_000,
  endSeconds: turn.endMs / 1_000,
  level: turn.camera === camera ? NEAR_GAIN : FAR_GAIN,
}))

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
    // Spread from the domain, never typed: on Wave 19 every enum written from
    // memory was wrong.
    const { COLOR_CRITIC_ACTIONS, COLOR_CRITIC_CAUSES } = await import('../../src/v2/domain/color-critic-report.ts')
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
    const sessionsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/route.ts')
    const tracksRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/tracks/route.ts')
    const trackPartsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/track-parts/route.ts')
    const protocolRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/protocol/route.ts')
    const protocolEvaluationsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/protocol/evaluations/route.ts')
    const syncRunsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-runs/route.ts')
    const syncRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync/route.ts')
    const diagnosticRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/route.ts')
    const anchorsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/anchors/route.ts')
    const sessionRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/route.ts')
    const directionRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/route.ts')
    const shotsRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/shots/route.ts')
    const candidatesRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/candidates/route.ts')
    const colorMatchRoute = await import('../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/color-match/route.ts')
    const compilationsRoute = await import('../../src/app/v1/projects/[projectId]/color-pipeline-compilations/route.ts')
    const lutSelectionRoute = await import('../../src/app/v1/projects/[projectId]/lut-selection/route.ts')
    const colorPlanRoute = await import('../../src/app/v1/projects/[projectId]/color-plan/route.ts')
    const proxyRendersRoute = await import('../../src/app/v1/projects/[projectId]/proxy-renders/route.ts')
    const operationRoute = await import('../../src/app/v1/operations/[operationId]/route.ts')
    const criticReportsRoute = await import('../../src/app/v1/projects/[projectId]/color-critic-reports/route.ts')
    const criticReportRoute = await import('../../src/app/v1/projects/[projectId]/color-critic-reports/[reportId]/route.ts')
    const artifactRoute = await import('../../src/app/v1/artifacts/[artifactId]/route.ts')
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
    const cardTwoArtifactId = 'artifact-camera-b-card-2'
    // The episode was recorded in the PAST, and that is load-bearing rather
    // than decorative: `evaluateRenderedProxy` refuses a proxy whose completion
    // predates the upload it was rendered from (`render-workflow.ts:221`), and
    // the render worker stamps its completion from the real clock. A fixture
    // dated in the future — which is what the teacher-and-screen journey uses,
    // and gets away with because it never renders — makes every render of it
    // fail with `INVALID_RENDER_INPUT`.
    const at = (second) => new Date(Date.parse('2026-02-10T09:00:00.000Z') + second * 1_000)
    const root = await mkdtemp(join(tmpdir(), 'apollo-podcast-multicam-e2e-'))
    const artifactRoot = join(root, 'artifacts')
    // The bytes FFmpeg writes. In local mode they ARE the stored artifacts, so
    // this is the artifact root itself; in s3 mode they are the fixture the
    // journey uploads, and they are kept OUTSIDE the artifact root on purpose:
    // an assertion below proves no source key resolves to a local file, so
    // every frame the render decoded can only have come out of MinIO.
    const sourceRoot = storageDriver === 's3' ? join(root, 'sources') : artifactRoot
    // Where the s3 materializers stage what they download, and where this
    // suite copies a stored object to before handing it to ffprobe.
    const workRoot = join(root, 'work')
    const readbackRoot = join(root, 'readback')
    for (const directory of [artifactRoot, sourceRoot, workRoot, readbackRoot]) {
      await mkdir(directory, { recursive: true })
    }
    // The direction route and the render worker both build FFmpeg providers and
    // a media materializer from the environment, so this process needs the
    // artifact root too — not just the worker children.
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_RENDER_WORK_ROOT = workRoot
    // Read, never pinned. Every capture journey used to assign `'local'` here,
    // which made "runs against versioned object storage" unfalsifiable and
    // silently overrode any CI step that tried to say otherwise.
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = storageDriver
    const objectStore = await openJourneyObjectStore()
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
    // A whole episode's worth of `/v1` calls arrives in one burst from a
    // workspace that was created seconds earlier, and the request-anomaly
    // detector compares a burst against a BASELINE this workspace does not
    // have: `requestMinimum` 20 with a 3x multiplier
    // (`admit-governed-capability.ts:45-46`) refused the render enqueue with
    // `GOVERNANCE_LIMIT_EXCEEDED` around the thirtieth call. The floor is
    // raised, not the limits — `requestsPerMinute` and the quotas stay at
    // their shipped defaults, so a journey that genuinely exceeded them would
    // still be refused. Same value the four synthetic journeys use.
    process.env.APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM = '400'

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
        // The render's own manifest records what it was derived from, and the
        // lineage row outlives the operation that wrote it: deleting manifests
        // first violates `media_artifact_lineage_manifestId_workspaceId_fkey`.
        prisma.v2MediaArtifactLineage,
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
      await closeJourneyObjectStore(objectStore).catch((error) => {
        console.log(`podcast object storage cleanup reported: ${error?.message ?? error}`)
      })
      await rm(root, { recursive: true, force: true }).catch((error) => {
        console.log(`podcast artifact root cleanup reported: ${error?.message ?? error}`)
      })
      await prisma.$disconnect()
    })
    await clean()

    // ---- the four recordings ----------------------------------------------
    // One room, four microphones. The recorder hears the whole afternoon at
    // full level; each camera hears the same afternoon through its own gain
    // envelope, so the person sitting in front of it is loud and the person
    // across the table is faint. That envelope is what makes a per-camera
    // diarization run describable: a run that put one voice on one file and the
    // other voice on the other file, over two files carrying the identical
    // signal, would be a seeded projection nothing in the audio supports.
    const mediaDirectory = join(sourceRoot, 'capture')
    const room = helpers.sweepSamples({ seconds: MASTER_SECONDS })
    const masterPcm = join(mediaDirectory, 'master.pcm')
    await helpers.writePcm(masterPcm, room)
    // Camera B's first card ends where its second begins: the recorder's own
    // clock is continuous across the restart, so card two's audio starts at the
    // room instant card one stopped at.
    const cardTwoRoomStartSeconds = CAMERA_LAG_SECONDS.b + CAMERA_B_CARD_ONE_SECONDS
    const cameraSeconds = Object.freeze({ a: CAMERA_SECONDS, b: CAMERA_B_CARD_ONE_SECONDS })
    const cameraSeeds = Object.freeze({ a: 20_291_001, b: 20_291_002 })
    const gainFor = (camera) => helpers.turnGain({ windows: gainWindowsFor(camera), ambient: AMBIENT_GAIN })
    const cameraPcm = {}
    for (const camera of CAMERAS) {
      cameraPcm[camera] = join(mediaDirectory, `camera-${camera}.pcm`)
      await helpers.writePcm(cameraPcm[camera], helpers.laggedSamples(room, {
        seconds: cameraSeconds[camera],
        lagSeconds: CAMERA_LAG_SECONDS[camera],
        seed: cameraSeeds[camera],
        gain: gainFor(camera),
      }))
    }
    const cardTwoPcm = join(mediaDirectory, 'camera-b-card-2.pcm')
    await helpers.writePcm(cardTwoPcm, helpers.laggedSamples(room, {
      seconds: CAMERA_B_CARD_TWO_SECONDS,
      lagSeconds: cardTwoRoomStartSeconds,
      seed: 20_291_003,
      gain: gainFor('b'),
    }))

    const keys = Object.freeze({
      master: 'capture/master-audio.m4a',
      a: 'capture/camera-a.mp4',
      b: 'capture/camera-b.mp4',
      cardTwo: 'capture/camera-b-card-2.mp4',
    })
    const files = Object.freeze({
      master: helpers.artifactPath(sourceRoot, keys.master),
      a: helpers.artifactPath(sourceRoot, keys.a),
      b: helpers.artifactPath(sourceRoot, keys.b),
      cardTwo: helpers.artifactPath(sourceRoot, keys.cardTwo),
    })
    const masterBytes = await helpers.encodeAudioRecording({
      ffmpegPath, outputPath: files.master, pcmPath: masterPcm, seconds: MASTER_SECONDS,
    })
    // Camera B is darker than camera A on purpose: a match plan derived from two
    // identically exposed pictures has nothing to correct, and a colour journey
    // whose transform is a bypass proves nothing about matching.
    const cameraFields = Object.freeze({ a: '0xc02020', b: '0x2020c0' })
    // The marker: a grey band overlaid on the field, stepping one column every
    // `BAR_STEP_SECONDS` of the FILE's own clock.
    //
    // `overlay` with `eval=frame`, not `drawbox` with the same expression.
    // Measured: `drawbox=x='mod(floor(t/4)\,8)*40'` evaluates its geometry once,
    // when `t` is still NAN, and the band ends up pinned at the clamp — column 7
    // in every frame of the file, which is a marker that says nothing. Overlay
    // is the filter that documents per-frame evaluation and does it.
    const barWidth = WIDTH / BAR_COLUMNS
    const encodeCamera = ({ field, outputPath, seconds, pcmPath }) => helpers.encodeRecording({
      ffmpegPath,
      outputPath,
      seconds,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
      videoInputs: [
        `color=c=${field}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${seconds}`,
        `color=c=${BAR_COLOR}:s=${barWidth}x${HEIGHT}:r=${FPS}:d=${seconds}`,
      ],
      filterComplex: '[0:v][1:v]overlay='
        + `x='mod(floor(t/${BAR_STEP_SECONDS})\\,${BAR_COLUMNS})*${barWidth}':y=0:eval=frame[picture]`,
      pcmPath,
    })
    const cameraBytes = {}
    for (const camera of CAMERAS) {
      cameraBytes[camera] = await encodeCamera({
        field: cameraFields[camera],
        outputPath: files[camera],
        seconds: cameraSeconds[camera],
        pcmPath: cameraPcm[camera],
      })
    }
    const cardTwoBytes = await encodeCamera({
      field: cameraFields.b,
      outputPath: files.cardTwo,
      seconds: CAMERA_B_CARD_TWO_SECONDS,
      pcmPath: cardTwoPcm,
    })

    const masterStreams = await helpers.probeStreams(ffprobePath, files.master)
    const cameraStreams = {}
    for (const camera of CAMERAS) cameraStreams[camera] = await helpers.probeStreams(ffprobePath, files[camera])
    const cardTwoStreams = await helpers.probeStreams(ffprobePath, files.cardTwo)
    const cardTwoVideo = cardTwoStreams.find((stream) => stream.codec_type === 'video')
    const masterAudio = masterStreams.find((stream) => stream.codec_type === 'audio')
    assert.ok(masterAudio, 'the recorder wrote an audio stream')
    assert.equal(masterStreams.some((stream) => stream.codec_type === 'video'), false, 'and no picture')
    const cameraVideo = {}
    for (const camera of CAMERAS) {
      cameraVideo[camera] = cameraStreams[camera].find((stream) => stream.codec_type === 'video')
      assert.ok(
        cameraStreams[camera].some((stream) => stream.codec_type === 'audio'),
        `camera ${camera} kept its scratch audio, which is what the protocol synchronizes on`,
      )
    }
    // The marker is a property of the FIXTURE, so it is measured on the fixture
    // before anything downstream is allowed to depend on it: at the middle of
    // each of two different steps the lit column has to be the step's own.
    for (const sourceSecond of [2, 6, 10]) {
      const columns = await helpers.columnLumaAt(ffmpegPath, files.a, sourceSecond, BAR_COLUMNS)
      assert.equal(
        columns.indexOf(Math.max(...columns)),
        Math.floor(sourceSecond / BAR_STEP_SECONDS) % BAR_COLUMNS,
        `the marker at ${sourceSecond}s of camera A does not sit in the column its own clock names: ${columns.map((value) => value.toFixed(0)).join(',')}`,
      )
    }
    const producerDigest = await helpers.binaryDigest(ffprobePath)

    // ---- the storage of record --------------------------------------------
    // In s3 mode the four recordings are PUT into the run's own versioned
    // bucket under the same keys the media rows carry, and the artifact root is
    // then proven to hold none of them: the direction, the colour match and the
    // render all resolve sources through `S3ArtifactSourceMaterializer`, so a
    // local copy at the artifact path would be an escape hatch that lets the
    // journey pass without object storage ever being read.
    if (objectStore) {
      for (const key of Object.values(keys)) {
        await objectStore.put(key, helpers.artifactPath(sourceRoot, key))
      }
      assert.deepEqual(await objectStore.keys(), Object.values(keys).slice().sort())
      for (const key of Object.values(keys)) {
        assert.equal(
          existsSync(helpers.artifactPath(artifactRoot, key)),
          false,
          `${key} must not also sit in the artifact root while MinIO is the store of record`,
        )
      }
    }

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
    for (const camera of CAMERAS) {
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
    // Camera B's second card. Ingested exactly like the others — the bytes were
    // read, hashed and probed here, and it is only the CAPTURE SESSION that
    // will say nobody opened the card, because that is the claim the coverage
    // is derived from.
    registered[cardTwoArtifactId] = await helpers.registerRecording({
      prisma, workspaceId, projectId,
      artifactId: cardTwoArtifactId,
      artifactKey: keys.cardTwo,
      mediaType: 'video',
      container: 'mp4',
      sha256: cardTwoBytes.sha256,
      byteSize: cardTwoBytes.byteSize,
      probe: {
        width: Number(cardTwoVideo.width),
        height: Number(cardTwoVideo.height),
        duration: Number(cardTwoVideo.duration),
        fps: FPS,
      },
      colorMetadata: helpers.colorMetadataFromStream(cardTwoVideo),
      pixelFormat: cardTwoVideo.pix_fmt,
      producerVersion: 'ffprobe-static',
      producerBinaryDigest: producerDigest,
      role: 'selected-insert',
      originalFileName: 'camera-b-card-2.mp4',
      createdAt: at(0),
      recipeId: 'capture-camera-ingest',
    })
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
    // `probeSource` is the load-bearing field of a part and the reason camera C
    // exists in this journey. `packet-scan` says every packet of the file was
    // read; `operator-report` says somebody wrote the duration on a label and
    // nobody opened the card. `deriveTrackCoverage` turns the second into an
    // `unverified` defect over the whole part (`COVERAGE_CONFIDENCE_POLICY`),
    // and `assertCoverageSelectable(..., 'auto-edit')` then refuses it by
    // SHAPE — not by a confidence comparison — which is what F4.005 is for.
    const trackPart = ({ trackId, artifactId, sha256, endTicks, probeSource = 'packet-scan' }) => ({
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
        probeSource,
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
    /** Where camera B's first card stops on the track's own clock. */
    const cardOneEndTicks = Math.round(Number(cameraVideo.b.duration) * FPS)
    for (const camera of CAMERAS) {
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

    // Camera B's second card, through the published route that attaches a
    // further file to a track the recorder had already started. It is added
    // BEFORE the sync run because a part changes the session version and marks
    // `track-coverage`, `session-clock-map` and `sync-diagnostic` stale — a
    // card attached afterwards would leave every derivation describing a
    // session that no longer exists.
    const cardTwoEndTicks = cardOneEndTicks + Math.round(Number(cardTwoVideo.duration) * FPS)
    const withCardTwo = await helpers.callRouteOk(trackPartsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/track-parts`,
      token,
      params: { projectId, sessionId },
      body: {
        baseVersionId: sessionVersionRef(head),
        baseHash: head.sessionHash,
        trackId: cameraTrackIds.b,
        part: {
          partId: 'part-camera-b-card-2',
          ordinal: 1,
          sourceAssetId: cardTwoArtifactId,
          timebase: TIMEBASE,
          // The recorder's clock is continuous across a restart: card two picks
          // up on the track's own timeline where card one stopped.
          coverage: { start: String(cardOneEndTicks), end: String(cardTwoEndTicks) },
          streamIndex: 0,
          splitReason: 'recorder-restart',
          evidence: {
            ingestArtifactId: cardTwoArtifactId,
            ingestSha256: cardTwoBytes.sha256,
            probeHash: producerDigest,
            probeSource: 'operator-report',
            observedAt: at(1).toISOString(),
          },
        },
        lineage: { commandId: 'command-add-camera-b-card-2', actorKind: 'api-client', actorId: clientId, note: null },
      },
    }, [201])
    head = withCardTwo.data.session
    assert.equal(head.trackCount, 3, 'a second card is a second part, not a second track')

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
      // The same store this process opened, not a second one: a worker left on
      // the local driver would render from a disk the parent never wrote to.
      ...journeyStorageEnvironment({ driver: storageDriver, artifactRoot, workRoot }),
      // The render worker seals its recipe parameters before it writes a
      // manifest; without a key it refuses to start rather than storing them in
      // the clear.
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'podcast-multicam-e2e-key',
      APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 11).toString('base64url'),
    }
    /** The shared driver, bound to this journey's workspace and environment. */
    const drainProxyRenders = (expected) =>
      helpers.drainProxyRenders({ prisma, workspaceId, environment: workerEnvironment, expected })

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
    for (const camera of CAMERAS) {
      const entry = syncByTrack.get(cameraTrackIds[camera])
      assert.ok(entry, `camera ${camera} has a sync verdict`)
      assert.equal(entry.outcome, 'auto-apply', entry.outcomeReasons.join('; '))
      assert.equal(entry.selectedMethod, 'audio-fingerprint')
      assert.ok(entry.map, `camera ${camera} has a clock map`)
      assert.equal(entry.coverage.gapTicks, '0', `camera ${camera} coverage has no holes`)
      offsetTicks[camera] = Number(entry.map.pieces[0].offsetTicks)
    }
    // Ground truth, and the only assertion in this journey that can tell a
    // correlator from a random number generator. Every instant below — the turn
    // windows, the sample seconds, the source seconds the marker is read at —
    // is DERIVED from these offsets, so a run that never compared them with the
    // lag the fixtures applied would be self-consistent around any measurement
    // whatsoever. One tick of tolerance: the correlator works on 2 s windows of
    // 16 kHz audio and answers in session ticks, so a lag that is an exact
    // number of frames can still land either side of a rounding.
    for (const camera of CAMERAS) {
      const applied = CAMERA_LAG_SECONDS[camera] * FPS
      assert.ok(
        Math.abs(offsetTicks[camera] - applied) <= 1,
        `camera ${camera}: the worker measured ${offsetTicks[camera]} ticks where the fixture delayed it by ${CAMERA_LAG_SECONDS[camera]}s (${applied} ticks)`,
      )
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
    for (const camera of CAMERAS) {
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
    for (const camera of CAMERAS) {
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
    // Seeded, and said so: diarization is a paid provider call. What is seeded
    // is one near-mic pass per camera over that camera's OWN file: the turns
    // that camera is near to, converted from room time into its file's time
    // with the lag that camera's audio was written with. The far voice is in
    // those files too, at 0.35 of the near one, and is deliberately not
    // reported — see the note at the top of this file about why a run naming
    // both voices would leave the direction with nothing to choose between.
    // Camera C gets no run at all: it is near to nobody.
    const fileMsFor = (camera, roomMs) => roomMs - Math.round(CAMERA_LAG_SECONDS[camera] * 1_000)
    const turnsFor = (camera) => ROOM_TURNS.filter((turn) => turn.camera === camera)
    const diarizationRuns = {}
    for (const camera of CAMERAS) {
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
      diarizationRuns[camera] = await helpers.storeDiarizationRun({
        prisma, workspaceId, projectId,
        runId: `podcast-diarization-${camera}`,
        workflowId: `podcast-workflow-${camera}`,
        transcriptId: `podcast-transcript-${camera}`,
        sourceArtifactId: artifactId,
        sourceArtifactSha256: cameraBytes[camera].sha256,
        sourceManifestId: registered[artifactId].manifestId,
        sourceManifestHash: registered[artifactId].manifestHash,
        durationMs: CAMERA_SECONDS * 1_000,
        segments: turnsFor(camera).map((turn) => ({
          providerSegmentId: turn.id,
          providerLabel: turn.label,
          startMs: fileMsFor(camera, turn.startMs),
          endMs: fileMsFor(camera, turn.endMs),
          text: turn.text,
        })),
        clientId,
        createdAt: at(2),
      })
    }
    // The keys the DOMAIN derived, kept by turn so the direction's citations can
    // be checked against them below. They are not written here and they are not
    // guessable: `calculateSpeakerKey` hashes the file's sha256 with the
    // provider triple and the label.
    const keyByTurn = new Map()
    const segmentByTurn = new Map()
    for (const camera of CAMERAS) {
      turnsFor(camera).forEach((turn, index) => {
        const segment = diarizationRuns[camera].segments[index]
        assert.equal(segment.providerSegmentId, turn.id, 'the stored run kept the turns in order')
        keyByTurn.set(turn.id, segment.speakerKey)
        segmentByTurn.set(turn.id, `observation:speech-podcast-diarization-${camera}-${segment.ordinal}`)
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

    // ---- claim 1: the angle follows the diarization projection ------------
    // A session instant is never typed here. It is the turn's instant in that
    // camera's own file, plus the offset the WORKER measured for that camera —
    // which the block above has already checked against the lag the fixture
    // applied, so the derivation stands on a measurement rather than on the
    // fixture agreeing with itself.
    const shotAt = (tick) => shots.find((shot) =>
      Number(shot.sessionRange.start) <= tick && tick < Number(shot.sessionRange.end))
    const sessionTickOfTurn = (turn, roomMs) =>
      Math.round((fileMsFor(turn.camera, roomMs) * FPS) / 1_000) + offsetTicks[turn.camera]
    const followed = []
    for (const turn of ROOM_TURNS) {
      const startTick = sessionTickOfTurn(turn, turn.startMs)
      const endTick = sessionTickOfTurn(turn, turn.endMs)
      const middle = Math.round((startTick + endTick) / 2)
      assert.ok(
        middle >= rangeStartTicks && middle < rangeEndTicks,
        `turn ${turn.id} lands at ${middle} ticks, outside the directed range`,
      )
      const shot = shotAt(middle)
      assert.ok(shot, `no shot covers ${middle} ticks, where ${turn.label} is speaking`)
      assert.equal(
        shot.chosen.trackId,
        cameraTrackIds[turn.onAir],
        `at the middle of ${turn.id} the shot on air should be camera ${turn.onAir}, not ${shot.chosen.trackId}`,
      )
      let cited = 'held'
      if (turn.onAir === turn.camera) {
        assert.ok(shot.chosen.activeSpeaker, `the shot over ${turn.id} cites the speech it was chosen for`)
        // The key is the SERVER's — re-derived by the projection from `runJson`
        // and refused if the body does not reproduce the stored hashes — and it
        // is compared with the key the domain factory computed for THIS
        // camera's run when the fixture was stored. Counting distinct keys, as
        // this journey used to, could not fail: a key is derived from the
        // file's sha256, so two runs over two files never share one even when
        // the same human spoke into both microphones. Naming the key instead
        // catches the thing that can actually go wrong — the projection
        // attaching a run to the wrong track.
        const keys = [...shot.chosen.activeSpeaker.speakerKeys].sort()
        assert.deepEqual(
          keys,
          [keyByTurn.get(turn.id)],
          `the voice on air over ${turn.id} is the cluster camera ${turn.camera}'s own run reported for it`,
        )
        assert.ok(
          shot.chosen.activeSpeaker.evidenceRefs.includes(segmentByTurn.get(turn.id)),
          `the shot over ${turn.id} cites that turn's own segment, not another of the same camera's: ${shot.chosen.activeSpeaker.evidenceRefs.join(' ')}`,
        )
        cited = keys[0].slice(0, 22)
      }
      followed.push(`${turn.id}@${(middle / FPS).toFixed(1)}s=${shot.chosen.trackId}:${cited}`)
    }
    // The swap detector, stated once over the whole cut: every key that reached
    // air on a camera is that camera's own. Exchanging the two stored runs
    // leaves the count of distinct keys at two and fails this.
    for (const camera of CAMERAS) {
      const onAir = [...new Set(shots
        .filter((shot) => shot.chosen.trackId === cameraTrackIds[camera] && shot.chosen.activeSpeaker)
        .flatMap((shot) => shot.chosen.activeSpeaker.speakerKeys))]
      assert.deepEqual(
        onAir,
        [diarizationRuns[camera].segments[0].speakerKey],
        `camera ${camera} went to air citing a cluster that is not the one its own run produced`,
      )
    }
    assert.deepEqual(
      [...new Set(shots.map((shot) => shot.chosen.trackId))].sort(),
      [cameraTrackIds.a, cameraTrackIds.b].sort(),
      'the cut used both main cameras and nothing else',
    )

    // ---- claim 1b: a 500 ms interjection is not a cut ---------------------
    // The one place in these two journeys where the minimum-shot policy is the
    // only thing standing between the fixture and a sub-minimum shot. The
    // aparte opens a shot on camera B; the host answers 500 ms later and would
    // close it; rule 8 holds camera B until the shot has lasted the minimum,
    // and the number below is therefore the POLICY's, not the fixture's.
    const minimumShotMs = direction.policy.minimumShotMs
    const aparteStartTick = sessionTickOfTurn(APARTE, APARTE.startMs)
    const aparteShot = shotAt(aparteStartTick)
    assert.ok(aparteShot, `no shot covers the aparte at ${aparteStartTick} ticks`)
    assert.equal(aparteShot.chosen.trackId, cameraTrackIds.b, 'the aparte cut to the guest')
    assert.ok(
      Math.abs(Number(aparteShot.sessionRange.start) - aparteStartTick) <= 1,
      `the cut landed at ${aparteShot.sessionRange.start} ticks, not where the aparte starts (${aparteStartTick})`,
    )
    const aparteShotMs = ((Number(aparteShot.sessionRange.end) - Number(aparteShot.sessionRange.start)) * 1_000) / FPS
    const aparteMs = APARTE.endMs - APARTE.startMs
    assert.ok(
      aparteShotMs >= minimumShotMs,
      `the aparte's shot lasts ${aparteShotMs}ms, under the ${minimumShotMs}ms minimum`,
    )
    assert.ok(
      aparteShotMs > aparteMs,
      `the ${aparteMs}ms aparte was cut at its own length (${aparteShotMs}ms) rather than held`,
    )
    const shortestShotMs = Math.min(...shots.map((shot) =>
      ((Number(shot.sessionRange.end) - Number(shot.sessionRange.start)) * 1_000) / FPS))
    assert.ok(
      shortestShotMs >= minimumShotMs,
      `the shortest shot is ${shortestShotMs}ms against a minimum of ${minimumShotMs}ms`,
    )
    assert.deepEqual(
      direction.warnings.filter((warning) => warning.code === 'minimum-shot-violated'),
      [],
      'and the direction says so itself',
    )

    // ---- claim 1c: the card nobody opened is never cut to -----------------
    // The same camera, on both sides of one probe source. Camera B's first card
    // was read packet by packet and goes to air; its second card is a duration
    // somebody wrote on a label, and the coverage gate refuses it — by shape,
    // with `coverage-unverified` as the reason, over a stretch where the camera
    // is otherwise perfectly usable: synchronized, resolved onto its own file,
    // and inside the directed range. Delete the gate and the refusal below
    // disappears while every other assertion in this journey stays green.
    const cardTwoSessionStartTick = cardOneEndTicks + offsetTicks.b
    assert.ok(
      cardTwoSessionStartTick > rangeStartTicks && cardTwoSessionStartTick < rangeEndTicks,
      `the second card has to start inside the directed range to be refused inside it (${cardTwoSessionStartTick})`,
    )
    const cameraBCandidates = await helpers.callRouteOk(candidatesRoute.GET, {
      path: `/v1/projects/${projectId}/capture-sessions/${sessionId}/direction/candidates`
        + `?trackId=${cameraTrackIds.b}&limit=200`,
      token,
      params: { projectId, sessionId },
    }, [200])
    // The listing is per decided WINDOW, each carrying the candidates evaluated
    // over it; the filter narrowed those to camera B's.
    assert.equal(cameraBCandidates.data.omittedWindows, 0, 'the whole candidate listing was read')
    const cameraBEvaluated = cameraBCandidates.data.windows.flatMap((window) => window.candidates)
    assert.ok(
      cameraBEvaluated.every((candidate) => candidate.trackId === cameraTrackIds.b),
      'the trackId filter narrowed the listing to camera B',
    )
    const onCardTwo = cameraBEvaluated
      .filter((candidate) => Number(candidate.sessionRange.start) >= cardTwoSessionStartTick)
    const onCardOne = cameraBEvaluated
      .filter((candidate) => Number(candidate.sessionRange.end) <= cardTwoSessionStartTick)
    assert.ok(onCardTwo.length > 0, 'the direction evaluated camera B over its second card at all')
    assert.ok(onCardOne.length > 0, 'and over its first card')
    for (const candidate of onCardTwo) {
      assert.equal(
        candidate.eligible,
        false,
        `camera B was eligible over its unprobed card at ${candidate.sessionRange.start}`,
      )
      assert.deepEqual(
        candidate.rejectionReasons,
        ['coverage-unverified'],
        `the unprobed card is refused for its probe source and nothing else: ${candidate.rejectionReasons.join(', ')}`,
      )
      assert.equal(candidate.coverage.availability, 'unverified')
      assert.equal(candidate.coverage.confidenceBps, null, 'an unverified range carries no confidence to compare')
      // Not a sync problem, which is the failure this could be mistaken for:
      // the track resolved onto its own file and was refused afterwards.
      assert.ok(candidate.sourceRange, 'camera B resolved onto its second card')
      assert.equal(candidate.sourcePartAssetId, cardTwoArtifactId, 'and that file is the second card')
      assert.ok(
        ['synced-high', 'synced-medium'].includes(candidate.syncStatus),
        `camera B is synchronized here (${candidate.syncStatus}); the coverage is the only thing wrong with it`,
      )
    }
    // The control, on the same track and the same run: the first card is
    // available, so the refusal above is about the probe source and not about
    // camera B.
    assert.ok(
      onCardOne.some((candidate) => candidate.eligible && candidate.coverage.availability === 'available'),
      'camera B was eligible somewhere on its probed card',
    )
    assert.deepEqual(
      [...new Set(shots.map((shot) => shot.chosen.sourcePartAssetId))].sort(),
      [cameraArtifactIds.a, cameraArtifactIds.b].sort(),
      'no shot was cut from the card nobody opened',
    )
    for (const shot of shots.filter((entry) => Number(entry.sessionRange.start) >= cardTwoSessionStartTick)) {
      assert.equal(
        shot.chosen.trackId,
        cameraTrackIds.a,
        `past the card change only camera A is left, and the cut shows ${shot.chosen.trackId}`,
      )
    }

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
    // The position of the match is a property of the domain, not of whoever
    // wrote the request — and the domain no longer says so by silently
    // re-sorting. `normalizeLayer` calls `assertMatchStagePosition`, so a
    // request that declares the creative LUT ahead of the match is REFUSED
    // `422 COLOR_STAGE_VIOLATION` instead of being accepted and quietly put
    // back in order. That is the stronger property, and it is proved first,
    // below, before the compilations this journey needs are written in the
    // order `COLOR_TRANSFORM_ORDER` defines.
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
    const technicalStage = stage('technical-rec709', 'technical', 'ffmpeg-zscale', 'v1', true, { mode: 'identity' })
    const matchStage = stage('match-bypass', 'match', 'apollo-match', 'v1', false, { mode: 'bypass' })
    const creativeStage = stage('creative-none', 'creative-lut', 'apollo-lut', 'v1', false, { mode: 'none' })
    const outputStage = stage('output-rec709', 'output', 'ffmpeg-zscale', 'v1', true, { mode: 'identity' })
    const [firstCamera] = CAMERAS
    const firstArtifactId = cameraArtifactIds[firstCamera]
    const refused = await helpers.callRouteOk(compilationsRoute.POST, {
      method: 'POST',
      path: `/v1/projects/${projectId}/color-pipeline-compilations`,
      token,
      params: { projectId },
      idempotencyKey: `podcast-compilation-${firstCamera}-misordered`,
      body: {
        sourceArtifactId: firstArtifactId,
        sourceManifestId: registered[firstArtifactId].manifestId,
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
    // Only the two cameras the timeline cuts to: a ColorPlan names the
    // recordings the cut uses, and camera C is never one of them.
    const compilations = {}
    for (const camera of CAMERAS) {
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
          stages: [technicalStage, matchStage, creativeStage, outputStage],
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
    // Drained IMMEDIATELY, before the next command advances the project.
    // `set-project-lut-selection` and `set-project-color-plan` are both
    // `renderPolicy: 'full-timeline'` (`edit-command-registry.ts:109,119`), so
    // each queues a render of the version it created — and a render whose
    // version the project has since moved past cannot file its proxy review:
    // `proxy-review-repository.ts:256` refuses it with `VERSION_CONFLICT`,
    // "Proxy review no longer belongs to the current project version", after
    // ffmpeg has already written the file. Batching the two drains, which is
    // what the draft did, therefore threw away the first render every time.
    const lutRenders = await drainProxyRenders(1)

    // The project's own colour pipeline, which a camera match is a LAYER inside
    // rather than a pipeline of its own: without it the match is refused with
    // `PRECONDITION_REQUIRED`.
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
            // A mild room-wide lift, and it has to be a real one. `set-project
            // -lut-selection` and `set-project-color-plan` are both
            // `full-timeline` (`edit-command-registry.ts:109,119`) and each
            // renders the cut as it stands; a colour plan that changed nothing
            // would produce a file byte-identical to the LUT selection's, and
            // media artifacts are content-addressed — the second render finds
            // the first one's row under the same `artifactKey`, gets its id
            // back, and dies on `Project render artifact identity did not
            // converge`. Two renders of one timeline are only distinguishable
            // if they look different.
            planLayer('match-room', 'match', 'apollo-match', true, {
              mode: 'adjust', brightness: 0.04, contrast: 1.06, saturation: 1,
            }),
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
    // The cut as it stands before any camera correction.
    const preMatchRenders = await drainProxyRenders(1)

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
    // The colour match queues nothing of its own: `lut-selection` and
    // `color-plan` each call `enqueueProjectProxyRenderService` in their route
    // handler and the match route does not, so the version the correction
    // created has no proxy until an operator asks for one. That request is the
    // next call, and the file it produces is the one measured below.
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
    const renderOutcomes = await drainProxyRenders(1)
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
    // What the delivered file IS comes back over `/v1`: the client that asked
    // for the render holds `artifacts:read` and the reader publishes `sha256`
    // and `byteSize`, so hashing the bytes on disk compares them with the
    // published answer rather than with the row behind it. The Prisma read that
    // stays is for `artifactKey` alone — the STORAGE key, which
    // `presentMediaArtifactV4` deliberately replaces with a public reference,
    // leaving no published way to find the file on disk.
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
    // In s3 mode this is a version-bound GET out of MinIO, not a path on this
    // machine: the bytes measured below are the bytes the store holds, and a
    // render that had only reached the local staging root would fail here
    // rather than pass on a leftover.
    const outputPath = await storedArtifactPath(objectStore, {
      artifactRoot,
      artifactKey: outputArtifact.artifactKey,
      readbackRoot,
    })
    const outputBytes = await readFile(outputPath)
    const outputSha256 = helpers.sha256Of(outputBytes)
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
    assert.ok(outputAudio, 'and the recorder audio reached the output')
    const outputFrames = Number(outputVideo.nb_read_frames)
    const expectedFrames = rangeEndTicks - rangeStartTicks
    assert.ok(
      Math.abs(outputFrames - expectedFrames) <= 3,
      `the file holds ${outputFrames} frames against the ${expectedFrames} the direction planned`,
    )
    assert.ok(Math.abs(Number(outputVideo.duration) - outputFrames / FPS) < 0.2)

    // Two instants, one in the longest shot of each camera, decoded to raw RGB.
    // Each one is read three ways: which camera it is (hue), which SECOND of
    // that camera's file it is (the marker column) and how bright it is
    // (the colour match, below).
    // The instant is chosen so the marker reading cannot be a coin toss: of the
    // marker steps whose CENTRE falls inside the shot (with half a second of
    // clearance at each end), the one nearest the shot's middle. Both cameras'
    // shots here are cut from part 0, whose coverage starts at tick zero, so a
    // source tick and a file second are the same instant.
    const sampleSeconds = {}
    const sourceSeconds = {}
    for (const camera of CAMERAS) {
      const shot = [...shots]
        .filter((entry) => entry.chosen.trackId === cameraTrackIds[camera])
        .sort((left, right) =>
          (Number(right.sessionRange.end) - Number(right.sessionRange.start))
          - (Number(left.sessionRange.end) - Number(left.sessionRange.start)))[0]
      assert.ok(shot, `the cut used camera ${camera}`)
      assert.equal(shot.chosen.sourcePartAssetId, cameraArtifactIds[camera], 'the longest shot is cut from card one')
      const sourceStart = Number(shot.chosen.sourceRange.start)
      const sourceEnd = Number(shot.chosen.sourceRange.end)
      const clearance = FPS / 2
      const centres = []
      for (let step = 0; (step + 0.5) * BAR_STEP_SECONDS * FPS < sourceEnd; step += 1) {
        const centre = Math.round((step + 0.5) * BAR_STEP_SECONDS * FPS)
        if (centre >= sourceStart + clearance && centre <= sourceEnd - clearance) centres.push(centre)
      }
      assert.ok(
        centres.length > 0,
        `camera ${camera}'s longest shot (${sourceStart}-${sourceEnd}) holds no whole marker step to sample`,
      )
      const middleSourceTick = (sourceStart + sourceEnd) / 2
      const sampleSourceTick = centres.reduce((best, centre) =>
        (Math.abs(centre - middleSourceTick) < Math.abs(best - middleSourceTick) ? centre : best))
      const sessionTick = Number(shot.sessionRange.start) + (sampleSourceTick - sourceStart)
      sampleSeconds[camera] = (sessionTick - rangeStartTicks) / FPS
      sourceSeconds[camera] = sampleSourceTick / FPS
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

    // ---- which MOMENT, not just which camera ------------------------------
    // A constant colour field answers "camera A" at every instant of camera A's
    // file, so the two assertions above would hold just as well for a clip that
    // decoded the head of its own file instead of the stretch it claims. The
    // marker column is what makes the instant readable: it steps once every
    // four seconds of the SOURCE clock, and every stage of the colour pipeline
    // is a monotone per-pixel map, so the brightest column of the delivered
    // frame is still the column the source frame lit.
    const markerColumns = {}
    for (const camera of CAMERAS) {
      const columns = await helpers.columnLumaAt(ffmpegPath, outputPath, sampleSeconds[camera], BAR_COLUMNS)
      const lit = columns.indexOf(Math.max(...columns))
      const expected = Math.floor(sourceSeconds[camera] / BAR_STEP_SECONDS) % BAR_COLUMNS
      // The fixture's own guard: a sample landing on a step boundary would make
      // the reading a coin toss rather than a measurement.
      const distanceToStep = Math.min(
        sourceSeconds[camera] % BAR_STEP_SECONDS,
        BAR_STEP_SECONDS - (sourceSeconds[camera] % BAR_STEP_SECONDS),
      )
      assert.ok(
        distanceToStep > 0.5,
        `camera ${camera}'s sample sits ${distanceToStep.toFixed(2)}s from a marker step; move the fixture, not the assertion`,
      )
      assert.equal(
        lit,
        expected,
        `the delivered frame at ${sampleSeconds[camera].toFixed(2)}s shows marker column ${lit}, `
        + `but it claims to come from ${sourceSeconds[camera].toFixed(2)}s of camera ${camera}, which lights column ${expected}`,
      )
      markerColumns[camera] = lit
    }

    // ---- the colour match, on the pixels rather than in the plan ----------
    // The plan says camera B is `exposureEv` below the reference and declares a
    // `match` transform to close the gap. Whether the gap actually closed is a
    // question about frames: each camera is sampled in its OWN rushes at the
    // second the shot resolved onto, and compared with the delivered frame.
    // Camera B has to come out brighter than its rushes, and the two cameras
    // have to sit closer together in the render than they did in the rushes. An
    // inverted correction — the same magnitude the other way — fails both.
    const sourceSampled = {
      a: await helpers.meanRgbAt(ffmpegPath, files.a, sourceSeconds.a),
      b: await helpers.meanRgbAt(ffmpegPath, files.b, sourceSeconds.b),
    }
    const deliveredLuma = { a: helpers.lumaOf(sampled.a), b: helpers.lumaOf(sampled.b) }
    const sourceLuma = { a: helpers.lumaOf(sourceSampled.a), b: helpers.lumaOf(sourceSampled.b) }
    const correctedTransform = matchPlan.cameraTransforms.find((entry) => entry.cameraId === cameraTrackIds.b)
    assert.ok(correctedTransform, 'the plan corrects camera B')
    assert.ok(
      correctedTransform.deltas.exposureEv < 0,
      `the plan measured camera B darker than the reference; it reports ${correctedTransform.deltas.exposureEv}`,
    )
    assert.ok(
      deliveredLuma.b > sourceLuma.b + 1,
      `camera B was not lifted: ${sourceLuma.b.toFixed(1)} in the rushes, ${deliveredLuma.b.toFixed(1)} in the render`,
    )
    const sourceGap = Math.abs(sourceLuma.a - sourceLuma.b)
    const deliveredGap = Math.abs(deliveredLuma.a - deliveredLuma.b)
    assert.ok(
      deliveredGap < sourceGap,
      `the cameras are no closer in the render (${deliveredGap.toFixed(1)}) than in the rushes (${sourceGap.toFixed(1)})`,
    )

    // ---- claim 4: the master recorder is the audio bed --------------------
    // A podcast on a master recorder has four recordings and exactly one of
    // them goes to air as sound. The compiled plan the renderer consumed is
    // read back from the snapshot the render named — inspection of what was
    // stored, not a second derivation — and every clip has to carry the
    // recorder as its audio whichever camera it shows. `sync-only` on every
    // camera is what says so upstream; this is what the cut did with it.
    //
    // UNPUBLISHED READ, and the second of the three this file makes: no `/v1`
    // reader publishes a project version's compiled edit plan. `GET .../shots`
    // publishes the DECISIONS and this is the plan the renderer was handed,
    // which is exactly the difference the claim is about — so the snapshot the
    // rendered version names is opened directly, and nothing is derived from it
    // here beyond reading the clips it stored.
    const renderedVersionRow = await prisma.v2ProjectVersion.findUniqueOrThrow({
      where: { id: renderVersionId },
    })
    const renderedPlan = JSON.parse((await prisma.v2ProjectSnapshot.findUniqueOrThrow({
      where: { id: renderedVersionRow.editPlanSnapshotId },
    })).contentJson)
    const renderedClips = renderedPlan.videoTracks.find((track) => track.kind === 'base-video').clips
    assert.ok(renderedClips.length >= 2, `the rendered cut has ${renderedClips.length} clip(s)`)
    assert.deepEqual(
      [...new Set(renderedClips.map((clip) => clip.audioSourceArtifactId ?? clip.sourceArtifactId))],
      [masterArtifactId],
      'every clip takes its sound from the master recorder, not from the camera it shows',
    )

    // ---- claim 2, again, over the CLIPS rather than the shots -------------
    // A shot is a decision; a clip is what the renderer was handed. The brief
    // asks that no CLIP lie outside measured coverage, so the frames the
    // renderer actually decoded are checked against the same bounds the worker
    // derived — including the master recorder's, which no shot ever names.
    // The recorder's own coverage has no published reader, and that is a
    // finding rather than an oversight here: the worker derived coverage for
    // all THREE tracks (`coverageDerived: 3`, asserted above), but
    // `GET .../sync` builds its listing from sync EVIDENCE records and the
    // reference track has none — there is nothing to synchronize it against.
    // So the camera bounds come from `/v1`, and the recorder's are read from
    // the projection the worker wrote. Read, not derived: the numbers are the
    // worker's, this only fetches them from where the API does not show them.
    const measuredCoverage = new Map()
    for (const [trackId, entry] of syncByTrack) {
      if (entry.coverage) measuredCoverage.set(trackId, [Number(entry.coverage.bounds.start), Number(entry.coverage.bounds.end), entry.coverage.gapTicks])
    }
    const masterCoverageRow = await prisma.v2CaptureTrackCoverage.findFirstOrThrow({
      where: { workspaceId, sessionId, trackId: masterTrackId },
    })
    measuredCoverage.set(masterTrackId, [
      Number(masterCoverageRow.boundsStart),
      Number(masterCoverageRow.boundsEnd),
      String(masterCoverageRow.gapTicks),
    ])

    const trackByArtifactId = new Map([
      [cameraArtifactIds.a, cameraTrackIds.a],
      [cameraArtifactIds.b, cameraTrackIds.b],
    ])
    const clipsOutsideCoverage = []
    for (const clip of renderedClips) {
      const trackId = trackByArtifactId.get(clip.sourceArtifactId)
      assert.ok(trackId, `clip ${clip.id} cuts ${clip.sourceArtifactId}, which is not one of the cameras`)
      for (const [label, boundedTrackId, from, to] of [
        ['picture', trackId, clip.sourceInFrame, clip.sourceOutFrame],
        ['sound', masterTrackId, clip.audioSourceInFrame ?? clip.sourceInFrame, clip.audioSourceOutFrame ?? clip.sourceOutFrame],
      ]) {
        const coverage = measuredCoverage.get(boundedTrackId)
        assert.ok(coverage, `${boundedTrackId} has measured coverage`)
        const [start, end, gapTicks] = coverage
        if (from < start || to > end || gapTicks !== '0') {
          clipsOutsideCoverage.push(`${clip.id}:${label}:${from}-${to} vs ${start}-${end} gaps=${gapTicks}`)
        }
      }
    }
    assert.deepEqual(
      clipsOutsideCoverage, [],
      'every rendered clip decodes frames the worker measured as covered',
    )

    // ---- the critic, on the bytes the render just wrote -------------------
    const reports = await helpers.callRouteOk(criticReportsRoute.GET, {
      path: `/v1/projects/${projectId}/color-critic-reports?projectVersionId=${encodeURIComponent(renderVersionId)}`,
      token,
      params: { projectId },
    }, [200])
    const report = reports.data.reports[0] ?? null
    assert.ok(report, 'the proxy render filed a colour critic report on the bytes it wrote')
    // The verdict is about THIS cut, corrected towards THIS reference, under
    // THIS plan — a report that named another version or another reference
    // camera would be a verdict on frames nobody rendered here.
    assert.equal(report.projectVersionId, renderVersionId)
    assert.equal(report.referenceCameraId, cameraTrackIds.a)
    assert.equal(report.matchPlanId, matchPlan.planId)
    assert.ok(COLOR_CRITIC_ACTIONS.includes(report.action), `unknown critic action ${report.action}`)
    assert.ok(COLOR_CRITIC_CAUSES.includes(report.cause), `unknown critic cause ${report.cause}`)
    assert.match(report.reportHash, /^[a-f0-9]{64}$/)
    // Everything above holds for a report that measured nothing at all: the
    // action and the cause are members of their enums whatever happened, and a
    // report with zero readable dimensions has confidence exactly 0 and is
    // still `human-review` / `evidence-unavailable`. These two are what say
    // frames were actually read.
    assert.ok(
      report.confidence > 0,
      `the critic reached a verdict with no measured dimension behind it (confidence ${report.confidence})`,
    )
    assert.ok(
      ['high', 'medium', 'low'].includes(report.confidenceBand),
      `unexpected confidence band ${report.confidenceBand}`,
    )
    // WHICH bytes were judged, from the verdict itself. `bytesEvaluated` is
    // read off the measurements — each one is bound to the file it decoded —
    // and is published only on the single-report read, so the summary above
    // could never have answered this.
    const reportDetail = await helpers.callRouteOk(criticReportRoute.GET, {
      path: `/v1/projects/${projectId}/color-critic-reports/${report.reportId}`,
      token,
      params: { projectId, reportId: report.reportId },
    }, [200])
    const judged = reportDetail.data.report
    assert.equal(judged.reportHash, report.reportHash, 'the listing and the report are the same verdict')
    const judgedBytes = new Map(judged.bytesEvaluated.map((bytes) => [bytes.artifactId, bytes.sha256]))
    assert.equal(
      judgedBytes.get(outputArtifactId),
      outputSha256,
      `the critic judged ${[...judgedBytes.keys()].join(', ')}, not the file this journey hashed off disk`,
    )
    const sectionOf = (stage) => judged.sections.find((section) => section.stage === stage)
    assert.deepEqual(
      sectionOf('after-output-transform').bytesEvaluated.map((bytes) => bytes.artifactId),
      [outputArtifactId],
      'the "after" side is the delivered file and nothing else',
    )
    // The "before" side names each camera's artifact, and its sha256 is NOT
    // that camera's rushes: the renderer's colour pre-pass writes a whole-file
    // intermediate per (source x pipeline) and throws it away with its scratch
    // directory, so the critic re-runs the same chain with the output stage
    // disabled and measures THAT. The artifact ids are what tie the reading
    // back to a camera; the hash is of the intermediate that was decoded.
    assert.deepEqual(
      sectionOf('before-output-transform').bytesEvaluated.map((bytes) => bytes.artifactId).sort(),
      CAMERAS.map((camera) => cameraArtifactIds[camera]).sort(),
      'the "before" side is both cameras',
    )
    for (const camera of CAMERAS) {
      assert.match(judgedBytes.get(cameraArtifactIds[camera]) ?? '', /^[a-f0-9]{64}$/)
      assert.notEqual(
        judgedBytes.get(cameraArtifactIds[camera]),
        outputSha256,
        `camera ${camera}'s "before" reading is not a second look at the delivered file`,
      )
    }
    // And that each camera was compared with ITSELF across the output
    // transform, which is what makes a "before" and an "after" one measurement.
    assert.deepEqual(
      judged.stagePairs.map((pair) => pair.cameraId).sort(),
      [cameraTrackIds.a, cameraTrackIds.b].sort(),
      'both cameras were paired across the output transform',
    )
    const measuredDimensions = judged.dimensions.filter((entry) => entry.status === 'measured')
    const unavailableDimensions = judged.dimensions.filter((entry) => entry.status === 'unavailable')
    assert.ok(measuredDimensions.length > 0, 'at least one dimension was read off the frames')
    for (const entry of unavailableDimensions) {
      assert.ok(entry.reason, `dimension ${entry.dimension} is unavailable without saying why`)
    }
    // The verdict and the detail have to agree about why: `evidence-unavailable`
    // is reached from issues classified `insufficient-evidence`, and here they
    // are the three cross-camera comparisons — a cut never shows two cameras at
    // the same instant, so no pair of readings describes the same moment.
    if (report.cause === 'evidence-unavailable') {
      assert.ok(
        judged.issues.some((issue) => issue.classification === 'insufficient-evidence'),
        'the verdict blames missing evidence and no issue says a dimension was unreadable',
      )
    }

    // The file itself, kept only when a run asks for it. `t.after` removes the
    // artifact root, so a CI run that wants to look at the MP4 afterwards has
    // to be handed a copy while it exists. Unset locally, so nothing piles up
    // on a laptop.
    const retentionRoot = process.env.APOLLO_PODCAST_MULTICAM_OUTPUT?.trim()
    let retainedPath = null
    if (retentionRoot) {
      await mkdir(retentionRoot, { recursive: true })
      retainedPath = join(retentionRoot, 'podcast-multicam-journey.mp4')
      await copyFile(outputPath, retainedPath)
      await writeFile(join(retentionRoot, 'manifest.json'), `${JSON.stringify({
        schemaVersion: 'podcast-multicam-journey-evidence/v1',
        renderedThrough: 'POST /v1/projects/{projectId}/proxy-renders + run-v2-render-worker-once.mjs',
        file: 'podcast-multicam-journey.mp4',
        sha256: outputSha256,
        byteSize: outputByteSize,
        width: Number(outputVideo.width),
        height: Number(outputVideo.height),
        videoCodec: outputVideo.codec_name,
        audioCodec: outputAudio.codec_name,
        durationInFrames: outputFrames,
        durationSeconds: Number(outputVideo.duration),
        plannedFrames: expectedFrames,
        measuredOffsetTicks: offsetTicks,
        appliedLagSeconds: CAMERA_LAG_SECONDS,
        sampledMeanRgb: sampled,
        sourceMeanRgb: sourceSampled,
        sampleSeconds,
        sourceSeconds,
        markerColumns,
        criticBytesEvaluated: judged.bytesEvaluated,
      }, null, 2)}\n`)
    }

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
      `E2E-F4.012 podcast 2 cameras (3 cards) + master: master=${Number(masterAudio.duration).toFixed(2)}s/${masterBytes.byteSize}B ` +
      `cameras=${CAMERAS.map((camera) => `${camera}:${cameraVideo[camera].nb_read_frames}f`).join('+')} ` +
      `offsets=${CAMERAS.map((camera) => `${camera}:${offsetTicks[camera]}ticks(${(offsetTicks[camera] / FPS).toFixed(2)}s applied ${CAMERA_LAG_SECONDS[camera]}s)`).join(' ')} ` +
      `diagnostic v${firstDiagnostic.data.diagnostic.version} autoEdit=${firstDiagnostic.data.diagnostic.autoEdit.allowed} ` +
      `anchored+regenerated v${diagnostic.version} autoEdit=${diagnostic.autoEdit.allowed} ` +
      `shots=${shots.length} follows=[${followed.join(' ')}] outsideCoverage=${outsideCoverage.length} ` +
      `aparte=${aparteMs}ms held=${aparteShotMs.toFixed(0)}ms shortestShot=${shortestShotMs.toFixed(0)}ms minimum=${minimumShotMs}ms ` +
      `cardTwo@${cardTwoSessionStartTick}ticks refused=${onCardTwo.length}x[${[...new Set(onCardTwo.flatMap((candidate) => candidate.rejectionReasons))].join('|')}] cardOne=${onCardOne.length} ` +
      `clips=${renderedClips.length} outsideClipCoverage=${clipsOutsideCoverage.length} audioBed=${masterArtifactId} ` +
      `renders=lut:${lutRenders.length}+plan:${preMatchRenders.length}+operator:${renderOutcomes.length} ` +
      `match=${matchPlan.cameraTransforms.map((entry) => `${entry.cameraId}:ev${entry.deltas.exposureEv === null ? 'null' : entry.deltas.exposureEv.toFixed(3)}`).join(',')} ` +
      `confidence=${matchPlan.confidence} humanReview=${matchPlan.humanReviewRequired} ` +
      `pipeline=${resolvedKinds.join('>')} compiled=${compilations.b.pipeline.stages.map((entry) => entry.kind).join('>')} ` +
      `render=${operation.data.operation.status} frames=${outputFrames}/${expectedFrames} duration=${Number(outputVideo.duration).toFixed(3)}s ` +
      `vcodec=${outputVideo.codec_name} acodec=${outputAudio.codec_name} bytes=${outputByteSize} sha256=${outputSha256.slice(0, 16)} ` +
      `pixels=${CAMERAS.map((camera) => `${camera}@${sampleSeconds[camera].toFixed(2)}s(r${sampled[camera].red.toFixed(0)},b${sampled[camera].blue.toFixed(0)})<-src@${sourceSeconds[camera].toFixed(2)}s(r${sourceSampled[camera].red.toFixed(0)},b${sourceSampled[camera].blue.toFixed(0)})marker${markerColumns[camera]}`).join(' ')} ` +
      `luma=a:${sourceLuma.a.toFixed(1)}>${deliveredLuma.a.toFixed(1)} b:${sourceLuma.b.toFixed(1)}>${deliveredLuma.b.toFixed(1)} gap=${sourceGap.toFixed(1)}>${deliveredGap.toFixed(1)} ` +
      `critic=${report.reportId}:${report.action}:${report.cause}:hard${report.hardIssues}/warn${report.warningIssues} ` +
      `criticConfidence=${report.confidence}(${report.confidenceBand}) measured=${measuredDimensions.length}/${judged.dimensions.length} judgedFiles=${judged.bytesEvaluated.length} ` +
      `protocolCeiling=${evaluation.data.evaluation.ceiling} unmet=${unmet.join('+')}` +
      `${retainedPath ? ` retained=${retainedPath}` : ''}`,
    )
    assert.deepEqual(unmet, ['end-marker', 'start-marker'], 'no marker was filmed, and only that is unmet')
    assert.equal(
      evaluation.data.evaluation.ceiling,
      'manual-anchors-required',
      'the missing markers cap the session, and the anchors confirmed above are what keep it off the floor',
    )
  },
)

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'
import { NextRequest } from 'next/server'

import {
  closeJourneyObjectStore,
  journeyStorageDriver,
  journeyStorageEnvironment,
  journeyStorageLabel,
  openJourneyObjectStore,
} from './helpers/journey-object-storage.mjs'
import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * Journey 4 (BRIEF-E2E §4) — the session that cannot be synchronized, and the
 * server that says so.
 *
 * This is the journey that proves the REFUSAL, so every assertion below is
 * about the refusal and its reasons; the recovery at the end exists only to
 * show that the refusal was a gate and not a wall.
 *
 * FOUR recordings, all generated here: a master audio recorder carrying a
 * distinct sweep every second, a camera in another room whose microphone heard
 * none of it (deterministic broadband noise), a second camera nobody pointed a
 * microphone at, which has no audio stream at all, and — the control — a
 * scratch recorder in the master's own room, which heard exactly the same
 * sweeps three seconds ahead of it. The first two are the two ways the audio
 * adapter reaches "nothing": a correlation that never clears the peak floor,
 * and a file with no audio to correlate. The fourth is the reason those two
 * are a VERDICT: the same worker, the same pass, the same adapter finds the
 * scratch recorder's offset and writes its clock map. Without it, "insufficient
 * for everything" and "this adapter never resolves anything" are the same
 * observation.
 *
 * What is asserted, in order:
 *
 * 1. **Nothing is auto-selected for the two cameras, and the recorder that DID
 *    share the room is aligned.** The real worker drains the run through
 *    `npm run worker:v2:capture-sync -- --once`, and for both cameras the
 *    stored evidence says `insufficient-evidence` with `selectedMethod: null`,
 *    `clockMap: null` and the reason the domain writes for a track no signal
 *    was observed on. The only row in `capture_clock_maps` belongs to the
 *    scratch recorder, and it carries the three-second offset the fixture
 *    built — measured, not declared. An offset of zero would have been the easy
 *    lie for the cameras, and it is not there.
 * 2. **The server demands a person.** The diagnostic derived through
 *    `POST /v1/.../sync-diagnostic` comes back `needs-input`, `manualRequired`,
 *    warning `insufficient-evidence`, and `recommendedActions` containing
 *    `add-manual-anchor` — one of the two remedies the published
 *    `RECOMMENDED_ACTIONS` vocabulary offers for this state. Its `autoEdit`
 *    gate is closed and names every reason.
 * 3. **The refusal is the server's.** `POST /v1/.../direction` answers 422
 *    `DIRECTION_RANGE_UNRESOLVABLE` and names the session ranges no angle was
 *    eligible for. It stays refused when the caller sends the most permissive
 *    policy the contract will accept — the gate is not a tunable — and the
 *    same call carrying `manualReviewRequired: false` is refused 422
 *    INVALID_ARGUMENT by validation rather than by policy — the direction body
 *    is a closed schema, so no caller-supplied verdict field is representable
 *    at all, and an invented field earns the identical refusal. No project
 *    version is created by any of it, and the stored direction that IS written
 *    names, per track, why every angle lost — including the aligned recorder,
 *    which loses as `not-a-video-source` and not for its sync.
 * 4. **After manual anchors posted through the API, the direction exists.**
 *    Three anchors for each of the three non-reference tracks through
 *    `POST /v1/.../sync-diagnostic/anchors` — the diagnostic reads markers and
 *    anchors, so even the track the audio cascade aligned by itself has nothing
 *    to give it — a second real worker pass that elects `manual-anchor` for the
 *    two cameras and writes their clock maps, a regenerated diagnostic that no
 *    longer warns, and the same direction request that was refused now returns
 *    201 with shots.
 *
 * The marker branch of "a marker or a manual anchor" is a stated omission: a
 * `reshoot-with-marker` recommendation is only derived when a capture protocol
 * evaluation caps the session at `not-synchronizable`
 * (`sync-diagnostic.ts:386-389`), and that ceiling then rejects EVERY angle
 * permanently (`multicam-direction.ts:962`), so a journey that took it could
 * not also show the recovery. What this suite proves about markers is narrower
 * and true: the published vocabulary carries the remedy, and the anchor path is
 * the one it exercises end to end.
 *
 * A second stated omission, of the same shape. This session carries no
 * active-speaker evidence at all — no diarization run is persisted for any of
 * its files, and the assertion below measures that rather than assuming it — so
 * the recovery at the end proves that an angle became ELIGIBLE, not that the
 * right angle was chosen. Angle choice from speaker evidence is covered by
 * `multicam-direction.e2e.mjs`, `multicam-direction-render.integration.mjs` and
 * `multicam-longform-gate.e2e.mjs`; nothing in this journey should be read as
 * evidence about it.
 *
 * The domain arrives through `await import` inside the test: tsx resolves a
 * static `.ts` specifier before it transforms the target and the file dies at
 * link time.
 */

const RUN = process.env.APOLLO_INSUFFICIENT_EVIDENCE_E2E === '1'
const SKIP = RUN ? false : 'set APOLLO_INSUFFICIENT_EVIDENCE_E2E=1 with a migrated V2_DATABASE_URL'
/**
 * Local disk or versioned MinIO, chosen by the runtime env the composition root
 * reads — never pinned in this file. This journey genuinely resolves artifact
 * bytes: the sync worker opens all four recordings to look for a signal, and
 * the whole point of the suite is that it finds none. A refusal reached because
 * the store was unreachable would be the same word for a different fact, which
 * is why the `s3` path is written to work rather than assumed equivalent.
 *
 * **No CI step exercises it.** An earlier version of this note said the s3 path
 * "is exercised", which was never true here: `grep -n
 * "npm run test:e2e:insufficient-evidence-journey" .github/workflows/ci.yml`
 * returns one line, 390, in the `quality` job, whose step sets no
 * APOLLO_V2_ARTIFACT_STORAGE_DRIVER. This journey proves PostgreSQL 16 only.
 * Writing the s3 path is capability; running it is coverage, and only the
 * podcast and phase gate journeys have it (spec 05 §34.4).
 */
const storageDriver = journeyStorageDriver()

const execFileAsync = promisify(execFile)
const FFMPEG = ffmpegStatic ?? 'ffmpeg'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))

const WORKSPACE = 'insufficient-evidence-workspace'
const PROJECT = 'insufficient-evidence-project'
const SESSION = 'insufficient-evidence-session'
const CLIENT = 'insufficient-evidence-client'
const VERSION = 'insufficient-evidence-version-1'

const MASTER_TRACK = 'track-master-audio'
const CAMERA_A_TRACK = 'track-camera-a'
const CAMERA_B_TRACK = 'track-camera-b'
/** The control: a second recorder in the master's room, started early. */
const SCRATCH_TRACK = 'track-scratch-audio'

const SAMPLE_RATE = 16_000
const TICKS_PER_SECOND = 90_000
const FPS = 30
const SESSION_SECONDS = 20
/** Where the operator places the three anchors, in seconds of session time. */
const ANCHOR_SECONDS = Object.freeze([2, 10, 18])
/**
 * The same three for the scratch recorder, pulled in so its own file still
 * holds them: session second 18 is source second 21 of a twenty-second file.
 */
const SCRATCH_ANCHOR_SECONDS = Object.freeze([2, 10, 16])
/**
 * How long before the master the scratch recorder was rolling.
 *
 * Not zero on purpose. A correlator that returns zero for everything would pass
 * a control built on an identical copy, and "the offset came out zero" is the
 * exact lie this whole journey exists to refuse elsewhere.
 */
const SCRATCH_LEAD_SECONDS = 3

const seconds = (value) => BigInt(Math.round(value * TICKS_PER_SECOND))
const at = (second) => new Date(Date.parse('2029-09-01T09:00:00.000Z') + second * 1_000)
const iso = (second) => at(second).toISOString()
const digest = (character) => character.repeat(64)

// ---------------------------------------------------------------------------
// The three recordings
// ---------------------------------------------------------------------------

/** Deterministic noise. `Math.random` would make every number below a guess. */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296 - 0.5
  }
}

/**
 * The recorder in room A: a distinct sweep every second.
 *
 * Distinct on purpose. A constant tone correlates equally against every second
 * of itself, so a fixture built on one could not tell "no match" from "matched
 * everywhere" — and this suite exists to assert the first.
 */
function masterSamples() {
  const samples = new Float64Array(SESSION_SECONDS * SAMPLE_RATE)
  for (let second = 0; second < SESSION_SECONDS; second += 1) {
    const start = 180 + 20 * ((second * 7) % SESSION_SECONDS)
    const span = second % 2 === 0 ? 150 : -150
    for (let sample = 0; sample < SAMPLE_RATE; sample += 1) {
      const t = sample / SAMPLE_RATE
      samples[second * SAMPLE_RATE + sample] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

/**
 * The scratch recorder in room A: the master's own sound, heard early.
 *
 * Its file starts `SCRATCH_LEAD_SECONDS` before the master's, so second `t` of
 * this file is second `t - 3` of the session, and the lead-in is room tone —
 * the recorder was already rolling while nothing had happened yet. That number
 * is what the cascade has to come back with.
 */
function scratchSamples(master) {
  const samples = new Float64Array(SESSION_SECONDS * SAMPLE_RATE)
  const noise = lcg(20_260_913)
  const lead = SCRATCH_LEAD_SECONDS * SAMPLE_RATE
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = index < lead ? 0.02 * noise() : (master[index - lead] ?? 0)
  }
  return samples
}

/** The camera in room B: broadband room tone that shares no event with room A. */
function roomToneSamples(seed) {
  const samples = new Float64Array(SESSION_SECONDS * SAMPLE_RATE)
  const noise = lcg(seed)
  for (let index = 0; index < samples.length; index += 1) samples[index] = 0.5 * noise()
  return samples
}

function toPcm(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), index * 2)
  }
  return buffer
}

async function identify(path) {
  const bytes = await readFile(path)
  const metadata = await stat(path)
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: metadata.size }
}

async function encodeAudioOnly(pcmPath, outputPath) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath,
    '-c:a', 'aac', '-b:a', '96k', '-ar', String(SAMPLE_RATE), '-ac', '1',
    outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  return identify(outputPath)
}

async function encodeCamera(input) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=${input.colour}:s=320x180:r=${FPS}:d=${SESSION_SECONDS}`,
    ...(input.pcmPath
      ? ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', input.pcmPath]
      : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    ...(input.pcmPath ? ['-c:a', 'aac', '-b:a', '96k', '-ar', String(SAMPLE_RATE), '-ac', '1'] : ['-an']),
    '-shortest', input.outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  return identify(input.outputPath)
}

// ---------------------------------------------------------------------------
// Routes, called the way Next calls them
// ---------------------------------------------------------------------------

async function callRoute(handler, url, options) {
  const request = new NextRequest(url, {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const response = await handler(request, { params: Promise.resolve(options.params) })
  return { status: response.status, payload: await response.json() }
}

test(
  'E2E-F4.012 a session with no usable sync evidence auto-selects nothing and the server says why',
  { skip: SKIP, timeout: 45 * 60_000 },
  async (t) => {
    assert.ok(process.env.V2_DATABASE_URL, 'this journey needs a migrated V2_DATABASE_URL')
    const databaseUrl = new URL(process.env.V2_DATABASE_URL)
    assert.ok(
      ['localhost', '127.0.0.1', '::1'].includes(databaseUrl.hostname),
      'this E2E is restricted to a disposable local PostgreSQL',
    )
    process.env.APOLLO_API_ENVIRONMENT = 'production'
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = storageDriver

    const root = await mkdtemp(join(tmpdir(), 'apollo-insufficient-evidence-'))
    const artifactRoot = join(root, 'artifacts')
    // What FFmpeg writes. In local mode these ARE the stored artifacts; in s3
    // mode they are the fixture this suite uploads, kept outside the artifact
    // root so an assertion can prove no key resolves to a local file and the
    // worker's four reads can only have come out of MinIO.
    const sourceRoot = storageDriver === 's3' ? join(root, 'sources') : artifactRoot
    const workRoot = join(root, 'work')
    for (const directory of [artifactRoot, sourceRoot, workRoot]) {
      await mkdir(directory, { recursive: true })
    }
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_RENDER_WORK_ROOT = workRoot
    const objectStore = await openJourneyObjectStore()

    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createCaptureSession } = await import('../../src/v2/domain/capture-session.ts')
    const { createTickInterval, rational, timebaseFromRate } = await import(
      '../../src/v2/domain/session-time.ts'
    )
    const { createSessionClock } = await import('../../src/v2/domain/session-clock.ts')
    const { RECOMMENDED_ACTIONS } = await import('../../src/v2/domain/sync-diagnostic.ts')
    const { createDesiredAction, createDesiredActionReference } = await import(
      '../../src/v2/domain/desired-action.ts'
    )
    const { createEditorialAudioTimelineHash } = await import('../../src/v2/domain/production-modes.ts')
    const { calculateVersionHash, stableSerialize } = await import(
      '../../src/v2/application/version-hash.ts'
    )
    const { PrismaApiClientRepository } = await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { disconnectV2PostgresClient } = await import(
      '../../src/v2/infrastructure/prisma-postgres/client.ts'
    )
    const syncRunsRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-runs/route.ts'
    )
    const syncRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync/route.ts'
    )
    const diagnosticRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/route.ts'
    )
    const anchorsRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/sync-diagnostic/anchors/route.ts'
    )
    const directionRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/direction/route.ts'
    )

    const client = new PrismaClient()
    // A project version names the Command that produced it and a Command names
    // the version it was based on, so neither table can be emptied while the
    // other still points at it. The two references are cleared first.
    const clean = async () => {
      await client.v2Project.updateMany({ where: { workspaceId: WORKSPACE }, data: { currentVersionId: null } })
      await client.v2ProjectVersion.updateMany({ where: { workspaceId: WORKSPACE }, data: { commandId: null } })
      for (const table of [
        client.v2MulticamAngleScoreComponent, client.v2MulticamAngleCandidate,
        client.v2MulticamShotAlternative, client.v2MulticamShotDecision,
        client.v2MulticamDirectionHead, client.v2MulticamDirection,
        client.v2MulticamObservation, client.v2MulticamEvidenceSet,
        client.v2SyncDiagnosticHead, client.v2SyncDiagnostic,
        client.v2CaptureClockMap, client.v2CaptureTrackCoverage,
        client.v2CaptureSessionClock, client.v2CaptureSyncEvidence,
        client.v2CaptureSyncRun,
        client.v2CaptureSessionVersion, client.v2CaptureSessionHead,
        client.v2CommandArtifactInvalidation, client.v2PublicEventOutbox,
        client.v2EditCommand, client.v2ProjectVersion,
        client.v2ProjectMediaAsset, client.v2ProjectSnapshot,
        client.v2MediaArtifactManifest, client.v2MediaArtifact,
        client.v2Project, client.v2ApiCredential, client.v2ApiClient,
      ]) {
        await table.deleteMany({ where: { workspaceId: WORKSPACE } })
      }
      await client.v2Workspace.deleteMany({ where: { id: WORKSPACE } })
    }

    t.after(async () => {
      // Reported rather than rethrown: a cleanup failure that masks the real
      // assertion turns one clear defect into two confusing ones.
      try {
        await clean()
      } catch (error) {
        console.error('cleanup failed:', error?.message ?? error)
      }
      await closeJourneyObjectStore(objectStore).catch((error) => {
        console.error('object storage cleanup failed:', error?.message ?? error)
      })
      await rm(root, { recursive: true, force: true }).catch((error) => {
        console.error('artifact root cleanup failed:', error?.message ?? error)
      })
      await client.$disconnect().catch(() => undefined)
      await disconnectV2PostgresClient().catch(() => undefined)
    })
    await clean()

    // ---- the four recordings ----------------------------------------------
    const captureDirectory = join(sourceRoot, 'capture')
    await mkdir(captureDirectory, { recursive: true })
    const master = masterSamples()
    await writeFile(join(captureDirectory, 'master.pcm'), toPcm(master))
    await writeFile(join(captureDirectory, 'camera-a.pcm'), toPcm(roomToneSamples(20_260_911)))
    await writeFile(join(captureDirectory, 'scratch.pcm'), toPcm(scratchSamples(master)))
    const masterFile = await encodeAudioOnly(
      join(captureDirectory, 'master.pcm'),
      join(captureDirectory, 'master.m4a'),
    )
    // The control, encoded exactly like the master so the only difference
    // between the two files is when the recorder was rolling.
    const scratchFile = await encodeAudioOnly(
      join(captureDirectory, 'scratch.pcm'),
      join(captureDirectory, 'scratch.m4a'),
    )
    const cameraAFile = await encodeCamera({
      colour: 'red',
      pcmPath: join(captureDirectory, 'camera-a.pcm'),
      outputPath: join(captureDirectory, 'camera-a.mp4'),
    })
    // No microphone at all on this one: `hasAudio === false` is the adapter's
    // other road to "nothing", and it must not become an offset of zero either.
    const cameraBFile = await encodeCamera({
      colour: 'blue',
      pcmPath: null,
      outputPath: join(captureDirectory, 'camera-b.mp4'),
    })

    // ---- the world the routes read ----------------------------------------
    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: WORKSPACE, slug: WORKSPACE, name: 'Insufficient evidence journey', status: 'active',
      createdAt: iso(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => at(0),
    })({
      id: CLIENT,
      workspaceId: WORKSPACE,
      name: 'Insufficient evidence journey',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const token = issued.token
    await client.v2Project.create({
      data: {
        id: PROJECT, workspaceId: WORKSPACE, name: 'Insufficient evidence journey',
        status: 'reviewing-proxy', objective: 'warming', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: CLIENT, createdAt: at(0), updatedAt: at(0),
      },
    })

    // Artifact id and capture asset id are the same string on purpose: the
    // compile step looks a probed cadence up by `track.sourceAssetId` against
    // the project's media links, which are keyed by artifact id
    // (`multicam-direction.ts:1195-1205`).
    const recordings = [
      { assetId: 'ie-asset-master', key: 'capture/master.m4a', file: masterFile, mediaType: 'audio', container: 'm4a', role: 'source-master' },
      { assetId: 'ie-asset-cam-a', key: 'capture/camera-a.mp4', file: cameraAFile, mediaType: 'video', container: 'mp4', role: 'selected-insert' },
      { assetId: 'ie-asset-cam-b', key: 'capture/camera-b.mp4', file: cameraBFile, mediaType: 'video', container: 'mp4', role: 'selected-insert' },
      { assetId: 'ie-asset-scratch', key: 'capture/scratch.m4a', file: scratchFile, mediaType: 'audio', container: 'm4a', role: 'selected-insert' },
    ]
    // In s3 mode the four recordings go into the run's own versioned bucket
    // under exactly these keys, and the artifact root is proven to hold none of
    // them: the sync worker resolves every part through
    // `S3ArtifactSourceMaterializer`, so a leftover local copy would let this
    // journey reach its refusal without object storage ever being read.
    if (objectStore) {
      for (const recording of recordings) {
        await objectStore.put(recording.key, join(sourceRoot, ...recording.key.split('/')))
      }
      assert.deepEqual(await objectStore.keys(), recordings.map(({ key }) => key).sort())
      for (const recording of recordings) {
        assert.equal(
          existsSync(join(artifactRoot, ...recording.key.split('/'))),
          false,
          `${recording.key} must not also sit in the artifact root while MinIO is the store of record`,
        )
      }
    }
    for (const recording of recordings) {
      await client.v2MediaArtifact.create({
        data: {
          id: recording.assetId, workspaceId: WORKSPACE, artifactKey: recording.key,
          sha256: recording.file.sha256, byteSize: BigInt(recording.file.byteSize),
          mediaType: recording.mediaType, container: recording.container,
          status: 'available', createdAt: at(0),
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: `manifest-${recording.assetId}`, workspaceId: WORKSPACE, artifactId: recording.assetId,
          schemaVersion: 'media-artifact-manifest/v1', manifestHash: digest('3'),
          recipeId: 'capture-ingest', recipeVersion: '1.0.0', parametersHash: digest('4'),
          manifestJson: JSON.stringify({
            artifact: { artifactKey: recording.key },
            probe: { duration: SESSION_SECONDS, fps: FPS, rFrameRate: `${FPS}/1` },
          }),
          createdAt: at(0),
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(), workspaceId: WORKSPACE, projectId: PROJECT,
          artifactId: recording.assetId, role: recording.role,
          originalFileName: recording.key.split('/')[1], createdAt: at(0),
        },
      })
    }

    // The Director EditPlan this direction re-cuts. A multicam direction does
    // not invent a timeline; without one the command answers PRECONDITION_REQUIRED.
    const desiredActionRef = createDesiredActionReference(createDesiredAction({ objective: 'warming' }))
    const baseClips = [{
      id: 'clip-base-0001', sourceArtifactId: 'ie-asset-cam-a',
      sourceInFrame: 0, sourceOutFrame: SESSION_SECONDS * FPS,
      timelineInFrame: 0, timelineOutFrame: SESSION_SECONDS * FPS, rate: 1,
    }]
    const basePlan = {
      schemaVersion: 2, state: 'compiled', id: `edit-plan-${VERSION}`, projectVersionId: VERSION,
      storyPlanId: 'story-insufficient', treatmentPlanId: 'treatment-insufficient',
      directorRunId: 'director-run-insufficient',
      fps: FPS, durationFrames: SESSION_SECONDS * FPS,
      sources: [{ id: 'ie-asset-cam-a', artifactId: 'ie-asset-cam-a', kind: 'video', durationSeconds: SESSION_SECONDS }],
      videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: baseClips }],
      overlayTracks: [], subtitleTracks: [], audioTracks: [], effectTracks: [], transitions: [],
      markers: [], protectedElements: [], localeVariantRefs: [], formatVariantRefs: [],
      lineageRefs: ['ie-asset-cam-a'],
      editorial: { commandType: 'source-ingest', exclusions: [], retainedSourceRanges: [] },
      retimedTranscript: { sourceTranscriptId: 'transcript-insufficient', words: [] },
      movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 },
      subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 42 },
      composition: {
        layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5,
        faceSafeFallback: [0.14, 0.08, 0.72, 0.56], subtitleSafeRegion: [0.08, 0.7, 0.84, 0.24],
      },
      director: { plannerVersion: 'journey-planner/v1', decisions: [], assumptions: [] },
      desiredActionRef,
      audioTimelineHash: createEditorialAudioTimelineHash({ fps: FPS, clips: baseClips }),
      createdAt: iso(0),
    }
    for (const [kind, content] of [['brief', { kind: 'brief' }], ['policies', { kind: 'policies' }]]) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `ie-snapshot-${kind}`, workspaceId: WORKSPACE, projectId: PROJECT, kind,
          schemaVersion: 1, contentJson: stableSerialize(content),
          contentHash: calculateVersionHash(content), createdAt: at(0),
        },
      })
    }
    await client.v2ProjectSnapshot.create({
      data: {
        id: 'ie-snapshot-edit-plan', workspaceId: WORKSPACE, projectId: PROJECT, kind: 'edit-plan',
        schemaVersion: 2, contentJson: stableSerialize(basePlan),
        contentHash: calculateVersionHash(basePlan), createdAt: at(0),
      },
    })
    const projectBaseHash = calculateVersionHash({
      projectId: PROJECT, sequence: 1, editPlanHash: calculateVersionHash(basePlan),
    })
    await client.v2ProjectVersion.create({
      data: {
        id: VERSION, workspaceId: WORKSPACE, projectId: PROJECT, sequence: 1,
        briefSnapshotId: 'ie-snapshot-brief',
        editPlanSnapshotId: 'ie-snapshot-edit-plan',
        policiesSnapshotId: 'ie-snapshot-policies',
        baseHash: projectBaseHash, createdBy: CLIENT, createdAt: at(0),
      },
    })
    await client.v2Project.update({ where: { id: PROJECT }, data: { currentVersionId: VERSION } })

    const timebase = timebaseFromRate(TICKS_PER_SECOND)
    const track = (input) => ({
      trackId: input.trackId,
      role: input.role,
      device: {
        deviceId: input.deviceId, recorderId: `recorder-${input.deviceId}`,
        make: null, model: null, serial: null,
      },
      sourceAssetId: input.assetId,
      timebase,
      streamIndex: 0,
      syncAudioPolicy: input.syncAudioPolicy,
      includeInFinalMix: input.includeInFinalMix,
      parts: [{
        partId: `part-${input.trackId}`,
        ordinal: 0,
        sourceAssetId: input.assetId,
        timebase,
        coverage: createTickInterval(BigInt(0), seconds(SESSION_SECONDS)),
        streamIndex: 0,
        splitReason: 'single-file',
        evidence: {
          ingestArtifactId: input.assetId,
          ingestSha256: input.sha256,
          probeHash: digest('b'),
          probeSource: 'packet-scan',
          observedAt: iso(1),
        },
      }],
    })
    const session = createCaptureSession({
      workspaceId: WORKSPACE,
      projectId: PROJECT,
      sessionId: SESSION,
      clock: { timebase, rounding: 'nearest-half-even' },
      referenceTrackId: MASTER_TRACK,
      tracks: [
        track({
          trackId: MASTER_TRACK, role: 'master-audio', deviceId: 'dev-recorder',
          assetId: 'ie-asset-master', sha256: masterFile.sha256,
          syncAudioPolicy: 'final-candidate', includeInFinalMix: true,
        }),
        track({
          trackId: CAMERA_A_TRACK, role: 'camera-main', deviceId: 'dev-a',
          assetId: 'ie-asset-cam-a', sha256: cameraAFile.sha256,
          syncAudioPolicy: 'sync-only', includeInFinalMix: false,
        }),
        track({
          trackId: CAMERA_B_TRACK, role: 'camera-alt', deviceId: 'dev-b',
          assetId: 'ie-asset-cam-b', sha256: cameraBFile.sha256,
          syncAudioPolicy: 'none', includeInFinalMix: false,
        }),
        // The control. `scratch-audio` is never a video angle
        // (`multicam-direction.ts:150`), so aligning it cannot rescue the
        // direction — which is what makes it safe to put in the same session as
        // the refusal it is a control for.
        track({
          trackId: SCRATCH_TRACK, role: 'scratch-audio', deviceId: 'dev-scratch',
          assetId: 'ie-asset-scratch', sha256: scratchFile.sha256,
          syncAudioPolicy: 'sync-only', includeInFinalMix: false,
        }),
      ],
      lineage: {
        commandId: 'command-create-session', operation: 'create-session',
        actorKind: 'api-client', actorId: CLIENT, occurredAt: iso(1), note: null,
      },
      createdAt: iso(1),
    })
    const sessions = new PrismaCaptureSessionRepository(client)
    await sessions.appendVersion({ session, occurredAt: iso(1) })
    // The clock ingest establishes. Session ticks are 90 kHz — a resolution
    // finer than a frame — so the frame rate is not derivable from the timebase
    // and the worker refuses to guess one; without this row it settles the run
    // as failed rather than inventing 30000/1001.
    await sessions.persistClock({
      workspaceId: WORKSPACE,
      clock: createSessionClock({
        sessionId: SESSION,
        timebase,
        frameRate: rational(BigInt(FPS), BigInt(1)),
        authority: {
          origin: 'master-audio',
          sourceId: 'ie-asset-master',
          provenance: 'original-capture',
          evidenceRef: 'probe-ie-asset-master',
        },
        establishedAt: iso(1),
      }),
      createdAt: iso(1),
    })

    const basePath = `http://localhost/v1/projects/${PROJECT}/capture-sessions/${SESSION}`
    const params = { projectId: PROJECT, sessionId: SESSION }
    const sessionBase = {
      baseVersionId: `${SESSION}:v${session.version}`,
      baseHash: session.sessionHash,
    }

    /**
     * The worker, through the npm SCRIPT and not the file.
     *
     * Spawning the file directly is how two Wave 19 suites shipped with a
     * broken script definition nobody noticed. Here a typo in package.json
     * fails this test.
     */
    const runWorkerOnce = () => new Promise((resolve, reject) => {
      const child = spawn(
        process.platform === 'win32' ? 'npm.cmd' : 'npm',
        ['run', '--silent', 'worker:v2:capture-sync', '--', '--once'],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...process.env,
            // The same store this process opened, not a second one: a worker
            // left on the local driver would look for a signal on a disk the
            // parent never wrote to, and answer the refusal for a wrong reason.
            ...journeyStorageEnvironment({ driver: storageDriver, artifactRoot, workRoot }),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: process.platform === 'win32',
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })
    const outcomeOf = (result) => JSON.parse(
      result.stdout.split('APOLLO_CAPTURE_SYNC_OUTCOME=')[1]?.split('\n')[0] ?? '{}',
    )

    // =====================================================================
    // 1. Nothing is auto-selected
    // =====================================================================
    const queued = await callRoute(syncRunsRoute.POST, `${basePath}/sync-runs`, {
      method: 'POST', token, params, body: sessionBase, idempotencyKey: 'ie-sync-first',
    })
    assert.equal(queued.status, 202, JSON.stringify(queued.payload))
    assert.equal(queued.payload.data.run.state, 'queued')

    const firstPass = await runWorkerOnce()
    const firstOutcome = outcomeOf(firstPass)
    assert.equal(
      firstPass.code,
      0,
      `worker exited ${firstPass.code}: ${JSON.stringify(firstOutcome)} ${firstPass.stderr}`,
    )
    assert.equal(firstOutcome.settled, true, JSON.stringify(firstOutcome))
    assert.equal(firstOutcome.status, 'succeeded', firstOutcome.failureReason ?? '')
    // The run SUCCEEDED and the answer was "we could not tell". Those are not
    // the same thing, and collapsing them would lose the reference recorder's
    // perfectly good material along with the answer.
    assert.equal(firstOutcome.insufficient, 2, JSON.stringify(firstOutcome))
    // The control, in the SAME pass through the SAME adapter: one track did
    // resolve. `insufficient: 2` beside `resolved: 0` is equally consistent with
    // an adapter that resolves nothing at all, and that reading is what this
    // number closes off.
    assert.equal(firstOutcome.resolved, 1, JSON.stringify(firstOutcome))
    assert.equal(firstOutcome.review, 0, JSON.stringify(firstOutcome))

    const beforeSync = await callRoute(syncRoute.GET, `${basePath}/sync`, {
      method: 'GET', token, params,
    })
    assert.equal(beforeSync.status, 200, JSON.stringify(beforeSync.payload))
    const beforeTracks = beforeSync.payload.data.tracks
    assert.equal(beforeTracks.length, 3, 'one verdict per non-reference track')
    const beforeByTrack = new Map(beforeTracks.map((entry) => [entry.trackId, entry]))
    for (const trackId of [CAMERA_A_TRACK, CAMERA_B_TRACK]) {
      const entry = beforeByTrack.get(trackId)
      assert.ok(entry, `no verdict at all for ${trackId}`)
      assert.equal(entry.outcome, 'insufficient-evidence', `${entry.trackId}: ${entry.outcome}`)
      assert.equal(entry.selectedMethod, null, `${entry.trackId} elected a method anyway`)
      assert.equal(entry.map, null, `${entry.trackId} was given a clock map anyway`)
      assert.equal(entry.manualRequired, true)
      // The REASON, not its length. This is the one the domain writes when the
      // cascade had nothing to admit (`sync-evidence.ts:922-925`); the other
      // string there — "every observed signal failed admission" — is a
      // different verdict about a different world, and a suite that accepted
      // either could not tell the two apart.
      assert.deepEqual(
        entry.outcomeReasons,
        ['no synchronization signal was observed for this track'],
        `${entry.trackId} refused for a reason this journey does not claim: ${entry.outcomeReasons.join(' | ')}`,
      )
      // Coverage was still measured: "we could not align it" is not "we did not
      // look at it", and an operator needs the second fact to keep the footage.
      assert.notEqual(entry.coverage, null, `${entry.trackId} lost its coverage with its offset`)
    }

    // The control's verdict, and the number that proves the bytes were read.
    const scratchVerdict = beforeByTrack.get(SCRATCH_TRACK)
    assert.ok(scratchVerdict, 'the scratch recorder got no verdict at all')
    assert.equal(scratchVerdict.outcome, 'auto-apply', JSON.stringify(scratchVerdict.outcomeReasons))
    assert.equal(scratchVerdict.selectedMethod, 'audio-fingerprint')
    assert.equal(scratchVerdict.manualRequired, false)
    assert.notEqual(scratchVerdict.map, null, 'the resolved track was given no clock map')
    const scratchOffsetSeconds =
      Number(BigInt(scratchVerdict.map.pieces[0].offsetTicks)) / TICKS_PER_SECOND
    // MEASURED against the fixture's own lead, within a frame: the recorder
    // rolled three seconds early, so session time is its source time minus
    // three. A cascade that answered zero — the failure this whole journey is
    // about — fails here rather than in a comment.
    const scratchOffsetErrorFrames =
      Math.abs(Math.abs(scratchOffsetSeconds) - SCRATCH_LEAD_SECONDS) * FPS
    assert.ok(
      scratchOffsetErrorFrames <= 1,
      `the scratch recorder came back at ${scratchOffsetSeconds.toFixed(3)}s against a built-in ` +
      `${SCRATCH_LEAD_SECONDS}s lead (${scratchOffsetErrorFrames.toFixed(2)} frames out)`,
    )

    const clockMapSources = (await client.v2CaptureClockMap.findMany({
      where: { workspaceId: WORKSPACE }, select: { sourceId: true },
    })).map((row) => row.sourceId).sort()
    assert.deepEqual(
      clockMapSources,
      ['ie-asset-scratch'],
      'a clock map was written for a track nothing could align, or withheld from the one that aligned',
    )

    // =====================================================================
    // 2. The server demands a person
    // =====================================================================
    const firstDiagnostic = await callRoute(diagnosticRoute.POST, `${basePath}/sync-diagnostic`, {
      method: 'POST', token, params, body: sessionBase,
    })
    assert.equal(firstDiagnostic.status, 201, JSON.stringify(firstDiagnostic.payload))
    const blocked = firstDiagnostic.payload.data.diagnostic
    assert.equal(blocked.status, 'needs-input')
    assert.equal(blocked.manualRequired, true)
    assert.ok(blocked.warnings.includes('insufficient-evidence'), JSON.stringify(blocked.warnings))
    assert.ok(
      blocked.recommendedActions.includes('add-manual-anchor'),
      `the diagnostic asked for ${blocked.recommendedActions.join(', ')}`,
    )
    // The other remedy for this state exists in the published vocabulary; the
    // header states why this journey does not take it.
    assert.ok(RECOMMENDED_ACTIONS.includes('reshoot-with-marker'))
    assert.equal(blocked.autoEdit.allowed, false)
    assert.ok(
      blocked.autoEdit.blockedBy.some((reason) => reason.includes('no usable evidence')),
      `the gate closed without naming the evidence: ${blocked.autoEdit.blockedBy.join(' | ')}`,
    )
    assert.equal(blocked.globalConfidence, 0)

    // =====================================================================
    // 3. The refusal is the server's, and it names its reason
    // =====================================================================
    const directionBody = {
      baseVersionId: VERSION,
      baseHash: projectBaseHash,
      format: { aspectRatio: '16:9' },
      range: {
        sessionStartTicks: seconds(1).toString(),
        sessionEndTicks: seconds(SESSION_SECONDS - 1).toString(),
      },
    }
    const refused = await callRoute(directionRoute.POST, `${basePath}/direction`, {
      method: 'POST', token, params, body: directionBody, idempotencyKey: 'ie-direction-blocked',
    })
    assert.equal(refused.status, 422, JSON.stringify(refused.payload))
    assert.equal(refused.payload.error.code, 'DIRECTION_RANGE_UNRESOLVABLE')
    // A policy refusal, not a validation one: the request was well formed and
    // the world was not ready. `retryable: false` says retrying the same call
    // will fail the same way, which is what sends an operator to the anchors.
    assert.equal(refused.payload.error.category, 'policy')
    assert.equal(refused.payload.error.retryable, false)
    assert.ok(refused.payload.error.requestId.length > 0)
    // MEASURED, not assumed: the envelope carries the code, the catalog message
    // and the request id, and NOTHING else. `presentPublicDomainError` forwards
    // `details` only for `AUTH_SCOPE_REQUIRED` and the stale-pair codes
    // (`error-presenter.ts:123-133`), so the uncovered ranges the domain error
    // carries do not cross the boundary. Which ranges they were is answered by
    // the stored direction below, through `GET /v1/.../direction`.
    assert.deepEqual(
      Object.keys(refused.payload.error).sort(),
      ['category', 'code', 'message', 'requestId', 'retryable'],
    )

    // The gate is not a tunable. The five numbers the contract lets an operator
    // move are shot-length and redundancy preferences; none of them is the sync
    // gate, and the most permissive legal set is refused identically.
    const bribed = await callRoute(directionRoute.POST, `${basePath}/direction`, {
      method: 'POST',
      token,
      params,
      idempotencyKey: 'ie-direction-permissive',
      body: {
        ...directionBody,
        // `jumpCutSameAngleMs` may not sit below `minimumShotMs`, so the most
        // permissive legal set pins the two together at the floor.
        policy: { minimumShotMs: 200, maxCutawayMs: 600_000, jumpCutSameAngleMs: 200, redundancyThreshold: 0, ambiguityMargin: 0 },
      },
    })
    assert.equal(bribed.status, 422, JSON.stringify(bribed.payload))
    assert.equal(bribed.payload.error.code, 'DIRECTION_RANGE_UNRESOLVABLE')

    // And the caller cannot declare the verdict instead of earning it — though
    // what is proved here is narrower than "the server defends
    // `manualReviewRequired` by name". The direction body is a CLOSED schema
    // (`multicam-direction-contract.ts:397-401` lists its six fields), so no
    // caller-supplied verdict field is representable at all: this is refused
    // 422 INVALID_ARGUMENT by validation before the command runs, where the
    // refusal above is 422 DIRECTION_RANGE_UNRESOLVABLE by policy after it. The
    // distinction the assertions make is code and category, not status — and
    // the control below shows the refusal is the schema and not this field's
    // name, which is exactly why the envelope does not repeat it.
    const declared = await callRoute(directionRoute.POST, `${basePath}/direction`, {
      method: 'POST',
      token,
      params,
      idempotencyKey: 'ie-direction-declared',
      body: { ...directionBody, manualReviewRequired: false },
    })
    assert.equal(declared.status, 422, JSON.stringify(declared.payload))
    assert.equal(declared.payload.error.code, 'INVALID_ARGUMENT')
    assert.equal(declared.payload.error.category, 'validation')
    assert.notEqual(declared.payload.error.code, refused.payload.error.code)
    assert.notEqual(declared.payload.error.category, refused.payload.error.category)
    const invented = await callRoute(directionRoute.POST, `${basePath}/direction`, {
      method: 'POST',
      token,
      params,
      idempotencyKey: 'ie-direction-invented',
      body: { ...directionBody, shotCount: 99 },
    })
    assert.equal(invented.status, declared.status, JSON.stringify(invented.payload))
    assert.equal(invented.payload.error.code, declared.payload.error.code)

    // Nothing was half-committed by any of the four.
    assert.equal(
      await client.v2ProjectVersion.count({ where: { workspaceId: WORKSPACE } }),
      1,
      'a refused direction created a project version',
    )
    assert.equal(await client.v2EditCommand.count({ where: { workspaceId: WORKSPACE } }), 0)

    // The direction the refusal was computed from IS stored and readable: it is
    // the artifact an operator opens to find out which angle lost and why.
    const storedDirection = await callRoute(directionRoute.GET, `${basePath}/direction`, {
      method: 'GET', token, params,
    })
    assert.equal(storedDirection.status, 200, JSON.stringify(storedDirection.payload))
    const refusedDirection = storedDirection.payload.data.direction
    assert.equal(refusedDirection.shotCount, 0, 'an angle was selected after all')
    assert.ok(refusedDirection.uncovered.length > 0)
    // The whole directed range, not a fragment of it: nothing was eligible
    // anywhere, and the stored ranges are the ones the request asked for.
    assert.equal(refusedDirection.uncovered[0].start, directionBody.range.sessionStartTicks)
    assert.equal(
      refusedDirection.uncovered[refusedDirection.uncovered.length - 1].end,
      directionBody.range.sessionEndTicks,
    )
    assert.equal(refusedDirection.manualReviewRequired, true)
    const noAngle = refusedDirection.warnings.filter((warning) => warning.code === 'no-eligible-candidate')
    assert.ok(noAngle.length > 0, JSON.stringify(refusedDirection.warnings))
    for (const trackId of [CAMERA_A_TRACK, CAMERA_B_TRACK]) {
      assert.ok(
        noAngle.some((warning) => warning.detail.includes(trackId)),
        `no stored warning explains why ${trackId} was not cut to`,
      )
    }
    assert.ok(
      noAngle.some((warning) => warning.detail.includes('sync-map-missing')
        || warning.detail.includes('sync-below-threshold')),
      `the stored reasons never mention the sync: ${noAngle[0].detail}`,
    )
    // The control lost for a DIFFERENT reason, and the stored record says which.
    // An audio recorder is not a video angle (`multicam-direction.ts:150`), so
    // aligning one cannot rescue a direction: it is rejected as
    // `not-a-video-source` where the cameras are rejected for their sync. If
    // those two ever collapsed into one sentence, an operator reading this
    // record would go looking for the wrong remedy.
    const scratchRejection = noAngle.find((warning) => warning.detail.includes(`${SCRATCH_TRACK}[`))
    assert.ok(
      scratchRejection,
      `the stored record never says why the scratch recorder was not cut to: ${noAngle.map((warning) => warning.detail).join(' | ')}`,
    )
    assert.ok(
      scratchRejection.detail.includes(`${SCRATCH_TRACK}[not-a-video-source`),
      `the aligned audio recorder was weighed as an angle: ${scratchRejection.detail}`,
    )

    // =====================================================================
    // 4. After a manual anchor through the API, the direction exists
    // =====================================================================
    //
    // Every non-reference track gets anchors, not just the two cameras: the
    // diagnostic is derived from markers and manual anchors, this session was
    // shot without markers, and so a track the AUDIO cascade aligned on its own
    // still has nothing for the diagnostic to read. The scratch recorder's
    // clapper sits three seconds further into ITS file, and its anchors say so
    // — an anchor typed in session time would contradict the offset the
    // correlator measured, and the cascade would refuse the contradicting pair
    // rather than average them.
    let diagnosticVersion = blocked.version
    let diagnosticHash = blocked.diagnosticHash
    let anchorsPlaced = 0
    const anchorPlan = [
      { trackId: CAMERA_A_TRACK, leadSeconds: 0, atSeconds: ANCHOR_SECONDS },
      { trackId: CAMERA_B_TRACK, leadSeconds: 0, atSeconds: ANCHOR_SECONDS },
      { trackId: SCRATCH_TRACK, leadSeconds: SCRATCH_LEAD_SECONDS, atSeconds: SCRATCH_ANCHOR_SECONDS },
    ]
    for (const plan of anchorPlan) {
      for (const second of plan.atSeconds) {
        const placed = await callRoute(anchorsRoute.POST, `${basePath}/sync-diagnostic/anchors`, {
          method: 'POST',
          token,
          params,
          body: {
            baseVersionId: `${SESSION}:diagnostic:v${diagnosticVersion}`,
            baseHash: diagnosticHash,
            trackId: plan.trackId,
            action: 'add',
            anchorId: `ie-anchor-${plan.trackId}-${second}`,
            sourceMs: (second + plan.leadSeconds) * 1_000,
            sessionMs: second * 1_000,
            evidenceRef: `operator-read-the-clapper-at-${second}s`,
          },
        })
        assert.equal(placed.status, 201, JSON.stringify(placed.payload))
        diagnosticVersion = placed.payload.data.diagnostic.version
        diagnosticHash = placed.payload.data.diagnostic.diagnosticHash
        anchorsPlaced += 1
      }
    }
    assert.equal(anchorsPlaced, 9)

    // The second pass now has something to elect. The anchors are read from the
    // diagnostic head by the signal source — the operator's word became a
    // signal, it did not bypass the cascade.
    const requeued = await callRoute(syncRunsRoute.POST, `${basePath}/sync-runs`, {
      method: 'POST', token, params, body: sessionBase, idempotencyKey: 'ie-sync-after-anchors',
    })
    assert.equal(requeued.status, 202, JSON.stringify(requeued.payload))
    const secondPass = await runWorkerOnce()
    const secondOutcome = outcomeOf(secondPass)
    assert.equal(
      secondPass.code,
      0,
      `worker exited ${secondPass.code}: ${JSON.stringify(secondOutcome)} ${secondPass.stderr}`,
    )
    assert.equal(secondOutcome.status, 'succeeded', secondOutcome.failureReason ?? '')
    assert.equal(secondOutcome.insufficient, 0, JSON.stringify(secondOutcome))

    const afterSync = await callRoute(syncRoute.GET, `${basePath}/sync`, {
      method: 'GET', token, params,
    })
    assert.equal(afterSync.status, 200, JSON.stringify(afterSync.payload))
    const afterTracks = afterSync.payload.data.tracks
    const afterByTrack = new Map(afterTracks.map((entry) => [entry.trackId, entry]))
    for (const trackId of [CAMERA_A_TRACK, CAMERA_B_TRACK]) {
      const entry = afterByTrack.get(trackId)
      assert.equal(entry.selectedMethod, 'manual-anchor', `${entry.trackId}: ${entry.selectedMethod}`)
      assert.notEqual(entry.map, null, `${entry.trackId} still has no clock map`)
    }
    // The control kept its map through all of it. Which method now carries it is
    // the cascade's precedence to decide, and this journey does not legislate
    // that; what it asserts is that the track the correlator aligned before any
    // anchor existed was not left behind by the recovery.
    assert.notEqual(afterByTrack.get(SCRATCH_TRACK).map, null, 'the control lost its clock map')
    assert.notEqual(afterByTrack.get(SCRATCH_TRACK).selectedMethod, null, 'the control lost its method')

    // Regenerated, so the diagnostic is derived from the anchors that now exist
    // rather than refitted around the warning it was born with.
    const regenerated = await callRoute(diagnosticRoute.POST, `${basePath}/sync-diagnostic`, {
      method: 'POST', token, params, body: sessionBase,
    })
    assert.equal(regenerated.status, 201, JSON.stringify(regenerated.payload))
    const cleared = regenerated.payload.data.diagnostic
    assert.equal(
      cleared.warnings.includes('insufficient-evidence'),
      false,
      `the diagnostic still says ${cleared.warnings.join(', ')}`,
    )
    assert.equal(cleared.autoEdit.allowed, true, cleared.autoEdit.blockedBy.join(' | '))
    for (const entry of cleared.tracks) {
      assert.equal(entry.manualAnchors.length, ANCHOR_SECONDS.length, `${entry.trackId} lost anchors`)
      // The actor is recorded, never displaced by the caller's own note.
      assert.ok(
        entry.manualAnchors.every((anchor) => anchor.evidenceRef.startsWith(`operator:${CLIENT} `)),
        `an anchor's evidence ref does not name who placed it: ${entry.manualAnchors[0].evidenceRef}`,
      )
    }

    const directed = await callRoute(directionRoute.POST, `${basePath}/direction`, {
      method: 'POST', token, params, body: directionBody, idempotencyKey: 'ie-direction-after-anchor',
    })
    assert.equal(directed.status, 201, JSON.stringify(directed.payload))
    const cut = directed.payload.data.directed
    assert.ok(cut.direction.shotCount > 0, 'the direction still selected nothing')
    assert.equal(cut.direction.uncovered.length, 0, JSON.stringify(cut.direction.uncovered))
    // The stated omission, MEASURED rather than assumed: this session carries no
    // active-speaker evidence at all — no diarization run is persisted for any
    // of its files — so what the shot above proves is that an angle became
    // ELIGIBLE. Which angle wins against a competitor is decided by evidence
    // that is not here, and is covered by the suites the header names.
    assert.equal(
      await client.v2MulticamObservation.count({
        where: { workspaceId: WORKSPACE, kind: 'active-speaker' },
      }),
      0,
      'this journey has speaker evidence after all, so the header must stop disclaiming angle choice',
    )
    assert.equal(
      await client.v2ProjectVersion.count({ where: { workspaceId: WORKSPACE } }),
      2,
      'the accepted direction did not advance the project',
    )

    console.log(
      `E2E-F4.012 insufficient evidence: master ${masterFile.byteSize} bytes of sweeps vs ` +
      `camera-a ${cameraAFile.byteSize} bytes of room tone and camera-b ${cameraBFile.byteSize} bytes with no audio, ` +
      `plus a ${scratchFile.byteSize}-byte scratch recorder holding the master's sweeps ${SCRATCH_LEAD_SECONDS}s early; ` +
      `pass 1 status=${firstOutcome.status} insufficient=${firstOutcome.insufficient} resolved=${firstOutcome.resolved} ` +
      `review=${firstOutcome.review} clockMaps=[${clockMapSources.join(',')}] ` +
      `control offset ${scratchOffsetSeconds.toFixed(3)}s vs built-in ${SCRATCH_LEAD_SECONDS}s ` +
      `(erro ${scratchOffsetErrorFrames.toFixed(2)} frames) via ${scratchVerdict.selectedMethod}; ` +
      `selectedMethod=[${beforeTracks.map((entry) => String(entry.selectedMethod)).join(',')}]; ` +
      `diagnostic v${blocked.version} status=${blocked.status} confidence=${blocked.globalConfidence} ` +
      `warnings=[${blocked.warnings.join(',')}] actions=[${blocked.recommendedActions.join(',')}] ` +
      `autoEdit=${blocked.autoEdit.allowed} blockedBy=${blocked.autoEdit.blockedBy.length}; ` +
      `direction refused ${refused.status}/${refused.payload.error.code} (${refused.payload.error.category}, ` +
      `retryable=${refused.payload.error.retryable}), permissive policy ${bribed.status}/${bribed.payload.error.code}, ` +
      `declared verdict ${declared.status}/${declared.payload.error.code} ` +
      `(any unknown field: ${invented.status}/${invented.payload.error.code}); ` +
      `stored direction shots=${refusedDirection.shotCount} ` +
      `uncovered=${refusedDirection.uncovered.length} warnings=${refusedDirection.warnings.length}; ` +
      `${anchorsPlaced} anchors over ${anchorPlan.length} tracks -> pass 2 insufficient=${secondOutcome.insufficient} ` +
      `method=[${afterTracks.map((entry) => entry.selectedMethod).join(',')}] ` +
      `diagnostic v${cleared.version} status=${cleared.status} confidence=${cleared.globalConfidence} ` +
      `autoEdit=${cleared.autoEdit.allowed}; direction ${directed.status} shots=${cut.direction.shotCount} uncovered=0; ` +
      `${journeyStorageLabel(storageDriver)}`,
    )
  },
)

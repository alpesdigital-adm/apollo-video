import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'
import { NextRequest } from 'next/server'

import {
  closeJourneyObjectStore,
  journeyStorageDriver,
  openJourneyObjectStore,
} from './helpers/journey-object-storage.mjs'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * Journey 3 (BRIEF-E2E §3) — a real reaction, a real reference, and the whole
 * react edit driven through the published `/v1` routes.
 *
 * Everything upstream of this file proves a piece of it and none of them prove
 * the product:
 *
 * - `playback-map-fingerprint.integration.mjs` builds the two recordings with
 *   FFmpeg and calls `buildPlaybackMap` directly. It never touches a route, a
 *   repository or a database, and it never renders anything.
 * - `playback-map.e2e.mjs` runs the services against PostgreSQL, but resolves
 *   media through a fake whose `resolve()` returns `/fixtures/<asset>.mp4` and
 *   whose observations are the fixture's, so no codec runs and no MP4 exists.
 * - `wave20-persistence-journey.e2e.mjs` round-trips the aggregate against the
 *   schema with an in-memory client.
 *
 * So this is the first thing in the lane where an operator's actual sequence
 * happens: two files are encoded, ingested as artifacts, named by a capture
 * session, and then `POST /v1/…/playback-map` measures them with the FFmpeg
 * fingerprinter through `CaptureMediaResolver` — which verifies the bytes
 * against the artifact's recorded sha256 before a detector may open them. The
 * map is read back through `GET /v1/…/playback-map` and
 * `GET /v1/…/playback-map/pieces`, the stretch the audio could not answer is
 * resolved through `POST /v1/…/playback-map/anchors`, and only then is the plan
 * compiled and RENDERED, with ffprobe reading the delivered file back.
 *
 * What the journey asserts, in the order it happens:
 *
 * 1. The reaction is not the reference. Both durations are measured by ffprobe
 *    and the reaction is twice the reference — the assumption ADR-135 exists to
 *    refuse, and the one a compiler reading the duration off the wrong file
 *    would break silently.
 * 2. The identity gate the resolver fails closed on is exercised NEGATIVELY,
 *    before the happy path: with the registry row's sha256 edited underneath
 *    the session, the same `POST` is refused 409
 *    `MEDIA_ARTIFACT_IDENTITY_MISMATCH` and writes no map. Without that call
 *    the gate could be deleted whole with this suite still green.
 * 3. The map the server derived carries play, a pause of a KNOWN length, a
 *    commentary stretch with no reference range at all, a rewind and a seek —
 *    each read out of the `/v1` payload, not out of the domain object.
 * 4. The person's anchor names ONE reference instant, and the stretch that was
 *    uncovered comes back covered AT THAT INSTANT — not merely `resolved`. An
 *    anchor read off a different frame used to shift the whole resolved piece,
 *    and a status flip cannot tell the two apart.
 * 5. The compiled plan renders, and the MP4 is checked as FOOTAGE and not only
 *    as a container: the reaction's own audio is cross-correlated against the
 *    delivered track at three timeline instants (a plan that cut the right
 *    lengths from the wrong moments moves the best lag off zero), frames
 *    sampled inside a paused stretch and inside a playing stretch are the two
 *    different sources they have to be, and a silent track fails the loudness
 *    floor.
 *
 * TWO hops here are NOT published capabilities. Both are named rather than
 * left for a reader to discover:
 *
 * - **Compile.** The registry has `playback-map.build/read/pieces.list/anchors.add`
 *   and nothing for compiling a renderable plan, so this journey reaches it
 *   through the same composition root a worker would
 *   (`createReactPlaybackMapServices().compile`).
 * - **Render.** Nothing under `src/app/v1` or `scripts/` consumes a
 *   `RenderablePlanSnapshot` either, so the MP4 comes from instantiating
 *   `FfmpegEditorialProxyRenderer` directly — which means this test hands the
 *   renderer the two source PATHS and an identity `ColorPipelineCompilation` it
 *   authored itself. In the product both come from the store and from a stored
 *   compilation, and a caller never supplies a colour measurement. So the
 *   render proves that THIS plan cuts THESE files into the footage asserted
 *   below; it does not prove that a published route would hand the renderer
 *   the same inputs.
 *
 * Both gaps are reported rather than papered over.
 *
 * The domain arrives through `await import` inside the test: tsx resolves a
 * static `.ts` specifier before it transforms the target and the file dies at
 * link time.
 */

const RUN = process.env.APOLLO_REACT_PLAYBACK_JOURNEY_E2E === '1'
const SKIP = RUN ? false : 'set APOLLO_REACT_PLAYBACK_JOURNEY_E2E=1 with a migrated V2_DATABASE_URL'
/**
 * Local disk or versioned MinIO, chosen by the runtime env — never pinned here.
 *
 * `POST /v1/.../playback-map` resolves the two recordings through
 * `CaptureMediaResolver`, so this journey does read artifact bytes, and the
 * first s3 run said so loudly: with an empty bucket the build answered
 * `500 INTERNAL_ERROR` where the suite expects `409
 * MEDIA_ARTIFACT_IDENTITY_MISMATCH`, because the reference track's
 * materialization failed before the identity comparison the assertion is about
 * was ever reached. The two recordings are therefore uploaded, and the refusal
 * assertion becomes a statement about the resolver rather than about which
 * disk the file happened to be on.
 *
 * What object storage still does NOT cover here is the render: nothing under
 * `src/app/v1` or `scripts/` consumes a `RenderablePlanSnapshot`, so the MP4
 * comes from an `FfmpegEditorialProxyRenderer` this test hands local source
 * paths to. That gap is the header's, not the driver's, and it is unchanged.
 */
const storageDriver = journeyStorageDriver()

const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const FFMPEG = ffmpegStatic ?? 'ffmpeg'
const FFPROBE = require('ffprobe-static').path

const WORKSPACE = 'react-journey-workspace'
const PROJECT = 'react-journey-project'
const SESSION = 'react-journey-session'
const CLIENT = 'react-journey-client'
const VERSION = 'react-journey-version'
const REACTION_TRACK = 'track-reaction'
const REFERENCE_TRACK = 'track-reference'

const SAMPLE_RATE = 16_000
const TICKS_PER_SECOND = 90_000
const FPS = 30
const REFERENCE_SECONDS = 30
const REACTION_SECONDS = 60

const seconds = (value) => BigInt(Math.round(value * TICKS_PER_SECOND))
const ticksToSeconds = (ticks) => Number(BigInt(ticks)) / TICKS_PER_SECOND
const at = (second) => new Date(Date.parse('2029-08-01T09:00:00.000Z') + second * 1_000)
const iso = (second) => at(second).toISOString()
const digest = (character) => character.repeat(64)

/**
 * What actually happened in front of the camera, second by second.
 *
 * Copied deliberately from `playback-map-fingerprint.integration.mjs`: the same
 * truth measured through a different path is the only way to tell a change in
 * the runtime wiring from a change in the detector. The pause is EIGHT seconds
 * long and that number is asserted below against what the server derived.
 */
const TRUTH = Object.freeze([
  { mode: 'playing', from: 0, to: 10, reference: 0 },
  { mode: 'paused', from: 10, to: 18, reference: null },
  { mode: 'playing', from: 18, to: 23, reference: 10 },
  { mode: 'commentary-only', from: 23, to: 37, reference: null },
  { mode: 'playing', from: 37, to: 41, reference: 15 },
  { mode: 'replay', from: 41, to: 49, reference: 8 },
  { mode: 'seek', from: 49, to: 53, reference: 19 },
  { mode: 'hidden', from: 53, to: 57, reference: 23 },
  { mode: 'playing', from: 57, to: 60, reference: 27 },
])

const PAUSE_SECONDS = 18 - 10

/**
 * Boundary tolerance, declared rather than discovered.
 *
 * The detector hops every 500 ms with a 1 s window, so a boundary is locatable
 * to within one hop plus the window that straddles it: 45 frames at 30 fps.
 * Every measured error is printed so a regression shows up as a number.
 */
const BOUNDARY_TOLERANCE_FRAMES = 45
const BOUNDARY_TOLERANCE_SECONDS = BOUNDARY_TOLERANCE_FRAMES / FPS

// ---------------------------------------------------------------------------
// The two recordings
// ---------------------------------------------------------------------------

/** Deterministic noise. `Math.random` would make the sha256 line a lie. */
function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296 - 0.5
  }
}

function buildReferenceSamples() {
  const samples = new Float64Array(REFERENCE_SECONDS * SAMPLE_RATE)
  for (let second = 0; second < REFERENCE_SECONDS; second += 1) {
    // A distinct sweep per second, under the correlator's 1 kHz Nyquist, so a
    // locked window names ONE second and not merely "some second".
    const start = 180 + 20 * ((second * 7) % REFERENCE_SECONDS)
    const span = second % 2 === 0 ? 150 : -150
    for (let sample = 0; sample < SAMPLE_RATE; sample += 1) {
      const t = sample / SAMPLE_RATE
      samples[second * SAMPLE_RATE + sample] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

function buildReactionSamples(reference) {
  const samples = new Float64Array(REACTION_SECONDS * SAMPLE_RATE)
  const noise = lcg(20_260_904)
  for (const segment of TRUTH) {
    const from = segment.from * SAMPLE_RATE
    const to = segment.to * SAMPLE_RATE
    for (let sample = from; sample < to; sample += 1) {
      if (segment.mode === 'hidden') {
        // The player is on screen behind an overlay: room tone only, under the
        // detector's energy floor. This is the stretch only a person can answer.
        samples[sample] = 0.004 * noise()
        continue
      }
      if (segment.reference === null) {
        samples[sample] = 0.55 * noise()
        continue
      }
      const referenceSample = Math.round(
        (segment.reference + (sample - from) / SAMPLE_RATE) * SAMPLE_RATE,
      )
      samples[sample] = (reference[referenceSample] ?? 0) + 0.10 * noise()
    }
  }
  return samples
}

function toPcm(samples) {
  const buffer = Buffer.alloc(samples.length * 2)
  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32_767), index * 2)
  }
  return buffer
}

async function encode(input) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i',
    `${input.videoSource}${input.videoSourceSeparator ?? '='}s=320x180:r=${FPS}:d=${input.durationSeconds}`,
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', input.pcmPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-shortest', input.outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  const bytes = await readFile(input.outputPath)
  const metadata = await stat(input.outputPath)
  return {
    path: input.outputPath,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: metadata.size,
  }
}

/** Streams and container duration, read off the file by ffprobe. */
function probeStreams(path) {
  return JSON.parse(execFileSync(FFPROBE, [
    '-v', 'error', '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,nb_read_frames,duration,sample_rate,width,height',
    '-show_entries', 'format=duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }))
}

/**
 * The delivered audio, decoded back to the rate the reaction was written at.
 *
 * The renderer re-encodes to 48 kHz AAC, so this is the reaction's sound after
 * two lossy generations. Correlation survives that; sample equality would not,
 * which is why nothing below compares bytes.
 */
function decodeAudio(path) {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', path,
    '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-',
  ], { windowsHide: true, maxBuffer: 512 * 1024 * 1024 })
  const samples = new Float64Array(Math.floor(raw.length / 2))
  for (let index = 0; index < samples.length; index += 1) samples[index] = raw.readInt16LE(index * 2) / 32_768
  return samples
}

/** Normalised cross-correlation of `window` against `source` at one offset. */
function correlationAt(window, source, offset) {
  let dot = 0
  let windowEnergy = 0
  let sourceEnergy = 0
  for (let index = 0; index < window.length; index += 1) {
    const left = window[index]
    const right = source[offset + index] ?? 0
    dot += left * right
    windowEnergy += left * left
    sourceEnergy += right * right
  }
  if (windowEnergy === 0 || sourceEnergy === 0) return 0
  return dot / Math.sqrt(windowEnergy * sourceEnergy)
}

/**
 * Where in the reaction the output is actually playing at `atSecond`.
 *
 * The compiler's own stated assumption is that every shot carries the
 * reaction's audio, and the timeline is the reaction tiled piece by piece — so
 * the answer must be "at `atSecond`", and the lag is the assertion. A plan that
 * cut the right lengths from the wrong moments (or from the wrong file) moves
 * this off zero while leaving the frame count, the duration and the codecs
 * exactly where they were.
 */
function reactionLagAt(delivered, reaction, atSecond, options) {
  const start = Math.round(atSecond * SAMPLE_RATE)
  const window = delivered.subarray(start, start + Math.round(options.windowSeconds * SAMPLE_RATE))
  const span = Math.round(options.searchSeconds * SAMPLE_RATE)
  // Half a millisecond of resolution: two orders finer than the frame the
  // assertion is stated in, and eight times cheaper than a sample-by-sample scan.
  const step = 8
  let best = { lagSamples: 0, score: -2 }
  for (let lag = -span; lag <= span; lag += step) {
    const offset = start + lag
    if (offset < 0 || offset + window.length > reaction.length) continue
    const score = correlationAt(window, reaction, offset)
    if (score > best.score) best = { lagSamples: lag, score }
  }
  return { lagSeconds: best.lagSamples / SAMPLE_RATE, score: best.score }
}

/** One decoded frame's mean and spread, over every RGB byte. */
function frameStatistics(path, atSecond) {
  const raw = execFileSync(FFMPEG, [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-ss', String(atSecond), '-i', path, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  let sum = 0
  for (const byte of raw) sum += byte
  const mean = sum / raw.length
  let variance = 0
  for (const byte of raw) variance += (byte - mean) ** 2
  return { mean, sd: Math.sqrt(variance / raw.length) }
}

// ---------------------------------------------------------------------------
// Routes, called the way Next calls them
// ---------------------------------------------------------------------------

function jsonRequest(url, options) {
  return new NextRequest(url, {
    method: options.method,
    headers: {
      authorization: `Bearer ${options.token}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
}

async function callRoute(handler, url, options) {
  const response = await handler(jsonRequest(url, options), {
    params: Promise.resolve(options.params),
  })
  const payload = await response.json()
  return { status: response.status, payload }
}

test(
  'E2E-F4.015 a real reaction is measured, anchored, compiled and rendered through /v1',
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

    const root = await mkdtemp(join(tmpdir(), 'apollo-react-journey-'))
    const artifactRoot = join(root, 'artifacts')
    // What FFmpeg writes. In local mode these ARE the stored artifacts; in s3
    // mode they are the fixture uploaded below, kept outside the artifact root
    // so no key resolves to a local file.
    const sourceRoot = storageDriver === 's3' ? join(root, 'sources') : artifactRoot
    for (const directory of [artifactRoot, sourceRoot]) await mkdir(directory, { recursive: true })
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_RENDER_WORK_ROOT = join(root, 'work')
    await mkdir(process.env.APOLLO_V2_RENDER_WORK_ROOT, { recursive: true })
    const objectStore = await openJourneyObjectStore()

    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createCaptureSession } = await import('../../src/v2/domain/capture-session.ts')
    const { createTickInterval, rational, timebaseFromRate } = await import(
      '../../src/v2/domain/session-time.ts'
    )
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
    const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
    const { createColorPipelineCompilation } = await import(
      '../../src/v2/domain/color-pipeline-compilation.ts'
    )
    const { validateDirectedEditPlan } = await import('../../src/v2/domain/director-run.ts')
    const { readOutputFormatPreset } = await import('../../src/v2/domain/output-format-registry.ts')
    const { PrismaApiClientRepository } = await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )
    const { FfmpegEditorialProxyRenderer } = await import(
      '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
    )
    const { createReactPlaybackMapServices } = await import(
      '../../src/v2/infrastructure/repository-factory.ts'
    )
    const { disconnectV2PostgresClient } = await import(
      '../../src/v2/infrastructure/prisma-postgres/client.ts'
    )
    const mapRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/playback-map/route.ts'
    )
    const piecesRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/playback-map/pieces/route.ts'
    )
    const anchorsRoute = await import(
      '../../src/app/v1/projects/[projectId]/capture-sessions/[sessionId]/playback-map/anchors/route.ts'
    )

    const client = new PrismaClient()
    const clean = async () => {
      await client.v2RenderablePlanSnapshot.deleteMany({ where: { workspaceId: WORKSPACE } })
      for (const table of [
        client.v2PlaybackUncoveredRange, client.v2PlaybackAnchor, client.v2PlaybackPiece,
        client.v2PlaybackMapHead, client.v2PlaybackMap,
        client.v2CaptureSessionHead, client.v2CaptureSessionVersion,
      ]) {
        await table.deleteMany({ where: { workspaceId: WORKSPACE } })
      }
      await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2MediaArtifact.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2Project.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2ApiCredential.deleteMany({ where: { workspaceId: WORKSPACE } })
      await client.v2ApiClient.deleteMany({ where: { workspaceId: WORKSPACE } })
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

    // ---- the two recordings, encoded here and never committed ---------------
    // In s3 mode `sourceRoot` sits outside the artifact root and the two files
    // are uploaded below, so the build route can only have read them out of
    // MinIO.
    const captureDirectory = join(sourceRoot, 'capture')
    await mkdir(captureDirectory, { recursive: true })
    const referenceSamples = buildReferenceSamples()
    // Kept, not discarded: this is what the delivered MP4's audio is measured
    // against at the end, and generating it twice would measure the generator.
    const reactionSamples = buildReactionSamples(referenceSamples)
    await writeFile(join(captureDirectory, 'reference.pcm'), toPcm(referenceSamples))
    await writeFile(join(captureDirectory, 'reaction.pcm'), toPcm(reactionSamples))
    const referenceFile = await encode({
      videoSource: 'testsrc2',
      durationSeconds: REFERENCE_SECONDS,
      pcmPath: join(captureDirectory, 'reference.pcm'),
      outputPath: join(captureDirectory, 'reference.mp4'),
    })
    const reactionFile = await encode({
      videoSource: 'color=c=gray',
      // `color` already carries an option, so size and rate append with ':'.
      videoSourceSeparator: ':',
      durationSeconds: REACTION_SECONDS,
      pcmPath: join(captureDirectory, 'reaction.pcm'),
      outputPath: join(captureDirectory, 'reaction.mp4'),
    })

    // ---- claim 1: the two recordings are not the same length ---------------
    const referenceProbe = probeStreams(referenceFile.path)
    const reactionProbe = probeStreams(reactionFile.path)
    const durationOf = (probe) => Number(probe.format.duration)
    const referenceSeconds = durationOf(referenceProbe)
    const reactionSeconds = durationOf(reactionProbe)
    assert.ok(Math.abs(referenceSeconds - REFERENCE_SECONDS) < 0.5, `reference measured ${referenceSeconds}s`)
    assert.ok(Math.abs(reactionSeconds - REACTION_SECONDS) < 0.5, `reaction measured ${reactionSeconds}s`)
    assert.ok(
      reactionSeconds > referenceSeconds * 1.9,
      `the reaction (${reactionSeconds}s) must not be the reference (${referenceSeconds}s)`,
    )

    // ---- the storage of record ---------------------------------------------
    if (objectStore) {
      for (const [key, file] of [
        ['capture/reference.mp4', referenceFile],
        ['capture/reaction.mp4', reactionFile],
      ]) {
        await objectStore.put(key, file.path)
        assert.equal(
          existsSync(join(artifactRoot, ...key.split('/'))),
          false,
          `${key} must not also sit in the artifact root while MinIO is the store of record`,
        )
      }
      assert.deepEqual(await objectStore.keys(), ['capture/reaction.mp4', 'capture/reference.mp4'])
    }

    // ---- the world the routes read -----------------------------------------
    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: WORKSPACE, slug: WORKSPACE, name: 'React playback journey', status: 'active', createdAt: iso(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => at(0),
    })({
      id: CLIENT,
      workspaceId: WORKSPACE,
      name: 'React playback journey',
      environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const token = issued.token
    await client.v2Project.create({
      data: {
        id: PROJECT, workspaceId: WORKSPACE, name: 'React playback journey', status: 'reviewing-proxy',
        objective: 'discovery', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: CLIENT, createdAt: at(0), updatedAt: at(0),
      },
    })
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      await client.v2ProjectSnapshot.create({
        data: {
          id: `react-journey-snapshot-${kind}`, workspaceId: WORKSPACE, projectId: PROJECT, kind,
          schemaVersion: 1, contentJson: JSON.stringify({ kind }), contentHash: digest('1'),
          createdAt: at(0),
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: VERSION, workspaceId: WORKSPACE, projectId: PROJECT, sequence: 1,
        briefSnapshotId: 'react-journey-snapshot-brief',
        editPlanSnapshotId: 'react-journey-snapshot-edit-plan',
        policiesSnapshotId: 'react-journey-snapshot-policies',
        baseHash: digest('2'), createdBy: CLIENT, createdAt: at(0),
      },
    })

    // The recordings as ingested artifacts. The byte size and the digest are the
    // file's own, because `LocalArtifactSourceMaterializer` re-hashes the file
    // before handing a detector its path: a fixture that typed either would be
    // refused here rather than in a comment.
    const recordings = [
      {
        role: 'reference',
        trackId: REFERENCE_TRACK,
        assetId: 'asset-reference-1',
        artifactId: 'artifact-react-reference',
        key: 'capture/reference.mp4',
        file: referenceFile,
        measuredSeconds: referenceSeconds,
        declaredSeconds: REFERENCE_SECONDS,
      },
      {
        role: 'reaction',
        trackId: REACTION_TRACK,
        assetId: 'asset-reaction-1',
        artifactId: 'artifact-react-reaction',
        key: 'capture/reaction.mp4',
        file: reactionFile,
        measuredSeconds: reactionSeconds,
        declaredSeconds: REACTION_SECONDS,
      },
    ]
    for (const recording of recordings) {
      await client.v2MediaArtifact.create({
        data: {
          id: recording.artifactId, workspaceId: WORKSPACE, artifactKey: recording.key,
          sha256: recording.file.sha256, byteSize: BigInt(recording.file.byteSize),
          mediaType: 'video', container: 'mp4', status: 'available', createdAt: at(0),
        },
      })
      await client.v2MediaArtifactManifest.create({
        data: {
          id: `manifest-${recording.artifactId}`, workspaceId: WORKSPACE, artifactId: recording.artifactId,
          schemaVersion: 'media-artifact-manifest/v1', manifestHash: digest('3'),
          recipeId: 'capture-ingest', recipeVersion: '1.0.0', parametersHash: digest('4'),
          manifestJson: JSON.stringify({
            schemaVersion: 'media-artifact-manifest/v1',
            artifact: {
              artifactKey: recording.key, sha256: recording.file.sha256,
              byteSize: recording.file.byteSize, mediaType: 'video', container: 'mp4',
            },
            recipe: { id: 'capture-ingest', version: '1.0.0', parametersHash: digest('4') },
            sources: [],
            // The measurement the compiler is forbidden to take from a caller:
            // ffprobe's number, not the fixture's intent.
            probe: {
              width: 320, height: 180, fps: FPS, rFrameRate: `${FPS}/1`,
              duration: recording.measuredSeconds,
            },
          }),
          createdAt: at(0),
        },
      })
      await client.v2ProjectMediaAsset.create({
        data: {
          id: randomUUID(), workspaceId: WORKSPACE, projectId: PROJECT,
          artifactId: recording.artifactId,
          role: recording.role === 'reaction' ? 'source-master' : 'selected-insert',
          originalFileName: `${recording.role}.mp4`, createdAt: at(0),
        },
      })
    }

    const reactionRecordingArtifactId = recordings[1].artifactId

    const timebase = timebaseFromRate(TICKS_PER_SECOND)
    const trackFor = (recording, role, syncAudioPolicy, includeInFinalMix) => ({
      trackId: recording.trackId,
      role,
      device: {
        deviceId: `device-${recording.role}`,
        recorderId: `recorder-${recording.role}`,
        make: null, model: null, serial: null,
      },
      sourceAssetId: recording.assetId,
      timebase,
      streamIndex: 0,
      syncAudioPolicy,
      includeInFinalMix,
      parts: [{
        partId: `part-${recording.role}-1`,
        ordinal: 0,
        sourceAssetId: recording.assetId,
        timebase,
        coverage: createTickInterval(BigInt(0), seconds(recording.declaredSeconds)),
        streamIndex: 0,
        splitReason: 'single-file',
        evidence: {
          ingestArtifactId: recording.artifactId,
          ingestSha256: recording.file.sha256,
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
      referenceTrackId: REFERENCE_TRACK,
      tracks: [
        trackFor(recordings[1], 'reaction', 'final-candidate', true),
        trackFor(recordings[0], 'reference-video', 'sync-only', false),
      ],
      lineage: {
        commandId: 'command-create-session',
        operation: 'create-session',
        actorKind: 'api-client',
        actorId: CLIENT,
        occurredAt: iso(1),
        note: null,
      },
      createdAt: iso(1),
    })
    await new PrismaCaptureSessionRepository(client).appendVersion({ session, occurredAt: iso(1) })

    const basePath = `http://localhost/v1/projects/${PROJECT}/capture-sessions/${SESSION}`
    const params = { projectId: PROJECT, sessionId: SESSION }
    const buildBody = {
      baseVersionId: `${SESSION}:v${session.version}`,
      baseHash: session.sessionHash,
      reactionTrackId: REACTION_TRACK,
    }

    // ---- claim 2: the gate, from the wrong side ----------------------------
    //
    // `CaptureMediaResolver` compares the session's recorded `ingestSha256`
    // against the registry's `sha256` and fails closed, because a detector
    // pointed at substituted bytes reports a marker the recording never held and
    // every offset derived from it is confidently wrong. Nothing in the tree
    // exercised that comparison negatively: the guard could be deleted whole and
    // every suite stayed green. So the row is edited underneath the session and
    // the SAME published call is made — the one assertion that makes the claim
    // at the top of this file true.
    await client.v2MediaArtifact.update({
      where: { id: reactionRecordingArtifactId },
      data: { sha256: digest('e') },
    })
    const refused = await callRoute(mapRoute.POST, `${basePath}/playback-map`, {
      method: 'POST', token, params, body: buildBody,
    })
    assert.equal(refused.status, 409, JSON.stringify(refused.payload))
    assert.equal(refused.payload.error.code, 'MEDIA_ARTIFACT_IDENTITY_MISMATCH')
    assert.equal(refused.payload.error.category, 'conflict')
    // Refused BEFORE anything was written: a half-built map derived from bytes
    // nobody could vouch for is worse than no map.
    assert.equal(
      await client.v2PlaybackMap.count({ where: { workspaceId: WORKSPACE } }),
      0,
      'a detection refused for identity still wrote a map',
    )
    await client.v2MediaArtifact.update({
      where: { id: reactionRecordingArtifactId },
      data: { sha256: reactionFile.sha256 },
    })
    // The restore, verified. Everything after this line is meaningless if the
    // registry stopped describing the files this test encoded, and a mismatch
    // discovered at the route reads like a defect in the product when it would
    // be a defect in the fixture — so the two are separated here, once.
    const registered = await client.v2MediaArtifact.findMany({
      where: { workspaceId: WORKSPACE },
      select: { id: true, sha256: true },
      orderBy: { id: 'asc' },
    })
    assert.deepEqual(
      registered,
      [...recordings]
        .map((recording) => ({ id: recording.artifactId, sha256: recording.file.sha256 }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
      'the artifact registry does not describe the files this journey encoded',
    )

    // ---- claim 3: the server derives the map from the bytes ----------------
    const startedAt = Date.now()
    const built = await callRoute(mapRoute.POST, `${basePath}/playback-map`, {
      method: 'POST',
      token,
      params,
      body: buildBody,
    })
    const detectionMs = Date.now() - startedAt
    assert.equal(built.status, 201, JSON.stringify(built.payload))
    const map = built.payload.data.map
    assert.equal(map.status, 'needs-input')
    assert.equal(built.payload.data.manualReviewRequired, true)
    assert.equal(map.uncovered.length, 1, JSON.stringify(map.uncovered))
    assert.equal(map.uncovered[0].reason, 'manual-anchor-required')

    // The durations the map carries are the two FILES', so they are compared
    // against what ffprobe measured on disk rather than against the constants
    // the fixture typed into the session's coverage. The two agree here — but
    // only one of them is a measurement, and asserting the other would have
    // proved that a number survived a round trip, not that anybody read a file.
    assert.notEqual(
      map.reactionMedia.durationTicks,
      map.referenceMedia.durationTicks,
      'the map claimed the reaction and the reference are the same length',
    )
    const ticksPerFrame = TICKS_PER_SECOND / FPS
    const durationErrorFrames = (ticks, measuredSeconds) =>
      Math.abs(Number(BigInt(ticks) - seconds(measuredSeconds))) / ticksPerFrame
    const reactionDurationErrorFrames = durationErrorFrames(map.reactionMedia.durationTicks, reactionSeconds)
    const referenceDurationErrorFrames = durationErrorFrames(map.referenceMedia.durationTicks, referenceSeconds)
    assert.ok(
      reactionDurationErrorFrames <= 1,
      `the map says the reaction is ${ticksToSeconds(map.reactionMedia.durationTicks)}s; ffprobe measured ${reactionSeconds}s`,
    )
    assert.ok(
      referenceDurationErrorFrames <= 1,
      `the map says the reference is ${ticksToSeconds(map.referenceMedia.durationTicks)}s; ffprobe measured ${referenceSeconds}s`,
    )

    // ---- the pieces, read through the published listing --------------------
    const listed = await callRoute(
      piecesRoute.GET,
      `${basePath}/playback-map/pieces?reactionTrackId=${REACTION_TRACK}`,
      { method: 'GET', token, params },
    )
    assert.equal(listed.status, 200, JSON.stringify(listed.payload))
    const pieces = listed.payload.data.pieces
    const modes = pieces.map((piece) => piece.mode)
    assert.deepEqual(
      modes,
      ['playing', 'paused', 'playing', 'commentary-only', 'playing', 'replay', 'seek', 'playing'],
      `the derived modes were ${modes.join(', ')}`,
    )

    const toSeconds = ticksToSeconds
    const spanSeconds = (piece) => toSeconds(piece.reactionRange.end) - toSeconds(piece.reactionRange.start)

    // A pause of a KNOWN length: eight seconds of the reactor talking over a
    // player that did not advance, and the reference range is null because the
    // reference produced no time at all.
    const paused = pieces.find((piece) => piece.mode === 'paused')
    assert.equal(paused.referenceRange, null, 'a pause that claims reference time is not a pause')
    assert.equal(paused.rate, null, 'a stopped player has no measured rate')
    const pauseError = Math.abs(spanSeconds(paused) - PAUSE_SECONDS)
    assert.ok(
      pauseError <= BOUNDARY_TOLERANCE_SECONDS,
      `the pause measured ${spanSeconds(paused).toFixed(3)}s against a known ${PAUSE_SECONDS}s`,
    )

    // Commentary: the reactor speaking with the player stopped, and no
    // reference range — the case a linearising map would fill in.
    const commentary = pieces.find((piece) => piece.mode === 'commentary-only')
    assert.equal(commentary.referenceRange, null)
    assert.ok(spanSeconds(commentary) > 8, `commentary measured ${spanSeconds(commentary).toFixed(3)}s`)

    // The rewind: back over reference ground already played, and named as such.
    const replay = pieces.find((piece) => piece.mode === 'replay')
    assert.equal(replay.direction, 'backward')
    assert.equal(replay.discontinuityReason, 'rewind')
    const beforeReplay = pieces[pieces.indexOf(replay) - 1]
    assert.ok(
      BigInt(replay.referenceRange.start) < BigInt(beforeReplay.referenceRange.start),
      'a replay that does not go back is not a replay',
    )

    // The seek: forward past unplayed reference, which is a different fact.
    const seek = pieces.find((piece) => piece.mode === 'seek')
    assert.equal(seek.discontinuityReason, 'seek')
    assert.ok(BigInt(seek.referenceRange.start) > BigInt(replay.referenceRange.end))

    // No piece asserts reference time the reference does not have.
    for (const piece of pieces) {
      if (piece.referenceRange === null) continue
      assert.ok(
        BigInt(piece.referenceRange.end) <= BigInt(map.referenceMedia.durationTicks),
        `piece ${piece.pieceId} plays past the end of the reference`,
      )
      assert.notEqual(
        piece.referenceRange.end,
        map.reactionMedia.durationTicks,
        `piece ${piece.pieceId} ends at the reaction's duration, which is not a reference instant`,
      )
    }

    // ---- claim 4: the person answers the one thing the audio could not -----
    const hidden = TRUTH.find((segment) => segment.mode === 'hidden')
    const uncoveredStart = BigInt(map.uncovered[0].range.start)
    const uncoveredEnd = BigInt(map.uncovered[0].range.end)
    // Deliberately NOT the head of the stretch: an operator reads the clock off
    // whatever frame is legible, and an anchor placed anywhere else used to
    // shift the whole resolved piece by the distance between the two.
    const anchorTick = uncoveredStart + (uncoveredEnd - uncoveredStart) / BigInt(2)
    const anchorReference = seconds(hidden.reference) + (anchorTick - uncoveredStart)
    const anchored = await callRoute(anchorsRoute.POST, `${basePath}/playback-map/anchors`, {
      method: 'POST',
      token,
      params,
      body: {
        baseVersionId: built.payload.data.versionRef,
        baseHash: map.mapHash,
        reactionTrackId: REACTION_TRACK,
        anchor: {
          anchorId: 'react-journey-anchor-1',
          reactionTick: anchorTick.toString(),
          referenceTick: anchorReference.toString(),
          mode: 'playing',
          note: 'overlay escondeu o player; li o relogio no frame',
        },
      },
    })
    assert.equal(anchored.status, 201, JSON.stringify(anchored.payload))
    const resolvedMap = anchored.payload.data.map
    assert.equal(resolvedMap.status, 'resolved')
    assert.equal(resolvedMap.version, 2)
    assert.equal(resolvedMap.uncovered.length, 0)
    // CONTRACT §2: who moved it is the authenticated actor, never the note.
    assert.equal(
      resolvedMap.anchors[0].evidenceRef,
      `operator:${CLIENT} (overlay escondeu o player; li o relogio no frame)`,
    )

    // ---- WHAT the person answered, not merely that the server took it ------
    //
    // `status: resolved` is a flip; the anchor's content is a reference INSTANT.
    // An anchor read off a different frame, or a resolution that pinned the
    // stretch to the head of the hole instead of to the anchor, resolves the map
    // just as cleanly, renders a different MP4 and prints an identical evidence
    // line. So the stretch is re-listed through the published listing and read.
    const relisted = await callRoute(
      piecesRoute.GET,
      `${basePath}/playback-map/pieces?reactionTrackId=${REACTION_TRACK}`,
      { method: 'GET', token, params },
    )
    assert.equal(relisted.status, 200, JSON.stringify(relisted.payload))
    const resolvedPieces = relisted.payload.data.pieces
    assert.equal(
      resolvedPieces.length,
      pieces.length + 1,
      `the anchor produced ${resolvedPieces.length} pieces out of ${pieces.length}`,
    )
    const anchoredPiece = resolvedPieces.find((piece) =>
      BigInt(piece.reactionRange.start) <= anchorTick && anchorTick < BigInt(piece.reactionRange.end))
    assert.ok(anchoredPiece, 'the anchored instant landed in no piece at all')
    assert.equal(anchoredPiece.detectionMethod, 'manual-anchor')
    assert.equal(anchoredPiece.discontinuityReason, 'manual-anchor')
    assert.ok(anchoredPiece.referenceRange !== null, 'the anchored stretch came back with no reference time')
    assert.ok(
      anchoredPiece.evidenceRefs.includes(resolvedMap.anchors[0].evidenceRef),
      `the piece does not cite the anchor that produced it: ${anchoredPiece.evidenceRefs.join(' | ')}`,
    )
    // Nothing here was DETECTED: this stretch is computed from the operator's
    // instant at rate 1, so it has to reproduce the arithmetic and not merely
    // land inside the detector's boundary tolerance. One frame, not 45.
    const expectedReferenceStart = hidden.reference +
      (ticksToSeconds(anchoredPiece.reactionRange.start) - ticksToSeconds(uncoveredStart))
    const anchoredReferenceErrorFrames =
      Math.abs(ticksToSeconds(anchoredPiece.referenceRange.start) - expectedReferenceStart) * FPS
    assert.ok(
      anchoredReferenceErrorFrames <= 1,
      `the anchored stretch starts at reference ${ticksToSeconds(anchoredPiece.referenceRange.start)}s ` +
      `where the operator's instant puts it at ${expectedReferenceStart}s`,
    )
    // And it advances with the reaction: a resolution that stretched or froze
    // the reference would keep the start and lose the span.
    const anchoredSpanErrorFrames = Math.abs(
      (ticksToSeconds(anchoredPiece.referenceRange.end) - ticksToSeconds(anchoredPiece.referenceRange.start)) -
      (ticksToSeconds(anchoredPiece.reactionRange.end) - ticksToSeconds(anchoredPiece.reactionRange.start)),
    ) * FPS
    assert.ok(anchoredSpanErrorFrames <= 1, `the anchored stretch runs ${anchoredSpanErrorFrames.toFixed(1)} frames out of step`)
    // The anchor filled the hole and moved nothing else: every piece the
    // detector had already derived comes back with the same two ranges.
    const rangesOf = (piece) => ({
      mode: piece.mode,
      reactionRange: piece.reactionRange,
      referenceRange: piece.referenceRange,
    })
    const survivors = resolvedPieces.filter((piece) => piece.pieceId !== anchoredPiece.pieceId)
    assert.equal(survivors.length, pieces.length)
    assert.deepEqual(
      survivors.map(rangesOf),
      pieces.map(rangesOf),
      'resolving the uncovered stretch moved a piece the detector had already measured',
    )

    // The version before the anchor is still readable, unchanged.
    const readV1 = await callRoute(
      mapRoute.GET,
      `${basePath}/playback-map?reactionTrackId=${REACTION_TRACK}&version=1`,
      { method: 'GET', token, params },
    )
    assert.equal(readV1.status, 200, JSON.stringify(readV1.payload))
    assert.equal(readV1.payload.data.map.mapHash, map.mapHash)
    assert.equal(readV1.payload.data.map.status, 'needs-input')

    // ---- claim 5: the compiled plan renders and the footage is the plan's --
    //
    // The one hop with no published capability. `createReactPlaybackMapServices`
    // is the composition root a worker would use, and it is executed here
    // rather than described.
    const services = createReactPlaybackMapServices()
    const compiled = await services.compile({
      actor: { workspaceId: WORKSPACE, kind: 'api-client', id: CLIENT },
      sessionId: SESSION,
      reactionTrackId: REACTION_TRACK,
      projectVersionId: VERSION,
      objective: 'discovery',
      planFps: rational(BigInt(FPS), BigInt(1)),
    })
    validateDirectedEditPlan(compiled.plan)
    assert.equal(compiled.mapVersion, 2)
    const reactionFrames = Math.round(REACTION_SECONDS * FPS)
    assert.equal(compiled.plan.durationFrames, reactionFrames)
    assert.notEqual(
      compiled.plan.durationFrames,
      Math.round(REFERENCE_SECONDS * FPS),
      'the plan ran the reference length instead of the reaction length',
    )

    const COLOR_METADATA = Object.freeze({
      colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709',
      range: 'limited', bitDepth: 8,
    })
    const identityCompilation = (artifactId) => {
      const implementation = (provider, parameters) => ({
        provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
      })
      return createColorPipelineCompilation({
        id: `compilation-${artifactId}`,
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        sourceArtifactId: artifactId,
        sourceManifestId: `manifest-${artifactId}`,
        probe: createMediaColorProbe({
          id: `probe-${artifactId}`, workspaceId: WORKSPACE, artifactId,
          manifestId: `manifest-${artifactId}`,
          detection: { state: 'ready', metadata: COLOR_METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr' },
          producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: digest('9') },
          createdAt: iso(0),
        }),
        outputMetadata: COLOR_METADATA,
        createdByClientId: CLIENT,
        createdAt: iso(1),
        // The order is forced in four places; an identity pipeline still has to
        // declare all four stages in COLOR_TRANSFORM_ORDER.
        stages: [
          { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
          { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-match', { mode: 'bypass' }) },
          { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-lut', { mode: 'none' }) },
          { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
        ],
      })
    }
    const pathByArtifactId = new Map(recordings.map((recording) => [recording.artifactId, recording.file.path]))
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'render-work'),
      ffmpegPath: FFMPEG,
    })
    const operationId = 'react-playback-journey-render'
    // Cleanup after the measurement, never in a `finally` that would delete the
    // evidence before anybody read it.
    t.after(async () => {
      await renderer.cleanup(operationId).catch((error) => {
        console.log(`react journey renderer cleanup reported: ${error?.message ?? error}`)
      })
    })
    const clips = compiled.plan.videoTracks[0].clips
    const rendered = await renderer.render({
      operationId,
      renderKind: 'proxy',
      sources: compiled.plan.sources.map((source) => ({
        artifactId: source.artifactId,
        path: pathByArtifactId.get(source.artifactId),
        mediaType: 'video',
        colorPipelineCompilation: identityCompilation(source.artifactId),
      })),
      lutPaths: {},
      clips,
      fps: compiled.plan.fps,
      format: '16:9',
      // No `outputSpec`: for `renderKind: 'proxy'` the renderer takes its
      // dimensions from the format registry and ignores the field entirely
      // (`ffmpeg-editorial-proxy-renderer.ts:586`), so passing one would have
      // been a number this test appeared to choose and did not.
      transitions: compiled.plan.transitions,
    })

    // ---- the MP4, read back -------------------------------------------------
    const outputProbe = probeStreams(rendered.outputPath)
    const video = outputProbe.streams.find((stream) => stream.codec_type === 'video')
    const audio = outputProbe.streams.find((stream) => stream.codec_type === 'audio')
    const outputBytes = await readFile(rendered.outputPath)
    const outputSha256 = createHash('sha256').update(outputBytes).digest('hex')
    const outputFrames = Number(video.nb_read_frames)
    const outputSeconds = Number(outputProbe.format.duration)
    assert.ok(audio, 'the reaction audio never reached the output')
    assert.equal(outputFrames, compiled.plan.durationFrames, 'the file does not hold the frames the plan promised')
    // The dimensions the RENDERER chose, read off the registry rather than
    // retyped: the proxy preset for 16:9 is where 960x540 comes from.
    const proxyPreset = readOutputFormatPreset('16:9').exportDefaults.proxy
    assert.equal(video.width, proxyPreset.width)
    assert.equal(video.height, proxyPreset.height)
    assert.equal(video.codec_name, proxyPreset.codec)
    assert.equal(audio.codec_name, proxyPreset.audioCodec)
    assert.equal(rendered.byteSize, outputBytes.length)
    assert.equal(rendered.sha256, outputSha256, 'the renderer reported a digest the file does not have')
    // The output runs the reaction, not the reference. Measured on the file.
    assert.ok(
      Math.abs(outputSeconds - reactionSeconds) < 0.5,
      `the render measured ${outputSeconds.toFixed(3)}s against a reaction of ${reactionSeconds.toFixed(3)}s`,
    )
    assert.ok(
      outputSeconds > referenceSeconds * 1.9,
      `the render measured ${outputSeconds.toFixed(3)}s, which is the reference's ${referenceSeconds.toFixed(3)}s`,
    )

    // ---- the footage, not the container ------------------------------------
    //
    // Everything above holds for 1800 frames of anything. A plan that cut the
    // right lengths from the wrong moments renders a file with the same frame
    // count, the same duration, the same codecs and the same dimensions — and a
    // different sha256 nobody may pin, because the digest is FFmpeg-build
    // dependent and this suite runs on Windows and on the ubuntu runner. So the
    // output is measured against the two things the fixture knows: the
    // reaction's own audio, and which source each stretch must have come from.
    const deliveredAudio = decodeAudio(rendered.outputPath)
    let audioEnergy = 0
    for (const sample of deliveredAudio) audioEnergy += sample * sample
    const audioRms = Math.sqrt(audioEnergy / deliveredAudio.length)
    // A muted track passes every assertion above; -40 dBFS is far below the
    // reaction (measured around -20 dBFS RMS) and far above digital silence.
    assert.ok(audioRms > 0.01, `the delivered audio is silent (rms ${audioRms.toFixed(5)})`)

    const midpointOf = (piece) =>
      (ticksToSeconds(piece.reactionRange.start) + ticksToSeconds(piece.reactionRange.end)) / 2
    const resolvedPaused = resolvedPieces.find((piece) => piece.mode === 'paused')
    const resolvedCommentary = resolvedPieces.find((piece) => piece.mode === 'commentary-only')
    const resolvedReplay = resolvedPieces.find((piece) => piece.mode === 'replay')
    const firstPlaying = resolvedPieces.find((piece) => piece.mode === 'playing')

    // Audio: the compiler's own assumption is that every shot carries the
    // reaction's sound and the timeline is the reaction tiled piece by piece, so
    // the best lag against the reaction has to be zero at every instant — inside
    // a stretch the reactor talked over, inside a rewind, and at the end.
    const audioProbes = [
      { label: 'paused', second: midpointOf(resolvedPaused) },
      { label: 'replay', second: midpointOf(resolvedReplay) },
      { label: 'tail', second: midpointOf(resolvedPieces[resolvedPieces.length - 1]) },
    ].map((probe) => ({
      ...probe,
      ...reactionLagAt(deliveredAudio, reactionSamples, probe.second, { windowSeconds: 1, searchSeconds: 2 }),
    }))
    for (const probe of audioProbes) {
      assert.ok(
        Math.abs(probe.lagSeconds) * FPS <= 1,
        `at ${probe.second.toFixed(2)}s the output plays the reaction's ${(probe.second + probe.lagSeconds).toFixed(2)}s ` +
        `(lag ${probe.lagSeconds.toFixed(3)}s, correlation ${probe.score.toFixed(3)})`,
      )
      assert.ok(
        probe.score > 0.8,
        `at ${probe.second.toFixed(2)}s (${probe.label}) nothing in the reaction correlates with the output: ${probe.score.toFixed(3)}`,
      )
    }

    // Picture: the reaction is a flat `color=c=gray` and the reference is
    // `testsrc2`, so which file a stretch was cut from is legible in one frame.
    // A plan that showed the reference while the player was stopped — or the
    // reactor while it was playing — is the mutation this catches.
    const pixelProbes = [
      { label: 'paused', second: midpointOf(resolvedPaused), source: 'reaction' },
      { label: 'commentary-only', second: midpointOf(resolvedCommentary), source: 'reaction' },
      { label: 'playing', second: midpointOf(firstPlaying), source: 'reference' },
      { label: 'replay', second: midpointOf(resolvedReplay), source: 'reference' },
    ].map((probe) => ({ ...probe, ...frameStatistics(rendered.outputPath, probe.second) }))
    for (const probe of pixelProbes) {
      if (probe.source === 'reaction') {
        assert.ok(
          probe.sd < 2 && Math.abs(probe.mean - 128) < 3,
          `at ${probe.second.toFixed(2)}s (${probe.label}) the picture is not the reactor's flat gray: mean ${probe.mean.toFixed(1)}, sd ${probe.sd.toFixed(2)}`,
        )
        continue
      }
      assert.ok(
        probe.sd > 40,
        `at ${probe.second.toFixed(2)}s (${probe.label}) the picture is flat, so it is not the reference: sd ${probe.sd.toFixed(2)}`,
      )
    }

    // What object storage holds at the end: the two recordings this journey
    // uploaded and nothing else. Nothing in a react playback map is promoted as
    // a derived artifact today, and a third key appearing here would mean
    // something started writing without anybody deciding it should.
    if (objectStore) {
      assert.deepEqual(await objectStore.keys(), ['capture/reaction.mp4', 'capture/reference.mp4'])
    }

    // The file itself, kept only when a run asks for it. The renderer's own
    // cleanup removes the work directory in `t.after`, so a CI run that wants
    // to look at the MP4 afterwards has to be handed a copy while it exists —
    // the same shape `proof-mode-visual-goldens.integration.mjs` uses for its
    // retained evidence. Unset locally, so nothing accumulates on a laptop.
    const retentionRoot = process.env.APOLLO_REACT_PLAYBACK_JOURNEY_OUTPUT?.trim()
    let retainedPath = null
    if (retentionRoot) {
      await mkdir(retentionRoot, { recursive: true })
      retainedPath = join(retentionRoot, 'react-playback-journey.mp4')
      await copyFile(rendered.outputPath, retainedPath)
      await writeFile(
        join(retentionRoot, 'manifest.json'),
        `${JSON.stringify({
          schemaVersion: 'react-playback-journey-evidence/v2',
          renderedThrough: 'FfmpegEditorialProxyRenderer',
          file: 'react-playback-journey.mp4',
          sha256: outputSha256,
          byteSize: rendered.byteSize,
          width: video.width,
          height: video.height,
          videoCodec: video.codec_name,
          audioCodec: audio.codec_name,
          audioSampleRate: Number(audio.sample_rate),
          durationInFrames: outputFrames,
          durationSeconds: outputSeconds,
          planFps: compiled.plan.fps,
          planDurationFrames: compiled.plan.durationFrames,
          clipCount: clips.length,
          mapVersion: compiled.mapVersion,
          // RUN-SCOPED, and named so nobody quotes it as a determinism witness.
          // The plan hash covers the plan's `createdAt`, which the composition
          // root fills from the clock, so two runs that deliver a byte-identical
          // MP4 still print two different values here (measured on this machine:
          // 5e0ed27c… and 2a7b120a… over the same sha256 74db78d7…). The
          // reproducible numbers in this file are sha256, byteSize and
          // durationInFrames.
          planHashRunScoped: compiled.planHash,
          pieceModes: modes,
          reproducibility: {
            reproducible: ['sha256', 'byteSize', 'durationInFrames', 'durationSeconds'],
            runScoped: ['planHashRunScoped'],
          },
          audioProbes: audioProbes.map((probe) => ({
            label: probe.label, atSecond: probe.second, lagSeconds: probe.lagSeconds, correlation: probe.score,
          })),
          pixelProbes: pixelProbes.map((probe) => ({
            label: probe.label, atSecond: probe.second, source: probe.source, mean: probe.mean, sd: probe.sd,
          })),
          audioRms,
          measuredSourceSeconds: { reference: referenceSeconds, reaction: reactionSeconds },
        }, null, 2)}\n`,
        'utf8',
      )
    }

    console.log(
      `E2E-F4.015 react journey: reference ${referenceSeconds.toFixed(3)}s/${referenceProbe.streams.find((stream) => stream.codec_type === 'video').codec_name} ` +
      `vs reaction ${reactionSeconds.toFixed(3)}s (ratio ${(reactionSeconds / referenceSeconds).toFixed(2)}x); ` +
      `detection ${detectionMs} ms over /v1 produced ${pieces.length} pieces [${modes.join('>')}] ` +
      `+ ${map.uncovered.length} uncovered; pause ${spanSeconds(paused).toFixed(3)}s vs known ${PAUSE_SECONDS}s ` +
      `(erro ${(pauseError * FPS).toFixed(1)} frames, tolerancia ${BOUNDARY_TOLERANCE_FRAMES}); ` +
      `commentary ${spanSeconds(commentary).toFixed(3)}s referenceRange=null; ` +
      `replay ${replay.direction}/${replay.discontinuityReason}; seek ${seek.discontinuityReason}; ` +
      `anchor v${resolvedMap.version} status=${resolvedMap.status} resolved the hole at reference ` +
      `${ticksToSeconds(anchoredPiece.referenceRange.start).toFixed(3)}s vs known ${hidden.reference}s ` +
      `(erro ${anchoredReferenceErrorFrames.toFixed(2)} frames) via ${anchoredPiece.detectionMethod}, ` +
      `${pieces.length}->${resolvedPieces.length} pieces; ` +
      `identity gate refused a tampered artifact ${refused.status}/${refused.payload.error.code}; ` +
      `plan ${compiled.plan.durationFrames} frames over ${clips.length} clips from ` +
      `${compiled.plan.sources.length} sources; ` +
      `MP4 ${outputFrames} frames / ${outputSeconds.toFixed(3)}s / ${video.codec_name}+${audio.codec_name} / ` +
      `${video.width}x${video.height} / ${rendered.byteSize} bytes / sha256 ${outputSha256.slice(0, 16)}; ` +
      `audio rms ${audioRms.toFixed(4)}, reaction lag ` +
      `[${audioProbes.map((probe) => `${probe.label} ${probe.lagSeconds.toFixed(3)}s r=${probe.score.toFixed(3)}`).join(', ')}]; ` +
      `pixels [${pixelProbes.map((probe) => `${probe.label} sd=${probe.sd.toFixed(2)} mean=${probe.mean.toFixed(1)}`).join(', ')}]` +
      `${retainedPath ? ` / retained at ${retainedPath}` : ''}`,
    )
  },
)

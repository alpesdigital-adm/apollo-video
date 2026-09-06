import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'
import { NextRequest } from 'next/server'

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
 * 2. The map the server derived carries play, a pause of a KNOWN length, a
 *    commentary stretch with no reference range at all, a rewind and a seek —
 *    each read out of the `/v1` payload, not out of the domain object.
 * 3. The compiled plan renders, and the MP4 runs the reaction's length rather
 *    than the reference's, with the frame count the plan promised.
 *
 * The compile step is the one hop that is NOT a published capability: the
 * registry has `playback-map.build/read/pieces.list/anchors.add` and nothing
 * for compiling a renderable plan, so this journey reaches it through the same
 * composition root a worker would (`createReactPlaybackMapServices().compile`).
 * That gap is reported rather than papered over.
 *
 * The domain arrives through `await import` inside the test: tsx resolves a
 * static `.ts` specifier before it transforms the target and the file dies at
 * link time.
 */

const RUN = process.env.APOLLO_REACT_PLAYBACK_JOURNEY_E2E === '1'
const SKIP = RUN ? false : 'set APOLLO_REACT_PLAYBACK_JOURNEY_E2E=1 with a migrated V2_DATABASE_URL'

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
    process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER = 'local'

    const artifactRoot = await mkdtemp(join(tmpdir(), 'apollo-react-journey-'))
    process.env.APOLLO_V2_ARTIFACT_ROOT = artifactRoot
    process.env.APOLLO_V2_RENDER_WORK_ROOT = join(artifactRoot, '.work')
    await mkdir(process.env.APOLLO_V2_RENDER_WORK_ROOT, { recursive: true })

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
      await rm(artifactRoot, { recursive: true, force: true }).catch((error) => {
        console.error('artifact root cleanup failed:', error?.message ?? error)
      })
      await client.$disconnect().catch(() => undefined)
      await disconnectV2PostgresClient().catch(() => undefined)
    })
    await clean()

    // ---- the two recordings, encoded here and never committed ---------------
    const captureDirectory = join(artifactRoot, 'capture')
    await mkdir(captureDirectory, { recursive: true })
    const referenceSamples = buildReferenceSamples()
    await writeFile(join(captureDirectory, 'reference.pcm'), toPcm(referenceSamples))
    await writeFile(join(captureDirectory, 'reaction.pcm'), toPcm(buildReactionSamples(referenceSamples)))
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

    // ---- claim 2: the server derives the map from the bytes ----------------
    const basePath = `http://localhost/v1/projects/${PROJECT}/capture-sessions/${SESSION}`
    const params = { projectId: PROJECT, sessionId: SESSION }
    const startedAt = Date.now()
    const built = await callRoute(mapRoute.POST, `${basePath}/playback-map`, {
      method: 'POST',
      token,
      params,
      body: {
        baseVersionId: `${SESSION}:v${session.version}`,
        baseHash: session.sessionHash,
        reactionTrackId: REACTION_TRACK,
      },
    })
    const detectionMs = Date.now() - startedAt
    assert.equal(built.status, 201, JSON.stringify(built.payload))
    const map = built.payload.data.map
    assert.equal(map.status, 'needs-input')
    assert.equal(built.payload.data.manualReviewRequired, true)
    assert.equal(map.uncovered.length, 1, JSON.stringify(map.uncovered))
    assert.equal(map.uncovered[0].reason, 'manual-anchor-required')

    // The durations the map carries are the two files', measured separately.
    assert.notEqual(
      map.reactionMedia.durationTicks,
      map.referenceMedia.durationTicks,
      'the map claimed the reaction and the reference are the same length',
    )
    assert.equal(map.reactionMedia.durationTicks, seconds(REACTION_SECONDS).toString())
    assert.equal(map.referenceMedia.durationTicks, seconds(REFERENCE_SECONDS).toString())

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

    const toSeconds = (ticks) => Number(BigInt(ticks)) / TICKS_PER_SECOND
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

    // ---- the person answers the one thing the audio could not --------------
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

    // The version before the anchor is still readable, unchanged.
    const readV1 = await callRoute(
      mapRoute.GET,
      `${basePath}/playback-map?reactionTrackId=${REACTION_TRACK}&version=1`,
      { method: 'GET', token, params },
    )
    assert.equal(readV1.status, 200, JSON.stringify(readV1.payload))
    assert.equal(readV1.payload.data.map.mapHash, map.mapHash)
    assert.equal(readV1.payload.data.map.status, 'needs-input')

    // ---- claim 3: the compiled plan renders --------------------------------
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
      workRoot: join(artifactRoot, 'render-work'),
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
      outputSpec: { width: 320, height: 180, fps: compiled.plan.fps },
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

    console.log(
      `E2E-F4.015 react journey: reference ${referenceSeconds.toFixed(3)}s/${referenceProbe.streams.find((stream) => stream.codec_type === 'video').codec_name} ` +
      `vs reaction ${reactionSeconds.toFixed(3)}s (ratio ${(reactionSeconds / referenceSeconds).toFixed(2)}x); ` +
      `detection ${detectionMs} ms over /v1 produced ${pieces.length} pieces [${modes.join('>')}] ` +
      `+ ${map.uncovered.length} uncovered; pause ${spanSeconds(paused).toFixed(3)}s vs known ${PAUSE_SECONDS}s ` +
      `(erro ${(pauseError * FPS).toFixed(1)} frames, tolerancia ${BOUNDARY_TOLERANCE_FRAMES}); ` +
      `commentary ${spanSeconds(commentary).toFixed(3)}s referenceRange=null; ` +
      `replay ${replay.direction}/${replay.discontinuityReason}; seek ${seek.discontinuityReason}; ` +
      `anchor v${resolvedMap.version} status=${resolvedMap.status}; ` +
      `plan ${compiled.plan.durationFrames} frames over ${clips.length} clips from ` +
      `${compiled.plan.sources.length} sources; ` +
      `MP4 ${outputFrames} frames / ${outputSeconds.toFixed(3)}s / ${video.codec_name}+${audio.codec_name} / ` +
      `${video.width}x${video.height} / ${rendered.byteSize} bytes / sha256 ${outputSha256.slice(0, 16)}`,
    )
  },
)

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import ffmpegStatic from 'ffmpeg-static'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const execFileAsync = promisify(execFile)
const FFMPEG = ffmpegStatic ?? 'ffmpeg'
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))

/**
 * E2E-F4.012 — the sync run, from the queue to the rows, through the driver.
 *
 * The integration suite proves the measurement; the journey suites prove the
 * rules. This proves the thing neither can: that `POST .../sync-runs` now has a
 * consumer, that the consumer is a real process started the way CI and an
 * operator start it, and that what it leaves behind survives a round trip
 * through PostgreSQL.
 *
 * Four claims no in-memory fake can make honestly:
 *
 * - **The queue is actually drained by a separate process.** The worker is
 *   spawned as a child running `scripts/run-v2-capture-sync-worker.mjs --once`,
 *   with nothing shared with this test but the database and the artifact root.
 * - **Rehydration is hash-verified.** A coverage row edited behind the
 *   repository must fail the read rather than be served. Faking that proves
 *   nothing, because the fake computes the hash.
 * - **A replay is not a second pass.** Running `--once` again with an empty
 *   queue exits 0 and leaves every row byte-identical.
 * - **BigInt ticks survive.** A tick is 64-bit and a driver that hands it back
 *   as a double would round it silently.
 */

const RUN = process.env.APOLLO_CAPTURE_SYNC_E2E === '1'

const SAMPLE_RATE = 16_000
const FPS = 25
const REFERENCE_SECONDS = 20
const CANDIDATE_SECONDS = 14
const LAG_SECONDS = 1.52
/** The lag in session ticks, which here are frames: 1.52 s at 25 fps. */
const EXPECTED_OFFSET_FRAMES = 38

function lcg(seed) {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 4_294_967_296 - 0.5
  }
}

/** Each second a distinct sweep, all well under the correlation Nyquist. */
function buildReferenceSamples() {
  const samples = new Float64Array(REFERENCE_SECONDS * SAMPLE_RATE)
  for (let second = 0; second < REFERENCE_SECONDS; second += 1) {
    const start = 180 + 13 * ((second * 7) % REFERENCE_SECONDS)
    const span = second % 2 === 0 ? 150 : -150
    for (let sample = 0; sample < SAMPLE_RATE; sample += 1) {
      const t = sample / SAMPLE_RATE
      samples[second * SAMPLE_RATE + sample] =
        0.55 * Math.sin(2 * Math.PI * (start * t + (span * t * t) / 2))
    }
  }
  return samples
}

function buildLaggedSamples(reference) {
  const samples = new Float64Array(CANDIDATE_SECONDS * SAMPLE_RATE)
  const noise = lcg(20_260_907)
  const shift = Math.round(LAG_SECONDS * SAMPLE_RATE)
  for (let sample = 0; sample < samples.length; sample += 1) {
    samples[sample] = (reference[sample + shift] ?? 0) + 0.08 * noise()
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

async function encode(pcmPath, outputPath, durationSeconds) {
  await execFileAsync(FFMPEG, [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:r=${FPS}:d=${durationSeconds}`,
    '-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', pcmPath,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-ar', String(SAMPLE_RATE), '-ac', '1',
    '-shortest', outputPath,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 300_000 })
  const bytes = await readFile(outputPath)
  const metadata = await stat(outputPath)
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: metadata.size,
  }
}

test(
  'E2E-F4.012 a queued sync run is drained by the driver and survives PostgreSQL',
  { skip: RUN ? false : 'set APOLLO_CAPTURE_SYNC_E2E=1 with a migrated V2_DATABASE_URL' },
  async (t) => {
    const { createCaptureSession } = await import('../../src/v2/domain/capture-session.ts')
    const { createTickInterval, createTimebase, rational } = await import(
      '../../src/v2/domain/session-time.ts'
    )
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { requestCaptureSyncService } = await import('../../src/v2/application/capture-session.ts')
    const { PrismaCaptureSessionRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-session-repository.ts'
    )
    const { PrismaCaptureSyncRunRepository } = await import(
      '../../src/v2/infrastructure/prisma/capture-sync-run-repository.ts'
    )
    const { PrismaWorkspaceRepository } = await import(
      '../../src/v2/infrastructure/prisma/workspace-repository.ts'
    )

    const client = new PrismaClient()
    const workspaceId = 'w20-capture-sync-workspace'
    const projectId = 'w20-capture-sync-project'
    const sessionId = 'w20-capture-sync-session'
    const at = (second) => new Date(Date.parse('2029-05-01T09:00:00.000Z') + second * 1_000).toISOString()
    const artifactRoot = await mkdtemp(join(tmpdir(), 'apollo-capture-sync-e2e-'))

    const clean = async () => {
      await client.v2CaptureTrackCoverage.deleteMany({ where: { workspaceId } })
      await client.v2CaptureClockMapPiece.deleteMany({ where: { workspaceId } })
      await client.v2CaptureClockMap.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSyncEvidence.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSyncRun.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionClock.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionHead.deleteMany({ where: { workspaceId } })
      await client.v2CaptureSessionVersion.deleteMany({ where: { workspaceId } })
      await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
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
      }
      await rm(artifactRoot, { recursive: true, force: true }).catch((error) => {
        console.error('artifact root cleanup failed:', error?.message ?? error)
      })
      await client.$disconnect()
    })

    await clean()

    // ---- the two recordings, generated here and never committed -----------
    const mediaDirectory = join(artifactRoot, 'capture')
    await mkdir(mediaDirectory, { recursive: true })
    const reference = buildReferenceSamples()
    await writeFile(join(mediaDirectory, 'reference.pcm'), toPcm(reference))
    await writeFile(join(mediaDirectory, 'camera-b.pcm'), toPcm(buildLaggedSamples(reference)))
    const referenceArtifact = await encode(
      join(mediaDirectory, 'reference.pcm'),
      join(mediaDirectory, 'reference.mp4'),
      REFERENCE_SECONDS,
    )
    const candidateArtifact = await encode(
      join(mediaDirectory, 'camera-b.pcm'),
      join(mediaDirectory, 'camera-b.mp4'),
      CANDIDATE_SECONDS,
    )

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId,
      slug: 'w20-capture-sync-workspace',
      name: 'Wave 20 capture sync',
      status: 'active',
      createdAt: at(0),
    }))
    await client.v2Project.create({
      data: {
        id: projectId,
        workspaceId,
        name: 'Wave 20 capture sync',
        status: 'reviewing-proxy',
        objective: 'discovery',
        format: '9:16',
        locale: 'pt-BR',
        createdByType: 'api-client',
        createdById: 'w20-capture-sync-client',
        createdAt: at(0),
        updatedAt: at(0),
      },
    })
    for (const artifact of [
      { id: 'artifact-reference', key: 'capture/reference.mp4', ...referenceArtifact },
      { id: 'artifact-camera-b', key: 'capture/camera-b.mp4', ...candidateArtifact },
    ]) {
      await client.v2MediaArtifact.create({
        data: {
          id: artifact.id,
          workspaceId,
          artifactKey: artifact.key,
          sha256: artifact.sha256,
          byteSize: BigInt(artifact.byteSize),
          mediaType: 'video',
          container: 'mp4',
          status: 'available',
          createdAt: at(0),
        },
      })
    }

    // One tick is one frame, so the session names its own frame rate through
    // the reference track's timebase — which is what the worker now requires
    // instead of falling back to 30000/1001.
    const timebase = createTimebase(rational(BigInt(1), BigInt(FPS)))
    const track = (input) => ({
      trackId: input.trackId,
      role: input.role,
      device: {
        deviceId: `device-${input.trackId}`,
        recorderId: `recorder-${input.trackId}`,
        make: null,
        model: null,
        serial: null,
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
        coverage: createTickInterval(BigInt(0), BigInt(input.seconds * FPS)),
        streamIndex: 0,
        splitReason: 'single-file',
        evidence: {
          ingestArtifactId: input.artifactId,
          ingestSha256: input.sha256,
          probeHash: 'b'.repeat(64),
          probeSource: 'packet-scan',
          observedAt: at(1),
        },
      }],
    })

    const session = createCaptureSession({
      workspaceId,
      projectId,
      sessionId,
      clock: { timebase, rounding: 'nearest-half-even' },
      referenceTrackId: 'track-camera-main',
      tracks: [
        track({
          trackId: 'track-camera-main',
          role: 'camera-main',
          assetId: 'asset-camera-main',
          artifactId: 'artifact-reference',
          sha256: referenceArtifact.sha256,
          seconds: REFERENCE_SECONDS,
          syncAudioPolicy: 'final-candidate',
          includeInFinalMix: true,
        }),
        track({
          trackId: 'track-camera-alt',
          role: 'camera-alt',
          assetId: 'asset-camera-alt',
          artifactId: 'artifact-camera-b',
          sha256: candidateArtifact.sha256,
          seconds: CANDIDATE_SECONDS,
          syncAudioPolicy: 'sync-only',
          includeInFinalMix: false,
        }),
      ],
      lineage: {
        commandId: 'command-create-session',
        operation: 'create-session',
        actorKind: 'api-client',
        actorId: 'w20-capture-sync-client',
        occurredAt: at(1),
        note: null,
      },
      createdAt: at(1),
    })

    const sessions = new PrismaCaptureSessionRepository(client)
    await sessions.appendVersion({ session, occurredAt: at(1) })

    // The request carries ids and the version fence, and nothing else. No
    // measurement, no offset, no verdict: everything below is derived by the
    // worker from the media and the session.
    const requested = await requestCaptureSyncService({
      repository: sessions,
      runs: new PrismaCaptureSyncRunRepository(client),
      createId: () => 'w20-capture-sync-run',
      clock: () => new Date(at(2)),
    })({
      actor: { workspaceId, clientId: 'w20-capture-sync-client' },
      projectId,
      sessionId,
      baseVersionId: `${sessionId}:v${session.version}`,
      baseHash: session.sessionHash,
      idempotencyKey: 'w20-capture-sync-idempotency',
    })
    assert.equal(requested.replayed, false)
    assert.equal(requested.run.status, 'queued')

    /** The driver, exactly as CI and an operator run it. */
    const runDriverOnce = () => new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['node_modules/tsx/dist/cli.mjs', 'scripts/run-v2-capture-sync-worker.mjs', '--once'],
        {
          cwd: REPOSITORY_ROOT,
          env: {
            ...process.env,
            APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
            APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', (code) => resolve({ code, stdout, stderr }))
    })

    const first = await runDriverOnce()
    assert.equal(first.code, 0, `driver exited ${first.code}: ${first.stderr}`)
    const firstOutcome = JSON.parse(
      first.stdout.split('APOLLO_CAPTURE_SYNC_OUTCOME=')[1]?.split('\n')[0] ?? '{}',
    )
    assert.equal(firstOutcome.claimed, true)
    assert.equal(firstOutcome.settled, true)
    assert.equal(firstOutcome.status, 'succeeded', firstOutcome.failureReason ?? '')
    assert.equal(firstOutcome.coverageDerived, 2)
    assert.equal(firstOutcome.coverageRefused, 0)

    // ---- what the pass left behind ----------------------------------------
    const settledRun = await client.v2CaptureSyncRun.findFirst({ where: { workspaceId, id: 'w20-capture-sync-run' } })
    assert.equal(settledRun.status, 'succeeded')
    assert.notEqual(settledRun.settledAt, null)
    assert.equal(
      (settledRun.resolvedCount ?? 0) + (settledRun.reviewCount ?? 0) + (settledRun.insufficientCount ?? 0),
      1,
      'one verdict per non-reference track',
    )
    assert.equal(settledRun.insufficientCount, 0, 'the two tracks share an acoustic event')

    const coverages = await client.v2CaptureTrackCoverage.findMany({
      where: { workspaceId, sessionId },
      orderBy: { trackId: 'asc' },
    })
    assert.deepEqual(coverages.map((entry) => entry.trackId), ['track-camera-alt', 'track-camera-main'])
    for (const coverage of coverages) {
      assert.equal(coverage.derivedSessionVersion, session.version)
      assert.equal(coverage.derivedReferenceEpoch, session.referenceEpoch)
      assert.equal(coverage.autoEditable, true, 'a packet-scanned part is above the auto-edit floor')
      assert.match(coverage.coverageHash, /^[a-f0-9]{64}$/)
    }
    // The reference camera recorded twenty seconds at 25 fps. Read back as a
    // BigInt, not as a double that happens to look right.
    const referenceCoverage = coverages.find((entry) => entry.trackId === 'track-camera-main')
    assert.equal(referenceCoverage.boundsEnd, BigInt(REFERENCE_SECONDS * FPS))
    assert.equal(referenceCoverage.coveredTicks, BigInt(REFERENCE_SECONDS * FPS))
    assert.equal(referenceCoverage.gapTicks, BigInt(0))

    const evidence = await client.v2CaptureSyncEvidence.findMany({ where: { workspaceId, sessionId } })
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0].trackId, 'track-camera-alt')
    assert.notEqual(evidence[0].outcome, 'insufficient-evidence')
    assert.equal(evidence[0].selectedMethod, 'audio-fingerprint')

    const maps = await client.v2CaptureClockMap.findMany({ where: { workspaceId, sessionId } })
    assert.equal(maps.length, 1)
    assert.equal(maps[0].sourceId, 'asset-camera-alt', 'a clock map is keyed by source asset, coverage by track')
    const pieces = await client.v2CaptureClockMapPiece.findMany({ where: { workspaceId, mapId: maps[0].id } })
    assert.equal(pieces.length, 1)
    const measuredFrames = Number(pieces[0].offsetTicks)
    console.log(
      `E2E-F4.012 capture sync: offset ${measuredFrames} frames against a projected ${EXPECTED_OFFSET_FRAMES}, ` +
      `outcome ${evidence[0].outcome}, ${coverages.length} coverages, run ${settledRun.status}`,
    )
    assert.ok(
      Math.abs(measuredFrames - EXPECTED_OFFSET_FRAMES) <= 1,
      `measured ${measuredFrames} frames against a projected ${EXPECTED_OFFSET_FRAMES}`,
    )

    // ---- a replay is not a second pass ------------------------------------
    const snapshot = async () => JSON.stringify({
      runs: await client.v2CaptureSyncRun.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
      coverages: await client.v2CaptureTrackCoverage.findMany({ where: { workspaceId }, orderBy: { trackId: 'asc' } }),
      maps: await client.v2CaptureClockMap.findMany({ where: { workspaceId }, orderBy: { id: 'asc' } }),
      pieces: await client.v2CaptureClockMapPiece.findMany({ where: { workspaceId }, orderBy: { pieceId: 'asc' } }),
      evidence: await client.v2CaptureSyncEvidence.findMany({ where: { workspaceId }, orderBy: { trackId: 'asc' } }),
    }, (_key, value) => (typeof value === 'bigint' ? `${value}n` : value))

    const before = await snapshot()
    const second = await runDriverOnce()
    assert.equal(second.code, 0, `an empty queue is not a failure: ${second.stderr}`)
    const secondOutcome = JSON.parse(
      second.stdout.split('APOLLO_CAPTURE_SYNC_OUTCOME=')[1]?.split('\n')[0] ?? '{}',
    )
    assert.equal(secondOutcome.claimed, false, 'the settled run must not be claimable again')
    assert.equal(await snapshot(), before, 'a second pass over an empty queue must write nothing')

    // ---- rehydration is hash-verified -------------------------------------
    // A row edited behind the repository is not a stale answer to be served;
    // it is an answer nobody can attribute. The read must refuse it.
    await client.v2CaptureTrackCoverage.update({
      where: { workspaceId_trackId: { workspaceId, trackId: 'track-camera-main' } },
      data: { boundsEnd: BigInt(REFERENCE_SECONDS * FPS) + BigInt(1) },
    })
    let refusal = null
    try {
      await sessions.readCoverage({ workspaceId, trackId: 'track-camera-main' })
    } catch (error) {
      refusal = error
    }
    assert.ok(refusal, 'a tampered coverage row must not be served')
    assert.equal(refusal.code, 'PERSISTENCE_CONFLICT')
  },
)

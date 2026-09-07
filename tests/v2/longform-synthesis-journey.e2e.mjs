import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

/**
 * Journey 6 — a long source becomes a two-minute cut, over two sources.
 *
 * **Two tests running the SAME journey end to end, differing only in how long
 * the master is.** The brief's Journey 6 is "extrair um conteúdo de dois
 * minutos de uma live de duas horas" (`docs/PRD-APOLLO-V2.md:117`), so the
 * headline case is the two-hour one; the ten-minute one is the fast control
 * that says whether a failure is about the source's length or about the
 * journey. Both build a real synthetic master with `lavfi`, probe it and assert
 * the MEASURED duration; neither ever calls a shorter file something it is not.
 *
 * - **The brief's two hours** (`BRIEF`, 7200 s). Its delivered ratio is
 *   `compressionBps: 167`, the number the published API example carries
 *   (`schema-examples.ts:6237`) — which it can only be if the source really is
 *   7200 s.
 * - **The ten-minute control** (`CONTROL`, 600 s), one twelfth of the source.
 *
 * **What this costs: the wall clock varies by machine and by load, so it is
 * given as a range with its N and never as one figure.** Five runs on one
 * developer machine (8 cores, ffmpeg 6.1.1; the spread is other work sharing
 * the CPU) measured, for the two-hour case, 131.9 / 187.8 / 188.1 / 199.2 /
 * 304.6 s of encode and 122.8 / 125.6 / 153.6 / 159.3 / 194.5 s of render; for
 * the control, 10.8 / 13.3 / 13.4 / 15.0 / 15.6 s of encode and 17.2 / 17.5 /
 * 17.5 / 20.7 / 25.2 s of render. The whole suite was 361.4 / 400.1 / 412.8 /
 * 559.1 s over four full runs. Earlier single runs on other machines reported
 * the two-hour encode at 122.3 s and 138.8 s.
 *
 * Those are the runs that had been made when this was written, not a bound: a
 * later run can land outside them, and that is precisely why a spread is quoted
 * instead of a number. An older version of this header did quote one — "Cost:
 * 190 s of encode" — which no run produced. It is gone. **Every run prints the
 * seconds it actually spent**, and those printed numbers are the measurement.
 *
 * What does NOT vary, and is worth more than the seconds: the bytes. Across
 * runs the two-hour master is 550 503 937 bytes / sha256 `471e17c1…` and its
 * cut is 5 930 393 bytes / sha256 `d9282ba0…`; the control's master is
 * 45 873 293 bytes / sha256 `c7230ab0…` and its cut 5 908 494 bytes / sha256
 * `3ab3bdb5…`. Both are 3600 frames of 120.000 s.
 *
 * **Why the two-hour render is possible at all.** It was not, until the commit
 * that added it: `FfmpegEditorialProxyRenderer` gave every clip a
 * `trim=start_frame=…` over one full-length input, so FFmpeg walked all
 * 216 000 frames, reached 11.9 GB of private bytes and was killed by the
 * renderer's own 30-minute timeout — `RENDER_EXECUTION_FAILED
 * { killed: true, signal: 'SIGTERM' }` after 1856.5 s. Each clip now reads its
 * own span through an `-ss`/`-t` input, which writes the same bytes for the
 * control (sha256 `8f11166c…` on the isolated renderer probe, before and after
 * the change) and brings the two-hour render into the minutes above, its
 * FFmpeg peaking at 3.0 GB of private bytes in the run that was sampled.
 *
 * **What is new against `synthesis-render.integration.mjs`.** That suite
 * proves the BRIDGE over real pixels: `createEditorialSynthesis` in memory,
 * `compileSynthesisToDirectedPlan` as a pure function, one render. It never
 * touches PostgreSQL and never crosses `/v1`. This one is the product path:
 *
 * 1. the master is RECORDED as a media artifact — the row, its manifest and
 *    the project link — whose sha256, byte size and probe were measured from
 *    the file rather than declared;
 * 2. the StoryPlan is created through `POST /v1/projects/{id}/story-plans`;
 * 3. the synthesis is created through
 *    `POST /v1/projects/{id}/editorial-syntheses`, whose service refuses to
 *    accept the caller's own StoryPlan and fetches it instead, so the claim
 *    check runs against rows;
 * 4. it is read back through `GET .../editorial-syntheses/{id}`, which
 *    re-derives the stored hash and refuses the row if it does not match;
 * 5. `compileSynthesisRenderPlanService` resolves the render sources from the
 *    project's own media links — the durations the renderer will use are the
 *    ones ffprobe measured at ingest — and persists a renderable plan
 *    snapshot;
 * 6. the plan that is RENDERED is the one read back out of
 *    `renderable_plan_snapshots`, not the one held in memory;
 * 7. and the output is measured: frame count, duration, frame rate, video and
 *    audio codecs, sample rate, byte size, sha256, and a pixel probe at the
 *    middle of every clip.
 *
 * All seven steps run for both sources; the two tests differ in nothing but
 * the length of the master and the six minutes the cut selects out of it.
 *
 * **What no object store holds.** The bytes reach the renderer from the local
 * fixture path — `sources: [{ path: masterPath }]`, a file inside this suite's
 * own `mkdtemp`. The three rows above carry an `artifactKey` that names where
 * such an artifact WOULD live; nothing writes it there, so no `materialize` /
 * `release` and no download path is exercised here. The CI step lives in the
 * `quality` job, which has PostgreSQL and no MinIO. Said plainly because the
 * alternative is to imply a storage round trip that did not happen.
 *
 * **The falsification the pixels pay for.** The master carries a marker for
 * every minute it has, up to 120: two bands, one for the ten-minute decade and
 * one for the minute inside it, so the pair identifies the minute exactly. The
 * six selected windows come from six non-consecutive minutes. A bridge that
 * took the first two minutes of the master, or that ignored `sourceInFrame`,
 * renders a perfectly valid MP4 of exactly the right length. Only the colours
 * say it took the wrong spans.
 *
 * Nothing is committed: the master, the render and the work root live in a
 * `mkdtemp` removed in `t.after`.
 */

const RUN = process.env.APOLLO_LONGFORM_SYNTHESIS_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_LONGFORM_SYNTHESIS_E2E=1 with a migrated V2_DATABASE_URL and ffmpeg'

/**
 * One value for the clients this journey issues and for the environment the
 * routes check them against. Pinning the client to `sandbox` while leaving the
 * environment to `??=` is what made the phase-gate journey answer 401
 * AUTH_INVALID in CI, which sets `APOLLO_API_ENVIRONMENT: production` for the
 * whole job, while passing on a developer machine where nothing sets it.
 */
const API_ENVIRONMENT = process.env.APOLLO_API_ENVIRONMENT ?? 'sandbox'
process.env.APOLLO_API_ENVIRONMENT = API_ENVIRONMENT

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const FPS = 30
const WIDTH = 320
const HEIGHT = 180
const TARGET_MS = 120_000
/** Each marker band is this tall; the two of them stack at the top of frame. */
const BAND_HEIGHT = 40
/** The published contract's own derivation: 120 s of the source, in basis points. */
const compressionBpsOf = (masterSeconds) =>
  Math.round((TARGET_MS * 10_000) / (masterSeconds * 1_000))

/**
 * A minute of the master, written as two colours.
 *
 * One colour per minute would need 120 well-separated colours; twelve decades
 * and ten units need twenty-two, and the pair identifies the minute exactly.
 * The closest pair inside either palette is 127 units apart in RGB (yellow and
 * orange), so the decision boundary is 63.5 and the tolerance below has room
 * that was measured rather than guessed.
 */
const rgb = (hex) => [
  Number.parseInt(hex.slice(2, 4), 16),
  Number.parseInt(hex.slice(4, 6), 16),
  Number.parseInt(hex.slice(6, 8), 16),
]
const marker = (name, hex) => Object.freeze({ name, hex, rgb: rgb(hex) })

/** The ten-minute decade, 0..11. */
const DECADES = Object.freeze([
  marker('red', '0xFF0000'), marker('green', '0x00FF00'), marker('blue', '0x0000FF'),
  marker('yellow', '0xFFFF00'), marker('magenta', '0xFF00FF'), marker('cyan', '0x00FFFF'),
  marker('orange', '0xFF8000'), marker('violet', '0x8000FF'), marker('spring', '0x00FF80'),
  marker('grey', '0x808080'), marker('white', '0xFFFFFF'), marker('brown', '0x804000'),
])
/** The minute inside the decade, 0..9. */
const UNITS = Object.freeze(DECADES.slice(0, 10))

/**
 * How far a sampled band may sit from the colour it is read as.
 *
 * How decisive a marker reading has to be, as a ratio and not as a distance.
 *
 * It used to be an absolute distance of 20, chosen because the closest pair in
 * either palette is 127 apart (so the decision boundary is 63.5) and the drift
 * measured on the author's machine was 1.0. That number did not survive a
 * different encoder: a GitHub runner read the same frames 25.0 away and the
 * assertion failed, while the exact-minute equality beside it passed — the
 * identification was never ambiguous, only the calibration was local.
 *
 * A ratio says what the assertion means without naming a machine's noise
 * floor: the winning marker must be at least five times closer than the one
 * that came second. A frame that blended two markers sits near 1.0 and is
 * still refused; an encoder that shifts every colour equally does not move the
 * ratio at all.
 */
const MARKER_AMBIGUITY_CEILING = 0.2

/**
 * Six windows over a source, together exactly 120 s, each wholly inside one
 * minute and never in consecutive minutes.
 *
 * The claim, its qualifier and its proof context are carried by three
 * DIFFERENT windows on purpose. `assertClaimContextPreserved` refuses a cut
 * that keeps an assertion and drops what qualifies or supports it, and a
 * fixture that put all three in one range would never exercise that.
 */
const windowsOver = (minutes, offsets) => Object.freeze(minutes.map((minute, index) => {
  const [fromSecond, toSecond] = offsets[index]
  return Object.freeze({
    rangeId: `range-${index + 1}`,
    startMs: (minute * 60 + fromSecond) * 1_000,
    endMs: (minute * 60 + toSecond) * 1_000,
    minute,
    claimIds: index === 2 ? ['claim-1'] : [],
    qualifierIds: index === 3 ? ['qualifier-1'] : [],
    proofContextIds: index === 4 ? ['proof-1'] : [],
  })
}))

/** Six spans inside their minutes: 25 + 18 + 22 + 15 + 25 + 15 = 120 s. */
const OFFSETS = Object.freeze([[30, 55], [30, 48], [10, 32], [10, 25], [20, 45], [10, 25]])

/**
 * The brief's source: two hours, six far-apart minutes.
 *
 * The minutes are spread across five of the twelve decade bands on purpose, so
 * the decade half of the marker is exercised as well as the unit half; a cut
 * that landed 60 minutes away would read the right unit and the wrong decade.
 */
const BRIEF = Object.freeze({
  masterSeconds: 7_200,
  windows: windowsOver([0, 17, 38, 59, 83, 116], OFFSETS),
})

/**
 * The fast control: ten minutes, six non-consecutive minutes.
 *
 * Same journey, same assertions, one twelfth of the encode. It is what says
 * whether a failure in the two-hour case is about the length of the source or
 * about the journey, and it is the one a hurried reader can re-run.
 */
const CONTROL = Object.freeze({
  masterSeconds: 600,
  windows: windowsOver([0, 2, 4, 5, 7, 9], OFFSETS),
})

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

/**
 * testsrc2 for two hours, with two marker bands that name the minute.
 *
 * Twenty-two `drawbox` filters, not 240: the decade band needs one span of ten
 * minutes each, and the unit band repeats every ten minutes, so `mod(t,600)`
 * gives one filter per unit colour instead of one per minute. What this costs
 * is machine-dependent and is printed by each run rather than asserted here;
 * the header carries the spread that has been measured for it.
 */
function buildMaster(path, masterSeconds) {
  const decades = DECADES
    .slice(0, Math.ceil(masterSeconds / 600))
    .map((entry, decade) =>
      `drawbox=x=0:y=0:w=${WIDTH}:h=${BAND_HEIGHT}:color=${entry.hex}@1:t=fill:`
      + `enable='between(t,${decade * 600},${(decade + 1) * 600})'`)
  const units = UNITS.map((entry, unit) =>
    `drawbox=x=0:y=${BAND_HEIGHT}:w=${WIDTH}:h=${BAND_HEIGHT}:color=${entry.hex}@1:t=fill:`
    + `enable='between(mod(t,600),${unit * 60},${(unit + 1) * 60})'`)
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${masterSeconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${masterSeconds}`,
    '-filter_complex', `[0:v]${[...decades, ...units].join(',')}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-ar', '48000',
    path,
  ], { windowsHide: true, timeout: 40 * 60_000 })
}

function probeStreams(path, countFrames = false) {
  return JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error',
    ...(countFrames ? ['-count_frames'] : []),
    '-show_entries',
    countFrames
      ? 'stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,nb_read_frames,duration'
      : 'stream=codec_type,codec_name,width,height,r_frame_rate,duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).streams
}

/**
 * The average colour of one marker band at one instant of a file.
 *
 * The crop sits inside the band rather than on it: five pixels of margin at
 * each edge keep the chroma subsampling of the band above or below out of the
 * average.
 */
function bandColourAt(path, second, top) {
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', `crop=${WIDTH}:${BAND_HEIGHT - 10}:0:${top + 5},scale=1:1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return [raw[0], raw[1], raw[2]]
}

function nearestMarker(colour, palette) {
  let best = 0
  let bestDistance = Infinity
  let runnerUpDistance = Infinity
  for (const [index, entry] of palette.entries()) {
    const measured = Math.sqrt(
      colour.reduce((total, value, channel) => total + (value - entry.rgb[channel]) ** 2, 0),
    )
    if (measured < bestDistance) {
      runnerUpDistance = bestDistance
      bestDistance = measured
      best = index
    } else if (measured < runnerUpDistance) {
      runnerUpDistance = measured
    }
  }
  return { index: best, distance: bestDistance, runnerUpDistance }
}

/** Which minute of the master a frame carries, read off its two bands. */
function minuteAt(path, second) {
  const decade = nearestMarker(bandColourAt(path, second, 0), DECADES)
  const unit = nearestMarker(bandColourAt(path, second, BAND_HEIGHT), UNITS)
  return {
    minute: decade.index * 10 + unit.index,
    distance: Math.max(decade.distance, unit.distance),
    // How decisive the reading was: the worse of the two bands' ratios between
    // the marker that won and the marker that came second.
    ambiguity: Math.max(
      decade.distance / decade.runnerUpDistance,
      unit.distance / unit.runnerUpDistance,
    ),
  }
}

async function callRoute(NextRequest, module, {
  method, path, params = {}, body, authorization, idempotencyKey,
}) {
  const headers = new Headers()
  if (authorization) headers.set('authorization', authorization)
  if (idempotencyKey) headers.set('idempotency-key', idempotencyKey)
  const init = { method, headers }
  if (body !== undefined) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(body)
  }
  const request = new NextRequest(new URL(`http://apollo.invalid${path}`), init)
  const response = await module[method](request, { params: Promise.resolve(params) })
  const text = await response.text()
  return { status: response.status, text, payload: text.length > 0 ? JSON.parse(text) : null }
}

/**
 * The whole product path over one synthetic master.
 *
 * There is one body for both tests on purpose: ingest, the StoryPlan, the
 * synthesis, the read-back, the compile, the persisted snapshot and the render
 * are the same code for the two-hour master and for the ten-minute control, so
 * the only thing that separates them is the source and the minutes selected
 * from it. A step that only worked for short sources could not hide here.
 */
async function driveJourney(t, {
  masterSeconds: MASTER_SECONDS,
  windows: WINDOWS,
  label,
}) {
    const MINUTES = MASTER_SECONDS / 60
    const EXPECTED_COMPRESSION_BPS = compressionBpsOf(MASTER_SECONDS)
    const { NextRequest } = await import('next/server')
    const { createApiClientService } = await import(
      '../../src/v2/application/create-api-client.ts'
    )
    const { PrismaApiClientRepository } = await import(
      '../../src/v2/infrastructure/prisma/api-client-repository.ts'
    )
    const { nodeApiCredentialCrypto } = await import(
      '../../src/v2/infrastructure/security/api-credential.ts'
    )
    const { PrismaEditorialSynthesisRepository } = await import(
      '../../src/v2/infrastructure/prisma/editorial-synthesis-repository.ts'
    )
    const { PrismaRenderSourceRepository } = await import(
      '../../src/v2/infrastructure/prisma/render-source-repository.ts'
    )
    const { PrismaRenderablePlanSnapshotRepository } = await import(
      '../../src/v2/infrastructure/prisma/renderable-plan-snapshot-repository.ts'
    )
    const { compileSynthesisRenderPlanService } = await import(
      '../../src/v2/application/compile-synthesis-to-directed-plan.ts'
    )
    const { createMediaArtifactManifest } = await import(
      '../../src/v2/domain/media-artifact.ts'
    )
    const { createMediaColorProbe } = await import('../../src/v2/domain/color-and-export.ts')
    const { createColorPipelineCompilation } = await import(
      '../../src/v2/domain/color-pipeline-compilation.ts'
    )
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')
    const { validateDirectedEditPlan } = await import('../../src/v2/domain/director-run.ts')
    const { STORY_GOLDEN_FIXTURES } = await import('../../src/v2/domain/story-plan.ts')
    const { FfmpegEditorialProxyRenderer } = await import(
      '../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts'
    )

    const storyPlansRoute = await import(
      '../../src/app/v1/projects/[projectId]/story-plans/route.ts'
    )
    const synthesesRoute = await import(
      '../../src/app/v1/projects/[projectId]/editorial-syntheses/route.ts'
    )
    const synthesisRoute = await import(
      '../../src/app/v1/projects/[projectId]/editorial-syntheses/[synthesisId]/route.ts'
    )

    const suffix = randomUUID().slice(0, 8)
    const workspaceId = `lfs-${suffix}`
    const projectId = `lfs-project-${suffix}`
    const versionId = `lfs-version-${suffix}`
    const artifactId = `lfs-master-${suffix}`
    const synthesisId = `lfs-synthesis-${suffix}`
    const createdAt = new Date('2029-07-01T09:00:00.000Z')

    const client = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-longform-synthesis-'))
    const masterPath = join(root, 'master.mp4')
    const renderer = new FfmpegEditorialProxyRenderer({
      workRoot: join(root, 'work'),
      ffmpegPath,
    })
    const operationId = `lfs-render-${suffix}`

    const clean = async () => {
      for (const table of [
        'v2RenderablePlanSnapshot',
        'v2EditorialSynthesisJoin',
        'v2EditorialSynthesisRange',
        'v2EditorialSynthesis',
        'v2StoryPlan',
        'v2ProjectMediaAsset',
        'v2MediaArtifactManifest',
        'v2MediaArtifact',
      ]) {
        await client[table].deleteMany({ where: { workspaceId } })
      }
      await client.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
      await client.v2ProjectVersion.deleteMany({ where: { workspaceId } })
      await client.v2ProjectSnapshot.deleteMany({ where: { workspaceId } })
      await client.v2Project.deleteMany({ where: { workspaceId } })
      await client.v2ApiClient.deleteMany({ where: { workspaceId } })
      await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
    }

    t.after(async () => {
      // Every teardown reports instead of rethrowing: an ffmpeg work root that
      // would not go is not a failed measurement, and turning it into one
      // hides the numbers above it.
      await renderer.cleanup(operationId).catch((error) => {
        console.error('renderer cleanup reported:', error?.message ?? error)
      })
      await rm(root, { recursive: true, force: true }).catch((error) => {
        console.error('fixture cleanup reported:', error?.message ?? error)
      })
      try {
        await clean()
      } catch (error) {
        console.error('database cleanup reported:', error?.message ?? error)
      }
      await client.$disconnect()
    })

    // ---- the master, built and then MEASURED -----------------------------
    const encodeStartedAt = Date.now()
    buildMaster(masterPath, MASTER_SECONDS)
    const encodeSeconds = (Date.now() - encodeStartedAt) / 1_000
    const masterStreams = probeStreams(masterPath)
    const masterVideo = masterStreams.find((stream) => stream.codec_type === 'video')
    const masterAudio = masterStreams.find((stream) => stream.codec_type === 'audio')
    const masterSeconds = Number(masterVideo.duration)
    assert.ok(
      masterSeconds >= MASTER_SECONDS - 1,
      `the master must be ${MASTER_SECONDS}s; ffprobe measured ${masterSeconds}s`,
    )
    // Measured, not asked for: an encode that quietly produced a different
    // codec or size would change what every later assertion is about.
    assert.equal(masterVideo.codec_name, 'h264')
    assert.equal(masterAudio.codec_name, 'aac')
    assert.equal(Number(masterVideo.width), WIDTH)
    assert.equal(Number(masterVideo.height), HEIGHT)
    const masterBytes = await readFile(masterPath)
    const masterSha256 = createHash('sha256').update(masterBytes).digest('hex')
    const masterByteSize = (await stat(masterPath)).size

    // The marker really names the minute in the FILE, not only in the
    // filtergraph this suite wrote: the first minute, every minute the cut
    // will select, and the last one.
    for (const minute of [...new Set([0, ...WINDOWS.map((window) => window.minute), MINUTES - 1])]) {
      const measured = minuteAt(masterPath, minute * 60 + 30)
      assert.equal(measured.minute, minute, `minute ${minute} of the master carries the wrong marker`)
      assert.ok(
        measured.ambiguity < MARKER_AMBIGUITY_CEILING,
        `minute ${minute} of the master reads only `
        + `${(1 / measured.ambiguity).toFixed(1)}x closer to its own marker than to the next `
        + `(absolute drift ${measured.distance.toFixed(1)})`,
      )
    }

    // ---- the world the routes need ---------------------------------------
    await clean()
    await client.v2Workspace.create({
      data: {
        id: workspaceId, slug: workspaceId, name: 'long-form synthesis journey',
        status: 'active', createdAt, updatedAt: createdAt,
      },
    })
    const caller = await createApiClientService({
      repository: new PrismaApiClientRepository(client),
      credentialCrypto: nodeApiCredentialCrypto,
      clock: () => createdAt,
    })({
      id: `lfs-client-${suffix}`,
      workspaceId,
      name: 'long-form synthesis journey',
      environment: API_ENVIRONMENT,
      scopes: ['projects:read', 'projects:write'],
    })
    const authorization = `Bearer ${caller.token}`
    await client.v2Project.create({
      data: {
        id: projectId, workspaceId, name: 'long-form synthesis journey',
        status: 'reviewing-proxy', objective: 'discovery', format: '16:9', locale: 'pt-BR',
        createdByType: 'api-client', createdById: caller.client.id,
        createdAt, updatedAt: createdAt,
      },
    })
    const snapshotIds = {}
    for (const kind of ['brief', 'edit-plan', 'policies']) {
      snapshotIds[kind] = `lfs-snapshot-${kind}-${suffix}`
      await client.v2ProjectSnapshot.create({
        data: {
          id: snapshotIds[kind], workspaceId, projectId, kind, schemaVersion: 1,
          contentJson: JSON.stringify({ kind }), contentHash: '1'.repeat(64), createdAt,
        },
      })
    }
    await client.v2ProjectVersion.create({
      data: {
        id: versionId, workspaceId, projectId, sequence: 1,
        briefSnapshotId: snapshotIds.brief,
        editPlanSnapshotId: snapshotIds['edit-plan'],
        policiesSnapshotId: snapshotIds.policies,
        baseHash: '2'.repeat(64), createdBy: caller.client.id, createdAt,
      },
    })
    await client.v2Project.update({
      where: { id: projectId },
      data: { currentVersionId: versionId },
    })

    // The artifact carries the numbers ffprobe returned, never the numbers the
    // encode was asked for: the compile step reads `durationSeconds` from here
    // and refuses a source nobody probed.
    const manifest = createMediaArtifactManifest({
      artifactKey: `workspaces/${workspaceId}/sources/master.mp4`,
      artifactSha256: masterSha256,
      byteSize: masterByteSize,
      mediaType: 'video',
      container: 'mp4',
      recipe: { id: 'source-master', version: '1.0.0', parameters: {} },
      sources: [],
      probe: {
        width: Number(masterVideo.width),
        height: Number(masterVideo.height),
        fps: FPS,
        duration: masterSeconds,
      },
    })
    await client.v2MediaArtifact.create({
      data: {
        id: artifactId, workspaceId,
        artifactKey: manifest.artifact.artifactKey, sha256: masterSha256,
        byteSize: BigInt(masterByteSize), mediaType: 'video', container: 'mp4',
        status: 'available', createdAt,
      },
    })
    await client.v2MediaArtifactManifest.create({
      data: {
        id: `manifest-${artifactId}`, workspaceId, artifactId,
        schemaVersion: manifest.schemaVersion, manifestHash: manifest.manifestHash,
        recipeId: manifest.recipe.id, recipeVersion: manifest.recipe.version,
        parametersHash: manifest.recipe.parametersHash,
        manifestJson: JSON.stringify(manifest), createdAt,
      },
    })
    await client.v2ProjectMediaAsset.create({
      data: {
        id: randomUUID(), workspaceId, projectId, artifactId,
        role: 'source-master', originalFileName: 'master.mp4', createdAt,
      },
    })

    // ---- the StoryPlan, through /v1 --------------------------------------
    const { schemaVersion: _ignoredSchemaVersion, ...golden } = STORY_GOLDEN_FIXTURES.linear
    // `productionMode` is deliberately absent. `createStoryPlan` (v3) asserts
    // it is `undefined` and reports "Hybrid production must use StoryPlan v4"
    // for ANY other value, so a plain source-driven label is refused with a
    // sentence about hybrids. Reported as a defect; the journey supplies what
    // the domain accepts.
    const planBody = {
      ...golden,
      // A two-minute target, and blocks long enough to reach it: the golden
      // fixture is a twelve-second reel, and the domain checks the synthesis
      // against the plan it was built from.
      targetDurationMs: { min: 100_000, max: 140_000 },
      blocks: golden.blocks.map((block) => ({
        ...block,
        durationTargetMs: { min: 20_000, ideal: 30_000, max: 45_000 },
      })),
    }
    const storyPlan = await callRoute(NextRequest, storyPlansRoute, {
      method: 'POST',
      path: `/v1/projects/${projectId}/story-plans`,
      params: { projectId },
      body: { projectVersionId: versionId, plan: planBody },
      authorization,
      idempotencyKey: `lfs-story-${suffix}`,
    })
    assert.equal(storyPlan.status, 201, storyPlan.text)
    const storyPlanId = storyPlan.payload.data.storyPlan.id

    // ---- the synthesis, through /v1 --------------------------------------
    const lineage = {
      sourceArtifactId: artifactId,
      sourceArtifactSha256: masterSha256,
      sourceManifestId: `manifest-${artifactId}`,
      sourceManifestHash: manifest.manifestHash,
      indexRunId: `lfs-index-${suffix}`,
      momentId: `lfs-moment-${suffix}`,
      momentHash: '3'.repeat(64),
      evaluationId: `lfs-evaluation-${suffix}`,
      evaluationHash: '4'.repeat(64),
    }
    const ranges = WINDOWS.map((window) => ({
      rangeId: window.rangeId,
      startMs: window.startMs,
      endMs: window.endMs,
      lineage,
      rightsSnapshotId: `lfs-rights-${suffix}`,
      rightsStatus: 'approved',
      consentStatus: 'approved',
      claimIds: window.claimIds,
      qualifierIds: window.qualifierIds,
      proofContextIds: window.proofContextIds,
    }))
    const created = await callRoute(NextRequest, synthesesRoute, {
      method: 'POST',
      path: `/v1/projects/${projectId}/editorial-syntheses`,
      params: { projectId },
      body: {
        synthesisId,
        objective: `two-minute cut of a ${MASTER_SECONDS}s master`,
        targetDurationMs: TARGET_MS,
        toleranceMs: 1_000,
        sourceDurationMs: MASTER_SECONDS * 1_000,
        frameRate: `${FPS}/1`,
        storyPlanId,
        editPlanId: `lfs-edit-plan-${suffix}`,
        ranges,
        joins: ranges.slice(0, -1).map((range, index) => ({
          beforeRangeId: range.rangeId,
          afterRangeId: ranges[index + 1].rangeId,
          kind: 'spliced',
          justification: `window ${index + 1} closes the thought that window ${index + 2} opens`,
          continuityRisks: ['argument'],
        })),
      },
      authorization,
    })
    assert.equal(created.status, 201, created.text)
    const summary = created.payload.data.synthesis
    assert.equal(summary.synthesizedDurationMs, TARGET_MS)
    assert.equal(summary.sourceDurationMs, MASTER_SECONDS * 1_000)
    assert.equal(summary.rangeCount, WINDOWS.length)
    assert.equal(summary.spliceCount, WINDOWS.length - 1)
    assert.equal(summary.chronologyPreserved, true)
    assert.equal(
      summary.droppedMs,
      MASTER_SECONDS * 1_000 - TARGET_MS,
      'the cut must account for every millisecond it left on the floor',
    )
    // 167 basis points: the ratio the published API example carries for this
    // exact case. A source shorter than two hours cannot produce it.
    assert.equal(
      summary.compressionBps,
      EXPECTED_COMPRESSION_BPS,
      `120 s of ${MASTER_SECONDS} s is ${EXPECTED_COMPRESSION_BPS} bps, not ${summary.compressionBps}`,
    )

    // Read back: the repository re-derives the stored hash and refuses a row
    // that does not match, so a successful read is a verified hydration.
    const read = await callRoute(NextRequest, synthesisRoute, {
      method: 'GET',
      path: `/v1/projects/${projectId}/editorial-syntheses/${synthesisId}`,
      params: { projectId, synthesisId },
      authorization,
    })
    assert.equal(read.status, 200, read.text)
    assert.equal(read.payload.data.synthesis.synthesisHash, summary.synthesisHash)
    assert.deepEqual(
      read.payload.data.synthesis.ranges.map((range) => [range.startMs, range.endMs]),
      WINDOWS.map((window) => [window.startMs, window.endMs]),
      'the stored ranges are not the ones the request declared',
    )

    // ---- the bridge, over the stored aggregate ---------------------------
    const syntheses = new PrismaEditorialSynthesisRepository(client)
    const snapshots = new PrismaRenderablePlanSnapshotRepository(client)
    const compiled = await compileSynthesisRenderPlanService({
      syntheses,
      sources: new PrismaRenderSourceRepository(client),
      snapshots,
      clock: () => createdAt,
    })({
      workspaceId,
      projectId,
      synthesisId,
      projectVersionId: versionId,
      objective: 'discovery',
    })
    assert.equal(compiled.replayed, false)

    // The plan that gets rendered is the one PostgreSQL returned, so a
    // serialization that lost a frame index would render the wrong span.
    const storedSnapshot = await snapshots.readLatestForSource({
      workspaceId,
      origin: 'multi-range-synthesis',
      sourceId: synthesisId,
    })
    assert.ok(storedSnapshot, 'the compile step persisted no renderable plan snapshot')
    assert.equal(storedSnapshot.planHash, compiled.planHash)
    assert.equal(storedSnapshot.sourceHash, summary.synthesisHash)
    assert.equal(storedSnapshot.origin, 'multi-range-synthesis')
    assert.equal(storedSnapshot.clipCount, WINDOWS.length)
    const plan = storedSnapshot.plan
    validateDirectedEditPlan(plan)
    const clips = plan.videoTracks[0].clips
    assert.equal(clips.length, WINDOWS.length)
    const expectedFrames = WINDOWS.reduce(
      (total, window) => total + ((window.endMs - window.startMs) / 1_000) * FPS,
      0,
    )
    assert.equal(plan.durationFrames, expectedFrames)
    // Every clip starts where its window does. This is the assertion the
    // render's pixels pay for again further down, and it is the one that still
    // holds for a source the renderer cannot serve.
    assert.deepEqual(
      clips.map((clip) => [clip.sourceInFrame, clip.sourceOutFrame]),
      WINDOWS.map((window) => [
        (window.startMs / 1_000) * FPS,
        (window.endMs / 1_000) * FPS,
      ]),
      'the compiled clips do not point at the windows the synthesis declared',
    )
    // And the master really carries those minutes at those frames — read off
    // the file, so a plan pointing at the right frames of the wrong recording
    // is still caught.
    const sourceMinutes = WINDOWS.map((window) =>
      minuteAt(masterPath, (window.startMs + window.endMs) / 2_000))
    assert.deepEqual(
      sourceMinutes.map((entry) => entry.minute),
      WINDOWS.map((window) => window.minute),
      'the master does not carry the declared minutes at the declared spans',
    )

    // ---- the render, and the file it wrote -------------------------------
    const implementation = (provider, parameters) => ({
      provider, version: 'v1', parameters, parametersHash: calculateCanonicalHash(parameters),
    })
    const probe = createMediaColorProbe({
      id: `probe-${artifactId}`,
      workspaceId,
      artifactId,
      manifestId: `manifest-${artifactId}`,
      detection: {
        state: 'ready', metadata: COLOR_METADATA, pixelFormat: 'yuv420p', hdrMode: 'sdr',
      },
      producer: { provider: 'ffprobe', version: 'json-v1', binaryDigest: '9'.repeat(64) },
      createdAt: createdAt.toISOString(),
    })
    const renderStartedAt = Date.now()
    const rendered = await renderer.render({
      operationId,
      renderKind: 'final',
      sources: [{
        artifactId,
        path: masterPath,
        mediaType: 'video',
        // Identity on purpose: this journey measures WHICH SPAN came out, and
        // a grade would move the marker colours the assertions read back.
        colorPipelineCompilation: createColorPipelineCompilation({
          id: `compilation-${artifactId}`,
          workspaceId,
          projectId,
          sourceArtifactId: artifactId,
          sourceManifestId: `manifest-${artifactId}`,
          probe,
          outputMetadata: COLOR_METADATA,
          createdByClientId: caller.client.id,
          createdAt: createdAt.toISOString(),
          stages: [
            { id: 'technical-rec709', kind: 'technical', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
            { id: 'match-bypass', kind: 'match', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-match', { mode: 'bypass' }) },
            { id: 'creative-none', kind: 'creative-lut', version: 'v1', enabled: false, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('apollo-lut', { mode: 'none' }) },
            { id: 'output-rec709', kind: 'output', version: 'v1', enabled: true, input: COLOR_METADATA, output: COLOR_METADATA, implementation: implementation('ffmpeg-zscale', { mode: 'identity' }) },
          ],
        }),
      }],
      lutPaths: {},
      clips,
      audioTimelineHash: plan.audioTimelineHash,
      fps: plan.fps,
      format: '16:9',
      outputSpec: { width: WIDTH, height: HEIGHT, fps: FPS },
      transitions: plan.transitions,
      composition: { foregroundScale: 1, verticalPosition: 0.5 },
    })

    const renderSeconds = (Date.now() - renderStartedAt) / 1_000
    const outStreams = probeStreams(rendered.outputPath, true)
    const outVideo = outStreams.find((stream) => stream.codec_type === 'video')
    const outAudio = outStreams.find((stream) => stream.codec_type === 'audio')
    const countedFrames = Number(outVideo.nb_read_frames)
    const measuredSeconds = Number(outVideo.duration)
    const outBytes = await readFile(rendered.outputPath)
    const outSha256 = createHash('sha256').update(outBytes).digest('hex')

    assert.equal(countedFrames, expectedFrames, 'the counted frames are the sum of the windows')
    assert.ok(
      Math.abs(measuredSeconds - TARGET_MS / 1_000) <= 1 / FPS,
      `the render measured ${measuredSeconds}s against a 120s target`,
    )
    assert.ok(
      measuredSeconds < masterSeconds / 4,
      'the output is nearly as long as the source, so nothing was actually cut',
    )
    assert.equal(outVideo.codec_name, 'h264')
    assert.equal(Number(outVideo.width), WIDTH)
    assert.equal(Number(outVideo.height), HEIGHT)
    // The frame rate is asserted rather than implied by the frame count: a
    // render at 25 fps over a longer timeline counts the same frames.
    assert.equal(outVideo.r_frame_rate, `${FPS}/1`)
    assert.ok(outAudio, 'the cut must carry audio')
    assert.equal(outAudio.codec_name, 'aac')
    // A resample to 8 kHz is inaudible in a frame count and obvious here.
    assert.equal(Number(outAudio.sample_rate), 48_000)
    assert.ok(
      Math.abs(Number(outAudio.duration) - measuredSeconds) <= 1 / FPS,
      `A/V drift: video ${measuredSeconds}s, audio ${outAudio.duration}s`,
    )
    assert.equal(outSha256, rendered.sha256, 'the digest the renderer reported is not the file it wrote')
    assert.equal((await stat(rendered.outputPath)).size, rendered.byteSize)

    // ---- the pixels say which minutes came out ---------------------------
    const identified = []
    const distances = []
    for (const [index, clip] of clips.entries()) {
      const middle = (clip.timelineInFrame + clip.timelineOutFrame) / 2 / FPS
      const measured = minuteAt(rendered.outputPath, middle)
      identified.push(measured.minute)
      distances.push(measured.distance)
      assert.equal(
        measured.minute,
        WINDOWS[index].minute,
        `output clip ${index} at ${middle}s carries minute ${measured.minute}'s marker, not minute ${WINDOWS[index].minute}'s`,
      )
      assert.ok(
        measured.ambiguity < MARKER_AMBIGUITY_CEILING,
        `the marker read at this frame is only ${(1 / measured.ambiguity).toFixed(1)}x closer to `
        + `minute ${measured.minute}'s colour than to the next marker's, under the `
        + `${(1 / MARKER_AMBIGUITY_CEILING).toFixed(0)}x this reading has to clear `
        + `(absolute drift ${measured.distance.toFixed(1)})`,
      )
    }
    assert.deepEqual(identified, WINDOWS.map((window) => window.minute))

    console.log(
      `E2E-F4.016 long-form synthesis journey (${label}): master ${masterSeconds.toFixed(2)}s `
      + `(${masterVideo.codec_name}/${masterAudio.codec_name} ${masterVideo.width}x${masterVideo.height} `
      + `${masterByteSize} bytes sha256 ${masterSha256.slice(0, 16)}, encoded in ${encodeSeconds.toFixed(1)}s) `
      + `-> synthesis ${synthesisId} `
      + `${summary.rangeCount} ranges ${summary.droppedMs}ms dropped compression ${summary.compressionBps}bps `
      + `hash ${summary.synthesisHash.slice(0, 12)} -> plan ${plan.id} ${plan.durationFrames} frames `
      + `hash ${compiled.planHash.slice(0, 12)} -> MP4 ${measuredSeconds.toFixed(3)}s `
      + `rendered in ${renderSeconds.toFixed(1)}s, `
      + `${countedFrames} frames (expected ${expectedFrames}) ${outVideo.codec_name}/${outAudio.codec_name}@${outAudio.sample_rate} `
      + `${WIDTH}x${HEIGHT}@${outVideo.r_frame_rate} ${rendered.byteSize} bytes sha256 ${outSha256.slice(0, 16)}; `
      + `minutes [${identified.join(',')}] max colour distance ${Math.max(...distances).toFixed(1)}`,
    )
}

test(
  'E2E-F4.016 a ten-minute master becomes a persisted two-minute cut whose MP4 carries the minutes it selected',
  { skip: SKIP, timeout: 45 * 60_000 },
  (t) => driveJourney(t, { ...CONTROL, label: 'ten-minute control' }),
)

test(
  "E2E-F4.016 the brief's two-hour master becomes a persisted two-minute cut whose MP4 carries the minutes it selected",
  { skip: SKIP, timeout: 45 * 60_000 },
  (t) => driveJourney(t, { ...BRIEF, label: 'brief two-hour source' }),
)

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
 * Journey 6 — a long source becomes a two-minute cut, and the MP4 is read back.
 *
 * **What the source really is.** Ten minutes, not two hours. The suite builds
 * a 600-second synthetic master with `lavfi`, probes it, and asserts the
 * measured duration; every number printed at the end is that measurement. Two
 * hours of the same fixture is the same journey with a bigger `d=` and roughly
 * twelve times the encode, and nothing here would change — but calling a
 * ten-minute file "two hours" is exactly the kind of claim the 18/07/2026
 * incident was made of, so the file says ten minutes and means it.
 *
 * **What is new against `synthesis-render.integration.mjs`.** That suite
 * proves the BRIDGE over real pixels: `createEditorialSynthesis` in memory,
 * `compileSynthesisToDirectedPlan` as a pure function, one render. It never
 * touches PostgreSQL and never crosses `/v1`. This one is the product path:
 *
 * 1. the master is stored as a real media artifact — sha256, byte size and
 *    probe measured from the file, never declared;
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
 * 7. and the output is measured: frame count, duration, video and audio
 *    codecs, sample rate, byte size, sha256, and a pixel probe at the middle
 *    of every clip.
 *
 * **The falsification the pixels pay for.** The master carries a different
 * marker colour in each of its ten minutes, and the six selected windows come
 * from six non-consecutive minutes. A bridge that took the first two minutes
 * of the master, or that ignored `sourceInFrame`, renders a perfectly valid
 * MP4 of exactly the right length. Only the colours say it took the wrong
 * spans.
 *
 * Nothing is committed: the master, the render and the work root live in a
 * `mkdtemp` removed in `t.after`.
 */

const RUN = process.env.APOLLO_LONGFORM_SYNTHESIS_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_LONGFORM_SYNTHESIS_E2E=1 with a migrated V2_DATABASE_URL and ffmpeg'

process.env.APOLLO_API_ENVIRONMENT ??= 'sandbox'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const FPS = 30
const WIDTH = 320
const HEIGHT = 180
/** Ten minutes. Stated as seconds so the assertion and the encode share it. */
const MASTER_SECONDS = 600
const TARGET_MS = 120_000

/** One colour per minute of the master. Well separated in RGB on purpose. */
const MARKERS = Object.freeze([
  { name: 'red', hex: '0xFF0000', rgb: [255, 0, 0] },
  { name: 'green', hex: '0x00FF00', rgb: [0, 255, 0] },
  { name: 'blue', hex: '0x0000FF', rgb: [0, 0, 255] },
  { name: 'yellow', hex: '0xFFFF00', rgb: [255, 255, 0] },
  { name: 'magenta', hex: '0xFF00FF', rgb: [255, 0, 255] },
  { name: 'cyan', hex: '0x00FFFF', rgb: [0, 255, 255] },
  { name: 'orange', hex: '0xFF8000', rgb: [255, 128, 0] },
  { name: 'violet', hex: '0x8000FF', rgb: [128, 0, 255] },
  { name: 'spring', hex: '0x00FF80', rgb: [0, 255, 128] },
  { name: 'grey', hex: '0x808080', rgb: [128, 128, 128] },
])

/**
 * Six windows, together exactly 120 s, each wholly inside one minute.
 *
 * Minutes 0, 1, 3, 5, 6 and 8 — never consecutive, so a render that ran
 * straight through the master would land on the wrong colour immediately.
 */
const WINDOWS = Object.freeze([
  { rangeId: 'range-1', startMs: 30_000, endMs: 55_000, minute: 0, claimIds: [], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-2', startMs: 90_000, endMs: 108_000, minute: 1, claimIds: [], qualifierIds: [], proofContextIds: [] },
  // The claim, its qualifier and its proof context are carried by three
  // DIFFERENT windows on purpose. `assertClaimContextPreserved` refuses a cut
  // that keeps an assertion and drops what qualifies or supports it, and a
  // fixture that put all three in one range would never exercise that.
  { rangeId: 'range-3', startMs: 190_000, endMs: 212_000, minute: 3, claimIds: ['claim-1'], qualifierIds: [], proofContextIds: [] },
  { rangeId: 'range-4', startMs: 310_000, endMs: 325_000, minute: 5, claimIds: [], qualifierIds: ['qualifier-1'], proofContextIds: [] },
  { rangeId: 'range-5', startMs: 380_000, endMs: 405_000, minute: 6, claimIds: [], qualifierIds: [], proofContextIds: ['proof-1'] },
  { rangeId: 'range-6', startMs: 500_000, endMs: 515_000, minute: 8, claimIds: [], qualifierIds: [], proofContextIds: [] },
])

const COLOR_METADATA = Object.freeze({
  colorSpace: 'rec709',
  transfer: 'bt709',
  primaries: 'bt709',
  matrix: 'bt709',
  range: 'limited',
  bitDepth: 8,
})

/** testsrc2 for ten minutes, with the top band painted a different colour each minute. */
function buildMaster(path) {
  const band = MARKERS.map((marker, minute) =>
    `drawbox=x=0:y=0:w=${WIDTH}:h=80:color=${marker.hex}@1:t=fill:`
    + `enable='between(t,${minute * 60},${(minute + 1) * 60})'`).join(',')
  execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc2=s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${MASTER_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${MASTER_SECONDS}`,
    '-filter_complex', `[0:v]${band}[v]`,
    '-map', '[v]', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-ar', '48000',
    path,
  ], { windowsHide: true, timeout: 900_000 })
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

/** The average colour of the marker band at one instant of a file. */
function bandColourAt(path, second) {
  const raw = execFileSync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-ss', String(second), '-i', path,
    '-frames:v', '1', '-vf', `crop=${WIDTH}:70:0:5,scale=1:1`,
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  return [raw[0], raw[1], raw[2]]
}

function nearestMinute(colour) {
  let best = 0
  let bestDistance = Infinity
  for (const [minute, marker] of MARKERS.entries()) {
    const measured = Math.sqrt(
      colour.reduce((total, value, index) => total + (value - marker.rgb[index]) ** 2, 0),
    )
    if (measured < bestDistance) {
      bestDistance = measured
      best = minute
    }
  }
  return { minute: best, distance: bestDistance }
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

test(
  'E2E-F4.016 a ten-minute master becomes a persisted two-minute cut whose MP4 carries the minutes it selected',
  { skip: SKIP, timeout: 45 * 60_000 },
  async (t) => {
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
    buildMaster(masterPath)
    const masterStreams = probeStreams(masterPath)
    const masterVideo = masterStreams.find((stream) => stream.codec_type === 'video')
    const masterAudio = masterStreams.find((stream) => stream.codec_type === 'audio')
    const masterSeconds = Number(masterVideo.duration)
    assert.ok(
      masterSeconds >= MASTER_SECONDS - 1,
      `the master must be at least ten minutes; ffprobe measured ${masterSeconds}s`,
    )
    const masterBytes = await readFile(masterPath)
    const masterSha256 = createHash('sha256').update(masterBytes).digest('hex')
    const masterByteSize = (await stat(masterPath)).size

    // The marker really is one colour per minute in the FILE, not only in the
    // filtergraph this suite wrote.
    for (const minute of [0, 3, 6, 9]) {
      const measured = nearestMinute(bandColourAt(masterPath, minute * 60 + 30))
      assert.equal(measured.minute, minute, `minute ${minute} of the master carries the wrong marker`)
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
      environment: 'sandbox',
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
        objective: 'two-minute cut of a ten-minute master',
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
    assert.ok(outAudio, 'the cut must carry audio')
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
      const measured = nearestMinute(bandColourAt(rendered.outputPath, middle))
      identified.push(measured.minute)
      distances.push(measured.distance)
      assert.equal(
        measured.minute,
        WINDOWS[index].minute,
        `output clip ${index} at ${middle}s carries minute ${measured.minute}'s marker, not minute ${WINDOWS[index].minute}'s`,
      )
      assert.ok(measured.distance < 90, `marker colour drifted by ${measured.distance.toFixed(1)}`)
    }
    assert.deepEqual(identified, WINDOWS.map((window) => window.minute))

    console.log(
      `E2E-F4.016 long-form synthesis journey: master ${masterSeconds.toFixed(2)}s `
      + `(${masterVideo.codec_name}/${masterAudio.codec_name} ${masterVideo.width}x${masterVideo.height} `
      + `${masterByteSize} bytes sha256 ${masterSha256.slice(0, 16)}) -> synthesis ${synthesisId} `
      + `${summary.rangeCount} ranges ${summary.droppedMs}ms dropped compression ${summary.compressionBps}bps `
      + `hash ${summary.synthesisHash.slice(0, 12)} -> plan ${plan.id} ${plan.durationFrames} frames `
      + `hash ${compiled.planHash.slice(0, 12)} -> MP4 ${measuredSeconds.toFixed(3)}s `
      + `${countedFrames} frames (expected ${expectedFrames}) ${outVideo.codec_name}/${outAudio.codec_name}@${outAudio.sample_rate} `
      + `${WIDTH}x${HEIGHT}@${outVideo.r_frame_rate} ${rendered.byteSize} bytes sha256 ${outSha256.slice(0, 16)}; `
      + `minutes [${identified.join(',')}] max colour distance ${Math.max(...distances).toFixed(1)}`,
    )
  },
)

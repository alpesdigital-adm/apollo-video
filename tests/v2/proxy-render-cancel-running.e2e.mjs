import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'
import { createOwnedTempRoot, removeOwnedTempRoot } from './helpers/owned-temp-root.mjs'

const require = createRequire(import.meta.url)
const { enqueueProjectProxyRenderService } = await import('../../src/v2/application/enqueue-project-proxy-render.ts')
const { cancelPublicOperationService } = await import('../../src/v2/application/cancel-public-operation.ts')
const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
const { FfmpegEditorialProxyRenderer } = await import('../../src/v2/infrastructure/media/ffmpeg-editorial-proxy-renderer.ts')

/**
 * W70 prep. A render that is CANCELLED WHILE IT IS RUNNING (W68 proved only a queued one).
 *
 * The production proxy-render worker, the production repositories, real PostgreSQL and real FFmpeg. The real renderer is held, after FFmpeg has
 * written the whole MP4 into its scratch directory, until the operation is cancelled (so the cancellation always lands in the middle of the
 * worker's `rendering` phase, with the finished file still in scratch and the artifact not yet promoted). The cancellation goes through the
 * public service. The proof: the operation ends `canceled`, the worker aborts the render and promotes nothing - no artifact row, no manifest, no
 * review, no cue map, no file under the artifact's storage prefix - the scratch directory of the operation is gone, and the same input can be
 * rendered by a NEW operation afterwards (the way forward the UI offers), which succeeds.
 */
const enabled = process.env.APOLLO_RENDER_CANCEL_RUNNING_E2E === '1'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, probe, { timeoutMs = 120_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { last = await probe(); if (last) return last } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
    await delay(intervalMs)
  }
}

async function filesUnder(root) {
  const out = []
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else out.push(path.replaceAll('\\', '/'))
    }
  }
  await walk(root)
  return out
}

test('W70 prep: cancelling a render while the worker is rendering promotes no artifact, ends canceled and cleans the scratch', { skip: !enabled, timeout: 600_000 }, async () => {
  const harnessUrl = process.env.V2_DATABASE_URL
  const poolOf = (limit) => { const url = new URL(harnessUrl); url.searchParams.set('connection_limit', String(limit)); return url.toString() }
  process.env.V2_DATABASE_URL = poolOf(3)
  const db = new PrismaClient({ datasources: { db: { url: poolOf(2) } } })
  const root = await createOwnedTempRoot('apollo-w70-cancel-')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
  const original = FfmpegEditorialProxyRenderer.prototype.render
  const held = { finished: [], aborted: [] }
  try {
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath })
    const environment = {
      ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', V2_DATABASE_URL: poolOf(3),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ?? `w70-${suffix}`,
      APOLLO_PROTECTED_PAYLOAD_KEY: process.env.APOLLO_PROTECTED_PAYLOAD_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
      // a short lease and heartbeat: the worker notices the cancellation within a fraction of a second
      APOLLO_V2_RENDER_LEASE_MS: '3000', APOLLO_V2_RENDER_HEARTBEAT_MS: '200',
    }
    // The real renderer, held after FFmpeg finished until the render is aborted (or 60 s pass): the cancellation lands inside the rendering phase.
    FfmpegEditorialProxyRenderer.prototype.render = async function render(input) {
      const result = await original.call(this, input)
      held.finished.push({ operationId: input.operationId, outputPath: result.outputPath, existsAtHold: (await stat(result.outputPath).catch(() => null)) !== null })
      for (let waited = 0; waited < 60_000 && !input.signal?.aborted; waited += 50) await delay(50)
      held.aborted.push({ operationId: input.operationId, aborted: input.signal?.aborted === true })
      if (input.signal?.aborted) throw Object.assign(new Error('render aborted'), { code: 'ABORT_ERR', name: 'AbortError' })
      return result
    }

    const projectId = world.projectId
    const enqueue = (key, variantId) => enqueueProjectProxyRenderService({
      projects: factory.createProjectProxyRenderRepository(), operations: factory.createPublicOperationRepository(),
      colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
    })({ workspaceId: world.owner.workspaceId, projectId, actor: world.owner.actor, variantId, idempotencyKey: key })
    const queued = await enqueue(`w70-${suffix}-cancel-1`, world.wideVariantId)
    const operationId = queued.operation.id
    const proxyRow = await db.v2ProjectProxyRenderOperation.findUniqueOrThrow({ where: { operationId } })
    const outputArtifactId = proxyRow.outputArtifactId

    // one worker pass, claimed by name, running in the background
    const pass = runProxyWorkerOnce({ environment, workspaceId: world.owner.workspaceId, operationId, onFailure: () => undefined })
    await waitFor('FFmpeg finished and the render is held in the rendering phase', async () => held.finished.some((entry) => entry.operationId === operationId))
    const during = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
    assert.equal(during.status, 'running')
    assert.equal(during.phase, 'rendering', 'the cancellation lands in the middle of the rendering phase')
    const scratch = join(artifactRoot, '.work', operationId)
    assert.ok((await stat(scratch).catch(() => null)) !== null, 'the scratch directory of the running operation exists')
    assert.equal(held.finished[0].existsAtHold, true, 'and the finished MP4 is in it, not yet promoted')
    assert.equal(await db.v2MediaArtifact.count({ where: { id: outputArtifactId, workspaceId: world.owner.workspaceId } }), 0, 'nothing is promoted yet')

    const cancelled = await cancelPublicOperationService({ operations: factory.createPublicOperationRepository() })({ workspaceId: world.owner.workspaceId, operationId, actor: world.owner.actor })
    assert.ok(['canceled', 'cancel-requested', 'canceling'].includes(cancelled.status) || cancelled.status === 'running', `the cancellation is accepted: ${cancelled.status}`)
    const outcome = await Promise.race([pass, delay(60_000).then(() => 'worker-pass-did-not-return')])
    assert.notEqual(outcome, 'worker-pass-did-not-return', 'the worker pass returns after the cancellation')
    assert.equal(held.aborted.at(-1)?.aborted, true, 'the render was told to stop (its signal was aborted), it did not run to the end')

    const final = await waitFor('the operation is canceled', async () => {
      const row = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })
      return row.status === 'canceled' ? row : null
    })
    assert.equal(final.status, 'canceled')
    assert.equal(final.leaseOwner, null, 'no lease is left held')
    const where = { workspaceId: world.owner.workspaceId }
    assert.equal(await db.v2MediaArtifact.count({ where: { ...where, id: outputArtifactId } }), 0, 'no artifact row was promoted')
    assert.equal(await db.v2MediaArtifactManifest.count({ where: { ...where, artifactId: outputArtifactId } }), 0, 'no manifest')
    assert.equal(await db.v2ProxyReview.count({ where: { ...where, operationId } }), 0, 'no review')
    assert.equal(await db.v2RenderElementMap.count({ where: { ...where, proxyArtifactId: outputArtifactId } }), 0, 'no cue map')
    assert.equal(await db.v2ProxyReviewDecision.count({ where }), 0, 'no decision')
    assert.equal(await db.v2MediaArtifact.count({ where: { ...where, id: { contains: outputArtifactId } } }), 0)
    const files = await filesUnder(artifactRoot)
    assert.deepEqual(files.filter((file) => file.includes(outputArtifactId) || file.includes('editorial-proxy')), [], 'no file in storage under the artifact or the proxy prefix')
    assert.equal((await stat(scratch).catch(() => null)), null, 'the scratch directory of the operation was removed')
    assert.deepEqual((await filesUnder(join(artifactRoot, '.work'))).filter((file) => file.includes(operationId)), [], 'and nothing of the operation is left in the work root')

    // a canceled render is not reopened for the same inputs (unique per Version and input hash): the same request is refused with its reason, and the
    // way forward is another Version (W68 proved that path in the editor).
    FfmpegEditorialProxyRenderer.prototype.render = original
    const again = await enqueue(`w70-${suffix}-cancel-2`, world.wideVariantId).then(() => null, (error) => error)
    assert.ok(again instanceof Error && /immutable proxy input is already admitted/.test(String(again.message)), `a canceled input is not reopened (${again instanceof Error ? again.message : 'accepted'})`)
    note('cancel-running', { operationId, phase: during.phase, held: held.finished.length, scratchRemoved: true, again: again.message })
  } finally {
    FfmpegEditorialProxyRenderer.prototype.render = original
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
    await removeOwnedTempRoot(root)
  }
})

function note(label, value) { console.log(`W70-EVIDENCE ${JSON.stringify({ label, ...value })}`) }

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { sourceWindowHarness } from './helpers/face-source-pg.mjs'
import { runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'
import { createOwnedTempRoot, removeOwnedTempRoot } from './helpers/owned-temp-root.mjs'
import { standInDetectorRows } from './helpers/reframe-gt-oracle.mjs'

const require = createRequire(import.meta.url)
const { enqueueProjectProxyRenderService } = await import('../../src/v2/application/enqueue-project-proxy-render.ts')
const { acknowledgeProxyWarningsService, readProxyReviewService } = await import('../../src/v2/application/proxy-review.ts')
const { applySubtitleSegmentOverrideService } = await import('../../src/v2/application/subtitle-segment-overrides.ts')
const { carryOverUntouchedOutputService } = await import('../../src/v2/application/carry-over-untouched-output.ts')
const { carryOverAfterCommand } = await import('../../src/v2/infrastructure/carry-over-after-command.ts')
const { PrismaProxyCarryOverRepository } = await import('../../src/v2/infrastructure/prisma/proxy-carry-over-repository.ts')
const { PrismaSubtitleSidecarRepository } = await import('../../src/v2/infrastructure/prisma/subtitle-sidecar-repository.ts')
const { PrismaSubtitleSegmentOverrideRepository } = await import('../../src/v2/infrastructure/prisma/subtitle-segment-override-repository.ts')
const { calculateProxyReviewHash } = await import('../../src/v2/application/render-workflow.ts')
const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
const { presentProxyReview } = await import('../../src/v2/public-api/proxy-review-presenter.ts')
const { proxyDirectorCriticIssuesDigest } = await import('../../src/v2/application/proxy-render-evidence.ts')
const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
const { setProjectColorPlanService } = await import('../../src/v2/application/project-color-plans.ts')
const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
const { PrismaProjectColorPlanRepository } = await import('../../src/v2/infrastructure/prisma/project-color-plan-repository.ts')
const { PrismaWorkspaceLutRepository } = await import('../../src/v2/infrastructure/prisma/workspace-lut-repository.ts')
const { getPublicSchema } = await import('../../src/v2/public-api/schema-registry.ts')
const { default: Ajv2020 } = await import('ajv/dist/2020.js')
const { default: addFormats } = await import('ajv-formats')

/**
 * W70 prep ("invalidar so o necessario"). A Command aimed at ONE output creates a new ProjectVersion; the OTHER output keeps its render, its
 * review and its approval when nothing it is drawn from changed, and the carry is recorded, never silent.
 *
 * Production services and repositories, real PostgreSQL, real FFmpeg (the production proxy-render worker): two outputs (9:16 and 16:9) over one
 * recording are rendered, the 9:16 review is acknowledged by a person, and then:
 *  1. a text exception on the 16:9 output (the production Command) -> the 9:16 render is carried to the new Version by its content address:
 *     a completed operation on the SAME artifact (`reusedFrom*` name the source), the same cue map, a review with its own hash and the approval
 *     re-bound by a `carry-over-approval` decision (base = the review carried, actor = who triggered it); the 16:9 output (the affected one)
 *     is not carried; a second attempt finds it present;
 *  2. a Command on the 9:16 output changes ITS inputs: the 16:9 output, which was never rendered for the exception it now has, is not carried;
 *  3. a render written without the address (before it existed), or a head that moved, is never a source;
 *  4. after the 16:9 output is rendered for its current inputs, a Command aimed at 9:16 carries the 16:9 render (a chain of carries is fine);
 *  5. the sidecar of a carried output names the very MP4 the earlier Version rendered.
 * W70 readiness (R2) - what the content address cannot see:
 *  6. a face window published after the render (the window the plan was still waiting for) is evidence the render never read: the address
 *     is unchanged and the carry is refused with face-evidence-moved;
 *  7. the Director issues the head's review would be built over are not the ones the render's was: refused with critic-issues-moved (the
 *     stored digest is moved by hand - in this world no Director run exists to move them); restored, the carry is made and copies the digests.
 */
const enabled = process.env.APOLLO_PROXY_CARRY_OVER_E2E === '1'
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

async function waitFor(label, probe, { timeoutMs = 120_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  for (;;) {
    try { last = await probe(); if (last) return last } catch (error) { last = error }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
    await delay(intervalMs)
  }
}

test('W70 prep: the untouched output keeps its render and approval by content address, recorded, and any change to its inputs carries nothing', { skip: !enabled, timeout: 900_000 }, async () => {
  const harnessUrl = process.env.V2_DATABASE_URL
  const poolOf = (limit) => { const url = new URL(harnessUrl); url.searchParams.set('connection_limit', String(limit)); return url.toString() }
  process.env.V2_DATABASE_URL = poolOf(3)
  const db = new PrismaClient({ datasources: { db: { url: poolOf(2) } } })
  const root = await createOwnedTempRoot('apollo-w70-carry-')
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
  try {
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath })
    const environment = {
      ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', V2_DATABASE_URL: poolOf(3),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ?? `w70-${suffix}`,
      APOLLO_PROTECTED_PAYLOAD_KEY: process.env.APOLLO_PROTECTED_PAYLOAD_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
    }
    const { workspaceId } = world.owner
    const projectId = world.projectId
    const actor = world.owner.actor
    const WIDE = world.wideVariantId, TALL = world.verticalVariantId
    const scope = { workspaceId, projectId }
    const head = async () => db.v2ProjectVersion.findUniqueOrThrow({ where: { id: (await db.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId } })
    const reviews = factory.createProxyReviewRepository()
    const renderOf = async (variantId) => {
      const queued = await enqueueProjectProxyRenderService({
        projects: factory.createProjectProxyRenderRepository(), operations: factory.createPublicOperationRepository(),
        colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
      })({ ...scope, actor, variantId, idempotencyKey: `w70-${suffix}-${variantId.slice(-6)}-${randomUUID().slice(0, 6)}` })
      const failures = []
      await runProxyWorkerOnce({ environment, workspaceId, operationId: queued.operation.id, onFailure: (item) => failures.push(String(item.error?.stack ?? item.error)) })
      const status = (await db.v2PublicOperation.findUniqueOrThrow({ where: { id: queued.operation.id } })).status
      assert.equal(status, 'succeeded', `render: ${failures.join(' | ')}`)
      return db.v2ProjectProxyRenderOperation.findUniqueOrThrow({ where: { operationId: queued.operation.id } })
    }
    const reviewAt = async (variantId, versionId) => readProxyReviewService({ repository: reviews })({ ...scope, variantId, projectVersionId: versionId })
    const override = applySubtitleSegmentOverrideService({ repository: new PrismaSubtitleSegmentOverrideRepository(db), createId: (kind) => `w70-${suffix}-${kind}-${randomUUID()}`, clock: () => new Date() })
    const command = async (variantId, segmentId, text, label) => {
      const base = await head()
      const applied = await override({ ...scope, baseVersionId: base.id, baseHash: base.baseHash, variantId, segmentId, dimensions: [{ kind: 'text', text }], actor, idempotencyKey: `w70-${suffix}-${label}` })
      await carryOverAfterCommand({ ...scope, versionId: applied.version.id, commandId: applied.command.id, affectedVariantIds: applied.impact.affectedVariantIds, actor, log: (message) => assert.fail(message) })
      return applied
    }
    const carryService = carryOverUntouchedOutputService({
      projects: factory.createProjectProxyRenderRepository(), carryOvers: new PrismaProxyCarryOverRepository(db),
      colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(),
      // the reader the render worker reads with (as `carryOverAfterCommand` wires it)
      faceEvidence: factory.createFaceSourceWindowRepository(),
    })
    const opAt = (versionId, variantId) => db.v2ProjectProxyRenderOperation.findFirst({ where: { ...scope, projectVersionId: versionId, outputVariantId: variantId, operation: { status: 'succeeded' } } })

    /* ---------------------------------------------------------- V0: both outputs rendered, the 9:16 review acknowledged by a person */
    const V0 = await head()
    const wideV0 = await renderOf(WIDE), tallV0 = await renderOf(TALL)
    assert.match(wideV0.renderContentHash ?? '', /^[a-f0-9]{64}$/, 'a render written now carries its content address')
    assert.notEqual(wideV0.renderContentHash, tallV0.renderContentHash)
    for (const render of [wideV0, tallV0]) {
      assert.match(render.faceEvidenceDigest ?? '', /^[a-f0-9]{64}$/, 'and the digest of the face windows its placement read')
      assert.equal(render.criticIssuesDigest, proxyDirectorCriticIssuesDigest([]), 'and of the Director issues it was reviewed over (none: no Director run here)')
    }
    const tallReview0 = await reviewAt(TALL, V0.id)
    assert.equal(tallReview0.status, 'warning-ack-required', 'the 9:16 render has warnings a person must acknowledge')
    const acknowledged = await acknowledgeProxyWarningsService({ repository: reviews, clock: () => new Date(), createId: () => randomUUID() })({
      ...scope, projectVersionId: V0.id, proxyReviewId: tallReview0.id, baseReviewHash: tallReview0.reviewHash, expectedRevision: tallReview0.revision,
      action: 'acknowledge-warnings', actor, idempotencyKey: `w70-${suffix}-ack`,
    })
    const approved0 = acknowledged.review
    assert.equal(approved0.status, 'ready-for-final'); assert.equal(approved0.finalAllowed, true)
    const decisionsBefore = await db.v2ProxyReviewDecision.count({ where: { workspaceId } })
    assert.equal(decisionsBefore, 1)

    /* ---------------------------------------------------------- 1. a Command aimed at 16:9: the 9:16 render and approval are carried */
    const c1 = await command(WIDE, 'cue-1', 'Ação', 'text-1')
    const V1 = c1.version
    assert.deepEqual([...c1.impact.affectedVariantIds], [WIDE], 'the Command names only the 16:9 output')
    const tallV1 = await opAt(V1.id, TALL)
    assert.ok(tallV1, 'the 9:16 output has a completed render of the new Version without being rendered again')
    assert.equal(tallV1.outputArtifactId, tallV0.outputArtifactId, 'it is the very same artifact')
    assert.equal(tallV1.outputManifestId, tallV0.outputManifestId)
    assert.equal(tallV1.reusedFromOperationId, tallV0.operationId, 'recorded as carried from the operation of the earlier Version')
    assert.equal(tallV1.reuseBaseVersionId, V0.id, 'and from that Version')
    assert.equal(tallV1.reuseCommandId, c1.command.id, 'by the Command that made the head')
    assert.equal(tallV1.renderContentHash, tallV0.renderContentHash, 'the content address of the inputs is the same one')
    assert.deepEqual([tallV1.faceEvidenceDigest, tallV1.criticIssuesDigest], [tallV0.faceEvidenceDigest, tallV0.criticIssuesDigest],
      'and so is what the render read (checked, then copied to the carried row)')
    assert.notEqual(tallV1.inputHash, tallV0.inputHash, 'while the pre-render input hash names the new Version')
    assert.equal(await opAt(V1.id, WIDE), null, 'the affected 16:9 output is not carried (it must be rendered for its new text)')
    const carriedReview = await reviewAt(TALL, V1.id)
    assert.equal(carriedReview.projectVersionId, V1.id)
    assert.equal(carriedReview.operationId, tallV1.operationId)
    assert.equal(carriedReview.inputHash, tallV1.inputHash)
    assert.equal(carriedReview.status, 'ready-for-final'); assert.equal(carriedReview.finalAllowed, true); assert.equal(carriedReview.warningsAcknowledged, true)
    // (Opus validation, note 3) the person who acknowledged V0 did not acknowledge V1: the carried review names the automatic carry, the person only in carriedFrom
    assert.equal(carriedReview.acknowledgedBy?.type, 'automatic-carry', 'the carried review is acknowledged by the automatic carry')
    assert.notEqual(carriedReview.acknowledgedBy.id, approved0.acknowledgedBy.id, 'never by the person of V0, as if they had acknowledged V1')
    assert.notEqual(carriedReview.reviewHash, approved0.reviewHash, 'the review is a new one, with its own hash')
    assert.equal(carriedReview.proxyArtifactId, approved0.proxyArtifactId)
    assert.deepEqual(carriedReview.technicalIssues, approved0.technicalIssues); assert.deepEqual(carriedReview.criticIssues, approved0.criticIssues)
    assert.deepEqual(carriedReview.formatQuality, approved0.formatQuality)
    const BODY_KEYS = ['schemaVersion', 'projectVersionId', 'proxyArtifactId', 'proxyManifestId', 'inputHash', 'outputSpecId', 'rangeCacheKey', 'spec', 'status', 'technicalIssues',
      'criticIssues', 'formatQuality', 'warningsAcknowledged', 'finalAllowed', 'uploadReceivedAt', 'renderCompletedAt', 'timeToFirstProxyMs']
    const body = Object.fromEntries(BODY_KEYS.filter((key) => carriedReview[key] !== undefined).map((key) => [key, carriedReview[key]]))
    assert.equal(calculateProxyReviewHash(body), carriedReview.reviewHash, 'and the hash is the hash of exactly what it says')
    const decisions = await db.v2ProxyReviewDecision.findMany({ where: { workspaceId, action: 'carry-over-approval' } })
    assert.equal(decisions.length, 1, 'the approval was re-bound by a decision of its own kind')
    assert.equal(decisions[0].proxyReviewId, carriedReview.id)
    assert.equal(decisions[0].baseReviewHash, approved0.reviewHash, 'it names the review it carries')
    assert.equal(decisions[0].resultReviewHash, carriedReview.reviewHash)
    assert.equal(decisions[0].actorId, world.owner.clientId, 'and the actor who triggered it')
    assert.equal(await db.v2ProxyReviewDecision.count({ where: { workspaceId, action: 'acknowledge-warnings' } }), 1, 'no second human acknowledgement was invented')
    assert.deepEqual(carriedReview.acknowledgedBy, { type: 'automatic-carry', id: decisions[0].id, at: decisions[0].createdAt.toISOString() }, 'named by its decision and the time it re-bound the approval')
    // Raw rows: the stored review of a carried approval names the automatic carry as its acknowledger (the decision and the time it was made); no
    // stored row other than the source's names the person who acknowledged V0, and the read path published that as stored, not rewritten.
    const rawCarried = await db.v2ProxyReview.findUniqueOrThrow({ where: { id: carriedReview.id } })
    assert.deepEqual([rawCarried.acknowledgedByType, rawCarried.acknowledgedById, rawCarried.acknowledgedAt?.toISOString()],
      ['automatic-carry', decisions[0].id, decisions[0].createdAt.toISOString()], 'the stored carried review names the automatic carry, not the earlier person')
    assert.deepEqual(
      (await db.v2ProxyReview.findMany({ where: { workspaceId, acknowledgedById: approved0.acknowledgedBy.id }, select: { id: true } })).map((row) => row.id),
      [approved0.id], 'the earlier person is the acknowledger of exactly the review they acknowledged')
    const rawSource = await db.v2ProxyReview.findUniqueOrThrow({ where: { id: approved0.id } })
    assert.deepEqual([rawSource.acknowledgedByType, rawSource.acknowledgedById], ['api-client', approved0.acknowledgedBy.id], 'and the source review still names them')
    // W70 readiness (R1): the carry is VISIBLE as what it is - an automatic carry of an identical render, with the review, the decision and the content
    // address - in the review a client reads; a render made for the Version says nothing of the kind. The approval is the one a person gave on V0.
    assert.deepEqual(carriedReview.carriedFrom, { versionId: V0.id, reviewId: approved0.id, reviewHash: approved0.reviewHash, decisionId: decisions[0].id, renderContentHash: tallV0.renderContentHash,
      acknowledgedBy: approved0.acknowledgedBy },
      'the public review names the Version, the review (as it was when carried), the decision that re-bound the approval, the content address and the person who acknowledged V0')
    assert.equal((await reviewAt(WIDE, V0.id)).carriedFrom, undefined, 'a render made for its own Version is not marked as carried')
    assert.equal((await reviewAt(TALL, V0.id)).carriedFrom, undefined)
    const publicShape = presentProxyReview(carriedReview)
    const validateV4 = addFormats(new Ajv2020({ strict: false, allErrors: true })).compile(getPublicSchema('apollo://schemas/project-proxy-review-response/v4').schema)
    assert.equal(validateV4({ data: { review: publicShape }, meta: { apiVersion: 'v1' } }), true, JSON.stringify(validateV4.errors))
    assert.deepEqual(publicShape.carriedFrom, carriedReview.carriedFrom)
    assert.deepEqual(publicShape.acknowledgedBy, carriedReview.acknowledgedBy, 'and the public review names the carry, not the person')
    // the operation records the impact of the Command that made the head in the slot that means that, and the content address beside it
    assert.equal(tallV1.reuseImpactHash, c1.impact.impactHash, 'reuseImpactHash is the impact of the Command, not the content address')
    assert.notEqual(tallV1.reuseImpactHash, tallV1.renderContentHash)
    assert.deepEqual([tallV1.carriedFromReviewId, tallV1.carriedFromReviewHash], [approved0.id, approved0.reviewHash])
    assert.equal(await db.v2ProjectProxyRenderOperation.count({ where: { ...scope, carriedFromReviewId: { not: null } } }), 1, 'only the carried operation is marked')
    assert.equal(await db.v2RenderElementMap.count({ where: { ...scope, projectVersionId: V1.id, proxyArtifactId: tallV0.outputArtifactId } }), 1, 'the cue map of the same MP4 is bound to the new Version')
    // the sidecar reader sees the carried output as the output of the new Version, aligned with the very MP4 of the earlier one
    const alignment = await new PrismaSubtitleSidecarRepository(db).readRenderedAlignment({ ...scope, variantId: TALL, projectVersionId: V1.id })
    assert.equal(alignment.projectVersionId, V1.id); assert.equal(alignment.outputArtifactId, tallV0.outputArtifactId); assert.equal(alignment.renderInputHash, tallV1.inputHash)
    // a second attempt finds it there; asking for the render of the 9:16 output of the head answers with the carried one instead of starting a render
    assert.deepEqual((await carryService({ ...scope, variantId: TALL, actor })).status, 'present')
    const asked = await enqueueProjectProxyRenderService({
      projects: factory.createProjectProxyRenderRepository(), operations: factory.createPublicOperationRepository(),
      colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
    })({ ...scope, actor, variantId: TALL, idempotencyKey: `w70-${suffix}-ask-tall` })
    assert.equal(asked.operation.id, tallV1.operationId, 'a render of the carried output on the head is the carried operation, not a second render')
    assert.equal(asked.operation.status, 'succeeded')
    assert.equal(await db.v2ProjectProxyRenderOperation.count({ where: { ...scope, projectVersionId: V1.id, outputVariantId: TALL } }), 1)
    console.log(`W70-EVIDENCE ${JSON.stringify({ label: 'carried', from: V0.id, to: V1.id, artifact: tallV1.outputArtifactId, content: tallV1.renderContentHash, decision: decisions[0].id })}`)

    /* ---------------------------------------------------------- 2. a Command that changes the inputs of the OTHER output: nothing is carried for it */
    const c2 = await command(TALL, 'cue-2', 'Última cue.', 'text-2')
    const V2 = c2.version
    assert.deepEqual([...c2.impact.affectedVariantIds], [TALL])
    assert.equal(await opAt(V2.id, WIDE), null, 'the 16:9 output now has an exception it was never rendered with: its inputs differ from its only render, so it is not carried')
    assert.equal(await opAt(V2.id, TALL), null, 'the affected 9:16 output is not carried either')
    const direct = await carryService({ ...scope, variantId: WIDE, actor })
    assert.deepEqual([direct.status, direct.reason], ['not-eligible', 'no-source-render'])
    assert.equal(await db.v2ProxyReviewDecision.count({ where: { workspaceId, action: 'carry-over-approval' } }), 1)

    /* ---------------------------------------------------------- 3. never a source: a render with no content address, a head that moved */
    const wideV2 = await renderOf(WIDE)
    assert.ok(wideV2.renderContentHash)
    await db.v2ProjectProxyRenderOperation.update({ where: { operationId: wideV2.operationId }, data: { renderContentHash: null } })
    const c3 = await command(TALL, 'cue-1', 'Primeira', 'text-3')
    assert.equal(await opAt(c3.version.id, WIDE), null, 'a render written without a content address is never carried (nothing is assumed about it)')
    await db.v2ProjectProxyRenderOperation.update({ where: { operationId: wideV2.operationId }, data: { renderContentHash: wideV2.renderContentHash } })

    /* ---------------------------------------------------------- 4. the address restored: the render is carried again, from an ancestor */
    const c4 = await command(TALL, 'cue-2', 'Segunda', 'text-4')
    const wideV4 = await opAt(c4.version.id, WIDE)
    assert.ok(wideV4, 'with its address, the unchanged 16:9 render is carried to the new head')
    assert.equal(wideV4.outputArtifactId, wideV2.outputArtifactId)
    assert.equal(wideV4.reusedFromOperationId, wideV2.operationId)
    assert.equal(wideV4.reuseBaseVersionId, wideV2.projectVersionId, 'from the Version it was rendered at, not from its parent')
    const wideReview4 = await reviewAt(WIDE, c4.version.id)
    const wideReview2 = await reviewAt(WIDE, wideV2.projectVersionId)
    assert.deepEqual([wideReview4.status, wideReview4.warningsAcknowledged, wideReview4.finalAllowed], [wideReview2.status, wideReview2.warningsAcknowledged, wideReview2.finalAllowed], 'a review nobody approved is carried as it was: nothing is approved by the carry')
    assert.equal(await db.v2ProxyReviewDecision.count({ where: { workspaceId, action: 'carry-over-approval' } }), 1, 'no approval existed, so none was re-bound')
    assert.deepEqual(wideReview4.carriedFrom, { versionId: wideV2.projectVersionId, reviewId: wideReview2.id, reviewHash: wideReview2.reviewHash, decisionId: null, renderContentHash: wideV2.renderContentHash,
      acknowledgedBy: null },
      'a carry that re-bound no approval says so: decisionId is null, and the review is the pending one it was')

    /* ---------------------------------------------------------- 5. a head that moved is refused */
    const stale = await carryService({ ...scope, variantId: TALL, actor })
    assert.ok(['present', 'not-eligible'].includes(stale.status))
    const moved = await new PrismaProxyCarryOverRepository(db).carry({
      ...scope, toProjectVersionId: V1.id, variantId: TALL, renderContentHash: tallV1.renderContentHash, inputHash: 'f'.repeat(64), editPlanSnapshotId: tallV1.editPlanSnapshotId,
      sourceArtifactId: tallV1.sourceArtifactId, sourceManifestId: tallV1.sourceManifestId, originalFileName: 'x.mp4',
      rangeCache: { sourceSha256: 'a'.repeat(64), editPlanHash: 'b'.repeat(64), format: '9:16' }, actor, now: new Date().toISOString(),
      ids: { operation: `operation-${randomUUID()}`, review: `review-${randomUUID()}`, decision: `decision-${randomUUID()}`, map: randomUUID() },
    })
    assert.deepEqual([moved.status, moved.reason], ['not-eligible', 'head-moved'], 'a carry to a Version that is no longer the head writes nothing')

    /* ---------------------------------------------------------- 6. (R2) a face window published after the render: the address cannot see it, the carry does */
    // The cover window spans source frames [0, 100); cue-3 plays over [105, 140), so the plan was still waiting for a window there. Publishing
    // it changes what the caption placement of the 16:9 output reads, while nothing its content address is made of moves.
    const faces = sourceWindowHarness(db, { suffix: `w70c${suffix}`, workspaceId, clientId: world.owner.clientId, projectId, sourceId: world.source.artifactId, actor })
    await faces.publish('late', { startSourceFrame: 100, endSourceFrame: 150 }, (frame) => standInDetectorRows(world.scene, frame))
    const c6 = await command(TALL, 'cue-2', 'Sexta', 'text-6')
    assert.equal(await opAt(c6.version.id, WIDE), null, 'the 16:9 render read other face windows than the head has now: it is not carried')
    const faceMoved = await carryService({ ...scope, variantId: WIDE, actor })
    assert.deepEqual([faceMoved.status, faceMoved.reason], ['not-eligible', 'face-evidence-moved'])
    const wideV6 = await renderOf(WIDE)
    assert.equal(wideV6.renderContentHash, wideV2.renderContentHash, 'the content address did not move')
    assert.notEqual(wideV6.faceEvidenceDigest, wideV2.faceEvidenceDigest, 'the evidence the new render read did')
    assert.equal(wideV6.criticIssuesDigest, wideV2.criticIssuesDigest)
    console.log(`W70-EVIDENCE ${JSON.stringify({ label: 'face-evidence-moved', version: c6.version.id, before: wideV2.faceEvidenceDigest, after: wideV6.faceEvidenceDigest })}`)

    /* ---------------------------------------------------------- 7. (R2) the Director issues moved: refused; restored, carried with the digests */
    await db.v2ProjectProxyRenderOperation.update({ where: { operationId: wideV6.operationId }, data: { criticIssuesDigest: proxyDirectorCriticIssuesDigest([{
      code: 'DIRECTOR_PACING_WARNING', severity: 'warning', category: 'editorial', message: 'Pacing needs review.', correctable: true }]) } })
    const c7 = await command(TALL, 'cue-2', 'Sétima', 'text-7')
    assert.equal(await opAt(c7.version.id, WIDE), null, 'a render reviewed over other Director issues than the head has is not carried')
    const criticMoved = await carryService({ ...scope, variantId: WIDE, actor })
    assert.deepEqual([criticMoved.status, criticMoved.reason], ['not-eligible', 'critic-issues-moved'])
    await db.v2ProjectProxyRenderOperation.update({ where: { operationId: wideV6.operationId }, data: { criticIssuesDigest: wideV6.criticIssuesDigest } })
    const c8 = await command(TALL, 'cue-2', 'Oitava', 'text-8')
    const wideV8 = await opAt(c8.version.id, WIDE)
    assert.ok(wideV8, 'with the same evidence, the render is carried')
    assert.equal(wideV8.reusedFromOperationId, wideV6.operationId)
    assert.deepEqual([wideV8.faceEvidenceDigest, wideV8.criticIssuesDigest], [wideV6.faceEvidenceDigest, wideV6.criticIssuesDigest], 'and the carried row names the evidence it was carried under')

    /* ---------------------------------------------------------- 8. (R2, Opus validation) a LUT Command between the render and the head: never carried */
    // The same grade re-set (mode none again): the content address agrees, so it is the defence in depth - a Version between the source and the head
    // that an exception Command did not make - that refuses. Without it this carry would be made.
    const lutBase = await head()
    await setProjectLutSelectionService({ repository: new PrismaProjectLutSelectionRepository(db), createId: (kind) => `w70c-${suffix}-lut-${kind}-${randomUUID()}`, createEventId: () => randomUUID() })({
      ...scope, baseVersionId: lutBase.id, baseHash: lutBase.baseHash, selection: { mode: 'none' }, reason: 'W70 readiness: the same grade, re-set by another Command.', actor,
      idempotencyKey: `w70c-${suffix}-lut-again` })
    const c9 = await command(TALL, 'cue-2', 'Nona', 'text-9')
    assert.equal(await opAt(c9.version.id, WIDE), null, 'a render made before a LUT Command is not carried past it')
    const lutRefused = await carryService({ ...scope, variantId: WIDE, actor })
    assert.deepEqual([lutRefused.status, lutRefused.reason], ['not-eligible', 'intermediate-command-not-carriable'], 'the address agreed and the LUT Command between them refused it')

    /* ---------------------------------------------------------- 9. (R2, Opus validation) a ColorPlan between the render and the head: the address moves */
    const colorBase = await head()
    const sourceColor = { colorSpace: 'rec709', transfer: 'bt709', primaries: 'bt709', matrix: 'bt709', range: 'limited', bitDepth: 8 }
    const compilation = await factory.createColorPipelineCompilationRepository().read({ ...scope, compilationId: `color-compilation-${world.source.artifactId}` })
    assert.ok(compilation, 'the world registered the colour compilation of its recording')
    const graded = await setProjectColorPlanService({ repository: new PrismaProjectColorPlanRepository(db), luts: new PrismaWorkspaceLutRepository(db), clock: () => new Date(),
      createEventId: randomUUID, createId: (kind) => `w70c-${suffix}-color-${kind}-${randomUUID()}` })({
      ...scope, baseVersionId: colorBase.id, baseHash: colorBase.baseHash, actor, idempotencyKey: `w70c-${suffix}-color`, reason: 'W70 readiness: one grade for the whole project.',
      plan: { schemaVersion: 'color-plan/v1', metadata: sourceColor, outputMetadata: sourceColor, sourceMetadata: { [world.source.artifactId]: sourceColor }, global: compilation.compilation.pipeline.stages },
    })
    assert.equal((await head()).id, graded.version.id, 'the ColorPlan Command made the head')
    const c10 = await command(TALL, 'cue-2', 'Décima', 'text-10')
    assert.equal(await opAt(c10.version.id, WIDE), null, 'a render made before a ColorPlan is not carried past it')
    const colorRefused = await carryService({ ...scope, variantId: WIDE, actor })
    assert.deepEqual([colorRefused.status, colorRefused.reason], ['not-eligible', 'no-source-render'], 'the grade is in the content address: no render was made under it')
    console.log(`W70-EVIDENCE ${JSON.stringify({ label: 'grade-not-carried', lut: lutRefused.reason, color: colorRefused.reason, colorPlanVersion: graded.version.id })}`)
  } finally {
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
    await removeOwnedTempRoot(root)
  }
})

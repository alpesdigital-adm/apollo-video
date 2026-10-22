import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { runProxyWorkerOnce, seedIssueOverrideWorld } from './helpers/issue-override-world.mjs'
import { commitSealedChild } from './helpers/pg-output-world.mjs'

const require = createRequire(import.meta.url)
const { enqueueProjectProxyRenderService } = await import('../../src/v2/application/enqueue-project-proxy-render.ts')
const { enqueueProjectFinalExportService } = await import('../../src/v2/application/enqueue-project-final-export.ts')
const { acknowledgeProxyWarningsService, readProxyReviewService } = await import('../../src/v2/application/proxy-review.ts')
const { applySubtitleSegmentOverrideService } = await import('../../src/v2/application/subtitle-segment-overrides.ts')
const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
const { carryOverAfterCommand } = await import('../../src/v2/infrastructure/carry-over-after-command.ts')
const { PrismaSubtitleSegmentOverrideRepository } = await import('../../src/v2/infrastructure/prisma/subtitle-segment-override-repository.ts')
const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
const { PrismaProjectFinalExportRepository } = await import('../../src/v2/infrastructure/prisma/project-final-export-repository.ts')
const { createDirectorRunInheritance, parseDirectorRunInheritance } = await import('../../src/v2/domain/director-run-inheritance.ts')
const { presentPublicDomainError } = await import('../../src/v2/public-api/error-presenter.ts')
const { createQualityReport, resolveStrategicRubric } = await import('../../src/v2/domain/strategic-rubric.ts')
const { createPerceptionTimeline } = await import('../../src/v2/domain/perception-timeline.ts')
const { calculateVersionHash, stableSerialize } = await import('../../src/v2/application/version-hash.ts')
const factory = await import('../../src/v2/infrastructure/repository-factory.ts')

/**
 * W70 readiness. A Version made by an EXCEPTION Command inherits the quality of the DirectorRun of the ancestor it descends from, and only
 * through exception Commands. Production services and repositories, real PostgreSQL, real FFmpeg (the production proxy-render and final-export
 * workers): one project with two outputs (9:16 and 16:9) over one real recording, a DirectorRun whose quality report carries a WARNING.
 *
 *   V0  the Director's Version (run-director). Both outputs are rendered; the 9:16 review is acknowledged by a person.
 *   V1  a subtitle exception on the 16:9 output (the production Command). The 9:16 approval is carried (W70 prep).
 *       - the 9:16 output is admitted for a final export WITHOUT a DirectorRun of its own: the run is the row of V0, the receipt names V1 and the
 *         Command, the DirectorRun table was not touched; the operation persists the sealed chain and the input hash covers it;
 *       - the 16:9 output, rendered afresh on V1, KEEPS the Director's warning in its review (the false-safe: before, an exception Version read
 *         an EMPTY list of Director issues and a person would never have been asked to acknowledge it);
 *       - the production final worker renders the 9:16 final on V1 and the receipt of the operation names the chain;
 *       - a final queued with a forged chain is refused when it is queued (the owner transaction re-derives it) and a sealed one whose stored
 *         chain moved is refused by the worker before it renders anything.
 *   V2  a Command that is NOT an exception Command (the LUT selection): the walk stops there, with a precise reason, and so does the
 *       exception Command stacked on top of it (V3): the Director's quality is never read past a Command the rule does not know.
 */
const enabled = process.env.APOLLO_DIRECTOR_INHERITANCE_E2E === '1'
const WARNING_CODE = 'FACE_PERCEPTION_UNAVAILABLE_REVIEW_REQUIRED'

function directorQualityReport({ suffix, evaluatedAt }) {
  const rubric = resolveStrategicRubric('discovery')
  const strategic = createQualityReport({ objective: 'discovery',
    evidence: rubric.criteria.map((criterion) => ({ criterionId: criterion.id, score: 100, evidence: [`controlled:${criterion.id}`] })),
    gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt })
  return {
    schemaVersion: 'director-quality-report/v3', id: `quality-report-${suffix}`, desiredActionRef: { id: `action-${suffix}` },
    status: 'review-required', strategic, score: 1,
    faceSafety: { status: 'unknown', reasonCode: 'FACE_PERCEPTION_UNAVAILABLE', evidenceRefs: [] },
    hardChecks: { openingMotionProtected: true, automaticZoomDisabled: true, subtitlesFaceSafe: false, subtitlesBounded: true, forbiddenSpeechAbsent: true, timelineContinuous: true },
    issues: [{ code: WARNING_CODE, severity: 'warning', category: 'editorial',
      message: 'Face detector evidence is unavailable. Caption placement requires review before approval or final export.', correctable: true }],
    criticVersion: 'project-director-critic/v2', evaluatedAt,
  }
}

test('W70 readiness: an exception Version inherits the Director quality (final admitted, warnings kept) and nothing else does', { skip: !enabled, timeout: 1_500_000 }, async () => {
  const harnessUrl = process.env.V2_DATABASE_URL
  const poolOf = (limit) => { const url = new URL(harnessUrl); url.searchParams.set('connection_limit', String(limit)); return url.toString() }
  process.env.V2_DATABASE_URL = poolOf(3)
  const db = new PrismaClient({ datasources: { db: { url: poolOf(2) } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-w70-inherit-'))
  const artifactRoot = join(root, 'artifacts')
  await mkdir(artifactRoot, { recursive: true })
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8)
  const ffmpegPath = process.env.FFMPEG_BIN ?? require('ffmpeg-static')
  try {
    const world = await seedIssueOverrideWorld({ db, artifactRoot, suffix, ffmpegPath })
    const environment = {
      ...process.env, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', V2_DATABASE_URL: poolOf(3),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: process.env.APOLLO_PROTECTED_PAYLOAD_KEY_ID ?? `w70i-${suffix}`,
      APOLLO_PROTECTED_PAYLOAD_KEY: process.env.APOLLO_PROTECTED_PAYLOAD_KEY ?? Buffer.alloc(32, 7).toString('base64url'),
    }
    // The final worker is built for a sandbox: no private OpenVINO runtime is configured here, so the final is delivered only on an explicit,
    // recorded acknowledgement of the missing MP4 critic (never in production). What is proved here is the inheritance, not that critic.
    const finalEnvironment = {
      ...environment, APOLLO_API_ENVIRONMENT: 'sandbox',
      APOLLO_V2_MP4_CRITIC_ACK_ACTOR: 'w70-inheritance-proof', APOLLO_V2_MP4_CRITIC_ACK_AT: '2026-10-21T00:00:00.000Z',
      APOLLO_V2_MP4_CRITIC_ACK_REASON: 'the inheritance proof wires no pixel oracle',
    }
    const { workspaceId } = world.owner
    const projectId = world.projectId
    const actor = world.owner.actor
    const WIDE = world.wideVariantId, TALL = world.verticalVariantId
    const scope = { workspaceId, projectId }
    const head = async () => db.v2ProjectVersion.findUniqueOrThrow({ where: { id: (await db.v2Project.findUniqueOrThrow({ where: { id: projectId } })).currentVersionId } })
    const reviews = factory.createProxyReviewRepository()
    const now = new Date()

    /* ---------------------------------------------------------- V0: the Director's Version, with a quality report that carries a WARNING */
    const directedIds = { version: `director-version-${suffix}`, snapshot: `director-plan-${suffix}`, run: `director-run-${suffix}` }
    const snapshotIds = { perception: `director-perception-${suffix}`, treatment: `director-treatment-${suffix}`, story: `director-story-${suffix}`, quality: `director-quality-${suffix}` }
    const qualityReport = directorQualityReport({ suffix, evaluatedAt: now.toISOString() })
    for (const [id, kind, schemaVersion, content] of [
      [snapshotIds.perception, 'perception', 1, { schemaVersion: 1, id: snapshotIds.perception, timeline: createPerceptionTimeline({ durationMs: 5_000, observations: [] }),
        summary: { id: `${snapshotIds.perception}-summary`, speechCoverage: 0, visualCoverage: 'absent', faceCoverage: 'absent', confidence: 0, sourceTranscriptId: `transcript-${suffix}` } }],
      [snapshotIds.treatment, 'treatment', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.story, 'story', 1, { schemaVersion: 1, state: 'complete' }],
      [snapshotIds.quality, 'quality-report', 3, qualityReport],
    ]) {
      await db.v2ProjectSnapshot.create({ data: { id, workspaceId, projectId, kind, schemaVersion, contentJson: stableSerialize(content), contentHash: calculateVersionHash(content), createdAt: now } })
    }
    const baseVersionId = (await head()).id
    const directed = await commitSealedChild(db, { workspaceId, projectId, actor, suffix: `dir-${suffix}`, type: 'run-director', versionId: directedIds.version, snapshotId: directedIds.snapshot, mutatePlan: (plan) => ({ ...plan }) })
    await db.v2DirectorRun.create({ data: {
      id: directedIds.run, workspaceId, projectId, commandId: directed.origin.command.id, baseVersionId, resultVersionId: directedIds.version, status: 'succeeded',
      objective: 'discovery', objectiveVersion: 1, rubricRef: 'awareness-discovery/v1', plannerVersion: 'director-inheritance-1.0.0', criticVersion: 'critic-inheritance-1.0.0',
      perceptionSnapshotId: snapshotIds.perception, treatmentSnapshotId: snapshotIds.treatment, storySnapshotId: snapshotIds.story,
      editPlanSnapshotId: directed.editPlanSnapshot.id, qualitySnapshotId: snapshotIds.quality, decisionsJson: stableSerialize([]), assumptionsJson: stableSerialize([]),
      initiatedByType: 'api-client', initiatedById: world.owner.clientId, createdAt: now, updatedAt: now,
    } })
    const V0 = await head()
    assert.equal(V0.id, directedIds.version)
    const qualitySnapshotHash = calculateVersionHash(qualityReport)

    const renderOf = async (variantId) => {
      const queued = await enqueueProjectProxyRenderService({
        projects: factory.createProjectProxyRenderRepository(), operations: factory.createPublicOperationRepository(),
        colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
      })({ ...scope, actor, variantId, idempotencyKey: `w70i-${suffix}-${variantId.slice(-6)}-${randomUUID().slice(0, 6)}` })
      const failures = []
      await runProxyWorkerOnce({ environment, workspaceId, operationId: queued.operation.id, onFailure: (item) => failures.push(String(item.error?.stack ?? item.error)) })
      const status = (await db.v2PublicOperation.findUniqueOrThrow({ where: { id: queued.operation.id } })).status
      assert.equal(status, 'succeeded', `render: ${failures.join(' | ')}`)
      return db.v2ProjectProxyRenderOperation.findUniqueOrThrow({ where: { operationId: queued.operation.id } })
    }
    const reviewAt = async (variantId, versionId) => readProxyReviewService({ repository: reviews })({ ...scope, variantId, projectVersionId: versionId })
    const acknowledge = async (review, versionId, label) => (await acknowledgeProxyWarningsService({ repository: reviews, clock: () => new Date(), createId: () => randomUUID() })({
      ...scope, projectVersionId: versionId, proxyReviewId: review.id, baseReviewHash: review.reviewHash, expectedRevision: review.revision,
      action: 'acknowledge-warnings', actor, idempotencyKey: `w70i-${suffix}-ack-${label}`,
    })).review
    const finalOf = async (variantId, label, versionRow) => enqueueProjectFinalExportService({
      projects: factory.createProjectFinalExportRepository(), rights: factory.createAssetRightsRepository(), operations: factory.createPublicOperationRepository(),
      colorPipelines: factory.createColorPipelineCompilationRepository(), clock: () => new Date(), createId: (kind) => `${kind}-${randomUUID()}`,
    })({ ...scope, projectVersionId: versionRow.id, projectVersionHash: versionRow.baseHash, format: variantId === TALL ? '9:16' : '16:9', variantId,
      approval: { approved: true, note: 'Aprovado na prova de herança do Diretor.' }, actor, idempotencyKey: `w70i-${suffix}-final-${label}` })

    const wideV0 = await renderOf(WIDE), tallV0 = await renderOf(TALL)
    const tallReview0 = await reviewAt(TALL, V0.id)
    assert.ok(tallReview0.criticIssues.some((issue) => issue.code === WARNING_CODE), 'on the Director Version the review carries the Director warning (the baseline)')
    assert.equal(tallReview0.status, 'warning-ack-required')
    const approved0 = await acknowledge(tallReview0, V0.id, 'v0-tall')
    assert.equal(approved0.status, 'ready-for-final')
    const runsBefore = await db.v2DirectorRun.count({ where: scope })
    assert.equal(runsBefore, 1)

    // the Director's own Version is admitted exactly as it always was: no inheritance anywhere
    const finalRepository = new PrismaProjectFinalExportRepository(db)
    const own = await finalRepository.readApprovedCurrentSource({ ...scope, projectVersionId: V0.id, projectVersionHash: V0.baseHash, variantId: TALL })
    assert.ok(own); assert.equal(own.directorRunId, directedIds.run); assert.equal(own.directorInheritance, undefined)

    /* ---------------------------------------------------------- V1: a subtitle exception on 16:9 */
    const override = applySubtitleSegmentOverrideService({ repository: new PrismaSubtitleSegmentOverrideRepository(db), createId: (kind) => `w70i-${suffix}-${kind}-${randomUUID()}`, clock: () => new Date() })
    const commandOn = async (variantId, segmentId, text, label) => {
      const base = await head()
      const applied = await override({ ...scope, baseVersionId: base.id, baseHash: base.baseHash, variantId, segmentId, dimensions: [{ kind: 'text', text }], actor, idempotencyKey: `w70i-${suffix}-${label}` })
      await carryOverAfterCommand({ ...scope, versionId: applied.version.id, commandId: applied.command.id, affectedVariantIds: applied.impact.affectedVariantIds, actor, log: (message) => assert.fail(message) })
      return applied
    }
    const c1 = await commandOn(WIDE, 'cue-1', 'Ação', 'text-1')
    const V1 = await head()
    assert.equal(V1.id, c1.version.id)
    assert.notEqual(V1.id, V0.id)
    assert.equal(await db.v2DirectorRun.count({ where: { ...scope, resultVersionId: V1.id } }), 0, 'the exception Version has no DirectorRun of its own')

    // the 9:16 approval was carried; the output is admitted for a final export with the Director quality of V0
    const carriedTall = await reviewAt(TALL, V1.id)
    assert.equal(carriedTall.status, 'ready-for-final')
    const inherited = await finalRepository.readApprovedCurrentSource({ ...scope, projectVersionId: V1.id, projectVersionHash: V1.baseHash, variantId: TALL })
    assert.ok(inherited, 'a Version made by an exception Command is reachable by a final export')
    assert.equal(inherited.directorRunId, directedIds.run, 'the run is the row of the Director Version, not a copy')
    assert.equal(inherited.qualitySnapshotHash, qualitySnapshotHash, 'and so is its quality')
    const expectedChain = createDirectorRunInheritance({ directorResultVersionId: V0.id, links: [{ versionId: V1.id, commandId: c1.command.id }] })
    assert.deepEqual(inherited.directorInheritance, expectedChain, 'the receipt names the Director Version, the Version the quality went through and the Command that made it')
    assert.equal(await db.v2DirectorRun.count({ where: scope }), runsBefore, 'no DirectorRun row was created or copied')

    // ... and the 16:9 output, rendered afresh on V1, keeps the Director warning (the false-safe on main)
    const wideV1 = await renderOf(WIDE)
    assert.equal(wideV1.projectVersionId, V1.id)
    const wideReview1 = await reviewAt(WIDE, V1.id)
    assert.ok(wideReview1.criticIssues.some((issue) => issue.code === WARNING_CODE),
      'a fresh proxy render of an exception Version keeps the warnings of the Director quality it inherited')
    assert.equal(wideReview1.status, 'warning-ack-required', 'so a person is still asked to acknowledge them')
    assert.equal(wideReview1.finalAllowed, false)

    // ---- the final export of the 9:16 output: queued with the chain, hash and context sealed, rendered by the production worker
    const finalTall = await finalOf(TALL, 'tall-v1', V1)
    const persistedTall = await db.v2ProjectFinalExportOperation.findUniqueOrThrow({ where: { operationId: finalTall.operation.id } })
    assert.equal(persistedTall.directorRunId, directedIds.run)
    assert.deepEqual(parseDirectorRunInheritance(JSON.parse(persistedTall.directorInheritanceJson)), expectedChain, 'the sealed chain is persisted with the operation')
    assert.deepEqual(finalTall.context.directorInheritance, expectedChain)
    // a final queued with a chain that is not the Version's is refused when it is queued: the owner transaction re-derives it
    const forged = createDirectorRunInheritance({ directorResultVersionId: V0.id, links: [{ versionId: V1.id, commandId: `${c1.command.id}-forged` }] })
    await assert.rejects(
      () => factory.createPublicOperationRepository().createOrReplay({ ...finalTall, operation: { ...finalTall.operation, id: `operation-forged-${suffix}`, target: { ...finalTall.operation.target, id: `artifact-forged-${suffix}`, manifestId: `manifest-forged-${suffix}` } },
        context: { ...finalTall.context, directorInheritance: forged, outputArtifactId: `artifact-forged-${suffix}`, outputManifestId: `manifest-forged-${suffix}` },
        idempotencyKey: `w70i-${suffix}-forged`, requestFingerprint: 'e'.repeat(64) }),
      (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED' && error.details.reason === 'director-inheritance-moved',
    )
    assert.equal(await db.v2ProjectFinalExportOperation.count({ where: { ...scope, projectVersionId: V1.id } }), 1, 'nothing was written for the forged chain')

    // the WIDE output: acknowledge the inherited warning, queue its final, then move its sealed chain in storage: the worker refuses before it renders
    const approvedWide = await acknowledge(wideReview1, V1.id, 'v1-wide')
    assert.equal(approvedWide.status, 'ready-for-final')
    const finalWide = await finalOf(WIDE, 'wide-v1', V1)
    await db.v2ProjectFinalExportOperation.update({ where: { operationId: finalWide.operation.id }, data: { directorInheritanceJson: stableSerialize(forged) } })
    const workerOf = () => factory.createProjectFinalExportWorker(finalEnvironment, () => new Date())
    const outcomes = new Map()
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await workerOf()(`w70i-final-worker-${attempt}:${process.pid}:${randomUUID().slice(0, 6)}`)
      assert.ok(outcome, 'the worker claimed an operation')
      outcomes.set(outcome.operationId, outcome)
    }
    assert.deepEqual([...outcomes.keys()].sort(), [finalTall.operation.id, finalWide.operation.id].sort(), 'each final was claimed once')
    const operationStatus = async (operationId) => (await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).status
    const tallAttempts = await db.v2ProjectFinalExportAttempt.findMany({ where: { operationId: finalTall.operation.id } })
    assert.equal(await operationStatus(finalTall.operation.id), 'succeeded',
      `the 9:16 final on the exception Version is rendered: ${tallAttempts.map((attempt) => attempt.errorCode ?? attempt.validatorsJson).join(' | ').slice(0, 1500)}`)
    assert.equal(await operationStatus(finalWide.operation.id), 'failed', 'the final whose stored chain moved is refused')
    assert.equal(await db.v2MediaArtifact.count({ where: { id: finalWide.context.outputArtifactId, workspaceId } }), 0, 'and no artifact exists for it: nothing was rendered or promoted')
    const wideAttempts = await db.v2ProjectFinalExportAttempt.findMany({ where: { operationId: finalWide.operation.id } })
    assert.ok(wideAttempts.length >= 1 && wideAttempts.every((attempt) => attempt.status === 'failed' && attempt.outputArtifactId === null), 'the tampered final has no promoted attempt')
    const finalArtifact = await db.v2MediaArtifact.findFirst({ where: { id: finalTall.context.outputArtifactId, workspaceId } })
    assert.ok(finalArtifact && finalArtifact.status === 'available', 'a final of the exception Version exists')
    console.log(`W70-EVIDENCE ${JSON.stringify({ label: 'inherited-final', director: V0.id, version: V1.id, command: c1.command.id, run: directedIds.run, operation: finalTall.operation.id, artifact: finalArtifact.id, inputHash: finalTall.context.inputHash })}`)

    /* ---------------------------------------------------------- V2: a Command that is not an exception Command; V3: an exception on top of it */
    const lut = await setProjectLutSelectionService({
      repository: new PrismaProjectLutSelectionRepository(db), createId: (kind) => `w70i-${suffix}-lut-${kind}-${randomUUID()}`, createEventId: () => randomUUID(),
    })({ baseVersionId: V1.id, baseHash: V1.baseHash, selection: { mode: 'none' }, reason: 'W70 readiness: a Command the inheritance rule does not know.',
      ...scope, actor, idempotencyKey: `w70i-${suffix}-lut-2` })
    const V2 = lut.version
    const refusal = (versionId, commandType) => (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED' && error.details.reason === 'director-run-not-inherited' &&
      error.details.inheritanceReason === 'command-not-inheriting' && error.details.commandType === commandType && error.details.versionId === versionId
    await assert.rejects(() => finalRepository.readApprovedCurrentSource({ ...scope, projectVersionId: V2.id, projectVersionHash: V2.baseHash, variantId: TALL }),
      refusal(V2.id, 'set-project-lut-selection'), 'the walk stops at the Command it does not know, with its type and Version')
    await assert.rejects(() => finalOf(TALL, 'tall-v2', V2), refusal(V2.id, 'set-project-lut-selection'))
    const published = await finalOf(TALL, 'tall-v2-published', V2).catch((error) => presentPublicDomainError(error, 'request-w70i'))
    assert.equal(published.error.code, 'EDITORIAL_ACCEPTANCE_FAILED')
    const lutCommandId = (await db.v2ProjectVersion.findUniqueOrThrow({ where: { id: V2.id } })).commandId
    assert.deepEqual(published.error.details, { reason: 'director-run-not-inherited', inheritanceReason: 'command-not-inheriting', versionId: V2.id, commandId: lutCommandId, commandType: 'set-project-lut-selection' },
      'the public error says which Version and which Command stopped the walk')

    const c3 = await commandOn(WIDE, 'cue-2', 'Segunda', 'text-3')
    const V3 = await head()
    assert.equal(V3.id, c3.version.id)
    await assert.rejects(() => finalRepository.readApprovedCurrentSource({ ...scope, projectVersionId: V3.id, projectVersionHash: V3.baseHash, variantId: TALL }),
      refusal(V2.id, 'set-project-lut-selection'), 'an exception stacked on a Version the rule does not cover is not covered either: the Director run behind it is never reached')
    assert.equal(await db.v2DirectorRun.count({ where: scope }), runsBefore, 'the DirectorRun table was never written')
  } finally {
    await db.$disconnect().catch(() => undefined)
    const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
    await disconnectV2PostgresClient().catch(() => undefined)
  }
})

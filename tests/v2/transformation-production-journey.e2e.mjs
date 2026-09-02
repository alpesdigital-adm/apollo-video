import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const workspaceId = 'transformation-production-e2e-workspace'
const clientId = 'transformation-production-e2e-client'
const credentialId = 'transformation-production-e2e-credential'
// Provider capability snapshots are intentionally short-lived. Anchor the
// journey to its actual run so the production adapter and the application
// clock agree about freshness instead of comparing real time with a fixture
// date years in the future.
const runStartedAt = Date.now()
const at = (second) => new Date(runStartedAt + second * 1_000)

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

async function waitForServer(baseUrl, server) {
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Next server exited with ${server.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Timed out waiting for transformation review server')
}

test('T-FR-113/114/115/116/123/218 review mask reaches a real derivative, critic and fallback through restarted workers', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required', timeout: 480_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-transformation-production-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  const shotsRoot = join(root, 'shots')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })
  await mkdir(shotsRoot, { recursive: true })
  const suffix = randomUUID().slice(0, 8)
  const uiUsername = `transformation-user-${suffix}`
  const uiPassword = `Transformation-E2E-${suffix}-secure`
  const uiSessionSecret = `transformation-session-secret-${suffix}-32-chars`
  let server = null
  let browser = null
  let serverLogs = ''
  const cleanup = async () => {
    const identityIds = (await client.v2WorkspaceMember.findMany({ where: { workspaceId }, select: { identityId: true } })).map((row) => row.identityId)
    await client.v2TransformationCriticIssue.deleteMany({ where: { workspaceId } })
    await client.v2TransformationCriticMeasurement.deleteMany({ where: { workspaceId } })
    await client.v2TransformationCriticReport.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackAttempt.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackLedger.deleteMany({ where: { workspaceId } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2ReviewCleanupMask.deleteMany({ where: { workspaceId } })
    await client.v2ReviewAnnotation.deleteMany({ where: { workspaceId } })
    await client.v2NoveltyBudgetDecisionLine.deleteMany({ where: { workspaceId } })
    await client.v2NoveltyBudgetDecision.deleteMany({ where: { workspaceId } })
    await client.v2NoveltyBudgetPolicy.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderSelection.deleteMany({ where: { workspaceId } })
    await client.v2TransformationBrief.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderHealth.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderCapability.deleteMany({ where: { workspaceId } })
    await client.v2TransformationProviderDefinition.deleteMany({ where: { workspaceId } })
    await client.v2ProjectProxyRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2ProjectMediaAsset.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null, rightsRevision: 0 } })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    const { uiLoginThrottleKey, uiSessionSubjectHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const sessionEnvironment = { APOLLO_UI_SESSION_SECRET: uiSessionSecret }
    await client.v2UiLoginAttempt.deleteMany({ where: { subjectHash: uiSessionSubjectHash(uiUsername, sessionEnvironment) } })
    await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: uiLoginThrottleKey('direct', uiUsername, sessionEnvironment) } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId } })
    if (identityIds.length > 0) await client.v2HumanIdentity.deleteMany({ where: { id: { in: identityIds } } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }
  try {
    await cleanup()
    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { requestTransformationJobService } = await import('../../src/v2/application/transformation-jobs.ts')
    const { runProviderJobWorkerOnce } = await import('../../src/v2/application/provider-jobs.ts')
    const { createReviewCleanupMaskService, refineReviewCleanupMaskService } = await import('../../src/v2/application/review-cleanup-masks.ts')
    const { readTransformationQualityService, PersistedTransformationResultCritic } = await import('../../src/v2/application/transformation-quality.ts')
    const { persistTransformationBriefService, recordTransformationProviderHealthService, registerTransformationProviderService, routeTransformationBriefService } = await import('../../src/v2/application/transformation-provider-registry.ts')
    const { assetRightsRevision, createAssetRightsSnapshot } = await import('../../src/v2/domain/asset-rights.ts')
    const { createAssetRightsChangeIntent } = await import('../../src/v2/domain/asset-rights-change.ts')
    const { createNoveltyBudgetDecision, createNoveltyBudgetPolicy, DEFAULT_NOVELTY_BUDGET_POLICY } = await import('../../src/v2/domain/novelty-budget.ts')
    const { createTransformationBrief } = await import('../../src/v2/domain/transformation-brief.ts')
    const { createMediaArtifactManifestV2 } = await import('../../src/v2/domain/media-artifact.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaNoveltyBudgetRepository } = await import('../../src/v2/infrastructure/prisma/novelty-budget-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const { PrismaProviderJobRepository } = await import('../../src/v2/infrastructure/prisma/provider-job-repository.ts')
    const { PrismaProviderResultArtifactRepository } = await import('../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts')
    const { PrismaReviewAnnotationRepository } = await import('../../src/v2/infrastructure/prisma/review-annotation-repository.ts')
    const { PrismaReviewCleanupMaskRepository } = await import('../../src/v2/infrastructure/prisma/review-cleanup-mask-repository.ts')
    const { PrismaTransformationProviderRegistryRepository } = await import('../../src/v2/infrastructure/prisma/transformation-provider-registry-repository.ts')
    const { PrismaTransformationQualityRepository } = await import('../../src/v2/infrastructure/prisma/transformation-quality-repository.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { calculateFileSha256 } = await import('../../src/v2/infrastructure/media/local-artifact-manifest.ts')
    const { probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const { HttpTransformationProviderAdapter } = await import('../../src/v2/infrastructure/transformation/http-transformation-provider.ts')
    const { FfmpegTransformationCriticEvaluator } = await import('../../src/v2/infrastructure/transformation/ffmpeg-transformation-critic.ts')
    const { VerifiedTransformationResultIngestor } = await import('../../src/v2/infrastructure/transformation/transformation-result-ingestion.ts')

    const sourcePath = join(root, 'source.mp4')
    const approvedPath = join(root, 'approved.mp4')
    const rejectedPath = join(root, 'rejected.mp4')
    const common = ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=30:d=3', '-vf']
    execFileSync(ffmpegPath, [...common, 'drawbox=x=80:y=20:w=80:h=100:color=red:t=fill,drawbox=x=20:y=140:w=100:h=20:color=white:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath], { windowsHide: true })
    execFileSync(ffmpegPath, [...common, 'drawbox=x=80:y=20:w=80:h=100:color=red:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', approvedPath], { windowsHide: true })
    execFileSync(ffmpegPath, [...common, 'drawbox=x=80:y=20:w=80:h=100:color=green:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', rejectedPath], { windowsHide: true })
    const approvedBytes = await readFile(approvedPath)
    const rejectedBytes = await readFile(rejectedPath)

    await new PrismaWorkspaceRepository(client).create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Transformation production E2E', status: 'active', createdAt: at(0).toISOString() }))
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => at(0) })({ id: clientId, credentialId, workspaceId, name: 'Transformation production client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({ ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer', clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext })
    let entity = 0
    const created = await createProjectService({ repository: new PrismaProjectCreationRepository(client), clock: () => at(0), createId: (kind) => `${kind}-transformation-e2e-${++entity}`, createEventId: randomUUID })({ workspaceId, name: 'Advanced cleanup production journey', objective: 'awareness', format: '16:9', actor, idempotency: { clientId, key: 'transformation-production-project' } })
    const projectId = created.project.id
    const projectVersionId = created.version.id

    const storage = new LocalMediaUploadStorage(artifactRoot)
    const artifacts = new PrismaMediaArtifactRepository(client)
    const sourceSha256 = await calculateFileSha256(sourcePath)
    const sourceStored = await storage.promoteDerived({ workspaceId, sourcePath, sha256: sourceSha256, extension: 'mp4', prefix: 'masters' })
    const sourceArtifactId = 'transformation-production-source'
    const sourceManifestId = 'transformation-production-source-manifest'
    const sourceManifest = createMediaArtifactManifestV2({
      artifactKey: sourceStored.key,
      artifactSha256: sourceSha256,
      byteSize: sourceStored.byteSize,
      mediaType: 'video',
      container: 'mp4',
      recipe: { id: 'controlled-source', version: '1.0.0', parameters: { fixture: 'transformation-production-e2e' } },
      sources: [],
      probe: { fps: 30, duration: 3, width: 320, height: 180 },
    })
    await artifacts.persistOrReplay({ workspaceId, artifactId: sourceArtifactId, manifestId: sourceManifestId, lineageIds: [], manifest: sourceManifest, createdAt: at(1).toISOString() })
    await client.v2ProjectMediaAsset.create({ data: { id: randomUUID(), workspaceId, projectId, artifactId: sourceArtifactId, role: 'editing-proxy', originalFileName: 'source.mp4', createdAt: at(1) } })
    const proxyOperationId = 'operation-transformation-production-proxy'
    await client.v2PublicOperation.create({ data: { id: proxyOperationId, workspaceId, projectId, clientId, actorCredentialId: credentialId, actorEnvironment: 'production', actorAuthenticationKind: 'bearer', actorContextHash: materializeActorAuditContext(actor).contextHash, type: 'project-proxy-render', status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: sourceArtifactId, cancelable: false, retryable: false, progressCompleted: 4, progressTotal: 4, progressUnit: 'render', attempt: 1, resultJson: JSON.stringify({ artifactId: sourceArtifactId }), idempotencyKey: 'transformation-production-proxy', requestFingerprint: createHash('sha256').update('proxy-fingerprint').digest('hex'), createdAt: at(1), updatedAt: at(1), startedAt: at(1), completedAt: at(1) } })
    await client.v2ProjectProxyRenderOperation.create({ data: { operationId: proxyOperationId, workspaceId, projectId, projectVersionId, editPlanSnapshotId: created.version.snapshotRefs.editPlan, sourceArtifactId, sourceManifestId, colorPipelineBindingsJson: JSON.stringify([]), inputHash: createHash('sha256').update('proxy-input').digest('hex'), outputArtifactId: sourceArtifactId, outputManifestId: sourceManifestId, originalFileName: 'source.mp4', createdAt: at(1) } })

    const rightsRepository = new PrismaAssetRightsRepository(client)
    const rights = createAssetRightsSnapshot({ id: 'transformation-production-rights', workspaceId, artifactId: sourceArtifactId, sequence: 1, draft: { status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'], allowedSyntheticOperations: ['video-to-video'], expiresAt: '2030-01-01T00:00:00.000Z', consent: { status: 'not-required', allowedUses: [] } }, createdBy: { type: 'api-client', id: clientId }, createdAt: at(2).toISOString() })
    await rightsRepository.setCurrent(rights, assetRightsRevision(sourceArtifactId, 0), createAssetRightsChangeIntent({ workspaceId, artifactId: sourceArtifactId, snapshotHash: rights.snapshotHash, baseRevision: assetRightsRevision(sourceArtifactId, 0), actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(2).toISOString() }))

    const registry = new PrismaTransformationProviderRegistryRepository(client)
    const providerId = 'transformation-production-provider'
    await registerTransformationProviderService({ repository: registry, provider: { id: providerId, workspaceId, displayName: 'Controlled inpaint adapter', adapterId: 'controlled-inpaint', adapterVersion: '1.0.0', transport: 'api', credentialRef: 'secrets/controlled-inpaint', enabled: true, capabilities: [{ id: 'controlled-inpaint-video-to-video', operation: 'video-to-video', capabilityVersion: '1.0.0', modes: ['object-environment-change'], regions: ['br'], maximumDurationFrames: 300, maximumWidth: 1920, maximumHeight: 1080, supportsAudio: false, price: { currency: 'BRL', fixedMinorUnits: 10, perSecondMinorUnits: 2 }, qualityScoreBps: 9_000, dataRetention: 'transient' }], createdAt: at(2).toISOString(), updatedAt: at(2).toISOString() } })
    await recordTransformationProviderHealthService({ repository: registry, health: { providerId, workspaceId, status: 'healthy', circuitState: 'closed', consecutiveFailures: 0, observedLatencyMs: 80, observedAt: at(2).toISOString() } })
    const brief = createTransformationBrief({ workspaceId, projectId, projectVersionId, storyPlanId: 'story-transformation-production', storyPlanHash: createHash('sha256').update('story').digest('hex'), sourceArtifactId, sourceArtifactHash: sourceSha256, sourceRange: { startFrame: 0, endFrame: 90 }, intent: 'world-shift', editorialIntent: 'Remover a legenda queimada sem alterar o apresentador.', mode: 'object-environment-change', prompt: 'Reconstruir apenas o fundo sob a máscara da legenda.', negativeConstraints: ['não alterar o apresentador'], preserve: ['identity', 'speech'], allowedChanges: ['pixels under reviewed mask'], target: { cleanup: 'content-aware-fill' }, outputSpecIds: ['output-horizontal'], intensityBps: 1_000, noveltyBps: 500, safety: ['protected-subject'], safeZones: [{ x: .25, y: .111111, width: .25, height: .555556, purpose: 'subject' }], fallbackLadder: ['video-to-video', 'actor-composite', 'generated-cutaway', 'source-unchanged'], rightsSnapshotId: rights.id, rightsSnapshotHash: rights.snapshotHash, identitySnapshotId: 'identity-transformation-production', identitySnapshotHash: createHash('sha256').update('identity').digest('hex'), createdAt: at(3).toISOString() })
    await persistTransformationBriefService({ repository: registry, brief })
    const routed = await routeTransformationBriefService({ repository: registry, workspaceId, projectId, briefId: brief.id, policy: { region: 'br', maximumCostMinorUnits: 100, minimumQualityScoreBps: 8_000, output: { width: 320, height: 180, includeAudio: false, fps: 30 } }, createdAt: at(4).toISOString() })

    const novelty = new PrismaNoveltyBudgetRepository(client)
    const noveltyPolicy = createNoveltyBudgetPolicy({ ...DEFAULT_NOVELTY_BUDGET_POLICY, id: 'novelty-policy-transformation-production' })
    await novelty.persistPolicy({ workspaceId, policy: noveltyPolicy, createdAt: at(4).toISOString() })
    const noveltyDecision = createNoveltyBudgetDecision({ workspaceId, projectId, projectVersionId, treatmentPlanId: 'treatment-transformation-production', storyPlanId: brief.storyPlanId, policy: noveltyPolicy, candidates: [{ id: 'candidate-transformation-production', briefId: brief.id, mode: brief.mode, intensityBps: brief.intensityBps, startFrame: 0, endFrame: 90, fps: 30, servedFromCache: false }], evaluatedAt: at(4).toISOString() })
    await novelty.persistDecision({ decision: noveltyDecision, createdAt: at(4).toISOString() })
    assert.equal(noveltyDecision.treatment, 'sober')

    const annotations = new PrismaReviewAnnotationRepository(client)
    const annotation = Object.freeze({ id: randomUUID(), projectVersionId, proxyArtifactId: sourceArtifactId, proxyHash: sourceSha256, frame: 0, timeRangeMs: Object.freeze([0, 3_000]), screenshotRef: 'data:image/jpeg;base64,AA==', scope: 'region', region: Object.freeze({ x: .0625, y: .777778, width: .3125, height: .111111 }), targetIds: Object.freeze([]), applicationScope: Object.freeze({ kind: 'region', targetIds: Object.freeze([]), formatIds: Object.freeze(['output-horizontal']), localeIds: Object.freeze(['pt-BR']), recipeIds: Object.freeze([]), global: false }), affectedCount: 1, text: 'Remover legenda queimada', author: Object.freeze({ id: clientId, name: clientId, type: 'api-client' }), authenticationAudit: materializeActorAuditContext(actor), status: 'open', createdAt: at(5).toISOString() })
    await annotations.create({ workspaceId, projectId, annotation, idempotencyKey: 'transformation-production-annotation', requestFingerprint: createHash('sha256').update('annotation').digest('hex') })
    const masks = new PrismaReviewCleanupMaskRepository(client)
    let maskSequence = 0
    const createdMask = await createReviewCleanupMaskService({ masks, annotations, registry, artifacts, clock: () => at(5), createMaskId: () => `review-cleanup-mask-production-${++maskSequence}` })({ workspaceId, projectId, annotationId: annotation.id, transformationBriefId: brief.id, format: { outputSpecId: 'output-horizontal', width: 320, height: 180 }, trackingConfidenceBps: 9_000, actor, idempotencyKey: 'transformation-production-mask' })
    const mask = createdMask.persisted.mask
    const refinedMask = await refineReviewCleanupMaskService({ masks, clock: () => at(6), createMaskId: () => `review-cleanup-mask-production-${++maskSequence}` })({ workspaceId, projectId, maskId: mask.id, expectedMaskHash: mask.maskHash, region: { x: .065, y: .78, width: .305, height: .105 }, range: mask.range, keyframes: [{ frame: mask.range.startFrame, region: { x: .065, y: .78, width: .305, height: .105 } }], trackingStatus: 'tracked', trackingConfidenceBps: 9_500, actor, idempotencyKey: 'transformation-production-mask-refine' })

    const submissions = []
    const outputs = [approvedBytes, rejectedBytes]
    const statusPolls = new Map()
    const adapter = new HttpTransformationProviderAdapter({ id: 'controlled-inpaint', adapterVersion: '1.0.0', baseUrl: 'http://127.0.0.1:4001', apiKey: 'controlled-provider-key', completion: 'polling', modes: ['object-environment-change'], supportsCancellation: false, priceFixedMinorUnits: 10, pricePerSecondMinorUnits: 2, currency: 'BRL', fetchImplementation: async (url, init = {}) => {
      if (String(url).endsWith('/capabilities')) return new Response(JSON.stringify({ minSeconds: 1, maxSeconds: 30 }), { status: 200, headers: { 'content-type': 'application/json' } })
      assert.equal(new Headers(init.headers).get('x-api-key'), 'controlled-provider-key')
      if (String(url).endsWith('/transformations')) {
        const body = JSON.parse(String(init.body))
        const transmitted = Buffer.from(body.input.sourceMediaBase64, 'base64')
        assert.equal(createHash('sha256').update(transmitted).digest('hex'), sourceSha256)
        assert.equal(body.input.cleanupMask.maskHash, refinedMask.persisted.mask.maskHash)
        const providerJobId = `controlled-provider-job-${submissions.length + 1}`
        submissions.push({ operationId: body.operationId, providerJobId, sourceByteSize: transmitted.byteLength })
        statusPolls.set(providerJobId, 0)
        return new Response(JSON.stringify({ providerJobId }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      const providerJobId = submissions.find((entry) => String(url).includes(entry.providerJobId))?.providerJobId
      assert.ok(providerJobId)
      if (String(url).endsWith('/result')) {
        const media = outputs.shift()
        assert.ok(media)
        return new Response(JSON.stringify({ mediaBase64: media.toString('base64'), mediaSha256: createHash('sha256').update(media).digest('hex'), observedCost: { currency: 'BRL', costMinorUnits: 16 } }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const polls = statusPolls.get(providerJobId) ?? 0
      statusPolls.set(providerJobId, polls + 1)
      return new Response(JSON.stringify({ status: polls === 0 ? 'processing' : 'completed' }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    const adapters = { get: ({ adapterId, adapterVersion }) => adapterId === adapter.id && adapterVersion === adapter.adapterVersion ? adapter : null }
    const jobs = new PrismaProviderJobRepository(client)
    const projects = new PrismaProjectWorkspaceQueryRepository(client)
    let jobSequence = 0
    let transitionSequence = 0
    let clockSecond = 10
    const requestJob = requestTransformationJobService({ jobs, registry, adapters, projects, artifacts, rights: rightsRepository, novelty, masks, clock: () => at(clockSecond), createJobId: () => `transformation-production-job-${++jobSequence}`, createTransitionId: () => `transformation-production-transition-${++transitionSequence}`, webhookConfigured: () => false })
    const sourceMaterializer = new LocalArtifactSourceMaterializer(artifactRoot)
    const materializer = new AuthorizedProviderSubmissionInputMaterializer({ profiles: { readProfile: async () => null }, artifacts, sources: sourceMaterializer })
    const resultArtifacts = new PrismaProviderResultArtifactRepository(client)
    const ingestor = new VerifiedTransformationResultIngestor({ workRoot, storage, artifacts, artifactQuery: artifacts, resultArtifacts, prober: { probe: (path, options) => probeVideo(path, { ...options, requireAudio: false }) }, clock: () => at(clockSecond) })
    const quality = new PrismaTransformationQualityRepository(client)
    const critic = new PersistedTransformationResultCritic({ registry, quality, artifacts, novelty, evaluator: new FfmpegTransformationCriticEvaluator({ sources: sourceMaterializer, prober: { probe: (path, options) => probeVideo(path, { ...options, requireAudio: false }) } }), clock: () => at(clockSecond) })
    const runFreshWorker = async () => {
      clockSecond += 1
      return runProviderJobWorkerOnce({ jobs, adapters, materializer, ingestor, critic, clock: () => at(clockSecond), createLeaseToken: () => `transformation-production-lease-${clockSecond}`, createTransitionId: () => `transformation-production-transition-${++transitionSequence}` })(`transformation-production-worker-${clockSecond}`)
    }
    const executeToTerminal = async (idempotencyKey) => {
      const requested = await requestJob({ workspaceId, projectId, briefId: brief.id, selectionId: routed.selection.id, use: 'ads', market: 'BRA', locale: 'pt-BR', maskId: refinedMask.persisted.mask.id, outputSpecId: 'output-horizontal', actor, idempotencyKey })
      for (let stage = 0; stage < 6; stage += 1) await runFreshWorker()
      return jobs.read({ workspaceId, projectId, jobId: requested.persisted.job.id })
    }

    const approved = await executeToTerminal('transformation-production-approved')
    assert.equal(approved.job.status, 'approved')
    const acceptedArtifact = await artifacts.findById(workspaceId, approved.job.resultArtifact.artifactId)
    assert.notEqual(acceptedArtifact.id, sourceArtifactId)
    assert.equal(await calculateFileSha256(join(artifactRoot, ...acceptedArtifact.artifactKey.split('/'))), acceptedArtifact.sha256)
    const rejected = await executeToTerminal('transformation-production-rejected')
    assert.equal(rejected.job.status, 'rejected')
    assert.equal(submissions.length, 2)
    assert.equal(submissions.every((entry) => entry.sourceByteSize === sourceStored.byteSize), true)

    const review = await readTransformationQualityService({ quality, novelty })({ workspaceId, projectId, actor })
    assert.equal(review.reports.length, 2)
    assert.equal(review.reports.every((report) => report.measurements.length === 14), true)
    const rejectedReport = review.reports.find((report) => report.providerJobId === rejected.job.id)
    assert.equal(rejectedReport.decision, 'rejected')
    assert.equal(rejectedReport.hardGates.includes('preserve-list'), true)
    const latestLedger = review.ledgers[0].ledger
    assert.equal(latestLedger.currentRung, 'actor-composite')
    assert.deepEqual(
      latestLedger.attempts.map(({ rung, outcome }) => ({ rung, outcome })),
      [
        { rung: 'video-to-video', outcome: 'approved' },
        { rung: 'video-to-video', outcome: 'rejected' },
        { rung: 'actor-composite', outcome: 'skipped' },
      ],
    )
    assert.equal(latestLedger.bestArtifactId, acceptedArtifact.id)
    assert.equal(latestLedger.incurredCostMinorUnits, 32)
    assert.equal(review.novelty[0].treatment, 'sober')
    assert.deepEqual(await readdir(workRoot), [])

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '200', APOLLO_V2_PERSISTENCE: 'postgres',
      APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: uiUsername,
      APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `transformation-salt-${suffix}`),
      APOLLO_UI_SESSION_SECRET: uiSessionSecret, APOLLO_UI_API_CLIENT_ID: clientId,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_RENDER_WORK_ROOT: workRoot,
      APOLLO_V2_PROVIDER_WORK_ROOT: join(workRoot, 'provider'),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'transformation-e2e-protected-payload',
      APOLLO_PROTECTED_PAYLOAD_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath,
    }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const executablePath = [
      process.env.PLAYWRIGHT_CHROME_EXECUTABLE,
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      '/usr/bin/google-chrome', '/usr/bin/chromium',
    ].find((candidate) => candidate && existsSync(candidate))
    assert.ok(executablePath, 'set PLAYWRIGHT_CHROME_EXECUTABLE to run the transformation browser E2E')
    const { chromium } = await import('playwright-core')
    browser = await chromium.launch({ executablePath, headless: true })
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    const page = await context.newPage()
    context.setDefaultTimeout(60_000)
    context.setDefaultNavigationTimeout(120_000)
    await page.goto(`${baseUrl}/login?next=${encodeURIComponent(`/projects/${projectId}`)}`)
    await page.locator('input[name="username"]').fill(uiUsername)
    await page.locator('input[name="password"]').fill(uiPassword)
    const loginCompleted = page.waitForResponse((response) => response.url().endsWith('/v1/session') && response.request().method() === 'POST')
    await page.getByRole('button', { name: 'Entrar no Apollo' }).click()
    assert.ok([200, 303].includes((await loginCompleted).status()))
    await page.goto(`${baseUrl}/projects/${projectId}`, { waitUntil: 'domcontentloaded' })
    const panel = page.getByTestId('transformation-review-panel')
    await panel.waitFor({ state: 'visible', timeout: 120_000 })
    await panel.getByText('Critic de 14 dimensões').waitFor({ state: 'visible' })
    assert.match(await panel.innerText(), /Fonte preservada/)
    assert.match(await panel.innerText(), /BRL 0\.32/)
    assert.match(await panel.innerText(), /sober/)
    assert.equal(await panel.locator('span').filter({ hasText: /^identity$/ }).count() > 0, true)

    await panel.getByLabel('Região x').fill('0.07')
    await panel.getByLabel('Estado do tracking').selectOption('tracked')
    await panel.getByLabel('Confiança do tracking').fill('96')
    const refinementResponse = page.waitForResponse((response) => response.url().includes('/review-cleanup-masks/') && response.url().endsWith('/refinements') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: 'Gravar refino' }).click()
    assert.equal((await refinementResponse).status(), 201)
    await panel.getByText('3 máscaras persistidas').waitFor({ state: 'visible' })
    assert.equal(await client.v2ReviewCleanupMask.count({ where: { workspaceId } }), 3)

    const acceptanceResponse = page.waitForResponse((response) => response.url().includes('/transformation-fallbacks/') && response.url().endsWith('/actions') && response.request().method() === 'POST')
    await panel.getByRole('button', { name: 'Aceitar resultado' }).click()
    assert.equal((await acceptanceResponse).status(), 201)
    const screenshotPath = process.env.APOLLO_TRANSFORMATION_E2E_SCREENSHOT ?? join(shotsRoot, 'transformation-reviewed-and-accepted.png')
    await mkdir(dirname(screenshotPath), { recursive: true })
    await page.screenshot({ path: screenshotPath, fullPage: true })
    const acceptedLedger = await quality.readLatestFallbackLedger({ workspaceId, projectId, briefId: brief.id })
    assert.equal(acceptedLedger.reviewDecision, 'accepted')
    const cookie = (await context.cookies()).map((entry) => `${entry.name}=${entry.value}`).join('; ')
    const actionUrl = `${baseUrl}/v1/projects/${projectId}/transformation-fallbacks/${latestLedger.id}/actions`
    const repeatAcceptance = await fetch(actionUrl, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept' }) })
    assert.equal(repeatAcceptance.status, 200)
    assert.equal((await repeatAcceptance.json()).data.replayed, true)
    const staleContradiction = await fetch(actionUrl, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'keep-source' }) })
    assert.equal(staleContradiction.status, 409)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    if (server && server.exitCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { server.kill('SIGKILL'); resolve() }, 10_000)
        server.once('exit', () => { clearTimeout(timeout); resolve() })
        server.kill('SIGTERM')
      })
    }
    await cleanup().catch(() => undefined)
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
    if (process.env.APOLLO_TRANSFORMATION_E2E_DEBUG === '1') console.error(serverLogs.slice(-4_000))
  }
})

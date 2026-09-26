import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path
const execFileAsync = promisify(execFile)

const RUN = process.env.APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E === '1'
const SKIP = RUN
  ? false
  : 'set APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E=1 with built Next/Remotion, isolated PostgreSQL and controlled media'

const workspaceId = 'provider-journey-e2e-workspace'
const clientId = 'provider-journey-e2e-client'
const credentialId = 'provider-journey-e2e-credential'
const hash = (character) => character.repeat(64)
const journeyEpochMs = Date.now() - 120_000
const at = (second) => new Date(journeyEpochMs + second * 1_000).toISOString()

const SCRIPT = 'Olá mundo'
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('hex')
const storageDriver = (process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER ?? 'local').trim().toLowerCase()

function ttsAlignment(durationSeconds) {
  const characters = [...SCRIPT]
  const step = durationSeconds / characters.length
  return {
    characters,
    startTimesSeconds: characters.map((_, index) => index * step),
    endTimesSeconds: characters.map((_, index) => (index + 1) * step),
  }
}

function assertSafeJourneyEnvironment() {
  assert.ok(process.env.V2_DATABASE_URL, 'V2_DATABASE_URL must name an isolated local PostgreSQL')
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  assert.match(url.pathname.slice(1), /(?:^|_)e2e(?:_|$)/)
  assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-synthetic-wave24-[a-z0-9-]+$/)
  assert.equal(Number(url.searchParams.get('connection_limit')), 1)
  for (const field of ['pool_timeout', 'connect_timeout']) {
    const value = Number(url.searchParams.get(field))
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 10)
  }
  assert.ok(process.env.APOLLO_WAVE24_RUN_ID && /^[a-z0-9-]+$/.test(process.env.APOLLO_WAVE24_RUN_ID))
  assert.ok(process.env.APOLLO_WAVE24_EVIDENCE_ROOT && isAbsolute(process.env.APOLLO_WAVE24_EVIDENCE_ROOT))
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer()
    socket.unref()
    socket.once('error', reject)
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address()
      const port = typeof address === 'object' && address ? address.port : 0
      socket.close(() => resolve(port))
    })
  })
}

function boundedFetch(input, init, testSignal, timeoutMs = 10_000) {
  const signals = [testSignal, AbortSignal.timeout(timeoutMs)]
  if (init?.signal) signals.push(init.signal)
  return globalThis.fetch(input, { ...init, signal: AbortSignal.any(signals) })
}

async function waitForServer(baseUrl, server, readLogs, testSignal) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error(`Next server exited with ${server.exitCode ?? server.signalCode}\n${readLogs()}`)
    }
    try {
      if ((await boundedFetch(`${baseUrl}/v1/health`, undefined, testSignal)).ok) return
    } catch {}
    await delay(250, undefined, { signal: testSignal })
  }
  throw new Error(`Timed out waiting for Next server\n${readLogs()}`)
}

async function childExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true
  return new Promise((resolve) => {
    let timer
    const finish = (exited) => {
      clearTimeout(timer)
      child.off('exit', onExit)
      resolve(exited)
    }
    const onExit = () => finish(true)
    child.once('exit', onExit)
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}

function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 15_000,
      })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error
    }
  } else {
    signalProcessGroup(child, 'SIGTERM')
  }
  if (await childExitWithin(child, 5_000)) return
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 15_000,
      })
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error
    }
  } else {
    signalProcessGroup(child, 'SIGKILL')
  }
  assert.equal(await childExitWithin(child, 10_000), true, `Next process tree ${child.pid} did not stop`)
}

async function readJsonResponse(response, label) {
  const payload = await response.json()
  assert.ok(response.ok, `${label} failed HTTP ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

async function readExpectedPublicResponse(response, label, expectedStatus, t) {
  const payload = await response.json()
  const error = payload && typeof payload === 'object' && payload.error && typeof payload.error === 'object'
    ? payload.error
    : null
  const diagnostic = Object.freeze({
    status: response.status,
    code: error && typeof error.code === 'string' ? error.code : null,
    message: error && typeof error.message === 'string' ? error.message : null,
  })
  if (response.status !== expectedStatus) t.diagnostic(`${label} public response: ${JSON.stringify(diagnostic)}`)
  assert.equal(response.status, expectedStatus, `${label} returned ${JSON.stringify(diagnostic)}`)
  return payload
}

test('W24.3 controlled provider to canonical cross-project render and phase-gate browser journey', {
  skip: SKIP,
  timeout: 1_500_000,
}, async (t) => {
  assertSafeJourneyEnvironment()
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-provider-journey-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  await mkdir(artifactRoot, { recursive: true })
  await mkdir(workRoot, { recursive: true })

  let objectStore = null
  let server = null
  let browser = null
  let fallbackFixture = null
  let serverLogs = ''
  let primaryError = null
  const expectedRenderOutputKeys = []
  const appendServerLog = (chunk) => {
    serverLogs = `${serverLogs}${String(chunk)}`.slice(-256 * 1024)
  }
  const evidenceRoot = join(
    resolve(process.env.APOLLO_WAVE24_EVIDENCE_ROOT),
    process.env.APOLLO_WAVE24_RUN_ID,
  )
  const uiSuffix = process.env.APOLLO_WAVE24_RUN_ID.slice(-24)
  const uiUsername = `synthetic-wave24-${uiSuffix}`
  const uiPassword = `Wave24-${uiSuffix}-controlled-secure`
  const uiSessionSecret = `wave24-${uiSuffix}-session-secret-32-chars`
  await mkdir(evidenceRoot, { recursive: true })

  const cleanup = async () => {
    const identityIds = (await client.v2WorkspaceMember.findMany({
      where: { workspaceId }, select: { identityId: true },
    })).map(({ identityId }) => identityId)
    await client.v2SyntheticPhaseGateEvidence.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPhaseGate.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticBuildAttestation.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionRenderQualityReport.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionRenderOperation.deleteMany({ where: { workspaceId } })
    await client.v2PublicOperation.deleteMany({ where: { workspaceId } })
    await client.v2TransformationCriticIssue.deleteMany({ where: { workspaceId } })
    await client.v2TransformationCriticMeasurement.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackDispatchRequest.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackDispatchClaim.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackAttempt.deleteMany({ where: { workspaceId } })
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
    await client.v2SyntheticCriticIssue.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticCriticMeasurement.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticCriticEvaluator.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticCriticReport.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
    await client.v2SyntheticCacheSubmissionClaim.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticMasterConsumption.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticCacheDecision.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticBlockGeneration.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticSpeechSegment.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticMasterArtifact.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticMasterAsset.deleteMany({ where: { workspaceId } })
    await client.v2ProviderExecutionReceipt.deleteMany({ where: { workspaceId } })
    await client.v2ProviderTransportEvidence.deleteMany({ where: { workspaceId } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionAsset.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticProductionRun.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticAudioMaster.deleteMany({ where: { workspaceId } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId } })
    await client.v2TransformationFallbackLedger.deleteMany({ where: { workspaceId } })
    await client.v2TransformationCriticReport.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null, rightsRevision: 0 } })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId } })
    await client.v2RecipeParameterPayload.deleteMany({ where: { workspaceId } })
    await client.v2RenderInputPayload.deleteMany({ where: { workspaceId } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId } })
    await client.v2Project.deleteMany({ where: { workspaceId } })
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    const { uiLoginThrottleKey, uiSessionSubjectHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const sessionEnvironment = { APOLLO_UI_SESSION_SECRET: uiSessionSecret }
    await client.v2UiLoginAttempt.deleteMany({
      where: { subjectHash: uiSessionSubjectHash(uiUsername, sessionEnvironment) },
    })
    await client.v2UiLoginThrottle.deleteMany({
      where: { keyHash: uiLoginThrottleKey('direct', uiUsername, sessionEnvironment) },
    })
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
    const { createExternalAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { enqueueProviderJobService, runProviderJobWorkerOnce } = await import('../../src/v2/application/provider-jobs.ts')
    const { createSyntheticScriptPlanService } = await import('../../src/v2/application/synthetic-script-plans.ts')
    const { ensureSyntheticBlockGenerationsService, settleSyntheticBlockGenerationsService } = await import('../../src/v2/application/synthetic-block-generations.ts')
    const { evaluateSyntheticCriticCore } = await import('../../src/v2/application/synthetic-critic.ts')
    const { SpecializedSyntheticProviderResultCritic } = await import('../../src/v2/application/synthetic-provider-critic.ts')
    const { createSyntheticAudioMasterService } = await import('../../src/v2/application/synthetic-audio-masters.ts')
    const { promoteSyntheticMasterAssetService } = await import('../../src/v2/application/synthetic-master-assets.ts')
    const { catalogSyntheticSpeechSegmentsService } = await import('../../src/v2/application/synthetic-speech-segments.ts')
    const { createSyntheticProductionRunService } = await import('../../src/v2/application/synthetic-production.ts')
    const { prepareCanonicalSyntheticMasterReuseService } = await import('../../src/v2/application/prepare-synthetic-master-reuse.ts')
    const { assetRightsRevision, createAssetRightsSnapshot } = await import('../../src/v2/domain/asset-rights.ts')
    const { createAssetRightsChangeIntent } = await import('../../src/v2/domain/asset-rights-change.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { createMediaArtifactManifestV2 } = await import('../../src/v2/domain/media-artifact.ts')
    const { calculateSyntheticCacheKey } = await import('../../src/v2/domain/synthetic-cache-identity.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
    const { prepareControlledTransformationFallbackFixture } = await import('./helpers/run-controlled-transformation-fallback.mjs')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaProjectWorkspaceQueryRepository } = await import('../../src/v2/infrastructure/prisma/project-workspace-query-repository.ts')
    const { PrismaProviderJobRepository } = await import('../../src/v2/infrastructure/prisma/provider-job-repository.ts')
    const { PrismaProviderResultArtifactRepository } = await import('../../src/v2/infrastructure/prisma/provider-result-artifact-repository.ts')
    const { PrismaProviderExecutionProvenanceRepository } = await import('../../src/v2/infrastructure/prisma/provider-execution-provenance-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticAudioMasterRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-audio-master-repository.ts')
    const { PrismaSyntheticMasterAssetRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-master-asset-repository.ts')
    const { PrismaSyntheticSpeechSegmentRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-speech-segment-repository.ts')
    const { PrismaPromotableProviderJobReader, PrismaStoredArtifactIdentityReader } = await import('../../src/v2/infrastructure/prisma/synthetic-master-promotion-readers.ts')
    const { PrismaSyntheticMasterReuseRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-master-reuse-repository.ts')
    const { PrismaSyntheticScriptPlanRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-script-plan-repository.ts')
    const { PrismaSyntheticBlockGenerationRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-block-generation-repository.ts')
    const { PrismaSyntheticCacheDecisionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-cache-decision-repository.ts')
    const { PrismaSyntheticCacheSubmissionClaimRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-cache-submission-claim-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')
    const { PrismaSyntheticCriticRuntimeContextResolver } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-runtime-context.ts')
    const { LocalArtifactSourceMaterializer, LocalMediaUploadStorage } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
    const { LocalArtifactContentStorage } = await import('../../src/v2/infrastructure/media/local-artifact-content-storage.ts')
    const { StoredSyntheticMasterAlignmentReader } = await import('../../src/v2/infrastructure/media/synthetic-master-alignment-reader.ts')
    const { ArtifactContentSyntheticMasterByteVerifier, FfmpegDecodedSyntheticAudioDurationReader, FfprobeSyntheticMasterDurationProber } = await import('../../src/v2/infrastructure/media/synthetic-master-media.ts')
    const { FfprobeSyntheticCriticMediaEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-media-integrity.ts')
    const { AlignmentSyntheticCriticPronunciationEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-pronunciation.ts')
    const { DeterministicSyntheticCriticControlledEvaluator } = await import('../../src/v2/infrastructure/media/synthetic-critic-controlled-probe.ts')
    const { S3ArtifactContentStorage, S3ArtifactSourceMaterializer, S3VerifiedMediaStorage, createArtifactS3ClientFromEnvironment } = await import('../../src/v2/infrastructure/media/s3-artifact-storage.ts')
    const { probeAudioDurationSeconds, probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
    const { ControlledAsyncMediaProviderAdapter } = await import('../../src/v2/infrastructure/controlled-async-media-provider.ts')
    const { FfmpegAvatarAudioComparison } = await import('../../src/v2/infrastructure/media/ffmpeg-avatar-audio-comparison.ts')
    const { AuthorizedProviderSubmissionInputMaterializer } = await import('../../src/v2/infrastructure/provider-submission-input-materializer.ts')
    const {
      PersistedProviderResultCritic,
      PersistedTtsResultCritic,
      VerifiedProviderResultIngestor,
      VerifiedTtsResultIngestor,
    } = await import('../../src/v2/infrastructure/provider-result-ingestion.ts')
    const { calculateFileSha256 } = await import('../../src/v2/infrastructure/media/local-artifact-manifest.ts')
    const { calculateCanonicalHash } = await import('../../src/v2/domain/canonical-hash.ts')

    // Real media fixtures produced by real FFmpeg: the "provider" outputs.
    const ttsAudioPath = join(root, 'tts-speech.mp3')
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', ttsAudioPath], { windowsHide: true })
    const ttsAudioBytes = await readFile(ttsAudioPath)
    const avatarVideoPath = join(root, 'avatar-result.mp4')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=2',
      '-i', ttsAudioPath, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', avatarVideoPath,
    ], { windowsHide: true })
    const bRollPath = join(root, 'consumer-b-broll.png')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2347D9:s=540x960', '-frames:v', '1', bRollPath,
    ], { windowsHide: true })
    const overlayPath = join(root, 'consumer-b-overlay.png')
    execFileSync(ffmpegPath, [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xF2C94C:s=540x960', '-frames:v', '1', overlayPath,
    ], { windowsHide: true })

    await new PrismaWorkspaceRepository(client).create(createWorkspace({
      id: workspaceId, slug: workspaceId, name: 'Provider Journey E2E', status: 'active', createdAt: at(0),
    }))
    const issued = await createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })({ id: clientId, credentialId, workspaceId, name: 'Provider journey client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const auditContext = createExternalAuditContext({ clientId, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const actor = Object.freeze({
      ...auditContext, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
    })
    let entity = 0
    let event = 0
    const project = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-provider-journey-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(900_000 + ++event).padStart(12, '0')}`,
    })({ workspaceId, name: 'Jornada TTS para avatar', objective: 'awareness', format: '9:16', actor, idempotency: { clientId, key: 'provider-journey-project' } })

    await client.v2MediaArtifact.create({
      data: {
        id: 'journey-consent-evidence', workspaceId, artifactKey: 'provider-journey/consent.json',
        sha256: hash('a'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const artifactRepository = new PrismaMediaArtifactRepository(client)
    const syntheticRepository = new PrismaSyntheticProductionRepository(client)
    const registerProfile = registerSyntheticPresenterProfileService({
      repository: syntheticRepository, artifacts: artifactRepository, clock: () => new Date(at(0)),
    })
    const registered = await registerProfile({
      workspaceId, profileId: 'journey-presenter', version: 1, actorIdentityId: 'journey-identity',
      avatar: { adapterId: 'controlled-avatar', adapterVersion: '1.0.0', identityRef: 'avatar_journey_123' },
      voice: { id: 'voice_journey_123', version: 1, adapterId: 'controlled-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'journey-consent', evidenceArtifactId: 'journey-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'journey-profile-key',
    })

    const ttsCapabilities = {
      operations: ['tts'], inputFormats: ['text'], outputFormats: ['mp3'], locales: ['pt-BR'],
      duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: false,
      supportsIdempotency: true, supportsCancellation: false, completion: 'synchronous',
      fetchedAt: at(3), expiresAt: '2030-01-01T00:00:00.000Z',
    }
    const ttsEstimate = { currency: 'USD', costMinorUnits: 0, estimatedLatencyMs: 500 }
    const ttsAdapterConfigHash = calculateCanonicalHash({
      id: 'controlled-tts', adapterVersion: '1.0.0', capabilities: ttsCapabilities, estimate: ttsEstimate,
    })
    let ttsAdapter = null
    const avatarCapabilities = {
      operations: ['audio-avatar'], inputFormats: ['mp3'], outputFormats: ['mp4'], locales: ['pt-BR'],
      duration: { minSeconds: 1, maxSeconds: 60 }, identityReference: 'profile-id', supportsSeed: true,
      supportsIdempotency: true, supportsCancellation: false, completion: 'polling',
      fetchedAt: at(3), expiresAt: '2030-01-01T00:00:00.000Z',
    }
    const avatarEstimate = { currency: 'USD', costMinorUnits: 0, estimatedLatencyMs: 3_000 }
    const avatarAdapterConfigHash = calculateCanonicalHash({
      id: 'controlled-avatar', adapterVersion: '1.0.0', capabilities: avatarCapabilities, estimate: avatarEstimate,
    })
    const avatarAdapter = new ControlledAsyncMediaProviderAdapter('controlled-avatar', '1.0.0', {
      capabilities: avatarCapabilities,
      estimate: avatarEstimate,
      statuses: ['queued', 'processing', 'completed'],
      completedAt: at(12),
      observedCost: { currency: 'USD', costMinorUnits: 0 },
      result: {
        providerJobId: 'controlled-avatar:journey-avatar-key',
        downloadUrl: 'controlled://avatar/result.mp4',
        mediaType: 'video',
        adapterConfigHash: avatarAdapterConfigHash,
        outputSpeechEvidence: {
          schemaVersion: 'controlled-avatar-output-speech/v1',
          outputTranscriptHash: SCRIPT_HASH,
          observedIdentityRef: 'avatar_journey_123',
          evaluatorId: 'controlled-output-speech',
          evaluatorVersion: '1.0.0',
        },
      },
    })
    const registry = {
      get: ({ adapterId, adapterVersion }) => {
        if (adapterId === 'controlled-tts' && adapterVersion === '1.0.0') return ttsAdapter
        if (adapterId === 'controlled-avatar' && adapterVersion === '1.0.0') return avatarAdapter
        return null
      },
    }

    // Storage of record: the content-addressed local root by default, or real
    // versioned MinIO/S3 when the runtime driver env selects it (CI Compose).
    assert.ok(['local', 's3'].includes(storageDriver), `unknown artifact storage driver: ${storageDriver}`)
    if (storageDriver === 's3') {
      const aws = await import('@aws-sdk/client-s3')
      const { bucket, client: s3Client } = createArtifactS3ClientFromEnvironment()
      // Exclusive clean bucket per run: creating it must succeed — an existing
      // bucket would mean shared or inherited state, which is forbidden here.
      await s3Client.send(new aws.CreateBucketCommand({ Bucket: bucket }))
      await s3Client.send(new aws.PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }))
      objectStore = { aws, bucket, client: s3Client }
    }
    const localStaging = new LocalMediaUploadStorage(artifactRoot)
    const storage = objectStore
      ? new S3VerifiedMediaStorage(localStaging, { bucket: objectStore.bucket, client: objectStore.client })
      : localStaging
    const materializeRoot = join(root, 'materialize')
    await mkdir(materializeRoot, { recursive: true })
    const sourceMaterializer = objectStore
      ? new S3ArtifactSourceMaterializer(materializeRoot, { bucket: objectStore.bucket, client: objectStore.client })
      : new LocalArtifactSourceMaterializer(artifactRoot)
    const readbackRoot = join(root, 'readback')
    await mkdir(readbackRoot, { recursive: true })
    let readbackSequence = 0
    // Local path whose bytes ARE the stored artifact: a version-bound GET from
    // MinIO in s3 mode, or the content-addressed path in local mode.
    const storedArtifactPath = async (artifactKey) => {
      if (!objectStore) return join(artifactRoot, ...artifactKey.split('/'))
      const head = await objectStore.client.send(new objectStore.aws.HeadObjectCommand({ Bucket: objectStore.bucket, Key: artifactKey }))
      assert.ok(head.VersionId && head.VersionId !== 'null', 'stored artifact object must be version-bound')
      const object = await objectStore.client.send(new objectStore.aws.GetObjectCommand({ Bucket: objectStore.bucket, Key: artifactKey, VersionId: head.VersionId }))
      const target = join(readbackRoot, `${readbackSequence += 1}-${artifactKey.split('/').at(-1)}`)
      await writeFile(target, Buffer.from(await object.Body.transformToByteArray()))
      return target
    }
    const providerRepository = new PrismaProviderJobRepository(client)
    const resultArtifactRepository = new PrismaProviderResultArtifactRepository(client)
    let tick = 0
    const controlledWorkerClock = () => new Date(at(tick + 2))
    const provenanceRepository = new PrismaProviderExecutionProvenanceRepository(client, controlledWorkerClock)
    const rightsRepository = new PrismaAssetRightsRepository(client)
    const projectsQuery = new PrismaProjectWorkspaceQueryRepository(client)
    const audioMasterRepository = new PrismaSyntheticAudioMasterRepository(client)
    const plans = new PrismaSyntheticScriptPlanRepository(client)
    const generations = new PrismaSyntheticBlockGenerationRepository(client)
    const criticReports = new PrismaSyntheticCriticReportRepository(client)
    let providerTransition = 0
    const enqueue = enqueueProviderJobService({
      jobs: providerRepository, adapters: registry, profiles: syntheticRepository,
      audioMasters: audioMasterRepository, projects: projectsQuery, artifacts: artifactRepository,
      rights: rightsRepository, clock: () => new Date(at(1)),
      createJobId: () => `journey-job-${entity += 1}`,
      createTransitionId: () => `journey-transition-${++providerTransition}`,
      resolveAvatarCriticBinding: async ({ audioMaster, audioRange, profileSnapshotId, use, market, locale }) => {
        assert.equal(audioMaster.source.kind, 'tts')
        const generation = await generations.findByProviderJob({
          workspaceId, projectId: project.project.id, providerJobId: audioMaster.source.providerJobId,
        })
        assert.ok(generation)
        const block = await client.v2SyntheticScriptBlock.findUniqueOrThrow({ where: { id: generation.blockId } })
        return Object.freeze({
          blockId: generation.blockId, scriptText: block.exactText, scriptHash: generation.scriptHash,
          profileSnapshotId, expectedDurationMs: audioRange.durationMs,
          alignmentArtifactId: audioMaster.alignmentEvidence.artifactId, use, market, locale,
        })
      },
    })

    const createdPlan = await createSyntheticScriptPlanService({
      plans, projects: projectsQuery, profiles: syntheticRepository,
      clock: () => new Date(at(1)), createId: (kind) => `${kind}-provider-journey-${++entity}`,
    })({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId, locale: 'pt-BR', scriptText: SCRIPT,
      actor, idempotencyKey: 'provider-journey-script-plan',
    })
    const planId = createdPlan.plan.head.id
    const [scriptBlock] = createdPlan.plan.blocks
    assert.ok(scriptBlock, 'the controlled script plan must contain one block')
    const generationId = `sbg-${createHash('sha256').update(`${scriptBlock.id}:1`, 'utf8').digest('hex').slice(0, 48)}`
    const ttsProviderJobRef = `controlled-tts:bg-${generationId}`
    ttsAdapter = new ControlledAsyncMediaProviderAdapter('controlled-tts', '1.0.0', {
      capabilities: ttsCapabilities,
      estimate: ttsEstimate,
      statuses: [],
      completedAt: at(3),
      observedCost: { currency: 'USD', costMinorUnits: 0 },
      result: {
        requestId: ttsProviderJobRef,
        modelId: 'controlled-tts-model',
        adapterConfigHash: ttsAdapterConfigHash,
        scriptHash: SCRIPT_HASH,
        audioBytes: new Uint8Array(ttsAudioBytes),
        audioSha256: createHash('sha256').update(ttsAudioBytes).digest('hex'),
        audioByteSize: ttsAudioBytes.byteLength,
        audioContainer: 'mp3',
        mediaType: 'audio',
        alignment: ttsAlignment(2),
      },
    })
    const ensureTts = ensureSyntheticBlockGenerationsService({
      plans, generations, profiles: syntheticRepository, artifacts: artifactRepository,
      rights: rightsRepository, cacheDecisions: new PrismaSyntheticCacheDecisionRepository(client),
      providerJobs: providerRepository, resultArtifacts: resultArtifactRepository, criticReports,
      submissionClaims: new PrismaSyntheticCacheSubmissionClaimRepository(client),
      enqueueProviderJob: enqueue, clock: () => new Date(at(1)),
    })
    const [ttsGenerationOutcome] = await ensureTts({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      planId, use: 'ads', market: 'BRA', actor,
    })
    assert.equal(ttsGenerationOutcome.action, 'enqueued')
    const [pendingGeneration] = await generations.listByPlan({ workspaceId, planId, statuses: ['pending'] })
    assert.ok(pendingGeneration?.providerJobId)
    const ttsJobId = pendingGeneration.providerJobId
    const ttsEnqueued = await providerRepository.read({ workspaceId, projectId: project.project.id, jobId: ttsJobId })
    assert.equal(ttsEnqueued.job.status, 'planned')

    // A real PostgreSQL CAS keeps long media work fenced: renewal extends the
    // same owner/token lease, prevents reclaim at the original expiry, and an
    // owner whose lease was later reclaimed cannot renew it again.
    const originalClaim = await providerRepository.claimNext({
      workerId: 'journey-lease-owner-one',
      leaseToken: 'journey-lease-token-one',
      now: new Date(at(1)),
      leaseExpiresAt: new Date(at(31)),
    })
    assert.equal(originalClaim.job.id, ttsJobId)
    const renewedClaim = await providerRepository.renewLease({
      current: originalClaim,
      now: new Date(at(20)),
      leaseExpiresAt: new Date(at(50)),
    })
    assert.equal(renewedClaim.lease.expiresAt, at(50))
    assert.equal(await providerRepository.claimNext({
      workerId: 'journey-lease-rival-early',
      leaseToken: 'journey-lease-rival-token-early',
      now: new Date(at(31)),
      leaseExpiresAt: new Date(at(61)),
    }), null, 'renewal must prevent reclaim at the original lease expiry')
    const rivalClaim = await providerRepository.claimNext({
      workerId: 'journey-lease-rival-late',
      leaseToken: 'journey-lease-rival-token-late',
      now: new Date(at(51)),
      leaseExpiresAt: new Date(at(81)),
    })
    assert.equal(rivalClaim.job.id, ttsJobId)
    await assert.rejects(providerRepository.renewLease({
      current: renewedClaim,
      now: new Date(at(52)),
      leaseExpiresAt: new Date(at(82)),
    }), (error) => error.code === 'VERSION_CONFLICT')
    await client.v2ProviderJob.update({
      where: { id: ttsJobId },
      data: { leaseOwner: null, leaseToken: null, leaseExpiresAt: null },
    })

    const materializer = new AuthorizedProviderSubmissionInputMaterializer({
      profiles: syntheticRepository, artifacts: artifactRepository,
      sources: sourceMaterializer, clock: () => new Date(at(2)),
    })
    const ttsIngestor = new VerifiedTtsResultIngestor({
      workRoot, storage, artifacts: artifactRepository, artifactQuery: artifactRepository,
      resultArtifacts: resultArtifactRepository,
      audioProber: { probeDurationSeconds: (path, options) => probeAudioDurationSeconds(path, options) },
      clock: () => new Date(at(3)),
    })
    const contentStorage = objectStore
      ? new S3ArtifactContentStorage({ bucket: objectStore.bucket, client: objectStore.client })
      : new LocalArtifactContentStorage(artifactRoot)
    const alignment = new StoredSyntheticMasterAlignmentReader({
      artifacts: artifactRepository,
      storage: contentStorage,
    })
    const evaluateSynthetic = evaluateSyntheticCriticCore({
      reports: criticReports,
      media: new FfprobeSyntheticCriticMediaEvaluator({
        sources: sourceMaterializer,
        environment: { ...process.env, FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath },
      }),
      pronunciation: new AlignmentSyntheticCriticPronunciationEvaluator({ alignment }),
      controlled: new DeterministicSyntheticCriticControlledEvaluator(),
      clock: () => new Date(at(7)),
      createId: ({ evaluationContextHash }) => `journey-critic-${evaluationContextHash.slice(0, 48)}`,
    })
    const criticContext = new PrismaSyntheticCriticRuntimeContextResolver({
      client, artifacts: artifactRepository, resultArtifacts: resultArtifactRepository,
      generations, plans, profiles: syntheticRepository, rights: rightsRepository,
      alignment, audioMasters: audioMasterRepository, sources: sourceMaterializer,
      audioComparison: new FfmpegAvatarAudioComparison({
        ...process.env, FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath,
      }),
      clock: () => new Date(at(7)),
    })
    const ttsCritic = new SpecializedSyntheticProviderResultCritic({
      transport: new PersistedTtsResultCritic(artifactRepository, resultArtifactRepository),
      context: criticContext,
      evaluate: evaluateSynthetic,
    })

    // Each tick constructs a brand-new worker instance with a new identity:
    // exactly what a process restart between steps looks like. All state that
    // carries the journey forward lives in PostgreSQL.
    const runFreshTtsWorkerOnce = () => {
      tick += 1
      return runProviderJobWorkerOnce({
        jobs: providerRepository, provenance: provenanceRepository,
        resultArtifacts: resultArtifactRepository,
        adapters: registry, materializer,
        ingestor: ttsIngestor, critic: ttsCritic,
        clock: controlledWorkerClock,
        createLeaseToken: () => `journey-tts-lease-${tick}`,
        createTransitionId: () => `journey-transition-${++providerTransition}`,
      })(`journey-tts-worker-${tick}`)
    }
    for (let stage = 0; stage < 6; stage += 1) await runFreshTtsWorkerOnce()
    const ttsDone = await providerRepository.read({ workspaceId, projectId: project.project.id, jobId: ttsJobId })
    const ttsReport = ttsDone.job.criticResultHash
      ? await criticReports.readByHash({ workspaceId, reportHash: ttsDone.job.criticResultHash })
      : null
    assert.equal(
      ttsDone.job.status,
      'approved',
      `TTS job ended ${ttsDone.job.status}: ${JSON.stringify({ error: ttsDone.job.normalizedError, report: ttsReport })}`,
    )
    assert.equal(ttsDone.job.providerJobId, ttsProviderJobRef)
    assert.equal(ttsDone.job.providerStatus, 'completed')
    assert.deepEqual(ttsAdapter.calls, ['capabilities', 'estimate', 'submit', 'capabilities'])
    await settleSyntheticBlockGenerationsService({
      generations, providerJobs: providerRepository, resultArtifacts: resultArtifactRepository,
      criticReports, clock: () => new Date(at(8)),
    })({ workspaceId, projectId: project.project.id, planId, actor })
    const [settledGeneration] = await generations.listByPlan({ workspaceId, planId, statuses: ['approved'] })
    assert.equal(settledGeneration.providerJobId, ttsJobId)
    // A restarted worker after approval finds nothing to do.
    assert.equal(await runFreshTtsWorkerOnce(), null)

    const ledger = await resultArtifactRepository.listByJob({ workspaceId, projectId: project.project.id, jobId: ttsJobId })
    assert.deepEqual(ledger.map(({ role }) => role), ['alignment-evidence', 'primary-audio'])
    const audioEntry = ledger.find((entry) => entry.role === 'primary-audio')
    const alignmentEntry = ledger.find((entry) => entry.role === 'alignment-evidence')
    assert.equal(audioEntry.scriptHash, SCRIPT_HASH)
    assert.equal(audioEntry.providerJobRef, ttsProviderJobRef)
    const audioRow = await artifactRepository.findById(workspaceId, audioEntry.artifactId)
    const storedAudioPath = await storedArtifactPath(audioRow.artifactKey)
    assert.equal(await calculateFileSha256(storedAudioPath), audioEntry.artifactSha256)
    assert.equal((await stat(storedAudioPath)).size, Number(audioEntry.byteSize))
    const audioProbe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', storedAudioPath], { encoding: 'utf8', windowsHide: true }))
    assert.equal(audioProbe.streams[0].codec_name, 'mp3')
    assert.ok(Math.abs(Number(audioProbe.format.duration) - 2) <= 0.2)
    const alignmentRow = await artifactRepository.findById(workspaceId, alignmentEntry.artifactId)
    const storedAlignment = JSON.parse(await readFile(await storedArtifactPath(alignmentRow.artifactKey), 'utf8'))
    assert.equal(storedAlignment.characters.join(''), SCRIPT)
    assert.equal(storedAlignment.audioSha256, audioEntry.artifactSha256)
    const approvedWords = await alignment.readWords({ workspaceId, artifactId: alignmentEntry.artifactId })

    // Replay is byte-identical and charges nothing new.
    const ttsReplayed = await ensureTts({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      planId, use: 'ads', market: 'BRA', actor,
    })
    assert.deepEqual(ttsReplayed.map(({ action }) => action), ['up-to-date'])
    assert.deepEqual(ttsAdapter.calls, ['capabilities', 'estimate', 'submit', 'capabilities'])
    assert.equal(await client.v2ProviderResultArtifact.count({ where: { workspaceId } }), 2)
    assert.equal(await calculateFileSha256(await storedArtifactPath(audioRow.artifactKey)), audioEntry.artifactSha256)

    // Rights for the produced artifacts before they may feed the audio master.
    for (const [index, artifactId] of [audioEntry.artifactId, alignmentEntry.artifactId].entries()) {
      const snapshot = createAssetRightsSnapshot({
        id: `journey-rights-${index + 1}`, workspaceId, artifactId, sequence: 1,
        draft: {
          status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
          allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
          consent: { status: 'not-required', allowedUses: [] },
        },
        createdBy: { type: 'api-client', id: clientId }, createdAt: at(9),
      })
      await rightsRepository.setCurrent(snapshot, assetRightsRevision(artifactId, 0), createAssetRightsChangeIntent({
        workspaceId, artifactId, snapshotHash: snapshot.snapshotHash, baseRevision: assetRightsRevision(artifactId, 0),
        actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(9),
      }))
    }

    const createAudioMaster = createSyntheticAudioMasterService({
      repository: audioMasterRepository, projects: projectsQuery, profiles: syntheticRepository,
      providerJobs: providerRepository, artifacts: artifactRepository, rights: rightsRepository,
      criticReports,
      alignment,
      audioDurations: new FfmpegDecodedSyntheticAudioDurationReader(sourceMaterializer, process.env),
      clock: () => new Date(at(10)), createId: () => 'journey-audio-master',
    })
    const audioMasterRequest = {
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId,
      source: { kind: 'tts', text: SCRIPT, providerJobId: ttsJobId },
      audioArtifactId: audioEntry.artifactId, alignmentEvidenceArtifactId: alignmentEntry.artifactId,
      durationMs: 2_000, locale: 'pt-BR',
      words: approvedWords.map((word) => ({ ...word, confidence: 0.99 })),
      approvedAt: at(8), approvalCriticHash: ttsDone.job.criticResultHash,
      use: 'ads', market: 'BRA', actor, idempotencyKey: 'journey-audio-master-key',
    }
    const tamperedWords = audioMasterRequest.words.map((word, index) =>
      index === 0 ? { ...word, endMs: word.endMs + 1 } : word)
    await assert.rejects(createAudioMaster({
      ...audioMasterRequest,
      words: tamperedWords,
      idempotencyKey: 'journey-audio-master-tampered-key',
    }), (error) => error.code === 'PERSISTENCE_CONFLICT')
    assert.equal(await client.v2SyntheticAudioMaster.count({ where: { workspaceId } }), 0)
    const masterCreated = await createAudioMaster(audioMasterRequest)
    assert.equal(masterCreated.replayed, false)
    const masterReplayed = await createAudioMaster(audioMasterRequest)
    assert.equal(masterReplayed.replayed, true)
    assert.equal(await client.v2SyntheticAudioMaster.count({ where: { workspaceId } }), 1)

    // Avatar leg: the approved master's exact audio is the only allowed input.
    const avatarEnqueued = await enqueue({
      workspaceId, projectId: project.project.id, projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId, operation: 'audio-avatar',
      adapterId: 'controlled-avatar', adapterVersion: '1.0.0',
      providerInput: { aspectRatio: '9:16' },
      sourceArtifactIds: [audioEntry.artifactId],
      audioMasterId: masterCreated.value.master.id,
      audioRange: { startWordIndex: 0, endWordIndex: 2 },
      use: 'ads', market: 'BRA', locale: 'pt-BR', actor, idempotencyKey: 'journey-avatar-key',
    })
    assert.equal(avatarEnqueued.persisted.job.status, 'planned')
    const avatarJobId = avatarEnqueued.persisted.job.id

    let downloaderCleanups = 0
    const avatarIngestor = new VerifiedProviderResultIngestor({
      downloader: {
        async download(input) {
          assert.equal(input.url, 'controlled://avatar/result.mp4')
          const target = join(workRoot, `downloaded-${input.operationId}.mp4`)
          await copyFile(avatarVideoPath, target)
          const bytes = await readFile(target)
          return { path: target, sha256: createHash('sha256').update(bytes).digest('hex'), byteSize: bytes.byteLength }
        },
        async cleanup(operationId) {
          downloaderCleanups += 1
          await rm(join(workRoot, `downloaded-${operationId}.mp4`), { force: true })
        },
      },
      storage, artifacts: artifactRepository, artifactQuery: artifactRepository,
      resultArtifacts: resultArtifactRepository,
      prober: { probe: (path, options) => probeVideo(path, { ...options, requireAudio: true }) },
      clock: () => new Date(at(12)),
    })
    const avatarCritic = new SpecializedSyntheticProviderResultCritic({
      transport: new PersistedProviderResultCritic(artifactRepository),
      context: criticContext,
      evaluate: evaluateSynthetic,
    })
    const runFreshAvatarWorkerOnce = () => {
      tick += 1
      return runProviderJobWorkerOnce({
        jobs: providerRepository, provenance: provenanceRepository,
        resultArtifacts: resultArtifactRepository,
        adapters: registry, materializer,
        ingestor: avatarIngestor, critic: avatarCritic,
        clock: controlledWorkerClock,
        createLeaseToken: () => `journey-avatar-lease-${tick}`,
        createTransitionId: () => `journey-transition-${++providerTransition}`,
      })(`journey-avatar-worker-${tick}`)
    }
    for (let stage = 0; stage < 8; stage += 1) await runFreshAvatarWorkerOnce()
    const avatarDone = await providerRepository.read({ workspaceId, projectId: project.project.id, jobId: avatarJobId })
    const avatarReport = avatarDone.job.criticResultHash
      ? await criticReports.readByHash({ workspaceId, reportHash: avatarDone.job.criticResultHash })
      : null
    assert.equal(
      avatarDone.job.status,
      'approved',
      `controlled avatar job ended ${avatarDone.job.status}: ${JSON.stringify({ error: avatarDone.job.normalizedError, report: avatarReport })}`,
    )
    assert.equal(avatarDone.job.providerJobId, 'controlled-avatar:journey-avatar-key')
    assert.ok(avatarDone.job.resultArtifact, 'approved provider result must remain bound to the job')
    const avatarEvidence = await provenanceRepository.listEvidenceByJob({ workspaceId, projectId: project.project.id, jobId: avatarJobId })
    const avatarSubmitEvidence = avatarEvidence.filter((evidence) => evidence.phase === 'submit')
    const avatarRetrieveEvidence = avatarEvidence.filter((evidence) => evidence.phase === 'retrieve')
    const avatarReceipt = await provenanceRepository.readReceiptByJob({ workspaceId, projectId: project.project.id, jobId: avatarJobId })
    assert.equal(avatarSubmitEvidence.length, 1)
    assert.equal(avatarRetrieveEvidence.length, 1)
    assert.ok(avatarReceipt, 'avatar execution receipt must exist before critic terminal state')
    assert.equal(avatarReceipt.submitEvidenceId, avatarSubmitEvidence[0].id)
    assert.equal(avatarReceipt.retrieveEvidenceId, avatarRetrieveEvidence[0].id)
    assert.equal(new Set([avatarSubmitEvidence[0].leaseToken, avatarRetrieveEvidence[0].leaseToken, avatarReceipt.leaseToken]).size, 3, 'submit, retrieve and receipt must retain their distinct legitimate worker leases')
    const avatarLedger = await resultArtifactRepository.listByJob({
      workspaceId, projectId: project.project.id, jobId: avatarJobId,
    })
    assert.deepEqual(avatarLedger.map(({ role }) => role), ['output-speech-evidence', 'primary-video'])
    assert.deepEqual(avatarReceipt.results.map(({ role }) => role).toSorted(), ['output-speech-evidence', 'primary-video'])
    assert.equal(avatarReport?.decision, 'approved', JSON.stringify(avatarReport))
    assert.equal(avatarReport?.audioArtifactId, null)
    assert.equal(avatarReport?.outputSpeechEvidence?.speechEvidence.outputTranscriptHash, SCRIPT_HASH)
    assert.equal(avatarReport?.outputSpeechEvidence?.speechEvidence.observedIdentityRef, 'avatar_journey_123')
    assert.equal(avatarReport?.outputSpeechEvidence?.sourceAudioArtifactId, audioEntry.artifactId)
    assert.equal(avatarReport?.outputSpeechEvidence?.sourceDurationMs, masterCreated.value.master.audio.durationMs)
    assert.notEqual(
      avatarReport?.outputSpeechEvidence?.outputDurationMs,
      masterCreated.value.master.audio.durationMs,
      'the controlled AAC fixture must exercise bounded codec padding rather than exact PCM duration',
    )
    assert.equal(avatarReport?.outputSpeechEvidence?.passed, true)
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 0, 'approval alone is not promotion')
    assert.equal(downloaderCleanups, 1)
    assert.deepEqual(avatarAdapter.calls, [
      'capabilities', 'estimate', 'submit', 'status', 'status', 'status', 'retrieve', 'capabilities',
    ])

    const avatarRightsByArtifact = new Map()
    for (const [index, result] of avatarLedger.entries()) {
      const snapshot = createAssetRightsSnapshot({
        id: `journey-avatar-rights-${index + 1}`, workspaceId, artifactId: result.artifactId, sequence: 1,
        draft: {
          status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
          allowedSyntheticOperations: result.role === 'primary-video'
            ? ['tts', 'audio-avatar', 'video-to-video', 'generated-cutaway']
            : ['audio-avatar'],
          expiresAt: '2030-01-01T00:00:00.000Z',
          consent: { status: 'not-required', allowedUses: [] },
        },
        createdBy: { type: 'api-client', id: clientId }, createdAt: at(13),
      })
      await rightsRepository.setCurrent(snapshot, assetRightsRevision(result.artifactId, 0), createAssetRightsChangeIntent({
        workspaceId, artifactId: result.artifactId, snapshotHash: snapshot.snapshotHash,
        baseRevision: assetRightsRevision(result.artifactId, 0),
        actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(13),
      }))
      avatarRightsByArtifact.set(result.artifactId, snapshot)
    }

    const avatarRow = await artifactRepository.findById(workspaceId, avatarDone.job.resultArtifact.artifactId)
    const avatarSpeechEntry = avatarLedger.find(({ role }) => role === 'output-speech-evidence')
    assert.ok(avatarSpeechEntry)
    const avatarSpeechRow = await artifactRepository.findById(workspaceId, avatarSpeechEntry.artifactId)
    const storedAvatarPath = await storedArtifactPath(avatarRow.artifactKey)
    const avatarRights = avatarRightsByArtifact.get(avatarRow.id)
    assert.ok(avatarRights)
    assert.equal(await calculateFileSha256(storedAvatarPath), avatarDone.job.resultArtifact.artifactSha256)
    assert.equal((await stat(storedAvatarPath)).size, Number(avatarRow.byteSize))
    const videoProbe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', storedAvatarPath], { encoding: 'utf8', windowsHide: true }))
    const videoStream = videoProbe.streams.find((stream) => stream.codec_type === 'video')
    assert.deepEqual([videoStream.codec_name, videoStream.width, videoStream.height], ['h264', 540, 960])
    assert.ok(videoProbe.streams.some((stream) => stream.codec_type === 'audio'))

    const bRollBytes = await readFile(bRollPath)
    const bRollSha256 = createHash('sha256').update(bRollBytes).digest('hex')
    const storedBRoll = await storage.promoteDerived({
      workspaceId,
      sourcePath: bRollPath,
      sha256: bRollSha256,
      extension: 'png',
      prefix: 'synthetic-wave24-broll',
    })
    const bRollManifest = createMediaArtifactManifestV2({
      artifactKey: storedBRoll.key,
      artifactSha256: storedBRoll.sha256,
      byteSize: storedBRoll.byteSize,
      mediaType: 'image',
      container: 'png',
      recipe: {
        id: 'synthetic-wave24-controlled-broll', version: '1.0.0',
        parameters: { project: 'consumer-b', colour: '0x2347D9' },
      },
      sources: [],
    })
    await artifactRepository.persistOrReplay({
      workspaceId,
      artifactId: 'journey-consumer-b-broll',
      manifestId: 'journey-consumer-b-broll-manifest',
      lineageIds: [],
      manifest: bRollManifest,
      createdAt: at(14),
    })
    const bRollRights = createAssetRightsSnapshot({
      id: 'journey-consumer-b-broll-rights', workspaceId,
      artifactId: 'journey-consumer-b-broll', sequence: 1,
      draft: {
        status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        consent: { status: 'not-required', allowedUses: [] },
      },
      createdBy: { type: 'api-client', id: clientId }, createdAt: at(14),
    })
    await rightsRepository.setCurrent(bRollRights, assetRightsRevision('journey-consumer-b-broll', 0), createAssetRightsChangeIntent({
      workspaceId, artifactId: 'journey-consumer-b-broll', snapshotHash: bRollRights.snapshotHash,
      baseRevision: assetRightsRevision('journey-consumer-b-broll', 0),
      actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(14),
    }))

    const overlayBytes = await readFile(overlayPath)
    const overlaySha256 = createHash('sha256').update(overlayBytes).digest('hex')
    const storedOverlay = await storage.promoteDerived({
      workspaceId,
      sourcePath: overlayPath,
      sha256: overlaySha256,
      extension: 'png',
      prefix: 'synthetic-wave24-overlay',
    })
    const overlayManifest = createMediaArtifactManifestV2({
      artifactKey: storedOverlay.key,
      artifactSha256: storedOverlay.sha256,
      byteSize: storedOverlay.byteSize,
      mediaType: 'image',
      container: 'png',
      recipe: {
        id: 'synthetic-wave24-controlled-overlay', version: '1.0.0',
        parameters: { project: 'consumer-b', colour: '0xF2C94C' },
      },
      sources: [],
    })
    await artifactRepository.persistOrReplay({
      workspaceId,
      artifactId: 'journey-consumer-b-overlay',
      manifestId: 'journey-consumer-b-overlay-manifest',
      lineageIds: [],
      manifest: overlayManifest,
      createdAt: at(14),
    })
    const overlayRights = createAssetRightsSnapshot({
      id: 'journey-consumer-b-overlay-rights', workspaceId,
      artifactId: 'journey-consumer-b-overlay', sequence: 1,
      draft: {
        status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
        consent: { status: 'not-required', allowedUses: [] },
      },
      createdBy: { type: 'api-client', id: clientId }, createdAt: at(14),
    })
    await rightsRepository.setCurrent(overlayRights, assetRightsRevision('journey-consumer-b-overlay', 0), createAssetRightsChangeIntent({
      workspaceId, artifactId: 'journey-consumer-b-overlay', snapshotHash: overlayRights.snapshotHash,
      baseRevision: assetRightsRevision('journey-consumer-b-overlay', 0),
      actor: { kind: 'internal', actorType: 'api-client', actorId: clientId }, changedAt: at(14),
    }))

    const masterRepository = new PrismaSyntheticMasterAssetRepository(client)
    const promoted = await promoteSyntheticMasterAssetService({
      masters: masterRepository,
      jobs: new PrismaPromotableProviderJobReader(client),
      resultArtifacts: resultArtifactRepository,
      artifacts: artifactRepository,
      profiles: syntheticRepository,
      rights: {
        async currentSnapshot({ workspaceId: targetWorkspaceId, artifactId }) {
          return (await rightsRepository.findCurrent(targetWorkspaceId, artifactId))?.snapshot ?? null
        },
      },
      criticReports,
      bytes: new ArtifactContentSyntheticMasterByteVerifier(contentStorage),
      durations: new FfprobeSyntheticMasterDurationProber(
        sourceMaterializer,
        new PrismaStoredArtifactIdentityReader(client),
        { ...process.env, FFMPEG_PATH: ffmpegPath, FFPROBE_PATH: ffprobePath },
      ),
      clock: () => new Date(at(14)),
      createId: () => 'journey-synthetic-master-a',
    })({
      workspaceId,
      projectId: project.project.id,
      providerJobId: avatarJobId,
      profileSnapshotId: registered.profile.profileSnapshotId,
      scriptText: SCRIPT,
      locale: 'pt-BR',
      use: 'ads',
      market: 'BRA',
      lineage: [settledGeneration.id],
      cost: { currency: 'USD', minorUnits: 0 },
      actor,
      idempotencyKey: 'journey-promote-master-a',
    })
    assert.equal(promoted.replayed, false)
    assert.deepEqual(promoted.master.artifacts.map(({ role }) => role), [
      'provider-original', 'final-audio', 'alignment',
    ])
    assert.equal(promoted.master.provenance.providerJobId, avatarJobId)
    assert.equal(promoted.master.cost.minorUnits, 0)

    const catalogued = await catalogSyntheticSpeechSegmentsService({
      masters: masterRepository,
      segments: new PrismaSyntheticSpeechSegmentRepository(client),
      profiles: syntheticRepository,
      alignment,
      createId: ({ blockId, occurrence }) => `journey-segment-${blockId}-${occurrence}`,
    })({
      workspaceId,
      masterId: promoted.master.id,
      actor,
      blocks: [{ blockId: settledGeneration.blockId, exactText: SCRIPT, occurrence: 1 }],
    })
    assert.equal(catalogued.replayed, false)
    assert.equal(catalogued.segments.length, 1)
    assert.equal(catalogued.segments[0].masterHash, promoted.master.masterHash)

    const consumerProject = await createProjectService({
      repository: new PrismaProjectCreationRepository(client),
      clock: () => new Date(at(15)),
      createId: (kind) => `${kind}-consumer-b-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(900_000 + ++event).padStart(12, '0')}`,
    })({
      workspaceId,
      name: 'Consumo canônico com composição B',
      objective: 'awareness',
      format: '9:16',
      actor,
      idempotency: { clientId, key: 'journey-consumer-project-b' },
    })
    const reuseRepository = new PrismaSyntheticMasterReuseRepository({ client, alignment })
    const currentAuthorizationClock = () => new Date()
    const canonicalSource = await reuseRepository.resolveCanonicalSource({
      workspaceId,
      sourceProviderJobId: avatarJobId,
      sourceArtifactId: avatarRow.id,
      sourceArtifactSha256: avatarRow.sha256,
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      at: currentAuthorizationClock(),
    })
    assert.ok(canonicalSource)
    assert.equal(canonicalSource.master.id, promoted.master.id)
    assert.equal(canonicalSource.currentAuthorityValid, true)
    const canonicalCacheKey = calculateSyntheticCacheKey(canonicalSource.cacheSubject)
    let reuseIdentity = 0
    const prepareCanonicalReuse = prepareCanonicalSyntheticMasterReuseService({
      repository: reuseRepository,
      clock: currentAuthorizationClock,
      createDecisionId: () => `journey-master-reuse-decision-${++reuseIdentity}`,
      createConsumptionId: () => `journey-master-consumption-${++reuseIdentity}`,
    })
    let runIdentity = 0
    const createRun = createSyntheticProductionRunService({
      repository: syntheticRepository,
      projects: projectsQuery,
      artifacts: artifactRepository,
      rights: rightsRepository,
      criticReports,
      providerJobs: providerRepository,
      audioMasters: audioMasterRepository,
      scriptPlans: plans,
      prepareCanonicalReuse,
      clock: currentAuthorizationClock,
      createRunId: () => `journey-production-run-${++runIdentity}`,
      createSnapshotId: () => `journey-edit-plan-snapshot-${runIdentity}`,
    })
    const productionBody = {
      workspaceId,
      projectVersionId: project.version.id,
      profileSnapshotId: registered.profile.profileSnapshotId,
      audio: {
        artifactId: audioEntry.artifactId,
        durationMs: masterCreated.value.master.audio.durationMs,
        locale: 'pt-BR',
        scriptHash: SCRIPT_HASH,
        alignment: masterCreated.value.master.words.map(({ word, startMs, endMs }) => ({ text: word, startMs, endMs })),
      },
      blocks: [{
        id: settledGeneration.blockId,
        text: SCRIPT,
        rangeMs: [0, masterCreated.value.master.audio.durationMs],
        cacheKey: canonicalCacheKey,
        providerJobId: avatarJobId,
        audioSha256: audioEntry.artifactSha256,
        artifactId: avatarRow.id,
        critic: { id: avatarReport.id, resultHash: avatarReport.reportHash, status: 'approved' },
      }],
      overlays: [],
      use: 'ads',
      market: 'BRA',
      actor,
    }
    const sourceRun = await createRun({
      ...productionBody,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      bRoll: [],
      captions: true,
      idempotencyKey: 'journey-production-source-a',
    })
    assert.equal(sourceRun.replayed, false)
    assert.equal(await reuseRepository.readByRun({
      workspaceId, consumerProjectId: project.project.id, productionRunId: sourceRun.run.plan.id,
    }), null, 'the source project stays on normal production rather than booking cross-project reuse')

    const consumerRun = await createRun({
      ...productionBody,
      projectId: consumerProject.project.id,
      projectVersionId: consumerProject.version.id,
      bRoll: [{
        id: 'journey-consumer-b-broll-insert',
        rangeMs: [500, 1_500],
        artifactId: 'journey-consumer-b-broll',
        role: 'b-roll',
      }],
      overlays: [{
        id: 'journey-consumer-b-overlay-insert',
        rangeMs: [1_500, 2_000],
        artifactId: 'journey-consumer-b-overlay',
        role: 'overlay',
      }],
      captions: true,
      idempotencyKey: 'journey-production-consumer-b',
    })
    assert.equal(consumerRun.replayed, false)
    assert.notEqual(consumerRun.run.plan.planHash, sourceRun.run.plan.planHash)
    assert.equal(consumerRun.run.plan.bRoll.length, 1)
    assert.equal(consumerRun.run.plan.overlays.length, 1)
    assert.deepEqual([
      consumerRun.run.plan.audio.artifactId,
      ...consumerRun.run.plan.blocks.map(({ artifact }) => artifact.artifactId),
      ...consumerRun.run.plan.bRoll.map(({ artifact }) => artifact.artifactId),
      ...consumerRun.run.plan.overlays.map(({ artifact }) => artifact.artifactId),
    ], [
      audioEntry.artifactId,
      avatarRow.id,
      'journey-consumer-b-broll',
      'journey-consumer-b-overlay',
    ])
    const consumption = await reuseRepository.readByRun({
      workspaceId,
      consumerProjectId: consumerProject.project.id,
      productionRunId: consumerRun.run.plan.id,
    })
    assert.ok(consumption)
    assert.equal(consumption.sourceMasterId, promoted.master.id)
    assert.equal(consumption.observationOpenedAt, consumerProject.project.createdAt)
    const reuseDecision = await client.v2SyntheticCacheDecision.findUniqueOrThrow({
      where: { id: consumption.cacheDecisionId },
    })
    assert.equal(reuseDecision.outcome, 'hit')
    assert.equal(reuseDecision.avoidedCostMinorUnits, 0)
    assert.equal(await client.v2ProviderJob.count({ where: { workspaceId, projectId: consumerProject.project.id } }), 0)
    assert.equal(await client.v2DirectorBudgetReservation.count({ where: { workspaceId, projectId: consumerProject.project.id } }), 0)
    assert.equal(await client.v2ProviderTransportEvidence.count({ where: { workspaceId, projectId: consumerProject.project.id, phase: 'submit' } }), 0)

    fallbackFixture = await prepareControlledTransformationFallbackFixture({
      runId: process.env.APOLLO_WAVE24_RUN_ID,
      workspaceId,
      projectId: project.project.id,
      projectVersionId: project.version.id,
      actor,
      client,
      storage,
      sourceMaterializer,
      artifactRoot,
      workRoot,
      sourceArtifact: {
        id: avatarRow.id,
        sha256: avatarRow.sha256,
        rightsSnapshotId: avatarRights.id,
        rightsSnapshotHash: avatarRights.snapshotHash,
      },
      sourcePath: storedAvatarPath,
      use: 'ads',
      market: 'BRA',
      locale: 'pt-BR',
      signal: t.signal,
    })

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      ...fallbackFixture.environment,
      NODE_ENV: 'production',
      __NEXT_PROCESSED_ENV: 'true',
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
      APOLLO_V2_PERSISTENCE: 'postgres',
      APOLLO_AUTH_MODE: 'bootstrap',
      APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true',
      APOLLO_UI_BOOTSTRAP_ROLE: 'operator',
      APOLLO_UI_USERNAME: uiUsername,
      APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(uiPassword, `wave24-salt-${uiSuffix}`),
      APOLLO_UI_SESSION_SECRET: uiSessionSecret,
      APOLLO_UI_API_CLIENT_ID: issued.client.id,
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_WORK_ROOT: join(workRoot, 'render-materialize'),
      APOLLO_V2_RENDER_OUTPUT_ROOT: join(workRoot, 'render-output'),
      APOLLO_V2_PROVIDER_WORK_ROOT: join(workRoot, 'provider'),
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
    }
    await mkdir(runtimeEnv.APOLLO_V2_RENDER_WORK_ROOT, { recursive: true })
    await mkdir(runtimeEnv.APOLLO_V2_RENDER_OUTPUT_ROOT, { recursive: true })
    await mkdir(runtimeEnv.APOLLO_V2_PROVIDER_WORK_ROOT, { recursive: true })
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env: runtimeEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    server.stdout.on('data', appendServerLog)
    server.stderr.on('data', appendServerLog)
    await waitForServer(baseUrl, server, () => serverLogs.slice(-8_000), t.signal)

    const login = await boundedFetch(`${baseUrl}/v1/session`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ username: uiUsername, password: uiPassword }),
    }, t.signal)
    await readJsonResponse(login, 'human UI login')
    const uiCookie = login.headers.get('set-cookie')?.split(';')[0]
    assert.ok(uiCookie, 'human UI login did not issue a session cookie')

    const fallback = await fallbackFixture.run({
      baseUrl,
      bearerToken: issued.token,
      idempotencyKey: `synthetic-wave24-fallback-${uiSuffix}`,
      approveReview: async ({ ledger, action, signal }) => {
        const response = await boundedFetch(
          `${baseUrl}/v1/projects/${encodeURIComponent(project.project.id)}/transformation-fallbacks/${encodeURIComponent(ledger.id)}/actions`,
          {
            method: 'POST',
            headers: {
              cookie: uiCookie,
              accept: 'application/json',
              'content-type': 'application/json',
              origin: baseUrl,
              'sec-fetch-site': 'same-origin',
            },
            body: JSON.stringify({ action }),
          },
          signal,
        )
        return (await readJsonResponse(response, 'human fallback approval')).data
      },
      signal: t.signal,
    })
    assert.equal(fallback.dispatch.outcome, 'enqueued')
    assert.equal(fallback.dispatchReplay.outcome, 'replayed')
    assert.equal(fallback.dispatchReplay.job.id, fallback.dispatch.job.id)
    assert.equal(fallback.fallbackJob.status, 'approved')
    assert.equal(fallback.approval.ledger.reviewDecision, 'accepted')

    const {
      createSyntheticBuildAttestationRuntime,
      createSyntheticProductionRenderRepository,
      createSyntheticProductionRenderWorker,
    } = await import('../../src/v2/infrastructure/repository-factory.ts')
    const renderRepository = createSyntheticProductionRenderRepository()
    const bearerHeaders = {
      authorization: `Bearer ${issued.token}`,
      accept: 'application/json',
      'content-type': 'application/json',
    }
    const renderOne = async ({ projectId, projectVersionId, runId, idempotencyKey, evidenceName }) => {
      const diagnoseUnexpectedWorkerState = async (label, workerResult, expectedStatus) => {
        if (workerResult?.status === expectedStatus) return
        let latest = null
        let repositoryError = null
        try {
          latest = await renderRepository.readLatestByRun({ workspaceId, projectId, runId })
        } catch (error) {
          const domainCode = error instanceof Error && error.name === 'DomainError' &&
            'code' in error && typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
            ? error.code
            : null
          repositoryError = domainCode
            ? { code: domainCode, message: error.message.slice(0, 240) }
            : { code: null, message: 'Render repository diagnostic failed' }
        }
        t.diagnostic(`${label} render worker state: ${JSON.stringify({
          worker: {
            operationId: workerResult?.operationId ?? null,
            status: workerResult?.status ?? null,
          },
          operation: latest
            ? {
                id: latest.operation.id,
                status: latest.operation.status,
                phase: latest.operation.phase,
                error: latest.operation.error
                  ? { code: latest.operation.error.code, message: latest.operation.error.message }
                  : null,
              }
            : null,
          binding: latest
            ? {
                projectId: latest.context.projectId,
                projectVersionId: latest.context.projectVersionId,
                productionRunId: latest.context.productionRunId,
                editPlanSnapshotId: latest.context.editPlanSnapshotId,
                planHash: latest.context.planHash,
                renderInputHash: latest.context.renderInputHash,
                contextHash: latest.context.contextHash,
                outputArtifactId: latest.context.outputArtifactId,
                outputManifestId: latest.context.outputManifestId,
                checkpointPresent: Boolean(latest.checkpoint),
                checkpointOutputSha256: latest.checkpoint?.outputSha256 ?? null,
                qualityPassed: latest.qualityReport?.passed ?? null,
              }
            : null,
          repositoryError,
        })}`)
      }
      const endpoint = `${baseUrl}/v1/projects/${encodeURIComponent(projectId)}/synthetic-production-runs/${encodeURIComponent(runId)}/render-operations`
      const request = async () => boundedFetch(endpoint, {
        method: 'POST',
        headers: { ...bearerHeaders, 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ output: { kind: 'final', aspectRatio: '9:16' } }),
      }, t.signal)
      const createdResponse = await request()
      const created = (await readExpectedPublicResponse(
        createdResponse,
        `${evidenceName} render enqueue`,
        202,
        t,
      )).data
      assert.equal(created.replayed, false)
      assert.equal(created.render.runId, runId)

      const firstWorker = createSyntheticProductionRenderWorker(runtimeEnv)
      const rendered = await firstWorker(`synthetic-wave24-render-${evidenceName}-1`, t.signal)
      await diagnoseUnexpectedWorkerState(`${evidenceName} initial`, rendered, 'waiting-attestation')
      assert.equal(rendered?.operationId, created.operation.id)
      assert.equal(rendered?.status, 'waiting-attestation')
      const waiting = await renderRepository.readLatestByRun({ workspaceId, projectId, runId })
      assert.equal(waiting?.operation.status, 'waiting')
      assert.ok(waiting?.checkpoint)
      assert.equal(waiting?.qualityReport?.passed, true)
      assert.equal(waiting?.attestation, undefined)
      const checkpointHash = waiting.checkpoint.outputSha256
      const checkpointAttempt = waiting.checkpoint.attempt
      const waitingArtifact = await artifactRepository.findById(workspaceId, waiting.context.outputArtifactId)
      assert.ok(waitingArtifact, 'waiting render output artifact must be durable before attestation')
      const waitingSourcePath = await storedArtifactPath(waitingArtifact.artifactKey)
      assert.equal(await calculateFileSha256(waitingSourcePath), checkpointHash)
      const retainedPath = join(evidenceRoot, `${evidenceName}.mp4`)
      await copyFile(waitingSourcePath, retainedPath)
      await writeFile(join(evidenceRoot, `${evidenceName}-render-identity.json`), `${JSON.stringify({
        workspaceId,
        projectId,
        projectVersionId,
        productionRunId: runId,
        publicOperationId: created.operation.id,
        outputArtifactId: waiting.context.outputArtifactId,
        outputManifestId: created.render.outputManifestId,
        outputKey: waiting.checkpoint.outputKey,
        outputSha256: checkpointHash,
        attempt: checkpointAttempt,
        status: waiting.operation.status,
      }, null, 2)}\n`, 'utf8')
      expectedRenderOutputKeys.push(waiting.checkpoint.outputKey)

      const recoveryBeforeAttestation = await createSyntheticProductionRenderWorker(runtimeEnv)(
        `synthetic-wave24-render-${evidenceName}-recovery`,
        t.signal,
      )
      assert.equal(recoveryBeforeAttestation, null, 'waiting render must not execute again before attestation')
      const stillWaiting = await renderRepository.readLatestByRun({ workspaceId, projectId, runId })
      assert.equal(stillWaiting.checkpoint.outputSha256, checkpointHash)
      assert.equal(stillWaiting.checkpoint.attempt, checkpointAttempt)

      const attested = await createSyntheticBuildAttestationRuntime().create({
        workspaceId,
        projectId,
        projectVersionId,
        productionRunId: runId,
        publicOperationId: created.operation.id,
        renderManifestId: created.render.outputManifestId,
        idempotencyKey: `synthetic-wave24-attestation-${evidenceName}`,
        signal: t.signal,
      })
      assert.equal(attested.replayed, false)
      const finalized = await createSyntheticProductionRenderWorker(runtimeEnv)(
        `synthetic-wave24-render-${evidenceName}-2`,
        t.signal,
      )
      await diagnoseUnexpectedWorkerState(`${evidenceName} finalize`, finalized, 'succeeded')
      assert.deepEqual(finalized, { operationId: created.operation.id, status: 'succeeded' })
      const terminal = await renderRepository.readLatestByRun({ workspaceId, projectId, runId })
      assert.equal(terminal.operation.status, 'succeeded')
      assert.equal(terminal.operation.phase, 'completed')
      assert.equal(terminal.checkpoint.outputSha256, checkpointHash)
      assert.equal(terminal.checkpoint.attempt, checkpointAttempt)
      assert.equal(terminal.attestation.attestationHash, attested.record.attestation.attestationHash)
      assert.equal(terminal.context.outputArtifactId, waiting.context.outputArtifactId)
      assert.equal(terminal.checkpoint.outputKey, waiting.checkpoint.outputKey)
      await writeFile(join(evidenceRoot, `${evidenceName}-render-terminal.json`), `${JSON.stringify({
        operation: {
          id: terminal.operation.id,
          status: terminal.operation.status,
          phase: terminal.operation.phase,
        },
        checkpoint: {
          outputSha256: terminal.checkpoint.outputSha256,
          attempt: terminal.checkpoint.attempt,
        },
        qualityReport: terminal.qualityReport,
        attestation: {
          attestationHash: terminal.attestation.attestationHash,
          identity: terminal.attestation.identity,
          identityHash: terminal.checkpoint.runtimeIdentityHash,
        },
      }, null, 2)}\n`, 'utf8')

      const replayResponse = await request()
      const replay = (await readExpectedPublicResponse(
        replayResponse,
        `${evidenceName} render replay`,
        200,
        t,
      )).data
      assert.equal(replay.replayed, true)
      assert.equal(replay.operation.id, created.operation.id)

      assert.equal(await calculateFileSha256(retainedPath), terminal.checkpoint.outputSha256)
      const framePath = join(evidenceRoot, `${evidenceName}-frame.png`)
      execFileSync(ffmpegPath, [
        '-nostdin', '-v', 'error', '-ss', '0.75', '-i', retainedPath,
        '-frames:v', '1', '-y', framePath,
      ], { windowsHide: true, timeout: 120_000 })
      const captionFrames = ['0.25', '1.25'].map((timestamp) => {
        const name = `${evidenceName}-caption-${timestamp}s.png`
        execFileSync(ffmpegPath, [
          '-nostdin', '-v', 'error', '-ss', timestamp, '-i', retainedPath,
          '-frames:v', '1', '-y', join(evidenceRoot, name),
        ], { windowsHide: true, timeout: 120_000 })
        return name
      })
      return Object.freeze({ created, terminal, retainedPath, framePath, captionFrames: Object.freeze(captionFrames) })
    }

    // W25 history proof: the first of three real evaluations of the same
    // project version goes through the same public POST before any render.
    // The evidence reader derives both the cross-project reuse check and the
    // provider-swap check from the consumer's verified, attested render, so
    // both are still absent here and present after the renders below.
    const {
      assertSyntheticPhaseGateBrowser,
      summarizeSyntheticPhaseGateCoverage,
    } = await import('./helpers/assert-synthetic-phase-gate-browser.mjs')
    const gateEndpoint = `${baseUrl}/v1/projects/${encodeURIComponent(project.project.id)}/synthetic-phase-gates`
    const expectedMissingLiveChecks = [
      'elevenlabs-audio-alignment-live',
      'heygen-generated-audio-avatar-live',
      'heygen-ready-audio-avatar-live',
    ]
    const renderSwapCheck = 'provider-swap-keeps-plan-and-renderer-contracts'
    const renderReuseCheck = 'cross-project-reuse-with-zero-provider-work'
    const gateCheck = (candidate, code) => candidate.report.evidence
      .flatMap((criterion) => criterion.checks)
      .find((check) => check.code === code) ?? null
    const runPhaseGateAsJourneyActor = async (idempotencyKey, label) => (await readExpectedPublicResponse(
      await boundedFetch(gateEndpoint, {
        method: 'POST',
        headers: { ...bearerHeaders, 'idempotency-key': idempotencyKey },
        body: JSON.stringify({
          projectVersionId: project.version.id,
          projectVersionHash: project.version.baseHash,
        }),
      }, t.signal),
      label,
      201,
      t,
    )).data.gate
    const preRenderGate = await runPhaseGateAsJourneyActor(
      'synthetic-wave25-phase-gate-before-render',
      'synthetic phase gate before render',
    )
    await writeFile(
      join(evidenceRoot, 'phase-gate-report-before-render.json'),
      `${JSON.stringify(preRenderGate, null, 2)}\n`,
      'utf8',
    )
    assert.equal(preRenderGate.projectVersionId, project.version.id)
    assert.equal(preRenderGate.projectVersionHash, project.version.baseHash)
    assert.equal(preRenderGate.report.approved, false)
    assert.deepEqual([preRenderGate.report.passed, preRenderGate.report.total], [1, 4])
    assert.deepEqual([...preRenderGate.report.missing].sort(), ['F3-GATE-001', 'F3-GATE-004'])
    const preRenderCoverage = summarizeSyntheticPhaseGateCoverage(preRenderGate.report)
    assert.deepEqual([preRenderCoverage.covered, preRenderCoverage.total], [3, 8])
    assert.deepEqual(
      preRenderCoverage.missingCodes,
      [...expectedMissingLiveChecks, renderReuseCheck, renderSwapCheck].sort(),
    )
    assert.equal(gateCheck(preRenderGate, renderSwapCheck), null, 'the pre-render gate must not carry render evidence')
    assert.equal(gateCheck(preRenderGate, renderReuseCheck)?.passed, false)
    assert.ok(gateCheck(preRenderGate, renderReuseCheck)?.missingEvidenceTypes.length > 0,
      'the pre-render gate must declare the reuse evidence it does not have')

    const sourceRender = await renderOne({
      projectId: project.project.id,
      projectVersionId: project.version.id,
      runId: sourceRun.run.plan.id,
      idempotencyKey: 'synthetic-wave24-render-source-a',
      evidenceName: 'project-a-final',
    })
    const consumerRender = await renderOne({
      projectId: consumerProject.project.id,
      projectVersionId: consumerProject.version.id,
      runId: consumerRun.run.plan.id,
      idempotencyKey: 'synthetic-wave24-render-consumer-b',
      evidenceName: 'project-b-final',
    })
    const consumerOverlayFrame = join(evidenceRoot, 'project-b-overlay-frame.png')
    execFileSync(ffmpegPath, [
      '-nostdin', '-v', 'error', '-ss', '1.75', '-i', consumerRender.retainedPath,
      '-frames:v', '1', '-y', consumerOverlayFrame,
    ], { windowsHide: true, timeout: 120_000 })
    assert.notEqual(
      sourceRender.terminal.checkpoint.outputSha256,
      consumerRender.terminal.checkpoint.outputSha256,
      'project B B-roll composition must produce different final bytes from project A',
    )
    assert.equal(await client.v2ProviderJob.count({ where: { workspaceId, projectId: consumerProject.project.id } }), 0)
    assert.equal(await client.v2DirectorBudgetReservation.count({ where: { workspaceId, projectId: consumerProject.project.id } }), 0)
    assert.equal(await client.v2ProviderTransportEvidence.count({ where: { workspaceId, projectId: consumerProject.project.id, phase: 'submit' } }), 0)

    const gateResponse = await boundedFetch(gateEndpoint, {
      method: 'POST',
      headers: { ...bearerHeaders, 'idempotency-key': 'synthetic-wave24-phase-gate' },
      body: JSON.stringify({
        projectVersionId: project.version.id,
        projectVersionHash: project.version.baseHash,
      }),
    }, t.signal)
    const gate = (await readExpectedPublicResponse(
      gateResponse,
      'synthetic phase gate run',
      201,
      t,
    )).data.gate
    assert.equal(gate.report.approved, false)
    assert.deepEqual([gate.report.passed, gate.report.total], [3, 4])
    const gateCoverage = summarizeSyntheticPhaseGateCoverage(gate.report)
    assert.deepEqual([gateCoverage.covered, gateCoverage.total], [5, 8])
    assert.deepEqual(gateCoverage.missingCodes, [...expectedMissingLiveChecks].sort())
    await writeFile(
      join(evidenceRoot, 'phase-gate-report.json'),
      `${JSON.stringify(gate, null, 2)}\n`,
      'utf8',
    )
    const listedResponse = await boundedFetch(`${gateEndpoint}?limit=100`, {
      headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json' },
    }, t.signal)
    const listed = (await readExpectedPublicResponse(
      listedResponse,
      'synthetic phase gate list',
      200,
      t,
    )).data.gates
    assert.equal(listed[0].recordHash, gate.recordHash)

    // The render and attestation are the observable difference between the
    // first two evaluations of the same version.
    assert.equal(gate.projectVersionId, preRenderGate.projectVersionId)
    assert.equal(gate.projectVersionHash, preRenderGate.projectVersionHash)
    for (const code of [renderReuseCheck, renderSwapCheck]) {
      assert.equal(gateCheck(gate, code)?.passed, true, `${code} must pass after the attested renders`)
      assert.deepEqual(gateCheck(gate, code)?.missingEvidenceTypes, [])
    }
    assert.deepEqual([gateCoverage.covered, preRenderCoverage.covered], [5, 3], 'render evidence must add two covered checks')
    assert.notEqual(gate.reportFingerprint, preRenderGate.reportFingerprint)
    assert.ok(Date.parse(gate.createdAt) > Date.parse(preRenderGate.createdAt))

    // The third real evaluation repeats the same version after the evidence:
    // same coverage, but a new immutable record.
    const repeatedGate = await runPhaseGateAsJourneyActor(
      'synthetic-wave25-phase-gate-repeat',
      'synthetic phase gate repeat',
    )
    assert.equal(repeatedGate.projectVersionId, gate.projectVersionId)
    assert.equal(repeatedGate.projectVersionHash, gate.projectVersionHash)
    assert.equal(repeatedGate.report.approved, false)
    assert.deepEqual([repeatedGate.report.passed, repeatedGate.report.total], [3, 4])
    assert.deepEqual(summarizeSyntheticPhaseGateCoverage(repeatedGate.report), gateCoverage)
    assert.notEqual(repeatedGate.id, gate.id)
    assert.notEqual(repeatedGate.recordHash, gate.recordHash)
    assert.ok(Date.parse(repeatedGate.createdAt) > Date.parse(gate.createdAt))

    const readCanonicalGateHistory = async () => (await readExpectedPublicResponse(
      await boundedFetch(`${gateEndpoint}?limit=20`, {
        headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json' },
      }, t.signal),
      'synthetic phase gate canonical history',
      200,
      t,
    )).data.gates
    const historyGates = await readCanonicalGateHistory()
    assert.deepEqual(historyGates.map(({ id }) => id), [repeatedGate.id, gate.id, preRenderGate.id])
    assert.deepEqual(historyGates.map(({ recordHash }) => recordHash), [
      repeatedGate.recordHash,
      gate.recordHash,
      preRenderGate.recordHash,
    ])
    for (const historyGate of historyGates) {
      assert.equal(historyGate.projectVersionId, project.version.id)
      assert.equal(historyGate.projectVersionHash, project.version.baseHash)
    }
    await writeFile(join(evidenceRoot, 'phase-gate-history-api.json'), `${JSON.stringify({
      mode: 'real',
      endpoint: 'GET /v1/projects/{projectId}/synthetic-phase-gates?limit=20',
      actor: 'journey API client (bearer)',
      projectId: project.project.id,
      projectVersionId: project.version.id,
      projectVersionHash: project.version.baseHash,
      gates: historyGates.map((historyGate) => ({
        id: historyGate.id,
        createdAt: historyGate.createdAt,
        evaluatedAt: historyGate.report.evaluatedAt,
        reportFingerprint: historyGate.reportFingerprint,
        recordHash: historyGate.recordHash,
        criteria: `${historyGate.report.passed}/${historyGate.report.total}`,
        checksCovered: summarizeSyntheticPhaseGateCoverage(historyGate.report).covered,
        renderDerivedChecks: Object.fromEntries([renderReuseCheck, renderSwapCheck].map((code) => [
          code,
          gateCheck(historyGate, code)?.missingEvidenceTypes.length === 0 ? 'covered' : 'absent',
        ])),
      })),
    }, null, 2)}\n`, 'utf8')

    assert.equal(typeof project.project.name, 'string')
    assert.equal(typeof consumerProject.project.name, 'string')
    // W27: the journey actor's own read of the critic report the gate
    // references (the viewer is compared with this record), and the persisted
    // rows the read-only viewer must never add to or remove.
    const readTransformationCriticReportAsJourneyActor = async (reportId) => (await readExpectedPublicResponse(
      await boundedFetch(
        `${baseUrl}/v1/projects/${encodeURIComponent(project.project.id)}/transformation-critic-reports/${encodeURIComponent(reportId)}`,
        { headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json' } },
        t.signal,
      ),
      'transformation critic report read as the journey actor',
      200,
      t,
    )).data.report
    const readCriticViewerPersistedCounts = async () => ({
      transformationCriticReports: await client.v2TransformationCriticReport.count({ where: { workspaceId } }),
      transformationCriticMeasurements: await client.v2TransformationCriticMeasurement.count({ where: { workspaceId } }),
      transformationCriticIssues: await client.v2TransformationCriticIssue.count({ where: { workspaceId } }),
      syntheticCriticReports: await client.v2SyntheticCriticReport.count({ where: { workspaceId } }),
      syntheticPhaseGates: await client.v2SyntheticPhaseGate.count({ where: { workspaceId } }),
      syntheticPhaseGateEvidence: await client.v2SyntheticPhaseGateEvidence.count({ where: { workspaceId } }),
    })
    const browserEvidence = await assertSyntheticPhaseGateBrowser({
      baseUrl,
      projectId: project.project.id,
      login: { username: uiUsername, password: uiPassword },
      evidence: {
        screenshotPath: join(evidenceRoot, 'synthetic-phase-gate.png'),
        root: evidenceRoot,
      },
      expected: {
        criteriaPassed: 3,
        criteriaTotal: 4,
        checksPassed: 5,
        checksTotal: 8,
        approved: false,
        missingLiveChecks: expectedMissingLiveChecks,
      },
      history: {
        canonicalGates: historyGates,
        readCanonicalGates: readCanonicalGateHistory,
        currentVersion: { id: project.version.id, hash: project.version.baseHash },
        olderGateId: preRenderGate.id,
        projectName: project.project.name,
        secondProject: {
          id: consumerProject.project.id,
          name: consumerProject.project.name,
          versionId: consumerProject.version.id,
          versionHash: consumerProject.version.baseHash,
        },
      },
      criticViewer: {
        readReport: readTransformationCriticReportAsJourneyActor,
        readPersistedCounts: readCriticViewerPersistedCounts,
      },
      step: async (name, action) => {
        let failure = null
        await t.test(name, async () => {
          try {
            await action()
          } catch (error) {
            failure = error
            throw error
          }
        })
        if (failure) throw failure
      },
      signal: t.signal,
      readServerLogs: () => serverLogs,
    })
    assert.ok(browserEvidence.gateText.includes('5/8 checks com evidência'))
    // The editor's own re-evaluation is the fourth real record; every
    // controlled transport answer stayed in the browser and never persisted.
    const historyAfterBrowser = await readCanonicalGateHistory()
    assert.equal(historyAfterBrowser.length, historyGates.length + 1)
    assert.equal(historyAfterBrowser[0].id, browserEvidence.history.editorEvaluationId)
    assert.deepEqual(historyAfterBrowser.slice(1).map(({ id }) => id), historyGates.map(({ id }) => id))
    assert.equal(historyAfterBrowser.some(({ id }) => id.startsWith('controlled-')), false)
    assert.equal(await client.v2SyntheticPhaseGate.count({ where: { workspaceId } }), historyGates.length + 1)
    // W27: the viewer only reads. The critic reports and gates the W27 block
    // found are exactly what the database holds after the browser section.
    const criticViewerCountsAfterBrowser = await readCriticViewerPersistedCounts()
    assert.deepEqual(criticViewerCountsAfterBrowser, browserEvidence.criticViewer.countsBefore,
      'the W27 critic report viewer block must not persist or remove anything')
    assert.equal(criticViewerCountsAfterBrowser.syntheticPhaseGates, historyGates.length + 1)
    await writeFile(join(evidenceRoot, 'result.json'), `${JSON.stringify({
      runId: process.env.APOLLO_WAVE24_RUN_ID,
      sourceProjectId: project.project.id,
      consumerProjectId: consumerProject.project.id,
      sourceMasterId: promoted.master.id,
      consumptionId: consumption.id,
      sourceRender: {
        operationId: sourceRender.created.operation.id,
        outputSha256: sourceRender.terminal.checkpoint.outputSha256,
        captionFrames: sourceRender.captionFrames,
      },
      consumerRender: {
        operationId: consumerRender.created.operation.id,
        outputSha256: consumerRender.terminal.checkpoint.outputSha256,
        bRollFrame: 'project-b-final-frame.png',
        overlayFrame: 'project-b-overlay-frame.png',
        captionFrames: consumerRender.captionFrames,
      },
      fallbackJobId: fallback.fallbackJob.id,
      phaseGateId: gate.id,
      phaseGateRecordHash: gate.recordHash,
      criteria: { passed: gate.report.passed, total: gate.report.total },
      checks: { covered: 5, total: 8 },
      phaseGateHistory: {
        mode: 'real',
        projectVersionId: project.version.id,
        evaluations: historyAfterBrowser.map((historyGate) => ({
          id: historyGate.id,
          createdAt: historyGate.createdAt,
          recordHash: historyGate.recordHash,
          checksCovered: summarizeSyntheticPhaseGateCoverage(historyGate.report).covered,
        })),
        preRenderGateId: preRenderGate.id,
        editorEvaluationId: browserEvidence.history.editorEvaluationId,
        browserEvidence: browserEvidence.history.evidencePath,
      },
      criticReportViewer: {
        reportId: browserEvidence.criticViewer.reportId,
        reportHash: browserEvidence.criticViewer.reportHash,
        persistedCountsBeforeW27: browserEvidence.criticViewer.countsBefore,
        persistedCountsAfterW27: browserEvidence.criticViewer.countsAfter,
        persistedCountsAfterBrowser: criticViewerCountsAfterBrowser,
        browserEvidence: browserEvidence.criticViewer.evidencePath,
      },
    }, null, 2)}\n`, 'utf8')

    if (objectStore) {
      // MinIO is the storage of record for every persisted artifact except the
      // external consent document fixture, whose bytes are outside this journey.
      const listing = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
      assert.equal(listing.IsTruncated ?? false, false)
      assert.equal((listing.DeleteMarkers ?? []).length, 0)
      const persistedKeys = (await client.v2MediaArtifact.findMany({
        where: { workspaceId, id: { not: 'journey-consent-evidence' }, status: 'available' },
        select: { artifactKey: true },
      })).map(({ artifactKey }) => artifactKey).sort()
      assert.deepEqual((listing.Versions ?? []).map(({ Key }) => Key).sort(), persistedKeys)
      assert.deepEqual(await readdir(artifactRoot), [], 'local staging root must hold no promoted bytes in s3 mode')
    }

    // Isolated negatives follow only after the positive A-to-B evidence is retained.
  } catch (error) {
    primaryError = error
    t.diagnostic(`journey failure before cleanup: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    const details = error && typeof error === 'object' && 'details' in error ? error.details : null
    if (details && typeof details === 'object' && 'decisions' in details && Array.isArray(details.decisions)) {
      t.diagnostic(`journey safe domain details: ${JSON.stringify({
        code: 'code' in error && typeof error.code === 'string' ? error.code : null,
        decisions: details.decisions.map((decision) => decision && typeof decision === 'object'
          ? {
              artifactId: 'artifactId' in decision && typeof decision.artifactId === 'string' ? decision.artifactId : null,
              outcome: 'outcome' in decision && typeof decision.outcome === 'string' ? decision.outcome : null,
              reasonCodes: 'reasonCodes' in decision && Array.isArray(decision.reasonCodes)
                ? decision.reasonCodes.filter((reason) => typeof reason === 'string')
                : [],
            }
          : null),
      })}`)
    }
    throw error
  } finally {
    const cleanupErrors = []
    const cleanupStep = async (label, action) => {
      try {
        await action()
      } catch (error) {
        const wrapped = new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        cleanupErrors.push(wrapped)
        t.diagnostic(wrapped.stack ?? wrapped.message)
      }
    }
    await cleanupStep('write bounded Next diagnostics failed', () =>
      writeFile(join(evidenceRoot, 'next.log'), serverLogs.slice(-256 * 1024), 'utf8'))
    await cleanupStep('controlled fallback fixture cleanup failed', async () => fallbackFixture?.close())
    await cleanupStep('Next process-tree cleanup failed', async () => stopChild(server))
    await cleanupStep('shared runtime database disconnect failed', async () => {
      const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
      await disconnectV2PostgresClient()
    })
    await cleanupStep('database cleanup failed', cleanup)
    await cleanupStep('database disconnect failed', () => client.$disconnect())
    if (objectStore) {
      // Zero orphan objects: delete every version, prove the empty listing,
      // then remove the run-exclusive bucket itself.
      await cleanupStep('object storage cleanup failed', async () => {
        const versions = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
        const stored = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].map(({ Key, VersionId }) => ({ Key, VersionId }))
        if (stored.length > 0) {
          await objectStore.client.send(new objectStore.aws.DeleteObjectsCommand({ Bucket: objectStore.bucket, Delete: { Objects: stored, Quiet: true } }))
        }
        const after = await objectStore.client.send(new objectStore.aws.ListObjectVersionsCommand({ Bucket: objectStore.bucket }))
        assert.deepEqual([...(after.Versions ?? []), ...(after.DeleteMarkers ?? [])], [], 'object storage must hold zero orphan objects after cleanup')
        await objectStore.client.send(new objectStore.aws.DeleteBucketCommand({ Bucket: objectStore.bucket }))
      })
      objectStore.client.destroy()
    }
    await cleanupStep('render scratch cleanup failed', async () => {
      const renderRoot = join(workRoot, 'render-output')
      const renderEntries = await readdir(renderRoot, { recursive: true }).catch(() => [])
      const normalizedRenderEntries = renderEntries.map((entry) => String(entry).replaceAll('\\', '/'))
      assert.equal(normalizedRenderEntries.some((entry) => entry.includes('.partial.')), false, 'render scratch retains a partial output')
      assert.deepEqual(
        normalizedRenderEntries.filter((entry) => entry.endsWith('.mp4')).sort(),
        [...expectedRenderOutputKeys].sort(),
        'render scratch contains an unexpected or missing committed output',
      )
      const materializeEntries = await readdir(join(workRoot, 'render-materialize'), { recursive: true }).catch(() => [])
      assert.deepEqual(materializeEntries, [], 'render materialization root retains worker files')
      const providerEntries = await readdir(join(workRoot, 'provider'), { recursive: true }).catch(() => [])
      assert.deepEqual(providerEntries, [], 'provider work root retains worker files')
      await rm(renderRoot, { recursive: true, force: true })
      await rm(join(workRoot, 'render-materialize'), { recursive: true, force: true })
      await rm(join(workRoot, 'provider'), { recursive: true, force: true })
    })
    // Zero orphans: every provider-side scratch root must be empty afterwards.
    await cleanupStep('provider work-root postflight failed', async () => {
      const leftoverWork = await readdir(workRoot).catch(() => [])
      assert.deepEqual(leftoverWork, [], 'provider work root must not keep orphan files')
    })
    await cleanupStep('materialization postflight failed', async () => {
      const leftoverMaterialize = await readdir(join(root, 'materialize')).catch(() => [])
      assert.deepEqual(leftoverMaterialize, [], 'artifact materialization root must not keep orphan files')
    })
    if (cleanupErrors.length === 0) {
      await cleanupStep('scratch-root removal failed', () => rm(root, { recursive: true, force: true }))
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        primaryError ? [primaryError, ...cleanupErrors] : cleanupErrors,
        primaryError ? 'journey and cleanup both failed' : 'journey cleanup failed',
      )
    }
  }
})

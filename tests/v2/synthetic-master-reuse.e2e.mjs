import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

const workspaceId = 'master-reuse-e2e-workspace'
const foreignWorkspaceId = 'master-reuse-e2e-foreign'
const clientId = 'master-reuse-e2e-client'
const foreignClientId = 'master-reuse-e2e-foreign-client'
const providerJobId = 'master-reuse-provider-job'
const hash = (character) => character.repeat(64)
const at = (second) => new Date(Date.parse('2029-06-01T00:00:00.000Z') + second * 1_000).toISOString()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitForServer(baseUrl, server, readLogs) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next server exited with ${server.exitCode}\n${readLogs().slice(-4_000)}`)
    }
    try {
      if ((await globalThis.fetch(`${baseUrl}/v1/health`)).ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Next server\n${readLogs().slice(-4_000)}`)
}

/**
 * F3.007 reuse proof.
 *
 * One workspace seals a synthetic master in project A, catalogs its speech
 * segments, and then project B — a different project in the same workspace —
 * finds and reads that performance through the public catalog. The whole
 * project B phase is measured on three independent counters (provider HTTP
 * calls, durable provider jobs, sealed masters) so "reuse costs nothing" is an
 * observation, not a claim.
 *
 * The generation itself is a fixture: an approved provider job with its result
 * artifacts, exactly like the F3.007 persistence integration test. What is
 * under test is the master and its reuse, not how the bytes were produced.
 *
 * The fixture carries the three ledger roles the pipeline actually writes —
 * primary-video, primary-audio and alignment-evidence, the only three
 * `provider_result_artifacts_media_check` admits. `normalized-video` is an
 * optional master role reserved for a real normalization stage, so a master
 * promoted straight off a provider job holds three artifacts and its video
 * duration is measured on the provider's own track.
 */
test('T-FR-104 a sealed synthetic master is reused across projects through /v1 with zero new provider work', {
  skip: !process.env.V2_DATABASE_URL && 'V2_DATABASE_URL is required',
  timeout: 900_000,
}, async () => {
  const client = new PrismaClient({ datasources: { db: { url: process.env.V2_DATABASE_URL } } })
  const root = await mkdtemp(join(tmpdir(), 'apollo-master-reuse-'))
  const artifactRoot = join(root, 'artifacts')
  const workRoot = join(root, 'work')
  let stub = null
  let server = null
  let serverLogs = ''

  const cleanupWorkspace = async (id) => {
    await client.v2SyntheticCriticIssue.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticMeasurement.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticEvaluator.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticCriticReport.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.updateMany({ where: { workspaceId: id }, data: { currentVersionId: null } })
    await client.v2SyntheticScriptBlock.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlanVersion.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticScriptPlan.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticSpeechSegment.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticMasterAsset.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderResultArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJobTransition.deleteMany({ where: { workspaceId: id } })
    await client.v2ProviderJob.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfileHead.deleteMany({ where: { workspaceId: id } })
    await client.v2SyntheticPresenterProfile.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifact.updateMany({
      where: { workspaceId: id },
      data: { currentRightsSnapshotId: null, rightsRevision: 0 },
    })
    await client.v2AssetRightsChange.deleteMany({ where: { workspaceId: id } })
    await client.v2AssetRightsSnapshot.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifactLineage.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifactManifest.deleteMany({ where: { workspaceId: id } })
    await client.v2MediaArtifact.deleteMany({ where: { workspaceId: id } })
    await client.v2PublicEventOutbox.deleteMany({ where: { workspaceId: id } })
    await client.v2IdempotencyRecord.deleteMany({ where: { workspaceId: id } })
    await client.v2ProjectCreationCommand.deleteMany({ where: { workspaceId: id } })
    await client.v2Project.deleteMany({ where: { workspaceId: id } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: id } })
    await client.v2Workspace.deleteMany({ where: { id } })
  }
  const cleanup = async () => {
    await cleanupWorkspace(workspaceId)
    await cleanupWorkspace(foreignWorkspaceId)
  }

  try {
    await cleanup()
    await mkdir(artifactRoot, { recursive: true })
    await mkdir(workRoot, { recursive: true })

    const { createProjectService } = await import('../../src/v2/application/create-project.ts')
    const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
    const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
    const { registerSyntheticPresenterProfileService } = await import('../../src/v2/application/synthetic-production.ts')
    const { setAssetRightsService } = await import('../../src/v2/application/set-asset-rights.ts')
    const { catalogSyntheticSpeechSegmentsService } = await import('../../src/v2/application/synthetic-speech-segments.ts')
    const { assetRightsRevision } = await import('../../src/v2/domain/asset-rights.ts')
    const { createSyntheticCriticReport } = await import('../../src/v2/domain/synthetic-critic-report.ts')
    const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
    const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
    const { PrismaWorkspaceRepository } = await import('../../src/v2/infrastructure/prisma/workspace-repository.ts')
    const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
    const { PrismaAssetRightsRepository } = await import('../../src/v2/infrastructure/prisma/asset-rights-repository.ts')
    const { PrismaMediaArtifactRepository } = await import('../../src/v2/infrastructure/prisma/media-artifact-repository.ts')
    const { PrismaProjectCreationRepository } = await import('../../src/v2/infrastructure/prisma/project-creation-repository.ts')
    const { PrismaSyntheticProductionRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-production-repository.ts')
    const { PrismaSyntheticMasterAssetRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-master-asset-repository.ts')
    const { PrismaSyntheticCriticReportRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-critic-report-repository.ts')
    const { PrismaSyntheticSpeechSegmentRepository } = await import('../../src/v2/infrastructure/prisma/synthetic-speech-segment-repository.ts')
    const { StoredSyntheticMasterAlignmentReader } = await import('../../src/v2/infrastructure/media/synthetic-master-alignment-reader.ts')
    const { LocalArtifactContentStorage } = await import('../../src/v2/infrastructure/media/local-artifact-content-storage.ts')

    // 0. Real bytes on disk. The promotion verifies every checksum against
    //    storage and measures both durations with ffprobe, so fabricated
    //    fixtures would never reach a sealed master. Audio and video are the
    //    same four seconds; the master tolerates at most one 30fps frame of
    //    drift between them.
    const roleFiles = {
      'provider-original': { key: `workspaces/${workspaceId}/masters/provider-original.mp4`, mediaType: 'video', container: 'mp4' },
      'final-audio': { key: `workspaces/${workspaceId}/masters/final-audio.wav`, mediaType: 'audio', container: 'wav' },
      alignment: { key: `workspaces/${workspaceId}/masters/alignment.json`, mediaType: 'data', container: 'json' },
    }
    const artifactIds = {
      'provider-original': 'master-reuse-original',
      'final-audio': 'master-reuse-audio',
      alignment: 'master-reuse-alignment',
    }
    const scriptText = 'Primeira ideia do roteiro. Segunda ideia bem forte.'
    const alignmentWords = [
      { word: 'Primeira', startMs: 0, endMs: 700 },
      { word: 'ideia', startMs: 700, endMs: 1_100 },
      { word: 'do', startMs: 1_100, endMs: 1_300 },
      { word: 'roteiro.', startMs: 1_300, endMs: 1_900 },
      { word: 'Segunda', startMs: 2_300, endMs: 2_900 },
      { word: 'ideia', startMs: 2_900, endMs: 3_300 },
      { word: 'bem', startMs: 3_300, endMs: 3_500 },
      { word: 'forte.', startMs: 3_500, endMs: 3_900 },
    ]
    const absolute = (key) => join(artifactRoot, ...key.split('/'))
    for (const key of Object.values(roleFiles).map((file) => file.key)) {
      await mkdir(dirname(absolute(key)), { recursive: true })
    }
    // The provider original carries its own audio track, exactly like a real
    // audio-avatar delivery: the master's duration probe refuses a silent video.
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30',
      '-f', 'lavfi', '-i', 'sine=frequency=320:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart',
      absolute(roleFiles['provider-original'].key),
    ], { windowsHide: true })
    execFileSync(ffmpegPath, [
      '-v', 'error', '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=320:sample_rate=44100:duration=4', '-c:a', 'pcm_s16le',
      absolute(roleFiles['final-audio'].key),
    ], { windowsHide: true })
    // The alignment artifact holds real provider-shaped character timings; the
    // catalog folds them back into exactly the eight words above, so nothing in
    // this test hands the domain a range it did not read from stored bytes.
    const characters = []
    const startTimesSeconds = []
    const endTimesSeconds = []
    for (const [index, word] of alignmentWords.entries()) {
      if (index > 0) {
        characters.push(' ')
        startTimesSeconds.push(alignmentWords[index - 1].endMs / 1_000)
        endTimesSeconds.push(word.startMs / 1_000)
      }
      const letters = [...word.word]
      const step = (word.endMs - word.startMs) / letters.length
      for (const [letterIndex, letter] of letters.entries()) {
        characters.push(letter)
        startTimesSeconds.push((word.startMs + letterIndex * step) / 1_000)
        endTimesSeconds.push((word.startMs + (letterIndex + 1) * step) / 1_000)
      }
    }
    assert.equal(characters.join(''), scriptText, 'the alignment must spell the script it timed')
    await writeFile(
      absolute(roleFiles.alignment.key),
      JSON.stringify({ schemaVersion: 'tts-alignment/v1', characters, startTimesSeconds, endTimesSeconds }),
    )
    const bytes = {}
    for (const [role, file] of Object.entries(roleFiles)) {
      const content = await readFile(absolute(file.key))
      bytes[role] = { sha256: sha256(content), byteSize: content.byteLength }
      assert.ok(bytes[role].byteSize > 0, `${role} fixture must carry bytes`)
    }

    // 1. Workspaces, clients, project A.
    const workspaces = new PrismaWorkspaceRepository(client)
    await workspaces.create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Master reuse journey', status: 'active', createdAt: at(0) }))
    await workspaces.create(createWorkspace({ id: foreignWorkspaceId, slug: foreignWorkspaceId, name: 'Foreign workspace', status: 'active', createdAt: at(0) }))

    const issueClient = createApiClientService({
      repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(at(0)),
    })
    const issued = await issueClient({
      id: clientId, workspaceId, name: 'Master reuse client', environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const foreignIssued = await issueClient({
      id: foreignClientId, workspaceId: foreignWorkspaceId, name: 'Foreign client', environment: 'production',
      scopes: ['projects:read', 'projects:write'],
    })
    const externalAudit = createExternalAuditContext({
      clientId, credentialId: issued.credential.id, workspaceId, environment: 'production',
    })
    const actor = Object.freeze({
      ...externalAudit, scopes: new Set(['projects:read', 'projects:write']), authenticationKind: 'bearer',
      clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext: externalAudit,
    })
    const auditContext = materializeActorAuditContext(actor)

    let entity = 0
    let event = 0
    const projectA = await createProjectService({
      repository: new PrismaProjectCreationRepository(client), clock: () => new Date(at(0)),
      createId: (kind) => `${kind}-master-reuse-${++entity}`,
      createEventId: () => `00000000-0000-4000-8000-${String(710_000 + ++event).padStart(12, '0')}`,
    })({
      workspaceId, name: 'Projeto A', objective: 'awareness', format: '9:16', actor,
      idempotency: { clientId, key: 'master-reuse-project-a' },
    })
    const projectId = projectA.project.id
    const projectVersionId = projectA.version.id

    // 2. Catalogued artifacts, cleared rights and the presenter consent.
    for (const [role, file] of Object.entries(roleFiles)) {
      await client.v2MediaArtifact.create({
        data: {
          id: artifactIds[role], workspaceId, artifactKey: file.key, sha256: bytes[role].sha256,
          byteSize: BigInt(bytes[role].byteSize), mediaType: file.mediaType, container: file.container,
          status: 'available', createdAt: new Date(at(0)),
        },
      })
    }
    await client.v2MediaArtifact.create({
      data: {
        id: 'master-reuse-consent-evidence', workspaceId, artifactKey: `workspaces/${workspaceId}/masters/consent.json`,
        sha256: hash('e'), byteSize: 512n, mediaType: 'data', container: 'json', status: 'available', createdAt: new Date(at(0)),
      },
    })
    const setRights = setAssetRightsService({
      repository: new PrismaAssetRightsRepository(client),
      clock: () => new Date(at(0)),
      createId: () => `master-reuse-rights-${++entity}`,
    })
    for (const role of Object.keys(roleFiles)) {
      await setRights({
        workspaceId, artifactId: artifactIds[role], baseRevision: assetRightsRevision(artifactIds[role], 0),
        draft: {
          status: 'approved', allowedUses: ['ads'], prohibitedUses: [],
          allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
          consent: { status: 'not-required', allowedUses: [] },
        },
        actor: { type: 'api-client', id: clientId },
      })
    }

    const profile = await registerSyntheticPresenterProfileService({
      repository: new PrismaSyntheticProductionRepository(client),
      artifacts: new PrismaMediaArtifactRepository(client),
      clock: () => new Date(at(0)),
    })({
      workspaceId, profileId: 'master-reuse-presenter', version: 1, actorIdentityId: 'master-reuse-identity',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.1.0', identityRef: 'avatar_reuse' },
      voice: { id: 'voice_reuse', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
      defaultLocale: 'pt-BR', status: 'active', disclosure: 'Conteúdo gerado com IA',
      consent: {
        id: 'master-reuse-consent-v1', evidenceArtifactId: 'master-reuse-consent-evidence', granted: true,
        allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
        allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      },
      actor, idempotencyKey: 'master-reuse-profile-v1',
    })
    const profileSnapshotId = profile.profile.profileSnapshotId

    // 3. The approved provider job and its result ledger. This is the fixture:
    //    the generation already happened and was approved by a critic.
    const criticResultHash = hash('f')
    await client.v2ProviderJob.create({
      data: {
        id: providerJobId, workspaceId, projectId, originProjectVersionId: projectVersionId,
        schemaVersion: 'provider-job/v1', operation: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.1.0',
        providerJobId: 'heygen_job_reuse', inputJson: '{}', inputHash: hash('1'),
        authorizationJson: '{}', authorizationHash: hash('2'), status: 'approved',
        resultArtifactId: artifactIds['provider-original'], resultArtifactSha256: bytes['provider-original'].sha256,
        criticResultHash, jobJson: '{}', jobHash: hash('3'), requestFingerprint: hash('4'),
        idempotencyKey: 'master-reuse-job-key', createdByClientId: clientId, actorContextHash: auditContext.contextHash,
        createdAt: new Date(at(1)), updatedAt: new Date(at(6)),
        submittedAt: new Date(at(2)), completedAt: new Date(at(6)),
      },
    })
    // The ledger roles the promotion maps onto the four master roles.
    // The three roles the ledger admits, mapped onto the three required master
    // roles. There is deliberately no normalization row: no stage writes one.
    const resultRoles = {
      'primary-video': 'provider-original',
      'primary-audio': 'final-audio',
      'alignment-evidence': 'alignment',
    }
    for (const [resultRole, masterRole] of Object.entries(resultRoles)) {
      await client.v2ProviderResultArtifact.create({
        data: {
          id: `master-reuse-result-${masterRole}`, workspaceId, projectId, jobId: providerJobId,
          schemaVersion: 'provider-result-artifact/v1', role: resultRole, providerJobRef: 'heygen_job_reuse',
          artifactId: artifactIds[masterRole], artifactSha256: bytes[masterRole].sha256,
          byteSize: BigInt(bytes[masterRole].byteSize),
          mediaType: roleFiles[masterRole].mediaType, container: roleFiles[masterRole].container,
          adapterId: 'heygen-v3', adapterVersion: '3.1.0', modelRef: 'avatar-model-1',
          adapterConfigHash: hash('7'), inputHash: hash('1'), authorizationHash: hash('2'),
          completedAt: new Date(at(6)), createdAt: new Date(at(6)),
        },
      })
    }

    // 3b. The critic's durable verdict on those exact bytes. Since F3.009 this
    //     — not the job's `criticResultHash` — is what lets a result become a
    //     master, so the journey must carry a real, persisted, hash-verified
    //     approval or the promotion below fails closed.
    await client.v2SyntheticScriptPlan.create({
      data: {
        id: 'master-reuse-plan', workspaceId, projectId, schemaVersion: 'synthetic-script-plan/v1',
        requestFingerprint: hash('1'), idempotencyKey: 'master-reuse-plan-key', createdByClientId: clientId,
        actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)), updatedAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptPlanVersion.create({
      data: {
        id: 'master-reuse-plan-v1', planId: 'master-reuse-plan', workspaceId, projectId, sequence: 1,
        projectVersionId, profileSnapshotId, schemaVersion: 'synthetic-script-plan-version/v1',
        locale: 'pt-BR', segmentationVersion: 'synthetic-script-segmentation/v1',
        scriptHash: hash('2'), commandType: 'create-plan', blockSequenceJson: '["master-reuse-block"]',
        impactJson: '{}', commandImpactHash: hash('3'), planVersionHash: hash('4'),
        requestFingerprint: hash('1'), idempotencyKey: 'master-reuse-plan-version-key',
        createdByClientId: clientId, actorContextHash: auditContext.contextHash, createdAt: new Date(at(0)),
      },
    })
    await client.v2SyntheticScriptBlock.create({
      data: {
        id: 'master-reuse-block', workspaceId, projectId, planId: 'master-reuse-plan',
        schemaVersion: 'synthetic-script-block/v1', exactText: 'Primeira ideia do roteiro.',
        normalizedTextHash: hash('5'), locale: 'pt-BR', occurrence: 1,
        createdInVersionId: 'master-reuse-plan-v1', originKind: 'initial-segmentation',
        blockHash: hash('6'), createdAt: new Date(at(0)),
      },
    })
    const criticMeasured = (dimension, evaluatorId, value, unit, threshold) => ({
      dimension, status: 'measured', evaluatorId, value, unit, threshold,
      confidence: 1, evidenceRefs: [`artifact://${artifactIds['provider-original']}`], range: null, note: null,
    })
    const criticUnavailable = (dimension, note) => ({
      dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
      threshold: null, confidence: null, evidenceRefs: [], range: null, note,
    })
    const criticVerdict = await new PrismaSyntheticCriticReportRepository(client).record({
      report: createSyntheticCriticReport({
        id: 'master-reuse-critic-report', workspaceId, projectId, blockId: 'master-reuse-block',
        capability: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.1.0',
        artifactId: artifactIds['provider-original'], artifactSha256: bytes['provider-original'].sha256,
        audioArtifactId: artifactIds['final-audio'], alignmentArtifactId: artifactIds.alignment,
        scriptHash: hash('7'), profileSnapshotId, expectedIdentityRef: 'avatar_reuse',
        evaluators: [
          { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'timeline and signal read from the artifact' },
          { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'spoken words compared to the approved script' },
          { id: 'controlled-deterministic-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in, not production visual validation' },
        ],
        measurements: [
          criticMeasured('lip-sync', 'controlled-deterministic-probe', 0, 'ms-av-offset', 34),
          criticMeasured('identity', 'controlled-deterministic-probe', 1, 'identity-ref-match', 1),
          criticMeasured('pronunciation', 'alignment-pronunciation', 0, 'word-deviations', 0),
          criticUnavailable('visual-artifacts', 'no visual artifact detector is deployed'),
          criticUnavailable('framing', 'no framing model is deployed'),
          criticUnavailable('continuity', 'this is the first approved block of the take'),
          criticUnavailable('eyes', 'no eye model is deployed'),
          criticUnavailable('teeth', 'no teeth model is deployed'),
          criticUnavailable('hands', 'no hand model is deployed'),
          criticMeasured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
          criticMeasured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'live-signal', 1),
        ],
        issues: [],
        decision: 'approved', recommendedAction: 'none',
        thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1',
        decidedAt: at(7),
      }),
    })
    assert.equal(criticVerdict.value.decision, 'approved')

    // 4. A loopback provider boundary nothing in this journey may touch. Every
    //    request that reaches it is a paid call the reuse claim would have to
    //    answer for.
    const providerCalls = []
    stub = http.createServer((request, response) => {
      providerCalls.push(`${request.method} ${request.url}`)
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ detail: 'no provider call is allowed in this journey' }))
    })
    const stubPort = await freePort()
    await new Promise((resolve) => stub.listen(stubPort, '127.0.0.1', resolve))

    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const runtimeEnv = {
      ...process.env,
      NODE_ENV: 'development',
      __NEXT_PROCESSED_ENV: 'true',
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_GOVERNANCE_ANOMALY_REQUEST_MINIMUM: '400',
      APOLLO_V2_PERSISTENCE: 'postgres',
      APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
      APOLLO_V2_ARTIFACT_ROOT: artifactRoot,
      APOLLO_V2_RENDER_WORK_ROOT: workRoot,
      APOLLO_V2_PROVIDER_WORK_ROOT: join(workRoot, 'provider'),
      APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'master-reuse-protected-payload',
      APOLLO_PROTECTED_PAYLOAD_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
      APOLLO_V2_ELEVENLABS_API_KEY: 'master-reuse-stub-secret',
      APOLLO_V2_ELEVENLABS_BASE_URL: `http://127.0.0.1:${stubPort}`,
      APOLLO_V2_PROVIDER_POLL_MS: '200',
    }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--webpack', '-p', String(port)], {
      cwd: process.cwd(), env: runtimeEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server, () => serverLogs)

    const api = async (method, path, options = {}) => {
      const token = options.token ?? issued.token
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
      if (options.key) headers['idempotency-key'] = options.key
      // A 404 with a null body is the dev server still lazily compiling the
      // route (a real 404 carries the {error} envelope). Replaying is safe:
      // every mutation here carries an idempotency key.
      const deadline = Date.now() + 30_000
      for (;;) {
        const response = await globalThis.fetch(`${baseUrl}${path}`, {
          method, headers,
          ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
        })
        const payload = await response.json().catch(() => null)
        if (response.status === 404 && payload === null && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500))
          continue
        }
        return { status: response.status, payload }
      }
    }

    const masterPath = `/v1/projects/${projectId}/synthetic-masters`
    const promotionBody = {
      providerJobId,
      profileSnapshotId,
      scriptText,
      locale: 'pt-BR',
      use: 'ads',
      market: 'BRA',
      lineage: ['generation-1', 'generation-2'],
      cost: { currency: 'USD', minorUnits: 150 },
    }

    // 5. Promotion seals one master with its four roles.
    const promoted = await api('POST', masterPath, { key: 'master-reuse-promote-1', payload: promotionBody })
    assert.equal(promoted.status, 201, JSON.stringify(promoted.payload))
    assert.equal(promoted.payload.data.replayed, false)
    const master = promoted.payload.data.master
    const masterId = master.id
    assert.match(master.masterHash, /^[a-f0-9]{64}$/)
    assert.equal(master.artifacts.length, 3)
    assert.deepEqual(
      master.artifacts.map(({ role }) => role),
      ['provider-original', 'final-audio', 'alignment'],
      'a master promoted straight off a provider job carries no normalization output',
    )
    for (const artifact of master.artifacts) {
      assert.equal(artifact.artifactId, artifactIds[artifact.role])
      assert.equal(artifact.sha256, bytes[artifact.role].sha256, `${artifact.role} must seal the stored bytes`)
      assert.equal(artifact.byteSize, bytes[artifact.role].byteSize)
    }
    assert.equal(master.durationMs, master.audioDurationMs)
    assert.equal(master.audioDurationMs, 4_000)
    assert.ok(Math.abs(master.videoDurationMs - master.audioDurationMs) <= 34)
    assert.equal(await client.v2SyntheticMasterArtifact.count({ where: { workspaceId, masterId } }), 3)

    // 6. Replaying the same idempotency key returns the same bytes, not a new
    //    master.
    const replayed = await api('POST', masterPath, { key: 'master-reuse-promote-1', payload: promotionBody })
    assert.equal(replayed.status, 200, JSON.stringify(replayed.payload))
    assert.equal(replayed.payload.data.replayed, true)
    assert.equal(JSON.stringify(replayed.payload.data.master), JSON.stringify(master))
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 1)

    // 7. The master and its lineage read back role by role.
    const read = await api('GET', `${masterPath}/${masterId}`)
    assert.equal(read.status, 200, JSON.stringify(read.payload))
    assert.equal(JSON.stringify(read.payload.data.master), JSON.stringify(master))

    const lineage = await api('GET', `${masterPath}/${masterId}/lineage`)
    assert.equal(lineage.status, 200, JSON.stringify(lineage.payload))
    const view = lineage.payload.data.lineage
    assert.equal(view.masterId, masterId)
    assert.equal(view.masterHash, master.masterHash)
    assert.deepEqual(Object.keys(view.artifacts).sort(), ['alignment', 'final-audio', 'provider-original'])
    for (const [role, artifact] of Object.entries(view.artifacts)) {
      assert.equal(artifact.artifactId, artifactIds[role])
      assert.equal(artifact.sha256, bytes[role].sha256)
    }
    assert.deepEqual(view.lineage, ['generation-1', 'generation-2'])
    assert.equal(view.provenance.providerJobId, providerJobId)
    assert.equal(view.provenance.providerJobRef, 'heygen_job_reuse')
    assert.equal(view.provenance.adapterId, 'heygen-v3')
    assert.equal(view.provenance.capability, 'audio-avatar')
    assert.equal(view.critic.decision, 'approved')
    // The lineage points at the persisted verdict, not at the provider job's
    // own critic hash — the master's approval is a document, not a claim.
    assert.equal(view.critic.reportId, criticVerdict.value.id)
    assert.equal(view.critic.reportHash, criticVerdict.value.reportHash)
    assert.notEqual(view.critic.reportHash, criticResultHash)

    // 8. Cataloguing the master's speech segments. F3.007 ships no HTTP route
    //    for this write, so the application service is driven directly against
    //    PostgreSQL — with the production alignment reader, which opens the
    //    stored alignment content-addressed. The word timings therefore come
    //    from the bytes on disk, never from this test.
    const catalogSegments = catalogSyntheticSpeechSegmentsService({
      masters: new PrismaSyntheticMasterAssetRepository(client),
      segments: new PrismaSyntheticSpeechSegmentRepository(client),
      profiles: new PrismaSyntheticProductionRepository(client),
      alignment: new StoredSyntheticMasterAlignmentReader({
        artifacts: new PrismaMediaArtifactRepository(client),
        storage: new LocalArtifactContentStorage(artifactRoot),
      }),
      createId: ({ blockId, occurrence }) => `master-reuse-segment-${blockId}-${occurrence}`,
    })
    const catalogued = await catalogSegments({
      workspaceId, masterId, actor,
      blocks: [
        { blockId: 'block-1', exactText: 'Primeira ideia do roteiro.', occurrence: 1 },
        { blockId: 'block-2', exactText: 'Segunda ideia bem forte.', occurrence: 1 },
      ],
    })
    assert.equal(catalogued.replayed, false)
    assert.equal(catalogued.segments.length, 2)

    // 9. The segments read back through /v1 with half-open, non-overlapping
    //    ranges and the identity the master sealed.
    const listed = await api('GET', `${masterPath}/${masterId}/speech-segments`)
    assert.equal(listed.status, 200, JSON.stringify(listed.payload))
    const segments = listed.payload.data.segments
    assert.equal(segments.length, 2)
    assert.deepEqual(segments.map(({ startMs, endMs }) => [startMs, endMs]), [[0, 1_900], [2_300, 3_900]])
    for (const [index, segment] of segments.entries()) {
      assert.ok(segment.endMs > segment.startMs, 'a segment range must be non-empty')
      assert.ok(segment.endMs <= master.audioDurationMs, 'a segment must stay inside the master timeline')
      if (index > 0) {
        assert.ok(
          segment.startMs >= segments[index - 1].endMs,
          'segment ranges must be half-open: the previous end may equal the next start, never exceed it',
        )
      }
      assert.equal(segment.masterId, masterId)
      assert.equal(segment.masterHash, master.masterHash)
      assert.equal(segment.projectId, projectId)
      assert.equal(segment.audioArtifactId, artifactIds['final-audio'])
      assert.equal(segment.videoArtifactId, artifactIds['provider-original'])
      assert.equal(segment.alignmentArtifactId, artifactIds.alignment)
      assert.equal(segment.identity.profileId, 'master-reuse-presenter')
      assert.equal(segment.identity.profileVersion, 1)
      assert.equal(segment.identity.voiceId, 'voice_reuse')
      assert.equal(segment.identity.avatarIdentityRef, 'avatar_reuse')
      assert.equal(segment.locale, 'pt-BR')
      assert.match(segment.segmentHash, /^[a-f0-9]{64}$/)
    }

    // ---------------------------------------------------------------------
    // Project B: the same workspace reuses project A's performance.
    // Three counters are read before and after the whole phase.
    // ---------------------------------------------------------------------
    const providerCallsBefore = providerCalls.length
    const providerJobsBefore = await client.v2ProviderJob.count({ where: { workspaceId } })
    const mastersBefore = await client.v2SyntheticMasterAsset.count({ where: { workspaceId } })
    const segmentsBefore = await client.v2SyntheticSpeechSegment.count({ where: { workspaceId } })
    const masterRowBefore = await client.v2SyntheticMasterAsset.findUniqueOrThrow({
      where: { id: masterId },
      select: { masterJson: true, masterHash: true, createdAt: true },
    })
    assert.equal(providerCallsBefore, 0, 'the fixture itself must not have called the provider')
    // Absolute baselines, so the deltas below are measured against known values
    // rather than against whatever happened to be there.
    assert.equal(providerJobsBefore, 1)
    assert.equal(mastersBefore, 1)
    assert.equal(segmentsBefore, 2)

    const createdB = await api('POST', '/v1/projects', {
      key: 'master-reuse-project-b',
      payload: { name: 'Projeto B', objective: 'awareness', format: '9:16' },
    })
    assert.equal(createdB.status, 201, JSON.stringify(createdB.payload))
    const projectBId = createdB.payload.data.project.id
    assert.notEqual(projectBId, projectId)

    // The workspace catalog answers project B with project A's segment.
    const searchPath = `/v1/workspaces/${workspaceId}/synthetic-speech-segments`
    const found = await api('GET', `${searchPath}?text=${encodeURIComponent('segunda ideia')}&locale=pt-BR&limit=10`)
    assert.equal(found.status, 200, JSON.stringify(found.payload))
    assert.equal(found.payload.data.segments.length, 1)
    const reused = found.payload.data.segments[0]
    assert.equal(reused.projectId, projectId, 'the reusable segment still belongs to project A')
    assert.equal(reused.masterId, masterId)
    assert.equal(reused.masterHash, master.masterHash)
    assert.equal(reused.audioArtifactId, artifactIds['final-audio'])
    assert.equal(reused.videoArtifactId, artifactIds['provider-original'])
    assert.deepEqual(
      reused,
      segments.find((segment) => segment.id === reused.id),
      'the workspace catalog and the master view must present the very same segment',
    )

    // Project B owns nothing of its own: scoping the same search to it is empty.
    const scopedToB = await api('GET', `${searchPath}?projectId=${projectBId}&limit=10`)
    assert.equal(scopedToB.status, 200, JSON.stringify(scopedToB.payload))
    assert.deepEqual(scopedToB.payload.data.segments, [])

    // Reading the reused master from project B's context: the master is
    // addressed by its own project, and the bytes come back identical.
    const reusedMaster = await api('GET', `${masterPath}/${masterId}`)
    assert.equal(reusedMaster.status, 200, JSON.stringify(reusedMaster.payload))
    assert.equal(JSON.stringify(reusedMaster.payload.data.master), JSON.stringify(master))

    // The three counters, after the whole project B phase.
    assert.equal(providerCalls.length, providerCallsBefore, `project B must cause zero provider calls, saw ${JSON.stringify(providerCalls)}`)
    assert.equal(providerCalls.length, 0)
    assert.equal(await client.v2ProviderJob.count({ where: { workspaceId } }), providerJobsBefore)
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), mastersBefore)
    assert.equal(await client.v2SyntheticSpeechSegment.count({ where: { workspaceId } }), segmentsBefore)

    // And the master itself was not touched by being reused.
    const masterRowAfter = await client.v2SyntheticMasterAsset.findUniqueOrThrow({
      where: { id: masterId },
      select: { masterJson: true, masterHash: true, createdAt: true },
    })
    assert.equal(masterRowAfter.masterHash, masterRowBefore.masterHash)
    assert.equal(masterRowAfter.masterJson, masterRowBefore.masterJson)
    assert.equal(masterRowAfter.createdAt.toISOString(), masterRowBefore.createdAt.toISOString())

    // ---------------------------------------------------------------------
    // Fail closed.
    // ---------------------------------------------------------------------
    // Another workspace sees neither the master nor the segments. The public
    // catalog answers ASSET_NOT_FOUND (422 in the error catalog, not 404) —
    // what matters is that no field of the master leaks into the body.
    const foreignRead = await api('GET', `${masterPath}/${masterId}`, { token: foreignIssued.token })
    assert.ok(foreignRead.status >= 400, JSON.stringify(foreignRead.payload))
    assert.equal(foreignRead.payload.error.code, 'ASSET_NOT_FOUND')
    assert.equal(JSON.stringify(foreignRead.payload).includes(master.masterHash), false)

    const foreignLineage = await api('GET', `${masterPath}/${masterId}/lineage`, { token: foreignIssued.token })
    assert.ok(foreignLineage.status >= 400, JSON.stringify(foreignLineage.payload))
    assert.equal(foreignLineage.payload.error.code, 'ASSET_NOT_FOUND')

    const foreignSearch = await api(
      'GET',
      `/v1/workspaces/${foreignWorkspaceId}/synthetic-speech-segments?text=${encodeURIComponent('segunda ideia')}&limit=10`,
      { token: foreignIssued.token },
    )
    assert.equal(foreignSearch.status, 200, JSON.stringify(foreignSearch.payload))
    assert.deepEqual(foreignSearch.payload.data.segments, [])

    // A foreign client cannot even address workspace A's catalog.
    const crossWorkspaceSearch = await api('GET', `${searchPath}?limit=10`, { token: foreignIssued.token })
    assert.ok(crossWorkspaceSearch.status >= 400, JSON.stringify(crossWorkspaceSearch.payload))
    assert.equal(crossWorkspaceSearch.payload.error.code, 'WORKSPACE_NOT_FOUND')

    // The same performance is never sealed twice, even under a fresh
    // idempotency key: the already sealed master comes back instead.
    const resealed = await api('POST', masterPath, { key: 'master-reuse-promote-2', payload: promotionBody })
    assert.equal(resealed.status, 200, JSON.stringify(resealed.payload))
    assert.equal(resealed.payload.data.replayed, true)
    assert.equal(resealed.payload.data.master.id, masterId)
    assert.equal(resealed.payload.data.master.masterHash, master.masterHash)
    assert.equal(await client.v2SyntheticMasterAsset.count({ where: { workspaceId } }), 1)
    assert.equal(await client.v2SyntheticMasterArtifact.count({ where: { workspaceId } }), 3)
    assert.equal(providerCalls.length, 0, 'nothing in this journey may reach the provider')
  } finally {
    if (server && server.exitCode === null) {
      await new Promise((resolve) => {
        const timeout = setTimeout(() => { server.kill('SIGKILL'); resolve() }, 10_000)
        timeout.unref?.()
        server.once('exit', () => { clearTimeout(timeout); resolve() })
        server.kill('SIGTERM')
      })
    }
    if (stub) await new Promise((resolve) => stub.close(resolve))
    await cleanup()
    await client.$disconnect()
    await rm(root, { recursive: true, force: true })
    if (process.env.APOLLO_MASTER_REUSE_DEBUG === '1') {
      console.error('server logs tail:', serverLogs.slice(-6_000))
    }
  }
})

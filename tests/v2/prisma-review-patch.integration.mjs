import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const execFileAsync = promisify(execFile)

function sha(value) { return createHash('sha256').update(typeof value === 'string' ? value : value).digest('hex') }

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close((error) => error ? reject(error) : resolve(address.port))
    })
  })
}

async function waitForServer(baseUrl, child) {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Next server exited with ${child.exitCode}`)
    try { if ((await fetch(`${baseUrl}/v1/health`)).ok) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Next server did not become ready')
}

test('T-FR-214 public review patch E2E persists valid, ambiguous, prohibited and real render-failure paths', {
  skip: process.env.APOLLO_REVIEW_PATCH_E2E !== '1' && 'set APOLLO_REVIEW_PATCH_E2E=1 and use an isolated V2 database',
}, async () => {
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { createExternalAuditContext, materializeActorAuditContext } = await import('../../src/v2/application/authenticate-api-client.ts')
  const { createProjectProxyRenderWorker } = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { PrismaApiClientRepository } = await import('../../src/v2/infrastructure/prisma/api-client-repository.ts')
  const { PrismaRenderElementMapRepository } = await import('../../src/v2/infrastructure/prisma/render-element-map-repository.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { buildRenderElementMap } = await import('../../src/v2/domain/review-system.ts')
  const { commitSealedChild, testActor } = await import('./helpers/pg-output-world.mjs')
  const { setProjectLutSelectionService } = await import('../../src/v2/application/project-lut-selections.ts')
  const { PrismaProjectLutSelectionRepository } = await import('../../src/v2/infrastructure/prisma/project-lut-selection-repository.ts')
  const { grantRendering, registerColorPipeline, registerMeasuredVideo, seedReviewProject } = await import('./helpers/review-edit-world.mjs')

  const client = new PrismaClient()
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `patch-e2e-workspace-${suffix}`
  const projectId = `patch-e2e-project-${suffix}`
  const versionId = `patch-e2e-version-${suffix}`
  const slug = `patch-e2e-${suffix}`
  const sourceArtifactId = `patch-e2e-source-${suffix}`
  const manifestId = `patch-e2e-manifest-${suffix}`
  const proxyArtifactId = `patch-e2e-proxy-${suffix}`
  const proxyManifestId = `patch-e2e-proxy-manifest-${suffix}`
  const root = path.join(os.tmpdir(), `apollo-patch-e2e-${suffix}`)
  const sourceKey = 'sources/master.mp4'
  const sourcePath = path.join(root, 'sources', 'master.mp4')
  const proxyKey = 'proxies/review.mp4'
  const proxyPath = path.join(root, 'proxies', 'review.mp4')
  const createdAt = '2026-07-22T01:30:00.000Z'
  let server
  let serverLogs = ''

  const cleanup = async () => {
    await rm(root, { recursive: true, force: true })
  }

  try {
    await cleanup()
    await mkdir(path.dirname(sourcePath), { recursive: true })
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourcePath,
    ], { windowsHide: true })
    const sourceBytes = await readFile(sourcePath)
    const sourceHash = sha(sourceBytes)
    // The proxy under review is its own artifact with its own bytes (a source and its proxy are never one project association).
    await mkdir(path.dirname(proxyPath), { recursive: true })
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', proxyPath,
    ], { windowsHide: true })
    const proxyBytes = await readFile(proxyPath)
    const proxyHash = sha(proxyBytes)
    const editPlan = {
      schemaVersion: 2, state: 'compiled', id: `edit-plan-${versionId}`, projectVersionId: versionId, storyPlanId: 'story-patch-e2e', treatmentPlanId: 'treatment-patch-e2e', directorRunId: 'director-patch-e2e', fps: 30, durationFrames: 150,
      sources: [{ id: sourceArtifactId, artifactId: sourceArtifactId, kind: 'video', durationSeconds: 5 }],
      videoTracks: [{ id: 'track-primary-video', kind: 'base-video', clips: [{ id: 'clip-1', sourceArtifactId, sourceInFrame: 0, sourceOutFrame: 150, timelineInFrame: 0, timelineOutFrame: 150, rate: 1 }] }],
      overlayTracks: [], subtitleTracks: [{ id: 'track-captions', kind: 'captions', presetId: 'clean-color', anchor: 'center', faceProtection: true, maxLines: 2, maxCharactersPerBlock: 32, cues: [{ id: 'cue-1', startFrame: 0, endFrame: 120, text: 'Legenda de validação', anchor: 'center' }] }], audioTracks: [], effectTracks: [], markers: [], transitions: [],
      protectedElements: [{ id: 'protected-clip-1', target: { type: 'clip', id: 'scene:clip-1' }, scope: { clipIds: ['clip-1'] }, createdBy: 'owner', allowExplicitUserOverride: false }],
      localeVariantRefs: [], formatVariantRefs: [], lineageRefs: [sourceArtifactId], movementPolicy: { automaticZoom: false, protectedOpeningFrames: 120 }, subtitlePolicy: { faceProtection: true, anchor: 'bottom', maxCharactersPerBlock: 32 },
      composition: { layout: 'landscape-inset', background: 'blurred-source', foregroundScale: 1, verticalPosition: 0.5, faceSafeFallback: [0.14, 0.08, 0.72, 0.57], subtitleSafeRegion: [0.08, 0.72, 0.84, 0.2] }, director: { plannerVersion: 'patch-e2e', decisions: [], assumptions: [] }, createdAt,
    }
    const editPlanId = `patch-e2e-edit-plan-${suffix}`
    await client.v2Workspace.create({ data: { id: workspaceId, slug: workspaceId, name: 'Patch E2E Workspace', status: 'active', createdAt: new Date(createdAt), updatedAt: new Date(createdAt) } })
    const issued = await createApiClientService({ repository: new PrismaApiClientRepository(client), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date(createdAt) })({ id: `patch-e2e-client-${suffix}`, workspaceId, name: 'Patch E2E Client', environment: 'production', scopes: ['projects:read', 'projects:write'] })
    const seedAuditContext = createExternalAuditContext({ clientId: issued.client.id, credentialId: issued.credential.id, workspaceId, environment: 'production' })
    const seedAuthenticationAudit = materializeActorAuditContext(Object.freeze({
      ...seedAuditContext,
      scopes: new Set(['projects:read', 'projects:write']),
      authenticationKind: 'bearer',
      clientKillSwitchEngaged: false,
      workspaceKillSwitchEngaged: false,
      clientAccessStatus: 'active',
      workspaceAccessStatus: 'active',
      auditContext: seedAuditContext,
    }))
    // The project is the sealed world the product builds: the creation Command, one explicit 9:16 output variant, the recording's
    // persisted ingest (artifact, manifest over the measured probe, link and sealed receipt) and a child Command that adopts that
    // receipt and plays the recording. The review-patch policy is the default one (the policies snapshot is born with the project).
    const actor = testActor({ workspaceId, clientId: issued.client.id, credentialId: issued.credential.id, environment: 'production',
      scopes: ['projects:read', 'projects:write', 'artifacts:rights'] })
    await seedReviewProject(client, { workspaceId, actor, prefix: 'patch-e2e', ids: { project: projectId },
      name: 'Patch E2E Project', aspectRatio: '9:16', status: 'reviewing-proxy', at: () => new Date(createdAt) })
    await registerMeasuredVideo(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, artifactKey: sourceKey, sha256: sourceHash,
      byteSize: sourceBytes.length, probe: { width: 640, height: 360, duration: 5, fps: 30 }, slug, manifestId,
      originalFileName: 'master.mp4', recipeId: 'patch-e2e-source', createdAt: new Date(createdAt) })
    await grantRendering(client, { workspaceId, artifactId: sourceArtifactId, actor, snapshotId: `patch-e2e-rights-${suffix}`, clock: () => new Date(createdAt) })
    const initialBundle = await commitSealedChild(client, { workspaceId, projectId, actor, suffix: `patch-e2e-${suffix}`, versionId, type: 'run-director',
      snapshotId: editPlanId, createdAt: new Date(Date.parse(createdAt) + 2_000).toISOString(), mutatePlan: () => editPlan, adopt: [sourceArtifactId] })
    // A proxy render needs an explicit LUT selection on its Version: the neutral one, taken by the production service (a child Command),
    // is the head the review, the proxy and the patches hang off.
    const noLut = await setProjectLutSelectionService({ repository: new PrismaProjectLutSelectionRepository(client),
      createId: (kind) => `patch-e2e-lut-${kind}-${suffix}`, createEventId: randomUUID, clock: () => new Date(Date.parse(createdAt) + 3_000) })({
      workspaceId, projectId, baseVersionId: initialBundle.version.id, baseHash: initialBundle.version.baseHash, selection: { mode: 'none' }, actor,
      idempotencyKey: `patch-e2e-lut-none-${suffix}`, reason: 'Keep this fixture colorimetrically neutral.' })
    const headVersionId = noLut.version.id
    const headEditPlanSnapshotId = noLut.version.snapshotRefs.editPlan
    const initialSequence = noLut.version.sequence
    await registerColorPipeline(client, { workspaceId, projectId, actor, artifactId: sourceArtifactId, manifestId, createdAt: new Date(createdAt) })
    await registerMeasuredVideo(client, { workspaceId, projectId, actor, artifactId: proxyArtifactId, artifactKey: proxyKey, sha256: proxyHash,
      byteSize: proxyBytes.length, probe: { width: 640, height: 360, duration: 5, fps: 30 }, slug: `${slug}-proxy`, manifestId: proxyManifestId,
      role: 'editing-proxy', originalFileName: 'review.mp4', recipeId: 'patch-e2e-proxy', createdAt: new Date(createdAt) })
    const seedOperationId = `patch-e2e-seed-operation-${suffix}`
    await client.v2PublicOperation.create({ data: { id: seedOperationId, workspaceId, projectId, clientId: issued.client.id, actorCredentialId: seedAuthenticationAudit.credentialId, actorEnvironment: seedAuthenticationAudit.environment, actorAuthenticationKind: seedAuthenticationAudit.authenticationKind, actorContextHash: seedAuthenticationAudit.contextHash, type: 'project-proxy-render', status: 'succeeded', phase: 'completed', targetType: 'media-artifact', targetId: proxyArtifactId, cancelable: false, retryable: false, attempt: 1, maxAttempts: 3, progressCompleted: 4, progressTotal: 4, progressUnit: 'render', resultJson: JSON.stringify({ artifactId: proxyArtifactId }), idempotencyKey: `patch-e2e-seed-${suffix}`, requestFingerprint: sha('seed-request'), createdAt: new Date(createdAt), updatedAt: new Date(createdAt), startedAt: new Date(createdAt), completedAt: new Date(createdAt) } })
    await client.v2ProjectProxyRenderOperation.create({ data: { operationId: seedOperationId, workspaceId, projectId, projectVersionId: headVersionId, editPlanSnapshotId: headEditPlanSnapshotId, sourceArtifactId, sourceManifestId: manifestId, colorPipelineBindingsJson: JSON.stringify([]), inputHash: sha('seed-input'), outputArtifactId: proxyArtifactId, outputManifestId: proxyManifestId, originalFileName: 'review.mp4', createdAt: new Date(createdAt) } })
    const map = buildRenderElementMap({ proxyHash, fps: 30, durationFrames: 150, canvas: { width: 540, height: 960 }, source: { width: 640, height: 360 }, clips: editPlan.videoTracks[0].clips, subtitleCues: editPlan.subtitleTracks[0].cues, composition: editPlan.composition })
    await new PrismaRenderElementMapRepository(client).persistOrReplay({ workspaceId, projectId, projectVersionId: headVersionId, proxyArtifactId, map, createdAt })

    const port = await getFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production', APOLLO_V2_ARTIFACT_ROOT: root, APOLLO_V2_RENDER_RETRY_BASE_MS: '1', APOLLO_V2_RENDER_RETRY_MAX_MS: '2' }, stdio: ['ignore', 'pipe', 'pipe'] })
    server.stdout.on('data', (chunk) => { serverLogs += String(chunk) })
    server.stderr.on('data', (chunk) => { serverLogs += String(chunk) })
    await waitForServer(baseUrl, server)
    const authorization = `Bearer ${issued.token}`
    const headers = (key) => ({ authorization, 'content-type': 'application/json', 'idempotency-key': key })
    const reviewUrl = `${baseUrl}/v1/projects/${projectId}/annotations`
    const screenshotRef = 'data:image/jpeg;base64,/9j/2Q=='
    const createAnnotation = async (body, key) => {
      const response = await fetch(reviewUrl, { method: 'POST', headers: headers(key), body: JSON.stringify(body) })
      const payload = await response.json()
      assert.equal(response.status, 201, JSON.stringify(payload))
      return payload.data.annotation
    }
    const baseAnnotation = { projectVersionId: headVersionId, proxyArtifactId, proxyHash, frame: 30, timeRangeMs: [1000, 1000], screenshotRef, scope: 'point', targetIds: ['subtitle:cue-1'], text: 'Reposicionar a legenda abaixo do rosto.' }
    const validAnnotation = await createAnnotation(baseAnnotation, `patch-valid-annotation-${suffix}`)
    const ambiguousAnnotation = await createAnnotation({ ...baseAnnotation, frame: 45, timeRangeMs: [1500, 1500], text: 'Melhorar este trecho.' }, `patch-ambiguous-annotation-${suffix}`)
    const prohibitedAnnotation = await createAnnotation({ ...baseAnnotation, frame: 30, timeRangeMs: [0, 5000], scope: 'scene', targetIds: ['scene:clip-1'], text: 'Remover este trecho.' }, `patch-prohibited-annotation-${suffix}`)
    const propose = async (annotationId, key) => {
      const response = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-proposals`, { method: 'POST', headers: headers(key), body: JSON.stringify({ annotationId }) })
      const payload = await response.json()
      assert.equal(response.status, 201, JSON.stringify(payload))
      return payload.data.proposal
    }
    const ready = await propose(validAnnotation.id, `patch-valid-proposal-${suffix}`)
    const ambiguous = await propose(ambiguousAnnotation.id, `patch-ambiguous-proposal-${suffix}`)
    const prohibited = await propose(prohibitedAnnotation.id, `patch-prohibited-proposal-${suffix}`)
    assert.equal(ready.status, 'ready')
    assert.equal('authenticationAudit' in ready, false)
    const storedReadyProposal = await client.v2ReviewPatchProposal.findUniqueOrThrow({
      where: { id: ready.id },
    })
    assert.equal(storedReadyProposal.actorClientId, issued.client.id)
    assert.equal(storedReadyProposal.actorCredentialId, issued.credential.id)
    assert.match(storedReadyProposal.actorContextHash, /^[a-f0-9]{64}$/)
    assert.equal(ambiguous.status, 'ambiguous')
    assert.equal(ambiguous.choices.length, 2)
    assert.equal(prohibited.status, 'prohibited')
    assert.equal(prohibited.gates.find((gate) => gate.gate === 'protected-elements').code, 'PROTECTED_TARGET')
    const applyResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-proposals/${ready.id}/apply`, { method: 'POST', headers: headers(`patch-valid-apply-${suffix}`), body: JSON.stringify({ confirmed: true }) })
    const applyPayload = await applyResponse.json()
    assert.equal(applyResponse.status, 201, `${JSON.stringify(applyPayload)}\n${serverLogs.slice(-4000)}`)
    assert.equal(applyPayload.data.version.sequence, initialSequence + 1)
    assert.equal(applyPayload.data.comparison.beforeVersionId, headVersionId)
    assert.equal(applyPayload.data.impact.commandType, 'apply-review-patch')
    assert.deepEqual(applyPayload.data.impact.affectedRanges, [{ startFrame: 30, endFrame: 31 }])
    assert.equal(applyPayload.data.invalidations.length, 1)
    assert.equal(applyPayload.data.invalidations[0].artifactId, proxyArtifactId)
    assert.equal(applyPayload.data.invalidations[0].impactHash, applyPayload.data.impact.impactHash)
    assert.equal(applyPayload.data.operation.status, 'queued')
    const persistedInvalidations = await client.v2CommandArtifactInvalidation.findMany({
      where: { workspaceId, projectId, resultVersionId: applyPayload.data.version.id },
    })
    assert.equal(persistedInvalidations.length, 1)
    assert.equal(persistedInvalidations[0].commandId, applyPayload.data.command.id)
    assert.deepEqual(JSON.parse(persistedInvalidations[0].affectedRangesJson), [{ startFrame: 30, endFrame: 31 }])
    // The worker's clock is read against the operation the API just queued (created at the server's real time).
    let workerNow = new Date(Date.now() + 1_000)
    const workerEnvironment = { ...process.env, APOLLO_V2_ARTIFACT_ROOT: root, APOLLO_V2_RENDER_RETRY_BASE_MS: '1', APOLLO_V2_RENDER_RETRY_MAX_MS: '2', APOLLO_PROTECTED_PAYLOAD_KEY_ID: 'patch-e2e-key-v1', APOLLO_PROTECTED_PAYLOAD_KEY: Buffer.alloc(32, 7).toString('base64url') }
    // The worker reports why an attempt failed through its diagnostic hook (the persisted failure is deliberately generic).
    const failureDiagnostics = []
    const worker = createProjectProxyRenderWorker(workerEnvironment, () => workerNow, ({ operationId, error }) => {
      failureDiagnostics.push(`${operationId}: ${error?.code} ${error?.message} ${JSON.stringify(error?.details ?? null)}`)
    })
    const validOutcome = await worker(`patch-e2e-worker-${suffix}`)
    const validOperationDiagnostic = await client.v2PublicOperation.findUnique({ where: { id: applyPayload.data.operation.id }, select: { status: true, phase: true, errorCode: true, errorMessage: true } })
    assert.equal(validOutcome.status, 'succeeded', JSON.stringify({ validOperationDiagnostic, failureDiagnostics }))
    const persistedReadyResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-proposals/${ready.id}`, { headers: { authorization } })
    const persistedReady = await persistedReadyResponse.json()
    assert.equal(persistedReady.data.proposal.render.status, 'succeeded')

    const currentReviewResponse = await fetch(reviewUrl, { headers: { authorization } })
    const currentReview = await currentReviewResponse.json()
    assert.equal(currentReviewResponse.status, 200, JSON.stringify(currentReview))
    const failureAnnotation = await createAnnotation({ projectVersionId: currentReview.data.session.projectVersionId, proxyArtifactId: currentReview.data.session.proxyArtifactId, proxyHash: currentReview.data.session.proxyHash, frame: 30, timeRangeMs: [1000, 1000], screenshotRef, scope: 'point', targetIds: ['subtitle:cue-1'], text: 'Reposicionar a legenda abaixo do rosto.' }, `patch-failure-annotation-${suffix}`)
    const failureProposal = await propose(failureAnnotation.id, `patch-failure-proposal-${suffix}`)
    assert.equal(failureProposal.status, 'ready')
    const failureApplyResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-proposals/${failureProposal.id}/apply`, { method: 'POST', headers: headers(`patch-failure-apply-${suffix}`), body: JSON.stringify({ confirmed: true }) })
    const failureApply = await failureApplyResponse.json()
    assert.equal(failureApplyResponse.status, 201, JSON.stringify(failureApply))
    // A real render failure with every identity intact: the renderer's FFmpeg is not an encoder. (A source whose bytes no longer match
    // their immutable identity is a different failure: a non-retryable persistence conflict.)
    const failingWorker = createProjectProxyRenderWorker({ ...workerEnvironment, FFMPEG_PATH: process.execPath }, () => workerNow, ({ operationId, error }) => {
      failureDiagnostics.push(`${operationId}: ${error?.code} ${error?.message} ${JSON.stringify(error?.details ?? null)}`)
    })
    const outcomes = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      workerNow = new Date(workerNow.getTime() + 10_000)
      outcomes.push(await failingWorker(`patch-e2e-worker-${suffix}`))
    }
    assert.equal(outcomes.at(-1)?.status, 'failed', JSON.stringify({ outcomes, failureDiagnostics }))
    const failedResponse = await fetch(`${baseUrl}/v1/projects/${projectId}/patch-proposals/${failureProposal.id}`, { headers: { authorization } })
    const failed = await failedResponse.json()
    assert.equal(failed.data.proposal.render.status, 'failed')
    assert.equal(failed.data.proposal.render.error.code, 'render_execution_failed')
    const state = await client.v2Project.findUnique({ where: { id: projectId }, include: { versions: true, editCommands: true, reviewPatchProposals: true } })
    assert.equal(state.versions.length, initialSequence + 2)
    assert.equal(state.editCommands.filter((command) => command.type === 'apply-review-patch').length, 2)
    assert.equal(state.reviewPatchProposals.length, 4)
  } finally {
    if (server && server.exitCode === null) {
      server.kill()
      await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))])
    }
    await cleanup()
    await client.$disconnect()
  }
})

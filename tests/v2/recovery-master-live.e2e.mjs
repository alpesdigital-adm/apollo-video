import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, isAbsolute, relative } from 'node:path'
import net from 'node:net'
import { promisify } from 'node:util'
import test from 'node:test'
import { PrismaClient, Prisma } from '../../generated/prisma-v2/index.js'

const execute = promisify(execFile)
const require = createRequire(import.meta.url)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
async function freePort() {
  return new Promise((done, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => done(port)) }) })
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt++) await delay(250)
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (let attempt = 0; attempt < 20 && child.exitCode === null && child.signalCode === null; attempt++) await delay(250)
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned server must terminate')
}
async function cleanup(prisma, workspaceId) {
  await prisma.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
  await prisma.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null } })
  const pending = Prisma.dmmf.datamodel.models.filter((model) => model.fields.some((field) => field.name === 'workspaceId')).map((model) => model.name[0].toLowerCase() + model.name.slice(1))
  for (let pass = 0; pending.length && pass < 16; pass++) {
    for (let index = pending.length - 1; index >= 0; index--) {
      try { await prisma[pending[index]].deleteMany({ where: { workspaceId } }); pending.splice(index, 1) }
      catch (error) { if (error.code !== 'P2003') throw error }
    }
  }
  assert.deepEqual(pending, [])
  await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
}

// This is deliberately a live, supervised proof. CI has no private owner
// master/provider secret or editorial reviewer. No seed transcript, fake speech
// provider, historical timestamps or automatic editorial approval is accepted.
test('W60 raw Imersão master uses live ingest, public commands and reconstructable export', {
  skip: process.env.APOLLO_RECOVERY_MASTER_LIVE !== '1', timeout: 1_800_000,
}, async () => {
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  assert.match(url.pathname, /e2e/)
  assert.match(url.searchParams.get('application_name'), /^apollo-video-e2e-/)
  for (const [name, limit] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]]) assert.ok(Number(url.searchParams.get(name)) >= 1 && Number(url.searchParams.get(name)) <= limit)
  assert.equal(process.env.GROQ_TRANSCRIBE_MODEL, 'whisper-large-v3-turbo')
  assert.equal(process.env.GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR, '4')
  assert.ok(Number(process.env.APOLLO_RECOVERY_COST_CAP_USD) > 0 && Number(process.env.APOLLO_RECOVERY_COST_CAP_USD) <= 2)
  const masterPath = process.env.APOLLO_RECOVERY_MASTER_PATH
  assert.ok(isAbsolute(masterPath))
  const bytes = await readFile(masterPath)
  assert.equal(bytes.length, 145_445_848)
  assert.equal(hash(bytes), '7ce34ba3acbb607eb1f47f419d73a8587a6f687bbfc0d9a1f115d7d9d771dccf')
  const evidenceDir = process.env.APOLLO_RECOVERY_EVIDENCE_ROOT
  assert.ok(isAbsolute(evidenceDir) && relative(process.cwd(), evidenceDir).startsWith('..'))
  await mkdir(evidenceDir, { recursive: true })
  const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
  const { probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
  const suffix = randomUUID().slice(0, 8)
  const workspaceId = `recovery-live-${suffix}`
  const root = await mkdtemp(join(tmpdir(), 'apollo-recovery-live-'))
  const artifactRoot = join(root, 'artifacts')
  const prisma = new PrismaClient()
  let server, logs = ''
  const evidence = { schemaVersion: 'recovery-master-live/v1', sourceCommit: process.env.GITHUB_SHA, runId: suffix, workspaceId, ownerPid: process.pid, masterSha256: hash(bytes), outcome: 'started', provenance: { master: 'owner-selected raw Imersão master', transcription: 'live Groq, no injected transport', persistence: 'isolated PostgreSQL', storage: 'local content-addressed bytes', productionDeployment: false, ownerAcceptance: false }, postflight: {} }
  const checkpoint = async () => writeFile(join(evidenceDir, 'recovery-live.json'), JSON.stringify(evidence, null, 2))
  const reviewedInput = async (name) => {
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      const body = await readFile(join(evidenceDir, name), 'utf8').catch((error) => { if (error.code === 'ENOENT') return null; throw error })
      if (body) return JSON.parse(body)
      await delay(500)
    }
    assert.fail(`Supervised editorial review required: ${name}`)
  }
  try {
    await mkdir(artifactRoot, { recursive: true })
    const probe = await probeVideo(masterPath)
    assert.ok(probe.duration > 100 && probe.duration < 110)
    evidence.sourceProbe = probe
    evidence.cost = { capUsd: 2, rateUsdPerHour: 0.04, maximumSpeechCalls: 2, maximumAudioSecondsPerCall: 110, upperEstimateUsd: 0.04 * 220 / 3600, rateSource: 'https://console.groq.com/docs/models', billingReceipt: 'unavailable' }
    await factory.createWorkspaceRepository().create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Imersão recovery live proof', status: 'active', createdAt: new Date().toISOString() }))
    const issued = await createApiClientService({ repository: factory.createApiClientRepository(), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })({ id: `recovery-client-${suffix}`, workspaceId, name: 'Isolated recovery actor', environment: 'production', scopes: ['projects:read', 'projects:write', 'projects:approve', 'media:write', 'artifacts:read', 'artifacts:write', 'artifacts:rights', 'operations:read', 'operations:cancel', 'operations:retry'] })
    const port = await freePort()
    const baseUrl = `http://127.0.0.1:${port}`
    const environment = { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', APOLLO_API_ENVIRONMENT: 'production', APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local', APOLLO_V2_RENDER_WORK_ROOT: join(root, 'work'), APOLLO_MEDIA_UPLOAD_BASE_URL: `${baseUrl}/`, APOLLO_MEDIA_UPLOAD_SIGNING_SECRET: `recovery-upload-${suffix}-with-at-least-32-bytes` }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    evidence.serverPid = server.pid
    server.stdout.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12000) }); server.stderr.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12000) })
    const deadline = Date.now() + 90_000
    while (true) {
      assert.equal(server.exitCode, null)
      try { if ((await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
      assert.ok(Date.now() < deadline, 'Server startup deadline exceeded'); await delay(250)
    }
    const headers = { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }
    const api = async (path, body, options = {}) => {
      const response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'idempotency-key': randomUUID() }), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), ...options })
      const payload = await response.json()
      if (!response.ok) {
        evidence.apiFailure = { path, status: response.status, error: payload.error }
        await checkpoint()
        const safeLogs = process.env.GROQ_API_KEY ? logs.replaceAll(process.env.GROQ_API_KEY, '[REDACTED_SECRET]') : logs
        await writeFile(join(evidenceDir, 'server-diagnostic.log'), safeLogs)
      }
      assert.ok(response.ok, `${path}: ${response.status}/${payload.error?.code}`)
      return payload.data
    }
    const created = await api('/v1/projects', { name: 'Boas-vindas Imersão — recuperação V2', objective: 'discovery', format: '16:9', locale: 'pt-BR' })
    const projectId = created.project.id
    evidence.projectId = projectId
    evidence.initialVersionId = created.version.id
    const lut = await api(`/v1/projects/${projectId}/lut-selection`, { baseVersionId: created.version.id, baseHash: created.version.baseHash, selection: { mode: 'none' }, reason: 'Preserve natural source colors for the owner recovery master.' })
    assert.equal(lut.selection.resolved.mode, 'none')
    evidence.lutSelectionId = lut.selection.id
    evidence.brief = { inputMode: 'media-only', objective: 'discovery', format: '16:9', editorialInstructionOrigin: 'AGENTS owner recovery requirements, persisted in removal Command and annotation before first Director Command', textualOwnerBrief: 'absent at media-only creation' }
    // The preserved archive filename ends in .mp4, but the unmodified master
    // has an ISO-BMFF ftyp qt signature. Declare its actual QuickTime container
    // for V2 inspection; keep exactly the owner-selected bytes and SHA.
    assert.equal(bytes.subarray(4, 12).toString('ascii'), 'ftypqt  ')
    evidence.uploadContainer = { archiveExtension: 'mp4', signature: 'ftyp qt', declaredExtension: 'mov', declaredMimeType: 'video/quicktime', sourceBytesChanged: false }
    const begun = await api('/v1/media/uploads', { projectId, fileName: 'imersao-master.mov', rightsConfirmed: true, kind: 'video', size: String(bytes.length), mimeType: 'video/quicktime', checksum: hash(bytes) })
    const { session } = await api(`/v1/media/uploads/${begun.upload.id}/session`, {})
    assert.equal(session.mode, 'multipart')
    for (let part = 1; part <= session.maxParts; part++) {
      const body = bytes.subarray((part - 1) * Number(session.partSize), Math.min(part * Number(session.partSize), bytes.length))
      const response = await fetch(session.partUrlTemplate.replace('{partNumber}', String(part)), { method: 'PUT', headers: session.requiredHeaders, body, signal: AbortSignal.timeout(60_000) })
      assert.equal(response.status, 201)
    }
    const completed = await api(`/v1/media/uploads/${begun.upload.id}/complete`, {})
    evidence.uploadId = begun.upload.id; evidence.ingestOperationId = completed.operation.id
    await checkpoint()
    const ingested = await factory.createMediaIngestWorker(environment)(`recovery-ingest-${suffix}`, AbortSignal.timeout(180_000))
    const operation = await api(`/v1/operations/${completed.operation.id}`)
    evidence.ingestResult = { worker: ingested, operation: operation.operation }
    const inspectedUpload = await prisma.v2MediaUpload.findUniqueOrThrow({ where: { id: begun.upload.id } })
    evidence.ingestInspection = { status: inspectedUpload.inspectionStatus, detectedMimeType: inspectedUpload.detectedMimeType, error: inspectedUpload.inspectionErrorJson ? JSON.parse(inspectedUpload.inspectionErrorJson) : null }
    await checkpoint()
    assert.equal(ingested?.status, 'succeeded', JSON.stringify(evidence.ingestResult))
    assert.equal(operation.operation.status, 'succeeded')
    const transcriptRow = await prisma.v2MediaTranscript.findFirstOrThrow({ where: { workspaceId, projectId }, orderBy: { createdAt: 'desc' } })
    const transcript = JSON.parse(transcriptRow.transcriptJson)
    assert.equal(transcript.provider, 'groq')
    assert.equal(transcript.model, 'whisper-large-v3-turbo')
    assert.ok(transcript.words.length > 200)
    const sourceArtifactId = transcriptRow.sourceArtifactId
    const sourceManifest = await prisma.v2MediaArtifactManifest.findFirstOrThrow({ where: { artifactId: sourceArtifactId }, orderBy: { createdAt: 'desc' } })
    const trustedProbe = await factory.createColorPipelineCompilationRepository().loadTrustedProbe({ workspaceId, projectId, sourceArtifactId, sourceManifestId: sourceManifest.id })
    assert.equal(trustedProbe?.detection.state, 'ready', 'Real master color metadata must be available before rendering')
    const colorMetadata = trustedProbe.detection.metadata
    const stage = (id, kind, enabled, provider, parameters) => ({ id, kind, version: 'v1', enabled, output: colorMetadata, implementation: { provider, version: 'v1', parameters, parametersHash: hash(Buffer.from(JSON.stringify(parameters))) } })
    const color = await api(`/v1/projects/${projectId}/color-pipeline-compilations`, { sourceArtifactId, sourceManifestId: sourceManifest.id, outputMetadata: colorMetadata, stages: [stage('technical-rec709', 'technical', true, 'ffmpeg-zscale', { mode: 'identity' }), stage('match-source', 'match', false, 'apollo-match', { mode: 'bypass' }), stage('creative-none', 'creative-lut', false, 'apollo-lut', { mode: 'none' }), stage('output-rec709', 'output', true, 'ffmpeg-zscale', { dither: true })] })
    evidence.colorCompilation = { id: color.compilation.id, sourceManifestId: sourceManifest.id, probeHash: trustedProbe.probeHash, pipelineHash: color.compilation.pipeline.pipelineHash }
    const rightsResponse = await fetch(`${baseUrl}/v1/artifacts/${sourceArtifactId}/rights`, { headers })
    assert.equal(rightsResponse.status, 200)
    await api(`/v1/artifacts/${sourceArtifactId}/rights`, { status: 'approved', owner: 'Owner-selected Imersão recovery input', license: 'owner-authorized-recovery', allowedUses: ['editorial-reuse', 'rendering', 'editing', 'distribution', 'transcription'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } }, { method: 'PUT', headers: { ...headers, 'if-match': rightsResponse.headers.get('etag') } })
    evidence.transcriptId = transcriptRow.id; evidence.transcriptHash = transcript.transcriptHash
    const beforeSubtitles = await api(`/v1/projects/${projectId}`)
    const subtitle = await api(`/v1/projects/${projectId}/subtitle-configuration`, { baseVersionId: beforeSubtitles.version.id, baseHash: beforeSubtitles.version.baseHash, variantId: '16:9', action: 'set', mode: 'manual', presetId: 'clean-color', presetVersion: 1, reason: 'Short readable subtitles in the bottom safe area, protecting the speaker face.' })
    evidence.subtitleConfiguration = subtitle
    await writeFile(join(evidenceDir, 'source-transcript.json'), JSON.stringify(transcript, null, 2))
    await checkpoint()
    console.log(JSON.stringify({ event: 'recovery-editorial-review-required', evidenceDir, transcriptId: transcriptRow.id }))
    const editorial = await reviewedInput('editorial-decisions.json')
    assert.equal(editorial.sourceSha256, evidence.masterSha256)
    assert.equal(editorial.transcriptHash, transcript.transcriptHash)
    assert.ok(Array.isArray(editorial.exclusionOverrides) && editorial.exclusionOverrides.length >= 2)
    const workspace = await api(`/v1/projects/${projectId}`)
    // The critic correctly rejects the uncut dated master. Apply reviewed
    // removals before requesting direction; never relax that gate for the test.
    const cut = await api(`/v1/projects/${projectId}/commands`, { type: 'remove-spoken-content', baseVersionId: workspace.version.id, baseHash: workspace.version.baseHash, sourceTranscriptId: transcriptRow.id, rules: editorial.rules, exclusionOverrides: editorial.exclusionOverrides, reason: editorial.instruction })
    evidence.cutCommandId = cut.command.id; evidence.exclusions = cut.editorial.exclusions
    const renderProxy = factory.createProjectProxyRenderWorker(environment, () => new Date(), ({ operationId, error }) => {
      evidence.proxyFailure = { operationId, code: error.code, message: error.message, details: error.details }
    })
    const initialProxy = await renderProxy(`recovery-cut-proxy-${suffix}`, { signal: AbortSignal.timeout(180_000) })
    evidence.cutProxyResult = initialProxy
    await checkpoint()
    assert.equal(initialProxy?.status, 'succeeded')
    const review = await api(`/v1/projects/${projectId}/annotations?projectVersionId=${cut.version.id}`)
    const initialArtifact = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: review.session.proxyArtifactId } })
    const screenshotPath = join(evidenceDir, 'initial-review-frame.jpg')
    await execute(require('ffmpeg-static'), ['-hide_banner', '-v', 'error', '-y', '-i', join(artifactRoot, ...initialArtifact.artifactKey.split('/')), '-frames:v', '1', '-vf', 'scale=640:-1', screenshotPath], { windowsHide: true, timeout: 30_000 })
    const screenshotRef = `data:image/jpeg;base64,${(await readFile(screenshotPath)).toString('base64')}`
    const annotation = await api(`/v1/projects/${projectId}/annotations`, { projectVersionId: cut.version.id, proxyArtifactId: review.session.proxyArtifactId, proxyHash: review.session.proxyHash, frame: 0, timeRangeMs: [0, 0], scope: 'point', targetIds: [], screenshotRef, text: editorial.instruction })
    evidence.annotationId = annotation.annotation.id
    const direction = await api(`/v1/projects/${projectId}/commands`, { type: 'run-director', baseVersionId: cut.version.id, baseHash: cut.version.baseHash, reason: editorial.instruction })
    assert.equal(direction.directorRun.editPlan.automaticZoom, false)
    evidence.directorRunId = direction.directorRun.id; evidence.direction = direction.directorRun
    assert.equal((await renderProxy(`recovery-final-proxy-${suffix}`, { signal: AbortSignal.timeout(180_000) }))?.status, 'succeeded')
    // Apply a correction observed in the actual first proxy through the public
    // annotation -> proposal -> confirmed Command chain, not a detached note.
    const correction = editorial.captionCorrection
    assert.ok(correction?.matchText && correction.replacementText && correction.reason, 'Reviewed caption correction is required')
    const directedVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: direction.version.id }, include: { editPlanSnapshot: true } })
    const directedPlan = JSON.parse(directedVersion.editPlanSnapshot.contentJson)
    const cue = directedPlan.subtitleTracks.flatMap(track => track.cues).find(item => item.text.includes(correction.matchText))
    assert.ok(cue, 'Reviewed correction must target a real rendered cue')
    const directedSession = await api(`/v1/projects/${projectId}/annotations?projectVersionId=${direction.version.id}`)
    const directedProxy = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: directedSession.session.proxyArtifactId } })
    const correctionFrame = cue.startFrame + 1
    const correctionTimeMs = Math.round(correctionFrame / directedPlan.fps * 1000)
    const correctionFramePath = join(evidenceDir, 'caption-before.jpg')
    await execute(require('ffmpeg-static'), ['-v', 'error', '-y', '-ss', String(correctionFrame / directedPlan.fps), '-i', join(artifactRoot, ...directedProxy.artifactKey.split('/')), '-frames:v', '1', '-vf', 'scale=640:-1', correctionFramePath], { windowsHide: true, timeout: 30_000 })
    const correctedText = cue.text.replace(correction.matchText, correction.replacementText)
    const correctionAnnotation = await api(`/v1/projects/${projectId}/annotations`, { projectVersionId: direction.version.id, proxyArtifactId: directedProxy.id, proxyHash: directedProxy.sha256, frame: correctionFrame, timeRangeMs: [correctionTimeMs, correctionTimeMs], scope: 'point', targetIds: [`subtitle:${cue.id}`], screenshotRef: `data:image/jpeg;base64,${(await readFile(correctionFramePath)).toString('base64')}`, text: `Corrigir a legenda para "${correctedText}".` })
    const proposal = await api(`/v1/projects/${projectId}/patch-proposals`, { annotationId: correctionAnnotation.annotation.id })
    assert.equal(proposal.proposal.status, 'ready')
    const applied = await api(`/v1/projects/${projectId}/patch-proposals/${proposal.proposal.id}/apply`, { confirmed: true })
    assert.equal(applied.command.type, 'apply-review-patch')
    assert.equal(applied.comparison.beforeVersionId, direction.version.id)
    evidence.captionCorrection = { annotationId: correctionAnnotation.annotation.id, proposalId: proposal.proposal.id, commandId: applied.command.id, beforeVersionId: direction.version.id, resultVersionId: applied.version.id, targetId: `subtitle:${cue.id}`, beforeText: cue.text, correctedText, reason: correction.reason, frame: correctionFrame }
    const exportVersion = applied.version
    const patchResult = await renderProxy(`recovery-caption-proxy-${suffix}`, { signal: AbortSignal.timeout(180_000) })
    evidence.captionProxyResult = patchResult
    await checkpoint()
    assert.equal(patchResult?.status, 'succeeded', JSON.stringify(evidence.proxyFailure))
    const patchedVersion = await prisma.v2ProjectVersion.findUniqueOrThrow({ where: { id: exportVersion.id }, include: { editPlanSnapshot: true } })
    const patchedPlan = JSON.parse(patchedVersion.editPlanSnapshot.contentJson)
    assert.equal(patchedPlan.subtitleTracks.flatMap(track => track.cues).find(item => item.id === cue.id)?.text, correctedText)
    await writeFile(join(evidenceDir, 'final-edit-plan.json'), JSON.stringify(patchedPlan, null, 2))
    const proxyReview = await api(`/v1/projects/${projectId}/proxy-reviews?projectVersionId=${exportVersion.id}`)
    assert.notEqual(proxyReview.review.status, 'blocked')
    const proxyArtifact = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: proxyReview.review.proxyArtifactId } })
    const previewPath = join(artifactRoot, ...proxyArtifact.artifactKey.split('/'))
    await copyFile(previewPath, join(evidenceDir, 'review-proxy.mp4'))
    await execute(require('ffmpeg-static'), ['-hide_banner', '-v', 'error', '-y', '-i', previewPath, '-vf', 'fps=1,scale=640:-1', join(evidenceDir, 'proxy-frame-%03d.jpg')], { windowsHide: true, timeout: 180_000 })
    evidence.proxyReview = proxyReview.review
    await checkpoint()
    console.log(JSON.stringify({ event: 'recovery-proxy-review-required', evidenceDir, proxyHash: proxyArtifact.sha256 }))
    const proxyVisual = await reviewedInput('proxy-visual-review.json')
    assert.equal(proxyVisual.artifactSha256, proxyArtifact.sha256)
    for (const gate of ['continuity', 'faceSafeSubtitles', 'naturalFraming', 'justifiedTransitions']) assert.equal(proxyVisual[gate], true, gate)
    evidence.proxyVisualReview = proxyVisual
    if (proxyReview.review.status === 'warning-ack-required') await api(`/v1/projects/${projectId}/proxy-reviews`, { action: 'acknowledge-warnings', proxyReviewId: proxyReview.review.id, projectVersionId: exportVersion.id, baseRevision: proxyReview.review.reviewHash, expectedRevision: proxyReview.review.revision })
    const readyReview = await api(`/v1/projects/${projectId}/proxy-reviews?projectVersionId=${exportVersion.id}`)
    assert.equal(readyReview.review.status, 'ready-for-final')
    assert.equal(readyReview.review.finalAllowed, true)
    const exported = await api(`/v1/projects/${projectId}/exports`, { projectVersionId: exportVersion.id, projectVersionHash: exportVersion.baseHash, format: '16:9', approval: { approved: true, note: 'Supervised local technical export; not owner acceptance or production deployment.' } })
    const finalResult = await factory.createProjectFinalExportWorker(environment)(`recovery-final-${suffix}`, AbortSignal.timeout(420_000))
    evidence.finalWorkerResult = finalResult
    evidence.finalOperation = (await api(`/v1/operations/${exported.operation.id}`)).operation
    await checkpoint()
    assert.equal(finalResult?.status, 'succeeded', JSON.stringify(evidence.finalOperation))
    const finalOp = await prisma.v2ProjectFinalExportOperation.findUniqueOrThrow({ where: { operationId: exported.operation.id } })
    const finalArtifact = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: finalOp.outputArtifactId } })
    const finalPath = join(artifactRoot, ...finalArtifact.artifactKey.split('/'))
    const finalBytes = await readFile(finalPath)
    assert.equal(hash(finalBytes), finalArtifact.sha256)
    await copyFile(finalPath, join(evidenceDir, 'final.mp4'))
    evidence.final = { artifactId: finalArtifact.id, operationId: exported.operation.id, sha256: finalArtifact.sha256, byteSize: finalBytes.length, probe: await probeVideo(finalPath) }
    const ffmpeg = require('ffmpeg-static')
    await execute(ffmpeg, ['-hide_banner', '-v', 'error', '-i', finalPath, '-f', 'null', '-'], { windowsHide: true, timeout: 180_000 })
    await execute(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', finalPath, '-vf', 'fps=1,scale=640:-1', join(evidenceDir, 'frame-%03d.jpg')], { windowsHide: true, timeout: 180_000 })
    const audioPath = join(evidenceDir, 'final-speech.flac')
    await execute(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-i', finalPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'flac', audioPath], { windowsHide: true, timeout: 180_000 })
    const { createMediaTranscriberFromEnvironment } = await import('../../src/v2/infrastructure/media/groq-media-transcriber.ts')
    const finalTranscript = await createMediaTranscriberFromEnvironment(environment).transcribe({ audioPath, language: 'pt-BR', signal: AbortSignal.timeout(180_000) })
    const normalized = finalTranscript.text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
    assert.equal(/31 de janeiro|trinta e um de janeiro|1 de fevereiro|primeiro de fevereiro|dois dias|2 dias/.test(normalized), false)
    await writeFile(join(evidenceDir, 'final-transcript.json'), JSON.stringify(finalTranscript, null, 2))
    evidence.final.forbiddenSpeechAbsent = true
    await checkpoint()
    console.log(JSON.stringify({ event: 'recovery-visual-review-required', evidenceDir, final: evidence.final }))
    const visual = await reviewedInput('visual-review.json')
    assert.equal(visual.artifactSha256, finalArtifact.sha256)
    for (const gate of ['continuity', 'faceSafeSubtitles', 'naturalFraming', 'justifiedTransitions', 'wholeOutputReviewed']) assert.equal(visual[gate], true, gate)
    evidence.visualReview = visual
    const manifestRow = await prisma.v2MediaArtifactManifest.findFirstOrThrow({ where: { artifactId: finalArtifact.id } })
    evidence.final.manifestId = manifestRow.id; evidence.final.manifestHash = manifestRow.manifestHash
    const manifest = JSON.parse(manifestRow.manifestJson)
    assert.equal(manifest.schemaVersion, 'media-artifact-manifest/v4')
    assert.equal(manifest.artifact.sha256, finalArtifact.sha256)
    assert.equal(manifest.artifact.byteSize, finalBytes.length)
    assert.equal(manifest.recipe.id, 'editorial-final')
    assert.ok(manifest.recipe.parametersRef)
    assert.ok(manifest.sources.length > 0)
    const input = await factory.createProtectedRenderInputStore().read(workspaceId, manifest.renderInput.ref, manifest.renderInput.inputHash)
    assert.ok(input)
    assert.equal(input.inputHash, manifest.renderInput.inputHash)
    assert.ok(input.assets.some((asset) => asset.artifactId === sourceArtifactId))
    const reconstruction = await api(`/v1/artifacts/${finalArtifact.id}/reconstruction-preflight/${manifestRow.id}`, undefined, { method: 'POST' })
    evidence.final.reconstruction = reconstruction
    await writeFile(join(evidenceDir, 'final-manifest.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(evidenceDir, 'final-render-input.json'), JSON.stringify(input, null, 2))
    await checkpoint()
    assert.equal(reconstruction.payloadAuthenticated, true)
    assert.equal(reconstruction.eligible, true, JSON.stringify(reconstruction.issues))
    assert.equal(reconstruction.inputHash, input.inputHash)
    evidence.final.reconstruction = reconstruction
    await writeFile(join(evidenceDir, 'final-manifest.json'), JSON.stringify(manifest, null, 2))
    await writeFile(join(evidenceDir, 'final-render-input.json'), JSON.stringify(input, null, 2))
    evidence.outcome = 'passed'
  } catch (error) {
    evidence.outcome = 'failed'; evidence.error = { name: error.name, message: error.message }
    // Never write the environment, auth headers, cookies or provider keys.
    throw error
  } finally {
    await stop(server)
    evidence.postflight.serverStopped = !server || server.exitCode !== null || server.signalCode !== null
    await cleanup(prisma, workspaceId)
    await disconnectV2PostgresClient()
    await prisma.$disconnect()
    await rm(root, { recursive: true, force: true })
    evidence.postflight.ownedWorkspaceRemoved = true; evidence.postflight.scratchRemoved = true
    evidence.serverLogsAvailable = logs.length > 0
    await checkpoint()
  }
})

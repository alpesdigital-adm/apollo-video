import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { PrismaClient, Prisma } from '../../generated/prisma-v2/index.js'
import { createImageFixtureBytes, seedAnalyzedImageLibrary } from './helpers/library-image-proof.mjs'
import { proveLibraryBrowser } from './helpers/library-browser-proof.mjs'
import { openJourneyObjectStore, closeJourneyObjectStore } from './helpers/journey-object-storage.mjs'

const execute = promisify(execFile); const require = createRequire(import.meta.url)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
function assertIsolatedDatabase() {
  assert.ok(process.env.V2_DATABASE_URL)
  const url = new URL(process.env.V2_DATABASE_URL)
  assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname))
  assert.match(url.pathname.slice(1), /(?:^|_)e2e(?:_|$)/)
  assert.match(url.searchParams.get('application_name') ?? '', /^apollo-video-e2e-[a-z0-9-]+$/)
  for (const [name, maximum] of [['connection_limit', 5], ['pool_timeout', 10], ['connect_timeout', 10]]) {
    const value = Number(url.searchParams.get(name)); assert.ok(Number.isInteger(value) && value >= 1 && value <= maximum)
  }
}
async function freePort() {
  return new Promise((done, reject) => { const socket = net.createServer(); socket.once('error', reject); socket.listen(0, '127.0.0.1', () => { const { port } = socket.address(); socket.close(() => done(port)) }) })
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const wait = () => new Promise((done) => { const timer = setTimeout(done, 5000); child.once('exit', () => { clearTimeout(timer); done() }) })
  await wait()
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await wait() }
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned Next server must terminate')
}
async function cleanupWorkspace(prisma, workspaceId) {
  const identities = await prisma.v2WorkspaceMember.findMany({ where: { workspaceId }, select: { identityId: true } })
  await prisma.v2Project.updateMany({ where: { workspaceId }, data: { currentVersionId: null } })
  await prisma.v2MediaArtifact.updateMany({ where: { workspaceId }, data: { currentRightsSnapshotId: null } })
  // Only this UUID workspace, with FK-aware retries. No reset/drop/shared rows.
  const pending = Prisma.dmmf.datamodel.models.filter((model) => model.fields.some((field) => field.name === 'workspaceId')).map((model) => model.name[0].toLowerCase() + model.name.slice(1))
  for (let pass = 0; pending.length && pass < 12; pass += 1) {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      try { await prisma[pending[index]].deleteMany({ where: { workspaceId } }); pending.splice(index, 1) }
      catch (error) { if (error.code !== 'P2003') throw error }
    }
  }
  assert.deepEqual(pending, [], 'Owned workspace cleanup left referenced rows')
  await prisma.v2Workspace.deleteMany({ where: { id: workspaceId } })
  for (const identity of identities) await prisma.v2HumanIdentity.deleteMany({ where: { id: identity.identityId, memberships: { none: {} } } })
}

test(process.env.APOLLO_W51_S3_ONLY === '1' ? 'W51 transfer uses real HTTP, PostgreSQL and versioned S3 bytes' : 'W50 library uses real HTTP, durable ingest, PostgreSQL, media bytes and Chromium', { skip: process.env.APOLLO_LIBRARY_JOURNEY_E2E !== '1', timeout: 480_000 }, async () => {
  assertIsolatedDatabase()
  const { createUiPasswordHash } = await import('../../src/v2/infrastructure/security/ui-session.ts')
  const { disconnectV2PostgresClient } = await import('../../src/v2/infrastructure/prisma-postgres/client.ts')
  const { LocalArtifactSourceMaterializer } = await import('../../src/v2/infrastructure/media/local-media-upload-storage.ts')
  const { calculateFileSha256 } = await import('../../src/v2/infrastructure/media/local-artifact-manifest.ts')
  const { probeAudioDurationSeconds, probeVideo } = await import('../../src/v2/infrastructure/media/video-probe.ts')
  const factory = await import('../../src/v2/infrastructure/repository-factory.ts')
  const { createWorkspace } = await import('../../src/v2/domain/workspace.ts')
  const { createApiClientService } = await import('../../src/v2/application/create-api-client.ts')
  const { nodeApiCredentialCrypto } = await import('../../src/v2/infrastructure/security/api-credential.ts')
  const suffix = randomUUID().slice(0, 8); const workspaceId = `library-journey-${suffix}`; const clientId = `library-client-${suffix}`
  const root = await mkdtemp(join(tmpdir(), 'apollo-library-journey-')); const artifactRoot = join(root, 'artifacts')
  const evidenceDir = resolve(process.env.APOLLO_LIBRARY_EVIDENCE_ROOT ?? join(root, 'evidence'))
  const fromRepo = relative(process.cwd(), evidenceDir); assert.ok(isAbsolute(evidenceDir) && (fromRepo.startsWith('..') || isAbsolute(fromRepo)))
  await mkdir(evidenceDir, { recursive: true }); await mkdir(artifactRoot, { recursive: true })
  const prisma = new PrismaClient(); let server, otherWorkspace, objectStore, logs = ''
  const evidence = { schemaVersion: 'library-journey/v1', sourceCommit: process.env.GITHUB_SHA ?? null, ciRunId: process.env.GITHUB_RUN_ID ?? null, runId: suffix, ownerPid: process.pid, workspaceId, outcome: 'started', checks: [], postflight: {} }
  try {
    await factory.createWorkspaceRepository().create(createWorkspace({ id: workspaceId, slug: workspaceId, name: 'Controlled library journey', status: 'active', createdAt: new Date().toISOString() }))
    const issued = await createApiClientService({ repository: factory.createApiClientRepository(), credentialCrypto: nodeApiCredentialCrypto, clock: () => new Date() })({ id: clientId, workspaceId, name: 'Controlled library actor', environment: 'production', scopes: ['projects:read', 'projects:write', 'media:write', 'artifacts:read', 'artifacts:write', 'artifacts:rights', 'operations:read', 'operations:cancel', 'operations:retry'] })
    const port = await freePort(); const baseUrl = `http://127.0.0.1:${port}`; const username = `library-${suffix}`; const password = `Library-${suffix}-controlled-password`
    const s3Only = process.env.APOLLO_W51_S3_ONLY === '1'
    if (s3Only) {
      assert.equal(process.env.APOLLO_V2_ARTIFACT_STORAGE_DRIVER, 's3')
      objectStore = await openJourneyObjectStore()
    }
    const environment = { ...process.env, NODE_ENV: 'production', __NEXT_PROCESSED_ENV: 'true', NEXT_TELEMETRY_DISABLED: '1', APOLLO_API_ENVIRONMENT: 'production', APOLLO_AUTH_MODE: 'bootstrap', APOLLO_ALLOW_BOOTSTRAP_AUTH: 'true', APOLLO_UI_BOOTSTRAP_ROLE: 'operator', APOLLO_UI_USERNAME: username, APOLLO_UI_PASSWORD_HASH: createUiPasswordHash(password, `library-salt-${suffix}`), APOLLO_UI_SESSION_SECRET: `library-${suffix}-session-with-32-bytes-minimum`, APOLLO_UI_API_CLIENT_ID: clientId, APOLLO_V2_ARTIFACT_ROOT: artifactRoot, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: s3Only ? 's3' : 'local', APOLLO_V2_RENDER_WORK_ROOT: join(root, 'work'), APOLLO_MEDIA_UPLOAD_BASE_URL: `${baseUrl}/`, APOLLO_MEDIA_UPLOAD_SIGNING_SECRET: `library-upload-${suffix}-with-at-least-32-bytes`, APOLLO_MEDIA_DOWNLOAD_BASE_URL: `${baseUrl}/`, APOLLO_MEDIA_DOWNLOAD_SIGNING_SECRET: `library-download-${suffix}-with-at-least-32-bytes` }
    server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], { cwd: process.cwd(), env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    evidence.serverPid = server.pid
    server.stdout.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12000) }); server.stderr.on('data', (chunk) => { logs = (logs + String(chunk)).slice(-12000) })
    const deadline = Date.now() + 90_000
    while (true) {
      assert.equal(server.exitCode, null, 'Owned Next server exited during startup')
      try { if ((await fetch(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(1000) })).ok) break } catch {}
      assert.ok(Date.now() < deadline, 'Owned Next startup deadline exceeded'); await new Promise((done) => setTimeout(done, 250))
    }
    const headers = { authorization: `Bearer ${issued.token}`, 'content-type': 'application/json' }
    async function api(path, body, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'idempotency-key': randomUUID() }), ...options.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000), ...options })
      const payload = await response.json(); assert.ok(response.ok, `${path} returned ${response.status}/${payload.error?.code}`); return payload.data
    }
    const project = await api('/v1/projects', { name: 'Library controlled target', objective: 'discovery', format: '16:9', locale: 'pt-BR' })
    const projectId = project.project.id
    async function grant(artifactId, overrides = {}) {
      const read = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/rights`, { headers, signal: AbortSignal.timeout(10000) }); assert.equal(read.status, 200)
      const response = await fetch(`${baseUrl}/v1/artifacts/${artifactId}/rights`, { method: 'PUT', headers: { ...headers, 'if-match': read.headers.get('etag') }, body: JSON.stringify({ status: 'approved', owner: 'Controlled fixture owner', license: 'owned-test-fixture', allowedUses: ['editorial-reuse', 'rendering', 'editing', 'distribution', 'transcription'], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] }, ...overrides }), signal: AbortSignal.timeout(10000) })
      assert.ok(response.ok, `Rights grant failed: ${response.status}`)
    }
    // All three sources use real HTTP uploads and the durable ingest worker.
    // Speech-provider transport is controlled; it does not prove live transcription.
    const videoPath = join(root, 'master.mp4')
    await execute(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath], { windowsHide: true, timeout: 30_000 })
    const videoBytes = await readFile(videoPath); const sourceSha256 = sha256(videoBytes)
    if (s3Only) {
      const begun = await api('/v1/media/uploads', { projectId, fileName: 'w51-s3-master.mp4', rightsConfirmed: true,
        kind: 'video', size: String(videoBytes.length), mimeType: 'video/mp4', checksum: sourceSha256 })
      const session = await api(`/v1/media/uploads/${begun.upload.id}/session`, {})
      assert.equal((await fetch(session.session.uploadUrl, { method: 'PUT', headers: session.session.requiredHeaders, body: videoBytes })).status, 201)
      const completed = await api(`/v1/media/uploads/${begun.upload.id}/complete`, {})
      const originalFetch = globalThis.fetch
      try {
        globalThis.fetch = async (url, options) => String(url) === 'https://api.groq.com/openai/v1/audio/transcriptions'
          ? Response.json({ text: 'Material controlado.', words: [{ word: 'Material', start: 0, end: 1 }, { word: 'controlado.', start: 1, end: 3 }], segments: [{ id: 0, text: 'Material controlado.', start: 0, end: 3 }] })
          : originalFetch(url, options)
        const worked = await factory.createMediaIngestWorker({ ...environment, GROQ_API_KEY: 'controlled-test-key-not-live-000000', GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR: '7200' })(`w51-s3-worker-${suffix}`, AbortSignal.timeout(60_000))
        assert.equal(worked?.status, 'succeeded')
      } finally { globalThis.fetch = originalFetch }
      const link = await prisma.v2ProjectMediaAsset.findFirstOrThrow({ where: { workspaceId, uploadId: begun.upload.id, role: 'source-master' } })
      const stored = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: link.artifactId } })
      assert.equal(stored.sha256, sourceSha256)
      assert.equal(await stat(join(artifactRoot, ...stored.artifactKey.split('/'))).then(() => true, () => false), false,
        'S3 master must not be silently read from local artifact storage')
      const head = await objectStore.client.send(new objectStore.aws.HeadObjectCommand({ Bucket: objectStore.bucket, Key: stored.artifactKey, ChecksumMode: 'ENABLED' }))
      assert.ok(head.VersionId && head.VersionId !== 'null')
      assert.equal(head.ContentLength, videoBytes.length)
      assert.ok(head.ChecksumSHA256 === Buffer.from(sourceSha256, 'hex').toString('base64') || head.Metadata?.['apollo-sha256'] === sourceSha256)
      await grant(stored.id)
      const download = await api(`/v1/artifacts/${stored.id}/download-grants`, { ttlSeconds: 30 })
      const full = await fetch(download.downloadUrl)
      assert.equal(full.status, 200)
      assert.equal(sha256(Buffer.from(await full.arrayBuffer())), sourceSha256)
      const range = await fetch(download.downloadUrl, { headers: { range: 'bytes=2-17' } })
      assert.equal(range.status, 206)
      assert.deepEqual(Buffer.from(await range.arrayBuffer()), videoBytes.subarray(2, 18))
      await api(`/v1/media/download-grants/${download.grant.id}/revoke`, {})
      assert.equal((await fetch(download.downloadUrl)).ok, false)
      assert.equal((await fetch(download.downloadUrl, { headers: { range: 'bytes=2-17' } })).ok, false)
      const expiring = await api(`/v1/artifacts/${stored.id}/download-grants`, { ttlSeconds: 30 })
      assert.equal((await fetch(expiring.downloadUrl)).status, 200)
      await new Promise((done) => setTimeout(done, 31_000))
      assert.equal((await fetch(expiring.downloadUrl)).ok, false)
      assert.equal((await fetch(expiring.downloadUrl, { headers: { range: 'bytes=2-17' } })).ok, false)
      evidence.s3Transfer = { artifactId: stored.id, artifactKey: stored.artifactKey, versionId: head.VersionId,
        byteSize: videoBytes.length, sha256: sourceSha256, uploadId: begun.upload.id, ingestOperationId: completed.operation.id,
        fullStatus: 200, rangeStatus: 206, revoked: true, expiredAfterSeconds: 31, liveProvider: false }
      evidence.outcome = 'passed'
      return
    }
    const uploads = []
    async function upload(bytes, kind, mimeType, fileName, approved = true) {
      const begun = await api('/v1/media/uploads', { projectId, fileName, rightsConfirmed: true, kind, size: String(bytes.length), mimeType, checksum: sha256(bytes) })
      const session = await api(`/v1/media/uploads/${begun.upload.id}/session`, {})
      const transferred = await fetch(session.session.uploadUrl, { method: 'PUT', headers: session.session.requiredHeaders, body: bytes, signal: AbortSignal.timeout(10000) }); assert.equal(transferred.status, 201)
      const completed = await api(`/v1/media/uploads/${begun.upload.id}/complete`, {})
      const originalFetch = globalThis.fetch
      let providerRequests = 0
      try {
        globalThis.fetch = async (url, options) => {
          if (String(url) !== 'https://api.groq.com/openai/v1/audio/transcriptions') return originalFetch(url, options)
          providerRequests += 1
          assert.ok(options.body.get('file').size > 0)
          return Response.json({ text: 'Material controlado.', words: [{ word: 'Material', start: 0, end: 1 }, { word: 'controlado.', start: 1, end: 3 }], segments: [{ id: 0, text: 'Material controlado.', start: 0, end: 3 }] })
        }
        const outcome = await factory.createMediaIngestWorker({ ...environment, GROQ_API_KEY: 'controlled-test-key-not-live-000000', GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR: '7200' })(`library-worker-${suffix}`, AbortSignal.timeout(60_000)); assert.equal(outcome?.status, 'succeeded')
      } finally { globalThis.fetch = originalFetch }
      assert.equal(providerRequests, kind === 'video' ? 1 : 0)
      assert.equal((await prisma.v2PublicOperation.findUniqueOrThrow({ where: { id: completed.operation.id } })).status, 'succeeded')
      const link = await prisma.v2ProjectMediaAsset.findFirstOrThrow({ where: { workspaceId, uploadId: begun.upload.id, role: kind === 'video' ? 'source-master' : `source-${kind}` } })
      if (approved) await grant(link.artifactId)
      uploads.push({ kind, uploadId: begun.upload.id, artifactId: link.artifactId, operationId: completed.operation.id, sourceSha256: sha256(bytes) }); return link.artifactId
    }
    const artifactId = await upload(videoBytes, 'video', 'video/mp4', 'master.mp4')
    const sourceArtifact = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: artifactId } })
    const { path: sourcePath } = await new LocalArtifactSourceMaterializer(artifactRoot).materialize({ operationId: `library-source-${suffix}`, artifactKey: sourceArtifact.artifactKey, sha256: sourceSha256, byteSize: videoBytes.length })
    const audioPath = join(root, 'tone.wav'); await execute(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:a', 'pcm_s16le', audioPath], { windowsHide: true, timeout: 30000 })
    const audioSourceBytes = await readFile(audioPath)
    const audioId = await upload(audioSourceBytes, 'audio', 'audio/wav', 'tone.wav')
    const imageId = await upload(await createImageFixtureBytes('multilingual'), 'image', 'image/png', 'multilingual.png')
    const image = await api(`/v1/media/library/${imageId}/image-analysis`)
    if (process.env.APOLLO_TESSERACT_PATH) { assert.equal(image.ocr.state, 'available'); assert.ok(image.ocr.values.length) } else assert.equal(image.ocr.state, 'unavailable')
    assert.equal(image.faces.state, 'unavailable'); assert.equal(image.objects.state, 'unavailable')
    const expiredId = await upload(await createImageFixtureBytes('small'), 'image', 'image/png', 'expired.png')
    await grant(expiredId, { expiresAt: '2020-01-01T00:00:00.000Z' })
    const restrictedId = await upload(await createImageFixtureBytes('plain'), 'image', 'image/png', 'restricted.png')
    await grant(restrictedId, { allowedLocales: ['en-US'] })
    const reviewBytes = await require('sharp')(await createImageFixtureBytes('plain')).resize(512, 256).png().toBuffer()
    const reviewId = await upload(reviewBytes, 'image', 'image/png', 'review.png', false)
    await prisma.v2MediaArtifact.update({ where: { id: reviewId }, data: { currentRightsSnapshotId: null } })
    await prisma.v2MediaLibraryEntry.update({ where: { artifactId }, data: { peopleJson: '["Ágata"]', peopleSearch: '\nágata\n', topicsJson: '["Imersão"]', topicsSearch: '\nimersão\n' } })
    otherWorkspace = await seedAnalyzedImageLibrary({ prisma, fixture: 'plain' })
    const denied = await fetch(`${baseUrl}/v1/media/library/${otherWorkspace.artifactId}`, { headers, signal: AbortSignal.timeout(10000) })
    assert.equal(denied.status, 404); assert.equal((await denied.json()).error.code, 'MEDIA_ARTIFACT_NOT_FOUND')
    evidence.checks.push({ strength: 'http-real+pg-real', name: 'workspace-isolation', otherArtifactId: otherWorkspace.artifactId, status: denied.status })
    const currentProject = await api(`/v1/projects/${projectId}`)
    for (const blockedId of [expiredId, restrictedId, reviewId]) {
      const response = await fetch(`${baseUrl}/v1/projects/${projectId}/media-library-attachments`, { method: 'POST', headers: { ...headers, 'idempotency-key': randomUUID() }, body: JSON.stringify({ selection: { kind: 'asset', artifactId: blockedId }, baseVersionId: currentProject.version.id, baseVersionHash: currentProject.version.baseHash }), signal: AbortSignal.timeout(10000) })
      const payload = await response.json(); assert.equal(payload.error.code, 'ASSET_RIGHTS_BLOCKED'); assert.ok(!response.ok)
      evidence.checks.push({ strength: 'http-real+pg-real', name: 'attach-rights-blocked', artifactId: blockedId, status: response.status, errorCode: payload.error.code })
    }
    evidence.checks.push({ strength: 'http-real+worker-real+pg-real', name: 'audio-and-image-ingest', uploads, ocr: image.ocr.state })
    const segments = []
    for (let index = 0; index < 28; index += 1) segments.push(await api(`/v1/media/library/${artifactId}/segments`, { label: `Controlled range ${index}`, startMs: index * 100, endMs: index * 100 + 500 }))
    const nested = await api(`/v1/media/library/${artifactId}/segments`, { label: 'Nested range', parentSegmentId: segments[0].id, startMs: 100, endMs: 500 })
    assert.equal(nested.physicalObjectKey, null)
    const audioSegment = await api(`/v1/media/library/${audioId}/segments`, { label: 'Audio virtual range', startMs: 500, endMs: 1500 })
    assert.equal(audioSegment.physicalObjectKey, null)
    const beforeVirtual = await prisma.v2MediaArtifact.count({ where: { workspaceId } })
    const virtual = await api(`/v1/media/segments/${segments[0].id}/derivative-jobs`, { consumerKey: 'library-virtual-proof', requiresPhysicalDerivative: false })
    assert.equal(virtual.kind, 'virtual')
    assert.equal(await prisma.v2MediaArtifact.count({ where: { workspaceId } }), beforeVirtual)
    const job = await api(`/v1/media/segments/${segments[0].id}/derivative-jobs`, { consumerKey: 'library-physical-proof', requiresPhysicalDerivative: true })
    assert.equal(job.kind, 'job')
    const derivative = await factory.createMediaSegmentDerivativeWorker(environment)(`library-derivative-${suffix}`, AbortSignal.timeout(60_000))
    assert.equal(derivative?.jobId, job.job.id); assert.equal(derivative?.status, 'succeeded')
    const observedJob = await api(`/v1/media/segment-derivative-jobs/${job.job.id}`)
    assert.equal(observedJob.status, 'succeeded')
    const output = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: derivative.outputArtifactId } })
    const { path: outputPath } = await new LocalArtifactSourceMaterializer(artifactRoot).materialize({ operationId: `library-proof-${suffix}`, artifactKey: output.artifactKey, sha256: output.sha256, byteSize: Number(output.byteSize) })
    assert.equal(await calculateFileSha256(outputPath), output.sha256)
    const outputProbe = await probeVideo(outputPath)
    assert.ok(Math.abs(outputProbe.duration - 0.5) < 0.12)
    const outputBytes = await readFile(outputPath)
    await writeFile(join(evidenceDir, 'segment-derivative.mp4'), outputBytes)
    const replay = await api(`/v1/media/segments/${segments[0].id}/derivative-jobs`, { consumerKey: 'library-physical-proof', requiresPhysicalDerivative: true })
    assert.equal(replay.kind, 'ready')
    evidence.derivativeJob = { jobId: job.job.id, outputArtifactId: output.id, sha256: output.sha256, bytes: outputBytes.length, duration: outputProbe.duration, replay: replay.kind }
    const audioJob = await api(`/v1/media/segments/${audioSegment.id}/derivative-jobs`, { consumerKey: 'library-audio-proof', requiresPhysicalDerivative: true })
    assert.equal(audioJob.kind, 'job')
    const audioDerivative = await factory.createMediaSegmentDerivativeWorker(environment)(`library-audio-derivative-${suffix}`, AbortSignal.timeout(60_000))
    assert.equal(audioDerivative?.jobId, audioJob.job.id); assert.equal(audioDerivative?.status, 'succeeded')
    assert.equal((await api(`/v1/media/segment-derivative-jobs/${audioJob.job.id}`)).status, 'succeeded')
    const audioOutput = await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: audioDerivative.outputArtifactId }, include: { manifests: true } })
    assert.equal(audioOutput.mediaType, 'audio'); assert.equal(audioOutput.container, 'wav')
    const audioContent = await fetch(`${baseUrl}/v1/artifacts/${audioOutput.id}/content`, { headers, signal: AbortSignal.timeout(10_000) })
    assert.equal(audioContent.status, 200)
    const audioOutputBytes = Buffer.from(await audioContent.arrayBuffer())
    assert.equal(sha256(audioOutputBytes), audioOutput.sha256)
    const { path: audioOutputPath } = await new LocalArtifactSourceMaterializer(artifactRoot).materialize({ operationId: `library-audio-proof-${suffix}`, artifactKey: audioOutput.artifactKey, sha256: audioOutput.sha256, byteSize: Number(audioOutput.byteSize) })
    assert.ok(Math.abs((await probeAudioDurationSeconds(audioOutputPath)) - 1) < 0.12)
    await execute(require('ffmpeg-static'), ['-hide_banner', '-loglevel', 'error', '-i', audioOutputPath, '-f', 'null', '-'], { windowsHide: true, timeout: 30_000 })
    assert.equal((await prisma.v2MediaArtifact.findUniqueOrThrow({ where: { id: audioId } })).sha256, sha256(audioSourceBytes))
    const audioManifest = JSON.parse(audioOutput.manifests[0].manifestJson)
    assert.deepEqual(audioManifest.sources.map((source) => source.sha256), [sha256(audioSourceBytes)])
    const audioReplay = await api(`/v1/media/segments/${audioSegment.id}/derivative-jobs`, { consumerKey: 'library-audio-proof', requiresPhysicalDerivative: true })
    assert.equal(audioReplay.kind, 'ready')
    await writeFile(join(evidenceDir, 'audio-segment-derivative.wav'), audioOutputBytes)
    evidence.audioDerivativeJob = { jobId: audioJob.job.id, outputArtifactId: audioOutput.id, outputManifestId: audioOutput.manifests[0].id, sourceSha256: sha256(audioSourceBytes), sha256: audioOutput.sha256, bytes: audioOutputBytes.length, duration: await probeAudioDurationSeconds(audioOutputPath), replay: audioReplay.kind }
    evidence.checks.push({ strength: 'http-real+pg-real', name: 'virtual-ranges', segments: segments.map((segment) => segment.id), nestedId: nested.id })
    const login = await fetch(`${baseUrl}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }), signal: AbortSignal.timeout(10000) }); assert.equal(login.status, 200)
    const cookie = /apollo_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1]; assert.ok(cookie)
    evidence.browser = await proveLibraryBrowser({ baseUrl, cookie, prisma, workspaceId, projectId, sourceArtifactId: artifactId, evidenceDir })
    assert.equal(await calculateFileSha256(sourcePath), sourceSha256); assert.equal((await readFile(sourcePath)).length, videoBytes.length)
    evidence.source = { artifactId, sourceSha256, bytes: videoBytes.length }; evidence.outcome = 'passed'
  } catch (error) {
    evidence.outcome = 'failed'; evidence.failure = { name: error.name, message: error.message }
    await writeFile(join(evidenceDir, 'library-server-diagnostic.log'), logs)
    throw error
  } finally {
    await stop(server); evidence.postflight.serverTerminal = !server || server.exitCode !== null || server.signalCode !== null
    await disconnectV2PostgresClient(); await otherWorkspace?.cleanup(); await cleanupWorkspace(prisma, workspaceId)
    await prisma.$disconnect()
    await closeJourneyObjectStore(objectStore)
    const observer = new PrismaClient()
    const supervisorObserver = process.env.APOLLO_LIBRARY_OBSERVER_APPLICATION_NAME ?? null
    if (supervisorObserver) assert.match(supervisorObserver, /^apollo-video-e2e-observer-[a-f0-9]{8}$/)
    try { evidence.postflight.supervisorObserver = supervisorObserver; evidence.postflight.backends = await observer.$queryRawUnsafe('SELECT application_name FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND ($1::text IS NULL OR application_name<>$1)', supervisorObserver); assert.deepEqual(evidence.postflight.backends, []) } finally { await observer.$disconnect() }
    await writeFile(join(evidenceDir, 'library-journey.json'), JSON.stringify(evidence, null, 2))
    await rm(root, { recursive: true, force: true })
  }
})

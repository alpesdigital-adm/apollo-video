import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { Prisma, PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext, materializeActorAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { cancelPublicOperationService } from '../../src/v2/application/cancel-public-operation.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { enqueueFaceProducerRunService } from '../../src/v2/application/enqueue-face-producer-run.ts'
import { runNextFaceProducerOperationService } from '../../src/v2/application/run-face-producer-worker.ts'
import { createFaceProducerEnvelope } from '../../src/v2/domain/face-producer-envelope.ts'
import { evaluateAssetUse } from '../../src/v2/domain/asset-rights.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaFaceProducerRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaFaceProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/face-producer-envelope-repository.ts'
import { hydrateAssetRights } from '../../src/v2/infrastructure/prisma/asset-rights-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaDocument } from '../../src/v2/public-api/schema-examples.ts'
import { presentPublicOperationV2, presentSuccess } from '../../src/v2/public-api/presenters.ts'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'
import { createFenceChildVersion, createFenceRightsSnapshot, expectProducerPublishErrorCode, fenceRightsRow, verifyProducerPublishFences } from './helpers/producer-publish-lock-race.mjs'

const exec = promisify(execFile)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const expectedVideoSha = 'a6f255543f3b135ab51a463865625a09b5672d352cc97ac175de11619a5f38f7'

test('W61 publish-race fixture hydrates a real child and rights expiry offline', () => {
  const world = { workspaceId: 'workspace-fence-offline', projectId: 'project-fence-offline',
    sourceId: 'artifact-fence-offline' }
  const child = createFenceChildVersion(world, { id: 'version-fence-base', sequence: 1,
    briefSnapshotId: 'brief-fence', treatmentSnapshotId: null, storySnapshotId: null,
    editPlanSnapshotId: 'edit-fence', policiesSnapshotId: 'policies-fence',
    baseHash: 'b'.repeat(64), createdBy: 'owner-fence' }, 'c'.repeat(64),
  'version-fence-child')
  assert.equal(child.sequence, 2)
  assert.equal(child.parentVersionId, 'version-fence-base')
  assert.equal(child.commandId, undefined)
  assert.equal(child.snapshotRefs.editPlan, 'edit-fence')
  assert.notEqual(child.baseHash, 'b'.repeat(64))
  const expiresAt = new Date(Date.now() + 10_000)
  const rights = createFenceRightsSnapshot(world, 2, expiresAt, 'offline')
  const renewed = createFenceRightsSnapshot(world, 3, null, 'offline-renewed')
  assert.equal(hydrateAssetRights(fenceRightsRow(rights)).snapshotHash, rights.snapshotHash)
  assert.equal(hydrateAssetRights(fenceRightsRow(renewed)).snapshotHash, renewed.snapshotHash)
  assert.notEqual(rights.snapshotHash, renewed.snapshotHash)
  assert.equal(renewed.sequence, 3)
  const context = { workspaceId: world.workspaceId, use: 'editorial-reuse', locale: 'pt-BR' }
  assert.equal(evaluateAssetUse(rights, context, new Date(expiresAt.getTime() - 1), 1).outcome,
    'allow')
  assert.deepEqual(evaluateAssetUse(rights, context, expiresAt).reasonCodes,
    ['RIGHTS_EXPIRED'])
  assert.equal(evaluateAssetUse(renewed, context, expiresAt).outcome, 'allow')
})

test('W61 publish-race matcher checks typed codes, not error prose', () => {
  const serialization = new Prisma.PrismaClientKnownRequestError('serialization conflict', {
    code: 'P2010', clientVersion: '5.22.0', meta: { code: '40001' },
  })
  const otherSqlState = new Prisma.PrismaClientKnownRequestError('other raw query error', {
    code: 'P2010', clientVersion: '5.22.0', meta: { code: '23514' },
  })
  assert.equal(expectProducerPublishErrorCode(
    new DomainError('PERSISTENCE_CONFLICT', 'Producer operation is not held by the current fenced attempt'),
    ['PERSISTENCE_CONFLICT']), true)
  assert.equal(expectProducerPublishErrorCode(
    new DomainError('ASSET_RIGHTS_BLOCKED', 'Producer source rights expired'),
    ['ASSET_RIGHTS_BLOCKED']), true)
  assert.equal(expectProducerPublishErrorCode(
    new DomainError('PERSISTENCE_CONFLICT', 'wrong cause'), ['ASSET_RIGHTS_BLOCKED'], false), false)
  assert.equal(expectProducerPublishErrorCode(new Error('lease expired'),
    ['PERSISTENCE_CONFLICT'], false), false)
  assert.equal(expectProducerPublishErrorCode(serialization,
    ['PERSISTENCE_CONFLICT', 'P2034', 'P2010:40001'], false), true)
  assert.equal(expectProducerPublishErrorCode(otherSqlState,
    ['PERSISTENCE_CONFLICT', 'P2034', 'P2010:40001'], false), false)
  assert.equal(expectProducerPublishErrorCode(serialization,
    ['PERSISTENCE_CONFLICT'], false), false)
  assert.equal(expectProducerPublishErrorCode(serialization,
    ['ASSET_RIGHTS_BLOCKED'], false), false)
})

function actorFor(world) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId,
    credentialId: `face-credential-${world.suffix}`, workspaceId: world.workspaceId,
    environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write', 'projects:read', 'operations:cancel']),
    authenticationKind: 'bearer', clientKillSwitchEngaged: false,
    workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext }
}

async function settleCaseOperation(db, world, operationId, label) {
  if (!world || !operationId) return
  const stored = await db.v2PublicOperation.findUnique({ where: { id: operationId } })
  if (!stored) return
  const active = ['queued', 'running', 'waiting', 'retrying']
  if (active.includes(stored.status)) {
    const canceledAt = new Date(Math.max(Date.now(), stored.updatedAt.getTime() + 1,
      (stored.nextAttemptAt?.getTime() ?? 0) + 1)).toISOString()
    const cancel = cancelPublicOperationService({
      operations: new PrismaPublicOperationRepository(db),
      clock: () => new Date(canceledAt), createId: () => `${label}-${randomUUID()}`,
    })
    const canceled = await cancel({ workspaceId: world.workspaceId,
      operationId, actor: actorFor(world) })
    assert.equal(canceled.status, 'canceled', `${label} must cancel active operation`)
  }
  const remaining = await db.v2PublicOperation.findUnique({ where: { id: operationId } })
  assert.ok(remaining && !active.includes(remaining.status), `${label} left an active operation`)
}

async function finishCase(db, world, operationId, label, primaryError) {
  let cleanupError
  try { await settleCaseOperation(db, world, operationId, label) }
  catch (error) { cleanupError = error }
  try { await db.$disconnect() }
  catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], `${label} and cleanup failed`)
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}

async function stopRunner(child) {
  if (!child) return
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return
  const waitClose = (timeoutMs) => new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('face runner stop deadline')), timeoutMs)
    child.once('close', () => { clearTimeout(timeout); done() })
  })
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    try { await waitClose(10_000) }
    catch {
      child.kill('SIGKILL')
      await waitClose(5_000)
    }
  }
  assert.throws(() => process.kill(child.pid, 0), /ESRCH|not found/i)
  if (process.platform === 'win32') {
    const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Select-Object -ExpandProperty ProcessId`],
    { windowsHide: true, timeout: 10_000 })
    assert.equal(stdout.trim(), '', 'face runner descendants must be terminal')
  }
}

test('W61 face control uses scoped canonical audit before the repository transaction', async () => {
  const world = { workspaceId: 'workspace-face-audit', clientId: 'client-face-audit', suffix: 'offline' }
  const actor = actorFor(world)
  const audit = materializeActorAuditContext(actor)
  assert.equal(audit.contextHash, createApiAccessAuditContext({
    clientId: audit.clientId, credentialId: audit.credentialId,
    workspaceId: audit.workspaceId, environment: audit.environment,
    authenticationKind: audit.authenticationKind,
  }).contextHash)
  const reachedTransaction = new Error('repository audit accepted')
  const validator = new PrismaPublicOperationRepository({
    async $transaction() { throw reachedTransaction },
  })
  const cancel = cancelPublicOperationService({ operations: validator,
    clock: () => new Date('2026-10-09T00:00:00.000Z'),
    createId: () => 'face-control-offline' })
  await assert.rejects(cancel({ workspaceId: world.workspaceId,
    operationId: 'face-operation-offline', actor: { ...actor,
      scopes: new Set(['projects:write']) } }), { code: 'AUTH_SCOPE_REQUIRED' })
  await assert.rejects(cancel({ workspaceId: 'workspace-other-audit',
    operationId: 'face-operation-offline', actor }), { code: 'AUTH_INVALID' })
  await assert.rejects(cancel({ workspaceId: world.workspaceId,
    operationId: 'face-operation-offline', actor }), (error) => error === reachedTransaction)
})

test('W61 PostgreSQL face claim blocks revoked rights before materialization',
  { skip: !process.env.V2_DATABASE_URL, timeout: 120_000 }, async () => {
    const db = new PrismaClient()
    let world
    let operationId
    let primaryError
    try {
      world = await seedPerceptionProducerContext(db)
      const operations = new PrismaPublicOperationRepository(db)
      const queued = await enqueueFaceProducerRunService({
        context: new PrismaFaceProducerRequestContextRepository(db), operations,
        createOperationId: () => `face-operation-${randomUUID()}`,
      })({ workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 30, actor: actorFor(world),
        idempotencyKey: `face-revoked-${world.suffix}` })
      operationId = queued.operation.id
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: { increment: 1 } } })
      let materialized = 0, analyzed = 0
      const worker = runNextFaceProducerOperationService({
        repository: new PrismaFaceProducerEnvelopeRepository(db),
        materializer: { async materialize() { materialized++; assert.fail('revoked source read') },
          async cleanup() {} },
        analyzer: { async analyze() { analyzed++; assert.fail('revoked source inference') } },
      })
      assert.equal(await worker(`face-revoked-worker-${world.suffix}`), null)
      assert.equal(materialized, 0)
      assert.equal(analyzed, 0)
      const stored = await operations.findById(world.workspaceId, queued.operation.id)
      assert.equal(stored.operation.status, 'failed')
      assert.equal(stored.operation.error.code, 'invalid_producer_context')
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId: queued.operation.id } }), 0)
      const events = await db.v2PublicEventOutbox.findMany({ where: {
        workspaceId: world.workspaceId, resourceId: queued.operation.id } })
      assert.ok(events.some((event) => event.type === 'operation.failed'))
    } catch (error) {
      primaryError = error
    } finally {
      await finishCase(db, world, operationId, 'face-revoked-cleanup', primaryError)
    }
  })

test('W61 PostgreSQL face retry releases lease without publishing or retaining terminal error',
  { skip: !process.env.V2_DATABASE_URL, timeout: 120_000 }, async () => {
    const db = new PrismaClient()
    let operationId
    let world
    let primaryError
    const operations = new PrismaPublicOperationRepository(db)
    try {
      world = await seedPerceptionProducerContext(db)
      const queued = await enqueueFaceProducerRunService({
        context: new PrismaFaceProducerRequestContextRepository(db), operations,
        createOperationId: () => `face-operation-${randomUUID()}`,
      })({ workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 30, actor: actorFor(world),
        idempotencyKey: `face-retry-${world.suffix}` })
      operationId = queued.operation.id
      let analyzed = 0
      const worker = runNextFaceProducerOperationService({
        repository: new PrismaFaceProducerEnvelopeRepository(db),
        materializer: { async materialize() { throw new Error('controlled transient storage failure') },
          async cleanup() {} },
        analyzer: { async analyze() { analyzed++; assert.fail('must not analyze missing bytes') } },
      })
      const result = await worker(`face-retry-worker-${world.suffix}`)
      assert.equal(result?.status, 'attempt-failed')
      assert.equal(result?.settled, true)
      assert.equal(analyzed, 0)
      const row = await db.v2PublicOperation.findUnique({ where: { id: operationId } })
      assert.equal(row.status, 'retrying')
      assert.equal(row.phase, 'retrying')
      assert.equal(row.attempt, 1)
      assert.equal(row.leaseOwner, null)
      assert.equal(row.leaseExpiresAt, null)
      assert.equal(row.errorCode, null)
      assert.equal(row.errorMessage, null)
      assert.ok(row.nextAttemptAt > row.updatedAt)
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId } }), 0)
      assert.ok((await db.v2PublicEventOutbox.findMany({ where: {
        workspaceId: world.workspaceId, resourceId: operationId } }))
        .some((event) => event.type === 'operation.status.changed'))
      const resumedAt = new Date(row.nextAttemptAt.getTime() + 1)
      const resumed = await new PrismaFaceProducerEnvelopeRepository(db).claimNext({
        leaseOwner: `face-retry-successor-${world.suffix}`, now: resumedAt, leaseMs: 30_000 })
      assert.equal(resumed?.operationId, operationId)
      assert.equal(resumed?.attempt, 2)
      const running = await db.v2PublicOperation.findUnique({ where: { id: operationId } })
      assert.equal(running.status, 'running')
      assert.equal(running.phase, 'probing')
      assert.equal(running.retryable, false)
      assert.equal(running.cancelable, true)
      assert.equal(running.nextAttemptAt, null)
      assert.equal(running.deadLetteredAt, null)
    } catch (error) {
      primaryError = error
    } finally {
      await finishCase(db, world, operationId, 'face-retry-cleanup', primaryError)
    }
  })

test('W61 PostgreSQL real YuNet runner stores only failed-gate sampled candidates from licensed development still',
  { skip: !process.env.V2_DATABASE_URL || process.env.APOLLO_FACE_VIDEO_E2E !== '1', timeout: 180_000 }, async () => {
    const required = ['W61_FACE_DEV_VIDEO', 'W61_FACE_DEV_LINEAGE', 'W61_FACE_DEV_LANDING',
      'W61_PYTHON', 'W61_PYDEPS',
      'W61_YUNET_MODEL', 'W61_OPENCV_BINARY', 'W61_FFMPEG', 'W61_FFPROBE', 'W61_YUNET_LICENSE']
    for (const key of required) assert.ok(isAbsolute(process.env[key] ?? ''), `${key} must be absolute`)
    const videoBytes = await readFile(process.env.W61_FACE_DEV_VIDEO)
    const lineage = JSON.parse(await readFile(process.env.W61_FACE_DEV_LINEAGE, 'utf8'))
    assert.equal(sha(videoBytes), expectedVideoSha)
    assert.equal(lineage.videoSha256, expectedVideoSha)
    assert.equal(lineage.imageId, 'eb03b32d7c7c6b7a')
    assert.equal(lineage.license, 'https://creativecommons.org/licenses/by/2.0/')
    assert.equal(sha(await readFile(process.env.W61_FACE_DEV_LANDING)), lineage.landingSha256)
    assert.equal(lineage.humanFaceGroundTruthBoxes, 2)
    assert.equal(lineage.frozenV5MatchedBoxes, 1)
    const db = new PrismaClient()
    const root = await mkdtemp(join(tmpdir(), 'apollo-face-pg-'))
    let child
    const cleanupOperations = []
    let cleanupWorld
    let primaryError
    try {
      const suffix = randomUUID().slice(0, 8)
      const workspaceId = `w61-admission-${suffix}`
      const artifactKey = `${workspaceId}/source.mp4`
      await mkdir(join(root, workspaceId), { recursive: true })
      await copyFile(process.env.W61_FACE_DEV_VIDEO, join(root, artifactKey))
      const world = await seedPerceptionProducerContext(db, { suffix, artifactKey,
        sourceSha256: expectedVideoSha, byteSize: BigInt(videoBytes.length) })
      const operations = new PrismaPublicOperationRepository(db)
      cleanupWorld = world
      const queued = await enqueueFaceProducerRunService({
        context: new PrismaFaceProducerRequestContextRepository(db), operations,
        createOperationId: () => `face-operation-${randomUUID()}`,
      })({ workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
        sampleIntervalFrames: 30, actor: actorFor(world),
        idempotencyKey: `face-real-${world.suffix}` })
      cleanupOperations.push(queued.operation.id)
      const runtime = {
        APOLLO_V2_ARTIFACT_ROOT: root, APOLLO_V2_ARTIFACT_STORAGE_DRIVER: 'local',
        APOLLO_V2_FACE_PYTHON_BIN: process.env.W61_PYTHON,
        APOLLO_V2_FACE_PYTHON_SHA256: sha(await readFile(process.env.W61_PYTHON)),
        APOLLO_V2_FACE_PYTHON_MODULE_DIR: process.env.W61_PYDEPS,
        APOLLO_V2_FACE_MODEL_BIN: process.env.W61_YUNET_MODEL,
        APOLLO_V2_FACE_BRIDGE_SCRIPT: resolve('src/v2/infrastructure/perception/yunet_cpu_bridge.py'),
        APOLLO_V2_FACE_OPENCV_BINARY: process.env.W61_OPENCV_BINARY,
        APOLLO_V2_FACE_OPENCV_SHA256: sha(await readFile(process.env.W61_OPENCV_BINARY)),
        APOLLO_V2_FACE_FFMPEG_BIN: process.env.W61_FFMPEG,
        APOLLO_V2_FACE_FFMPEG_SHA256: sha(await readFile(process.env.W61_FFMPEG)),
        APOLLO_V2_FACE_FFPROBE_BIN: process.env.W61_FFPROBE,
        APOLLO_V2_FACE_FFPROBE_SHA256: sha(await readFile(process.env.W61_FFPROBE)),
        APOLLO_V2_FACE_MODEL_LICENSE: process.env.W61_YUNET_LICENSE,
        APOLLO_V2_FACE_MODEL_LICENSE_SHA256: sha(await readFile(process.env.W61_YUNET_LICENSE)),
        APOLLO_V2_FACE_POLL_MS: '100',
      }
      runtime.APOLLO_V2_FACE_BRIDGE_SHA256 = sha(await readFile(runtime.APOLLO_V2_FACE_BRIDGE_SCRIPT))
      child = spawn(process.execPath, ['--import', 'tsx', 'scripts/run-v2-face-producer-worker.mjs'], {
        cwd: process.cwd(), env: { ...process.env, ...runtime }, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let diagnostic = '', closed = false
      child.once('error', (error) => { diagnostic = (diagnostic + String(error)).slice(-4000) })
      child.once('close', (code) => { closed = true; diagnostic = (diagnostic + ` close=${code}`).slice(-4000) })
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => {
        diagnostic = (diagnostic + data.toString()).slice(-4000)
      })
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0, diagnostic)
      const deadline = Date.now() + 120_000
      let stored
      while (Date.now() < deadline) {
        stored = await operations.findById(world.workspaceId, queued.operation.id)
        if (stored?.operation.status === 'succeeded' || stored?.operation.status === 'failed' ||
            closed || diagnostic.includes('"status":"iteration-failed"')) break
        await new Promise((done) => setTimeout(done, 250))
      }
      assert.equal(stored?.operation.status, 'succeeded', diagnostic)
      await stopRunner(child)
      child = null
      const row = await db.v2FaceProducerEnvelope.findFirst({ where: { operationId: queued.operation.id } })
      assert.ok(row)
      const repository = new PrismaFaceProducerEnvelopeRepository(db)
      const input = { id: row.id, workspaceId: world.workspaceId, projectId: world.projectId,
        inputVersionId: world.versionId, now: new Date() }
      const envelope = await repository.read(input)
      assert.equal(envelope.faceSafety, 'unknown')
      assert.equal(envelope.identity, 'not-performed')
      assert.equal(envelope.coverage, 'sampled-only')
      assert.equal(envelope.producer.assessment.status, 'failed-gate')
      assert.equal(envelope.sourceSha256, expectedVideoSha)
      assert.equal((await db.v2PublicOperation.findUnique({ where: { id: queued.operation.id } })).leaseOwner, null)
      assert.deepEqual(envelope.samples.map((sample) => sample.sourceFrame), [0, 30, 60, 90])
      assert.ok(envelope.samples.every((sample) => sample.imageSha256.length === 64 &&
        sample.frameWidth === 1024 && sample.frameHeight === 768))
      assert.ok(envelope.samples.some((sample) => sample.status === 'observed' && sample.boxes.length > 0),
        'controlled development still must yield at least one real candidate')
      const ajv = new Ajv2020({ strict: true, allErrors: true })
      addFormats(ajv)
      const validate = ajv.compile(publicSchemaDocument(getPublicSchema(
        'apollo://schemas/face-producer-operation-read/v1')))
      const response = presentSuccess({ operation: presentPublicOperationV2(stored.operation,
        { includeProjectId: true }), envelope })
      assert.equal(validate(response), true, ajv.errorsText(validate.errors))
      assert.equal(await repository.read({ ...input, id: `missing-${randomUUID()}` }), null)
      assert.equal(await repository.read({ ...input, inputVersionId: `stale-${randomUUID()}` }), null)
      assert.equal(await repository.read({ ...input, workspaceId: world.otherWorkspaceId }), null)
      const queueAnother = async (label) => {
        const next = await enqueueFaceProducerRunService({
          context: new PrismaFaceProducerRequestContextRepository(db), operations,
          createOperationId: () => `face-operation-${randomUUID()}`,
        })({ workspaceId: world.workspaceId, projectId: world.projectId,
          projectVersionId: world.versionId, sourceArtifactId: world.sourceId,
          sampleIntervalFrames: 30, actor: actorFor(world),
          idempotencyKey: `face-${label}-${world.suffix}` })
        cleanupOperations.push(next.operation.id)
        return next.operation.id
      }
      const { schemaVersion, authority, coverage, faceSafety, identity, timeMapHash,
        detectorConfigHash, envelopeHash, ...baseEnvelope } = envelope
      await verifyProducerPublishFences({ db, world, repository,
        Repository: PrismaFaceProducerEnvelopeRepository,
        label: 'face', phases: ['analyzing', 'verifying', 'persisting'],
        envelopeModel: 'v2FaceProducerEnvelope',
        enqueue: queueAnother,
        cloneEnvelope: ({ operationId, attempt, fenceHash }) =>
          createFaceProducerEnvelope({ ...baseEnvelope,
            id: `face-envelope-${randomUUID()}`, operationId,
            operationAttempt: attempt, operationFenceHash: fenceHash,
            createdAt: new Date().toISOString() }),
        cancel: (operationId, kind) => settleCaseOperation(db, world, operationId,
          `face-${kind}-cleanup`),
      })
      const leaseOwner = `face-fence-${world.suffix}`
      const fencedId = await queueAnother('cancel-fence')
      const claim = await repository.claimNext({ leaseOwner, now: new Date(), leaseMs: 120_000 })
      assert.equal(claim?.operationId, fencedId)
      for (const phase of ['analyzing', 'verifying', 'persisting']) {
        assert.equal(await repository.advancePhase({ operationId: fencedId, attempt: claim.attempt,
          leaseOwner, now: new Date(), phase }), true)
      }
      const fencedEnvelope = createFaceProducerEnvelope({ ...baseEnvelope,
        id: `face-envelope-${randomUUID()}`, operationId: fencedId,
        operationAttempt: claim.attempt,
        operationFenceHash: await repository.currentFenceHash({ operationId: fencedId,
          attempt: claim.attempt, leaseOwner, now: new Date() }),
        createdAt: new Date().toISOString() })
      await assert.rejects(repository.publish({ envelope: fencedEnvelope,
        leaseOwner: `wrong-${leaseOwner}`, now: new Date() }), /fenc|held|lease/i)
      const expiredAt = new Date(claim.leaseExpiresAt.getTime() + 1000)
      const successorOwner = `face-takeover-${world.suffix}`
      const successor = await repository.claimNext({ leaseOwner: successorOwner,
        now: expiredAt, leaseMs: 120_000 })
      assert.equal(successor?.operationId, fencedId)
      assert.equal(successor?.attempt, claim.attempt + 1)
      await assert.rejects(repository.currentFenceHash({ operationId: fencedId,
        attempt: claim.attempt, leaseOwner, now: expiredAt }), /fenc|held|lease/i)
      await assert.rejects(repository.publish({ envelope: fencedEnvelope,
        leaseOwner, now: expiredAt }), /fenc|held|lease/i)
      assert.equal((await db.v2PublicOperation.findUnique({ where: { id: fencedId } })).leaseOwner,
        successorOwner)
      const canceled = await cancelPublicOperationService({ operations,
        clock: () => new Date(expiredAt.getTime() + 1000),
        createId: () => `face-cancel-${randomUUID()}` })({
        workspaceId: world.workspaceId, operationId: fencedId, actor: actorFor(world) })
      assert.equal(canceled.status, 'canceled')
      assert.equal(await repository.advancePhase({ operationId: fencedId, attempt: claim.attempt,
        leaseOwner, now: new Date(), phase: 'persisting' }), false)
      await assert.rejects(repository.publish({ envelope: fencedEnvelope,
        leaseOwner, now: new Date() }), /fenc|held|lease/i)
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId: fencedId } }), 0)
      await db.v2FaceProducerEnvelope.create({ data: {
        id: fencedEnvelope.id, workspaceId: world.workspaceId, projectId: world.projectId,
        projectVersionId: world.versionId, operationId: fencedId,
        operationAttempt: fencedEnvelope.operationAttempt,
        operationFenceHash: fencedEnvelope.operationFenceHash,
        sourceArtifactId: world.sourceId, sourceSha256: expectedVideoSha,
        editPlanSnapshotId: world.editId,
        editPlanSnapshotHash: fencedEnvelope.editPlanSnapshotHash,
        timeMapHash: fencedEnvelope.timeMapHash,
        detectorConfigHash: fencedEnvelope.detectorConfigHash,
        contentJson: JSON.stringify(fencedEnvelope), envelopeHash: fencedEnvelope.envelopeHash,
        createdAt: new Date(fencedEnvelope.createdAt),
      } })
      await assert.rejects(repository.read({ ...input, id: fencedEnvelope.id }), /result|fenc|publish/i,
        'a manually inserted row beside a canceled operation must not be readable')
      await db.v2FaceProducerEnvelope.delete({ where: { id: fencedEnvelope.id } })
      const sourceSha = world.sourceSha256
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /source|hash/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: sourceSha } })
      const originalContent = row.contentJson
      for (const mutate of [
        (value) => { value.producer.modelSha256 = 'f'.repeat(64) },
        (value) => { value.samples[0].imageSha256 = 'f'.repeat(64) },
      ]) {
        const altered = JSON.parse(originalContent)
        mutate(altered)
        await db.v2FaceProducerEnvelope.update({ where: { id: row.id },
          data: { contentJson: JSON.stringify(altered) } })
        await assert.rejects(repository.read(input), /integrity|hash/i)
      }
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id },
        data: { contentJson: originalContent } })
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /integrity|hash/i)
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id },
        data: { envelopeHash: envelope.envelopeHash } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId },
        data: { currentRightsSnapshotId: null, rightsRevision: { increment: 1 } } })
      await assert.rejects(repository.read(input), /rights/i)
      assert.ok((await db.v2PublicEventOutbox.findMany({ where: {
        workspaceId: world.workspaceId, resourceId: queued.operation.id } }))
        .some((event) => event.type === 'operation.succeeded'))
    } catch (error) {
      primaryError = error
    } finally {
      const cleanupErrors = []
      try { await stopRunner(child) } catch (error) { cleanupErrors.push(error) }
      for (const operationId of cleanupOperations) {
        try { await settleCaseOperation(db, cleanupWorld, operationId, 'face-finally') }
        catch (error) { cleanupErrors.push(error) }
      }
      try { await db.$disconnect() } catch (error) { cleanupErrors.push(error) }
      try {
        const canonical = await realpath(root).catch(() => null)
        if (canonical && isAbsolute(canonical)) {
          const offset = relative(resolve(tmpdir()), canonical)
          if (offset && !offset.startsWith('..') && !isAbsolute(offset)) {
            await rm(canonical, { recursive: true, force: true })
          }
        }
      } catch (error) { cleanupErrors.push(error) }
      if (primaryError && cleanupErrors.length) {
        throw new AggregateError([primaryError, ...cleanupErrors], 'face test and cleanup failed')
      }
      if (primaryError) throw primaryError
      if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'face cleanup failed')
    }
  })

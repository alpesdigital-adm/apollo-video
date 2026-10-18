import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { enqueueFaceWindowRunService } from '../../src/v2/application/enqueue-face-window-run.ts'
import { runNextFaceWindowOperationService } from '../../src/v2/application/run-face-window-worker.ts'
import { createFaceProducerEnvelopeV2 } from '../../src/v2/domain/face-producer-envelope-v2.ts'
import { PrismaFaceProducerEnvelopeRepository } from '../../src/v2/infrastructure/prisma/face-producer-envelope-repository.ts'
import { PrismaFaceWindowEnvelopeRepository } from '../../src/v2/infrastructure/prisma/face-window-envelope-repository.ts'
import { PrismaFaceWindowRequestContextRepository } from '../../src/v2/infrastructure/prisma/perception-producer-request-context-repository.ts'
import { PrismaPublicOperationRepository } from '../../src/v2/infrastructure/prisma/public-operation-repository.ts'
import { acceptedProducer, detectorConfig, observedSample, unknownSample } from './helpers/face-envelope-v2.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'
import { cancelProducerFenceCase, verifyProducerPublishFences } from './helpers/producer-publish-lock-race.mjs'

/**
 * W62 PostgreSQL proof of the owner-accepted V9 face window profile (written for a supervised run; not run in CI).
 *
 * What it must establish, in a database and not in a stand-in:
 *  - the YuNet diagnostic and the V9 profile never claim, publish or read each other's operations or envelopes;
 *  - a window is sealed together with its raw detector outputs, in the transaction that completes the operation;
 *  - the same fences the other producers have (lease, rights, head version) hold for the window publish;
 *  - the table CHECKs refuse an unbounded window and a half-formed raw output;
 *  - every tamper (content, hash, raw bytes, a missing raw row, source, rights) is caught on read.
 */
const WINDOW = Object.freeze({ startTimelineFrame: 100, endTimelineFrame: 250 })
const CHECK_FAILURE = /check constraint|constraint failed|violates/i

function actorFor(world) {
  const auditContext = createExternalAuditContext({ clientId: world.clientId, credentialId: `face-window-credential-${world.suffix}`,
    workspaceId: world.workspaceId, environment: 'production' })
  return { ...auditContext, scopes: new Set(['projects:write', 'projects:read', 'operations:cancel']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false, clientAccessStatus: 'active',
    workspaceAccessStatus: 'active', auditContext }
}

/** The detector stand-in: real V9 tensors for every sampled frame of the claimed window, one failed frame. */
function analyzerFor({ producer = acceptedProducer(), failFrame = 130 } = {}) {
  return {
    analyze: async (request) => {
      const first = Math.ceil(request.sourceInFrame / request.sampleIntervalFrames) * request.sampleIntervalFrames
      const built = []
      for (let frame = first; frame < request.sourceOutFrame; frame += request.sampleIntervalFrames) {
        built.push(frame === failFrame
          ? { sample: unknownSample({ timelineFrame: frame, sourceFrame: frame }), raw: null }
          : observedSample({ timelineFrame: frame, sourceFrame: frame, rows: frame % 10 === 0 ? [[0.9, 0.2, 0.2, 0.4, 0.6]] : [] }))
      }
      return {
        sourceFps: { num: 30, den: 1 }, sourceTimebase: { num: 1, den: 15360 }, sourcePtsStart: 0, sourceClock: 'constant-frame-rate',
        sourcePtsRounding: 'nearest', sourceWidth: 1280, sourceHeight: 720, sourceOrientation: 'rotation-0-exif-neutral',
        detectorConfig: { ...detectorConfig }, producer,
        samples: built.map(({ sample: { timelineFrame: _unused, ...rest } }) => rest),
        rawOutputs: built.map(({ raw }) => raw),
      }
    },
  }
}
const materializer = { materialize: async (request) => ({ path: 'C:/private/face-window-source.mp4', sha256: request.sha256, byteSize: request.byteSize }), cleanup: async () => {} }

function harness(db, world) {
  const operations = new PrismaPublicOperationRepository(db)
  const operationIds = []
  const enqueue = async (label, window = WINDOW) => {
    const queued = await enqueueFaceWindowRunService({
      context: new PrismaFaceWindowRequestContextRepository(db), operations,
      createOperationId: () => `face-operation-${randomUUID()}`,
    })({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
      sourceArtifactId: world.sourceId, window, actor: actorFor(world), idempotencyKey: `face-window-${label}-${world.suffix}` })
    operationIds.push(queued.operation.id)
    return queued.operation.id
  }
  const worker = (analyzer = analyzerFor()) => runNextFaceWindowOperationService({
    repository: new PrismaFaceWindowEnvelopeRepository(db), materializer, analyzer })
  const cleanup = async () => {
    const failures = []
    for (const operationId of operationIds) {
      try { await cancelProducerFenceCase(db, operations, world, actorFor(world), operationId, 'face-window-cleanup') }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'face window cleanup failed')
  }
  return { operations, enqueue, worker, cleanup }
}

async function finish(db, cleanup, primaryError) {
  let cleanupError
  try { await cleanup() } catch (error) { cleanupError = error }
  try { await db.$disconnect() } catch (error) { cleanupError = cleanupError ? new AggregateError([cleanupError, error]) : error }
  if (primaryError && cleanupError) throw new AggregateError([primaryError, cleanupError], 'face window test and cleanup failed')
  if (primaryError) throw primaryError
  if (cleanupError) throw cleanupError
}

test('W62 PostgreSQL face window: admission refuses what cannot be observed and the table CHECKs hold',
  { skip: !process.env.V2_DATABASE_URL, timeout: 180_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = harness(db, world)
      const context = new PrismaFaceWindowRequestContextRepository(db)
      const admitted = await context.read({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId, sourceArtifactId: world.sourceId })
      assert.equal(admitted?.timelineFps, 30)
      assert.equal(admitted?.timelineDurationFrames, 900)
      assert.equal(await context.read({ workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId, sourceArtifactId: `other-${randomUUID()}` }), null)
      assert.equal(await context.read({ workspaceId: world.otherWorkspaceId, projectId: world.projectId, projectVersionId: world.versionId, sourceArtifactId: world.sourceId }), null)
      await assert.rejects(run.enqueue('past-end', { startTimelineFrame: 850, endTimelineFrame: 901 }), { code: 'INVALID_ARGUMENT' })
      await assert.rejects(run.enqueue('too-long', { startTimelineFrame: 0, endTimelineFrame: 301 }), { code: 'INVALID_ARGUMENT' })

      const operationId = await run.enqueue('checks')
      const stored = await db.v2FaceProducerOperation.findUniqueOrThrow({ where: { operationId } })
      assert.equal(stored.detectorProfile, 'openvino-face0204-v9')
      assert.equal(stored.windowStartTimelineFrame, WINDOW.startTimelineFrame)
      assert.equal(stored.windowEndTimelineFrame, WINDOW.endTimelineFrame)
      assert.equal(stored.sampleIntervalFrames, 5)
      // a replayed request is the same operation
      assert.equal(await run.enqueue('checks'), operationId)

      const refused = (data) => assert.rejects(db.v2FaceProducerOperation.update({ where: { operationId }, data }), (error) => CHECK_FAILURE.test(String(error?.message)))
      await refused({ windowEndTimelineFrame: WINDOW.startTimelineFrame + 301 })
      await refused({ windowEndTimelineFrame: WINDOW.startTimelineFrame })
      await refused({ windowStartTimelineFrame: null })
      await refused({ detectorProfile: 'yunet-v5-diagnostic' })
      await refused({ detectorProfile: 'unknown-profile' })
      const unchanged = await db.v2FaceProducerOperation.findUniqueOrThrow({ where: { operationId } })
      assert.deepEqual([unchanged.detectorProfile, unchanged.windowStartTimelineFrame, unchanged.windowEndTimelineFrame],
        ['openvino-face0204-v9', WINDOW.startTimelineFrame, WINDOW.endTimelineFrame])
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

test('W62 PostgreSQL face window: profile isolation, sealed publish with raw outputs, fenced read and tamper refusals',
  { skip: !process.env.V2_DATABASE_URL, timeout: 240_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = harness(db, world)
      const operationId = await run.enqueue('publish')

      // The YuNet repository does not see a V9 operation: it can claim others, never this one, and leaves it queued.
      const legacy = new PrismaFaceProducerEnvelopeRepository(db)
      const legacyClaim = await legacy.claimNext({ leaseOwner: `legacy-${world.suffix}`, now: new Date(), leaseMs: 30_000 })
      assert.notEqual(legacyClaim?.operationId, operationId)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).status, 'queued')

      const result = await run.worker()(`face-window-worker-${world.suffix}`)
      assert.equal(result?.status, 'succeeded')
      assert.equal(result?.operationId, operationId)

      const row = await db.v2FaceProducerEnvelope.findFirstOrThrow({ where: { operationId } })
      assert.equal(row.schemaVersion, 'face-producer-envelope/v2')
      assert.deepEqual([row.windowStartTimelineFrame, row.windowEndTimelineFrame], [WINDOW.startTimelineFrame, WINDOW.endTimelineFrame])
      const raws = await db.v2FaceProducerRawOutput.findMany({ where: { envelopeId: row.id }, orderBy: { sampleIndex: 'asc' } })
      assert.ok(raws.length >= 29 && raws.length <= 30, '30 sampled frames, at most one failed and without a raw output')
      assert.ok(raws.every((raw) => raw.rawBytes.length === 5600 && raw.workspaceId === world.workspaceId))
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).leaseOwner, null)
      assert.ok((await db.v2PublicEventOutbox.findMany({ where: { workspaceId: world.workspaceId, resourceId: operationId } }))
        .some((event) => event.type === 'operation.succeeded'))

      const repository = new PrismaFaceWindowEnvelopeRepository(db)
      const input = { id: row.id, workspaceId: world.workspaceId, projectId: world.projectId, inputVersionId: world.versionId, now: new Date() }
      const stored = await repository.read(input)
      assert.equal(stored.envelope.schemaVersion, 'face-producer-envelope/v2')
      assert.equal(stored.envelope.faceSafety, 'unknown')
      assert.equal(stored.envelope.identity, 'not-performed')
      assert.equal(stored.envelope.coverage, 'sampled-only')
      assert.equal(stored.authentication.authenticated, true)
      assert.equal(stored.envelope.producer.assessment.status, 'owner-accepted-scoped')
      assert.deepEqual(stored.envelope.window, WINDOW)
      assert.equal(stored.envelope.samples.length, 30)
      assert.equal(raws.length, stored.envelope.samples.filter((sample) => sample.rawOutput !== null).length)
      assert.equal(await repository.read({ ...input, id: `missing-${randomUUID()}` }), null)
      assert.equal(await repository.read({ ...input, inputVersionId: `stale-${randomUUID()}` }), null)
      assert.equal(await repository.read({ ...input, workspaceId: world.otherWorkspaceId }), null)
      // the YuNet reader refuses a V9 envelope outright
      await assert.rejects(legacy.read(input), { code: 'PERSISTENCE_CONFLICT' })

      // listing: overlap, not containment, oldest window first; a range outside the window finds nothing
      const base = { workspaceId: world.workspaceId, projectId: world.projectId, projectVersionId: world.versionId, sourceArtifactId: world.sourceId, now: new Date() }
      assert.deepEqual((await repository.listWindows({ ...base, fromTimelineFrame: 249, toTimelineFrame: 300 })).map((item) => item.envelope.id), [row.id])
      assert.deepEqual((await repository.listWindows({ ...base, fromTimelineFrame: 0, toTimelineFrame: 101 })).map((item) => item.envelope.id), [row.id])
      assert.equal((await repository.listWindows({ ...base, fromTimelineFrame: 250, toTimelineFrame: 400 })).length, 0)
      assert.equal((await repository.listWindows({ ...base, fromTimelineFrame: 0, toTimelineFrame: 100 })).length, 0)
      assert.equal((await repository.listWindows({ ...base, workspaceId: world.otherWorkspaceId, fromTimelineFrame: 0, toTimelineFrame: 900 })).length, 0)

      // a raw output with the wrong shape never reaches the table
      await assert.rejects(db.v2FaceProducerRawOutput.create({ data: { id: `face-raw-short-${randomUUID()}`, workspaceId: world.workspaceId,
        envelopeId: row.id, sampleIndex: 59, timelineFrame: 1, sha256: 'a'.repeat(64), rawBytes: Buffer.alloc(5599), createdAt: new Date() } }),
      (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceProducerRawOutput.create({ data: { id: `face-raw-index-${randomUUID()}`, workspaceId: world.workspaceId,
        envelopeId: row.id, sampleIndex: 60, timelineFrame: 1, sha256: 'a'.repeat(64), rawBytes: Buffer.alloc(5600), createdAt: new Date() } }),
      (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceProducerEnvelope.update({ where: { id: row.id }, data: { schemaVersion: 'face-producer-envelope/v1' } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))

      // tamper: raw bytes, a missing raw row, content, hashes, source, rights - each one is caught on read
      const target = raws[1]
      const flipped = Buffer.from(target.rawBytes); flipped[3] ^= 1
      await db.v2FaceProducerRawOutput.update({ where: { id: target.id }, data: { rawBytes: flipped } })
      await assert.rejects(repository.read(input), /raw output/i)
      await db.v2FaceProducerRawOutput.update({ where: { id: target.id }, data: { rawBytes: target.rawBytes } })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      await db.v2FaceProducerRawOutput.delete({ where: { id: target.id } })
      await assert.rejects(repository.read(input), /raw output/i)
      await db.v2FaceProducerRawOutput.create({ data: target })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      const originalContent = row.contentJson
      for (const mutate of [
        (value) => { value.producer.model.xmlSha256 = 'f'.repeat(64) },
        (value) => { value.samples[0].imageSha256 = 'f'.repeat(64) },
        (value) => { value.window.endTimelineFrame -= 5 },
        (value) => { value.faceSafety = 'safe' },
      ]) {
        const altered = JSON.parse(originalContent)
        mutate(altered)
        await db.v2FaceProducerEnvelope.update({ where: { id: row.id }, data: { contentJson: JSON.stringify(altered) } })
        await assert.rejects(repository.read(input), { code: 'PERSISTENCE_CONFLICT' })
      }
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id }, data: { contentJson: originalContent } })
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id }, data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /integrity|hash/i)
      await db.v2FaceProducerEnvelope.update({ where: { id: row.id }, data: { envelopeHash: row.envelopeHash } })

      const sourceSha = world.sourceSha256
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /source|hash/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: sourceSha } })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: null, rightsRevision: { increment: 1 } } })
      await assert.rejects(repository.read(input), { code: 'ASSET_RIGHTS_BLOCKED' })
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

test('W62 PostgreSQL face window: an unauthenticated producer and a foreign window are refused atomically; lease, rights and head fences hold',
  { skip: !process.env.V2_DATABASE_URL, timeout: 360_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = harness(db, world)

      // A producer on a platform without a parity receipt completes nothing and stores nothing.
      const linuxId = await run.enqueue('linux')
      const linux = await run.worker(analyzerFor({ producer: acceptedProducer('linux') }))(`face-window-linux-${world.suffix}`)
      assert.equal(linux?.status, 'attempt-failed')
      assert.equal(linux?.settled, true)
      const failed = await db.v2PublicOperation.findUniqueOrThrow({ where: { id: linuxId } })
      assert.equal(failed.status, 'failed')
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId: linuxId } }), 0)
      assert.equal(await db.v2FaceProducerRawOutput.count({ where: { workspaceId: world.workspaceId } }), 0)

      // The accepted producer publishes; its envelope is the base the fence cases clone.
      const baseOperationId = await run.enqueue('base')
      assert.equal((await run.worker()(`face-window-base-${world.suffix}`))?.status, 'succeeded')
      const baseRow = await db.v2FaceProducerEnvelope.findFirstOrThrow({ where: { operationId: baseOperationId } })
      const repository = new PrismaFaceWindowEnvelopeRepository(db)
      const { envelope } = await repository.read({ id: baseRow.id, workspaceId: world.workspaceId, projectId: world.projectId,
        inputVersionId: world.versionId, now: new Date() })
      const { schemaVersion, authority, coverage, faceSafety, identity, timeMapHash, detectorConfigHash, envelopeHash, ...baseInput } = envelope
      const rawByIndex = (await db.v2FaceProducerRawOutput.findMany({ where: { envelopeId: baseRow.id }, orderBy: { sampleIndex: 'asc' } }))
      const rawOutputs = envelope.samples.map((sample, index) => sample.rawOutput === null ? null
        : new Uint8Array(rawByIndex.find((raw) => raw.sampleIndex === index).rawBytes))
      const clone = ({ operationId, attempt, fenceHash }, overrides = {}) => createFaceProducerEnvelopeV2({ ...baseInput,
        id: `face-envelope-${randomUUID()}`, operationId, operationAttempt: attempt, operationFenceHash: fenceHash,
        createdAt: new Date().toISOString(), ...overrides })

      // A sealed result for another window than the operation asked for is a different request.
      const foreignId = await run.enqueue('foreign', { startTimelineFrame: 300, endTimelineFrame: 450 })
      const foreignOwner = `face-window-foreign-${world.suffix}`
      const foreignClaim = await repository.claimNext({ leaseOwner: foreignOwner, now: new Date(), leaseMs: 120_000 })
      assert.equal(foreignClaim?.operationId, foreignId)
      assert.deepEqual(foreignClaim.window, { startTimelineFrame: 300, endTimelineFrame: 450 })
      for (const phase of ['analyzing', 'verifying', 'persisting']) {
        assert.equal(await repository.advancePhase({ operationId: foreignId, attempt: foreignClaim.attempt, leaseOwner: foreignOwner, now: new Date(), phase }), true)
      }
      const foreignFence = await repository.currentFenceHash({ operationId: foreignId, attempt: foreignClaim.attempt, leaseOwner: foreignOwner, now: new Date() })
      const foreign = clone({ operationId: foreignId, attempt: foreignClaim.attempt, fenceHash: foreignFence })
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: foreignOwner, now: new Date() }), /context differs|sealed result/i)
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: `wrong-${foreignOwner}`, now: new Date() }), /fenc|held|lease/i)
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId: foreignId } }), 0)
      assert.equal(await db.v2FaceProducerRawOutput.count({ where: { envelope: { operationId: foreignId } } }), 0)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: foreignId } })).status, 'running')

      // Lease takeover: the expired owner can no longer publish, the successor can.
      const successorOwner = `face-window-successor-${world.suffix}`
      const expiredAt = new Date(Date.now() + 130_000)
      const successor = await repository.claimNext({ leaseOwner: successorOwner, now: expiredAt, leaseMs: 120_000 })
      assert.equal(successor?.operationId, foreignId)
      assert.equal(successor?.attempt, foreignClaim.attempt + 1)
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: foreignOwner, now: expiredAt }), /fenc|held|lease/i)

      // The three publish fences, with the real PostgreSQL lock waits, through the same harness the other producers use.
      class WindowRepository extends PrismaFaceWindowEnvelopeRepository {
        publish(input) { return super.publish({ ...input, rawOutputs }) }
      }
      await verifyProducerPublishFences({ db, world, repository: new WindowRepository(db), Repository: WindowRepository,
        label: 'facewin', phases: ['analyzing', 'verifying', 'persisting'], envelopeModel: 'v2FaceProducerEnvelope',
        enqueue: (label) => run.enqueue(label), cloneEnvelope: (claim) => clone(claim),
        cancel: (operationId) => cancelProducerFenceCase(db, run.operations, world, actorFor(world), operationId, 'facewin-fence') })
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

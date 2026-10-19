import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { createAssetRightsSnapshot } = await import('../../src/v2/domain/asset-rights.ts')
const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { createFaceProducerEnvelopeV3 } = await import('../../src/v2/domain/face-producer-envelope-v3.ts')
const { PrismaFaceProducerEnvelopeRepository } = await import('../../src/v2/infrastructure/prisma/face-producer-envelope-repository.ts')
const { PrismaFaceSourceWindowRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-repository.ts')
const { PrismaFaceSourceWindowRequestContextRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-request-context-repository.ts')
const { PrismaFaceWindowEnvelopeRepository } = await import('../../src/v2/infrastructure/prisma/face-window-envelope-repository.ts')
import { acceptedProducer } from './helpers/face-envelope-v2.mjs'
import { actorFor, directorCut, finish, peerProject, sourceAnalyzerFor, sourceWindowHarness } from './helpers/face-source-pg.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'
import { RECORDING_ALLOWED_USES } from './helpers/pg-output-world.mjs'
import { cancelProducerFenceCase, commitFenceChildVersion, fenceRightsRow, verifyProducerPublishFences } from './helpers/producer-publish-lock-race.mjs'

/**
 * W65b PostgreSQL proof of the SOURCE-keyed V9 face windows (written for a supervised run; not run in CI).
 *
 * What it must establish, in a database and not in a stand-in:
 *  - admission asks only what is true of the source: it is played by the project, attached to it, an available video with an integer
 *    frame rate and rights that allow analysis; the window must lie inside the source and hold a sampled frame;
 *  - the three detector profiles never claim, publish or read each other's operations or envelopes;
 *  - a window is sealed together with its raw detector outputs in the transaction that completes the operation, and the table CHECKs
 *    refuse an unbounded window or a half-formed raw output;
 *  - THE POINT OF THE PROFILE: the evidence belongs to the source. It is read, unchanged, by every Version of the project (a Director
 *    cut that did not exist when it was produced) and by every project of the workspace that has the source - and by nobody else;
 *  - at every use the source identity is re-verified, the rights are re-evaluated for the CONSUMING project's locale, and every tamper
 *    (content, hash, raw bytes, a missing raw row) is refused;
 *  - the lease and rights fences hold on publish, a producer the registry does not authenticate publishes nothing, and - unlike the
 *    timeline profile - a head Version that moved is NOT a reason to lose evidence about the source.
 */
const WINDOW = Object.freeze({ startSourceFrame: 100, endSourceFrame: 250 })
const CHECK_FAILURE = /check constraint|constraint failed|violates/i
const CUT = Object.freeze([
  { sourceInFrame: 280, sourceOutFrame: 330, timelineInFrame: 0, timelineOutFrame: 50 },
  { sourceInFrame: 120, sourceOutFrame: 220, timelineInFrame: 50, timelineOutFrame: 150 },
])

test('W65b PostgreSQL face source window: admission refuses what cannot be observed and the table CHECKs hold',
  { skip: !process.env.V2_DATABASE_URL, timeout: 240_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = sourceWindowHarness(db, world)
      const context = new PrismaFaceSourceWindowRequestContextRepository(db)
      const ask = { workspaceId: world.workspaceId, projectId: world.projectId, sourceArtifactId: world.sourceId }
      const admitted = await context.read(ask)
      assert.equal(admitted?.sourceFps, 30)
      assert.equal(admitted?.sourceDurationFrames, 900)
      assert.equal(admitted?.sourceSha256, world.sourceSha256)
      assert.equal(admitted?.projectVersionId, world.versionId, 'the Version is only the audit context of the request')
      assert.equal(await context.read({ ...ask, sourceArtifactId: `other-${randomUUID()}` }), null)
      assert.equal(await context.read({ ...ask, workspaceId: world.otherWorkspaceId }), null)
      // a project that has no such source does not get to ask; one that has it attached but does not play it neither
      const noSource = await peerProject(db, world, { attach: false, label: 'admission-none' })
      assert.equal(await context.read({ ...ask, projectId: noSource.projectId }), null)
      const notPlayed = await peerProject(db, world, { label: 'admission-attached' })
      assert.equal(await context.read({ ...ask, projectId: notPlayed.projectId }), null, 'the project must play the source to request evidence of it')
      await assert.rejects(run.enqueue('not-played', WINDOW, { projectId: notPlayed.projectId }), { code: 'PRECONDITION_REQUIRED' })

      await assert.rejects(run.enqueue('past-end', { startSourceFrame: 850, endSourceFrame: 901 }), { code: 'INVALID_ARGUMENT' })
      await assert.rejects(run.enqueue('too-long', { startSourceFrame: 0, endSourceFrame: 301 }), { code: 'INVALID_ARGUMENT' })
      await assert.rejects(run.enqueue('no-sample', { startSourceFrame: 101, endSourceFrame: 104 }), { code: 'INVALID_ARGUMENT' })
      await assert.rejects(run.enqueue('empty', { startSourceFrame: 100, endSourceFrame: 100 }), { code: 'INVALID_ARGUMENT' })

      const queued = await run.enqueue('checks', WINDOW)
      const operationId = queued.operation.id
      const stored = await db.v2FaceProducerOperation.findUniqueOrThrow({ where: { operationId } })
      assert.equal(stored.detectorProfile, 'openvino-face0204-v9-source')
      assert.equal(stored.windowStartSourceFrame, WINDOW.startSourceFrame)
      assert.equal(stored.windowEndSourceFrame, WINDOW.endSourceFrame)
      assert.equal(stored.windowStartTimelineFrame, null)
      assert.equal(stored.windowEndTimelineFrame, null)
      assert.equal(stored.sampleIntervalFrames, 5)
      assert.equal(stored.projectVersionId, world.versionId)
      assert.equal(stored.sourceSha256, world.sourceSha256)
      // a replayed request is the same operation
      const replay = await run.enqueue('checks', WINDOW)
      assert.equal(replay.operation.id, operationId)
      assert.equal(replay.replayed, true)

      const refused = (data) => assert.rejects(db.v2FaceProducerOperation.update({ where: { operationId }, data }), (error) => CHECK_FAILURE.test(String(error?.message)))
      await refused({ windowEndSourceFrame: WINDOW.startSourceFrame + 301 })
      await refused({ windowEndSourceFrame: WINDOW.startSourceFrame })
      await refused({ windowStartSourceFrame: -1 })
      await refused({ windowStartSourceFrame: null })
      await refused({ windowStartTimelineFrame: 0, windowEndTimelineFrame: 10 })
      await refused({ detectorProfile: 'yunet-v5-diagnostic' })
      await refused({ detectorProfile: 'openvino-face0204-v9' })
      await refused({ detectorProfile: 'unknown-profile' })
      const unchanged = await db.v2FaceProducerOperation.findUniqueOrThrow({ where: { operationId } })
      assert.deepEqual([unchanged.detectorProfile, unchanged.windowStartSourceFrame, unchanged.windowEndSourceFrame],
        ['openvino-face0204-v9-source', WINDOW.startSourceFrame, WINDOW.endSourceFrame])
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

test('W65b PostgreSQL face source window: profile isolation, sealed publish, reuse by every Version and sibling project, fenced read and tamper refusals',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = sourceWindowHarness(db, world)
      const queued = await run.enqueue('publish', WINDOW)
      const operationId = queued.operation.id

      // The other two profiles do not see this operation: they can claim others, never this one, and leave it queued.
      const yunet = new PrismaFaceProducerEnvelopeRepository(db)
      const yunetClaim = await yunet.claimNext({ leaseOwner: `yunet-${world.suffix}`, now: new Date(), leaseMs: 30_000 })
      assert.notEqual(yunetClaim?.operationId, operationId)
      const timeline = new PrismaFaceWindowEnvelopeRepository(db)
      const timelineClaim = await timeline.claimNext({ leaseOwner: `timeline-${world.suffix}`, now: new Date(), leaseMs: 30_000 })
      assert.notEqual(timelineClaim?.operationId, operationId)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).status, 'queued')

      const result = await run.worker()(`face-source-worker-${world.suffix}`)
      assert.equal(result?.status, 'succeeded')
      assert.equal(result?.operationId, operationId)

      const row = await db.v2FaceSourceWindowEnvelope.findFirstOrThrow({ where: { operationId } })
      assert.equal(row.schemaVersion, 'face-producer-envelope/v3')
      assert.deepEqual([row.windowStartSourceFrame, row.windowEndSourceFrame], [WINDOW.startSourceFrame, WINDOW.endSourceFrame])
      assert.equal(row.sourceArtifactId, world.sourceId)
      assert.equal(row.sourceSha256, world.sourceSha256)
      assert.equal(await db.v2FaceProducerEnvelope.count({ where: { operationId } }), 0, 'nothing is written to the timeline-keyed table')
      const raws = await db.v2FaceSourceWindowRawOutput.findMany({ where: { envelopeId: row.id }, orderBy: { sampleIndex: 'asc' } })
      assert.equal(raws.length, 30, 'one 5600-byte tensor for each of the 30 sampled frames')
      assert.ok(raws.every((raw) => raw.rawBytes.length === 5600 && raw.workspaceId === world.workspaceId))
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: operationId } })).leaseOwner, null)
      assert.ok((await db.v2PublicEventOutbox.findMany({ where: { workspaceId: world.workspaceId, resourceId: operationId } }))
        .some((event) => event.type === 'operation.succeeded'))

      const repository = new PrismaFaceSourceWindowRepository(db)
      const input = { id: row.id, workspaceId: world.workspaceId, projectId: world.projectId, now: new Date() }
      const stored = await repository.read(input)
      assert.equal(stored.envelope.schemaVersion, 'face-producer-envelope/v3')
      assert.equal(stored.envelope.faceSafety, 'unknown')
      assert.equal(stored.envelope.identity, 'not-performed')
      assert.equal(stored.envelope.coverage, 'sampled-only')
      assert.equal(stored.authentication.authenticated, true)
      assert.equal(stored.envelope.producer.assessment.status, 'owner-accepted-scoped')
      assert.deepEqual(stored.envelope.window, WINDOW)
      assert.equal(stored.envelope.sourceArtifactId, world.sourceId)
      assert.deepEqual(stored.envelope.sourceFps, { num: 30, den: 1 })
      assert.equal(stored.envelope.samples.length, 30)
      assert.ok(!('projectId' in stored.envelope) && !('projectVersionId' in stored.envelope) && !('timeMap' in stored.envelope),
        'the evidence names no project, version or time map')
      assert.equal(raws.length, stored.envelope.samples.filter((sample) => sample.rawOutput !== null).length)
      assert.equal(await repository.read({ ...input, id: `missing-${randomUUID()}` }), null)
      assert.equal(await repository.read({ ...input, workspaceId: world.otherWorkspaceId }), null)
      const noSource = await peerProject(db, world, { attach: false, label: 'read-none' })
      assert.equal(await repository.read({ ...input, projectId: noSource.projectId }), null, 'a project that does not have the source cannot read evidence of it')

      // ---- reuse: the Version the window was requested under is not part of the evidence -----------------------------------
      const peer = await peerProject(db, world, { label: 'read-peer' })
      assert.equal((await repository.read({ ...input, projectId: peer.projectId })).envelope.envelopeHash, row.envelopeHash, 'a sibling project reads the same window')
      const cut = await directorCut(db, world, CUT)
      assert.notEqual(cut.versionId, world.versionId)
      assert.equal((await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })).currentVersionId, cut.versionId)
      assert.equal((await repository.read(input)).envelope.envelopeHash, row.envelopeHash, 'the Director cut that did not exist when it was produced reads the same window')
      // the operation read still works for the Version it was requested under, and the new head can ask again for its own windows
      const reference = await new PrismaFaceSourceWindowRequestContextRepository(db).readEnvelopeId({ workspaceId: world.workspaceId, projectId: world.projectId, operationId })
      assert.equal(reference?.id, row.id)
      assert.equal(await new PrismaFaceSourceWindowRequestContextRepository(db).readEnvelopeId({ workspaceId: world.workspaceId, projectId: peer.projectId, operationId }), null,
        'the operation belongs to the project that requested it')
      assert.equal(await new PrismaFaceSourceWindowRequestContextRepository(db).readEnvelopeId({ workspaceId: world.otherWorkspaceId, projectId: world.projectId, operationId }), null)
      const readmitted = await new PrismaFaceSourceWindowRequestContextRepository(db).read({ workspaceId: world.workspaceId, projectId: world.projectId, sourceArtifactId: world.sourceId })
      assert.equal(readmitted?.projectVersionId, cut.versionId)

      // ---- listing, in the source's own frames: overlap, not containment, oldest window first ------------------------------
      const base = { workspaceId: world.workspaceId, projectId: world.projectId, sourceArtifactId: world.sourceId, now: new Date() }
      assert.deepEqual((await repository.listSourceWindows({ ...base, fromSourceFrame: 249, toSourceFrame: 300 })).map((item) => item.envelope.id), [row.id])
      assert.deepEqual((await repository.listSourceWindows({ ...base, fromSourceFrame: 0, toSourceFrame: 101 })).map((item) => item.envelope.id), [row.id])
      assert.deepEqual((await repository.listSourceWindows({ ...base, projectId: peer.projectId, fromSourceFrame: 0, toSourceFrame: 900 })).map((item) => item.envelope.id), [row.id])
      assert.equal((await repository.listSourceWindows({ ...base, fromSourceFrame: 250, toSourceFrame: 400 })).length, 0)
      assert.equal((await repository.listSourceWindows({ ...base, fromSourceFrame: 0, toSourceFrame: 100 })).length, 0)
      assert.equal((await repository.listSourceWindows({ ...base, workspaceId: world.otherWorkspaceId, fromSourceFrame: 0, toSourceFrame: 900 })).length, 0)
      assert.equal((await repository.listSourceWindows({ ...base, projectId: noSource.projectId, fromSourceFrame: 0, toSourceFrame: 900 })).length, 0)
      assert.equal((await repository.listSourceWindows({ ...base, sourceArtifactId: `other-${randomUUID()}`, fromSourceFrame: 0, toSourceFrame: 900 })).length, 0)

      // ---- table shapes: nothing malformed reaches the tables ---------------------------------------------------------------
      const rawRow = { workspaceId: world.workspaceId, envelopeId: row.id, sha256: 'a'.repeat(64), createdAt: new Date() }
      await assert.rejects(db.v2FaceSourceWindowRawOutput.create({ data: { ...rawRow, id: `face-source-raw-short-${randomUUID()}`, sampleIndex: 59, sourceFrame: 1, rawBytes: Buffer.alloc(5599) } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceSourceWindowRawOutput.create({ data: { ...rawRow, id: `face-source-raw-index-${randomUUID()}`, sampleIndex: 60, sourceFrame: 1, rawBytes: Buffer.alloc(5600) } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceSourceWindowRawOutput.create({ data: { ...rawRow, id: `face-source-raw-frame-${randomUUID()}`, sampleIndex: 58, sourceFrame: -1, rawBytes: Buffer.alloc(5600) } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { schemaVersion: 'face-producer-envelope/v2' } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { windowEndSourceFrame: row.windowStartSourceFrame + 301 } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))
      await assert.rejects(db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { windowEndSourceFrame: row.windowStartSourceFrame } }),
        (error) => CHECK_FAILURE.test(String(error?.message)))

      // ---- tamper: raw bytes, a missing raw row, content, hashes, source, rights - each one is caught on read -----------------
      const target = raws[1]
      const flipped = Buffer.from(target.rawBytes); flipped[3] ^= 1
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: target.id }, data: { rawBytes: flipped } })
      await assert.rejects(repository.read(input), /raw output/i)
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: target.id }, data: { rawBytes: target.rawBytes } })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      await db.v2FaceSourceWindowRawOutput.delete({ where: { id: target.id } })
      await assert.rejects(repository.read(input), /raw output/i)
      await db.v2FaceSourceWindowRawOutput.create({ data: target })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      const originalContent = row.contentJson
      for (const mutate of [
        (value) => { value.producer.model.xmlSha256 = 'f'.repeat(64) },
        (value) => { value.samples[0].imageSha256 = 'f'.repeat(64) },
        (value) => { value.window.endSourceFrame -= 5 },
        (value) => { value.sourceSha256 = 'f'.repeat(64) },
        (value) => { value.faceSafety = 'safe' },
      ]) {
        const altered = JSON.parse(originalContent)
        mutate(altered)
        await db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { contentJson: JSON.stringify(altered) } })
        await assert.rejects(repository.read(input), { code: 'PERSISTENCE_CONFLICT' })
      }
      await db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { contentJson: originalContent } })
      await db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /integrity|hash/i)
      await db.v2FaceSourceWindowEnvelope.update({ where: { id: row.id }, data: { envelopeHash: row.envelopeHash } })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      // source identity at use: the artifact of this workspace has other bytes than the window was sealed over
      const sourceSha = world.sourceSha256
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: 'f'.repeat(64) } })
      await assert.rejects(repository.read(input), /source|hash/i)
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: sourceSha } })
      assert.equal((await repository.read(input)).envelope.id, row.id)

      // rights currency at use, for the CONSUMING project's locale: the grant now covers pt-BR only
      const original = await db.v2MediaArtifact.findUniqueOrThrow({ where: { id: world.sourceId } })
      const sequence = original.rightsRevision + 1
      const ptOnly = createAssetRightsSnapshot({ id: `rights-ptbr-${world.suffix}`, workspaceId: world.workspaceId, artifactId: world.sourceId, sequence,
        draft: { status: 'approved', allowedUses: [...RECORDING_ALLOWED_USES], prohibitedUses: [], allowedLocales: ['pt-BR'],
          sourceNote: 'Controlled W65b fixture: Brazilian Portuguese only', consent: { status: 'not-required', allowedUses: [] } },
        createdBy: { type: 'user', id: 'w65b-owner' }, createdAt: new Date().toISOString() })
      await db.v2AssetRightsSnapshot.create({ data: { ...fenceRightsRow(ptOnly), allowedLocalesJson: stableSerialize(ptOnly.allowedLocales) } })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: ptOnly.id, rightsRevision: sequence } })
      assert.equal((await repository.read(input)).envelope.id, row.id, 'the project whose locale is covered keeps reading')
      const english = await peerProject(db, world, { label: 'read-en', locale: 'en-US' })
      await assert.rejects(repository.read({ ...input, projectId: english.projectId }), { code: 'ASSET_RIGHTS_BLOCKED' })
      await assert.rejects(repository.listSourceWindows({ ...base, projectId: english.projectId, fromSourceFrame: 0, toSourceFrame: 900 }), { code: 'ASSET_RIGHTS_BLOCKED' })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: original.currentRightsSnapshotId, rightsRevision: original.rightsRevision } })
      assert.equal((await repository.read({ ...input, projectId: english.projectId })).envelope.id, row.id)

      // rights revoked altogether
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: null, rightsRevision: { increment: 1 } } })
      await assert.rejects(repository.read(input), { code: 'ASSET_RIGHTS_BLOCKED' })
      await assert.rejects(repository.listSourceWindows({ ...base, fromSourceFrame: 0, toSourceFrame: 900 }), { code: 'ASSET_RIGHTS_BLOCKED' })
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

test('W65b PostgreSQL face source window: an unauthenticated producer and a foreign window are refused atomically; lease and rights fences hold and a moved head does not lose the evidence',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let world, run, primaryError
    try {
      world = await seedPerceptionProducerContext(db, { durationFrames: 900 })
      run = sourceWindowHarness(db, world)
      const operationIdOf = async (label, window = WINDOW) => (await run.enqueue(label, window)).operation.id

      // A producer on a platform without a parity receipt completes nothing and stores nothing.
      const linuxId = await operationIdOf('linux')
      const linux = await run.worker(sourceAnalyzerFor(() => [], { producer: acceptedProducer('linux') }))(`face-source-linux-${world.suffix}`)
      assert.equal(linux?.status, 'attempt-failed')
      assert.equal(linux?.settled, true)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: linuxId } })).status, 'failed')
      assert.equal(await db.v2FaceSourceWindowEnvelope.count({ where: { operationId: linuxId } }), 0)
      assert.equal(await db.v2FaceSourceWindowRawOutput.count({ where: { workspaceId: world.workspaceId } }), 0)

      // The accepted producer publishes; its envelope is the base the fence cases clone.
      const baseOperationId = await operationIdOf('base')
      assert.equal((await run.worker()(`face-source-base-${world.suffix}`))?.status, 'succeeded')
      const baseRow = await db.v2FaceSourceWindowEnvelope.findFirstOrThrow({ where: { operationId: baseOperationId } })
      const repository = new PrismaFaceSourceWindowRepository(db)
      const { envelope } = await repository.read({ id: baseRow.id, workspaceId: world.workspaceId, projectId: world.projectId, now: new Date() })
      const { schemaVersion, authority, coverage, faceSafety, identity, detectorConfigHash, envelopeHash, ...baseInput } = envelope
      void schemaVersion; void authority; void coverage; void faceSafety; void identity; void detectorConfigHash; void envelopeHash
      const rawByIndex = await db.v2FaceSourceWindowRawOutput.findMany({ where: { envelopeId: baseRow.id }, orderBy: { sampleIndex: 'asc' } })
      const rawOutputs = envelope.samples.map((sample, index) => sample.rawOutput === null ? null
        : new Uint8Array(rawByIndex.find((raw) => raw.sampleIndex === index).rawBytes))
      const clone = ({ operationId, attempt, fenceHash }, overrides = {}) => createFaceProducerEnvelopeV3({ ...baseInput,
        id: `face-source-envelope-${randomUUID()}`, operationId, operationAttempt: attempt, operationFenceHash: fenceHash,
        createdAt: new Date().toISOString(), ...overrides })

      // A sealed result for another window than the operation asked for is a different request.
      const foreignWindow = { startSourceFrame: 300, endSourceFrame: 450 }
      const foreignId = await operationIdOf('foreign', foreignWindow)
      const foreignOwner = `face-source-foreign-${world.suffix}`
      const foreignClaim = await repository.claimNext({ leaseOwner: foreignOwner, now: new Date(), leaseMs: 120_000 })
      assert.equal(foreignClaim?.operationId, foreignId)
      assert.deepEqual(foreignClaim.window, foreignWindow)
      assert.equal(foreignClaim.sourceFps, 30)
      for (const phase of ['analyzing', 'verifying', 'persisting']) {
        assert.equal(await repository.advancePhase({ operationId: foreignId, attempt: foreignClaim.attempt, leaseOwner: foreignOwner, now: new Date(), phase }), true)
      }
      const foreignFence = await repository.currentFenceHash({ operationId: foreignId, attempt: foreignClaim.attempt, leaseOwner: foreignOwner, now: new Date() })
      const foreign = clone({ operationId: foreignId, attempt: foreignClaim.attempt, fenceHash: foreignFence })
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: foreignOwner, now: new Date() }), /context differs|sealed result/i)
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: `wrong-${foreignOwner}`, now: new Date() }), /fenc|held|lease/i)
      assert.equal(await db.v2FaceSourceWindowEnvelope.count({ where: { operationId: foreignId } }), 0)
      assert.equal(await db.v2FaceSourceWindowRawOutput.count({ where: { envelope: { operationId: foreignId } } }), 0)
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: foreignId } })).status, 'running')

      // Lease takeover: the expired owner can no longer publish, the successor can.
      const successorOwner = `face-source-successor-${world.suffix}`
      const expiredAt = new Date(Date.now() + 130_000)
      const successor = await repository.claimNext({ leaseOwner: successorOwner, now: expiredAt, leaseMs: 120_000 })
      assert.equal(successor?.operationId, foreignId)
      assert.equal(successor?.attempt, foreignClaim.attempt + 1)
      await assert.rejects(repository.publish({ envelope: foreign, rawOutputs, leaseOwner: foreignOwner, now: expiredAt }), /fenc|held|lease/i)

      // The lease and rights publish fences, with the real PostgreSQL lock waits, through the same harness the other producers use.
      // (`head` is left out on purpose: see below.)
      class SourceWindowRepository extends PrismaFaceSourceWindowRepository {
        publish(publishInput) { return super.publish({ ...publishInput, rawOutputs }) }
      }
      await verifyProducerPublishFences({ db, world, repository: new SourceWindowRepository(db), Repository: SourceWindowRepository,
        label: 'facesrc', phases: ['analyzing', 'verifying', 'persisting'], envelopeModel: 'v2FaceSourceWindowEnvelope', kinds: ['lease', 'rights'],
        enqueue: (label) => operationIdOf(label), cloneEnvelope: (claim) => clone(claim),
        cancel: (operationId) => cancelProducerFenceCase(db, run.operations, world, actorFor(world), operationId, 'facesrc-fence') })

      // A moved head Version is NOT a fence for evidence about the source: the head moves to another Version between the request and the
      // claim, and again between the claim and the publish - and the window is still sealed, completed and readable.
      const headOperationId = await operationIdOf('head-moved')
      const firstChild = await commitFenceChildVersion(db, world, 'facesrc-head-before-claim')
      await db.v2Project.update({ where: { id: world.projectId }, data: { currentVersionId: firstChild.version.id } })
      const headOwner = `face-source-head-${world.suffix}`
      const headClaim = await repository.claimNext({ leaseOwner: headOwner, now: new Date(), leaseMs: 120_000 })
      assert.equal(headClaim?.operationId, headOperationId, 'the claim does not require the requesting Version to be current')
      assert.equal(headClaim.projectVersionId, world.versionId)
      for (const phase of ['analyzing', 'verifying', 'persisting']) {
        assert.equal(await repository.advancePhase({ operationId: headOperationId, attempt: headClaim.attempt, leaseOwner: headOwner, now: new Date(), phase }), true)
      }
      const secondChild = await commitFenceChildVersion(db, world, 'facesrc-head-before-publish')
      await db.v2Project.update({ where: { id: world.projectId }, data: { currentVersionId: secondChild.version.id } })
      const headFence = await repository.currentFenceHash({ operationId: headOperationId, attempt: headClaim.attempt, leaseOwner: headOwner, now: new Date() })
      const sealed = await repository.publish({ envelope: clone({ operationId: headOperationId, attempt: headClaim.attempt, fenceHash: headFence }),
        rawOutputs, leaseOwner: headOwner, now: new Date() })
      assert.equal((await db.v2PublicOperation.findUniqueOrThrow({ where: { id: headOperationId } })).status, 'succeeded')
      assert.equal(await db.v2FaceSourceWindowEnvelope.count({ where: { operationId: headOperationId } }), 1)
      const reread = await repository.read({ id: sealed.id, workspaceId: world.workspaceId, projectId: world.projectId, now: new Date() })
      assert.equal(reread.envelope.envelopeHash, sealed.envelopeHash)
      assert.equal((await db.v2Project.findUniqueOrThrow({ where: { id: world.projectId } })).currentVersionId, secondChild.version.id)
    } catch (error) {
      primaryError = error
    } finally {
      await finish(db, run?.cleanup ?? (async () => {}), primaryError)
    }
  })

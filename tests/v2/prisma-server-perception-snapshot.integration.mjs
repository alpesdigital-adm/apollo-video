import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { digest, sha } from './helpers/perception-snapshot-fixtures.mjs'
import { commitSealedChild } from './helpers/pg-output-world.mjs'
import { OCR_FRAMES, coverageOf, seedSnapshotWorld } from './helpers/server-perception-pg-world.mjs'
import { seedPerceptionProducerContext } from './helpers/perception-producer-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { calculateCanonicalHash, stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')
const { createPerceptionTimeline, PERCEPTION_KINDS } = await import('../../src/v2/domain/perception-timeline.ts')
const { serverPerceptionSnapshotId } = await import('../../src/v2/domain/server-perception-snapshot.ts')

/**
 * W63a PostgreSQL proof of the server perception snapshot (written for the supervised disposable cluster; not run in hosted CI).
 *
 * The evidence is real: OCR, temporal and source-keyed face v3 rows written by the products' own writers (admission, claim, fenced
 * publish) over a sealed Version that plays one recording. What it must establish, in a database:
 *  - the snapshot fuses all three, says per kind what was examined, and never calls an unexamined kind complete;
 *  - it is content-addressed and idempotent: the same evidence is the same row, however often and however concurrently it is asked;
 *  - another Version, workspace or project never sees this evidence, and an older Version keeps the evidence it had;
 *  - source bytes, rights and every sealed row are re-verified at read: a revoked right or a tampered row refuses the whole read;
 *  - the table itself refuses what the domain refuses (an absent kind without a reason, a complete one that examined less, a filled
 *    `object`, fewer than nine kinds), is append-only, and a row forged at INSERT time is refused by the reader.
 */
const IMMUTABLE = /immutable record/i
const CHECK_FAILURE = /check constraint|violates|constraint failed|nine kinds/i

test('W63a PostgreSQL server perception snapshot: fuses the sealed evidence, states coverage per kind, is content-addressed and idempotent',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError, built
    try {
      built = await seedSnapshotWorld(db)
      const { world, stats } = built
      const ask = { workspaceId: world.workspaceId, projectId: world.projectId }
      const first = await built.service(() => new Date('2026-10-19T12:00:00.000Z'))(ask)

      assert.equal(first.projectVersionId, world.versionId)
      assert.equal(first.origin.kind, 'server-assembled')
      assert.equal(first.origin.manualTimelinesIncluded, false)
      assert.equal(first.snapshot.schemaVersion, 'server-perception-snapshot/v1')
      assert.equal(first.snapshot.faceSafety, 'unknown')
      assert.deepEqual(first.snapshot.timeBase, { unit: 'ms', frameToMs: 'round-nearest', fps: 30, durationFrames: 120, durationMs: 4_000 })
      assert.equal(first.snapshot.editPlan.snapshotId, world.editId)
      assert.deepEqual(first.snapshot.sources, [{ artifactId: world.sourceId, sha256: world.sourceSha256 }])
      assert.deepEqual(first.result.kinds, PERCEPTION_KINDS)
      assert.equal(first.id, serverPerceptionSnapshotId(first.snapshot.snapshotHash))

      // every input is a sealed row of this Version/source, named by its id and hash
      assert.deepEqual(first.snapshot.inputs.map((input) => input.kind), ['face', 'face', 'ocr', 'temporal', 'transcript'])
      const sealed = new Map([[stats.ocr.id, stats.ocr.envelopeHash], [stats.temporal.id, stats.temporal.envelopeHash],
        ...stats.faceWindows.map((row) => [row.id, row.envelopeHash])])
      for (const input of first.snapshot.inputs) {
        assert.equal(input.sourceArtifactId, world.sourceId)
        assert.equal(input.sourceSha256, world.sourceSha256)
        if (input.kind === 'transcript') {
          // the words are the sealed EditPlan's own retimed transcript: bound to the plan, with no clock of a producer
          assert.equal(input.sourceClock, null)
          assert.equal(input.observationCount, 2)
          continue
        }
        assert.equal(sealed.get(input.envelopeId), input.envelopeHash, input.kind)
        assert.deepEqual(input.sourceClock.fps, { num: 30, den: 1 })
      }
      assert.deepEqual(first.snapshot.rejected, [])
      for (const observation of first.result.observations) {
        assert.equal(observation.provenance.origin, 'server')
        if (observation.kind === 'transcript-word') {
          assert.equal(observation.provenance.confidenceBasis, 'policy-prior', 'the plan carries no ASR confidence: it is not presented as measured')
          continue
        }
        assert.equal(sealed.get(observation.provenance.envelopeId), observation.provenance.envelopeHash)
      }

      // per kind: what was examined, and a reason for what was not
      const states = Object.fromEntries(first.result.coverage.map((entry) => [entry.kind, entry.state]))
      assert.deepEqual(states, { 'transcript-word': 'partial', speaker: 'absent', silence: 'absent', face: 'partial', object: 'absent',
        shot: 'partial', motion: 'partial', ocr: 'partial', 'image-insert': 'absent' })
      assert.equal(coverageOf(first, 'transcript-word').reasonCode, 'RECOGNIZED_WORD_SPANS_ONLY')
      assert.equal(coverageOf(first, 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
      assert.equal(coverageOf(first, 'speaker').reasonCode, 'DIARIZATION_UNAVAILABLE')
      assert.equal(coverageOf(first, 'silence').reasonCode, 'SILENCE_PRODUCER_UNAVAILABLE')
      assert.equal(coverageOf(first, 'image-insert').reasonCode, 'INSERT_GEOMETRY_NOT_COMPILED')
      assert.deepEqual(first.result.observations.filter((item) => item.kind === 'ocr').map((item) => item.value.timelineFrame), [0, 30, 60])
      assert.equal(first.result.observations.filter((item) => item.kind === 'shot').length, 119)
      assert.equal(first.result.observations.filter((item) => item.kind === 'motion').length, 117, 'the pairs above the gate are not motion')
      assert.equal(first.result.observations.filter((item) => item.kind === 'face').length, 12)
      assert.ok(coverageOf(first, 'shot').observedMs < 4_000 && coverageOf(first, 'motion').observedMs < coverageOf(first, 'shot').observedMs)
      // four sampled frames are four single-frame ranges: the rest of the timeline is NOT examined and is not guessed
      assert.deepEqual(coverageOf(first, 'ocr').ranges, OCR_FRAMES.map((frame) => [Math.round(frame / 30 * 1000), Math.round((frame + 1) / 30 * 1000)]))
      assert.equal(coverageOf(first, 'ocr').observedMs, OCR_FRAMES.length * 33)
      assert.equal(coverageOf(first, 'ocr').reasonCode, 'SAMPLED_FRAMES_ONLY')
      const temporalInput = first.snapshot.inputs.find((input) => input.kind === 'temporal')
      assert.deepEqual(temporalInput.unexamined.filter((gap) => gap.reasonCode === 'MOTION_UNRELIABLE_FRAME_DIFFERENCE')
        .map((gap) => [gap.startFrame, gap.endFrame]), [[10, 12]])

      // the database holds the same bytes and the nine per-kind rows that imply them
      const row = await db.v2ServerPerceptionSnapshot.findUniqueOrThrow({ where: { id: first.id }, include: { coverage: true } })
      assert.equal(row.snapshotHash, first.snapshot.snapshotHash)
      assert.equal(row.timelineHash, first.snapshot.timelineHash)
      assert.equal(row.coverage.length, 9)
      assert.deepEqual(row.coverage.map((entry) => entry.kind).toSorted(), [...PERCEPTION_KINDS].toSorted())
      const { timelineHash, ...timelineBody } = JSON.parse(row.snapshotJson).timeline
      assert.equal(timelineHash, first.snapshot.timelineHash)
      assert.equal(calculateCanonicalHash(timelineBody), timelineHash)
      assert.equal(row.createdAt.toISOString(), '2026-10-19T12:00:00.000Z')

      // range clipping: the part before the first OCR sample is examined by nobody, and OCR says so
      const clipped = await built.service()({ ...ask, fromMs: 1_000, toMs: 2_000, kinds: ['ocr', 'object', 'shot'] })
      assert.deepEqual(clipped.result.range, { startMs: 1_000, endMs: 2_000 })
      assert.deepEqual(clipped.result.kinds, ['ocr', 'object', 'shot'])
      assert.ok(clipped.result.observations.every((item) => ['ocr', 'shot'].includes(item.kind) && item.startMs < 2_000 && item.endMs > 1_000))
      assert.equal(coverageOf(clipped, 'object').state, 'absent')
      assert.equal(coverageOf(clipped, 'ocr').state, 'partial')
      assert.equal(coverageOf(clipped, 'shot').state, 'complete', 'every frame of the range has an adjacent pair')
      assert.equal(clipped.snapshot.snapshotHash, first.snapshot.snapshotHash, 'a range query does not change the snapshot')

      // replay: the same evidence is the same row, whoever asks and however concurrently
      const again = await built.service(() => new Date('2026-10-19T13:00:00.000Z'))(ask)
      assert.equal(again.id, first.id)
      assert.equal(again.snapshot.snapshotHash, first.snapshot.snapshotHash)
      assert.equal(again.createdAt, first.createdAt, 'the first write is the only write')
      const concurrent = await Promise.all(Array.from({ length: 6 }, () => built.service()(ask)))
      assert.ok(concurrent.every((item) => item.id === first.id && item.snapshot.snapshotHash === first.snapshot.snapshotHash))
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 1)
      assert.equal(await db.v2ServerPerceptionSnapshotCoverage.count({ where: { workspaceId: world.workspaceId } }), 9)
      assert.equal(stableSerialize(again.result), stableSerialize(first.result))
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W63a PostgreSQL server perception snapshot: another Version, workspace or project never sees this evidence; an older Version keeps its own',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const built = await seedSnapshotWorld(db)
      const { world } = built
      const ask = { workspaceId: world.workspaceId, projectId: world.projectId }
      const v1 = await built.service()(ask)

      // a later Version of the same project (the head moves): OCR and temporal were sealed for the earlier one and are not carried over
      const child = await commitSealedChild(db, { workspaceId: world.workspaceId, projectId: world.projectId, actor: world.actor,
        suffix: `w63a-${world.suffix}-next` })
      const v2 = await built.service()(ask)
      assert.equal(v2.projectVersionId, child.version.id)
      assert.notEqual(v2.projectVersionId, v1.projectVersionId)
      assert.notEqual(v2.snapshot.snapshotHash, v1.snapshot.snapshotHash)
      assert.equal(coverageOf(v2, 'ocr').state, 'absent')
      assert.equal(coverageOf(v2, 'ocr').reasonCode, 'NO_PRODUCER_RUN')
      assert.equal(coverageOf(v2, 'shot').state, 'absent')
      assert.equal(v2.snapshot.inputs.some((input) => input.kind === 'ocr' || input.kind === 'temporal'), false)
      // face windows are keyed by the source's bytes, so a new Version of the same source reads them unchanged
      assert.equal(v2.snapshot.inputs.filter((input) => input.kind === 'face').length, 2)
      assert.equal(coverageOf(v2, 'face').state, 'partial')
      // the older Version, asked for by name, still has exactly the evidence it had
      const older = await built.service()({ ...ask, projectVersionId: world.versionId })
      assert.equal(older.snapshot.snapshotHash, v1.snapshot.snapshotHash)
      assert.equal(older.id, v1.id)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 2)

      // a Version that plays nothing has no clock to put perception on
      const versions = await db.v2ProjectVersion.findMany({ where: { projectId: world.projectId, workspaceId: world.workspaceId }, orderBy: { sequence: 'asc' } })
      const empty = versions.find((version) => version.id !== world.versionId && version.id !== child.version.id)
      assert.ok(empty, 'the creation or empty variant Version exists')
      await assert.rejects(built.service()({ ...ask, projectVersionId: empty.id }), { code: 'PRECONDITION_REQUIRED' })

      // another workspace: the project, and the version, do not exist for it
      const other = await seedPerceptionProducerContext(db, { durationFrames: 120 })
      await assert.rejects(built.service()({ workspaceId: other.workspaceId, projectId: world.projectId }), { code: 'PROJECT_NOT_FOUND' })
      await assert.rejects(built.service()({ workspaceId: world.workspaceId, projectId: other.projectId }), { code: 'PROJECT_NOT_FOUND' })
      await assert.rejects(built.service()({ ...ask, projectVersionId: other.versionId }), { code: 'PROJECT_NOT_FOUND' })
      await assert.rejects(built.service()({ ...ask, projectVersionId: `missing-${randomUUID()}` }), { code: 'PROJECT_NOT_FOUND' })
      // ... and that workspace's own snapshot contains none of this one's evidence
      const foreign = await built.service()({ workspaceId: other.workspaceId, projectId: other.projectId })
      // (the words' hash is the content hash of an identical fixture transcript, so only sealed producer rows are compared)
      const ours = new Set(v1.snapshot.inputs.filter((input) => input.kind !== 'transcript').map((input) => input.envelopeHash))
      assert.equal(foreign.snapshot.inputs.some((input) => ours.has(input.envelopeHash)), false)
      assert.deepEqual(foreign.snapshot.inputs.map((input) => input.kind), ['transcript'], 'only the words of its own EditPlan')
      assert.ok(foreign.result.coverage.filter((entry) => entry.kind !== 'transcript-word').every((entry) => entry.state === 'absent'))
      await assert.rejects(built.service()({ ...ask, projectVersionId: '' }), { code: 'INVALID_ARGUMENT' })
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W63a PostgreSQL server perception snapshot: rights, source bytes and sealed rows are re-verified at every read',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const built = await seedSnapshotWorld(db)
      const { world, stats } = built
      const ask = { workspaceId: world.workspaceId, projectId: world.projectId }
      const baseline = await built.service()(ask)

      // revoked rights: the source is no longer analysable, so the evidence about it is no longer served
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: null, rightsRevision: 2 } })
      await assert.rejects(built.service()(ask), { code: 'ASSET_RIGHTS_BLOCKED' })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { currentRightsSnapshotId: world.rightsId, rightsRevision: 3 } })
      assert.equal((await built.service()(ask)).snapshot.snapshotHash, baseline.snapshot.snapshotHash, 'restoring the right restores the same snapshot')

      // an OCR row whose columns no longer match its sealed content is refused (the seal is re-derived on every read)
      await db.v2PerceptionProducerEnvelope.update({ where: { id: stats.ocr.id }, data: { envelopeHash: 'f'.repeat(64) } })
      await assert.rejects(built.service()(ask), (error) => error?.code === 'PERSISTENCE_CONFLICT' && /integrity|hash|columns/i.test(error.message))
      await db.v2PerceptionProducerEnvelope.update({ where: { id: stats.ocr.id }, data: { envelopeHash: stats.ocr.envelopeHash } })
      // so is a temporal row bound to other bytes
      await db.v2TemporalProducerEnvelope.update({ where: { id: stats.temporal.id }, data: { sourceSha256: 'e'.repeat(64) } })
      await assert.rejects(built.service()(ask), { code: 'PERSISTENCE_CONFLICT' })
      await db.v2TemporalProducerEnvelope.update({ where: { id: stats.temporal.id }, data: { sourceSha256: stats.temporal.sourceSha256 } })
      // and a face window whose raw detector bytes were replaced
      const raw = await db.v2FaceSourceWindowRawOutput.findFirstOrThrow({ where: { envelopeId: stats.faceWindows[0].id }, orderBy: { sampleIndex: 'asc' } })
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: raw.id }, data: { rawBytes: Buffer.alloc(5600, 7) } })
      await assert.rejects(built.service()(ask), { code: 'PERSISTENCE_CONFLICT' })
      await db.v2FaceSourceWindowRawOutput.update({ where: { id: raw.id }, data: { rawBytes: raw.rawBytes } })

      // an envelope bound to other bytes than the source's (the adversarial source): the artifact's identity moved under the seal
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: 'd'.repeat(64) } })
      await assert.rejects(built.service()(ask), { code: 'PERSISTENCE_CONFLICT' })
      await db.v2MediaArtifact.update({ where: { id: world.sourceId }, data: { sha256: world.sourceSha256 } })

      const restored = await built.service()(ask)
      assert.equal(restored.snapshot.snapshotHash, baseline.snapshot.snapshotHash)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 1, 'a refused read writes nothing')
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

test('W63a PostgreSQL server perception snapshot: the table is append-only, refuses what the domain refuses, and a row forged at insert is refused by the reader',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      const built = await seedSnapshotWorld(db)
      const { world } = built
      const ask = { workspaceId: world.workspaceId, projectId: world.projectId }
      const stored = await built.service()(ask)

      // append-only: neither the snapshot nor any of its coverage rows can be changed or removed
      await assert.rejects(db.v2ServerPerceptionSnapshot.update({ where: { id: stored.id }, data: { timelineHash: 'a'.repeat(64) } }), IMMUTABLE)
      await assert.rejects(db.v2ServerPerceptionSnapshot.delete({ where: { id: stored.id } }), IMMUTABLE)
      await assert.rejects(db.v2ServerPerceptionSnapshotCoverage.update({ where: { snapshotId_kind: { snapshotId: stored.id, kind: 'face' } },
        data: { state: 'complete' } }), IMMUTABLE)
      await assert.rejects(db.v2ServerPerceptionSnapshotCoverage.delete({ where: { snapshotId_kind: { snapshotId: stored.id, kind: 'object' } } }), IMMUTABLE)

      // the coverage rows are constrained like the domain constrains the timeline
      const parentFor = (label) => {
        const snapshotHash = digest(`w63a-forged-${label}-${world.suffix}`)
        return { snapshotHash, data: { id: serverPerceptionSnapshotId(snapshotHash), workspaceId: world.workspaceId, projectId: world.projectId,
          projectVersionId: world.versionId, editPlanSnapshotId: world.editId, editPlanSnapshotHash: sha('c'), durationFrames: 120,
          durationMs: 4_000, schemaVersion: 'server-perception-snapshot/v1', snapshotJson: '{}', snapshotHash, timelineHash: sha('d'),
          createdAt: new Date() } }
      }
      const row = (parent, kind, over) => ({ snapshotId: parent.data.id, workspaceId: world.workspaceId, kind, state: 'absent',
        observedMs: 0, durationMs: 4_000, observationCount: 0, reasonCode: 'NO_PRODUCER_RUN', ...over })
      const violates = async (label, over, kind = 'ocr') => {
        const parent = parentFor(label)
        await assert.rejects(db.$transaction(async (transaction) => {
          await transaction.v2ServerPerceptionSnapshot.create({ data: parent.data })
          await transaction.v2ServerPerceptionSnapshotCoverage.create({ data: row(parent, kind, over) })
        }), CHECK_FAILURE, label)
      }
      await violates('absent-without-reason', { reasonCode: null })
      await violates('absent-with-observations', { observationCount: 3 })
      await violates('absent-with-examined-time', { observedMs: 10 })
      await violates('complete-that-examined-less', { state: 'complete', observedMs: 3_999, reasonCode: null })
      await violates('complete-with-reason', { state: 'complete', observedMs: 4_000 })
      await violates('partial-that-examined-all', { state: 'partial', observedMs: 4_000, reasonCode: null })
      await violates('partial-that-examined-nothing', { state: 'partial', observedMs: 0, reasonCode: null })
      await violates('time-past-the-duration', { state: 'partial', observedMs: 4_001, reasonCode: null })
      await violates('lower-case-reason', { reasonCode: 'no_producer_run' })
      await violates('unknown-kind', {}, 'lighting')
      await violates('object-complete', { state: 'complete', observedMs: 4_000, reasonCode: null }, 'object')
      await violates('object-partial', { state: 'partial', observedMs: 100, reasonCode: null }, 'object')
      await violates('object-other-reason', { reasonCode: 'NO_PRODUCER_RUN' }, 'object')
      await violates('speaker-partial', { state: 'partial', observedMs: 100, reasonCode: null }, 'speaker')
      await violates('silence-with-observations', { observationCount: 1 }, 'silence')
      await violates('image-insert-complete', { state: 'complete', observedMs: 4_000, reasonCode: null }, 'image-insert')
      // a snapshot of fewer than nine kinds cannot be committed
      const short = parentFor('eight-kinds')
      await assert.rejects(db.$transaction(async (transaction) => {
        await transaction.v2ServerPerceptionSnapshot.create({ data: short.data })
        await transaction.v2ServerPerceptionSnapshotCoverage.createMany({ data: PERCEPTION_KINDS.slice(0, 8).map((kind) => row(short, kind, {})) })
        await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
      }), CHECK_FAILURE)
      // a snapshot whose id is not its content address
      const stray = parentFor('stray-id')
      await assert.rejects(db.v2ServerPerceptionSnapshot.create({ data: { ...stray.data, id: 'perception-snapshot-not-the-hash' } }), CHECK_FAILURE)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId: world.workspaceId } }), 1, 'nothing forged was kept')

      // a row forged AT INSERT, internally consistent for the database but not what the assembler would seal: the reader refuses it
      const genuine = JSON.parse((await db.v2ServerPerceptionSnapshot.findUniqueOrThrow({ where: { id: stored.id } })).snapshotJson)
      const forge = async (label, mutate, { resealTimeline = false, ...over } = {}) => {
        const body = structuredClone(genuine)
        delete body.snapshotHash
        mutate(body)
        if (resealTimeline) {
          // the timeline's own hash is made consistent again, so only the rule under test can refuse the row
          body.timeline = JSON.parse(JSON.stringify(createPerceptionTimeline({ durationMs: body.timeline.durationMs, origin: 'server',
            observations: body.timeline.observations, coverage: body.timeline.coverage.map((entry) => ({ kind: entry.kind, ranges: entry.ranges,
              ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}) })) })))
        }
        const snapshotHash = calculateCanonicalHash(body)
        const json = stableSerialize({ ...body, snapshotHash })
        const parent = { data: { id: serverPerceptionSnapshotId(snapshotHash), workspaceId: world.workspaceId, projectId: world.projectId,
          projectVersionId: world.versionId, editPlanSnapshotId: world.editId, editPlanSnapshotHash: genuine.editPlan.snapshotHash,
          durationFrames: 120, durationMs: 4_000, schemaVersion: 'server-perception-snapshot/v1', snapshotJson: json, snapshotHash,
          timelineHash: body.timeline.timelineHash, createdAt: new Date(), ...over } }
        await db.$transaction(async (transaction) => {
          await transaction.v2ServerPerceptionSnapshot.create({ data: parent.data })
          await transaction.v2ServerPerceptionSnapshotCoverage.createMany({ data: PERCEPTION_KINDS.map((kind) => {
            const entry = body.timeline.coverage.find((candidate) => candidate.kind === kind)
            return { snapshotId: parent.data.id, workspaceId: world.workspaceId, kind, state: entry.state, observedMs: entry.observedMs,
              durationMs: 4_000, observationCount: body.timeline.observations.filter((item) => item.kind === kind).length,
              reasonCode: entry.reasonCode ?? null }
          }) })
          await transaction.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE')
        })
        await assert.rejects(built.snapshots.findByHash({ workspaceId: world.workspaceId, projectId: world.projectId,
          projectVersionId: world.versionId, snapshotHash }), { code: 'PERSISTENCE_CONFLICT' }, label)
      }
      // a timeline whose stored coverage says more than its own ranges add up to (the table admits a partial row of that size)
      await forge('timeline-lies-about-coverage', (body) => {
        body.timeline.coverage.find((entry) => entry.kind === 'ocr').observedMs += 1
      })
      // an observation whose provenance names an envelope the snapshot does not list
      await forge('observation-from-nowhere', (body) => {
        body.timeline.observations.find((item) => item.kind === 'ocr').provenance.envelopeHash = 'b'.repeat(64)
      }, { resealTimeline: true })
      // a snapshot about another EditPlan than the columns say
      await forge('plan-differs-from-columns', (body) => { body.editPlan.snapshotHash = 'a'.repeat(64) })
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

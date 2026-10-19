import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { seedDirectorSnapshotWorld } from './helpers/director-snapshot-world.mjs'
import { FACE_ROWS } from './helpers/server-perception-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { stableSerialize } = await import('../../src/v2/domain/canonical-hash.ts')

/**
 * W63a PostgreSQL proof that the Director's perception IS the server perception snapshot (written for the supervised disposable
 * cluster; not run in hosted CI). The OCR, temporal and source-keyed face evidence is written by the products' own writers over the
 * Director world of the OCR suite (a real transcript row, the plan retimed from it, a sealed input Version); the analyzers are
 * stand-ins in what they look at only.
 *
 * It must establish: the Director and the public snapshot hold the same bytes (the run's timeline is the stored snapshot's, and
 * it names it by hash); the Director writes that snapshot once, in its own commit; evidence that moves between its read and its
 * commit refuses the run and leaves nothing behind; what the Director decides is what it decided before (face safety unknown,
 * review required); and the stored run reads back through the strict parser.
 */
test('W63a PostgreSQL Director: its perception is the server snapshot, written once by its commit, refused when the evidence moves',
  { skip: !process.env.V2_DATABASE_URL, timeout: 480_000 }, async () => {
    const db = new PrismaClient()
    let primaryError
    try {
      // the Director world of the OCR suite, in an output format of its own (the OCR suite owns 9:16), with the evidence over it
      const { suffix, workspaceId, world, built, director, snapshots, publicSnapshot, service, request, rowsBefore } = await seedDirectorSnapshotWorld(db)

      // the Director's context carries the same evidence the public snapshot is made of
      const context = await director.readContext({ workspaceId, projectId: world.projectId })
      assert.equal(context.currentVersion.id, world.versionId)
      assert.equal(context.ocrEnvelope.envelopeHash, built.stats.ocr.envelopeHash)
      assert.deepEqual(context.perceptionEvidence.temporal.map((envelope) => envelope.envelopeHash), [built.stats.temporal.envelopeHash])
      assert.equal(context.perceptionEvidence.faceWindows.length, 2)
      assert.equal(context.perceptionEvidence.editPlan.snapshotHash.length, 64)
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 0, 'reading the context writes nothing')

      // evidence that moves between the Director's read and its commit refuses the run and leaves nothing behind
      const before = await rowsBefore()
      const racing = Object.create(director)
      racing.commitWithCanonicalSnapshots = async (scope, prepare) => {
        await built.faces.publish('w63a-late', { startSourceFrame: 30, endSourceFrame: 90 }, (frame) => (frame % 10 === 0 ? FACE_ROWS : []))
        return director.commitWithCanonicalSnapshots(scope, prepare)
      }
      await assert.rejects(service(racing)(request(`w63a-stale-${suffix}`)),
        (error) => error?.code === 'PERSISTENCE_CONFLICT' && /evidence changed before commit/i.test(error.message))
      assert.deepEqual(await rowsBefore(), before, 'a refused run writes no Version, run, Command, snapshot or perception row')

      // the next run reads the evidence as it now is, and commits
      const directed = await service(director)(request(`w63a-director-${suffix}`))
      const perception = directed.run.perception
      assert.equal(perception.schemaVersion, 2)
      assert.equal(perception.inputVersionId, world.versionId)
      assert.equal(perception.serverSnapshot.schemaVersion, 'server-perception-snapshot/v1')
      assert.equal(perception.ocrEvidence.envelopeHash, built.stats.ocr.envelopeHash)
      // decisions are what they were: the new evidence kinds decide nothing, face safety stays unknown
      assert.equal(directed.run.qualityReport.status, 'review-required')
      assert.equal(directed.run.qualityReport.faceSafety.status, 'unknown')
      assert.equal(directed.run.qualityReport.hardChecks.subtitlesFaceSafe, false)
      assert.equal(perception.summary.confidence, 0.82)
      assert.equal(perception.summary.faceCoverage, 'partial')
      assert.equal(perception.summary.visualCoverage, 'partial')

      // the Director wrote the snapshot, once, in its commit; the public read finds the same bytes
      const stored = await db.v2ServerPerceptionSnapshot.findMany({ where: { workspaceId }, include: { coverage: true } })
      assert.equal(stored.length, 1)
      assert.equal(stored[0].snapshotHash, perception.serverSnapshot.snapshotHash)
      assert.equal(stored[0].projectVersionId, world.versionId)
      assert.equal(stored[0].coverage.length, 9)
      const created = stored[0].createdAt.toISOString()
      const api = await publicSnapshot({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId })
      assert.equal(api.id, stored[0].id)
      assert.equal(api.snapshot.snapshotHash, perception.serverSnapshot.snapshotHash)
      assert.equal(api.createdAt, created, 'the API found the Director\'s row; it wrote nothing')
      assert.equal(await db.v2ServerPerceptionSnapshot.count({ where: { workspaceId } }), 1)
      const record = await snapshots.findByHash({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId,
        snapshotHash: perception.serverSnapshot.snapshotHash })
      assert.equal(stableSerialize(perception.timeline), stableSerialize(record.snapshot.timeline), 'the run\'s timeline IS the snapshot\'s')
      assert.equal(perception.timeline.timelineHash, api.snapshot.timelineHash)
      for (const kind of ['transcript-word', 'ocr', 'shot', 'motion', 'face']) {
        assert.ok(perception.timeline.observations.some((item) => item.kind === kind), kind)
      }
      assert.equal(perception.timeline.coverage.find((entry) => entry.kind === 'object').reasonCode, 'NO_VERIFIED_DETECTOR')
      assert.equal(perception.timeline.coverage.find((entry) => entry.kind === 'object').state, 'absent')
      // the late face window is among the inputs the snapshot lists
      assert.equal(record.snapshot.inputs.filter((input) => input.kind === 'face').length, 3)

      // the stored run reads back through the strict parser (replay of the same request)
      const replay = await service(director)(request(`w63a-director-${suffix}`))
      assert.equal(replay.replayed, true)
      assert.equal(stableSerialize(replay.run.perception), stableSerialize(perception))
      const quality = await director.readQualityReport({ workspaceId, projectId: world.projectId, directorRunId: directed.run.id })
      assert.equal(quality.report.faceSafety.status, 'unknown')

      // the head moved: the older Version keeps exactly the evidence and snapshot the run was made from
      const older = await publicSnapshot({ workspaceId, projectId: world.projectId, projectVersionId: world.versionId })
      assert.equal(older.snapshot.snapshotHash, perception.serverSnapshot.snapshotHash)
      const head = await publicSnapshot({ workspaceId, projectId: world.projectId })
      assert.equal(head.projectVersionId, directed.version.id)
      assert.equal(head.result.coverage.find((entry) => entry.kind === 'ocr').reasonCode, 'NO_PRODUCER_RUN')
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (primaryError) throw primaryError
    }
  })

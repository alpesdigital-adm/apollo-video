import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { seedDirectorSnapshotWorld } from './helpers/director-snapshot-world.mjs'
import { distinctFaceWindows, publishFaceWindows } from './helpers/server-perception-pg-world.mjs'

// Under tsx a static named import of a TypeScript module is not visible to Node (the module runs as CommonJS), so these are dynamic.
const { assembleServerPerceptionSnapshot } = await import('../../src/v2/domain/server-perception-snapshot.ts')
const { FACE_WINDOW_SNAPSHOT_CAP } = await import('../../src/v2/domain/face-window-paging.ts')
const { PrismaFaceSourceWindowRepository } = await import('../../src/v2/infrastructure/prisma/face-source-window-repository.ts')
const { PrismaServerPerceptionEvidenceReader } = await import('../../src/v2/infrastructure/prisma/server-perception-evidence-reader.ts')

/**
 * W63a cost of the snapshot at a realistic number of face windows (written for the supervised disposable cluster; a MEASUREMENT, not
 * hosted CI: it reports durations and fails only on what is wrong, never on how long something took).
 *
 * The windows are written by the products' own writers (admission, claim, fenced publish), one after the other, over the Director
 * world of the W63a Director suite. At each scale (APOLLO_COST_SCALES, default "200,990" windows) it measures, `REPS` times:
 *  - the evidence read alone (every window re-verified: seal, columns, bytes, rights), outside any transaction;
 *  - the assembly alone (CPU, no database);
 *  - GET cold: the public service when the evidence has just changed (read, assemble, insert the content-addressed row);
 *  - GET warm: the same request again (read, assemble, find the row);
 *  - the Director run: its context read, its COMMIT (the Serializable transaction, 30 s timeout, up to 3 attempts, which re-reads all
 *    the evidence inside it) and the whole run.
 * Every repetition publishes one more window first, so every cold GET and every Director run sees evidence that really changed. The
 * Director runs go one after the other on the head the previous run left (the first on the input Version, with its OCR and temporal
 * rows; the others on the Director's own output Versions, which carry the same source's windows and no OCR or temporal row).
 */
const REPS = 3
const SCALES = (process.env.APOLLO_COST_SCALES ?? '200,990').split(',').map((item) => Number(item.trim()))
const OUT = process.env.APOLLO_COST_OUT
const round = (value) => Math.round(value * 10) / 10
const summarize = (values) => {
  const sorted = values.toSorted((left, right) => left - right)
  return { n: sorted.length, minMs: round(sorted[0]), medianMs: round(sorted[Math.floor(sorted.length / 2)]), maxMs: round(sorted.at(-1)),
    allMs: values.map(round) }
}
const timed = async (action) => {
  const started = performance.now()
  const value = await action()
  return { value, ms: performance.now() - started }
}

test('W63a PostgreSQL cost: the snapshot read, the cold and warm GET and the Director commit at 200 and about 1000 face windows',
  { skip: !process.env.V2_DATABASE_URL, timeout: 3_000_000 }, async () => {
    assert.ok(SCALES.every((scale) => Number.isSafeInteger(scale) && scale >= 3 && scale + 2 * REPS <= FACE_WINDOW_SNAPSHOT_CAP), 'the scales fit under the cap')
    const db = new PrismaClient()
    let primaryError
    const report = { reps: REPS, windowCap: FACE_WINDOW_SNAPSHOT_CAP, scales: [] }
    try {
      const { workspaceId, world, built, director, snapshots, publicSnapshot, service, request } = await seedDirectorSnapshotWorld(db, { aspectRatio: '1:1' })
      const faceRepository = new PrismaFaceSourceWindowRepository(db)
      const reader = new PrismaServerPerceptionEvidenceReader(db)
      const range = { workspaceId, projectId: world.projectId, sourceArtifactId: world.sourceId, fromSourceFrame: 0, toSourceFrame: 120 }
      const pool = distinctFaceWindows(Math.max(...SCALES) + 2 * REPS, { skip: [[0, 60], [60, 120]] })
      let used = 0
      const publishMore = async (count, label) => {
        const started = performance.now()
        const next = pool.slice(used, used + count)
        assert.equal(next.length, count, 'the pool of distinct windows is large enough')
        await publishFaceWindows(built.faces, next, label)
        used += count
        return performance.now() - started
      }
      const input = { workspaceId, projectId: world.projectId, projectVersionId: world.versionId }
      let base = { versionId: world.versionId, baseHash: world.head.version.baseHash }
      let directorRuns = 0

      for (const scale of SCALES) {
        const entry = { scale: null, seedMsPerWindow: null, evidenceRead: null, assemble: null, getCold: null, getWarm: null,
          snapshotJsonBytes: null, responseBytes: null, faceInputs: null, director: null }
        // grow to `scale` windows in all (two exist already)
        const missing = scale - (2 + used)
        if (missing > 0) entry.seedMsPerWindow = round((await publishMore(missing, `w63a-cost-${scale}`)) / missing)
        const read = [], assemble = [], cold = [], warm = [], bytes = [], responseBytes = [], windowCounts = []
        for (let rep = 0; rep < REPS; rep += 1) {
          await publishMore(1, `w63a-cost-${scale}-rep${rep}`)
          const windows = await faceRepository.countSourceWindows(range)
          windowCounts.push(windows)
          const evidence = await timed(() => reader.readForVersion({ ...input, now: new Date() }))
          read.push(evidence.ms)
          assert.equal(evidence.value.faceWindows.length, windows, 'every window of the source was read')
          assert.equal(evidence.value.faceWindowRefusals, undefined)
          const assembled = await timed(async () => assembleServerPerceptionSnapshot(evidence.value))
          assemble.push(assembled.ms)
          const first = await timed(() => publicSnapshot(input))
          cold.push(first.ms)
          assert.equal(first.value.snapshot.snapshotHash, assembled.value.snapshotHash)
          assert.equal(first.value.snapshot.inputs.filter((item) => item.kind === 'face').length, windows)
          const second = await timed(() => publicSnapshot(input))
          warm.push(second.ms)
          assert.equal(second.value.snapshot.snapshotHash, first.value.snapshot.snapshotHash)
          assert.equal(second.value.createdAt, first.value.createdAt, 'the warm GET found the row the cold GET wrote')
          const row = await db.v2ServerPerceptionSnapshot.findUniqueOrThrow({ where: { id: first.value.id }, select: { snapshotJson: true } })
          bytes.push(Buffer.byteLength(row.snapshotJson))
          responseBytes.push(Buffer.byteLength(JSON.stringify({ data: first.value })))
        }
        Object.assign(entry, { scale: windowCounts, evidenceRead: summarize(read), assemble: summarize(assemble), getCold: summarize(cold),
          getWarm: summarize(warm), snapshotJsonBytes: bytes, responseBytes, faceInputs: windowCounts })

        // the Director: its context read, its commit transaction and the whole run, REPS times, each on the head the last one left
        const context = [], commit = [], total = [], attempts = []
        for (let rep = 0; rep < REPS; rep += 1) {
          await publishMore(1, `w63a-cost-${scale}-director${rep}`)
          const measured = Object.create(director)
          let contextMs = null, commitMs = null, tries = 0
          measured.readContext = async (...args) => {
            const started = performance.now()
            try { return await director.readContext(...args) } finally { contextMs = performance.now() - started }
          }
          measured.commitWithCanonicalSnapshots = async (scope, prepare) => {
            const started = performance.now()
            try {
              return await director.commitWithCanonicalSnapshots(scope, async (...args) => { tries += 1; return prepare(...args) })
            } finally { commitMs = performance.now() - started }
          }
          directorRuns += 1
          const run = await timed(() => service(measured)(request(`w63a-cost-director-${directorRuns}-${scale}`, base)))
          assert.ok(contextMs !== null && commitMs !== null)
          context.push(contextMs)
          commit.push(commitMs)
          total.push(run.ms)
          attempts.push(tries)
          assert.equal(run.value.run.perception.schemaVersion, 2)
          assert.equal(run.value.run.qualityReport.faceSafety.status, 'unknown')
          const stored = await snapshots.findByHash({ workspaceId, projectId: world.projectId, projectVersionId: base.versionId,
            snapshotHash: run.value.run.perception.serverSnapshot.snapshotHash })
          const faceInputs = stored.snapshot.inputs.filter((item) => item.kind === 'face').length
          assert.ok(faceInputs > 0 && faceInputs <= await faceRepository.countSourceWindows(range))
          if (base.versionId === world.versionId) assert.equal(faceInputs, await faceRepository.countSourceWindows(range))
          base = { versionId: run.value.version.id, baseHash: run.value.version.baseHash }
        }
        entry.director = { contextRead: summarize(context), commitTransaction: summarize(commit), commitAttempts: attempts, run: summarize(total),
          commitTransactionTimeoutMs: 30_000 }
        report.scales.push(entry)
        console.log(`W63A_COST ${JSON.stringify(entry)}`)
      }
    } catch (error) {
      primaryError = error
    } finally {
      try { await db.$disconnect() } catch (error) { primaryError ??= error }
      if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
      if (primaryError) throw primaryError
    }
  })

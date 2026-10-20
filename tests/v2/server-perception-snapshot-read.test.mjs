import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { PUBLIC_ERROR_CODES } from '../../src/v2/public-api/public-error-catalog.ts'
import { assembleServerPerceptionSnapshot } from '../../src/v2/domain/server-perception-snapshot.ts'
import {
  materializeServerPerceptionSnapshotService, readServerPerceptionSnapshotService,
} from '../../src/v2/application/server-perception-snapshots.ts'
import { assemblyBase, ocrEnvelope, transcriptRef, transcriptWords, wholeClips } from './helpers/perception-snapshot-fixtures.mjs'

/**
 * W64: the read side of GET /perception/snapshot never assembles and never writes. These are the application-level proofs (the route
 * and PostgreSQL ones are in the snapshot and Director evidence suites).
 */
const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: {
  transcript: { transcript: transcriptRef(), words: transcriptWords({ clips: wholeClips() }) }, ocr: [ocrEnvelope({ frames: [0, 30] })] } }))

function repository(found) {
  const calls = []
  return {
    calls,
    async findLatestForVersion(input) { calls.push(['findLatestForVersion', input]); return found },
    async assertSourcesStillHold(input) { calls.push(['assertSourcesStillHold', input.snapshot.snapshotHash]); if (repository.revoked) throw new DomainError('ASSET_RIGHTS_BLOCKED', 'revoked') },
    async persistIfAbsent() { calls.push(['persistIfAbsent']); throw new Error('a read must not write') },
    async findByHash() { calls.push(['findByHash']); return null },
  }
}
const record = { id: 'perception-snapshot-x', workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', snapshot, createdAt: '2026-10-19T00:00:00.000Z' }
const ask = { workspaceId: 'workspace-1', projectId: 'project-1' }

test('W64 the snapshot read serves the stored row and touches nothing else: no evidence reader, no write', async () => {
  repository.revoked = false
  const repo = repository({ status: 'found', record })
  const read = readServerPerceptionSnapshotService({ snapshots: repo, clock: () => new Date('2026-10-19T12:00:00.000Z') })
  const result = await read({ ...ask, fromMs: 0, toMs: 2000 })
  assert.equal(result.snapshot.snapshotHash, snapshot.snapshotHash)
  assert.equal(result.createdAt, record.createdAt, 'the row\'s own time: nothing was written now')
  assert.deepEqual(repo.calls.map(([name]) => name), ['findLatestForVersion', 'assertSourcesStillHold'])
  // the service is built from the snapshot store alone: it has no evidence reader to assemble with (a store that cannot write at all works)
  const readOnly = { findLatestForVersion: repo.findLatestForVersion, assertSourcesStillHold: repo.assertSourcesStillHold }
  const again = await readServerPerceptionSnapshotService({ snapshots: readOnly, clock: () => new Date() })(ask)
  assert.equal(again.snapshot.snapshotHash, snapshot.snapshotHash)
})

test('W64 a Version with no stored snapshot is a typed 404 that names a Director run as the writer; a Version that plays nothing keeps its 428; strangers see nothing', async () => {
  repository.revoked = false
  const clock = () => new Date()
  const notMaterialized = repository({ status: 'not-materialized', projectVersionId: 'version-1' })
  await assert.rejects(readServerPerceptionSnapshotService({ snapshots: notMaterialized, clock })(ask),
    (error) => error instanceof DomainError && error.code === 'SNAPSHOT_NOT_MATERIALIZED' && error.details.projectVersionId === 'version-1' && /Director run/.test(error.details.reason))
  assert.deepEqual(notMaterialized.calls.map(([name]) => name), ['findLatestForVersion'], 'it did not try to assemble or to write')
  await assert.rejects(readServerPerceptionSnapshotService({ snapshots: repository({ status: 'plays-nothing', projectVersionId: 'version-1' }), clock })(ask),
    (error) => error.code === 'PRECONDITION_REQUIRED')
  await assert.rejects(readServerPerceptionSnapshotService({ snapshots: repository({ status: 'not-found' }), clock })(ask),
    (error) => error.code === 'PROJECT_NOT_FOUND')
  assert.ok(PUBLIC_ERROR_CODES.includes('SNAPSHOT_NOT_MATERIALIZED'))
})

test('W64 the stored snapshot is history, but rights and source bytes are not: they are checked again at every read', async () => {
  repository.revoked = true
  const repo = repository({ status: 'found', record })
  await assert.rejects(readServerPerceptionSnapshotService({ snapshots: repo, clock: () => new Date() })(ask), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  assert.deepEqual(repo.calls.map(([name]) => name), ['findLatestForVersion', 'assertSourcesStillHold'])
  repository.revoked = false
})

test('W64 only the materializing service may write, and it writes the row that holds exactly the assembled bytes', async () => {
  const written = []
  const evidence = { async readForVersion() { return assemblyBase({ extra: { ocr: [ocrEnvelope({ frames: [0, 30] })] } }) } }
  const snapshots = {
    async persistIfAbsent(input) { written.push(input); return { record: { ...record, snapshot: input.snapshot, createdAt: input.createdAt }, created: true } },
  }
  const result = await materializeServerPerceptionSnapshotService({ evidence, snapshots, clock: () => new Date('2026-10-19T12:00:00.000Z') })(ask)
  assert.equal(written.length, 1)
  assert.equal(result.snapshot.snapshotHash, written[0].snapshot.snapshotHash)
})

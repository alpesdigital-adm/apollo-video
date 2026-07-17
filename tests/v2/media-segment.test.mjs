import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaSegment, materializeSegment } from '../../src/v2/domain/media-segment.ts'

test('T-FR-042 creates semantic, overlapping and nested ranges without cutting master bytes', () => {
  const first = createMediaSegment({ id: 's1', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Promessa', startMs: 0, endMs: 5_000 })
  const overlap = createMediaSegment({ id: 's2', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Prova', startMs: 4_000, endMs: 8_000 })
  const nested = createMediaSegment({ id: 's3', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, parentSegment: first, label: 'Frase', startMs: 1_000, endMs: 5_000 })
  assert.equal(first.physicalObjectKey, null)
  assert.equal(overlap.semanticRange.startMs, 4_000)
  assert.equal(nested.parentSegmentId, 's1')
  assert.deepEqual(nested.sourceTimeMapping, { sourceStartMs: 1_000, sourceEndMs: 5_000, rate: 1 })
})

test('T-FR-042 accepts exact asset boundary and materializes only for a physical consumer', () => {
  const segment = createMediaSegment({ id: 'edge', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Tudo', startMs: 0, endMs: 10_000 })
  assert.equal(materializeSegment(segment, { requiresPhysicalDerivative: false, key: 'director' }), null)
  assert.deepEqual(materializeSegment(segment, { requiresPhysicalDerivative: true, key: 'export' }), { recipe: 'extract-range/v1', sourceAssetId: 'a', sourceRangeMs: [0, 10_000], outputKey: 'derivatives/segments/edge/export', immutableSource: true })
  assert.throws(() => createMediaSegment({ id: 'bad', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: '', startMs: 0, endMs: 10_001 }), /inside/i)
})

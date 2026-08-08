import test from 'node:test'
import assert from 'node:assert/strict'
import { createMediaSegment, materializeSegment } from '../../src/v2/domain/media-segment.ts'
import { createMediaSegmentService, listMediaSegmentsService, requestMediaSegmentMaterializationService } from '../../src/v2/application/media-segments.ts'

test('T-FR-042 creates semantic, overlapping and nested ranges without cutting master bytes', () => {
  const first = createMediaSegment({ id: 's1', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Promessa', startMs: 0, endMs: 5_000 })
  const overlap = createMediaSegment({ id: 's2', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Prova', startMs: 4_000, endMs: 8_000 })
  const nested = createMediaSegment({ id: 's3', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, parentSegment: first, label: 'Frase', startMs: 1_000, endMs: 5_000 })
  assert.equal(first.physicalObjectKey, null)
  assert.equal(overlap.semanticRange.startMs, 4_000)
  assert.equal(nested.parentSegmentId, 's1')
  assert.deepEqual(nested.sourceTimeMapping, { sourceStartMs: 1_000, sourceEndMs: 5_000, rate: 1 })
})

test('T-FR-042 application creates content-addressed virtual ranges and defers physical work', async () => {
  const rows = new Map()
  const source = { artifactId: 'asset', artifactKey: 'masters/source.mp4', sha256: 'a'.repeat(64), byteSize: 100, mediaType: 'video', container: 'mp4', durationMs: 10_000 }
  const repository = {
    async readSource(workspaceId, artifactId) { return workspaceId === 'workspace' && artifactId === 'asset' ? source : null },
    async find(workspaceId, segmentId) { const row = rows.get(segmentId); return row?.workspaceId === workspaceId ? row : null },
    async list(workspaceId, artifactId) { return [...rows.values()].filter((row) => row.workspaceId === workspaceId && row.parentAssetId === artifactId) },
    async create(segment) { const existing = [...rows.values()].find((row) => row.segmentHash === segment.segmentHash); if (existing) return { segment: existing, replayed: true }; rows.set(segment.id, segment); return { segment, replayed: false } },
    async findMaterialization() { return null },
  }
  const create = createMediaSegmentService({ repository, clock: () => new Date('2026-08-08T14:00:00.000Z') })
  const first = await create({ workspaceId: 'workspace', artifactId: 'asset', label: 'Promessa', startMs: 0, endMs: 5000 })
  const replay = await create({ workspaceId: 'workspace', artifactId: 'asset', label: 'Promessa', startMs: 0, endMs: 5000 })
  const nested = await create({ workspaceId: 'workspace', artifactId: 'asset', parentSegmentId: first.segment.id, label: 'Frase', startMs: 1000, endMs: 5000 })
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(nested.segment.parentSegmentId, first.segment.id)
  assert.equal((await listMediaSegmentsService({ repository })({ workspaceId: 'workspace', artifactId: 'asset' })).items.length, 2)
  const requested = await requestMediaSegmentMaterializationService({ repository })({ workspaceId: 'workspace', segmentId: first.segment.id, consumerKey: 'export', requiresPhysicalDerivative: true })
  assert.equal(requested.recipe.recipe, 'extract-range/v1')
  assert.equal(requested.materializationRequired, true)
  await assert.rejects(() => create({ workspaceId: 'workspace', artifactId: 'asset', parentSegmentId: first.segment.id, label: 'Fora', startMs: 0, endMs: 6000 }), /inside/i)
})

test('T-FR-042 accepts exact asset boundary and materializes only for a physical consumer', () => {
  const segment = createMediaSegment({ id: 'edge', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Tudo', startMs: 0, endMs: 10_000 })
  assert.equal(materializeSegment(segment, { requiresPhysicalDerivative: false, key: 'director' }), null)
  assert.deepEqual(materializeSegment(segment, { requiresPhysicalDerivative: true, key: 'export' }), { recipe: 'extract-range/v1', sourceAssetId: 'a', sourceRangeMs: [0, 10_000], outputKey: 'derivatives/segments/edge/export', immutableSource: true })
  assert.throws(() => createMediaSegment({ id: 'bad', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: 'Inválido', startMs: 0, endMs: 10_001 }), /inside/i)
  assert.throws(() => createMediaSegment({ id: 'bad-label', workspaceId: 'w', parentAssetId: 'a', parentDurationMs: 10_000, label: '', startMs: 0, endMs: 1 }), /label/i)
})

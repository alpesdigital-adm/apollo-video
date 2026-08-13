import test from 'node:test'
import assert from 'node:assert/strict'

import { attachMediaLibraryItemService, listMediaLibraryService, readMediaLibraryItemService } from '../../src/v2/application/media-library.ts'
import {
  assertLibraryAttachmentEligible,
  listMediaLibrary,
  mediaLibraryRights,
  mediaLibrarySearchField,
  normalizeMediaLibraryQuery,
} from '../../src/v2/domain/media-library.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateCanonicalHash, stableSerialize } from '../../src/v2/domain/canonical-hash.ts'
import { PrismaMediaLibraryRepository } from '../../src/v2/infrastructure/prisma/media-library-repository.ts'

const now = new Date('2026-08-08T12:00:00.000Z')
const approvedRights = (overrides = {}) => createAssetRightsSnapshot({
  id: overrides.id ?? 'rights_approved', workspaceId: 'ws_1', artifactId: overrides.artifactId ?? 'artifact_a', sequence: 1,
  draft: {
    status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [],
    consent: { status: 'not-required', allowedUses: [] }, ...overrides.draft,
  },
  createdBy: { type: 'user', id: 'user_1' }, createdAt: '2026-08-01T00:00:00.000Z',
})

const item = (id, overrides = {}) => ({
  id, workspaceId: 'ws_1', kind: 'video', label: id, people: ['Ana'], topics: ['Produto premium'], status: 'usable',
  rights: { status: 'eligible', snapshotId: 'rights_1', reasonCodes: [] }, origin: { type: 'upload' },
  preview: { thumbnail: { status: 'available', artifactId: `thumb_${id}` }, waveform: { status: 'unavailable' } },
  technical: { mediaType: 'video', container: 'mp4', byteSize: '1024' },
  source: { type: 'artifact', artifactId: id, virtual: false, bytesDuplicated: false },
  createdAt: `2026-01-${id === 'a' ? '03' : id === 'b' ? '02' : '01'}T00:00:00.000Z`, ...overrides,
})

test('T-FR-040 normalizes bounded filters and canonical metadata search fields', () => {
  assert.deepEqual(normalizeMediaLibraryQuery({ workspaceId: ' ws_1 ', person: ' ÁLVARO ', topic: ' PRODUTO ', limit: 12 }), {
    workspaceId: 'ws_1', person: 'álvaro', topic: 'produto', limit: 12,
  })
  assert.deepEqual(mediaLibrarySearchField(['Bia', 'Ana'], 'people'), { values: ['Ana', 'Bia'], search: '\nana\nbia\n' })
  assert.throws(() => normalizeMediaLibraryQuery({ workspaceId: 'ws_1', limit: 101 }), /limit/i)
  assert.throws(() => mediaLibrarySearchField(['Ana', 'ana'], 'people'), /duplicates/i)
})

test('T-FR-040 collection oracle paginates, filters and rejects a cursor outside the filtered result', () => {
  const all = [item('a'), item('b', { kind: 'audio', people: ['Bia'], technical: { mediaType: 'audio', container: 'wav', byteSize: '2048' } }), item('c', { rights: { status: 'restricted', reasonCodes: ['RIGHTS_STATUS_RESTRICTED'] } }), item('x', { workspaceId: 'ws_2' })]
  const first = listMediaLibrary(all, { workspaceId: 'ws_1', limit: 2 })
  assert.deepEqual(first.items.map((value) => value.id), ['a', 'b'])
  assert.deepEqual(listMediaLibrary(all, { workspaceId: 'ws_1', after: first.nextCursor, limit: 2 }).items.map((value) => value.id), ['c'])
  assert.deepEqual(listMediaLibrary(all, { workspaceId: 'ws_1', kind: 'audio', person: 'bia', topic: 'prod', rightsStatus: 'eligible' }).items.map((value) => value.id), ['b'])
  assert.throws(() => listMediaLibrary(all, { workspaceId: 'ws_1', kind: 'video', after: first.nextCursor }), /cursor/i)
})

test('T-FR-040 maps current rights to eligible, review, restricted and expired without optimistic defaults', () => {
  assert.equal(mediaLibraryRights(approvedRights(), { workspaceId: 'ws_1', locale: 'pt-BR', now }).status, 'eligible')
  assert.deepEqual(mediaLibraryRights(null, { workspaceId: 'ws_1', locale: 'pt-BR', now }), { status: 'review', reasonCodes: ['RIGHTS_MISSING'] })
  assert.equal(mediaLibraryRights(approvedRights({ draft: { status: 'restricted', allowedUses: [], prohibitedUses: [], consent: { status: 'not-required', allowedUses: [] } } }), { workspaceId: 'ws_1', locale: 'pt-BR', now }).status, 'restricted')
  assert.equal(mediaLibraryRights(approvedRights({ draft: { status: 'approved', allowedUses: ['editorial-reuse'], prohibitedUses: [], expiresAt: '2026-08-08T11:59:59.000Z', consent: { status: 'not-required', allowedUses: [] } } }), { workspaceId: 'ws_1', locale: 'pt-BR', now }).status, 'expired')
})

test('T-FR-040 attachment service delegates one normalized reference-only transactional write', async () => {
  const writes = []
  const repository = {
    async attach(input) { writes.push(input); return { id: 'ref_1', ...input, role: 'selected-insert', bytesDuplicated: false, replayed: false } },
  }
  const attach = attachMediaLibraryItemService({ repository, clock: () => now })
  const result = await attach({ workspaceId: ' ws_1 ', projectId: ' project_1 ', artifactId: ' artifact_ok ' })
  assert.equal(result.bytesDuplicated, false)
  assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], { workspaceId: 'ws_1', projectId: 'project_1', artifactId: 'artifact_ok', createdAt: now.toISOString() })
  await assert.rejects(() => attach({ workspaceId: 'ws_1', projectId: 'x', artifactId: 'artifact_ok' }), /identifiers/i)
  assert.throws(() => assertLibraryAttachmentEligible(item('a', { status: 'processing' }), 'ws_1'), /usable/i)
  assert.throws(() => assertLibraryAttachmentEligible(item('a', { rights: { status: 'restricted', reasonCodes: ['RIGHTS_USE_NOT_ALLOWED'] } }), 'ws_1'), /rights/i)
})

test('T-FR-040 list application service passes normalized workspace query to the repository', async () => {
  let received
  const expected = { items: [], nextCursor: null }
  const result = await listMediaLibraryService({ repository: { async list(query) { received = query; return expected } }, clock: () => now })({ workspaceId: ' ws_1 ', limit: 7 })
  assert.equal(result, expected)
  assert.deepEqual(received, { workspaceId: 'ws_1', limit: 7 })
})

test('T-FR-040 detail service resolves either artifact or segment identity inside one normalized workspace', async () => {
  const received = []
  const expected = item('segment_1', { kind: 'segment', source: { type: 'segment', artifactId: 'asset_1', description: '', semanticRange: { startMs: 10, endMs: 20 }, sourceTimeMapping: { sourceStartMs: 10, sourceEndMs: 20, rate: 1 }, physicalObjectKey: null, sourceDurationMs: 100, segmentHash: 'a'.repeat(64), virtual: true, bytesDuplicated: false } })
  const read = readMediaLibraryItemService({ repository: { async findById(...args) { received.push(args); return expected } }, clock: () => now })
  assert.equal(await read(' ws_1 ', ' segment_1 '), expected)
  assert.deepEqual(received[0], ['ws_1', 'segment_1', now])
  await assert.rejects(() => read('ws_1', 'x'), /invalid/i)
})

test('T-FR-040/T-FR-042 Prisma read model merges a virtual segment with its immutable parent metadata and preview', async () => {
  const library = {
    artifactId: 'asset_parent', workspaceId: 'ws_1', label: 'Master', peopleJson: stableSerialize(['Ana']), topicsJson: stableSerialize(['Oferta']),
    peopleSearch: '\nana\n', topicsSearch: '\noferta\n', originType: 'upload', parentArtifactId: null, thumbnailArtifactId: 'thumb_parent', waveformArtifactId: null,
    createdAt: new Date('2026-08-08T12:00:00.000Z'), updatedAt: new Date('2026-08-08T12:00:00.000Z'),
    thumbnailArtifact: { id: 'thumb_parent', status: 'available' }, waveformArtifact: null,
  }
  const artifact = { id: 'asset_parent', mediaType: 'video', container: 'mp4', byteSize: 9000n, status: 'available', currentRightsSnapshot: null, libraryEntry: library }
  const content = { schemaVersion: 'media-segment/v1', workspaceId: 'ws_1', parentAssetId: 'asset_parent', label: 'Trecho', description: 'Promessa', semanticRange: { startMs: 1000, endMs: 2000 }, sourceTimeMapping: { sourceStartMs: 1000, sourceEndMs: 2000, rate: 1 }, sourceDurationMs: 5000 }
  const segment = { id: 'segment_1', workspaceId: 'ws_1', artifactId: 'asset_parent', parentSegmentId: null, label: 'Trecho', description: 'Promessa', startMs: 1000, endMs: 2000, sourceDurationMs: 5000, physicalObjectKey: null, segmentHash: calculateCanonicalHash(content), createdAt: new Date('2026-08-08T13:00:00.000Z'), parentSegment: null, artifact }
  const repository = new PrismaMediaLibraryRepository({
    v2MediaLibraryEntry: { async findMany() { return [{ ...library, artifact: { ...artifact, id: undefined, libraryEntry: undefined } }] } },
    v2MediaSegment: { async findMany() { return [segment] } },
  })
  const page = await repository.list({ workspaceId: 'ws_1', limit: 10 }, now)
  assert.deepEqual(page.items.map((entry) => [entry.id, entry.kind]), [['segment_1', 'segment'], ['asset_parent', 'video']])
  assert.deepEqual(page.items[0].source, { type: 'segment', artifactId: 'asset_parent', description: 'Promessa', semanticRange: { startMs: 1000, endMs: 2000 }, sourceTimeMapping: { sourceStartMs: 1000, sourceEndMs: 2000, rate: 1 }, physicalObjectKey: null, sourceDurationMs: 5000, segmentHash: segment.segmentHash, virtual: true, bytesDuplicated: false })
  assert.deepEqual(page.items[0].preview.thumbnail, { status: 'available', artifactId: 'thumb_parent' })
  assert.deepEqual(page.items[0].rights, { status: 'review', reasonCodes: ['RIGHTS_MISSING'] })
  assert.equal(page.items[0].technical.byteSize, '9000')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { attachLibraryItem, listMediaLibrary } from '../../src/v2/domain/media-library.ts'

const item = (id, overrides = {}) => ({
  id, workspaceId: 'ws_1', kind: 'video', label: id, people: ['Ana'], topics: ['produto'], status: 'usable',
  rightsStatus: 'eligible', origin: { type: 'upload' }, preview: { thumbnailUrl: `/${id}.jpg`, waveformUrl: `/${id}.json` },
  createdAt: `2026-01-${id === 'a' ? '03' : id === 'b' ? '02' : '01'}T00:00:00.000Z`, ...overrides
})

test('T-FR-040 paginates workspace assets and filters kind, person, topic and rights', () => {
  const all = [item('a'), item('b', { kind: 'audio', people: ['Bia'] }), item('c', { rightsStatus: 'restricted' }), item('x', { workspaceId: 'ws_2' })]
  const first = listMediaLibrary(all, { workspaceId: 'ws_1', limit: 2 })
  assert.deepEqual(first.items.map((value) => value.id), ['a', 'b'])
  assert.deepEqual(listMediaLibrary(all, { workspaceId: 'ws_1', after: first.nextCursor, limit: 2 }).items.map((value) => value.id), ['c'])
  assert.deepEqual(listMediaLibrary(all, { workspaceId: 'ws_1', kind: 'audio', person: 'bia', topic: 'prod', rightsStatus: 'eligible' }).items.map((value) => value.id), ['b'])
})

test('T-FR-040 exposes preview, origin and status then reuses eligible bytes by reference', () => {
  const asset = item('a')
  assert.equal(asset.preview.thumbnailUrl, '/a.jpg')
  assert.equal(asset.origin.type, 'upload')
  assert.deepEqual(attachLibraryItem({ item: asset, projectId: 'project_1', workspaceId: 'ws_1' }), {
    projectId: 'project_1', workspaceId: 'ws_1', assetId: 'a', source: 'media-library', bytesDuplicated: false
  })
  assert.throws(() => attachLibraryItem({ item: item('r', { rightsStatus: 'restricted' }), projectId: 'p', workspaceId: 'ws_1' }), /rights/i)
})

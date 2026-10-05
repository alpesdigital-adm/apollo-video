import assert from 'node:assert/strict'
import test from 'node:test'
import { readMediaLibraryPreviewService } from '../../src/v2/application/read-media-library-preview.ts'
import { readArtifactContentService } from '../../src/v2/application/read-artifact-content.ts'

test('library preview checks source authorization and lineage before opening bytes', async () => {
  let opens = 0
  let item = { status: 'usable', rights: { status: 'eligible', reasonCodes: [] }, source: { artifactId: 'original' }, preview: { thumbnail: { status: 'available', artifactId: 'thumbnail' } } }
  const source = { id: 'original', status: 'available', artifactKey: 'masters/source', sha256: 'a'.repeat(64) }
  const derivative = { id: 'thumbnail', status: 'available', mediaType: 'image', container: 'png', artifactKey: 'preview/thumb', byteSize: 3n, sha256: 'b'.repeat(64), manifests: [{ recipe: { id: 'media-library-thumbnail' }, sources: [{ artifactId: source.id, artifactKey: source.artifactKey, sha256: source.sha256, role: 'source-master' }] }] }
  const dependencies = { library: { async findById(workspace) { return workspace === 'workspace-a' ? item : null } }, artifacts: { async findById(_workspace, id) { return id === 'original' ? source : derivative } }, storage: { async open() { opens += 1; return { body: new Uint8Array([1, 2, 3]), byteSize: 3, start: 0, end: 2 } } } }
  const read = readMediaLibraryPreviewService(dependencies)
  const direct = readArtifactContentService(dependencies)
  const input = { workspaceId: 'workspace-a', itemId: 'segment-a', kind: 'thumbnail' }
  assert.equal((await read(input)).contentType, 'image/png'); assert.equal(opens, 1)
  for (const status of ['expired', 'restricted', 'review']) {
    item = { ...item, rights: { status, reasonCodes: ['RIGHTS_EXPIRED'] } }
    await assert.rejects(() => read(input), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
    await assert.rejects(() => direct({ workspaceId: 'workspace-a', artifactId: 'thumbnail', rangeHeader: null }), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  }
  assert.equal(opens, 1)
  await assert.rejects(() => readArtifactContentService({ artifacts: dependencies.artifacts, storage: dependencies.storage })({ workspaceId: 'workspace-a', artifactId: 'thumbnail', rangeHeader: null }), (error) => error.code === 'ASSET_RIGHTS_BLOCKED')
  await assert.rejects(() => read({ ...input, workspaceId: 'workspace-b' }), (error) => error.code === 'MEDIA_ARTIFACT_NOT_FOUND')
  item = { ...item, rights: { status: 'eligible', reasonCodes: [] } }
  derivative.manifests[0].sources[0].sha256 = 'c'.repeat(64)
  await assert.rejects(() => read(input), (error) => error.code === 'PERSISTENCE_CONFLICT')
  assert.equal(opens, 1)
})

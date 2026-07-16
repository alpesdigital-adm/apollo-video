import assert from 'node:assert/strict'
import test from 'node:test'

import { assertNoPermanentStorageIdentity, publicArtifactReference } from '../../src/v2/public-api/public-media-identity.ts'
import { PUBLIC_SCHEMAS } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { presentMediaArtifact } from '../../src/v2/public-api/presenters.ts'

test('all public examples exclude permanent storage identities', () => {
  for (const schema of PUBLIC_SCHEMAS) {
    for (const example of publicSchemaExamples(schema)) assert.doesNotThrow(() => assertNoPermanentStorageIdentity(example), schema.ref)
  }
})

test('public artifact presentation replaces internal keys with logical references', () => {
  const output = presentMediaArtifact({
    id: 'artifact-output-1', workspaceId: 'workspace-1', artifactKey: 'workspaces/1/private/output.mp4', sha256: 'a'.repeat(64), byteSize: 10n,
    mediaType: 'video', container: 'mp4', status: 'available', createdAt: '2026-07-16T23:00:00.000Z',
    manifests: [{ id: 'manifest-1', schemaVersion: 'v1', manifestHash: 'b'.repeat(64), recipe: { id: 'test', version: 'v1', parametersHash: 'c'.repeat(64) }, createdAt: '2026-07-16T23:00:00.000Z', sources: [{ artifactId: 'artifact-source-1', artifactKey: 'workspaces/1/private/source.mov', sha256: 'd'.repeat(64), role: 'primary', ordinal: 0 }] }],
  })
  assert.equal(output.artifact.artifactKey, 'artifact:artifact-output-1')
  assert.equal(output.manifests[0].sources[0].artifactKey, 'artifact:artifact-source-1')
  assert.equal(JSON.stringify(output).includes('workspaces/1/private'), false)
  assert.doesNotThrow(() => assertNoPermanentStorageIdentity(output))
})

test('storage-shaped keys and path-shaped artifact references fail closed', () => {
  assert.throws(() => assertNoPermanentStorageIdentity({ storagePath: '/private/file.mp4' }), /forbidden/)
  assert.throws(() => assertNoPermanentStorageIdentity({ artifactKey: 'workspace/private/file.mp4' }), /opaque/)
  assert.throws(() => publicArtifactReference('../artifact'), /represented publicly/)
})

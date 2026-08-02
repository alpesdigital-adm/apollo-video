import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { assertNoPermanentStorageIdentity, publicArtifactReference } from '../../src/v2/public-api/public-media-identity.ts'
import { getPublicSchema, PUBLIC_SCHEMAS } from '../../src/v2/public-api/schema-registry.ts'
import { publicSchemaExamples } from '../../src/v2/public-api/schema-examples.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  presentMediaArtifact,
  presentMediaArtifactV3,
  presentMediaArtifactV4,
} from '../../src/v2/public-api/presenters.ts'

test('all public examples exclude permanent storage identities', () => {
  for (const schema of PUBLIC_SCHEMAS) {
    for (const example of publicSchemaExamples(schema)) assert.doesNotThrow(() => assertNoPermanentStorageIdentity(example), schema.ref)
  }
})

test('public artifact presentation replaces internal keys with logical references', () => {
  const output = presentMediaArtifact({
    id: 'artifact-output-1', workspaceId: 'workspace-1', artifactKey: 'workspaces/1/private/output.mp4', sha256: 'a'.repeat(64), byteSize: 10n,
    mediaType: 'video', container: 'mp4', status: 'available', lifecycleRevision: 1, createdAt: '2026-07-16T23:00:00.000Z',
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

test('T-FR-236 maps the three persisted artifact lifecycle states without conflating stale', () => {
  const base = {
    id: 'artifact-output-1', workspaceId: 'workspace-1',
    artifactKey: 'private/artifact-output-1.mp4', sha256: 'a'.repeat(64),
    byteSize: 10n, mediaType: 'video', container: 'mp4',
    lifecycleRevision: 1, createdAt: '2026-07-16T23:00:00.000Z', manifests: [],
  }
  const available = presentMediaArtifactV3({ ...base, status: 'available' })
  const quarantined = presentMediaArtifactV3({ ...base, status: 'quarantined' })
  const deleted = presentMediaArtifactV3({ ...base, status: 'deleted' })
  const availableV4 = presentMediaArtifactV4({ ...base, status: 'available' })

  assert.deepEqual(available.artifact.visibleState, {
    schemaVersion: 'visible-state/v1', label: 'available', tone: 'success',
    progress: { mode: 'none' }, primaryAction: 'open-result',
    availableActions: ['open-result'], terminal: true,
  })
  assert.equal(quarantined.artifact.visibleState.label, 'quarantined')
  assert.equal(quarantined.artifact.visibleState.primaryAction, 'inspect-error')
  assert.equal(quarantined.artifact.visibleState.terminal, false)
  assert.equal(deleted.artifact.visibleState.label, 'deleted')
  assert.equal(deleted.artifact.visibleState.primaryAction, 'inspect-history')
  assert.notEqual(available.artifact.visibleState.label, 'stale-output')
  assert.throws(() => available.artifact.visibleState.availableActions.push('retry'))
  assert.throws(
    () => presentMediaArtifactV3({ ...base, status: 'stale' }),
    /lifecycle status is invalid/,
  )

  const capability = FOUNDATION_CAPABILITIES.find((item) =>
    item.id === 'apollo.artifacts.read')
  assert.equal(capability.version, '4.0.0')
  assert.equal(capability.outputSchemaRef, 'apollo://schemas/artifact-detail/v4')
  assert.equal(
    getPublicSchema('apollo://schemas/artifact-detail/v2').ref,
    'apollo://schemas/artifact-detail/v2',
  )
  const validate = addFormats(new Ajv2020({ strict: false, allErrors: true }))
    .compile(getPublicSchema(capability.outputSchemaRef).schema)
  const validBody = { data: availableV4, meta: { apiVersion: 'v1' } }
  assert.equal(validate(validBody), true, JSON.stringify(validate.errors))
  const mismatched = structuredClone(validBody)
  mismatched.data.artifact.visibleState = quarantined.artifact.visibleState
  assert.equal(validate(mismatched), false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { referencesOfVariant, renderOperationVariantId, renderOutputReferences } from '../../src/v2/domain/output-variant-references.ts'

const entry = (variantId, aspectRatio) => ({ variantId, spec: { output: { aspectRatio } } })
const stateOf = (...entries) => ({ stateHash: 'a'.repeat(64), document: { schemaVersion: 'project-output-state/v3', id: 'state-1', entries, sourceDependencies: null } })
const two = stateOf(entry('variant-vertical', '9:16'), entry('variant-wide', '16:9'))
const one = stateOf(entry('variant-only', '1:1'))

test('a render operation belongs to the output it names, and that output must be a member of its Version', () => {
  assert.equal(renderOperationVariantId(two, { outputVariantId: 'variant-wide' }), 'variant-wide')
  assert.equal(renderOperationVariantId(two, { outputVariantId: 'variant-vertical', outputAspectRatio: '9:16' }), 'variant-vertical')
  assert.throws(() => renderOperationVariantId(two, { outputVariantId: 'variant-other' }), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('a legacy row without a stated output is attributed only when the answer is exact', () => {
  assert.equal(renderOperationVariantId(two, { outputVariantId: null, outputAspectRatio: '16:9' }), 'variant-wide', 'a final names its ratio')
  assert.equal(renderOperationVariantId(one, { outputVariantId: null }), 'variant-only', 'a proxy of a one-output Version')
  assert.throws(() => renderOperationVariantId(two, { outputVariantId: null }), (error) => error.code === 'PERSISTENCE_CONFLICT', 'a proxy of two outputs is never guessed')
  assert.throws(() => renderOperationVariantId(two, { outputVariantId: null, outputAspectRatio: '1:1' }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  const clash = stateOf(entry('variant-a', '9:16'), entry('variant-b', '9:16'))
  assert.throws(() => renderOperationVariantId(clash, { outputVariantId: null, outputAspectRatio: '9:16' }), (error) => error.code === 'PERSISTENCE_CONFLICT')
})

test('the references of a Version list every render under its own output, sorted, and a variant keeps only its own', () => {
  const references = renderOutputReferences({ state: two, sourceVersionId: 'version-1',
    proxies: [{ outputArtifactId: 'proxy-wide', outputVariantId: 'variant-wide' }, { outputArtifactId: 'proxy-vertical', outputVariantId: 'variant-vertical' }],
    finals: [{ outputArtifactId: 'final-wide', outputVariantId: null, outputAspectRatio: '16:9' }] })
  assert.deepEqual(references.map((reference) => `${reference.kind}:${reference.artifactId}:${reference.variantId}`), [
    'final:final-wide:variant-wide', 'proxy:proxy-vertical:variant-vertical', 'proxy:proxy-wide:variant-wide'])
  assert.ok(references.every((reference) => reference.sourceVersionId === 'version-1'))
  assert.deepEqual(referencesOfVariant(references, 'variant-vertical').map((reference) => reference.artifactId), ['proxy-vertical'])
  assert.deepEqual(referencesOfVariant(references, 'variant-none'), [])
})

import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import { PUBLIC_SCHEMA_EXAMPLES } from '../../src/v2/public-api/schema-examples.ts'
const ref = 'apollo://schemas/media-library-attachment/v2'
const validate = addFormats(new Ajv2020({ strict: true, allErrors: true })).compile(getPublicSchema(ref).schema)
const examples = PUBLIC_SCHEMA_EXAMPLES[ref]
test('attachment contract distinguishes asset and complete immutable segment references', () => {
  assert.deepEqual(examples.map((example) => example.data.selection.kind), ['asset', 'segment'])
  for (const example of examples) assert.equal(validate(example), true, JSON.stringify(validate.errors))
  for (const field of ['segmentHash', 'semanticRange', 'sourceTimeMapping']) {
    const segment = structuredClone(examples[1])
    delete segment.data[field]
    assert.equal(validate(segment), false, `segment without ${field} must fail`)
    const asset = structuredClone(examples[0])
    asset.data[field] = examples[1].data[field]
    assert.equal(validate(asset), false, `asset with segment-only ${field} must fail`)
  }
  const invalidHash = structuredClone(examples[1])
  invalidHash.data.segmentHash = 'unverified'
  assert.equal(validate(invalidHash), false)
  const invalidMapping = structuredClone(examples[1])
  invalidMapping.data.sourceTimeMapping.rate = 2
  assert.equal(validate(invalidMapping), false)
})

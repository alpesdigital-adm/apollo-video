import assert from 'node:assert/strict'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { FOUNDATION_CAPABILITIES } from '../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../src/v2/public-api/openapi.ts'
import { readFileSync } from 'node:fs'

import { PUBLIC_SCHEMAS, getPublicSchema } from '../src/v2/public-api/schema-registry.ts'
import {
  createPublicContractSnapshot,
  findBreakingContractChanges,
} from '../src/v2/public-api/contract-snapshot.ts'
import {
  PUBLIC_SCHEMA_EXAMPLES,
  publicSchemaDocument,
  publicSchemaExamples,
} from '../src/v2/public-api/schema-examples.ts'

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)

for (const definition of PUBLIC_SCHEMAS) {
  const document = publicSchemaDocument(definition)
  assert.equal(document.$id, definition.ref)
  assert.equal(document.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(typeof document.title, 'string')
  assert.equal(ajv.validateSchema(document), true, ajv.errorsText(ajv.errors))
  const examples = publicSchemaExamples(definition)
  assert.ok(examples.length > 0, `${definition.ref} must publish at least one example`)
  const validate = ajv.compile(document)
  for (const [index, example] of examples.entries()) {
    assert.equal(
      validate(example),
      true,
      `${definition.ref} example ${index} is invalid: ${ajv.errorsText(validate.errors)}`,
    )
  }
}

const openApi = createOpenApiDocument()
for (const capability of FOUNDATION_CAPABILITIES) {
  getPublicSchema(capability.outputSchemaRef)
  if (capability.inputSchemaRef) getPublicSchema(capability.inputSchemaRef)
  if (!capability.endpoint || capability.exposure === 'internal-only') continue

  const operation =
    openApi.paths[capability.endpoint.path]?.[capability.endpoint.method.toLowerCase()]
  assert.ok(operation, `OpenAPI operation is missing for ${capability.id}`)
  assert.equal(operation['x-apollo-capability-id'], capability.id)
  for (const status of capability.successStatuses) {
    assert.ok(operation.responses[String(status)], `${capability.id} is missing HTTP ${status}`)
  }
}

const serialized = JSON.stringify(openApi)
assert.equal(serialized.includes('undefined'), false)
assert.doesNotThrow(() => JSON.parse(serialized))

const baseline = JSON.parse(
  readFileSync('contracts/v1/public-contract-baseline.json', 'utf8'),
)
const breakingChanges = findBreakingContractChanges(
  baseline,
  createPublicContractSnapshot(),
)
assert.deepEqual(
  breakingChanges,
  [],
  `Breaking public contract changes detected:\n${breakingChanges.join('\n')}`,
)

process.stdout.write(
  `Public contracts verified: ${FOUNDATION_CAPABILITIES.length} capabilities, ` +
    `${PUBLIC_SCHEMAS.length} schemas, ` +
    `${Object.values(PUBLIC_SCHEMA_EXAMPLES).reduce((total, examples) => total + examples.length, 0)} examples, ` +
    `${Object.keys(openApi.paths).length} paths, compatibility baseline intact\n`,
)

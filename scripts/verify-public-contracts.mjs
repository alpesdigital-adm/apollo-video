import assert from 'node:assert/strict'

import { FOUNDATION_CAPABILITIES } from '../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../src/v2/public-api/openapi.ts'
import { PUBLIC_SCHEMAS, getPublicSchema } from '../src/v2/public-api/schema-registry.ts'

for (const definition of PUBLIC_SCHEMAS) {
  assert.equal(definition.schema.$id, definition.ref)
  assert.equal(definition.schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
  assert.equal(typeof definition.schema.title, 'string')
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

process.stdout.write(
  `Public contracts verified: ${FOUNDATION_CAPABILITIES.length} capabilities, ` +
    `${PUBLIC_SCHEMAS.length} schemas, ${Object.keys(openApi.paths).length} paths\n`,
)

import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../../src/v2/public-api/openapi.ts'
import {
  PUBLIC_SCHEMAS,
  getPublicSchema,
  getPublicSchemaByRoute,
  publicSchemaPath,
} from '../../src/v2/public-api/schema-registry.ts'

test('every public capability resolves all declared schema references', () => {
  for (const capability of FOUNDATION_CAPABILITIES) {
    assert.equal(getPublicSchema(capability.outputSchemaRef).ref, capability.outputSchemaRef)
    if (capability.inputSchemaRef) {
      assert.equal(getPublicSchema(capability.inputSchemaRef).ref, capability.inputSchemaRef)
    }
  }
})

test('schema routes are stable, versioned and reject unknown documents', () => {
  const routes = new Set()
  for (const definition of PUBLIC_SCHEMAS) {
    const route = publicSchemaPath(definition)
    assert.match(route, /^\/v1\/schemas\/[a-z0-9-]+\/v[1-9]\d*$/)
    assert.equal(routes.has(route), false)
    routes.add(route)
    assert.equal(
      getPublicSchemaByRoute(definition.id, `v${definition.version}`).ref,
      definition.ref,
    )
  }

  assert.throws(
    () => getPublicSchemaByRoute('missing-schema', 'v1'),
    (error) => error instanceof DomainError && error.code === 'PUBLIC_SCHEMA_NOT_FOUND',
  )
})

test('OpenAPI document contains one operation per exposed endpoint', () => {
  const document = createOpenApiDocument()
  assert.equal(document.openapi, '3.1.0')

  for (const capability of FOUNDATION_CAPABILITIES) {
    if (!capability.endpoint || capability.exposure === 'internal-only') continue
    const operation =
      document.paths[capability.endpoint.path]?.[
        capability.endpoint.method.toLowerCase()
      ]
    assert.ok(operation, `${capability.id} is missing from OpenAPI`)
    assert.equal(operation['x-apollo-capability-id'], capability.id)
    for (const status of capability.successStatuses) {
      assert.ok(operation.responses[String(status)])
    }
  }

  assert.equal(JSON.stringify(document).includes('undefined'), false)
})

test('OpenAPI derives auth, idempotency and optional request bodies from capabilities', () => {
  const document = createOpenApiDocument()
  const createProject = document.paths['/v1/projects'].post
  assert.deepEqual(createProject.security, [{ bearerAuth: [] }])
  assert.equal(createProject.requestBody.required, true)
  assert.ok(
    createProject.parameters.some(
      (parameter) => parameter.in === 'header' && parameter.name === 'Idempotency-Key',
    ),
  )

  const rotate =
    document.paths['/v1/workspaces/{workspaceId}/clients/{clientId}/credentials'].post
  assert.equal(rotate.requestBody.required, false)

  const listProjects = document.paths['/v1/projects'].get
  assert.ok(
    listProjects.parameters.some(
      (parameter) => parameter.in === 'query' && parameter.name === 'limit',
    ),
  )

  const capabilities = document.paths['/v1/capabilities'].get
  assert.deepEqual(capabilities.security, [{}, { bearerAuth: [] }])
})

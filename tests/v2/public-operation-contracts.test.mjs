import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

import { applicationServicesForEndpoint } from '../../scripts/generate-ui-capability-parity-report.mjs'
import {
  FOUNDATION_CAPABILITIES,
  resolveCapabilityAuthScheme,
} from '../../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../../src/v2/public-api/openapi.ts'
import {
  PUBLIC_SCHEMAS,
  getPublicSchema,
} from '../../src/v2/public-api/schema-registry.ts'
import {
  publicSchemaDocument,
  publicSchemaExamples,
} from '../../src/v2/public-api/schema-examples.ts'

const root = resolve(import.meta.dirname, '../..')
const openApi = createOpenApiDocument()
const ajv = addFormats(new Ajv2020({ allErrors: true, strict: true }))
const validatedSchemaRefs = new Set()

test('the public API PostgreSQL journey remains syntactically executable', () => {
  const journey = resolve(root, 'tests/v2/public-project-api.integration.mjs')
  const checked = spawnSync(process.execPath, ['--check', journey], {
    encoding: 'utf8',
    windowsHide: true,
  })
  assert.equal(checked.status, 0, checked.stderr || checked.stdout)
})

for (const definition of PUBLIC_SCHEMAS) {
  const document = publicSchemaDocument(definition)
  assert.equal(ajv.validateSchema(document), true, ajv.errorsText(ajv.errors))
  const validate = ajv.compile(document)
  const examples = publicSchemaExamples(definition)
  assert.ok(examples.length > 0, `${definition.ref} must publish an example`)
  for (const [index, example] of examples.entries()) {
    assert.equal(
      validate(example),
      true,
      `${definition.ref} example ${index}: ${ajv.errorsText(validate.errors)}`,
    )
  }
  validatedSchemaRefs.add(definition.ref)
}

const schemaRefByComponent = new Map(
  Object.entries(openApi.components.schemas).map(([name, schema]) => [name, schema.$id]),
)

const DIRECT_PUBLIC_API_BOUNDARIES = Object.freeze({
  'apollo.health.read': 'health is computed from public runtime configuration',
  'apollo.events.catalog.read': 'the event catalog is the versioned public contract itself',
  'apollo.contracts.openapi.read': 'OpenAPI is generated directly from the public contract registry',
  'apollo.contracts.schemas.read': 'JSON Schemas are read directly from the public schema registry',
  'apollo.subtitle-styles.list': 'the content-addressed subtitle style registry is the versioned public contract itself',
  'apollo.subtitle-styles.preview': 'the instant CSS preview is derived deterministically from the registry, with no persisted state',
})

function routeSourceFor(capability) {
  const relativeRoute = capability.endpoint.path
    .replace(/^\/v1/, '')
    .replaceAll(/\{([^}]+)\}/g, '[$1]')
  const path = resolve(root, `src/app/v1${relativeRoute}/route.ts`)
  assert.equal(existsSync(path), true, `missing route for ${capability.id}`)
  const source = readFileSync(path, 'utf8')
  assert.match(
    source,
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${capability.endpoint.method}\\s*\\(`),
  )
  return source
}

function referencedPublicSchema(operationSchema) {
  const prefix = '#/components/schemas/'
  assert.match(operationSchema?.$ref ?? '', /^#\/components\/schemas\/[A-Za-z0-9]+$/)
  return schemaRefByComponent.get(operationSchema.$ref.slice(prefix.length))
}

function expectedSecurity(capability) {
  if (capability.authMode === 'none') return []
  const authScheme = resolveCapabilityAuthScheme(capability)
  const scheme = authScheme === 'ui-session'
    ? 'uiSession'
    : authScheme === 'signed-token'
      ? 'signedUploadToken'
      : 'bearerAuth'
  return capability.authMode === 'optional' ? [{}, { [scheme]: [] }] : [{ [scheme]: [] }]
}

function parameterMap(operation) {
  return new Map(operation.parameters.map((parameter) => [
    `${parameter.in}:${parameter.name}`,
    parameter,
  ]))
}

test('T-FR-241 every public operation has an executable, versioned contract test', async (t) => {
  assert.equal(FOUNDATION_CAPABILITIES.length, 267)
  const endpoints = new Set()

  for (const capability of FOUNDATION_CAPABILITIES) {
    await t.test(capability.id, () => {
      assert.notEqual(capability.exposure, 'internal-only')
      assert.ok(capability.endpoint)
      const endpointKey = `${capability.endpoint.method} ${capability.endpoint.path}`
      assert.equal(endpoints.has(endpointKey), false, `duplicate endpoint: ${endpointKey}`)
      endpoints.add(endpointKey)

      const routeSource = routeSourceFor(capability)
      if (Object.hasOwn(DIRECT_PUBLIC_API_BOUNDARIES, capability.id)) {
        assert.ok(DIRECT_PUBLIC_API_BOUNDARIES[capability.id].length >= 40)
        assert.match(routeSource, /from ['"]@\/v2\/public-api\//)
      } else {
        const services = applicationServicesForEndpoint(root, capability.endpoint)
        assert.ok(services.length > 0, `${capability.id} does not reach an Application service`)
      }

      const operation = openApi.paths[capability.endpoint.path]?.[
        capability.endpoint.method.toLowerCase()
      ]
      assert.ok(operation, `${capability.id} is absent from OpenAPI`)
      assert.equal(operation['x-apollo-capability-id'], capability.id)
      assert.equal(operation['x-apollo-capability-version'], capability.version)
      assert.deepEqual(operation['x-apollo-required-scopes'], [...capability.requiredScopes])
      assert.equal(operation['x-apollo-idempotency'], capability.idempotency)
      assert.deepEqual(operation.security, expectedSecurity(capability))

      const parameters = parameterMap(operation)
      const pathParameters = [...capability.endpoint.path.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1])
      assert.deepEqual(
        [...parameters.values()].filter((parameter) => parameter.in === 'path')
          .map((parameter) => parameter.name),
        pathParameters,
      )
      for (const parameter of capability.queryParameters ?? []) {
        assert.deepEqual(parameters.get(`query:${parameter.name}`), {
          name: parameter.name,
          in: 'query',
          required: parameter.required,
          description: parameter.description,
          schema: { ...parameter.schema },
        })
      }
      assert.equal(
        parameters.has('header:Idempotency-Key'),
        capability.idempotency === 'required',
      )
      assert.equal(
        parameters.has('header:If-Match'),
        capability.precondition === 'if-match',
      )

      assert.equal(validatedSchemaRefs.has(capability.outputSchemaRef), true)
      for (const status of capability.successStatuses) {
        const response = operation.responses[String(status)]
        assert.ok(response, `${capability.id} lacks success status ${status}`)
        const mediaType = capability.responseMediaType ?? 'application/json'
        assert.equal(
          referencedPublicSchema(response.content[mediaType].schema),
          capability.outputSchemaRef,
        )
      }

      if (capability.inputSchemaRef) {
        assert.equal(validatedSchemaRefs.has(capability.inputSchemaRef), true)
        assert.equal(operation.requestBody.required, capability.requestBodyRequired ?? true)
        const mediaType = capability.requestMediaType ?? 'application/json'
        assert.equal(
          referencedPublicSchema(operation.requestBody.content[mediaType].schema),
          capability.inputSchemaRef,
        )
      } else {
        assert.equal(operation.requestBody, undefined)
      }

      for (const status of ['401', '403', '404', '409', '416', '422', '429', '500', '502', '503']) {
        assert.equal(
          referencedPublicSchema(operation.responses[status].content['application/json'].schema),
          'apollo://schemas/error-envelope/v4',
        )
      }
      assert.equal(getPublicSchema(capability.outputSchemaRef).ref, capability.outputSchemaRef)
    })
  }

  assert.equal(endpoints.size, FOUNDATION_CAPABILITIES.length)
  assert.equal(Object.keys(DIRECT_PUBLIC_API_BOUNDARIES).length, 6)
})

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
import {
  advancePublicOperationPhase,
  createQueuedPublicOperation,
  startPublicOperationAttempt,
  succeedPublicOperation,
} from '../../src/v2/domain/public-operation.ts'
import { FACE0204_OUTPUT_BYTES, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256 } from '../../src/v2/domain/face-detector-output.ts'
import { FACE_EVIDENCE_POLICY, FACE_EVIDENCE_POLICY_SHA256 } from '../../src/v2/domain/face-evidence-policy.ts'
import { ACCEPTED_FACE_PRODUCERS, authenticateFaceEnvelope } from '../../src/v2/domain/face-producer-registry.ts'
import { acceptedProducer, sealedWindow } from './helpers/face-envelope-v2.mjs'
import { sealedSourceWindow } from './helpers/face-source-envelope-v3.mjs'
import { presentPublicOperationV2 } from '../../src/v2/public-api/presenters.ts'
import { assembleServerPerceptionSnapshot, queryServerPerceptionSnapshot } from '../../src/v2/domain/server-perception-snapshot.ts'
import { assemblyBase, ocrEnvelope, temporalEnvelope } from './helpers/perception-snapshot-fixtures.mjs'

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
  assert.equal(FOUNDATION_CAPABILITIES.length, 392)
  assert.deepEqual(FOUNDATION_CAPABILITIES
    .filter((capability) => capability.id.startsWith('apollo.projects.perception-producer-operations.'))
    .map((capability) => capability.id).sort(), [
      'apollo.projects.perception-producer-operations.create',
      'apollo.projects.perception-producer-operations.read',
    ])
  assert.deepEqual(FOUNDATION_CAPABILITIES
    .filter((capability) => capability.id.startsWith('apollo.projects.temporal-producer-operations.'))
    .map((capability) => capability.id).sort(), [
      'apollo.projects.temporal-producer-operations.create',
      'apollo.projects.temporal-producer-operations.read',
    ])
  assert.deepEqual(FOUNDATION_CAPABILITIES
    .filter((capability) => capability.id.startsWith('apollo.projects.face-producer-operations.'))
    .map((capability) => capability.id).sort(), [
      'apollo.projects.face-producer-operations.create',
      'apollo.projects.face-producer-operations.read',
    ])
  assert.deepEqual(FOUNDATION_CAPABILITIES
    .filter((capability) => capability.id.startsWith('apollo.projects.face-window-operations.'))
    .map((capability) => capability.id).sort(), [
      'apollo.projects.face-window-operations.create',
      'apollo.projects.face-window-operations.read',
    ])
  assert.deepEqual(FOUNDATION_CAPABILITIES
    .filter((capability) => capability.id.startsWith('apollo.projects.face-source-windows.'))
    .map((capability) => capability.id).sort(), [
      'apollo.projects.face-source-windows.create',
      'apollo.projects.face-source-windows.read',
    ])
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

test('perception producer public responses accept each real stage and reject unrelated domain phases', () => {
  for (const [name, type, phases] of [
    ['perception', 'perception-producer-run', ['probing', 'transcribing', 'verifying', 'persisting']],
    ['temporal', 'perception-temporal-run', ['probing', 'analyzing', 'verifying', 'persisting']],
    ['face', 'perception-face-run', ['probing', 'analyzing', 'verifying', 'persisting']],
  ]) {
    const created = ajv.getSchema(`apollo://schemas/${name}-producer-operation-created/v1`)
    const read = ajv.getSchema(`apollo://schemas/${name}-producer-operation-read/v1`)
    assert.ok(created)
    assert.ok(read)
    let operation = startPublicOperationAttempt(createQueuedPublicOperation({
      id: `operation-${name}-stages-1`, workspaceId: 'workspace-stages-1',
      projectId: 'project-stages-1', clientId: 'client-stages-1', type,
      target: { type: 'project-version', id: 'version-stages-1' },
      createdAt: '2026-10-08T00:00:00.000Z',
    }), '2026-10-08T00:00:01.000Z')
    for (const [index, phase] of phases.entries()) {
      operation = advancePublicOperationPhase(operation, phase, `2026-10-08T00:00:0${index + 2}.000Z`)
      assert.deepEqual(operation.progress, { completed: index, total: 4, unit: 'stage' })
      const presented = presentPublicOperationV2(operation)
      assert.equal(read({ data: { operation: presented }, meta: { apiVersion: 'v1' } }), true,
        `${name}/${phase}: ${ajv.errorsText(read.errors)}`)
      assert.equal(created({ data: { operation: presented, replayed: true }, meta: { apiVersion: 'v1' } }), true,
        `${name}/${phase} replay: ${ajv.errorsText(created.errors)}`)
    }
    for (const forbidden of ['rendering', 'directing', name === 'perception' ? 'analyzing' : 'transcribing']) {
      assert.throws(() => advancePublicOperationPhase(operation, forbidden, '2026-10-08T00:00:09.000Z'),
        (error) => error.code === 'INVALID_PUBLIC_OPERATION')
    }
    const unknown = structuredClone(presentPublicOperationV2(operation))
    unknown.phase = 'detecting-faces'
    assert.equal(read({ data: { operation: unknown }, meta: { apiVersion: 'v1' } }), false)
  }
})

test('diagnostic face capabilities require scoped auth and do not accept caller safety authority', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((capability) => [capability.id, capability]))
  const create = capabilities.get('apollo.projects.face-producer-operations.create')
  const read = capabilities.get('apollo.projects.face-producer-operations.read')
  assert.equal(create.version, '1.0.0')
  assert.equal(create.authMode, 'required')
  assert.deepEqual(create.requiredScopes, ['projects:write'])
  assert.equal(create.idempotency, 'required')
  assert.equal(create.inputSchemaRef, 'apollo://schemas/face-producer-run-request/v1')
  assert.equal(create.outputSchemaRef, 'apollo://schemas/face-producer-operation-created/v1')
  assert.deepEqual(create.endpoint, { method: 'POST', path: '/v1/projects/{projectId}/face-producer-operations' })
  assert.deepEqual(create.successStatuses, [202, 200])
  assert.equal(read.version, '1.0.0')
  assert.equal(read.authMode, 'required')
  assert.deepEqual(read.requiredScopes, ['projects:read'])
  assert.equal(read.outputSchemaRef, 'apollo://schemas/face-producer-operation-read/v1')
  assert.deepEqual(read.endpoint, { method: 'GET', path: '/v1/projects/{projectId}/face-producer-operations/{operationId}' })

  const request = ajv.getSchema(create.inputSchemaRef)
  assert.ok(request)
  const valid = { projectVersionId: 'version-face-1', sourceArtifactId: 'artifact-face-1', sampleIntervalFrames: 30 }
  assert.equal(request(valid), true, ajv.errorsText(request.errors))
  for (const extra of [{ faceSafety: 'verified' }, { authority: 'server-produced' }, { producer: 'trusted-detector' }]) {
    assert.equal(request({ ...valid, ...extra }), false)
  }
  for (const sampleIntervalFrames of [0, 301]) assert.equal(request({ ...valid, sampleIntervalFrames }), false)
  const response = ajv.getSchema(read.outputSchemaRef)
  assert.ok(response)
  const queued = structuredClone(publicSchemaExamples(getPublicSchema(read.outputSchemaRef))[0])
  assert.equal(response(queued), true, ajv.errorsText(response.errors))
  queued.data.operation.status = 'succeeded'
  queued.data.operation.phase = 'completed'
  assert.equal(response(queued), false, 'successful diagnostic operation must include its sealed envelope')
})

test('owner-accepted face window capabilities require scoped auth, own the cadence and never grant face safety', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((capability) => [capability.id, capability]))
  const create = capabilities.get('apollo.projects.face-window-operations.create')
  const read = capabilities.get('apollo.projects.face-window-operations.read')
  assert.equal(create.version, '1.0.0')
  assert.equal(create.authMode, 'required')
  assert.deepEqual(create.requiredScopes, ['projects:write'])
  assert.equal(create.idempotency, 'required')
  assert.equal(create.inputSchemaRef, 'apollo://schemas/face-window-run-request/v1')
  assert.equal(create.outputSchemaRef, 'apollo://schemas/face-window-operation-created/v1')
  assert.deepEqual(create.endpoint, { method: 'POST', path: '/v1/projects/{projectId}/face-window-operations' })
  assert.deepEqual(create.successStatuses, [202, 200])
  assert.equal(read.version, '1.0.0')
  assert.deepEqual(read.requiredScopes, ['projects:read'])
  assert.equal(read.outputSchemaRef, 'apollo://schemas/face-window-operation-read/v1')
  assert.deepEqual(read.endpoint, { method: 'GET', path: '/v1/projects/{projectId}/face-window-operations/{operationId}' })

  const request = ajv.getSchema(create.inputSchemaRef)
  const valid = { projectVersionId: 'version-face-1', sourceArtifactId: 'artifact-face-1', window: { startTimelineFrame: 100, endTimelineFrame: 250 } }
  assert.equal(request(valid), true, ajv.errorsText(request.errors))
  // cadence, thresholds, profile and every kind of authority are the server's, never the caller's
  for (const extra of [{ sampleIntervalFrames: 5 }, { scoreThreshold: 0.1 }, { detectorProfile: 'openvino-face0204-v9' }, { faceSafety: 'verified' },
    { authority: 'server-produced' }, { producer: 'trusted-detector' }]) {
    assert.equal(request({ ...valid, ...extra }), false, JSON.stringify(extra))
  }
  for (const window of [undefined, {}, { startTimelineFrame: 0 }, { startTimelineFrame: -1, endTimelineFrame: 10 }, { startTimelineFrame: 0, endTimelineFrame: 0 },
    { startTimelineFrame: 0.5, endTimelineFrame: 10 }, { startTimelineFrame: 0, endTimelineFrame: 10, stride: 5 }]) {
    assert.equal(request({ ...valid, window }), false, JSON.stringify(window))
  }

  const response = ajv.getSchema(read.outputSchemaRef)
  const queued = structuredClone(publicSchemaExamples(getPublicSchema(read.outputSchemaRef))[0])
  assert.equal(response(queued), true, ajv.errorsText(response.errors))
  let operation = startPublicOperationAttempt(createQueuedPublicOperation({
    id: 'operation-face-window-succeeded-1', workspaceId: 'workspace-1', projectId: 'project-1', clientId: 'client-1',
    type: 'perception-face-run', target: { type: 'project-version', id: 'version-1' }, createdAt: '2026-10-08T00:00:00.000Z',
  }), '2026-10-08T00:00:01.000Z')
  for (const [index, phase] of ['probing', 'analyzing', 'verifying', 'persisting'].entries()) {
    operation = advancePublicOperationPhase(operation, phase, '2026-10-08T00:00:0' + (index + 2) + '.000Z')
  }
  const succeeded = presentPublicOperationV2(succeedPublicOperation(operation, '2026-10-08T00:00:09.000Z'), { includeProjectId: true })
  assert.equal(response({ data: { operation: succeeded }, meta: { apiVersion: 'v1' } }), false, 'success must carry its sealed envelope and the producer verdict')

  const envelope = sealedWindow({ rowsAt: (frame) => (frame % 10 === 0 ? [[0.9, 0.2, 0.2, 0.4, 0.6]] : []) })
  const authentication = authenticateFaceEnvelope(envelope)
  assert.equal(authentication.authenticated, true)
  const body = (overrides = {}) => ({ data: { operation: succeeded, envelope, producerAuthentication: authentication, ...overrides }, meta: { apiVersion: 'v1' } })
  assert.equal(response(body()), true, ajv.errorsText(response.errors))
  assert.equal(response(body({ envelope: undefined })), false)
  assert.equal(response(body({ producerAuthentication: undefined })), false)

  // a Linux producer is a valid envelope that the registry does not authenticate: both facts are visible
  const linux = sealedWindow({ producer: acceptedProducer('linux') })
  const linuxVerdict = authenticateFaceEnvelope(linux)
  assert.equal(linuxVerdict.authenticated, false)
  assert.equal(response(body({ envelope: linux, producerAuthentication: linuxVerdict })), true, ajv.errorsText(response.errors))

  const edit = (mutate) => { const clone = structuredClone(envelope); mutate(clone); return body({ envelope: clone }) }
  for (const [label, mutate] of [
    ['face safety granted', (value) => { value.faceSafety = 'safe' }],
    ['identity performed', (value) => { value.identity = 'performed' }],
    ['qualified assessment', (value) => { value.producer.assessment.status = 'qualified' }],
    ['independent confirmation', (value) => { value.producer.assessment.independentConfirmation = 'performed' }],
    ['v1 schema version', (value) => { value.schemaVersion = 'face-producer-envelope/v1' }],
    ['other model', (value) => { value.producer.model.xmlSha256 = 'f'.repeat(64) }],
    ['other policy', (value) => { value.policySha256 = 'f'.repeat(64) }],
    ['other detector input', (value) => { value.detectorConfig.inputWidth = 640 }],
    ['wrong raw output size', (value) => { value.samples[0].rawOutput.bytes = FACE0204_OUTPUT_BYTES - 1 }],
    ['score under the collection floor', (value) => { value.samples[2].boxes[0].confidence = 0.1 }],
    ['sixty-one samples', (value) => { value.samples = [...value.samples, ...value.samples, ...value.samples].slice(0, 61) }],
    ['unknown field', (value) => { value.approvedBy = 'someone' }],
  ]) assert.equal(response(edit(mutate)), false, label)
})

test('the published face window envelope contract is pinned to the domain constants it mirrors', () => {
  const schema = getPublicSchema('apollo://schemas/face-window-operation-read/v1')
  const text = JSON.stringify(schema)
  const accepted = ACCEPTED_FACE_PRODUCERS[0]
  for (const pinned of [FACE_EVIDENCE_POLICY.id, FACE_EVIDENCE_POLICY_SHA256, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256,
    accepted.model.xmlSha256, accepted.model.binSha256, accepted.model.licenseSha256, accepted.model.sourceCommit,
    accepted.v9ReceiptSha256, accepted.v9PreregistrationSha256, accepted.ownerAcceptanceSha256]) {
    assert.ok(text.includes(pinned), pinned + ' is not in the published schema')
  }
  // The sampled-frame cap and the windows the policy allows are the same numbers the schema states.
  assert.equal(FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow, 60)
  assert.equal(FACE_EVIDENCE_POLICY.sampling.maxWindowFrames, 300)
  const request = getPublicSchema('apollo://schemas/face-window-run-request/v1')
  assert.match(JSON.stringify(request), /at most 300 frames and at most 60 sampled frames/)
})

test('face source window capabilities are keyed by the source, own the cadence and never grant face safety', () => {
  const capabilities = new Map(FOUNDATION_CAPABILITIES.map((capability) => [capability.id, capability]))
  const create = capabilities.get('apollo.projects.face-source-windows.create')
  const read = capabilities.get('apollo.projects.face-source-windows.read')
  assert.equal(create.version, '1.0.0')
  assert.equal(create.authMode, 'required')
  assert.deepEqual(create.requiredScopes, ['projects:write'])
  assert.equal(create.idempotency, 'required')
  assert.equal(create.inputSchemaRef, 'apollo://schemas/face-source-window-run-request/v1')
  assert.equal(create.outputSchemaRef, 'apollo://schemas/face-source-window-operation-created/v1')
  assert.deepEqual(create.endpoint, { method: 'POST', path: '/v1/projects/{projectId}/face-source-windows' })
  assert.deepEqual(create.successStatuses, [202, 200])
  assert.equal(read.version, '1.0.0')
  assert.deepEqual(read.requiredScopes, ['projects:read'])
  assert.equal(read.outputSchemaRef, 'apollo://schemas/face-source-window-operation-read/v1')
  assert.deepEqual(read.endpoint, { method: 'GET', path: '/v1/projects/{projectId}/face-source-windows/{operationId}' })

  const request = ajv.getSchema(create.inputSchemaRef)
  const valid = { sourceArtifactId: 'artifact-face-1', window: { startSourceFrame: 100, endSourceFrame: 250 } }
  assert.equal(request(valid), true, ajv.errorsText(request.errors))
  // the request names the SOURCE: no Version, no timeline range; cadence, thresholds and every kind of authority are the server's
  for (const extra of [{ projectVersionId: 'version-face-1' }, { sampleIntervalFrames: 5 }, { scoreThreshold: 0.1 },
    { detectorProfile: 'openvino-face0204-v9-source' }, { faceSafety: 'verified' }, { authority: 'server-produced' },
    { producer: 'trusted-detector' }, { sourceSha256: 'f'.repeat(64) }]) {
    assert.equal(request({ ...valid, ...extra }), false, JSON.stringify(extra))
  }
  for (const window of [undefined, {}, { startSourceFrame: 0 }, { startSourceFrame: -1, endSourceFrame: 10 }, { startSourceFrame: 0, endSourceFrame: 0 },
    { startSourceFrame: 0.5, endSourceFrame: 10 }, { startSourceFrame: 0, endSourceFrame: 10, stride: 5 },
    { startTimelineFrame: 0, endTimelineFrame: 10 }]) {
    assert.equal(request({ ...valid, window }), false, JSON.stringify(window))
  }
  assert.equal(request({ window: valid.window }), false, 'the source is required')

  const response = ajv.getSchema(read.outputSchemaRef)
  const queued = structuredClone(publicSchemaExamples(getPublicSchema(read.outputSchemaRef))[0])
  assert.equal(response(queued), true, ajv.errorsText(response.errors))
  let operation = startPublicOperationAttempt(createQueuedPublicOperation({
    id: 'operation-face-source-window-succeeded-1', workspaceId: 'workspace-1', projectId: 'project-1', clientId: 'client-1',
    type: 'perception-face-run', target: { type: 'project-version', id: 'version-1' }, createdAt: '2026-10-18T00:00:00.000Z',
  }), '2026-10-18T00:00:01.000Z')
  for (const [index, phase] of ['probing', 'analyzing', 'verifying', 'persisting'].entries()) {
    operation = advancePublicOperationPhase(operation, phase, '2026-10-18T00:00:0' + (index + 2) + '.000Z')
  }
  const succeeded = presentPublicOperationV2(succeedPublicOperation(operation, '2026-10-18T00:00:09.000Z'), { includeProjectId: true })
  assert.equal(response({ data: { operation: succeeded }, meta: { apiVersion: 'v1' } }), false, 'success must carry its sealed envelope and the producer verdict')

  const envelope = sealedSourceWindow({ rowsAt: (frame) => (frame % 10 === 0 ? [[0.9, 0.2, 0.2, 0.4, 0.6]] : []) })
  const authentication = authenticateFaceEnvelope(envelope)
  assert.equal(authentication.authenticated, true)
  const body = (overrides = {}) => ({ data: { operation: succeeded, envelope, producerAuthentication: authentication, ...overrides }, meta: { apiVersion: 'v1' } })
  assert.equal(response(body()), true, ajv.errorsText(response.errors))
  assert.equal(response(body({ envelope: undefined })), false)
  assert.equal(response(body({ producerAuthentication: undefined })), false)

  // a Linux producer is a valid envelope that the registry does not authenticate: both facts are visible
  const linux = sealedSourceWindow({ producer: acceptedProducer('linux') })
  const linuxVerdict = authenticateFaceEnvelope(linux)
  assert.equal(linuxVerdict.authenticated, false)
  assert.equal(response(body({ envelope: linux, producerAuthentication: linuxVerdict })), true, ajv.errorsText(response.errors))

  // an unknown-sample window with a failed detector frame is still a valid, sealed envelope
  const withFailure = sealedSourceWindow({ rowsAt: (frame) => (frame === 20 ? 'unknown' : []) })
  assert.equal(response(body({ envelope: withFailure, producerAuthentication: authenticateFaceEnvelope(withFailure) })), true, ajv.errorsText(response.errors))

  const edit = (mutate) => { const clone = structuredClone(envelope); mutate(clone); return body({ envelope: clone }) }
  for (const [label, mutate] of [
    ['face safety granted', (value) => { value.faceSafety = 'safe' }],
    ['identity performed', (value) => { value.identity = 'performed' }],
    ['qualified assessment', (value) => { value.producer.assessment.status = 'qualified' }],
    ['independent confirmation', (value) => { value.producer.assessment.independentConfirmation = 'performed' }],
    ['v2 schema version', (value) => { value.schemaVersion = 'face-producer-envelope/v2' }],
    ['a project in the evidence', (value) => { value.projectId = 'project-1' }],
    ['a version in the evidence', (value) => { value.projectVersionId = 'version-1' }],
    ['a time map in the evidence', (value) => { value.timeMap = [] }],
    ['a timeline window', (value) => { value.window = { startTimelineFrame: 0, endTimelineFrame: 10 } }],
    ['a timeline frame on a sample', (value) => { value.samples[0].timelineFrame = 0 }],
    ['non-integer frame rate', (value) => { value.sourceFps = { num: 30000, den: 1001 } }],
    ['variable frame rate', (value) => { value.sourceClock = 'variable-frame-rate' }],
    ['rotated source', (value) => { value.sourceOrientation = 'rotation-90' }],
    ['other model', (value) => { value.producer.model.xmlSha256 = 'f'.repeat(64) }],
    ['other policy', (value) => { value.policySha256 = 'f'.repeat(64) }],
    ['other detector input', (value) => { value.detectorConfig.inputWidth = 640 }],
    ['wrong raw output size', (value) => { value.samples[0].rawOutput.bytes = FACE0204_OUTPUT_BYTES - 1 }],
    ['score under the collection floor', (value) => { value.samples[2].boxes[0].confidence = 0.1 }],
    ['sixty-one samples', (value) => { value.samples = [...value.samples, ...value.samples, ...value.samples].slice(0, 61) }],
    ['a gap without a reason', (value) => { value.gaps = [{ startSourceFrame: 0, endSourceFrame: 1, reasonCode: 'not a code' }] }],
    ['unknown field', (value) => { value.approvedBy = 'someone' }],
  ]) assert.equal(response(edit(mutate)), false, label)
})

test('the published face source window envelope contract is pinned to the domain constants it mirrors', () => {
  const schema = getPublicSchema('apollo://schemas/face-source-window-operation-read/v1')
  const text = JSON.stringify(schema)
  const accepted = ACCEPTED_FACE_PRODUCERS[0]
  for (const pinned of [FACE_EVIDENCE_POLICY.id, FACE_EVIDENCE_POLICY_SHA256, FACE0204_OUTPUT_POLICY_ID, FACE0204_OUTPUT_POLICY_SHA256,
    accepted.model.xmlSha256, accepted.model.binSha256, accepted.model.licenseSha256, accepted.model.sourceCommit,
    accepted.v9ReceiptSha256, accepted.v9PreregistrationSha256, accepted.ownerAcceptanceSha256, 'face-producer-envelope/v3']) {
    assert.ok(text.includes(pinned), pinned + ' is not in the published schema')
  }
  assert.equal(FACE_EVIDENCE_POLICY.sampling.maxSamplesPerWindow, 60)
  assert.equal(FACE_EVIDENCE_POLICY.sampling.maxWindowFrames, 300)
  const request = getPublicSchema('apollo://schemas/face-source-window-run-request/v1')
  assert.match(JSON.stringify(request), /at most 300 frames, at most 60 sampled frames/)
  // the timeline-keyed contract is untouched by the source-keyed one
  assert.ok(JSON.stringify(getPublicSchema('apollo://schemas/face-window-operation-read/v1')).includes('face-producer-envelope/v2'))
  assert.ok(!JSON.stringify(getPublicSchema('apollo://schemas/face-window-operation-read/v1')).includes('face-producer-envelope/v3'))
})

test('T-F4.015 each renderable-plan compiler is reached by its own route and by no other', () => {
  // The dead wiring this refuses: `createReactPlaybackMapServices` built a
  // `compile:` member that nothing ever called once the published route moved
  // to `createReactPlaybackPlanCompileService`. The walker follows a factory
  // call into every service the factory constructs, so that one dead member
  // attributed the compiler to the build and the anchors rows of the parity
  // report — two endpoints whose handlers never invoke it. That is not only a
  // cosmetic inflation: `api-governance-coverage.test.mjs` matches a route's
  // required scope against the concatenated source of every service attributed
  // to it, so a sibling dragged in by a factory can satisfy an assertion the
  // route itself would fail.
  const attribution = new Map([
    ['compileReactPlaybackPlanService', []],
    ['compileSynthesisRenderPlanService', []],
  ])
  for (const capability of FOUNDATION_CAPABILITIES) {
    if (Object.hasOwn(DIRECT_PUBLIC_API_BOUNDARIES, capability.id)) continue
    const services = applicationServicesForEndpoint(root, capability.endpoint)
    for (const [service, endpoints] of attribution) {
      if (services.includes(service)) {
        endpoints.push(`${capability.endpoint.method} ${capability.endpoint.path}`)
      }
    }
  }
  assert.deepEqual(
    attribution.get('compileReactPlaybackPlanService'),
    ['POST /v1/projects/{projectId}/capture-sessions/{sessionId}/playback-map/plan'],
  )
  assert.deepEqual(
    attribution.get('compileSynthesisRenderPlanService'),
    ['POST /v1/projects/{projectId}/editorial-syntheses/{synthesisId}/render-plan'],
  )
})

test('the server perception snapshot capability is a scoped query that answers with server provenance and honest coverage', () => {
  const capability = FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.perception.snapshot.read')
  assert.ok(capability)
  assert.equal(capability.version, '1.0.0')
  assert.equal(capability.operationKind, 'query')
  assert.deepEqual(capability.requiredScopes, ['projects:read'])
  assert.deepEqual(capability.endpoint, { method: 'GET', path: '/v1/projects/{projectId}/perception/snapshot' })
  assert.deepEqual(capability.queryParameters.map((parameter) => parameter.name), ['versionId', 'fromMs', 'toMs', 'kinds'])
  assert.ok(capability.queryParameters.every((parameter) => parameter.required === false))
  assert.deepEqual(capability.successStatuses, [200])
  // The manual timeline of PUT /perception keeps its own capability, schema and label.
  assert.equal(FOUNDATION_CAPABILITIES.find((item) => item.id === 'apollo.projects.perception.read').outputSchemaRef, 'apollo://schemas/perception-range-response/v2')
  const response = ajv.getSchema(capability.outputSchemaRef)
  assert.equal(response(structuredClone(publicSchemaExamples(getPublicSchema(capability.outputSchemaRef))[0])), true, ajv.errorsText(response.errors))

  // A real snapshot, queried the way the service queries it, satisfies the published schema.
  const snapshot = assembleServerPerceptionSnapshot(assemblyBase({ extra: { ocr: [ocrEnvelope({ frames: [0, 30] })], temporal: [temporalEnvelope()] } }))
  const base = {
    id: `perception-snapshot-${snapshot.snapshotHash.slice(0, 40)}`, workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1',
    createdAt: '2026-10-19T00:00:00.000Z', origin: { kind: 'server-assembled', manualTimelinesIncluded: false },
    snapshot: { schemaVersion: snapshot.schemaVersion, snapshotHash: snapshot.snapshotHash, timelineHash: snapshot.timeline.timelineHash,
      faceSafety: snapshot.faceSafety, editPlan: snapshot.editPlan, timeBase: snapshot.timeBase, sources: snapshot.sources,
      inputs: snapshot.inputs, rejected: snapshot.rejected },
    result: queryServerPerceptionSnapshot(snapshot, { fromMs: 0, toMs: 2_000 }),
  }
  const envelope = (data) => ({ data, meta: { apiVersion: 'v1' } })
  assert.equal(response(envelope(base)), true, ajv.errorsText(response.errors))
  // Each way a response could overstate what the server examined, or pass a caller's timeline off as the server's, is refused.
  const edit = (mutate) => { const clone = structuredClone(base); mutate(clone); return envelope(clone) }
  for (const [label, mutate] of [
    ['manual origin', (value) => { value.origin.kind = 'manual-controlled' }],
    ['manual timelines included', (value) => { value.origin.manualTimelinesIncluded = true }],
    ['invented values', (value) => { value.result.inventedValues = 1 }],
    ['face safety granted', (value) => { value.snapshot.faceSafety = 'safe' }],
    ['observation without server provenance', (value) => { delete value.result.observations[0].provenance.origin }],
    ['observation provenance of a caller', (value) => { value.result.observations[0].provenance = { source: 'caller', model: 'caller', version: 'v1', confidence: 0.99 } }],
    ['unknown confidence basis', (value) => { value.result.observations[0].provenance.confidenceBasis = 'believed' }],
    ['coverage state invented', (value) => { value.result.coverage[0].state = 'unknown' }],
    ['coverage without its unexamined ranges', (value) => { delete value.result.coverage[0].unexaminedRanges }],
    ['reason code in lower case', (value) => { value.result.coverage.find((entry) => entry.state === 'absent').reasonCode = 'no_verified_detector' }],
    ['extra field on the snapshot', (value) => { value.snapshot.manualTimeline = {} }],
    ['unhashed snapshot', (value) => { value.snapshot.snapshotHash = 'not-a-hash' }],
    ['unverified source bytes', (value) => { value.snapshot.sources[0].sha256 = null }],
    ['unverified EditPlan', (value) => { value.snapshot.editPlan.snapshotHash = null }],
  ]) {
    assert.equal(response(edit(mutate)), false, label)
  }
  // The object kind is always absent for lack of a verified detector; the response carries that reason, not a state of its own.
  const object = base.result.coverage.find((entry) => entry.kind === 'object')
  assert.deepEqual([object.state, object.reasonCode, object.observedMs], ['absent', 'NO_VERIFIED_DETECTOR', 0])
})

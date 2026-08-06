import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { createPublicApiDocumentationBundle } from '../../scripts/build-public-api-documentation.mjs'
import { PUBLIC_EVENT_CATALOG } from '../../src/v2/domain/public-event.ts'
import {
  FOUNDATION_CAPABILITIES,
  capabilitiesForScopes,
} from '../../src/v2/public-api/capability-registry.ts'
import { createOpenApiDocument } from '../../src/v2/public-api/openapi.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import {
  PUBLIC_DEPRECATIONS,
  definePublicDeprecationRegistry,
  isPublicMigrationGuidePath,
  publicDeprecationHeadersForSchema,
} from '../../src/v2/public-api/deprecations.ts'
import {
  PUBLIC_ERROR_CATALOG,
  PUBLIC_ERROR_CODES,
  definePublicErrorCatalog,
} from '../../src/v2/public-api/public-error-catalog.ts'
import {
  agentDataBoundaryForSchemas,
  agentToolsForCapabilities,
} from '../../src/v2/public-api/agent-tool-catalog.ts'
import {
  FOUNDATION_AGENT_TOOL_SAFETY,
  defineAgentToolSafetyRegistry,
  requireAgentToolExecutionGate,
} from '../../src/v2/public-api/agent-tool-safety.ts'
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

test('documentation build deterministically publishes OpenAPI and every versioned schema', () => {
  const first = createPublicApiDocumentationBundle()
  const second = createPublicApiDocumentationBundle()
  assert.equal(first.manifest.bundleHash, second.manifest.bundleHash)
  assert.equal(first.manifest.capabilityCount, FOUNDATION_CAPABILITIES.length)
  assert.equal(first.manifest.schemaCount, PUBLIC_SCHEMAS.length)
  assert.equal(first.manifest.migrationGuideCount, Object.keys(PUBLIC_DEPRECATIONS).length)
  assert.equal(first.files.length, PUBLIC_SCHEMAS.length + 2)
  assert.match(first.manifest.bundleHash, /^[a-f0-9]{64}$/)

  for (const file of first.files) {
    assert.equal(createHash('sha256').update(file.content).digest('hex'), file.sha256)
    assert.equal(Buffer.byteLength(file.content), file.bytes)
    if (file.path.endsWith('.json')) {
      assert.doesNotThrow(() => JSON.parse(file.content))
    } else {
      assert.match(file.path, /^migration-guides\/[a-z0-9-]+\.md$/)
      assert.match(file.content, /^# /)
    }
  }
  const openApi = JSON.parse(first.files.find((file) => file.path === 'openapi.json').content)
  assert.equal(Object.keys(openApi.paths).length, first.manifest.pathCount)
  for (const definition of PUBLIC_SCHEMAS) {
    const path = `schemas/${definition.id}/v${definition.version}.json`
    const document = JSON.parse(first.files.find((file) => file.path === path).content)
    assert.equal(document.$id, definition.ref)
    assert.ok(document.examples.length > 0)
  }
  const migrationGuide = first.files.find(
    (file) => file.path === 'migration-guides/error-envelope-v1-to-v3.md',
  )
  assert.match(migrationGuide.content, /apollo:\/\/schemas\/error-envelope\/v3/)
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

test('deprecated public schemas publish stable RFC headers and a local migration guide', () => {
  const definition = PUBLIC_DEPRECATIONS['apollo://schemas/error-envelope/v1']
  assert.equal(Object.isFrozen(PUBLIC_DEPRECATIONS), true)
  assert.equal(Object.keys(PUBLIC_DEPRECATIONS).length, 1)
  assert.equal(Object.isFrozen(definition), true)
  assert.equal(getPublicSchema(definition.schemaRef).ref, definition.schemaRef)
  assert.deepEqual(definition, {
    schemaRef: 'apollo://schemas/error-envelope/v1',
    deprecatedAt: '2026-08-03T00:00:00.000Z',
    sunsetAt: '2027-08-03T00:00:00.000Z',
    migrationGuide: '/migration-guides/error-envelope-v1-to-v3.md',
  })
  assert.deepEqual(publicDeprecationHeadersForSchema(definition.schemaRef), {
    Deprecation: '@1785715200',
    Sunset: 'Tue, 03 Aug 2027 00:00:00 GMT',
    Link: '</migration-guides/error-envelope-v1-to-v3.md>; rel="deprecation"; type="text/markdown"',
  })
  assert.deepEqual(publicDeprecationHeadersForSchema('apollo://schemas/error-envelope/v3'), {})
  assert.equal(isPublicMigrationGuidePath(definition.migrationGuide), true)
  assert.equal(isPublicMigrationGuidePath('/migration-guides/unregistered.md'), false)
  assert.equal(isPublicMigrationGuidePath('/login'), false)

  const valid = { ...definition }
  assert.throws(() => definePublicDeprecationRegistry([valid, valid]), /duplicate/)
  assert.throws(
    () => definePublicDeprecationRegistry([{ ...valid, schemaRef: 'not-a-schema' }]),
    /schemaRef/,
  )
  assert.throws(
    () => definePublicDeprecationRegistry([{ ...valid, deprecatedAt: '2026-08-03' }]),
    /deprecatedAt/,
  )
  assert.throws(
    () => definePublicDeprecationRegistry([{ ...valid, sunsetAt: valid.deprecatedAt }]),
    /180 days/,
  )
  assert.throws(
    () => definePublicDeprecationRegistry([{ ...valid, migrationGuide: '/../private.md' }]),
    /migrationGuide/,
  )
})

test('public error catalog classifies every public code exactly once and fails closed', () => {
  assert.deepEqual(Object.keys(PUBLIC_ERROR_CATALOG).sort(), [...PUBLIC_ERROR_CODES].sort())
  assert.equal(Object.isFrozen(PUBLIC_ERROR_CATALOG), true)
  assert.deepEqual(PUBLIC_ERROR_CATALOG.AUTH_INVALID, {
    code: 'AUTH_INVALID', status: 401, category: 'auth', retryable: false,
    message: 'Auth invalid',
  })
  assert.deepEqual(PUBLIC_ERROR_CATALOG.VERSION_CONFLICT, {
    code: 'VERSION_CONFLICT', status: 409, category: 'conflict', retryable: false,
    message: 'Version conflict',
  })
  assert.deepEqual(PUBLIC_ERROR_CATALOG.ASSET_RIGHTS_BLOCKED, {
    code: 'ASSET_RIGHTS_BLOCKED', status: 422, category: 'policy', retryable: false,
    message: 'Asset rights blocked',
  })
  assert.deepEqual(PUBLIC_ERROR_CATALOG.WEBHOOK_CHALLENGE_TRANSPORT_FAILED, {
    code: 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
    status: 502,
    category: 'provider',
    retryable: true,
    message: 'An external provider request could not be completed',
  })
  assert.deepEqual(PUBLIC_ERROR_CATALOG.PERSISTENCE_NOT_CONFIGURED, {
    code: 'PERSISTENCE_NOT_CONFIGURED', status: 503, category: 'internal', retryable: true,
    message: 'The request could not be completed',
  })
  assert.deepEqual(PUBLIC_ERROR_CATALOG.INTERNAL_ERROR, {
    code: 'INTERNAL_ERROR', status: 500, category: 'internal', retryable: true,
    message: 'The request could not be completed',
  })

  assert.throws(
    () => definePublicErrorCatalog([{
      codes: PUBLIC_ERROR_CODES,
      status: 422,
      category: 'validation',
    }, {
      codes: ['AUTH_INVALID'],
      status: 401,
      category: 'auth',
    }]),
    (error) => error instanceof DomainError && error.code === 'INVALID_PUBLIC_SCHEMA',
  )
  assert.throws(
    () => definePublicErrorCatalog([{
      codes: PUBLIC_ERROR_CODES.slice(1),
      status: 422,
      category: 'validation',
    }]),
    (error) =>
      error instanceof DomainError && error.code === 'INVALID_PUBLIC_SCHEMA' &&
      error.details.missing.includes('INVALID_ARGUMENT'),
  )
})

test('public event schema and catalog expose the same versioned event types', () => {
  const eventSchema = getPublicSchema('apollo://schemas/public-event/v2').schema
  const catalogSchema = getPublicSchema('apollo://schemas/event-catalog/v2').schema
  const eventTypes = PUBLIC_EVENT_CATALOG.map((event) => event.type)

  assert.deepEqual(eventSchema.properties.type.enum, eventTypes)
  assert.deepEqual(catalogSchema.properties.data.properties.events.items.properties.type.enum, eventTypes)
  assert.equal(
    catalogSchema.properties.data.properties.envelopeSchemaRef.const,
    'apollo://schemas/public-event/v2',
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

  const schemaHeaders = document.paths['/v1/schemas/{schemaId}/{version}']
    .get.responses['200'].headers
  assert.deepEqual(schemaHeaders.Deprecation.schema, {
    type: 'string', pattern: '^@[0-9]+$',
  })
  assert.match(schemaHeaders.Sunset.description, /HTTP-date/)
  assert.match(schemaHeaders.Link.description, /Migration guide/)

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

  const login = document.paths['/v1/session'].post
  const readSession = document.paths['/v1/session'].get
  const logout = document.paths['/v1/session'].delete
  assert.deepEqual(login.security, [])
  assert.deepEqual(readSession.security, [{ uiSession: [] }])
  assert.deepEqual(logout.security, [{}, { uiSession: [] }])
  assert.equal(login.requestBody.content['application/json'].schema.$ref, '#/components/schemas/UiSessionCreateRequestV1')
  assert.equal(document.components.securitySchemes.uiSession.in, 'cookie')

  const readRights = document.paths['/v1/artifacts/{artifactId}/rights'].get
  assert.ok(readRights.responses['200'].headers.ETag)
  const setRights = document.paths['/v1/artifacts/{artifactId}/rights'].put
  assert.ok(
    setRights.parameters.some(
      (parameter) =>
        parameter.in === 'header' && parameter.name === 'If-Match' && parameter.required,
    ),
  )
  assert.ok(setRights.responses['200'].headers.ETag)
  assert.ok(setRights.responses['412'])
  assert.ok(setRights.responses['428'])
})

test('version conflicts expose only the bounded semantic diff', async () => {
  const body = presentPublicDomainError(
    new DomainError('VERSION_CONFLICT', 'Command targets changed since its base version', {
      conflict: {
        currentVersionId: 'version-current-2',
        conflictingTargets: ['clip:clip-1'],
        diff: {
          commands: ['command-intervening-1'],
          storyChanges: [],
          timelineChanges: [{
            commandId: 'command-intervening-1',
            target: 'clip:clip-1',
            summary: 'Clip timing changed.',
            internalPayload: 'must-not-leak',
          }],
          visualChanges: [],
          audioChanges: [],
          outputChanges: [],
          invalidatedArtifacts: ['artifact-proxy-1'],
          estimatedCostDelta: 0,
          internalGraph: 'must-not-leak',
        },
        internalSnapshot: 'must-not-leak',
      },
    }),
    'request-version-conflict-1',
  )
  assert.deepEqual(body.error.conflict, {
    currentVersionId: 'version-current-2',
    conflictingTargets: ['clip:clip-1'],
    diff: {
      commands: ['command-intervening-1'],
      storyChanges: [],
      timelineChanges: [{
        commandId: 'command-intervening-1',
        target: 'clip:clip-1',
        summary: 'Clip timing changed.',
      }],
      visualChanges: [],
      audioChanges: [],
      outputChanges: [],
      invalidatedArtifacts: ['artifact-proxy-1'],
      estimatedCostDelta: 0,
    },
  })
  assert.equal(JSON.stringify(body).includes('must-not-leak'), false)

  const document = createOpenApiDocument()
  const errorSchema =
    document.paths['/v1/projects'].post.responses['409'].content['application/json'].schema
  assert.deepEqual(errorSchema, { $ref: '#/components/schemas/ErrorEnvelopeV3' })
})

test('public errors never expose a domain diagnostic through the client message', () => {
  const secret = 'provider-secret-and-private-diagnostic'
  const body = presentPublicDomainError(
    new DomainError('WEBHOOK_CHALLENGE_TRANSPORT_FAILED', secret),
    'request-redaction-1',
  )
  assert.equal(body.error.message, 'An external provider request could not be completed')
  assert.equal(JSON.stringify(body).includes(secret), false)
})

test('agent tools compose transport inputs and structured outputs from capabilities', () => {
  const grantedScopes = new Set(
    FOUNDATION_CAPABILITIES.flatMap((capability) => capability.requiredScopes),
  )
  const tools = agentToolsForCapabilities(
    capabilitiesForScopes(FOUNDATION_CAPABILITIES, grantedScopes),
  )
  assert.equal(
    tools.length,
    FOUNDATION_CAPABILITIES.filter((capability) => capability.toolName).length,
  )
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length)
  assert.ok(tools.every((tool) => Object.isFrozen(tool)))

  const rights = tools.find((tool) => tool.name === 'apollo.artifacts.rights.set')
  assert.deepEqual(rights.inputSchema.required, ['path', 'headers', 'body'])
  assert.deepEqual(rights.inputSchema.properties.path.required, ['artifactId'])
  assert.deepEqual(rights.inputSchema.properties.headers.required, ['ifMatch'])
  assert.equal(rights.inputSchema.properties.body.required.includes('status'), true)
  assert.equal(rights.errorSchema.properties.error.properties.conflict.type, 'object')
  assert.equal(rights.annotations.readOnlyHint, false)
  assert.equal(rights.annotations.idempotentHint, true)

  const createProject = tools.find((tool) => tool.name === 'apollo.projects.create')
  assert.deepEqual(createProject.inputSchema.properties.headers.required, ['idempotencyKey'])
  assert.equal(createProject.inputSchema.required.includes('body'), true)

  const rotateCredential = tools.find(
    (tool) => tool.name === 'apollo.clients.credentials.rotate',
  )
  assert.equal(rotateCredential.inputSchema.required.includes('body'), false)

  const listProjects = tools.find((tool) => tool.name === 'apollo.projects.list')
  assert.ok(listProjects.inputSchema.properties.query.properties.limit)
  assert.equal(listProjects.annotations.readOnlyHint, true)
  assert.equal(listProjects.annotations.idempotentHint, true)
})

test('agent tool discovery is deny-by-default for unavailable scopes', () => {
  const tools = agentToolsForCapabilities(
    capabilitiesForScopes(FOUNDATION_CAPABILITIES, new Set()),
  )
  assert.deepEqual(tools.map((tool) => tool.name), [
    'apollo.health.read',
    'apollo.capabilities.list',
    'apollo.tools.list',
    'apollo.events.catalog.read',
    'apollo.contracts.openapi.read',
    'apollo.contracts.schemas.read',
  ])
})

test('agent data boundary identifies transcript, OCR and media metadata as data-only paths', () => {
  const boundary = agentDataBoundaryForSchemas(
    {
      type: 'object',
      properties: {
        body: {
          type: 'object',
          properties: {
            transcript: { type: 'string' },
            transcriptText: { type: 'string' },
            title: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'object',
      properties: {
        data: {
          type: 'object',
          properties: {
            ocr: { type: 'string' },
            ocrText: { type: 'string' },
            metadata: { type: 'object' },
            frames: { type: 'array', items: { type: 'object', properties: { mediaMetadata: { type: 'object' } } } },
          },
        },
      },
    },
  )
  assert.deepEqual(boundary.inputPaths, ['/body/transcript', '/body/transcriptText'])
  assert.deepEqual(boundary.outputPaths, [
    '/data/frames/*/mediaMetadata', '/data/metadata', '/data/ocr', '/data/ocrText',
  ])
  assert.equal(boundary.mediaContentClassification, 'untrusted-data')
  assert.equal(boundary.instructionPolicy, 'never-execute')
})

test('mutable agent tools have exhaustive trusted safety gates', () => {
  const mutable = FOUNDATION_CAPABILITIES.filter(
    (capability) =>
      capability.toolName &&
      (capability.operationKind === 'command' || capability.operationKind === 'job'),
  )
  assert.equal(Object.keys(FOUNDATION_AGENT_TOOL_SAFETY).length, mutable.length)
  for (const capability of mutable) {
    const rule = FOUNDATION_AGENT_TOOL_SAFETY[capability.id]
    assert.ok(rule)
    if (
      rule.impact !== 'bounded' ||
      capability.costClass === 'high' ||
      capability.costClass === 'variable'
    ) {
      assert.notEqual(rule.confirmation, 'none')
    }
  }

  assert.throws(
    () => defineAgentToolSafetyRegistry([mutable[0]], {}),
    (error) => error instanceof DomainError && error.code === 'INVALID_CAPABILITY',
  )
  assert.throws(
    () => defineAgentToolSafetyRegistry([mutable[0]], {
      [mutable[0].id]: {
        impact: 'destructive', confirmation: 'none',
        reason: 'This destructive operation has no trusted execution gate.',
      },
    }),
    (error) => error instanceof DomainError && error.code === 'INVALID_CAPABILITY',
  )
})

test('agent gate rejects model-supplied absence, mismatch and expired evidence', () => {
  const capability = FOUNDATION_CAPABILITIES.find(
    (candidate) => candidate.id === 'apollo.artifacts.rights.set',
  )
  const rule = FOUNDATION_AGENT_TOOL_SAFETY[capability.id]
  const fingerprint = 'a'.repeat(64)
  const now = new Date('2026-07-16T21:00:00.000Z')

  assert.throws(
    () => requireAgentToolExecutionGate(capability, rule, fingerprint, undefined, now),
    (error) => error instanceof DomainError && error.code === 'TOOL_CONFIRMATION_REQUIRED',
  )
  assert.throws(
    () => requireAgentToolExecutionGate(capability, rule, fingerprint, {
      kind: 'human-approval', capabilityId: capability.id,
      inputFingerprint: 'b'.repeat(64),
      issuedAt: '2026-07-16T20:59:00.000Z', expiresAt: '2026-07-16T21:05:00.000Z',
    }, now),
    (error) => error instanceof DomainError && error.code === 'TOOL_CONFIRMATION_INVALID',
  )
  assert.throws(
    () => requireAgentToolExecutionGate(capability, rule, fingerprint, {
      kind: 'human-approval', capabilityId: capability.id, inputFingerprint: fingerprint,
      issuedAt: '2026-07-16T20:50:00.000Z', expiresAt: '2026-07-16T20:59:59.000Z',
    }, now),
    (error) => error instanceof DomainError && error.code === 'TOOL_CONFIRMATION_INVALID',
  )
  assert.deepEqual(
    requireAgentToolExecutionGate(capability, rule, fingerprint, {
      kind: 'human-approval', capabilityId: capability.id, inputFingerprint: fingerprint,
      issuedAt: '2026-07-16T20:59:00.000Z', expiresAt: '2026-07-16T21:05:00.000Z',
    }, now),
    {
      confirmation: 'human-approval',
      issuedAt: '2026-07-16T20:59:00.000Z',
      expiresAt: '2026-07-16T21:05:00.000Z',
    },
  )
})

test('agent descriptors announce host approval without writable self-approval arguments', () => {
  const tools = agentToolsForCapabilities(FOUNDATION_CAPABILITIES)
  for (const tool of tools.filter((candidate) => candidate.apollo.confirmation !== 'none')) {
    assert.match(tool.description, /Requires trusted human approval|Requires a valid bound preflight/)
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'approval'), false)
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'confirmed'), false)
    assert.equal(Object.hasOwn(tool.inputSchema.properties, 'preflightToken'), false)
  }
  assert.equal(
    tools.find((tool) => tool.name === 'apollo.artifacts.rights.set').apollo.confirmation,
    'human-approval',
  )
  assert.equal(
    tools.find((tool) => tool.name === 'apollo.clients.credentials.revoke').apollo.confirmation,
    'human-approval',
  )
})

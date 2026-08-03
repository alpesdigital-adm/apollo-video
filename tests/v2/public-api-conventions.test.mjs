import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import ts from 'typescript'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  PUBLIC_API_CONVENTIONS,
  PUBLIC_API_VERSION,
  PUBLIC_DATE_TIME_SCHEMA,
  PUBLIC_FRAME_SCHEMA,
  PUBLIC_ID_SCHEMA,
  assertAllowlistedPublicQuery,
  assertPublicJsonValue,
  publicDateTime,
  publicFrame,
  publicIdentifier,
} from '../../src/v2/public-api/conventions.ts'
import { presentSuccess } from '../../src/v2/public-api/presenters.ts'
import {
  FOUNDATION_CAPABILITIES,
  assertPublicCapabilityQuery,
} from '../../src/v2/public-api/capability-registry.ts'

function rejects(callback) {
  assert.throws(callback, (error) => error instanceof DomainError && error.code === 'INVALID_ARGUMENT')
}

const root = resolve(import.meta.dirname, '../..')

function routeFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return routeFiles(path)
    return entry.isFile() && entry.name === 'route.ts' ? [path] : []
  })
}

test('T-FR-241 /v1 JSON, identifier, UTC and frame conventions are canonical', () => {
  assert.equal(PUBLIC_API_VERSION, 'v1')
  assert.equal(PUBLIC_API_CONVENTIONS.basePath, '/v1')
  assert.equal(PUBLIC_API_CONVENTIONS.json.mediaType, 'application/json')
  assert.equal(PUBLIC_API_CONVENTIONS.json.charset, 'utf-8')
  assert.equal(PUBLIC_API_CONVENTIONS.frame.interval, 'half-open')
  assert.equal(PUBLIC_API_CONVENTIONS.frame.secondsForEditorialTiming, false)
  assert.deepEqual(PUBLIC_ID_SCHEMA, { type: 'string', minLength: 3, maxLength: 128 })
  assert.deepEqual(PUBLIC_DATE_TIME_SCHEMA, { type: 'string', format: 'date-time' })
  assert.deepEqual(PUBLIC_FRAME_SCHEMA, { type: 'integer', minimum: 0 })
  assert.equal(presentSuccess({ ok: true }).meta.apiVersion, 'v1')

  assert.equal(publicIdentifier('project-123'), 'project-123')
  for (const value of ['', ' id', 'id', 'id/unsafe', 'x'.repeat(129)]) rejects(() => publicIdentifier(value))

  assert.equal(publicDateTime('2026-08-03T12:34:56.789Z'), '2026-08-03T12:34:56.789Z')
  for (const value of ['2026-08-03', '2026-08-03T12:34:56+00:00', 'not-a-date']) {
    rejects(() => publicDateTime(value))
  }

  assert.equal(publicFrame(0), 0)
  assert.equal(publicFrame(30), 30)
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '30']) rejects(() => publicFrame(value))
})

test('T-FR-241 public JSON and query filters fail closed', () => {
  assert.doesNotThrow(() => assertPublicJsonValue({ id: 'project-1', frames: [0, 30], value: null }))
  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, new Date()]) {
    rejects(() => assertPublicJsonValue(value))
  }
  rejects(() => assertPublicJsonValue({ hidden: undefined }))

  const query = assertAllowlistedPublicQuery(
    new URLSearchParams('limit=20&after=opaque-cursor'),
    new Set(['limit', 'after']),
  )
  assert.deepEqual({ ...query }, { limit: '20', after: 'opaque-cursor' })
  rejects(() => assertAllowlistedPublicQuery(new URLSearchParams('sql=drop'), new Set(['limit'])))
  rejects(() => assertAllowlistedPublicQuery(new URLSearchParams('limit=1&limit=2'), new Set(['limit'])))
})

test('T-FR-241 capability query allowlists resolve concrete /v1 paths through the canonical registry', () => {
  const projects = assertPublicCapabilityQuery(
    'GET',
    '/v1/projects',
    new URLSearchParams('limit=20&status=active'),
    FOUNDATION_CAPABILITIES,
  )
  assert.equal(projects.id, 'apollo.projects.list')
  const workspace = assertPublicCapabilityQuery(
    'GET',
    '/v1/projects/project-123/workspace',
    new URLSearchParams(),
    FOUNDATION_CAPABILITIES,
  )
  assert.equal(workspace.id, 'apollo.projects.workspace.current.read')
  const deadLetter = assertPublicCapabilityQuery(
    'GET',
    '/v1/operations/dead-letter',
    new URLSearchParams(),
    FOUNDATION_CAPABILITIES,
  )
  assert.equal(deadLetter.id, 'apollo.operations.dead-letter.list')

  rejects(() => assertPublicCapabilityQuery(
    'GET', '/v1/projects', new URLSearchParams('unknown=true'), FOUNDATION_CAPABILITIES,
  ))
  rejects(() => assertPublicCapabilityQuery(
    'GET', '/v1/projects', new URLSearchParams('limit=1&limit=2'), FOUNDATION_CAPABILITIES,
  ))
  assert.throws(
    () => assertPublicCapabilityQuery(
      'GET', '/v1/not-registered', new URLSearchParams(), FOUNDATION_CAPABILITIES,
    ),
    (error) => error instanceof DomainError && error.code === 'CAPABILITY_PARITY_MISSING',
  )
})

test('T-FR-241 every implemented /v1 HTTP handler has one canonical capability endpoint', () => {
  const registryEndpoints = new Map(FOUNDATION_CAPABILITIES.flatMap((capability) =>
    capability.endpoint ? [[`${capability.endpoint.method} ${capability.endpoint.path}`, capability]] : []))
  const handlers = []
  const undeclaredQueryParameters = []
  const unguardedQueryHandlers = []
  for (const path of routeFiles(resolve(root, 'src/app/v1'))) {
    const relativePath = relative(resolve(root, 'src/app'), path).replaceAll('\\', '/')
    const endpoint = `/${relativePath}`
      .replace(/\/route\.ts$/, '')
      .replaceAll(/\[([^\]]+)\]/g, '{$1}')
    const file = ts.createSourceFile(
      path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS,
    )
    for (const statement of file.statements) {
      if (!ts.isFunctionDeclaration(statement) || !statement.name ||
          !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(statement.name.text) ||
          !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue
      const handler = `${statement.name.text} ${endpoint}`
      handlers.push(handler)
      const capability = registryEndpoints.get(handler)
      if (!capability) continue
      const declared = new Set((capability.queryParameters ?? []).map((parameter) => parameter.name))
      let usesQuery = false
      let guardsQuery = false
      const visit = (node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
            ['authenticateExternalRequest', 'assertAllowlistedPublicQuery', 'discoverExternalCapabilities']
              .includes(node.expression.text)) {
          guardsQuery = true
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
            ['get', 'getAll', 'has'].includes(node.expression.name.text) &&
            ts.isStringLiteralLike(node.arguments[0]) &&
            /(?:searchParams|params)$/.test(node.expression.expression.getText())) {
          usesQuery = true
          const name = node.arguments[0].text
          if (!declared.has(name)) undeclaredQueryParameters.push(`${handler}: ${name}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(statement)
      if (usesQuery && !guardsQuery) unguardedQueryHandlers.push(handler)
    }
  }
  assert.ok(handlers.length >= 180)
  assert.deepEqual(
    handlers.filter((handler) => !registryEndpoints.has(handler)),
    [],
    'every implemented public handler must be declared by the capability registry',
  )
  assert.deepEqual(
    undeclaredQueryParameters,
    [],
    'every statically accessed public query parameter must be declared by its capability',
  )
  assert.deepEqual(
    unguardedQueryHandlers,
    [],
    'every query-bearing public handler must use authenticated or explicit query allowlisting',
  )
})

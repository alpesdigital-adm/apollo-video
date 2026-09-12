import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

import {
  FOUNDATION_CAPABILITIES,
  INTERNAL_ONLY_SURFACES,
  bindUiNetworkActionsToCapabilities,
} from '../src/v2/public-api/capability-registry.ts'

const REPORT_TESTS = Object.freeze([
  'tests/v2/capability-registry.test.mjs:T-F0-034-ui-capability-binding',
  'tests/v2/capability-registry.test.mjs:T-F0-034-shared-service-boundary',
  'tests/v2/public-contracts.test.mjs:public-contract-registry',
])
const uiActionCache = new Map()
const applicationServiceCache = new Map()
const reachableServiceCache = new Map()

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!entry.isFile()) return []
    if (entry.name.endsWith('.tsx')) return [path]
    if (!entry.name.endsWith('.ts')) return []
    return /^\s*(['\"])use client\1/m.test(readFileSync(path, 'utf8')) ? [path] : []
  })
}

function staticUiPath(node) {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text
    for (const span of node.templateSpans) {
      if (!(ts.isIdentifier(span.expression) && span.expression.text === 'suffix')) value += '{param}'
      value += span.literal.text
    }
    return value
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticUiPath(node.left)
    const right = staticUiPath(node.right)
    return left === undefined || right === undefined ? undefined : left + right
  }
  return undefined
}

function requestMethod(call) {
  const options = call.arguments[1]
  if (!options || !ts.isObjectLiteralExpression(options)) return 'GET'
  const property = options.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && candidate.name.getText().replaceAll(/["']/g, '') === 'method')
  return property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text
    : 'GET'
}

function enclosingFunctionName(node) {
  let current = node.parent
  while (current) {
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text
    current = current.parent
  }
  return undefined
}

/**
 * The editor read coordinator (src/app/_operator/editor-reads.ts) receives its
 * transport as `createEditorReads({ fetch: (url, init) => fetch(url, init), ... })`.
 * That inner `fetch(url, init)` is not a UI network action of its own: every
 * path it carries is declared at a `reads.read({ url: ... })` call site, which
 * the visitor below records. Anything else dynamic stays unclassified.
 */
function isReadCoordinatorTransport(node) {
  let current = node.parent
  while (current && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) current = current.parent
  if (!current) return false
  const property = current.parent
  if (!property || !ts.isPropertyAssignment(property) || property.name.getText() !== 'fetch') return false
  const options = property.parent
  const call = options?.parent
  return Boolean(call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) &&
    call.expression.text === 'createEditorReads')
}

function objectProperty(literal, name) {
  return literal.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && candidate.name.getText().replaceAll(/["']/g, '') === name)
}

export function discoverUiNetworkActions(root) {
  const cached = uiActionCache.get(root)
  if (cached) return cached
  const actions = []
  for (const path of [
    ...sourceFiles(resolve(root, 'src/app')),
    ...sourceFiles(resolve(root, 'src/components')),
  ]) {
    const source = readFileSync(path, 'utf8')
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const visit = (node) => {
      // Reads issued through the editor read coordinator declare their path in
      // the descriptor's `url`; they are GET by construction (the coordinator
      // throws on any other method).
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'reads' &&
          node.expression.name.text === 'read') {
        assert.ok(node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]),
          `canonical reads.read descriptor must be an object literal with a static url: ${relative(root, path)}`)
        const urlProperty = objectProperty(node.arguments[0], 'url')
        const pathPattern = urlProperty ? staticUiPath(urlProperty.initializer) : undefined
        assert.ok(pathPattern, `read coordinator descriptor without a static url: ${relative(root, path)}`)
        if (pathPattern.startsWith('/v1/')) {
          const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
          actions.push({
            id: `${relative(root, path).replaceAll('\\', '/')}:${line}`,
            method: 'GET',
            path: pathPattern.split('?', 1)[0],
          })
        }
        ts.forEachChild(node, visit)
        return
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
          (node.expression.text === 'fetch' || node.expression.text === 'requestJson')) {
        let pathPattern = staticUiPath(node.arguments[0])
        let method = requestMethod(node)
        if (!pathPattern && node.expression.text === 'fetch' && isReadCoordinatorTransport(node)) {
          ts.forEachChild(node, visit)
          return
        }
        if (!pathPattern && node.expression.text === 'fetch' && enclosingFunctionName(node) !== 'requestJson') {
          const signedUpload = enclosingFunctionName(node) === 'transfer' && (
            (ts.isCallExpression(node.arguments[0]) &&
              ts.isIdentifier(node.arguments[0].expression) &&
              node.arguments[0].expression.text === 'localSignedUrl') ||
            (ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'url')
          )
          assert.ok(signedUpload, `dynamic UI fetch is not explicitly classified: ${relative(root, path)}`)
          pathPattern = '/v1/media/uploads/{uploadId}/content'
          method = 'PUT'
        }
        if (pathPattern?.startsWith('/v1/')) {
          const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
          actions.push({
            id: `${relative(root, path).replaceAll('\\', '/')}:${line}`,
            method,
            path: pathPattern.split('?', 1)[0],
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  const discovered = Object.freeze(actions
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((action) => Object.freeze(action)))
  uiActionCache.set(root, discovered)
  return discovered
}

function routeFileForEndpoint(root, endpoint) {
  const routeSegments = endpoint.path
    .split('?', 1)[0]
    .replaceAll(/\{([^}]+)\}/g, '[$1]')
    .split('/')
    .filter(Boolean)
  return resolve(root, 'src/app', ...routeSegments, 'route.ts')
}

function resolveLocalModule(root, fromPath, specifier) {
  const base = specifier.startsWith('@/')
    ? resolve(root, 'src', specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(fromPath), specifier)
      : undefined
  if (!base) return undefined
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

function reachableApplicationServices(root, path, functionName, visited = new Set()) {
  const visitKey = `${path}#${functionName}`
  const cached = reachableServiceCache.get(visitKey)
  if (cached) return new Set(cached)
  if (visited.has(visitKey)) return new Set()
  visited.add(visitKey)
  const source = readFileSync(path, 'utf8')
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const imports = new Map()
  const functions = new Map()
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) functions.set(statement.name.text, statement)
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue
    const clause = statement.importClause
    if (clause?.name) imports.set(clause.name.text, {
      imported: 'default', source: statement.moduleSpecifier.text,
    })
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) imports.set(element.name.text, {
        imported: element.propertyName?.text ?? element.name.text,
        source: statement.moduleSpecifier.text,
      })
    }
  }
  const target = functions.get(functionName)
  if (!target) return new Set()
  const services = new Set()
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const called = node.expression.text
      if (functions.has(called)) {
        for (const service of reachableApplicationServices(root, path, called, visited)) services.add(service)
      }
      const imported = imports.get(called)
      if (imported) {
        if (/[/\\]application[/\\]/.test(imported.source)) {
          services.add(imported.imported)
        } else {
          const importedPath = resolveLocalModule(root, path, imported.source)
          if (importedPath) {
            for (const service of reachableApplicationServices(root, importedPath, imported.imported, visited)) {
              services.add(service)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(target)
  reachableServiceCache.set(visitKey, Object.freeze([...services]))
  return services
}

/**
 * The application services a route can reach, or an empty list.
 *
 * It used to throw on the empty case, which made `routesWithoutApplicationService`
 * unreportable — and made the `calls.length === 0` filter in
 * `T-F0-034-shared-service-boundary` dead code, because the helper it filters
 * could never return an empty array. The refusal now lives at the two places
 * that want to refuse (`public-operation-contracts.test.mjs` and the CLI below),
 * and the report can state the number instead of asserting it away.
 */
export function applicationServicesForEndpoint(root, endpoint) {
  const cacheKey = `${root}#${endpoint.method} ${endpoint.path}`
  const cached = applicationServiceCache.get(cacheKey)
  if (cached) return cached
  const path = routeFileForEndpoint(root, endpoint)
  assert.ok(existsSync(path), `capability route does not exist: ${endpoint.method} ${endpoint.path}`)
  const discovered = Object.freeze(
    [...reachableApplicationServices(root, path, endpoint.method)].sort(),
  )
  applicationServiceCache.set(cacheKey, discovered)
  return discovered
}

/**
 * Which discovered UI actions do NOT resolve to an exposed capability.
 *
 * `bindUiNetworkActionsToCapabilities` refuses the whole list when one action
 * fails to bind, which is the right behaviour for a gate and the wrong one for
 * a report: the summary published `unboundActions: 0` as a literal, so the
 * number was true only in the sense that the generator would have crashed
 * before writing it. Binding each action on its own is what turns that constant
 * into a measurement — and it is still refused, by the CLI below, before
 * anything is written.
 */
function unbindableUiActions(actions, registry) {
  return actions.filter((action) => {
    try {
      bindUiNetworkActionsToCapabilities([action], registry)
      return false
    } catch {
      return true
    }
  })
}

/**
 * `actions` is an injection point for the falsification test in
 * `capability-registry.test.mjs`, and for nothing else: the two counters below
 * can only be shown to move if a caller can hand the report a UI action the
 * repository does not contain. Production always discovers them from `src`.
 */
export function createUiCapabilityParityReport(
  root,
  registry = FOUNDATION_CAPABILITIES,
  actions = discoverUiNetworkActions(root),
) {
  const unbound = unbindableUiActions(actions, registry)
  const bindings = unbound.length > 0
    ? []
    : bindUiNetworkActionsToCapabilities(actions, registry)
  const capabilities = new Map(registry.map((capability) => [capability.id, capability]))
  const rows = bindings.map((binding) => {
    const capability = capabilities.get(binding.capabilityId)
    assert.ok(capability?.endpoint, `bound capability lacks public endpoint: ${binding.capabilityId}`)
    return {
      uiAction: binding.id,
      capabilityId: capability.id,
      capabilityVersion: capability.version,
      endpoint: `${capability.endpoint.method} ${capability.endpoint.path}`,
      applicationServices: applicationServicesForEndpoint(root, capability.endpoint),
      tests: REPORT_TESTS,
    }
  })
  const endpointCount = new Set(rows.map((row) => row.endpoint)).size
  const capabilityCount = new Set(rows.map((row) => row.capabilityId)).size
  const capabilityContracts = registry.map((capability) => ({
    capabilityId: capability.id,
    exposure: capability.exposure,
    endpoint: capability.endpoint
      ? `${capability.endpoint.method} ${capability.endpoint.path}`
      : null,
    inputSchemaRef: capability.inputSchemaRef ?? null,
    outputSchemaRef: capability.outputSchemaRef,
    internalOnlySurfaceId: capability.internalOnlySurfaceId ?? null,
    tests: capability.exposure === 'internal-only' ? [] : [REPORT_TESTS[2]],
  }))
  const unjustifiedCapabilities = capabilityContracts.filter((capability) =>
    capability.exposure === 'internal-only'
      ? !capability.internalOnlySurfaceId
      : !capability.endpoint || !capability.outputSchemaRef || capability.tests.length === 0)
  return {
    schemaVersion: 'ui-capability-parity-report/v1',
    summary: {
      uiActions: rows.length,
      capabilities: capabilityCount,
      endpoints: endpointCount,
      registeredCapabilities: registry.length,
      operableCapabilities: capabilityContracts.filter(
        (capability) => capability.exposure !== 'internal-only',
      ).length,
      publicContractCapabilities: capabilityContracts.filter(
        (capability) => capability.exposure !== 'internal-only',
      ).length,
      internalOnlyCapabilities: capabilityContracts.filter(
        (capability) => capability.exposure === 'internal-only',
      ).length,
      unjustifiedCapabilities: unjustifiedCapabilities.length,
      // Counted, not declared. Both were literal zeros.
      unboundActions: unbound.length,
      routesWithoutApplicationService: rows.filter(
        (row) => row.applicationServices.length === 0,
      ).length,
    },
    unboundActionIds: Object.freeze(unbound.map((action) => action.id)),
    routesWithoutApplicationServiceEndpoints: Object.freeze(
      rows.filter((row) => row.applicationServices.length === 0).map((row) => row.endpoint),
    ),
    rows,
    capabilityContracts,
    internalOnlySurfaces: INTERNAL_ONLY_SURFACES,
  }
}

export function serializeUiCapabilityParityReport(report) {
  return `${JSON.stringify(report, null, 2)}\n`
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (import.meta.url === invokedPath) {
  const root = resolve(import.meta.dirname, '..')
  const output = resolve(root, 'docs/quality/ui-capability-parity-report.json')
  const report = createUiCapabilityParityReport(root)
  // The gate, kept where it was strong and moved off the summary field it used
  // to impersonate: a UI action with no capability, or a public route that
  // reaches no application service, refuses the report in both modes rather
  // than being written down as a zero.
  assert.deepEqual(report.unboundActionIds, [],
    'every operable UI network action must resolve to one exposed capability')
  assert.deepEqual(report.routesWithoutApplicationServiceEndpoints, [],
    'every UI-reachable public route must reach a V2 application service')
  const serialized = serializeUiCapabilityParityReport(report)
  if (process.argv.includes('--check')) {
    assert.equal(readFileSync(output, 'utf8'), serialized,
      'UI capability parity report drifted; run npm run api:parity:report')
    console.log('UI capability parity report verified')
  } else {
    writeFileSync(output, serialized)
    console.log(`UI capability parity report written: ${relative(root, output)}`)
  }
}

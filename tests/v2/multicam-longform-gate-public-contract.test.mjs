import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  buildLegacyRuntimeCriterion,
  calculateLegacyRuntimeAuditHash,
  evaluateMulticamLongformGate,
  explainMulticamLongformGate,
  MULTICAM_LONGFORM_CRITERIA,
  MULTICAM_LONGFORM_CRITERION_CHECKS,
  MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES,
  MULTICAM_LONGFORM_FAILURE_REASONS,
} from '../../src/v2/domain/multicam-longform-gate.ts'
import { calculateMulticamLongformGateRecordHash } from '../../src/v2/application/multicam-longform-gate.ts'
import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import {
  assertPublicCapabilityQuery,
  FOUNDATION_CAPABILITIES,
} from '../../src/v2/public-api/capability-registry.ts'
import {
  MULTICAM_LONGFORM_CHECK_CODES,
  parseEvaluateMulticamLongformGateBody,
  presentMulticamLongformGate,
  presentMulticamLongformGateArtifacts,
} from '../../src/v2/public-api/multicam-longform-gate-contract.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'
import {
  MULTICAM_LONGFORM_ARTIFACT_ADDRESSES,
  multicamLongformArtifactHref,
} from '../../src/v2/ui/multicam-longform-gate-addresses.ts'
import { stripSourceComments } from './helpers/strip-source-comments.mjs'

/**
 * T-F4.016 — what the published phase gate refuses, and what it copies.
 *
 * `public-operation-contracts.test.mjs` already proves each of the seven
 * capabilities has a route, a schema and an example that validate. This suite
 * proves the four things that wiring cannot:
 *
 * 1. A request that tries to contribute a result is refused by the name of the
 *    field it used, not with a shrug.
 * 2. Every enum in the published schemas IS the domain constant, so a criterion
 *    renamed in the evaluator cannot leave a contract describing a check that
 *    no longer runs — the exact failure this gate exists to catch.
 * 3. The record a reader gets carries the three-state evidence reference and
 *    both counters, and does NOT carry the caller's idempotency key.
 * 4. The artifact listing deduplicates rather than repeating, and says what its
 *    filter and its limit removed.
 */

const GATE_IDS = Object.freeze([
  'apollo.projects.multicam-longform-gate.evaluate',
  'apollo.projects.multicam-longform-gate.latest.read',
  'apollo.projects.multicam-longform-gate.read',
  'apollo.projects.multicam-longform-gate.list',
  'apollo.projects.multicam-longform-gate.outstanding.read',
  'apollo.projects.multicam-longform-gate.artifacts.list',
  'apollo.multicam-longform-gate.criteria.list',
])

function capability(id) {
  const found = FOUNDATION_CAPABILITIES.find((entry) => entry.id === id)
  assert.ok(found, `${id} must be registered`)
  return found
}

function routeFileFor(entry) {
  const relative = entry.endpoint.path.replace(/^\/v1/, '').replaceAll(/\{([^}]+)\}/g, '[$1]')
  return path.resolve('src/app/v1', `.${relative}`, 'route.ts')
}

function handlerSource(source, method) {
  // Comments first: every assertion below asks whether the handler DOES
  // something, and a plain `includes("requireScope(actor, 'projects:read')")`
  // was satisfied by that same line commented out — deleting the call failed,
  // commenting it out passed, which is the wrong way round for a check whose
  // whole subject is what the code does.
  const code = stripSourceComments(source)
  const start = code.indexOf(`export async function ${method}(`)
  assert.ok(start >= 0, `handler ${method} not found`)
  const next = code.indexOf('\nexport async function ', start + 1)
  return next === -1 ? code.slice(start) : code.slice(start, next)
}

function refuses(fn, fragment) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT', `expected INVALID_ARGUMENT, got ${error.code}`)
    assert.ok(
      JSON.stringify(error.details ?? {}).includes(fragment) || error.message.includes(fragment),
      `refusal must name ${fragment}; it said ${error.message} ${JSON.stringify(error.details ?? {})}`,
    )
    return true
  })
}

// ---------------------------------------------------------------------------
// A gate record built the way the service builds one, used by the tests below.
// ---------------------------------------------------------------------------

const evaluatedAt = '2026-09-05T10:00:00.000Z'
const digest = (seed) => seed.repeat(64).slice(0, 64)
const auditContent = {
  schemaVersion: 'legacy-runtime-audit/v1',
  entryModules: ['src/v2/application/multicam-longform-gate.ts'],
  unreadableEntryModules: [],
  scannedModuleCount: 120,
  violations: [],
  scannedAt: evaluatedAt,
}
const audit = { ...auditContent, auditHash: calculateLegacyRuntimeAuditHash(auditContent) }

/**
 * One criterion passing on two rows, one of which is cited by both its checks,
 * and one criterion failing on a row whose hash did not recompute.
 */
const report = evaluateMulticamLongformGate({
  workspaceId: 'workspace-gate-contract',
  projectId: 'project-gate-contract',
  sessionId: 'capture-session-gate-contract',
  evaluatedAt,
  evidence: [
    {
      criterion: 'final-mp4-inspectable',
      checks: [
        {
          code: 'final-export-promoted',
          passed: true,
          failureReason: null,
          detail: 'attempt 2 promoted the delivered master',
          references: [{ type: 'final-export', id: 'final-export-attempt-2', hash: digest('1'), verified: true }],
        },
        {
          code: 'output-codec-recorded',
          passed: true,
          failureReason: null,
          detail: 'h264 / aac at 1920x1080',
          references: [{ type: 'media-manifest', id: 'manifest-master', hash: digest('2'), verified: true }],
        },
        {
          code: 'output-probe-measured',
          passed: true,
          failureReason: null,
          detail: 'ffprobe counted 3 600 frames',
          // The artifact table stores no digest of its own. A check may pass
          // beside this; it may not pass beside an unverified one.
          references: [{ type: 'media-artifact', id: 'artifact-master', hash: null, verified: false }],
        },
        {
          code: 'artifact-hash-matches-attempt',
          passed: true,
          failureReason: null,
          detail: 'manifest sha256 equals the attempt sha256',
          references: [{ type: 'final-export', id: 'final-export-attempt-2', hash: digest('1'), verified: true }],
        },
      ],
    },
    {
      criterion: 'colour-critic-resolved',
      checks: MULTICAM_LONGFORM_CRITERION_CHECKS['colour-critic-resolved'].map((code) => ({
        code,
        passed: false,
        failureReason: 'evidence-unverified',
        detail: 'the stored verdict does not recompute from its own content',
        references: [{ type: 'colour-critic-report', id: 'color-critic-report-1', hash: digest('3'), verified: false }],
      })),
    },
    buildLegacyRuntimeCriterion(audit),
  ],
})

const recordContent = {
  schemaVersion: 'multicam-longform-gate/v1',
  id: 'multicam-longform-gate-contract-1',
  workspaceId: 'workspace-gate-contract',
  projectId: 'project-gate-contract',
  sessionId: 'capture-session-gate-contract',
  projectVersionId: 'project-version-gate-1',
  projectVersionHash: digest('4'),
  report,
  reportFingerprint: report.fingerprint,
  idempotencyKey: 'run-the-gate-once',
  requestFingerprint: digest('5'),
  createdBy: { type: 'api-client', id: 'client-gate-contract' },
  createdAt: evaluatedAt,
}
const gate = { ...recordContent, recordHash: calculateMulticamLongformGateRecordHash(recordContent) }

// ---------------------------------------------------------------------------

test('T-F4.016 the seven gate capabilities obey the query and command rules', () => {
  const commands = []
  for (const id of GATE_IDS) {
    const entry = capability(id)
    assert.equal(entry.exposure, 'public')
    assert.equal(entry.authMode, 'required')
    assert.equal(entry.requiredScopes.length, 1, `${id} must declare exactly one scope`)
    if (entry.operationKind === 'query') {
      assert.deepEqual([...entry.requiredScopes], ['projects:read'])
      assert.equal(entry.idempotency, 'not-applicable')
      assert.deepEqual([...entry.successStatuses], [200])
      assert.equal(entry.endpoint.method, 'GET')
      assert.equal(entry.inputSchemaRef, undefined, `${id} is a query and must accept no body`)
      for (const parameter of entry.queryParameters ?? []) {
        assert.ok(parameter.schema.type, `${id}/${parameter.name} must declare a type`)
      }
      continue
    }
    commands.push(entry)
    assert.equal(entry.operationKind, 'command')
    assert.deepEqual([...entry.requiredScopes], ['projects:write'])
    assert.deepEqual([...entry.successStatuses], [201, 200])
    assert.equal(entry.requestBodyRequired, true)
    assert.equal(entry.endpoint.method, 'POST')
    // `required`, not `natural`: the route reads the header. The test below
    // pins that claim to the route source.
    assert.equal(entry.idempotency, 'required')
    const rule = FOUNDATION_AGENT_TOOL_SAFETY[entry.toolName]
    assert.ok(rule, `${id} must carry an agent-tool safety rule`)
    assert.ok(rule.reason.trim().length >= 10 && rule.reason.trim().length <= 500)
    if (rule.impact !== 'bounded') {
      assert.notEqual(rule.confirmation, 'none', `${id} is ${rule.impact} and must be gated`)
    }
  }
  // Exactly one command. Reading a gate, its history, its criteria, what it is
  // missing and what it read are all queries, because none of them changes the
  // record — and a gate that could be "approved" by a second command would be
  // approvable by a caller.
  assert.equal(commands.length, 1)
})

test('T-F4.016 no gate capability accepts an evidence, score or approval field', () => {
  // The whole published input surface of this slice: one optional session
  // filter. If a future revision adds a field here, this assertion is where the
  // conversation about whether a caller may contribute to a verdict happens.
  const input = getPublicSchema('apollo://schemas/evaluate-multicam-longform-gate-request/v1').schema
  assert.deepEqual(Object.keys(input.properties), ['sessionId'])
  assert.equal(input.additionalProperties, false)
  assert.equal(input.required, undefined)

  assert.deepEqual(parseEvaluateMulticamLongformGateBody({}), {})
  assert.deepEqual(
    parseEvaluateMulticamLongformGateBody({ sessionId: ' capture-session-1 ' }),
    { sessionId: 'capture-session-1' },
  )
  // Each of these is something the evaluator derives. The refusal has to name
  // the key: an operator who sent `approved` needs to be told to remove
  // `approved`, not that their request was invalid.
  for (const field of [
    'approved', 'satisfied', 'criteria', 'evidence', 'evidenceRef', 'report',
    'recordHash', 'projectVersionId', 'baseVersionId', 'score',
  ]) {
    refuses(() => parseEvaluateMulticamLongformGateBody({ [field]: 'x' }), field)
  }
  refuses(() => parseEvaluateMulticamLongformGateBody({ sessionId: 42 }), 'sessionId')
  refuses(() => parseEvaluateMulticamLongformGateBody({ sessionId: 'ab' }), 'sessionId')
  refuses(() => parseEvaluateMulticamLongformGateBody([]), 'body')
})

test('T-F4.016 every enum the gate publishes is the domain constant, not a copy of it', () => {
  const record = getPublicSchema('apollo://schemas/multicam-longform-gate-read/v1').schema
    .properties.data.properties.gate
  const reportSchema = record.properties.report
  const criterion = reportSchema.properties.criteria.items
  const check = criterion.properties.checks.items
  const reference = check.properties.references.items

  assert.deepEqual(criterion.properties.criterion.enum, [...MULTICAM_LONGFORM_CRITERIA])
  assert.deepEqual(check.properties.code.enum, [...MULTICAM_LONGFORM_CHECK_CODES])
  assert.deepEqual(
    check.properties.failureReason.oneOf[0].enum,
    [...MULTICAM_LONGFORM_FAILURE_REASONS],
  )
  assert.deepEqual(
    reference.properties.type.enum,
    [...MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES],
  )
  // Every check code the domain defines is publishable, and nothing else is.
  const declared = new Set(MULTICAM_LONGFORM_CHECK_CODES)
  for (const codes of Object.values(MULTICAM_LONGFORM_CRITERION_CHECKS)) {
    for (const code of codes) assert.ok(declared.has(code), `${code} is not publishable`)
  }
  assert.equal(declared.size, MULTICAM_LONGFORM_CHECK_CODES.length)

  // Ten, and the total is a const rather than a range, so a criterion added to
  // the domain without a baseline review fails here instead of shipping as a
  // gate that silently judges eleven things while claiming ten.
  assert.equal(reportSchema.properties.total.const, MULTICAM_LONGFORM_CRITERIA.length)
  assert.equal(reportSchema.properties.criteria.minItems, MULTICAM_LONGFORM_CRITERIA.length)
  assert.equal(reportSchema.properties.criteria.maxItems, MULTICAM_LONGFORM_CRITERIA.length)

  const catalogue = getPublicSchema('apollo://schemas/multicam-longform-gate-criteria/v1').schema
    .properties.data
  assert.equal(catalogue.properties.total.const, MULTICAM_LONGFORM_CRITERIA.length)
  assert.deepEqual(
    catalogue.properties.criteria.items.properties.criterion.enum,
    [...MULTICAM_LONGFORM_CRITERIA],
  )

  const typeFilter = capability('apollo.projects.multicam-longform-gate.artifacts.list')
    .queryParameters.find((parameter) => parameter.name === 'type')
  assert.deepEqual(typeFilter.schema.enum, [...MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES])
})

test('T-F4.016 the presented record keeps all ten criteria and drops the caller key', () => {
  const presented = presentMulticamLongformGate(gate)
  // Ten criteria, in catalogue order, including the seven nobody answered.
  assert.deepEqual(
    presented.report.criteria.map((entry) => entry.criterion),
    [...MULTICAM_LONGFORM_CRITERIA],
  )
  assert.equal(presented.report.approved, false)
  assert.equal(presented.report.total, 10)
  // Two of the three answered criteria passed; seven were never answered at
  // all, and `evaluated` counts them apart from `satisfied`.
  assert.equal(presented.report.satisfied, 2)
  assert.equal(presented.report.evaluated, 3)

  const critic = presented.report.criteria.find((entry) => entry.criterion === 'colour-critic-resolved')
  assert.equal(critic.unverifiedReferenceCount, 3)
  assert.equal(critic.unhashedReferenceCount, 0)
  const media = presented.report.criteria.find((entry) => entry.criterion === 'final-mp4-inspectable')
  // The distinction the whole record turns on: a digest that could not be
  // recomputed is not a digest that disagreed.
  assert.equal(media.unverifiedReferenceCount, 0)
  assert.equal(media.unhashedReferenceCount, 1)
  assert.equal(media.passed, true)
  const unhashed = media.checks
    .flatMap((check) => check.references)
    .find((reference) => reference.hash === null)
  assert.equal(unhashed.verified, false)

  const missing = presented.report.criteria.find((entry) => entry.criterion === 'contextual-multi-range-synthesis')
  assert.equal(missing.missingCheckCount, missing.checkCount)
  assert.ok(missing.checks.every((check) => check.failureReason === 'evidence-missing'))

  // The caller's key and the fingerprint derived from it and the actor context
  // are request correlation, not gate content. Neither is published.
  assert.equal('idempotencyKey' in presented, false)
  assert.equal('requestFingerprint' in presented, false)
  assert.equal(presented.recordHash, gate.recordHash)
})

test('T-F4.016 the outstanding view puts what nobody ran before what ran and refused', () => {
  const explained = explainMulticamLongformGate(report)
  assert.equal(explained.approved, false)
  const order = explained.outstanding.map((entry) => entry.neverEvaluated)
  assert.deepEqual(
    [...order].sort((left, right) => Number(right) - Number(left)),
    order,
    'criteria nobody evaluated must come first',
  )
  const critic = explained.outstanding.find((entry) => entry.criterion === 'colour-critic-resolved')
  assert.equal(critic.neverEvaluated, false)
  assert.equal(critic.unverifiedReferenceCount, 3)
  assert.ok(critic.statement.length > 20, 'an outstanding criterion must carry its sentence')
  assert.ok(critic.blocking.every((blocker) => blocker.reason === 'evidence-unverified'))
})

test('T-F4.016 the artifact listing deduplicates and says what it removed', () => {
  const all = presentMulticamLongformGateArtifacts(gate, { limit: 100 })
  // `final-export-attempt-2` was read by two checks and appears once, carrying
  // both citations. Three rows repeated per check would make a reader believe
  // the gate read more evidence than it did.
  const exports = all.artifacts.filter((entry) => entry.type === 'final-export')
  assert.equal(exports.length, 1)
  assert.deepEqual(
    exports[0].citedBy.map((citation) => citation.check).sort(),
    ['artifact-hash-matches-attempt', 'final-export-promoted'],
  )
  assert.equal(all.unverifiedCount, 1, 'the tampered colour verdict is counted once')
  assert.equal(all.unhashedCount, 1, 'the media artifact carries no digest of its own')
  assert.equal(all.filteredOut, 0)
  assert.equal(all.omittedArtifacts, 0)
  assert.equal(all.approved, false)

  const filtered = presentMulticamLongformGateArtifacts(gate, { type: 'media-artifact', limit: 100 })
  assert.equal(filtered.artifacts.length, 1)
  assert.equal(filtered.filteredOut, all.artifacts.length - 1)
  const truncated = presentMulticamLongformGateArtifacts(gate, { limit: 1 })
  assert.equal(truncated.artifacts.length, 1)
  assert.equal(truncated.omittedArtifacts, all.artifacts.length - 1)

  // The two counters are about the evaluation, never about the page. They were
  // computed over the kept slice, so `limit=1` — or the route's default of 100
  // on an evaluation citing more than that — answered "nothing was tampered
  // with" for a record that had recorded tampering. A caller who did not choose
  // the limit must not be told a different truth by it.
  assert.equal(
    truncated.unverifiedCount,
    all.unverifiedCount,
    'a truncated page reported fewer tampered references than the evaluation has',
  )
  assert.equal(
    truncated.unhashedCount,
    all.unhashedCount,
    'a truncated page hid a reference that carries no hash of its own',
  )
  // The type filter is the caller's own narrowing, so the counters follow it.
  assert.equal(filtered.unhashedCount, 1)
  assert.equal(filtered.unverifiedCount, 0)
})

test('T-F4.016 every address the screen offers is one a capability declares', () => {
  // The page turns four evidence kinds into links. `bindUiNetworkActionsToCapabilities`
  // only walks `fetch` call sites, so an `<a href>` is invisible to the parity
  // report: retargeting `capture-session` at a path nothing serves left the
  // whole suite, the parity report and the browser E2E green, because the
  // browser asserts exactly one of the four. This pins the map, not one entry.
  const exposed = new Map(
    FOUNDATION_CAPABILITIES
      .filter((entry) => entry.exposure !== 'internal-only' && entry.endpoint)
      .map((entry) => [
        `${entry.endpoint.method} ${entry.endpoint.path.replaceAll(/\{[^}]+\}/g, '{}')}`,
        entry.id,
      ]),
  )
  const addresses = Object.entries(MULTICAM_LONGFORM_ARTIFACT_ADDRESSES)
  assert.ok(addresses.length >= 4, 'the address map lost an entry')
  for (const [type, template] of addresses) {
    assert.ok(
      MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES.includes(type),
      `${type} is not an evidence resource type the gate can cite`,
    )
    const shape = `GET ${template.replaceAll(/\{[^}]+\}/g, '{}')}`
    assert.ok(
      exposed.has(shape),
      `${type} links to ${template}, which no exposed capability serves`,
    )
    // And the route that answers it exists, the way routeFileFor proves it for
    // the seven fetched endpoints.
    const file = path.resolve(
      'src/app',
      `.${template.replaceAll(/\{([^}]+)\}/g, '[$1]')}`,
      'route.ts',
    )
    assert.ok(existsSync(file), `${type} links to ${template}, which has no route file at ${file}`)
  }

  // Built hrefs are the templates filled in, with both ids encoded: an evidence
  // id is a composite the server built and may carry `:` and `/`.
  assert.equal(
    multicamLongformArtifactHref('project a', { type: 'media-artifact', id: 'artifact/1' }),
    '/v1/artifacts/artifact%2F1',
  )
  assert.equal(
    multicamLongformArtifactHref('project a', {
      type: 'capture-session',
      id: 'session:1',
    }),
    '/v1/projects/project%20a/capture-sessions/session%3A1',
  )
  assert.equal(
    multicamLongformArtifactHref('p', { type: 'clock-map', id: 'c1' }),
    null,
    'a kind with no published address was turned into a link anyway',
  )
})

test('T-F4.016 the published request schema accepts exactly what the route accepts', () => {
  const sessionId = getPublicSchema('apollo://schemas/evaluate-multicam-longform-gate-request/v1')
    .schema.properties.sessionId
  // Not the 200-character evidence-id schema, which exists for the composite
  // ids the server builds on the way OUT. Published at 200 with no pattern, an
  // agent tool generated from this schema could emit a schema-valid request
  // that the parser and the application service both answer with 400.
  assert.equal(sessionId.maxLength, 128)
  assert.ok(sessionId.pattern, 'the one caller-supplied field is published without a charset')
  const pattern = new RegExp(sessionId.pattern)
  for (const value of [
    'capture-session-1',
    'a-b',
    'a/b:c.d_x',
    'ab',
    '-leading',
    'capture session one',
    'sessão-com-acento',
    `capture-session-${'a'.repeat(150)}`,
    `capture-session-${'a'.repeat(120)}`,
  ]) {
    const bySchema = pattern.test(value) &&
      value.length >= sessionId.minLength &&
      value.length <= sessionId.maxLength
    let byParser = true
    try {
      parseEvaluateMulticamLongformGateBody({ sessionId: value })
    } catch {
      byParser = false
    }
    assert.equal(
      bySchema,
      byParser,
      `schema and parser disagree about ${JSON.stringify(value.slice(0, 40))} (${value.length} chars)`,
    )
  }
})

test('T-F4.016 each gate endpoint resolves to exactly one capability before the handler runs', () => {
  const resolved = [
    ['POST', '/v1/projects/p1/multicam-longform-gate/evaluations', {}],
    ['GET', '/v1/projects/p1/multicam-longform-gate/evaluations', { limit: '5' }],
    ['GET', '/v1/projects/p1/multicam-longform-gate/evaluations/g1', {}],
    ['GET', '/v1/projects/p1/multicam-longform-gate/evaluations/g1/artifacts', { type: 'media-artifact' }],
    ['GET', '/v1/projects/p1/multicam-longform-gate', {}],
    ['GET', '/v1/projects/p1/multicam-longform-gate/outstanding', {}],
    ['GET', '/v1/multicam-longform-gate/criteria', {}],
  ].map(([method, endpoint, query]) => assertPublicCapabilityQuery(
    method,
    endpoint,
    new URLSearchParams(query),
    FOUNDATION_CAPABILITIES,
  ).id)
  assert.deepEqual([...resolved].sort(), [...GATE_IDS].sort())

  // An undeclared filter is refused before the handler body, not defaulted
  // inside it.
  refuses(
    () => assertPublicCapabilityQuery(
      'GET',
      '/v1/projects/p1/multicam-longform-gate/evaluations',
      new URLSearchParams({ approved: 'true' }),
      FOUNDATION_CAPABILITIES,
    ),
    'approved',
  )
})

const GATE_ROUTES = GATE_IDS.map((id) => {
  const entry = capability(id)
  const file = routeFileFor(entry)
  assert.ok(existsSync(file), `${id} must have a route file at ${file}`)
  return { entry, file, source: readFileSync(file, 'utf8') }
})

test('T-F4.016 every gate route emits one named presenter and requires its declared scope', () => {
  const examples = readFileSync('src/v2/public-api/schema-examples.ts', 'utf8')
  for (const { entry, file, source } of GATE_ROUTES) {
    const handler = handlerSource(source, entry.endpoint.method)
    assert.equal(
      (handler.match(/presentSuccess\(/g) ?? []).length,
      1,
      `${entry.id} must build exactly one success body`,
    )
    const named = /presentSuccess\(\s*(present[A-Za-z0-9]*)\(/.exec(handler)
    assert.ok(named, `${entry.id} must pass presentSuccess a named presenter, not a literal in ${file}`)
    assert.ok(
      source.includes(`import { ${named[1]} }`) || source.includes(`\n  ${named[1]},\n`),
      `${entry.id} must import ${named[1]} from the contract module`,
    )
    // The published example for the same schema is built by the same function,
    // so the shape Ajv validates is the shape the route emits.
    const start = examples.indexOf(`'${entry.outputSchemaRef}': [`)
    assert.ok(start >= 0, `${entry.outputSchemaRef} must publish an example`)
    assert.ok(
      examples.slice(start, start + 400).includes(`data: ${named[1]}(`),
      `the ${entry.outputSchemaRef} example must be built by ${named[1]}, as the route is`,
    )
    assert.ok(
      handler.includes(`requireScope(actor, '${entry.requiredScopes[0]}')`),
      `${entry.id} must call requireScope(actor, '${entry.requiredScopes[0]}')`,
    )
    assert.match(source, /export const dynamic = 'force-dynamic'/)
  }
})

test('T-F4.016 the evaluation advertises an Idempotency-Key its route actually reads', () => {
  // `idempotency: 'required'` puts a mandatory header into the published
  // OpenAPI and a required `idempotencyKey` into the agent tool. Four Wave 20
  // commands declared it while no route read one; this is the assertion that
  // keeps the gate honest about it.
  const { source } = GATE_ROUTES.find(
    (route) => route.entry.id === 'apollo.projects.multicam-longform-gate.evaluate',
  )
  assert.match(source, /request\.headers\.get\('idempotency-key'\)/)
  assert.match(source, /idempotencyKey,/)
  // Per handler, not per file: the history listing shares its file with the
  // evaluation, and a whole-file grep would report the POST's key as the GET's.
  for (const { entry, source: routeSource } of GATE_ROUTES) {
    if (entry.operationKind === 'query') {
      assert.equal(
        /idempotency-key/i.test(handlerSource(routeSource, entry.endpoint.method)),
        false,
        `${entry.id} is a query and must not read an idempotency key`,
      )
    }
  }
})

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  COLOR_CRITIC_DIMENSIONS,
  COLOR_CRITIC_SEVERITIES,
} from '../../src/v2/domain/color-critic-report.ts'
import {
  ANGLE_REJECTIONS,
  ANGLE_SCORE_COMPONENT_NAMES,
  DIRECTION_RULES,
  DIRECTION_WARNINGS,
  OUTPUT_ASPECT_RATIOS,
} from '../../src/v2/domain/multicam-direction.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PLAYBACK_MODES } from '../../src/v2/domain/playback-map.ts'
import {
  COLOR_CRITIC_BUDGET_WINDOW,
  listColorCriticIssuesService,
  listColorCriticReportsService,
  readColorCriticReportService,
} from '../../src/v2/application/color-critic.ts'
import { DIRECTION_POLICY_OVERRIDE_KEYS } from '../../src/v2/application/multicam-direction.ts'
import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import {
  assertPublicCapabilityQuery,
  FOUNDATION_CAPABILITIES,
} from '../../src/v2/public-api/capability-registry.ts'
import {
  parseDirectMulticamSessionBody,
  parseProtectMulticamSelectionBody,
} from '../../src/v2/public-api/multicam-direction-contract.ts'
import {
  parseDeriveMatchPlanBody,
  parseMatchRangeOverrideBody,
} from '../../src/v2/public-api/multicam-color-contract.ts'
import {
  parseBuildPlaybackMapBody,
  parsePlaybackAnchorBody,
} from '../../src/v2/public-api/react-playback-map-contract.ts'
import {
  parseCompilePlaybackPlanBody,
  parseCompileSynthesisPlanBody,
} from '../../src/v2/public-api/renderable-plan-contract.ts'
import { RENDERABLE_PLAN_ORIGINS } from '../../src/v2/application/renderable-edit-plan.ts'
import { derivationVersion } from '../../src/v2/public-api/capture-derivation-contract.ts'
import { presentPublicDomainError } from '../../src/v2/public-api/error-presenter.ts'
import { PUBLIC_SCHEMA_EXAMPLES } from '../../src/v2/public-api/schema-examples.ts'
import { getPublicSchema } from '../../src/v2/public-api/schema-registry.ts'

/**
 * F4.012 to F4.015 — what the published surface refuses, and what it copies.
 *
 * `public-operation-contracts.test.mjs` already proves each capability has a
 * route, a schema and an example that validate. This suite proves the two
 * things that wiring cannot: that a request carrying a derivation is refused by
 * the name of the field, and that every enum in the published schemas is the
 * domain constant rather than a copy of it that has since drifted.
 */

const WAVE20_IDS = Object.freeze([
  'apollo.projects.capture-sessions.direction.run',
  'apollo.projects.capture-sessions.direction.read',
  'apollo.projects.capture-sessions.direction.candidates.list',
  'apollo.projects.capture-sessions.direction.shots.list',
  'apollo.projects.capture-sessions.direction.protected-selections.direct',
  'apollo.projects.capture-sessions.color-match.derive',
  'apollo.projects.capture-sessions.color-match.read',
  'apollo.projects.capture-sessions.color-match.overrides.add',
  'apollo.projects.color-critic-reports.list',
  'apollo.projects.color-critic-reports.read',
  'apollo.projects.color-critic-reports.issues.list',
  'apollo.projects.capture-sessions.playback-map.build',
  'apollo.projects.capture-sessions.playback-map.read',
  'apollo.projects.capture-sessions.playback-map.pieces.list',
  'apollo.projects.capture-sessions.playback-map.anchors.add',
])

const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)

function capability(id) {
  const found = FOUNDATION_CAPABILITIES.find((entry) => entry.id === id)
  assert.ok(found, `${id} must be registered`)
  return found
}

function refuses(fn, fragment) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'INVALID_ARGUMENT', `expected INVALID_ARGUMENT, got ${error.code}: ${error.message}`)
    assert.ok(
      JSON.stringify(error.details ?? {}).includes(fragment) || error.message.includes(fragment),
      `refusal must name ${fragment}; it said ${error.message} ${JSON.stringify(error.details ?? {})}`,
    )
    return true
  })
}

test('T-F4.012 a direction request that carries a derivation is refused by the name of the field', () => {
  const valid = {
    baseVersionId: 'project-version-panel-7',
    baseHash: HASH,
    format: { aspectRatio: '16:9' },
  }
  assert.deepEqual(parseDirectMulticamSessionBody(valid).format, { aspectRatio: '16:9' })

  // Each of these is something the server derives from stored projections. The
  // refusal has to name the key: an operator who sent `confidence` needs to be
  // told to remove `confidence`, not that their request was invalid.
  for (const field of ['confidence', 'shots', 'manualReviewRequired', 'evidenceHash', 'score']) {
    refuses(() => parseDirectMulticamSessionBody({ ...valid, [field]: 1 }), field)
  }
  // The calibration is not an operator preference. Only the five editorial
  // numbers may be moved, and `qualityFloorBps` is the exact threshold a
  // candidate's measured quality is compared against.
  refuses(
    () => parseDirectMulticamSessionBody({ ...valid, policy: { qualityFloorBps: 0 } }),
    'qualityFloorBps',
  )
  for (const key of DIRECTION_POLICY_OVERRIDE_KEYS) {
    assert.deepEqual(
      parseDirectMulticamSessionBody({ ...valid, policy: { [key]: 1_200 } }).policy,
      { [key]: 1_200 },
    )
  }
})

test('T-F4.012 a session tick crosses as a decimal string and a JSON number is refused', () => {
  const valid = {
    baseVersionId: 'project-version-panel-7',
    baseHash: HASH,
    format: { aspectRatio: '16:9' },
  }
  // 2^53 + 1 in 90 kHz ticks is a real position in a long recording and the
  // number a double cannot hold. As a string it survives; as a number the
  // parser refuses rather than storing a rounded instant.
  const start = '9007199254740993'
  assert.equal(
    parseDirectMulticamSessionBody({
      ...valid,
      range: { sessionStartTicks: start, sessionEndTicks: '9007199254740999' },
    }).range.sessionStartTicks,
    start,
  )
  refuses(
    () => parseDirectMulticamSessionBody({
      ...valid,
      range: { sessionStartTicks: 9_007_199_254_740_993, sessionEndTicks: 9_007_199_254_740_999 },
    }),
    'sessionStartTicks',
  )
  refuses(
    () => parseDirectMulticamSessionBody({ ...valid, range: { sessionStartTicks: '90', sessionEndTicks: '90' } }),
    'before',
  )
})

test('T-F4.012 a protected selection may not name its own author, and may not be empty', () => {
  const valid = {
    baseVersionId: 'project-version-panel-7',
    baseHash: HASH,
    format: { aspectRatio: '16:9' },
    protectedSelections: [
      {
        selectionId: 'protected-selection-1',
        trackId: 'track-camera-b',
        sessionStartTicks: '5400000',
        sessionEndTicks: '8100000',
        note: 'Hold on the wide through the demo.',
      },
    ],
  }
  assert.equal(parseProtectMulticamSelectionBody(valid).protectedSelections.length, 1)

  // Who attested a protected selection is the authenticated actor. A note that
  // could also name its own author would let a request put somebody else's name
  // on a human override.
  refuses(
    () => parseProtectMulticamSelectionBody({
      ...valid,
      protectedSelections: [{ ...valid.protectedSelections[0], attestedBy: 'user-someone-else' }],
    }),
    'attestedBy',
  )
  refuses(() => parseProtectMulticamSelectionBody({ ...valid, protectedSelections: [] }), 'protectedSelections')
})

test('T-F4.013 a colour request carries a reference camera and two fences, and no measurement', () => {
  const valid = {
    referenceCameraId: 'camera-a',
    baseVersionId: 'capture-session-panel:v3',
    baseHash: HASH,
    projectBaseVersionId: 'project-version-panel-8',
    projectBaseHash: OTHER_HASH,
  }
  assert.equal(parseDeriveMatchPlanBody(valid).referenceCameraId, 'camera-a')
  for (const field of ['deltas', 'confidence', 'issues', 'measurements']) {
    refuses(() => parseDeriveMatchPlanBody({ ...valid, [field]: 1 }), field)
  }
  // A ColorPlan camera key is a lowercase token; the uppercase form would be
  // accepted by the plan and lower-cased by the renderer, which is how one
  // camera's correction reaches another camera's frames.
  refuses(() => parseDeriveMatchPlanBody({ ...valid, referenceCameraId: 'Camera-A' }), 'referenceCameraId')
})

test('T-F4.013 an override is the one place a colour number is the caller\'s, and it is bounded', () => {
  const valid = {
    baseVersionId: 'capture-session-panel:match:v2',
    baseHash: HASH,
    projectBaseVersionId: 'project-version-panel-9',
    projectBaseHash: OTHER_HASH,
    override: {
      overrideId: 'override-1',
      cameraId: 'camera-b',
      parameters: { brightness: 0.04, contrast: 1, saturation: 1 },
      reason: 'The wide sits under the window.',
    },
  }
  assert.equal(parseMatchRangeOverrideBody(valid).override.parameters.brightness, 0.04)
  refuses(
    () => parseMatchRangeOverrideBody({
      ...valid,
      override: { ...valid.override, parameters: { ...valid.override.parameters, brightness: 12 } },
    }),
    'brightness',
  )
  // A fence from another chain, or from the sync diagnostic, must not match by
  // accident because the version numbers agree.
  assert.equal(derivationVersion('capture-session-panel:match:v2', 'capture-session-panel', 'match', 'baseVersionId'), 2)
  refuses(
    () => derivationVersion('capture-session-panel:diagnostic:v2', 'capture-session-panel', 'match', 'baseVersionId'),
    'baseVersionId',
  )
  refuses(
    () => derivationVersion('capture-session-other:match:v2', 'capture-session-panel', 'match', 'baseVersionId'),
    'baseVersionId',
  )
})

test('T-F4.015 an anchor must say whether there was a reference, and may not merely omit it', () => {
  const valid = {
    baseVersionId: 'capture-session-react:playback:track-reaction:v1',
    baseHash: HASH,
    reactionTrackId: 'track-reaction',
    anchor: { anchorId: 'anchor-1', reactionTick: '3150000', referenceTick: '1800000' },
  }
  assert.equal(parsePlaybackAnchorBody(valid).anchor.referenceTick, BigInt(1_800_000))
  // Null asserts "there was no reference here", which is itself an answer.
  assert.equal(
    parsePlaybackAnchorBody({ ...valid, anchor: { ...valid.anchor, referenceTick: null } }).anchor.referenceTick,
    null,
  )
  // Omitting it would leave that answer and "nobody said" indistinguishable.
  refuses(
    () => parsePlaybackAnchorBody({
      ...valid,
      anchor: { anchorId: 'anchor-1', reactionTick: '3150000' },
    }),
    'referenceTick',
  )
  refuses(
    () => parsePlaybackAnchorBody({ ...valid, anchor: { ...valid.anchor, origin: 'automatic' } }),
    'origin',
  )
})

test('T-F4.012 every published Wave 20 enum is the domain constant, not a copy of it', () => {
  const candidate = getPublicSchema('apollo://schemas/multicam-angle-candidate-list/v1')
    .schema.properties.data.properties.windows.items.properties.candidates.items
  assert.deepEqual(candidate.properties.rejectionReasons.items.enum, [...ANGLE_REJECTIONS])
  assert.deepEqual(
    Object.keys(candidate.properties.score.properties).filter((name) => name !== 'total'),
    [...ANGLE_SCORE_COMPONENT_NAMES],
  )

  const direction = getPublicSchema('apollo://schemas/multicam-direction-read/v1')
    .schema.properties.data.properties.direction
  assert.deepEqual(direction.properties.format.properties.aspectRatio.enum, [...OUTPUT_ASPECT_RATIOS])
  assert.deepEqual(direction.properties.warnings.items.properties.code.enum, [...DIRECTION_WARNINGS])
  assert.deepEqual(
    Object.keys(direction.properties.policy.properties).filter(
      (name) => name !== 'schemaVersion' && name !== 'calibrationVersion',
    ),
    [...DIRECTION_POLICY_OVERRIDE_KEYS],
  )

  const shots = getPublicSchema('apollo://schemas/multicam-shot-decision-list/v1')
    .schema.properties.data.properties.shots.items
  assert.deepEqual(shots.properties.rule.enum, [...DIRECTION_RULES])

  const piece = getPublicSchema('apollo://schemas/react-playback-piece-list/v1')
    .schema.properties.data.properties.pieces.items
  assert.deepEqual(piece.properties.mode.enum, [...PLAYBACK_MODES])

  const issue = getPublicSchema('apollo://schemas/color-critic-issue-list/v1')
    .schema.properties.data.properties.issues.items
  assert.deepEqual(issue.properties.dimension.enum, [...COLOR_CRITIC_DIMENSIONS])
  assert.deepEqual(issue.properties.severity.enum, [...COLOR_CRITIC_SEVERITIES])
})

test('T-F4.014 the published surface exposes the colour verdict and never a way to run it', () => {
  // The critic is handed a path on the server's disk, the sha of the bytes at
  // it and the clips the timeline was cut from, all measured by the render
  // worker. A caller-facing run would take those from a request, which is the
  // caller supplying the evidence for a verdict about their own render.
  const criticCapabilities = FOUNDATION_CAPABILITIES.filter((entry) => entry.id.includes('color-critic'))
  assert.equal(criticCapabilities.length, 3)
  for (const entry of criticCapabilities) {
    assert.equal(entry.operationKind, 'query', `${entry.id} must be a query`)
    assert.deepEqual([...entry.requiredScopes], ['projects:read'])
    assert.equal(entry.inputSchemaRef, undefined, `${entry.id} must accept no body`)
  }
})

test('T-F4.012 the fifteen Wave 20 capabilities obey the query and command rules', () => {
  const commands = []
  for (const id of WAVE20_IDS) {
    const entry = capability(id)
    assert.equal(entry.exposure, 'public')
    assert.equal(entry.authMode, 'required')
    assert.ok(entry.endpoint.path.startsWith('/v1/projects/'), `${id} must be under /v1/projects`)
    if (entry.operationKind === 'query') {
      assert.deepEqual([...entry.requiredScopes], ['projects:read'])
      assert.equal(entry.idempotency, 'not-applicable')
      assert.deepEqual([...entry.successStatuses], [200])
      assert.equal(entry.endpoint.method, 'GET')
      for (const parameter of entry.queryParameters ?? []) {
        assert.ok(parameter.schema.type, `${id}/${parameter.name} must declare a type`)
      }
      continue
    }
    commands.push(entry)
    assert.equal(entry.operationKind, 'command')
    assert.deepEqual([...entry.requiredScopes], ['projects:write'])
    // Not all six the same: two read a caller key and four do not, and the
    // declaration has to say which. `the idempotency a Wave 20 command
    // declares is the one its route reads` below is what pins it to the code.
    assert.ok(
      entry.idempotency === 'required' || entry.idempotency === 'natural',
      `${id} must declare an idempotency a caller can act on`,
    )
    assert.deepEqual([...entry.successStatuses], [201, 200])
    assert.equal(entry.requestBodyRequired, true)
    assert.equal(entry.endpoint.method, 'POST')
    // Every command carries both halves of the fence in its request schema: a
    // version number alone can be reused after a write that failed halfway.
    const input = getPublicSchema(entry.inputSchemaRef).schema
    assert.ok(input.required.includes('baseVersionId'), `${id} must fence on baseVersionId`)
    assert.ok(input.required.includes('baseHash'), `${id} must fence on baseHash`)
    // And every one of them is a rule in the agent-tool safety registry.
    const rule = FOUNDATION_AGENT_TOOL_SAFETY[entry.toolName]
    assert.ok(rule, `${id} must carry an agent-tool safety rule`)
    assert.ok(rule.reason.trim().length >= 10 && rule.reason.trim().length <= 500)
    if (rule.impact !== 'bounded') {
      assert.notEqual(rule.confirmation, 'none', `${id} is ${rule.impact} and must be gated`)
    }
  }
  assert.equal(commands.length, 6)
})

test('T-F4.012 each new endpoint resolves to exactly one capability before the handler runs', () => {
  // `assertPublicCapabilityQuery` runs inside `authenticateExternalRequest`,
  // ahead of every handler body. A path template that overlapped an existing
  // one would fail here as CAPABILITY_PARITY_MISSING rather than in production.
  const resolved = [
    ['GET', '/v1/projects/p1/capture-sessions/s1/direction', {}],
    ['POST', '/v1/projects/p1/capture-sessions/s1/direction', {}],
    ['GET', '/v1/projects/p1/capture-sessions/s1/direction/candidates', { startTicks: '90', limit: '5' }],
    ['GET', '/v1/projects/p1/capture-sessions/s1/direction/shots', {}],
    ['POST', '/v1/projects/p1/capture-sessions/s1/direction/protected-selections', {}],
    ['GET', '/v1/projects/p1/capture-sessions/s1/color-match', {}],
    ['POST', '/v1/projects/p1/capture-sessions/s1/color-match', {}],
    ['POST', '/v1/projects/p1/capture-sessions/s1/color-match/overrides', {}],
    ['GET', '/v1/projects/p1/color-critic-reports', { projectVersionId: 'project-version-1' }],
    ['GET', '/v1/projects/p1/color-critic-reports/r1', {}],
    ['GET', '/v1/projects/p1/color-critic-reports/r1/issues', { severity: 'hard' }],
    ['GET', '/v1/projects/p1/capture-sessions/s1/playback-map', { reactionTrackId: 'track-reaction' }],
    ['POST', '/v1/projects/p1/capture-sessions/s1/playback-map', {}],
    ['GET', '/v1/projects/p1/capture-sessions/s1/playback-map/pieces', { reactionTrackId: 'track-reaction', mode: 'paused' }],
    ['POST', '/v1/projects/p1/capture-sessions/s1/playback-map/anchors', {}],
  ].map(([method, path, query]) => assertPublicCapabilityQuery(
    method,
    path,
    new URLSearchParams(query),
    FOUNDATION_CAPABILITIES,
  ).id)
  assert.deepEqual([...resolved].sort(), [...WAVE20_IDS].sort())

  // The two filters a read cannot guess are refused before the handler, not
  // defaulted inside it.
  for (const [path, missing] of [
    ['/v1/projects/p1/capture-sessions/s1/playback-map', 'reactionTrackId'],
    ['/v1/projects/p1/color-critic-reports', 'projectVersionId'],
  ]) {
    refuses(
      () => assertPublicCapabilityQuery('GET', path, new URLSearchParams(), FOUNDATION_CAPABILITIES),
      missing,
    )
  }
  refuses(
    () => assertPublicCapabilityQuery(
      'GET',
      '/v1/projects/p1/capture-sessions/s1/direction',
      new URLSearchParams({ trackId: 'track-camera-a' }),
      FOUNDATION_CAPABILITIES,
    ),
    'trackId',
  )
})

// ---------------------------------------------------------------------------
// What the routes actually emit, and what they actually read
//
// Two reviewers independently showed that every gate in this repository stayed
// green while a Wave 20 route was mutated: the response wrapper was renamed,
// `replayed` was hardcoded, a field the service never produces was added, and
// `requireScope` was deleted. Nothing validated a route's emitted shape against
// the `outputSchemaRef` it advertises, and nothing tied a request parser to the
// `inputSchemaRef` the precondition audit reads its fence off. The checks below
// are the pins. They are deliberately structural — they read the route source —
// because the alternative is booting Next to exercise fifteen handlers, and a
// text check that fails on the exact mutations is worth more than a runtime
// check that does not exist.
// ---------------------------------------------------------------------------

/** `/v1/projects/{projectId}/...` -> `src/app/v1/projects/[projectId]/.../route.ts`. */
function routeFileFor(entry) {
  const segments = entry.endpoint.path
    .replace(/^\//, '')
    .split('/')
    .map((segment) => (segment.startsWith('{') ? `[${segment.slice(1, -1)}]` : segment))
  return path.join('src', 'app', ...segments, 'route.ts')
}

/** The body of one exported handler, up to the next top-level export. */
function handlerSource(source, method) {
  const opening = `export async function ${method}(`
  const start = source.indexOf(opening)
  assert.ok(start >= 0, `route must export ${method}`)
  const rest = source.slice(start + opening.length)
  const end = rest.indexOf('\nexport ')
  return end === -1 ? rest : rest.slice(0, end)
}

const WAVE20_ROUTES = WAVE20_IDS.map((id) => {
  const entry = capability(id)
  const file = routeFileFor(entry)
  assert.ok(existsSync(file), `${id} must have a route file at ${file}`)
  return { entry, file, source: readFileSync(file, 'utf8') }
})

test('T-F4.012 every Wave 20 route emits its response through one named presenter', () => {
  // A route that assembles its own wrapper is a second source of truth for a
  // published schema, and the schema side is guarded while the emitting side is
  // not: `presentSuccess({ direction: ..., replayed: true, extra: 'x' })`
  // violated `multicam-direction-directed/v1` in three ways and every gate
  // passed. With one named builder per capability, the wrapper the route emits
  // is the wrapper the published example is built from, and Ajv checks that
  // example against the schema on every `api:v1:validate`.
  const examples = readFileSync('src/v2/public-api/schema-examples.ts', 'utf8')
  for (const { entry, file, source } of WAVE20_ROUTES) {
    const handler = handlerSource(source, entry.endpoint.method)
    const calls = handler.match(/presentSuccess\(/g) ?? []
    assert.equal(calls.length, 1, `${entry.id} must build exactly one success body`)
    const named = /presentSuccess\(\s*(present[A-Za-z0-9]*)\(/.exec(handler)
    assert.ok(
      named,
      `${entry.id} must pass presentSuccess a named presenter, not an object literal assembled in ${file}`,
    )
    const presenter = named[1]
    assert.ok(
      source.includes(`\n  ${presenter},\n`) || source.includes(`import { ${presenter} }`),
      `${entry.id} must import ${presenter} from a contract module`,
    )
    // The published example for the same schema is built by the same function,
    // so the shape Ajv validates is the shape the route emits.
    const start = examples.indexOf(`'${entry.outputSchemaRef}': [`)
    assert.ok(start >= 0, `${entry.outputSchemaRef} must publish an example`)
    assert.ok(
      examples.slice(start, start + 400).includes(`data: ${presenter}(`),
      `the ${entry.outputSchemaRef} example must be built by ${presenter}, as the route is`,
    )
  }
})

test('T-F4.012 every Wave 20 route requires the scope its capability declares', () => {
  // Defence in depth rather than the only gate — `authenticateExternalRequest`
  // already enforces `requiredScopes` before the handler body runs. Pinned
  // because deleting the line changed no gate at all, and the day a registry
  // entry loses a scope the route is the last thing standing.
  for (const { entry, source } of WAVE20_ROUTES) {
    assert.equal(entry.requiredScopes.length, 1, `${entry.id} must declare exactly one scope`)
    const handler = handlerSource(source, entry.endpoint.method)
    assert.ok(
      handler.includes(`requireScope(actor, '${entry.requiredScopes[0]}')`),
      `${entry.id} must call requireScope(actor, '${entry.requiredScopes[0]}') in its ${entry.endpoint.method} handler`,
    )
  }
})

test('T-F4.012 the idempotency a Wave 20 command declares is the one its route reads', () => {
  // `idempotency: 'required'` puts a mandatory `Idempotency-Key` header into the
  // published OpenAPI and a required `idempotencyKey` into the agent tool. Four
  // of the six Wave 20 commands declared it while no route and no service read
  // a key — a parameter documented into existence. They declare `'natural'`
  // now, which is what they are: fenced on the exact version and hash the
  // caller read, with a repeat collapsing into `replayed: true`.
  for (const { entry, source } of WAVE20_ROUTES) {
    if (entry.operationKind !== 'command') {
      assert.equal(entry.idempotency, 'not-applicable')
      continue
    }
    const reads = /idempotency-key/i.test(source)
    if (entry.idempotency === 'required') {
      assert.ok(reads, `${entry.id} advertises Idempotency-Key; its route must read it`)
      assert.ok(
        /idempotency: \{ clientId: actor\.clientId, key: idempotencyKey \}/.test(source),
        `${entry.id} must bind the key to the authenticated client, never to the request alone`,
      )
    } else {
      assert.equal(entry.idempotency, 'natural')
      assert.equal(
        reads,
        false,
        `${entry.id} declares a natural key; reading Idempotency-Key without threading it is worse than not reading it`,
      )
    }
  }
})

/**
 * The same rule across the whole published surface, with the debt named.
 *
 * Every capability declaring `idempotency: 'required'` must have a route that
 * reads the header. The eight below were already shipped that way by Waves 18
 * and 19; they are listed so the count cannot grow and so nobody reads this
 * suite as saying the surface is clean. Wave 20 is not on the list.
 */
const IDEMPOTENCY_HEADER_DEBT = Object.freeze([
  'apollo.projects.capture-sessions.create',
  'apollo.projects.capture-sessions.tracks.add',
  'apollo.projects.capture-sessions.track-parts.add',
  'apollo.projects.capture-sessions.reference-track.change',
  'apollo.projects.capture-sessions.protocol.evaluate',
  'apollo.projects.capture-sessions.sync-diagnostic.generate',
  'apollo.projects.capture-sessions.sync-diagnostic.anchors.edit',
  'apollo.projects.editorial-syntheses.create',
])

test('no NEW capability advertises an Idempotency-Key nothing reads', () => {
  const unread = FOUNDATION_CAPABILITIES
    .filter((entry) => entry.idempotency === 'required' && entry.endpoint)
    .filter((entry) => {
      const file = routeFileFor(entry)
      return !existsSync(file) || !/idempotency-key/i.test(readFileSync(file, 'utf8'))
    })
    .map((entry) => entry.id)
  assert.deepEqual(
    [...unread].sort(),
    [...IDEMPOTENCY_HEADER_DEBT].sort(),
    'a capability that requires an idempotency key must have a route that reads one',
  )
  for (const id of IDEMPOTENCY_HEADER_DEBT) {
    assert.ok(!WAVE20_IDS.includes(id), `${id} is Wave 20 and must not be on the debt list`)
  }
})

// ---------------------------------------------------------------------------
// The published request schema and the runtime parser, pinned to each other
// ---------------------------------------------------------------------------

const WAVE20_PARSERS = Object.freeze({
  'apollo.projects.capture-sessions.direction.run': parseDirectMulticamSessionBody,
  'apollo.projects.capture-sessions.direction.protected-selections.direct': parseProtectMulticamSelectionBody,
  'apollo.projects.capture-sessions.color-match.derive': parseDeriveMatchPlanBody,
  'apollo.projects.capture-sessions.color-match.overrides.add': parseMatchRangeOverrideBody,
  'apollo.projects.capture-sessions.playback-map.build': parseBuildPlaybackMapBody,
  'apollo.projects.capture-sessions.playback-map.anchors.add': parsePlaybackAnchorBody,
})

test('T-F4.012 every key a Wave 20 request schema requires is a key its parser refuses to do without', () => {
  // The precondition audit classifies `direction.run` as a base-version-bound
  // action on the strength of `required: ['baseVersionId', 'baseHash', ...]` in
  // the *schema*. Nothing read the parser. Making `baseHash` optional there —
  // defaulting to a zero digest — left the audit, the OpenAPI and every gate
  // green, and only the service's own re-check of the pair kept the build from
  // writing unfenced. This loop is the missing edge: the schema's `required`
  // drives the parser, one key at a time, off the published example.
  for (const [id, parse] of Object.entries(WAVE20_PARSERS)) {
    const entry = capability(id)
    const schema = getPublicSchema(entry.inputSchemaRef).schema
    const examples = PUBLIC_SCHEMA_EXAMPLES[entry.inputSchemaRef]
    assert.ok(examples?.length > 0, `${entry.inputSchemaRef} must publish an example`)
    const example = examples[0]

    // The published example is what a caller copies. If the parser refuses it,
    // the documentation is a trap.
    assert.doesNotThrow(() => parse(example), `${id} must accept its own published example`)

    assert.ok(schema.required.length > 0, `${id} must require something`)
    for (const key of schema.required) {
      const { [key]: _removed, ...without } = example
      refuses(() => parse(without), key)
    }
  }
})

test('T-F4.015 a version ref the server builds at full width survives its own published bound', () => {
  // `presentBuiltPlaybackMap` builds `<sessionId>:playback:<trackId>:v<n>` out
  // of two ids a caller may legitimately choose 128 characters long. Published
  // as `idSchema` the composite was 269 characters against a maximum of 128, so
  // the API handed out a fence it would refuse back — and the parser, capped at
  // the 200 `identifier` allows, refused it too.
  const widest = `${'s'.repeat(128)}:playback:${'t'.repeat(128)}:v999999999`
  assert.equal(widest.length, 277)

  const request = getPublicSchema('apollo://schemas/add-react-playback-anchor-request/v1').schema
  assert.ok(
    widest.length <= request.properties.baseVersionId.maxLength,
    `the published baseVersionId bound (${request.properties.baseVersionId.maxLength}) must accept a ref the server builds (${widest.length})`,
  )
  for (const ref of [
    'apollo://schemas/react-playback-map-read/v1',
    'apollo://schemas/react-playback-map-built/v1',
    'apollo://schemas/multicam-match-plan-read/v1',
  ]) {
    const published = getPublicSchema(ref).schema.properties.data.properties.versionRef
    const bound = published.maxLength ?? published.oneOf[0].maxLength
    assert.ok(bound >= widest.length, `${ref} publishes versionRef with maxLength ${bound}`)
  }

  // And the parser accepts what the schema accepts.
  const parsed = parsePlaybackAnchorBody({
    baseVersionId: widest,
    baseHash: HASH,
    reactionTrackId: 'track-reaction',
    anchor: { anchorId: 'anchor-1', reactionTick: '900', referenceTick: '450' },
  })
  assert.equal(parsed.baseVersionId, widest)
  // Still bounded: 300 is the grammar, not "anything".
  refuses(
    () => parsePlaybackAnchorBody({
      baseVersionId: 'x'.repeat(301),
      baseHash: HASH,
      reactionTrackId: 'track-reaction',
      anchor: { anchorId: 'anchor-1', reactionTick: '900', referenceTick: '450' },
    }),
    'baseVersionId',
  )
})

// ---------------------------------------------------------------------------
// Derived truths an agent acts on
// ---------------------------------------------------------------------------

function criticReport(overrides = {}) {
  return {
    reportId: 'report-1',
    projectId: 'project-1',
    projectVersionId: 'project-version-1',
    action: 'accept',
    cause: 'none',
    confidence: 9_000,
    confidenceBand: 'high',
    referenceCameraId: 'camera-a',
    matchPlanId: null,
    issues: [],
    evaluatedAt: '2026-09-01T00:00:00.000Z',
    reportHash: HASH,
    ...overrides,
  }
}

test('T-F4.014 the correction budget does not move when the caller changes the page size', () => {
  // `evaluate` counts bounded corrections over a fixed window before it decides
  // whether another one is allowed. The listing used to count over the caller's
  // own page, so `?limit=1` reported the budget as unspent for a version whose
  // next correction the evaluator will refuse — an agent reading the listing
  // would have asked for a correction that cannot happen.
  const rows = [
    criticReport({ reportId: 'r3', action: 'bounded-correction', evaluatedAt: '2026-09-03T00:00:00.000Z' }),
    criticReport({ reportId: 'r2', action: 'bounded-correction', evaluatedAt: '2026-09-02T00:00:00.000Z' }),
    criticReport({ reportId: 'r1', action: 'accept', evaluatedAt: '2026-09-01T00:00:00.000Z' }),
  ]
  const seen = []
  const list = listColorCriticReportsService({
    reports: {
      async listForProjectVersion({ limit }) {
        seen.push(limit)
        return rows.slice(0, limit ?? 25)
      },
    },
  })
  const scope = { workspaceId: 'ws-1', projectId: 'project-1', projectVersionId: 'project-version-1' }
  return Promise.all([list(scope), list({ ...scope, limit: 1 }), list({ ...scope, limit: 100 })])
    .then(([wide, narrow, widest]) => {
      for (const [label, answer] of [['default', wide], ['limit=1', narrow], ['limit=100', widest]]) {
        assert.equal(answer.correctionsApplied, 2, `${label} must see both bounded corrections`)
        assert.equal(answer.correctionBudgetExhausted, true, `${label} must see the budget spent`)
      }
      // The page itself still honours the caller.
      assert.equal(narrow.reports.length, 1)
      assert.equal(wide.reports.length, 3)
      // And the budget was always counted over the evaluator's window.
      assert.ok(
        seen.filter((limit) => limit === COLOR_CRITIC_BUDGET_WINDOW).length >= 2,
        `the budget read must use the evaluator window; saw ${seen.join(',')}`,
      )
    })
})

test('T-F4.014 a verdict about one project is not readable under another project path', async () => {
  // The route is `/v1/projects/{projectId}/color-critic-reports/{reportId}`.
  // A path segment that names a project is either enforced or it is a lie the
  // client believes: a verdict about project A returned under project B's URL
  // is filed against the wrong cut, and the 404 that should have happened did
  // not. The fake below deliberately IGNORES the projectId hint, so this proves
  // the service refuses rather than the query.
  const reports = { async read({ reportId }) { return reportId === 'report-1' ? criticReport() : null } }
  const read = readColorCriticReportService({ reports })
  const listIssues = listColorCriticIssuesService({ reports })

  assert.equal((await read({ workspaceId: 'ws-1', projectId: 'project-1', reportId: 'report-1' })).reportId, 'report-1')
  for (const call of [
    () => read({ workspaceId: 'ws-1', projectId: 'project-2', reportId: 'report-1' }),
    () => listIssues({ workspaceId: 'ws-1', projectId: 'project-2', reportId: 'report-1' }),
  ]) {
    await assert.rejects(call, (error) => {
      assert.equal(error.code, 'COLOR_CRITIC_REPORT_NOT_FOUND')
      return true
    })
  }
  // The issue listing under the owning project still answers.
  assert.equal(
    (await listIssues({ workspaceId: 'ws-1', projectId: 'project-1', reportId: 'report-1' })).reportId,
    'report-1',
  )
})

test('T-F4.012 a stale refusal reaches the caller with the version and hash that are current', () => {
  // The audit rows say these refusals "carry the current pair". They did not:
  // the public presenter forwarded `details` only for AUTH_SCOPE_REQUIRED, so a
  // UI that wanted to offer "reload and retry" got a generic message and
  // nothing to reload to.
  for (const code of [
    'CAPTURE_SESSION_VERSION_STALE',
    'SYNC_DIAGNOSTIC_VERSION_STALE',
    'PLAYBACK_MAP_VERSION_STALE',
    'PERSISTENCE_CONFLICT',
  ]) {
    const presented = presentPublicDomainError(
      new DomainError(code, 'moved on', {
        currentVersionId: 'capture-session-1:playback:track-reaction:v7',
        currentVersion: 7,
        currentHash: OTHER_HASH,
      }),
      'req-1',
    )
    assert.equal(presented.error.code, code)
    assert.deepEqual(presented.error.details, {
      currentVersionId: 'capture-session-1:playback:track-reaction:v7',
      currentVersion: 7,
      currentHash: OTHER_HASH,
    })
  }

  // A project fence names its half `currentBaseHash`; that travels too.
  const conflict = presentPublicDomainError(
    new DomainError('VERSION_CONFLICT', 'stale', {
      currentVersionId: 'project-version-9',
      currentBaseHash: OTHER_HASH,
    }),
    'req-2',
  )
  assert.deepEqual(conflict.error.details, {
    currentVersionId: 'project-version-9',
    currentBaseHash: OTHER_HASH,
  })

  // Nothing else in `details` crosses, and a malformed pair is dropped rather
  // than published: details are internal, and a future throw must not be able
  // to leak through this door.
  const noisy = presentPublicDomainError(
    new DomainError('PERSISTENCE_CONFLICT', 'stale', {
      currentVersion: 3,
      currentHash: 'not-a-digest',
      internalCursor: 'row-4711',
    }),
    'req-3',
  )
  assert.deepEqual(noisy.error.details, { currentVersion: 3 })
  assert.equal(
    presentPublicDomainError(new DomainError('PERSISTENCE_CONFLICT', 'x', {}), 'req-4').error.details,
    undefined,
  )
})

test('T-F4.015 a published example states what the fixture it was built from actually holds', () => {
  // The examples are built by the real presenters, but the ARGUMENTS handed to
  // those presenters are still written by hand. Replacing one derived value
  // with a literal that says the opposite — `manualReviewRequired: false` over
  // a map with uncovered stretches — passed every gate, because Ajv only checks
  // that an example is well-typed. This checks that it is also true.
  for (const ref of [
    'apollo://schemas/react-playback-map-built/v1',
    'apollo://schemas/react-playback-map-anchored/v1',
    'apollo://schemas/react-playback-map-read/v1',
  ]) {
    const { data } = PUBLIC_SCHEMA_EXAMPLES[ref][0]
    assert.equal(
      data.manualReviewRequired,
      data.map.uncovered.length > 0,
      `${ref} must say a person is needed exactly when the map has a stretch nobody could resolve`,
    )
  }
  // The same rule for the two counters on the verdict listing: the summary is
  // derived from the reports it lists, so the example cannot claim otherwise.
  const listing = PUBLIC_SCHEMA_EXAMPLES['apollo://schemas/color-critic-report-list/v1'][0].data
  assert.equal(
    listing.correctionBudgetExhausted,
    listing.correctionsApplied >= 2,
    'the example must exhaust the budget exactly when it has spent it',
  )
  assert.ok(listing.reports.length > 0, 'the listing example must list something')
})

// ---------------------------------------------------------------------------
// The two compiles, published after the rest of Wave 20
//
// They are a separate list from WAVE20_IDS because they answer the fence
// question differently, and the difference is the point rather than an
// oversight: the react map is a version chain and the compile fences on it; an
// EditorialSynthesis is one immutable content-addressed cut with no later
// version to be stale against, so there is nothing to fence and the request
// says so by carrying no fence at all. Everything else about them is held to
// the same rules as the other six Wave 20 commands.
// ---------------------------------------------------------------------------

const WAVE20_PLAN_IDS = Object.freeze([
  'apollo.projects.capture-sessions.playback-map.plan.compile',
  'apollo.projects.editorial-syntheses.render-plan.compile',
])

const WAVE20_PLAN_ROUTES = WAVE20_PLAN_IDS.map((id) => {
  const entry = capability(id)
  const file = routeFileFor(entry)
  assert.ok(existsSync(file), `${id} must have a route file at ${file}`)
  return { entry, file, source: readFileSync(file, 'utf8') }
})

test('T-F4.016 the two compiles are published commands with a route, a presenter and a scope', () => {
  const examples = readFileSync('src/v2/public-api/schema-examples.ts', 'utf8')
  for (const { entry, file, source } of WAVE20_PLAN_ROUTES) {
    assert.equal(entry.exposure, 'public')
    assert.equal(entry.authMode, 'required')
    assert.equal(entry.operationKind, 'command')
    assert.equal(entry.endpoint.method, 'POST')
    assert.ok(entry.endpoint.path.startsWith('/v1/projects/'))
    assert.deepEqual([...entry.requiredScopes], ['projects:write'])
    assert.deepEqual([...entry.successStatuses], [201, 200])
    assert.equal(entry.requestBodyRequired, true)
    // Natural, and therefore no header: the plan is content-addressed under
    // (workspace, origin, source, source hash, project version), so a repeat
    // replays. A route that advertised Idempotency-Key without reading one
    // would publish a mandatory parameter nothing consumes.
    assert.equal(entry.idempotency, 'natural')
    assert.equal(
      /idempotency-key/i.test(source),
      false,
      `${entry.id} declares a natural key and must not read a header`,
    )

    const handler = handlerSource(source, 'POST')
    assert.ok(
      handler.includes("requireScope(actor, 'projects:write')"),
      `${entry.id} must call requireScope in its handler`,
    )
    const calls = handler.match(/presentSuccess\(/g) ?? []
    assert.equal(calls.length, 1, `${entry.id} must build exactly one success body`)
    const named = /presentSuccess\(\s*(present[A-Za-z0-9]*)\(/.exec(handler)
    assert.ok(named, `${entry.id} must pass presentSuccess a named presenter, not a literal in ${file}`)
    assert.equal(
      named[1],
      'presentCompiledRenderablePlan',
      `${entry.id} must answer through the one shared compiled-plan presenter`,
    )
    // The published example is built by the same presenter the route emits
    // through, so what Ajv validates is what a caller receives.
    const start = examples.indexOf(`'${entry.outputSchemaRef}': [`)
    assert.ok(start >= 0, `${entry.outputSchemaRef} must publish an example`)
    assert.ok(
      examples.slice(start, start + 800).includes('data: presentCompiledRenderablePlan('),
      `the ${entry.outputSchemaRef} example must be built by the presenter the route uses`,
    )
    // The route reaches the application layer rather than a repository.
    assert.match(
      source,
      /from '@\/v2\/infrastructure\/repository-factory'/,
      `${entry.id} must build its service from the composition root`,
    )
  }
})

test('T-F4.016 the compile that has a version chain fences on it, and the one that has none says so', () => {
  const react = capability('apollo.projects.capture-sessions.playback-map.plan.compile')
  const reactInput = getPublicSchema(react.inputSchemaRef).schema
  assert.ok(reactInput.required.includes('baseVersionId'), 'the map compile must fence on baseVersionId')
  assert.ok(reactInput.required.includes('baseHash'), 'the map compile must fence on baseHash')
  // And the parser refuses what the schema requires, one key at a time, off the
  // published example — the edge that let a Wave 20 fence be made optional in
  // the parser while the schema, the audit and every gate stayed green.
  const reactExample = PUBLIC_SCHEMA_EXAMPLES[react.inputSchemaRef][0]
  assert.doesNotThrow(() => parseCompilePlaybackPlanBody(reactExample))
  for (const key of reactInput.required) {
    const { [key]: _removed, ...without } = reactExample
    refuses(() => parseCompilePlaybackPlanBody(without), key)
  }
  // A rate that is not a rate is refused at the boundary rather than rounded.
  refuses(
    () => parseCompilePlaybackPlanBody({ ...reactExample, planFps: '29.97' }),
    'planFps',
  )
  // An objective outside the domain constant is refused by name.
  refuses(
    () => parseCompilePlaybackPlanBody({ ...reactExample, objective: 'engagement' }),
    'objective',
  )

  const synthesis = capability('apollo.projects.editorial-syntheses.render-plan.compile')
  const synthesisInput = getPublicSchema(synthesis.inputSchemaRef).schema
  assert.deepEqual(
    [...synthesisInput.required].sort(),
    ['objective', 'projectVersionId'],
    'the synthesis compile takes ids and an objective, and nothing that asserts a measurement',
  )
  const synthesisExample = PUBLIC_SCHEMA_EXAMPLES[synthesis.inputSchemaRef][0]
  assert.doesNotThrow(() => parseCompileSynthesisPlanBody(synthesisExample))
  for (const key of synthesisInput.required) {
    const { [key]: _removed, ...without } = synthesisExample
    refuses(() => parseCompileSynthesisPlanBody(without), key)
  }
  // Neither request has any shape a caller could use to assert what the cut is:
  // no source, no digest, no duration, no clip and no frame rate.
  for (const forbidden of ['sources', 'sourceArtifactId', 'sha256', 'durationSeconds', 'clips', 'frameRate', 'planFps']) {
    refuses(
      () => parseCompileSynthesisPlanBody({ ...synthesisExample, [forbidden]: 'x' }),
      forbidden,
    )
  }
})

test('T-F4.016 the compiled-plan answer is the stored row, and it publishes what makes a plan falsifiable', () => {
  const schema = getPublicSchema('apollo://schemas/renderable-plan-compiled/v1').schema
  const plan = schema.properties.data.properties.plan
  assert.equal(plan.additionalProperties, false)
  // The four fields a reader needs to tell a current plan from a stale one, and
  // the origins spread from the domain constant rather than retyped.
  for (const field of ['planHash', 'sourceId', 'sourceHash', 'sourceVersion']) {
    assert.ok(plan.required.includes(field), `the answer must carry ${field}`)
  }
  // Published v1 is immutable. New Wave 21 origins use their own contracts;
  // growing the internal domain enum must never silently widen this response.
  const publishedV1Origins = ['react-playback', 'multi-range-synthesis']
  assert.deepEqual(plan.properties.origin.enum, publishedV1Origins)
  assert.ok(publishedV1Origins.every((origin) => RENDERABLE_PLAN_ORIGINS.includes(origin)))
  // Null is a legal answer for a source with no chain, and it is the synthesis
  // example that proves the schema allows it rather than a comment saying so.
  const examples = PUBLIC_SCHEMA_EXAMPLES['apollo://schemas/renderable-plan-compiled/v1']
  assert.equal(examples.length, 2, 'both origins must publish an example')
  const byOrigin = Object.fromEntries(examples.map((entry) => [entry.data.plan.origin, entry.data.plan]))
  assert.deepEqual(Object.keys(byOrigin).sort(), [...publishedV1Origins].sort())
  assert.equal(byOrigin['multi-range-synthesis'].sourceVersion, null)
  assert.equal(typeof byOrigin['react-playback'].sourceVersion, 'number')
  // The assumptions are the honest part of an automated cut and they travel.
  assert.ok(
    byOrigin['react-playback'].assumptions.some((line) => line.includes('ADR-135')),
    'the react example must publish the compiler sentence about which recording sets the length',
  )
})

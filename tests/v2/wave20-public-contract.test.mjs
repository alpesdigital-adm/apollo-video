import assert from 'node:assert/strict'
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
import { PLAYBACK_MODES } from '../../src/v2/domain/playback-map.ts'
import { DIRECTION_POLICY_OVERRIDE_KEYS } from '../../src/v2/application/multicam-direction.ts'
import { FOUNDATION_AGENT_TOOL_SAFETY } from '../../src/v2/public-api/agent-tool-safety.ts'
import { FOUNDATION_CAPABILITIES } from '../../src/v2/public-api/capability-registry.ts'
import {
  parseDirectMulticamSessionBody,
  parseProtectMulticamSelectionBody,
} from '../../src/v2/public-api/multicam-direction-contract.ts'
import {
  parseDeriveMatchPlanBody,
  parseMatchRangeOverrideBody,
} from '../../src/v2/public-api/multicam-color-contract.ts'
import { parsePlaybackAnchorBody } from '../../src/v2/public-api/react-playback-map-contract.ts'
import { derivationVersion } from '../../src/v2/public-api/capture-derivation-contract.ts'
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
    assert.equal(entry.idempotency, 'required')
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

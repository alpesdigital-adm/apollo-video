import { calculateCanonicalHash } from './canonical-hash.ts'
import type { CaptureSession, CaptureTrackRole } from './capture-session.ts'
import { assertDomain } from './errors.ts'

/**
 * F4.009 — versioned capture protocols (FR-147).
 *
 * A protocol is not a checklist. A checklist that asks for a marker and shrugs
 * when it is missing has told the operator nothing they can act on: they find
 * out what it cost after the shoot, when the material is already on the card
 * and the room has been struck.
 *
 * So a requirement here names **what stops being possible without it**. No
 * scratch audio on the screen recording means audio fingerprinting is
 * unavailable for that track, which means manual anchors, which means no
 * unattended edit. That chain is the protocol's whole reason to exist, and it
 * is stated before the recording rather than diagnosed after it.
 *
 * The second rule is that compliance is **observed, not declared**. An earlier
 * draft of this feature took a `provided: string[]` from the caller — the
 * client asserting its own conformance, which is exactly the client-produced
 * evidence the architecture forbids as authority. Everything that can be seen
 * in the CaptureSession is derived from it. The handful of facts nobody can
 * observe from the media — whether the presenter wore headphones — are
 * recorded as *attested* and carry that label all the way to the diagnostic.
 */

export const CAPTURE_PROTOCOL_SCHEMA_VERSION = 'capture-protocol/v1' as const

export const CAPTURE_SCENARIOS = Object.freeze([
  'teacher-and-screen',
  'podcast',
  'react',
  'multicam',
] as const)
export type CaptureScenario = (typeof CAPTURE_SCENARIOS)[number]

/**
 * What a requirement protects. Each one is a synchronization capability that
 * disappears when the requirement is unmet — never a vague quality goal.
 */
export const SYNC_CAPABILITIES = Object.freeze([
  'shared-clock',
  'audio-fingerprint',
  'marker-correlation',
  'drift-measurement',
  'continuous-piecewise-map',
  'reference-cross-check',
] as const)
export type SyncCapability = (typeof SYNC_CAPABILITIES)[number]

/**
 * How a requirement is checked.
 *
 * `observed` is derived from the session. `attested` is a human statement
 * about something no probe can see, and it never counts as verification — it
 * is carried forward labelled so that a diagnostic built on it says so.
 */
export const REQUIREMENT_VERIFICATIONS = Object.freeze(['observed', 'attested'] as const)
export type RequirementVerification = (typeof REQUIREMENT_VERIFICATIONS)[number]

export const REQUIREMENT_LEVELS = Object.freeze(['required', 'recommended'] as const)
export type RequirementLevel = (typeof REQUIREMENT_LEVELS)[number]

/** The ceiling a protocol places on unattended editing. */
export const SYNC_CEILINGS = Object.freeze([
  'automatic',
  'automatic-with-review',
  'manual-anchors-required',
  'not-synchronizable',
] as const)
export type SyncCeiling = (typeof SYNC_CEILINGS)[number]

/**
 * How a requirement is decided against a real session.
 *
 * Declarative on purpose. An earlier draft matched requirement ids against a
 * list of strings the client sent, which meant the answer was whatever the
 * client typed. Each check below names something the system can look at
 * itself — except `operator-attestation`, which exists precisely because some
 * facts have no observable trace and pretending otherwise would be worse.
 */
export type RequirementCheck =
  | Readonly<{ kind: 'track-present'; role: CaptureTrackRole; minimum: number }>
  | Readonly<{ kind: 'track-carries-sync-audio'; role: CaptureTrackRole }>
  | Readonly<{ kind: 'track-excluded-from-mix'; role: CaptureTrackRole }>
  | Readonly<{ kind: 'single-continuous-recording'; role: CaptureTrackRole }>
  | Readonly<{ kind: 'marker-observed'; position: 'start' | 'end' | 'after-restart' }>
  | Readonly<{ kind: 'distinct-devices'; minimum: number }>
  | Readonly<{ kind: 'operator-attestation' }>

export interface CaptureRequirement {
  readonly requirementId: string
  readonly level: RequirementLevel
  readonly verification: RequirementVerification
  readonly check: RequirementCheck
  /** Stated to the operator before recording, in their words. */
  readonly statement: string
  /**
   * What is lost without it. Empty only for a recommendation that improves
   * quality without removing a capability.
   */
  readonly losesCapabilities: readonly SyncCapability[]
  /** The plain consequence, for a person deciding whether to re-shoot. */
  readonly consequence: string
}

export interface ExpectedTrack {
  readonly role: CaptureTrackRole
  readonly minimum: number
  /** Null when any number above the minimum is fine. */
  readonly maximum: number | null
  readonly mustCarryAudio: boolean
  readonly note: string
}

export interface CaptureProtocol {
  readonly schemaVersion: typeof CAPTURE_PROTOCOL_SCHEMA_VERSION
  readonly protocolId: string
  readonly scenario: CaptureScenario
  /** Monotonic. A published protocol is never edited in place. */
  readonly version: number
  readonly title: string
  readonly summary: string
  readonly requirements: readonly Readonly<CaptureRequirement>[]
  readonly expectedTracks: readonly Readonly<ExpectedTrack>[]
  /** The best outcome achievable when every requirement is met. */
  readonly bestCeiling: SyncCeiling
  readonly publishedAt: string
  readonly protocolHash: string
}

const ID = /^[a-z0-9][a-z0-9-]{2,63}$/

function assertId(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} must be a lowercase kebab-case identifier`)
  return value
}

function assertStatement(value: string, field: string): string {
  const trimmed = value.trim()
  // Long enough to be a sentence an operator can act on. "Emit marker" is not
  // an instruction; it is a label.
  assertDomain(
    trimmed.length >= 20 && trimmed.length <= 400,
    'INVALID_ARGUMENT',
    `${field} must be a sentence an operator can act on`,
  )
  return trimmed
}

export function createCaptureProtocol(input: {
  protocolId: string
  scenario: CaptureScenario
  version: number
  title: string
  summary: string
  requirements: readonly Readonly<CaptureRequirement>[]
  expectedTracks: readonly Readonly<ExpectedTrack>[]
  bestCeiling: SyncCeiling
  publishedAt: string
}): Readonly<CaptureProtocol> {
  assertId(input.protocolId, 'protocolId')
  assertDomain(
    CAPTURE_SCENARIOS.includes(input.scenario),
    'INVALID_ARGUMENT',
    `${input.scenario} is not a capture scenario`,
  )
  assertDomain(
    Number.isSafeInteger(input.version) && input.version >= 1,
    'INVALID_ARGUMENT',
    'a protocol version is a positive integer',
  )
  assertDomain(
    SYNC_CEILINGS.includes(input.bestCeiling),
    'INVALID_ARGUMENT',
    `${input.bestCeiling} is not a sync ceiling`,
  )
  assertDomain(input.requirements.length > 0, 'INVALID_ARGUMENT', 'a protocol states at least one requirement')
  assertDomain(input.expectedTracks.length > 0, 'INVALID_ARGUMENT', 'a protocol names the tracks it expects')

  const seen = new Set<string>()
  for (const requirement of input.requirements) {
    assertId(requirement.requirementId, 'requirementId')
    assertDomain(
      !seen.has(requirement.requirementId),
      'INVALID_ARGUMENT',
      `requirement ${requirement.requirementId} is declared twice`,
    )
    seen.add(requirement.requirementId)
    assertStatement(requirement.statement, `requirement ${requirement.requirementId} statement`)
    assertStatement(requirement.consequence, `requirement ${requirement.requirementId} consequence`)
    assertDomain(
      REQUIREMENT_LEVELS.includes(requirement.level),
      'INVALID_ARGUMENT',
      `${requirement.level} is not a requirement level`,
    )
    assertDomain(
      REQUIREMENT_VERIFICATIONS.includes(requirement.verification),
      'INVALID_ARGUMENT',
      `${requirement.verification} is not a verification kind`,
    )
    // The label and the check have to agree. A requirement calling itself
    // observed while its only check is an attestation would let a human
    // statement be read downstream as a measurement.
    assertDomain(
      (requirement.verification === 'attested') === (requirement.check.kind === 'operator-attestation'),
      'INVALID_ARGUMENT',
      `requirement ${requirement.requirementId} disagrees with its own check about whether it can be observed`,
    )
    for (const capability of requirement.losesCapabilities) {
      assertDomain(
        SYNC_CAPABILITIES.includes(capability),
        'INVALID_ARGUMENT',
        `${capability} is not a synchronization capability`,
      )
    }
    // A requirement that is mandatory and costs nothing when skipped is not
    // mandatory; it is a preference wearing the wrong label.
    assertDomain(
      requirement.level !== 'required' || requirement.losesCapabilities.length > 0,
      'INVALID_ARGUMENT',
      `requirement ${requirement.requirementId} is required but names nothing that is lost without it`,
    )
  }

  for (const expected of input.expectedTracks) {
    assertDomain(
      Number.isSafeInteger(expected.minimum) && expected.minimum >= 0,
      'INVALID_ARGUMENT',
      `expected track ${expected.role} has an invalid minimum`,
    )
    assertDomain(
      expected.maximum === null || (Number.isSafeInteger(expected.maximum) && expected.maximum >= expected.minimum),
      'INVALID_ARGUMENT',
      `expected track ${expected.role} has a maximum below its minimum`,
    )
  }

  const body = {
    schemaVersion: CAPTURE_PROTOCOL_SCHEMA_VERSION,
    protocolId: input.protocolId,
    scenario: input.scenario,
    version: input.version,
    title: input.title.trim(),
    summary: assertStatement(input.summary, 'summary'),
    requirements: Object.freeze(input.requirements.map((requirement) => Object.freeze({
      ...requirement,
      statement: requirement.statement.trim(),
      consequence: requirement.consequence.trim(),
      losesCapabilities: Object.freeze([...requirement.losesCapabilities]),
    }))),
    expectedTracks: Object.freeze(input.expectedTracks.map((track) => Object.freeze({ ...track }))),
    bestCeiling: input.bestCeiling,
    publishedAt: input.publishedAt,
  }
  return Object.freeze({ ...body, protocolHash: calculateCanonicalHash(body) })
}

export function assertCaptureProtocolIntegrity(protocol: Readonly<CaptureProtocol>): Readonly<CaptureProtocol> {
  assertDomain(
    protocol.schemaVersion === CAPTURE_PROTOCOL_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored capture protocol schema is invalid',
  )
  const { protocolHash, ...body } = protocol
  assertDomain(
    calculateCanonicalHash(body) === protocolHash,
    'PERSISTENCE_CONFLICT',
    'stored capture protocol hash does not match its body',
  )
  return protocol
}

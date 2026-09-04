import { calculateCanonicalHash } from './canonical-hash.ts'
import type { CaptureSession, CaptureTrack } from './capture-session.ts'
import type {
  CaptureProtocol,
  CaptureRequirement,
  RequirementCheck,
  SyncCapability,
  SyncCeiling,
} from './capture-protocol.ts'
import { assertDomain } from './errors.ts'

/**
 * F4.009 — deciding a protocol against a real session (FR-147).
 *
 * Every check reads the CaptureSession the ingest actually produced. Nothing
 * here accepts the caller's word for whether a requirement was met, with one
 * deliberate exception: `operator-attestation`, for facts that leave no trace
 * in the media. Those are recorded as attested and stay labelled, so a
 * diagnostic built on them can say which of its inputs was a measurement and
 * which was somebody's recollection.
 *
 * The output is not a score. It is the list of capabilities that are gone and
 * the ceiling that follows, because "78% compliant" tells an editor nothing
 * while "audio fingerprinting is unavailable on the screen track, so this
 * needs manual anchors" tells them exactly what to do next.
 */

export const CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION = 'capture-protocol-evaluation/v1' as const

export const REQUIREMENT_OUTCOMES = Object.freeze([
  'met',
  'unmet',
  'attested',
  'attestation-missing',
] as const)
export type RequirementOutcome = (typeof REQUIREMENT_OUTCOMES)[number]

export interface RequirementFinding {
  readonly requirementId: string
  readonly level: CaptureRequirement['level']
  readonly outcome: RequirementOutcome
  /** What the session actually showed. The sentence an operator reads. */
  readonly observation: string
  readonly losesCapabilities: readonly SyncCapability[]
  readonly consequence: string
}

/**
 * Marker facts the system observed, never the client's claim.
 *
 * Supplied by F4.010's detection rather than by the request, which is why the
 * shape is a set of positions the *detector* confirmed rather than a boolean
 * the caller sets.
 */
export interface ObservedMarkerFacts {
  readonly confirmedPositions: readonly ('start' | 'end' | 'after-restart')[]
}

export interface CaptureProtocolEvaluation {
  readonly schemaVersion: typeof CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION
  readonly workspaceId: string
  readonly sessionId: string
  /** The exact session version judged. A later version is a different session. */
  readonly sessionVersion: number
  readonly sessionHash: string
  readonly protocolId: string
  readonly protocolVersion: number
  readonly protocolHash: string
  readonly findings: readonly Readonly<RequirementFinding>[]
  /** Union of everything lost by unmet requirements at any level. */
  readonly lostCapabilities: readonly SyncCapability[]
  readonly ceiling: SyncCeiling
  /** True when the ceiling forbids cutting without a person in the loop. */
  readonly blocksAutoEdit: boolean
  /** Requirements answered by a human statement rather than by the media. */
  readonly attestedRequirementIds: readonly string[]
  readonly evaluatedAt: string
  readonly evaluationHash: string
}

function tracksWithRole(session: Readonly<CaptureSession>, role: CaptureTrack['role']): readonly Readonly<CaptureTrack>[] {
  return session.tracks.filter((track) => track.role === role)
}

/**
 * Decide one check against the session.
 *
 * Returns the outcome and the sentence describing what was seen — the
 * observation is not decoration, it is the difference between a red cross and
 * an operator knowing that the screen recording arrived with its audio muted.
 */
function decide(
  check: RequirementCheck,
  session: Readonly<CaptureSession>,
  markers: Readonly<ObservedMarkerFacts>,
  attestations: ReadonlySet<string>,
  requirementId: string,
): Readonly<{ outcome: RequirementOutcome; observation: string }> {
  switch (check.kind) {
    case 'track-present': {
      const found = tracksWithRole(session, check.role)
      return found.length >= check.minimum
        ? { outcome: 'met', observation: `${found.length} ${check.role} track(s) present` }
        : { outcome: 'unmet', observation: `expected at least ${check.minimum} ${check.role} track(s), found ${found.length}` }
    }
    case 'track-carries-sync-audio': {
      const found = tracksWithRole(session, check.role)
      if (found.length === 0) {
        return { outcome: 'unmet', observation: `no ${check.role} track to carry sync audio` }
      }
      // 'none' is the recorder saying it captured no usable audio at all;
      // anything else can at least be correlated against.
      const usable = found.filter((track) => track.syncAudioPolicy !== 'none')
      return usable.length > 0
        ? { outcome: 'met', observation: `${check.role} audio is usable for sync (${usable[0]!.syncAudioPolicy})` }
        : { outcome: 'unmet', observation: `every ${check.role} track declares syncAudioPolicy 'none'` }
    }
    case 'track-excluded-from-mix': {
      const found = tracksWithRole(session, check.role)
      if (found.length === 0) {
        return { outcome: 'unmet', observation: `no ${check.role} track present` }
      }
      const leaking = found.filter((track) => track.includeInFinalMix)
      return leaking.length === 0
        ? { outcome: 'met', observation: `${check.role} audio is kept out of the delivered mix` }
        : { outcome: 'unmet', observation: `${leaking.length} ${check.role} track(s) would reach the delivered mix` }
    }
    case 'single-continuous-recording': {
      const found = tracksWithRole(session, check.role)
      if (found.length === 0) {
        return { outcome: 'unmet', observation: `no ${check.role} track present` }
      }
      const split = found.filter((track) => track.parts.length > 1)
      return split.length === 0
        ? { outcome: 'met', observation: `${check.role} recorded in one continuous file` }
        : {
          outcome: 'unmet',
          observation: `${check.role} is split across ${split[0]!.parts.length} files; the recorder stopped mid-session`,
        }
    }
    case 'marker-observed': {
      // The detector's answer, not the request's. A caller cannot assert a
      // marker into existence.
      return markers.confirmedPositions.includes(check.position)
        ? { outcome: 'met', observation: `a marker was detected at the ${check.position} of the session` }
        : { outcome: 'unmet', observation: `no marker was detected at the ${check.position} of the session` }
    }
    case 'distinct-devices': {
      const devices = new Set(session.tracks.map((track) => track.device.deviceId))
      return devices.size >= check.minimum
        ? { outcome: 'met', observation: `${devices.size} distinct recording devices` }
        : { outcome: 'unmet', observation: `expected at least ${check.minimum} distinct devices, found ${devices.size}` }
    }
    case 'operator-attestation': {
      return attestations.has(requirementId)
        ? { outcome: 'attested', observation: 'stated by the operator; nothing in the media can confirm it' }
        : { outcome: 'attestation-missing', observation: 'the operator did not state this either way' }
    }
  }
}

/**
 * The ceiling that follows from what is missing.
 *
 * Ordered from worst outcome down, so the first thing that applies wins. A
 * session that lost both marker correlation and audio fingerprinting has no
 * automatic path at all, and saying "manual anchors required" would be
 * optimistic rather than merely cautious.
 */
/** The capabilities that can align two recordings without a human. */
const AUTOMATIC_CAPABILITIES: readonly SyncCapability[] = Object.freeze([
  'shared-clock',
  'audio-fingerprint',
  'marker-correlation',
])

function ceilingFor(
  protocol: Readonly<CaptureProtocol>,
  lost: ReadonlySet<SyncCapability>,
  unmetRequired: number,
): SyncCeiling {
  // Relative to the protocol, not absolute. A first draft demanded that
  // shared-clock be among the lost capabilities before declaring a session
  // unsynchronizable — but a teacher's camera and a screen recorder never
  // shared a clock to begin with, so no requirement protects it and it could
  // never appear as lost. The question is whether every automatic route *this
  // protocol secures* is gone.
  const securedAutomatic = AUTOMATIC_CAPABILITIES.filter((capability) =>
    protocol.requirements.some((requirement) => requirement.losesCapabilities.includes(capability)))
  const noAutomaticPath = securedAutomatic.length > 0
    && securedAutomatic.every((capability) => lost.has(capability))
  if (noAutomaticPath) return 'not-synchronizable'
  if (unmetRequired > 0) return 'manual-anchors-required'
  if (lost.size > 0) return 'automatic-with-review'
  return protocol.bestCeiling
}

export function evaluateCaptureProtocol(input: {
  workspaceId: string
  protocol: Readonly<CaptureProtocol>
  session: Readonly<CaptureSession>
  markers?: Readonly<ObservedMarkerFacts>
  /** Requirement ids the operator affirmed. Only consulted for attestations. */
  attestedRequirementIds?: readonly string[]
  evaluatedAt: string
}): Readonly<CaptureProtocolEvaluation> {
  assertDomain(
    input.session.workspaceId === input.workspaceId,
    'INVALID_ARGUMENT',
    'a protocol evaluation must judge a session from its own workspace',
  )
  const markers = input.markers ?? Object.freeze({ confirmedPositions: Object.freeze([]) })
  const attestations = new Set(input.attestedRequirementIds ?? [])

  // An attestation for a requirement the protocol observes would let a human
  // statement quietly override a measurement.
  for (const id of attestations) {
    const requirement = input.protocol.requirements.find((entry) => entry.requirementId === id)
    assertDomain(
      requirement !== undefined,
      'INVALID_ARGUMENT',
      `attested requirement ${id} is not part of protocol ${input.protocol.protocolId}`,
    )
    assertDomain(
      requirement!.check.kind === 'operator-attestation',
      'INVALID_ARGUMENT',
      `requirement ${id} is observed from the session and cannot be attested`,
    )
  }

  const findings: RequirementFinding[] = []
  const lost = new Set<SyncCapability>()
  let unmetRequired = 0

  for (const requirement of input.protocol.requirements) {
    const decision = decide(requirement.check, input.session, markers, attestations, requirement.requirementId)
    // A missing attestation on a required item is as blocking as an unmet
    // observation: nobody has said the thing is true, and the media cannot.
    const counts = decision.outcome === 'unmet' || decision.outcome === 'attestation-missing'
    if (counts) {
      for (const capability of requirement.losesCapabilities) lost.add(capability)
      if (requirement.level === 'required') unmetRequired += 1
    }
    findings.push(Object.freeze({
      requirementId: requirement.requirementId,
      level: requirement.level,
      outcome: decision.outcome,
      observation: decision.observation,
      losesCapabilities: Object.freeze([...requirement.losesCapabilities]),
      consequence: requirement.consequence,
    }))
  }

  const ceiling = ceilingFor(input.protocol, lost, unmetRequired)
  const body = {
    schemaVersion: CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION,
    workspaceId: input.workspaceId,
    sessionId: input.session.sessionId,
    sessionVersion: input.session.version,
    sessionHash: input.session.sessionHash,
    protocolId: input.protocol.protocolId,
    protocolVersion: input.protocol.version,
    protocolHash: input.protocol.protocolHash,
    findings: Object.freeze(findings),
    lostCapabilities: Object.freeze([...lost].sort()),
    ceiling,
    blocksAutoEdit: ceiling === 'manual-anchors-required' || ceiling === 'not-synchronizable',
    attestedRequirementIds: Object.freeze(
      findings.filter((finding) => finding.outcome === 'attested').map((finding) => finding.requirementId),
    ),
    evaluatedAt: input.evaluatedAt,
  }
  return Object.freeze({ ...body, evaluationHash: calculateCanonicalHash(body) })
}

export function assertCaptureProtocolEvaluationIntegrity(
  evaluation: Readonly<CaptureProtocolEvaluation>,
): Readonly<CaptureProtocolEvaluation> {
  assertDomain(
    evaluation.schemaVersion === CAPTURE_PROTOCOL_EVALUATION_SCHEMA_VERSION,
    'PERSISTENCE_CONFLICT',
    'stored protocol evaluation schema is invalid',
  )
  const { evaluationHash, ...body } = evaluation
  assertDomain(
    calculateCanonicalHash(body) === evaluationHash,
    'PERSISTENCE_CONFLICT',
    'stored protocol evaluation hash does not match its body',
  )
  return evaluation
}

/** Requirements an operator still has to act on, worst first. */
export function outstandingRequirements(
  evaluation: Readonly<CaptureProtocolEvaluation>,
): readonly Readonly<RequirementFinding>[] {
  return Object.freeze(evaluation.findings
    .filter((finding) => finding.outcome === 'unmet' || finding.outcome === 'attestation-missing')
    .sort((left, right) => (left.level === right.level ? 0 : left.level === 'required' ? -1 : 1)))
}

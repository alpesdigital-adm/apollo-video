import type {
  CaptureProtocol,
  CaptureRequirement,
  ExpectedTrack,
} from '../domain/capture-protocol.ts'
import type { CaptureProtocolEvaluation, RequirementFinding } from '../domain/capture-protocol-evaluation.ts'
import { CAPTURE_SCENARIOS, type CaptureScenario } from '../domain/capture-protocol.ts'
import { DomainError } from '../domain/errors.ts'

/**
 * The public boundary for capture protocols (F4.009, FR-147).
 *
 * Protocols are published, versioned documents: the API hands them out and
 * accepts a reference to one, never a definition of one. A caller that could
 * post its own requirement list could also post an empty one and be told the
 * session complies — which is why `attach` takes a `protocolId` and nothing
 * else about the protocol's content.
 *
 * Attestation is the single field a caller is allowed to assert, and it is
 * carried separately from observation. An `attested` requirement is one no
 * machine can check (a person confirms the camera never stopped); an
 * `observed` one is derived from the session. Presenting them under one word
 * would let a claim be mistaken for a measurement.
 */

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactFields(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200) {
    throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  }
  return value.trim()
}

function identifierList(value: unknown, field: string, maximum: number): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([])
  if (!Array.isArray(value) || value.length > maximum) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an array of at most ${maximum} ids`)
  }
  const ids = value.map((entry, index) => identifier(entry, `${field}[${index}]`))
  if (new Set(ids).size !== ids.length) {
    throw new DomainError('INVALID_ARGUMENT', `${field} repeats an id`)
  }
  return Object.freeze(ids)
}

function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be a sha256 digest`)
  }
  return value
}

export function parseBaseVersionBody(raw: unknown): Readonly<{ baseVersionId: string; baseHash: string }> {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash'], 'body')
  return Object.freeze({
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
  })
}

export function parseCaptureScenario(value: unknown, field: string): CaptureScenario {
  if (typeof value !== 'string' || !(CAPTURE_SCENARIOS as readonly string[]).includes(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be one of ${CAPTURE_SCENARIOS.join(', ')}`)
  }
  return value as CaptureScenario
}

export function parseAttachCaptureProtocolBody(raw: unknown): Readonly<{ protocolId: string }> {
  const body = record(raw, 'body')
  exactFields(body, ['protocolId'], 'body')
  return Object.freeze({ protocolId: identifier(body.protocolId, 'protocolId') })
}

export function parseEvaluateCaptureProtocolBody(raw: unknown): Readonly<{
  baseVersionId: string
  baseHash: string
  protocolId?: string
  scenario?: CaptureScenario
  attestedRequirementIds: readonly string[]
}> {
  const body = record(raw, 'body')
  exactFields(body, ['baseVersionId', 'baseHash', 'protocolId', 'scenario', 'attestedRequirementIds'], 'body')
  if (body.protocolId !== undefined && body.scenario !== undefined) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Name either protocolId or scenario, not both: two ways to choose a protocol can disagree',
    )
  }
  return Object.freeze({
    // The version AND its hash: a version number alone can be reused after a
    // failed write, so a verdict naming only "version 3" could be describing a
    // different version 3 than the caller actually read.
    baseVersionId: identifier(body.baseVersionId, 'baseVersionId'),
    baseHash: sha256(body.baseHash, 'baseHash'),
    protocolId: body.protocolId === undefined ? undefined : identifier(body.protocolId, 'protocolId'),
    scenario: body.scenario === undefined ? undefined : parseCaptureScenario(body.scenario, 'scenario'),
    // Attestations are claims by the caller, and they are labelled as such all
    // the way through: the evaluation records which ids were attested so a
    // later reader can tell a human's word from a measurement.
    attestedRequirementIds: identifierList(body.attestedRequirementIds, 'attestedRequirementIds', 64),
  })
}

function presentRequirement(requirement: Readonly<CaptureRequirement>) {
  return Object.freeze({
    requirementId: requirement.requirementId,
    level: requirement.level,
    verification: requirement.verification,
    checkKind: requirement.check.kind,
    statement: requirement.statement,
    losesCapabilities: requirement.losesCapabilities,
    consequence: requirement.consequence,
  })
}

function presentExpectedTrack(track: Readonly<ExpectedTrack>) {
  return Object.freeze({
    role: track.role,
    minimum: track.minimum,
    maximum: track.maximum,
    mustCarryAudio: track.mustCarryAudio,
    note: track.note,
  })
}

export function presentCaptureProtocolSummary(protocol: Readonly<CaptureProtocol>) {
  return Object.freeze({
    protocolId: protocol.protocolId,
    scenario: protocol.scenario,
    version: protocol.version,
    title: protocol.title,
    summary: protocol.summary,
    bestCeiling: protocol.bestCeiling,
    requirementCount: protocol.requirements.length,
    publishedAt: protocol.publishedAt,
    protocolHash: protocol.protocolHash,
  })
}

export function presentCaptureProtocol(protocol: Readonly<CaptureProtocol>) {
  return Object.freeze({
    ...presentCaptureProtocolSummary(protocol),
    schemaVersion: protocol.schemaVersion,
    requirements: protocol.requirements.map(presentRequirement),
    expectedTracks: protocol.expectedTracks.map(presentExpectedTrack),
  })
}

function presentFinding(finding: Readonly<RequirementFinding>) {
  return Object.freeze({
    requirementId: finding.requirementId,
    level: finding.level,
    outcome: finding.outcome,
    observation: finding.observation,
    losesCapabilities: finding.losesCapabilities,
    consequence: finding.consequence,
  })
}

export function presentCaptureProtocolEvaluation(evaluation: Readonly<CaptureProtocolEvaluation>) {
  return Object.freeze({
    schemaVersion: evaluation.schemaVersion,
    sessionId: evaluation.sessionId,
    sessionVersion: evaluation.sessionVersion,
    sessionHash: evaluation.sessionHash,
    protocolId: evaluation.protocolId,
    protocolVersion: evaluation.protocolVersion,
    protocolHash: evaluation.protocolHash,
    findings: evaluation.findings.map(presentFinding),
    lostCapabilities: evaluation.lostCapabilities,
    ceiling: evaluation.ceiling,
    blocksAutoEdit: evaluation.blocksAutoEdit,
    attestedRequirementIds: evaluation.attestedRequirementIds,
    evaluatedAt: evaluation.evaluatedAt,
    evaluationHash: evaluation.evaluationHash,
  })
}

export function presentCaptureSessionProtocol(input: {
  attachment: Readonly<{
    protocolId: string
    protocolVersion: number
    protocolHash: string
    attachedAt: string
  }> | null
  protocol: Readonly<CaptureProtocol> | null
  evaluation: Readonly<CaptureProtocolEvaluation> | null
  sessionVersion: number
  evaluationIsForCurrentVersion: boolean
}) {
  return Object.freeze({
    sessionVersion: input.sessionVersion,
    attachment: input.attachment === null ? null : Object.freeze({
      protocolId: input.attachment.protocolId,
      protocolVersion: input.attachment.protocolVersion,
      protocolHash: input.attachment.protocolHash,
      attachedAt: input.attachment.attachedAt,
    }),
    protocol: input.protocol === null ? null : presentCaptureProtocol(input.protocol),
    evaluation: input.evaluation === null ? null : presentCaptureProtocolEvaluation(input.evaluation),
    // An evaluation made against an earlier session version is not wrong, it
    // is stale — and the difference matters enough to say out loud rather than
    // leaving a client to compare two version numbers and guess.
    evaluationIsForCurrentVersion: input.evaluationIsForCurrentVersion,
  })
}

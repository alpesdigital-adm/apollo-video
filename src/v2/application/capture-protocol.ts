import type { CaptureProtocol, CaptureScenario } from '../domain/capture-protocol.ts'
import {
  currentProtocolForScenario,
  findCaptureProtocol,
  PUBLISHED_CAPTURE_PROTOCOLS,
} from '../domain/capture-protocol-catalog.ts'
import {
  evaluateCaptureProtocol,
  type CaptureProtocolEvaluation,
  type ObservedMarkerFacts,
} from '../domain/capture-protocol-evaluation.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  AttachedCaptureProtocol,
  CaptureProtocolRepository,
} from './ports/capture-protocol-repository.ts'
import type { CaptureSessionRepository } from './ports/capture-session-repository.ts'

/**
 * Capture protocol commands and queries (F4.009 / FR-147).
 *
 * The evaluation service reads the session from the repository rather than
 * accepting one from the caller, and takes marker facts from the detector
 * rather than from the request. Both are the same rule: the thing being judged
 * and the evidence judging it must come from the system, not from whoever
 * wants a particular verdict.
 */

export interface CaptureProtocolActor {
  readonly workspaceId: string
  readonly kind: AttachedCaptureProtocol['attachedByKind']
  readonly id: string
}

/**
 * Publish the four canonical protocols.
 *
 * Idempotent: the catalogue is content-addressed, so seeding it twice is a
 * replay. Running this against a database whose stored v1 differs from the
 * code's v1 is a conflict rather than an update — a stored evaluation naming
 * v1 must keep meaning what it meant.
 */
export function publishCaptureProtocolsService(dependencies: {
  repository: CaptureProtocolRepository
  clock: () => Date
}) {
  return async (): Promise<Readonly<{ published: number; replayed: number }>> => {
    const now = dependencies.clock().toISOString()
    let published = 0
    let replayed = 0
    for (const protocol of PUBLISHED_CAPTURE_PROTOCOLS) {
      const result = await dependencies.repository.publish({ protocol, createdAt: now })
      if (result.replayed) replayed += 1
      else published += 1
    }
    return Object.freeze({ published, replayed })
  }
}

export function listCaptureProtocolsService(dependencies: { repository: CaptureProtocolRepository }) {
  return async (): Promise<readonly Readonly<CaptureProtocol>[]> => {
    const stored = await dependencies.repository.list()
    // Falling back to the code's catalogue keeps the pre-recording screen
    // useful on a workspace whose seed has not run: an operator about to shoot
    // needs the requirements now, and they are the same document either way.
    return stored.length > 0 ? stored : PUBLISHED_CAPTURE_PROTOCOLS
  }
}

export function attachCaptureProtocolService(dependencies: {
  repository: CaptureProtocolRepository
  sessions: CaptureSessionRepository
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureProtocolActor
    sessionId: string
    protocolId: string
  }): Promise<Readonly<AttachedCaptureProtocol>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }
    const stored = await dependencies.repository.read({ protocolId: input.protocolId })
    const protocol = stored ?? findCaptureProtocol(input.protocolId)
    // No expectedVersion and no version fence, deliberately. Attaching a
    // protocol says what the shoot was meant to be; it does not change what
    // was recorded, so it must not append a session version or invalidate a
    // derivation. Everything downstream keys off the session version, which is
    // untouched here.
    return dependencies.repository.attach({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      protocol,
      attachedByKind: input.actor.kind,
      attachedById: input.actor.id,
      attachedAt: dependencies.clock().toISOString(),
    })
  }
}

/**
 * Judge a session against its protocol.
 *
 * `markers` come from F4.010's detection results, never from the request. A
 * caller that could assert markers would be able to talk the ceiling up to
 * `automatic` on a session where nothing was ever detected.
 */
export function evaluateCaptureProtocolService(dependencies: {
  repository: CaptureProtocolRepository
  sessions: CaptureSessionRepository
  observeMarkers: (input: {
    workspaceId: string
    sessionId: string
    sessionVersion: number
  }) => Promise<Readonly<ObservedMarkerFacts>>
  clock: () => Date
}) {
  return async (input: {
    actor: CaptureProtocolActor
    sessionId: string
    protocolId?: string
    scenario?: CaptureScenario
    attestedRequirementIds?: readonly string[]
  }): Promise<Readonly<{ evaluation: Readonly<CaptureProtocolEvaluation>; replayed: boolean }>> => {
    const session = await dependencies.sessions.readHead({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }

    const attachment = await dependencies.repository.readAttachment({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
    })
    const protocol = input.protocolId
      ? (await dependencies.repository.read({ protocolId: input.protocolId }) ?? findCaptureProtocol(input.protocolId))
      : input.scenario
        ? currentProtocolForScenario(input.scenario)
        : attachment
          ? (await dependencies.repository.read({
            protocolId: attachment.protocolId,
            version: attachment.protocolVersion,
          }) ?? findCaptureProtocol(attachment.protocolId))
          : null

    if (!protocol) {
      throw new DomainError(
        'CAPTURE_PROTOCOL_NOT_FOUND',
        `Capture session ${input.sessionId} has no attached protocol; name one to evaluate against`,
      )
    }

    const markers = await dependencies.observeMarkers({
      workspaceId: input.actor.workspaceId,
      sessionId: input.sessionId,
      sessionVersion: session.version,
    })
    const evaluation = evaluateCaptureProtocol({
      workspaceId: input.actor.workspaceId,
      protocol,
      session,
      markers,
      attestedRequirementIds: input.attestedRequirementIds,
      evaluatedAt: dependencies.clock().toISOString(),
    })
    return dependencies.repository.persistEvaluation({
      evaluation,
      createdAt: dependencies.clock().toISOString(),
    })
  }
}

/**
 * The protocol and current evaluation of a session.
 *
 * The evaluation is looked up for the session's *current* version. An
 * evaluation of an earlier version is not returned as a fallback: it judged a
 * different set of tracks, and showing it beside today's session is how a
 * stale verdict gets acted on.
 */
export function readCaptureSessionProtocolService(dependencies: {
  repository: CaptureProtocolRepository
  sessions: CaptureSessionRepository
}) {
  return async (input: { workspaceId: string; sessionId: string }): Promise<Readonly<{
    attachment: Readonly<AttachedCaptureProtocol> | null
    protocol: Readonly<CaptureProtocol> | null
    evaluation: Readonly<CaptureProtocolEvaluation> | null
    sessionVersion: number
    evaluationIsForCurrentVersion: boolean
  }>> => {
    const session = await dependencies.sessions.readHead(input)
    if (!session) {
      throw new DomainError(
        'CAPTURE_SESSION_NOT_FOUND',
        `Capture session ${input.sessionId} does not exist`,
      )
    }
    const attachment = await dependencies.repository.readAttachment(input)
    if (!attachment) {
      return Object.freeze({
        attachment: null,
        protocol: null,
        evaluation: null,
        sessionVersion: session.version,
        evaluationIsForCurrentVersion: false,
      })
    }
    const protocol = await dependencies.repository.read({
      protocolId: attachment.protocolId,
      version: attachment.protocolVersion,
    }) ?? findCaptureProtocol(attachment.protocolId)
    const evaluation = await dependencies.repository.readEvaluation({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sessionVersion: session.version,
      protocolId: attachment.protocolId,
      protocolVersion: attachment.protocolVersion,
    })
    return Object.freeze({
      attachment,
      protocol,
      evaluation,
      sessionVersion: session.version,
      evaluationIsForCurrentVersion: evaluation !== null,
    })
  }
}

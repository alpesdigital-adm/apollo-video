import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import type { CommandImpactOutputReference } from '../domain/command-impact.ts'
import { type CommandActor, createEditCommand, type EditCommand } from '../domain/edit-command.ts'
import { assertDomain } from '../domain/errors.ts'
import { assertMulticamDirectionIntegrity, type MulticamDirection } from '../domain/multicam-direction.ts'
import {
  createMulticamDirectionImpact,
  type MulticamDirectionImpactV1,
} from '../domain/multicam-direction-impact.ts'

/**
 * The `direct-multicam-session` EditCommand (F4.012, spec 02 §24.1).
 *
 * This module is the Command half only: it turns a direction that already
 * exists into the Command and impact document that bind it to a project
 * version. Persisting the direction, fencing the session and writing the new
 * project version are the service's work and arrive with the repositories;
 * what exists here is what the registry gate requires — one call site with a
 * literal type, producing an impact its declared parser accepts.
 *
 * Nothing here decides anything. The caller supplies ids and a direction that
 * was derived on the server from stored projections; the shot count, the
 * review flag and every hash come off the direction itself, and the direction
 * is re-verified before any of them are read.
 */

export interface DirectMulticamSessionPayload {
  readonly schemaVersion: 1
  readonly sessionId: string
  readonly sessionVersion: number
  readonly directionHash: string
  readonly diagnosticVersion: number
  readonly diagnosticHash: string
  readonly evidenceHash: string
  readonly shotCount: number
  readonly manualReviewRequired: boolean
  readonly impact: Readonly<MulticamDirectionImpactV1>
}

export interface DirectMulticamSessionInput {
  readonly commandId: string
  readonly workspaceId: string
  readonly projectId: string
  readonly baseVersionId: string
  readonly baseHash: string
  readonly resultVersionId: string
  readonly author: Readonly<CommandActor>
  readonly direction: Readonly<MulticamDirection>
  /** Frames of the timeline the direction is applied to. */
  readonly durationFrames: number
  readonly outputReferences: readonly Readonly<CommandImpactOutputReference>[]
  readonly idempotencyKey: string
  readonly reason?: string
  readonly createdAt: string
}

export interface DirectMulticamSessionResult {
  readonly command: Readonly<EditCommand<DirectMulticamSessionPayload>>
  readonly impact: Readonly<MulticamDirectionImpactV1>
  /** The base hash of the version this Command would produce. */
  readonly resultBaseHash: string
}

export function buildDirectMulticamSessionCommand(
  input: Readonly<DirectMulticamSessionInput>,
): Readonly<DirectMulticamSessionResult> {
  // Re-verified, not trusted: every hash below is copied out of this object,
  // and a direction whose body no longer matches its hash would put those
  // copies into a Command that outlives it.
  const direction = assertMulticamDirectionIntegrity(input.direction)
  assertDomain(
    direction.workspaceId === input.workspaceId,
    'INVALID_ARGUMENT',
    'the direction belongs to another workspace',
  )
  const impact = createMulticamDirectionImpact({
    commandId: input.commandId,
    baseVersionId: input.baseVersionId,
    resultVersionId: input.resultVersionId,
    sessionId: direction.sessionId,
    sessionVersion: direction.sessionVersion,
    directionHash: direction.directionHash,
    diagnosticHash: direction.diagnosticHash,
    evidenceHash: direction.evidenceHash,
    shotCount: direction.shots.length,
    manualReviewRequired: direction.manualReviewRequired,
    durationFrames: input.durationFrames,
    outputReferences: input.outputReferences,
  })
  const payload: DirectMulticamSessionPayload = Object.freeze({
    schemaVersion: 1 as const,
    sessionId: direction.sessionId,
    sessionVersion: direction.sessionVersion,
    directionHash: direction.directionHash,
    diagnosticVersion: direction.diagnosticVersion,
    diagnosticHash: direction.diagnosticHash,
    evidenceHash: direction.evidenceHash,
    shotCount: direction.shots.length,
    manualReviewRequired: direction.manualReviewRequired,
    impact,
  })
  const command = createEditCommand<DirectMulticamSessionPayload>({
    id: input.commandId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    baseHash: input.baseHash,
    author: input.author,
    type: 'direct-multicam-session',
    scope: { project: true },
    payload,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    idempotencyKey: input.idempotencyKey,
    createdAt: input.createdAt,
  })
  const resultBaseHash = calculateCanonicalHash({
    schemaVersion: 'project-version-multicam-direction/v1',
    previousBaseHash: input.baseHash,
    commandId: input.commandId,
    directionHash: direction.directionHash,
    impactHash: impact.impactHash,
  })
  return Object.freeze({ command, impact, resultBaseHash })
}

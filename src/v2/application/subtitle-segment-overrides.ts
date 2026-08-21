import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createSubtitleSegmentOverrideCommandImpact } from '../domain/command-impact.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import {
  createSubtitleSegmentOverride,
  normalizeSubtitleSegmentOverrideDimensions,
  resolveSubtitleSegmentOverrideResetTarget,
  type SubtitleSegmentOverrideAction,
  type SubtitleSegmentOverrideDimension,
} from '../domain/subtitle-segment-override.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { SubtitleSegmentOverrideRepository } from './ports/subtitle-segment-override-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const id = (value: unknown, field: string) => {
  const parsed = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(parsed)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return parsed
}

/**
 * F1.037 / FR-174 — the single application service behind both the public `/v1`
 * route and the editor panel. Everything the UI can do to a subtitle exception it
 * does through this function, so the API is never a thinner or fatter version of
 * the product.
 *
 * The write path is fail-closed on scope. An override may only be created against
 * the variant and the exact half-open range the CURRENT EditPlan compiles for that
 * segment: a divergent variant or range is rejected here (`INVALID_ARGUMENT`)
 * instead of being widened into something global. The read path in
 * `applySubtitleSegmentOverrides` answers the same divergence with a recorded
 * no-op, because by then the EditPlan may legitimately have moved under a document
 * that was valid when it was written.
 */
export function applySubtitleSegmentOverrideService(dependencies: {
  repository: SubtitleSegmentOverrideRepository
  createId: (kind: 'command' | 'version' | 'override') => string
  clock?: () => Date
}) {
  return async (request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    variantId: string
    segmentId: string
    action?: SubtitleSegmentOverrideAction
    dimensions?: readonly unknown[]
    protected?: boolean
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    reason?: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId')
    const variantId = id(request.variantId, 'variantId')
    const segmentId = id(request.segmentId, 'segmentId')
    if (!/^[a-f0-9]{64}$/.test(request.baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    const action: SubtitleSegmentOverrideAction = request.action ?? 'set'
    if (action !== 'set' && action !== 'reset') throw new DomainError('INVALID_ARGUMENT', 'action is invalid')
    if (action === 'set' && (!Array.isArray(request.dimensions) || request.dimensions.length === 0)) {
      throw new DomainError('INVALID_ARGUMENT', 'A set action requires at least one subtitle dimension')
    }
    if (action === 'reset' && request.dimensions !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', 'A reset action cannot carry subtitle dimensions')
    }
    if (action === 'reset' && request.protected !== undefined) {
      throw new DomainError('INVALID_ARGUMENT', 'A reset action cannot carry a protection flag')
    }

    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== workspaceId) {
      throw new DomainError('AUTH_INVALID', 'Subtitle segment override actor does not match workspace')
    }
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    }

    // Normalized before fingerprinting so two spellings of the same exception replay
    // as the same request instead of colliding as a payload mismatch.
    const requestedDimensions: readonly SubtitleSegmentOverrideDimension[] = action === 'set'
      ? normalizeSubtitleSegmentOverrideDimensions(request.dimensions ?? [])
      : []
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'apply-subtitle-segment-override-request/v1',
      workspaceId, projectId, baseVersionId, baseHash: request.baseHash, variantId, segmentId,
      action,
      dimensions: requestedDimensions,
      protected: action === 'set' ? request.protected === true : null,
      reason: request.reason?.trim() ?? null,
      actorContextHash: audit.contextHash,
    })

    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another subtitle segment override')
      }
      return replay.result
    }

    const context = await dependencies.repository.readContext({ workspaceId, projectId, variantId, segmentId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Subtitle segment override context was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Subtitle segment override base version is stale')
    }
    // Fail-closed scope, both halves. A variant the EditPlan does not compile and a
    // segment that does not exist in it are refused; neither is ever reinterpreted
    // as "apply everywhere".
    if (!context.variantIds.includes(variantId)) {
      throw new DomainError('INVALID_ARGUMENT', 'Subtitle segment override names a variant this project version does not compile')
    }
    const segment = context.segments.find((item) => item.id === segmentId)
    if (!segment) {
      throw new DomainError('INVALID_ARGUMENT', 'Subtitle segment override names a segment this variant does not compile')
    }
    if (action === 'reset' && !context.currentOverride) {
      throw new DomainError('INVALID_ARGUMENT', 'There is no subtitle segment override to reset on this segment')
    }

    const target = action === 'reset'
      ? resolveSubtitleSegmentOverrideResetTarget({ current: context.currentOverride, previous: context.previousOverride })
      : { dimensions: requestedDimensions, protected: request.protected === true }

    const createdAt = (dependencies.clock ?? (() => new Date()))().toISOString()
    const commandId = id(dependencies.createId('command'), 'commandId')
    const versionId = id(dependencies.createId('version'), 'versionId')
    // The range is taken from the compiled segment, never from the caller: an
    // exception cannot claim frames the EditPlan does not give that segment.
    const range = Object.freeze({ startFrame: segment.startFrame, endFrame: segment.endFrame })

    const subtitleOverride = createSubtitleSegmentOverride({
      id: id(dependencies.createId('override'), 'overrideId'),
      workspaceId, projectId, baseVersionId, resultVersionId: versionId, commandId,
      variantId, segmentId, range,
      action,
      dimensions: target.dimensions,
      protected: target.protected,
      previousOverrideId: context.currentOverride?.id ?? null,
      createdAt,
    })
    const impact = createSubtitleSegmentOverrideCommandImpact({
      commandId, baseVersionId, resultVersionId: versionId, variantId, segmentId,
      range,
      dimensionKinds: subtitleOverride.dimensions.map((dimension) => dimension.kind),
      durationFrames: context.durationFrames,
      outputReferences: context.outputReferences,
    })
    const author: Readonly<CommandActor> = Object.freeze({
      type: 'api-client',
      id: audit.clientId,
      ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}),
    })
    const command = createEditCommand({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash, author,
      type: 'apply-subtitle-segment-override',
      // The scope names the variant and the frames, so an operator auditing the log
      // sees the blast radius without opening the impact.
      scope: { outputSpecIds: [variantId], frameRange: { startFrame: range.startFrame, endFrame: range.endFrame } },
      payload: Object.freeze({
        schemaVersion: 1 as const,
        variantId, segmentId, range,
        action,
        dimensions: subtitleOverride.dimensions,
        protected: subtitleOverride.protected,
        impact,
      }),
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey, createdAt,
    })
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId,
      sequence: context.currentVersion.sequence + 1,
      parentVersionId: baseVersionId,
      snapshotRefs: context.currentVersion.snapshotRefs,
      baseHash: calculateCanonicalHash({
        schemaVersion: 'project-version-subtitle-segment-override/v1',
        previousBaseHash: request.baseHash,
        commandId,
        overrideHash: subtitleOverride.overrideHash,
        impactHash: impact.impactHash,
      }),
      createdBy: audit.clientId, commandId, createdAt,
    })
    return dependencies.repository.commitOrReplay({
      requestFingerprint, authenticationAudit: audit, command, version, subtitleOverride, impact,
    })
  }
}

export function readSubtitleSegmentOverrideService(dependencies: {
  repository: SubtitleSegmentOverrideRepository
}) {
  return (input: { workspaceId: string; projectId: string; variantId: string; segmentId: string }) =>
    dependencies.repository.readCurrent({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      projectId: id(input.projectId, 'projectId'),
      variantId: id(input.variantId, 'variantId'),
      segmentId: id(input.segmentId, 'segmentId'),
    })
}

/** Every head exception of one variant — the list the compiler applies. */
export function listSubtitleSegmentOverridesService(dependencies: {
  repository: SubtitleSegmentOverrideRepository
}) {
  return (input: { workspaceId: string; projectId: string; variantId: string }) =>
    dependencies.repository.listCurrentByVariant({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      projectId: id(input.projectId, 'projectId'),
      variantId: id(input.variantId, 'variantId'),
    })
}

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { createVariantReframeOverrideCommandImpact } from '../domain/command-impact.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import type { NormalizedBounds } from '../domain/output-spec.ts'
import { requireOutputVariant } from '../domain/output-consumption.ts'
import { referencesOfVariant } from '../domain/output-variant-references.ts'
import { reidentifiedEditPlanSnapshot, transitionProjectOutputState } from '../domain/project-output-state-transition.ts'
import {
  assertReframeOverrideDoesNotOverlap, createVariantReframeOverride, type VariantReframeOverrideAction, type VariantReframeOverrideV2,
} from '../domain/variant-reframe-overrides.ts'
import { assembleVariantReframePlanRecord, reframeClipMapHash, reframeOverrideHidesSubject } from '../domain/variant-reframe-plan.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'
import type { VariantReframeOverrideRepository } from './ports/variant-reframe-override-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const id = (value: unknown, field: string) => {
  const parsed = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(parsed)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return parsed
}

/**
 * W66r — the single application service behind both the public `/v1` route and the editor: a manual reframe of ONE half-open range of
 * ONE clip of ONE output variant (`set`), or the return of that exact range to the automatic level (`reset`).
 *
 * Precedence is manual over automatic, and only there: the Command stores the editor's crop and re-decides the variant's plan over the
 * SAME observations the base plan was decided from, so the raw evidence and the server's own plan are byte-identical after it (only the
 * final plan and the render ranges change). The result Version carries that plan for the target variant and, unchanged, the plan of every
 * other output, so nothing outside the variant and the range goes stale. It is fail-closed on scope: a variant the State does not carry, a
 * clip the Version does not play, a range outside the clip, a crop that would zoom or that hides a subject the server is sure of are all
 * refused here. The base Version is checked twice (here, and by compare-and-swap in the commit).
 */
export function applyVariantReframeOverrideService(dependencies: {
  repository: VariantReframeOverrideRepository
  createId: (kind: 'command' | 'version' | 'override' | 'edit-plan-snapshot' | 'state' | 'materialization') => string
  clock?: () => Date
}) {
  return async (request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    variantId: string
    clipId: string
    startFrame: number
    endFrame: number
    action?: VariantReframeOverrideAction
    crop?: Readonly<NormalizedBounds>
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    reason?: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId')
    const variantId = id(request.variantId, 'variantId')
    const clipId = id(request.clipId, 'clipId')
    if (!/^[a-f0-9]{64}$/.test(request.baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    if (!Number.isSafeInteger(request.startFrame) || !Number.isSafeInteger(request.endFrame) || request.startFrame < 0 || request.endFrame <= request.startFrame) {
      throw new DomainError('INVALID_ARGUMENT', 'The frame range must be a non-empty half-open interval')
    }
    const action: VariantReframeOverrideAction = request.action ?? 'set'
    if (action !== 'set' && action !== 'reset') throw new DomainError('INVALID_ARGUMENT', 'action is invalid')
    if (action === 'set' && !request.crop) throw new DomainError('INVALID_ARGUMENT', 'A set action requires a crop')
    if (action === 'reset' && request.crop !== undefined) throw new DomainError('INVALID_ARGUMENT', 'A reset action cannot carry a crop')

    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    if (audit.workspaceId !== workspaceId) throw new DomainError('AUTH_INVALID', 'Reframe override actor does not match workspace')
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')

    // Normalized before fingerprinting so two spellings of the same crop replay as the same request instead of colliding.
    const requestedCrop = action === 'set' ? Object.freeze({ x: request.crop!.x, y: request.crop!.y, width: request.crop!.width, height: request.crop!.height }) : null
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'apply-variant-reframe-override-request/v1',
      workspaceId, projectId, baseVersionId, baseHash: request.baseHash, variantId, clipId,
      startFrame: request.startFrame, endFrame: request.endFrame, action, crop: requestedCrop,
      reason: request.reason?.trim() ?? null, actorContextHash: audit.contextHash,
    })

    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another variant reframe override')
      }
      return replay.result
    }

    const context = await dependencies.repository.readContext({ workspaceId, projectId, variantId, clipId, startFrame: request.startFrame, endFrame: request.endFrame })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Variant reframe override context was not found')
    const parent = context.parent
    const currentVersion = parent.version
    if (currentVersion.id !== baseVersionId || currentVersion.baseHash !== request.baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Variant reframe override base version is stale')
    }
    // Fail-closed scope: a variant the State of the base Version does not carry (or two outputs of one ratio) is refused, never
    // reinterpreted as "apply to every output". `variantId` is the stable variant of the State.
    const variant = requireOutputVariant(parent.state, variantId)
    if (variant.aspectRatio !== context.plan.spec.aspectRatio) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'The sealed output no longer describes the variant the reframe was read for')
    }
    const clip = context.plan.clips.find((candidate) => candidate.clipId === clipId)
    if (!clip) throw new DomainError('INVALID_ARGUMENT', 'Variant reframe override names a clip this version does not play')
    const base = context.currentPlan
    if (!base) {
      throw new DomainError('PRECONDITION_REQUIRED', 'A reframe plan must be requested for this version and variant before a manual reframe',
        { reason: 'reframe-plan-required' })
    }
    const record = base.record
    if (record.binding.specHash !== context.plan.spec.specHash ||
        record.binding.clipMapHash !== reframeClipMapHash(context.plan.timeline, context.plan.clips.map((entry) => ({
          clipId: entry.clipId, sourceArtifactId: entry.sourceArtifactId, sourceSha256: entry.sourceSha256, sourceWidth: entry.sourceWidth, sourceHeight: entry.sourceHeight,
          sourceInFrame: entry.sourceInFrame, sourceOutFrame: entry.sourceOutFrame, timelineInFrame: entry.timelineInFrame, timelineOutFrame: entry.timelineOutFrame,
          rate: entry.rate, fps: entry.fps })))) {
      throw new DomainError('PRECONDITION_REQUIRED', 'The persisted reframe plan no longer describes this version; request it again',
        { reason: 'reframe-plan-stale' })
    }
    if (action === 'reset' && !context.currentOverride) {
      throw new DomainError('INVALID_ARGUMENT', 'There is no manual reframe on this range to reset')
    }
    if (action === 'set') {
      assertReframeOverrideDoesNotOverlap(context.plan.overrideHeads, { variantId, clipId, startFrame: request.startFrame, endFrame: request.endFrame })
      if (reframeOverrideHidesSubject({
        observationSet: record.observationSet, serverPlan: record.serverPlan, safeArea: context.plan.spec.safeArea,
        crop: request.crop!, startFrame: request.startFrame, endFrame: request.endFrame,
      })) {
        throw new DomainError('INVALID_ARGUMENT', 'The manual crop would hide a subject the server is sure of; reframe it to keep the subject visible',
          { reason: 'HIDES_CRITICAL_SUBJECT' })
      }
    }

    const createdAt = (dependencies.clock ?? (() => new Date()))().toISOString()
    const commandId = id(dependencies.createId('command'), 'commandId')
    const versionId = id(dependencies.createId('version'), 'versionId')
    const editPlanSnapshotId = id(dependencies.createId('edit-plan-snapshot'), 'editPlanSnapshotId')
    const stateId = id(dependencies.createId('state'), 'stateId')
    const range = Object.freeze({ startFrame: request.startFrame, endFrame: request.endFrame })

    const reframeOverride = createVariantReframeOverride({
      id: id(dependencies.createId('override'), 'overrideId'),
      workspaceId, projectId, baseVersionId, resultVersionId: versionId, commandId,
      variantId, aspectRatio: variant.aspectRatio as VariantReframeOverrideV2['aspectRatio'],
      clip: { clipId: clip.clipId, sourceArtifactId: clip.sourceArtifactId, sourceSha256: clip.sourceSha256, sourceWidth: clip.sourceWidth, sourceHeight: clip.sourceHeight,
        sourceInFrame: clip.sourceInFrame, sourceOutFrame: clip.sourceOutFrame, timelineInFrame: clip.timelineInFrame, timelineOutFrame: clip.timelineOutFrame, rate: clip.rate, fps: clip.fps },
      startFrame: range.startFrame, endFrame: range.endFrame, action, ...(action === 'set' ? { crop: request.crop! } : {}),
      previous: context.currentOverride, createdAt,
    })

    // The target variant's plan is decided again over the SAME observations with the heads this Command leaves; the other outputs' plans are
    // the ones they had. Nothing here reads evidence again, so nothing the detector produced can move.
    const heads = [
      ...context.plan.overrideHeads.filter((head) => !(head.variantId === variantId && head.clipId === clipId && head.startFrame === range.startFrame && head.endFrame === range.endFrame)),
      reframeOverride,
    ]
    const targetRecord = assembleVariantReframePlanRecord({
      workspaceId, projectId, variantId, spec: context.plan.spec, timeline: context.plan.timeline, source: context.plan.source, clips: context.plan.clips,
      observationSet: record.observationSet, overrideHeads: heads,
    })
    const plans = Object.freeze([
      Object.freeze({ variantId, record: targetRecord }),
      ...context.siblingPlans.filter((plan) => plan.record.variantId !== variantId).map((plan) => Object.freeze({ variantId: plan.record.variantId, record: plan.record })),
    ])

    const impact = createVariantReframeOverrideCommandImpact({
      commandId, baseVersionId, resultVersionId: versionId, variantId, clipId, action, range,
      durationFrames: context.durationFrames, outputReferences: referencesOfVariant(context.outputReferences, variantId),
    })
    const author: Readonly<CommandActor> = Object.freeze({
      type: 'api-client', id: audit.clientId, ...(audit.delegatedUserId ? { delegatedUserId: audit.delegatedUserId } : {}),
    })
    const command = createEditCommand({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash, author,
      type: 'apply-variant-reframe-override',
      // The scope names the variant and the frames, so an operator auditing the log sees the blast radius without opening the impact.
      scope: { outputVariantIds: [variantId], frameRange: { startFrame: range.startFrame, endFrame: range.endFrame } },
      payload: Object.freeze({
        schemaVersion: 1 as const, variantId, clipId, range, action, crop: reframeOverride.crop, impact,
      }),
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey, createdAt,
    })
    // The override lives in its own domain rows and the plan record in its own table; the EditPlan is the parent's under the new Version's identity.
    const bundle = transitionProjectOutputState({
      parent, command, audit, requestFingerprint,
      allocation: {
        workspaceId, projectId, resultVersionId: versionId, stateId, parentVersionId: currentVersion.id,
        sequence: currentVersion.sequence + 1, createdBy: audit.clientId, createdAt,
      },
      editPlanSnapshot: reidentifiedEditPlanSnapshot(parent, { snapshotId: editPlanSnapshotId, versionId, createdAt }),
      createMaterializationId: () => id(dependencies.createId('materialization'), 'materializationId'),
    })
    return dependencies.repository.commitOrReplay({ bundle, reframeOverride, impact, plans })
  }
}

/** Every head override of one variant — what the plan is decided over. */
export function listVariantReframeOverridesService(dependencies: { repository: VariantReframeOverrideRepository }) {
  return (input: { workspaceId: string; projectId: string; variantId: string }) =>
    dependencies.repository.listCurrentByVariant({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      projectId: id(input.projectId, 'projectId'),
      variantId: id(input.variantId, 'variantId'),
    })
}

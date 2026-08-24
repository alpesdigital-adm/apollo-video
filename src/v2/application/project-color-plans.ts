import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { createColorPlan } from '../domain/color-and-export.ts'
import { createEditCommand, type CommandActor } from '../domain/edit-command.ts'
import { DomainError } from '../domain/errors.ts'
import { createProjectColorPlan } from '../domain/project-color-plan.ts'
import { createProjectColorPlanImpact } from '../domain/project-color-plan-impact.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  ProjectColorPlanRepository,
  SetProjectColorPlanRequest,
} from './ports/project-color-plan-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/

function id(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!ID.test(normalized)) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

type ProjectColorPlanActor = AuthenticatedExternalActor | Readonly<CommandActor>

function commandActor(input: ProjectColorPlanActor, workspaceId: string): Readonly<{
  author: Readonly<CommandActor>
  authenticationAudit?: Readonly<ApiAccessAuditContext>
}> {
  if (input && 'auditContext' in input) {
    requireScope(input, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(input)
    if (authenticationAudit.workspaceId !== workspaceId) {
      throw new DomainError('AUTH_INVALID', 'Project ColorPlan actor does not match the workspace')
    }
    return Object.freeze({
      author: Object.freeze({
        type: 'api-client' as const,
        id: authenticationAudit.clientId,
        ...(authenticationAudit.delegatedUserId
          ? { delegatedUserId: authenticationAudit.delegatedUserId }
          : {}),
      }),
      authenticationAudit,
    })
  }
  if (!input || !['director', 'system'].includes(input.type)) {
    throw new DomainError('AUTH_INVALID', 'Project ColorPlan command actor is not trusted')
  }
  return Object.freeze({
    author: Object.freeze({
      type: input.type,
      id: id(input.id, 'actor.id'),
      ...(input.delegatedUserId
        ? { delegatedUserId: id(input.delegatedUserId, 'actor.delegatedUserId') }
        : {}),
    }),
  })
}

function assertPlanTargets(
  plan: ReturnType<typeof createColorPlan>,
  targets: readonly Readonly<{ sourceId: string; cameraId?: string; segmentId?: string }>[],
): void {
  const values = {
    sources: new Set(targets.map((target) => target.sourceId)),
    cameras: new Set(targets.flatMap((target) => target.cameraId ? [target.cameraId] : [])),
    segments: new Set(targets.flatMap((target) => target.segmentId ? [target.segmentId] : [])),
  }
  for (const kind of ['sources', 'cameras', 'segments'] as const) {
    const unknown = Object.keys(plan[kind]).filter((key) => !values[kind].has(key))
    if (unknown.length > 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        `ColorPlan ${kind} contain targets outside the current EditPlan`,
        { targets: unknown },
      )
    }
  }
  const unknownMetadata = Object.keys(plan.sourceMetadata)
    .filter((key) => !values.sources.has(key))
  if (unknownMetadata.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'ColorPlan sourceMetadata contains sources outside the current EditPlan',
      { targets: unknownMetadata },
    )
  }
}

export function setProjectColorPlanService(dependencies: {
  repository: ProjectColorPlanRepository
  createId: (kind: 'command' | 'version' | 'color-plan') => string
  createEventId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: SetProjectColorPlanRequest & {
    actor: ProjectColorPlanActor
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId')
    const baseHash = request.baseHash?.trim()
    if (!/^[a-f0-9]{64}$/.test(baseHash)) throw new DomainError('INVALID_ARGUMENT', 'baseHash is invalid')
    const idempotencyKey = request.idempotencyKey?.trim()
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new DomainError('INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    }
    const actor = commandActor(request.actor, workspaceId)
    const canonicalPlan = createColorPlan(request.plan)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'set-project-color-plan-request/v1',
      workspaceId,
      projectId,
      baseVersionId,
      baseHash,
      colorPlanHash: canonicalPlan.planHash,
      reason: request.reason?.trim() ?? null,
      actorIdentity: actor.authenticationAudit
        ? { kind: 'external', contextHash: actor.authenticationAudit.contextHash }
        : { kind: 'internal', actor: actor.author },
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another project ColorPlan')
      }
      return replay.result
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project ColorPlan context was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== baseHash) {
      throw new DomainError('VERSION_CONFLICT', 'Project ColorPlan base version is stale')
    }
    assertPlanTargets(canonicalPlan, context.targets)
    const sourceIds = [...new Set(context.targets.map((target) => target.sourceId))].sort()
    const trustedSourceIds = Object.keys(context.trustedSourceMetadata).sort()
    if (
      stableSerialize(sourceIds) !== stableSerialize(trustedSourceIds) ||
      sourceIds.some((sourceId) =>
        calculateCanonicalHash(canonicalPlan.sourceMetadata[sourceId]) !==
          calculateCanonicalHash(context.trustedSourceMetadata[sourceId]))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'ColorPlan source metadata must match the trusted source probes',
      )
    }
    const createdAt = clock().toISOString()
    const commandId = id(dependencies.createId('command'), 'commandId')
    const versionId = id(dependencies.createId('version'), 'versionId')
    const colorPlan = createProjectColorPlan({
      id: id(dependencies.createId('color-plan'), 'colorPlanId'),
      workspaceId,
      projectId,
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      plan: canonicalPlan,
      targets: context.targets,
      createdAt,
    })
    const impact = createProjectColorPlanImpact({
      commandId,
      baseVersionId,
      resultVersionId: versionId,
      colorPlanId: colorPlan.id,
      colorPlanHash: colorPlan.plan.planHash,
      compiledManifestHash: colorPlan.compiled.manifestHash,
      durationFrames: context.currentDurationFrames,
      proxyVariantId: context.proxyVariantId,
      outputReferences: context.outputReferences,
    })
    const payload = Object.freeze({
      schemaVersion: 1 as const,
      colorPlanId: colorPlan.id,
      colorPlanHash: colorPlan.plan.planHash,
      compiledManifestHash: colorPlan.compiled.manifestHash,
      impact,
    })
    const command = createEditCommand({
      id: commandId,
      workspaceId,
      projectId,
      baseVersionId,
      baseHash,
      author: actor.author,
      type: 'set-project-color-plan',
      scope: { project: true },
      payload,
      ...(request.reason?.trim() ? { reason: request.reason.trim() } : {}),
      idempotencyKey,
      createdAt,
    })
    const version = createProjectVersion({
      id: versionId,
      workspaceId,
      projectId,
      sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: context.currentVersion.snapshotRefs,
      baseHash: calculateCanonicalHash({
        schemaVersion: 'project-version-color-plan/v1',
        previousBaseHash: context.currentVersion.baseHash,
        commandId,
        colorPlanRecordHash: colorPlan.recordHash,
        impactHash: impact.impactHash,
      }),
      createdBy: actor.author.id,
      commandId,
      createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(),
      type: 'project.version.created',
      version: '1.0.0',
      workspaceId,
      occurredAt: createdAt,
      sequence: version.sequence,
      actor: actor.author.type === 'api-client'
        ? { clientId: actor.author.id, ...(actor.author.delegatedUserId ? { userId: actor.author.delegatedUserId } : {}) }
        : { userId: actor.author.id },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId,
        sequence: version.sequence,
        parentVersionId: version.parentVersionId,
        baseHash: version.baseHash,
        commandId,
        commandType: command.type,
        colorPlanHash: colorPlan.plan.planHash,
        compiledManifestHash: colorPlan.compiled.manifestHash,
        commandImpactHash: impact.impactHash,
        artifactInvalidationCount: impact.affectedArtifacts.length,
        createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command,
      ...(actor.authenticationAudit ? { authenticationAudit: actor.authenticationAudit } : {}),
      version,
      colorPlan,
      requestFingerprint,
      event,
    })
  }
}

export function readProjectColorPlanService(dependencies: {
  repository: ProjectColorPlanRepository
}) {
  return (input: { workspaceId: string; projectId: string }) =>
    dependencies.repository.readCurrent({
      workspaceId: id(input.workspaceId, 'workspaceId'),
      projectId: id(input.projectId, 'projectId'),
    })
}

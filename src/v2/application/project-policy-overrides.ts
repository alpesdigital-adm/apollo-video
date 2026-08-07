import { calculateCanonicalHash, stableSerialize } from '../domain/canonical-hash.ts'
import { createEditCommand } from '../domain/edit-command.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createProjectPolicyOverrideInvalidations,
  createProjectPolicyOverridesImpact,
} from '../domain/project-policy-overrides-impact.ts'
import {
  normalizeProjectOverrides,
  normalizeWorkspaceProjectPolicyValues,
  projectOverridePolicySnapshot,
  resolveProjectOverrides,
} from '../domain/project-overrides.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import { createProjectVersion } from '../domain/project-version.ts'
import { createPublicEvent } from '../domain/public-event.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { ProjectPolicyOverridesRepository } from './ports/project-policy-overrides-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
function id(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  assertDomain(ID.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function workspaceDefaultsFromPolicy(content: Readonly<Record<string, unknown>>) {
  if (content.schemaVersion === 2 && content.workspaceDefaults !== undefined) {
    return normalizeWorkspaceProjectPolicyValues(content.workspaceDefaults)
  }
  return normalizeWorkspaceProjectPolicyValues({
    ...(Array.isArray(content.guardrails) ? { guardrails: content.guardrails } : {}),
  })
}

function overridesFromPolicy(content: Readonly<Record<string, unknown>>) {
  return normalizeProjectOverrides(content.schemaVersion === 2 && content.overrides !== undefined ? content.overrides : {})
}

function resolvedValues(resolved: ReturnType<typeof resolveProjectOverrides>) {
  return Object.freeze(Object.fromEntries(
    Object.entries(resolved).map(([element, resolution]) => [element, resolution.value]),
  ))
}

export function setProjectPolicyOverridesService(dependencies: {
  repository: ProjectPolicyOverridesRepository
  createId: (kind: 'command' | 'version' | 'snapshot') => string
  createEventId: () => string
  clock?: () => Date
}) {
  const clock = dependencies.clock ?? (() => new Date())
  return async (request: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    baseHash: string
    overrides: unknown
    reason?: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) => {
    const workspaceId = id(request.workspaceId, 'workspaceId')
    const projectId = id(request.projectId, 'projectId')
    const baseVersionId = id(request.baseVersionId, 'baseVersionId')
    assertDomain(/^[a-f0-9]{64}$/.test(request.baseHash), 'INVALID_ARGUMENT', 'baseHash is invalid')
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Project policy actor does not match the workspace')
    const idempotencyKey = request.idempotencyKey?.trim()
    assertDomain(Boolean(idempotencyKey) && idempotencyKey.length >= 8 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key is invalid')
    const overrides = normalizeProjectOverrides(request.overrides)
    const reason = request.reason?.replace(/\s+/g, ' ').trim()
    assertDomain(reason === undefined || (reason.length > 0 && reason.length <= 1_000), 'INVALID_ARGUMENT', 'reason is invalid')
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'set-project-policy-overrides-request/v1',
      workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      overrides, reason: reason ?? null, actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({ workspaceId, projectId, idempotencyKey, actorContextHash: authenticationAudit.contextHash })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different project overrides')
      return Object.freeze({ ...replay.result, replayed: true })
    }
    const context = await dependencies.repository.readContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project policy context was not found')
    if (context.currentVersion.id !== baseVersionId || context.currentVersion.baseHash !== request.baseHash) throw new DomainError('VERSION_CONFLICT', 'Project policy base version is stale')
    const previousOverrides = overridesFromPolicy(context.currentPolicySnapshot.content)
    assertDomain(stableSerialize(previousOverrides) !== stableSerialize(overrides), 'INVALID_ARGUMENT', 'Project overrides are unchanged')
    const workspaceDefaults = workspaceDefaultsFromPolicy(context.currentPolicySnapshot.content)
    const previousResolved = resolveProjectOverrides(workspaceDefaults, previousOverrides)
    const resolved = resolveProjectOverrides(workspaceDefaults, overrides)
    const createdAt = clock().toISOString()
    const commandId = id(dependencies.createId('command'), 'commandId')
    const versionId = id(dependencies.createId('version'), 'versionId')
    const snapshotId = id(dependencies.createId('snapshot'), 'snapshotId')
    const policyState = projectOverridePolicySnapshot({
      workspaceId, projectId, projectVersionId: versionId, commandId,
      workspaceDefaults, overrides, createdAt,
    })
    const resolvedGuardrails = resolved.guardrails.value
    const policyContent = Object.freeze({
      ...context.currentPolicySnapshot.content,
      ...policyState.content,
      state: 'configured',
      brandKitMode: Object.values(overrides).every((override) => override.mode === 'inherit') ? 'inherit' : 'project-override',
      guardrails: Array.isArray(resolvedGuardrails) ? resolvedGuardrails : Object.freeze([]),
    })
    const policyJson = stableSerialize(policyContent)
    const policyHash = calculateCanonicalHash(policyContent)
    const policySnapshot = createProjectSnapshot({
      id: snapshotId, workspaceId, projectId, kind: 'policies', contentSchemaVersion: 2,
      contentJson: policyJson, contentHash: policyHash, createdAt,
    })
    const impact = createProjectPolicyOverridesImpact({
      commandId, baseVersionId, resultVersionId: versionId,
      policySnapshotId: snapshotId, policySnapshotHash: policyHash,
      previousResolvedHash: calculateCanonicalHash(resolvedValues(previousResolved)),
      resultResolvedHash: calculateCanonicalHash(resolvedValues(resolved)),
      durationFrames: context.currentDurationFrames,
      outputReferences: context.outputReferences,
    })
    const payload = Object.freeze({
      schemaVersion: 1 as const, overrides, policySnapshotId: snapshotId,
      policySnapshotHash: policyHash, impact,
      nextRequiredCapability: 'apollo.projects.commands.apply:run-director' as const,
    })
    const author = Object.freeze({
      type: 'api-client' as const,
      id: authenticationAudit.clientId,
      ...(authenticationAudit.delegatedUserId ? { delegatedUserId: authenticationAudit.delegatedUserId } : {}),
    })
    const command = createEditCommand({
      id: commandId, workspaceId, projectId, baseVersionId, baseHash: request.baseHash,
      author, type: 'set-project-policy-overrides', scope: { project: true }, payload,
      ...(reason ? { reason } : {}), idempotencyKey, createdAt,
    })
    const version = createProjectVersion({
      id: versionId, workspaceId, projectId, sequence: context.currentVersion.sequence + 1,
      parentVersionId: context.currentVersion.id,
      snapshotRefs: { ...context.currentVersion.snapshotRefs, policies: snapshotId },
      baseHash: calculateCanonicalHash({
        schemaVersion: 'project-version-policy-overrides/v1',
        previousBaseHash: context.currentVersion.baseHash, commandId,
        policySnapshotHash: policyHash, impactHash: impact.impactHash,
      }),
      createdBy: author.id, commandId, createdAt,
    })
    const event = createPublicEvent({
      id: dependencies.createEventId(), type: 'project.version.created', version: '1.0.0',
      workspaceId, occurredAt: createdAt, sequence: version.sequence,
      actor: { clientId: author.id, ...(author.delegatedUserId ? { userId: author.delegatedUserId } : {}) },
      resource: { type: 'project-version', id: version.id },
      data: {
        projectId, sequence: version.sequence, parentVersionId: version.parentVersionId,
        baseHash: version.baseHash, commandId, commandType: command.type,
        policySnapshotId: snapshotId, policySnapshotHash: policyHash,
        commandImpactHash: impact.impactHash,
        artifactInvalidationCount: createProjectPolicyOverrideInvalidations({ impact, createdAt }).length,
        nextRequiredCapability: payload.nextRequiredCapability, createdAt,
      },
    })
    return dependencies.repository.commitOrReplay({
      command, authenticationAudit, version, policySnapshot,
      workspaceDefaults, overrides, resolved, requestFingerprint, event,
    })
  }
}

export function readProjectPolicyOverridesService(dependencies: { repository: ProjectPolicyOverridesRepository }) {
  return async (input: { workspaceId: string; projectId: string }) => {
    const value = await dependencies.repository.readCurrent({ workspaceId: id(input.workspaceId, 'workspaceId'), projectId: id(input.projectId, 'projectId') })
    if (!value) throw new DomainError('PROJECT_NOT_FOUND', 'Project policy state was not found')
    return value
  }
}

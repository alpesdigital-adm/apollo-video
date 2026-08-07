import { Prisma, type PrismaClient, type V2ProjectVersion } from '../../../../generated/prisma-v2/index.js'

import type {
  CurrentProjectPolicyOverrides,
  ProjectPolicyOverridesCommit,
  ProjectPolicyOverridesPayloadV1,
  ProjectPolicyOverridesRepository,
  ProjectPolicyOverridesResult,
} from '../../application/ports/project-policy-overrides-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  createProjectPolicyOverrideInvalidations,
  parseProjectPolicyOverridesImpact,
} from '../../domain/project-policy-overrides-impact.ts'
import {
  normalizeProjectOverrides,
  normalizeWorkspaceProjectPolicyValues,
  resolveProjectOverrides,
} from '../../domain/project-overrides.ts'
import { createProjectSnapshot } from '../../domain/project-snapshot.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import {
  editCommandExternalActorAuditData,
  hydrateEditCommandExternalActorAudit,
} from './edit-command-actor-audit.ts'

const storedCommandInclude = Prisma.validator<Prisma.V2EditCommandInclude>()({
  resultVersion: { include: { policiesSnapshot: true } },
  artifactInvalidations: true,
})
type StoredCommand = Prisma.V2EditCommandGetPayload<{ include: typeof storedCommandInclude }>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (
      typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) ||
      stableSerialize(parsed) !== value
    ) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateVersion(row: V2ProjectVersion) {
  return createProjectVersion({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sequence: row.sequence,
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    ...(row.forkedFromProjectId ? { forkedFromProjectId: row.forkedFromProjectId } : {}),
    ...(row.forkedFromVersionId ? { forkedFromVersionId: row.forkedFromVersionId } : {}),
    snapshotRefs: {
      brief: row.briefSnapshotId,
      ...(row.treatmentSnapshotId ? { treatment: row.treatmentSnapshotId } : {}),
      ...(row.storySnapshotId ? { story: row.storySnapshotId } : {}),
      editPlan: row.editPlanSnapshotId,
      policies: row.policiesSnapshotId,
    },
    baseHash: row.baseHash,
    createdBy: row.createdBy,
    ...(row.commandId ? { commandId: row.commandId } : {}),
    createdAt: row.createdAt.toISOString(),
  })
}

function policyState(content: Readonly<Record<string, unknown>>) {
  if (content.schemaVersion === 2) {
    const workspaceDefaults = normalizeWorkspaceProjectPolicyValues(content.workspaceDefaults)
    const overrides = normalizeProjectOverrides(content.overrides)
    const resolved = resolveProjectOverrides(workspaceDefaults, overrides)
    if (stableSerialize(resolved) !== stableSerialize(content.resolved)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy resolution is inconsistent')
    }
    return Object.freeze({ workspaceDefaults, overrides, resolved })
  }
  if (content.schemaVersion !== 1) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy schema is unsupported')
  }
  const workspaceDefaults = normalizeWorkspaceProjectPolicyValues({
    ...(Array.isArray(content.guardrails) ? { guardrails: content.guardrails } : {}),
  })
  const overrides = normalizeProjectOverrides({})
  return Object.freeze({
    workspaceDefaults,
    overrides,
    resolved: resolveProjectOverrides(workspaceDefaults, overrides),
  })
}

function hydratePolicySnapshot(row: {
  id: string
  workspaceId: string
  projectId: string
  kind: string
  schemaVersion: number
  contentJson: string
  contentHash: string
  createdAt: Date
}) {
  const content = parseRecord(row.contentJson, 'project policy snapshot')
  if (
    row.kind !== 'policies' || calculateCanonicalHash(content) !== row.contentHash ||
    Number(content.schemaVersion) !== row.schemaVersion
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy snapshot identity is invalid')
  const state = policyState(content)
  return Object.freeze({
    snapshot: createProjectSnapshot({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      kind: 'policies',
      contentSchemaVersion: row.schemaVersion,
      contentJson: row.contentJson,
      contentHash: row.contentHash,
      createdAt: row.createdAt.toISOString(),
    }),
    content: Object.freeze(content),
    ...state,
  })
}

function hydrateStoredCommand(row: StoredCommand, replayed: boolean): Readonly<ProjectPolicyOverridesResult> {
  const authenticationAudit = hydrateEditCommandExternalActorAudit(row)
  if (row.type !== 'set-project-policy-overrides' || !row.resultVersion) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy override result is missing')
  }
  const payload = parseRecord(row.payloadJson, 'project policy override payload') as unknown as ProjectPolicyOverridesPayloadV1
  const impact = parseProjectPolicyOverridesImpact(payload.impact)
  const storedPolicy = hydratePolicySnapshot(row.resultVersion.policiesSnapshot)
  const overrides = normalizeProjectOverrides(payload.overrides)
  if (
    payload.schemaVersion !== 1 ||
    payload.nextRequiredCapability !== 'apollo.projects.commands.apply:run-director' ||
    stableSerialize(overrides) !== stableSerialize(storedPolicy.overrides) ||
    payload.policySnapshotId !== storedPolicy.snapshot.id ||
    payload.policySnapshotHash !== storedPolicy.snapshot.contentHash ||
    impact.commandId !== row.id || impact.baseVersionId !== row.baseVersionId ||
    impact.resultVersionId !== row.resultVersion.id ||
    impact.policySnapshotId !== storedPolicy.snapshot.id ||
    impact.policySnapshotHash !== storedPolicy.snapshot.contentHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy override lineage is inconsistent')
  const command = createEditCommand<ProjectPolicyOverridesPayloadV1>({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    baseVersionId: row.baseVersionId,
    baseHash: row.baseHash,
    author: {
      type: 'api-client',
      id: row.actorId,
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
    },
    type: 'set-project-policy-overrides',
    scope: parseRecord(row.scopeJson, 'project policy override scope') as EditScope,
    payload: Object.freeze({ ...payload, overrides, impact }),
    ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
  if (authenticationAudit.contextHash !== row.actorContextHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy actor context is inconsistent')
  }
  const expectedInvalidations = createProjectPolicyOverrideInvalidations({ impact, createdAt: command.createdAt })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1',
    id: item.id,
    status: item.status,
    commandId: item.commandId,
    baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId,
    artifactId: item.artifactId,
    kind: item.kind,
    variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'project policy invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'project policy invalidation ranges'),
    impactHash: item.impactHash,
    createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy invalidations are inconsistent')
  }
  const version = hydrateVersion(row.resultVersion)
  return Object.freeze({
    command,
    version,
    policySnapshot: storedPolicy.snapshot,
    workspaceDefaults: storedPolicy.workspaceDefaults,
    overrides: storedPolicy.overrides,
    resolved: storedPolicy.resolved,
    impact,
    invalidations: Object.freeze(invalidations),
    replayed,
  })
}

function currentValue(row: {
  currentVersion: (V2ProjectVersion & { policiesSnapshot: {
    id: string
    workspaceId: string
    projectId: string
    kind: string
    schemaVersion: number
    contentJson: string
    contentHash: string
    createdAt: Date
  } }) | null
}): Readonly<CurrentProjectPolicyOverrides> | null {
  if (!row.currentVersion) return null
  const stored = hydratePolicySnapshot(row.currentVersion.policiesSnapshot)
  return Object.freeze({
    version: hydrateVersion(row.currentVersion),
    policySnapshot: Object.freeze({
      id: stored.snapshot.id,
      contentSchemaVersion: stored.snapshot.contentSchemaVersion,
      contentHash: stored.snapshot.contentHash,
    }),
    workspaceDefaults: stored.workspaceDefaults,
    overrides: stored.overrides,
    resolved: stored.resolved,
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaProjectPolicyOverridesRepository implements ProjectPolicyOverridesRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      } },
      include: storedCommandInclude,
    })
    if (!row) return null
    if (row.type !== 'set-project-policy-overrides') {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another command type')
    }
    if (hydrateEditCommandExternalActorAudit(row).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Project policy replay belongs to another authentication context')
    }
    return Object.freeze({ requestFingerprint: row.requestFingerprint, result: hydrateStoredCommand(row, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { policiesSnapshot: true, editPlanSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const editPlan = parseRecord(project.currentVersion.editPlanSnapshot.contentJson, 'project policy EditPlan')
    const currentDurationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames < 0 || !project.format) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy render context is incomplete')
    }
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    if (currentDurationFrames === 0 && (proxyOutputs.length > 0 || finalOutputs.length > 0)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project outputs exist before a renderable timeline')
    }
    const policy = hydratePolicySnapshot(project.currentVersion.policiesSnapshot)
    const currentVersion = hydrateVersion(project.currentVersion)
    return Object.freeze({
      currentVersion,
      currentPolicySnapshot: Object.freeze({
        id: policy.snapshot.id,
        contentSchemaVersion: policy.snapshot.contentSchemaVersion,
        contentHash: policy.snapshot.contentHash,
        content: policy.content,
      }),
      currentDurationFrames,
      proxyVariantId: project.format,
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: currentVersion.id, variantId: project.format! })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: currentVersion.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { policiesSnapshot: true } } },
    })
    return project ? currentValue(project) : null
  }

  async commitOrReplay(bundle: Readonly<ProjectPolicyOverridesCommit>, serializationAttempt = 1): Promise<Readonly<ProjectPolicyOverridesResult>> {
    editCommandExternalActorAuditData(bundle.authenticationAudit, bundle.command.workspaceId, bundle.command.author)
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2EditCommand.findUnique({
          where: { workspaceId_projectId_idempotencyKey: {
            workspaceId: bundle.command.workspaceId,
            projectId: bundle.command.projectId,
            idempotencyKey: bundle.command.idempotencyKey,
          } },
          include: storedCommandInclude,
        })
        if (existing) {
          if (
            existing.type !== 'set-project-policy-overrides' ||
            existing.requestFingerprint !== bundle.requestFingerprint ||
            hydrateEditCommandExternalActorAudit(existing).contextHash !== bundle.authenticationAudit.contextHash
          ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different project overrides')
          return hydrateStoredCommand(existing, true)
        }
        const project = await transaction.v2Project.findFirst({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
          include: { currentVersion: { include: { policiesSnapshot: true, editPlanSnapshot: true } } },
        })
        if (
          !project?.currentVersion ||
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before policy override commit')
        const currentPolicy = hydratePolicySnapshot(project.currentVersion.policiesSnapshot)
        if (stableSerialize(currentPolicy.workspaceDefaults) !== stableSerialize(bundle.workspaceDefaults)) {
          throw new DomainError('VERSION_CONFLICT', 'Workspace policy values changed before project override commit')
        }
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true },
          }),
          transaction.v2ProjectFinalExportOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true, outputAspectRatio: true },
          }),
        ])
        const outputs = [
          ...proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: bundle.command.baseVersionId, variantId: project.format ?? '9:16' })),
          ...finalOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: bundle.command.baseVersionId, variantId: output.outputAspectRatio })),
        ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
        const expectedAffectedOutputs = bundle.command.payload.impact.renderSemanticsChanged ? outputs : []
        if (stableSerialize(expectedAffectedOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before policy impact commit')
        }
        await transaction.v2EditCommand.create({ data: {
          id: bundle.command.id,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          baseVersionId: bundle.command.baseVersionId,
          baseHash: bundle.command.baseHash,
          type: bundle.command.type,
          scopeJson: stableSerialize(bundle.command.scope),
          payloadJson: stableSerialize(bundle.command.payload),
          reason: bundle.command.reason,
          actorType: bundle.command.author.type,
          actorId: bundle.command.author.id,
          delegatedUserId: bundle.command.author.delegatedUserId,
          ...editCommandExternalActorAuditData(bundle.authenticationAudit, bundle.command.workspaceId, bundle.command.author),
          idempotencyKey: bundle.command.idempotencyKey,
          requestFingerprint: bundle.requestFingerprint,
          createdAt: new Date(bundle.command.createdAt),
        } })
        await transaction.v2ProjectSnapshot.create({ data: {
          id: bundle.policySnapshot.id,
          workspaceId: bundle.policySnapshot.workspaceId,
          projectId: bundle.policySnapshot.projectId,
          kind: bundle.policySnapshot.kind,
          schemaVersion: bundle.policySnapshot.contentSchemaVersion,
          contentJson: bundle.policySnapshot.contentJson,
          contentHash: bundle.policySnapshot.contentHash,
          createdAt: new Date(bundle.policySnapshot.createdAt),
        } })
        await transaction.v2ProjectVersion.create({ data: {
          id: bundle.version.id,
          workspaceId: bundle.version.workspaceId,
          projectId: bundle.version.projectId,
          sequence: bundle.version.sequence,
          parentVersionId: bundle.version.parentVersionId,
          briefSnapshotId: bundle.version.snapshotRefs.brief!,
          treatmentSnapshotId: bundle.version.snapshotRefs.treatment,
          storySnapshotId: bundle.version.snapshotRefs.story,
          editPlanSnapshotId: bundle.version.snapshotRefs.editPlan,
          policiesSnapshotId: bundle.version.snapshotRefs.policies,
          baseHash: bundle.version.baseHash,
          createdBy: bundle.version.createdBy,
          commandId: bundle.command.id,
          createdAt: new Date(bundle.version.createdAt),
        } })
        const invalidations = createProjectPolicyOverrideInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
        if (invalidations.length > 0) await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
          id: item.id,
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          commandId: item.commandId,
          baseVersionId: item.baseVersionId,
          resultVersionId: item.resultVersionId,
          artifactId: item.artifactId,
          kind: item.kind,
          variantId: item.variantId,
          status: item.status,
          dependencyTypesJson: stableSerialize(item.dependencyTypes),
          affectedRangesJson: stableSerialize(item.affectedRanges),
          impactHash: item.impactHash,
          createdAt: new Date(item.createdAt),
        })) })
        const updated = await transaction.v2Project.updateMany({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId, currentVersionId: bundle.command.baseVersionId },
          data: { currentVersionId: bundle.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during policy override')
        await transaction.v2PublicEventOutbox.create({ data: {
          id: bundle.event.id,
          workspaceId: bundle.event.workspaceId,
          type: bundle.event.type,
          version: bundle.event.version,
          occurredAt: new Date(bundle.event.occurredAt),
          sequence: bundle.event.sequence,
          actorClientId: bundle.event.actor?.clientId,
          actorUserId: bundle.event.actor?.userId,
          resourceType: bundle.event.resource.type,
          resourceId: bundle.event.resource.id,
          dataJson: stableSerialize(bundle.event.data),
        } })
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: storedCommandInclude,
        })
        return hydrateStoredCommand(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitOrReplay(bundle, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotent({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
          actorContextHash: bundle.authenticationAudit.contextHash,
        })
        if (existing?.requestFingerprint === bundle.requestFingerprint) return existing.result
        if (existing) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different project overrides')
        throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy override collided with immutable state')
      }
      throw error
    }
  }
}

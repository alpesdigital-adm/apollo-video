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
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRow, hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
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
  return hydrateProjectVersionRowV3(row)
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
  if (row.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project policy command seal is invalid')
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
    version: hydrateProjectVersionRow(row.currentVersion),
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
      include: { currentVersion: { include: { policiesSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersion.id })
    if (!parent) return null
    const editPlan = parseRecord(operationalBundlePlanV3(parent).contentJson, 'project policy EditPlan')
    const currentDurationFrames = Number(editPlan.durationFrames)
    // Policy overrides are project-wide: the impact covers EVERY output the sealed State carries, each render attributed to its own.
    const variantIds = parent.state.document.entries.map((entry) => entry.variantId)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames < 0 || variantIds.length === 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy render context is incomplete')
    }
    const currentVersionId = parent.version.id
    const [proxyOutputs, finalOutputs] = await Promise.all([
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputVariantId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true },
      }),
    ])
    if (currentDurationFrames === 0 && (proxyOutputs.length > 0 || finalOutputs.length > 0)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project outputs exist before a renderable timeline')
    }
    const policy = hydratePolicySnapshot(project.currentVersion.policiesSnapshot)
    if (parent.version.snapshotRefs.policies !== policy.snapshot.id) throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy snapshot differs from the sealed head')
    return Object.freeze({
      parent,
      currentPolicySnapshot: Object.freeze({
        id: policy.snapshot.id,
        contentSchemaVersion: policy.snapshot.contentSchemaVersion,
        contentHash: policy.snapshot.contentHash,
        content: policy.content,
      }),
      currentDurationFrames,
      variantIds: Object.freeze(variantIds),
      outputReferences: renderOutputReferences({ state: parent.state, sourceVersionId: currentVersionId, proxies: proxyOutputs, finals: finalOutputs }),
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { policiesSnapshot: true } } },
    })
    return project ? currentValue(project) : null
  }

  async commitOrReplay(input: Readonly<ProjectPolicyOverridesCommit>, serializationAttempt = 1): Promise<Readonly<ProjectPolicyOverridesResult>> {
    const sealed = childCommandOf<ProjectPolicyOverridesPayloadV1>(input.bundle)
    const authenticationAudit = sealed.audit
    if (!authenticationAudit) throw new DomainError('AUTH_INVALID', 'Project policy overrides require an authenticated external actor')
    editCommandExternalActorAuditData(authenticationAudit, sealed.command.workspaceId, sealed.command.author)
    const bundle = { command: sealed.command, requestFingerprint: sealed.requestFingerprint, version: input.bundle.version, event: input.event, workspaceDefaults: input.workspaceDefaults }
    const policySnapshot = input.bundle.snapshots.find((snapshot) => snapshot.id === bundle.version.snapshotRefs.policies)
    if (
      bundle.command.type !== 'set-project-policy-overrides' || !policySnapshot || policySnapshot.kind !== 'policies' ||
      bundle.command.payload.policySnapshotId !== policySnapshot.id || bundle.command.payload.policySnapshotHash !== policySnapshot.contentHash ||
      bundle.version.commandId !== bundle.command.id
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy snapshot does not belong to the Command that produced its Version')
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
            hydrateEditCommandExternalActorAudit(existing).contextHash !== authenticationAudit.contextHash
          ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different project overrides')
          return hydrateStoredCommand(existing, true)
        }
        const project = await transaction.v2Project.findFirst({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
          include: { currentVersion: { include: { policiesSnapshot: true } } },
        })
        if (
          !project?.currentVersion ||
          project.currentVersion.id !== bundle.command.baseVersionId ||
          project.currentVersion.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== project.currentVersion.id ||
          bundle.version.sequence !== project.currentVersion.sequence + 1 ||
          input.bundle.state.document.parentStateHash !== project.currentVersion.outputStateHash
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before policy override commit')
        const currentPolicy = hydratePolicySnapshot(project.currentVersion.policiesSnapshot)
        if (stableSerialize(currentPolicy.workspaceDefaults) !== stableSerialize(bundle.workspaceDefaults)) {
          throw new DomainError('VERSION_CONFLICT', 'Workspace policy values changed before project override commit')
        }
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true, outputVariantId: true },
          }),
          transaction.v2ProjectFinalExportOperation.findMany({
            where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, projectVersionId: bundle.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true, outputVariantId: true, outputAspectRatio: true },
          }),
        ])
        const outputs = renderOutputReferences({ state: input.bundle.state, sourceVersionId: bundle.command.baseVersionId, proxies: proxyOutputs, finals: finalOutputs })
        const expectedAffectedOutputs = bundle.command.payload.impact.renderSemanticsChanged ? outputs : []
        if (stableSerialize(expectedAffectedOutputs) !== stableSerialize(bundle.command.payload.impact.affectedArtifacts)) {
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before policy impact commit')
        }
        await commitProjectVersionWithOutputState(transaction, input.bundle)
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
        await settleDeferredOutputGuards(transaction)
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({
          where: { id: bundle.command.id },
          include: storedCommandInclude,
        })
        return hydrateStoredCommand(stored, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) {
        return this.commitOrReplay(input, serializationAttempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotent({
          workspaceId: bundle.command.workspaceId,
          projectId: bundle.command.projectId,
          idempotencyKey: bundle.command.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (existing?.requestFingerprint === bundle.requestFingerprint) return existing.result
        if (existing) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with different project overrides')
        throw new DomainError('PERSISTENCE_CONFLICT', 'Project policy override collided with immutable state')
      }
      throw error
    }
  }
}

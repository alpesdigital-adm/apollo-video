import { Prisma, type PrismaClient, type V2ProjectVersion } from '../../../../generated/prisma-v2/index.js'

import type {
  CurrentEditorialRequest,
  EditorialRequestRepository,
  EditorialRequestRevisionCommit,
  EditorialRequestRevisionPayloadV1,
  EditorialRequestRevisionResult,
} from '../../application/ports/editorial-request-repository.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { EDITORIAL_REQUEST_NEEDS_OUTPUT_REASON, deriveEditorialRequestFromBrief } from '../../domain/editorial-request.ts'
import {
  createEditorialRequestRevisionInvalidations,
  parseEditorialRequestRevisionImpact,
} from '../../domain/editorial-request-revision-impact.ts'
import { DomainError } from '../../domain/errors.ts'
import { operationalBundlePlanV3 } from '../../domain/output-version-bundle.ts'
import { renderOutputReferences } from '../../domain/output-variant-references.ts'
import { childCommandOf } from '../../domain/project-output-state-transition.ts'
import { hydrateProjectVersionRow, hydrateProjectVersionRowV3 } from '../../domain/project-version-row.ts'
import { createProjectSnapshot } from '../../domain/project-snapshot.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { readPersistedOperationalOutputBundleV3 } from './output-state-consumption.ts'
import { commitProjectVersionWithOutputState, settleDeferredOutputGuards } from './project-version-commit.ts'
import { editCommandExternalActorAuditData, hydrateEditCommandExternalActorAudit } from './edit-command-actor-audit.ts'

const storedCommandInclude = Prisma.validator<Prisma.V2EditCommandInclude>()({
  resultVersion: { include: { briefSnapshot: true } },
  artifactInvalidations: true,
})
type StoredCommand = Prisma.V2EditCommandGetPayload<{ include: typeof storedCommandInclude }>

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error('invalid')
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

interface BriefRow { id: string; workspaceId: string; projectId: string; kind: string; schemaVersion: number; contentJson: string; contentHash: string; createdAt: Date }

function hydrateBriefSnapshot(row: BriefRow) {
  const content = parseRecord(row.contentJson, 'project brief snapshot')
  if (row.kind !== 'brief' || calculateCanonicalHash(content) !== row.contentHash || Number(content.schemaVersion) !== row.schemaVersion) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project brief snapshot identity is invalid')
  }
  return Object.freeze({
    snapshot: createProjectSnapshot({
      id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, kind: 'brief', contentSchemaVersion: row.schemaVersion,
      contentJson: row.contentJson, contentHash: row.contentHash, createdAt: row.createdAt.toISOString(),
    }),
    content: Object.freeze(content),
  })
}

/** The objective the request is stated under, or none: a project created with no objective has none, and the Apollo presumes none. */
function objectiveOf(project: { objective: string | null }, content: Readonly<Record<string, unknown>>): string | undefined {
  return project.objective ?? (typeof content.objective === 'string' ? content.objective : undefined)
}

/** A revision made since the objective can be set states the objective its request was made under; an older one is read under the objective of the project. */
function statedObjective(payload: Readonly<{ objective?: string | null }>, fallback: string | undefined): string | undefined {
  return 'objective' in payload ? (payload.objective ?? undefined) : fallback
}

function hydrateStoredCommand(row: StoredCommand, objective: string | undefined, replayed: boolean): Readonly<EditorialRequestRevisionResult> {
  const authenticationAudit = hydrateEditCommandExternalActorAudit(row)
  if (row.type !== 'revise-editorial-request' || !row.resultVersion) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial request revision result is missing')
  const payload = parseRecord(row.payloadJson, 'editorial request revision payload') as unknown as EditorialRequestRevisionPayloadV1
  const impact = parseEditorialRequestRevisionImpact(payload.impact)
  const stored = hydrateBriefSnapshot(row.resultVersion.briefSnapshot)
  // The Command names the request the Brief Snapshot of its Version states: both are recomputed from the document, not trusted from the payload.
  const request = deriveEditorialRequestFromBrief({ ...stored.content, ...(statedObjective(payload, objective) !== undefined ? { objective: statedObjective(payload, objective)! } : {}) })
  if (
    payload.schemaVersion !== 1 ||
    payload.nextRequiredCapability !== 'apollo.projects.commands.apply:run-director' ||
    payload.briefSnapshotId !== stored.snapshot.id || payload.briefSnapshotHash !== stored.snapshot.contentHash ||
    payload.requestHash !== request.requestHash ||
    payload.interpretationHash !== (request.interpretation?.interpretationHash ?? null) ||
    impact.commandId !== row.id || impact.baseVersionId !== row.baseVersionId || impact.resultVersionId !== row.resultVersion.id ||
    impact.briefSnapshotId !== stored.snapshot.id || impact.briefSnapshotHash !== stored.snapshot.contentHash ||
    impact.resultRequestHash !== request.requestHash || impact.previousRequestHash !== payload.previousRequestHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial request revision lineage is inconsistent')
  const command = createEditCommand<EditorialRequestRevisionPayloadV1>({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, baseVersionId: row.baseVersionId, baseHash: row.baseHash,
    author: { type: 'api-client', id: row.actorId, ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}) },
    type: 'revise-editorial-request',
    scope: parseRecord(row.scopeJson, 'editorial request revision scope') as EditScope,
    payload: Object.freeze({ ...payload, impact }),
    ...(row.reason ? { reason: row.reason } : {}),
    idempotencyKey: row.idempotencyKey, createdAt: row.createdAt.toISOString(),
  })
  if (authenticationAudit.contextHash !== row.actorContextHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial request actor context is inconsistent')
  const expectedInvalidations = createEditorialRequestRevisionInvalidations({ impact, createdAt: command.createdAt }).toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status, commandId: item.commandId, baseVersionId: item.baseVersionId,
    resultVersionId: item.resultVersionId, artifactId: item.artifactId, kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'editorial request invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'editorial request invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial request invalidations are inconsistent')
  if (row.commandHash !== command.commandHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored editorial request command seal is invalid')
  return Object.freeze({
    command, version: hydrateProjectVersionRowV3(row.resultVersion as V2ProjectVersion), briefSnapshot: stored.snapshot, impact,
    invalidations: Object.freeze(invalidations), replayed,
  })
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

export class PrismaEditorialRequestRepository implements EditorialRequestRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  private async objectiveOfProject(workspaceId: string, projectId: string, content: Readonly<Record<string, unknown>>): Promise<string | undefined> {
    const project = await this.client.v2Project.findFirst({ where: { id: projectId, workspaceId }, select: { objective: true } })
    if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    return objectiveOf(project, content)
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey } },
      include: storedCommandInclude,
    })
    if (!row) return null
    if (row.type !== 'revise-editorial-request') throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key belongs to another command type')
    if (hydrateEditCommandExternalActorAudit(row).contextHash !== input.actorContextHash) {
      throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Editorial request replay belongs to another authentication context')
    }
    const objective = await this.objectiveOfProject(input.workspaceId, input.projectId, parseRecord(row.resultVersion?.briefSnapshot.contentJson ?? '{}', 'project brief snapshot'))
    return Object.freeze({ requestFingerprint: row.requestFingerprint, result: hydrateStoredCommand(row, objective, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string }) {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { briefSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const parent = await readPersistedOperationalOutputBundleV3(this.client, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersion.id })
    if (!parent) return null
    const editPlan = parseRecord(operationalBundlePlanV3(parent).contentJson, 'editorial request EditPlan')
    const currentDurationFrames = Number(editPlan.durationFrames)
    // A revision is a child Command, and a child Command needs an explicit output variant (the sealed Version machinery): a project with none is
    // refused with its own reason. Its briefing was read when it was created, and it can be revised as soon as it has an output.
    if (parent.state.document.entries.length === 0) {
      throw new DomainError('PRECONDITION_REQUIRED', 'A project with no output cannot have its editorial request revised yet', { reason: EDITORIAL_REQUEST_NEEDS_OUTPUT_REASON })
    }
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames < 0) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial request render context is incomplete')
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
    const brief = hydrateBriefSnapshot(project.currentVersion.briefSnapshot)
    if (parent.version.snapshotRefs.brief !== brief.snapshot.id) throw new DomainError('PERSISTENCE_CONFLICT', 'Project brief snapshot differs from the sealed head')
    const directorStarted = (await this.client.v2DirectorRun.count({ where: { workspaceId: input.workspaceId, projectId: input.projectId } })) > 0
    return Object.freeze({
      parent,
      project: Object.freeze({ ...(objectiveOf(project, brief.content) !== undefined ? { objective: objectiveOf(project, brief.content)! } : {}), directorStarted }),
      currentBriefSnapshot: Object.freeze({ id: brief.snapshot.id, contentSchemaVersion: brief.snapshot.contentSchemaVersion, contentHash: brief.snapshot.contentHash, content: brief.content }),
      currentDurationFrames,
      outputReferences: renderOutputReferences({ state: parent.state, sourceVersionId: currentVersionId, proxies: proxyOutputs, finals: finalOutputs }),
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string }): Promise<Readonly<CurrentEditorialRequest> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { briefSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const brief = hydrateBriefSnapshot(project.currentVersion.briefSnapshot)
    return Object.freeze({
      version: hydrateProjectVersionRow(project.currentVersion),
      briefSnapshot: Object.freeze({ id: brief.snapshot.id, contentSchemaVersion: brief.snapshot.contentSchemaVersion, contentHash: brief.snapshot.contentHash, content: brief.content }),
      ...(objectiveOf(project, brief.content) !== undefined ? { objective: objectiveOf(project, brief.content)! } : {}),
    })
  }

  async commitOrReplay(input: Readonly<EditorialRequestRevisionCommit>, serializationAttempt = 1): Promise<Readonly<EditorialRequestRevisionResult>> {
    const sealed = childCommandOf<EditorialRequestRevisionPayloadV1>(input.bundle)
    const authenticationAudit = sealed.audit
    if (!authenticationAudit) throw new DomainError('AUTH_INVALID', 'Editorial request revisions require an authenticated external actor')
    editCommandExternalActorAuditData(authenticationAudit, sealed.command.workspaceId, sealed.command.author)
    const bundle = { command: sealed.command, requestFingerprint: sealed.requestFingerprint, version: input.bundle.version, event: input.event }
    const briefSnapshot = input.bundle.snapshots.find((snapshot) => snapshot.id === bundle.version.snapshotRefs.brief)
    if (
      bundle.command.type !== 'revise-editorial-request' || !briefSnapshot || briefSnapshot.kind !== 'brief' ||
      bundle.command.payload.briefSnapshotId !== briefSnapshot.id || bundle.command.payload.briefSnapshotHash !== briefSnapshot.contentHash ||
      bundle.version.commandId !== bundle.command.id
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial request snapshot does not belong to the Command that produced its Version')
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2EditCommand.findUnique({
          where: { workspaceId_projectId_idempotencyKey: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, idempotencyKey: bundle.command.idempotencyKey } },
          include: storedCommandInclude,
        })
        const projectRow = await transaction.v2Project.findFirst({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId },
          include: { currentVersion: true },
        })
        if (!projectRow) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
        const objective = objectiveOf(projectRow, JSON.parse(briefSnapshot.contentJson) as Record<string, unknown>)
        if (existing) {
          if (
            existing.type !== 'revise-editorial-request' || existing.requestFingerprint !== bundle.requestFingerprint ||
            hydrateEditCommandExternalActorAudit(existing).contextHash !== authenticationAudit.contextHash
          ) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different editorial request')
          return hydrateStoredCommand(existing, objective, true)
        }
        const current = projectRow.currentVersion
        if (
          !current || current.id !== bundle.command.baseVersionId || current.baseHash !== bundle.command.baseHash ||
          bundle.version.parentVersionId !== current.id || bundle.version.sequence !== current.sequence + 1 ||
          input.bundle.state.document.parentStateHash !== current.outputStateHash
        ) throw new DomainError('VERSION_CONFLICT', 'Project changed before the editorial request revision commit')
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
          throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before the editorial request impact commit')
        }
        await commitProjectVersionWithOutputState(transaction, input.bundle)
        const invalidations = createEditorialRequestRevisionInvalidations({ impact: bundle.command.payload.impact, createdAt: bundle.command.createdAt })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
            id: item.id, workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, commandId: item.commandId,
            baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId, artifactId: item.artifactId, kind: item.kind, variantId: item.variantId,
            status: item.status, dependencyTypesJson: stableSerialize(item.dependencyTypes), affectedRangesJson: stableSerialize(item.affectedRanges),
            impactHash: item.impactHash, createdAt: new Date(item.createdAt),
          })) })
        }
        // The objective of the project is set by this revision when it names one: only while the project has none, or while no Director run has judged against it.
        const setsObjective = bundle.command.payload.change.objective === 'set'
        if (setsObjective) {
          if (typeof bundle.command.payload.objective !== 'string') throw new DomainError('PERSISTENCE_CONFLICT', 'An editorial request revision that sets the objective must state it')
          if (projectRow.objective !== null && (await transaction.v2DirectorRun.count({ where: { workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId } })) > 0) {
            throw new DomainError('VERSION_CONFLICT', 'The Director judged the project against its objective before the editorial request revision commit')
          }
        }
        const updated = await transaction.v2Project.updateMany({
          where: { id: bundle.command.projectId, workspaceId: bundle.command.workspaceId, currentVersionId: bundle.command.baseVersionId, ...(setsObjective ? { objective: projectRow.objective } : {}) },
          data: { currentVersionId: bundle.version.id, ...(setsObjective ? { objective: bundle.command.payload.objective as string } : {}) },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during the editorial request revision')
        await transaction.v2PublicEventOutbox.create({ data: {
          id: bundle.event.id, workspaceId: bundle.event.workspaceId, type: bundle.event.type, version: bundle.event.version,
          occurredAt: new Date(bundle.event.occurredAt), sequence: bundle.event.sequence,
          actorClientId: bundle.event.actor?.clientId, actorUserId: bundle.event.actor?.userId,
          resourceType: bundle.event.resource.type, resourceId: bundle.event.resource.id, dataJson: stableSerialize(bundle.event.data),
        } })
        await settleDeferredOutputGuards(transaction)
        const stored = await transaction.v2EditCommand.findUniqueOrThrow({ where: { id: bundle.command.id }, include: storedCommandInclude })
        return hydrateStoredCommand(stored, objective, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000 })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && serializationAttempt < 3) return this.commitOrReplay(input, serializationAttempt + 1)
      if (isPrismaCode(error, 'P2002')) {
        const existing = await this.findIdempotent({
          workspaceId: bundle.command.workspaceId, projectId: bundle.command.projectId, idempotencyKey: bundle.command.idempotencyKey,
          actorContextHash: authenticationAudit.contextHash,
        })
        if (existing?.requestFingerprint === bundle.requestFingerprint) return existing.result
        if (existing) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different editorial request')
        throw new DomainError('PERSISTENCE_CONFLICT', 'Editorial request revision collided with immutable state')
      }
      throw error
    }
  }
}

import { createHash } from 'node:crypto'
import { Prisma, type PrismaClient, type V2ProjectLutSelection, type V2ProjectVersion, type V2WorkspaceLutVersion } from '../../../../generated/prisma-v2/index.js'
import type { ProjectLutSelectionCommandPayloadV2, ProjectLutSelectionCommit, ProjectLutSelectionContext, ProjectLutSelectionRepository, ProjectLutSelectionResult } from '../../application/ports/project-lut-selection-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { DomainError } from '../../domain/errors.ts'
import { createProjectLutSelection, type ProjectLutSelection, type ProjectLutSelectionRequest } from '../../domain/project-lut-selection.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import { createWorkspaceLutVersion, type LutColorSpace, type LutLicensePolicy } from '../../domain/workspace-lut.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { createProjectLutSelectionInvalidations, parseProjectLutSelectionImpact } from '../../domain/project-lut-selection-impact.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'

const selectionInclude = Prisma.validator<Prisma.V2ProjectLutSelectionInclude>()({
  command: { include: { artifactInvalidations: true } },
  resultVersion: true,
  resolvedLutVersion: true,
})
type StoredSelection = Prisma.V2ProjectLutSelectionGetPayload<{ include: typeof selectionInclude }>
type DbClient = PrismaClient | Prisma.TransactionClient

function parse(value: string, field: string): Record<string, unknown> {
  try { const result = JSON.parse(value) as unknown; if (!result || typeof result !== 'object' || Array.isArray(result) || stableSerialize(result) !== value) throw new Error('invalid'); return result as Record<string, unknown> }
  catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`) }
}

function parseTags(value: string): string[] {
  try {
    const result = JSON.parse(value) as unknown
    if (!Array.isArray(result) || !result.every((tag) => typeof tag === 'string') || stableSerialize(result) !== value) throw new Error('invalid')
    return result
  } catch { throw new DomainError('PERSISTENCE_CONFLICT', 'Stored selected LUT tags are invalid') }
}

function parseArray(value: string, field: string): unknown[] {
  try { const result = JSON.parse(value) as unknown; if (!Array.isArray(result) || stableSerialize(result) !== value) throw new Error('invalid'); return result }
  catch { throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`) }
}

function hydrateVersion(row: V2ProjectVersion) {
  return createProjectVersion({
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, sequence: row.sequence,
    ...(row.parentVersionId ? { parentVersionId: row.parentVersionId } : {}),
    ...(row.forkedFromProjectId ? { forkedFromProjectId: row.forkedFromProjectId } : {}),
    ...(row.forkedFromVersionId ? { forkedFromVersionId: row.forkedFromVersionId } : {}),
    snapshotRefs: { brief: row.briefSnapshotId, ...(row.treatmentSnapshotId ? { treatment: row.treatmentSnapshotId } : {}), ...(row.storySnapshotId ? { story: row.storySnapshotId } : {}), editPlan: row.editPlanSnapshotId, policies: row.policiesSnapshotId },
    baseHash: row.baseHash, createdBy: row.createdBy, ...(row.commandId ? { commandId: row.commandId } : {}), createdAt: row.createdAt.toISOString(),
  })
}

function hydrateLut(row: V2WorkspaceLutVersion) {
  const preview = Buffer.from(row.previewPng)
  if (preview.byteLength !== row.previewByteSize || createHash('sha256').update(preview).digest('hex') !== row.previewSha256) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored selected LUT preview is invalid')
  const value = createWorkspaceLutVersion({
    id: row.id, workspaceId: row.workspaceId, lutId: row.lutId, version: row.version, name: row.name, owner: row.owner,
    license: { policy: row.licensePolicy as LutLicensePolicy, name: row.licenseName, ...(row.licenseUsageNotes ? { usageNotes: row.licenseUsageNotes } : {}) },
    tags: parseTags(row.tagsJson), compatibility: { inputColorSpace: row.inputColorSpace as LutColorSpace, outputColorSpace: row.outputColorSpace as LutColorSpace },
    intensity: row.intensityDefault, cubeContent: row.cubeContent, preview: { byteSize: row.previewByteSize, sha256: row.previewSha256 },
    createdByClientId: row.createdByClientId, createdAt: row.createdAt.toISOString(),
  })
  if (value.recordHash !== row.recordHash || value.cube.contentHash !== row.cubeContentHash) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored selected LUT identity is invalid')
  return value
}

function hydrate(row: StoredSelection, replayed: boolean): Readonly<ProjectLutSelectionResult> {
  const raw = parse(row.selectionJson, 'project LUT selection') as unknown as ProjectLutSelection
  const selection = createProjectLutSelection({
    id: raw.id, workspaceId: raw.workspaceId, projectId: raw.projectId, baseVersionId: raw.baseVersionId, resultVersionId: raw.resultVersionId,
    commandId: raw.commandId, requested: raw.requested, resolved: raw.resolved, ...(raw.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: raw.workspaceDefaultRevision } : {}), intensity: raw.intensity, createdAt: raw.createdAt,
  })
  const requestedLutId = selection.requested.mode === 'lut-version' ? selection.requested.lutId : null
  const requestedLutVersion = selection.requested.mode === 'lut-version' ? selection.requested.version : null
  const resolvedLutVersionId = selection.resolved.mode === 'lut-version' ? selection.resolved.lut.versionId : null
  if (
    selection.selectionHash !== row.selectionHash || stableSerialize(selection) !== row.selectionJson ||
    row.id !== selection.id || row.workspaceId !== selection.workspaceId || row.projectId !== selection.projectId ||
    row.commandId !== selection.commandId || row.baseVersionId !== selection.baseVersionId || row.resultVersionId !== selection.resultVersionId ||
    row.requestedMode !== selection.requested.mode || row.requestedLutId !== requestedLutId || row.requestedLutVersion !== requestedLutVersion ||
    row.resolvedMode !== selection.resolved.mode || row.resolvedLutVersionId !== resolvedLutVersionId ||
    row.workspaceDefaultRevision !== (selection.workspaceDefaultRevision ?? null) || row.intensity !== selection.intensity ||
    row.createdAt.toISOString() !== selection.createdAt
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project LUT selection projections are invalid')
  if (selection.resolved.mode === 'lut-version' && (!row.resolvedLutVersion || row.resolvedLutVersion.id !== selection.resolved.lut.versionId || hydrateLut(row.resolvedLutVersion).recordHash !== selection.resolved.lut.recordHash)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project LUT resolution is invalid')
  const commandRow = row.command
  const payload = parse(commandRow.payloadJson, 'project LUT command payload') as unknown as ProjectLutSelectionCommandPayloadV2
  const impact = parseProjectLutSelectionImpact(payload.impact)
  const command = createEditCommand<ProjectLutSelectionCommandPayloadV2>({
    id: commandRow.id, workspaceId: commandRow.workspaceId, projectId: commandRow.projectId, baseVersionId: commandRow.baseVersionId, baseHash: commandRow.baseHash,
    author: { type: commandRow.actorType as 'user' | 'director' | 'system' | 'api-client', id: commandRow.actorId, ...(commandRow.delegatedUserId ? { delegatedUserId: commandRow.delegatedUserId } : {}) },
    type: commandRow.type, scope: parse(commandRow.scopeJson, 'project LUT command scope') as EditScope,
    payload,
    ...(commandRow.reason ? { reason: commandRow.reason } : {}), idempotencyKey: commandRow.idempotencyKey, createdAt: commandRow.createdAt.toISOString(),
  })
  const version = hydrateVersion(row.resultVersion)
  const expectedPayload = { schemaVersion: 2, ...selection.requested, intensity: selection.intensity, impact }
  if (
    command.type !== 'set-project-lut-selection' || stableSerialize(command.payload) !== stableSerialize(expectedPayload) ||
    impact.commandId !== command.id || impact.baseVersionId !== selection.baseVersionId ||
    impact.resultVersionId !== selection.resultVersionId || impact.selectionId !== selection.id ||
    impact.selectionHash !== selection.selectionHash || impact.resolvedMode !== selection.resolved.mode ||
    impact.resolvedLutVersionId !== (selection.resolved.mode === 'lut-version' ? selection.resolved.lut.versionId : null) ||
    impact.resolvedLutRecordHash !== (selection.resolved.mode === 'lut-version' ? selection.resolved.lut.recordHash : null) ||
    impact.intensity !== selection.intensity ||
    command.workspaceId !== selection.workspaceId || command.projectId !== selection.projectId || command.baseVersionId !== selection.baseVersionId ||
    version.workspaceId !== selection.workspaceId || version.projectId !== selection.projectId || version.parentVersionId !== selection.baseVersionId ||
    version.commandId !== command.id || selection.commandId !== command.id || selection.resultVersionId !== version.id
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project LUT command lineage is invalid')
  const expectedInvalidations = createProjectLutSelectionInvalidations({ impact, createdAt: command.createdAt })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = commandRow.artifactInvalidations.map((item) => parseCommandArtifactInvalidation({
    schemaVersion: 'command-artifact-invalidation/v1', id: item.id, status: item.status,
    commandId: item.commandId, baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId,
    artifactId: item.artifactId, kind: item.kind, variantId: item.variantId,
    dependencyTypes: parseArray(item.dependencyTypesJson, 'project LUT invalidation dependencies'),
    affectedRanges: parseArray(item.affectedRangesJson, 'project LUT invalidation ranges'),
    impactHash: item.impactHash, createdAt: item.createdAt.toISOString(),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project LUT invalidations are inconsistent')
  return Object.freeze({ command, version, selection, impact, invalidations: Object.freeze(invalidations), replayed })
}

async function resolve(client: DbClient, input: { workspaceId: string; requested: ProjectLutSelectionRequest }): Promise<Readonly<{ workspaceDefaultRevision?: number; lut?: ReturnType<typeof hydrateLut> }>> {
  if (input.requested.mode === 'none') return Object.freeze({})
  if (input.requested.mode === 'lut-version') {
    const [row, head] = await Promise.all([
      client.v2WorkspaceLutVersion.findUnique({ where: { workspaceId_lutId_version: { workspaceId: input.workspaceId, lutId: input.requested.lutId, version: input.requested.version } } }),
      client.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: input.requested.lutId, workspaceId: input.workspaceId } } }),
    ])
    if (!row || head?.status !== 'active') throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Active requested workspace LUT version was not found')
    return Object.freeze({ lut: hydrateLut(row) })
  }
  const head = await client.v2WorkspaceLutDefault.findUnique({ where: { workspaceId: input.workspaceId } })
  if (!head) return Object.freeze({ workspaceDefaultRevision: 0 })
  const version = await client.v2WorkspaceLutDefaultVersion.findUnique({ where: { id: head.currentVersionId } })
  if (!version || version.workspaceId !== input.workspaceId || version.revision !== head.revision) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT default head is invalid')
  if (version.mode === 'none') return Object.freeze({ workspaceDefaultRevision: version.revision })
  if (!version.lutVersionId) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT default resolution is missing')
  const lut = await client.v2WorkspaceLutVersion.findUnique({ where: { id: version.lutVersionId } })
  if (!lut) throw new DomainError('PERSISTENCE_CONFLICT', 'Workspace LUT default version disappeared')
  const lutHead = await client.v2WorkspaceLut.findUnique({ where: { id_workspaceId: { id: lut.lutId, workspaceId: input.workspaceId } } })
  if (lutHead?.status !== 'active') throw new DomainError('VERSION_CONFLICT', 'Workspace LUT default points to an inactive LUT')
  return Object.freeze({ workspaceDefaultRevision: version.revision, lut: hydrateLut(lut) })
}

export class PrismaProjectLutSelectionRepository implements ProjectLutSelectionRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({ where: { workspaceId_projectId_idempotencyKey: input }, select: { id: true, requestFingerprint: true } })
    if (!command) return null
    const row = await this.client.v2ProjectLutSelection.findUnique({ where: { commandId_workspaceId: { commandId: command.id, workspaceId: input.workspaceId } }, include: selectionInclude })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent project LUT selection disappeared')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrate(row, true) })
  }

  async readContext(input: { workspaceId: string; projectId: string; requested: ProjectLutSelectionRequest }): Promise<Readonly<ProjectLutSelectionContext> | null> {
    const project = await this.client.v2Project.findFirst({ where: { id: input.projectId, workspaceId: input.workspaceId }, include: { currentVersion: { include: { editPlanSnapshot: true } } } })
    if (!project?.currentVersion) return null
    const [resolved, proxyOutputs, finalOutputs] = await Promise.all([
      resolve(this.client, { workspaceId: input.workspaceId, requested: input.requested }),
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true },
      }),
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
        select: { outputArtifactId: true, outputAspectRatio: true },
      }),
    ])
    const editPlan = parse(project.currentVersion.editPlanSnapshot.contentJson, 'current project LUT EditPlan')
    const currentDurationFrames = Number(editPlan.durationFrames)
    if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames < 0 || !project.format) throw new DomainError('PERSISTENCE_CONFLICT', 'Project LUT render context is incomplete')
    if (currentDurationFrames === 0 && (proxyOutputs.length > 0 || finalOutputs.length > 0)) throw new DomainError('PERSISTENCE_CONFLICT', 'Project outputs exist before a renderable timeline')
    return Object.freeze({
      currentVersion: hydrateVersion(project.currentVersion),
      ...(resolved.workspaceDefaultRevision !== undefined ? { workspaceDefaultRevision: resolved.workspaceDefaultRevision } : {}),
      ...(resolved.lut ? { resolvedLutVersion: resolved.lut } : {}),
      currentDurationFrames,
      proxyVariantId: project.format,
      outputReferences: Object.freeze([
        ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: project.currentVersion!.id, variantId: project.format! })),
        ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: project.currentVersion!.id, variantId: output.outputAspectRatio })),
      ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
    })
  }

  async readCurrent(input: { workspaceId: string; projectId: string }) {
    const head = await this.client.v2ProjectLutSelectionHead.findUnique({ where: { projectId_workspaceId: { projectId: input.projectId, workspaceId: input.workspaceId } } })
    if (!head) return null
    const row = await this.client.v2ProjectLutSelection.findUnique({ where: { id: head.selectionId }, include: selectionInclude })
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId) throw new DomainError('PERSISTENCE_CONFLICT', 'Project LUT selection head is invalid')
    return hydrate(row, false)
  }

  async readEffectiveForVersion(input: { workspaceId: string; projectId: string; projectVersionId: string }) {
    const lineage = await this.client.$queryRaw<Array<{ selectionId: string }>>(Prisma.sql`
      WITH RECURSIVE lineage AS (
        SELECT "id", "parentVersionId", 0 AS depth
        FROM "project_versions"
        WHERE "id" = ${input.projectVersionId} AND "workspaceId" = ${input.workspaceId} AND "projectId" = ${input.projectId}
        UNION ALL
        SELECT parent."id", parent."parentVersionId", lineage.depth + 1
        FROM "project_versions" parent
        INNER JOIN lineage ON parent."id" = lineage."parentVersionId"
        WHERE parent."workspaceId" = ${input.workspaceId} AND parent."projectId" = ${input.projectId} AND lineage.depth < 999
      )
      SELECT selection."id" AS "selectionId"
      FROM lineage
      INNER JOIN "project_lut_selections" selection
        ON selection."resultVersionId" = lineage."id"
        AND selection."workspaceId" = ${input.workspaceId}
        AND selection."projectId" = ${input.projectId}
      ORDER BY lineage.depth ASC
      LIMIT 1
    `)
    const selectionId = lineage[0]?.selectionId
    if (!selectionId) return null
    const row = await this.client.v2ProjectLutSelection.findUnique({ where: { id: selectionId }, include: selectionInclude })
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId) throw new DomainError('PERSISTENCE_CONFLICT', 'Effective project LUT selection disappeared')
    const result = hydrate(row, false)
    return Object.freeze({ selection: result.selection, ...(row.resolvedLutVersion ? { resolvedLutVersion: hydrateLut(row.resolvedLutVersion) } : {}) })
  }

  async commitOrReplay(input: Readonly<ProjectLutSelectionCommit>, serializationAttempt = 1): Promise<Readonly<ProjectLutSelectionResult>> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const project = await transaction.v2Project.findFirst({ where: { id: input.command.projectId, workspaceId: input.command.workspaceId }, include: { currentVersion: true } })
        if (!project?.currentVersion || project.currentVersion.id !== input.command.baseVersionId || project.currentVersion.baseHash !== input.command.baseHash || input.version.parentVersionId !== project.currentVersion.id || input.version.sequence !== project.currentVersion.sequence + 1) throw new DomainError('VERSION_CONFLICT', 'Project version changed before LUT selection commit')
        const resolved = await resolve(transaction, { workspaceId: input.command.workspaceId, requested: input.selection.requested })
        const expectedLut = input.selection.resolved.mode === 'lut-version' ? input.selection.resolved.lut : undefined
        if ((resolved.workspaceDefaultRevision ?? undefined) !== input.selection.workspaceDefaultRevision || resolved.lut?.id !== expectedLut?.versionId || resolved.lut?.recordHash !== expectedLut?.recordHash) throw new DomainError('VERSION_CONFLICT', 'Project LUT selection resolution changed before commit')
        const [proxyOutputs, finalOutputs] = await Promise.all([
          transaction.v2ProjectProxyRenderOperation.findMany({
            where: { workspaceId: input.command.workspaceId, projectId: input.command.projectId, projectVersionId: input.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true },
          }),
          transaction.v2ProjectFinalExportOperation.findMany({
            where: { workspaceId: input.command.workspaceId, projectId: input.command.projectId, projectVersionId: input.command.baseVersionId, operation: { status: 'succeeded', phase: 'completed' } },
            select: { outputArtifactId: true, outputAspectRatio: true },
          }),
        ])
        const currentOutputs = [
          ...proxyOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: input.command.baseVersionId, variantId: project.format ?? '9:16' })),
          ...finalOutputs.map((output) => ({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: input.command.baseVersionId, variantId: output.outputAspectRatio })),
        ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))
        if (stableSerialize(currentOutputs) !== stableSerialize(input.command.payload.impact.affectedArtifacts)) throw new DomainError('VERSION_CONFLICT', 'Project render outputs changed before LUT selection impact commit')
        await transaction.v2EditCommand.create({ data: {
          id: input.command.id, workspaceId: input.command.workspaceId, projectId: input.command.projectId, baseVersionId: input.command.baseVersionId, baseHash: input.command.baseHash,
          type: input.command.type, scopeJson: stableSerialize(input.command.scope), payloadJson: stableSerialize(input.command.payload), reason: input.command.reason,
          actorType: input.command.author.type, actorId: input.command.author.id, delegatedUserId: input.command.author.delegatedUserId,
          idempotencyKey: input.command.idempotencyKey, requestFingerprint: input.requestFingerprint, createdAt: new Date(input.command.createdAt),
        } })
        await transaction.v2ProjectVersion.create({ data: {
          id: input.version.id, workspaceId: input.version.workspaceId, projectId: input.version.projectId, sequence: input.version.sequence, parentVersionId: input.version.parentVersionId,
          briefSnapshotId: input.version.snapshotRefs.brief!, treatmentSnapshotId: input.version.snapshotRefs.treatment, storySnapshotId: input.version.snapshotRefs.story,
          editPlanSnapshotId: input.version.snapshotRefs.editPlan, policiesSnapshotId: input.version.snapshotRefs.policies, baseHash: input.version.baseHash,
          createdBy: input.version.createdBy, commandId: input.command.id, createdAt: new Date(input.version.createdAt),
        } })
        await transaction.v2ProjectLutSelection.create({ data: {
          id: input.selection.id, workspaceId: input.selection.workspaceId, projectId: input.selection.projectId, commandId: input.selection.commandId,
          baseVersionId: input.selection.baseVersionId, resultVersionId: input.selection.resultVersionId, requestedMode: input.selection.requested.mode,
          requestedLutId: input.selection.requested.mode === 'lut-version' ? input.selection.requested.lutId : undefined,
          requestedLutVersion: input.selection.requested.mode === 'lut-version' ? input.selection.requested.version : undefined,
          resolvedMode: input.selection.resolved.mode, resolvedLutVersionId: input.selection.resolved.mode === 'lut-version' ? input.selection.resolved.lut.versionId : undefined,
          workspaceDefaultRevision: input.selection.workspaceDefaultRevision, intensity: input.selection.intensity,
          selectionJson: stableSerialize(input.selection), selectionHash: input.selection.selectionHash, createdAt: new Date(input.selection.createdAt),
        } })
        const invalidations = createProjectLutSelectionInvalidations({ impact: input.command.payload.impact, createdAt: input.command.createdAt })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
            id: item.id, workspaceId: input.command.workspaceId, projectId: input.command.projectId,
            commandId: item.commandId, baseVersionId: item.baseVersionId, resultVersionId: item.resultVersionId,
            artifactId: item.artifactId, kind: item.kind, variantId: item.variantId, status: item.status,
            dependencyTypesJson: stableSerialize(item.dependencyTypes), affectedRangesJson: stableSerialize(item.affectedRanges),
            impactHash: item.impactHash, createdAt: new Date(item.createdAt),
          })) })
        }
        await transaction.v2ProjectLutSelectionHead.upsert({
          where: { projectId_workspaceId: { projectId: input.selection.projectId, workspaceId: input.selection.workspaceId } },
          create: { projectId: input.selection.projectId, workspaceId: input.selection.workspaceId, selectionId: input.selection.id, updatedAt: new Date(input.selection.createdAt) },
          update: { selectionId: input.selection.id, updatedAt: new Date(input.selection.createdAt) },
        })
        const updated = await transaction.v2Project.updateMany({ where: { id: input.command.projectId, workspaceId: input.command.workspaceId, currentVersionId: input.command.baseVersionId }, data: { currentVersionId: input.version.id } })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during LUT selection')
        await transaction.v2PublicEventOutbox.create({ data: {
          id: input.event.id, workspaceId: input.event.workspaceId, type: input.event.type, version: input.event.version, occurredAt: new Date(input.event.occurredAt), sequence: input.event.sequence,
          actorClientId: input.event.actor?.clientId, actorUserId: input.event.actor?.userId, resourceType: input.event.resource.type, resourceId: input.event.resource.id, dataJson: stableSerialize(input.event.data),
        } })
        const row = await transaction.v2ProjectLutSelection.findUniqueOrThrow({ where: { id: input.selection.id }, include: selectionInclude })
        return hydrate(row, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: input.command.workspaceId, projectId: input.command.projectId, idempotencyKey: input.command.idempotencyKey })
        if (replay?.requestFingerprint === input.requestFingerprint) return replay.result
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another project LUT selection')
        throw new DomainError('VERSION_CONFLICT', 'Project LUT selection conflicted with another write')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) return this.commitOrReplay(input, serializationAttempt + 1)
      throw error
    }
  }
}

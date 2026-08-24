import {
  Prisma,
  type PrismaClient,
  type V2ProjectVersion,
} from '../../../../generated/prisma-v2/index.js'
import type {
  ProjectColorPlanCommit,
  ProjectColorPlanContext,
  ProjectColorPlanRepository,
  ProjectColorPlanResult,
} from '../../application/ports/project-color-plan-repository.ts'
import { createApiAccessAuditContext, type ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import { calculateCanonicalHash, stableSerialize } from '../../domain/canonical-hash.ts'
import type { ColorMetadata } from '../../domain/color-and-export.ts'
import { parseCommandArtifactInvalidation } from '../../domain/command-impact.ts'
import { createEditCommand, type EditScope } from '../../domain/edit-command.ts'
import { requireEditCommandType } from '../../domain/edit-command-registry.ts'
import { DomainError } from '../../domain/errors.ts'
import { parseProjectColorPlan } from '../../domain/project-color-plan.ts'
import {
  createProjectColorPlanInvalidations,
  parseProjectColorPlanImpact,
} from '../../domain/project-color-plan-impact.ts'
import { createProjectVersion } from '../../domain/project-version.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

const colorPlanInclude = Prisma.validator<Prisma.V2ProjectColorPlanInclude>()({
  command: { include: { artifactInvalidations: true } },
  resultVersion: true,
})
type StoredColorPlan = Prisma.V2ProjectColorPlanGetPayload<{ include: typeof colorPlanInclude }>
type DbClient = PrismaClient | Prisma.TransactionClient

function parse(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseArray(value: string, field: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || stableSerialize(parsed) !== value) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function trustedMetadata(value: unknown): Readonly<ColorMetadata> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Trusted source color metadata is invalid')
  }
  const metadata = value as Record<string, unknown>
  const keys = ['bitDepth', 'colorSpace', 'matrix', 'primaries', 'range', 'transfer']
  if (
    stableSerialize(Object.keys(metadata).sort()) !== stableSerialize(keys) ||
    !['colorSpace', 'matrix', 'primaries', 'transfer'].every((key) =>
      typeof metadata[key] === 'string' && (metadata[key] as string).length > 0) ||
    !['full', 'limited'].includes(String(metadata.range)) ||
    !Number.isSafeInteger(metadata.bitDepth) ||
    Number(metadata.bitDepth) < 8 ||
    Number(metadata.bitDepth) > 32
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Trusted source color metadata is invalid')
  return Object.freeze({
    colorSpace: metadata.colorSpace as string,
    transfer: metadata.transfer as string,
    primaries: metadata.primaries as string,
    matrix: metadata.matrix as string,
    range: metadata.range as 'full' | 'limited',
    bitDepth: metadata.bitDepth as number,
  })
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

function hydrateAuthenticationAudit(row: StoredColorPlan['command']): Readonly<ApiAccessAuditContext> | undefined {
  const auditValues = [
    row.actorCredentialId,
    row.actorEnvironment,
    row.actorAuthenticationKind,
    row.actorContextHash,
    row.actorDelegatedIdentityId,
    row.actorWorkspaceRole,
  ]
  if (row.actorType !== 'api-client') {
    if (!['director', 'system'].includes(row.actorType) || auditValues.some((value) => value !== null)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan actor is invalid')
    }
    return undefined
  }
  try {
    if (!row.actorCredentialId || !row.actorEnvironment || !row.actorAuthenticationKind || !row.actorContextHash) throw new Error('missing audit')
    const audit = createApiAccessAuditContext({
      clientId: row.actorId,
      credentialId: row.actorCredentialId,
      workspaceId: row.workspaceId,
      environment: row.actorEnvironment as 'sandbox' | 'production',
      authenticationKind: row.actorAuthenticationKind as 'bearer' | 'ui-session',
      ...(row.delegatedUserId ? { delegatedUserId: row.delegatedUserId } : {}),
      ...(row.actorDelegatedIdentityId ? { delegatedIdentityId: row.actorDelegatedIdentityId } : {}),
      ...(row.actorWorkspaceRole ? { workspaceRole: row.actorWorkspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== row.actorContextHash) throw new Error('hash mismatch')
    return audit
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan audit is invalid')
  }
}

function commandAuditData(audit: Readonly<ApiAccessAuditContext> | undefined) {
  return audit ? {
    actorCredentialId: audit.credentialId,
    actorEnvironment: audit.environment,
    actorAuthenticationKind: audit.authenticationKind,
    actorContextHash: audit.contextHash,
    actorDelegatedIdentityId: audit.delegatedIdentityId,
    actorWorkspaceRole: audit.workspaceRole,
  } : {}
}

function assertCommitAudit(input: Readonly<ProjectColorPlanCommit>): void {
  if (input.command.author.type === 'api-client') {
    if (
      !input.authenticationAudit ||
      input.authenticationAudit.clientId !== input.command.author.id ||
      input.authenticationAudit.workspaceId !== input.command.workspaceId ||
      input.authenticationAudit.delegatedUserId !== input.command.author.delegatedUserId
    ) throw new DomainError('AUTH_INVALID', 'Project ColorPlan audit does not match its author')
  } else if (input.authenticationAudit) {
    throw new DomainError('AUTH_INVALID', 'Internal Project ColorPlan command cannot carry an external audit')
  }
}

function hydrate(row: StoredColorPlan, replayed: boolean): Readonly<ProjectColorPlanResult> {
  const authenticationAudit = hydrateAuthenticationAudit(row.command)
  const colorPlan = parseProjectColorPlan(parse(row.recordJson, 'project ColorPlan record'))
  if (
    colorPlan.id !== row.id ||
    colorPlan.workspaceId !== row.workspaceId ||
    colorPlan.projectId !== row.projectId ||
    colorPlan.commandId !== row.commandId ||
    colorPlan.baseVersionId !== row.baseVersionId ||
    colorPlan.resultVersionId !== row.resultVersionId ||
    colorPlan.schemaVersion !== row.schemaVersion ||
    stableSerialize(colorPlan.plan) !== row.planJson ||
    colorPlan.plan.planHash !== row.planHash ||
    stableSerialize(colorPlan.compiled) !== row.compiledManifestJson ||
    colorPlan.compiled.manifestHash !== row.compiledManifestHash ||
    colorPlan.recordHash !== row.recordHash
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan projections are inconsistent')
  const payload = parse(row.command.payloadJson, 'project ColorPlan command payload')
  const impact = parseProjectColorPlanImpact(payload.impact)
  const command = createEditCommand({
    id: row.command.id,
    workspaceId: row.command.workspaceId,
    projectId: row.command.projectId,
    baseVersionId: row.command.baseVersionId,
    baseHash: row.command.baseHash,
    author: {
      type: row.command.actorType as 'director' | 'system' | 'api-client',
      id: row.command.actorId,
      ...(row.command.delegatedUserId ? { delegatedUserId: row.command.delegatedUserId } : {}),
    },
    type: requireEditCommandType(row.command.type),
    scope: parse(row.command.scopeJson, 'project ColorPlan command scope') as EditScope,
    payload: payload as never,
    ...(row.command.reason ? { reason: row.command.reason } : {}),
    idempotencyKey: row.command.idempotencyKey,
    createdAt: row.command.createdAt.toISOString(),
  })
  const version = hydrateVersion(row.resultVersion)
  const expectedPayload = {
    schemaVersion: 1,
    colorPlanId: colorPlan.id,
    colorPlanHash: colorPlan.plan.planHash,
    compiledManifestHash: colorPlan.compiled.manifestHash,
    impact,
  }
  if (
    command.type !== 'set-project-color-plan' ||
    stableSerialize(command.payload) !== stableSerialize(expectedPayload) ||
    impact.commandId !== command.id ||
    impact.baseVersionId !== colorPlan.baseVersionId ||
    impact.resultVersionId !== colorPlan.resultVersionId ||
    impact.colorPlanId !== colorPlan.id ||
    impact.colorPlanHash !== colorPlan.plan.planHash ||
    impact.compiledManifestHash !== colorPlan.compiled.manifestHash ||
    command.workspaceId !== colorPlan.workspaceId ||
    command.projectId !== colorPlan.projectId ||
    version.parentVersionId !== colorPlan.baseVersionId ||
    version.id !== colorPlan.resultVersionId ||
    version.commandId !== command.id
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan lineage is invalid')
  if (authenticationAudit && authenticationAudit.contextHash !== row.command.actorContextHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan authentication changed')
  }
  const expectedInvalidations = createProjectColorPlanInvalidations({ impact, createdAt: command.createdAt })
    .toSorted((left, right) => left.id.localeCompare(right.id))
  const invalidations = row.command.artifactInvalidations.map((item) =>
    parseCommandArtifactInvalidation({
      schemaVersion: 'command-artifact-invalidation/v1',
      id: item.id,
      status: item.status,
      commandId: item.commandId,
      baseVersionId: item.baseVersionId,
      resultVersionId: item.resultVersionId,
      artifactId: item.artifactId,
      kind: item.kind,
      variantId: item.variantId,
      dependencyTypes: parseArray(item.dependencyTypesJson, 'project ColorPlan invalidation dependencies'),
      affectedRanges: parseArray(item.affectedRangesJson, 'project ColorPlan invalidation ranges'),
      impactHash: item.impactHash,
      createdAt: item.createdAt.toISOString(),
    })).toSorted((left, right) => left.id.localeCompare(right.id))
  if (stableSerialize(expectedInvalidations) !== stableSerialize(invalidations)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project ColorPlan invalidations are inconsistent')
  }
  return Object.freeze({ command, version, colorPlan, impact, invalidations: Object.freeze(invalidations), replayed })
}

function targetsFromEditPlan(editPlan: Record<string, unknown>) {
  const tracks = Array.isArray(editPlan.videoTracks) ? editPlan.videoTracks : []
  const baseTrack = tracks.find((track) => track && typeof track === 'object' && (track as { kind?: unknown }).kind === 'base-video') as { clips?: unknown } | undefined
  const clips = Array.isArray(baseTrack?.clips) ? baseTrack.clips : []
  const targets = clips.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new DomainError('PERSISTENCE_CONFLICT', `EditPlan clip ${index} is invalid`)
    const clip = raw as Record<string, unknown>
    if (typeof clip.id !== 'string' || typeof clip.sourceArtifactId !== 'string') throw new DomainError('PERSISTENCE_CONFLICT', `EditPlan clip ${index} has no color target identity`)
    return Object.freeze({
      sourceId: clip.sourceArtifactId.trim().toLowerCase(),
      ...(typeof clip.cameraId === 'string' ? { cameraId: clip.cameraId.trim().toLowerCase() } : {}),
      segmentId: clip.id.trim().toLowerCase(),
    })
  })
  if (targets.length < 1 || new Set(targets.map((target) => stableSerialize(target))).size !== targets.length) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'EditPlan ColorPlan targets are missing or duplicated')
  }
  return Object.freeze(targets)
}

function creativeLutRefs(colorPlan: ProjectColorPlanCommit['colorPlan']) {
  return [...new Map(colorPlan.compiled.targets.flatMap((target) => {
    const stage = target.stages.find((candidate) => candidate.kind === 'creative-lut')!
    return stage.enabled && stage.lut ? [[stage.lut.artifactId, stage.lut] as const] : []
  })).values()]
}

async function readContext(client: DbClient, input: { workspaceId: string; projectId: string }): Promise<Readonly<ProjectColorPlanContext> | null> {
  const project = await client.v2Project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId },
    include: { currentVersion: { include: { editPlanSnapshot: true } } },
  })
  if (!project?.currentVersion || !project.format) return null
  const editPlan = parse(project.currentVersion.editPlanSnapshot.contentJson, 'project ColorPlan EditPlan')
  const targets = targetsFromEditPlan(editPlan)
  const sourceIds = [...new Set(targets.map((target) => target.sourceId))].sort()
  const [proxyOutputs, finalOutputs, colorCompilations] = await Promise.all([
    client.v2ProjectProxyRenderOperation.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
      select: { outputArtifactId: true },
    }),
    client.v2ProjectFinalExportOperation.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: project.currentVersion.id, operation: { status: 'succeeded', phase: 'completed' } },
      select: { outputArtifactId: true, outputAspectRatio: true },
    }),
    client.v2ColorPipelineCompilation.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        sourceArtifactId: { in: sourceIds },
      },
      select: {
        sourceArtifactId: true,
        compilationJson: true,
        compilationHash: true,
        pipelineHash: true,
      },
    }),
  ])
  const trustedSourceMetadata: Record<string, Readonly<ColorMetadata>> = {}
  for (const sourceId of sourceIds) {
    const candidates = colorCompilations.filter((row) => row.sourceArtifactId === sourceId)
    if (candidates.length !== 1) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Every ColorPlan source requires one unambiguous trusted color compilation',
        { sourceArtifactId: sourceId, compilationCount: candidates.length },
      )
    }
    const row = candidates[0]!
    const compilation = parse(row.compilationJson, 'trusted color compilation')
    const pipeline = compilation.pipeline
    if (!pipeline || typeof pipeline !== 'object' || Array.isArray(pipeline)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Trusted color compilation pipeline is invalid')
    }
    const { compilationHash: _storedCompilationHash, ...compilationContent } = compilation
    const pipelineRecord = pipeline as Record<string, unknown>
    const { pipelineHash: _storedPipelineHash, manifestKey: _manifestKey, ...pipelineContent } = pipelineRecord
    if (
      compilation.compilationHash !== row.compilationHash ||
      calculateCanonicalHash(compilationContent) !== row.compilationHash ||
      pipelineRecord.pipelineHash !== row.pipelineHash ||
      calculateCanonicalHash(pipelineContent) !== row.pipelineHash ||
      !pipelineRecord.sourceMetadata ||
      typeof pipelineRecord.sourceMetadata !== 'object' ||
      Array.isArray(pipelineRecord.sourceMetadata)
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Trusted color compilation hashes are invalid')
    trustedSourceMetadata[sourceId] = trustedMetadata(pipelineRecord.sourceMetadata)
  }
  const currentDurationFrames = Number(editPlan.durationFrames)
  if (!Number.isSafeInteger(currentDurationFrames) || currentDurationFrames < 0) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Project ColorPlan timeline is invalid')
  }
  if (currentDurationFrames === 0 && (proxyOutputs.length > 0 || finalOutputs.length > 0)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Project outputs exist before a ColorPlan timeline')
  }
  return Object.freeze({
    currentVersion: hydrateVersion(project.currentVersion),
    targets,
    trustedSourceMetadata: Object.freeze(trustedSourceMetadata),
    currentDurationFrames,
    proxyVariantId: project.format,
    outputReferences: Object.freeze([
      ...proxyOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'proxy' as const, sourceVersionId: project.currentVersion!.id, variantId: project.format! })),
      ...finalOutputs.map((output) => Object.freeze({ artifactId: output.outputArtifactId, kind: 'final' as const, sourceVersionId: project.currentVersion!.id, variantId: output.outputAspectRatio })),
    ].toSorted((left, right) => `${left.kind}:${left.artifactId}`.localeCompare(`${right.kind}:${right.artifactId}`))),
  })
}

export class PrismaProjectColorPlanRepository implements ProjectColorPlanRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const command = await this.client.v2EditCommand.findUnique({
      where: { workspaceId_projectId_idempotencyKey: input },
      select: { id: true, requestFingerprint: true },
    })
    if (!command) return null
    const row = await this.client.v2ProjectColorPlan.findUnique({
      where: { commandId_workspaceId: { commandId: command.id, workspaceId: input.workspaceId } },
      include: colorPlanInclude,
    })
    if (!row) throw new DomainError('PERSISTENCE_CONFLICT', 'Idempotent project ColorPlan disappeared')
    return Object.freeze({ requestFingerprint: command.requestFingerprint, result: hydrate(row, true) })
  }

  readContext(input: { workspaceId: string; projectId: string }) {
    return readContext(this.client, input)
  }

  async readCurrent(input: { workspaceId: string; projectId: string }) {
    const head = await this.client.v2ProjectColorPlanHead.findUnique({
      where: { projectId_workspaceId: { projectId: input.projectId, workspaceId: input.workspaceId } },
    })
    if (!head) return null
    const row = await this.client.v2ProjectColorPlan.findUnique({ where: { id: head.colorPlanId }, include: colorPlanInclude })
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project ColorPlan head is invalid')
    }
    return hydrate(row, false)
  }

  async readEffectiveForVersion(input: { workspaceId: string; projectId: string; projectVersionId: string }) {
    const lineage = await this.client.$queryRaw<Array<{ colorPlanId: string }>>(Prisma.sql`
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
      SELECT color_plan."id" AS "colorPlanId"
      FROM lineage
      INNER JOIN "project_color_plans" color_plan
        ON color_plan."resultVersionId" = lineage."id"
        AND color_plan."workspaceId" = ${input.workspaceId}
        AND color_plan."projectId" = ${input.projectId}
      ORDER BY lineage.depth ASC
      LIMIT 1
    `)
    const colorPlanId = lineage[0]?.colorPlanId
    if (!colorPlanId) return null
    const row = await this.client.v2ProjectColorPlan.findUnique({ where: { id: colorPlanId }, include: colorPlanInclude })
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Effective project ColorPlan disappeared')
    }
    return hydrate(row, false).colorPlan
  }

  async commitOrReplay(input: Readonly<ProjectColorPlanCommit>, serializationAttempt = 1): Promise<Readonly<ProjectColorPlanResult>> {
    assertCommitAudit(input)
    try {
      return await this.client.$transaction(async (transaction) => {
        const context = await readContext(transaction, { workspaceId: input.command.workspaceId, projectId: input.command.projectId })
        if (
          !context ||
          context.currentVersion.id !== input.command.baseVersionId ||
          context.currentVersion.baseHash !== input.command.baseHash ||
          input.version.parentVersionId !== context.currentVersion.id ||
          input.version.sequence !== context.currentVersion.sequence + 1 ||
          stableSerialize(context.targets.map((target) => stableSerialize(target)).toSorted()) !==
            stableSerialize(input.colorPlan.compiled.targets.map((target) => stableSerialize(target.target)).toSorted()) ||
          stableSerialize(context.outputReferences) !== stableSerialize(input.command.payload.impact.affectedArtifacts)
        ) throw new DomainError('VERSION_CONFLICT', 'Project ColorPlan context changed before commit')
        const lutRefs = creativeLutRefs(input.colorPlan)
        if (lutRefs.length > 0) {
          const versions = await transaction.v2WorkspaceLutVersion.findMany({
            where: { workspaceId: input.command.workspaceId, id: { in: lutRefs.map((ref) => ref.artifactId) } },
            select: { id: true, lutId: true, cubeContentHash: true, licensePolicy: true },
          })
          const heads = await transaction.v2WorkspaceLut.findMany({
            where: { workspaceId: input.command.workspaceId, id: { in: versions.map((version) => version.lutId) } },
            select: { id: true, status: true },
          })
          if (lutRefs.some((ref) => {
            const version = versions.find((candidate) => candidate.id === ref.artifactId)
            const head = version ? heads.find((candidate) => candidate.id === version.lutId) : null
            return !version || version.cubeContentHash !== ref.sha256 || !head || head.status !== 'active' || !['owned', 'licensed'].includes(version.licensePolicy)
          })) throw new DomainError('VERSION_CONFLICT', 'ColorPlan creative LUT availability changed before commit')
        }
        await transaction.v2EditCommand.create({ data: {
          id: input.command.id,
          workspaceId: input.command.workspaceId,
          projectId: input.command.projectId,
          baseVersionId: input.command.baseVersionId,
          baseHash: input.command.baseHash,
          type: input.command.type,
          scopeJson: stableSerialize(input.command.scope),
          payloadJson: stableSerialize(input.command.payload),
          reason: input.command.reason,
          actorType: input.command.author.type,
          actorId: input.command.author.id,
          delegatedUserId: input.command.author.delegatedUserId,
          ...commandAuditData(input.authenticationAudit),
          idempotencyKey: input.command.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          createdAt: new Date(input.command.createdAt),
        } })
        await transaction.v2ProjectVersion.create({ data: {
          id: input.version.id,
          workspaceId: input.version.workspaceId,
          projectId: input.version.projectId,
          sequence: input.version.sequence,
          parentVersionId: input.version.parentVersionId,
          briefSnapshotId: input.version.snapshotRefs.brief!,
          treatmentSnapshotId: input.version.snapshotRefs.treatment,
          storySnapshotId: input.version.snapshotRefs.story,
          editPlanSnapshotId: input.version.snapshotRefs.editPlan,
          policiesSnapshotId: input.version.snapshotRefs.policies,
          baseHash: input.version.baseHash,
          createdBy: input.version.createdBy,
          commandId: input.command.id,
          createdAt: new Date(input.version.createdAt),
        } })
        await transaction.v2ProjectColorPlan.create({ data: {
          id: input.colorPlan.id,
          workspaceId: input.colorPlan.workspaceId,
          projectId: input.colorPlan.projectId,
          commandId: input.colorPlan.commandId,
          baseVersionId: input.colorPlan.baseVersionId,
          resultVersionId: input.colorPlan.resultVersionId,
          schemaVersion: input.colorPlan.schemaVersion,
          planJson: stableSerialize(input.colorPlan.plan),
          planHash: input.colorPlan.plan.planHash,
          compiledManifestJson: stableSerialize(input.colorPlan.compiled),
          compiledManifestHash: input.colorPlan.compiled.manifestHash,
          recordJson: stableSerialize(input.colorPlan),
          recordHash: input.colorPlan.recordHash,
          createdAt: new Date(input.colorPlan.createdAt),
        } })
        const invalidations = createProjectColorPlanInvalidations({ impact: input.command.payload.impact, createdAt: input.command.createdAt })
        if (invalidations.length > 0) {
          await transaction.v2CommandArtifactInvalidation.createMany({ data: invalidations.map((item) => ({
            id: item.id,
            workspaceId: input.command.workspaceId,
            projectId: input.command.projectId,
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
        }
        await transaction.v2ProjectColorPlanHead.upsert({
          where: { projectId_workspaceId: { projectId: input.colorPlan.projectId, workspaceId: input.colorPlan.workspaceId } },
          create: { projectId: input.colorPlan.projectId, workspaceId: input.colorPlan.workspaceId, colorPlanId: input.colorPlan.id, updatedAt: new Date(input.colorPlan.createdAt) },
          update: { colorPlanId: input.colorPlan.id, updatedAt: new Date(input.colorPlan.createdAt) },
        })
        const updated = await transaction.v2Project.updateMany({
          where: { id: input.command.projectId, workspaceId: input.command.workspaceId, currentVersionId: input.command.baseVersionId },
          data: { currentVersionId: input.version.id },
        })
        if (updated.count !== 1) throw new DomainError('VERSION_CONFLICT', 'Project current version changed during ColorPlan commit')
        await transaction.v2PublicEventOutbox.create({ data: {
          id: input.event.id,
          workspaceId: input.event.workspaceId,
          type: input.event.type,
          version: input.event.version,
          occurredAt: new Date(input.event.occurredAt),
          sequence: input.event.sequence,
          actorClientId: input.event.actor?.clientId,
          actorUserId: input.event.actor?.userId,
          resourceType: input.event.resource.type,
          resourceId: input.event.resource.id,
          dataJson: stableSerialize(input.event.data),
        } })
        const row = await transaction.v2ProjectColorPlan.findUniqueOrThrow({ where: { id: input.colorPlan.id }, include: colorPlanInclude })
        return hydrate(row, false)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findIdempotent({ workspaceId: input.command.workspaceId, projectId: input.command.projectId, idempotencyKey: input.command.idempotencyKey })
        if (replay?.requestFingerprint === input.requestFingerprint) return replay.result
        if (replay) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with another project ColorPlan')
        throw new DomainError('VERSION_CONFLICT', 'Project ColorPlan conflicted with another write')
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && serializationAttempt < 3) {
        return this.commitOrReplay(input, serializationAttempt + 1)
      }
      throw error
    }
  }
}

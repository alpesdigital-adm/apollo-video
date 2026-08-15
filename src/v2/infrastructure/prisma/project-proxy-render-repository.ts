import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProjectProxyRenderRepository, ProjectProxyRenderSource } from '../../application/ports/project-proxy-render-repository.ts'
import { MAX_PARTIAL_RENDER_RANGES } from '../../application/ports/project-proxy-render-repository.ts'
import type { ProxyQualityIssue } from '../../application/render-workflow.ts'
import { calculateVersionHash } from '../../application/version-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  parseCommandArtifactInvalidation,
  parseCommandImpact,
} from '../../domain/command-impact.ts'
import { editCommandRenderPolicy } from '../../domain/edit-command-registry.ts'

function parseRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseCriticIssues(value: string | undefined): readonly Readonly<ProxyQualityIssue>[] {
  if (!value) return Object.freeze([])
  const quality = parseRecord(value, 'project proxy QualityReport')
  if (!Array.isArray(quality.issues)) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport is invalid')
  return Object.freeze(quality.issues.map((candidate) => {
    if (
      typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) ||
      typeof candidate.code !== 'string' ||
      !['hard', 'warning'].includes(String(candidate.severity)) ||
      !['technical', 'policy', 'integrity', 'editorial'].includes(String(candidate.category)) ||
      typeof candidate.message !== 'string' ||
      typeof candidate.correctable !== 'boolean'
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport issue is invalid')
    const range = candidate.rangeMs
    const evidenceRange = candidate.evidenceRange
    if (
      range !== undefined &&
      (!Array.isArray(range) || range.length !== 2 || range.some((item) => !Number.isSafeInteger(item) || item < 0))
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport range is invalid')
    if (evidenceRange !== undefined && (
      typeof evidenceRange !== 'object' || evidenceRange === null || Array.isArray(evidenceRange) ||
      !Number.isSafeInteger((evidenceRange as Record<string, unknown>).startFrame) ||
      !Number.isSafeInteger((evidenceRange as Record<string, unknown>).endFrame) ||
      Number((evidenceRange as Record<string, unknown>).startFrame) < 0 ||
      Number((evidenceRange as Record<string, unknown>).endFrame) <= Number((evidenceRange as Record<string, unknown>).startFrame)
    )) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored project proxy QualityReport evidence range is invalid')
    return Object.freeze({
      code: candidate.code,
      severity: candidate.severity as 'hard' | 'warning',
      category: candidate.category as ProxyQualityIssue['category'],
      message: candidate.message,
      ...(range ? { rangeMs: Object.freeze([range[0], range[1]] as [number, number]) } : {}),
      ...(typeof candidate.targetId === 'string' ? { targetId: candidate.targetId } : {}),
      ...(typeof candidate.outputSpecId === 'string' ? { outputSpecId: candidate.outputSpecId } : {}),
      ...(evidenceRange
        ? { evidenceRange: Object.freeze({ startFrame: Number((evidenceRange as Record<string, unknown>).startFrame), endFrame: Number((evidenceRange as Record<string, unknown>).endFrame) }) }
        : {}),
      ...(Array.isArray(candidate.elementIds) ? { elementIds: Object.freeze(candidate.elementIds.map(String)) } : {}),
      ...(Array.isArray(candidate.evidenceIds) ? { evidenceIds: Object.freeze(candidate.evidenceIds.map(String)) } : {}),
      correctable: candidate.correctable,
    })
  }))
}

function parseArray(value: string, field: string): readonly unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function hydrateSource(
  project: Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>,
  expected?: { sourceArtifactId?: string; sourceManifestId?: string },
): Readonly<ProjectProxyRenderSource> | null {
  const version = project?.versions[0]
  const media = project?.mediaAssets.find((item) =>
    item.role === 'source-master' &&
    (!expected?.sourceArtifactId || item.artifactId === expected.sourceArtifactId))
  const manifest = expected?.sourceManifestId
    ? media?.artifact.manifests.find((item) => item.id === expected.sourceManifestId)
    : media?.artifact.manifests[0]
  if (!project || !version || !media || !manifest) return null
  const editPlan = parseRecord(version.editPlanSnapshot.contentJson, 'project proxy EditPlan') as unknown as EditorialCutEditPlan | DirectedEditPlan
  const manifestBody = parseRecord(manifest.manifestJson, 'project proxy source manifest')
  const artifactBody = manifestBody.artifact
  if (
    editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' ||
    version.editPlanSnapshot.workspaceId !== project.workspaceId ||
    version.editPlanSnapshot.projectId !== project.id ||
    calculateVersionHash(editPlan) !== version.editPlanSnapshot.contentHash ||
    typeof artifactBody !== 'object' || artifactBody === null || Array.isArray(artifactBody) ||
    typeof (artifactBody as Record<string, unknown>).artifactKey !== 'string'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy source is inconsistent')
  const clips = editPlan.videoTracks.find((track) => track.kind === 'base-video')?.clips ?? []
  const referencedArtifactIds = [...new Set(clips.flatMap((clip) => [
    clip.sourceArtifactId,
    clip.audioSourceArtifactId ?? clip.sourceArtifactId,
  ]))].sort()
  const renderSources = referencedArtifactIds.map((artifactId) => {
    const link = project.mediaAssets.find((item) => item.artifactId === artifactId)
    const sourceManifest = link?.artifact.manifests[0]
    const sourceBody = sourceManifest
      ? parseRecord(sourceManifest.manifestJson, `project render source manifest ${sourceManifest.id}`)
      : null
    const sourceArtifact = sourceBody?.artifact
    if (
      !link ||
      !sourceManifest ||
      link.artifact.status !== 'available' ||
      !['video', 'audio'].includes(link.artifact.mediaType) ||
      typeof sourceArtifact !== 'object' ||
      sourceArtifact === null ||
      Array.isArray(sourceArtifact) ||
      typeof (sourceArtifact as Record<string, unknown>).artifactKey !== 'string'
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        `Referenced render source ${artifactId} is unavailable`,
      )
    }
    return Object.freeze({
      artifactId,
      manifestId: sourceManifest.id,
      artifactKey: (sourceArtifact as Record<string, unknown>).artifactKey as string,
      sha256: link.artifact.sha256,
      byteSize: Number(link.artifact.byteSize),
      mediaType: link.artifact.mediaType as 'video' | 'audio',
      container: link.artifact.container,
      role: link.role === 'source-master'
        ? 'source-master' as const
        : 'selected-insert' as const,
    })
  })
  if (!renderSources.some((item) => item.artifactId === media.artifactId)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Compiled EditPlan no longer references its source master audio or video',
    )
  }
  return Object.freeze({
    projectId: project.id,
    projectVersionId: version.id,
    editPlanSnapshotId: version.editPlanSnapshotId,
    editPlanHash: version.editPlanSnapshot.contentHash,
    editPlan: Object.freeze(editPlan),
    format: project.format ?? '9:16',
    sourceArtifactId: media.artifactId,
    sourceManifestId: manifest.id,
    sourceArtifactKey: (artifactBody as Record<string, unknown>).artifactKey as string,
    sourceSha256: media.artifact.sha256,
    renderSources: Object.freeze(renderSources),
    originalFileName: media.originalFileName,
    uploadReceivedAt: (media.upload?.createdAt ?? media.createdAt).toISOString(),
    criticIssues: parseCriticIssues(version.directorRunAsResult?.qualitySnapshot.contentJson),
  })
}

export class PrismaProjectProxyRenderRepository implements ProjectProxyRenderRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  queryProject(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    editPlanSnapshotId?: string
    sourceArtifactId?: string
    sourceManifestId?: string
  }) {
    return this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        format: true,
        currentVersionId: true,
        versions: {
          where: input.projectVersionId
            ? { id: input.projectVersionId, ...(input.editPlanSnapshotId ? { editPlanSnapshotId: input.editPlanSnapshotId } : {}) }
            : { currentForProjects: { some: { id: input.projectId, workspaceId: input.workspaceId } } },
          orderBy: { sequence: 'desc' as const },
          take: 1,
          include: {
            editPlanSnapshot: true,
            directorRunAsResult: { include: { qualitySnapshot: true } },
            command: {
              include: {
                artifactInvalidations: {
                  include: { resolutions: { include: { operation: { select: { status: true } } } } },
                },
              },
            },
          },
        },
        mediaAssets: {
          orderBy: [{ role: 'asc' as const }, { createdAt: 'desc' as const }],
          include: { upload: { select: { createdAt: true } }, artifact: {
            include: {
              manifests: {
                orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
                take: 8,
              },
            },
          } },
        },
      },
    })
  }

  async readCurrentSource(input: { workspaceId: string; projectId: string }) {
    const project = await this.queryProject(input)
    const source = hydrateSource(project)
    return source ? this.attachRangeReuse(input.workspaceId, project!, source) : null
  }

  async readImmutableSource(input: { workspaceId: string; projectId: string; projectVersionId: string; editPlanSnapshotId: string; sourceArtifactId: string; sourceManifestId: string }) {
    const project = await this.queryProject(input)
    const source = hydrateSource(project, input)
    return source ? this.attachRangeReuse(input.workspaceId, project!, source) : null
  }

  private async readReusableProxy(input: {
    workspaceId: string
    projectId: string
    baseVersionId: string
    artifactIds?: readonly string[]
  }) {
    const previous = await this.client.v2ProjectProxyRenderOperation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        projectVersionId: input.baseVersionId,
        ...(input.artifactIds ? { outputArtifactId: { in: [...input.artifactIds] } } : {}),
        operation: { status: 'succeeded', phase: 'completed' },
      },
      orderBy: { createdAt: 'desc' },
      select: { operationId: true, outputArtifactId: true, outputManifestId: true },
    })
    if (!previous) return null
    const artifact = await this.client.v2MediaArtifact.findFirst({
      where: {
        id: previous.outputArtifactId,
        workspaceId: input.workspaceId,
        status: 'available',
      },
      include: {
        manifests: { where: { id: previous.outputManifestId }, take: 1 },
      },
    })
    const manifest = artifact?.manifests[0]
    if (!artifact || !manifest || !Number.isSafeInteger(Number(artifact.byteSize))) return null
    const manifestBody = parseRecord(manifest.manifestJson, 'reusable project proxy manifest')
    const artifactBody = manifestBody.artifact
    if (
      typeof artifactBody !== 'object' || artifactBody === null || Array.isArray(artifactBody) ||
      typeof (artifactBody as Record<string, unknown>).artifactKey !== 'string'
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Reusable project proxy manifest is invalid')
    return Object.freeze({
      operationId: previous.operationId,
      artifactId: artifact.id,
      manifestId: manifest.id,
      artifactKey: (artifactBody as Record<string, unknown>).artifactKey as string,
      sha256: artifact.sha256,
      byteSize: Number(artifact.byteSize),
    })
  }

  private async attachRangeReuse(
    workspaceId: string,
    project: NonNullable<Awaited<ReturnType<PrismaProjectProxyRenderRepository['queryProject']>>>,
    source: Readonly<ProjectProxyRenderSource>,
  ): Promise<Readonly<ProjectProxyRenderSource>> {
    const version = project.versions[0]
    const command = version?.command
    // Range reuse is derived from the canonical registry: only Command types whose
    // declared policy is partial-range may narrow a render to stale ranges.
    if (!version || !command || editCommandRenderPolicy(command.type) !== 'partial-range') return source
    const payload = parseRecord(command.payloadJson, 'project proxy Command payload')
    if (!payload.impact) return source
    const impact = parseCommandImpact(payload.impact)
    if (
      impact.commandId !== command.id ||
      impact.commandType !== command.type ||
      impact.baseVersionId !== command.baseVersionId ||
      impact.resultVersionId !== version.id
    ) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy Command impact identity is inconsistent')
    }
    if (!impact.renderSemanticsChanged) {
      if (
        impact.changeKinds.length !== 1 || impact.changeKinds[0] !== 'selection' ||
        impact.affectedArtifacts.length !== 0 || impact.minimalRenders.length !== 0
      ) throw new DomainError('PERSISTENCE_CONFLICT', 'Render-free Command impact is inconsistent')
      const reusable = await this.readReusableProxy({
        workspaceId,
        projectId: source.projectId,
        baseVersionId: impact.baseVersionId,
      })
      return Object.freeze({
        ...source,
        unchangedReuseRequired: true as const,
        ...(reusable ? { unchangedReuse: Object.freeze({
          schemaVersion: 'project-proxy-unchanged-reuse/v1' as const,
          commandId: command.id,
          impactHash: impact.impactHash,
          baseVersionId: impact.baseVersionId,
          ...reusable,
        }) } : {}),
      })
    }
    const minimalRenders = impact.minimalRenders.filter((render) =>
      render.kind === 'proxy' && render.variantId === source.format)
    if (minimalRenders.length !== 1) return source
    const requestedRanges = minimalRenders[0]!.ranges
    const durationFrames = source.editPlan.durationFrames
    if (
      requestedRanges.length < 1 || requestedRanges.length > MAX_PARTIAL_RENDER_RANGES
    ) return source
    // Clamp each stale range to the compiled duration and require the canonical
    // shape the domain produces: ordered and strictly disjoint. Anything else —
    // including a set that covers the whole timeline — falls back to a full render.
    const ranges: { startFrame: number; endFrame: number }[] = []
    for (const requested of requestedRanges) {
      const startFrame = requested.startFrame
      const endFrame = Math.min(requested.endFrame, durationFrames)
      if (
        !Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) ||
        startFrame < 0 || endFrame <= startFrame
      ) return source
      const previous = ranges.at(-1)
      if (previous && startFrame <= previous.endFrame) return source
      ranges.push({ startFrame, endFrame })
    }
    const staleFrames = ranges.reduce((total, item) => total + item.endFrame - item.startFrame, 0)
    if (ranges.length < 1 || staleFrames >= durationFrames) return source
    const invalidations = command.artifactInvalidations
      .filter((row) => !row.resolutions.some((resolution) => resolution.operation.status === 'succeeded'))
      .map((row) => parseCommandArtifactInvalidation({
        schemaVersion: 'command-artifact-invalidation/v1',
        id: row.id,
        status: row.status,
        commandId: row.commandId,
        baseVersionId: row.baseVersionId,
        resultVersionId: row.resultVersionId,
        artifactId: row.artifactId,
        kind: row.kind,
        variantId: row.variantId,
        dependencyTypes: parseArray(row.dependencyTypesJson, 'proxy invalidation dependencies'),
        affectedRanges: parseArray(row.affectedRangesJson, 'proxy invalidation ranges'),
        impactHash: row.impactHash,
        createdAt: row.createdAt.toISOString(),
      }))
    const proxyArtifactIds = invalidations
      .filter((item) =>
        item.kind === 'proxy' && item.variantId === source.format &&
        item.commandId === command.id && item.baseVersionId === impact.baseVersionId &&
        item.resultVersionId === impact.resultVersionId && item.impactHash === impact.impactHash)
      .map((item) => item.artifactId)
    if (proxyArtifactIds.length === 0) return source
    const reusable = await this.readReusableProxy({
      workspaceId,
      projectId: source.projectId,
      baseVersionId: impact.baseVersionId,
      artifactIds: proxyArtifactIds,
    })
    if (!reusable) return source
    return Object.freeze({
      ...source,
      rangeReuse: Object.freeze({
        schemaVersion: 'project-proxy-range-reuse/v1' as const,
        commandId: command.id,
        impactHash: impact.impactHash,
        baseVersionId: impact.baseVersionId,
        ranges: Object.freeze(ranges.map((item) => Object.freeze(item))),
        artifactId: reusable.artifactId,
        manifestId: reusable.manifestId,
        artifactKey: reusable.artifactKey,
        sha256: reusable.sha256,
        byteSize: reusable.byteSize,
      }),
    })
  }

  async attachCompletedOutput(input: Parameters<ProjectProxyRenderRepository['attachCompletedOutput']>[0]): Promise<void> {
    await this.client.$transaction(async (transaction) => {
      const [operation, artifact, manifest] = await Promise.all([
        transaction.v2ProjectProxyRenderOperation.findFirst({ where: {
          operationId: input.operationId, workspaceId: input.workspaceId, projectId: input.projectId,
          projectVersionId: input.projectVersionId, outputArtifactId: input.outputArtifactId, outputManifestId: input.outputManifestId,
        } }),
        transaction.v2MediaArtifact.findFirst({ where: { id: input.outputArtifactId, workspaceId: input.workspaceId, status: 'available' } }),
        transaction.v2MediaArtifactManifest.findFirst({ where: { id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } }),
      ])
      if (!operation || !artifact || !manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Completed project proxy output is inconsistent')
      await transaction.v2ProjectMediaAsset.upsert({
        where: { projectId_artifactId_role: { projectId: input.projectId, artifactId: input.outputArtifactId, role: 'editorial-proxy' } },
        create: {
          id: randomUUID(), workspaceId: input.workspaceId, projectId: input.projectId, artifactId: input.outputArtifactId,
          role: 'editorial-proxy', originalFileName: input.originalFileName, createdAt: new Date(input.createdAt),
        },
        update: {},
      })
      const unresolvedInvalidations = await transaction.v2CommandArtifactInvalidation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          kind: 'proxy',
          variantId: input.variantId,
          resolutions: { none: { operation: { status: 'succeeded' } } },
        },
        select: { id: true },
      })
      if (unresolvedInvalidations.length > 0) {
        for (const invalidation of unresolvedInvalidations) {
          const replacement = {
            replacementArtifactId: input.outputArtifactId,
            replacementManifestId: input.outputManifestId,
            createdAt: new Date(input.createdAt),
          }
          await transaction.v2CommandArtifactInvalidationResolution.upsert({
            where: { invalidationId_operationId: {
              invalidationId: invalidation.id,
              operationId: input.operationId,
            } },
            create: {
              id: randomUUID(),
              invalidationId: invalidation.id,
              workspaceId: input.workspaceId,
              projectId: input.projectId,
              operationId: input.operationId,
              ...replacement,
            },
            update: replacement,
          })
        }
      }
      await transaction.v2DirectorRun.updateMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          resultVersionId: input.projectVersionId,
          status: { in: ['planned', 'rendering'] },
        },
        data: { status: 'succeeded' },
      })
    })
  }
}

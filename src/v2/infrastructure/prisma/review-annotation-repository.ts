import type { Prisma, PrismaClient, V2ReviewAnnotation } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedReviewAnnotation,
  ReviewAnnotationRepository,
  ReviewPreviewContext,
  ReviewSceneRecord,
} from '../../application/ports/review-annotation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { REVIEW_SCOPE_KINDS, type ReviewScope } from '../../domain/review-system.ts'

function parseObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseStringArray(value: string, field: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) throw new Error('invalid')
    return parsed
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function parseReviewScope(value: string): Readonly<ReviewScope> {
  const parsed = parseObject(value, 'review application scope')
  const arrayFields = ['targetIds', 'formatIds', 'localeIds', 'recipeIds'] as const
  if (
    typeof parsed.kind !== 'string' || !REVIEW_SCOPE_KINDS.includes(parsed.kind as ReviewScope['kind']) ||
    typeof parsed.global !== 'boolean' ||
    arrayFields.some((field) => !Array.isArray(parsed[field]) || !(parsed[field] as unknown[]).every((item) => typeof item === 'string'))
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored review application scope is invalid')
  return Object.freeze({
    kind: parsed.kind as ReviewScope['kind'],
    targetIds: Object.freeze([...(parsed.targetIds as string[])]),
    formatIds: Object.freeze([...(parsed.formatIds as string[])]),
    localeIds: Object.freeze([...(parsed.localeIds as string[])]),
    recipeIds: Object.freeze([...(parsed.recipeIds as string[])]),
    global: parsed.global,
  })
}

function toAnnotation(row: V2ReviewAnnotation): Readonly<PersistedReviewAnnotation> {
  const region = row.scope === 'region'
    ? {
        x: row.regionX as number,
        y: row.regionY as number,
        width: row.regionWidth as number,
        height: row.regionHeight as number,
      }
    : undefined
  return Object.freeze({
    id: row.id,
    projectVersionId: row.projectVersionId,
    proxyArtifactId: row.proxyArtifactId,
    proxyHash: row.proxyHash,
    frame: row.frame,
    timeRangeMs: Object.freeze([row.timeStartMs, row.timeEndMs] as const),
    screenshotRef: row.screenshotRef,
    scope: row.scope as PersistedReviewAnnotation['scope'],
    ...(region ? { region: Object.freeze(region) } : {}),
    targetIds: Object.freeze(parseStringArray(row.targetIdsJson, 'review target IDs')),
    applicationScope: parseReviewScope(row.applicationScopeJson),
    affectedCount: row.affectedCount,
    text: row.text,
    author: Object.freeze({
      id: row.authorId,
      name: row.authorName,
      type: row.authorType as 'user' | 'api-client',
    }),
    status: row.status as PersistedReviewAnnotation['status'],
    createdAt: row.createdAt.toISOString(),
  })
}

function scenesFromEditPlan(editPlan: Record<string, unknown>): readonly ReviewSceneRecord[] {
  const tracks = Array.isArray(editPlan.videoTracks) ? editPlan.videoTracks : []
  const baseTrack = tracks.find((track) =>
    typeof track === 'object' && track !== null && !Array.isArray(track) &&
    (track as Record<string, unknown>).kind === 'base-video') as Record<string, unknown> | undefined
  const clips = baseTrack && Array.isArray(baseTrack.clips) ? baseTrack.clips : []
  return Object.freeze(clips.flatMap((clip, index) => {
    if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) return []
    const record = clip as Record<string, unknown>
    if (
      typeof record.id !== 'string' || !Number.isInteger(record.timelineInFrame) ||
      !Number.isInteger(record.timelineOutFrame) || (record.timelineOutFrame as number) <= (record.timelineInFrame as number)
    ) return []
    return [Object.freeze({
      id: `scene:${record.id}`,
      label: `Cena ${index + 1}`,
      startFrame: record.timelineInFrame as number,
      endFrame: record.timelineOutFrame as number,
    })]
  }))
}

interface ProxyCandidate {
  artifactId: string
  projectVersionId?: string
  createdAt: Date
}

export class PrismaReviewAnnotationRepository implements ReviewAnnotationRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readPreviewContext(input: { workspaceId: string; projectId: string; projectVersionId?: string }): Promise<Readonly<ReviewPreviewContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: {
        id: true,
        currentVersionId: true,
        format: true,
        locale: true,
        versions: {
          orderBy: { sequence: 'desc' },
          select: {
            id: true,
            sequence: true,
            createdAt: true,
            editPlanSnapshot: { select: { contentJson: true } },
          },
        },
      },
    })
    if (!project?.currentVersionId) return null
    const selectedVersion = input.projectVersionId
      ? project.versions.find((version) => version.id === input.projectVersionId)
      : project.versions.find((version) => version.id === project.currentVersionId)
    if (!selectedVersion) return null
    const [finalOperations, proxyOperations] = await Promise.all([
      this.client.v2ProjectFinalExportOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
        orderBy: { createdAt: 'desc' },
        select: { outputArtifactId: true, projectVersionId: true, createdAt: true },
      }),
      this.client.v2ProjectProxyRenderOperation.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
        orderBy: { createdAt: 'desc' },
        select: { outputArtifactId: true, projectVersionId: true, createdAt: true },
      }),
    ])
    const exactFinal = finalOperations.find((operation) => operation.projectVersionId === selectedVersion.id)
    const exactProxy = proxyOperations.find((operation) => operation.projectVersionId === selectedVersion.id)
    let candidate: ProxyCandidate | null = exactFinal
      ? { artifactId: exactFinal.outputArtifactId, projectVersionId: exactFinal.projectVersionId, createdAt: exactFinal.createdAt }
      : exactProxy
        ? { artifactId: exactProxy.outputArtifactId, projectVersionId: exactProxy.projectVersionId, createdAt: exactProxy.createdAt }
        : null
    if (!candidate && selectedVersion.id === project.currentVersionId) {
      const latestFinal = finalOperations[0]
      const latestProxy = proxyOperations[0]
      const candidates: ProxyCandidate[] = [
        ...(latestFinal ? [{ artifactId: latestFinal.outputArtifactId, projectVersionId: latestFinal.projectVersionId, createdAt: latestFinal.createdAt }] : []),
        ...(latestProxy ? [{ artifactId: latestProxy.outputArtifactId, projectVersionId: latestProxy.projectVersionId, createdAt: latestProxy.createdAt }] : []),
      ]
      candidate = candidates.toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    }
    if (!candidate && selectedVersion.id === project.currentVersionId) {
      const editingProxy = await this.client.v2ProjectMediaAsset.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, role: 'editing-proxy' },
        orderBy: { createdAt: 'desc' },
      })
      if (editingProxy) candidate = { artifactId: editingProxy.artifactId, createdAt: editingProxy.createdAt }
    }
    if (!candidate) return null
    const artifact = await this.client.v2MediaArtifact.findFirst({
      where: { id: candidate.artifactId, workspaceId: input.workspaceId, status: 'available' },
      include: { manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1 } },
    })
    if (!artifact?.manifests[0]) throw new DomainError('PERSISTENCE_CONFLICT', 'Review proxy artifact has no manifest')
    const manifest = parseObject(artifact.manifests[0].manifestJson, 'review proxy manifest')
    const probe = typeof manifest.probe === 'object' && manifest.probe !== null && !Array.isArray(manifest.probe)
      ? manifest.probe as Record<string, unknown>
      : {}
    const editPlan = parseObject(selectedVersion.editPlanSnapshot.contentJson, 'review EditPlan')
    const fps = typeof probe.fps === 'number' && probe.fps > 0
      ? probe.fps
      : typeof editPlan.fps === 'number' && editPlan.fps > 0 ? editPlan.fps : 0
    const durationFrames = typeof editPlan.durationFrames === 'number' && Number.isInteger(editPlan.durationFrames) && editPlan.durationFrames > 0
      ? editPlan.durationFrames
      : typeof probe.duration === 'number' && probe.duration > 0 ? Math.round(probe.duration * fps) : 0
    if (
      !fps || !durationFrames || typeof probe.width !== 'number' || probe.width <= 0 ||
      typeof probe.height !== 'number' || probe.height <= 0
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Review proxy metadata is incomplete')
    const scenes = scenesFromEditPlan(editPlan)
    const recipeIds = Object.freeze([artifact.manifests[0].recipeId])
    const previewVersionIds = new Set([
      ...finalOperations.map((operation) => operation.projectVersionId),
      ...proxyOperations.map((operation) => operation.projectVersionId),
    ])
    previewVersionIds.add(project.currentVersionId)
    return Object.freeze({
      currentProjectVersionId: project.currentVersionId,
      projectVersionId: selectedVersion.id,
      proxyArtifactId: artifact.id,
      proxyHash: artifact.sha256,
      fps,
      width: probe.width,
      height: probe.height,
      durationFrames,
      stale: selectedVersion.id !== project.currentVersionId || candidate.projectVersionId !== selectedVersion.id,
      formatId: project.format ?? '9:16',
      localeId: project.locale ?? 'pt-BR',
      recipeIds,
      availableScopeCounts: Object.freeze({
        frame: durationFrames,
        region: 1,
        clip: scenes.length,
        scene: scenes.length,
        range: 1,
        project: 1,
        formats: project.format ? 1 : 0,
        locales: project.locale ? 1 : 0,
        recipes: recipeIds.length,
      }),
      versions: Object.freeze(project.versions.map((version) => Object.freeze({
        id: version.id,
        sequence: version.sequence,
        createdAt: version.createdAt.toISOString(),
        current: version.id === project.currentVersionId,
        previewAvailable: previewVersionIds.has(version.id),
      }))),
      scenes,
    })
  }

  async list(input: { workspaceId: string; projectId: string; projectVersionId?: string; limit: number }) {
    const rows = await this.client.v2ReviewAnnotation.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(toAnnotation))
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const row = await this.client.v2ReviewAnnotation.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey },
    })
    return row ? Object.freeze({ requestFingerprint: row.requestFingerprint, annotation: toAnnotation(row) }) : null
  }

  async create(input: {
    workspaceId: string
    projectId: string
    annotation: PersistedReviewAnnotation
    idempotencyKey: string
    requestFingerprint: string
  }) {
    return this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
      const existing = await transaction.v2ReviewAnnotation.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey },
      })
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Annotation idempotency payload changed')
        return toAnnotation(existing)
      }
      const project = await transaction.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        select: { currentVersionId: true },
      })
      if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
      if (project.currentVersionId !== input.annotation.projectVersionId) {
        throw new DomainError('VERSION_CONFLICT', 'Project version changed before annotation persistence', { currentVersionId: project.currentVersionId })
      }
      const artifact = await transaction.v2MediaArtifact.findFirst({
        where: { id: input.annotation.proxyArtifactId, workspaceId: input.workspaceId, sha256: input.annotation.proxyHash, status: 'available' },
        select: { id: true },
      })
      const link = await transaction.v2ProjectMediaAsset.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          artifactId: input.annotation.proxyArtifactId,
          role: { in: ['editing-proxy', 'editorial-proxy', 'final-output'] },
        },
        select: { id: true },
      })
      if (!artifact || !link) throw new DomainError('VERSION_CONFLICT', 'Review proxy is no longer available in the project')
      const createdAt = new Date(input.annotation.createdAt)
      const row = await transaction.v2ReviewAnnotation.create({
        data: {
          id: input.annotation.id,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId: input.annotation.projectVersionId,
          proxyArtifactId: input.annotation.proxyArtifactId,
          proxyHash: input.annotation.proxyHash,
          frame: input.annotation.frame,
          timeStartMs: input.annotation.timeRangeMs[0],
          timeEndMs: input.annotation.timeRangeMs[1],
          scope: input.annotation.scope,
          ...(input.annotation.region ? {
            regionX: input.annotation.region.x,
            regionY: input.annotation.region.y,
            regionWidth: input.annotation.region.width,
            regionHeight: input.annotation.region.height,
          } : {}),
          targetIdsJson: JSON.stringify(input.annotation.targetIds),
          applicationScopeJson: JSON.stringify(input.annotation.applicationScope),
          affectedCount: input.annotation.affectedCount,
          screenshotRef: input.annotation.screenshotRef,
          text: input.annotation.text,
          authorType: input.annotation.author.type,
          authorId: input.annotation.author.id,
          authorName: input.annotation.author.name,
          status: input.annotation.status,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          createdAt,
          updatedAt: createdAt,
        },
      })
      return toAnnotation(row)
    }, { isolationLevel: 'Serializable' })
  }
}

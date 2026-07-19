import type { Prisma, PrismaClient, V2ReviewAnnotation } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedReviewAnnotation,
  ReviewAnnotationRepository,
  ReviewPreviewContext,
  ReviewSceneRecord,
} from '../../application/ports/review-annotation-repository.ts'
import { DomainError } from '../../domain/errors.ts'

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

  async readPreviewContext(input: { workspaceId: string; projectId: string }): Promise<Readonly<ReviewPreviewContext> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      include: { currentVersion: { include: { editPlanSnapshot: true } } },
    })
    if (!project?.currentVersion) return null
    const currentVersionId = project.currentVersion.id
    const [currentFinal, currentProxy] = await Promise.all([
      this.client.v2ProjectFinalExportOperation.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded' } },
        orderBy: { createdAt: 'desc' },
      }),
      this.client.v2ProjectProxyRenderOperation.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, projectVersionId: currentVersionId, operation: { status: 'succeeded' } },
        orderBy: { createdAt: 'desc' },
      }),
    ])
    let candidate: ProxyCandidate | null = currentFinal
      ? { artifactId: currentFinal.outputArtifactId, projectVersionId: currentFinal.projectVersionId, createdAt: currentFinal.createdAt }
      : currentProxy
        ? { artifactId: currentProxy.outputArtifactId, projectVersionId: currentProxy.projectVersionId, createdAt: currentProxy.createdAt }
        : null
    if (!candidate) {
      const [latestFinal, latestProxy] = await Promise.all([
        this.client.v2ProjectFinalExportOperation.findFirst({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
          orderBy: { createdAt: 'desc' },
        }),
        this.client.v2ProjectProxyRenderOperation.findFirst({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
          orderBy: { createdAt: 'desc' },
        }),
      ])
      const candidates: ProxyCandidate[] = [
        ...(latestFinal ? [{ artifactId: latestFinal.outputArtifactId, projectVersionId: latestFinal.projectVersionId, createdAt: latestFinal.createdAt }] : []),
        ...(latestProxy ? [{ artifactId: latestProxy.outputArtifactId, projectVersionId: latestProxy.projectVersionId, createdAt: latestProxy.createdAt }] : []),
      ]
      candidate = candidates.toSorted((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null
    }
    if (!candidate) {
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
    const editPlan = parseObject(project.currentVersion.editPlanSnapshot.contentJson, 'review EditPlan')
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
    return Object.freeze({
      projectVersionId: currentVersionId,
      proxyArtifactId: artifact.id,
      proxyHash: artifact.sha256,
      fps,
      width: probe.width,
      height: probe.height,
      durationFrames,
      stale: candidate.projectVersionId !== currentVersionId,
      scenes: scenesFromEditPlan(editPlan),
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

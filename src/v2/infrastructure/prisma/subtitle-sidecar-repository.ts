import type {
  Prisma,
  PrismaClient,
  V2ProjectSubtitleSidecar,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSubtitleSidecar,
  RenderedSubtitleAlignmentSource,
  SubtitleSidecarRepository,
} from '../../application/ports/subtitle-sidecar-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  renderElementMapHash,
  validateRenderElementMap,
  type RenderElement,
  type RenderElementMap,
} from '../../domain/review-system.ts'
import {
  SUBTITLE_SIDECAR_FORMATS,
  type SubtitleSidecarFormat,
} from '../../domain/subtitle-sidecar.ts'

function parseObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

/**
 * Reads the cue texts of the exact EditPlan snapshot that the render operation
 * consumed. The project head is deliberately not consulted: a later command may
 * already have rewritten the cues, and the sidecar has to describe the MP4.
 */
function cueTextsOf(contentJson: string): Readonly<Record<string, string>> {
  const plan = parseObject(contentJson, 'EditPlan snapshot')
  const tracks = plan.subtitleTracks
  if (!Array.isArray(tracks)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan snapshot has no subtitle tracks')
  }
  const texts: Record<string, string> = {}
  for (const track of tracks) {
    if (!track || typeof track !== 'object' || Array.isArray(track)) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle track is invalid')
    }
    const cues = (track as Record<string, unknown>).cues
    if (!Array.isArray(cues)) continue
    for (const cue of cues) {
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue is invalid')
      }
      const value = cue as Record<string, unknown>
      if (typeof value.id !== 'string' || typeof value.text !== 'string') {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue identity is invalid')
      }
      if (value.id in texts) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue id is duplicated')
      }
      texts[value.id] = value.text
    }
  }
  return Object.freeze(texts)
}

function mapOf(row: {
  schemaVersion: string
  proxyHash: string
  fps: number
  durationFrames: number
  canvasWidth: number
  canvasHeight: number
  elementsJson: string
  mapHash: string
}): Readonly<RenderElementMap> {
  let elements: unknown
  try {
    elements = JSON.parse(row.elementsJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap JSON is invalid')
  }
  if (!Array.isArray(elements)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap elements are invalid')
  }
  const map = validateRenderElementMap({
    schemaVersion: row.schemaVersion as RenderElementMap['schemaVersion'],
    proxyHash: row.proxyHash,
    fps: row.fps,
    durationFrames: row.durationFrames,
    canvas: { width: row.canvasWidth, height: row.canvasHeight },
    elements: elements as RenderElement[],
  }, row.proxyHash)
  if (renderElementMapHash(map) !== row.mapHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored RenderElementMap hash is invalid')
  }
  return map
}

function toRecord(row: V2ProjectSubtitleSidecar): Readonly<PersistedSubtitleSidecar> {
  if (!SUBTITLE_SIDECAR_FORMATS.includes(row.format as SubtitleSidecarFormat)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle sidecar format is invalid')
  }
  if (row.outputKind !== 'proxy' && row.outputKind !== 'final') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle sidecar output kind is invalid')
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    projectVersionId: row.projectVersionId,
    variantId: row.variantId,
    outputKind: row.outputKind,
    outputArtifactId: row.outputArtifactId,
    outputManifestId: row.outputManifestId,
    outputSha256: row.outputSha256,
    format: row.format as SubtitleSidecarFormat,
    locale: row.locale,
    artifactId: row.artifactId,
    manifestId: row.manifestId,
    artifactKey: row.artifactKey,
    sha256: row.sha256,
    byteSize: row.byteSize,
    encoding: row.encoding,
    cueCount: row.cueCount,
    lineageHash: row.lineageHash,
    renderElementMapHash: row.renderElementMapHash,
    renderInputHash: row.renderInputHash,
    editPlanSnapshotId: row.editPlanSnapshotId,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaSubtitleSidecarRepository implements SubtitleSidecarRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readRenderedAlignment(input: {
    workspaceId: string
    projectId: string
    variantId: string
    projectVersionId?: string
  }): Promise<Readonly<RenderedSubtitleAlignmentSource> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true, format: true, currentVersionId: true },
    })
    if (!project) return null
    const projectVersionId = input.projectVersionId ?? project.currentVersionId
    if (!projectVersionId) return null
    const version = await this.client.v2ProjectVersion.findFirst({
      where: { id: projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId },
      select: { id: true, sequence: true },
    })
    if (!version) return null

    // A final export is the stronger evidence of what the audience sees, so it
    // wins whenever one exists for the requested variant.
    const [final, proxy] = await Promise.all([
      this.client.v2ProjectFinalExportOperation.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId,
          outputAspectRatio: input.variantId,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        orderBy: [{ createdAt: 'desc' }],
        include: { editPlanSnapshot: true },
      }),
      this.client.v2ProjectProxyRenderOperation.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        orderBy: [{ createdAt: 'desc' }],
        include: { editPlanSnapshot: true },
      }),
    ])
    const render = final && final.outputAspectRatio === input.variantId
      ? {
          kind: 'final' as const,
          variantId: final.outputAspectRatio,
          outputArtifactId: final.outputArtifactId,
          outputManifestId: final.outputManifestId,
          renderInputHash: final.inputHash,
          editPlanSnapshotId: final.editPlanSnapshotId,
          editPlanHash: final.editPlanSnapshot.contentHash,
          editPlanJson: final.editPlanSnapshot.contentJson,
        }
      : proxy && (project.format ?? input.variantId) === input.variantId
        ? {
            kind: 'proxy' as const,
            variantId: project.format ?? input.variantId,
            outputArtifactId: proxy.outputArtifactId,
            outputManifestId: proxy.outputManifestId,
            renderInputHash: proxy.inputHash,
            editPlanSnapshotId: proxy.editPlanSnapshotId,
            editPlanHash: proxy.editPlanSnapshot.contentHash,
            editPlanJson: proxy.editPlanSnapshot.contentJson,
          }
        : null
    if (!render) return null

    const [artifact, mapRow] = await Promise.all([
      this.client.v2MediaArtifact.findFirst({
        where: { id: render.outputArtifactId, workspaceId: input.workspaceId },
        select: { id: true, artifactKey: true, sha256: true, status: true },
      }),
      this.client.v2RenderElementMap.findFirst({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId,
          proxyArtifactId: render.outputArtifactId,
        },
      }),
    ])
    if (!artifact || !mapRow) return null

    return Object.freeze({
      projectId: input.projectId,
      projectVersionId,
      projectVersionSequence: version.sequence,
      isCurrentVersion: project.currentVersionId === projectVersionId,
      variantId: render.variantId,
      outputKind: render.kind,
      outputArtifactId: render.outputArtifactId,
      outputManifestId: render.outputManifestId,
      outputArtifactKey: artifact.artifactKey,
      outputSha256: artifact.sha256,
      renderInputHash: render.renderInputHash,
      editPlanSnapshotId: render.editPlanSnapshotId,
      editPlanHash: render.editPlanHash,
      renderElementMapId: mapRow.id,
      renderElementMapHash: mapRow.mapHash,
      map: mapOf(mapRow),
      cueTexts: cueTextsOf(render.editPlanJson),
    })
  }

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string }) {
    const row = await this.client.v2ProjectSubtitleSidecar.findFirst({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row
      ? Object.freeze({ requestFingerprint: row.requestFingerprint, record: toRecord(row) })
      : null
  }

  async persistOrReplay(input: {
    record: PersistedSubtitleSidecar
    idempotencyKey: string
    requestFingerprint: string
  }) {
    const { record } = input
    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
        const existing = await transaction.v2ProjectSubtitleSidecar.findFirst({
          where: { workspaceId: record.workspaceId, lineageHash: record.lineageHash },
        })
        if (existing) {
          if (
            existing.id !== record.id ||
            existing.sha256 !== record.sha256 ||
            existing.artifactId !== record.artifactId ||
            existing.byteSize !== record.byteSize ||
            existing.cueCount !== record.cueCount
          ) {
            throw new DomainError(
              'PERSISTENCE_CONFLICT',
              'Subtitle sidecar replay changed immutable content',
            )
          }
          return Object.freeze({ record: toRecord(existing), replayed: true })
        }
        const row = await transaction.v2ProjectSubtitleSidecar.create({
          data: {
            id: record.id,
            workspaceId: record.workspaceId,
            projectId: record.projectId,
            projectVersionId: record.projectVersionId,
            variantId: record.variantId,
            outputKind: record.outputKind,
            outputArtifactId: record.outputArtifactId,
            outputManifestId: record.outputManifestId,
            outputSha256: record.outputSha256,
            format: record.format,
            locale: record.locale,
            artifactId: record.artifactId,
            manifestId: record.manifestId,
            artifactKey: record.artifactKey,
            sha256: record.sha256,
            byteSize: record.byteSize,
            encoding: record.encoding,
            cueCount: record.cueCount,
            lineageHash: record.lineageHash,
            renderElementMapHash: record.renderElementMapHash,
            renderInputHash: record.renderInputHash,
            editPlanSnapshotId: record.editPlanSnapshotId,
            idempotencyKey: input.idempotencyKey,
            requestFingerprint: input.requestFingerprint,
            createdAt: new Date(record.createdAt),
          },
        })
        return Object.freeze({ record: toRecord(row), replayed: false })
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (
        typeof error === 'object' && error !== null && 'code' in error &&
        (error as { code?: string }).code === 'P2002'
      ) {
        const replay = await this.findIdempotent({
          workspaceId: record.workspaceId,
          projectId: record.projectId,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay?.requestFingerprint === input.requestFingerprint) {
          return Object.freeze({ record: replay.record, replayed: true })
        }
        if (replay) {
          throw new DomainError(
            'IDEMPOTENCY_PAYLOAD_MISMATCH',
            'Idempotency key was reused with another subtitle sidecar',
          )
        }
        const byLineage = await this.client.v2ProjectSubtitleSidecar.findFirst({
          where: { workspaceId: record.workspaceId, lineageHash: record.lineageHash },
        })
        if (byLineage) return Object.freeze({ record: toRecord(byLineage), replayed: true })
      }
      throw error
    }
  }

  async list(input: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    variantId?: string
    format?: SubtitleSidecarFormat
    limit: number
  }) {
    const rows = await this.client.v2ProjectSubtitleSidecar.findMany({
      where: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        ...(input.projectVersionId ? { projectVersionId: input.projectVersionId } : {}),
        ...(input.variantId ? { variantId: input.variantId } : {}),
        ...(input.format ? { format: input.format } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
    })
    return Object.freeze(rows.map(toRecord))
  }
}

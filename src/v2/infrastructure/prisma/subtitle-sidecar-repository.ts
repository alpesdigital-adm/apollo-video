import type {
  Prisma,
  PrismaClient,
  V2ProjectSubtitleSidecar,
} from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSubtitleSidecar,
  RenderedSubtitleAlignmentSource,
  SidecarOutputConsumptionSeal,
  SubtitleSidecarRepository,
} from '../../application/ports/subtitle-sidecar-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { renderRowsOfVariant } from '../../domain/render-row-variant.ts'
import { requirePersistedOutputConsumptionV3, type RequiredOutputConsumptionV3 } from './output-state-consumption.ts'
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
import { emittedSubtitleTracks } from '../../domain/subtitle-emission-tracks.ts'
import { resolveSubtitleOverridesForRender, subtitleOverrideSetHash } from '../../domain/subtitle-segment-override.ts'
import { readSubtitleSegmentOverrideHeadsAsOf } from './subtitle-segment-override-repository.ts'

const PROXY_REVIEW_STATUSES = ['blocked', 'warning-ack-required', 'ready-for-final'] as const

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
 * The cues the EditPlan snapshot of the render compiled (the cues a renderer may burn: the emitted tracks, exactly as the geometry
 * derivation reads them), with their frames. The project head is deliberately not consulted: a later command may already have rewritten
 * the cues, and the sidecar has to describe the MP4.
 */
function compiledCuesOf(contentJson: string): readonly Readonly<{ id: string; startFrame: number; endFrame: number; text: string }>[] {
  const plan = parseObject(contentJson, 'EditPlan snapshot')
  const tracks = plan.subtitleTracks
  if (!Array.isArray(tracks)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored EditPlan snapshot has no subtitle tracks')
  }
  const cues: { id: string; startFrame: number; endFrame: number; text: string }[] = []
  const seen = new Set<string>()
  for (const track of emittedSubtitleTracks(tracks as readonly object[])) {
    const trackCues = (track as { cues?: unknown }).cues
    if (!Array.isArray(trackCues)) continue
    for (const cue of trackCues) {
      if (!cue || typeof cue !== 'object' || Array.isArray(cue)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue is invalid')
      }
      const value = cue as Record<string, unknown>
      if (typeof value.id !== 'string' || typeof value.text !== 'string') {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue identity is invalid')
      }
      if (seen.has(value.id)) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue id is duplicated')
      }
      const startFrame = Number(value.startFrame), endFrame = Number(value.endFrame)
      if (!Number.isSafeInteger(startFrame) || !Number.isSafeInteger(endFrame) || startFrame < 0 || endFrame <= startFrame) {
        throw new DomainError('PERSISTENCE_CONFLICT', 'Stored subtitle cue range is invalid')
      }
      seen.add(value.id)
      cues.push(Object.freeze({ id: value.id, startFrame, endFrame, text: value.text }))
    }
  }
  return Object.freeze(cues)
}

/** The set hash of subtitle exceptions the review of a render recorded (`formatQuality.subtitleOverridesHash`); `null` when it was drawn with none. */
function reviewedOverridesHash(formatQualityJson: string | null): string | null {
  if (formatQualityJson === null) return null
  const hash = parseObject(formatQualityJson, 'proxy review format quality').subtitleOverridesHash
  return typeof hash === 'string' ? hash : null
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

const sealOf = (consumption: Readonly<RequiredOutputConsumptionV3>): SidecarOutputConsumptionSeal =>
  Object.freeze({ seal: consumption.seal, sealHash: consumption.sealHash })

export class PrismaSubtitleSidecarRepository implements SubtitleSidecarRepository {
  private readonly client: PrismaClient

  constructor(client: PrismaClient) {
    this.client = client
  }

  async readRenderedAlignment(input: {
    workspaceId: string
    projectId: string
    /** The stable variant of the State whose output is aligned. */
    variantId: string
    projectVersionId?: string
  }): Promise<Readonly<RenderedSubtitleAlignmentSource> | null> {
    const project = await this.client.v2Project.findFirst({
      where: { id: input.projectId, workspaceId: input.workspaceId },
      select: { id: true, currentVersionId: true },
    })
    if (!project) return null
    const projectVersionId = input.projectVersionId ?? project.currentVersionId
    if (!projectVersionId) return null
    const version = await this.client.v2ProjectVersion.findFirst({
      where: { id: projectVersionId, workspaceId: input.workspaceId, projectId: input.projectId },
      select: { id: true, sequence: true },
    })
    if (!version) return null

    // The output of exactly this Version (never the head, never the project's format): the one persisted consumption reader
    // admits it for rendering, or refuses with the published reason (a copy no editorial cut has materialized, a Version
    // without outputs, an unknown or ambiguous variant). `variantId` is the stable variant of that State.
    const scope = { workspaceId: input.workspaceId, projectId: input.projectId, versionId: projectVersionId }
    const rendered = await requirePersistedOutputConsumptionV3(this.client, { ...scope, variantId: input.variantId, purpose: 'render' })
    const outputVariantId = rendered.entry.variantId

    // The renders of this Version made for THIS output (selected by the output they name, never by Version alone: the other
    // outputs of the Version have renders of their own). A final export is the stronger evidence of what the audience sees, so
    // it wins whenever one exists for the requested output.
    const [finals, proxies] = await Promise.all([
      this.client.v2ProjectFinalExportOperation.findMany({
        where: {
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          projectVersionId,
          operation: { status: 'succeeded', phase: 'completed' },
        },
        orderBy: [{ createdAt: 'desc' }],
        include: { editPlanSnapshot: true },
      }),
      this.client.v2ProjectProxyRenderOperation.findMany({
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
    const final = renderRowsOfVariant(rendered.state, finals, outputVariantId)[0] ?? null
    const proxy = renderRowsOfVariant(rendered.state, proxies, outputVariantId)[0] ?? null
    const render = final
      ? {
          kind: 'final' as const,
          outputArtifactId: final.outputArtifactId,
          outputManifestId: final.outputManifestId,
          renderInputHash: final.inputHash,
          reviewWhere: { id: final.proxyReviewId } as const,
          editPlanSnapshotId: final.editPlanSnapshotId,
          editPlanHash: final.editPlanSnapshot.contentHash,
          editPlanJson: final.editPlanSnapshot.contentJson,
        }
      : proxy
        ? {
            kind: 'proxy' as const,
            outputArtifactId: proxy.outputArtifactId,
            outputManifestId: proxy.outputManifestId,
            renderInputHash: proxy.inputHash,
            reviewWhere: { operationId: proxy.operationId } as const,
            editPlanSnapshotId: proxy.editPlanSnapshotId,
            editPlanHash: proxy.editPlanSnapshot.contentHash,
            editPlanJson: proxy.editPlanSnapshot.contentJson,
          }
        : null
    if (!render) {
      // No render of THIS output exists for the requested Version. When a render of the same output exists for ANOTHER Version of the project,
      // the sidecar of that render would describe something this Version does not play: say so, precisely, instead of "not found".
      const [otherFinal, otherProxy] = await Promise.all([
        this.client.v2ProjectFinalExportOperation.findFirst({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, outputVariantId, projectVersionId: { not: projectVersionId },
            operation: { status: 'succeeded', phase: 'completed' } },
          orderBy: [{ createdAt: 'desc' }], select: { projectVersionId: true },
        }),
        this.client.v2ProjectProxyRenderOperation.findFirst({
          where: { workspaceId: input.workspaceId, projectId: input.projectId, outputVariantId, projectVersionId: { not: projectVersionId },
            operation: { status: 'succeeded', phase: 'completed' } },
          orderBy: [{ createdAt: 'desc' }], select: { projectVersionId: true },
        }),
      ])
      const renderedVersionId = otherFinal?.projectVersionId ?? otherProxy?.projectVersionId ?? null
      if (renderedVersionId !== null) {
        throw new DomainError('SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
          'This output has no render of the requested Version; the only render is of another Version, so its sidecar would not describe what this Version plays',
          { reason: 'render-stale', requestedVersionId: projectVersionId, renderedVersionId, variantId: outputVariantId })
      }
      return null
    }
    // What the audience sees is a final export: the Version must be consumable as one too (a cut copy stays blocked until its
    // target owns perception authority), or the sidecar would describe an export the product refuses to make.
    const finalConsumption = render.kind === 'final'
      ? await requirePersistedOutputConsumptionV3(this.client, { ...scope, variantId: rendered.entry.variantId, purpose: 'final' })
      : null

    const [artifact, mapRow, reviewRow] = await Promise.all([
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
      this.client.v2ProxyReview.findFirst({
        where: { ...render.reviewWhere, workspaceId: input.workspaceId, projectId: input.projectId },
        select: { status: true, finalAllowed: true, reviewHash: true, formatQualityJson: true },
      }),
    ])
    if (!artifact || !mapRow) return null
    if (reviewRow && !PROXY_REVIEW_STATUSES.includes(reviewRow.status as (typeof PROXY_REVIEW_STATUSES)[number])) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored proxy review status is invalid')
    }

    // The cues THIS render could draw: the compiled cues of its own EditPlan snapshot with the subtitle exceptions of the output applied -
    // the very function the geometry derivation applied to the render. The exceptions are those in force as of the rendered Version, and the
    // set must be the one the review of the render recorded: another set would make the sidecar describe pixels nobody drew.
    const heads = await readSubtitleSegmentOverrideHeadsAsOf(this.client, {
      workspaceId: input.workspaceId, projectId: input.projectId, variantId: outputVariantId, versionSequence: version.sequence,
    })
    const overridesHash = subtitleOverrideSetHash(heads, outputVariantId)
    if (reviewRow && reviewedOverridesHash(reviewRow.formatQualityJson) !== overridesHash) {
      throw new DomainError('SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH',
        'The subtitle exceptions in force for this output are not the set the render was drawn with',
        { reason: 'override-set-mismatch', variantId: outputVariantId, projectVersionId })
    }
    const compiled = compiledCuesOf(render.editPlanJson)
    const effective = overridesHash === null ? compiled
      : resolveSubtitleOverridesForRender({ cues: compiled, overrides: heads, variantId: outputVariantId }).cues

    return Object.freeze({
      projectId: input.projectId,
      projectVersionId,
      projectVersionSequence: version.sequence,
      isCurrentVersion: project.currentVersionId === projectVersionId,
      variantId: outputVariantId,
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
      cueTexts: Object.freeze(Object.fromEntries(effective.map((cue) => [cue.id, cue.text]))),
      cueFrames: Object.freeze(Object.fromEntries(effective.map((cue) => [cue.id, Object.freeze({ startFrame: cue.startFrame, endFrame: cue.endFrame })]))),
      subtitleOverridesHash: overridesHash,
      outputConsumption: Object.freeze({ render: sealOf(rendered), ...(finalConsumption ? { final: sealOf(finalConsumption) } : {}) }),
      review: reviewRow
        ? Object.freeze({
            status: reviewRow.status as (typeof PROXY_REVIEW_STATUSES)[number],
            finalAllowed: reviewRow.finalAllowed,
            reviewHash: reviewRow.reviewHash,
          })
        : null,
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

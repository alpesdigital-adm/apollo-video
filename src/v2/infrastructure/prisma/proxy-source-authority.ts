import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type { EditorialCutEditPlan } from '../../application/apply-editorial-cut-command.ts'
import type { DirectedEditPlan } from '../../domain/director-run.ts'
import type { ProjectProxyRenderSource } from '../../application/ports/project-proxy-render-repository.ts'
import type { ProxyQualityIssue } from '../../application/render-workflow.ts'
import { calculateVersionHash } from '../../application/version-hash.ts'
import { evaluateAssetUse } from '../../domain/asset-rights.ts'
import { hydrateAssetRights } from './asset-rights-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import type { OutputConsumptionPurpose } from '../../domain/output-consumption.ts'
import { requirePersistedOutputConsumptionV3 } from './output-state-consumption.ts'

type ProxySourceQuery = {
  workspaceId: string; projectId: string; projectVersionId?: string; editPlanSnapshotId?: string;
  sourceArtifactId?: string; sourceManifestId?: string
  /** What the caller will do with the source: the proxy render (default) or the final export. The verdict is the purpose's. */
  purpose?: Extract<OutputConsumptionPurpose, 'render' | 'final'>
  /** The State variant to consume. Absent means "the State's only output": a State with several outputs is then refused, never guessed. */
  variantId?: string
}

/**
 * The project with the Version, media and rights its render is built from, read through the one persisted consumption verdict.
 *
 * The Version consumed is the one asked for, else the head. Its sealed State and the sole output's entry decide whether it may be
 * rendered (or exported) at all, and name the format: `format` is the aspect ratio of the sealed entry, never the project's
 * stored format and never a default. A refusal is a PRECONDITION_REQUIRED whose `details.reason` names why (a copy no editorial
 * cut has given authority, a final export of a cut copy, an output without a format, a State with several outputs, ...).
 * `outputConsumption` is the seal of what was read, for the consumer to put in its context and input hash.
 */
export async function queryProxySourceProject(client: PrismaClient | Prisma.TransactionClient, input: ProxySourceQuery) {
  const project = await findProxySourceProject(client, input)
  if (!project) return null
  const purpose = input.purpose ?? 'render'
  const versionId = input.projectVersionId ?? project.versions[0]?.id ?? project.currentVersionId
  if (!versionId) {
    throw new DomainError('PRECONDITION_REQUIRED', 'Project has no Version whose output can be consumed', { reason: 'output-version-missing', purpose })
  }
  // The light reader (sealed Version + State rows): safe inside an owner transaction. The audit rebuild is never asked for here.
  const consumption = await requirePersistedOutputConsumptionV3(client, {
    workspaceId: input.workspaceId, projectId: input.projectId, versionId, purpose,
    ...(input.variantId !== undefined ? { variantId: input.variantId } : {}) })
  if (consumption.aspectRatio === null) {
    throw new DomainError('PRECONDITION_REQUIRED', 'The consumed output carries no aspect ratio of its own',
      { reason: 'output-not-consumable', purpose, outputStateId: consumption.state.document.id })
  }
  return {
    ...project,
    format: consumption.aspectRatio,
    outputConsumption: Object.freeze({ seal: consumption.seal, sealHash: consumption.sealHash }),
  }
}

function findProxySourceProject(client: PrismaClient | Prisma.TransactionClient, input: ProxySourceQuery) {
  return client.v2Project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId },
    select: {
      id: true,
      workspaceId: true,
      locale: true,
      currentVersionId: true,
      versions: {
        where: input.projectVersionId
          ? { id: input.projectVersionId, ...(input.editPlanSnapshotId ? { editPlanSnapshotId: input.editPlanSnapshotId } : {}) }
          : { currentForProjects: { some: { id: input.projectId, workspaceId: input.workspaceId } } },
        orderBy: { sequence: 'desc' as const },
        take: 1,
        include: {
          editPlanSnapshot: true,
          directorRunAsResult: { include: { qualitySnapshot: true, perceptionSnapshot: true } },
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
            currentRightsSnapshot: true,
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

export function parseProxySourceRecord(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

export function parseProxySourceCriticIssues(value: string | undefined): readonly Readonly<ProxyQualityIssue>[] {
  if (!value) return Object.freeze([])
  const quality = parseProxySourceRecord(value, 'project proxy QualityReport')
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


export function assertProxySourceLineage(manifestJson: string,
  source: Readonly<ProjectProxyRenderSource>): void {
  const manifest = parseProxySourceRecord(manifestJson, 'project proxy output manifest')
  const sources: readonly unknown[] | null = Array.isArray(manifest.sources) ? manifest.sources : null
  if (!sources || source.renderSources.some((asset) =>
    !sources.some((candidate: unknown) => typeof candidate === 'object' && candidate !== null &&
      !Array.isArray(candidate) && (candidate as Record<string, unknown>).artifactKey === asset.artifactKey &&
      (candidate as Record<string, unknown>).sha256 === asset.sha256 &&
      (candidate as Record<string, unknown>).role === asset.role))) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy source bytes are not sealed by output lineage')
  }
}

type ProjectSourceLink = NonNullable<Awaited<ReturnType<typeof queryProxySourceProject>>>['mediaAssets'][number]

export function uniqueSourceLink(links: readonly ProjectSourceLink[], artifactId: string): ProjectSourceLink {
  const matches = links.filter((item) => item.artifactId === artifactId)
  if (matches.length !== 1) throw new DomainError('PERSISTENCE_CONFLICT',
    `Render source ${artifactId} has no unambiguous project association`)
  return matches[0]!
}

function sourceRightsPurpose(link: ProjectSourceLink): Readonly<{
  use: 'rendering' | 'editorial-reuse'; role: 'source-master' | 'selected-insert'
}> {
  // Project uploads and referenced library inserts have different authorized uses.
  // Unknown roles cannot acquire insert authority through ordering or a default.
  if (link.role === 'source-master' && link.artifact.mediaType === 'video') {
    return { use: 'rendering', role: 'source-master' }
  }
  if (link.role === 'source-audio' && link.artifact.mediaType === 'audio') {
    return { use: 'rendering', role: 'source-master' }
  }
  if (link.role === 'selected-insert' && ['video', 'audio'].includes(link.artifact.mediaType)) {
    return { use: 'editorial-reuse', role: 'selected-insert' }
  }
  throw new DomainError('PERSISTENCE_CONFLICT', `Render source ${link.artifactId} has an unsupported project role or media type`)
}

export function referencedRenderArtifactIds(editPlan: EditorialCutEditPlan | DirectedEditPlan): string[] {
  const clips = editPlan.videoTracks.filter((track) => track.kind === 'base-video').flatMap((track) => track.clips)
  return [...new Set(clips.flatMap((clip) => [clip.sourceArtifactId,
    clip.audioSourceArtifactId ?? clip.sourceArtifactId]).concat(
    'audioTracks' in editPlan ? editPlan.audioTracks.map((track) => track.artifactId) : []))].sort()
}

export function hydrateProxySource(
  project: Awaited<ReturnType<typeof queryProxySourceProject>>,
  expected?: { sourceArtifactId?: string; sourceManifestId?: string },
  evaluatedAt: Date = new Date(),
): Readonly<ProjectProxyRenderSource> | null {
  const version = project?.versions[0]
  const media = project?.mediaAssets.find((item) =>
    item.role === 'source-master' &&
    (!expected?.sourceArtifactId || item.artifactId === expected.sourceArtifactId))
  const manifest = expected?.sourceManifestId
    ? media?.artifact.manifests.find((item) => item.id === expected.sourceManifestId)
    : media?.artifact.manifests[0]
  if (!project || !version || !media || !manifest) return null
  // The Version row and the sealed State must be one and the same Version: a consumption sealed to another is no authority here.
  if (project.outputConsumption.seal.projectVersionId !== version.id || project.outputConsumption.seal.projectVersionHash !== version.baseHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy source is not the Version its output consumption seals')
  }
  const editPlan = parseProxySourceRecord(version.editPlanSnapshot.contentJson, 'project proxy EditPlan') as unknown as EditorialCutEditPlan | DirectedEditPlan
  const manifestBody = parseProxySourceRecord(manifest.manifestJson, 'project proxy source manifest')
  const artifactBody = manifestBody.artifact
  if (
    editPlan.schemaVersion !== 2 || editPlan.state !== 'compiled' ||
    version.editPlanSnapshot.workspaceId !== project.workspaceId ||
    version.editPlanSnapshot.projectId !== project.id ||
    calculateVersionHash(editPlan) !== version.editPlanSnapshot.contentHash ||
    typeof artifactBody !== 'object' || artifactBody === null || Array.isArray(artifactBody) ||
    typeof (artifactBody as Record<string, unknown>).artifactKey !== 'string'
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Project proxy source is inconsistent')
  const renderSources = hydrateProxyRenderSources(project, editPlan, evaluatedAt)
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
    format: project.format,
    outputConsumption: project.outputConsumption,
    sourceArtifactId: media.artifactId,
    sourceManifestId: manifest.id,
    sourceArtifactKey: (artifactBody as Record<string, unknown>).artifactKey as string,
    sourceSha256: media.artifact.sha256,
    renderSources: Object.freeze(renderSources),
    originalFileName: media.originalFileName,
    uploadReceivedAt: (media.upload?.createdAt ?? media.createdAt).toISOString(),
    criticIssues: parseProxySourceCriticIssues(version.directorRunAsResult?.qualitySnapshot.contentJson),
  })
}

export function hydrateProxyRenderSources(project: NonNullable<Awaited<ReturnType<typeof queryProxySourceProject>>>,
  editPlan: EditorialCutEditPlan | DirectedEditPlan, evaluatedAt: Date) {
  const referencedArtifactIds = referencedRenderArtifactIds(editPlan)
  return referencedArtifactIds.map((artifactId) => {
    const link = uniqueSourceLink(project.mediaAssets, artifactId)
    const purpose = sourceRightsPurpose(link)
    const sourceManifest = link?.artifact.manifests[0]
    const sourceBody = sourceManifest
      ? parseProxySourceRecord(sourceManifest.manifestJson, `project render source manifest ${sourceManifest.id}`)
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
    const musicTrack = 'audioTracks' in editPlan ? editPlan.audioTracks.find((track) => track.artifactId === artifactId) : undefined
    if (musicTrack) {
      const rights = link.artifact.currentRightsSnapshot
      if (!rights || rights.id !== musicTrack.rightsSnapshotId || rights.status !== 'approved' || (rights.expiresAt && rights.expiresAt <= evaluatedAt)) throw new DomainError('ASSET_RIGHTS_BLOCKED', `Music source ${artifactId} no longer has the approved current rights snapshot`)
    } else {
      const rights = link.artifact.currentRightsSnapshot
        ? hydrateAssetRights(link.artifact.currentRightsSnapshot) : null
      if (evaluateAssetUse(rights, { workspaceId: project.workspaceId,
        use: purpose.use, locale: project.locale ?? 'und' }, evaluatedAt).outcome !== 'allow') {
        throw new DomainError('ASSET_RIGHTS_BLOCKED', `Render source ${artifactId} no longer has approved current rights`)
      }
    }
    const probe = (sourceBody as Record<string, unknown>).probe as Record<string, unknown> | undefined
    const dimensions = link.artifact.mediaType === 'video' && probe && typeof probe === 'object' &&
      Number.isSafeInteger(probe.width) && Number.isSafeInteger(probe.height) && Number(probe.width) >= 2 && Number(probe.height) >= 2
      ? Object.freeze({ width: Number(probe.width), height: Number(probe.height) }) : undefined
    return Object.freeze({
      artifactId,
      manifestId: sourceManifest.id,
      artifactKey: (sourceArtifact as Record<string, unknown>).artifactKey as string,
      sha256: link.artifact.sha256,
      byteSize: Number(link.artifact.byteSize),
      mediaType: link.artifact.mediaType as 'video' | 'audio',
      container: link.artifact.container,
      role: musicTrack ? 'approved-music' as const : purpose.role,
      ...(dimensions ? { probe: dimensions } : {}),
    })
  })
}

export async function lockProxySourceArtifacts(transaction: Prisma.TransactionClient, input: {
  workspaceId: string; plan: EditorialCutEditPlan | DirectedEditPlan; sourceArtifactId: string; outputArtifactId: string
}) {
  const ids = [...new Set([...referencedRenderArtifactIds(input.plan), input.sourceArtifactId, input.outputArtifactId])]
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const rows = await transaction.$queryRaw<readonly { id: string }[]>`
    SELECT id FROM media_artifacts WHERE "workspaceId" = ${input.workspaceId}
    AND id IN (${Prisma.join(ids)}) ORDER BY id COLLATE "C" FOR UPDATE`
  if (rows.length !== ids.length || rows.some((row, index) => row.id !== ids[index])) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy source artifact fences are unavailable')
  }
}

export async function proxySourceClock(transaction: Prisma.TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<readonly { now: Date }[]>`SELECT clock_timestamp() AS now`
  if (rows.length !== 1 || !(rows[0]!.now instanceof Date) || !Number.isFinite(rows[0]!.now.getTime())) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Proxy source database clock is unavailable')
  }
  return rows[0]!.now
}

export async function assertInlineProxySourceAuthority(transaction: Prisma.TransactionClient, input: {
  workspaceId: string; projectId: string; projectVersionId: string; editPlanSnapshotId: string;
  sourceArtifactId: string; sourceManifestId: string; outputArtifactId: string; outputManifestId: string
  /** The stable State variant the reuse is for (the output of the child Version); absent means the State's only output. */
  variantId?: string
}) {
  // Call only after operation/detail/project/all-source locks. The database clock
  // is refreshed on both admission and the final read after outbox writes.
  const project = await queryProxySourceProject(transaction, input)
  const manifest = await transaction.v2MediaArtifactManifest.findFirst({ where: {
    id: input.outputManifestId, workspaceId: input.workspaceId, artifactId: input.outputArtifactId } })
  if (!manifest) throw new DomainError('PERSISTENCE_CONFLICT', 'Inline proxy output lineage is unavailable')
  const observedAt = await proxySourceClock(transaction)
  const source = hydrateProxySource(project, input, observedAt)
  if (!source || !project || project.currentVersionId !== input.projectVersionId ||
      source.projectVersionId !== input.projectVersionId || source.editPlanSnapshotId !== input.editPlanSnapshotId ||
      source.sourceArtifactId !== input.sourceArtifactId || source.sourceManifestId !== input.sourceManifestId ||
      !source.renderSources.some((asset) => asset.artifactId === input.sourceArtifactId &&
        asset.manifestId === input.sourceManifestId && asset.artifactKey === source.sourceArtifactKey &&
        asset.sha256 === source.sourceSha256)) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Inline proxy source authority changed')
  }
  assertProxySourceLineage(manifest.manifestJson, source)
  return source
}

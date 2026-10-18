import { randomUUID } from 'node:crypto'

import type { Prisma, PrismaClient, V2MediaArtifact, V2ReviewAnnotation } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedReviewAnnotation,
  ReviewAnnotationRepository,
  ReviewPreviewContext,
  ReviewSceneRecord,
} from '../../application/ports/review-annotation-repository.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertMediaArtifactManifest, type MediaArtifactManifest } from '../../domain/media-artifact.ts'
import { createPublicEvent } from '../../domain/public-event.ts'
import { outputVariantsOf, type OutputConsumptionState } from '../../domain/output-consumption.ts'
import { renderRowIsOfVariant } from '../../domain/render-row-variant.ts'
import { REVIEW_SCOPE_KINDS, type ReviewScope } from '../../domain/review-system.ts'
import { persistPublicEvents } from './public-event-outbox.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
} from './external-actor-audit.ts'
import { requireCriticOutputConsumption } from './critic-output-consumption.ts'

function parseObject(value: string, field: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid')
    return parsed as Record<string, unknown>
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored ${field} is invalid`)
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null &&
    'code' in error && error.code === code
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
  const authenticationAudit = hydrateExternalActorAudit(
    row,
    row.actorClientId ?? '',
  )
  const expectedAuthor = authenticationAudit.delegatedUserId
    ? {
        id: authenticationAudit.delegatedUserId,
        name: authenticationAudit.delegatedUserId,
        type: 'user' as const,
      }
    : {
        id: authenticationAudit.clientId,
        name: authenticationAudit.clientId,
        type: 'api-client' as const,
      }
  if (
    row.authorId !== expectedAuthor.id ||
    row.authorName !== expectedAuthor.name ||
    row.authorType !== expectedAuthor.type
  ) throw new DomainError(
    'PERSISTENCE_CONFLICT',
    'Stored review annotation author does not match its authentication audit',
  )
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
    authenticationAudit,
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

type ProjectionManifestRow = Prisma.V2MediaArtifactManifestGetPayload<{
  include: { recipeParameters: true; renderInput: true }
}>
type ProjectionArtifactRow = Pick<V2MediaArtifact,
  'id' | 'workspaceId' | 'artifactKey' | 'sha256' | 'byteSize' | 'mediaType' | 'container'>

function protectedProjectionMetadata(value: {
  canonicalByteSize: number; algorithm: string; keyId: string; nonce: string; ciphertext: string; authTag: string
}, maximumBytes: number): boolean {
  // Same stored-envelope metadata contract as media-artifact-repository.
  // No plaintext/storage reads or new authorization are performed here.
  return Number.isSafeInteger(value.canonicalByteSize) && value.canonicalByteSize > 0 &&
    value.canonicalByteSize <= maximumBytes && value.algorithm === 'aes-256-gcm' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.keyId) && /^[A-Za-z0-9_-]{16}$/.test(value.nonce) &&
    value.ciphertext.length > 0 && /^[A-Za-z0-9_-]{22}$/.test(value.authTag)
}

/** Shared integrity reader for review/workspace projections. A syntactically
 * valid resealed document still has to equal the scoped immutable row facts.
 * This does not authenticate MP4 bytes, decrypt payloads or grant rendering. */
export function readStoredProjectionManifest(workspaceId: string, artifact: ProjectionArtifactRow,
  stored: ProjectionManifestRow): Readonly<MediaArtifactManifest> {
  try {
    const manifest = JSON.parse(stored.manifestJson) as MediaArtifactManifest
    assertMediaArtifactManifest(manifest)
    const identityMatches = artifact.workspaceId === workspaceId && stored.workspaceId === workspaceId &&
      stored.artifactId === artifact.id && manifest.artifact.artifactKey === artifact.artifactKey &&
      manifest.artifact.sha256 === artifact.sha256 && BigInt(manifest.artifact.byteSize) === artifact.byteSize &&
      manifest.artifact.mediaType === artifact.mediaType && manifest.artifact.container === artifact.container
    const columnsMatch = manifest.schemaVersion === stored.schemaVersion && manifest.manifestHash === stored.manifestHash &&
      manifest.recipe.id === stored.recipeId && manifest.recipe.version === stored.recipeVersion &&
      manifest.recipe.parametersHash === stored.parametersHash
    const recipeParametersMatch = manifest.schemaVersion === 'media-artifact-manifest/v3' ||
      manifest.schemaVersion === 'media-artifact-manifest/v4'
      ? stored.recipeParametersRef === manifest.recipe.parametersRef && stored.recipeParameters !== null &&
        stored.recipeParameters.workspaceId === workspaceId && stored.recipeParameters.ref === manifest.recipe.parametersRef &&
        stored.recipeParameters.ref === `recipe-parameters/sha256/${manifest.recipe.parametersHash}` &&
        stored.recipeParameters.parametersHash === manifest.recipe.parametersHash &&
        protectedProjectionMetadata(stored.recipeParameters, 1024 * 1024)
      : stored.recipeParametersRef === null && stored.recipeParameters === null
    const renderInputMatch = manifest.schemaVersion === 'media-artifact-manifest/v4'
      ? stored.renderInputRef === manifest.renderInput.ref && stored.renderInputHash === manifest.renderInput.inputHash &&
        stored.renderInput !== null && stored.renderInput.workspaceId === workspaceId &&
        stored.renderInput.ref === manifest.renderInput.ref && stored.renderInput.ref === `render-input/sha256/${manifest.renderInput.inputHash}` &&
        stored.renderInput.inputHash === manifest.renderInput.inputHash && protectedProjectionMetadata(stored.renderInput, 4 * 1024 * 1024)
      : stored.renderInputRef === null && stored.renderInputHash === null && stored.renderInput === null
    if (!identityMatches || !columnsMatch || !recipeParametersMatch || !renderInputMatch) throw new Error('binding mismatch')
    return Object.freeze(manifest)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored projection manifest failed integrity or row binding validation',
      { manifestId: stored.id })
  }
}

interface ProxyCandidate {
  artifactId: string
  projectVersionId?: string
  createdAt: Date
}

export type ReviewPreviewReader = Pick<Prisma.TransactionClient,
  'v2Project' | 'v2ProjectFinalExportOperation' | 'v2ProjectProxyRenderOperation' |
  'v2ProjectMediaAsset' | 'v2MediaArtifact' | '$queryRawUnsafe'>

/**
 * `variantId` is the stable variant of the State the review is about; absent means the State's only output (several outputs
 * without it are refused with `output-variant-required`). The proxy a review is about is the render made for that output.
 */
export type ReviewPreviewInput = Readonly<{ workspaceId: string; projectId: string; projectVersionId?: string; variantId?: string }>

/**
 * The review preview of one Version. The output the review is about is the one the persisted consumption reader admits for the
 * `critic` purpose: the State of exactly the selected Version (the head, or the historical one asked for), its output (the
 * explicit `variantId`, or the only one), and the format that output carries. A Version whose output cannot be critiqued (a copy no
 * editorial cut has materialized, a project without outputs, several outputs without a variant, a State that fails its seal) is
 * refused with the published reason, before any proxy is looked for. The proxy is then the render made for that output: another
 * output's render of the same Version is never offered, and a render of the selected Version is exact only for its own output.
 */
export async function readReviewPreviewContext(
  client: ReviewPreviewReader,
  input: ReviewPreviewInput,
): Promise<Readonly<ReviewPreviewContext> | null> {
  const found = await locateReviewPreview(client, input, (versionId) => requireCriticOutputConsumption(client, {
    workspaceId: input.workspaceId, projectId: input.projectId, versionId, ...(input.variantId ? { variantId: input.variantId } : {}) }),
  (admission) => ({ state: admission.state, variantId: admission.entry.variantId }))
  if (!found) return null
  const { located: { scopeCounts, ...facts }, admission } = found
  const variantIds = Object.freeze(outputVariantsOf(admission.state).map((variant) => variant.variantId))
  return Object.freeze({
    ...facts,
    formatId: admission.formatId,
    variantId: admission.entry.variantId,
    variantIds,
    outputConsumption: Object.freeze({ sealHash: admission.sealHash, seal: admission.seal }),
    availableScopeCounts: Object.freeze({ ...scopeCounts, formats: variantIds.length }) as ReviewPreviewContext['availableScopeCounts'],
  })
}

/** What the workspace reports of the review preview: which proxy a review of the Version would be about, and whether it is stale. */
export type ReviewPreviewAvailability = Readonly<Pick<ReviewPreviewContext,
  'currentProjectVersionId' | 'projectVersionId' | 'sourceVersionId' | 'proxyArtifactId' | 'proxyHash' | 'stale'>>

/**
 * The proxy a review of the Version would be about, as a read model: it describes which proxy exists and whether it is stale, and
 * admits nothing. Whether the output behind it may be critiqued is the consumers' verdict (the preview and the annotation refuse a
 * copy no editorial cut has materialized with the published reason), not a fact this description invents a reason for.
 */
export async function readReviewPreviewAvailability(
  client: ReviewPreviewReader,
  input: Omit<ReviewPreviewInput, 'variantId'>,
): Promise<ReviewPreviewAvailability | null> {
  const found = await locateReviewPreview(client, input, async () => null)
  if (!found) return null
  const { currentProjectVersionId, projectVersionId, sourceVersionId, proxyArtifactId, proxyHash, stale } = found.located
  return Object.freeze({ currentProjectVersionId, projectVersionId, sourceVersionId, proxyArtifactId, proxyHash, stale })
}

/** The preview without the facts only the output's admission knows (its format, its variant and the format scope count). */
type LocatedReviewPreview = Omit<ReviewPreviewContext, 'formatId' | 'variantId' | 'variantIds' | 'outputConsumption' | 'availableScopeCounts'> &
  { scopeCounts: Omit<ReviewPreviewContext['availableScopeCounts'], 'formats'> }

/** The output a review of the Version is about: the State of the selected Version and the stable variant admitted from it. */
type ReviewedOutput = Readonly<{ state: OutputConsumptionState; variantId: string }>

/**
 * Selects the Version and the proxy a review of it is about. `admit` runs as soon as the Version is selected (before any operation
 * or proxy is read): the consumers pass the critic admission, the availability read model passes nothing. `outputOf` says which
 * output the admission is about; the renders considered are then that output's only (the availability read model, which names no
 * output, describes the renders of the Version whatever output they were made for).
 */
async function locateReviewPreview<Admission>(
  client: ReviewPreviewReader,
  input: Omit<ReviewPreviewInput, 'variantId'>,
  admit: (versionId: string) => Promise<Admission>,
  outputOf?: (admission: Admission) => ReviewedOutput,
): Promise<{ located: LocatedReviewPreview; admission: Admission } | null> {
  const project = await client.v2Project.findFirst({
    where: { id: input.projectId, workspaceId: input.workspaceId },
    select: {
      id: true,
      currentVersionId: true,
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
  const admission = await admit(selectedVersion.id)
  const output = outputOf?.(admission) ?? null
  const [allFinalOperations, allProxyOperations] = await Promise.all([
    client.v2ProjectFinalExportOperation.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
      orderBy: { createdAt: 'desc' },
      select: { outputArtifactId: true, projectVersionId: true, outputVariantId: true, outputAspectRatio: true, createdAt: true, operation: { select: { workspaceId: true, projectId: true } } },
    }),
    client.v2ProjectProxyRenderOperation.findMany({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, operation: { status: 'succeeded' } },
      orderBy: { createdAt: 'desc' },
      select: { outputArtifactId: true, projectVersionId: true, outputVariantId: true, createdAt: true, operation: { select: { workspaceId: true, projectId: true } } },
    }),
  ])
  if ([...allFinalOperations, ...allProxyOperations].some((record) => record.operation.workspaceId !== input.workspaceId ||
    record.operation.projectId !== input.projectId)) throw new DomainError('PERSISTENCE_CONFLICT', 'Review preview operation belongs to another project')
  // The renders of the output the review is about: a render names the output it was made for, and another output's render of the
  // same Version is not the preview of this one (nor does it make this one's preview current).
  const finalOperations = output ? allFinalOperations.filter((record) => renderRowIsOfVariant(output.state, record, output.variantId)) : allFinalOperations
  const proxyOperations = output ? allProxyOperations.filter((record) => renderRowIsOfVariant(output.state, record, output.variantId)) : allProxyOperations
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
    const editingProxy = await client.v2ProjectMediaAsset.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, role: 'editing-proxy' },
      orderBy: { createdAt: 'desc' },
    })
    if (editingProxy) candidate = { artifactId: editingProxy.artifactId, createdAt: editingProxy.createdAt }
  }
  if (!candidate) return null
  const artifact = await client.v2MediaArtifact.findFirst({
    where: { id: candidate.artifactId, workspaceId: input.workspaceId, status: 'available' },
    include: { manifests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 1,
      include: { recipeParameters: true, renderInput: true } } },
  })
  if (!artifact?.manifests[0]) throw new DomainError('PERSISTENCE_CONFLICT', 'Review proxy artifact has no manifest')
  const manifest = readStoredProjectionManifest(input.workspaceId, artifact, artifact.manifests[0])
  const probe: Partial<NonNullable<MediaArtifactManifest['probe']>> = manifest.probe ?? {}
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
  const located: LocatedReviewPreview = Object.freeze({
    currentProjectVersionId: project.currentVersionId,
    projectVersionId: selectedVersion.id,
    sourceVersionId: candidate.projectVersionId ?? null,
    proxyArtifactId: artifact.id,
    proxyHash: artifact.sha256,
    fps,
    width: probe.width,
    height: probe.height,
    durationFrames,
    stale: selectedVersion.id !== project.currentVersionId || candidate.projectVersionId !== selectedVersion.id,
    localeId: project.locale ?? 'pt-BR',
    recipeIds,
    scopeCounts: Object.freeze({
      frame: durationFrames,
      region: 1,
      clip: scenes.length,
      scene: scenes.length,
      range: 1,
      project: 1,
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
  return { located, admission }
}

export class PrismaReviewAnnotationRepository implements ReviewAnnotationRepository {
  private readonly client: PrismaClient
  private readonly createEventId: () => string

  constructor(client: PrismaClient, createEventId: () => string = randomUUID) {
    this.client = client
    this.createEventId = createEventId
  }

  async readPreviewContext(input: ReviewPreviewInput): Promise<Readonly<ReviewPreviewContext> | null> {
    return readReviewPreviewContext(this.client, input)
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

  async findIdempotent(input: { workspaceId: string; projectId: string; idempotencyKey: string; actorContextHash: string }) {
    const row = await this.client.v2ReviewAnnotation.findFirst({
      where: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey },
    })
    if (!row) return null
    const annotation = toAnnotation(row)
    if (
      annotation.authenticationAudit.contextHash !== input.actorContextHash
    ) throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Review annotation idempotency key belongs to another authentication context',
    )
    return Object.freeze({ requestFingerprint: row.requestFingerprint, annotation })
  }

  async create(input: {
    workspaceId: string
    projectId: string
    annotation: PersistedReviewAnnotation
    idempotencyKey: string
    requestFingerprint: string
    /** The stable variant of the State being critiqued; absent means the State's only output. */
    variantId?: string
  }) {
    try {
      return await this.client.$transaction(async (transaction: Prisma.TransactionClient) => {
      const existing = await transaction.v2ReviewAnnotation.findFirst({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, idempotencyKey: input.idempotencyKey },
      })
      if (existing) {
        if (existing.requestFingerprint !== input.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Annotation idempotency payload changed')
        const annotation = toAnnotation(existing)
        if (
          annotation.authenticationAudit.contextHash !==
            input.annotation.authenticationAudit.contextHash
        ) throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Review annotation replay belongs to another authentication context',
        )
        return annotation
      }
      const project = await transaction.v2Project.findFirst({
        where: { id: input.projectId, workspaceId: input.workspaceId },
        select: { currentVersionId: true },
      })
      if (!project) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
      if (project.currentVersionId !== input.annotation.projectVersionId) {
        throw new DomainError('VERSION_CONFLICT', 'Project version changed before annotation persistence', { currentVersionId: project.currentVersionId })
      }
      // The annotation is a critique of the output of exactly this Version. A copy that no editorial cut has given target authority
      // is not reviewed (the proxies it links belong to its source), nor is a Version whose output the reader cannot admit.
      await requireCriticOutputConsumption(transaction, { workspaceId: input.workspaceId, projectId: input.projectId, versionId: project.currentVersionId!,
        ...(input.variantId ? { variantId: input.variantId } : {}) })
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
          actorClientId: input.annotation.authenticationAudit.clientId,
          ...externalActorAuditData(
            input.annotation.authenticationAudit,
            input.workspaceId,
            input.annotation.authenticationAudit.clientId,
          ),
          status: input.annotation.status,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint: input.requestFingerprint,
          createdAt,
          updatedAt: createdAt,
        },
      })
      await persistPublicEvents(transaction, [createPublicEvent({
        id: this.createEventId(),
        type: 'annotation.created',
        version: '1.0.0',
        workspaceId: input.workspaceId,
        occurredAt: input.annotation.createdAt,
        actor: input.annotation.author.type === 'user'
          ? { userId: input.annotation.author.id }
          : { clientId: input.annotation.author.id },
        resource: { type: 'annotation', id: input.annotation.id },
        data: {
          projectId: input.projectId,
          projectVersionId: input.annotation.projectVersionId,
          proxyArtifactId: input.annotation.proxyArtifactId,
          frame: input.annotation.frame,
          scope: input.annotation.scope,
          status: input.annotation.status,
        },
      })])
      return toAnnotation(row)
      }, { isolationLevel: 'Serializable' })
    } catch (error) {
      if (!isPrismaCode(error, 'P2002')) {
        throw error
      }
      const replay = await this.findIdempotent({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        actorContextHash: input.annotation.authenticationAudit.contextHash,
      })
      if (!replay) throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Concurrent review annotation did not publish an idempotent winner',
      )
      if (replay.requestFingerprint !== input.requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Concurrent review annotation changed its idempotency payload',
        )
      }
      return replay.annotation
    }
  }
}

import {
  Prisma,
  type PrismaClient,
  type V2AssetRightsSnapshot,
  type V2LongFormChapter,
  type V2LongFormIndexRun,
  type V2LongFormMoment,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateLongFormIndexRecordHash,
} from '../../application/catalog-long-form-moments.ts'
import type {
  LongFormIndexCreationContext,
  LongFormIndexRepository,
  LongFormMomentSearchQuery,
  LongFormMomentSearchResult,
  LongFormRightsSnapshot,
  PersistedLongFormIndexRun,
} from '../../application/ports/long-form-index-repository.ts'
import {
  assertMediaArtifactManifest,
  type MediaArtifactManifest,
} from '../../domain/media-artifact.ts'
import {
  buildLongFormMomentPreview,
  LONG_FORM_INDEX_POLICY_VERSION,
  type CatalogedLongFormChapter,
  type CatalogedLongFormMoment,
  type LongFormObservation,
  type LongFormProducer,
} from '../../domain/long-form-moment.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { normalizeSpeechText } from '../../domain/speech-segment-catalog.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

type RunWithHierarchy = V2LongFormIndexRun & {
  chapters: V2LongFormChapter[]
  moments: V2LongFormMoment[]
}

type SearchRow = V2LongFormMoment & {
  chapter: V2LongFormChapter
  indexRun: V2LongFormIndexRun & {
    sourceArtifact: {
      currentRightsSnapshot: V2AssetRightsSnapshot | null
    }
    moments: {
      id: string
      chapterId: string
      ordinal: number
    }[]
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  )
}

function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid JSON`,
    )
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return value as Record<string, unknown>
}

function array(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} is invalid`,
    )
  }
  return value
}

function observation(
  value: string,
  field: string,
): Readonly<LongFormObservation> {
  return Object.freeze(
    record(
      parseJson(value, field),
      field,
    ) as unknown as LongFormObservation,
  )
}

function strings(value: string, field: string): readonly string[] {
  const items = array(parseJson(value, field), field)
  if (!items.every((item) => typeof item === 'string')) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} must contain strings`,
    )
  }
  return Object.freeze(items as string[])
}

function ranges(
  value: string,
  field: string,
): readonly (readonly [number, number])[] {
  const items = array(parseJson(value, field), field)
  if (
    !items.every(
      (item) =>
        Array.isArray(item) &&
        item.length === 2 &&
        item.every(Number.isSafeInteger),
    )
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored ${field} must contain integer ranges`,
    )
  }
  const typed = items as readonly (readonly [number, number])[]
  return Object.freeze(typed.map((item) =>
    Object.freeze([item[0], item[1]]) as readonly [number, number]))
}

function normalizedLines(values: readonly string[]): string {
  return `\n${values.map(normalizeSpeechText).join('\n')}\n`
}

function searchText(input: {
  topic: Readonly<LongFormObservation>
  summary: Readonly<LongFormObservation>
  keyQuote?: Readonly<LongFormObservation>
  roles: readonly string[]
  tags: readonly string[]
}): string {
  return [
    input.topic.normalizedValue,
    input.summary.normalizedValue,
    input.keyQuote?.normalizedValue,
    ...input.roles.map(normalizeSpeechText),
    ...input.tags.map(normalizeSpeechText),
  ].filter((value): value is string => Boolean(value)).join('\n')
}

function rightsSnapshot(
  row: V2AssetRightsSnapshot,
): Readonly<LongFormRightsSnapshot> {
  return Object.freeze({
    id: row.id,
    status: row.status,
    consentStatus: row.consentStatus,
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(row.consentExpiresAt
      ? { consentExpiresAt: row.consentExpiresAt.toISOString() }
      : {}),
  })
}

function effectiveRights(
  current: Readonly<LongFormRightsSnapshot> | null,
  now: string,
): Readonly<{
  id: string
  status: string
  consentStatus: string
}> {
  if (!current) {
    return Object.freeze({
      id: 'rights-missing',
      status: 'unknown',
      consentStatus: 'unknown',
    })
  }
  const instant = Date.parse(now)
  return Object.freeze({
    id: current.id,
    status:
      current.expiresAt && Date.parse(current.expiresAt) <= instant
        ? 'expired'
        : current.status,
    consentStatus:
      current.consentExpiresAt &&
      Date.parse(current.consentExpiresAt) <= instant
        ? 'expired'
        : current.consentStatus,
  })
}

function hydrateMoment(
  row: V2LongFormMoment,
): Readonly<CatalogedLongFormMoment> {
  const topic = observation(row.topicJson, 'long-form moment topic')
  const summary = observation(row.summaryJson, 'long-form moment summary')
  const keyQuote = row.keyQuoteJson
    ? observation(row.keyQuoteJson, 'long-form moment key quote')
    : undefined
  const speakerIds = strings(
    row.speakerIdsJson,
    'long-form moment speakers',
  )
  const momentRanges = ranges(row.rangesJson, 'long-form moment ranges')
  const evidenceSpanIds = strings(
    row.evidenceSpanIdsJson,
    'long-form evidence spans',
  )
  const roles = strings(row.rolesJson, 'long-form moment roles')
  const tags = strings(row.tagsJson, 'long-form moment tags')
  const recommendedRange = momentRanges[row.recommendedRangeIndex]
  if (!recommendedRange) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored long-form moment ${row.id} has no recommended range`,
    )
  }
  const content = Object.freeze({
    schemaVersion: 'long-form-moment/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    indexRunId: row.indexRunId,
    chapterId: row.chapterId,
    sourceArtifactId: row.sourceArtifactId,
    sourceMomentId: row.sourceMomentId,
    topic,
    summary,
    ...(keyQuote ? { keyQuote } : {}),
    speakerIds,
    rangesMs: momentRanges,
    recommendedRangeIndex: row.recommendedRangeIndex,
    recommendedRangeMs: recommendedRange,
    evidenceSpanIds,
    salience: row.salience,
    hookPotential: row.hookPotential,
    standaloneScore: row.standaloneScore,
    contextScore: row.contextScore,
    insightDensity: row.insightDensity,
    roles,
    tags,
    physicalMaterialized: false as const,
    indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.physicalMaterialized ||
    row.indexPolicyVersion !== LONG_FORM_INDEX_POLICY_VERSION ||
    row.recommendedStartMs !== recommendedRange[0] ||
    row.recommendedEndMs !== recommendedRange[1] ||
    topic.normalizedValue !== row.topicNormalized ||
    summary.normalizedValue !== row.summaryNormalized ||
    (keyQuote?.normalizedValue ?? null) !== row.keyQuoteNormalized ||
    normalizedLines(speakerIds) !== row.speakersNormalized ||
    normalizedLines(roles) !== row.rolesNormalized ||
    normalizedLines(tags) !== row.tagsNormalized ||
    searchText({ topic, summary, keyQuote, roles, tags }) !==
      row.searchTextNormalized ||
    stableSerialize(topic) !== row.topicJson ||
    stableSerialize(summary) !== row.summaryJson ||
    (keyQuote ? stableSerialize(keyQuote) : null) !== row.keyQuoteJson ||
    stableSerialize(speakerIds) !== row.speakerIdsJson ||
    stableSerialize(momentRanges) !== row.rangesJson ||
    stableSerialize(evidenceSpanIds) !== row.evidenceSpanIdsJson ||
    stableSerialize(roles) !== row.rolesJson ||
    stableSerialize(tags) !== row.tagsJson ||
    calculateCanonicalHash(content) !== row.momentHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored long-form moment ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({ ...content, momentHash: row.momentHash })
}

function hydrateChapter(
  row: V2LongFormChapter,
  momentIds: readonly string[],
): Readonly<CatalogedLongFormChapter> {
  const title = observation(row.titleJson, 'long-form chapter title')
  const topicPath = strings(
    row.topicPathJson,
    'long-form chapter topic path',
  )
  const content = Object.freeze({
    schemaVersion: 'long-form-chapter/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    indexRunId: row.indexRunId,
    sourceArtifactId: row.sourceArtifactId,
    sourceChapterId: row.sourceChapterId,
    title,
    topicPath,
    rangeMs: Object.freeze([
      row.startMs,
      row.endMs,
    ]) as readonly [number, number],
    momentIds: Object.freeze([...momentIds]),
    physicalMaterialized: false as const,
    indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.physicalMaterialized ||
    row.indexPolicyVersion !== LONG_FORM_INDEX_POLICY_VERSION ||
    title.normalizedValue !== row.titleNormalized ||
    normalizedLines(topicPath) !== row.topicPathNormalized ||
    stableSerialize(title) !== row.titleJson ||
    stableSerialize(topicPath) !== row.topicPathJson ||
    calculateCanonicalHash(content) !== row.chapterHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored long-form chapter ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({ ...content, chapterHash: row.chapterHash })
}

function hydrateRun(
  row: RunWithHierarchy,
): Readonly<PersistedLongFormIndexRun> {
  const orderedMomentRows = [...row.moments].sort(
    (left, right) => left.ordinal - right.ordinal,
  )
  const moments = Object.freeze(orderedMomentRows.map(hydrateMoment))
  const chapters = Object.freeze([...row.chapters]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((chapter) =>
      hydrateChapter(
        chapter,
        moments
          .filter((moment) => moment.chapterId === chapter.id)
          .map((moment) => moment.id),
      )))
  const producer = Object.freeze(
    record(
      parseJson(row.producerJson, 'long-form producer'),
      'long-form producer',
    ) as unknown as LongFormProducer,
  )
  const content = Object.freeze({
    schemaVersion: 'long-form-index-run/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceArtifactId: row.sourceArtifactId,
    sourceArtifactSha256: row.sourceArtifactSha256,
    sourceManifestId: row.sourceManifestId,
    sourceManifestHash: row.sourceManifestHash,
    durationMs: row.durationMs,
    rightsSnapshotId: row.rightsSnapshotId,
    rightsStatus: row.rightsStatus,
    consentStatus: row.consentStatus,
    indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
    producer,
    chapters,
    moments,
    chapterCount: row.chapterCount,
    momentCount: row.momentCount,
    hierarchyHash: row.hierarchyHash,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdBy: Object.freeze({
      type: 'api-client' as const,
      id: row.createdById,
    }),
    createdAt: row.createdAt.toISOString(),
  })
  if (
    row.createdByType !== 'api-client' ||
    row.indexPolicyVersion !== LONG_FORM_INDEX_POLICY_VERSION ||
    row.chapterCount !== chapters.length ||
    row.momentCount !== moments.length ||
    stableSerialize(producer) !== row.producerJson ||
    calculateCanonicalHash({ chapters, moments }) !== row.hierarchyHash ||
    calculateLongFormIndexRecordHash(content) !== row.recordHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored long-form index ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    recordHash: row.recordHash,
    active: row.active,
  })
}

function chapterData(
  chapter: Readonly<CatalogedLongFormChapter>,
  ordinal: number,
) {
  return {
    id: chapter.id,
    workspaceId: chapter.workspaceId,
    projectId: chapter.projectId,
    indexRunId: chapter.indexRunId,
    sourceArtifactId: chapter.sourceArtifactId,
    sourceChapterId: chapter.sourceChapterId,
    ordinal,
    titleJson: stableSerialize(chapter.title),
    titleNormalized: chapter.title.normalizedValue,
    topicPathJson: stableSerialize(chapter.topicPath),
    topicPathNormalized: normalizedLines(chapter.topicPath),
    startMs: chapter.rangeMs[0],
    endMs: chapter.rangeMs[1],
    physicalMaterialized: chapter.physicalMaterialized,
    indexPolicyVersion: chapter.indexPolicyVersion,
    createdAt: new Date(chapter.createdAt),
    chapterHash: chapter.chapterHash,
  }
}

function momentData(
  moment: Readonly<CatalogedLongFormMoment>,
  ordinal: number,
) {
  return {
    id: moment.id,
    workspaceId: moment.workspaceId,
    projectId: moment.projectId,
    indexRunId: moment.indexRunId,
    chapterId: moment.chapterId,
    sourceArtifactId: moment.sourceArtifactId,
    sourceMomentId: moment.sourceMomentId,
    ordinal,
    topicJson: stableSerialize(moment.topic),
    topicNormalized: moment.topic.normalizedValue,
    summaryJson: stableSerialize(moment.summary),
    summaryNormalized: moment.summary.normalizedValue,
    keyQuoteJson: moment.keyQuote
      ? stableSerialize(moment.keyQuote)
      : undefined,
    keyQuoteNormalized: moment.keyQuote?.normalizedValue,
    speakerIdsJson: stableSerialize(moment.speakerIds),
    speakersNormalized: normalizedLines(moment.speakerIds),
    rangesJson: stableSerialize(moment.rangesMs),
    recommendedRangeIndex: moment.recommendedRangeIndex,
    recommendedStartMs: moment.recommendedRangeMs[0],
    recommendedEndMs: moment.recommendedRangeMs[1],
    evidenceSpanIdsJson: stableSerialize(moment.evidenceSpanIds),
    salience: moment.salience,
    hookPotential: moment.hookPotential,
    standaloneScore: moment.standaloneScore,
    contextScore: moment.contextScore,
    insightDensity: moment.insightDensity,
    rolesJson: stableSerialize(moment.roles),
    rolesNormalized: normalizedLines(moment.roles),
    tagsJson: stableSerialize(moment.tags),
    tagsNormalized: normalizedLines(moment.tags),
    searchTextNormalized: searchText(moment),
    physicalMaterialized: moment.physicalMaterialized,
    indexPolicyVersion: moment.indexPolicyVersion,
    createdAt: new Date(moment.createdAt),
    momentHash: moment.momentHash,
  }
}

function runData(run: Readonly<PersistedLongFormIndexRun>) {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    sourceArtifactId: run.sourceArtifactId,
    sourceArtifactSha256: run.sourceArtifactSha256,
    sourceManifestId: run.sourceManifestId,
    sourceManifestHash: run.sourceManifestHash,
    durationMs: run.durationMs,
    rightsSnapshotId: run.rightsSnapshotId,
    rightsStatus: run.rightsStatus,
    consentStatus: run.consentStatus,
    indexPolicyVersion: run.indexPolicyVersion,
    producerJson: stableSerialize(run.producer),
    chapterCount: run.chapterCount,
    momentCount: run.momentCount,
    hierarchyHash: run.hierarchyHash,
    requestFingerprint: run.requestFingerprint,
    idempotencyKey: run.idempotencyKey,
    recordHash: run.recordHash,
    active: run.active,
    createdByType: run.createdBy.type,
    createdById: run.createdBy.id,
    createdAt: new Date(run.createdAt),
  }
}

function parseManifest(
  manifestJson: string,
  expectedHash: string,
): MediaArtifactManifest {
  let manifest: MediaArtifactManifest
  try {
    manifest = JSON.parse(manifestJson) as MediaArtifactManifest
  } catch {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored long-form source manifest is invalid JSON',
    )
  }
  assertMediaArtifactManifest(manifest)
  if (
    manifest.manifestHash !== expectedHash ||
    stableSerialize(manifest) !== manifestJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored long-form source manifest failed integrity validation',
    )
  }
  return manifest
}

function durationMs(manifest: MediaArtifactManifest): number {
  const duration = manifest.probe?.duration
  const milliseconds = Number.isFinite(duration)
    ? Math.round(Number(duration) * 1_000)
    : 0
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'Long-form source manifest requires a positive media duration',
    )
  }
  return milliseconds
}

function includeHierarchy() {
  return {
    chapters: { orderBy: { ordinal: 'asc' as const } },
    moments: { orderBy: { ordinal: 'asc' as const } },
  }
}

export class PrismaLongFormIndexRepository
implements LongFormIndexRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<LongFormIndexCreationContext> | null> {
    const artifact = await this.client.v2MediaArtifact.findFirst({
      where: {
        id: input.sourceArtifactId,
        workspaceId: input.workspaceId,
        status: 'available',
        mediaType: 'video',
        projectAssets: {
          some: {
            projectId: input.projectId,
            workspaceId: input.workspaceId,
          },
        },
      },
      include: {
        manifests: {
          where: { id: input.sourceManifestId },
          take: 1,
        },
        currentRightsSnapshot: true,
      },
    })
    const manifestRow = artifact?.manifests[0]
    if (!artifact || !manifestRow || !artifact.currentRightsSnapshot) {
      return null
    }
    const manifest = parseManifest(
      manifestRow.manifestJson,
      manifestRow.manifestHash,
    )
    if (
      manifest.artifact.sha256 !== artifact.sha256 ||
      manifest.artifact.mediaType !== 'video'
    ) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Long-form manifest does not identify its stored video artifact',
      )
    }
    return Object.freeze({
      sourceArtifactId: artifact.id,
      sourceArtifactSha256: artifact.sha256,
      sourceManifestId: manifestRow.id,
      sourceManifestHash: manifestRow.manifestHash,
      durationMs: durationMs(manifest),
      rights: rightsSnapshot(artifact.currentRightsSnapshot),
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2LongFormIndexRun.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
      include: includeHierarchy(),
    })
    return row ? hydrateRun(row) : null
  }

  async persist(
    run: Readonly<PersistedLongFormIndexRun>,
  ): ReturnType<LongFormIndexRepository['persist']> {
    const persisted = await this.persistInternal(run)
    if (!persisted) {
      throw new DomainError(
        'PERSISTENCE_CONFLICT',
        'Unfenced long-form persistence unexpectedly lost a lease',
      )
    }
    return persisted
  }

  async persistWithLongFormLease(
    input: Parameters<
      LongFormIndexRepository['persistWithLongFormLease']
    >[0],
  ): ReturnType<
    LongFormIndexRepository['persistWithLongFormLease']
  > {
    if (input.fence.stage !== 'moments') {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Long-form index output requires the moments stage fence',
      )
    }
    if (
      input.fence.workspaceId !== input.run.workspaceId ||
      input.fence.projectId !== input.run.projectId
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form index fence belongs to another tenant or project',
      )
    }
    return this.persistInternal(input.run, input.fence)
  }

  private async persistInternal(
    run: Readonly<PersistedLongFormIndexRun>,
    fence?: Parameters<
      LongFormIndexRepository['persistWithLongFormLease']
    >[0]['fence'],
    attempt = 1,
  ): ReturnType<
    LongFormIndexRepository['persistWithLongFormLease']
  > {
    const fenceNow = fence ? new Date(fence.now) : undefined
    if (fenceNow && Number.isNaN(fenceNow.getTime())) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Long-form persistence fence instant is invalid',
      )
    }
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing = await transaction.v2LongFormIndexRun.findUnique({
          where: {
            workspaceId_projectId_idempotencyKey: {
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              idempotencyKey: run.idempotencyKey,
            },
          },
          include: includeHierarchy(),
        })
        if (existing) {
          if (existing.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different long-form index request',
            )
          }
          return Object.freeze({
            run: hydrateRun(existing),
            replayed: true,
          })
        }
        if (fence) {
          const [operation, stage] = await Promise.all([
            transaction.v2PublicOperation.findFirst({
              where: {
                id: fence.operationId,
                workspaceId: run.workspaceId,
                type: 'long-form-index',
                status: 'running',
                leaseOwner: fence.leaseOwner,
                attempt: fence.operationAttempt,
                leaseExpiresAt: { gt: fenceNow! },
              },
              select: { id: true },
            }),
            transaction.v2LongFormIndexStageCheckpoint.findFirst({
              where: {
                workflowId: fence.workflowId,
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                stage: 'moments',
                status: 'running',
                inputHash: fence.expectedStageInputHash,
                idempotencyKey:
                  fence.expectedStageIdempotencyKey,
                workflow: {
                  operationId: fence.operationId,
                  sourceArtifactId: run.sourceArtifactId,
                  sourceArtifactSha256:
                    run.sourceArtifactSha256,
                  sourceManifestId: run.sourceManifestId,
                  sourceManifestHash: run.sourceManifestHash,
                },
              },
              select: { id: true },
            }),
          ])
          if (
            !operation ||
            !stage ||
            run.idempotencyKey !==
              fence.expectedStageIdempotencyKey
          ) {
            return null
          }
        }
        const [artifact, actor] = await Promise.all([
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: run.sourceArtifactId,
              workspaceId: run.workspaceId,
              status: 'available',
              mediaType: 'video',
              currentRightsSnapshotId: run.rightsSnapshotId,
              projectAssets: {
                some: {
                  projectId: run.projectId,
                  workspaceId: run.workspaceId,
                },
              },
            },
            include: {
              manifests: {
                where: { id: run.sourceManifestId },
                take: 1,
              },
              currentRightsSnapshot: true,
            },
          }),
          transaction.v2ApiClient.findFirst({
            where: {
              id: run.createdBy.id,
              workspaceId: run.workspaceId,
              status: 'active',
            },
            select: { id: true },
          }),
        ])
        const manifestRow = artifact?.manifests[0]
        if (
          !artifact ||
          !manifestRow ||
          !artifact.currentRightsSnapshot ||
          !actor
        ) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Long-form commit context is no longer available',
          )
        }
        if (
          fence &&
          (
            artifact.currentRightsSnapshot.status !== 'approved' ||
            !['approved', 'not-required'].includes(
              artifact.currentRightsSnapshot.consentStatus,
            ) ||
            (
              artifact.currentRightsSnapshot.expiresAt &&
              artifact.currentRightsSnapshot.expiresAt <= fenceNow!
            ) ||
            (
              artifact.currentRightsSnapshot.consentExpiresAt &&
              artifact.currentRightsSnapshot.consentExpiresAt <=
                fenceNow!
            )
          )
        ) {
          throw new DomainError(
            'ASSET_RIGHTS_BLOCKED',
            'Long-form source rights no longer allow moment indexing',
          )
        }
        const manifest = parseManifest(
          manifestRow.manifestJson,
          manifestRow.manifestHash,
        )
        if (
          artifact.sha256 !== run.sourceArtifactSha256 ||
          manifestRow.manifestHash !== run.sourceManifestHash ||
          durationMs(manifest) !== run.durationMs ||
          artifact.currentRightsSnapshot.status !== run.rightsStatus ||
          artifact.currentRightsSnapshot.consentStatus !== run.consentStatus
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Long-form source or rights changed before commit',
          )
        }
        await transaction.v2LongFormIndexRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            sourceArtifactId: run.sourceArtifactId,
            active: true,
          },
          data: { active: false },
        })
        await transaction.v2LongFormIndexRun.create({
          data: runData(run),
        })
        await transaction.v2LongFormChapter.createMany({
          data: run.chapters.map(chapterData),
        })
        await transaction.v2LongFormMoment.createMany({
          data: run.moments.map(momentData),
        })
        const created = await transaction.v2LongFormIndexRun.findUnique({
          where: { id: run.id },
          include: includeHierarchy(),
        })
        if (!created) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Long-form index disappeared during commit',
          )
        }
        return Object.freeze({
          run: hydrateRun(created),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persistInternal(run, fence, attempt + 1)
      }
      if (isPrismaCode(error, 'P2002')) {
        const replay = await this.findIdempotent({
          workspaceId: run.workspaceId,
          projectId: run.projectId,
          idempotencyKey: run.idempotencyKey,
        })
        if (replay) {
          if (replay.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different long-form index request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
        if (attempt < 3) {
          return this.persistInternal(run, fence, attempt + 1)
        }
      }
      if (isPrismaCode(error, 'P2034') || isPrismaCode(error, 'P2002')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Long-form indexing conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async search(
    query: Readonly<LongFormMomentSearchQuery>,
  ): Promise<readonly Readonly<LongFormMomentSearchResult>[]> {
    const project = await this.client.v2Project.findFirst({
      where: {
        id: query.projectId,
        workspaceId: query.workspaceId,
      },
      select: { id: true },
    })
    if (!project) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    }
    const rows = await this.client.v2LongFormMoment.findMany({
      where: {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        indexRun: { active: true },
        ...(query.text
          ? { searchTextNormalized: { contains: query.text } }
          : {}),
        ...(query.chapterId ? { chapterId: query.chapterId } : {}),
        ...(query.sourceArtifactId
          ? { sourceArtifactId: query.sourceArtifactId }
          : {}),
        ...(query.speakerId
          ? {
              speakerIdsJson: {
                contains: JSON.stringify(query.speakerId),
              },
            }
          : {}),
        ...(query.role
          ? {
              rolesNormalized: {
                contains: `\n${query.role}\n`,
              },
            }
          : {}),
        ...(query.tag
          ? {
              tagsNormalized: {
                contains: `\n${query.tag}\n`,
              },
            }
          : {}),
        ...(query.minSalience !== undefined
          ? { salience: { gte: query.minSalience } }
          : {}),
      },
      include: {
        chapter: true,
        indexRun: {
          include: {
            sourceArtifact: {
              select: { currentRightsSnapshot: true },
            },
            moments: {
              select: { id: true, chapterId: true, ordinal: true },
              orderBy: { ordinal: 'asc' },
            },
          },
        },
      },
      orderBy: [
        { salience: 'desc' },
        { standaloneScore: 'desc' },
        { insightDensity: 'desc' },
        { recommendedStartMs: 'asc' },
        { id: 'asc' },
      ],
      take: query.limit,
    })
    const matchedBy = Object.freeze([
      ...(query.text ? ['text' as const] : []),
      ...(query.chapterId ? ['chapter' as const] : []),
      ...(query.sourceArtifactId ? ['source-artifact' as const] : []),
      ...(query.speakerId ? ['speaker' as const] : []),
      ...(query.role ? ['role' as const] : []),
      ...(query.tag ? ['tag' as const] : []),
      ...(query.minSalience !== undefined ? ['salience' as const] : []),
    ])
    return Object.freeze((rows as SearchRow[]).map((row) => {
      const moment = hydrateMoment(row)
      const chapter = hydrateChapter(
        row.chapter,
        row.indexRun.moments
          .filter((candidate) => candidate.chapterId === row.chapter.id)
          .map((candidate) => candidate.id),
      )
      const current = row.indexRun.sourceArtifact.currentRightsSnapshot
      const rights = effectiveRights(
        current ? rightsSnapshot(current) : null,
        query.now,
      )
      const blockedReasons = Object.freeze([
        ...(rights.id !== row.indexRun.rightsSnapshotId
          ? ['RIGHTS_SNAPSHOT_STALE']
          : []),
        ...(rights.status !== 'approved'
          ? [`RIGHTS_${rights.status.toUpperCase()}`]
          : []),
        ...(!['approved', 'not-required'].includes(rights.consentStatus)
          ? [`CONSENT_${rights.consentStatus.toUpperCase()}`]
          : []),
      ])
      return Object.freeze({
        moment,
        chapter,
        matchedBy,
        preview: buildLongFormMomentPreview({
          moment,
          masterDurationMs: row.indexRun.durationMs,
          contextBeforeMs: query.contextBeforeMs,
          contextAfterMs: query.contextAfterMs,
        }),
        rightsSnapshotId: rights.id,
        rightsStatus: rights.status,
        consentStatus: rights.consentStatus,
        eligibleForReuse: blockedReasons.length === 0,
        blockedReasons,
      })
    }))
  }
}

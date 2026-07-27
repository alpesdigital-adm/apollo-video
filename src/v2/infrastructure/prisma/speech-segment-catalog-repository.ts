import {
  Prisma,
  type PrismaClient,
  type V2SpeechSegment,
  type V2SpeechSegmentCatalogRun,
} from '../../../../generated/prisma-v2/index.js'

import {
  calculateSpeechCatalogRunRecordHash,
} from '../../application/catalog-speech-segments.ts'
import type {
  PersistedSpeechCatalogRun,
  SpeechSegmentCatalogRepository,
  SpeechSegmentSearchQuery,
  SpeechSegmentSearchResult,
} from '../../application/ports/speech-segment-catalog-repository.ts'
import {
  calculateCanonicalHash,
  stableSerialize,
} from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import {
  normalizeSpeechText,
  type CatalogedSpeechSegment,
  type SpeechCatalogObservation,
  type SpeechCatalogProducer,
  type SpeechCatalogProvenance,
  type SpeechCatalogWordAlignment,
  type SpeechSegmentAnnotationInput,
  type SpeechSegmentClassification,
} from '../../domain/speech-segment-catalog.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

interface RunWithSegments extends V2SpeechSegmentCatalogRun {
  segments: V2SpeechSegment[]
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

function object(value: unknown, field: string): Record<string, unknown> {
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

export function hydrateStoredMediaTranscript(row: {
  transcriptJson: string
  transcriptHash: string
}) {
  const parsed = object(
    parseJson(row.transcriptJson, 'media transcript'),
    'media transcript',
  )
  const body = {
    language: parsed.language,
    text: parsed.text,
    words: parsed.words,
    segments: parsed.segments,
    provider: parsed.provider,
    model: parsed.model,
  }
  const transcript = createMediaTranscript(body as never)
  if (
    transcript.transcriptHash !== row.transcriptHash ||
    parsed.transcriptHash !== row.transcriptHash ||
    stableSerialize(transcript) !== row.transcriptJson
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored media transcript failed integrity validation',
    )
  }
  return transcript
}

function parseProducer(value: string): Readonly<SpeechCatalogProducer> {
  return Object.freeze(
    object(
      parseJson(value, 'speech catalog producer'),
      'speech catalog producer',
    ) as unknown as SpeechCatalogProducer,
  )
}

function parseAnnotations(
  value: string,
): readonly Readonly<SpeechSegmentAnnotationInput>[] {
  return Object.freeze(
    array(
      parseJson(value, 'speech catalog annotations'),
      'speech catalog annotations',
    ).map((item) => Object.freeze(
      object(item, 'speech catalog annotation') as unknown as
        SpeechSegmentAnnotationInput,
    )),
  )
}

function parseObservation(
  value: string,
  field: string,
): Readonly<SpeechCatalogObservation> {
  return Object.freeze(
    object(parseJson(value, field), field) as unknown as
      SpeechCatalogObservation,
  )
}

function parseObservationArray(
  value: string,
  field: string,
): readonly Readonly<SpeechCatalogObservation>[] {
  return Object.freeze(
    array(parseJson(value, field), field).map((item) =>
      Object.freeze(
        object(item, field) as unknown as SpeechCatalogObservation,
      )),
  )
}

function parseWords(
  value: string,
): readonly Readonly<SpeechCatalogWordAlignment>[] {
  return Object.freeze(
    array(parseJson(value, 'speech segment words'), 'speech segment words')
      .map((item) =>
        Object.freeze(
          object(item, 'speech segment word') as unknown as
            SpeechCatalogWordAlignment,
        )),
  )
}

function parseVisual(value: string): CatalogedSpeechSegment['visual'] {
  const parsed = object(
    parseJson(value, 'speech segment visual metadata'),
    'speech segment visual metadata',
  )
  return Object.freeze({
    ...(parsed.emotion
      ? {
          emotion: Object.freeze(
            object(
              parsed.emotion,
              'speech segment emotion',
            ) as unknown as SpeechCatalogObservation,
          ),
        }
      : {}),
    ...(parsed.expression
      ? {
          expression: Object.freeze(
            object(
              parsed.expression,
              'speech segment expression',
            ) as unknown as SpeechCatalogObservation,
          ),
        }
      : {}),
    ...(parsed.wardrobe
      ? {
          wardrobe: Object.freeze(
            object(
              parsed.wardrobe,
              'speech segment wardrobe',
            ) as unknown as SpeechCatalogObservation,
          ),
        }
      : {}),
    ...(parsed.setting
      ? {
          setting: Object.freeze(
            object(
              parsed.setting,
              'speech segment setting',
            ) as unknown as SpeechCatalogObservation,
          ),
        }
      : {}),
    colors: Object.freeze(
      array(parsed.colors, 'speech segment colors').map((item) =>
        Object.freeze(
          object(item, 'speech segment color') as unknown as
            SpeechCatalogObservation,
        )),
    ),
  })
}

export function hydrateStoredSpeechSegment(
  row: V2SpeechSegment,
): Readonly<CatalogedSpeechSegment> {
  const words = parseWords(row.wordsJson)
  const speaker = parseObservation(row.speakerJson, 'speech segment speaker')
  const visual = parseVisual(row.visualJson)
  const intentions = parseObservationArray(
    row.intentionsJson,
    'speech segment intentions',
  )
  const extractionProvenance = Object.freeze(
    object(
      parseJson(
        row.extractionProvenanceJson,
        'speech segment extraction provenance',
      ),
      'speech segment extraction provenance',
    ) as unknown as SpeechCatalogProvenance,
  )
  const content = Object.freeze({
    schemaVersion: 'speech-segment/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    catalogRunId: row.catalogRunId,
    sourceTranscriptId: row.sourceTranscriptId,
    sourceTranscriptHash: row.sourceTranscriptHash,
    sourceArtifactId: row.sourceArtifactId,
    sourceSegmentId: row.sourceSegmentId,
    exactText: row.exactText,
    normalizedText: row.normalizedText,
    words,
    speaker,
    speakerId: row.speakerId,
    rangeMs: Object.freeze([row.startMs, row.endMs]) as readonly [number, number],
    completeThoughtScore: row.completeThoughtScore,
    classification: row.classification as SpeechSegmentClassification,
    visual,
    intentions,
    extractionProvenance,
    extractionPolicyVersion: 'speech-segment-extraction/v1' as const,
    physicalMaterialized: false as const,
    createdAt: row.createdAt.toISOString(),
  })
  const colorsNormalized = visual.colors
    .map((color) => color.normalizedValue)
    .join('\n')
  const intentionsNormalized = intentions
    .map((intention) => intention.normalizedValue)
    .join('\n')
  if (
    row.physicalMaterialized ||
    row.extractionPolicyVersion !== content.extractionPolicyVersion ||
    row.speakerId !== speaker.value ||
    row.speakerNormalized !== speaker.normalizedValue ||
    row.emotionNormalized !== (visual.emotion?.normalizedValue ?? null) ||
    row.expressionNormalized !==
      (visual.expression?.normalizedValue ?? null) ||
    row.wardrobeNormalized !== (visual.wardrobe?.normalizedValue ?? null) ||
    row.settingNormalized !== (visual.setting?.normalizedValue ?? null) ||
    row.colorsNormalized !== colorsNormalized ||
    row.intentionsNormalized !== intentionsNormalized ||
    stableSerialize(words) !== row.wordsJson ||
    stableSerialize(speaker) !== row.speakerJson ||
    stableSerialize(visual) !== row.visualJson ||
    stableSerialize(intentions) !== row.intentionsJson ||
    stableSerialize(extractionProvenance) !== row.extractionProvenanceJson ||
    calculateCanonicalHash(content) !== row.segmentHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored speech segment ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({ ...content, segmentHash: row.segmentHash })
}

function hydrateRun(
  row: RunWithSegments,
): Readonly<PersistedSpeechCatalogRun> {
  const producer = parseProducer(row.producerJson)
  const annotations = parseAnnotations(row.annotationsJson)
  const segments = Object.freeze(
    [...row.segments]
      .sort((left, right) => left.sourceSegmentId - right.sourceSegmentId)
      .map(hydrateStoredSpeechSegment),
  )
  const content = Object.freeze({
    schemaVersion: 'speech-segment-catalog-run/v1' as const,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    sourceTranscriptId: row.sourceTranscriptId,
    sourceTranscriptHash: row.sourceTranscriptHash,
    sourceArtifactId: row.sourceArtifactId,
    extractionPolicyVersion: 'speech-segment-extraction/v1' as const,
    producer,
    annotations,
    annotationsHash: row.annotationsHash,
    segments,
    segmentCount: row.segmentCount,
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
    row.extractionPolicyVersion !== content.extractionPolicyVersion ||
    calculateCanonicalHash(annotations) !== row.annotationsHash ||
    row.segmentCount !== segments.length ||
    calculateSpeechCatalogRunRecordHash(content) !== row.recordHash
  ) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      `Stored speech catalog run ${row.id} failed integrity validation`,
    )
  }
  return Object.freeze({
    ...content,
    recordHash: row.recordHash,
    active: row.active,
  })
}

function segmentData(segment: Readonly<CatalogedSpeechSegment>) {
  return {
    id: segment.id,
    workspaceId: segment.workspaceId,
    projectId: segment.projectId,
    catalogRunId: segment.catalogRunId,
    sourceTranscriptId: segment.sourceTranscriptId,
    sourceTranscriptHash: segment.sourceTranscriptHash,
    sourceArtifactId: segment.sourceArtifactId,
    sourceSegmentId: segment.sourceSegmentId,
    exactText: segment.exactText,
    normalizedText: segment.normalizedText,
    wordsJson: stableSerialize(segment.words),
    speakerJson: stableSerialize(segment.speaker),
    speakerId: segment.speakerId,
    speakerNormalized: segment.speaker.normalizedValue,
    startMs: segment.rangeMs[0],
    endMs: segment.rangeMs[1],
    completeThoughtScore: segment.completeThoughtScore,
    classification: segment.classification,
    visualJson: stableSerialize(segment.visual),
    emotionNormalized: segment.visual.emotion?.normalizedValue,
    expressionNormalized: segment.visual.expression?.normalizedValue,
    wardrobeNormalized: segment.visual.wardrobe?.normalizedValue,
    settingNormalized: segment.visual.setting?.normalizedValue,
    colorsNormalized: segment.visual.colors
      .map((color) => color.normalizedValue)
      .join('\n'),
    intentionsJson: stableSerialize(segment.intentions),
    intentionsNormalized: segment.intentions
      .map((intention) => intention.normalizedValue)
      .join('\n'),
    extractionProvenanceJson: stableSerialize(segment.extractionProvenance),
    extractionPolicyVersion: segment.extractionPolicyVersion,
    physicalMaterialized: segment.physicalMaterialized,
    segmentHash: segment.segmentHash,
    createdAt: new Date(segment.createdAt),
  }
}

export class PrismaSpeechSegmentCatalogRepository
implements SpeechSegmentCatalogRepository {
  constructor(
    private readonly client: PrismaClient = getV2PostgresClient(),
  ) {}

  async readExtractionContext(input: {
    workspaceId: string
    projectId: string
    sourceTranscriptId: string
  }) {
    const row = await this.client.v2MediaTranscript.findFirst({
      where: {
        id: input.sourceTranscriptId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
      },
    })
    if (!row) return null
    return Object.freeze({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sourceTranscriptId: row.id,
      sourceArtifactId: row.sourceArtifactId,
      transcript: hydrateStoredMediaTranscript(row),
    })
  }

  async findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }) {
    const row = await this.client.v2SpeechSegmentCatalogRun.findUnique({
      where: {
        workspaceId_projectId_idempotencyKey: input,
      },
      include: { segments: true },
    })
    return row ? hydrateRun(row) : null
  }

  async persist(
    run: Readonly<PersistedSpeechCatalogRun>,
    attempt = 1,
  ): ReturnType<SpeechSegmentCatalogRepository['persist']> {
    try {
      return await this.client.$transaction(async (transaction) => {
        const existing =
          await transaction.v2SpeechSegmentCatalogRun.findUnique({
            where: {
              workspaceId_projectId_idempotencyKey: {
                workspaceId: run.workspaceId,
                projectId: run.projectId,
                idempotencyKey: run.idempotencyKey,
              },
            },
            include: { segments: true },
          })
        if (existing) {
          if (existing.requestFingerprint !== run.requestFingerprint) {
            throw new DomainError(
              'IDEMPOTENCY_PAYLOAD_MISMATCH',
              'Idempotency key was used with a different speech catalog request',
            )
          }
          return Object.freeze({
            run: hydrateRun(existing),
            replayed: true,
          })
        }
        const [project, transcript, artifact, actor] = await Promise.all([
          transaction.v2Project.findFirst({
            where: {
              id: run.projectId,
              workspaceId: run.workspaceId,
            },
            select: { id: true },
          }),
          transaction.v2MediaTranscript.findFirst({
            where: {
              id: run.sourceTranscriptId,
              workspaceId: run.workspaceId,
              projectId: run.projectId,
              sourceArtifactId: run.sourceArtifactId,
            },
          }),
          transaction.v2MediaArtifact.findFirst({
            where: {
              id: run.sourceArtifactId,
              workspaceId: run.workspaceId,
              status: 'available',
            },
            select: { id: true },
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
        if (!project || !transcript || !artifact || !actor) {
          throw new DomainError(
            'PERSISTENCE_CONFLICT',
            'Speech catalog commit context is no longer available',
          )
        }
        if (
          transcript.transcriptHash !== run.sourceTranscriptHash ||
          hydrateStoredMediaTranscript(transcript).transcriptHash !==
            run.sourceTranscriptHash
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Transcript changed before speech catalog commit',
          )
        }
        await transaction.v2SpeechSegmentCatalogRun.updateMany({
          where: {
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            sourceTranscriptId: run.sourceTranscriptId,
            active: true,
          },
          data: { active: false },
        })
        await transaction.v2SpeechSegmentCatalogRun.create({
          data: {
            id: run.id,
            workspaceId: run.workspaceId,
            projectId: run.projectId,
            sourceTranscriptId: run.sourceTranscriptId,
            sourceTranscriptHash: run.sourceTranscriptHash,
            sourceArtifactId: run.sourceArtifactId,
            extractionPolicyVersion: run.extractionPolicyVersion,
            producerJson: stableSerialize(run.producer),
            annotationsJson: stableSerialize(run.annotations),
            annotationsHash: run.annotationsHash,
            segmentCount: run.segmentCount,
            requestFingerprint: run.requestFingerprint,
            idempotencyKey: run.idempotencyKey,
            recordHash: run.recordHash,
            active: true,
            createdByType: run.createdBy.type,
            createdById: run.createdBy.id,
            createdAt: new Date(run.createdAt),
          },
        })
        await transaction.v2SpeechSegment.createMany({
          data: run.segments.map(segmentData),
        })
        const row =
          await transaction.v2SpeechSegmentCatalogRun.findUniqueOrThrow({
            where: { id: run.id },
            include: { segments: true },
          })
        return Object.freeze({
          run: hydrateRun(row),
          replayed: false,
        })
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      })
    } catch (error) {
      if (isPrismaCode(error, 'P2034') && attempt < 3) {
        return this.persist(run, attempt + 1)
      }
      if (isPrismaCode(error, 'P2034')) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Speech catalog conflicted with another transaction',
        )
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
              'Idempotency key was used with a different speech catalog request',
            )
          }
          return Object.freeze({ run: replay, replayed: true })
        }
        if (attempt < 3) {
          return this.persist(run, attempt + 1)
        }
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Speech catalog active-run transition conflicted with another transaction',
        )
      }
      throw error
    }
  }

  async search(
    query: Readonly<SpeechSegmentSearchQuery>,
  ): Promise<readonly Readonly<SpeechSegmentSearchResult>[]> {
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
    const rows = await this.client.v2SpeechSegment.findMany({
      where: {
        workspaceId: query.workspaceId,
        projectId: query.projectId,
        catalogRun: { active: true },
        ...(query.text
          ? { normalizedText: { contains: query.text } }
          : {}),
        ...(query.intention
          ? { intentionsNormalized: { contains: query.intention } }
          : {}),
        ...(query.speakerId
          ? { speakerNormalized: { contains: query.speakerId } }
          : {}),
        ...(query.emotion
          ? { emotionNormalized: { contains: query.emotion } }
          : {}),
        ...(query.expression
          ? { expressionNormalized: { contains: query.expression } }
          : {}),
        ...(query.wardrobe
          ? { wardrobeNormalized: { contains: query.wardrobe } }
          : {}),
        ...(query.setting
          ? { settingNormalized: { contains: query.setting } }
          : {}),
        ...(query.sourceArtifactId
          ? { sourceArtifactId: query.sourceArtifactId }
          : {}),
        ...(query.classification
          ? { classification: query.classification }
          : {}),
        ...(query.completeThoughtMin !== undefined
          ? { completeThoughtScore: { gte: query.completeThoughtMin } }
          : {}),
      },
      include: {
        sourceArtifact: {
          include: { currentRightsSnapshot: true },
        },
      },
      orderBy: [
        { completeThoughtScore: 'desc' },
        { sourceArtifactId: 'asc' },
        { startMs: 'asc' },
        { id: 'asc' },
      ],
      take: query.limit,
    })
    const matchedBy = Object.freeze([
      ...(query.text ? ['speech' as const] : []),
      ...(query.intention ? ['intention' as const] : []),
      ...(query.speakerId ? ['person' as const] : []),
      ...(query.emotion ? ['emotion' as const] : []),
      ...(query.expression ? ['expression' as const] : []),
      ...(query.wardrobe ? ['wardrobe' as const] : []),
      ...(query.setting ? ['setting' as const] : []),
      ...(query.sourceArtifactId ? ['source-artifact' as const] : []),
      ...(query.classification ? ['classification' as const] : []),
      ...(query.completeThoughtMin !== undefined
        ? ['complete-thought' as const]
        : []),
    ])
    return Object.freeze(rows.map((row) => {
      const rights = row.sourceArtifact.currentRightsSnapshot
      const expired = Boolean(
        rights?.expiresAt && rights.expiresAt.getTime() <= Date.now(),
      )
      const rightsStatus = expired
        ? 'expired'
        : rights?.status ?? 'unverified'
      const blockedReasons = Object.freeze(
        rightsStatus === 'approved'
          ? []
          : [`rights-${rightsStatus}`],
      )
      return Object.freeze({
        segment: hydrateStoredSpeechSegment(row),
        matchedBy,
        rightsStatus,
        eligibleForReuse: blockedReasons.length === 0,
        blockedReasons,
      })
    }))
  }
}

import { Prisma, type PrismaClient, type V2SyntheticSpeechSegment } from '../../../../generated/prisma-v2/index.js'

import type {
  SyntheticSpeechSegmentRepository,
  SyntheticSpeechSegmentSearchQuery,
} from '../../application/ports/synthetic-speech-segment-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  assertSyntheticSpeechSegmentIntegrity,
  SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION,
  type SyntheticSpeechSegment,
  type SyntheticSpeechSegmentWord,
} from '../../domain/synthetic-speech-segment.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

function hydrate(row: V2SyntheticSpeechSegment): Readonly<SyntheticSpeechSegment> {
  let words: readonly Readonly<SyntheticSpeechSegmentWord>[]
  try {
    words = JSON.parse(row.wordsJson) as readonly Readonly<SyntheticSpeechSegmentWord>[]
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic speech segment words are invalid')
  }
  const segment: SyntheticSpeechSegment = {
    schemaVersion: SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION,
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    masterId: row.masterId,
    masterHash: row.masterHash,
    blockId: row.blockId,
    occurrence: row.occurrence,
    sequence: row.sequence,
    audioArtifactId: row.audioArtifactId,
    videoArtifactId: row.videoArtifactId,
    alignmentArtifactId: row.alignmentArtifactId,
    exactText: row.exactText,
    normalizedText: row.normalizedText,
    scriptHash: row.scriptHash,
    words: Object.freeze(words.map((word) => Object.freeze({ ...word }))),
    startMs: row.startMs,
    endMs: row.endMs,
    locale: row.locale,
    identity: Object.freeze({
      actorIdentityId: row.actorIdentityId,
      profileId: row.profileId,
      profileVersion: row.profileVersion,
      voiceId: row.voiceId,
      voiceVersion: row.voiceVersion,
      avatarIdentityRef: row.avatarIdentityRef,
      emotion: row.emotionNormalized,
      wardrobe: row.wardrobeNormalized,
      background: row.settingNormalized,
      framing: row.framingNormalized,
    }),
    consentSnapshotHash: row.consentSnapshotHash,
    rightsSnapshotId: row.rightsSnapshotId,
    criticReportId: row.criticReportId,
    criticReportHash: row.criticReportHash,
    createdAt: row.createdAt.toISOString(),
    segmentHash: row.segmentHash,
  }
  if (row.schemaVersion !== SYNTHETIC_SPEECH_SEGMENT_SCHEMA_VERSION) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic speech segment schema version is unknown')
  }
  // The stored hash is recomputed from the projected columns, so a row edited
  // behind the application fails closed instead of being reused.
  return Object.freeze(assertSyntheticSpeechSegmentIntegrity(Object.freeze(segment)))
}

function rowData(segment: Readonly<SyntheticSpeechSegment>) {
  return {
    id: segment.id,
    workspaceId: segment.workspaceId,
    projectId: segment.projectId,
    masterId: segment.masterId,
    masterHash: segment.masterHash,
    schemaVersion: segment.schemaVersion,
    blockId: segment.blockId,
    occurrence: segment.occurrence,
    sequence: segment.sequence,
    audioArtifactId: segment.audioArtifactId,
    videoArtifactId: segment.videoArtifactId,
    alignmentArtifactId: segment.alignmentArtifactId,
    exactText: segment.exactText,
    normalizedText: segment.normalizedText,
    scriptHash: segment.scriptHash,
    wordsJson: stableSerialize(segment.words.map((word) => ({ ...word }))),
    startMs: segment.startMs,
    endMs: segment.endMs,
    locale: segment.locale,
    actorIdentityId: segment.identity.actorIdentityId,
    profileId: segment.identity.profileId,
    profileVersion: segment.identity.profileVersion,
    voiceId: segment.identity.voiceId,
    voiceVersion: segment.identity.voiceVersion,
    avatarIdentityRef: segment.identity.avatarIdentityRef,
    emotionNormalized: segment.identity.emotion,
    wardrobeNormalized: segment.identity.wardrobe,
    settingNormalized: segment.identity.background,
    framingNormalized: segment.identity.framing,
    consentSnapshotHash: segment.consentSnapshotHash,
    rightsSnapshotId: segment.rightsSnapshotId,
    criticReportId: segment.criticReportId,
    criticReportHash: segment.criticReportHash,
    segmentHash: segment.segmentHash,
    createdAt: new Date(segment.createdAt),
  }
}

export class PrismaSyntheticSpeechSegmentRepository implements SyntheticSpeechSegmentRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async catalog(input: Parameters<SyntheticSpeechSegmentRepository['catalog']>[0]) {
    const existing = await this.listByMaster({ workspaceId: input.workspaceId, masterId: input.masterId })
    if (existing.length > 0) return Object.freeze({ segments: existing, replayed: true })
    try {
      await this.client.$transaction(async (transaction) => {
        await transaction.v2SyntheticSpeechSegment.createMany({
          data: input.segments.map(rowData),
        })
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent catalog of the same master won; the catalog is a pure
        // function of the master, so its rows are the answer.
        const raced = await this.listByMaster({ workspaceId: input.workspaceId, masterId: input.masterId })
        if (raced.length > 0) return Object.freeze({ segments: raced, replayed: true })
      }
      throw error
    }
    return Object.freeze({
      segments: await this.listByMaster({ workspaceId: input.workspaceId, masterId: input.masterId }),
      replayed: false,
    })
  }

  async listByMaster(input: Parameters<SyntheticSpeechSegmentRepository['listByMaster']>[0]) {
    const rows = await this.client.v2SyntheticSpeechSegment.findMany({
      where: { workspaceId: input.workspaceId, masterId: input.masterId },
      orderBy: { sequence: 'asc' },
    })
    return Object.freeze(rows.map(hydrate))
  }

  async read(input: Parameters<SyntheticSpeechSegmentRepository['read']>[0]) {
    const row = await this.client.v2SyntheticSpeechSegment.findFirst({
      where: { id: input.segmentId, workspaceId: input.workspaceId },
    })
    return row ? hydrate(row) : null
  }

  async search(query: Readonly<SyntheticSpeechSegmentSearchQuery>) {
    const rows = await this.client.v2SyntheticSpeechSegment.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(query.profileId ? { profileId: query.profileId } : {}),
        ...(query.locale ? { locale: query.locale } : {}),
        ...(query.scriptHash ? { scriptHash: query.scriptHash } : {}),
        ...(query.emotion ? { emotionNormalized: query.emotion } : {}),
        ...(query.wardrobe ? { wardrobeNormalized: query.wardrobe } : {}),
        ...(query.setting ? { settingNormalized: query.setting } : {}),
        ...(query.text ? { normalizedText: { contains: query.text } } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { sequence: 'asc' }],
      take: query.limit,
    })
    return Object.freeze(rows.map(hydrate))
  }
}

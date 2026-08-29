import { Prisma, type PrismaClient, type V2SyntheticBlockConcatenation } from '../../../../generated/prisma-v2/index.js'

import type {
  PersistedSyntheticBlockConcatenation,
  SyntheticBlockConcatenationRepository,
} from '../../application/ports/synthetic-block-concatenation-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function hydrate(row: V2SyntheticBlockConcatenation): Readonly<PersistedSyntheticBlockConcatenation> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let settings
  let entries
  try {
    settings = JSON.parse(row.settingsJson)
    entries = JSON.parse(row.manifestJson)
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored block concatenation JSON is invalid')
  }
  if (!Array.isArray(entries) || typeof settings !== 'object' || settings === null) {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored block concatenation shape is invalid')
  }
  return Object.freeze({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    planId: row.planId,
    planVersionId: row.planVersionId,
    container: row.container as 'mp3' | 'wav',
    codec: row.codec,
    sampleRate: row.sampleRate,
    channels: row.channels,
    gapMs: row.gapMs,
    durationMs: row.durationMs,
    settings: Object.freeze(settings),
    entries: Object.freeze(entries),
    concatHash: row.concatHash,
    audioArtifactId: row.audioArtifactId,
    alignmentArtifactId: row.alignmentArtifactId,
    finalAudioSha256: row.finalAudioSha256,
    audioMasterId: row.audioMasterId,
    requestFingerprint: row.requestFingerprint,
    idempotencyKey: row.idempotencyKey,
    createdAt: row.createdAt.toISOString(),
  })
}

export class PrismaSyntheticBlockConcatenationRepository implements SyntheticBlockConcatenationRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async findReplay(input: Parameters<SyntheticBlockConcatenationRepository['findReplay']>[0]) {
    const row = await this.client.v2SyntheticBlockConcatenation.findFirst({
      where: {
        workspaceId: input.workspaceId,
        planId: input.planId,
        createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash,
        idempotencyKey: input.idempotencyKey,
      },
    })
    return row ? hydrate(row) : null
  }

  async create(input: Parameters<SyntheticBlockConcatenationRepository['create']>[0]) {
    const value = input.concatenation
    try {
      const row = await this.client.$transaction(async (transaction) => transaction.v2SyntheticBlockConcatenation.create({
        data: {
          id: value.id,
          workspaceId: value.workspaceId,
          projectId: value.projectId,
          planId: value.planId,
          planVersionId: value.planVersionId,
          schemaVersion: 'synthetic-block-concatenation/v1',
          container: value.container,
          codec: value.codec,
          sampleRate: value.sampleRate,
          channels: value.channels,
          gapMs: value.gapMs,
          durationMs: value.durationMs,
          settingsJson: stableSerialize(value.settings),
          manifestJson: stableSerialize(value.entries),
          concatHash: value.concatHash,
          audioArtifactId: value.audioArtifactId,
          alignmentArtifactId: value.alignmentArtifactId,
          finalAudioSha256: value.finalAudioSha256,
          audioMasterId: value.audioMasterId,
          requestFingerprint: input.requestFingerprint,
          idempotencyKey: input.idempotencyKey,
          createdByClientId: input.authenticationAudit.clientId,
          ...externalActorAuditData(input.authenticationAudit, value.workspaceId, input.authenticationAudit.clientId),
          createdAt: new Date(value.createdAt),
        },
      }), { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
      return Object.freeze({ concatenation: hydrate(row), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findReplay({
          workspaceId: value.workspaceId,
          planId: value.planId,
          actorClientId: input.authenticationAudit.clientId,
          actorContextHash: input.authenticationAudit.contextHash,
          idempotencyKey: input.idempotencyKey,
        })
        if (replay && replay.requestFingerprint === input.requestFingerprint) {
          return Object.freeze({ concatenation: replay, replayed: true })
        }
      }
      throw error
    }
  }

  async read(input: Parameters<SyntheticBlockConcatenationRepository['read']>[0]) {
    const row = await this.client.v2SyntheticBlockConcatenation.findFirst({
      where: { id: input.concatenationId, workspaceId: input.workspaceId, planId: input.planId },
    })
    return row ? hydrate(row) : null
  }
}

import { Prisma, type PrismaClient, type V2SyntheticAudioMaster } from '../../../../generated/prisma-v2/index.js'

import type { PersistedSyntheticAudioMaster, SyntheticAudioMasterRepository } from '../../application/ports/synthetic-audio-master-repository.ts'
import { stableSerialize } from '../../domain/canonical-hash.ts'
import { DomainError } from '../../domain/errors.ts'
import { assertSyntheticAudioMaster, type SyntheticAudioMaster } from '../../domain/synthetic-audio-master.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { externalActorAuditData, hydrateExternalActorAudit } from './external-actor-audit.ts'

function hydrate(row: V2SyntheticAudioMaster): Readonly<PersistedSyntheticAudioMaster> {
  hydrateExternalActorAudit(row, row.createdByClientId)
  let master: SyntheticAudioMaster
  try {
    master = JSON.parse(row.masterJson) as SyntheticAudioMaster
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic audio master JSON is invalid')
  }
  assertSyntheticAudioMaster(master)
  if (
    stableSerialize(master) !== row.masterJson || master.id !== row.id || master.workspaceId !== row.workspaceId ||
    master.projectId !== row.projectId || master.projectVersionId !== row.projectVersionId || master.profileSnapshotId !== row.profileSnapshotId ||
    master.schemaVersion !== row.schemaVersion || master.source.kind !== row.sourceKind ||
    (master.source.kind === 'tts' ? master.source.providerJobId : null) !== row.ttsProviderJobId ||
    master.audio.artifactId !== row.audioArtifactId || master.alignmentEvidence.artifactId !== row.alignmentEvidenceArtifactId ||
    master.audio.durationMs !== row.durationMs || master.audio.locale !== row.locale || master.wordsHash !== row.wordsHash ||
    master.masterHash !== row.masterHash || master.createdAt !== row.createdAt.toISOString()
  ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored synthetic audio master failed integrity validation')
  return Object.freeze({ master: Object.freeze(master), requestFingerprint: row.requestFingerprint, idempotencyKey: row.idempotencyKey })
}

export class PrismaSyntheticAudioMasterRepository implements SyntheticAudioMasterRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async findReplay(input: Parameters<SyntheticAudioMasterRepository['findReplay']>[0]) {
    const row = await this.client.v2SyntheticAudioMaster.findUnique({
      where: { workspaceId_projectId_createdByClientId_actorContextHash_idempotencyKey: {
        workspaceId: input.workspaceId, projectId: input.projectId, createdByClientId: input.actorClientId,
        actorContextHash: input.actorContextHash, idempotencyKey: input.idempotencyKey,
      } },
    })
    return row ? hydrate(row) : null
  }

  async create(input: Parameters<SyntheticAudioMasterRepository['create']>[0]) {
    const master = input.master
    try {
      const row = await this.client.v2SyntheticAudioMaster.create({ data: {
        id: master.id, workspaceId: master.workspaceId, projectId: master.projectId, projectVersionId: master.projectVersionId,
        profileSnapshotId: master.profileSnapshotId, schemaVersion: master.schemaVersion, sourceKind: master.source.kind,
        ttsProviderJobId: master.source.kind === 'tts' ? master.source.providerJobId : null,
        audioArtifactId: master.audio.artifactId, alignmentEvidenceArtifactId: master.alignmentEvidence.artifactId,
        durationMs: master.audio.durationMs, locale: master.audio.locale, wordsHash: master.wordsHash,
        masterJson: stableSerialize(master), masterHash: master.masterHash, requestFingerprint: input.requestFingerprint,
        idempotencyKey: input.idempotencyKey, createdByClientId: input.authenticationAudit.clientId,
        ...externalActorAuditData(input.authenticationAudit, master.workspaceId, input.authenticationAudit.clientId),
        createdAt: new Date(master.createdAt),
      } })
      return Object.freeze({ value: hydrate(row), replayed: false })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const replay = await this.findReplay({ workspaceId: master.workspaceId, projectId: master.projectId, actorClientId: input.authenticationAudit.clientId, actorContextHash: input.authenticationAudit.contextHash, idempotencyKey: input.idempotencyKey })
        if (replay && replay.requestFingerprint === input.requestFingerprint) return Object.freeze({ value: replay, replayed: true })
      }
      throw error
    }
  }

  async read(input: Parameters<SyntheticAudioMasterRepository['read']>[0]) {
    const row = await this.client.v2SyntheticAudioMaster.findFirst({ where: { id: input.audioMasterId, workspaceId: input.workspaceId, projectId: input.projectId } })
    return row ? hydrate(row) : null
  }
}

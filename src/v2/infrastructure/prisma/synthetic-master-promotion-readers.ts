import { type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import { DomainError } from '../../domain/errors.ts'
import type {
  PromotableProviderJob,
  PromotableProviderJobReader,
} from '../../application/synthetic-master-assets.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'
import { PrismaProviderJobRepository } from './provider-job-repository.ts'
import { PrismaSyntheticAudioMasterRepository } from './synthetic-audio-master-repository.ts'

/**
 * Reads the durable provider run a promotion is allowed to trust.
 *
 * Only the columns the promotion actually validates are projected: the raw
 * input and authorization documents stay in PostgreSQL, because a master must
 * never be sealed from — or leak — a provider payload. The lookup is bound to
 * the workspace, so a job id from another tenant simply does not exist here.
 */
export class PrismaPromotableProviderJobReader implements PromotableProviderJobReader {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async read(input: { workspaceId: string; jobId: string }): Promise<Readonly<PromotableProviderJob> | null> {
    const persisted = await new PrismaProviderJobRepository(this.client).readById(input)
    if (!persisted) return null
    const row = persisted.job
    const audioRange = row.input.audioRange
    if (
      audioRange !== undefined &&
      (typeof audioRange !== 'object' || audioRange === null ||
        !Number.isSafeInteger((audioRange as { startMs?: unknown }).startMs) ||
        !Number.isSafeInteger((audioRange as { endMs?: unknown }).endMs) ||
        typeof (audioRange as { rangeHash?: unknown }).rangeHash !== 'string')
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored provider job audio range is invalid')
    if (
      typeof row.input.audioMasterId !== 'string' || row.input.audioMasterId.length === 0
    ) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored audio-avatar job has no canonical audio master')
    const storedMaster = await new PrismaSyntheticAudioMasterRepository(this.client).read({
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      audioMasterId: row.input.audioMasterId,
    })
    if (!storedMaster) throw new DomainError('PERSISTENCE_CONFLICT', 'Stored audio-avatar job references a missing audio master')
    const master = storedMaster.master
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      originProjectVersionId: row.originProjectVersionId,
      operation: row.operation,
      adapterId: row.adapterId,
      adapterVersion: row.adapterVersion,
      providerJobId: row.providerJobId ?? null,
      status: row.status,
      criticResultHash: row.criticResultHash ?? null,
      authorization: Object.freeze({
        profileSnapshotId: row.authorization.profileSnapshotId,
      }),
      audioRange: audioRange
        ? Object.freeze({
          startMs: (audioRange as { startMs: number }).startMs,
          endMs: (audioRange as { endMs: number }).endMs,
          rangeHash: (audioRange as { rangeHash: string }).rangeHash,
        })
        : null,
      audioMaster: Object.freeze({
        id: master.id,
        masterHash: master.masterHash,
        profileSnapshotId: master.profileSnapshotId,
        sourceProviderJobId: master.source.kind === 'tts' ? master.source.providerJobId : null,
        audio: Object.freeze({ ...master.audio }),
        alignmentEvidence: Object.freeze({ ...master.alignmentEvidence }),
      }),
      resultArtifact: row.resultArtifact
        ? Object.freeze({ artifactId: row.resultArtifact.artifactId, artifactSha256: row.resultArtifact.artifactSha256 })
        : null,
      authorizationHash: row.authorization.authorizationHash,
      submittedAt: row.submittedAt ?? null,
      completedAt: row.completedAt ?? null,
    })
  }
}

export interface StoredArtifactByteIdentity {
  sha256: string
  byteSize: number
}

/**
 * Resolves the content address storage holds for one artifact key. The duration
 * prober needs it to materialize verified bytes: probing an unverified file
 * would measure whatever happens to sit at that path.
 */
export class PrismaStoredArtifactIdentityReader {
  private readonly client: PrismaClient

  constructor(client: PrismaClient = getV2PostgresClient()) {
    this.client = client
  }

  async readByKey(artifactKey: string): Promise<Readonly<StoredArtifactByteIdentity> | null> {
    const row = await this.client.v2MediaArtifact.findFirst({
      where: { artifactKey },
      select: { sha256: true, byteSize: true },
    })
    if (!row) return null
    return Object.freeze({ sha256: row.sha256, byteSize: Number(row.byteSize) })
  }
}

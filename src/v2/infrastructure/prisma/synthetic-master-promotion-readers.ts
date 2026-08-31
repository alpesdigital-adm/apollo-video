import { type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type {
  PromotableProviderJob,
  PromotableProviderJobReader,
} from '../../application/synthetic-master-assets.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

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
    const row = await this.client.v2ProviderJob.findFirst({
      where: { id: input.jobId, workspaceId: input.workspaceId },
      select: {
        id: true,
        workspaceId: true,
        projectId: true,
        originProjectVersionId: true,
        operation: true,
        adapterId: true,
        adapterVersion: true,
        providerJobId: true,
        status: true,
        criticResultHash: true,
        authorizationHash: true,
        submittedAt: true,
        completedAt: true,
      },
    })
    if (!row) return null
    return Object.freeze({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      originProjectVersionId: row.originProjectVersionId,
      operation: row.operation,
      adapterId: row.adapterId,
      adapterVersion: row.adapterVersion,
      providerJobId: row.providerJobId,
      status: row.status,
      criticResultHash: row.criticResultHash,
      authorizationHash: row.authorizationHash,
      submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
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

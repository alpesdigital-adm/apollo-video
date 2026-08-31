import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { SyntheticCacheSubmissionClaimRepository } from '../../application/ports/synthetic-cache-submission-claim-repository.ts'
import { getV2PostgresClient } from '../prisma-postgres/client.ts'

/**
 * The claim is arbitrated by the primary key, in one statement.
 *
 * `ON CONFLICT DO UPDATE ... WHERE` is what makes this safe: PostgreSQL takes
 * a row lock on the conflicting row and re-evaluates the predicate, so exactly
 * one of two concurrent callers can insert, and a second one can only take over
 * a claim that is genuinely stale. A statement that changes nothing returns no
 * row, which is precisely "somebody else holds this address".
 */
export class PrismaSyntheticCacheSubmissionClaimRepository implements SyntheticCacheSubmissionClaimRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient = getV2PostgresClient()) { this.client = client }

  async claim(input: Parameters<SyntheticCacheSubmissionClaimRepository['claim']>[0]) {
    const taken = await this.client.$queryRaw<{ blockId: string }[]>(Prisma.sql`
      INSERT INTO "synthetic_cache_submission_claims" ("workspaceId", "cacheKey", "blockId", "claimedAt")
      VALUES (${input.workspaceId}, ${input.cacheKey}, ${input.blockId}, ${input.now})
      ON CONFLICT ("workspaceId", "cacheKey") DO UPDATE
        SET "blockId" = EXCLUDED."blockId", "claimedAt" = EXCLUDED."claimedAt"
        WHERE "synthetic_cache_submission_claims"."claimedAt" < ${input.staleBefore}
      RETURNING "blockId"
    `)
    return taken.length === 1
  }

  async release(input: Parameters<SyntheticCacheSubmissionClaimRepository['release']>[0]) {
    await this.client.v2SyntheticCacheSubmissionClaim.deleteMany({
      where: { workspaceId: input.workspaceId, cacheKey: input.cacheKey, blockId: input.blockId },
    })
  }
}

import { Prisma, type PrismaClient } from '../../../../generated/prisma-v2/index.js'
import type {
  OidcAuthorizationRepository,
  OidcAuthorizationTransaction,
} from '../../application/ports/oidc-authorization-repository.ts'

function hydrate(row: {
  stateHash: string; browserBindingHash: string; nonceHash: string; protectedCodeVerifier: string
  issuer: string; clientId: string; redirectUri: string; returnTo: string
  createdAt: Date; expiresAt: Date; consumedAt: Date | null
}): Readonly<OidcAuthorizationTransaction> {
  return Object.freeze({
    stateHash: row.stateHash,
    browserBindingHash: row.browserBindingHash,
    nonceHash: row.nonceHash,
    protectedCodeVerifier: row.protectedCodeVerifier,
    issuer: row.issuer,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    returnTo: row.returnTo,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.consumedAt ? { consumedAt: row.consumedAt.toISOString() } : {}),
  })
}

export class PrismaOidcAuthorizationRepository implements OidcAuthorizationRepository {
  constructor(private readonly client: PrismaClient) {}

  async create(input: Readonly<OidcAuthorizationTransaction>): Promise<void> {
    await this.client.v2OidcAuthorization.create({ data: {
      ...input,
      createdAt: new Date(input.createdAt),
      expiresAt: new Date(input.expiresAt),
      consumedAt: input.consumedAt ? new Date(input.consumedAt) : null,
    } })
  }

  async consume(input: Parameters<OidcAuthorizationRepository['consume']>[0], retry = 0): Promise<Readonly<OidcAuthorizationTransaction> | null> {
    const consumedAt = new Date(input.consumedAt)
    try {
      return await this.client.$transaction(async (transaction) => {
        const claimed = await transaction.v2OidcAuthorization.updateMany({
          where: {
            stateHash: input.stateHash,
            browserBindingHash: input.browserBindingHash,
            consumedAt: null,
            expiresAt: { gt: consumedAt },
          },
          data: { consumedAt },
        })
        if (claimed.count !== 1) return null
        const row = await transaction.v2OidcAuthorization.findUniqueOrThrow({ where: { stateHash: input.stateHash } })
        return hydrate(row)
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034' && retry < 3) {
        return this.consume(input, retry + 1)
      }
      throw error
    }
  }

  async deleteExpired(input: Parameters<OidcAuthorizationRepository['deleteExpired']>[0]): Promise<number> {
    const rows = await this.client.v2OidcAuthorization.findMany({
      where: { expiresAt: { lt: new Date(input.before) } },
      orderBy: { expiresAt: 'asc' },
      take: input.limit,
      select: { stateHash: true },
    })
    if (rows.length === 0) return 0
    return (await this.client.v2OidcAuthorization.deleteMany({
      where: { stateHash: { in: rows.map((row) => row.stateHash) } },
    })).count
  }
}

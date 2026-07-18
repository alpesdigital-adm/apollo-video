import type { PrismaClient } from '../../../../generated/prisma-v2/index.js'

import type { MediaDownloadGrantRepository } from '../../application/ports/media-download-grant-repository.ts'
import { createMediaDownloadGrant } from '../../domain/media-download-grant.ts'
import { DomainError } from '../../domain/errors.ts'

export class PrismaMediaDownloadGrantRepository implements MediaDownloadGrantRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }
  private present(row: { id: string; workspaceId: string; clientId: string; artifactId: string; tokenHash: string; idempotencyKey: string; requestFingerprint: string; status: string; expiresAt: Date; createdAt: Date; revokedAt: Date | null }) {
    return createMediaDownloadGrant({ id: row.id, workspaceId: row.workspaceId, clientId: row.clientId, artifactId: row.artifactId, tokenHash: row.tokenHash, idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, status: row.status as 'active' | 'revoked', expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}) })
  }
  async createOrReplay(grant: Parameters<MediaDownloadGrantRepository['createOrReplay']>[0]) {
    const existing = await this.client.v2MediaDownloadGrant.findUnique({ where: { workspaceId_clientId_idempotencyKey: { workspaceId: grant.workspaceId, clientId: grant.clientId, idempotencyKey: grant.idempotencyKey } } })
    if (existing) {
      if (existing.requestFingerprint !== grant.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency-Key was used with a different download request')
      return { grant: this.present(existing), replayed: true }
    }
    return { grant: this.present(await this.client.v2MediaDownloadGrant.create({ data: { ...grant, expiresAt: new Date(grant.expiresAt), createdAt: new Date(grant.createdAt), revokedAt: grant.revokedAt ? new Date(grant.revokedAt) : null } })), replayed: false }
  }
  async find(input: Parameters<MediaDownloadGrantRepository['find']>[0]) {
    const row = await this.client.v2MediaDownloadGrant.findFirst({ where: { id: input.grantId, workspaceId: input.workspaceId, clientId: input.clientId } })
    return row ? this.present(row) : undefined
  }
  async revoke(input: Parameters<MediaDownloadGrantRepository['revoke']>[0]) {
    const result = await this.client.v2MediaDownloadGrant.updateMany({ where: { id: input.grantId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'active' }, data: { status: 'revoked', revokedAt: new Date(input.revokedAt) } })
    if (result.count !== 1) throw new DomainError('MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant cannot be revoked')
    const row = await this.client.v2MediaDownloadGrant.findUnique({ where: { id: input.grantId } })
    if (!row) throw new DomainError('MEDIA_DOWNLOAD_GRANT_NOT_FOUND', 'Media download grant was not found')
    return this.present(row)
  }
}

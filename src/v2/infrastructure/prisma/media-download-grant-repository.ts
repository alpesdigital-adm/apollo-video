import type { PrismaClient, V2MediaDownloadGrant } from '../../../../generated/prisma-v2/index.js'

import type { MediaDownloadGrantRepository } from '../../application/ports/media-download-grant-repository.ts'
import { createMediaDownloadGrant } from '../../domain/media-download-grant.ts'
import { DomainError } from '../../domain/errors.ts'
import { createApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { ApiEnvironment } from '../../domain/api-client.ts'
import type { WorkspaceMemberRole } from '../../domain/workspace-member.ts'

function hydrateAudit(row: V2MediaDownloadGrant, prefix: 'issuer' | 'revoker') {
  const credentialId = prefix === 'issuer' ? row.issuerCredentialId : row.revokerCredentialId
  const environment = prefix === 'issuer' ? row.issuerEnvironment : row.revokerEnvironment
  const authenticationKind = prefix === 'issuer'
    ? row.issuerAuthenticationKind
    : row.revokerAuthenticationKind
  const contextHash = prefix === 'issuer' ? row.issuerContextHash : row.revokerContextHash
  const delegatedUserId = prefix === 'issuer'
    ? row.issuerDelegatedUserId
    : row.revokerDelegatedUserId
  const delegatedIdentityId = prefix === 'issuer'
    ? row.issuerDelegatedIdentityId
    : row.revokerDelegatedIdentityId
  const workspaceRole = prefix === 'issuer' ? row.issuerWorkspaceRole : row.revokerWorkspaceRole
  if (!credentialId || !environment || !authenticationKind || !contextHash) {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored download grant ${prefix} audit is incomplete`)
  }
  try {
    const audit = createApiAccessAuditContext({
      clientId: row.clientId,
      credentialId,
      workspaceId: row.workspaceId,
      environment: environment as ApiEnvironment,
      authenticationKind: authenticationKind as 'bearer' | 'ui-session',
      ...(delegatedUserId ? { delegatedUserId } : {}),
      ...(delegatedIdentityId ? { delegatedIdentityId } : {}),
      ...(workspaceRole ? { workspaceRole: workspaceRole as WorkspaceMemberRole } : {}),
    })
    if (audit.contextHash !== contextHash) throw new Error('context hash mismatch')
    return audit
  } catch {
    throw new DomainError('PERSISTENCE_CONFLICT', `Stored download grant ${prefix} audit is invalid`)
  }
}

export class PrismaMediaDownloadGrantRepository implements MediaDownloadGrantRepository {
  private readonly client: PrismaClient
  constructor(client: PrismaClient) { this.client = client }
  private present(row: V2MediaDownloadGrant) {
    try {
      return createMediaDownloadGrant({ id: row.id, workspaceId: row.workspaceId, clientId: row.clientId, artifactId: row.artifactId, tokenHash: row.tokenHash, idempotencyKey: row.idempotencyKey, requestFingerprint: row.requestFingerprint, status: row.status as 'active' | 'revoked', expiresAt: row.expiresAt.toISOString(), createdAt: row.createdAt.toISOString(), audit: hydrateAudit(row, 'issuer'), ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString(), revocationAudit: hydrateAudit(row, 'revoker') } : {}) })
    } catch (error) {
      if (error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT') throw error
      throw new DomainError('PERSISTENCE_CONFLICT', 'Stored media download grant is invalid')
    }
  }
  async createOrReplay(
    grant: Parameters<MediaDownloadGrantRepository['createOrReplay']>[0],
  ): ReturnType<MediaDownloadGrantRepository['createOrReplay']> {
    const existing = await this.client.v2MediaDownloadGrant.findUnique({ where: { workspaceId_clientId_idempotencyKey: { workspaceId: grant.workspaceId, clientId: grant.clientId, idempotencyKey: grant.idempotencyKey } } })
    if (existing) {
      if (existing.requestFingerprint !== grant.requestFingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency-Key was used with a different download request')
      return { grant: this.present(existing), replayed: true }
    }
    try {
      return { grant: this.present(await this.client.v2MediaDownloadGrant.create({ data: {
        id: grant.id, workspaceId: grant.workspaceId, clientId: grant.clientId,
        artifactId: grant.artifactId, tokenHash: grant.tokenHash,
        idempotencyKey: grant.idempotencyKey, requestFingerprint: grant.requestFingerprint,
        status: grant.status, expiresAt: new Date(grant.expiresAt), createdAt: new Date(grant.createdAt),
        issuerCredentialId: grant.audit.credentialId,
        issuerEnvironment: grant.audit.environment,
        issuerAuthenticationKind: grant.audit.authenticationKind,
        issuerContextHash: grant.audit.contextHash,
        issuerDelegatedUserId: grant.audit.delegatedUserId,
        issuerDelegatedIdentityId: grant.audit.delegatedIdentityId,
        issuerWorkspaceRole: grant.audit.workspaceRole,
      } })), replayed: false }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
        return this.createOrReplay(grant)
      }
      throw error
    }
  }
  async find(input: Parameters<MediaDownloadGrantRepository['find']>[0]) {
    const row = await this.client.v2MediaDownloadGrant.findFirst({ where: { id: input.grantId, workspaceId: input.workspaceId, clientId: input.clientId } })
    return row ? this.present(row) : undefined
  }
  async revokeOrReplay(input: Parameters<MediaDownloadGrantRepository['revokeOrReplay']>[0]) {
    const result = await this.client.v2MediaDownloadGrant.updateMany({
      where: { id: input.grantId, workspaceId: input.workspaceId, clientId: input.clientId, status: 'active' },
      data: {
        status: 'revoked', revokedAt: new Date(input.revokedAt),
        revokerCredentialId: input.audit.credentialId,
        revokerEnvironment: input.audit.environment,
        revokerAuthenticationKind: input.audit.authenticationKind,
        revokerContextHash: input.audit.contextHash,
        revokerDelegatedUserId: input.audit.delegatedUserId,
        revokerDelegatedIdentityId: input.audit.delegatedIdentityId,
        revokerWorkspaceRole: input.audit.workspaceRole,
      },
    })
    const row = await this.client.v2MediaDownloadGrant.findFirst({
      where: { id: input.grantId, workspaceId: input.workspaceId, clientId: input.clientId },
    })
    if (!row) throw new DomainError('MEDIA_DOWNLOAD_GRANT_NOT_FOUND', 'Media download grant was not found')
    const grant = this.present(row)
    if (result.count === 0 && grant.revocationAudit?.contextHash !== input.audit.contextHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Download grant was revoked by a different audit identity')
    }
    return { grant, replayed: result.count === 0 }
  }
}

import { createHash, randomUUID } from 'node:crypto'

import { assertDomain } from '../domain/errors.ts'
import { createMediaDownloadGrant } from '../domain/media-download-grant.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import type { MediaDownloadGrantRepository, MediaDownloadGrantSigner } from './ports/media-download-grant-repository.ts'

const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

export function issueMediaDownloadGrantService(dependencies: {
  artifacts: MediaArtifactQueryRepository; grants: MediaDownloadGrantRepository; signer: MediaDownloadGrantSigner
  clock?: () => Date; createId?: () => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? randomUUID
  return async function issue(input: { workspaceId: string; clientId: string; artifactId: string; idempotencyKey: string; ttlSeconds?: number }) {
    const artifact = await dependencies.artifacts.findById(input.workspaceId, input.artifactId.trim())
    assertDomain(Boolean(artifact) && artifact!.status === 'available', 'MEDIA_ARTIFACT_NOT_FOUND', 'Media artifact was not found')
    const ttlSeconds = input.ttlSeconds ?? 300
    assertDomain(Number.isInteger(ttlSeconds) && ttlSeconds >= 30 && ttlSeconds <= 900, 'INVALID_ARGUMENT', 'ttlSeconds must be from 30 to 900')
    const createdAt = clock()
    const id = createId()
    const expiresAt = new Date(createdAt.getTime() + ttlSeconds * 1000).toISOString()
    const requestFingerprint = createHash('sha256').update(JSON.stringify({ artifactId: artifact!.id, ttlSeconds })).digest('hex')
    const signed = dependencies.signer.sign({ grantId: id, workspaceId: input.workspaceId, clientId: input.clientId, artifactId: artifact!.id, expiresAt })
    const candidate = createMediaDownloadGrant({ id, workspaceId: input.workspaceId, clientId: input.clientId, artifactId: artifact!.id, tokenHash: hashToken(signed.token), idempotencyKey: input.idempotencyKey, requestFingerprint, status: 'active', createdAt: createdAt.toISOString(), expiresAt })
    const persisted = await dependencies.grants.createOrReplay(candidate)
    const effective = persisted.grant
    const effectiveSigned = dependencies.signer.sign({ grantId: effective.id, workspaceId: effective.workspaceId, clientId: effective.clientId, artifactId: effective.artifactId, expiresAt: effective.expiresAt })
    return Object.freeze({ grant: Object.freeze({ id: effective.id, artifactId: effective.artifactId, status: effective.status, expiresAt: effective.expiresAt, createdAt: effective.createdAt }), downloadUrl: effectiveSigned.downloadUrl, replayed: persisted.replayed })
  }
}

export function revokeMediaDownloadGrantService(dependencies: { grants: MediaDownloadGrantRepository; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function revoke(input: { workspaceId: string; clientId: string; grantId: string }) {
    const grant = await dependencies.grants.find(input)
    assertDomain(Boolean(grant), 'MEDIA_DOWNLOAD_GRANT_NOT_FOUND', 'Media download grant was not found')
    if (grant!.status === 'revoked') return Object.freeze({ grant, replayed: true })
    const revoked = await dependencies.grants.revoke({ ...input, revokedAt: clock().toISOString() })
    return Object.freeze({ grant: revoked, replayed: false })
  }
}

export function authorizeMediaDownloadGrantService(dependencies: { grants: MediaDownloadGrantRepository; clock?: () => Date }) {
  const clock = dependencies.clock ?? (() => new Date())
  return async function authorize(input: { workspaceId: string; clientId: string; grantId: string; token: string }) {
    const grant = await dependencies.grants.find(input)
    assertDomain(Boolean(grant), 'MEDIA_DOWNLOAD_GRANT_NOT_FOUND', 'Media download grant was not found')
    assertDomain(grant!.status === 'active' && new Date(grant!.expiresAt) > clock(), 'MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant is inactive')
    assertDomain(hashToken(input.token) === grant!.tokenHash, 'MEDIA_DOWNLOAD_GRANT_REJECTED', 'Media download grant token is invalid')
    return Object.freeze({ artifactId: grant!.artifactId, grantId: grant!.id })
  }
}

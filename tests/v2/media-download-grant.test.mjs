import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeMediaDownloadGrantService, issueMediaDownloadGrantService, revokeMediaDownloadGrantService } from '../../src/v2/application/manage-media-download-grant.ts'
import { HmacMediaDownloadGrantSigner } from '../../src/v2/infrastructure/security/media-download-grant-signer.ts'
import { createExternalAuditContext } from '../../src/v2/application/authenticate-api-client.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { PrismaMediaDownloadGrantRepository } from '../../src/v2/infrastructure/prisma/media-download-grant-repository.ts'

function grantRepository() {
  const records = new Map()
  return {
    records,
    async createOrReplay(candidate) {
      const existing = [...records.values()].find((record) => record.workspaceId === candidate.workspaceId && record.clientId === candidate.clientId && record.idempotencyKey === candidate.idempotencyKey)
      if (existing) {
        if (existing.requestFingerprint !== candidate.requestFingerprint) { const error = new Error('mismatch'); error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH'; throw error }
        return { grant: existing, replayed: true }
      }
      records.set(candidate.id, candidate); return { grant: candidate, replayed: false }
    },
    async find({ workspaceId, clientId, grantId }) { const grant = records.get(grantId); return grant?.workspaceId === workspaceId && grant?.clientId === clientId ? grant : undefined },
    async revokeOrReplay({ grantId, revokedAt, audit }) {
      const grant = records.get(grantId)
      if (grant.status === 'revoked') {
        if (grant.revocationAudit.contextHash !== audit.contextHash) throw new DomainError('PERSISTENCE_CONFLICT', 'audit mismatch')
        return { grant, replayed: true }
      }
      const revoked = { ...grant, status: 'revoked', revokedAt, revocationAudit: audit }
      records.set(grantId, revoked)
      return { grant: revoked, replayed: false }
    },
  }
}

function memoryPrismaGrantRepository() {
  const rows = new Map()
  const model = {
    async findUnique({ where }) {
      if (where.id) return rows.get(where.id) ?? null
      const identity = where.workspaceId_clientId_idempotencyKey
      return [...rows.values()].find((row) =>
        row.workspaceId === identity.workspaceId && row.clientId === identity.clientId &&
        row.idempotencyKey === identity.idempotencyKey) ?? null
    },
    async findFirst({ where }) {
      const row = rows.get(where.id)
      return row?.workspaceId === where.workspaceId && row?.clientId === where.clientId ? row : null
    },
    async create({ data }) {
      const row = {
        ...data,
        revokedAt: null,
        revokerCredentialId: null, revokerEnvironment: null,
        revokerAuthenticationKind: null, revokerContextHash: null,
        revokerDelegatedUserId: null, revokerDelegatedIdentityId: null,
        revokerWorkspaceRole: null,
      }
      rows.set(row.id, row)
      return row
    },
    async updateMany({ where, data }) {
      const row = rows.get(where.id)
      if (!row || row.workspaceId !== where.workspaceId || row.clientId !== where.clientId || row.status !== where.status) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
  }
  return { rows, repository: new PrismaMediaDownloadGrantRepository({ v2MediaDownloadGrant: model }) }
}

function downloadActor(credentialId = 'credential-download-1') {
  const auditContext = createExternalAuditContext({
    workspaceId: 'workspace-download-1', clientId: 'client-download-1',
    credentialId, environment: 'sandbox',
  })
  return Object.freeze({
    ...auditContext, scopes: new Set(['artifacts:read']), authenticationKind: 'bearer',
    clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
    clientAccessStatus: 'active', workspaceAccessStatus: 'active', auditContext,
  })
}
const actor = downloadActor()
const artifact = { id: 'artifact-download-1', workspaceId: actor.workspaceId, status: 'available' }

test('download grant is short, artifact-scoped, idempotent and stores only token hash', async () => {
  const grants = grantRepository()
  const signer = new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return artifact } }, grants, signer, clock: () => new Date('2026-07-16T23:00:00.000Z'), createId: () => '123e4567-e89b-42d3-a456-426614174301' })
  const request = { workspaceId: actor.workspaceId, actor, artifactId: artifact.id, idempotencyKey: 'download-grant-001', ttlSeconds: 300 }
  const first = await issue(request)
  const replay = await issue(request)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(first.downloadUrl, replay.downloadUrl)
  assert.equal(first.grant.expiresAt, '2026-07-16T23:05:00.000Z')
  const token = new URL(first.downloadUrl).searchParams.get('token')
  assert.ok(token)
  assert.equal(new URL(first.downloadUrl).pathname, `/v1/media/download-grants/${first.grant.id}/content`)
  assert.deepEqual(signer.verify(token), {
    grantId: first.grant.id,
    workspaceId: actor.workspaceId,
    clientId: actor.clientId,
    artifactId: artifact.id,
    expiresAt: first.grant.expiresAt,
  })
  assert.throws(() => signer.verify(`${token.slice(0, -1)}x`), /invalid/)
  assert.equal(JSON.stringify([...grants.records.values()]).includes(token), false)
  assert.match([...grants.records.values()][0].tokenHash, /^[a-f0-9]{64}$/)
  assert.equal([...grants.records.values()][0].audit.credentialId, 'credential-download-1')
  await assert.rejects(
    issue({ ...request, actor: downloadActor('credential-download-2') }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
})

test('revocation converges and immediately denies authorization', async () => {
  const grants = grantRepository()
  const signer = new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return artifact } }, grants, signer, clock: () => new Date('2026-07-16T23:00:00.000Z'), createId: () => '123e4567-e89b-42d3-a456-426614174302' })
  const result = await issue({ workspaceId: actor.workspaceId, actor, artifactId: artifact.id, idempotencyKey: 'download-grant-002' })
  const token = new URL(result.downloadUrl).searchParams.get('token')
  const authorize = authorizeMediaDownloadGrantService({ grants, clock: () => new Date('2026-07-16T23:01:00.000Z') })
  assert.equal((await authorize({ ...actor, grantId: result.grant.id, token })).artifactId, artifact.id)
  const revoke = revokeMediaDownloadGrantService({ grants, clock: () => new Date('2026-07-16T23:02:00.000Z') })
  assert.equal((await revoke({ workspaceId: actor.workspaceId, actor, grantId: result.grant.id })).replayed, false)
  assert.equal((await revoke({ workspaceId: actor.workspaceId, actor, grantId: result.grant.id })).replayed, true)
  await assert.rejects(
    revoke({ workspaceId: actor.workspaceId, actor: downloadActor('credential-download-2'), grantId: result.grant.id }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  await assert.rejects(() => authorize({ ...actor, grantId: result.grant.id, token }), /inactive/)
})

test('download grant rejects unsafe TTL and unavailable artifacts', async () => {
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return { ...artifact, status: 'quarantined' } } }, grants: grantRepository(), signer: new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) }) })
  await assert.rejects(() => issue({ workspaceId: actor.workspaceId, actor, artifactId: artifact.id, idempotencyKey: 'download-grant-003', ttlSeconds: 901 }), /not found|ttlSeconds/)
})

test('Prisma download grant persists both audit identities and rejects stored tampering', async () => {
  const { rows, repository } = memoryPrismaGrantRepository()
  const signer = new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 'p'.repeat(32) })
  const issue = issueMediaDownloadGrantService({
    artifacts: { async findById() { return artifact } }, grants: repository, signer,
    clock: () => new Date('2026-07-16T23:00:00.000Z'),
    createId: () => '123e4567-e89b-42d3-a456-426614174303',
  })
  const issued = await issue({
    workspaceId: actor.workspaceId, actor, artifactId: artifact.id,
    idempotencyKey: 'download-grant-prisma-001',
  })
  const row = rows.get(issued.grant.id)
  assert.equal(row.issuerCredentialId, 'credential-download-1')
  assert.equal(row.issuerContextHash.length, 64)
  const revoked = await revokeMediaDownloadGrantService({
    grants: repository, clock: () => new Date('2026-07-16T23:02:00.000Z'),
  })({ workspaceId: actor.workspaceId, actor, grantId: issued.grant.id })
  assert.equal(revoked.grant.revocationAudit.credentialId, 'credential-download-1')
  assert.equal(row.revokerContextHash, revoked.grant.revocationAudit.contextHash)
  row.revokerCredentialId = 'credential-forged'
  await assert.rejects(
    repository.find({ workspaceId: actor.workspaceId, clientId: actor.clientId, grantId: issued.grant.id }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

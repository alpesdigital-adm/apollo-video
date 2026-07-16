import assert from 'node:assert/strict'
import test from 'node:test'

import { authorizeMediaDownloadGrantService, issueMediaDownloadGrantService, revokeMediaDownloadGrantService } from '../../src/v2/application/manage-media-download-grant.ts'
import { HmacMediaDownloadGrantSigner } from '../../src/v2/infrastructure/security/media-download-grant-signer.ts'

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
    async revoke({ grantId, revokedAt }) { const grant = records.get(grantId); const revoked = { ...grant, status: 'revoked', revokedAt }; records.set(grantId, revoked); return revoked },
  }
}

const actor = { workspaceId: 'workspace-download-1', clientId: 'client-download-1' }
const artifact = { id: 'artifact-download-1', workspaceId: actor.workspaceId, status: 'available' }

test('download grant is short, artifact-scoped, idempotent and stores only token hash', async () => {
  const grants = grantRepository()
  const signer = new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return artifact } }, grants, signer, clock: () => new Date('2026-07-16T23:00:00.000Z'), createId: () => '123e4567-e89b-42d3-a456-426614174301' })
  const request = { ...actor, artifactId: artifact.id, idempotencyKey: 'download-grant-001', ttlSeconds: 300 }
  const first = await issue(request)
  const replay = await issue(request)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(first.downloadUrl, replay.downloadUrl)
  assert.equal(first.grant.expiresAt, '2026-07-16T23:05:00.000Z')
  const token = new URL(first.downloadUrl).searchParams.get('token')
  assert.ok(token)
  assert.equal(JSON.stringify([...grants.records.values()]).includes(token), false)
  assert.match([...grants.records.values()][0].tokenHash, /^[a-f0-9]{64}$/)
})

test('revocation converges and immediately denies authorization', async () => {
  const grants = grantRepository()
  const signer = new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) })
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return artifact } }, grants, signer, clock: () => new Date('2026-07-16T23:00:00.000Z'), createId: () => '123e4567-e89b-42d3-a456-426614174302' })
  const result = await issue({ ...actor, artifactId: artifact.id, idempotencyKey: 'download-grant-002' })
  const token = new URL(result.downloadUrl).searchParams.get('token')
  const authorize = authorizeMediaDownloadGrantService({ grants, clock: () => new Date('2026-07-16T23:01:00.000Z') })
  assert.equal((await authorize({ ...actor, grantId: result.grant.id, token })).artifactId, artifact.id)
  const revoke = revokeMediaDownloadGrantService({ grants, clock: () => new Date('2026-07-16T23:02:00.000Z') })
  assert.equal((await revoke({ ...actor, grantId: result.grant.id })).replayed, false)
  assert.equal((await revoke({ ...actor, grantId: result.grant.id })).replayed, true)
  await assert.rejects(() => authorize({ ...actor, grantId: result.grant.id, token }), /inactive/)
})

test('download grant rejects unsafe TTL and unavailable artifacts', async () => {
  const issue = issueMediaDownloadGrantService({ artifacts: { async findById() { return { ...artifact, status: 'quarantined' } } }, grants: grantRepository(), signer: new HmacMediaDownloadGrantSigner({ baseUrl: 'https://downloads.example.com/', secret: 's'.repeat(32) }) })
  await assert.rejects(() => issue({ ...actor, artifactId: artifact.id, idempotencyKey: 'download-grant-003', ttlSeconds: 901 }), /not found|ttlSeconds/)
})

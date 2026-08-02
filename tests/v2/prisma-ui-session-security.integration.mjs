import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { PrismaUiSessionSecurityRepository } from '../../src/v2/infrastructure/prisma/ui-session-security-repository.ts'
import { PrismaWorkspaceMemberRepository } from '../../src/v2/infrastructure/prisma/workspace-member-repository.ts'

test('UI session security is revocable, idle-bounded, distributed and auditable in PostgreSQL', async () => {
  const client = new PrismaClient()
  const first = new PrismaUiSessionSecurityRepository(client)
  const second = new PrismaUiSessionSecurityRepository(client)
  const members = new PrismaWorkspaceMemberRepository(client)
  const workspaceId = 'ui-session-security-workspace'
  const clientId = 'ui-session-security-client'
  const nonceHash = 'a'.repeat(64)
  const subjectHash = 'b'.repeat(64)
  const keyHash = 'c'.repeat(64)
  const resetKeyHash = 'd'.repeat(64)
  const identityId = '00000000-0000-4000-8000-000000000981'
  const memberId = '00000000-0000-4000-8000-000000000982'
  const cleanup = async () => {
    await client.v2UiSession.deleteMany({ where: { workspaceId } })
    await client.v2UiLoginAttempt.deleteMany({ where: { keyHash: { in: [keyHash, resetKeyHash] } } })
    await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: { in: [keyHash, resetKeyHash] } } })
    await client.v2ApiCredential.deleteMany({ where: { workspaceId } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId } })
    await client.v2HumanIdentity.deleteMany({ where: { id: identityId } })
    await client.v2Workspace.deleteMany({ where: { id: workspaceId } })
  }
  try {
    await cleanup()
    await client.v2Workspace.create({ data: { id: workspaceId, slug: 'ui-session-security', name: 'UI Session Security' } })
    await client.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'UI Session Security Client', environment: 'production',
      scopesJson: '[]', secretSalt: 'test-salt', secretHash: 'e'.repeat(64),
    } })
    const member = await members.provisionBootstrapMembership({
      identityId, memberId, issuer: 'urn:apollo:bootstrap', subjectHash, workspaceId,
      role: 'operator', now: '2026-08-02T00:00:00.000Z',
    })
    assert.equal((await members.provisionBootstrapMembership({
      identityId: randomUUID(), memberId: randomUUID(), issuer: 'urn:apollo:bootstrap', subjectHash, workspaceId,
      role: 'administrator', now: '2026-08-02T00:00:01.000Z',
    })).id, memberId, 'bootstrap replay must preserve the original member and role')
    assert.equal(member.role, 'operator')
    const session = { version: 1, subject: 'operator', clientId, issuedAt: 1_785_628_800, expiresAt: 1_785_672_000, nonce: 'session-security-nonce' }
    await first.createSession({ session, nonceHash, subjectHash, workspaceId, memberId, idleTtlSeconds: 1800 })
    const touched = await second.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:10:00.000Z', idleTtlSeconds: 1800 })
    assert.equal(touched.idleExpiresAt, '2026-08-02T00:40:00.000Z')
    assert.equal(touched.memberId, memberId)
    assert.equal(touched.memberRole, 'operator')
    await client.v2WorkspaceMember.update({ where: { id: memberId }, data: { status: 'suspended' } })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:11:00.000Z', idleTtlSeconds: 1800 }), null)
    await client.v2WorkspaceMember.update({ where: { id: memberId }, data: { status: 'active' } })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:40:00.000Z', idleTtlSeconds: 1800 }), null)
    await second.revokeSession({ nonceHash, revokedAt: '2026-08-02T00:20:00.000Z' })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:21:00.000Z', idleTtlSeconds: 1800 }), null)

    const reserve = (repository, attempt, throttleKey = keyHash) => repository.reserveLoginAttempt({
      attemptId: randomUUID(), keyHash: throttleKey, subjectHash, requestId: `request-ui-security-${attempt}`,
      occurredAt: `2026-08-02T01:00:0${attempt}.000Z`, windowMs: 900_000, maxAttempts: 6,
    })
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const repository = attempt % 2 === 0 ? first : second
      const reservation = await reserve(repository, attempt)
      assert.equal(reservation.allowed, true)
      await repository.settleLoginAttempt({ attemptId: reservation.attemptId, settledAt: `2026-08-02T01:00:1${attempt}.000Z`, outcome: 'invalid' })
    }
    const blocked = await reserve(second, 7)
    assert.equal(blocked.allowed, false)
    assert.equal(blocked.retryAfterSeconds > 0, true)
    assert.equal((await client.v2UiLoginThrottle.findUnique({ where: { keyHash } })).attemptCount, 6)
    assert.deepEqual(await client.v2UiLoginAttempt.groupBy({ by: ['outcome'], where: { keyHash }, _count: { _all: true }, orderBy: { outcome: 'asc' } }), [
      { outcome: 'blocked', _count: { _all: 1 } }, { outcome: 'invalid', _count: { _all: 6 } },
    ])

    const successful = await reserve(first, 8, resetKeyHash)
    await second.settleLoginAttempt({ attemptId: successful.attemptId, settledAt: '2026-08-02T01:00:20.000Z', outcome: 'succeeded' })
    assert.equal(await client.v2UiLoginThrottle.findUnique({ where: { keyHash: resetKeyHash } }), null)
    assert.equal((await reserve(second, 9, resetKeyHash)).allowed, true)
  } finally {
    await cleanup()
    await client.$disconnect()
  }
})

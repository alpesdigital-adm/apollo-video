import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { PrismaClient } from '../../generated/prisma-v2/index.js'
import { PrismaUiSessionSecurityRepository } from '../../src/v2/infrastructure/prisma/ui-session-security-repository.ts'
import { PrismaWorkspaceMemberRepository } from '../../src/v2/infrastructure/prisma/workspace-member-repository.ts'
import { PrismaOidcAuthorizationRepository } from '../../src/v2/infrastructure/prisma/oidc-authorization-repository.ts'

test('UI session security is revocable, idle-bounded, distributed and auditable in PostgreSQL', async () => {
  const client = new PrismaClient()
  const first = new PrismaUiSessionSecurityRepository(client)
  const second = new PrismaUiSessionSecurityRepository(client)
  const members = new PrismaWorkspaceMemberRepository(client)
  const workspaceId = 'ui-session-security-workspace'
  const otherWorkspaceId = 'ui-session-security-other'
  const clientId = 'ui-session-security-client'
  const otherClientId = 'ui-session-security-other-client'
  const nonceHash = 'a'.repeat(64)
  const subjectHash = 'b'.repeat(64)
  const keyHash = 'c'.repeat(64)
  const resetKeyHash = 'd'.repeat(64)
  const identityId = '00000000-0000-4000-8000-000000000981'
  const memberId = '00000000-0000-4000-8000-000000000982'
  const otherMemberId = '00000000-0000-4000-8000-000000000983'
  const workspaceIds = [workspaceId, otherWorkspaceId]
  const cleanup = async () => {
    await client.v2UiSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2UiLoginAttempt.deleteMany({ where: { keyHash: { in: [keyHash, resetKeyHash] } } })
    await client.v2UiLoginThrottle.deleteMany({ where: { keyHash: { in: [keyHash, resetKeyHash] } } })
    await client.v2WorkspaceUiPrincipal.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2ApiAdministrationCommand.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2ApiCredential.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2WorkspaceMember.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2ApiClient.deleteMany({ where: { workspaceId: { in: workspaceIds } } })
    await client.v2HumanIdentity.deleteMany({ where: { id: identityId } })
    await client.v2Workspace.deleteMany({ where: { id: { in: workspaceIds } } })
  }
  try {
    await cleanup()
    await client.v2Workspace.create({ data: { id: workspaceId, slug: 'ui-session-security', name: 'UI Session Security' } })
    await client.v2Workspace.create({ data: { id: otherWorkspaceId, slug: 'ui-session-security-other', name: 'Other UI Session Security' } })
    await client.v2ApiClient.create({ data: {
      id: clientId, workspaceId, name: 'UI Session Security Client', type: 'service-account',
      allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '[]', createdBy: 'system:test',
    } })
    await client.v2ApiClient.create({ data: {
      id: otherClientId, workspaceId: otherWorkspaceId, name: 'Other UI Session Security Client', type: 'service-account',
      allowedEnvironmentsJson: '["production"]', scopeGrantsJson: '["projects:read"]', createdBy: 'system:test',
    } })
    await members.provisionBootstrapUiPrincipal({ workspaceId, clientId, now: '2026-08-02T00:00:00.000Z' })
    await members.provisionBootstrapUiPrincipal({ workspaceId: otherWorkspaceId, clientId: otherClientId, now: '2026-08-02T00:00:00.000Z' })
    const member = await members.provisionMembership({
      identityId, memberId, issuer: 'urn:apollo:bootstrap', subjectHash, workspaceId,
      role: 'operator', now: '2026-08-02T00:00:00.000Z',
    })
    assert.equal((await members.provisionMembership({
      identityId: randomUUID(), memberId: randomUUID(), issuer: 'urn:apollo:bootstrap', subjectHash, workspaceId,
      role: 'administrator', now: '2026-08-02T00:00:01.000Z',
    })).id, memberId, 'bootstrap replay must preserve the original member and role')
    assert.equal(member.role, 'operator')
    const otherMember = await members.provisionMembership({
      identityId: randomUUID(), memberId: otherMemberId, issuer: 'urn:apollo:bootstrap', subjectHash,
      workspaceId: otherWorkspaceId, role: 'director', now: '2026-08-02T00:00:02.000Z',
    })
    assert.equal(otherMember.id, otherMemberId)
    assert.deepEqual((await members.listSelectableForMember({ memberId })).map((entry) => entry.workspaceId), [otherWorkspaceId, workspaceId])
    assert.equal((await members.resolveSelectableForMember({ memberId, workspaceId: otherWorkspaceId }))?.uiClientId, otherClientId)
    const grant = { clientId, issuedAt: '2026-08-02T00:00:00.000Z', expiresAt: '2026-08-02T12:00:00.000Z' }
    await first.createSession({ grant, nonceHash, subjectHash, workspaceId, memberId, idleTtlSeconds: 1800 })
    const touched = await second.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:10:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 })
    assert.equal(touched.idleExpiresAt, '2026-08-02T00:40:00.000Z')
    assert.equal(touched.memberId, memberId)
    assert.equal(touched.memberRole, 'operator')
    const concurrentTouches = await Promise.all(Array.from({ length: 16 }, (_, index) =>
      (index % 2 === 0 ? first : second).readActiveAndTouch({
        nonceHash,
        now: `2026-08-02T00:10:${String(index).padStart(2, '0')}.000Z`,
        idleTtlSeconds: 1800,
        identifierMaxAgeSeconds: 900,
      }),
    ))
    assert.equal(concurrentTouches.every((session) => session?.nonceHash === nonceHash), true)
    await client.v2WorkspaceMember.update({ where: { id: memberId }, data: { status: 'suspended' } })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:11:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 }), null)
    await client.v2WorkspaceMember.update({ where: { id: memberId }, data: { status: 'active' } })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:40:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 }), null)
    await second.revokeSession({ nonceHash, revokedAt: '2026-08-02T00:20:00.000Z' })
    assert.equal(await first.readActiveAndTouch({ nonceHash, now: '2026-08-02T00:21:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 }), null)

    const rotationNonceHash = 'e'.repeat(64)
    const nextNonceHash = 'f'.repeat(64)
    const rotationGrant = { clientId, issuedAt: '2026-08-02T02:00:00.000Z', expiresAt: '2026-08-02T12:00:00.000Z' }
    await first.createSession({ grant: rotationGrant, nonceHash: rotationNonceHash, subjectHash, workspaceId, memberId, idleTtlSeconds: 1800 })
    const nextGrant = { ...rotationGrant, clientId: otherClientId, issuedAt: '2026-08-02T02:05:00.000Z' }
    const rotated = await second.rotateSession({
      currentNonceHash: rotationNonceHash, grant: nextGrant, nonceHash: nextNonceHash,
      workspaceId: otherWorkspaceId, clientId: otherClientId, memberId: otherMemberId,
      environment: 'production', idleTtlSeconds: 1800, now: '2026-08-02T02:05:00.000Z',
    })
    assert.equal(rotated.workspaceId, otherWorkspaceId)
    assert.equal(rotated.memberRole, 'director')
    assert.equal(await first.readActiveAndTouch({ nonceHash: rotationNonceHash, now: '2026-08-02T02:06:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 }), null)
    assert.equal((await first.readActiveAndTouch({ nonceHash: nextNonceHash, now: '2026-08-02T02:06:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900 }))?.workspaceId, otherWorkspaceId)

    const periodicNonceHash = '9'.repeat(64)
    const refreshInput = (now) => ({
      currentNonceHash: nextNonceHash, successorNonceHash: periodicNonceHash, now,
      idleTtlSeconds: 1800, rotateAfterSeconds: 600, identifierMaxAgeSeconds: 900, recoverySeconds: 60,
    })
    const notDue = await first.refreshActiveSession(refreshInput('2026-08-02T02:14:00.000Z'))
    assert.equal(notDue.rotated, false)
    assert.equal(notDue.session.nonceHash, nextNonceHash)
    const concurrentRefresh = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? first : second).refreshActiveSession(refreshInput('2026-08-02T02:15:00.000Z')),
    ))
    assert.equal(concurrentRefresh.every((result) => result?.rotated && result.session.nonceHash === periodicNonceHash), true)
    assert.equal(await client.v2UiSession.count({ where: { nonceHash: periodicNonceHash } }), 1)
    assert.deepEqual(await client.v2UiSession.findUnique({
      where: { nonceHash: nextNonceHash },
      select: { successorNonceHash: true, rotatedAt: true, revokedAt: true },
    }), {
      successorNonceHash: periodicNonceHash,
      rotatedAt: new Date('2026-08-02T02:15:00.000Z'),
      revokedAt: new Date('2026-08-02T02:15:00.000Z'),
    })
    assert.equal(await first.readActiveAndTouch({
      nonceHash: nextNonceHash, now: '2026-08-02T02:15:30.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900,
    }), null, 'a rotated identifier cannot authenticate ordinary API requests')
    assert.equal((await first.readActiveAndTouch({
      nonceHash: periodicNonceHash, now: '2026-08-02T02:15:30.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900,
    }))?.workspaceId, otherWorkspaceId)
    assert.equal(await second.refreshActiveSession(refreshInput('2026-08-02T02:16:00.000Z')), null, 'rotation recovery is bounded')

    const hardExpiredHash = '8'.repeat(64)
    await first.createSession({
      grant: { clientId, issuedAt: '2026-08-02T03:00:00.000Z', expiresAt: '2026-08-02T12:00:00.000Z' },
      nonceHash: hardExpiredHash, subjectHash, workspaceId, memberId, idleTtlSeconds: 1800,
    })
    assert.equal(await first.readActiveAndTouch({
      nonceHash: hardExpiredHash, now: '2026-08-02T03:15:00.000Z', idleTtlSeconds: 1800, identifierMaxAgeSeconds: 900,
    }), null, 'an unrotated identifier expires after fifteen minutes')

    const loggedOutHash = '7'.repeat(64)
    await first.createSession({
      grant: { clientId, issuedAt: '2026-08-02T04:00:00.000Z', expiresAt: '2026-08-02T12:00:00.000Z' },
      nonceHash: loggedOutHash, subjectHash, workspaceId, memberId, idleTtlSeconds: 1800,
    })
    await first.revokeSession({ nonceHash: loggedOutHash, revokedAt: '2026-08-02T04:01:00.000Z' })
    assert.equal(await second.refreshActiveSession({
      currentNonceHash: loggedOutHash, successorNonceHash: '6'.repeat(64), now: '2026-08-02T04:01:01.000Z',
      idleTtlSeconds: 1800, rotateAfterSeconds: 600, identifierMaxAgeSeconds: 900, recoverySeconds: 60,
    }), null, 'logout cannot be recovered as a rotation')

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

test('OIDC authorization transaction is browser-bound, atomic and one-shot in PostgreSQL', async () => {
  const client = new PrismaClient()
  const first = new PrismaOidcAuthorizationRepository(client)
  const second = new PrismaOidcAuthorizationRepository(client)
  const stateHash = '1'.repeat(64)
  const input = {
    stateHash,
    browserBindingHash: '2'.repeat(64),
    nonceHash: '3'.repeat(64),
    protectedCodeVerifier: 'v1.test.encrypted.verifier.tag',
    issuer: 'https://identity.example.test',
    clientId: 'apollo-web',
    redirectUri: 'https://apollo.example.test/v1/session/oidc/callback',
    returnTo: '/projects',
    createdAt: '2026-08-02T20:00:00.000Z',
    expiresAt: '2026-08-02T20:10:00.000Z',
  }
  try {
    await client.v2OidcAuthorization.deleteMany({ where: { stateHash } })
    await first.create(input)
    assert.equal(await second.consume({ stateHash, browserBindingHash: '4'.repeat(64), consumedAt: '2026-08-02T20:01:00.000Z' }), null)
    const [left, right] = await Promise.all([
      first.consume({ stateHash, browserBindingHash: input.browserBindingHash, consumedAt: '2026-08-02T20:02:00.000Z' }),
      second.consume({ stateHash, browserBindingHash: input.browserBindingHash, consumedAt: '2026-08-02T20:02:00.000Z' }),
    ])
    assert.equal([left, right].filter(Boolean).length, 1)
    assert.equal((left ?? right).consumedAt, '2026-08-02T20:02:00.000Z')
    assert.equal(await first.consume({ stateHash, browserBindingHash: input.browserBindingHash, consumedAt: '2026-08-02T20:03:00.000Z' }), null)
    assert.equal(await first.deleteExpired({ before: '2026-08-02T20:11:00.000Z', limit: 10 }), 1)
  } finally {
    await client.v2OidcAuthorization.deleteMany({ where: { stateHash } })
    await client.$disconnect()
  }
})

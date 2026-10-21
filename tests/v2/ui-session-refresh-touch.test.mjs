import assert from 'node:assert/strict'
import test from 'node:test'

import { PrismaUiSessionSecurityRepository } from '../../src/v2/infrastructure/prisma/ui-session-security-repository.ts'

const CURRENT = 'a'.repeat(64)
const SUCCESSOR = 'b'.repeat(64)

function session(overrides = {}) {
  return {
    nonceHash: CURRENT, workspaceId: 'workspace-1', clientId: 'client-1', memberId: 'member-1', subjectHash: 'c'.repeat(64),
    issuedAt: new Date('2026-10-21T19:00:00.000Z'), lastSeenAt: new Date('2026-10-21T19:00:00.000Z'),
    idleExpiresAt: new Date('2026-10-21T19:30:00.000Z'), expiresAt: new Date('2026-10-21T23:00:00.000Z'),
    revokedAt: null, rotatedAt: null, successorNonceHash: null,
    member: { role: 'operator', status: 'active', identityId: 'identity-1', identity: { status: 'active' } },
    ...overrides,
  }
}

function refreshInput(now) {
  return {
    currentNonceHash: CURRENT, successorNonceHash: SUCCESSOR, now,
    idleTtlSeconds: 1800, rotateAfterSeconds: 600, identifierMaxAgeSeconds: 900, recoverySeconds: 60,
  }
}

// A fake PostgreSQL where every write made INSIDE the Serializable transaction loses to a concurrent writer of the same
// ui_sessions row (SQLSTATE 40001 -> Prisma P2034), exactly what concurrent GET /v1/session calls of one browser page do.
// Writes made outside a transaction (READ COMMITTED) always succeed and are applied to `state.row`.
function fakeDatabase(initial = session(), { beforeTouch } = {}) {
  const state = { row: initial, transactions: 0, transactionWrites: 0, touches: [] }
  const conflict = () => Object.assign(new Error('could not serialize access due to concurrent update'), { code: 'P2034' })
  const transaction = {
    v2UiSession: {
      async findUnique() { return state.row },
      async update() { state.transactionWrites += 1; throw conflict() },
      async updateMany() { state.transactionWrites += 1; throw conflict() },
      async create() { state.transactionWrites += 1; throw conflict() },
    },
  }
  const client = {
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, 'Serializable')
      state.transactions += 1
      return callback(transaction)
    },
    v2UiSession: {
      async findUnique() { return state.row },
      async updateMany({ where, data }) {
        await beforeTouch?.(state)
        const row = state.row
        const now = where.idleExpiresAt.gt
        const eligible = !row.revokedAt && row.expiresAt > where.expiresAt.gt && row.idleExpiresAt > now &&
          row.issuedAt > where.issuedAt.gt && row.lastSeenAt < where.lastSeenAt.lt
        state.touches.push({ eligible, data })
        if (!eligible) return { count: 0 }
        state.row = { ...row, lastSeenAt: data.lastSeenAt, idleExpiresAt: data.idleExpiresAt }
        return { count: 1 }
      },
    },
  }
  return { client, state }
}

test('concurrent GET /v1/session idle touches never conflict and none answers PERSISTENCE_CONFLICT', async () => {
  const { client, state } = fakeDatabase()
  const repository = new PrismaUiSessionSecurityRepository(client)
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    repository.refreshActiveSession(refreshInput(`2026-10-21T19:03:${String(index).padStart(2, '0')}.000Z`))))
  assert.equal(results.every((result) => result?.rotated === false && result.session.nonceHash === CURRENT), true)
  assert.equal(state.transactionWrites, 0, 'the idle touch is not written inside the Serializable transaction')
  assert.equal(state.transactions, 12, 'one read transaction each, no retries')
  assert.equal(state.row.lastSeenAt.toISOString(), '2026-10-21T19:03:11.000Z', 'lastSeenAt reached the newest touch')
  assert.equal(state.row.idleExpiresAt.toISOString(), '2026-10-21T19:33:11.000Z')
})

test('the idle touch only moves forward', async () => {
  const { client, state } = fakeDatabase(session({ lastSeenAt: new Date('2026-10-21T19:05:00.000Z') }))
  const repository = new PrismaUiSessionSecurityRepository(client)
  const result = await repository.refreshActiveSession(refreshInput('2026-10-21T19:04:00.000Z'))
  assert.equal(result.rotated, false)
  assert.equal(state.row.lastSeenAt.toISOString(), '2026-10-21T19:05:00.000Z')
  assert.equal(state.touches[0].eligible, false)
})

test('a session revoked between the read and the touch is not extended and not authenticated', async () => {
  const { client, state } = fakeDatabase(session(), {
    beforeTouch(database) { database.row = { ...database.row, revokedAt: new Date('2026-10-21T19:03:00.000Z') } },
  })
  const repository = new PrismaUiSessionSecurityRepository(client)
  assert.equal(await repository.refreshActiveSession(refreshInput('2026-10-21T19:04:00.000Z')), null)
  assert.equal(state.row.lastSeenAt.toISOString(), '2026-10-21T19:00:00.000Z')
  assert.equal(state.touches.every((touch) => touch.eligible === false), true)
})

test('an expired or suspended session is not touched', async () => {
  for (const row of [
    session({ idleExpiresAt: new Date('2026-10-21T19:02:00.000Z') }),
    session({ member: { role: 'operator', status: 'suspended', identityId: 'identity-1', identity: { status: 'active' } } }),
  ]) {
    const { client, state } = fakeDatabase(row)
    const repository = new PrismaUiSessionSecurityRepository(client)
    assert.equal(await repository.refreshActiveSession(refreshInput('2026-10-21T19:04:00.000Z')), null)
    assert.equal(state.row.lastSeenAt.toISOString(), '2026-10-21T19:00:00.000Z')
  }
})

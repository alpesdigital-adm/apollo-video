import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { createV2PostgresClient } from '../../src/v2/infrastructure/prisma-postgres/client.ts'

test('Apollo V2 rejects missing and non-PostgreSQL connection URLs', () => {
  const previous = process.env.V2_DATABASE_URL
  delete process.env.V2_DATABASE_URL
  try {
    assert.throws(
      () => createV2PostgresClient(),
      (error) =>
        error instanceof DomainError && error.code === 'PERSISTENCE_NOT_CONFIGURED',
    )
  } finally {
    if (previous === undefined) delete process.env.V2_DATABASE_URL
    else process.env.V2_DATABASE_URL = previous
  }

  for (const databaseUrl of ['', 'file:./dev.db', 'mysql://localhost/apollo']) {
    assert.throws(
      () => createV2PostgresClient(databaseUrl),
      (error) =>
        error instanceof DomainError && error.code === 'PERSISTENCE_NOT_CONFIGURED',
    )
  }
})

test('independent Postgres client exposes only v2 model delegates', async () => {
  const client = createV2PostgresClient(
    'postgresql://apollo:test-only@127.0.0.1:5432/apollo_v2?schema=public',
  )
  try {
    assert.equal(typeof client.v2Workspace.findUnique, 'function')
    assert.equal(typeof client.v2Project.create, 'function')
    assert.equal(typeof client.v2ProjectVersion.findMany, 'function')
    assert.equal('project' in client, false)
  } finally {
    await client.$disconnect()
  }
})

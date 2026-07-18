import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import { resolveV2PersistenceMode } from '../../src/v2/infrastructure/persistence-mode.ts'
import { createV2PostgresClient } from '../../src/v2/infrastructure/prisma-postgres/client.ts'

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  )
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  try {
    return callback()
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('Apollo V2 requires Postgres in every environment', () => {
  withEnvironment(
    {
      APOLLO_API_ENVIRONMENT: 'sandbox',
      APOLLO_V2_PERSISTENCE: undefined,
      V2_DATABASE_URL: undefined,
    },
    () =>
      assert.throws(
        resolveV2PersistenceMode,
        (error) =>
          error instanceof DomainError && error.code === 'PERSISTENCE_NOT_CONFIGURED',
      ),
  )

  withEnvironment(
    {
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_V2_PERSISTENCE: 'sqlite-prototype',
      V2_DATABASE_URL: undefined,
    },
    () =>
      assert.throws(
        resolveV2PersistenceMode,
        (error) =>
          error instanceof DomainError && error.code === 'PERSISTENCE_NOT_CONFIGURED',
      ),
  )
})

test('configured Postgres is the only accepted persistence mode', () => {
  withEnvironment(
    {
      APOLLO_API_ENVIRONMENT: 'sandbox',
      APOLLO_V2_PERSISTENCE: 'postgres',
      V2_DATABASE_URL: 'postgresql://apollo:test-only@127.0.0.1:5432/apollo_v2?schema=public',
    },
    () => assert.equal(resolveV2PersistenceMode(), 'postgres'),
  )
})

test('Postgres mode requires a connection URL', () => {
  withEnvironment(
    {
      APOLLO_API_ENVIRONMENT: 'production',
      APOLLO_V2_PERSISTENCE: 'postgres',
      V2_DATABASE_URL: undefined,
    },
    () =>
      assert.throws(
        resolveV2PersistenceMode,
        (error) =>
          error instanceof DomainError && error.code === 'PERSISTENCE_NOT_CONFIGURED',
      ),
  )
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

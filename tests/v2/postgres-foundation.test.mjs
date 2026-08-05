import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  PERSISTED_PUBLIC_OPERATION_PHASES,
  PERSISTED_PUBLIC_OPERATION_TYPES,
} from '../../src/v2/domain/public-operation.ts'
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

test('latest PostgreSQL operation constraints cover every V2 operation type and phase', async () => {
  const migrationsUrl = new URL(
    '../../prisma/v2/migrations/',
    import.meta.url,
  )
  const directories = (await readdir(migrationsUrl, {
    withFileTypes: true,
  }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted()
  const definitions = []
  for (const directory of directories) {
    const sql = await readFile(
      new URL(`${directory}/migration.sql`, migrationsUrl),
      'utf8',
    )
    for (const kind of ['type', 'phase']) {
      const pattern = new RegExp(
        `ADD CONSTRAINT "public_operations_${kind}_check"\\s+CHECK\\s*\\(\\s*"${kind}" IN \\(([\\s\\S]*?)\\)\\s*\\)`,
        'g',
      )
      for (const match of sql.matchAll(pattern)) {
        definitions.push({
          kind,
          migration: directory,
          values: [...match[1].matchAll(/'([^']+)'/g)]
            .map((value) => value[1]),
        })
      }
    }
  }

  const latest = (kind) =>
    definitions.filter((entry) => entry.kind === kind).at(-1)
  assert.deepEqual(
    latest('type')?.values,
    [...PERSISTED_PUBLIC_OPERATION_TYPES],
  )
  assert.deepEqual(
    latest('phase')?.values,
    [...PERSISTED_PUBLIC_OPERATION_PHASES],
  )
  assert.equal(
    latest('type')?.migration,
    '20260803223000_project_director_operations',
  )
  assert.equal(
    latest('phase')?.migration,
    '20260803223000_project_director_operations',
  )
})

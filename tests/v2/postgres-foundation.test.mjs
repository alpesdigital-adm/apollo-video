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

test('color pipeline binding migration backfills historical render operations', async () => {
  const sql = await readFile(
    new URL(
      '../../prisma/v2/migrations/20260731080000_render_color_pipeline_bindings/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )

  for (const table of [
    'project_proxy_render_operations',
    'project_final_export_operations',
  ]) {
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE "${table}"\\s+ADD COLUMN "colorPipelineBindingsJson" TEXT NOT NULL DEFAULT '\\[\\]'`,
      ),
    )
    assert.match(
      sql,
      new RegExp(
        `ALTER TABLE "${table}"\\s+ALTER COLUMN "colorPipelineBindingsJson" DROP DEFAULT`,
      ),
    )
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
          sql,
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
    '20261009010000_face_producer_envelope',
  )
  assert.equal(
    latest('phase')?.migration,
    '20261008231000_temporal_public_operation_constraints',
  )

  const sql = latest('type').sql
  const versionTargets = sql.match(/"type" IN \(([^)]+)\) AND "targetType" = 'project-version'/)
  assert.ok(versionTargets, 'producer operations must remain version-scoped')
  assert.deepEqual([...versionTargets[1].matchAll(/'([^']+)'/g)].map((match) => match[1]), [
    'project-director-run', 'synthetic-production-render',
    'perception-producer-run', 'perception-temporal-run', 'perception-face-run',
  ])
  for (const [type, phases] of [
    ['perception-producer-run', ['probing', 'transcribing', 'verifying', 'persisting']],
    ['perception-temporal-run', ['probing', 'analyzing', 'verifying', 'persisting']],
    ['perception-face-run', ['probing', 'analyzing', 'verifying', 'persisting']],
  ]) {
    const mappings = [...sql.matchAll(new RegExp(
      `WHEN "type" = '${type}' AND "phase" = '([^']+)' THEN (\\d+)`, 'g',
    ))].map((match) => [match[1], Number(match[2])])
    assert.deepEqual(mappings, phases.map((phase, index) => [phase, index]),
      `${type} must persist precisely its four measured stages`)
    assert.match(sql, new RegExp(
      `"type" <> '${type}' OR "status" <> 'running'\\s+OR "phase" IN \\(${phases.map((phase) => `'${phase}'`).join(', ')}\\)`,
    ), `${type} must reject unrelated running phases`)
  }
  const projectScope = sql.match(/"type" IN \(([^)]+)\) AND "projectId" IS NOT NULL/)
  assert.ok(projectScope)
  const requiredProjectTypes = [...projectScope[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  for (const type of ['perception-producer-run', 'perception-temporal-run', 'perception-face-run']) {
    assert.equal(requiredProjectTypes.includes(type), true, `${type} requires projectId`)
  }
  const totalFour = sql.match(/WHEN "type" IN \(([^)]+)\) THEN 4/)
  assert.ok(totalFour)
  const fourStageTypes = [...totalFour[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  for (const type of ['perception-producer-run', 'perception-temporal-run', 'perception-face-run']) {
    assert.equal(fourStageTypes.includes(type), true, `${type} has four persisted stages`)
  }
})

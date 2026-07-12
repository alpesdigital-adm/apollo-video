import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const prismaCli = fileURLToPath(new URL('../node_modules/prisma/build/index.js', import.meta.url))
const schemaPath = 'prisma/v2/schema.prisma'
const migrationsPath = 'prisma/v2/migrations'
const environment = {
  ...process.env,
  V2_DATABASE_URL:
    process.env.V2_DATABASE_URL ??
    'postgresql://apollo:validate-only@127.0.0.1:5432/apollo_v2?schema=public',
}

function runPrisma(args, capture = false) {
  const result = spawnSync(process.execPath, [prismaCli, ...args], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    stdio: capture ? 'pipe' : 'inherit',
  })
  if (result.status !== 0) {
    if (result.error) throw result.error
    if (capture) process.stderr.write(result.stderr ?? '')
    process.exit(result.status ?? 1)
  }
  return result.stdout ?? ''
}

function names(sql, pattern) {
  return new Set([...sql.matchAll(pattern)].map((match) => match[1]))
}

function assertSetContains(actual, expected, label) {
  const missing = [...expected].filter((name) => !actual.has(name))
  assert.deepEqual(missing, [], `${label} missing from committed migration`)
}

runPrisma(['validate', '--schema', schemaPath])
const generated = runPrisma(
  ['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
  true,
)
const committed = readdirSync(migrationsPath, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((left, right) => left.name.localeCompare(right.name))
  .map((entry) => readFileSync(`${migrationsPath}/${entry.name}/migration.sql`, 'utf8'))
  .join('\n')

assertSetContains(
  names(committed, /CREATE TABLE "([^"]+)"/g),
  names(generated, /CREATE TABLE "([^"]+)"/g),
  'tables',
)
assertSetContains(
  names(committed, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g),
  names(generated, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g),
  'indexes',
)
assertSetContains(
  names(committed, /ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g),
  names(generated, /ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g),
  'foreign keys',
)

const requiredChecks = [
  'workspaces_status_check',
  'api_clients_status_check',
  'api_clients_environment_check',
  'api_credentials_status_check',
  'api_credentials_hash_check',
  'api_credentials_revocation_check',
  'projects_status_check',
  'projects_creator_type_check',
  'project_snapshots_kind_check',
  'project_snapshots_hash_check',
  'project_versions_sequence_check',
  'project_versions_hash_check',
  'idempotency_records_status_check',
  'idempotency_records_fingerprint_check',
]
for (const constraint of requiredChecks) {
  assert.match(committed, new RegExp(`CONSTRAINT "${constraint}"`))
}

console.log(
  `V2 migration verified: ${names(generated, /CREATE TABLE "([^"]+)"/g).size} tables, ` +
    `${names(generated, /CREATE (?:UNIQUE )?INDEX "([^"]+)"/g).size} indexes, ` +
    `${names(generated, /ADD CONSTRAINT "([^"]+)" FOREIGN KEY/g).size} foreign keys`,
)

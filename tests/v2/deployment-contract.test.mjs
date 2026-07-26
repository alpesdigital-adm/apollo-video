import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const deployScriptUrl = new URL('../../infra/deploy/apollo-vps.sh', import.meta.url)

test('production deploy waits for PostgreSQL before migrating or replacing containers', async () => {
  const script = await readFile(deployScriptUrl, 'utf8')
  const waitForPostgres = script.indexOf('const deadline = Date.now() + 30_000')
  const migration = script.indexOf('npm run db:v2:migrate:deploy')
  const firstReplacement = script.indexOf('remove_container "${CONTAINER}"')

  assert.match(script, /--add-host host\.docker\.internal:host-gateway/)
  assert.match(script, /--network easypanel/)
  assert.match(script, /socket\.once\(\\"connect\\"/)
  assert.match(script, /setTimeout\(connect, 500\)/)
  assert.ok(waitForPostgres >= 0)
  assert.ok(migration > waitForPostgres)
  assert.ok(firstReplacement > migration)
})

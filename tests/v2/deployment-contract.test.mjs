import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const deployScriptUrl = new URL('../../infra/deploy/apollo-vps.sh', import.meta.url)
const nextConfigUrl = new URL('../../next.config.js', import.meta.url)
const agentInstructionsUrl = new URL('../../AGENTS.md', import.meta.url)

test('production deploy waits for PostgreSQL before migrating or replacing containers', async () => {
  const script = await readFile(deployScriptUrl, 'utf8')
  const uploadConfiguration = script.indexOf('APOLLO_MEDIA_UPLOAD_SIGNING_SECRET must contain at least 32 characters')
  const waitForPostgres = script.indexOf('const deadline = Date.now() + 30_000')
  const migration = script.indexOf('npm run db:v2:migrate:deploy')
  const firstReplacement = script.indexOf('remove_container "${CONTAINER}"')

  assert.match(script, /APOLLO_MEDIA_UPLOAD_BASE_URL must be a clean HTTPS origin/)
  assert.ok(uploadConfiguration >= 0)
  assert.ok(waitForPostgres > uploadConfiguration)
  assert.match(script, /--add-host host\.docker\.internal:host-gateway/)
  assert.match(script, /--network easypanel/)
  assert.match(script, /socket\.once\(\\"connect\\"/)
  assert.match(script, /setTimeout\(connect, 500\)/)
  assert.ok(waitForPostgres >= 0)
  assert.ok(migration > waitForPostgres)
  assert.ok(firstReplacement > migration)
  assert.match(
    script,
    /LONG_FORM_WORKER=.*long-form-worker/,
  )
  assert.match(
    script,
    /run-v2-long-form-worker\.mjs/,
  )
  assert.match(
    script,
    /PROVIDER_WORKER=.*provider-worker/,
  )
  assert.match(
    script,
    /run-v2-provider-worker\.mjs/,
  )
  assert.match(
    script,
    /GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR.*must be a positive integer/s,
  )
  assert.match(
    script,
    /Long-form provider credentials are not configured/,
  )
  assert.match(
    script,
    /for worker in "\$\{INGEST_WORKER\}" "\$\{RENDER_WORKER\}" "\$\{WEBHOOK_WORKER\}" "\$\{LONG_FORM_WORKER\}" "\$\{PROVIDER_WORKER\}"/,
  )
})

test('build tracing excludes ephemeral runtime artifacts and process logs stay outside the repository', async () => {
  const [configuration, instructions] = await Promise.all([
    readFile(nextConfigUrl, 'utf8'),
    readFile(agentInstructionsUrl, 'utf8'),
  ])
  assert.match(
    configuration,
    /outputFileTracingExcludes:\s*\{[\s\S]*'\/\*':\s*\[[\s\S]*'\.\/\.apollo\/\*\*\/\*'[\s\S]*'\.\/output\/\*\*\/\*'/,
  )
  assert.match(
    instructions,
    /Logs, PID files e stdout\/stderr[\s\S]*fora da raiz rastreada pelo build/,
  )
  assert.match(
    instructions,
    /proibido criar novamente `ssh-tunnel\*\.log`/,
  )
})

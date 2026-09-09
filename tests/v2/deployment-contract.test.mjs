import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const deployScriptUrl = new URL('../../infra/deploy/apollo-vps.sh', import.meta.url)
const dockerfileUrl = new URL('../../Dockerfile', import.meta.url)
const workflowComposeUrl = new URL('../../infra/workflow/compose.yml', import.meta.url)
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
    /PROVIDER_WORK_ROOT="\$\{APOLLO_V2_PROVIDER_WORK_ROOT:-\/app\/tmp\/provider-results\}"/,
  )
  assert.match(
    script,
    /--env APOLLO_V2_PROVIDER_WORK_ROOT="\$\{PROVIDER_WORK_ROOT\}"/,
  )
  assert.match(
    script,
    /install -d -o 1000 -g 1000 "\$\{APP_ROOT\}\/tmp\/provider-results"/,
  )
  assert.match(script, /sleep 20\nfor worker in/)
  assert.match(
    script,
    /GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR.*must be a positive integer/s,
  )
  assert.match(
    script,
    /Long-form provider credentials are not configured/,
  )
  assert.match(script, /APOLLO_LOCALIZATION_WORKER_ENABLED \?\? "false"/)
  assert.match(script, /localizationFlag !== "true" && localizationFlag !== "false"/)
  assert.match(script, /if \(localizationFlag === "true"\) \{[\s\S]*APOLLO_LOCALIZATION_PROVIDER_BASE_URL must be a clean HTTPS base URL/)
  assert.match(script, /APOLLO_LOCALIZATION_PROVIDER_API_KEY is not configured/)
  assert.match(script, /APOLLO_LOCALIZATION_PROVIDER_MODEL is not configured/)
  assert.match(script, /boundedInteger\("APOLLO_LOCALIZATION_MAX_COST_MICROS", 0, Number\.MAX_SAFE_INTEGER\)/)
  assert.match(script, /APOLLO_V2_CAPTURE_SYNC_LEASE_MS\?\.trim\(\)[\s\S]*boundedInteger\("APOLLO_V2_CAPTURE_SYNC_LEASE_MS", 300_000, 3_600_000\)[\s\S]*: 300_000/)
  for (const [container, entrypoint] of [
    ['CAPTURE_SYNC_WORKER', 'run-v2-capture-sync-worker.mjs'],
    ['MUSIC_ANALYSIS_WORKER', 'run-v2-music-analysis-worker.mjs'],
    ['LOCALIZATION_TRANSLATION_WORKER', 'run-v2-localization-translation-worker.mjs'],
    ['LOCALIZATION_MEDIA_WORKER', 'run-v2-localization-media-worker.mjs'],
  ]) {
    assert.match(script, new RegExp(`${container}=.*-worker`))
    assert.match(script, new RegExp(entrypoint.replaceAll('.', '\\.')))
    assert.match(script, new RegExp(`remove_container "\\$\\{${container}\\}"`))
  }
  for (const binary of [
    '--env APOLLO_V2_FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env APOLLO_FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env APOLLO_FFPROBE_PATH=/usr/bin/ffprobe',
    '--env FFPROBE_PATH=/usr/bin/ffprobe',
  ]) assert.ok(script.includes(binary), `${binary} must override the env file inside every runtime container`)
  assert.match(script, /remove_container "\$\{LOCALIZATION_TRANSLATION_WORKER\}"/)
  assert.match(script, /if \[\[ "\$\{LOCALIZATION_WORKER_ENABLED\}" == "true" \]\]; then[\s\S]*run-v2-localization-translation-worker\.mjs[\s\S]*fi/)
  assert.match(script, /WORKERS=\([\s\S]*"\$\{LOCALIZATION_MEDIA_WORKER\}"[\s\S]*\)/)
  assert.match(script, /WORKERS\+=\("\$\{LOCALIZATION_TRANSLATION_WORKER\}"\)/)
  assert.match(script, /for worker in "\$\{WORKERS\[@\]\}"/)
  for (const [name, fallback] of [
    ['APOLLO_CAPTURE_SYNC_WORKER_MEMORY', '768m'],
    ['APOLLO_MUSIC_ANALYSIS_WORKER_MEMORY', '768m'],
    ['APOLLO_LOCALIZATION_TRANSLATION_WORKER_MEMORY', '512m'],
    ['APOLLO_LOCALIZATION_MEDIA_WORKER_MEMORY', '2g'],
  ]) assert.ok(script.includes(`memoryLimit("${name}", "${fallback}")`))
})

test('production image materializes the Remotion bundle and runtime media binaries are deterministic', async () => {
  const [dockerfile, workflow] = await Promise.all([
    readFile(dockerfileUrl, 'utf8'),
    readFile(workflowComposeUrl, 'utf8'),
  ])
  const remotionBuild = dockerfile.indexOf('npm run remotion:build')
  const nextBuild = dockerfile.indexOf('npm run build', remotionBuild + 1)
  const runtimeCopy = dockerfile.indexOf('/app/remotion ./remotion')
  assert.ok(remotionBuild >= 0, 'the image never creates remotion/build')
  assert.ok(nextBuild > remotionBuild, 'the Remotion bundle must be built before the application image')
  assert.ok(runtimeCopy > remotionBuild, 'the built Remotion tree is not copied into the runtime stage')
  assert.match(dockerfile, /ensureBrowser\(\{logLevel:'error'\}\)/)
  for (const dependency of ['libnss3', 'libgbm1', 'libasound2', 'fonts-liberation']) {
    assert.ok(dockerfile.includes(dependency), `${dependency} is required by the bundled Remotion browser`)
  }
  for (const setting of [
    'APOLLO_V2_FFMPEG_PATH: /usr/bin/ffmpeg',
    'APOLLO_FFMPEG_PATH: /usr/bin/ffmpeg',
    'FFMPEG_PATH: /usr/bin/ffmpeg',
    'APOLLO_FFPROBE_PATH: /usr/bin/ffprobe',
    'FFPROBE_PATH: /usr/bin/ffprobe',
  ]) assert.ok(workflow.includes(setting), `${setting} is absent from the local runtime topology`)
})

test('workflow topology declares every durable Wave 18 through 21 worker without implicitly enabling paid translation', async () => {
  const workflow = await readFile(workflowComposeUrl, 'utf8')
  for (const [service, entrypoint] of [
    ['capture-sync-worker', 'run-v2-capture-sync-worker.mjs'],
    ['music-analysis-worker', 'run-v2-music-analysis-worker.mjs'],
    ['localization-translation-worker', 'run-v2-localization-translation-worker.mjs'],
    ['localization-media-worker', 'run-v2-localization-media-worker.mjs'],
  ]) {
    assert.match(workflow, new RegExp(`\\n  ${service}:`))
    assert.match(workflow, new RegExp(entrypoint.replaceAll('.', '\\.')))
  }
  assert.match(
    workflow,
    /localization-translation-worker:[\s\S]*?profiles: \["localization-provider"\][\s\S]*?run-v2-localization-translation-worker\.mjs/,
  )
  assert.match(workflow, /localization-translation-worker:[\s\S]*?APOLLO_LOCALIZATION_WORKER_ENABLED: "true"/)
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

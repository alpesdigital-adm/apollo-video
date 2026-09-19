import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import test from 'node:test'

const deployScriptUrl = new URL('../../infra/deploy/apollo-vps.sh', import.meta.url)
const deployLibraryUrls = {
  common: new URL('../../infra/deploy/lib/common.sh', import.meta.url),
  state: new URL('../../infra/deploy/lib/state.sh', import.meta.url),
  docker: new URL('../../infra/deploy/lib/docker.sh', import.meta.url),
  ops: new URL('../../infra/deploy/lib/ops.sh', import.meta.url),
}
const monitorScriptUrl = new URL('../../scripts/ops/host-safety-monitor.mjs', import.meta.url)
const verdictScriptUrl = new URL('../../scripts/ops/host-safety-verdict.mjs', import.meta.url)
const budgetScriptUrl = new URL('../../scripts/ops/resource-budget.mjs', import.meta.url)
const workerRoles = [
  'ingest-worker',
  'render-worker',
  'webhook-worker',
  'long-form-worker',
  'provider-worker',
  'capture-sync-worker',
  'music-analysis-worker',
  'localization-translation-worker',
  'localization-media-worker',
]
const dockerfileUrl = new URL('../../Dockerfile', import.meta.url)
const workflowComposeUrl = new URL('../../infra/workflow/compose.yml', import.meta.url)
const nextConfigUrl = new URL('../../next.config.js', import.meta.url)
const agentInstructionsUrl = new URL('../../AGENTS.md', import.meta.url)

test('production deploy gates every mutation behind lock, budget, monitor and preflight', async () => {
  const [script, common, state, docker, ops, monitorScript, verdictScript] = await Promise.all([
    readFile(deployScriptUrl, 'utf8'),
    readFile(deployLibraryUrls.common, 'utf8'),
    readFile(deployLibraryUrls.state, 'utf8'),
    readFile(deployLibraryUrls.docker, 'utf8'),
    readFile(deployLibraryUrls.ops, 'utf8'),
    readFile(monitorScriptUrl, 'utf8'),
    readFile(verdictScriptUrl, 'utf8'),
  ])

  // The order inside `cmd_deploy` is the invariant, not the order of definitions:
  // lock, no latch, image present, budget, cgroup capability, policy, container OOM,
  // monitor, preflight — and only then directories, configuration, migrations and the
  // per-container loop.
  const deployBody = script.slice(script.indexOf('cmd_deploy() {'))
  const at = (needle) => {
    const index = deployBody.indexOf(needle)
    assert.ok(index >= 0, `cmd_deploy does not contain ${needle}`)
    return index
  }
  const gateSequence = [
    'apollo_lock_acquire deploy',
    'apollo_latch_engaged',
    'apollo_require_image_present',
    'apollo_resolve_budget',
    'apollo_cgroup_capability',
    'apollo_load_policy_observation',
    'apollo_preflight_container_oom',
    'apollo_monitor_start',
    'apollo_await_phase preflight',
    'install -d',
    'apollo_validate_configuration',
    'apollo_wait_for_postgres_and_migrate',
    'for role in "${APOLLO_ROLES[@]}"',
    'apollo_await_phase postflight',
  ]
  for (let index = 1; index < gateSequence.length; index += 1) {
    assert.ok(
      at(gateSequence[index]) > at(gateSequence[index - 1]),
      `${gateSequence[index]} must come after ${gateSequence[index - 1]}`,
    )
  }
  // The end of a green run, in order: publish the open state by removing gate.json,
  // stop the run's own monitor, release the lock. (`apollo_lock_release` also appears
  // in the containment paths above, so this tail is matched as a whole.)
  assert.match(
    deployBody,
    /apollo_gate_clear 'postflight established[\s\S]*?apollo_monitor_stop[\s\S]*?apollo_lock_release[\s\S]*?trap - EXIT/,
  )
  // Containment after an inconclusive step: latch, stop only the run's own monitor,
  // release the lock, and start nothing.
  assert.match(script, /apollo_contain_and_latch\(\) \{\s*\n[^}]*apollo_latch_engage[\s\S]*?apollo_monitor_stop[\s\S]*?apollo_lock_release/)
  assert.ok(!/docker start|docker restart/.test(script), 'containment never starts a container')

  // The PostgreSQL wait still precedes the migration inside the same container, and the
  // configuration is still validated by the image because the host has no Node.
  assert.match(script, /APOLLO_MEDIA_UPLOAD_BASE_URL must be a clean HTTPS origin/)
  assert.ok(script.indexOf('const deadline = Date.now() + 30_000') < script.indexOf('npm run db:v2:migrate:deploy'))
  assert.match(script, /socket\.once\(\\"connect\\"/)
  assert.match(script, /setTimeout\(connect, 500\)/)
  assert.match(script, /--add-host host\.docker\.internal:host-gateway/)
  assert.match(script, /--network easypanel/)

  // Every long-running container keeps the environment the previous version passed, and
  // gains a read-only view of the host gate plus a name in pg_stat_activity.
  for (const binary of [
    '--env APOLLO_V2_FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env APOLLO_FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env FFMPEG_PATH=/usr/bin/ffmpeg',
    '--env APOLLO_FFPROBE_PATH=/usr/bin/ffprobe',
    '--env FFPROBE_PATH=/usr/bin/ffprobe',
  ]) assert.ok(script.includes(binary), `${binary} must override the env file inside every runtime container`)
  assert.match(script, /--env APOLLO_OPS_STATE_DIR=\/app\/ops-state/)
  assert.match(script, /-v "\$\(apollo_ops_state_mount_ro\)"/)
  assert.match(ops, /printf '%s:\/app\/ops-state:ro'/)
  assert.match(script, /--env "APOLLO_PROCESS_ROLE=\$\{role\}"/)
  assert.match(script, /PROVIDER_WORK_ROOT="\$\{APOLLO_V2_PROVIDER_WORK_ROOT:-\/app\/tmp\/provider-results\}"/)
  assert.match(script, /--env "APOLLO_V2_PROVIDER_WORK_ROOT=\$\{PROVIDER_WORK_ROOT\}"/)
  assert.match(script, /install -d -o 1000 -g 1000 "\$\{APP_ROOT\}\/tmp\/provider-results"/)
  assert.match(script, /--restart unless-stopped/)
  assert.match(script, /--init/)

  // Roles are declared once and the entrypoint is derived from the role, so the proof
  // that every worker still has one is the file on disk, not a string in this script.
  for (const role of workerRoles) {
    assert.match(script, new RegExp(`^  ${role}$`, 'm'), `${role} is not in APOLLO_ROLES`)
    assert.match(script, new RegExp(`${role}\\) printf '%s' "\\$\\{`), `${role} has no container name mapping`)
    await access(new URL(`../../scripts/run-v2-${role}.mjs`, import.meta.url))
  }
  assert.match(script, /\.\/node_modules\/\.bin\/tsx "scripts\/run-v2-\$\{role\}\.mjs"/)
  // The paid translation worker is still opt-in, now through the role gate.
  assert.match(script, /\[\[ "\$1" != 'localization-translation-worker' \]\] && return 0/)
  assert.match(script, /\[\[ "\$\{APOLLO_LOCALIZATION_ENABLED\}" == 'true' \]\]/)
  assert.match(script, /APOLLO_LOCALIZATION_WORKER_ENABLED \?\? "false"/)
  assert.match(script, /localizationFlag !== "true" && localizationFlag !== "false"/)
  assert.match(script, /if \(localizationFlag === "true"\) \{[\s\S]*APOLLO_LOCALIZATION_PROVIDER_BASE_URL must be a clean HTTPS base URL/)
  assert.match(script, /APOLLO_LOCALIZATION_PROVIDER_API_KEY is not configured/)
  assert.match(script, /APOLLO_LOCALIZATION_PROVIDER_MODEL is not configured/)
  assert.match(script, /boundedInteger\("APOLLO_LOCALIZATION_MAX_COST_MICROS", 0, Number\.MAX_SAFE_INTEGER\)/)
  assert.match(script, /APOLLO_V2_CAPTURE_SYNC_LEASE_MS\?\.trim\(\)[\s\S]*boundedInteger\("APOLLO_V2_CAPTURE_SYNC_LEASE_MS", 300_000, 3_600_000\)[\s\S]*: 300_000/)
  assert.match(script, /GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR.*must be a positive integer/s)
  assert.match(script, /Long-form provider credentials are not configured/)

  // The two `|| true` that used to swallow every stop and rm failure are gone, and the
  // whole file no longer silences any Docker verb that changes state.
  // Comments are stripped first: the header of the script quotes the old idiom in order
  // to explain why it is gone, and an assertion that cannot tell prose from code would
  // be satisfied by deleting the explanation.
  const withoutComments = (text) =>
    text
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
  assert.ok(
    !/docker (stop|rm)[^\n]*\|\| true/.test(withoutComments(`${script}\n${docker}`)),
    'no failure of a stop or rm of an Apollo container may be swallowed',
  )
  // The run's own monitor is no exception: its stop is confirmed too. The only failure
  // still tolerated is a removal, because an exited container publishes nothing and its
  // name carries this run's id.
  assert.ok(
    !/docker stop[^\n]*\|\| true/.test(withoutComments(ops)),
    'even the run monitor may not have its stop failure swallowed',
  )
  assert.match(ops, /apollo_monitor_stop\(\)[\s\S]*?docker rm "\$\{name\}" >\/dev\/null 2>&1/)
  assert.ok(!/remove_container/.test(script), 'the unconditional teardown helper is gone')
  // An invocation, not a mention: the script names these verbs in the message that
  // explains why it refuses to perform them, so the check is anchored to a command.
  assert.ok(
    !/^\s*docker (load|pull|system prune)/m.test(withoutComments(`${script}\n${docker}\n${ops}`)),
    'this operation never imports an image and never prunes the daemon',
  )
  assert.match(script, /This script never imports an image: docker load, docker pull/)
  assert.match(script, /uncoveredHostWork/)

  // A stop is a claim only once status, pid and PostgreSQL backends agree.
  assert.match(docker, /docker stop --timeout 30 "\$\{name\}"/)
  assert.match(docker, /\[\[ "\$\{status\}" != 'exited' && "\$\{status\}" != 'dead' \]\]/)
  assert.match(docker, /\[\[ "\$\{pid\}" != '0' \]\]/)
  assert.match(docker, /apollo_await_zero_backends "apollo-video-\$\{role\}"/)
  assert.match(docker, /apollo\.managed/)
  assert.match(docker, /--adopt-unlabelled/)
  assert.match(docker, /limit-readback-mismatch/)
  assert.match(docker, /State\.OOMKilled/)
  assert.match(docker, /cgroup v2/)

  // The host operational state is a lock by mkdir, a latch that is archived and never
  // removed, and a journal that never receives an environment value.
  assert.match(state, /mkdir "\$\{APOLLO_LOCK_DIR\}"/)
  assert.match(state, /bootId/)
  assert.match(state, /APOLLO_LOCK_ORPHAN_AFTER_MS=600000/)
  assert.match(state, /apollo-ops-latch\/v1/)
  assert.match(state, /released\.json/)
  assert.ok(!/rm -f "\$\{APOLLO_LATCH_FILE\}"/.test(state), 'a latch is archived, never deleted')
  assert.match(common, /never a wall clock|CLOCK_BOOTTIME/)

  // Every seam that could shorten a window, weaken a wait, replace the policy, lower a
  // quota or skip a step is declared in one list and refused on the shared host.
  for (const seam of [
    'APOLLO_OPS_POLICY_CATALOG',
    'APOLLO_OPS_MONITOR_MODE',
    'APOLLO_OPS_POLL_SLEEP_S',
    'APOLLO_OPS_PREFLIGHT_TIMEOUT_S',
    'APOLLO_OPS_POSTFLIGHT_TIMEOUT_S',
    'APOLLO_OPS_BACKEND_WAIT_ATTEMPTS',
    'APOLLO_OPS_BACKEND_WAIT_SLEEP_S',
    'APOLLO_OPS_HEALTH_ATTEMPTS',
    'APOLLO_OPS_HEALTH_SLEEP_S',
    'APOLLO_OPS_BOOTSTRAP_CPUS',
    'APOLLO_OPS_BOOTSTRAP_MEMORY_BYTES',
    'APOLLO_OPS_BOOTSTRAP_PIDS',
    'APOLLO_OPS_PROC_ROOT',
    'APOLLO_DEPLOY_SKIP_CHOWN',
  ]) {
    assert.match(common, new RegExp(`^  ${seam}$`, 'm'), `${seam} is not declared as a production-forbidden seam`)
  }
  assert.match(common, /\[\[ -n "\$\{!name\+set\}" \]\]/, 'a seam that is set but empty must still be refused')
  // It runs during environment validation — before the lock, the image or the budget —
  // so it applies to every subcommand, `plan` included.
  assert.match(
    script,
    /apollo_validate_environment\(\) \{[\s\S]*?apollo_refuse_production_seams "\$\{APOLLO_RESOURCE_PROFILE\}"/,
  )
  assert.ok(
    script.indexOf('apollo_refuse_production_seams "${APOLLO_RESOURCE_PROFILE}"') < script.indexOf('cmd_deploy() {'),
    'the seam refusal is validation, not a step of the deploy',
  )
  // And in Node, for the two programs that read the policy.
  for (const source of [monitorScript, verdictScript]) {
    assert.match(source, /--catalog must be \$\{SHIPPED_CATALOG\} when --profile is shared-production/)
  }

  // Every ops program resolves its configuration against the IMAGE root, which is what
  // makes the `config/` copy above load-bearing rather than decorative.
  const budgetScript = await readFile(budgetScriptUrl, 'utf8')
  for (const [name, source] of [
    ['host-safety-monitor.mjs', monitorScript],
    ['host-safety-verdict.mjs', verdictScript],
    ['resource-budget.mjs', budgetScript],
  ]) {
    assert.match(source, /const root = resolve\(import\.meta\.dirname, '\.\.', '\.\.'\)/, `${name} does not resolve against the image root`)
    assert.match(source, /resolve\(root, (options\.catalog|path)\)/, `${name} does not read its configuration from the image root`)
  }
  assert.match(monitorScript, /config\/host-safety-policy\.json/)
  assert.match(verdictScript, /config\/host-safety-policy\.json/)
  assert.match(budgetScript, /config\/resource-budget\.json/)

  // The run's own monitor may be stopped, but "stopped" is confirmed like every other
  // stop: a monitor left running keeps publishing a gate for a run that is over.
  assert.match(ops, /monitor-stop-inconclusive/)
  assert.match(ops, /monitor-remove-inconclusive/)
  assert.match(ops, /apollo_monitor_stop\(\)[\s\S]*?\[\[ "\$\{status\}" != 'exited' && "\$\{status\}" != 'dead' \]\]/)
  assert.match(script, /if ! apollo_monitor_stop; then[\s\S]*?the run monitor did not reach a terminal state/)
  assert.match(script, /apollo_monitor_stop \|\| apollo_log 'containment continued/)
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
  // The runtime stage must carry `config/`.
  //
  // It did not, and nothing noticed until a container of the real image tried to run:
  // the monitor, the verdict and the budget all resolve their catalog relative to the
  // image root, so every one of them died with ENOENT on
  // /app/config/host-safety-policy.json — in CI and in production alike (CI run
  // 35450914276). A fake Docker cannot show this, because a fake has no filesystem.
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('FROM '))
  assert.match(
    runtimeStage,
    /COPY --from=build --chown=node:node \/app\/config \.\/config/,
    'the runtime image has no config/, so the host safety policy and the resource budget cannot be read',
  )
  assert.match(dockerfile, /ensureBrowser\(\{logLevel:'error'\}\)/)
  for (const dependency of ['libnss3', 'libgbm1', 'libasound2', 'fonts-dejavu-core', 'fonts-liberation']) {
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

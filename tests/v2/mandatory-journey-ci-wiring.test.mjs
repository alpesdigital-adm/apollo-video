import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * T-F4.016 — the six product journeys are wired into CI, proved by reading CI.
 *
 * Every one of those suites skips by default, behind its own
 * `APOLLO_<TOPIC>_E2E` gate, and `node --test` exits 0 on a skip. So a journey
 * that lost its CI step — deleted in a merge, renamed without the workflow
 * following, or given an env block that sets the wrong variable — would report
 * exactly what a passing journey reports: a green run and a zero exit code.
 * The mandate that all six must run lived only inside `ci.yml`'s env blocks,
 * and nothing in the tree asserted that those blocks existed. A mandate
 * nothing checks is a comment.
 *
 * This suite is a `.test.mjs` on purpose: `npm test` discovers it, it needs no
 * database, no FFmpeg and no browser, and it therefore fails in the cheapest
 * job in the pipeline rather than in the one that would have run the journey.
 *
 * It deliberately derives almost everything it checks. The npm script comes
 * from `package.json`, the suite file from that script's command line, and the
 * gate variable from the suite's own source — so renaming a gate inside a
 * journey and forgetting the workflow is caught, instead of being hidden by a
 * second copy of the name living here. Only the six journeys themselves are
 * written down, because that list IS the mandate.
 *
 * A first version of this file asserted only that a step EXISTED with the
 * right env. An audit defeated it three ways without touching a name: `if:
 * false` on the step, `continue-on-error: true` on the step, and `if: false` on
 * the job that owns all six. A step that cannot fail the build enforces
 * nothing, so the parser now reads the switches as well as the names, and the
 * assertions below cover being switched off as well as being deleted.
 */

const REPO = new URL('../../', import.meta.url)
const read = (relative) => readFile(new URL(relative, REPO), 'utf8')

/**
 * BRIEF-E2E §"Jornadas", numbered as the briefing numbers them. The order is
 * the briefing's, not the workflow's.
 */
const MANDATORY_JOURNEYS = [
  { number: 1, subject: 'podcast, two cameras and a master audio track', script: 'test:e2e:podcast-multicam-journey' },
  { number: 2, subject: 'teacher and screen', script: 'test:e2e:teacher-screen-journey' },
  { number: 3, subject: 'react, piecewise playback', script: 'test:e2e:react-playback-journey' },
  { number: 4, subject: 'insufficient sync evidence', script: 'test:e2e:insufficient-evidence-journey' },
  { number: 5, subject: 'phase gate', script: 'test:e2e:phase-gate-journey' },
  { number: 6, subject: 'two hours to about two minutes', script: 'test:e2e:longform-synthesis' },
]

const SUITE_FILE = /tests\/[A-Za-z0-9/._-]+\.(?:mjs|cjs|js)/g

const isLiteral = (value, word) => value !== undefined && new RegExp(`^(?:${word}|'${word}'|"${word}")$`).test(value)

/**
 * `ci.yml` is read structurally rather than by regexing the whole file, because
 * the two things that decide whether a command runs — which job owns it and
 * which switches are set on it — are positional. Top-level keys sit at column
 * zero, jobs two spaces in, job attributes at four, steps open with `- ` at
 * six, and everything belonging to a step is indented at least eight. A blank
 * line belongs to whatever step precedes it; anything shallower than eight
 * closes the step, which is what makes a `# comment` written between two steps
 * at six spaces end the first rather than join it — and what makes a step
 * commented out stop counting as a step, which regexing the raw text did not.
 */
const parseWorkflow = (workflow) => {
  const jobs = []
  const steps = []
  let topLevelKey = null
  let job = null
  let current = null

  for (const line of workflow.split('\n')) {
    const topLevel = /^([A-Za-z][A-Za-z0-9_-]*):/.exec(line)
    if (topLevel) {
      topLevelKey = topLevel[1]
      job = null
      current = null
      continue
    }

    // Only `jobs:` holds jobs. Without this, `- main` under `on.push.branches`
    // parses as a step, at exactly the indentation a step uses.
    if (topLevelKey !== 'jobs') continue

    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (header) {
      job = { id: header[1], attrs: new Map() }
      jobs.push(job)
      current = null
      continue
    }
    if (!job) continue

    const jobAttribute = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (jobAttribute) {
      job.attrs.set(jobAttribute[1], jobAttribute[2].trim())
      current = null
      continue
    }

    if (/^ {6}- /.test(line)) {
      current = { job, lines: [line] }
      steps.push(current)
      continue
    }
    if (!current) continue
    if (line.trim() !== '' && !/^ {8}/.test(line)) {
      current = null
      continue
    }
    current.lines.push(line)
  }

  const parsed = steps.map(({ job: owner, lines }) => {
    const body = lines.join('\n')
    const npmScripts = [...body.matchAll(/npm run ([a-z0-9:._-]+)/g)].map((match) => match[1])
    const suiteFiles = [...body.matchAll(SUITE_FILE)].map((match) => match[0])

    // The `- ` line carries the step's first key, so `- uses: actions/checkout`
    // reads the same as a `uses:` written under a `- name:`.
    const attrs = new Map()
    const opener = /^ {6}- ([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[0])
    if (opener) attrs.set(opener[1], opener[2].trim())
    for (const line of lines.slice(1)) {
      const attribute = /^ {8}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (attribute) attrs.set(attribute[1], attribute[2].trim())
    }
    const name = attrs.get('name') ?? null

    // Blank lines and `#` comments are skipped rather than treated as the end
    // of the block. Breaking on a comment silently dropped every variable
    // written below one — six steps in this workflow explain a bucket or a
    // storage driver right above the value, and their `V2_DATABASE_URL` sits
    // under that explanation.
    const env = new Map()
    const envAt = lines.findIndex((line) => /^ {8}env:\s*$/.test(line))
    if (envAt >= 0) {
      for (const line of lines.slice(envAt + 1)) {
        if (line.trim() === '' || /^\s*#/.test(line)) continue
        const entry = /^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
        if (!entry) break
        env.set(entry[1], entry[2].trim())
      }
    }

    return { job: owner, name, npmScripts, suiteFiles, env, attrs, body }
  })

  return { jobs, steps: parsed }
}

/**
 * A step counts as coverage only if a red run inside it turns the build red.
 * `if: false` never runs; `continue-on-error: true` runs and is ignored; either
 * one on the owning job does the same to every step in it. Any other `if:` is
 * counted as running, which is the honest limit of reading YAML without
 * evaluating GitHub's expression language: `if: always()` genuinely runs, and
 * `if: ${{ github.event_name == 'push' }}` genuinely runs on half the events.
 */
const gatesTheBuild = (step) =>
  !isLiteral(step.attrs.get('if'), 'false') &&
  !isLiteral(step.attrs.get('continue-on-error'), 'true') &&
  !isLiteral(step.job?.attrs.get('if'), 'false') &&
  !isLiteral(step.job?.attrs.get('continue-on-error'), 'true')

const PERCEPTION_SUITES = [
  'tesseract-ocr-video-adapter', 'ffmpeg-temporal-video-analyzer',
  'prisma-perception-producer-admission', 'prisma-perception-producer-worker',
  'prisma-perception-producer-http', 'prisma-director-ocr',
  'prisma-temporal-producer', 'prisma-face-producer',
]

function verifyNamespaceConfigurationGuard(workflow) {
  const { jobs, steps } = parseWorkflow(workflow)
  const command = 'python3 -I -S -B tests/v2/perception-namespace-config.test.py'
  for (const [jobId, stepName] of [
    ['quality', 'Require Python 3.12 or newer for disposable operations tests'],
    ['perception', 'Prepare owned PostgreSQL and OCR dependencies'],
  ]) {
    const job = jobs.find((entry) => entry.id === jobId)
    assert.ok(job, `${jobId} is required for namespace configuration parity`)
    assert.equal(job.attrs.get('if'), undefined)
    assert.equal(job.attrs.get('continue-on-error'), undefined)
    const matches = steps.filter((step) => step.job === job && step.name === stepName)
    assert.equal(matches.length, 1)
    const step = matches[0]
    assert.equal(step.attrs.get('if'), undefined)
    assert.equal(step.attrs.get('continue-on-error'), undefined)
    assert.ok(gatesTheBuild(step))
    const lines = step.body.split('\n').map((line) => line.trim())
    assert.equal(lines.filter((line) => line === command).length, 1, 'Pure Python parity/negative gate cannot be removed, guarded or swallowed')
    const prerequisite = jobId === 'quality' ? lines.indexOf('fi')
      : lines.indexOf('sudo apt-get install -y tesseract-ocr tesseract-ocr-eng postgresql-client python3')
    assert.ok(prerequisite >= 0 && prerequisite < lines.indexOf(command), 'Existing Python prerequisite must precede pure guard')
  }
}

test('namespace Python configuration parity and strict negatives are mandatory in existing CI owners', async () => {
  const workflow = await read('.github/workflows/ci.yml')
  verifyNamespaceConfigurationGuard(workflow)
  const guards = await read('tests/v2/perception-namespace-config.test.py')
  assert.match(guards, /class CgroupConfiguration\(unittest\.TestCase\)/)
  for (const name of ['test_actual_closed_environment_matches_node_owner',
    'test_arbitrary_names_types_nul_and_aggregate_bytes_are_rejected', 'test_consumer_and_faults_are_fixed_not_exec_rpc'])
    assert.ok(guards.includes(`def ${name}(`), 'Fixed CI configuration command must include cgroup parity/strict guards')
  const command = '          python3 -I -S -B tests/v2/perception-namespace-config.test.py\n'
  for (const replacement of ['', '          echo parity-removed\n',
    '          python3 -I -S -B tests/v2/perception-namespace-config.test.py || true\n']) {
    assert.throws(() => verifyNamespaceConfigurationGuard(workflow.replace(command, replacement)))
  }
  for (const name of ['Require Python 3.12 or newer for disposable operations tests', 'Prepare owned PostgreSQL and OCR dependencies']) {
    for (const modifier of ['        if: false\n', '        continue-on-error: true\n']) {
      assert.throws(() => verifyNamespaceConfigurationGuard(workflow.replace(`      - name: ${name}\n`, `      - name: ${name}\n${modifier}`)))
    }
  }
})

function verifyPerceptionWiring(workflow) {
  const { jobs, steps } = parseWorkflow(workflow)
  const job = jobs.find((entry) => entry.id === 'perception')
  assert.ok(job, 'perception job is mandatory')
  assert.equal(job.attrs.get('if'), undefined)
  assert.equal(job.attrs.get('continue-on-error'), undefined)
  const block = workflow.split(/^  perception:\s*$/m)[1]?.split(/^  [a-zA-Z][\w-]*:\s*$/m)[0]
  assert.ok(block)
  for (const gate of ['APOLLO_OCR_VIDEO_E2E', 'APOLLO_PERCEPTION_HTTP_E2E',
    'APOLLO_TEMPORAL_VIDEO_E2E', 'APOLLO_TEMPORAL_HTTP_E2E']) {
    assert.match(block, new RegExp(`^ {6}${gate}: ['"]1['"]\\s*$`, 'm'))
  }
  assert.match(block, /^ {6}V2_DATABASE_URL: .*127\.0\.0\.1.*apollo_v2_perception.*application_name=apollo-video-e2e-perception-.*connection_limit=2.*pool_timeout=10.*connect_timeout=10/m)
  assert.match(block, /sha256sum.*binary-provenance\.sha256/)
  assert.match(block, /APOLLO_PERCEPTION_JOB_DEADLINE_MS=.*18 \* 60 \* 1000/)
  const rendererInstalls = steps.filter((step) => step.job === job && step.attrs.get('run') === 'npm ci --prefix remotion')
  assert.equal(rendererInstalls.length, 1, 'perception requires one locked Remotion dependency installation')
  const rendererInstall = rendererInstalls[0]
  assert.equal(rendererInstall.attrs.get('if'), undefined)
  assert.equal(rendererInstall.attrs.get('continue-on-error'), undefined)
  assert.ok(gatesTheBuild(rendererInstall))
  const productionBuild = steps.find((step) => step.job === job && step.attrs.get('run') === 'npm run build')
  assert.ok(productionBuild && steps.indexOf(rendererInstall) < steps.indexOf(productionBuild),
    'locked Remotion dependencies must be installed before the unchanged production build')
  const composed = steps.filter((step) => step.job === job &&
    step.attrs.get('run') === 'node scripts/validation/perception-consumer-cgroup.mjs gates tests/v2/perception-namespace-observer.integration.mjs')
  assert.equal(composed.length, 1, 'Real Linux namespace observer composed gate is mandatory')
  const cgroupGate = steps.filter((step) => step.job === job && step.name === 'Linux cgroup containment controlled gate')
  assert.equal(cgroupGate.length, 1, 'Real Linux cgroup owner-death/containment gate is mandatory')
  assert.equal(cgroupGate[0].attrs.get('run'), 'node scripts/validation/perception-consumer-cgroup.mjs --controlled-gates')
  assert.equal(cgroupGate[0].attrs.get('timeout-minutes'), '3')
  assert.equal(cgroupGate[0].attrs.get('if'), undefined); assert.equal(cgroupGate[0].attrs.get('continue-on-error'), undefined)
  assert.ok(gatesTheBuild(cgroupGate[0]))
  assert.ok(steps.indexOf(productionBuild) < steps.indexOf(cgroupGate[0]) && steps.indexOf(cgroupGate[0]) < steps.indexOf(composed[0]))
  assert.equal(composed[0].attrs.get('if'), undefined)
  assert.equal(composed[0].attrs.get('continue-on-error'), undefined)
  assert.ok(gatesTheBuild(composed[0]))
  assert.ok(steps.indexOf(productionBuild) < steps.indexOf(composed[0]))
  const addonBuilds = steps.filter((step) => step.job === job && step.name === 'Build unprivileged CI pidfd addon')
  assert.equal(addonBuilds.length, 1, 'Perception namespace requires its normal UID native pidfd prerequisite')
  assert.equal(addonBuilds[0].attrs.get('run'), 'bash scripts/validation/build-perception-pidfd.sh')
  assert.equal(addonBuilds[0].attrs.get('timeout-minutes'), '2')
  assert.equal(addonBuilds[0].attrs.get('if'), undefined)
  assert.equal(addonBuilds[0].attrs.get('continue-on-error'), undefined)
  assert.ok(steps.indexOf(addonBuilds[0]) < steps.indexOf(composed[0]))
  assert.doesNotMatch(block, /setcap|sudo\s+(?:npm|node)\b|sudoers|sysctl/)
  for (const name of PERCEPTION_SUITES) {
    const suite = `tests/v2/${name}.integration.mjs`
    const matches = steps.filter((step) => step.job === job && step.suiteFiles.includes(suite))
    assert.equal(matches.length, 1, `${suite} has exactly one supervised mandatory run`)
    const step = matches[0]
    assert.equal(step.attrs.get('if'), undefined)
    assert.equal(step.attrs.get('continue-on-error'), undefined)
    assert.ok(gatesTheBuild(step))
    const invocation = `node scripts/validation/perception-consumer-cgroup.mjs namespace ${suite}`
    assert.ok(step.body.includes(invocation))
    assert.ok(steps.indexOf(composed[0]) < steps.indexOf(step), 'Namespace gate must precede all eight proofs')
    if (name === 'prisma-face-producer') {
      assert.ok(step.body.includes(`${invocation} 'publish-race|face control'`))
    } else {
      assert.ok(step.body.split('\n').some((line) => line.trim() === invocation || line.trim() === `run: ${invocation}`))
    }
  }
}

test('W61 perception CI preserves supervised mandatory coverage and its exact facial limitation', async () => {
  const workflow = await read('.github/workflows/ci.yml')
  verifyPerceptionWiring(workflow)
  const cgroupStep = '      - name: Linux cgroup containment controlled gate\n        timeout-minutes: 3\n        run: node scripts/validation/perception-consumer-cgroup.mjs --controlled-gates\n'
  assert.ok(workflow.includes(cgroupStep))
  for (const replacement of ['', cgroupStep.replace('        run:', '        if: false\n        run:'),
    cgroupStep.replace('        run:', '        continue-on-error: true\n        run:'),
    cgroupStep.replace('timeout-minutes: 3', 'timeout-minutes: 4'),
    cgroupStep.replace('--controlled-gates', '--arbitrary')]) {
    assert.throws(() => verifyPerceptionWiring(workflow.replace(cgroupStep, replacement)))
  }
  for (const replacement of ['    if: false\n', '    continue-on-error: true\n']) {
    assert.throws(() => verifyPerceptionWiring(workflow.replace('  perception:\n', `  perception:\n${replacement}`)))
  }
  for (const name of PERCEPTION_SUITES) {
    const invocation = `node scripts/validation/perception-consumer-cgroup.mjs namespace tests/v2/${name}.integration.mjs`
    assert.throws(() => verifyPerceptionWiring(workflow.replace(invocation, 'echo removed')))
    assert.throws(() => verifyPerceptionWiring(workflow.replace(invocation,
      invocation.replace('perception-consumer-cgroup.mjs namespace', 'run-perception-ci-namespace.mjs'))))
  }
  for (const replacement of ['        if: false\n', '        continue-on-error: true\n']) {
    assert.throws(() => verifyPerceptionWiring(workflow.replace('      - name: Real OCR and temporal media adapters\n', `      - name: Real OCR and temporal media adapters\n${replacement}`)))
  }
  assert.throws(() => verifyPerceptionWiring(workflow.replace("APOLLO_TEMPORAL_HTTP_E2E: '1'", "APOLLO_TEMPORAL_HTTP_E2E: '0'")))
  assert.throws(() => verifyPerceptionWiring(workflow.replace(" 'publish-race|face control'", '')))
  const composedStep = '      - name: Linux namespace observer composed gate\n        run: node scripts/validation/perception-consumer-cgroup.mjs gates tests/v2/perception-namespace-observer.integration.mjs\n'
  assert.ok(workflow.includes(composedStep))
  assert.throws(() => verifyPerceptionWiring(workflow.replace(composedStep, '')))
  for (const replacement of ['        if: false\n', '        continue-on-error: true\n']) {
    assert.throws(() => verifyPerceptionWiring(workflow.replace(composedStep,
      composedStep.replace('        run:', `${replacement}        run:`))))
  }
  const rendererStep = '      - name: Install locked renderer dependencies for perception build\n        run: npm ci --prefix remotion\n'
  assert.ok(workflow.includes(rendererStep))
  assert.throws(() => verifyPerceptionWiring(workflow.replace(rendererStep, '')))
  for (const replacement of ['        if: false\n', '        continue-on-error: true\n']) {
    assert.throws(() => verifyPerceptionWiring(workflow.replace(rendererStep,
      rendererStep.replace('        run:', `${replacement}        run:`))))
  }
  const face = await read('tests/v2/prisma-face-producer.integration.mjs')
  const selected = [...face.matchAll(/^test\('([^']+)'/gm)].map((match) => match[1]).filter((name) => /publish-race|face control/.test(name))
  assert.deepEqual(selected, [
    'W61 publish-race fixture hydrates a real child and rights expiry offline',
    'W61 publish-race matcher checks typed codes, not error prose',
    'W61 face control uses scoped canonical audit before the repository transaction',
  ])
})

test('CI pidfd prerequisite remains unprivileged and mandatory under Node 22 quality and Node 24 perception', async () => {
  const workflow = await read('.github/workflows/ci.yml')
  const verify = (source) => {
    const { steps } = parseWorkflow(source)
    for (const job of ['quality', 'perception']) {
      const builds = steps.filter((step) => step.job.id === job && step.name === 'Build unprivileged CI pidfd addon')
      assert.equal(builds.length, 1)
      const build = builds[0]
      assert.equal(build.attrs.get('run'), 'bash scripts/validation/build-perception-pidfd.sh')
      assert.equal(build.attrs.get('if'), undefined); assert.equal(build.attrs.get('continue-on-error'), undefined)
      assert.equal(build.attrs.get('timeout-minutes'), '2'); assert.ok(gatesTheBuild(build))
      const consumer = steps.find((step) => step.job.id === job && step.attrs.get('run') ===
        (job === 'quality' ? 'node scripts/validation/perception-consumer-cgroup.mjs unit' : 'node scripts/validation/perception-consumer-cgroup.mjs gates tests/v2/perception-namespace-observer.integration.mjs'))
      assert.ok(consumer && steps.indexOf(build) < steps.indexOf(consumer))
      const cleanup = steps.filter((step) => step.job.id === job && step.attrs.get('run') === 'node scripts/validation/cleanup-perception-pidfd.mjs')
      assert.equal(cleanup.length, 1); assert.equal(cleanup[0].attrs.get('if'), 'always()')
      assert.equal(cleanup[0].attrs.get('continue-on-error'), undefined)
      assert.ok(steps.indexOf(consumer) < steps.indexOf(cleanup[0]))
      const archives = steps.filter((step) => step.job.id === job && step.name === 'Publish pidfd prerequisite and consumer lifecycle evidence')
      assert.equal(archives.length, 1); assert.equal(archives[0].attrs.get('if'), 'always()')
      assert.equal(archives[0].attrs.get('continue-on-error'), undefined)
      assert.ok(steps.indexOf(cleanup[0]) < steps.indexOf(archives[0]))
    }
    const quality = source.split(/^  quality:\s*$/m)[1]?.split(/^  [a-zA-Z][\w-]*:\s*$/m)[0]
    const perception = source.split(/^  perception:\s*$/m)[1]?.split(/^  [a-zA-Z][\w-]*:\s*$/m)[0]
    assert.match(quality, /node-version: 22/); assert.match(perception, /node-version: 24/)
  }
  verify(workflow)
  const step = '      - name: Build unprivileged CI pidfd addon\n        timeout-minutes: 2\n        run: bash scripts/validation/build-perception-pidfd.sh\n'
  assert.equal(workflow.split(step).length - 1, 2)
  for (const replacement of ['', step.replace('        run:', '        if: false\n        run:'),
    step.replace('        run:', '        continue-on-error: true\n        run:'),
    step.replace('run: bash', 'run: sudo bash')]) {
    assert.throws(() => verify(workflow.replace(step, replacement)))
  }
  for (const invocation of ['node scripts/validation/perception-consumer-cgroup.mjs unit',
    'node scripts/validation/perception-consumer-cgroup.mjs gates', 'node scripts/validation/cleanup-perception-pidfd.mjs']) {
    assert.throws(() => verify(workflow.replace(invocation, 'echo omitted')))
  }
})

function verifyLocalizationProxyMediaWiring(workflow, gate) {
  const { steps } = parseWorkflow(workflow)
  const matches = steps.filter((step) => step.npmScripts.includes('test:integration:localization-media-proxy'))
  assert.equal(matches.length, 1, 'localized media proxy must have exactly one mandatory CI run')
  const step = matches[0]
  assert.equal(step.job.id, 'local-infrastructure')
  assert.equal(step.attrs.get('id'), 'localization-media-proxy')
  assert.equal(step.attrs.get('if'), undefined)
  assert.equal(step.attrs.get('continue-on-error'), undefined)
  assert.equal(step.job.attrs.get('if'), undefined)
  assert.equal(step.job.attrs.get('continue-on-error'), undefined)
  assert.ok(gatesTheBuild(step))
  assert.ok(isLiteral(step.env.get(gate), '1'), 'the proxy persistence gate must run rather than skip')
  assert.match(step.env.get('V2_DATABASE_URL'), /127\.0\.0\.1:55432\/apollo_video_v2_e2e.*application_name=apollo-video-e2e-localization-media-proxy-ci.*connection_limit=5.*pool_timeout=10.*connect_timeout=10/)
  assert.equal(step.env.get('APOLLO_WAVE21_EVIDENCE_DIR'), '${{ runner.temp }}/localization-proxy-${{ github.run_id }}-${{ github.run_attempt }}')
  for (const required of [
    'set -euo pipefail',
    'ffmpeg="$(node -p \'require("ffmpeg-static")\')"',
    'ffprobe="$(node -p \'require("ffprobe-static").path\')"',
    'test -x "$ffmpeg" && test -x "$ffprobe"',
    'export APOLLO_V2_FFMPEG_PATH="$ffmpeg" FFPROBE_BIN="$ffprobe"',
    '"$ffmpeg" -version > "$APOLLO_WAVE21_EVIDENCE_DIR/ffmpeg-version.txt"',
    '"$ffprobe" -version > "$APOLLO_WAVE21_EVIDENCE_DIR/ffprobe-version.txt"',
    'sha256sum "$ffmpeg" "$ffprobe" package-lock.json > "$APOLLO_WAVE21_EVIDENCE_DIR/binary-provenance.sha256"',
    'sha256sum tests/v2/localization-snapshot-proxy.pg.integration.mjs tests/v2/helpers/localization-pg.mjs tests/v2/helpers/capture-journey.mjs > "$APOLLO_WAVE21_EVIDENCE_DIR/input-provenance.sha256"',
    'manifest="$(find "$APOLLO_WAVE21_EVIDENCE_DIR" -mindepth 2 -maxdepth 2 -type f -name manifest.json -print -quit)"',
    'test -n "$manifest" && test -s "$manifest"',
    'find "$APOLLO_WAVE21_EVIDENCE_DIR" -type f ! -name evidence-files.sha256 -print0 | sort -z | xargs -0 sha256sum > "$APOLLO_WAVE21_EVIDENCE_DIR/evidence-files.sha256"',
  ]) assert.ok(step.body.includes(required), `localized media proxy lost its executable/evidence contract: ${required}`)
  const publication = steps.find((entry) => entry.job === step.job && entry.name === 'Publish localization proxy media and binary provenance')
  assert.ok(publication && gatesTheBuild(publication))
  assert.equal(publication.attrs.get('uses'), 'actions/upload-artifact@v4')
  assert.equal(publication.attrs.get('if'), "always() && steps.localization-media-proxy.conclusion != 'skipped'")
  assert.match(publication.body, /path: \$\{\{ runner\.temp \}\}\/localization-proxy-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/)
  assert.match(publication.body, /if-no-files-found: error/)
  return step
}

test('localization media proxy CI resolves explicit locked media binaries and retains measured evidence', async () => {
  const [workflow, packageJson, source] = await Promise.all([
    read('.github/workflows/ci.yml'), read('package.json'), read('tests/v2/localization-snapshot-proxy.pg.integration.mjs'),
  ])
  assert.match(JSON.parse(packageJson).scripts['test:integration:localization-media-proxy'], /tests\/v2\/localization-snapshot-proxy\.pg\.integration\.mjs$/)
  const gate = /const enabled = process\.env\.(APOLLO_[A-Z0-9_]+) === '1'/.exec(source)?.[1]
  assert.ok(gate)
  const step = verifyLocalizationProxyMediaWiring(workflow, gate)
  for (const required of [
    'require("ffprobe-static").path', 'test -x "$ffprobe"', 'FFPROBE_BIN="$ffprobe"',
    'ffprobe-version.txt', 'binary-provenance.sha256', 'input-provenance.sha256',
    'test -n "$manifest" && test -s "$manifest"', 'evidence-files.sha256',
  ]) {
    const changed = workflow.replace(step.body, step.body.replaceAll(required, 'removed'))
    assert.notEqual(changed, workflow)
    assert.throws(() => verifyLocalizationProxyMediaWiring(changed, gate), undefined, required)
  }
  for (const disabled of ['        if: false\n', '        continue-on-error: true\n']) {
    assert.throws(() => verifyLocalizationProxyMediaWiring(workflow.replace(step.body,
      step.body.replace('        id:', `${disabled}        id:`)), gate))
  }
  assert.throws(() => verifyLocalizationProxyMediaWiring(workflow.replace(step.body,
    step.body.replace(`${gate}: "1"`, `${gate}: "0"`)), gate))
  for (const disabled of ['    if: false\n', '    continue-on-error: true\n']) {
    assert.throws(() => verifyLocalizationProxyMediaWiring(workflow.replace('  local-infrastructure:\n',
      `  local-infrastructure:\n${disabled}`), gate))
  }
  const publication = parseWorkflow(workflow).steps.find((entry) => entry.name === 'Publish localization proxy media and binary provenance')
  assert.throws(() => verifyLocalizationProxyMediaWiring(workflow.replace(publication.body,
    publication.body.replace('if-no-files-found: error', 'if-no-files-found: warn')), gate))
})

const singleTestFileOf = (command) => {
  const files = [...command.matchAll(SUITE_FILE)].map((match) => match[0])
  return files.length === 1 ? files[0] : null
}

test('dashboard runtime journey cannot silently skip or stop gating CI', async () => {
  const suite = 'tests/v2/dashboard-runtime-journey.e2e.mjs'
  const [workflow, source] = await Promise.all([
    read('.github/workflows/dashboard-runtime-ci.yml'), read(suite),
  ])
  const gate = /process\.env\.(APOLLO_[A-Z_]+_E2E)\s*!==\s*'1'/.exec(source)?.[1]
  assert.ok(gate, 'derive the opt-in gate from the runtime journey')
  const step = parseWorkflow(workflow).steps.find((entry) => entry.suiteFiles.includes(suite))
  assert.ok(step && gatesTheBuild(step), 'the real worker journey must fail CI when it fails')
  assert.match(workflow, new RegExp(`^ {6}${gate}: ['\"]?1['\"]?\\s*$`, 'm'))
  assert.match(workflow, /^ {6}V2_DATABASE_URL: .*apollo_v2_e2e_dashboard.*connection_limit=1/m)
})

test('T-F4.016 every mandatory product journey has a CI step, its own gate and a database', async () => {
  const [rawPackage, workflow] = await Promise.all([read('package.json'), read('.github/workflows/ci.yml')])
  const { scripts } = JSON.parse(rawPackage)
  const { jobs, steps } = parseWorkflow(workflow)

  assert.ok(jobs.length > 0, 'parsed no jobs out of ci.yml; the parser and the workflow have diverged')
  assert.ok(steps.length > 0, 'parsed no steps out of ci.yml; the parser and the workflow have diverged')

  // Everything below is only as true as the parse. A GitHub step always runs
  // either a command or an action, and always belongs to a job, so anything
  // parsed without those is the parser reading list items that are not steps —
  // which is exactly what an earlier version did to `- main` under
  // `on.push.branches`, at the same six-space indentation a step uses.
  const notSteps = steps
    .filter((step) => !step.job || (!step.attrs.has('run') && !step.attrs.has('uses')))
    .map((step) => step.name ?? step.attrs.keys().next().value ?? '(unreadable)')
  assert.deepEqual(notSteps, [], `parsed these as CI steps though they run nothing: ${notSteps.join(', ')}`)

  assert.equal(
    MANDATORY_JOURNEYS.length,
    6,
    'the briefing mandates six product journeys; changing that number is a decision, not an edit',
  )

  const seenGates = new Map()
  const seenApplicationNames = new Map()
  const versionedStorage = []

  for (const journey of MANDATORY_JOURNEYS) {
    const where = `journey ${journey.number} (${journey.subject})`

    const command = scripts[journey.script]
    assert.ok(command, `${where}: package.json has no script "${journey.script}"`)

    const file = singleTestFileOf(command)
    assert.ok(file, `${where}: "${journey.script}" must run exactly one test file, got: ${command}`)
    assert.match(file, /\.e2e\.mjs$/, `${where}: "${journey.script}" must run an .e2e.mjs suite, got ${file}`)

    // The gate is read out of the suite, never restated here: a journey that
    // renames its own variable and leaves `ci.yml` behind must fail this test.
    const suite = await read(file)
    const gate = /const RUN = process\.env\.(APOLLO_[A-Z0-9_]+) === '1'/.exec(suite)?.[1]
    assert.ok(gate, `${where}: ${file} does not declare "const RUN = process.env.APOLLO_..._E2E === '1'"`)

    const running = steps.filter((step) => step.npmScripts.includes(journey.script))
    // At least one, not exactly one. A journey may legitimately run more than
    // once — the podcast and phase gate journeys each run a second time in the
    // `local-infrastructure` job, the same suite under `s3`, which is the half
    // of the briefing's "PostgreSQL 16 AND versioned object storage" the
    // `quality` job cannot give. Which journeys those are is asserted below
    // rather than described here, because an earlier version of this comment
    // named the teacher journey — which runs once, in `quality`, with no s3
    // env at all — and nothing in the file could contradict it.
    assert.ok(
      running.length >= 1,
      `${where}: no CI step runs "npm run ${journey.script}"`,
    )
    if (running.some((step) => isLiteral(step.env.get('APOLLO_V2_ARTIFACT_STORAGE_DRIVER'), 's3'))) {
      versionedStorage.push(journey.script)
    }

    for (const step of running) {
    assert.ok(step.name, `${where}: its CI step must be named, so a failure names the journey`)
    assert.ok(step.job, `${where}: step "${step.name}" was parsed outside any job, which cannot happen in a valid workflow`)

    // Existing with the right env is not the same as running. A mandatory
    // journey is mandatory on every build, so it may carry no `if:` at all —
    // not even `always()`, which would be a way to spell a condition today and
    // spell `false` tomorrow — and it may not be excused from failing.
    assert.equal(
      step.attrs.get('if'),
      undefined,
      `${where}: step "${step.name}" declares if: ${step.attrs.get('if')}; a mandatory journey runs on every build`,
    )
    assert.ok(
      !isLiteral(step.attrs.get('continue-on-error'), 'true'),
      `${where}: step "${step.name}" sets continue-on-error: true, so the journey can fail without failing the build`,
    )
    assert.equal(
      step.job.attrs.get('if'),
      undefined,
      `${where}: job "${step.job.id}" declares if: ${step.job.attrs.get('if')}, which switches the journey off with it`,
    )
    assert.ok(
      !isLiteral(step.job.attrs.get('continue-on-error'), 'true'),
      `${where}: job "${step.job.id}" sets continue-on-error: true, so nothing it runs can fail the build`,
    )

    // Not `env` inherited from the job: each journey declares its own, because
    // that is where the gate lives and because the URL carries the
    // `application_name` the orphan-backend check greps for afterwards.
    //
    // The value is unquoted before comparing. GitHub coerces env values to
    // strings, so `APOLLO_X_E2E: 1` and `APOLLO_X_E2E: "1"` both reach the
    // suite as `'1'` and both run the journey; failing the second spelling
    // would be this test inventing a rule the platform does not have.
    const gateValue = step.env.get(gate)?.replace(/^(['"])(.*)\1$/, '$2')
    assert.equal(
      gateValue,
      '1',
      `${where}: step "${step.name}" must set ${gate} to 1, found ${step.env.get(gate) ?? 'nothing'}`,
    )

    const databaseUrl = step.env.get('V2_DATABASE_URL')
    assert.ok(databaseUrl, `${where}: step "${step.name}" sets no V2_DATABASE_URL, so the suite would skip on connect`)
    assert.match(databaseUrl, /^postgresql:\/\//, `${where}: V2_DATABASE_URL must be a PostgreSQL URL, got ${databaseUrl}`)

    // `assertIsolatedDatabase` (tests/v2/helpers/capture-journey.mjs) refuses
    // to run against a URL whose application_name does not read like this, so
    // journeys 1 and 2 already fail loudly on a mislabelled step. The other
    // four do not, and every leak check in this workflow greps for the label
    // afterwards — so the convention is asserted for all six here rather than
    // for the two that happen to enforce it at runtime.
    const applicationName = /application_name=([^&\s]+)/.exec(databaseUrl)?.[1]
    assert.match(
      applicationName ?? '',
      /^apollo-video-e2e-[a-z0-9-]+$/,
      `${where}: V2_DATABASE_URL needs an apollo-video-e2e-… application_name, got ${applicationName ?? 'none'}`,
    )

    // Uniqueness of the label is per STEP, not per journey: two steps running
    // the same journey under different storage drivers must still be
    // distinguishable in a leak check, and sharing a label would make one of
    // them invisible.
    const nameTwin = seenApplicationNames.get(applicationName)
    assert.equal(
      nameTwin,
      undefined,
      `${where}: step "${step.name}" shares application_name ${applicationName} with ${nameTwin}`,
    )
    seenApplicationNames.set(applicationName, `journey ${journey.number} step "${step.name}"`)
    }

    // Uniqueness of the GATE is per journey, because every step of one journey
    // shares it by design. Two different journeys sharing one gate is the
    // defect: neither could then be run alone.
    const gateTwin = seenGates.get(gate)
    assert.equal(
      gateTwin,
      undefined,
      `${where}: shares gate ${gate} with journey ${gateTwin}, so one of the two can never be run alone`,
    )
    seenGates.set(gate, journey.number)
  }

  // The count that the briefing's "PostgreSQL 16 AND versioned object storage"
  // actually buys, written as an equality so it cannot drift into prose again.
  // Two of six, not four and not all six: `APOLLO_V2_ARTIFACT_STORAGE_DRIVER:
  // s3` appears on the podcast and phase gate steps of `local-infrastructure`
  // and nowhere else, so teacher-screen, react-playback, insufficient-evidence
  // and longform-synthesis prove PostgreSQL only. Three of those four read the
  // driver from the environment and would run under `s3` unchanged — no CI
  // step gives them one; `longform-synthesis` reaches the renderer from a local
  // fixture path and has no artifact store in its path at all.
  //
  // Adding a journey to the `s3` half is a welcome change that must edit this
  // list, spec 05 §34.4 and the FR-150/F4.015/F4.016 traceability rows with it.
  assert.deepEqual(
    versionedStorage.toSorted(),
    ['test:e2e:phase-gate-journey', 'test:e2e:podcast-multicam-journey'],
    'exactly the podcast and phase gate journeys are wired to run against versioned object storage',
  )
})

/**
 * Reasons a suite file is allowed to run in no CI step. `PHASE_1_3` and
 * `NO_SCRIPT` are debts; the other two are decisions.
 */
const PAID_PROVIDERS = 'calls paid providers, which the owner’s briefing forbids in CI'
const PHASE_1_3 = 'Phase 1-3 suite with an npm script and no CI step'
const NO_SCRIPT = 'Phase 1-3 suite with no npm script at all, so wiring it means writing one first'

/**
 * Suite files that no CI step runs, each with a reason and with every document
 * that leans on it.
 *
 * The unit here is the FILE, not the npm script. An earlier version of this
 * list was keyed by script, and an audit found thirteen `*.integration.mjs`
 * files that no script names at all — invisible to `npm test`, which discovers
 * only `*.test.mjs`, invisible to CI, and invisible to a ratchet that counts
 * scripts. `tests/v2/prisma-manual-edit.integration.mjs` is 88 KB of them.
 *
 * `citedBy` is the second half of the same lesson. This list exists because
 * `test:integration:multicam-visual-evidence` sat unwired while spec 05 quoted
 * the numbers it measures, and the first version of the list then described its
 * own entries as "simply unrun" while seven of them were somebody's cited
 * evidence. The assertion below holds `citedBy` to exactly the set of documents
 * that name the file, so writing a document that leans on an unrun suite fails
 * this test until the citation is recorded here — which is the moment to notice
 * that the proof being cited did not run.
 *
 * A citation is a file, not a line: line numbers in TODO.md rot on the next
 * insertion above them, and a stale line number would make this fail for a
 * reason that has nothing to do with coverage.
 */
const KNOWN_UNRUN_SUITES = [
  {
    file: 'tests/v2/prisma-face-producer-http.integration.mjs',
    reason: 'W61 diagnostic face HTTP requires the licensed, hash-pinned development video/landing/lineage, YuNet model/license and local Python/OpenCV runtime; local result face-http-resume-v1-39bfb5da SHA256 1fa3c5960fdc2ce7bb9d7ee4cd72bc1c51fff76b10e878cfec0787f828be2fb9 is a controlled proof, not CI coverage or approved facial quality. Face producer integration is wired only for three offline audit/fixture cases; its PG and runner cases are likewise local, with faceSafety unknown and holdout closed.',
    citedBy: ['docs/quality/w61-yunet-cpu-adapter.md'],
  },
  { file: 'tests/v2/recovery-master-live.e2e.mjs', reason: 'requires the private owner-selected Imersão master, authorized live Groq credential/cost cap and supervised editorial/visual review; local proof is separate from hosted CI', citedBy: ['docs/quality/w51-60-integration.md'] },
  { file: 'tests/v2/contamination-golden-fixtures.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-evaluation-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-evidence-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-extraction-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-contiguous-audio-evidence-provider.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-contiguous-visual-evidence-provider.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-speaker-diarization-audio-preparer.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/format-quality-critic.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/long-form-stage-fencing.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/media-input-runtime.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/mvp-core-full-journey.e2e.mjs',
    reason: `${PHASE_1_3}; docs/quality/mvp-core-gate-v1.md calls it "a prova principal" of the MVP core gate`,
    citedBy: ['docs/quality/mvp-core-gate-v1.md', 'docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'],
  },
  { file: 'tests/v2/output-formats-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-asset-selection.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-format-quality-by-output.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-hierarchical-processing.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-long-form-moment-catalog.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-manual-edit.integration.mjs',
    reason: `${NO_SCRIPT}; docs/REQUIREMENTS-TRACEABILITY.md cites it for FR-233 and says in the same paragraph that it was never executed`,
    citedBy: ['docs/REQUIREMENTS-TRACEABILITY.md'],
  },
  { file: 'tests/v2/prisma-montage-alternative.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/prisma-mvp-core-gate.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-production-batch.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-proxy-review.integration.mjs',
    reason: NO_SCRIPT,
    citedBy: ['docs/specs/08-localization-and-audio.md'],
  },
  { file: 'tests/v2/prisma-quality-iteration.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-review-annotation.integration.mjs',
    reason: `${PHASE_1_3}; TODO.md cites it as the evidence closing F1-039 and F1-040`,
    citedBy: ['TODO.md', 'docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'],
  },
  {
    file: 'tests/v2/prisma-review-patch-batch.integration.mjs',
    reason: `${NO_SCRIPT}; TODO.md cites it as the evidence closing F1-044/T-FR-215`,
    citedBy: ['TODO.md', 'docs/PROJECT-STATUS.md'],
  },
  {
    file: 'tests/v2/prisma-review-patch.integration.mjs',
    reason: `${NO_SCRIPT}; TODO.md cites it as the evidence closing F1-043/T-FR-214`,
    citedBy: ['TODO.md', 'docs/PROJECT-STATUS.md'],
  },
  { file: 'tests/v2/prisma-script-alignment.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-source-deconstruction.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-speech-segment-catalog.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-subtitle-sidecar.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-take-library.integration.mjs',
    reason: `${PHASE_1_3}; docs/quality/take-library-v1.md reports it as having passed over a real rebuilt database`,
    citedBy: ['docs/quality/take-library-v1.md'],
  },
  { file: 'tests/v2/prisma-validated-segment-catalog.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/provider-live-contract.e2e.mjs',
    reason: PAID_PROVIDERS,
    citedBy: ['docs/PACOTE-WAVE24-GATE-SINTETICO.md'],
  },
  { file: 'tests/v2/reframe-plan-render.integration.mjs', reason: PHASE_1_3, citedBy: ['docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'] },
  { file: 'tests/v2/render-geometry-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/responsive-placement-visual.integration.mjs', reason: PHASE_1_3, citedBy: ['docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'] },
  { file: 'tests/v2/source-deconstruction-golden-reel.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/subtitle-anchor-render.integration.mjs', reason: PHASE_1_3, citedBy: ['docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'] },
  { file: 'tests/v2/subtitle-sidecar-pipeline.integration.mjs', reason: PHASE_1_3, citedBy: ['docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'] },
  { file: 'tests/v2/subtitle-style-token-goldens.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/subtitle-style-visual-goldens.integration.mjs', reason: PHASE_1_3, citedBy: ['docs/PROJECT-STATUS.md', 'docs/quality/project-status-classification-audit.md'] },
  { file: 'tests/v2/transformation-critic-media.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/visual-montage-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/wave10-combined-journey.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/wave9-combined-journeys.integration.mjs', reason: PHASE_1_3 },
]

const listSuiteFiles = async () => {
  const root = fileURLToPath(new URL('tests/', REPO))
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.(?:integration|e2e)\.mjs$/.test(entry.name))
    .map((entry) => `tests/${path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')}`)
    .sort()
}

const listMarkdown = async () => {
  const root = fileURLToPath(REPO)
  const entries = await readdir(fileURLToPath(new URL('docs/', REPO)), { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(entry.parentPath, entry.name))
  files.push(path.join(root, 'TODO.md'))
  return Promise.all(
    files.map(async (file) => ({
      name: path.relative(root, file).split(path.sep).join('/'),
      text: await readFile(file, 'utf8'),
    })),
  )
}

/**
 * What CI actually runs, as a set of suite files: every file a gating step
 * names directly, plus every file named by a script such a step invokes.
 * `npm test` finds `*.test.mjs` on its own; it finds neither `*.integration.mjs`
 * nor `*.e2e.mjs`, which is the whole reason a suite can exist and never run.
 */
const suiteFilesRunByCi = (steps, scripts, cgroupSource) => {
  const gating = steps.filter(gatesTheBuild)
  const runByCi = new Set(gating.flatMap((step) => step.npmScripts))
  const files = new Set(gating.flatMap((step) => step.suiteFiles))
  // This fixed owner chooses a source-pinned suite internally, instead of
  // taking a test path from argv. Count only its real mandatory invocation and
  // its actual literal -> fixed file -> spawn -> CLI dispatch bindings.
  const cgroupOwners = gating.filter((entry) => entry.job.id === 'perception' &&
    entry.name === 'Linux cgroup containment controlled gate' &&
    entry.attrs.get('run') === 'node scripts/validation/perception-consumer-cgroup.mjs --controlled-gates' &&
    entry.attrs.get('timeout-minutes') === '3' && entry.attrs.get('if') === undefined &&
    entry.attrs.get('continue-on-error') === undefined && entry.job.attrs.get('if') === undefined &&
    entry.job.attrs.get('continue-on-error') === undefined)
  if (cgroupOwners.length) {
    assert.equal(cgroupOwners.length, 1, 'Exactly one fixed cgroup owner may attest this suite')
    const declaration = /^export const CGROUP_GATE_SUITE = '(tests\/v2\/[A-Za-z0-9._-]+\.integration\.mjs)'$/m.exec(cgroupSource)
    assert.ok(declaration, 'Fixed cgroup gate suite must be an actual literal')
    assert.ok(cgroupSource.includes('const file = join(CI_ROOT, CGROUP_GATE_SUITE)'))
    assert.ok(cgroupSource.includes('spawn(process.execPath, [file],'))
    assert.ok(cgroupSource.includes("if (mode === '--controlled-gates')"))
    assert.ok(cgroupSource.includes('await runControlledCgroupGate()).success'))
    files.add(declaration[1])
  }
  for (const [name, command] of Object.entries(scripts)) {
    if (!runByCi.has(name)) continue
    for (const match of command.matchAll(SUITE_FILE)) files.add(match[0])
  }
  return { runByCi, files }
}

test('suite inventory follows the real cgroup owner; removed, bypassed or non-gating calls do not count', async () => {
  const [workflow, source] = await Promise.all([read('.github/workflows/ci.yml'),
    read('scripts/validation/perception-consumer-cgroup.mjs')])
  const suite = 'tests/v2/perception-consumer-cgroup.integration.mjs'
  const counted = (value, owner = source) => suiteFilesRunByCi(parseWorkflow(value).steps, {}, owner).files.has(suite)
  assert.equal(counted(workflow), true)
  const step = '      - name: Linux cgroup containment controlled gate\n        timeout-minutes: 3\n        run: node scripts/validation/perception-consumer-cgroup.mjs --controlled-gates\n'
  assert.ok(workflow.includes(step))
  for (const replacement of ['', step.replace('        run:', '        if: false\n        run:'),
    step.replace('        run:', '        continue-on-error: true\n        run:'),
    step.replace('--controlled-gates', '--arbitrary'), step.replace('timeout-minutes: 3', 'timeout-minutes: 4')]) {
    assert.equal(counted(workflow.replace(step, replacement)), false)
  }
  for (const attribute of ['    if: false\n', '    continue-on-error: true\n'])
    assert.equal(counted(workflow.replace('  perception:\n', '  perception:\n' + attribute)), false)
  for (const [actual, broken] of [
    ['export const CGROUP_GATE_SUITE =', 'export const UNRELATED_SUITE ='],
    ['const file = join(CI_ROOT, CGROUP_GATE_SUITE)', 'const file = unrelatedFile'],
    ['spawn(process.execPath, [file],', 'spawn(process.execPath, [unrelatedFile],'],
    ["if (mode === '--controlled-gates')", "if (mode === '--arbitrary')"],
    ['await runControlledCgroupGate()).success', 'await unrelatedGate()).success'],
  ]) {
    assert.ok(source.includes(actual))
    assert.throws(() => counted(workflow, source.replace(actual, broken)))
  }
})

async function inventoryCiSteps() {
  const [central, library, dashboard] = await Promise.all([
    read('.github/workflows/ci.yml'),
    read('.github/workflows/library-ci.yml'),
    read('.github/workflows/dashboard-runtime-ci.yml'),
  ])
  assert.match(library, /push:\s*\n\s+branches: \[main\]/)
  assert.match(library, /\n  pull_request:/)
  assert.match(dashboard, /push:\s*\n\s+branches: \[main\]/)
  assert.match(dashboard, /\n  pull_request:/)
  // Only generic coverage aggregates workflows. Six mandatory journeys above
  // still require their original ci.yml jobs, database and admission switches.
  return [...parseWorkflow(central).steps, ...parseWorkflow(library).steps, ...parseWorkflow(dashboard).steps]
}

test('T-F4.016 no integration or e2e suite file goes unrun by CI without being declared', async () => {
  const [rawPackage, workflow, present, cgroupSource] = await Promise.all([
    read('package.json'),
    inventoryCiSteps(),
    listSuiteFiles(),
    read('scripts/validation/perception-consumer-cgroup.mjs'),
  ])
  const { scripts } = JSON.parse(rawPackage)
  const steps = workflow
  const { files: filesRunByCi } = suiteFilesRunByCi(steps, scripts, cgroupSource)

  assert.ok(present.length > 0, 'found no integration or e2e suite files under tests/; the glob and the tree have diverged')

  const declared = new Map(KNOWN_UNRUN_SUITES.map((entry) => [entry.file, entry]))
  assert.equal(declared.size, KNOWN_UNRUN_SUITES.length, 'KNOWN_UNRUN_SUITES lists the same file twice')

  const undeclared = present.filter((file) => !filesRunByCi.has(file) && !declared.has(file))
  assert.deepEqual(
    undeclared,
    [],
    `these suite files run in no CI step; wire them into .github/workflows/ci.yml or add them to KNOWN_UNRUN_SUITES with a reason: ${undeclared.join(', ')}`,
  )

  const nowRun = [...declared.keys()].filter((file) => filesRunByCi.has(file))
  assert.deepEqual(
    nowRun,
    [],
    `these files are declared unrun but CI now runs them; remove them from KNOWN_UNRUN_SUITES: ${nowRun.join(', ')}`,
  )

  const gone = [...declared.keys()].filter((file) => !present.includes(file))
  assert.deepEqual(
    gone,
    [],
    `these files are declared unrun but no longer exist; remove them from KNOWN_UNRUN_SUITES: ${gone.join(', ')}`,
  )

  const unexplained = KNOWN_UNRUN_SUITES.filter((entry) => !entry.reason || entry.reason.length < 20).map((entry) => entry.file)
  assert.deepEqual(unexplained, [], `these entries carry no usable reason: ${unexplained.join(', ')}`)
})

test('T-F4.016 every npm integration or e2e script either runs in CI or runs a declared suite', async () => {
  const [rawPackage, steps, cgroupSource] = await Promise.all([read('package.json'), inventoryCiSteps(),
    read('scripts/validation/perception-consumer-cgroup.mjs')])
  const { scripts } = JSON.parse(rawPackage)
  const { runByCi, files: filesRunByCi } = suiteFilesRunByCi(steps, scripts, cgroupSource)

  const declared = new Set(KNOWN_UNRUN_SUITES.map((entry) => entry.file))

  const unaccounted = Object.entries(scripts)
    .filter(([name]) => /^test:(?:integration|e2e):/.test(name))
    .filter(([name]) => !runByCi.has(name))
    .flatMap(([name, command]) => {
      const files = [...command.matchAll(SUITE_FILE)].map((match) => match[0])
      if (files.length === 0) return [`${name} (names no test file at all)`]
      const dark = files.filter(
        (file) => !file.endsWith('.test.mjs') && !filesRunByCi.has(file) && !declared.has(file),
      )
      return dark.map((file) => `${name} -> ${file}`)
    })

  assert.deepEqual(
    unaccounted,
    [],
    `these npm scripts run in no CI step and name a suite nothing else runs; wire them into .github/workflows/ci.yml or declare the file in KNOWN_UNRUN_SUITES: ${unaccounted.join(', ')}`,
  )
})

test('T-F4.016 every unrun suite a document leans on says so where it is declared', async () => {
  const documents = await listMarkdown()
  assert.ok(documents.length > 0, 'read no Markdown under docs/; the walk and the tree have diverged')

  const wrong = []
  for (const entry of KNOWN_UNRUN_SUITES) {
    const basename = entry.file.split('/').pop()
    const found = documents.filter((document) => document.text.includes(basename)).map((document) => document.name).sort()
    const recorded = [...(entry.citedBy ?? [])].sort()
    if (found.join('|') === recorded.join('|')) continue
    wrong.push(`${entry.file}: cited by [${found.join(', ') || 'nothing'}], declared citedBy [${recorded.join(', ') || 'nothing'}]`)
  }

  assert.deepEqual(
    wrong,
    [],
    `a document naming a suite CI never runs is a claim resting on a proof that did not execute; record it in that entry's citedBy, or stop citing it:\n  ${wrong.join('\n  ')}`,
  )
})

test('W51 S3 and W58 catalog variants cannot silently become skipped CI proofs', async () => {
  const { steps } = parseWorkflow(await read('.github/workflows/ci.yml'))
  for (const [variant, gate, primary, suite] of [
    ['W51', 'APOLLO_W51_S3_ONLY', 'APOLLO_LIBRARY_JOURNEY_E2E', 'tests/v2/library-journey.e2e.mjs'],
    ['W58', 'APOLLO_W58_CATALOG_E2E', 'APOLLO_SYNTHETIC_WAVE24_JOURNEY_E2E', 'tests/v2/synthetic-wave24-journey.e2e.mjs'],
  ]) {
    const matches = steps.filter((step) => isLiteral(step.env.get(gate), '1'))
    assert.equal(matches.length, 1, `${variant} must have one mandatory variant run`)
    const step = matches[0]
    assert.equal(step.attrs.get('if'), undefined)
    assert.equal(step.job.attrs.get('if'), undefined)
    assert.ok(!isLiteral(step.attrs.get('continue-on-error'), 'true'))
    assert.ok(!isLiteral(step.job.attrs.get('continue-on-error'), 'true'))
    assert.ok(isLiteral(step.env.get(primary), '1'))
    assert.ok(step.suiteFiles.includes(suite) || step.npmScripts.some((script) => script === 'test:e2e:synthetic-wave24-journey'))
    if (variant === 'W51') assert.ok(isLiteral(step.env.get('APOLLO_V2_ARTIFACT_STORAGE_DRIVER'), 's3'))
    if (variant === 'W58') assert.ok(step.body.includes('${process.env.APOLLO_WAVE24_EVIDENCE_ROOT}/${process.env.APOLLO_WAVE24_RUN_ID}/w58-catalog.json'))
  }
})

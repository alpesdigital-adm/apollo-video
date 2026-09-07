import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

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
 */

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

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

/**
 * Steps in `ci.yml` are two spaces deeper than `steps:`, which sits at four,
 * so a step opens at six and everything belonging to it is indented at least
 * eight. A blank line belongs to whatever step precedes it; anything shallower
 * than eight closes the step, which is what makes a `# comment` written
 * between two steps at six spaces end the first rather than join it.
 */
const parseWorkflowSteps = (workflow) => {
  const steps = []
  let current = null

  for (const line of workflow.split('\n')) {
    if (/^ {6}- /.test(line)) {
      current = { lines: [line] }
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

  return steps.map(({ lines }) => {
    const body = lines.join('\n')
    const name = /^ {6}- name: (.+)$/.exec(lines[0])?.[1]?.trim() ?? null
    const npmScripts = [...body.matchAll(/npm run ([a-z0-9:._-]+)/g)].map((match) => match[1])

    const env = new Map()
    const envAt = lines.findIndex((line) => /^ {8}env:\s*$/.test(line))
    if (envAt >= 0) {
      for (const line of lines.slice(envAt + 1)) {
        if (line.trim() === '') continue
        const entry = /^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
        if (!entry) break
        env.set(entry[1], entry[2].trim())
      }
    }

    return { name, npmScripts, env }
  })
}

const singleTestFileOf = (command) => {
  const files = [...command.matchAll(/tests\/[A-Za-z0-9/._-]+\.(?:mjs|cjs|js)/g)].map((match) => match[0])
  return files.length === 1 ? files[0] : null
}

test('T-F4.016 every mandatory product journey has a CI step, its own gate and a database', async () => {
  const [rawPackage, workflow] = await Promise.all([read('package.json'), read('.github/workflows/ci.yml')])
  const { scripts } = JSON.parse(rawPackage)
  const steps = parseWorkflowSteps(workflow)

  assert.equal(
    MANDATORY_JOURNEYS.length,
    6,
    'the briefing mandates six product journeys; changing that number is a decision, not an edit',
  )

  const seenGates = new Map()
  const seenApplicationNames = new Map()

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
    assert.equal(
      running.length,
      1,
      `${where}: expected exactly one CI step running "npm run ${journey.script}", found ${running.length}`,
    )

    const [step] = running
    assert.ok(step.name, `${where}: its CI step must be named, so a failure names the journey`)

    // Not `env` inherited from the job: each journey declares its own, because
    // that is where the gate lives and because the URL carries the
    // `application_name` the orphan-backend check greps for afterwards.
    assert.equal(
      step.env.get(gate),
      '"1"',
      `${where}: step "${step.name}" must set ${gate}: "1", found ${step.env.get(gate) ?? 'nothing'}`,
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

    const gateTwin = seenGates.get(gate)
    assert.equal(
      gateTwin,
      undefined,
      `${where}: shares gate ${gate} with journey ${gateTwin}, so one of the two can never be run alone`,
    )
    seenGates.set(gate, journey.number)

    const nameTwin = seenApplicationNames.get(applicationName)
    assert.equal(
      nameTwin,
      undefined,
      `${where}: shares application_name ${applicationName} with journey ${nameTwin}`,
    )
    seenApplicationNames.set(applicationName, journey.number)
  }
})

/**
 * Scripts that no CI step runs, and that no other CI-wired script covers. This
 * list is a ratchet, not a permission: the assertion below fails both when a
 * script goes unwired without being written down here and when one on the list
 * finally gets a CI step and the entry is left behind. It exists because
 * `test:integration:multicam-visual-evidence` sat here unnoticed while spec 05
 * quoted the numbers it measures.
 *
 * Everything on it predates Wave 20 and belongs to Phases 1-3. Two entries are
 * different in kind and should stay off CI rather than be wired:
 * `test:e2e:provider-live` calls paid providers, which the owner's briefing
 * forbids in CI, and `test:integration:image-analysis` needs a Tesseract
 * install the workflow does not provision. The rest are simply unrun, and
 * closing them is a scoping decision for the owner, not a whitespace fix.
 */
const KNOWN_UNWIRED_SCRIPTS = [
  'test:integration:media-input',
  'test:integration:reframe',
  'test:integration:output-formats',
  'test:integration:responsive-placement',
  'test:integration:render-geometry',
  'test:integration:format-critic',
  'test:integration:format-quality-by-output',
  'test:integration:wave9',
  'test:integration:wave10',
  'test:integration:subtitle-sidecar',
  'test:integration:subtitle-sidecar-db',
  'test:integration:transformation-critic-media',
  'test:integration:media-library',
  'test:integration:media-segment',
  'test:integration:image-analysis',
  'test:integration:visual-montage',
  'test:integration:subtitle-styles',
  'test:integration:subtitle-style-tokens',
  'test:integration:subtitle-anchor',
  'test:integration:review',
  'test:integration:asset-selection',
  'test:integration:final-export',
  'test:integration:quality-iteration',
  'test:integration:project-duplication',
  'test:integration:mvp-core-gate',
  'test:integration:speech-segments',
  'test:integration:evidence-segments',
  'test:integration:long-form-moments',
  'test:integration:validated-segments',
  'test:integration:hierarchical-processing',
  'test:integration:long-form-stage-fencing',
  'test:integration:source-deconstruction',
  'test:integration:production-batches',
  'test:integration:script-alignments',
  'test:integration:take-libraries',
  'test:e2e:mvp-core-full',
  'test:e2e:provider-live',
]

test('T-F4.016 no new integration or e2e script goes unrun by CI', async () => {
  const [rawPackage, workflow] = await Promise.all([read('package.json'), read('.github/workflows/ci.yml')])
  const { scripts } = JSON.parse(rawPackage)

  const testFilesOf = (command) => [...command.matchAll(/tests\/[A-Za-z0-9/._-]+\.(?:mjs|cjs|js)/g)].map((m) => m[0])
  const runByCi = new Set([...workflow.matchAll(/npm run ([a-z0-9:._-]+)/g)].map((match) => match[1]))

  // A file counts as run if some CI step names it directly, or if a script CI
  // does run names it. `npm test` finds `*.test.mjs` on its own; it finds
  // neither `*.integration.mjs` nor `*.e2e.mjs`, which is the whole reason a
  // script can exist and never execute.
  const filesRunByCi = new Set([...workflow.matchAll(/tests\/[A-Za-z0-9/._-]+\.(?:mjs|cjs|js)/g)].map((m) => m[0]))
  for (const [name, command] of Object.entries(scripts)) {
    if (!runByCi.has(name)) continue
    for (const file of testFilesOf(command)) filesRunByCi.add(file)
  }

  const unwired = Object.entries(scripts)
    .filter(([name]) => /^test:(?:integration|e2e):/.test(name))
    .filter(([name]) => !runByCi.has(name))
    .filter(([, command]) => {
      const files = testFilesOf(command)
      return files.length === 0 || !files.every((file) => file.endsWith('.test.mjs') || filesRunByCi.has(file))
    })
    .map(([name]) => name)

  const known = new Set(KNOWN_UNWIRED_SCRIPTS)
  const undeclared = unwired.filter((name) => !known.has(name))
  assert.deepEqual(
    undeclared,
    [],
    `these npm scripts run in no CI step and no other suite covers their files; wire them into .github/workflows/ci.yml or add them to KNOWN_UNWIRED_SCRIPTS with a reason: ${undeclared.join(', ')}`,
  )

  const stale = KNOWN_UNWIRED_SCRIPTS.filter((name) => !unwired.includes(name))
  assert.deepEqual(
    stale,
    [],
    `these scripts are listed as unwired but CI now covers them (or they no longer exist); remove them from KNOWN_UNWIRED_SCRIPTS: ${stale.join(', ')}`,
  )
})

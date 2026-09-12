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

    return { job: owner, name, npmScripts, suiteFiles, env, attrs }
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

const singleTestFileOf = (command) => {
  const files = [...command.matchAll(SUITE_FILE)].map((match) => match[0])
  return files.length === 1 ? files[0] : null
}

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
const NEEDS_TESSERACT = 'needs a Tesseract install the workflow does not provision'
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
  { file: 'tests/v2/contamination-golden-fixtures.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-evaluation-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-evidence-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/contiguous-extraction-repository.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-contiguous-audio-evidence-provider.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-contiguous-visual-evidence-provider.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/ffmpeg-speaker-diarization-audio-preparer.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/format-quality-critic.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/image-analysis-tesseract.integration.mjs',
    reason: `${NEEDS_TESSERACT}; PRD FR-145 and the F4.015 traceability row cite it as why the OCR engine is present but unrun in CI`,
    citedBy: ['docs/PRD-APOLLO-V2.md', 'docs/REQUIREMENTS-TRACEABILITY.md'],
  },
  { file: 'tests/v2/long-form-stage-fencing.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/media-input-runtime.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/media-segment-materialization.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/mvp-core-full-journey.e2e.mjs',
    reason: `${PHASE_1_3}; docs/quality/mvp-core-gate-v1.md calls it "a prova principal" of the MVP core gate`,
    citedBy: ['docs/quality/mvp-core-gate-v1.md'],
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
  { file: 'tests/v2/prisma-media-library.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-montage-alternative.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/prisma-mvp-core-gate.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-production-batch.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/prisma-project-duplication.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-proxy-review.integration.mjs',
    reason: NO_SCRIPT,
    citedBy: ['docs/specs/08-localization-and-audio.md'],
  },
  { file: 'tests/v2/prisma-quality-iteration.integration.mjs', reason: PHASE_1_3 },
  {
    file: 'tests/v2/prisma-review-annotation.integration.mjs',
    reason: `${PHASE_1_3}; TODO.md cites it as the evidence closing F1-039 and F1-040`,
    citedBy: ['TODO.md'],
  },
  {
    file: 'tests/v2/prisma-review-patch-batch.integration.mjs',
    reason: `${NO_SCRIPT}; TODO.md cites it as the evidence closing F1-044/T-FR-215`,
    citedBy: ['TODO.md'],
  },
  {
    file: 'tests/v2/prisma-review-patch.integration.mjs',
    reason: `${NO_SCRIPT}; TODO.md cites it as the evidence closing F1-043/T-FR-214`,
    citedBy: ['TODO.md'],
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
  { file: 'tests/v2/provider-live-contract.e2e.mjs', reason: PAID_PROVIDERS },
  { file: 'tests/v2/reframe-plan-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/render-geometry-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/responsive-placement-visual.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/source-deconstruction-golden-reel.integration.mjs', reason: NO_SCRIPT },
  { file: 'tests/v2/subtitle-anchor-render.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/subtitle-sidecar-pipeline.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/subtitle-style-token-goldens.integration.mjs', reason: PHASE_1_3 },
  { file: 'tests/v2/subtitle-style-visual-goldens.integration.mjs', reason: PHASE_1_3 },
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
const suiteFilesRunByCi = (steps, scripts) => {
  const gating = steps.filter(gatesTheBuild)
  const runByCi = new Set(gating.flatMap((step) => step.npmScripts))
  const files = new Set(gating.flatMap((step) => step.suiteFiles))
  for (const [name, command] of Object.entries(scripts)) {
    if (!runByCi.has(name)) continue
    for (const match of command.matchAll(SUITE_FILE)) files.add(match[0])
  }
  return { runByCi, files }
}

test('T-F4.016 no integration or e2e suite file goes unrun by CI without being declared', async () => {
  const [rawPackage, workflow, present] = await Promise.all([
    read('package.json'),
    read('.github/workflows/ci.yml'),
    listSuiteFiles(),
  ])
  const { scripts } = JSON.parse(rawPackage)
  const { steps } = parseWorkflow(workflow)
  const { files: filesRunByCi } = suiteFilesRunByCi(steps, scripts)

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
  const [rawPackage, workflow] = await Promise.all([read('package.json'), read('.github/workflows/ci.yml')])
  const { scripts } = JSON.parse(rawPackage)
  const { steps } = parseWorkflow(workflow)
  const { runByCi, files: filesRunByCi } = suiteFilesRunByCi(steps, scripts)

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

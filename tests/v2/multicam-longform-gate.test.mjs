import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertLegacyRuntimeAudit,
  assertMulticamLongformGateReportIntegrity,
  buildLegacyRuntimeCriterion,
  calculateLegacyRuntimeAuditHash,
  describeMulticamLongformCriteria,
  evaluateMulticamLongformGate,
  explainMulticamLongformGate,
  LEGACY_RUNTIME_MARKERS,
  MULTICAM_LONGFORM_CRITERIA,
  MULTICAM_LONGFORM_CRITERION_CHECKS,
  MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES,
  MULTICAM_LONGFORM_FAILURE_REASONS,
} from '../../src/v2/domain/multicam-longform-gate.ts'
import {
  GATE_RUNTIME_ENTRY_MODULES,
  ModuleGraphLegacyRuntimeAudit,
} from '../../src/v2/infrastructure/audit/module-graph-legacy-runtime-audit.ts'

/**
 * F4.016 — the multicamera/long-form phase gate, criterion by criterion.
 *
 * ADR-135 requires every condition to be independently visible, so the shape
 * of this suite mirrors that: for each of the ten criteria it proves three
 * different things separately — that the criterion can be satisfied, that
 * removing only its evidence fails only it (and the gate), and that evidence
 * whose hash did not recompute cannot be made to back an approval.
 *
 * What this suite does NOT prove: that the readers actually read those rows,
 * or that a real PostgreSQL refuses the tampered row. Those are
 * `multicam-longform-gate.e2e.mjs` (measured against a throwaway PostgreSQL
 * 16 cluster), and no fixture here should be read as evidence of them.
 */

const AT = '2029-06-01T10:00:00.000Z'
const HASH = (seed) => seed.repeat(64).slice(0, 64)

/** One reference per criterion, hashed and verified. */
const REFERENCE = {
  'podcast-multicam-synchronised': { type: 'sync-diagnostic', id: 'session-podcast:3', hash: HASH('a'), verified: true },
  'teacher-and-screen-synchronised': { type: 'sync-diagnostic', id: 'session-teacher:2', hash: HASH('b'), verified: true },
  'insufficient-evidence-requires-manual': { type: 'capture-protocol-evaluation', id: 'session-hidden:react-v1:1', hash: HASH('c'), verified: true },
  'react-edited-with-piecewise-map': { type: 'playback-map', id: 'session-react:p1', hash: HASH('d'), verified: true },
  'active-speaker-and-demonstration-directed': { type: 'multicam-direction', id: 'session-podcast:2', hash: HASH('e'), verified: true },
  'contextual-multi-range-synthesis': { type: 'editorial-synthesis', id: 'synthesis-1', hash: HASH('f'), verified: true },
  'colour-match-precedes-creative-lut': { type: 'match-plan', id: 'session-podcast:mp1', hash: HASH('0'), verified: true },
  'colour-critic-resolved': { type: 'colour-critic-report', id: 'critic-1', hash: HASH('1'), verified: true },
  'final-mp4-inspectable': { type: 'media-manifest', id: 'manifest-final', hash: HASH('2'), verified: true },
  'no-legacy-runtime-dependency': { type: 'module-graph-audit', id: `legacy-runtime-audit:${AT}`, hash: HASH('3'), verified: true },
}

function passingCriterion(criterion) {
  return {
    criterion,
    checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) => ({
      code,
      passed: true,
      failureReason: null,
      detail: `${code} observed on ${REFERENCE[criterion].id}`,
      references: [{ ...REFERENCE[criterion] }],
    })),
  }
}

function passingEvidence() {
  return MULTICAM_LONGFORM_CRITERIA.map(passingCriterion)
}

function evaluate(evidence, overrides = {}) {
  return evaluateMulticamLongformGate({
    workspaceId: 'w20-gate-workspace',
    projectId: 'w20-gate-project',
    sessionId: null,
    evidence,
    evaluatedAt: AT,
    ...overrides,
  })
}

test('T-F4.016 the ten criteria and their checks are the ones ADR-135 asks for', () => {
  assert.equal(MULTICAM_LONGFORM_CRITERIA.length, 10)
  const catalogue = describeMulticamLongformCriteria()
  assert.equal(catalogue.length, 10)
  for (const entry of catalogue) {
    assert.deepEqual(
      entry.checks,
      [...MULTICAM_LONGFORM_CRITERION_CHECKS[entry.criterion]],
      `${entry.criterion} catalogue disagrees with the constant`,
    )
    assert.ok(
      entry.statement.length >= 40,
      `${entry.criterion} has no statement a reader could act on`,
    )
  }
  // Each of the six ADR-135 conditions has a criterion of its own, and no
  // criterion stands for two of them.
  for (const criterion of [
    'podcast-multicam-synchronised',
    'teacher-and-screen-synchronised',
    'insufficient-evidence-requires-manual',
    'react-edited-with-piecewise-map',
    'active-speaker-and-demonstration-directed',
    'contextual-multi-range-synthesis',
  ]) {
    assert.ok(MULTICAM_LONGFORM_CRITERIA.includes(criterion), `${criterion} is missing`)
  }
})

test('T-F4.016 a complete server evidence set approves the gate and hashes stably', () => {
  const first = evaluate(passingEvidence())
  assert.equal(first.approved, true)
  assert.equal(first.satisfied, 10)
  assert.equal(first.evaluated, 10)
  assert.equal(first.total, 10)
  assert.deepEqual([...first.failed], [])
  assert.deepEqual([...first.blocking], [])
  assert.equal(first.serverEvidenceOnly, true)

  // A replica built from the same rows is byte-identical: the record is
  // content-addressed, so two evaluations of one unchanged project cannot
  // disagree about what was true.
  const second = evaluate(passingEvidence())
  assert.equal(second.fingerprint, first.fingerprint)
  assert.equal(JSON.stringify(second), JSON.stringify(first))

  // Order of the criteria in the input must not change the answer.
  const shuffled = evaluate([...passingEvidence()].reverse())
  assert.equal(shuffled.fingerprint, first.fingerprint)
})

test('T-F4.016 every criterion fails on its own when its evidence is missing', () => {
  for (const criterion of MULTICAM_LONGFORM_CRITERIA) {
    const report = evaluate(
      passingEvidence().filter((item) => item.criterion !== criterion),
    )
    const failed = report.criteria.find((item) => item.criterion === criterion)
    const others = report.criteria.filter((item) => item.criterion !== criterion)

    assert.equal(report.approved, false, `${criterion}: gate approved without it`)
    assert.equal(report.satisfied, 9, `${criterion}: wrong satisfied count`)
    assert.equal(report.evaluated, 9, `${criterion}: wrong evaluated count`)
    assert.deepEqual([...report.failed], [criterion])
    assert.equal(failed.passed, false)
    assert.equal(
      failed.missingCheckCount,
      MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].length,
      `${criterion}: not every check was reported missing`,
    )
    for (const check of failed.checks) {
      assert.equal(check.failureReason, 'evidence-missing')
      assert.deepEqual([...check.references], [])
      assert.ok(check.detail.includes(check.code))
    }
    // The other nine still say what they found. A gate that reports one
    // aggregate boolean cannot tell an operator that nine conditions hold.
    assert.ok(others.every((item) => item.passed), `${criterion}: took others down with it`)
  }
})

test('T-F4.016 a criterion whose evidence did not verify fails as unverified, alone', () => {
  for (const criterion of MULTICAM_LONGFORM_CRITERIA) {
    const evidence = passingEvidence().map((item) =>
      item.criterion !== criterion
        ? item
        : {
            criterion,
            checks: item.checks.map((check, index) =>
              index !== 0
                ? check
                : {
                    ...check,
                    passed: false,
                    failureReason: 'evidence-unverified',
                    detail: `stored row ${REFERENCE[criterion].id} did not re-derive to its hash`,
                    references: [{ ...REFERENCE[criterion], verified: false }],
                  }),
          })
    const report = evaluate(evidence)
    const item = report.criteria.find((entry) => entry.criterion === criterion)

    assert.equal(report.approved, false, `${criterion}: tampering approved the gate`)
    assert.equal(report.satisfied, 9)
    assert.equal(item.passed, false)
    assert.equal(item.failedCheckCount, 1)
    assert.equal(item.missingCheckCount, 0, 'unverified is not the same answer as missing')
    assert.equal(item.unverifiedReferenceCount, 1)
    assert.equal(report.blocking[0].reason, 'evidence-unverified')
    assert.equal(report.blocking[0].criterion, criterion)
  }
})

test('T-F4.016 a check cannot claim to pass on evidence whose hash did not verify', () => {
  const evidence = passingEvidence()
  evidence[0].checks[0].references = [
    { ...REFERENCE[evidence[0].criterion], verified: false },
  ]
  assert.throws(
    () => evaluate(evidence),
    (error) => /did not verify/.test(String(error?.message)),
    'a pass built on unverified evidence was accepted',
  )
})

test('T-F4.016 a reference with no stored hash is not the same thing as one that failed to verify', () => {
  // The three states, counted apart. Conflating the last two is what made four
  // of the ten criteria impossible to store: the migration refuses a passing
  // row whose `unverifiedReferenceCount` is not zero, so a criterion citing a
  // media artifact nobody downloaded aborted the whole persist() transaction.
  const evidence = passingEvidence()
  const criterion = evidence[8].criterion
  assert.equal(criterion, 'final-mp4-inspectable')
  evidence[8].checks[0].references = [
    { ...REFERENCE[criterion] },
    { type: 'media-artifact', id: 'artifact-final', hash: null, verified: false },
  ]
  const report = evaluate(evidence)
  const item = report.criteria.find((entry) => entry.criterion === criterion)

  assert.equal(report.approved, true, 'a pass citing a hash-less row was refused')
  assert.equal(item.passed, true)
  assert.equal(
    item.unverifiedReferenceCount,
    0,
    'a row that stores no hash was counted as a hash that did not verify',
  )
  assert.equal(item.unhashedReferenceCount, 1)

  // The other half of the distinction: a hash that WAS recomputed and
  // disagreed still forbids the pass.
  const tampered = passingEvidence()
  tampered[8].checks[0].references = [
    { ...REFERENCE[tampered[8].criterion], verified: false },
  ]
  assert.throws(
    () => evaluate(tampered),
    (error) => /did not verify/.test(String(error?.message)),
  )
})

test('T-F4.016 a reference may not claim verification without a hash, or be cited twice', () => {
  // Both invariants are load-bearing for the counts and are encoded again as
  // CHECK constraints, so a domain that accepted either would turn a modelling
  // bug into a write-time persistence failure.
  const claiming = passingEvidence()
  claiming[0].checks[0].references = [
    { type: 'capture-session', id: 'session-podcast', hash: null, verified: true },
  ]
  assert.throws(
    () => evaluate(claiming),
    (error) =>
      error?.code === 'INVALID_ARGUMENT' &&
      /claims verification without a stored hash/.test(String(error?.message)),
    'a reference with nothing to recompute claimed it had recomputed',
  )

  const duplicated = passingEvidence()
  duplicated[0].checks[0].references = [
    { ...REFERENCE[duplicated[0].criterion] },
    { ...REFERENCE[duplicated[0].criterion] },
  ]
  assert.throws(
    () => evaluate(duplicated),
    (error) =>
      error?.code === 'INVALID_ARGUMENT' &&
      /lists the same reference twice/.test(String(error?.message)),
    'one row counted as two pieces of evidence',
  )
})

test('T-F4.016 a check that read nothing must say the evidence was missing', () => {
  const evidence = passingEvidence()
  evidence[2].checks[0] = {
    ...evidence[2].checks[0],
    passed: false,
    failureReason: 'requirement-unmet',
    detail: 'concluded without reading anything',
    references: [],
  }
  assert.throws(
    () => evaluate(evidence),
    (error) => /without reading any evidence/.test(String(error?.message)),
  )
})

test('T-F4.016 a failing check must name a reason and a passing one must not', () => {
  // A pass carrying a refusal reason is refused rather than tidied up: the
  // reader that produced it disagreed with itself, and silently dropping one
  // half of the contradiction would decide which half was the truth.
  const withReason = passingEvidence()
  withReason[1].checks[0] = { ...withReason[1].checks[0], failureReason: 'requirement-unmet' }
  assert.throws(
    () => evaluate(withReason),
    (error) => /supported failure reason/.test(String(error?.message)),
    'a passing check kept a failure reason',
  )

  const withoutReason = passingEvidence()
  withoutReason[1].checks[0] = {
    ...withoutReason[1].checks[0],
    passed: false,
    failureReason: null,
  }
  assert.throws(
    () => evaluate(withoutReason),
    (error) => /supported failure reason/.test(String(error?.message)),
  )

  for (const reason of MULTICAM_LONGFORM_FAILURE_REASONS) {
    const evidence = passingEvidence()
    evidence[3].checks[0] = {
      ...evidence[3].checks[0],
      passed: false,
      failureReason: reason,
      detail: `refused with ${reason}`,
    }
    const report = evaluate(evidence)
    assert.equal(report.criteria[3].checks[0].failureReason, reason)
  }
})

test('T-F4.016 an unknown criterion, check or resource type is refused', () => {
  assert.throws(
    () => evaluate([{ criterion: 'invented-criterion', checks: [] }]),
    (error) => /unsupported/.test(String(error?.message)),
  )
  const strayCheck = passingEvidence()
  strayCheck[0].checks[0] = { ...strayCheck[0].checks[0], code: 'verdict-resolved' }
  assert.throws(
    () => evaluate(strayCheck),
    (error) => /does not belong to/.test(String(error?.message)),
    'a check from another criterion was accepted',
  )
  const strayType = passingEvidence()
  strayType[0].checks[0].references = [
    { type: 'legacy-table', id: 'x-1234', hash: HASH('9'), verified: true },
  ]
  assert.throws(
    () => evaluate(strayType),
    (error) => /reference type/.test(String(error?.message)),
  )
  assert.equal(MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES.includes('workspace'), true)
})

test('T-F4.016 a stored report that was edited fails integrity re-derivation', () => {
  const report = evaluate(
    passingEvidence().filter(
      (item) => item.criterion !== 'final-mp4-inspectable',
    ),
  )
  assert.equal(report.approved, false)
  const roundTripped = assertMulticamLongformGateReportIntegrity(
    JSON.parse(JSON.stringify(report)),
  )
  assert.equal(roundTripped.fingerprint, report.fingerprint)

  const forged = JSON.parse(JSON.stringify(report))
  forged.approved = true
  forged.satisfied = 10
  assert.throws(
    () => assertMulticamLongformGateReportIntegrity(forged),
    (error) => /integrity/.test(String(error?.message)),
    'an approval that nobody evaluated survived re-derivation',
  )

  // Flipping a check that did read evidence is caught by the fingerprint: the
  // criterion, the counts and the blocking list all move with it.
  const flipped = JSON.parse(JSON.stringify(report))
  const passing = flipped.criteria.findIndex((item) => item.passed)
  flipped.criteria[passing].checks[0].passed = false
  flipped.criteria[passing].checks[0].failureReason = 'requirement-unmet'
  assert.throws(
    () => assertMulticamLongformGateReportIntegrity(flipped),
    (error) => /integrity/.test(String(error?.message)),
  )

  // Flipping a check that read nothing is caught earlier, by the rule that a
  // conclusion has to have looked at something. Different message, same
  // refusal — and the code is what a caller branches on.
  const forgedCheck = JSON.parse(JSON.stringify(report))
  const absent = forgedCheck.criteria.findIndex(
    (item) => item.missingCheckCount === item.checkCount,
  )
  assert.equal(forgedCheck.criteria[absent].criterion, 'final-mp4-inspectable')
  forgedCheck.criteria[absent].checks[0].passed = true
  forgedCheck.criteria[absent].checks[0].failureReason = null
  assert.throws(
    () => assertMulticamLongformGateReportIntegrity(forgedCheck),
    (error) =>
      error?.code === 'INVALID_ARGUMENT' &&
      /without reading any evidence/.test(String(error?.message)),
  )
})

test('T-F4.016 the explanation puts never-evaluated criteria before refused ones', () => {
  const evidence = passingEvidence().filter(
    (item) => item.criterion !== 'colour-critic-resolved',
  )
  const refused = evidence.find(
    (item) => item.criterion === 'final-mp4-inspectable',
  )
  refused.checks[1] = {
    ...refused.checks[1],
    passed: false,
    failureReason: 'requirement-unmet',
    detail: 'container was webm, not mp4',
  }
  const explanation = explainMulticamLongformGate(evaluate(evidence))

  assert.equal(explanation.approved, false)
  assert.equal(explanation.satisfied, 8)
  assert.equal(explanation.outstanding.length, 2)
  assert.equal(explanation.outstanding[0].criterion, 'colour-critic-resolved')
  assert.equal(explanation.outstanding[0].neverEvaluated, true)
  assert.equal(explanation.outstanding[1].criterion, 'final-mp4-inspectable')
  assert.equal(explanation.outstanding[1].neverEvaluated, false)
  assert.equal(explanation.outstanding[1].blocking[0].check, 'output-codec-recorded')
  assert.match(explanation.outstanding[1].blocking[0].detail, /webm/)
  assert.ok(explanation.outstanding[0].statement.length >= 40)
})

test('T-F4.016 the legacy-runtime criterion reports the scan, not a promise', () => {
  const clean = {
    schemaVersion: 'legacy-runtime-audit/v1',
    entryModules: ['src/v2/application/multicam-longform-gate.ts'],
    unreadableEntryModules: [],
    scannedModuleCount: 42,
    violations: [],
    scannedAt: AT,
  }
  clean.auditHash = calculateLegacyRuntimeAuditHash(clean)
  assertLegacyRuntimeAudit(clean)
  const passing = buildLegacyRuntimeCriterion(clean)
  assert.equal(passing.checks.length, 3)
  assert.ok(passing.checks.every((check) => check.passed))
  assert.match(passing.checks[0].detail, /scanned 42 modules/)

  const dirty = {
    ...clean,
    violations: [
      { marker: 'legacy-runtime-import', module: 'src/v2/application/x.ts', specifier: '@/lib/old' },
      { marker: 'sqlite-persistence', module: 'src/v2/infrastructure/y.ts', specifier: 'better-sqlite3' },
    ],
  }
  dirty.auditHash = calculateLegacyRuntimeAuditHash(dirty)
  const failing = buildLegacyRuntimeCriterion(dirty)
  const byCode = Object.fromEntries(failing.checks.map((check) => [check.code, check]))
  assert.equal(byCode['module-graph-scanned'].passed, true)
  assert.equal(byCode['no-legacy-runtime-import'].passed, false)
  assert.equal(byCode['no-legacy-runtime-import'].failureReason, 'requirement-unmet')
  assert.match(byCode['no-legacy-runtime-import'].detail, /@\/lib\/old/)
  assert.equal(byCode['no-compatibility-persistence'].passed, false)
  assert.match(byCode['no-compatibility-persistence'].detail, /better-sqlite3/)

  // A scan whose hash does not recompute is not a scan. It fails the whole
  // criterion as unverified rather than being trusted or throwing.
  const forged = { ...clean, scannedModuleCount: 9999 }
  const unverified = buildLegacyRuntimeCriterion(forged)
  assert.ok(unverified.checks.every((check) => check.failureReason === 'evidence-unverified'))
  assert.ok(unverified.checks.every((check) => check.references[0].verified === false))

  // An entry module the scanner could not open is missing evidence for the
  // whole criterion, never an import it "found". Reported as a violation — as
  // it was — a root without the sources published ten `legacy-runtime-import`
  // accusations against modules nobody read, and `no-legacy-runtime-import`
  // would otherwise pass on zero violations counted over zero files.
  const unread = {
    ...clean,
    unreadableEntryModules: ['src/v2/application/multicam-longform-gate.ts'],
  }
  unread.auditHash = calculateLegacyRuntimeAuditHash(unread)
  assertLegacyRuntimeAudit(unread)
  const unreadable = buildLegacyRuntimeCriterion(unread)
  assert.equal(unreadable.checks.length, 3)
  assert.ok(unreadable.checks.every((check) => check.passed === false))
  assert.ok(unreadable.checks.every((check) => check.failureReason === 'evidence-missing'))
  assert.match(unreadable.checks[0].detail, /unreadable/)

  // The list is part of the hashed body, so an audit that quietly drops it
  // does not verify.
  const stripped = { ...unread, unreadableEntryModules: [] }
  assert.throws(
    () => assertLegacyRuntimeAudit(stripped),
    (error) => error.code === 'INVALID_ARGUMENT',
  )

  // No audit at all leaves the criterion with nothing recorded, which the
  // evaluation turns into `evidence-missing` for all three checks.
  assert.deepEqual(buildLegacyRuntimeCriterion(null).checks, [])
  assert.equal(LEGACY_RUNTIME_MARKERS.length, 5)
})

test('T-F4.016 the scanner resolves its root when it runs, never when it is compiled', async () => {
  // The defect: the root came from `import.meta.url`, which webpack replaces
  // with the BUILD machine's absolute source path, so the bundled server
  // carried a frozen root and every entry module was unreadable the moment the
  // app ran from anywhere else. This process cannot open a webpack bundle, so
  // the assertion is behavioural and catches the cause rather than the
  // spelling: a root derived from the module survives `chdir` and would keep
  // reading the real tree here, while one derived at run time does not.
  const elsewhere = await mkdtemp(join(tmpdir(), 'apollo-gate-root-'))
  const original = process.cwd()
  try {
    process.chdir(elsewhere)
    const relocated = await new ModuleGraphLegacyRuntimeAudit({
      clock: () => new Date(AT),
    }).audit()
    assert.equal(relocated.scannedModuleCount, 0, 'a root without sources scanned something')
    assert.deepEqual(
      [...relocated.unreadableEntryModules],
      [...GATE_RUNTIME_ENTRY_MODULES].sort(),
    )
    assert.deepEqual(
      relocated.violations,
      [],
      'modules nobody could read were published as legacy runtime imports',
    )
    const criterion = buildLegacyRuntimeCriterion(relocated)
    assert.ok(
      criterion.checks.every((check) => check.failureReason === 'evidence-missing'),
      'a scan that read nothing answered the criterion anyway',
    )
  } finally {
    process.chdir(original)
    await rm(elsewhere, { recursive: true, force: true })
  }

  // And with the real root back, the same scanner reads the real tree: the
  // assertion above must fail for the right reason, not because the walk is
  // broken everywhere.
  const here = await new ModuleGraphLegacyRuntimeAudit({
    repositoryRoot: process.cwd(),
    clock: () => new Date(AT),
  }).audit()
  assert.deepEqual([...here.unreadableEntryModules], [])
  assert.ok(here.scannedModuleCount > GATE_RUNTIME_ENTRY_MODULES.length)
})

test('T-F4.016 the real module graph behind the gate carries no legacy runtime', async () => {
  const audit = await new ModuleGraphLegacyRuntimeAudit({
    clock: () => new Date(AT),
  }).audit()
  assertLegacyRuntimeAudit(audit)
  console.log(
    `[T-F4.016] module graph: ${audit.scannedModuleCount} modules from ` +
    `${audit.entryModules.length} entries, ${audit.violations.length} violations`,
  )
  assert.equal(
    audit.violations.length,
    0,
    `legacy runtime reachable from the gate: ${JSON.stringify(audit.violations)}`,
  )
  assert.ok(
    audit.scannedModuleCount > GATE_RUNTIME_ENTRY_MODULES.length,
    'the walk never followed an import',
  )
  const criterion = buildLegacyRuntimeCriterion(audit)
  assert.ok(criterion.checks.every((check) => check.passed))

  // A second scan of unchanged sources produces the same hash: the audit is
  // evidence a later reader can re-derive, not a timestamped opinion.
  const again = await new ModuleGraphLegacyRuntimeAudit({
    clock: () => new Date(AT),
  }).audit()
  assert.equal(again.auditHash, audit.auditHash)
})

test('T-F4.016 the migration encodes the same criteria, checks and reasons as the domain', () => {
  const sql = readFileSync(
    new URL(
      '../../prisma/v2/migrations/20260905170000_multicam_longform_gate/migration.sql',
      import.meta.url,
    ),
    'utf8',
  )
  const listAfter = (constraint) => {
    const start = sql.indexOf(constraint)
    assert.notEqual(start, -1, `${constraint} is not in the migration`)
    const open = sql.indexOf('IN (', start)
    const close = sql.indexOf(')', open)
    return sql
      .slice(open + 4, close)
      .split(',')
      .map((value) => value.trim().replace(/^'|'$/g, ''))
      .filter((value) => value.length > 0)
      .sort()
  }

  assert.deepEqual(
    listAfter('multicam_longform_gate_criteria_criterion_check'),
    [...MULTICAM_LONGFORM_CRITERIA].sort(),
    'the criterion CHECK and the domain constant disagree',
  )
  const checkCodes = [
    ...new Set(
      MULTICAM_LONGFORM_CRITERIA.flatMap(
        (criterion) => [...MULTICAM_LONGFORM_CRITERION_CHECKS[criterion]],
      ),
    ),
  ].sort()
  assert.deepEqual(
    listAfter('multicam_longform_gate_checks_code_check'),
    checkCodes,
    'the check-code CHECK and the domain constant disagree',
  )
  assert.deepEqual(
    listAfter('multicam_longform_gate_evidence_resource_check'),
    [...MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES].sort(),
    'the resource-type CHECK and the domain constant disagree',
  )
  // The failure reasons appear inside the reason CHECK rather than a leading
  // IN (...), so they are matched literally.
  for (const reason of MULTICAM_LONGFORM_FAILURE_REASONS) {
    assert.ok(
      sql.includes(`'${reason}'`),
      `the migration does not know the failure reason ${reason}`,
    )
  }
  assert.ok(
    sql.includes(`"total" = ${MULTICAM_LONGFORM_CRITERIA.length}`),
    'the migration does not pin the criterion count',
  )
  // The column that keeps "no hash to recompute" out of the tamper count. Both
  // tables carry it, and the checks table pins the two as disjoint.
  assert.equal(
    (sql.match(/"unhashedReferenceCount" INTEGER NOT NULL DEFAULT 0/g) ?? []).length,
    2,
    'the criteria and check tables do not both count hash-less references',
  )
  assert.ok(
    sql.includes(
      'AND ("unverifiedReferenceCount" + "unhashedReferenceCount") <= "referenceCount"',
    ),
    'the migration lets the two reference counts overlap',
  )
  assert.ok(
    sql.includes(
      'AND ("passed" = FALSE OR ("referenceCount" > 0 AND "unverifiedReferenceCount" = 0))',
    ),
    'the migration stopped refusing a pass built on a hash that did not verify',
  )
})

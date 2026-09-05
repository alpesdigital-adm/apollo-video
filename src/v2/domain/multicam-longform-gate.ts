import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

/**
 * F4.016 — the phase gate for multicamera and long-form capture (ADR-135).
 *
 * ADR-135 names six conditions and one sentence that outranks them: "every
 * condition is independently visible before the phase is approved". That
 * sentence is the whole design. A gate that collapses to one boolean cannot
 * say which of the six failed, and the 18/07/2026 incident is exactly what a
 * single aggregated boolean produces — 1.247 of 1.255 boxes ticked and no
 * integrated product behind them.
 *
 * So this module models a criterion as a list of named checks, and a check as
 * a result plus the evidence references it read plus the exact reason it said
 * no. Ten criteria, not six: the four extra ones (colour match before the LUT,
 * the colour critic's verdict, an inspectable MP4, and the absence of legacy
 * runtime) are the Wave 20 features the six conditions silently assume, and an
 * assumption nobody checks is how the last "100%" happened.
 *
 * Three rules the shape enforces rather than documents:
 *
 * - **Evidence is never supplied by the caller.** Every reference here is
 *   produced by a reader that went to PostgreSQL itself. The request carries a
 *   project id and at most a session id. There is no field on this input that
 *   a client could use to assert a result.
 * - **Missing evidence fails only its own criterion — and the gate.** A gate
 *   whose criterion 3 has no rows is not "9 of 10 approved". It is not
 *   approved, and criteria 1, 2 and 4-10 still report their own answers so the
 *   operator can see what is actually left.
 * - **Evidence whose hash does not recompute is a failure, not an exception.**
 *   A row edited underneath the product is the case the gate exists for. It
 *   reproves the criterion with `evidence-unverified` and the gate says which
 *   reference disagreed, instead of throwing and leaving no record.
 */

export const MULTICAM_LONGFORM_GATE_SCHEMA_VERSION =
  'multicam-longform-gate/v1' as const
export const MULTICAM_LONGFORM_GATE_REPORT_SCHEMA_VERSION =
  'multicam-longform-gate-report/v1' as const
export const MULTICAM_LONGFORM_GATE_ID = 'multicam-longform/v1' as const

/**
 * The ten criteria and the checks each one is made of.
 *
 * Criterion ids are sentences rather than serial numbers on purpose: the
 * operator reading "insufficient-evidence-requires-manual: failed" learns what
 * failed; "AC-003: failed" sends them to a table.
 */
export const MULTICAM_LONGFORM_CRITERION_CHECKS = Object.freeze({
  'podcast-multicam-synchronised': Object.freeze([
    'podcast-protocol-evaluated',
    'diagnostic-synchronised',
    'participant-tracks-distinct',
    'coverage-derived',
    'clock-map-persisted',
  ]),
  'teacher-and-screen-synchronised': Object.freeze([
    'teacher-protocol-evaluated',
    'diagnostic-synchronised',
    'track-durations-unequal',
    'coverage-derived',
  ]),
  'insufficient-evidence-requires-manual': Object.freeze([
    'sync-evidence-insufficient',
    'diagnostic-requires-manual',
    'protocol-ceiling-blocks-auto-edit',
  ]),
  'react-edited-with-piecewise-map': Object.freeze([
    'playback-map-persisted',
    'interrupted-piece-present',
    'reaction-duration-differs',
    'map-compiled-into-plan',
  ]),
  'active-speaker-and-demonstration-directed': Object.freeze([
    'direction-persisted',
    'active-speaker-rule-fired',
    'demonstration-rule-fired',
    'decisions-carry-justification',
  ]),
  'contextual-multi-range-synthesis': Object.freeze([
    'synthesis-persisted',
    'target-duration-is-120s',
    'duration-within-tolerance',
    'multiple-ranges-preserved',
    'context-proof-recorded',
  ]),
  'colour-match-precedes-creative-lut': Object.freeze([
    'match-plan-persisted',
    'transforms-are-match-stage',
    'match-precedes-creative-lut',
  ]),
  'colour-critic-resolved': Object.freeze([
    'critic-report-persisted',
    'verdict-resolved',
    'no-open-hard-issue',
  ]),
  'final-mp4-inspectable': Object.freeze([
    'final-export-promoted',
    'output-codec-recorded',
    'output-probe-measured',
    'artifact-hash-matches-attempt',
  ]),
  'no-legacy-runtime-dependency': Object.freeze([
    'module-graph-scanned',
    'no-legacy-runtime-import',
    'no-compatibility-persistence',
  ]),
} as const)

export type MulticamLongformCriterion =
  keyof typeof MULTICAM_LONGFORM_CRITERION_CHECKS
export type MulticamLongformCheckCode =
  (typeof MULTICAM_LONGFORM_CRITERION_CHECKS)[MulticamLongformCriterion][number]

export const MULTICAM_LONGFORM_CRITERIA = Object.freeze(
  Object.keys(MULTICAM_LONGFORM_CRITERION_CHECKS) as MulticamLongformCriterion[],
)

/**
 * The condition each criterion stands for, in the words ADR-135 uses. Kept
 * next to the checks so a catalogue endpoint has one source and the report
 * does not have to carry prose in every row it hashes.
 */
export const MULTICAM_LONGFORM_CRITERION_STATEMENTS = Object.freeze({
  'podcast-multicam-synchronised':
    'A podcast session with two participants and distinct audio is synchronised, its coverage derived and its clock map persisted.',
  'teacher-and-screen-synchronised':
    'A teacher-and-screen session whose tracks have different durations is synchronised without stretching either one.',
  'insufficient-evidence-requires-manual':
    'A session the evidence cannot resolve says so, refuses to invent a map, and demands a marker or a manual anchor before any automatic edit.',
  'react-edited-with-piecewise-map':
    'A react session is edited through a piecewise playback map that survives a pause, a rewind or a seek, with a reaction duration that is not the reference duration.',
  'active-speaker-and-demonstration-directed':
    'A multicamera direction cut both by active speaker and by demonstration, with the rule and the justification recorded per shot.',
  'contextual-multi-range-synthesis':
    'A multi-range synthesis of about 120 seconds that keeps its context proof and lands inside its declared tolerance.',
  'colour-match-precedes-creative-lut':
    'The camera match is a match-stage plan and resolves before the creative LUT, so the grade is not graded.',
  'colour-critic-resolved':
    'The colour critic reached a verdict that closes: approved, bounded correction, or a human review with no hard issue left open.',
  'final-mp4-inspectable':
    'The delivered MP4 exists as an artifact whose hash, codec, dimensions, frame rate and duration were measured rather than declared.',
  'no-legacy-runtime-dependency':
    'The module graph behind every path above was scanned and imports no legacy runtime and no compatibility persistence.',
} as const satisfies Readonly<Record<MulticamLongformCriterion, string>>)

/**
 * The kinds of persisted row a check is allowed to have read.
 *
 * A closed set, because "evidence-ref: whatever the reader felt like" is how a
 * gate stops being auditable. Each value names a table the Wave 18/19/20
 * migrations actually created.
 */
export const MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES = Object.freeze([
  'workspace',
  'project',
  'project-version',
  'capture-session',
  'capture-protocol',
  'capture-protocol-evaluation',
  'sync-diagnostic',
  'sync-evidence',
  'track-coverage',
  'clock-map',
  'playback-map',
  'playback-piece',
  'multicam-direction',
  'shot-decision',
  'editorial-synthesis',
  'match-plan',
  'match-transform',
  'colour-plan',
  'colour-critic-report',
  'renderable-plan-snapshot',
  'final-export',
  'media-artifact',
  'media-manifest',
  'module-graph-audit',
] as const)

export type MulticamLongformEvidenceResourceType =
  (typeof MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES)[number]

/**
 * Why a check said no. Five reasons, because the operator's next action is
 * different for each: shoot it, investigate the row, measure it, fix the
 * content, or re-run against the current version.
 */
export const MULTICAM_LONGFORM_FAILURE_REASONS = Object.freeze([
  /** No row answers this check at all. */
  'evidence-missing',
  /** A row exists and its stored hash does not recompute from its content. */
  'evidence-unverified',
  /** The field this check needs was never measured. Null, never zero. */
  'evidence-not-measured',
  /** The evidence verifies and reports the requirement is not met. */
  'requirement-unmet',
  /** The evidence verifies but describes a different version of the subject. */
  'evidence-stale',
] as const)

export type MulticamLongformFailureReason =
  (typeof MULTICAM_LONGFORM_FAILURE_REASONS)[number]

export interface MulticamLongformEvidenceReferenceInput {
  type: MulticamLongformEvidenceResourceType
  id: string
  /** The row's own hash, or null when the table stores none. */
  hash: string | null
  /** Whether the reader recomputed the hash and it matched. */
  verified: boolean
}

export interface MulticamLongformCheckEvidenceInput {
  code: MulticamLongformCheckCode
  passed: boolean
  failureReason: MulticamLongformFailureReason | null
  /** What was observed, in one line. Required whether it passed or not. */
  detail: string
  references: readonly MulticamLongformEvidenceReferenceInput[]
}

export interface MulticamLongformCriterionEvidenceInput {
  criterion: MulticamLongformCriterion
  checks: readonly MulticamLongformCheckEvidenceInput[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{2,199}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const RESOURCE_TYPE_SET = new Set<string>(
  MULTICAM_LONGFORM_EVIDENCE_RESOURCE_TYPES,
)
const CRITERION_SET = new Set<string>(MULTICAM_LONGFORM_CRITERIA)
const FAILURE_REASON_SET = new Set<string>(MULTICAM_LONGFORM_FAILURE_REASONS)
const MAX_DETAIL_LENGTH = 512
const MAX_REFERENCES_PER_CHECK = 16

function boundedIdentity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value),
    'INVALID_ARGUMENT',
    `${field} must be an opaque identifier`,
  )
  return value
}

function isoTimestamp(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO timestamp`,
  )
  return value
}

function normalizeReference(
  input: MulticamLongformEvidenceReferenceInput,
  code: MulticamLongformCheckCode,
): Readonly<MulticamLongformEvidenceReferenceInput> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    `evidence reference of ${code} must be an object`,
  )
  assertDomain(
    RESOURCE_TYPE_SET.has(input.type),
    'INVALID_ARGUMENT',
    `evidence reference type ${String(input.type)} is unsupported`,
  )
  const id = boundedIdentity(input.id, `evidence reference id of ${code}`)
  assertDomain(
    input.hash === null || SHA_256_PATTERN.test(String(input.hash)),
    'INVALID_ARGUMENT',
    `evidence reference hash of ${code} must be SHA-256 or null`,
  )
  assertDomain(
    typeof input.verified === 'boolean',
    'INVALID_ARGUMENT',
    `evidence reference of ${code} must say whether it verified`,
  )
  // A reference with no hash cannot claim verification: there was nothing to
  // recompute. Saying "verified" about a row that stores no hash would make
  // the tamper check look stronger than it is.
  assertDomain(
    input.hash !== null || input.verified === false,
    'INVALID_ARGUMENT',
    `evidence reference of ${code} claims verification without a stored hash`,
  )
  return Object.freeze({
    type: input.type,
    id,
    hash: input.hash,
    verified: input.verified,
  })
}

function missingCheck(
  code: MulticamLongformCheckCode,
): Readonly<MulticamLongformCheckEvidenceInput> {
  return Object.freeze({
    code,
    passed: false,
    failureReason: 'evidence-missing' as const,
    detail: `no server evidence was produced for ${code}`,
    references: Object.freeze([]),
  })
}

function normalizeCheck(
  input: MulticamLongformCheckEvidenceInput,
): Readonly<MulticamLongformCheckEvidenceInput> {
  assertDomain(
    typeof input.passed === 'boolean',
    'INVALID_ARGUMENT',
    `check ${String(input.code)} must carry a boolean result`,
  )
  assertDomain(
    typeof input.detail === 'string' &&
      input.detail.trim().length >= 1 &&
      input.detail.length <= MAX_DETAIL_LENGTH,
    'INVALID_ARGUMENT',
    `check ${String(input.code)} must state what it observed in 1..${MAX_DETAIL_LENGTH} characters`,
  )
  assertDomain(
    input.passed
      ? input.failureReason === null
      : FAILURE_REASON_SET.has(String(input.failureReason)),
    'INVALID_ARGUMENT',
    `check ${String(input.code)} must name a supported failure reason exactly when it failed`,
  )
  assertDomain(
    Array.isArray(input.references) &&
      input.references.length <= MAX_REFERENCES_PER_CHECK,
    'INVALID_ARGUMENT',
    `check ${String(input.code)} carries an unbounded reference list`,
  )
  const references = input.references.map((reference) =>
    normalizeReference(reference, input.code))
  const identities = new Set(
    references.map((reference) =>
      `${reference.type}:${reference.id}:${reference.hash ?? ''}`),
  )
  assertDomain(
    identities.size === references.length,
    'INVALID_ARGUMENT',
    `check ${String(input.code)} lists the same reference twice`,
  )
  // Only "nothing was there" explains an empty reference list. Every other
  // answer had to read something to reach its conclusion.
  assertDomain(
    references.length >= 1 || input.failureReason === 'evidence-missing',
    'INVALID_ARGUMENT',
    `check ${String(input.code)} concluded without reading any evidence`,
  )
  // A pass built on a reference the reader could not verify is the failure
  // mode this gate exists to catch, so it cannot be expressed.
  assertDomain(
    !input.passed ||
      references.every((reference) =>
        reference.hash === null || reference.verified),
    'INVALID_ARGUMENT',
    `check ${String(input.code)} passed on evidence whose hash did not verify`,
  )
  return Object.freeze({
    code: input.code,
    passed: input.passed,
    failureReason: input.passed ? null : input.failureReason,
    detail: input.detail,
    references: Object.freeze(references),
  })
}

function normalizeCriterion(input: MulticamLongformCriterionEvidenceInput) {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'criterion evidence must be an object',
  )
  assertDomain(
    CRITERION_SET.has(input.criterion),
    'INVALID_ARGUMENT',
    `criterion ${String(input.criterion)} is unsupported`,
  )
  const required = MULTICAM_LONGFORM_CRITERION_CHECKS[input.criterion]
  const requiredSet = new Set<string>(required)
  assertDomain(
    Array.isArray(input.checks) && input.checks.length <= required.length,
    'INVALID_ARGUMENT',
    `criterion ${input.criterion} carries an invalid check list`,
  )
  const supplied = new Map<
    MulticamLongformCheckCode,
    MulticamLongformCheckEvidenceInput
  >()
  for (const check of input.checks) {
    assertDomain(
      typeof check === 'object' && check !== null,
      'INVALID_ARGUMENT',
      `criterion ${input.criterion} carries a malformed check`,
    )
    assertDomain(
      requiredSet.has(check.code),
      'INVALID_ARGUMENT',
      `check ${String(check.code)} does not belong to ${input.criterion}`,
    )
    assertDomain(
      !supplied.has(check.code),
      'INVALID_ARGUMENT',
      `check ${check.code} is duplicated in ${input.criterion}`,
    )
    supplied.set(check.code, check)
  }
  const checks = required.map((code) =>
    normalizeCheck(supplied.get(code) ?? missingCheck(code)))
  const failedChecks = checks.filter((check) => !check.passed)
  return Object.freeze({
    criterion: input.criterion,
    source: 'server' as const,
    automatic: true as const,
    passed: failedChecks.length === 0,
    checkCount: checks.length,
    failedCheckCount: failedChecks.length,
    missingCheckCount: required.filter((code) => !supplied.has(code)).length,
    unverifiedReferenceCount: checks.reduce(
      (total, check) =>
        total +
        check.references.filter((reference) => !reference.verified).length,
      0,
    ),
    checks: Object.freeze(checks),
  })
}

export type MulticamLongformCriterionResult = ReturnType<
  typeof normalizeCriterion
>

function absentCriterion(
  criterion: MulticamLongformCriterion,
): MulticamLongformCriterionResult {
  return normalizeCriterion({ criterion, checks: [] })
}

/**
 * Evaluate the phase gate from server-read evidence.
 *
 * Note what the signature does not accept: no score, no approval, no evidence
 * ref chosen by a caller, no override. `evidence` comes from a repository that
 * queried PostgreSQL; `evaluatedAt` comes from the service's clock.
 */
export function evaluateMulticamLongformGate(input: {
  workspaceId: string
  projectId: string
  sessionId: string | null
  evidence: readonly MulticamLongformCriterionEvidenceInput[]
  evaluatedAt: string
}) {
  const workspaceId = boundedIdentity(input.workspaceId, 'workspaceId')
  const projectId = boundedIdentity(input.projectId, 'projectId')
  const sessionId =
    input.sessionId === null
      ? null
      : boundedIdentity(input.sessionId, 'sessionId')
  const evaluatedAt = isoTimestamp(input.evaluatedAt, 'evaluatedAt')
  assertDomain(
    Array.isArray(input.evidence) &&
      input.evidence.length <= MULTICAM_LONGFORM_CRITERIA.length,
    'INVALID_ARGUMENT',
    'gate evidence is invalid',
  )
  const byCriterion = new Map<
    MulticamLongformCriterion,
    MulticamLongformCriterionResult
  >()
  for (const evidence of input.evidence) {
    assertDomain(
      typeof evidence === 'object' && evidence !== null,
      'INVALID_ARGUMENT',
      'gate evidence entry must be an object',
    )
    assertDomain(
      !byCriterion.has(evidence.criterion),
      'INVALID_ARGUMENT',
      `criterion ${String(evidence.criterion)} is duplicated`,
    )
    byCriterion.set(evidence.criterion, normalizeCriterion(evidence))
  }
  // Every criterion appears in the report, in the catalogue's order, whether or
  // not the reader found anything. A criterion that vanishes when it has no
  // rows is a criterion nobody notices is unmet.
  const criteria = MULTICAM_LONGFORM_CRITERIA.map(
    (criterion) => byCriterion.get(criterion) ?? absentCriterion(criterion),
  )
  const evaluated = MULTICAM_LONGFORM_CRITERIA.filter((criterion) =>
    byCriterion.has(criterion)).length
  const satisfied = criteria.filter((item) => item.passed).length
  const failed = criteria
    .filter((item) => !item.passed)
    .map((item) => item.criterion)
  const blocking = criteria.flatMap((item) =>
    item.checks
      .filter((check) => !check.passed)
      .map((check) =>
        Object.freeze({
          criterion: item.criterion,
          check: check.code,
          reason: check.failureReason,
          detail: check.detail,
        })),
  )
  const report = Object.freeze({
    schemaVersion: MULTICAM_LONGFORM_GATE_REPORT_SCHEMA_VERSION,
    gate: MULTICAM_LONGFORM_GATE_ID,
    workspaceId,
    projectId,
    sessionId,
    approved: satisfied === MULTICAM_LONGFORM_CRITERIA.length,
    satisfied,
    evaluated,
    total: MULTICAM_LONGFORM_CRITERIA.length,
    failed: Object.freeze(failed),
    blocking: Object.freeze(blocking),
    serverEvidenceOnly: true as const,
    criteria: Object.freeze(criteria),
    evaluatedAt,
  })
  return Object.freeze({
    ...report,
    fingerprint: calculateCanonicalHash(report),
  })
}

export type MulticamLongformGateReport = ReturnType<
  typeof evaluateMulticamLongformGate
>

/**
 * Re-derive a stored report and refuse it if the stored fingerprint disagrees.
 *
 * Used on every read: a report row that was edited in the database has to fail
 * here rather than be handed to a UI that would display an approval nobody
 * evaluated.
 */
export function assertMulticamLongformGateReportIntegrity(
  report: Readonly<MulticamLongformGateReport>,
): Readonly<MulticamLongformGateReport> {
  const recomputed = evaluateMulticamLongformGate({
    workspaceId: report.workspaceId,
    projectId: report.projectId,
    sessionId: report.sessionId,
    evidence: report.criteria.map((criterion) => ({
      criterion: criterion.criterion,
      checks: criterion.checks.map((check) => ({
        code: check.code,
        passed: check.passed,
        failureReason: check.failureReason,
        detail: check.detail,
        references: check.references.map((reference) => ({ ...reference })),
      })),
    })),
    evaluatedAt: report.evaluatedAt,
  })
  assertDomain(
    recomputed.fingerprint === report.fingerprint &&
      recomputed.approved === report.approved &&
      recomputed.satisfied === report.satisfied &&
      recomputed.evaluated === report.evaluated,
    'INVALID_ARGUMENT',
    'multicam long-form gate report failed integrity validation',
  )
  return recomputed
}

/**
 * What is still missing, ordered so the first line is the first thing to do.
 *
 * Criteria with nothing recorded come before criteria that recorded a refusal:
 * "we never ran it" and "it ran and said no" need different work, and putting
 * them in one list sorted by criterion order hides which is which.
 */
export function explainMulticamLongformGate(
  report: Readonly<MulticamLongformGateReport>,
) {
  const outstanding = report.criteria
    .filter((criterion) => !criterion.passed)
    .map((criterion) =>
      Object.freeze({
        criterion: criterion.criterion,
        statement: MULTICAM_LONGFORM_CRITERION_STATEMENTS[criterion.criterion],
        neverEvaluated: criterion.missingCheckCount === criterion.checkCount,
        missingCheckCount: criterion.missingCheckCount,
        failedCheckCount: criterion.failedCheckCount,
        unverifiedReferenceCount: criterion.unverifiedReferenceCount,
        blocking: Object.freeze(
          criterion.checks
            .filter((check) => !check.passed)
            .map((check) =>
              Object.freeze({
                check: check.code,
                reason: check.failureReason,
                detail: check.detail,
              })),
        ),
      }))
  const ordered = [
    ...outstanding.filter((item) => item.neverEvaluated),
    ...outstanding.filter((item) => !item.neverEvaluated),
  ]
  return Object.freeze({
    gate: report.gate,
    approved: report.approved,
    satisfied: report.satisfied,
    total: report.total,
    outstanding: Object.freeze(ordered),
  })
}

/**
 * Criterion 10 is the only one whose evidence is not a database row: "no
 * legacy runtime" is a property of the code that produced the other nine, and
 * AGENTS.md L152 asks for an automatic check that stops the reintroduction
 * rather than a promise. These are the markers a scanner reports, defined here
 * so the scanner cannot quietly narrow what counts as legacy.
 */
export const LEGACY_RUNTIME_MARKERS = Object.freeze([
  /** An import that resolves into the retired `src/lib` runtime. */
  'legacy-runtime-import',
  /** The legacy Prisma client, which is bound to the retired schema. */
  'legacy-prisma-client',
  /** SQLite, in any spelling: the retired product's store. */
  'sqlite-persistence',
  /** A retired `/api/process/*`-era route or handler. */
  'legacy-process-route',
  /** A compatibility path that writes both stores. */
  'dual-write-compatibility',
] as const)

export type LegacyRuntimeMarker = (typeof LEGACY_RUNTIME_MARKERS)[number]

export interface LegacyRuntimeAuditViolation {
  readonly marker: LegacyRuntimeMarker
  /** Repository-relative module path, forward slashes. */
  readonly module: string
  /** The import specifier that tripped the marker, when there was one. */
  readonly specifier: string | null
}

export interface LegacyRuntimeAuditResult {
  readonly schemaVersion: 'legacy-runtime-audit/v1'
  readonly entryModules: readonly string[]
  readonly scannedModuleCount: number
  readonly violations: readonly Readonly<LegacyRuntimeAuditViolation>[]
  readonly auditHash: string
  readonly scannedAt: string
}

const LEGACY_MARKER_SET = new Set<string>(LEGACY_RUNTIME_MARKERS)

/** Recompute an audit's hash from its content. A scan nobody can re-derive is a claim. */
export function calculateLegacyRuntimeAuditHash(
  audit: Omit<LegacyRuntimeAuditResult, 'auditHash'>,
): string {
  return calculateCanonicalHash({
    schemaVersion: audit.schemaVersion,
    entryModules: [...audit.entryModules],
    scannedModuleCount: audit.scannedModuleCount,
    violations: audit.violations.map((violation) => ({
      marker: violation.marker,
      module: violation.module,
      specifier: violation.specifier,
    })),
    scannedAt: audit.scannedAt,
  })
}

export function assertLegacyRuntimeAudit(
  audit: Readonly<LegacyRuntimeAuditResult>,
): Readonly<LegacyRuntimeAuditResult> {
  assertDomain(
    typeof audit === 'object' && audit !== null &&
      audit.schemaVersion === 'legacy-runtime-audit/v1',
    'INVALID_ARGUMENT',
    'legacy runtime audit has an unsupported schema version',
  )
  assertDomain(
    Array.isArray(audit.entryModules) && audit.entryModules.length >= 1,
    'INVALID_ARGUMENT',
    'legacy runtime audit must name the modules it started from',
  )
  assertDomain(
    Number.isSafeInteger(audit.scannedModuleCount) &&
      audit.scannedModuleCount >= audit.entryModules.length,
    'INVALID_ARGUMENT',
    'legacy runtime audit scanned fewer modules than it entered',
  )
  for (const violation of audit.violations) {
    assertDomain(
      LEGACY_MARKER_SET.has(violation.marker),
      'INVALID_ARGUMENT',
      `legacy runtime audit reported the unknown marker ${String(violation.marker)}`,
    )
  }
  isoTimestamp(audit.scannedAt, 'legacy runtime audit scannedAt')
  assertDomain(
    calculateLegacyRuntimeAuditHash(audit) === audit.auditHash,
    'INVALID_ARGUMENT',
    'legacy runtime audit hash does not recompute from its content',
  )
  return audit
}

/**
 * Turn a module-graph scan into the three checks of criterion 10.
 *
 * The scan is treated as evidence like any row: it carries a hash, the hash is
 * recomputed, and a scan that does not recompute reproves the criterion with
 * `evidence-unverified` instead of throwing.
 */
export function buildLegacyRuntimeCriterion(
  audit: Readonly<LegacyRuntimeAuditResult> | null,
): MulticamLongformCriterionEvidenceInput {
  const criterion = 'no-legacy-runtime-dependency' as const
  if (!audit) {
    return { criterion, checks: [] }
  }
  let verified = true
  try {
    assertLegacyRuntimeAudit(audit)
  } catch {
    verified = false
  }
  const reference = Object.freeze({
    type: 'module-graph-audit' as const,
    id: `legacy-runtime-audit:${audit.scannedAt}`,
    hash: SHA_256_PATTERN.test(String(audit.auditHash)) ? audit.auditHash : null,
    verified,
  })
  const references = [reference]
  if (!verified) {
    const detail =
      `module graph scan of ${audit.entryModules.length} entry modules did not verify against its own hash`
    return {
      criterion,
      checks: MULTICAM_LONGFORM_CRITERION_CHECKS[criterion].map((code) => ({
        code,
        passed: false,
        failureReason: 'evidence-unverified' as const,
        detail,
        references,
      })),
    }
  }
  const marked = (markers: readonly LegacyRuntimeMarker[]) =>
    audit.violations.filter((violation) => markers.includes(violation.marker))
  const importViolations = marked([
    'legacy-runtime-import',
    'legacy-process-route',
  ])
  const persistenceViolations = marked([
    'legacy-prisma-client',
    'sqlite-persistence',
    'dual-write-compatibility',
  ])
  const describe = (
    violations: readonly Readonly<LegacyRuntimeAuditViolation>[],
  ) =>
    violations
      .slice(0, 3)
      .map((violation) =>
        `${violation.module} → ${violation.specifier ?? violation.marker}`)
      .join('; ')
  return {
    criterion,
    checks: [
      {
        code: 'module-graph-scanned',
        passed: audit.scannedModuleCount >= audit.entryModules.length,
        failureReason:
          audit.scannedModuleCount >= audit.entryModules.length
            ? null
            : 'evidence-not-measured',
        detail:
          `scanned ${audit.scannedModuleCount} modules from ${audit.entryModules.length} entry points at ${audit.scannedAt}`,
        references,
      },
      {
        code: 'no-legacy-runtime-import',
        passed: importViolations.length === 0,
        failureReason: importViolations.length === 0 ? null : 'requirement-unmet',
        detail:
          importViolations.length === 0
            ? `no legacy runtime import in ${audit.scannedModuleCount} scanned modules`
            : `${importViolations.length} legacy runtime imports: ${describe(importViolations)}`,
        references,
      },
      {
        code: 'no-compatibility-persistence',
        passed: persistenceViolations.length === 0,
        failureReason:
          persistenceViolations.length === 0 ? null : 'requirement-unmet',
        detail:
          persistenceViolations.length === 0
            ? `no compatibility persistence in ${audit.scannedModuleCount} scanned modules`
            : `${persistenceViolations.length} compatibility persistence imports: ${describe(persistenceViolations)}`,
        references,
      },
    ],
  }
}

/** The catalogue a "show me the criteria" reader needs; no evaluation. */
export function describeMulticamLongformCriteria() {
  return Object.freeze(
    MULTICAM_LONGFORM_CRITERIA.map((criterion) =>
      Object.freeze({
        criterion,
        statement: MULTICAM_LONGFORM_CRITERION_STATEMENTS[criterion],
        checks: Object.freeze([
          ...MULTICAM_LONGFORM_CRITERION_CHECKS[criterion],
        ]),
      })),
  )
}

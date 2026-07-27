import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const MVP_CORE_CRITERION_CHECKS = Object.freeze({
  'AC-001': Object.freeze([
    'workspace-active',
    'project-created',
    'policy-snapshot-bound',
  ]),
  'AC-002': Object.freeze([
    'objective-bound',
    'briefing-optional-contract',
  ]),
  'AC-003': Object.freeze([
    'immutable-master',
    'derived-proxy',
    'source-lineage',
  ]),
  'AC-004': Object.freeze([
    'word-timestamps',
    'silence-detection-recorded',
    'retake-detection-recorded',
  ]),
  'AC-005': Object.freeze([
    'treatment-plan-persisted',
    'story-plan-persisted',
    'edit-plan-persisted',
  ]),
  'AC-006': Object.freeze([
    'talking-head-broll',
    'voiceover-broll-no-person',
  ]),
  'AC-007': Object.freeze([
    'generated-candidate-evaluated',
    'rejected-candidate-audited',
    'replacement-selected',
  ]),
  'AC-008': Object.freeze([
    'proxy-rendered',
    'hard-validation-passed',
    'localized-critic-recorded',
  ]),
  'AC-009': Object.freeze([
    'annotation-bound',
    'correction-version-created',
  ]),
  'AC-010': Object.freeze([
    'trim-versioned',
    'broll-replaced',
    'text-edited',
    'subtitle-edited',
    'layout-edited',
    'undo-versioned',
  ]),
  'AC-011': Object.freeze([
    'copy-on-write-duplicate',
    'master-bytes-not-copied',
  ]),
  'AC-012': Object.freeze([
    'export-9-16-validated',
    'export-16-9-validated',
    'layout-independent',
  ]),
  'AC-013': Object.freeze([
    'final-manifest-complete',
    'final-reconstructable',
  ]),
  'AC-014': Object.freeze([
    'restart-recovered',
    'retry-safe',
    'project-not-stuck',
  ]),
  'AC-015': Object.freeze([
    'progress-state-truthful',
    'review-state-truthful',
    'completion-state-truthful',
    'failure-state-truthful',
  ]),
  'AC-016': Object.freeze([
    'external-actor-authorized',
    'public-api-only',
    'version-policy-parity',
    'job-artifact-parity',
  ]),
} as const)

export type MvpCoreCriterion = keyof typeof MVP_CORE_CRITERION_CHECKS
export type MvpCoreCheckCode =
  (typeof MVP_CORE_CRITERION_CHECKS)[MvpCoreCriterion][number]

export const MVP_CORE_ACCEPTANCE_CRITERIA = Object.freeze(
  Object.keys(MVP_CORE_CRITERION_CHECKS) as MvpCoreCriterion[],
)

export const MVP_CORE_EVIDENCE_RESOURCE_TYPES = Object.freeze([
  'workspace',
  'project',
  'snapshot',
  'version',
  'artifact',
  'manifest',
  'transcript',
  'director-run',
  'asset-selection',
  'proxy-review',
  'quality-iteration',
  'annotation',
  'patch-proposal',
  'command',
  'operation',
  'dashboard-state',
  'api-client',
] as const)

export type MvpCoreEvidenceResourceType =
  (typeof MVP_CORE_EVIDENCE_RESOURCE_TYPES)[number]

export interface MvpCoreEvidenceReferenceInput {
  type: MvpCoreEvidenceResourceType
  id: string
  hash?: string
}

export interface MvpCoreCheckEvidenceInput {
  code: MvpCoreCheckCode
  passed: boolean
  references: readonly MvpCoreEvidenceReferenceInput[]
}

export interface MvpCoreCriterionEvidenceInput {
  criterion: MvpCoreCriterion
  checks: readonly MvpCoreCheckEvidenceInput[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const RESOURCE_TYPE_SET = new Set<string>(MVP_CORE_EVIDENCE_RESOURCE_TYPES)
const CRITERION_SET = new Set<string>(MVP_CORE_ACCEPTANCE_CRITERIA)

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
  input: MvpCoreEvidenceReferenceInput,
): Readonly<MvpCoreEvidenceReferenceInput> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'MVP evidence reference must be an object',
  )
  assertDomain(
    RESOURCE_TYPE_SET.has(input.type),
    'INVALID_ARGUMENT',
    'MVP evidence reference type is unsupported',
  )
  const id = boundedIdentity(input.id, 'MVP evidence reference id')
  if (input.hash !== undefined) {
    assertDomain(
      SHA_256_PATTERN.test(input.hash),
      'INVALID_ARGUMENT',
      'MVP evidence reference hash must be SHA-256',
    )
  }
  return Object.freeze({
    type: input.type,
    id,
    ...(input.hash === undefined ? {} : { hash: input.hash }),
  })
}

function normalizeCriterionEvidence(
  input: MvpCoreCriterionEvidenceInput,
): Readonly<{
  criterion: MvpCoreCriterion
  source: 'server'
  automatic: true
  passed: boolean
  missingChecks: readonly MvpCoreCheckCode[]
  checks: readonly Readonly<{
    code: MvpCoreCheckCode
    passed: boolean
    references: readonly Readonly<MvpCoreEvidenceReferenceInput>[]
  }>[]
}> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'MVP criterion evidence must be an object',
  )
  assertDomain(
    CRITERION_SET.has(input.criterion),
    'INVALID_ARGUMENT',
    'MVP criterion is unsupported',
  )
  assertDomain(
    Array.isArray(input.checks) && input.checks.length <= 32,
    'INVALID_ARGUMENT',
    'MVP criterion checks are invalid',
  )
  const requiredChecks = MVP_CORE_CRITERION_CHECKS[input.criterion]
  const requiredSet = new Set<string>(requiredChecks)
  const supplied = new Map<MvpCoreCheckCode, MvpCoreCheckEvidenceInput>()
  for (const check of input.checks) {
    assertDomain(
      typeof check === 'object' && check !== null,
      'INVALID_ARGUMENT',
      'MVP check evidence must be an object',
    )
    assertDomain(
      requiredSet.has(check.code),
      'INVALID_ARGUMENT',
      `MVP check ${check.code} does not belong to ${input.criterion}`,
    )
    assertDomain(
      !supplied.has(check.code),
      'INVALID_ARGUMENT',
      `MVP check ${check.code} is duplicated`,
    )
    assertDomain(
      typeof check.passed === 'boolean',
      'INVALID_ARGUMENT',
      `MVP check ${check.code} must have a boolean result`,
    )
    assertDomain(
      Array.isArray(check.references) &&
        check.references.length >= 1 &&
        check.references.length <= 16,
      'INVALID_ARGUMENT',
      `MVP check ${check.code} must contain bounded server references`,
    )
    supplied.set(check.code, check)
  }
  const missingChecks = requiredChecks.filter((code) => !supplied.has(code))
  const checks = requiredChecks.map((code) => {
    const check = supplied.get(code)
    if (!check) {
      return Object.freeze({
        code,
        passed: false,
        references: Object.freeze([]),
      })
    }
    const references = check.references.map(normalizeReference)
    const identities = new Set(references.map((reference) =>
      `${reference.type}:${reference.id}:${reference.hash ?? ''}`))
    assertDomain(
      identities.size === references.length,
      'INVALID_ARGUMENT',
      `MVP check ${check.code} contains duplicate references`,
    )
    return Object.freeze({
      code,
      passed: check.passed,
      references: Object.freeze(references),
    })
  })
  return Object.freeze({
    criterion: input.criterion,
    source: 'server',
    automatic: true,
    passed:
      missingChecks.length === 0 &&
      checks.every((check) => check.passed),
    missingChecks: Object.freeze([...missingChecks]),
    checks: Object.freeze(checks),
  })
}

export function evaluateMvpCoreGate(input: {
  workspaceId: string
  primaryProjectId: string
  companionProjectId: string
  evidence: readonly MvpCoreCriterionEvidenceInput[]
  evaluatedAt: string
}) {
  const workspaceId = boundedIdentity(input.workspaceId, 'workspaceId')
  const primaryProjectId = boundedIdentity(
    input.primaryProjectId,
    'primaryProjectId',
  )
  const companionProjectId = boundedIdentity(
    input.companionProjectId,
    'companionProjectId',
  )
  assertDomain(
    primaryProjectId !== companionProjectId,
    'INVALID_ARGUMENT',
    'MVP gate requires distinct primary and companion projects',
  )
  const evaluatedAt = isoTimestamp(input.evaluatedAt, 'evaluatedAt')
  assertDomain(
    Array.isArray(input.evidence) &&
      input.evidence.length <= MVP_CORE_ACCEPTANCE_CRITERIA.length,
    'INVALID_ARGUMENT',
    'MVP gate evidence is invalid',
  )
  const normalizedByCriterion = new Map<
    MvpCoreCriterion,
    ReturnType<typeof normalizeCriterionEvidence>
  >()
  for (const evidence of input.evidence) {
    assertDomain(
      !normalizedByCriterion.has(evidence.criterion),
      'INVALID_ARGUMENT',
      `MVP criterion ${evidence.criterion} is duplicated`,
    )
    normalizedByCriterion.set(
      evidence.criterion,
      normalizeCriterionEvidence(evidence),
    )
  }
  const missing = MVP_CORE_ACCEPTANCE_CRITERIA.filter(
    (criterion) => !normalizedByCriterion.has(criterion),
  )
  const evidence = MVP_CORE_ACCEPTANCE_CRITERIA.flatMap((criterion) => {
    const item = normalizedByCriterion.get(criterion)
    return item ? [item] : []
  })
  const failed = evidence
    .filter((item) => !item.passed)
    .map((item) => item.criterion)
  const covered = evidence.filter(
    (item) => item.missingChecks.length === 0,
  ).length
  const passed = evidence.filter((item) => item.passed).length
  const report = Object.freeze({
    schemaVersion: 'mvp-core-gate-report/v1' as const,
    gate: 'mvp-core/v1' as const,
    workspaceId,
    primaryProjectId,
    companionProjectId,
    approved:
      missing.length === 0 &&
      failed.length === 0 &&
      covered === MVP_CORE_ACCEPTANCE_CRITERIA.length,
    covered,
    passed,
    total: MVP_CORE_ACCEPTANCE_CRITERIA.length,
    missing: Object.freeze([...missing]),
    failed: Object.freeze(failed),
    serverEvidenceOnly: true as const,
    evidence: Object.freeze(evidence),
    evaluatedAt,
  })
  return Object.freeze({
    ...report,
    fingerprint: calculateCanonicalHash(report),
  })
}

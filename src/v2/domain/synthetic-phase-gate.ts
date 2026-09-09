import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const SYNTHETIC_PHASE_GATE_CRITERION_CHECKS = Object.freeze({
  'F3-GATE-001': Object.freeze([
    'elevenlabs-audio-alignment-live',
    'heygen-generated-audio-avatar-live',
    'heygen-ready-audio-avatar-live',
  ]),
  'F3-GATE-002': Object.freeze([
    'approved-blocks-catalogued',
    'cross-project-reuse-with-zero-provider-work',
  ]),
  'F3-GATE-003': Object.freeze([
    'transformation-rejected-before-fallback',
    'fallback-result-approved',
  ]),
  'F3-GATE-004': Object.freeze([
    'provider-swap-keeps-plan-and-renderer-contracts',
  ]),
} as const)

export type SyntheticPhaseGateCriterion =
  keyof typeof SYNTHETIC_PHASE_GATE_CRITERION_CHECKS
export type SyntheticPhaseGateCheckCode =
  (typeof SYNTHETIC_PHASE_GATE_CRITERION_CHECKS)[SyntheticPhaseGateCriterion][number]

export const SYNTHETIC_PHASE_GATE_CRITERIA = Object.freeze(
  Object.keys(SYNTHETIC_PHASE_GATE_CRITERION_CHECKS) as SyntheticPhaseGateCriterion[],
)

export const SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES = Object.freeze([
  'provider-job',
  'provider-result-artifact',
  'alignment-artifact',
  'synthetic-audio-master',
  'synthetic-master',
  'speech-segment',
  'cache-decision',
  'project',
  'transformation-fallback-ledger',
  'transformation-critic-report',
  'edit-plan',
  'render-manifest',
  'build-attestation',
] as const)

export type SyntheticPhaseGateEvidenceType =
  (typeof SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES)[number]

function evidenceTypes<
  const T extends readonly SyntheticPhaseGateEvidenceType[],
>(...types: T): Readonly<T> {
  return Object.freeze(types)
}

const REQUIRED_EVIDENCE_TYPES: Readonly<
  Record<SyntheticPhaseGateCheckCode, readonly SyntheticPhaseGateEvidenceType[]>
> = Object.freeze({
  'elevenlabs-audio-alignment-live': evidenceTypes(
    'provider-job',
    'provider-result-artifact',
    'alignment-artifact',
  ),
  'heygen-generated-audio-avatar-live': evidenceTypes(
    'provider-job',
    'synthetic-audio-master',
    'provider-result-artifact',
  ),
  'heygen-ready-audio-avatar-live': evidenceTypes(
    'provider-job',
    'synthetic-audio-master',
    'provider-result-artifact',
  ),
  'approved-blocks-catalogued': evidenceTypes(
    'synthetic-master',
    'speech-segment',
  ),
  'cross-project-reuse-with-zero-provider-work': evidenceTypes(
    'cache-decision',
    'synthetic-master',
    'project',
  ),
  'transformation-rejected-before-fallback': evidenceTypes(
    'transformation-fallback-ledger',
    'transformation-critic-report',
  ),
  'fallback-result-approved': evidenceTypes(
    'transformation-fallback-ledger',
    'provider-result-artifact',
  ),
  'provider-swap-keeps-plan-and-renderer-contracts': evidenceTypes(
    'edit-plan',
    'render-manifest',
    'build-attestation',
  ),
})

export interface SyntheticPhaseGateEvidenceReferenceInput {
  type: SyntheticPhaseGateEvidenceType
  id: string
  hash: string
}

export interface SyntheticPhaseGateCheckEvidenceInput {
  code: SyntheticPhaseGateCheckCode
  passed: boolean
  references: readonly SyntheticPhaseGateEvidenceReferenceInput[]
}

export interface SyntheticPhaseGateCriterionEvidenceInput {
  criterion: SyntheticPhaseGateCriterion
  checks: readonly SyntheticPhaseGateCheckEvidenceInput[]
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/
const CRITERION_SET = new Set<string>(SYNTHETIC_PHASE_GATE_CRITERIA)
const EVIDENCE_TYPE_SET = new Set<string>(SYNTHETIC_PHASE_GATE_EVIDENCE_TYPES)

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value),
    'INVALID_ARGUMENT',
    `${field} must be an opaque identifier`,
  )
  return value
}

function sha256(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && SHA_256_PATTERN.test(value),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value
}

function canonicalTimestamp(value: unknown, field: string): string {
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
  input: SyntheticPhaseGateEvidenceReferenceInput,
): Readonly<SyntheticPhaseGateEvidenceReferenceInput> {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'Synthetic phase gate evidence reference must be an object',
  )
  assertDomain(
    EVIDENCE_TYPE_SET.has(input.type),
    'INVALID_ARGUMENT',
    'Synthetic phase gate evidence type is unsupported',
  )
  return Object.freeze({
    type: input.type,
    id: identity(input.id, 'Synthetic phase gate evidence id'),
    hash: sha256(input.hash, 'Synthetic phase gate evidence hash'),
  })
}

function normalizeCriterion(
  input: SyntheticPhaseGateCriterionEvidenceInput,
) {
  assertDomain(
    typeof input === 'object' && input !== null,
    'INVALID_ARGUMENT',
    'Synthetic phase gate criterion evidence must be an object',
  )
  assertDomain(
    CRITERION_SET.has(input.criterion),
    'INVALID_ARGUMENT',
    'Synthetic phase gate criterion is unsupported',
  )
  assertDomain(
    Array.isArray(input.checks) && input.checks.length <= 16,
    'INVALID_ARGUMENT',
    'Synthetic phase gate checks are invalid',
  )
  const requiredChecks = SYNTHETIC_PHASE_GATE_CRITERION_CHECKS[input.criterion]
  const requiredSet = new Set<string>(requiredChecks)
  const supplied = new Map<
    SyntheticPhaseGateCheckCode,
    SyntheticPhaseGateCheckEvidenceInput
  >()
  for (const item of input.checks) {
    assertDomain(
      typeof item === 'object' && item !== null,
      'INVALID_ARGUMENT',
      'Synthetic phase gate check must be an object',
    )
    assertDomain(
      requiredSet.has(item.code),
      'INVALID_ARGUMENT',
      `Synthetic phase gate check ${item.code} does not belong to ${input.criterion}`,
    )
    assertDomain(
      !supplied.has(item.code),
      'INVALID_ARGUMENT',
      `Synthetic phase gate check ${item.code} is duplicated`,
    )
    assertDomain(
      typeof item.passed === 'boolean',
      'INVALID_ARGUMENT',
      `Synthetic phase gate check ${item.code} must have a boolean result`,
    )
    assertDomain(
      Array.isArray(item.references) &&
        item.references.length >= 1 &&
        item.references.length <= 16,
      'INVALID_ARGUMENT',
      `Synthetic phase gate check ${item.code} must contain bounded server references`,
    )
    supplied.set(item.code, item)
  }

  const missingChecks = requiredChecks.filter((code) => !supplied.has(code))
  const checks = requiredChecks.map((code) => {
    const inputCheck = supplied.get(code)
    if (!inputCheck) {
      return Object.freeze({
        code,
        passed: false,
        missingEvidenceTypes: Object.freeze([...REQUIRED_EVIDENCE_TYPES[code]]),
        references: Object.freeze([]),
      })
    }
    const references = inputCheck.references.map(normalizeReference)
    const identities = new Set(references.map(({ type, id, hash }) =>
      `${type}:${id}:${hash}`))
    assertDomain(
      identities.size === references.length,
      'INVALID_ARGUMENT',
      `Synthetic phase gate check ${code} contains duplicate references`,
    )
    const suppliedTypes = new Set(references.map((reference) => reference.type))
    const missingEvidenceTypes = REQUIRED_EVIDENCE_TYPES[code]
      .filter((type) => !suppliedTypes.has(type))
    return Object.freeze({
      code,
      passed: inputCheck.passed && missingEvidenceTypes.length === 0,
      missingEvidenceTypes: Object.freeze(missingEvidenceTypes),
      references: Object.freeze(references),
    })
  })
  return Object.freeze({
    criterion: input.criterion,
    source: 'server' as const,
    automatic: true as const,
    passed:
      missingChecks.length === 0 &&
      checks.every((check) => check.passed),
    missingChecks: Object.freeze([...missingChecks]),
    checks: Object.freeze(checks),
  })
}

export function evaluateSyntheticPhaseGate(input: {
  workspaceId: string
  projectId: string
  projectVersionId: string
  projectVersionHash: string
  evidence: readonly SyntheticPhaseGateCriterionEvidenceInput[]
  evaluatedAt: string
}) {
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const projectVersionId = identity(input.projectVersionId, 'projectVersionId')
  const projectVersionHash = sha256(input.projectVersionHash, 'projectVersionHash')
  const evaluatedAt = canonicalTimestamp(input.evaluatedAt, 'evaluatedAt')
  assertDomain(
    Array.isArray(input.evidence) &&
      input.evidence.length <= SYNTHETIC_PHASE_GATE_CRITERIA.length,
    'INVALID_ARGUMENT',
    'Synthetic phase gate evidence is invalid',
  )

  const byCriterion = new Map<
    SyntheticPhaseGateCriterion,
    ReturnType<typeof normalizeCriterion>
  >()
  for (const criterion of input.evidence) {
    assertDomain(
      !byCriterion.has(criterion.criterion),
      'INVALID_ARGUMENT',
      `Synthetic phase gate criterion ${criterion.criterion} is duplicated`,
    )
    byCriterion.set(criterion.criterion, normalizeCriterion(criterion))
  }

  const missing = SYNTHETIC_PHASE_GATE_CRITERIA
    .filter((criterion) => !byCriterion.has(criterion))
  const evidence = SYNTHETIC_PHASE_GATE_CRITERIA.flatMap((criterion) => {
    const item = byCriterion.get(criterion)
    return item ? [item] : []
  })
  const failed = evidence
    .filter((item) => !item.passed)
    .map((item) => item.criterion)
  const covered = evidence
    .filter((item) => item.missingChecks.length === 0 &&
      item.checks.every((check) => check.missingEvidenceTypes.length === 0))
    .length
  const passed = evidence.filter((item) => item.passed).length
  const report = Object.freeze({
    schemaVersion: 'synthetic-phase-gate-report/v1' as const,
    gate: 'synthetic-phase/v1' as const,
    workspaceId,
    projectId,
    projectVersionId,
    projectVersionHash,
    approved:
      missing.length === 0 &&
      failed.length === 0 &&
      covered === SYNTHETIC_PHASE_GATE_CRITERIA.length,
    covered,
    passed,
    total: SYNTHETIC_PHASE_GATE_CRITERIA.length,
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

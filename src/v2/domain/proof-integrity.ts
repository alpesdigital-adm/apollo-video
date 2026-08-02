import {
  calculateCanonicalHash,
  stableSerialize,
} from './canonical-hash.ts'
import type { CompatibilityNode } from './compatibility-graph.ts'
import type {
  CatalogedEvidenceSegment,
  EvidenceRightsSnapshot,
} from './evidence-segment.ts'
import { assertDomain } from './errors.ts'
import type {
  ProofNeedItem,
  ProofNeedRun,
} from './proof-need.ts'
import { normalizeSpeechText } from './speech-segment-catalog.ts'

export const PROOF_INTEGRITY_RUN_SCHEMA_VERSION =
  'proof-integrity-run/v1' as const
export const PROOF_INTEGRITY_POLICY_VERSION =
  'proof-integrity-policy/v1' as const
export const PROOF_INTEGRITY_PRESENTATION_SCHEMA_VERSION =
  'proof-integrity-presentation/v1' as const
export const PROOF_INTEGRITY_PERSON_CLAIM_KEY =
  'integrity.person' as const
export const PROOF_INTEGRITY_PERIOD_CLAIM_KEY =
  'integrity.period' as const

export const PROOF_INTEGRITY_OUTCOMES = [
  'approved',
  'blocked',
  'not-applicable',
] as const

export const PROOF_INTEGRITY_DIMENSIONS = [
  'claim',
  'product',
  'person',
  'period',
  'audience',
  'consent',
  'rights',
  'context',
] as const

export const PROOF_INTEGRITY_REASON_CODES = [
  'PROOF_UNAVAILABLE',
  'EVIDENCE_MISSING',
  'EVIDENCE_IDENTITY_MISMATCH',
  'RECIPE_CLAIM_UNSPECIFIED',
  'RECIPE_CLAIM_MISMATCH',
  'RECIPE_PERSON_UNSPECIFIED',
  'RECIPE_PERIOD_UNSPECIFIED',
  'RECIPE_AUDIENCE_UNSPECIFIED',
  'EVIDENCE_AUDIENCE_UNSPECIFIED',
  'CLAIM_MISMATCH',
  'PRODUCT_MISMATCH',
  'PERSON_MISMATCH',
  'PERIOD_MISMATCH',
  'AUDIENCE_MISMATCH',
  'RIGHTS_SNAPSHOT_STALE',
  'RIGHTS_NOT_APPROVED',
  'RIGHTS_EXPIRED',
  'CONSENT_NOT_APPROVED',
  'CONSENT_EXPIRED',
  'EVIDENCE_INTEGRITY_BLOCKED',
  'CONTEXT_RANGE_MISSING',
  'CONTEXT_RANGE_INCOMPLETE',
  'ADJACENT_CONTEXT_MISSING',
] as const

export type ProofIntegrityOutcome =
  typeof PROOF_INTEGRITY_OUTCOMES[number]
export type ProofIntegrityDimension =
  typeof PROOF_INTEGRITY_DIMENSIONS[number]
export type ProofIntegrityReasonCode =
  typeof PROOF_INTEGRITY_REASON_CODES[number]

export interface ProofIntegrityUseInput {
  proofNeedItemId: string
  includedContextRangeMs?: readonly [number, number]
  includedAdjacentEvidenceIds: readonly string[]
}

export interface ProofIntegrityCurrentRights
extends EvidenceRightsSnapshot {
  rightsExpiresAt?: string
  consentExpiresAt?: string
}

export interface ProofIntegrityComparison {
  dimension: ProofIntegrityDimension
  expected: readonly string[]
  actual: readonly string[]
  outcome: 'match' | 'mismatch' | 'missing' | 'expired'
  reasonCode?: ProofIntegrityReasonCode
}

export interface ProofIntegrityRecipeContext {
  nodeId: string
  nodeHash: string
  contextHash: string
  claimId: string
  claimText?: string
  productId: string
  person?: string
  period?: string
  audienceTags: readonly string[]
  consentRequirement: 'approved' | 'approved-or-not-required'
  contextHashBinding: string
}

export interface ProofIntegrityPresentationContract {
  schemaVersion: typeof PROOF_INTEGRITY_PRESENTATION_SCHEMA_VERSION
  evidenceId: string
  evidenceHash: string
  requiredContextRangeMs: readonly [number, number]
  requiredAdjacentEvidenceIds: readonly string[]
  visual: Readonly<{
    attribution: string
    qualifiers: readonly string[]
    mandatory: true
  }>
  verbal: Readonly<{
    attribution: string
    qualifiers: readonly string[]
    mandatory: true
  }>
  presentationHash: string
}

export interface ProofIntegrityIssue {
  code: 'PROOF_INTEGRITY_BLOCKED'
  severity: 'hard'
  reasonCodes: readonly ProofIntegrityReasonCode[]
  actions: readonly (
    | 'add-structured-recipe-context'
    | 'select-compatible-existing-evidence'
    | 'restore-required-evidence-context'
    | 'renew-rights-or-consent'
  )[]
  fabricationSuggested: false
  message: string
  issueHash: string
}

export interface ProofIntegrityEvaluation {
  id: string
  sequence: number
  proofNeedItemId: string
  proofNeedItemHash: string
  proofNeedResolution: ProofNeedItem['resolution']
  selectedEvidenceId?: string
  selectedEvidenceHash?: string
  recipeContext?: Readonly<ProofIntegrityRecipeContext>
  use: Readonly<{
    includedContextRangeMs?: readonly [number, number]
    includedAdjacentEvidenceIds: readonly string[]
  }>
  comparisons: readonly Readonly<ProofIntegrityComparison>[]
  outcome: ProofIntegrityOutcome
  allowedForAssembly: boolean
  presentation?: Readonly<ProofIntegrityPresentationContract>
  issue?: Readonly<ProofIntegrityIssue>
  fabricationSuggested: false
  evaluatedAt: string
  evaluationHash: string
}

export interface ProofIntegrityRun {
  schemaVersion: typeof PROOF_INTEGRITY_RUN_SCHEMA_VERSION
  policyVersion: typeof PROOF_INTEGRITY_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  targetRecipeId: string
  targetRecipeHash: string
  proofNeedRunId: string
  proofNeedRunHash: string
  evaluations: readonly Readonly<ProofIntegrityEvaluation>[]
  summary: Readonly<{
    evaluationCount: number
    approvedCount: number
    blockedCount: number
    notApplicableCount: number
    hardIssueCount: number
    fabricationSuggestionCount: 0
    readyForAssembly: boolean
  }>
  createdByClientId: string
  createdAt: string
  runHash: string
}

export interface ProofIntegrityItemSource {
  item: Readonly<ProofNeedItem>
  recipeNode?: Readonly<CompatibilityNode>
  evidence?: Readonly<CatalogedEvidenceSegment>
  currentRights?: Readonly<ProofIntegrityCurrentRights>
  use?: Readonly<ProofIntegrityUseInput>
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function range(
  value: unknown,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      Number.isSafeInteger(value[1]) &&
      value[0] >= 0 &&
      value[1] > value[0],
    'INVALID_ARGUMENT',
    `${field} must be a positive integer range`,
  )
  return Object.freeze([value[0], value[1]])
}

function optionalRange(
  value: unknown,
  field: string,
): readonly [number, number] | undefined {
  return value === undefined ? undefined : range(value, field)
}

function referenceList(
  value: unknown,
  field: string,
): readonly string[] {
  assertDomain(
    Array.isArray(value) && value.length <= 64,
    'INVALID_ARGUMENT',
    `${field} must contain at most 64 references`,
  )
  const result = value.map((entry, index) =>
    identity(entry, `${field}[${index}]`))
  assertDomain(
    new Set(result).size === result.length,
    'INVALID_ARGUMENT',
    `${field} contains duplicates`,
  )
  return Object.freeze(result.toSorted())
}

function normalized(value: string): string {
  return normalizeSpeechText(value)
}

function equalText(left: string, right: string): boolean {
  return normalized(left) === normalized(right)
}

function uniqueReasons(
  values: readonly ProofIntegrityReasonCode[],
): readonly ProofIntegrityReasonCode[] {
  return Object.freeze([...new Set(values)])
}

function comparison(input: {
  dimension: ProofIntegrityDimension
  expected: readonly string[]
  actual: readonly string[]
  outcome: ProofIntegrityComparison['outcome']
  reasonCode?: ProofIntegrityReasonCode
}): Readonly<ProofIntegrityComparison> {
  return Object.freeze({
    dimension: input.dimension,
    expected: Object.freeze([...input.expected]),
    actual: Object.freeze([...input.actual]),
    outcome: input.outcome,
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  })
}

function claimValue(
  node: Readonly<CompatibilityNode>,
  key: string,
): string | undefined {
  return node.claims.find((entry) => entry.key === key)?.value
}

function periodValues(
  evidence: Readonly<CatalogedEvidenceSegment>,
): readonly string[] {
  return Object.freeze(evidence.qualifiers.flatMap((qualifier) => {
    const match = qualifier.value.match(/^\s*period\s*[:=]\s*(.+?)\s*$/i)
    return match?.[1] ? [match[1]] : []
  }))
}

function recipeContext(
  item: Readonly<ProofNeedItem>,
  node: Readonly<CompatibilityNode>,
): Readonly<ProofIntegrityRecipeContext> {
  const claimText = claimValue(node, item.claimId)
  const person = claimValue(node, PROOF_INTEGRITY_PERSON_CLAIM_KEY)
  const period = claimValue(node, PROOF_INTEGRITY_PERIOD_CLAIM_KEY)
  const consentRequirement =
    item.type === 'demonstration'
      ? 'approved-or-not-required' as const
      : 'approved' as const
  const content = {
    nodeId: node.id,
    nodeHash: node.nodeHash,
    contextHash: node.contextHash,
    claimId: item.claimId,
    ...(claimText ? { claimText } : {}),
    productId: node.offerId,
    ...(person ? { person } : {}),
    ...(period ? { period } : {}),
    audienceTags: Object.freeze([...node.audienceTags]),
    consentRequirement,
  }
  return Object.freeze({
    ...content,
    contextHashBinding: calculateCanonicalHash(content),
  })
}

function presentationContract(
  evidence: Readonly<CatalogedEvidenceSegment>,
): Readonly<ProofIntegrityPresentationContract> {
  const qualifiers = Object.freeze(
    evidence.qualifiers.map((qualifier) => qualifier.value),
  )
  const body = {
    schemaVersion: PROOF_INTEGRITY_PRESENTATION_SCHEMA_VERSION,
    evidenceId: evidence.id,
    evidenceHash: evidence.evidenceHash,
    requiredContextRangeMs: evidence.contextRangeMs,
    requiredAdjacentEvidenceIds: evidence.adjacentEvidenceIds,
    visual: Object.freeze({
      attribution: evidence.attribution.value,
      qualifiers,
      mandatory: true as const,
    }),
    verbal: Object.freeze({
      attribution: evidence.attribution.value,
      qualifiers,
      mandatory: true as const,
    }),
  }
  return Object.freeze({
    ...body,
    presentationHash: calculateCanonicalHash(body),
  })
}

function actionsForReasons(
  reasons: readonly ProofIntegrityReasonCode[],
): ProofIntegrityIssue['actions'] {
  const actions = new Set<ProofIntegrityIssue['actions'][number]>()
  for (const reason of reasons) {
    if (reason.startsWith('RECIPE_')) {
      actions.add('add-structured-recipe-context')
    }
    if (
      reason === 'CONTEXT_RANGE_MISSING' ||
      reason === 'CONTEXT_RANGE_INCOMPLETE' ||
      reason === 'ADJACENT_CONTEXT_MISSING'
    ) {
      actions.add('restore-required-evidence-context')
    }
    if (
      reason.startsWith('RIGHTS_') ||
      reason.startsWith('CONSENT_')
    ) {
      actions.add('renew-rights-or-consent')
    }
    if (
      reason === 'PROOF_UNAVAILABLE' ||
      reason === 'EVIDENCE_MISSING' ||
      reason === 'EVIDENCE_IDENTITY_MISMATCH' ||
      reason.endsWith('_MISMATCH') ||
      reason === 'EVIDENCE_AUDIENCE_UNSPECIFIED' ||
      reason === 'EVIDENCE_INTEGRITY_BLOCKED'
    ) {
      actions.add('select-compatible-existing-evidence')
    }
  }
  if (actions.size === 0) {
    actions.add('select-compatible-existing-evidence')
  }
  return Object.freeze([...actions].toSorted())
}

function issue(
  reasons: readonly ProofIntegrityReasonCode[],
): Readonly<ProofIntegrityIssue> {
  const reasonCodes = uniqueReasons(reasons)
  const body = {
    code: 'PROOF_INTEGRITY_BLOCKED' as const,
    severity: 'hard' as const,
    reasonCodes,
    actions: actionsForReasons(reasonCodes),
    fabricationSuggested: false as const,
    message:
      'Uso da prova bloqueado. Complete o contexto da receita, restaure o contexto original da evidência, renove a autorização ou selecione uma evidência existente compatível.',
  }
  return Object.freeze({
    ...body,
    issueHash: calculateCanonicalHash(body),
  })
}

function evaluationBody(value: ProofIntegrityEvaluation) {
  return {
    id: value.id,
    sequence: value.sequence,
    proofNeedItemId: value.proofNeedItemId,
    proofNeedItemHash: value.proofNeedItemHash,
    proofNeedResolution: value.proofNeedResolution,
    ...(value.selectedEvidenceId
      ? { selectedEvidenceId: value.selectedEvidenceId }
      : {}),
    ...(value.selectedEvidenceHash
      ? { selectedEvidenceHash: value.selectedEvidenceHash }
      : {}),
    ...(value.recipeContext
      ? { recipeContext: value.recipeContext }
      : {}),
    use: value.use,
    comparisons: value.comparisons,
    outcome: value.outcome,
    allowedForAssembly: value.allowedForAssembly,
    ...(value.presentation
      ? { presentation: value.presentation }
      : {}),
    ...(value.issue ? { issue: value.issue } : {}),
    fabricationSuggested: value.fabricationSuggested,
    evaluatedAt: value.evaluatedAt,
  }
}

function buildEvaluation(input: {
  runId: string
  sequence: number
  source: Readonly<ProofIntegrityItemSource>
  evaluatedAt: string
}): Readonly<ProofIntegrityEvaluation> {
  const { item } = input.source
  const use = Object.freeze({
    ...(input.source.use?.includedContextRangeMs
      ? {
          includedContextRangeMs: range(
            input.source.use.includedContextRangeMs,
            `uses[${input.sequence - 1}].includedContextRangeMs`,
          ),
        }
      : {}),
    includedAdjacentEvidenceIds: referenceList(
      input.source.use?.includedAdjacentEvidenceIds ?? [],
      `uses[${input.sequence - 1}].includedAdjacentEvidenceIds`,
    ),
  })
  const id = `proof-integrity-evaluation-${calculateCanonicalHash({
    runId: input.runId,
    sequence: input.sequence,
    proofNeedItemId: item.id,
  }).slice(0, 40)}`

  if (item.resolution === 'no-proof-needed') {
    const body = {
      id,
      sequence: input.sequence,
      proofNeedItemId: item.id,
      proofNeedItemHash: item.itemHash,
      proofNeedResolution: item.resolution,
      use,
      comparisons: Object.freeze([]),
      outcome: 'not-applicable' as const,
      allowedForAssembly: false,
      fabricationSuggested: false as const,
      evaluatedAt: input.evaluatedAt,
    }
    return Object.freeze({
      ...body,
      evaluationHash: calculateCanonicalHash(body),
    })
  }

  if (item.resolution === 'proof-unavailable') {
    const blockedIssue = issue(['PROOF_UNAVAILABLE'])
    const body = {
      id,
      sequence: input.sequence,
      proofNeedItemId: item.id,
      proofNeedItemHash: item.itemHash,
      proofNeedResolution: item.resolution,
      use,
      comparisons: Object.freeze([]),
      outcome: 'blocked' as const,
      allowedForAssembly: false,
      issue: blockedIssue,
      fabricationSuggested: false as const,
      evaluatedAt: input.evaluatedAt,
    }
    return Object.freeze({
      ...body,
      evaluationHash: calculateCanonicalHash(body),
    })
  }

  const reasons: ProofIntegrityReasonCode[] = []
  const comparisons: ProofIntegrityComparison[] = []
  const selected = item.selectedEvidence
  const evidence = input.source.evidence
  const node = input.source.recipeNode
  const currentRights = input.source.currentRights
  const evidenceMatches =
    Boolean(selected) &&
    Boolean(evidence) &&
    selected!.id === evidence!.id &&
    selected!.evidenceHash === evidence!.evidenceHash

  if (!evidence || !selected) {
    reasons.push('EVIDENCE_MISSING')
  } else if (!evidenceMatches) {
    reasons.push('EVIDENCE_IDENTITY_MISMATCH')
  }

  const context = node ? recipeContext(item, node) : undefined
  if (!context?.claimText) reasons.push('RECIPE_CLAIM_UNSPECIFIED')
  if (
    context?.claimText &&
    !equalText(context.claimText, item.claimText)
  ) {
    reasons.push('RECIPE_CLAIM_MISMATCH')
  }
  if (!context?.person) reasons.push('RECIPE_PERSON_UNSPECIFIED')
  if (!context?.period) reasons.push('RECIPE_PERIOD_UNSPECIFIED')
  if (!context || context.audienceTags.length === 0) {
    reasons.push('RECIPE_AUDIENCE_UNSPECIFIED')
  }

  if (context) {
    const actualClaim = evidence ? [evidence.claim.value] : []
    const expectedClaim = context.claimText ? [context.claimText] : []
    const claimMatch =
      expectedClaim.length === 1 &&
      actualClaim.length === 1 &&
      equalText(expectedClaim[0]!, actualClaim[0]!)
    comparisons.push(comparison({
      dimension: 'claim',
      expected: expectedClaim,
      actual: actualClaim,
      outcome: expectedClaim.length === 0 || actualClaim.length === 0
        ? 'missing'
        : claimMatch ? 'match' : 'mismatch',
      ...(!claimMatch ? { reasonCode: 'CLAIM_MISMATCH' } : {}),
    }))
    if (!claimMatch) reasons.push('CLAIM_MISMATCH')

    const actualProducts = evidence?.compatibleOfferIds ?? []
    const productMatch = actualProducts.includes(context.productId)
    comparisons.push(comparison({
      dimension: 'product',
      expected: [context.productId],
      actual: actualProducts,
      outcome: actualProducts.length === 0
        ? 'missing'
        : productMatch ? 'match' : 'mismatch',
      ...(!productMatch ? { reasonCode: 'PRODUCT_MISMATCH' } : {}),
    }))
    if (!productMatch) reasons.push('PRODUCT_MISMATCH')

    const actualPerson = evidence ? [evidence.subject.value] : []
    const personMatch =
      Boolean(context.person) &&
      actualPerson.length === 1 &&
      equalText(context.person!, actualPerson[0]!)
    comparisons.push(comparison({
      dimension: 'person',
      expected: context.person ? [context.person] : [],
      actual: actualPerson,
      outcome: !context.person || actualPerson.length === 0
        ? 'missing'
        : personMatch ? 'match' : 'mismatch',
      ...(!personMatch ? { reasonCode: 'PERSON_MISMATCH' } : {}),
    }))
    if (!personMatch) reasons.push('PERSON_MISMATCH')

    const actualPeriods = evidence ? periodValues(evidence) : []
    const periodMatch =
      Boolean(context.period) &&
      actualPeriods.length === 1 &&
      equalText(context.period!, actualPeriods[0]!)
    comparisons.push(comparison({
      dimension: 'period',
      expected: context.period ? [context.period] : [],
      actual: actualPeriods,
      outcome: !context.period || actualPeriods.length === 0
        ? 'missing'
        : periodMatch ? 'match' : 'mismatch',
      ...(!periodMatch ? { reasonCode: 'PERIOD_MISMATCH' } : {}),
    }))
    if (!periodMatch) reasons.push('PERIOD_MISMATCH')

    const actualAudiences = evidence?.compatibleAudienceTags ?? []
    const audienceMatch =
      context.audienceTags.length > 0 &&
      actualAudiences.length > 0 &&
      context.audienceTags.every((expected) =>
        actualAudiences.some((actual) => equalText(expected, actual)))
    comparisons.push(comparison({
      dimension: 'audience',
      expected: context.audienceTags,
      actual: actualAudiences,
      outcome: context.audienceTags.length === 0 ||
        actualAudiences.length === 0
        ? 'missing'
        : audienceMatch ? 'match' : 'mismatch',
      ...(!audienceMatch ? { reasonCode: 'AUDIENCE_MISMATCH' } : {}),
    }))
    if (actualAudiences.length === 0) {
      reasons.push('EVIDENCE_AUDIENCE_UNSPECIFIED')
    }
    if (!audienceMatch) reasons.push('AUDIENCE_MISMATCH')
  }

  const now = Date.parse(input.evaluatedAt)
  const rightsExpired = Boolean(
    currentRights?.rightsExpiresAt &&
    Date.parse(currentRights.rightsExpiresAt) <= now,
  )
  const consentExpired = Boolean(
    currentRights?.consentExpiresAt &&
    Date.parse(currentRights.consentExpiresAt) <= now,
  )
  const rightsCurrent =
    Boolean(currentRights) &&
    Boolean(evidence) &&
    currentRights!.id === evidence!.rightsSnapshotId
  const rightsApproved =
    rightsCurrent &&
    currentRights!.rightsStatus === 'approved' &&
    !rightsExpired
  const consentApproved =
    Boolean(currentRights) &&
    !consentExpired &&
    (context?.consentRequirement === 'approved-or-not-required'
      ? ['approved', 'not-required'].includes(
          currentRights!.consentStatus,
        )
      : currentRights!.consentStatus === 'approved')
  comparisons.push(comparison({
    dimension: 'rights',
    expected: ['approved'],
    actual: currentRights ? [currentRights.rightsStatus] : [],
    outcome: !currentRights
      ? 'missing'
      : rightsExpired ? 'expired'
        : rightsApproved ? 'match' : 'mismatch',
    ...(!rightsApproved
      ? {
          reasonCode: rightsExpired
            ? 'RIGHTS_EXPIRED' as const
            : !rightsCurrent
              ? 'RIGHTS_SNAPSHOT_STALE' as const
              : 'RIGHTS_NOT_APPROVED' as const,
        }
      : {}),
  }))
  if (!rightsCurrent) reasons.push('RIGHTS_SNAPSHOT_STALE')
  if (rightsExpired) {
    reasons.push('RIGHTS_EXPIRED')
  } else if (!rightsApproved) {
    reasons.push('RIGHTS_NOT_APPROVED')
  }
  comparisons.push(comparison({
    dimension: 'consent',
    expected: context?.consentRequirement ===
      'approved-or-not-required'
      ? ['approved', 'not-required']
      : ['approved'],
    actual: currentRights ? [currentRights.consentStatus] : [],
    outcome: !currentRights
      ? 'missing'
      : consentExpired ? 'expired'
        : consentApproved ? 'match' : 'mismatch',
    ...(!consentApproved
      ? {
          reasonCode: consentExpired
            ? 'CONSENT_EXPIRED' as const
            : 'CONSENT_NOT_APPROVED' as const,
        }
      : {}),
  }))
  if (consentExpired) {
    reasons.push('CONSENT_EXPIRED')
  } else if (!consentApproved) {
    reasons.push('CONSENT_NOT_APPROVED')
  }

  if (evidence?.integrityStatus === 'blocked') {
    reasons.push('EVIDENCE_INTEGRITY_BLOCKED')
  }
  const requiredRange = evidence?.contextRangeMs
  const includedRange = use.includedContextRangeMs
  const contextRangeComplete = Boolean(
    requiredRange &&
    includedRange &&
    includedRange[0] <= requiredRange[0] &&
    includedRange[1] >= requiredRange[1],
  )
  const missingAdjacent = evidence
    ? evidence.adjacentEvidenceIds.filter((idValue) =>
        !use.includedAdjacentEvidenceIds.includes(idValue))
    : []
  comparisons.push(comparison({
    dimension: 'context',
    expected: [
      ...(requiredRange
        ? [`${requiredRange[0]}-${requiredRange[1]}`]
        : []),
      ...(evidence?.adjacentEvidenceIds ?? []),
    ],
    actual: [
      ...(includedRange
        ? [`${includedRange[0]}-${includedRange[1]}`]
        : []),
      ...use.includedAdjacentEvidenceIds,
    ],
    outcome: !includedRange
      ? 'missing'
      : contextRangeComplete && missingAdjacent.length === 0
        ? 'match'
        : 'mismatch',
    ...(!includedRange
      ? { reasonCode: 'CONTEXT_RANGE_MISSING' as const }
      : !contextRangeComplete
        ? { reasonCode: 'CONTEXT_RANGE_INCOMPLETE' as const }
        : missingAdjacent.length > 0
          ? { reasonCode: 'ADJACENT_CONTEXT_MISSING' as const }
          : {}),
  }))
  if (!includedRange) {
    reasons.push('CONTEXT_RANGE_MISSING')
  } else if (!contextRangeComplete) {
    reasons.push('CONTEXT_RANGE_INCOMPLETE')
  }
  if (missingAdjacent.length > 0) {
    reasons.push('ADJACENT_CONTEXT_MISSING')
  }

  const reasonCodes = uniqueReasons(reasons)
  const approved = reasonCodes.length === 0
  const evidencePresentation =
    evidence && evidenceMatches
      ? presentationContract(evidence)
      : undefined
  const blockedIssue = approved ? undefined : issue(reasonCodes)
  const body = {
    id,
    sequence: input.sequence,
    proofNeedItemId: item.id,
    proofNeedItemHash: item.itemHash,
    proofNeedResolution: item.resolution,
    ...(selected
      ? {
          selectedEvidenceId: selected.id,
          selectedEvidenceHash: selected.evidenceHash,
        }
      : {}),
    ...(context ? { recipeContext: context } : {}),
    use,
    comparisons: Object.freeze(comparisons),
    outcome: approved ? 'approved' as const : 'blocked' as const,
    allowedForAssembly: approved,
    ...(evidencePresentation
      ? { presentation: evidencePresentation }
      : {}),
    ...(blockedIssue ? { issue: blockedIssue } : {}),
    fabricationSuggested: false as const,
    evaluatedAt: input.evaluatedAt,
  }
  return Object.freeze({
    ...body,
    evaluationHash: calculateCanonicalHash(body),
  })
}

function runBody(value: ProofIntegrityRun) {
  return {
    schemaVersion: value.schemaVersion,
    policyVersion: value.policyVersion,
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    batchId: value.batchId,
    targetRecipeId: value.targetRecipeId,
    targetRecipeHash: value.targetRecipeHash,
    proofNeedRunId: value.proofNeedRunId,
    proofNeedRunHash: value.proofNeedRunHash,
    evaluations: value.evaluations,
    summary: value.summary,
    createdByClientId: value.createdByClientId,
    createdAt: value.createdAt,
  }
}

export function createProofIntegrityRun(input: {
  id: string
  workspaceId: string
  projectId: string
  proofNeedRun: Readonly<ProofNeedRun>
  sources: readonly Readonly<ProofIntegrityItemSource>[]
  createdByClientId: string
  createdAt: string
}): Readonly<ProofIntegrityRun> {
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const createdAt = instant(input.createdAt, 'createdAt')
  assertDomain(
    input.proofNeedRun.workspaceId === workspaceId &&
      input.proofNeedRun.projectId === projectId,
    'PRECONDITION_REQUIRED',
    'ProofIntegrity run requires a ProofNeed run in the same project',
  )
  assertDomain(
    input.sources.length === input.proofNeedRun.items.length &&
      input.sources.every((source, index) =>
        source.item.id === input.proofNeedRun.items[index]?.id &&
        source.item.itemHash ===
          input.proofNeedRun.items[index]?.itemHash),
    'PRECONDITION_REQUIRED',
    'ProofIntegrity sources must cover the exact ordered ProofNeed items',
  )
  const evaluations = Object.freeze(input.sources.map((source, index) =>
    buildEvaluation({
      runId: id,
      sequence: index + 1,
      source,
      evaluatedAt: createdAt,
    })))
  const summary = Object.freeze({
    evaluationCount: evaluations.length,
    approvedCount: evaluations.filter((entry) =>
      entry.outcome === 'approved').length,
    blockedCount: evaluations.filter((entry) =>
      entry.outcome === 'blocked').length,
    notApplicableCount: evaluations.filter((entry) =>
      entry.outcome === 'not-applicable').length,
    hardIssueCount: evaluations.filter((entry) =>
      entry.issue?.severity === 'hard').length,
    fabricationSuggestionCount: 0 as const,
    readyForAssembly: evaluations.every((entry) =>
      entry.outcome !== 'blocked'),
  })
  const body = {
    schemaVersion: PROOF_INTEGRITY_RUN_SCHEMA_VERSION,
    policyVersion: PROOF_INTEGRITY_POLICY_VERSION,
    id,
    workspaceId,
    projectId,
    batchId: input.proofNeedRun.batchId,
    targetRecipeId: input.proofNeedRun.targetRecipeId,
    targetRecipeHash: input.proofNeedRun.targetRecipeHash,
    proofNeedRunId: input.proofNeedRun.id,
    proofNeedRunHash: input.proofNeedRun.runHash,
    evaluations,
    summary,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt,
  }
  return Object.freeze({
    ...body,
    runHash: calculateCanonicalHash(body),
  })
}

export function hydrateProofIntegrityRun(
  value: Readonly<ProofIntegrityRun>,
): Readonly<ProofIntegrityRun> {
  assertDomain(
    value.schemaVersion === PROOF_INTEGRITY_RUN_SCHEMA_VERSION &&
      value.policyVersion === PROOF_INTEGRITY_POLICY_VERSION &&
      Array.isArray(value.evaluations) &&
      value.evaluations.length >= 1 &&
      value.evaluations.length <= 16,
    'PERSISTENCE_CONFLICT',
    'Persisted ProofIntegrity run version or evaluations are invalid',
  )
  for (const [index, evaluation] of value.evaluations.entries()) {
    assertDomain(
      evaluation.sequence === index + 1 &&
        evaluation.fabricationSuggested === false &&
        calculateCanonicalHash(evaluationBody(evaluation)) ===
          evaluation.evaluationHash &&
        (evaluation.outcome === 'approved'
          ? evaluation.allowedForAssembly &&
            !evaluation.issue &&
            Boolean(evaluation.presentation)
          : !evaluation.allowedForAssembly) &&
        (evaluation.outcome === 'blocked'
          ? Boolean(evaluation.issue) &&
            evaluation.issue.fabricationSuggested === false &&
            evaluation.issue.reasonCodes.length > 0
          : !evaluation.issue),
      'PERSISTENCE_CONFLICT',
      `Persisted ProofIntegrity evaluation ${index + 1} is invalid`,
    )
    if (evaluation.recipeContext) {
      const {
        contextHashBinding: _binding,
        ...contextBody
      } = evaluation.recipeContext
      assertDomain(
        calculateCanonicalHash(contextBody) ===
          evaluation.recipeContext.contextHashBinding,
        'PERSISTENCE_CONFLICT',
        `Persisted ProofIntegrity recipe context ${index + 1} is invalid`,
      )
    }
    if (evaluation.presentation) {
      const {
        presentationHash: _presentationHash,
        ...presentationBody
      } = evaluation.presentation
      assertDomain(
        stableSerialize(evaluation.presentation.visual) ===
          stableSerialize(evaluation.presentation.verbal) &&
          calculateCanonicalHash(presentationBody) ===
            evaluation.presentation.presentationHash,
        'PERSISTENCE_CONFLICT',
        `Persisted ProofIntegrity presentation ${index + 1} is invalid`,
      )
    }
    if (evaluation.issue) {
      const { issueHash: _issueHash, ...issueBody } = evaluation.issue
      assertDomain(
        evaluation.issue.code === 'PROOF_INTEGRITY_BLOCKED' &&
          evaluation.issue.severity === 'hard' &&
          !evaluation.issue.actions.some((action: string) =>
            action.includes('generate') ||
            action.includes('fabricate')) &&
          calculateCanonicalHash(issueBody) === evaluation.issue.issueHash,
        'PERSISTENCE_CONFLICT',
        `Persisted ProofIntegrity issue ${index + 1} is invalid`,
      )
    }
  }
  const expectedSummary = {
    evaluationCount: value.evaluations.length,
    approvedCount: value.evaluations.filter((entry) =>
      entry.outcome === 'approved').length,
    blockedCount: value.evaluations.filter((entry) =>
      entry.outcome === 'blocked').length,
    notApplicableCount: value.evaluations.filter((entry) =>
      entry.outcome === 'not-applicable').length,
    hardIssueCount: value.evaluations.filter((entry) =>
      entry.issue?.severity === 'hard').length,
    fabricationSuggestionCount: 0,
    readyForAssembly: value.evaluations.every((entry) =>
      entry.outcome !== 'blocked'),
  }
  assertDomain(
    stableSerialize(value.summary) === stableSerialize(expectedSummary) &&
      value.summary.fabricationSuggestionCount === 0 &&
      calculateCanonicalHash(runBody(value)) === value.runHash,
    'PERSISTENCE_CONFLICT',
    'Persisted ProofIntegrity summary or run hash is invalid',
  )
  return Object.freeze(value)
}

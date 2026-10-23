// The regression case of the Imersao master recovery E2E (a one-off test: 31 de janeiro, 1o de fevereiro, dois dias).
// This content belongs to tests/ only. The product never carries it as a rule, a default or an example: the Apollo removes
// what each video's own request names (the `rules` of a `remove-spoken-content` Command).
import { DomainError } from '../../../src/v2/domain/errors.ts'
import {
  deriveEditorialExclusions,
} from '../../../src/v2/application/editorial-phrase-rules.ts'

export const RECOVERY_EDITORIAL_EXCLUSION_RULES = Object.freeze([
  Object.freeze({
    id: 'date-january-31',
    label: '31 de janeiro',
    alternatives: Object.freeze([
      Object.freeze(['31', 'de', 'janeiro']),
      Object.freeze(['trinta', 'e', 'um', 'de', 'janeiro']),
    ]),
  }),
  Object.freeze({
    id: 'date-february-1',
    label: '1 de fevereiro',
    alternatives: Object.freeze([
      Object.freeze(['1', 'de', 'fevereiro']),
      Object.freeze(['primeiro', 'de', 'fevereiro']),
    ]),
  }),
  Object.freeze({
    id: 'duration-two-days',
    label: 'dois dias',
    alternatives: Object.freeze([
      Object.freeze(['dois', 'dias']),
      Object.freeze(['2', 'dias']),
    ]),
  }),
])

/** The same rules as a user sends them in a `remove-spoken-content` Command: phrases, not tokens. */
export const RECOVERY_REQUESTED_REMOVAL_RULES = Object.freeze(RECOVERY_EDITORIAL_EXCLUSION_RULES.map((rule) =>
  Object.freeze({ id: rule.id, label: rule.label, alternatives: Object.freeze(rule.alternatives.map((tokens) => tokens.join(' '))) })))

export function deriveRecoveryEditorialExclusions(transcript) {
  return deriveEditorialExclusions(transcript, RECOVERY_EDITORIAL_EXCLUSION_RULES)
}

function overlaps(left, right) {
  return left.sourceStartSeconds < right.sourceEndSeconds - 0.001 &&
    right.sourceStartSeconds < left.sourceEndSeconds - 0.001
}

export function validateRecoveryEditorialAcceptance(input) {
  const exclusions = deriveRecoveryEditorialExclusions(input.transcript)
  const matchedRuleIds = new Set(exclusions.flatMap((range) => range.ruleIds))
  const missing = RECOVERY_EDITORIAL_EXCLUSION_RULES
    .map((rule) => rule.id)
    .filter((ruleId) => !matchedRuleIds.has(ruleId))
  if (missing.length > 0) {
    throw new DomainError(
      'EDITORIAL_ACCEPTANCE_FAILED',
      'The recovery master does not prove every required editorial exclusion',
      { missingRuleIds: missing },
    )
  }
  const retainedForbidden = exclusions.filter((exclusion) =>
    input.retainedSourceRanges.some((retained) => overlaps(exclusion, retained)),
  )
  if (retainedForbidden.length > 0) {
    throw new DomainError(
      'EDITORIAL_ACCEPTANCE_FAILED',
      'The EditPlan still retains forbidden date or duration speech',
      {
        retainedRuleIds: [...new Set(retainedForbidden.flatMap((range) => range.ruleIds))],
        retainedRanges: retainedForbidden.map((range) => ({
          sourceStartSeconds: range.sourceStartSeconds,
          sourceEndSeconds: range.sourceEndSeconds,
        })),
      },
    )
  }
  return Object.freeze({
    accepted: true,
    excludedRuleIds: Object.freeze([...matchedRuleIds].sort()),
    exclusions,
  })
}

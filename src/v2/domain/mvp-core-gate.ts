export const MVP_CORE_ACCEPTANCE_CRITERIA = Object.freeze(Array.from({ length: 16 }, (_, index) => `AC-${String(index + 1).padStart(3, '0')}`))
export const QUALITY_API_ACTIONS = Object.freeze(['select-asset', 'critique-asset', 'critique-proxy', 'validate', 'compile-patches', 'iterate', 'report', 'mvp-gate'] as const)
export interface GateEvidence { criterion: string; automatic: boolean; passed: boolean; reference: string }

export function evaluateMvpCoreGate(evidence: readonly GateEvidence[]) {
  const byCriterion = new Map(evidence.map((item) => [item.criterion, item]))
  const missing = MVP_CORE_ACCEPTANCE_CRITERIA.filter((criterion) => !byCriterion.has(criterion))
  const failed = evidence.filter((item) => !item.passed).map((item) => item.criterion)
  const withoutAutomaticEvidence = evidence.filter((item) => !item.automatic).map((item) => item.criterion)
  const approved = missing.length === 0 && failed.length === 0 && withoutAutomaticEvidence.length === 0
  return Object.freeze({ gate: 'mvp-core/v1', approved, covered: MVP_CORE_ACCEPTANCE_CRITERIA.length - missing.length, total: MVP_CORE_ACCEPTANCE_CRITERIA.length, missing: Object.freeze(missing), failed: Object.freeze(failed), withoutAutomaticEvidence: Object.freeze(withoutAutomaticEvidence), evidence: Object.freeze([...evidence]) })
}

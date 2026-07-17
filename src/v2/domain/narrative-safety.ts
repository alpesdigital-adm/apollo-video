export interface NarrativeStatement {
  id: string; speakerId: string; rangeMs: readonly [number, number]; text: string; claimType: 'promise' | 'testimony' | 'comparison' | 'fact'
  qualifierTokens: readonly string[]; negationTokens: readonly string[]; causalTokens: readonly string[]; deadlineTokens: readonly string[]
  proofIds: readonly string[]; requiredContextIds: readonly string[]
}
export interface NarrativeEditItem { statementId: string; speakerId: string; preservedText: string }
export interface NarrativeQualityIssue { code: string; severity: 'block'; statementId: string; rangeMs: readonly [number, number]; evidence: readonly string[]; correction: { kind: 'restore-context' | 'restore-token' | 'restore-attribution' | 'restore-proof'; refs: readonly string[] } }

export function validateNarrativeEdit(statements: readonly NarrativeStatement[], edit: readonly NarrativeEditItem[]): Readonly<{ safe: boolean; issues: readonly NarrativeQualityIssue[] }> {
  const byId = new Map(statements.map((statement) => [statement.id, statement])); const selected = new Set(edit.map((item) => item.statementId)); const order = new Map(edit.map((item, index) => [item.statementId, index])); const issues: NarrativeQualityIssue[] = []
  const add = (statement: NarrativeStatement, code: string, evidence: readonly string[], kind: NarrativeQualityIssue['correction']['kind'], refs: readonly string[]) => issues.push({ code, severity: 'block', statementId: statement.id, rangeMs: statement.rangeMs, evidence: Object.freeze([...evidence]), correction: Object.freeze({ kind, refs: Object.freeze([...refs]) }) })
  for (const item of edit) {
    const statement = byId.get(item.statementId); if (!statement) continue
    if (item.speakerId !== statement.speakerId) add(statement, 'ATTRIBUTION_CHANGED', [statement.speakerId, item.speakerId], 'restore-attribution', [statement.speakerId])
    for (const [tokens, code] of [[statement.qualifierTokens, 'QUALIFIER_REMOVED'], [statement.negationTokens, 'NEGATION_REMOVED'], [statement.causalTokens, 'CAUSALITY_CHANGED'], [statement.deadlineTokens, 'DEADLINE_REMOVED']] as const) {
      const missing = tokens.filter((token) => !item.preservedText.toLocaleLowerCase().includes(token.toLocaleLowerCase())); if (missing.length) add(statement, code, missing, 'restore-token', missing)
    }
    const missingProof = statement.proofIds.filter((id) => !selected.has(id)); if (missingProof.length) add(statement, 'PROOF_CONTEXT_REMOVED', missingProof, 'restore-proof', missingProof)
    const missingContext = statement.requiredContextIds.filter((id) => !selected.has(id)); if (missingContext.length) add(statement, 'REQUIRED_CONTEXT_REMOVED', missingContext, 'restore-context', missingContext)
    const reorderedContext = statement.requiredContextIds.filter((id) => selected.has(id) && order.get(id)! > order.get(statement.id)!); if (reorderedContext.length) add(statement, 'CONTEXT_REORDERED_AFTER_CLAIM', reorderedContext, 'restore-context', reorderedContext)
  }
  return Object.freeze({ safe: issues.length === 0, issues: Object.freeze(issues) })
}

export const NARRATIVE_POLICY_FIXTURES = Object.freeze({
  promise: { id: 'promise', speakerId: 'expert', rangeMs: [0, 3000], text: 'Pode melhorar em até 30 dias', claimType: 'promise', qualifierTokens: ['pode'], negationTokens: [], causalTokens: [], deadlineTokens: ['até 30 dias'], proofIds: ['proof'], requiredContextIds: [] },
  testimony: { id: 'testimony', speakerId: 'client', rangeMs: [3000, 6000], text: 'Eu tive resultado', claimType: 'testimony', qualifierTokens: [], negationTokens: [], causalTokens: [], deadlineTokens: [], proofIds: [], requiredContextIds: ['context'] },
  comparison: { id: 'comparison', speakerId: 'expert', rangeMs: [6000, 9000], text: 'Não é mais rápido por acaso', claimType: 'comparison', qualifierTokens: [], negationTokens: ['não'], causalTokens: ['por acaso'], deadlineTokens: [], proofIds: [], requiredContextIds: [] },
  context: { id: 'context', speakerId: 'client', rangeMs: [9000, 11000], text: 'No meu caso específico', claimType: 'fact', qualifierTokens: ['específico'], negationTokens: [], causalTokens: [], deadlineTokens: [], proofIds: [], requiredContextIds: [] },
  proof: { id: 'proof', speakerId: 'expert', rangeMs: [11000, 13000], text: 'Dados observados', claimType: 'fact', qualifierTokens: [], negationTokens: [], causalTokens: [], deadlineTokens: [], proofIds: [], requiredContextIds: [] }
} satisfies Record<string, NarrativeStatement>)

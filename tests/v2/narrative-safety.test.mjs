import test from 'node:test'
import assert from 'node:assert/strict'
import { NARRATIVE_POLICY_FIXTURES, validateNarrativeEdit } from '../../src/v2/domain/narrative-safety.ts'

const values = Object.values(NARRATIVE_POLICY_FIXTURES)
const preserved = (id, text = NARRATIVE_POLICY_FIXTURES[id].text, speakerId = NARRATIVE_POLICY_FIXTURES[id].speakerId) => ({ statementId: id, speakerId, preservedText: text })
test('T-FR-063 blocks trim that removes qualifiers, negation, causality, deadlines or proof', () => {
  const result = validateNarrativeEdit(values, [preserved('promise', 'Melhora em 30 dias'), preserved('comparison', 'É mais rápido'), preserved('proof')])
  assert.equal(result.safe, false)
  assert.deepEqual(new Set(result.issues.map((issue) => issue.code)), new Set(['QUALIFIER_REMOVED', 'DEADLINE_REMOVED', 'NEGATION_REMOVED', 'CAUSALITY_CHANGED']))
  assert.equal(result.issues.every((issue) => issue.rangeMs.length === 2 && issue.evidence.length && issue.correction.refs.length), true)
})
test('T-FR-063 blocks attribution/reorder/context removal and accepts meaning-preserving composition', () => {
  const changed = validateNarrativeEdit(values, [preserved('testimony', undefined, 'expert'), preserved('context')])
  assert.deepEqual(changed.issues.map((issue) => issue.code), ['ATTRIBUTION_CHANGED', 'CONTEXT_REORDERED_AFTER_CLAIM'])
  const safe = validateNarrativeEdit(values, [preserved('context'), preserved('testimony'), preserved('proof'), preserved('promise'), preserved('comparison')])
  assert.equal(safe.safe, true)
  assert.deepEqual(Object.keys(NARRATIVE_POLICY_FIXTURES), ['promise', 'testimony', 'comparison', 'context', 'proof'])
})

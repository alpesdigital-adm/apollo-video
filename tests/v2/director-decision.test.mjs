import test from 'node:test'
import assert from 'node:assert/strict'
import { createDirectorDecision, traceDecisionToFrames } from '../../src/v2/domain/director-decision.ts'

const input = { id: 'decision-1', runId: 'run-1', planNodeId: 'node-proof', commandId: 'command-7', artifactId: 'final-1', actor: { type: 'agent', id: 'director-v1' }, decision: 'Use testimony segment', candidates: [{ id: 'seg-a', outcome: 'selected', reason: 'best evidence' }, { id: 'seg-b', outcome: 'rejected', reason: 'rights review' }], evidence: [{ ref: 'perception:obs-9', rangeMs: [1000, 4000] }], confidence: .91, score: .87, cost: { estimated: .2, actual: .18, currency: 'USD' }, summary: 'Depoimento A escolhido por evidência e direito liberado.', createdAt: '2026-07-17T20:00:00.000Z' }
test('T-FR-065 persists decision, alternatives, evidence, confidence, score, cost and actor with links', () => {
  const decision = createDirectorDecision(input)
  assert.equal(decision.runId, 'run-1'); assert.equal(decision.planNodeId, 'node-proof'); assert.equal(decision.commandId, 'command-7'); assert.equal(decision.artifactId, 'final-1')
  assert.equal(decision.candidates.length, 2); assert.equal(decision.evidence.length, 1); assert.deepEqual(decision.cost, { estimated: .2, actual: .18, currency: 'USD' })
})
test('T-FR-065 traces a decision through plan node and artifact to exact final frames', () => {
  const decision = createDirectorDecision(input)
  assert.deepEqual(traceDecisionToFrames(decision, [{ artifactId: 'final-1', planNodeId: 'node-proof', fromFrame: 120, toFrame: 240 }, { artifactId: 'other', planNodeId: 'node-proof', fromFrame: 0, toFrame: 1 }]), { decisionId: 'decision-1', runId: 'run-1', commandId: 'command-7', artifactId: 'final-1', frames: [{ from: 120, to: 240 }] })
  assert.throws(() => traceDecisionToFrames(decision, []), /lineage/)
})

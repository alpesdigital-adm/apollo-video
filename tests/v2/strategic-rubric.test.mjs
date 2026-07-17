import assert from 'node:assert/strict'
import test from 'node:test'
import { STRATEGIC_RUBRICS, STRATEGIC_RUBRIC_REFERENCE_SET, createQualityReport, qualityReportSnapshot } from '../../src/v2/domain/strategic-rubric.ts'

test('eight versioned rubrics have normalized weights, explicit gates and non-causal thresholds', () => {
  assert.equal(STRATEGIC_RUBRICS.length, 8)
  for (const rubric of STRATEGIC_RUBRICS) {
    assert.ok(Math.abs(rubric.criteria.reduce((sum, criterion) => sum + criterion.weight, 0) - 1) < 1e-9)
    assert.equal(rubric.purpose, 'editorial-quality-proxy')
    assert.ok(rubric.requiredGates.includes('narrative-integrity'))
    assert.ok(rubric.requiredGates.includes('legibility'))
    assert.ok(rubric.requiredGates.includes('rights-compliance'))
  }
  assert.equal(STRATEGIC_RUBRIC_REFERENCE_SET.length, 24)
  assert.equal(new Set(STRATEGIC_RUBRIC_REFERENCE_SET.map((item) => item.id)).size, 24)
})

test('QualityReport persists rubric scores and evidence but hard gates override a high score', () => {
  const rubric = STRATEGIC_RUBRICS.find((item) => item.objective === 'sale')
  const evidence = rubric.criteria.map(({ id }) => ({ criterionId: id, score: 95, evidence: [`observed:${id}`] }))
  const blocked = createQualityReport({ objective: 'sale', evidence, gates: { narrativeIntegrity: true, legibility: true, rights: true, ctaPresent: false }, evaluatedAt: '2026-07-17T00:00:00.000Z' })
  assert.equal(blocked.score, 95)
  assert.equal(blocked.passed, false)
  assert.deepEqual(blocked.gateFailures, ['cta-required'])
  const snapshot = qualityReportSnapshot(blocked)
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.parse(snapshot.contentJson).rubric.version, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { STRATEGIC_RUBRICS, STRATEGIC_RUBRIC_REFERENCE_SET, createQualityReport, parseStrategicQualityReport, qualityReportSnapshot } from '../../src/v2/domain/strategic-rubric.ts'

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
  for (const reference of STRATEGIC_RUBRIC_REFERENCE_SET) {
    const report = createQualityReport({
      objective: reference.objective,
      evidence: reference.criterionScores,
      gates: reference.gates,
      evaluatedAt: '2026-07-17T00:00:00.000Z',
    })
    assert.ok(report.score >= reference.expectedBand[0] && report.score <= reference.expectedBand[1])
    assert.equal(report.passed, reference.expectedPassed)
    assert.equal(reference.note, 'Editorial reference only; it does not assert commercial causality.')
  }
})

test('QualityReport persists rubric scores and evidence but hard gates override a high score', () => {
  const rubric = STRATEGIC_RUBRICS.find((item) => item.objective === 'sale')
  const evidence = rubric.criteria.map(({ id }) => ({ criterionId: id, score: 95, evidence: [`observed:${id}`] }))
  const blocked = createQualityReport({ objective: 'sale', evidence, gates: { narrativeIntegrity: true, legibility: true, rights: true, ctaPresent: false }, evaluatedAt: '2026-07-17T00:00:00.000Z' })
  assert.equal(blocked.score, 95)
  assert.equal(blocked.passed, false)
  assert.deepEqual(blocked.gateFailures, ['cta-required'])
  assert.deepEqual(blocked.gateResults.find((gate) => gate.id === 'cta-required'), {
    id: 'cta-required', passed: false, evidence: ['gate:cta-required:fail'],
  })
  const snapshot = qualityReportSnapshot(blocked)
  assert.match(snapshot.contentHash, /^[a-f0-9]{64}$/)
  assert.equal(JSON.parse(snapshot.contentJson).rubric.version, 1)
  assert.equal(JSON.parse(snapshot.contentJson).rubric.threshold, 78)
  assert.equal(JSON.parse(snapshot.contentJson).schemaVersion, 'strategic-quality-report/v1')
})

test('strategic quality evidence is exact, bounded and deterministic', () => {
  const rubric = STRATEGIC_RUBRICS.find((item) => item.objective === 'discovery')
  const evidence = rubric.criteria.map(({ id }) => ({
    criterionId: id, score: 80, evidence: [`observed:${id}`],
  }))
  const input = {
    objective: 'discovery', evidence,
    gates: { narrativeIntegrity: true, legibility: true, rights: true },
    evaluatedAt: '2026-07-17T00:00:00.000Z',
  }
  assert.deepEqual(createQualityReport(input), createQualityReport(input))
  const report = createQualityReport(input)
  assert.deepEqual(parseStrategicQualityReport(JSON.parse(JSON.stringify(report))), report)
  assert.throws(
    () => parseStrategicQualityReport({ ...report, score: report.score + 1 }),
    (error) => error?.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(() => createQualityReport({ ...input, evidence: [...evidence, evidence[0]] }), /every rubric criterion exactly once/)
  assert.throws(() => createQualityReport({ ...input, evidence: evidence.slice(1) }), /every rubric criterion exactly once/)
  assert.throws(() => createQualityReport({
    ...input,
    evidence: evidence.map((item, index) => index === 0 ? { ...item, evidence: [] } : item),
  }), /Missing or invalid evidence/)
  assert.throws(() => createQualityReport({ ...input, evaluatedAt: 'not-a-date' }), /evaluatedAt is invalid/)
})

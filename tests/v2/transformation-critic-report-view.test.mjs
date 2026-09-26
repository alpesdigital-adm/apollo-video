import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRANSFORMATION_CRITIC_ACTIONS,
  TRANSFORMATION_CRITIC_DECISIONS,
  TRANSFORMATION_CRITIC_STATUSES,
  TRANSFORMATION_EVALUATOR_KINDS,
} from '../../src/v2/domain/transformation-critic-report.ts'
import {
  CRITIC_ACTION_LABELS,
  CRITIC_DECISION_LABELS,
  CRITIC_EVALUATOR_KIND_LABELS,
  CRITIC_SEVERITY_LABELS,
  CRITIC_STATUS_LABELS,
  criticLabel,
  formatBasisPoints,
  formatCriticEvaluatedAt,
  frameRangeLabel,
  matchesTransformationCriticReportReference,
  resolveMeasurementOrigin,
  viewerFailureText,
} from '../../src/v2/ui/transformation-critic-report-view.ts'

/**
 * The reading rules of the inline critic report viewer (Wave 27). The viewer
 * shows an answer only when it is the referenced report, and every number or
 * origin it prints is exactly what the record says — an absent score is not a
 * zero and a controlled stand-in is not a real measurement.
 */

const reference = Object.freeze({ id: 'critic-report-1', hash: 'e'.repeat(64) })
const report = Object.freeze({ id: 'critic-report-1', reportHash: 'e'.repeat(64), projectId: 'project-1' })
const evaluators = Object.freeze([
  Object.freeze({ id: 'ffprobe-integrity', kind: 'measured', version: '1.2.0' }),
  Object.freeze({ id: 'identity-stand-in', kind: 'controlled', version: '0.3.0' }),
])

test('a report is shown only when project, id and hash all match the gate reference', () => {
  assert.equal(matchesTransformationCriticReportReference({ report, projectId: 'project-1', reference }), true)
  assert.equal(matchesTransformationCriticReportReference({
    report: { ...report, projectId: 'project-2' }, projectId: 'project-1', reference,
  }), false, 'a report of another project')
  assert.equal(matchesTransformationCriticReportReference({
    report: { ...report, id: 'critic-report-2' }, projectId: 'project-1', reference,
  }), false, 'another report id')
  assert.equal(matchesTransformationCriticReportReference({
    report: { ...report, reportHash: 'f'.repeat(64) }, projectId: 'project-1', reference,
  }), false, 'the same id with another hash')
  assert.equal(matchesTransformationCriticReportReference({ report, projectId: 'project-2', reference }), false,
    'the screen asked for another project')
})

test('an absent score reads as unavailable and never as zero', () => {
  assert.equal(formatBasisPoints(null), 'indisponível')
  assert.notEqual(formatBasisPoints(null), '0 bps')
  assert.equal(formatBasisPoints(undefined), 'indisponível')
  assert.equal(formatBasisPoints(Number.NaN), 'indisponível')
  assert.equal(formatBasisPoints(0), '0 bps', 'a measured zero is still a measurement')
  assert.equal(formatBasisPoints(8_500), '8500 bps')
})

test('ranges are stated in frames and never converted to seconds', () => {
  assert.equal(frameRangeLabel({ startFrame: 12, endFrame: 47 }), 'quadros 12–47')
  assert.equal(frameRangeLabel({ startFrame: 0, endFrame: 0 }), 'quadros 0–0')
  assert.equal(frameRangeLabel(null), 'resultado inteiro')
  for (const label of [frameRangeLabel({ startFrame: 30, endFrame: 90 }), frameRangeLabel(null)]) {
    assert.doesNotMatch(label, /\d\s*s\b|segundo|\bsec/i, label)
  }
})

test('a measurement names its evaluator and never passes a controlled stand-in off as a real measurement', () => {
  const measured = resolveMeasurementOrigin({ evaluatorId: 'ffprobe-integrity' }, evaluators)
  assert.deepEqual(measured, {
    evaluatorId: 'ffprobe-integrity',
    kind: 'measured',
    label: 'origem: ffprobe-integrity · medição real · v1.2.0',
  })
  const controlled = resolveMeasurementOrigin({ evaluatorId: 'identity-stand-in' }, evaluators)
  assert.deepEqual(controlled, {
    evaluatorId: 'identity-stand-in',
    kind: 'controlled',
    label: 'origem: identity-stand-in · prova controlada · v0.3.0',
  })
  assert.doesNotMatch(controlled.label, /medição real/)
  assert.deepEqual(resolveMeasurementOrigin({}, evaluators), {
    evaluatorId: '', kind: '', label: 'origem não informada',
  }, 'a measurement without evaluator')
  assert.deepEqual(resolveMeasurementOrigin({ evaluatorId: 'not-declared' }, evaluators), {
    evaluatorId: 'not-declared', kind: '', label: 'origem não informada',
  }, 'an evaluator the report does not declare keeps its id but claims no kind')
  assert.deepEqual(resolveMeasurementOrigin({ evaluatorId: 'odd' }, [{ id: 'odd', kind: 'perceptual', version: '1' }]), {
    evaluatorId: 'odd', kind: '', label: 'origem não informada',
  }, 'an unknown evaluator kind is never presented as either kind')
})

test('the viewer failure texts name what the operator can do', () => {
  assert.equal(viewerFailureText({ kind: 'forbidden', status: 403, message: 'server text' }),
    'Esta sessão não pode consultar o relatório crítico.')
  assert.equal(viewerFailureText({ kind: 'rate-limited', retryAfterMs: 2_000, message: 'server text' }),
    'O servidor pediu uma pausa de 2 s antes de consultar o relatório novamente.')
  assert.equal(viewerFailureText({ kind: 'rate-limited', retryAfterMs: 1_200, message: 'server text' }),
    'O servidor pediu uma pausa de 2 s antes de consultar o relatório novamente.',
    'a remaining wait is rounded up, never shortened')
  assert.equal(viewerFailureText({ kind: 'rate-limited', message: 'server text' }),
    'O servidor pediu uma pausa antes de consultar o relatório novamente.')
  assert.equal(viewerFailureText({ kind: 'error', code: 'ASSET_NOT_FOUND', message: 'Transformation critic report was not found' }),
    'Relatório não encontrado neste projeto (ASSET_NOT_FOUND).')
  assert.equal(viewerFailureText({ kind: 'identity', message: '' }),
    'O relatório retornado não corresponde à referência selecionada (projeto, ID ou hash divergente).')
  assert.equal(viewerFailureText({ kind: 'error', code: 'INVALID_ARGUMENT', message: 'A leitura falhou no servidor (HTTP 422).' }),
    'A leitura falhou no servidor (HTTP 422).', 'any other refusal keeps the classified message')
})

test('every value the domain can record has a label, and an unknown one is shown as received', () => {
  for (const decision of TRANSFORMATION_CRITIC_DECISIONS) assert.ok(CRITIC_DECISION_LABELS[decision], decision)
  for (const action of TRANSFORMATION_CRITIC_ACTIONS) assert.ok(CRITIC_ACTION_LABELS[action], action)
  for (const status of TRANSFORMATION_CRITIC_STATUSES) assert.ok(CRITIC_STATUS_LABELS[status], status)
  for (const kind of TRANSFORMATION_EVALUATOR_KINDS) assert.ok(CRITIC_EVALUATOR_KIND_LABELS[kind], kind)
  for (const severity of ['blocking', 'major', 'minor']) assert.ok(CRITIC_SEVERITY_LABELS[severity], severity)
  assert.equal(criticLabel(CRITIC_DECISION_LABELS, 'rejected'), 'Rejeitado')
  assert.equal(criticLabel(CRITIC_DECISION_LABELS, 'escalated'), 'escalated')
  assert.equal(criticLabel(CRITIC_DECISION_LABELS, 'constructor'), 'constructor',
    'a prototype member is never rendered as a label')
})

test('an evaluation instant that cannot be read is shown as received instead of failing the render', () => {
  assert.equal(formatCriticEvaluatedAt('not-an-instant'), 'not-an-instant')
  assert.notEqual(formatCriticEvaluatedAt('2029-03-01T10:04:12.000Z'), '2029-03-01T10:04:12.000Z')
})

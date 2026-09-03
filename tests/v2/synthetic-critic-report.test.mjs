import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SYNTHETIC_CRITIC_DIMENSIONS,
  assertSyntheticCriticReportIntegrity,
  createSyntheticCriticReport,
  isSyntheticCriticApproval,
} from '../../src/v2/domain/synthetic-critic-report.ts'

const digest = (character) => character.repeat(64)

const evaluators = [
  { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'duration, codecs, frames and audio presence read from the artifact' },
  { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'words spoken compared to the approved script, word by word' },
  { id: 'controlled-identity-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in for an identity model that is not deployed' },
]

const measured = (dimension, evaluatorId, value, unit, threshold) => ({
  dimension, status: 'measured', evaluatorId, value, unit, threshold,
  confidence: 1, evidenceRefs: [`evidence://${dimension}`], range: null, note: null,
})
const unavailable = (dimension, note) => ({
  dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
  threshold: null, confidence: null, evidenceRefs: [], range: null, note,
})

const baseMeasurements = [
  measured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
  measured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'ratio', 1),
  measured('pronunciation', 'alignment-pronunciation', 0, 'missing-words', 0),
  measured('lip-sync', 'controlled-identity-probe', 0.94, 'ratio', 0.9),
  measured('identity', 'controlled-identity-probe', 0.97, 'ratio', 0.9),
  measured('continuity', 'ffprobe-media-integrity', 0, 'ms-gap', 0),
  unavailable('visual-artifacts', 'no artifact detector is deployed'),
  unavailable('framing', 'no framing model is deployed'),
  unavailable('eyes', 'no eye model is deployed'),
  unavailable('teeth', 'no teeth model is deployed'),
  unavailable('hands', 'no hand model is deployed'),
]

const base = {
  id: 'critic-report-1', workspaceId: 'workspace-1', projectId: 'project-1', blockId: 'block-1',
  capability: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
  artifactId: 'artifact-video', artifactSha256: digest('a'),
  audioArtifactId: 'artifact-audio', alignmentArtifactId: 'artifact-alignment',
  scriptHash: digest('b'), profileSnapshotId: 'ana:v2', expectedIdentityRef: 'avatar_ana',
  evaluators, measurements: baseMeasurements, issues: [],
  decision: 'approved', recommendedAction: 'none',
  thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/v1',
  decidedAt: '2026-08-31T12:00:00.000Z',
}

test('T-FR-106 a report answers for every dimension and never hides what it could not measure', () => {
  const report = createSyntheticCriticReport(base)

  assert.deepEqual(report.measurements.map((entry) => entry.dimension), [...SYNTHETIC_CRITIC_DIMENSIONS])
  assert.match(report.reportHash, /^[a-f0-9]{64}$/)
  assert.equal(assertSyntheticCriticReportIntegrity(report), report)

  // A controlled evaluator is labelled as such, so nobody can read it as
  // production visual validation.
  const identity = report.measurements.find((entry) => entry.dimension === 'identity')
  assert.equal(report.evaluators.find((entry) => entry.id === identity.evaluatorId).kind, 'controlled')
  const integrity = report.measurements.find((entry) => entry.dimension === 'temporal-integrity')
  assert.equal(report.evaluators.find((entry) => entry.id === integrity.evaluatorId).kind, 'measured')

  // What was not measured says so, with a reason, and carries no number.
  for (const dimension of ['visual-artifacts', 'framing', 'eyes', 'teeth', 'hands']) {
    const entry = report.measurements.find((measurement) => measurement.dimension === dimension)
    assert.equal(entry.status, 'unavailable')
    assert.equal(entry.value, null)
    assert.equal(entry.confidence, null)
    assert.ok(entry.note.length > 0)
  }
})

test('T-FR-106 a dimension cannot carry a score it did not measure', () => {
  const fabricated = baseMeasurements.map((entry) =>
    entry.dimension === 'eyes' ? { ...entry, value: 0.99, confidence: 0.99 } : entry)
  assert.throws(
    () => createSyntheticCriticReport({ ...base, measurements: fabricated }),
    /must not carry a fabricated value/,
  )

  const silent = baseMeasurements.filter((entry) => entry.dimension !== 'hands')
  assert.throws(
    () => createSyntheticCriticReport({ ...base, measurements: silent }),
    /silent about hands/,
  )

  const unexplained = baseMeasurements.map((entry) =>
    entry.dimension === 'eyes' ? { ...entry, note: '   ' } : entry)
  assert.throws(() => createSyntheticCriticReport({ ...base, measurements: unexplained }), /must say why/)

  const unsourced = baseMeasurements.map((entry) =>
    entry.dimension === 'pronunciation' ? { ...entry, evidenceRefs: [] } : entry)
  assert.throws(() => createSyntheticCriticReport({ ...base, measurements: unsourced }), /must reference its evidence/)

  const unnamed = baseMeasurements.map((entry) =>
    entry.dimension === 'pronunciation' ? { ...entry, evaluatorId: 'ghost-evaluator' } : entry)
  assert.throws(() => createSyntheticCriticReport({ ...base, measurements: unnamed }), /must name an evaluator listed/)
})

test('T-FR-106 evidence-unavailable is never approval, and approval is never dirty', () => {
  // Not knowing is not the same as knowing it is fine.
  assert.equal(isSyntheticCriticApproval('evidence-unavailable'), false)
  assert.equal(isSyntheticCriticApproval('needs-review'), false)
  assert.equal(isSyntheticCriticApproval('rejected'), false)
  assert.equal(isSyntheticCriticApproval('approved'), true)

  const blockingIssue = {
    blockId: 'block-1', dimension: 'identity', severity: 'blocking',
    range: { startMs: 0, endMs: 1_200 }, evidence: 'identity probe below threshold', action: 'fallback',
  }
  assert.throws(
    () => createSyntheticCriticReport({ ...base, issues: [blockingIssue] }),
    /approved report cannot carry a blocking issue/,
  )
  assert.throws(
    () => createSyntheticCriticReport({ ...base, recommendedAction: 'retry' }),
    /approved report cannot recommend an action/,
  )
  assert.throws(
    () => createSyntheticCriticReport({ ...base, decision: 'rejected', recommendedAction: 'none' }),
    /must recommend what to do/,
  )
  assert.throws(
    () => createSyntheticCriticReport({ ...base, decision: 'rejected', recommendedAction: 'retry', issues: [] }),
    /must localize at least one issue/,
  )

  const rejected = createSyntheticCriticReport({
    ...base, decision: 'rejected', recommendedAction: 'fallback', issues: [blockingIssue],
  })
  assert.equal(rejected.issues[0].range.endMs, 1_200)
  assert.equal(rejected.issues[0].action, 'fallback')
  assert.notEqual(rejected.reportHash, createSyntheticCriticReport(base).reportHash)
})

test('T-FR-106 a tampered report fails closed instead of being trusted', () => {
  const report = createSyntheticCriticReport(base)
  assert.throws(
    () => assertSyntheticCriticReportIntegrity({ ...report, decision: 'approved', artifactSha256: digest('9') }),
    /does not match its stored content/,
  )
  assert.throws(
    () => assertSyntheticCriticReportIntegrity({ ...report, thresholdsVersion: 'other/v9' }),
    /does not match its stored content/,
  )
})

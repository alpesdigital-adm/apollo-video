import assert from 'node:assert/strict'
import test from 'node:test'

import {
  listSyntheticCriticReportsService,
  readSyntheticCriticBlockEvidenceService,
  readSyntheticCriticReportService,
} from '../../src/v2/application/synthetic-critic-report-queries.ts'
import { createSyntheticCriticReport } from '../../src/v2/domain/synthetic-critic-report.ts'
import {
  parseSyntheticCriticReportListQuery,
  presentSyntheticCriticReport,
  SYNTHETIC_CRITIC_REPORT_LIST_QUERY_PARAMETERS,
} from '../../src/v2/public-api/synthetic-critic-report-contract.ts'

const digest = (character) => character.repeat(64)
const workspaceId = 'critic-api-workspace'
const projectId = 'critic-api-project'

const evaluators = [
  { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'timeline and signal read from the artifact' },
  { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'spoken words compared to the approved script' },
  { id: 'controlled-deterministic-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in, not production visual validation' },
]
const measured = (dimension, evaluatorId, value, unit, threshold) => ({
  dimension, status: 'measured', evaluatorId, value, unit, threshold,
  confidence: 1, evidenceRefs: ['artifact://critic-api-video'], range: null, note: null,
})
const unavailable = (dimension, note) => ({
  dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
  threshold: null, confidence: null, evidenceRefs: [], range: null, note,
})
const measurements = [
  measured('lip-sync', 'controlled-deterministic-probe', 0, 'ms-av-offset', 34),
  measured('identity', 'controlled-deterministic-probe', 1, 'identity-ref-match', 1),
  measured('pronunciation', 'alignment-pronunciation', 0, 'word-deviations', 0),
  unavailable('visual-artifacts', 'no visual artifact detector is deployed'),
  unavailable('framing', 'no framing model is deployed'),
  unavailable('continuity', 'this is the first approved block of the take'),
  unavailable('eyes', 'no eye model is deployed'),
  unavailable('teeth', 'no teeth model is deployed'),
  unavailable('hands', 'no hand model is deployed'),
  measured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
  measured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'live-signal', 1),
]

function report(overrides = {}) {
  return createSyntheticCriticReport({
    id: 'critic-api-report-1', workspaceId, projectId, blockId: 'critic-api-block',
    capability: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.1.0',
    artifactId: 'critic-api-video', artifactSha256: digest('a'),
    audioArtifactId: 'critic-api-audio', alignmentArtifactId: 'critic-api-alignment',
    scriptHash: digest('7'), profileSnapshotId: 'critic-api-presenter:v1',
    expectedIdentityRef: 'avatar_critic_api',
    evaluators, measurements, issues: [],
    decision: 'approved', recommendedAction: 'none',
    thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1',
    decidedAt: '2029-05-01T00:00:10.000Z',
    ...overrides,
  })
}

const rejected = () => report({
  id: 'critic-api-report-2',
  artifactId: 'critic-api-video-b', artifactSha256: digest('b'),
  measurements: measurements.map((entry) =>
    entry.dimension === 'pronunciation' ? { ...entry, value: 2 } : entry),
  issues: [{
    blockId: 'critic-api-block', dimension: 'pronunciation', severity: 'blocking',
    range: { startMs: 1_200, endMs: 1_850 },
    evidence: 'two words of the approved script were not spoken in the aligned take',
    action: 'retry',
  }],
  decision: 'rejected', recommendedAction: 'retry',
  decidedAt: '2029-05-01T00:00:20.000Z',
})

const actor = Object.freeze({
  clientId: 'critic-api-client', credentialId: 'critic-api-credential', workspaceId,
  environment: 'production', actor: Object.freeze({ type: 'api-client', id: 'critic-api-client' }),
  scopes: new Set(['projects:read']), authenticationKind: 'bearer',
  clientKillSwitchEngaged: false, workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active', workspaceAccessStatus: 'active',
  auditContext: Object.freeze({
    clientId: 'critic-api-client', credentialId: 'critic-api-credential', workspaceId,
    environment: 'production', actor: Object.freeze({ type: 'api-client', id: 'critic-api-client' }),
  }),
})

function repository(overrides = {}) {
  const calls = { listByProject: [], readByBlock: [], read: [] }
  return {
    calls,
    reports: {
      record: async () => { throw new Error('the read side must never record a verdict') },
      read: async (input) => {
        calls.read.push(input)
        return overrides.read === undefined ? report() : overrides.read
      },
      readByHash: async () => null,
      readByBlock: async (input) => {
        calls.readByBlock.push(input)
        return overrides.readByBlock ?? [rejected(), report()]
      },
      readByArtifact: async () => [],
      listByProject: async (input) => {
        calls.listByProject.push(input)
        return overrides.listByProject ?? [rejected(), report()]
      },
    },
  }
}

test('T-FR-106 the critic presenter exposes how a verdict was reached and hides what it judged', () => {
  const projected = presentSyntheticCriticReport(rejected())

  // The evaluator kind and scope are the whole point: without them a
  // deterministic stand-in reads as production visual validation.
  assert.deepEqual(
    projected.evaluators.map(({ id, kind }) => [id, kind]),
    [
      ['ffprobe-media-integrity', 'measured'],
      ['alignment-pronunciation', 'measured'],
      ['controlled-deterministic-probe', 'controlled'],
    ],
  )
  for (const evaluator of projected.evaluators) {
    assert.ok(evaluator.scope.length > 0, 'every evaluator must state what it can answer')
  }

  // Every dimension answers, and the ones with no instrument say why instead
  // of carrying a number nobody measured.
  assert.equal(projected.measurements.length, 11)
  for (const measurement of projected.measurements) {
    assert.ok(['measured', 'not-applicable', 'unavailable'].includes(measurement.status))
    assert.ok('value' in measurement && 'unit' in measurement && 'threshold' in measurement && 'note' in measurement)
    if (measurement.status === 'measured') {
      assert.equal(typeof measurement.value, 'number')
      assert.equal(typeof measurement.unit, 'string')
    } else {
      assert.equal(measurement.value, null)
      assert.ok(measurement.note && measurement.note.length > 0)
    }
  }

  // The issue keeps its localization and the action it recommends.
  assert.deepEqual(projected.issues, [{
    blockId: 'critic-api-block', dimension: 'pronunciation', severity: 'blocking',
    range: { startMs: 1_200, endMs: 1_850 },
    evidence: 'two words of the approved script were not spoken in the aligned take',
    action: 'retry',
  }])

  // The script stays behind its content address; no consent or provider
  // material crosses the boundary at all.
  const serialized = JSON.stringify(projected)
  assert.equal(projected.scriptHash, digest('7'))
  assert.doesNotMatch(serialized, /scriptText|consent|providerInput|apiKey|credential/i)
  assert.equal(Object.hasOwn(projected, 'scriptText'), false)
})

test('T-FR-106 the critic list query is allowlisted, bounded and project-scoped', async () => {
  assert.deepEqual([...SYNTHETIC_CRITIC_REPORT_LIST_QUERY_PARAMETERS].sort(), ['blockId', 'decision', 'limit'])

  assert.deepEqual(
    parseSyntheticCriticReportListQuery(new URLSearchParams('decision=rejected&blockId=critic-api-block&limit=5')),
    { decision: 'rejected', blockId: 'critic-api-block', limit: 5 },
  )
  assert.throws(() => parseSyntheticCriticReportListQuery(new URLSearchParams('decision=approved-ish')), /decision must be one of/)

  const { calls, reports } = repository()
  const list = listSyntheticCriticReportsService({ reports })

  // An unbounded or absurd limit is refused rather than silently clamped.
  await assert.rejects(list({ workspaceId, projectId, actor, limit: 0 }), /between 1 and 100/)
  await assert.rejects(list({ workspaceId, projectId, actor, limit: 101 }), /between 1 and 100/)

  // Narrowing by decision keeps only that verdict.
  const onlyRejected = await list({ workspaceId, projectId, actor, decision: 'rejected' })
  assert.deepEqual(onlyRejected.map(({ id }) => id), ['critic-api-report-2'])

  // Narrowing by block reads by block, then keeps this project's reports only.
  const foreignProject = { ...rejected(), projectId: 'another-project' }
  const scoped = listSyntheticCriticReportsService({
    reports: repository({ readByBlock: [foreignProject, report()] }).reports,
  })
  assert.deepEqual(
    (await scoped({ workspaceId, projectId, actor, blockId: 'critic-api-block' })).map(({ id }) => id),
    ['critic-api-report-1'],
  )
  assert.equal(calls.listByProject.length >= 1, true)

  // Another workspace is refused outright, before any read.
  await assert.rejects(
    list({ workspaceId: 'other-workspace', projectId, actor }),
    /another workspace/,
  )
})

test('T-FR-106 reading one verdict and one block\'s evidence stays inside the project', async () => {
  const read = readSyntheticCriticReportService({ reports: repository().reports })
  assert.equal((await read({ workspaceId, projectId, reportId: 'critic-api-report-1', actor })).id, 'critic-api-report-1')

  // A report that exists in the workspace but in another project is absent,
  // never a cross-project peek.
  const foreign = readSyntheticCriticReportService({
    reports: repository({ read: { ...report(), projectId: 'another-project' } }).reports,
  })
  await assert.rejects(
    foreign({ workspaceId, projectId, reportId: 'critic-api-report-1', actor }),
    /was not found in this project/,
  )

  const missing = readSyntheticCriticReportService({ reports: repository({ read: null }).reports })
  await assert.rejects(
    missing({ workspaceId, projectId, reportId: 'critic-api-report-1', actor }),
    /was not found in this project/,
  )

  // Block evidence answers with the verdict currently in force — the newest —
  // and asks the port for exactly one.
  const evidenceRepository = repository()
  const evidence = readSyntheticCriticBlockEvidenceService({ reports: evidenceRepository.reports })
  const current = await evidence({ workspaceId, projectId, blockId: 'critic-api-block', actor })
  assert.equal(current.id, 'critic-api-report-2')
  assert.equal(current.decision, 'rejected')
  assert.deepEqual(evidenceRepository.calls.readByBlock, [{ workspaceId, blockId: 'critic-api-block', limit: 1 }])

  // A block nobody judged is reported as absent. Silence is never approval.
  const unjudged = readSyntheticCriticBlockEvidenceService({ reports: repository({ readByBlock: [] }).reports })
  await assert.rejects(
    unjudged({ workspaceId, projectId, blockId: 'critic-api-block', actor }),
    /No synthetic critic report judges this block/,
  )
})

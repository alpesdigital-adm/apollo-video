import assert from 'node:assert/strict'
import test from 'node:test'

import {
  produceContiguousEvaluationsService,
} from '../../src/v2/application/contiguous-evaluation.ts'
import { authenticationAudit } from './helpers/authentication-audit.mjs'

const sha = (value) => value.repeat(64).slice(0, 64)
const dimensionEvidence = {
  selfContained: 'evidence-boundary-evaluation',
  density: 'evidence-density-evaluation',
  integrity: 'evidence-integrity-evaluation',
  audio: 'evidence-audio-evaluation',
  visual: 'evidence-visual-evaluation',
}

function evidence(id, kind, dimension, value) {
  return {
    id,
    sourceIndexRunId: 'index-contiguous-evaluation',
    sourceIndexRunHash: sha('a'),
    sourceMomentId: 'moment-contiguous-evaluation',
    sourceMomentHash: sha('d'),
    kind,
    dimensions: [dimension],
    rangeMs: [5_000, 125_000],
    producer: {
      provider: 'apollo',
      model: `${kind}-analyzer`,
      version: '1.0.0',
      inputHash: sha('4'),
      outputHash: sha('5'),
    },
    evidenceHash: sha(value),
    facts: { measured: true, value: 0.9 },
  }
}

function source(overrides = {}) {
  return {
    workspaceId: 'workspace-contiguous-evaluation',
    projectId: 'project-contiguous-evaluation',
    indexRunId: 'index-contiguous-evaluation',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-contiguous-evaluation',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-contiguous-evaluation',
    sourceManifestHash: sha('c'),
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-contiguous-evaluation',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [
      {
        id: 'moment-contiguous-evaluation',
        momentHash: sha('d'),
        chapterId: 'chapter-contiguous-evaluation',
        topic: 'aquisicao',
        recommendedRangeMs: [10_000, 110_000],
        evidence: [
          evidence(
            dimensionEvidence.selfContained,
            'transcript-boundary',
            'selfContained',
            'e',
          ),
          evidence(
            dimensionEvidence.density,
            'transcript-density',
            'density',
            'f',
          ),
          evidence(
            dimensionEvidence.integrity,
            'rights-integrity',
            'integrity',
            '1',
          ),
          evidence(
            dimensionEvidence.audio,
            'audio-analysis',
            'audio',
            '2',
          ),
          evidence(
            dimensionEvidence.visual,
            'visual-analysis',
            'visual',
            '3',
          ),
        ],
      },
    ],
    ...overrides,
  }
}

function evaluatedDecision(overrides = {}) {
  return {
    status: 'evaluated',
    momentId: 'moment-contiguous-evaluation',
    objectiveTags: ['education'],
    semanticRangeMs: [5_000, 125_000],
    scores: Object.fromEntries(
      Object.entries(dimensionEvidence).map(
        ([dimension, reference]) => [
          dimension,
          { value: 0.9, evidenceRefs: [reference] },
        ],
      ),
    ),
    ...overrides,
  }
}

function fixture(options = {}) {
  let stored
  let providerCalls = 0
  let currentSource = options.source ?? source()
  const repository = {
    async readSource() {
      return currentSource
    },
    async findIdempotent(input) {
      return stored &&
        stored.workspaceId === input.workspaceId &&
        stored.projectId === input.projectId &&
        stored.sourceIndexRunId === input.sourceIndexRunId &&
        stored.createdBy.id === input.createdByClientId &&
        stored.idempotencyKey === input.idempotencyKey
        ? stored
        : null
    },
    async persistWithLongFormLease({ run }) {
      stored = run
      return { run, replayed: false }
    },
  }
  const provider = {
    identity: {
      provider: 'apollo',
      model: 'contiguous-quality-evaluator',
      version: '1.0.0',
    },
    async evaluate() {
      providerCalls += 1
      return options.decisions ?? [evaluatedDecision()]
    },
  }
  const produce = produceContiguousEvaluationsService({
    repository,
    provider,
    createRunId: () => 'contiguous-evaluation-run-1',
    createEvaluationId: (momentId) =>
      `contiguous-evaluation-${momentId}`,
    clock: () => new Date('2026-07-30T23:55:00.000Z'),
  })
  return {
    produce,
    stored: () => stored,
    providerCalls: () => providerCalls,
    setSource(value) {
      currentSource = value
    },
  }
}

const request = {
  workspaceId: 'workspace-contiguous-evaluation',
  projectId: 'project-contiguous-evaluation',
  indexRunId: 'index-contiguous-evaluation',
  authenticationAudit: authenticationAudit({
    clientId: 'client-contiguous-evaluation',
    credentialId: 'credential-contiguous-evaluation',
    workspaceId: 'workspace-contiguous-evaluation',
  }),
  fence: {
    workspaceId: 'workspace-contiguous-evaluation',
    projectId: 'project-contiguous-evaluation',
    workflowId: 'workflow-contiguous-evaluation',
    operationId: 'operation-contiguous-evaluation',
    stage: 'moments',
    expectedStageInputHash: sha('e'),
    expectedStageIdempotencyKey: 'moments-contiguous-evaluation',
    leaseOwner: 'worker-contiguous-evaluation',
    operationAttempt: 1,
    now: '2026-07-30T23:55:00.000Z',
  },
  idempotencyKey: 'contiguous-evaluation-key-1',
}

test('T-FR-134 internal producer binds every evaluated dimension to trusted evidence', async () => {
  const value = fixture()
  const created = await value.produce(request)

  assert.equal(created.replayed, false)
  assert.equal(created.run.evaluations.length, 1)
  assert.equal(
    created.run.evaluations[0].evaluationProducer.inputHash,
    created.run.producer.inputHash,
  )
  assert.equal(
    created.run.evaluations[0].evaluationProducer.outputHash,
    created.run.producer.outputHash,
  )
  assert.equal(created.run.runHash, value.stored().runHash)
  assert.deepEqual(
    created.run.authenticationAudit,
    request.authenticationAudit,
  )
  assert.deepEqual(created.run.provenance, {
    kind: 'long-form-stage',
    workflowId: request.fence.workflowId,
    operationId: request.fence.operationId,
    stage: 'moments',
    stageInputHash: request.fence.expectedStageInputHash,
    stageIdempotencyKey:
      request.fence.expectedStageIdempotencyKey,
  })
  assert.equal(value.providerCalls(), 1)
})

test('T-FR-134 internal producer replays before provider execution and rejects source drift', async () => {
  const value = fixture()
  const first = await value.produce(request)
  const replay = await value.produce(request)

  assert.equal(replay.replayed, true)
  assert.equal(replay.run.runHash, first.run.runHash)
  assert.equal(value.providerCalls(), 1)

  value.setSource(source({
    indexRunHash: sha('9'),
    moments: source().moments.map((moment) => ({
      ...moment,
      evidence: moment.evidence.map((item) => ({
        ...item,
        sourceIndexRunHash: sha('9'),
      })),
    })),
  }))
  await assert.rejects(
    value.produce(request),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(value.providerCalls(), 1)
})

test('T-FR-242 evaluation producer rejects fence and credential drift before duplicate work', async () => {
  const value = fixture()
  await assert.rejects(
    value.produce({
      ...request,
      fence: { ...request.fence, workspaceId: 'workspace-other' },
    }),
    (error) => error.code === 'VERSION_CONFLICT',
  )
  assert.equal(value.providerCalls(), 0)

  await value.produce(request)
  await assert.rejects(
    value.produce({
      ...request,
      authenticationAudit: authenticationAudit({
        clientId: request.authenticationAudit.clientId,
        credentialId: 'credential-contiguous-evaluation-other',
        workspaceId: request.workspaceId,
      }),
    }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(value.providerCalls(), 1)
})

test('T-FR-134 internal producer rejects fabricated evidence and incomplete decision coverage', async () => {
  const fabricated = fixture({
    decisions: [
      evaluatedDecision({
        scores: {
          ...evaluatedDecision().scores,
          audio: {
            value: 0.9,
            evidenceRefs: [dimensionEvidence.visual],
          },
        },
      }),
    ],
  })
  await assert.rejects(
    fabricated.produce(request),
    (error) => error.code === 'RENDER_OUTPUT_INVALID',
  )
  assert.equal(fabricated.stored(), undefined)

  const secondMoment = {
    ...source().moments[0],
    id: 'moment-contiguous-evaluation-2',
    momentHash: sha('8'),
    evidence: source().moments[0].evidence.map((item) => ({
      ...item,
      id: `${item.id}-2`,
      sourceMomentId: 'moment-contiguous-evaluation-2',
      sourceMomentHash: sha('8'),
    })),
  }
  const incomplete = fixture({
    source: source({
      moments: [...source().moments, secondMoment],
    }),
  })
  await assert.rejects(
    incomplete.produce(request),
    (error) => error.code === 'RENDER_OUTPUT_INVALID',
  )
  assert.equal(incomplete.stored(), undefined)
})

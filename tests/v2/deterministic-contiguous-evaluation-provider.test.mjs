import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DeterministicContiguousEvaluationProvider,
} from '../../src/v2/infrastructure/analysis/deterministic-contiguous-evaluation-provider.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function evidence(kind, dimensions, facts, index) {
  return {
    id: `evidence-${kind}-policy`,
    sourceIndexRunId: 'index-evaluation-policy',
    sourceIndexRunHash: sha('a'),
    sourceMomentId: 'moment-evaluation-policy',
    sourceMomentHash: sha('b'),
    kind,
    dimensions,
    rangeMs: [10_000, 130_000],
    producer: {
      provider: kind.includes('analysis') ? 'ffmpeg' : 'apollo',
      model: `${kind}-model`,
      version: '1.0.0',
      inputHash: sha(String(index + 1)),
      outputHash: sha(String(index + 2)),
    },
    evidenceHash: sha(String(index + 3)),
    facts,
  }
}

function moment(overrides = {}) {
  return {
    id: 'moment-evaluation-policy',
    momentHash: sha('b'),
    chapterId: 'chapter-evaluation-policy',
    topic:
      'Oferta clara para comprar com valor e contexto preservado.',
    recommendedRangeMs: [10_000, 130_000],
    evidence: [
      evidence(
        'transcript-boundary',
        ['selfContained', 'integrity'],
        {
          alignedStart: true,
          alignedEnd: true,
          startsWithCapitalOrNumber: true,
          endsWithTerminalPunctuation: true,
          maximumInternalGapMs: 200,
          evidencePreserved: true,
        },
        0,
      ),
      evidence(
        'transcript-density',
        ['density'],
        {
          wordsPerMinute: 142,
          speechCoverageRatio: 0.8,
          wordCount: 180,
        },
        1,
      ),
      evidence(
        'rights-integrity',
        ['integrity'],
        {
          rightsApproved: true,
          consentApproved: false,
          consentNotRequired: true,
        },
        2,
      ),
      evidence(
        'audio-analysis',
        ['audio'],
        {
          integratedLufs: -16,
          silenceRatio: 0.05,
          audibleSignal: true,
          clippingRisk: false,
          sourceChecksumVerified: true,
        },
        3,
      ),
      evidence(
        'visual-analysis',
        ['visual'],
        {
          sampledFrameCount: 3_600,
          averageLuma: 0.5,
          blackRatio: 0,
          freezeRatio: 0.1,
          broadcastRangeViolationRatio: 0,
          sourceChecksumVerified: true,
        },
        4,
      ),
    ],
    ...overrides,
  }
}

function source(momentValue = moment()) {
  return {
    workspaceId: 'workspace-evaluation-policy',
    projectId: 'project-evaluation-policy',
    indexRunId: 'index-evaluation-policy',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-evaluation-policy',
    sourceArtifactSha256: sha('c'),
    sourceManifestId: 'manifest-evaluation-policy',
    sourceManifestHash: sha('d'),
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-evaluation-policy',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [momentValue],
  }
}

test('T-FR-134 deterministic evaluator scores five exact evidence kinds and derives bounded objectives', async () => {
  const decisions =
    await new DeterministicContiguousEvaluationProvider()
      .evaluate(source(), new AbortController().signal)

  assert.equal(decisions[0].status, 'evaluated')
  assert.deepEqual(decisions[0].semanticRangeMs, [
    10_000,
    130_000,
  ])
  assert.ok(decisions[0].objectiveTags.includes('discovery'))
  assert.ok(decisions[0].objectiveTags.includes('awareness'))
  assert.ok(decisions[0].objectiveTags.includes('warming'))
  assert.ok(decisions[0].objectiveTags.includes('sale'))
  assert.ok(decisions[0].scores.selfContained.value > 0.9)
  assert.ok(decisions[0].scores.audio.value > 0.9)
  for (const observation of Object.values(decisions[0].scores)) {
    assert.equal(observation.evidenceRefs.length, 1)
  }
})

test('T-FR-134 deterministic evaluator rejects silent, black and incomplete evidence without fabricating scores', async () => {
  const base = moment()
  const silent = {
    ...base,
    evidence: base.evidence.map((item) =>
      item.kind === 'audio-analysis'
        ? {
            ...item,
            facts: { ...item.facts, audibleSignal: false },
          }
        : item),
  }
  const black = {
    ...base,
    evidence: base.evidence.map((item) =>
      item.kind === 'visual-analysis'
        ? {
            ...item,
            facts: { ...item.facts, blackRatio: 1 },
          }
        : item),
  }
  const incomplete = {
    ...base,
    evidence: base.evidence.filter(
      (item) => item.kind !== 'transcript-density',
    ),
  }
  const provider = new DeterministicContiguousEvaluationProvider()
  assert.equal(
    (await provider.evaluate(
      source(silent),
      new AbortController().signal,
    ))[0].reason,
    'INSUFFICIENT_AUDIO_EVIDENCE',
  )
  assert.equal(
    (await provider.evaluate(
      source(black),
      new AbortController().signal,
    ))[0].reason,
    'INSUFFICIENT_VISUAL_EVIDENCE',
  )
  assert.equal(
    (await provider.evaluate(
      source(incomplete),
      new AbortController().signal,
    ))[0].reason,
    'INSUFFICIENT_TRANSCRIPT_EVIDENCE',
  )
})

test('T-FR-134 deterministic evaluator stops on cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    new DeterministicContiguousEvaluationProvider()
      .evaluate(source(), controller.signal),
    (error) => error.code === 'VERSION_CONFLICT',
  )
})

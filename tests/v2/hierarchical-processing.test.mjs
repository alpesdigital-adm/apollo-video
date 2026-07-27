import assert from 'node:assert/strict'
import test from 'node:test'

import {
  aggregateHierarchicalMoments,
  chunkLongForm,
  createHierarchicalEvidenceSpans,
  estimateHierarchicalFixture,
  normalizeHierarchicalTierVersions,
  planHierarchicalProcessing,
  processCheapSignals,
  processHierarchicalLanguage,
  processHierarchicalVision,
} from '../../src/v2/domain/hierarchical-processing.ts'

const versions = (vision = '1.0.0') =>
  normalizeHierarchicalTierVersions({
    'cheap-signals': {
      provider: 'apollo',
      model: 'transcript-statistics',
      version: '1.0.0',
    },
    vision: {
      provider: 'apollo',
      model: 'cataloged-visual-observations',
      version: vision,
    },
    language: {
      provider: 'apollo',
      model: 'transcript-segmentation',
      version: '1.0.0',
    },
    aggregation: {
      provider: 'apollo',
      model: 'evidence-preserving-aggregation',
      version: '1.0.0',
    },
  })

function fixture(durationMs = 1_800_000) {
  const chunks = chunkLongForm({
    artifactId: 'artifact-long-form',
    durationMs,
    chunkDurationMs: 300_000,
    overlapMs: 15_000,
  })
  const segments = Array.from(
    { length: Math.ceil(durationMs / 30_000) },
    (_, id) => ({
      id,
      startMs: id * 30_000,
      endMs: Math.min(durationMs, id * 30_000 + 20_000),
      text: `Reflexao completa numero ${id} sobre aquisicao e oferta.`,
    }),
  )
  const evidenceSpans = createHierarchicalEvidenceSpans({
    transcriptId: 'transcript-long-form',
    durationMs,
    segments,
    chunks,
  })
  const cheap = processCheapSignals({ chunks, evidenceSpans })
  const vision = processHierarchicalVision({
    chunks: cheap.chunks,
    width: 1920,
    height: 1080,
    fps: 30,
    catalogedVisualObservationCount: 4,
  })
  const language = processHierarchicalLanguage({
    chunks: cheap.chunks,
    evidenceSpans: cheap.evidenceSpans,
  })
  const aggregation = aggregateHierarchicalMoments({
    candidates: language.candidates,
    evidenceSpans: cheap.evidenceSpans,
  })
  return { chunks, evidenceSpans, cheap, vision, language, aggregation }
}

test('T-FR-053 maps two hours into immutable overlapping chunks', () => {
  const chunks = chunkLongForm({
    artifactId: 'artifact-two-hours',
    durationMs: 7_200_000,
  })
  assert.equal(chunks.length, 24)
  assert.deepEqual(chunks[0].coreRangeMs, [0, 300_000])
  assert.deepEqual(chunks[0].sourceRangeMs, [0, 315_000])
  assert.deepEqual(chunks[1].coreRangeMs, [300_000, 600_000])
  assert.deepEqual(chunks[1].sourceRangeMs, [285_000, 615_000])
  assert.equal(chunks[1].overlapBeforeMs, 15_000)
  assert.equal(chunks[1].overlapAfterMs, 15_000)
  assert.deepEqual(
    chunks.at(-1).coreRangeMs,
    [6_900_000, 7_200_000],
  )
  assert.equal(chunks.at(-1).overlapAfterMs, 0)
  assert.throws(() => chunks.push(chunks[0]))
})

test('T-FR-053 preserves exact evidence spans across overlap', () => {
  const chunks = chunkLongForm({
    artifactId: 'artifact-overlap',
    durationMs: 600_000,
  })
  const spans = createHierarchicalEvidenceSpans({
    transcriptId: 'transcript-overlap',
    durationMs: 600_000,
    chunks,
    segments: [
      {
        id: 1,
        startMs: 292_000,
        endMs: 308_000,
        text: 'Uma fala atravessa a fronteira entre os chunks.',
      },
      {
        id: 2,
        startMs: 400_000,
        endMs: 420_000,
        text: 'Outra fala fica no segundo chunk.',
      },
    ],
  })
  assert.equal(spans[0].chunkIds.length, 2)
  const cheap = processCheapSignals({ chunks, evidenceSpans: spans })
  assert.ok(cheap.chunks[0].evidenceSpanIds.includes(spans[0].id))
  assert.ok(cheap.chunks[1].evidenceSpanIds.includes(spans[0].id))
  assert.deepEqual(spans[0].rangeMs, [292_000, 308_000])
  assert.match(spans[0].textHash, /^[a-f0-9]{64}$/)
})

test('T-FR-053 executes cheap signals before expensive tiers', () => {
  const plan = planHierarchicalProcessing({
    tierVersions: versions(),
    chunkConfigurationChanged: false,
  })
  assert.equal(plan.cheapSignalsFirst, true)
  assert.deepEqual(plan.executionOrder, [
    'cheap-signals',
    'vision',
    'language',
    'aggregation',
  ])
  assert.deepEqual(
    plan.tiers.map((tier) => tier.prerequisites),
    [[], ['cheap-signals'], ['cheap-signals'], ['vision', 'language']],
  )
})

test('T-FR-053 invalidates only a changed tier and dependents', () => {
  const plan = planHierarchicalProcessing({
    tierVersions: versions('2.0.0'),
    previousTierVersions: versions('1.0.0'),
    chunkConfigurationChanged: false,
  })
  assert.deepEqual(plan.invalidatedTiers, ['vision', 'aggregation'])
  assert.equal(
    plan.tiers.find((tier) => tier.tier === 'cheap-signals').status,
    'reuse',
  )
  assert.equal(
    plan.tiers.find((tier) => tier.tier === 'language').status,
    'reuse',
  )
  assert.equal(
    plan.tiers.find((tier) => tier.tier === 'vision').status,
    'process',
  )
  assert.equal(
    plan.tiers.find((tier) => tier.tier === 'aggregation').status,
    'process',
  )
})

test('T-FR-053 aggregates chapters and moments without losing spans', () => {
  const result = fixture()
  const sourceIds = new Set(
    result.evidenceSpans.map((span) => span.id),
  )
  const aggregateIds = new Set(
    result.aggregation.moments.flatMap(
      (moment) => moment.evidenceSpanIds,
    ),
  )
  assert.equal(result.aggregation.evidencePreserved, true)
  assert.deepEqual(aggregateIds, sourceIds)
  assert.equal(result.aggregation.moments.length, result.chunks.length)
  assert.equal(result.aggregation.chapters.length, 2)
  assert.ok(
    result.aggregation.chapters.every(
      (chapter) => chapter.evidenceSpanIds.length > 0,
    ),
  )
})

test('T-FR-053 measures bounded 30-minute and two-hour fixtures', () => {
  for (const durationMs of [1_800_000, 7_200_000]) {
    const result = fixture(durationMs)
    const workingSetBytes = [
      result.cheap,
      result.vision,
      result.language,
      result.aggregation,
    ].reduce((total, tier) => total + tier.workingSetBytes, 0)
    const measurement = estimateHierarchicalFixture({
      durationMs,
      chunkCount: result.chunks.length,
      workingSetBytes,
      costMinorUnits: result.chunks.length * 6,
      elapsedMs: result.chunks.length * 5,
    })
    assert.equal(measurement.bounded, true)
    assert.ok(measurement.workingSetBytes > 0)
    assert.ok(measurement.costMinorUnits > 0)
    assert.ok(measurement.elapsedMs > 0)
    assert.match(measurement.measurementHash, /^[a-f0-9]{64}$/)
  }
})

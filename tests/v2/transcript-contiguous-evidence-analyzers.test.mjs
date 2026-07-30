import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  createLongFormMomentTranscriptEvidence,
} from '../../src/v2/domain/long-form-transcript-evidence.ts'
import {
  TranscriptBoundaryContiguousEvidenceAnalyzer,
  TranscriptDensityContiguousEvidenceAnalyzer,
} from '../../src/v2/infrastructure/analysis/transcript-contiguous-evidence-analyzers.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function span(id, rangeMs, text) {
  const content = {
    id,
    sourceSegmentId: Number(id.at(-1)),
    rangeMs,
    text,
    textHash: calculateCanonicalHash(text),
    wordCount: text.split(/\s+/u).length,
    chunkIds: ['chunk-transcript-analyzer'],
  }
  return { ...content, spanHash: calculateCanonicalHash(content) }
}

function source(
  withEvidence = true,
  recommendedRangeMs = [10_000, 70_000],
) {
  const moment = {
    id: 'moment-transcript-analyzer',
    momentHash: sha('b'),
    recommendedRangeMs,
  }
  const transcriptEvidence =
    createLongFormMomentTranscriptEvidence({
      id: 'sidecar-transcript-analyzer',
      workspaceId: 'workspace-transcript-analyzer',
      projectId: 'project-transcript-analyzer',
      indexRunId: 'index-transcript-analyzer',
      indexRunHash: sha('a'),
      momentId: moment.id,
      momentHash: moment.momentHash,
      hierarchicalRunId: 'hierarchical-transcript-analyzer',
      hierarchicalRunHash: sha('c'),
      sourceTranscriptId: 'transcript-analyzer',
      sourceTranscriptHash: sha('d'),
      spans: [
        span(
          'evidence-span-analyzer-1',
          [10_000, 40_000],
          'Uma ideia começa com contexto',
        ),
        span(
          'evidence-span-analyzer-2',
          [45_000, 70_000],
          'e termina de forma completa.',
        ),
      ],
    })
  return {
    workspaceId: 'workspace-transcript-analyzer',
    projectId: 'project-transcript-analyzer',
    indexRunId: 'index-transcript-analyzer',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-transcript-analyzer',
    sourceArtifactSha256: sha('e'),
    sourceManifestId: 'manifest-transcript-analyzer',
    sourceManifestHash: sha('f'),
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-transcript-analyzer',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [{
      ...moment,
      ...(withEvidence ? { transcriptEvidence } : {}),
    }],
  }
}

test('T-FR-134 transcript analyzers derive boundary and density facts from exact spans', async () => {
  const signal = new AbortController().signal
  const boundary =
    await new TranscriptBoundaryContiguousEvidenceAnalyzer()
      .analyze(source(), signal)
  const density =
    await new TranscriptDensityContiguousEvidenceAnalyzer()
      .analyze(source(), signal)

  assert.deepEqual(boundary[0].dimensions, [
    'selfContained',
    'integrity',
  ])
  assert.equal(boundary[0].facts.alignedStart, true)
  assert.equal(boundary[0].facts.alignedEnd, true)
  assert.equal(boundary[0].facts.startBoundaryDeltaMs, 0)
  assert.equal(boundary[0].facts.endBoundaryDeltaMs, 0)
  assert.equal(boundary[0].facts.internalGapCount, 1)
  assert.equal(boundary[0].facts.maximumInternalGapMs, 5_000)
  assert.equal(
    boundary[0].facts.endsWithTerminalPunctuation,
    true,
  )
  assert.deepEqual(density[0].dimensions, ['density'])
  assert.equal(density[0].facts.wordCount, 10)
  assert.equal(density[0].facts.speechMs, 55_000)
  assert.equal(density[0].facts.speechCoverageRatio, 0.916667)

  const shifted =
    await new TranscriptBoundaryContiguousEvidenceAnalyzer()
      .analyze(source(true, [11_000, 69_000]), signal)
  assert.equal(shifted[0].facts.alignedStart, false)
  assert.equal(shifted[0].facts.alignedEnd, false)
  assert.equal(shifted[0].facts.startBoundaryDeltaMs, 1_000)
  assert.equal(shifted[0].facts.endBoundaryDeltaMs, -1_000)
})

test('T-FR-134 transcript analyzers fail closed without sidecar or after cancellation', async () => {
  const analyzer =
    new TranscriptBoundaryContiguousEvidenceAnalyzer()
  await assert.rejects(
    analyzer.analyze(
      source(false),
      new AbortController().signal,
    ),
    (error) => error.code === 'PRECONDITION_REQUIRED',
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    analyzer.analyze(source(), controller.signal),
    (error) => error.code === 'VERSION_CONFLICT',
  )
})

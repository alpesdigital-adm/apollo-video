import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RIGHTS_INTEGRITY_ANALYZER_IDENTITY,
  RightsIntegrityContiguousEvidenceAnalyzer,
} from '../../src/v2/infrastructure/analysis/rights-integrity-contiguous-evidence-analyzer.ts'

const sha = (value) => value.repeat(64).slice(0, 64)

function source(overrides = {}) {
  return {
    workspaceId: 'workspace-rights-evidence',
    projectId: 'project-rights-evidence',
    indexRunId: 'index-rights-evidence',
    indexRunHash: sha('a'),
    sourceArtifactId: 'artifact-rights-evidence',
    sourceArtifactSha256: sha('b'),
    sourceManifestId: 'manifest-rights-evidence',
    sourceManifestHash: sha('c'),
    sourceDurationMs: 7_200_000,
    rightsSnapshotId: 'rights-snapshot-evidence',
    rightsStatus: 'approved',
    consentStatus: 'not-required',
    moments: [{
      id: 'moment-rights-evidence',
      momentHash: sha('d'),
      recommendedRangeMs: [10_000, 130_000],
    }],
    ...overrides,
  }
}

test('T-FR-134 rights analyzer emits integrity facts from the current source authorization', async () => {
  const analyzer =
    new RightsIntegrityContiguousEvidenceAnalyzer()
  const observations = await analyzer.analyze(
    source(),
    new AbortController().signal,
  )

  assert.deepEqual(
    analyzer.identity,
    RIGHTS_INTEGRITY_ANALYZER_IDENTITY,
  )
  assert.deepEqual(observations, [{
    momentId: 'moment-rights-evidence',
    rangeMs: [10_000, 130_000],
    dimensions: ['integrity'],
    facts: {
      rightsApproved: true,
      consentApproved: false,
      consentNotRequired: true,
      rightsSnapshotId: 'rights-snapshot-evidence',
    },
  }])
})

test('T-FR-134 rights analyzer fails closed on blocked rights or cancellation', async () => {
  const analyzer =
    new RightsIntegrityContiguousEvidenceAnalyzer()
  await assert.rejects(
    analyzer.analyze(
      source({ rightsStatus: 'blocked' }),
      new AbortController().signal,
    ),
    (error) => error.code === 'ASSET_RIGHTS_BLOCKED',
  )
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    analyzer.analyze(source(), controller.signal),
    (error) => error.code === 'VERSION_CONFLICT',
  )
})

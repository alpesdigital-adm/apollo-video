import assert from 'node:assert/strict'
import test from 'node:test'

import {
  catalogLongFormMomentsService,
  searchLongFormMomentsService,
} from '../../src/v2/application/catalog-long-form-moments.ts'
import {
  buildLongFormMomentPreview,
  catalogLongFormHierarchy,
} from '../../src/v2/domain/long-form-moment.ts'
import {
  authenticatedActor,
  authenticationAudit,
} from './helpers/authentication-audit.mjs'

const createdAt = '2026-07-27T14:00:00.000Z'
const artifactHash = 'a'.repeat(64)
const manifestHash = 'b'.repeat(64)
const producer = {
  provider: 'apollo',
  model: 'long-form-indexer',
  version: '1.0.0',
  confidence: 0.97,
}
const chapters = [
  {
    sourceChapterId: 'chapter-traffic',
    title: { value: 'Tráfego pago', confidence: 0.98 },
    topicPath: ['Marketing', 'Tráfego pago'],
    rangeMs: [0, 3_600_000],
  },
  {
    sourceChapterId: 'chapter-offer',
    title: { value: 'Construção da oferta', confidence: 0.99 },
    topicPath: ['Marketing', 'Oferta'],
    rangeMs: [3_600_000, 7_200_000],
  },
]
const moments = [
  {
    sourceMomentId: 'moment-traffic',
    sourceChapterId: 'chapter-traffic',
    topic: { value: 'Análise de campanhas', confidence: 0.96 },
    summary: {
      value: 'Como identificar campanhas que precisam de ajuste.',
      confidence: 0.95,
    },
    keyQuote: {
      value: 'O contexto muda a leitura da métrica.',
      confidence: 0.94,
    },
    speakerIds: ['person-specialist'],
    rangesMs: [[1_000, 31_000], [100_000, 130_000]],
    recommendedRangeIndex: 1,
    evidenceSpanIds: ['speech-segment-traffic'],
    salience: 0.82,
    hookPotential: 0.71,
    standaloneScore: 0.84,
    contextScore: 0.89,
    insightDensity: 0.8,
    roles: ['education'],
    tags: ['campaign-analysis'],
  },
  {
    sourceMomentId: 'moment-offer',
    sourceChapterId: 'chapter-offer',
    topic: { value: 'Oferta', confidence: 0.99 },
    summary: {
      value: 'Construção da oferta a partir do problema central.',
      confidence: 0.98,
    },
    keyQuote: {
      value: 'A oferta organiza a transformação.',
      confidence: 0.97,
    },
    speakerIds: ['person-host', 'person-specialist'],
    rangesMs: [[4_000_000, 4_030_000]],
    recommendedRangeIndex: 0,
    evidenceSpanIds: ['speech-segment-offer'],
    salience: 0.93,
    hookPotential: 0.88,
    standaloneScore: 0.91,
    contextScore: 0.86,
    insightDensity: 0.9,
    roles: ['education', 'story'],
    tags: ['offer'],
  },
]

function hierarchy() {
  return catalogLongFormHierarchy({
    workspaceId: 'workspace-long-form',
    projectId: 'project-long-form',
    indexRunId: 'long-form-index-run-1',
    sourceArtifactId: 'artifact-long-form',
    durationMs: 7_200_000,
    chapters,
    moments,
    producer,
    createdAt,
    createId: (kind, sourceId) => `${kind}-${sourceId}`,
  })
}

test('T-FR-045 models chapter, topic, summary, speakers, ranges and salience with immutable provenance', () => {
  const result = hierarchy()
  const moment = result.moments[1]
  assert.equal(result.chapters.length, 2)
  assert.equal(result.moments.length, 2)
  assert.equal(moment.topic.normalizedValue, 'oferta')
  assert.equal(moment.topic.provenance.source, 'long-form-analysis')
  assert.equal(moment.summary.provenance.model, 'long-form-indexer')
  assert.deepEqual(moment.speakerIds, [
    'person-host',
    'person-specialist',
  ])
  assert.deepEqual(moment.rangesMs, [[4_000_000, 4_030_000]])
  assert.equal(moment.salience, 0.93)
  assert.equal(moment.physicalMaterialized, false)
  assert.match(moment.momentHash, /^[a-f0-9]{64}$/)
  assert.throws(() => moment.speakerIds.push('person-other'))
})

test('T-FR-045 indexes two hours hierarchically without a monolithic summary', () => {
  const result = hierarchy()
  assert.deepEqual(Object.keys(result).sort(), ['chapters', 'moments'])
  assert.equal('summary' in result, false)
  assert.deepEqual(
    result.chapters.map((chapter) => ({
      source: chapter.sourceChapterId,
      range: chapter.rangeMs,
      momentIds: chapter.momentIds,
    })),
    [
      {
        source: 'chapter-traffic',
        range: [0, 3_600_000],
        momentIds: ['long-form-moment-moment-traffic'],
      },
      {
        source: 'chapter-offer',
        range: [3_600_000, 7_200_000],
        momentIds: ['long-form-moment-moment-offer'],
      },
    ],
  )
  assert.throws(() =>
    catalogLongFormHierarchy({
      workspaceId: 'workspace-long-form',
      projectId: 'project-long-form',
      indexRunId: 'long-form-index-run-2',
      sourceArtifactId: 'artifact-long-form',
      durationMs: 7_200_000,
      chapters: [
        chapters[0],
        { ...chapters[1], rangeMs: [3_500_000, 7_200_000] },
      ],
      moments,
      producer,
      createdAt,
      createId: (kind, sourceId) => `${kind}-${sourceId}-invalid`,
    }),
  )
})

test('T-FR-045 opens independent context before and after every range and clamps it to the master', () => {
  const result = hierarchy()
  const first = buildLongFormMomentPreview({
    moment: {
      ...result.moments[0],
      recommendedRangeIndex: 0,
      recommendedRangeMs: result.moments[0].rangesMs[0],
    },
    masterDurationMs: 7_200_000,
    contextBeforeMs: 10_000,
    contextAfterMs: 15_000,
  })
  assert.deepEqual(first.primary.previewRangeMs, [0, 46_000])
  assert.equal(first.primary.clippedBefore, true)
  assert.deepEqual(first.ranges[1].previewRangeMs, [90_000, 145_000])

  const last = buildLongFormMomentPreview({
    moment: {
      ...result.moments[1],
      rangesMs: [[7_180_000, 7_200_000]],
      recommendedRangeMs: [7_180_000, 7_200_000],
    },
    masterDurationMs: 7_200_000,
    contextBeforeMs: 10_000,
    contextAfterMs: 15_000,
  })
  assert.deepEqual(last.primary.previewRangeMs, [7_170_000, 7_200_000])
  assert.equal(last.primary.clippedAfter, true)
})

test('T-FR-045 catalogs and searches a two-topic live through the application boundary', async () => {
  let persisted
  let capturedQuery
  const repository = {
    async readCreationContext() {
      return {
        sourceArtifactId: 'artifact-long-form',
        sourceArtifactSha256: artifactHash,
        sourceManifestId: 'manifest-long-form',
        sourceManifestHash: manifestHash,
        durationMs: 7_200_000,
        rights: {
          id: 'rights-long-form',
          status: 'approved',
          consentStatus: 'not-required',
        },
      }
    },
    async findIdempotent() {
      return persisted ?? null
    },
    async persist(run) {
      persisted = run
      return { run, replayed: false }
    },
    async search(query) {
      capturedQuery = query
      const moment = persisted.moments.find(
        (candidate) => candidate.sourceMomentId === 'moment-offer',
      )
      const chapter = persisted.chapters.find(
        (candidate) => candidate.id === moment.chapterId,
      )
      return [{
        moment,
        chapter,
        matchedBy: ['text', 'speaker'],
        preview: buildLongFormMomentPreview({
          moment,
          masterDurationMs: persisted.durationMs,
          contextBeforeMs: query.contextBeforeMs,
          contextAfterMs: query.contextAfterMs,
        }),
        rightsSnapshotId: persisted.rightsSnapshotId,
        rightsStatus: 'approved',
        consentStatus: 'not-required',
        eligibleForReuse: true,
        blockedReasons: [],
      }]
    },
  }
  const catalog = catalogLongFormMomentsService({
    repository,
    clock: () => new Date(createdAt),
    createId: (kind, sourceId) =>
      sourceId ? `${kind}-${sourceId}` : `${kind}-1`,
  })
  const actorAudit = authenticationAudit({
    clientId: 'client-long-form',
    credentialId: 'credential-long-form',
    workspaceId: 'workspace-long-form',
  })
  const actor = authenticatedActor({
    clientId: actorAudit.clientId,
    credentialId: actorAudit.credentialId,
    workspaceId: actorAudit.workspaceId,
  })
  const catalogRequest = {
    workspaceId: 'workspace-long-form',
    projectId: 'project-long-form',
    sourceArtifactId: 'artifact-long-form',
    expectedArtifactSha256: artifactHash,
    sourceManifestId: 'manifest-long-form',
    expectedManifestHash: manifestHash,
    indexPolicyVersion: 'long-form-index/v1',
    producer,
    chapters,
    moments,
    actor,
    provenance: { kind: 'external-request' },
    idempotencyKey: 'long-form-catalog-key',
  }
  const result = await catalog(catalogRequest)
  assert.equal(result.run.chapterCount, 2)
  assert.equal(result.run.momentCount, 2)
  assert.equal('summary' in result.run, false)
  assert.deepEqual(result.run.authenticationAudit, actorAudit)
  assert.deepEqual(result.run.provenance, { kind: 'external-request' })
  assert.equal((await catalog(catalogRequest)).replayed, true)
  await assert.rejects(
    () => catalog({
      ...catalogRequest,
      actor: authenticatedActor({
        clientId: actorAudit.clientId,
        credentialId: 'credential-long-form-other',
        workspaceId: actorAudit.workspaceId,
      }),
    }),
    (error) =>
      error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )

  const search = searchLongFormMomentsService({
    repository,
    clock: () => new Date(createdAt),
  })
  const results = await search({
    workspaceId: 'workspace-long-form',
    projectId: 'project-long-form',
    text: 'OFÉRTA',
    speakerId: 'person-specialist',
    contextBeforeMs: 10_000,
    contextAfterMs: 10_000,
  })
  assert.equal(capturedQuery.text, 'oferta')
  assert.equal(results[0].moment.sourceMomentId, 'moment-offer')
  assert.deepEqual(
    results[0].preview.primary.previewRangeMs,
    [3_990_000, 4_040_000],
  )
})

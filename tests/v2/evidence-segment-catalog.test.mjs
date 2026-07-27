import assert from 'node:assert/strict'
import test from 'node:test'

import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'
import { catalogSpeechSegments } from '../../src/v2/domain/speech-segment-catalog.ts'
import {
  authorizeEvidenceSegmentUse,
  createCatalogedEvidenceSegment,
} from '../../src/v2/domain/evidence-segment.ts'

const createdAt = '2026-07-27T13:00:00.000Z'

function sourceSpeechSegment() {
  const transcript = createMediaTranscript({
    language: 'pt-BR',
    text: 'A conversão aumentou vinte por cento neste período.',
    provider: 'fixture',
    model: 'evidence-alignment-v1',
    words: [
      { word: 'A', start: 1, end: 1.1 },
      { word: 'conversão', start: 1.1, end: 1.5 },
      { word: 'aumentou', start: 1.5, end: 1.9 },
      { word: 'vinte', start: 1.9, end: 2.1 },
      { word: 'por', start: 2.1, end: 2.2 },
      { word: 'cento', start: 2.2, end: 2.5 },
      { word: 'neste', start: 2.5, end: 2.7 },
      { word: 'período.', start: 2.7, end: 3 },
    ],
    segments: [{
      id: 10,
      start: 1,
      end: 3,
      text: 'A conversão aumentou vinte por cento neste período.',
      confidence: 0.97,
    }],
  })
  return catalogSpeechSegments({
    workspaceId: 'workspace-evidence-fixture',
    projectId: 'project-evidence-fixture',
    catalogRunId: 'speech-catalog-run-evidence-fixture',
    sourceTranscriptId: 'transcript-evidence-fixture',
    sourceArtifactId: 'artifact-evidence-fixture',
    transcript,
    annotations: [{
      sourceSegmentId: 10,
      speaker: { value: 'person-client-a', confidence: 0.99 },
    }],
    producer: {
      provider: 'apollo',
      model: 'speech-catalog',
      version: '1.0.0',
      confidence: 0.97,
    },
    createdAt,
    createSegmentId: () => 'speech-segment-evidence-fixture',
  })[0]
}

function evidence(patch = {}) {
  return createCatalogedEvidenceSegment({
    id: `evidence-segment-${patch.category ?? 'testimonial'}-fixture`,
    workspaceId: 'workspace-evidence-fixture',
    projectId: 'project-evidence-fixture',
    sourceSpeechSegment: sourceSpeechSegment(),
    transcriptDurationMs: 10_000,
    rights: {
      id: 'rights-snapshot-evidence-fixture',
      rightsStatus: 'approved',
      consentStatus: 'approved',
    },
    category: 'testimonial',
    claim: { value: 'A conversão aumentou vinte por cento', confidence: 0.98 },
    context: { value: 'Resultado observado no período medido', confidence: 0.95 },
    qualifiers: [],
    subject: { value: 'Cliente A', confidence: 0.99 },
    attribution: { value: 'Depoimento do Cliente A', confidence: 0.99 },
    compatibleOfferIds: [],
    compatibleAudienceTags: ['empreendedores'],
    compatibleObjections: [],
    credibilityScore: 0.91,
    specificityScore: 0.94,
    authenticityScore: 0.93,
    contextRangeMs: [500, 3_500],
    frameRefs: ['frame-30', 'frame-90'],
    adjacentEvidenceIds: [],
    requiresContext: false,
    producer: {
      provider: 'apollo',
      model: 'evidence-catalog',
      version: '1.0.0',
      confidence: 0.96,
    },
    actorId: 'api-client-evidence-fixture',
    createdAt,
    ...patch,
  })
}

function authorize(item, patch = {}) {
  return authorizeEvidenceSegmentUse({
    evidence: item,
    intendedClaim: item.claim.value,
    includedContext: true,
    currentRights: {
      id: item.rightsSnapshotId,
      rightsStatus: 'approved',
      consentStatus: 'approved',
    },
    now: createdAt,
    ...patch,
  })
}

test('T-FR-044 preserves exact transcript, source refs, frames, context and immutable virtual handles', () => {
  const item = evidence()
  assert.equal(
    item.exactTranscript,
    'A conversão aumentou vinte por cento neste período.',
  )
  assert.equal(item.sourceSpeechSegmentId, 'speech-segment-evidence-fixture')
  assert.equal(item.sourceTranscriptId, 'transcript-evidence-fixture')
  assert.equal(item.sourceArtifactId, 'artifact-evidence-fixture')
  assert.deepEqual(item.sourceRangeMs, [1000, 3000])
  assert.deepEqual(item.contextRangeMs, [500, 3500])
  assert.deepEqual(item.handlesMs, { before: 500, after: 500 })
  assert.deepEqual(item.frameRefs, ['frame-30', 'frame-90'])
  assert.equal(item.physicalMaterialized, false)
  assert.match(item.evidenceHash, /^[a-f0-9]{64}$/)
})

test('T-FR-044 derives claim, qualifier, subject, attribution, consent and provenance without caller-controlled transcript', () => {
  const item = evidence({
    qualifiers: [{
      value: 'No período medido e sem atribuir causalidade',
      confidence: 0.97,
    }],
  })
  assert.equal(item.claim.normalizedValue, 'a conversao aumentou vinte por cento')
  assert.equal(item.qualifiers[0].provenance.source, 'evidence-observation')
  assert.equal(item.subject.value, 'Cliente A')
  assert.equal(item.attribution.value, 'Depoimento do Cliente A')
  assert.equal(item.consentStatus, 'approved')
  assert.equal(item.requiresContext, true)
  assert.equal(item.integrityStatus, 'context-required')
})

test('T-FR-044 blocks isolated qualifier/context use and prevents claim, offer or rights drift', () => {
  const item = evidence({
    qualifiers: [{
      value: 'No período medido',
      confidence: 0.99,
    }],
    compatibleOfferIds: ['offer-approved'],
    compatibleObjections: ['preço'],
  })
  assert.deepEqual(
    authorize(item, {
      includedContext: false,
      offerId: 'offer-other',
      objection: 'tempo',
      intendedClaim: 'A receita dobrou',
    }).reasons,
    [
      'CONTEXT_REQUIRED',
      'CLAIM_DRIFT',
      'OFFER_INCOMPATIBLE',
      'OBJECTION_INCOMPATIBLE',
    ],
  )
  assert.equal(
    authorize(item, {
      offerId: 'offer-approved',
      objection: 'preço',
    }).allowed,
    true,
  )
  assert.deepEqual(
    authorize(item, {
      offerId: 'offer-approved',
      objection: 'preço',
      currentRights: {
        id: 'rights-snapshot-new',
        rightsStatus: 'revoked',
        consentStatus: 'revoked',
      },
    }).reasons,
    ['RIGHTS_SNAPSHOT_STALE', 'RIGHTS_REVOKED', 'CONSENT_REVOKED'],
  )
})

test('T-FR-044 enforces testimonial, financial, before-after and hearsay integrity policies', () => {
  const testimonial = evidence()
  const financial = evidence({
    id: 'evidence-segment-financial-fixture',
    category: 'financial-result',
    qualifiers: [{ value: 'Receita bruta no período', confidence: 0.99 }],
  })
  const beforeAfter = evidence({
    id: 'evidence-segment-before-after-fixture',
    category: 'before-after',
  })
  const hearsay = evidence({
    id: 'evidence-segment-hearsay-fixture',
    category: 'hearsay',
    qualifiers: [{ value: 'Relato sem fonte primária', confidence: 0.8 }],
  })

  assert.equal(testimonial.integrityStatus, 'valid')
  assert.equal(authorize(testimonial).allowed, true)
  assert.equal(financial.integrityStatus, 'context-required')
  assert.equal(
    authorize(financial, { includedContext: false }).allowed,
    false,
  )
  assert.deepEqual(beforeAfter.integrityReasons, ['QUALIFIER_REQUIRED'])
  assert.equal(beforeAfter.integrityStatus, 'blocked')
  assert.deepEqual(hearsay.integrityReasons, ['HEARSAY_BLOCKED'])
  assert.equal(hearsay.integrityStatus, 'blocked')
})

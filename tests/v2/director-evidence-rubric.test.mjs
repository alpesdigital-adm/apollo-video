import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import {
  CONFIDENCE_BAND_POLICY,
  CONFIDENCE_BAND_POLICY_V1_SHA256,
  CONFIDENCE_BAND_POLICY_V2,
  CONFIDENCE_BAND_POLICY_V2_SHA256,
  EVIDENCE_GATED_DECISION_TYPES,
  classifyConfidence,
  classifyConfidenceV2,
  createDecisionConfidence,
} from '../../src/v2/domain/decision-confidence.ts'
import {
  DIRECTOR_EVIDENCE_RUBRIC,
  DIRECTOR_EVIDENCE_RUBRIC_SHA256,
  EVIDENCE_ID_CAP,
  assessDecisionEvidence,
  assessPerceptionModality,
  assessRightsModality,
  bandOfDecisionEvidence,
  evaluateSourceRightsCertainty,
  parseDecisionPerceptionEvidence,
  requiredModalitiesFor,
  verifyDecisionEvidenceAgainstSnapshot,
  weakestTier,
} from '../../src/v2/domain/director-evidence-rubric.ts'
import { validateDirectorDecisions } from '../../src/v2/domain/director-run.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import { createPerceptionTimeline, mergeRanges } from '../../src/v2/domain/perception-timeline.ts'
import { serverPerceptionSnapshotId } from '../../src/v2/domain/server-perception-snapshot.ts'
import { sha } from './helpers/perception-snapshot-fixtures.mjs'

/**
 * W64 unit proofs of the Director's evidence rubric and of confidence-band-policy/v2: the tier of a modality over a range
 * (boundaries, ceilings, pending requests), the integral rights verdict, the band per decision type on (tier, confidence), and the
 * strict re-reading of a stored decision. Snapshots here are hand-made so that every millisecond of coverage is stated, never inferred.
 */

const DURATION = 10_000

function observation(kind, id, startMs, endMs, confidence, basis = 'producer-reported') {
  return { id, kind, startMs, endMs, value: { id }, provenance: { source: 'envelope-1', model: 'controlled', version: sha('a'), confidence,
    origin: 'server', producer: 'controlled', envelopeId: 'envelope-1', envelopeHash: sha('a'), confidenceBasis: basis } }
}

/** A snapshot-shaped value: `kinds` maps a perception kind to the ms ranges it examined, its observations and the coverage reason. */
function snapshotOf(kinds = {}, { inputs = [], durationMs = DURATION, snapshotHash = sha('c') } = {}) {
  const observations = Object.values(kinds).flatMap((spec) => spec.observations ?? [])
  const coverage = ['transcript-word', 'speaker', 'silence', 'face', 'object', 'shot', 'motion', 'ocr', 'image-insert'].map((kind) => {
    const ranges = kinds[kind]?.ranges ?? []
    const covered = mergeRanges(ranges).reduce((sum, [start, end]) => sum + end - start, 0)
    // a complete kind states no reason; any other states one (the producer's, or the generic ones the assembler uses)
    return covered === durationMs ? { kind, ranges }
      : { kind, ranges, reasonCode: kinds[kind]?.reasonCode ?? (covered === 0 ? 'NO_PRODUCER_RUN' : 'SAMPLED_FRAMES_ONLY') }
  })
  return { timeline: createPerceptionTimeline({ durationMs, origin: 'server', observations, coverage }), inputs, snapshotHash }
}

const whole = [[0, DURATION]]

test('W64 rubric: the policy and the rubric are sealed by hash, and the v1 policy is exactly what it was', () => {
  assert.equal(CONFIDENCE_BAND_POLICY.schemaVersion, 'confidence-band-policy/v1')
  // Pinned: the v1 policy that every run born before W64 is graded by never changes; v2 and the rubric change only by a new hash
  // (and, with it, a reviewed edit of these three lines).
  assert.equal(CONFIDENCE_BAND_POLICY_V1_SHA256, '1d210d508cc54de38b55ec16d7f789b92b0411a44cf15889ed28e3e19e0fb43c')
  assert.equal(CONFIDENCE_BAND_POLICY_V2_SHA256, '7352b6295bf69af31ba4c36c2629922d9e1cd0d297fc7c910f05d41312158b34')
  assert.equal(DIRECTOR_EVIDENCE_RUBRIC_SHA256, 'fe25d5b395fadfa1cf5fafd094f243c4bf6b209da1fc6661f432df358e4bf75d')
  assert.equal(calculateCanonicalHash(CONFIDENCE_BAND_POLICY), CONFIDENCE_BAND_POLICY_V1_SHA256)
  assert.equal(CONFIDENCE_BAND_POLICY_V2.schemaVersion, 'confidence-band-policy/v2')
  assert.equal(calculateCanonicalHash(CONFIDENCE_BAND_POLICY_V2), CONFIDENCE_BAND_POLICY_V2_SHA256)
  assert.equal(calculateCanonicalHash(DIRECTOR_EVIDENCE_RUBRIC), DIRECTOR_EVIDENCE_RUBRIC_SHA256)
  assert.notEqual(CONFIDENCE_BAND_POLICY_V1_SHA256, CONFIDENCE_BAND_POLICY_V2_SHA256)
  // v2 keeps every v1 threshold: a v1 type is graded the same under either.
  for (const type of Object.keys(CONFIDENCE_BAND_POLICY).filter((key) => key !== 'schemaVersion')) {
    assert.deepEqual(CONFIDENCE_BAND_POLICY_V2[type], CONFIDENCE_BAND_POLICY[type], type)
  }
  assert.equal(Object.isFrozen(CONFIDENCE_BAND_POLICY_V2) && Object.isFrozen(CONFIDENCE_BAND_POLICY_V2.crop), true)
  assert.deepEqual([...EVIDENCE_GATED_DECISION_TYPES], ['crop', 'caption', 'insert'])
  // The face ceiling is read from the face evidence policy: boxes of an undeployed detector never reach `high`.
  assert.equal(DIRECTOR_EVIDENCE_RUBRIC.modalities.face.ceiling, 'partial')
  assert.equal(DIRECTOR_EVIDENCE_RUBRIC.modalities.face.ceilingReasonCode, 'FACE_DETECTOR_NOT_DEPLOYABLE')
  assert.deepEqual(requiredModalitiesFor('crop', false), ['face'])
  assert.deepEqual(requiredModalitiesFor('caption', false), ['transcript-word', 'face', 'ocr'])
  assert.deepEqual(requiredModalitiesFor('insert', false), [])
  assert.deepEqual(requiredModalitiesFor('insert', true), ['rights'])
})

test('W64 tiers: nothing examined is absent with the reason the snapshot gives, a range partly examined is partial', () => {
  const none = assessPerceptionModality(snapshotOf(), 'ocr', whole)
  assert.equal(none.tier, 'absent')
  assert.equal(none.reasonCode, 'NO_PRODUCER_RUN')
  assert.equal(none.examinedMs, 0)
  assert.equal(none.observationCount, 0)

  const some = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100]], observations: [observation('ocr', 'ocr-1', 0, 100, 0.9)] } }), 'ocr', whole)
  assert.equal(some.tier, 'partial')
  assert.equal(some.reasonCode, 'PARTIAL_COVERAGE')
  assert.equal(some.examinedMs, 100)
  assert.ok(some.denseMs < some.rangeMs)

  // an examined range elsewhere in the timeline says nothing about this range
  const elsewhere = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100]], observations: [observation('ocr', 'ocr-1', 0, 100, 0.9)] } }), 'ocr', [[5000, 6000]])
  assert.equal(elsewhere.tier, 'absent')
  assert.equal(elsewhere.reasonCode, 'SAMPLED_FRAMES_ONLY')
})

test('W64 tiers: the density gap is the boundary between partial and high (OCR gap 2000 ms: a hole of exactly 2000 is covered, 2001 is not)', () => {
  const sample = (start, end, id) => observation('ocr', id, start, end, 0.9)
  const at2000 = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100], [2100, 2200]], observations: [sample(0, 100, 'a'), sample(2100, 2200, 'b')] } }), 'ocr', [[0, 3200]])
  assert.equal(at2000.denseMs, 3200, 'half the gap on each side of the samples touches')
  assert.equal(at2000.tier, 'high')
  const at2001 = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100], [2101, 2201]], observations: [sample(0, 100, 'a'), sample(2101, 2201, 'b')] } }), 'ocr', [[0, 3201]])
  assert.equal(at2001.denseMs, 3200, 'one millisecond more and the instant between them is spoken for by neither sample')
  assert.equal(at2001.tier, 'partial')
  assert.equal(at2001.reasonCode, 'PARTIAL_COVERAGE')
  // the edges of the range count: a sample must be within half the gap of both ends
  const farEnd = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100]], observations: [sample(0, 100, 'a')] } }), 'ocr', [[0, 1101]])
  assert.equal(farEnd.tier, 'partial')
  const nearEnd = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100]], observations: [sample(0, 100, 'a')] } }), 'ocr', [[0, 1100]])
  assert.equal(nearEnd.tier, 'high')
  // several ranges are assessed together: a decision spread over two stretches needs both of them examined
  const two = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, 100]], observations: [sample(0, 100, 'a')] } }), 'ocr', [[0, 500], [5000, 5500]])
  assert.equal(two.rangeMs, 1000)
  assert.equal(two.tier, 'partial')
})

test('W64 tiers: high needs MEASURED confidence at or above the floor; a prior is not a measurement and a low mean is not high', () => {
  const observations = (confidence, basis) => ({ ocr: { ranges: [[0, DURATION]], observations: [observation('ocr', 'o-1', 0, DURATION, confidence, basis)] } })
  // ocr floor is 0.6 (>=)
  assert.equal(assessPerceptionModality(snapshotOf(observations(0.6)), 'ocr', whole).tier, 'high')
  const below = assessPerceptionModality(snapshotOf(observations(0.599999)), 'ocr', whole)
  assert.equal(below.tier, 'partial')
  assert.equal(below.reasonCode, 'BELOW_CONFIDENCE_FLOOR')
  assert.equal(below.confidence, 0.599999)
  // a deterministic measurement counts as measured
  const deterministic = assessPerceptionModality(snapshotOf(observations(1, 'deterministic-measurement')), 'ocr', whole)
  assert.equal(deterministic.tier, 'high')
  assert.equal(deterministic.confidenceBasis, 'deterministic-measurement')
  // a policy prior is covered but never measured: partial, with its own reason, however high the number
  const prior = assessPerceptionModality(snapshotOf(observations(0.99, 'policy-prior')), 'ocr', whole)
  assert.equal(prior.tier, 'partial')
  assert.equal(prior.reasonCode, 'CONFIDENCE_NOT_MEASURED')
  assert.equal(prior.confidence, null)
  assert.equal(prior.confidenceBasis, 'policy-prior')
  // the mean of the measured observations is what is compared, and only the measured ones enter it
  const mixed = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: [
    observation('ocr', 'o-1', 0, 5000, 0.9), observation('ocr', 'o-2', 5000, DURATION, 0.3), observation('ocr', 'o-3', 100, 200, 0.01, 'policy-prior')] } }), 'ocr', whole)
  assert.equal(mixed.confidence, 0.6)
  assert.equal(mixed.tier, 'high', 'mean(0.9, 0.3) = 0.6 is at the floor; the prior is left out')
  // dense coverage with no observation at all (every sampled frame had no text) is a measurement of absence: high
  const empty = assessPerceptionModality(snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: [] } }), 'ocr', whole)
  assert.equal(empty.tier, 'high')
  assert.equal(empty.confidence, null)
  assert.equal(empty.confidenceBasis, 'none')
  // the transcript's words carry a prior in the snapshot, so a transcript is never `high` until its confidence is measured
  const words = assessPerceptionModality(snapshotOf({ 'transcript-word': { ranges: [[0, DURATION]], observations: [observation('transcript-word', 'w-1', 0, DURATION, 0.82, 'policy-prior')] } }), 'transcript-word', whole)
  assert.equal(words.tier, 'partial')
  assert.equal(words.reasonCode, 'CONFIDENCE_NOT_MEASURED')
})

test('W64 tiers: face evidence is NEVER high - dense coverage, perfect scores, the ceiling still holds', () => {
  const perfect = assessPerceptionModality(snapshotOf({ face: { ranges: [[0, DURATION]],
    observations: [observation('face', 'f-1', 0, DURATION, 1.0)] } }), 'face', whole)
  assert.equal(perfect.tier, 'partial')
  assert.equal(perfect.reasonCode, 'FACE_DETECTOR_NOT_DEPLOYABLE')
  assert.equal(perfect.ceilingApplied, true)
  assert.equal(perfect.denseMs, perfect.rangeMs)
  assert.equal(perfect.confidence, 1)
  // below that, face reads like any modality: partial coverage is partial for its own reason
  const sparse = assessPerceptionModality(snapshotOf({ face: { ranges: [[0, 100]], observations: [observation('face', 'f-1', 0, 100, 1.0)] } }), 'face', whole)
  assert.equal(sparse.tier, 'partial')
  assert.equal(sparse.reasonCode, 'PARTIAL_COVERAGE')
  assert.equal(sparse.ceilingApplied, false)
  // and a stored assessment claiming face is high is refused whatever hash it carries
  const evidence = assessDecisionEvidence({ decisionId: 'decision-crop-1', decisionType: 'crop', snapshotId: serverPerceptionSnapshotId(sha('c')),
    snapshot: snapshotOf({ face: { ranges: [[0, DURATION]], observations: [observation('face', 'f-1', 0, DURATION, 1.0)] } }), rangesMs: whole })
  assert.equal(evidence.tier, 'partial')
  const forged = { ...evidence, tier: 'high', modalities: evidence.modalities.map((item) => ({ ...item, tier: 'high', ceilingApplied: false })) }
  const { evidenceHash: _dropped, ...body } = forged
  assert.throws(() => parseDecisionPerceptionEvidence({ ...body, evidenceHash: calculateCanonicalHash(body) }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT')
})

test('W64 tiers: face windows that were asked for and are not sealed are pending, not silently absent; a refused request says so', () => {
  const none = snapshotOf()
  const pending = { pendingRangesMs: [[0, 4000]], failedRangesMs: [] }
  const refused = { pendingRangesMs: [], failedRangesMs: [[0, DURATION]] }
  const wasPending = assessPerceptionModality(none, 'face', [[1000, 2000]], pending)
  assert.equal(wasPending.tier, 'absent')
  assert.equal(wasPending.reasonCode, 'FACE_EVIDENCE_PENDING')
  assert.equal(wasPending.pendingMs, 1000)
  assert.equal(assessPerceptionModality(none, 'face', whole, refused).reasonCode, 'FACE_EVIDENCE_REQUEST_FAILED')
  // outside the requested windows the plain reason stands
  assert.equal(assessPerceptionModality(none, 'face', [[5000, 6000]], pending).reasonCode, 'NO_PRODUCER_RUN')
  // part sealed, the rest pending: partial, and the rest is named
  const half = snapshotOf({ face: { ranges: [[0, 4000]], observations: [observation('face', 'f-1', 0, 4000, 0.9)] } })
  const rest = assessPerceptionModality(half, 'face', whole, { pendingRangesMs: [[4000, DURATION]], failedRangesMs: [] })
  assert.equal(rest.tier, 'partial')
  assert.equal(rest.reasonCode, 'PARTIAL_COVERAGE_REST_PENDING')
  assert.equal(rest.pendingMs, 6000)
  // pending only ever refers to face: it cannot make another modality's absence look like a request
  assert.equal(assessPerceptionModality(none, 'ocr', whole, pending).reasonCode, 'NO_PRODUCER_RUN')
})

test('W64 tiers: the assessment is a pure function and names the sealed evidence it stands on, with the full list sealed by hash', () => {
  const many = Array.from({ length: EVIDENCE_ID_CAP + 36 }, (_, index) => observation('ocr', `ocr-${String(index).padStart(3, '0')}`, index * 50, index * 50 + 40, 0.9))
  const inputs = [{ kind: 'ocr', envelopeId: 'ocr-envelope-b' }, { kind: 'ocr', envelopeId: 'ocr-envelope-a' }, { kind: 'face', envelopeId: 'face-window-1' }]
  const snapshot = snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: many } }, { inputs })
  const first = assessPerceptionModality(snapshot, 'ocr', whole)
  const second = assessPerceptionModality(snapshot, 'ocr', [[0, DURATION]])
  assert.equal(calculateCanonicalHash(first), calculateCanonicalHash(second))
  assert.deepEqual(first.envelopeIds, ['ocr-envelope-a', 'ocr-envelope-b'], 'only the envelopes of this modality, in order')
  assert.equal(first.observationCount, EVIDENCE_ID_CAP + 36)
  assert.equal(first.observationIds.length, EVIDENCE_ID_CAP)
  assert.equal(first.observationIds[0], 'ocr-000')
  assert.equal(first.observationIdsHash, calculateCanonicalHash(many.map((item) => item.id)), 'the hash covers every id, listed or not')
  assert.throws(() => assessPerceptionModality(snapshot, 'ocr', [[0, DURATION + 1]]), (error) => error.code === 'INVALID_ARGUMENT')
  assert.throws(() => assessPerceptionModality(snapshot, 'ocr', []), (error) => error.code === 'INVALID_ARGUMENT')
})

test('W64 rights are integral: certain only when approved, consented, current - never partial', () => {
  const now = new Date('2026-10-19T12:00:00.000Z')
  const rights = (overrides = {}) => ({ state: 'present', snapshotId: 'rights-1', snapshotHash: sha('d'), status: 'approved', consentStatus: 'not-required', ...overrides })
  assert.deepEqual(evaluateSourceRightsCertainty('a', rights(), now), { artifactId: 'a', certain: true, reasonCode: 'RIGHTS_CERTAIN', snapshotId: 'rights-1', snapshotHash: sha('d') })
  assert.equal(evaluateSourceRightsCertainty('a', rights({ consentStatus: 'approved' }), now).certain, true)
  const refusals = {
    revoked: [rights({ status: 'revoked' }), 'RIGHTS_STATUS_REVOKED'],
    pending: [rights({ status: 'pending' }), 'RIGHTS_STATUS_PENDING'],
    consentPending: [rights({ consentStatus: 'pending' }), 'CONSENT_STATUS_PENDING'],
    expired: [rights({ expiresAt: now.toISOString() }), 'RIGHTS_EXPIRED'],
    consentExpired: [rights({ consentExpiresAt: '2026-10-19T11:59:59.999Z' }), 'CONSENT_EXPIRED'],
    brokenDate: [rights({ expiresAt: 'not-a-date' }), 'RIGHTS_EXPIRED'],
    missing: [{ state: 'missing' }, 'RIGHTS_UNKNOWN'],
    unlisted: [undefined, 'RIGHTS_UNKNOWN'],
  }
  for (const [name, [record, reasonCode]] of Object.entries(refusals)) {
    const verdict = evaluateSourceRightsCertainty('a', record, now)
    assert.equal(verdict.certain, false, name)
    assert.equal(verdict.reasonCode, reasonCode, name)
  }
  assert.equal(evaluateSourceRightsCertainty('a', rights({ expiresAt: '2026-10-19T12:00:00.001Z' }), now).certain, true, 'one millisecond before expiry is still certain')
  // one uncertain source among certain ones makes the whole modality absent; there is no partial
  const certain = evaluateSourceRightsCertainty('a', rights(), now)
  const uncertain = evaluateSourceRightsCertainty('b', { state: 'missing' }, now)
  assert.equal(assessRightsModality([certain, certain], 1000).tier, 'high')
  const mixed = assessRightsModality([certain, uncertain], 1000)
  assert.equal(mixed.tier, 'absent')
  assert.equal(mixed.reasonCode, 'RIGHTS_UNKNOWN')
  assert.equal(assessRightsModality([], 1000).tier, 'absent', 'no source to be certain about is not certainty')
  for (const verdicts of [[], [certain], [uncertain], [certain, uncertain]]) assert.notEqual(assessRightsModality(verdicts, 1000).tier, 'partial')
})

test('W64 band policy v2: the band of crop, caption and insert on (tier, confidence), at every boundary', () => {
  const confidence = (value) => createDecisionConfidence({ value, evidence: [{ ref: 'evidence-ref-1', weight: 1 }], reasonCodes: ['DIRECTOR_TEST'], calibrationVersion: 'director-confidence-2026-08-v1' })
  const table = {
    crop: { autoApply: 0.8, review: 0.62, onAbsent: 'review' },
    caption: { autoApply: 0.8, review: 0.7, onAbsent: 'review' },
    insert: { autoApply: 0.9, review: 0.65, onAbsent: 'block' },
  }
  for (const [type, rule] of Object.entries(table)) {
    assert.deepEqual({ autoApply: CONFIDENCE_BAND_POLICY_V2[type].autoApply, review: CONFIDENCE_BAND_POLICY_V2[type].review, onAbsent: CONFIDENCE_BAND_POLICY_V2[type].onAbsent }, rule, type)
    const band = (tier, value) => classifyConfidenceV2(type, confidence(value), tier)
    // high: auto-apply at the threshold, review just under it, block under the review floor
    assert.equal(band('high', rule.autoApply), 'auto-apply', `${type} high at autoApply`)
    assert.equal(band('high', rule.autoApply - 0.001), 'review', `${type} high just under autoApply`)
    assert.equal(band('high', rule.review), 'review', `${type} high at review floor`)
    assert.equal(band('high', rule.review - 0.001), 'block', `${type} high under review floor`)
    // partial can never auto-apply, however sure the planner is
    assert.equal(band('partial', 1), 'review', `${type} partial at 1.0`)
    assert.equal(band('partial', rule.review), 'review')
    assert.equal(band('partial', rule.review - 0.001), 'block')
    // absent is never auto-apply: the type's own answer, and block under the floor regardless
    assert.equal(band('absent', 1), rule.onAbsent, `${type} absent at 1.0`)
    assert.equal(band('absent', rule.autoApply), rule.onAbsent)
    assert.equal(band('absent', rule.review), rule.onAbsent)
    assert.equal(band('absent', rule.review - 0.001), 'block')
    // the tier is required: a gated type is never graded without it
    assert.throws(() => classifyConfidenceV2(type, confidence(1)), (error) => error.code === 'INVALID_ARGUMENT')
    assert.throws(() => classifyConfidenceV2(type, confidence(1), 'excellent'), (error) => error.code === 'INVALID_ARGUMENT')
  }
  // exhaustive: no gated type, tier or confidence on a fine grid reaches auto-apply unless the tier is high
  for (const type of EVIDENCE_GATED_DECISION_TYPES) for (const tier of ['partial', 'absent']) {
    for (let value = 0; value <= 1.0000001; value += 0.01) {
      assert.notEqual(classifyConfidenceV2(type, confidence(Math.min(1, value)), tier), 'auto-apply', `${type} ${tier} ${value}`)
    }
  }
  // rights stay integral and ignore the tier; the v1 types are graded as v1 grades them
  assert.equal(classifyConfidenceV2('rights', confidence(1)), 'auto-apply')
  assert.equal(classifyConfidenceV2('rights', confidence(0.999999)), 'block')
  assert.equal(classifyConfidenceV2('rights', confidence(0.999999), 'high'), 'block')
  for (const type of ['transcription', 'cut', 'asset-selection', 'narrative-reorder', 'generation']) {
    for (const value of [0, 0.5, 0.6, 0.62, 0.65, 0.7, 0.75, 0.85, 0.86, 0.88, 0.9, 0.92, 1]) {
      assert.equal(classifyConfidenceV2(type, confidence(value)), classifyConfidence(type, confidence(value)), `${type} ${value}`)
    }
  }
  assert.throws(() => classifyConfidence('crop', confidence(1)), (error) => error.code === 'INVALID_ARGUMENT', 'v1 knows nothing of the new types')
})

test('W64 decisions: the weakest required modality is the decision tier, an omitted insert needs nothing, and the band follows the tier', () => {
  assert.equal(weakestTier(['high', 'high']), 'high')
  assert.equal(weakestTier(['high', 'partial']), 'partial')
  assert.equal(weakestTier(['partial', 'absent', 'high']), 'absent')
  const snapshotId = serverPerceptionSnapshotId(sha('c'))
  const snapshot = snapshotOf({
    ocr: { ranges: [[0, DURATION]], observations: [observation('ocr', 'ocr-1', 0, DURATION, 0.9)] },
    'transcript-word': { ranges: [[0, DURATION]], observations: [observation('transcript-word', 'w-1', 0, DURATION, 0.82, 'policy-prior')] },
  }, { inputs: [{ kind: 'ocr', envelopeId: 'ocr-envelope-1' }] })
  const caption = assessDecisionEvidence({ decisionId: 'decision-caption-1', decisionType: 'caption', snapshot, snapshotId, rangesMs: whole })
  assert.deepEqual(caption.modalities.map((item) => [item.modality, item.tier]), [['transcript-word', 'partial'], ['face', 'absent'], ['ocr', 'high']])
  assert.equal(caption.tier, 'absent', 'one absent modality makes the decision absent')
  const confidence = createDecisionConfidence({ value: 0.82, evidence: [{ ref: snapshotId, weight: 1 }], reasonCodes: ['DIRECTOR_SUBTITLE'], calibrationVersion: 'director-confidence-2026-08-v1' })
  assert.equal(bandOfDecisionEvidence(caption, confidence), 'review')
  const omitted = assessDecisionEvidence({ decisionId: 'decision-insert-1', decisionType: 'insert', snapshot, snapshotId, rangesMs: whole, inserted: false })
  assert.deepEqual(omitted.modalities, [])
  assert.equal(omitted.tier, 'high', 'nothing is proposed, so nothing needs evidence')
  const unknownRights = evaluateSourceRightsCertainty('insert-1', undefined, new Date())
  const inserted = assessDecisionEvidence({ decisionId: 'decision-insert-1', decisionType: 'insert', snapshot, snapshotId, rangesMs: whole, inserted: true, rights: [unknownRights] })
  assert.equal(inserted.tier, 'absent')
  assert.equal(bandOfDecisionEvidence(inserted, createDecisionConfidence({ value: 1, evidence: [{ ref: snapshotId, weight: 1 }], reasonCodes: ['DIRECTOR_INSERT'], calibrationVersion: 'director-confidence-2026-08-v1' })), 'block',
    'an insert on uncertain rights is blocked even at planner confidence 1.0')
})

function plannedDecision(evidence, overrides = {}) {
  const base = {
    id: evidence.decisionId, category: evidence.decisionType === 'crop' ? 'layout' : evidence.decisionType === 'caption' ? 'subtitle' : 'insert',
    choice: 'a-choice', reason: 'A reason.', confidence: 0.82, alternatives: ['other'],
    evidenceRefs: ['plan-snapshot-1', evidence.snapshot.id], bandPolicy: { schemaVersion: 'confidence-band-policy/v2', policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 },
    perceptionEvidence: evidence,
  }
  return { ...base, ...overrides }
}

test('W64 stored decisions are re-read strictly: policy, evidence seal, tier, band and the snapshot named as evidence', () => {
  const snapshotId = serverPerceptionSnapshotId(sha('c'))
  const snapshot = snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: [observation('ocr', 'ocr-1', 0, DURATION, 0.9)] } })
  const crop = assessDecisionEvidence({ decisionId: 'decision-layout-1', decisionType: 'crop', snapshot, snapshotId, rangesMs: whole })
  const filler = ['narrative', 'movement', 'transition'].map((category, index) => ({
    id: `decision-${category}-1`, category, choice: 'x', reason: 'y', confidence: 0.9, alternatives: ['z'], evidenceRefs: [`ref-${index}-aaa`],
    bandPolicy: { schemaVersion: 'confidence-band-policy/v2', policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 },
  }))
  const validated = validateDirectorDecisions([...filler, plannedDecision(crop)])
  const stored = JSON.parse(JSON.stringify(validated))
  const layout = validated.find((item) => item.id === 'decision-layout-1')
  assert.equal(layout.decisionType, 'crop')
  assert.equal(layout.confidenceBand, 'review')
  assert.equal(layout.perceptionEvidence.tier, 'absent')
  // a stored run reads back to the same decisions
  assert.deepEqual(JSON.parse(JSON.stringify(validateDirectorDecisions(stored))), stored)

  const tamper = (mutate) => () => validateDirectorDecisions(mutate(JSON.parse(JSON.stringify(stored))))
  const layoutOf = (decisions) => decisions.find((item) => item.id === 'decision-layout-1')
  const conflict = (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
  // the band is the policy's band for (tier, confidence): raising it is refused
  assert.throws(tamper((d) => { layoutOf(d).confidenceBand = 'auto-apply'; return d }), conflict)
  // the evidence is sealed: editing the tier invalidates the seal; re-sealing around a wrong tier fails the tier-from-figures rule
  assert.throws(tamper((d) => { layoutOf(d).perceptionEvidence.tier = 'high'; return d }), conflict)
  assert.throws(tamper((d) => { const e = layoutOf(d).perceptionEvidence; e.modalities[0].examinedMs = 5; return d }), conflict)
  assert.throws(tamper((d) => { delete layoutOf(d).perceptionEvidence; return d }), conflict, 'an evidence-gated decision without evidence')
  assert.throws(tamper((d) => { d.find((item) => item.id === 'decision-narrative-1').perceptionEvidence = layoutOf(d).perceptionEvidence; return d }), conflict,
    'a decision that is not evidence-gated carries none')
  assert.throws(tamper((d) => { layoutOf(d).evidenceRefs = ['plan-snapshot-1']; return d }), conflict, 'the snapshot must be named as evidence')
  assert.throws(tamper((d) => { layoutOf(d).bandPolicy.policyHash = sha('9'); return d }), conflict, 'an unknown policy hash')
  assert.throws(tamper((d) => { layoutOf(d).decisionType = 'generation'; return d }), conflict, 'the type is the policy\'s for the category')
  // evidence about another decision is not this decision's evidence
  const other = assessDecisionEvidence({ decisionId: 'decision-other-1', decisionType: 'crop', snapshot, snapshotId, rangesMs: whole })
  assert.throws(() => validateDirectorDecisions([...filler, plannedDecision(crop, { perceptionEvidence: other })]), conflict)
  // v1 decisions (no band policy) stay graded by v1 exactly as before, under their old type
  const v1 = validateDirectorDecisions([...filler.map(({ bandPolicy: _bandPolicy, ...rest }) => rest),
    { id: 'decision-layout-0', category: 'layout', choice: 'x', reason: 'y', confidence: 0.82, alternatives: ['z'], evidenceRefs: ['ref-9-aaa'] }])
  assert.equal(v1.at(-1).decisionType, 'generation')
  assert.equal(v1.at(-1).confidenceBand, 'review')
  assert.equal(v1.at(-1).perceptionEvidence, undefined)
  assert.throws(() => validateDirectorDecisions([...filler.map(({ bandPolicy: _bandPolicy, ...rest }) => rest),
    { id: 'decision-layout-0', category: 'layout', choice: 'x', reason: 'y', confidence: 0.82, alternatives: ['z'], evidenceRefs: ['ref-9-aaa'], perceptionEvidence: crop }]), conflict,
  'a v1 decision cannot claim evidence tiers')
})

test('W64 a record cannot seal itself with fewer requirements than the rubric demands of its decision type', () => {
  const snapshotId = serverPerceptionSnapshotId(sha('c'))
  const snapshot = snapshotOf({})
  const seal = (record) => { const { evidenceHash: _dropped, ...body } = record; return { ...body, evidenceHash: calculateCanonicalHash(body) } }
  const conflict = (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT'
  const crop = JSON.parse(JSON.stringify(assessDecisionEvidence({ decisionId: 'decision-layout-1', decisionType: 'crop', snapshot, snapshotId, rangesMs: whole })))
  assert.deepEqual(crop.required, ['face'])
  // a crop that requires nothing is vacuously high; re-sealed so that every other rule holds, only the requirement is wrong
  const hollow = seal({ ...crop, required: [], modalities: [], tier: 'high' })
  assert.throws(() => parseDecisionPerceptionEvidence(hollow), conflict)
  // the caption's three, in any lesser form
  const caption = JSON.parse(JSON.stringify(assessDecisionEvidence({ decisionId: 'decision-caption-1', decisionType: 'caption', snapshot, snapshotId, rangesMs: whole })))
  const lesser = seal({ ...caption, required: ['ocr'], modalities: caption.modalities.filter((item) => item.modality === 'ocr'), tier: caption.modalities.find((item) => item.modality === 'ocr').tier })
  assert.throws(() => parseDecisionPerceptionEvidence(lesser), conflict)
  assert.throws(() => parseDecisionPerceptionEvidence(seal({ ...caption, required: [...caption.required].reverse(), modalities: [...caption.modalities].reverse() })), conflict, 'nor another order')
  assert.doesNotThrow(() => parseDecisionPerceptionEvidence(caption))
  // through a decision: the requirement must also be the one of ITS choice (an insert that proposes footage stands on rights, not on nothing)
  const none = JSON.parse(JSON.stringify(assessDecisionEvidence({ decisionId: 'decision-insert-1', decisionType: 'insert', snapshot, snapshotId, rangesMs: whole, inserted: false })))
  assert.deepEqual(none.required, [])
  const decision = (choice, evidence) => ({ id: 'decision-insert-1', category: 'insert', choice, reason: 'y', confidence: 1, alternatives: ['z'], evidenceRefs: ['ref-9-aaa', snapshotId],
    bandPolicy: { schemaVersion: 'confidence-band-policy/v2', policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 }, perceptionEvidence: evidence })
  const filler = ['narrative', 'movement', 'transition'].map((category, index) => ({ id: `decision-${category}-1`, category, choice: 'x', reason: 'y', confidence: 0.9,
    alternatives: ['z'], evidenceRefs: [`ref-${index}-aaa`], bandPolicy: { schemaVersion: 'confidence-band-policy/v2', policyHash: CONFIDENCE_BAND_POLICY_V2_SHA256 } }))
  assert.doesNotThrow(() => validateDirectorDecisions([...filler, decision('no_insert', none)]))
  assert.throws(() => validateDirectorDecisions([...filler, decision('use_selected_insert', none)]), conflict, 'a selected insert whose record requires nothing would grade auto-apply')
  const rights = assessDecisionEvidence({ decisionId: 'decision-insert-1', decisionType: 'insert', snapshot, snapshotId, rangesMs: whole, inserted: true,
    rights: [evaluateSourceRightsCertainty('a', { state: 'present', snapshotId: 'rights-1', snapshotHash: sha('d'), status: 'approved', consentStatus: 'not-required' }, new Date())] })
  assert.doesNotThrow(() => validateDirectorDecisions([...filler, decision('use_selected_insert', rights)]))
  assert.throws(() => validateDirectorDecisions([...filler, decision('no_insert', rights)]), conflict, 'and an omitted insert does not claim rights it did not use')
})

test('W64 the oracle: stored evidence re-derived from its snapshot must be byte-identical, and a tier the snapshot does not support fails', () => {
  const snapshotId = serverPerceptionSnapshotId(sha('c'))
  const snapshot = snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: [observation('ocr', 'ocr-1', 0, DURATION, 0.9)] } }, { inputs: [{ kind: 'ocr', envelopeId: 'ocr-envelope-1' }] })
  const evidence = assessDecisionEvidence({ decisionId: 'decision-caption-1', decisionType: 'caption', snapshot, snapshotId, rangesMs: whole })
  const stored = JSON.parse(JSON.stringify(evidence))
  const parsed = parseDecisionPerceptionEvidence(stored)
  verifyDecisionEvidenceAgainstSnapshot(parsed, snapshot, { snapshotId })
  // a snapshot with the same hash and different content cannot support the stored figures
  const richer = snapshotOf({ ocr: { ranges: [[0, DURATION]], observations: [observation('ocr', 'ocr-1', 0, DURATION, 0.9)] },
    face: { ranges: [[0, DURATION]], observations: [observation('face', 'f-1', 0, DURATION, 0.9)] } }, { inputs: [{ kind: 'ocr', envelopeId: 'ocr-envelope-1' }] })
  assert.throws(() => verifyDecisionEvidenceAgainstSnapshot(parsed, richer, { snapshotId }), (error) => error.code === 'PERSISTENCE_CONFLICT')
  // the same figures with a different pending request state are different evidence too
  assert.throws(() => verifyDecisionEvidenceAgainstSnapshot(parsed, snapshot, { snapshotId, faceRequests: { pendingRangesMs: [[0, 1000]], failedRangesMs: [] } }),
    (error) => error.code === 'PERSISTENCE_CONFLICT')
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { promoteSyntheticMasterAssetService } from '../../src/v2/application/synthetic-master-assets.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { calculateCanonicalHash } from '../../src/v2/domain/canonical-hash.ts'
import { createAvatarOutputSpeechEvidence } from '../../src/v2/domain/avatar-output-speech-evidence.ts'
import { createSyntheticCriticReport } from '../../src/v2/domain/synthetic-critic-report.ts'
import { createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'

const digest = (character) => character.repeat(64)
const workspaceId = 'promotion-workspace'
const projectId = 'promotion-project'
const providerJobId = 'promotion-job'
const now = new Date('2029-05-01T00:00:00.000Z')
const scriptText = 'Primeira ideia do roteiro. Segunda ideia bem forte.'
const scriptHash = createHash('sha256').update(scriptText, 'utf8').digest('hex')
const audioRangeHash = digest('6')

const snapshot = createSyntheticPresenterProfileSnapshot({
  id: 'promotion-presenter',
  version: 3,
  actorIdentityId: 'promotion-identity',
  avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_promotion' },
  voice: { id: 'voice_promotion', version: 1, adapterId: 'elevenlabs-tts', adapterVersion: '1.0.0' },
  defaultLocale: 'pt-BR',
  status: 'active',
  disclosure: 'Conteúdo gerado com IA',
  consent: {
    id: 'promotion-consent', evidenceArtifactId: 'promotion-consent-evidence', evidenceSha256: digest('e'), granted: true,
    allowedUses: ['ads'], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
    allowedOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
  },
})

// The provider result ledger admits exactly these three roles
// (`provider_result_artifacts_media_check`), so a promotable job carries three.
const ROLES = {
  'provider-original': { providerRole: 'primary-video', artifactId: 'artifact-original', sha256: digest('a'), mediaType: 'video', container: 'mp4' },
  'final-audio': { providerRole: 'primary-audio', artifactId: 'artifact-audio', sha256: digest('c'), mediaType: 'audio', container: 'wav' },
  alignment: { providerRole: 'alignment-evidence', artifactId: 'artifact-alignment', sha256: digest('d'), mediaType: 'data', container: 'json' },
}

/**
 * A real critic report, built by the aggregate itself — every dimension
 * answered, the controlled evaluator declaring that it is a stand-in and not
 * production visual validation, and the verdict hash calculated from the body.
 * The promotion gate reads this, not a hash the provider job happened to carry.
 */
const criticEvaluators = [
  { id: 'ffprobe-media-integrity', version: '1.0.0', kind: 'measured', scope: 'timeline and signal read from the artifact' },
  { id: 'alignment-pronunciation', version: '1.0.0', kind: 'measured', scope: 'spoken words compared to the approved script' },
  { id: 'controlled-deterministic-probe', version: '1.0.0', kind: 'controlled', scope: 'deterministic stand-in, not production visual validation' },
]
const criticMeasured = (dimension, evaluatorId, value, unit, threshold) => ({
  dimension, status: 'measured', evaluatorId, value, unit, threshold,
  confidence: 1, evidenceRefs: ['artifact://artifact-original'], range: null, note: null,
})
const criticUnavailable = (dimension, note) => ({
  dimension, status: 'unavailable', evaluatorId: null, value: null, unit: null,
  threshold: null, confidence: null, evidenceRefs: [], range: null, note,
})
const criticMeasurements = [
  criticMeasured('lip-sync', 'controlled-deterministic-probe', 0, 'ms-av-offset', 34),
  criticMeasured('identity', 'controlled-deterministic-probe', 1, 'identity-ref-match', 1),
  criticMeasured('pronunciation', 'alignment-pronunciation', 0, 'word-deviations', 0),
  criticUnavailable('visual-artifacts', 'no visual artifact detector is deployed'),
  criticUnavailable('framing', 'no framing model is deployed'),
  criticUnavailable('continuity', 'this is the first approved block of the take'),
  criticUnavailable('eyes', 'no eye model is deployed'),
  criticUnavailable('teeth', 'no teeth model is deployed'),
  criticUnavailable('hands', 'no hand model is deployed'),
  criticMeasured('temporal-integrity', 'ffprobe-media-integrity', 0, 'ms-drift', 34),
  criticMeasured('audiovisual-integrity', 'ffprobe-media-integrity', 1, 'live-signal', 1),
]
const criticExpectation = Object.freeze({
  durationMs: 8_000,
  durationMode: 'fixed',
  fps: null,
  videoCodec: null,
  audioCodec: null,
  audioSampleRateHz: null,
  identityRef: 'avatar_promotion',
  declaredIdentityRef: null,
  rights: Object.freeze({ withinGrantedScope: true, reason: null }),
  previousBlock: null,
})

function criticReport(overrides = {}) {
  const reportArtifactId = overrides.artifactId ?? 'artifact-original'
  const reportArtifactSha256 = overrides.artifactSha256 ?? digest('a')
  const outputSpeechEvidence = overrides.outputSpeechEvidence ?? createAvatarOutputSpeechEvidence({
    jobId: overrides.providerJobId ?? providerJobId,
    videoArtifactId: reportArtifactId, videoArtifactSha256: reportArtifactSha256,
    sourceAudioArtifactId: 'artifact-audio', sourceAudioRangeHash: audioRangeHash,
    sourcePcmSha256: digest('4'), outputPcmSha256: digest('5'),
    sourceDurationMs: 8_000, outputDurationMs: 8_000,
    policyVersion: 'avatar-audio-pcm-comparison/1.1.0', sampleRateHz: 16_000,
    alignedLagSamples: 0, correlationBps: 10_000, normalizedErrorBps: 0,
    comparedSampleCount: 128_000, sourceCoverageBps: 10_000, outputCoverageBps: 10_000,
    worstWindowCorrelationBps: 10_000, worstWindowNormalizedErrorBps: 0,
    failedWindowCount: 0, comparedWindowCount: 32,
    sourceRmsBps: 5_000, outputRmsBps: 5_000, passed: true,
    speechEvidence: {
      kind: 'controlled', evaluatorId: 'controlled-output-speech', evaluatorVersion: '1.0.0',
      outputTranscriptHash: scriptHash, observedIdentityRef: 'avatar_promotion',
    },
  })
  return createSyntheticCriticReport({
    id: 'promotion-critic-report-1',
    workspaceId,
    projectId,
    blockId: 'promotion-block-1',
    providerJobId,
    capability: 'audio-avatar',
    adapterId: 'heygen-v3',
    adapterVersion: '3.0.0',
    artifactId: reportArtifactId,
    artifactSha256: reportArtifactSha256,
    audioArtifactId: null,
    alignmentArtifactId: 'artifact-alignment',
    outputSpeechEvidence,
    outputSpeechEvidenceArtifactId: 'artifact-output-speech-evidence',
    scriptHash,
    profileSnapshotId: 'promotion-presenter:v3',
    expectedIdentityRef: 'avatar_promotion',
    expectationHash: calculateCanonicalHash(criticExpectation),
    evaluationContextHash: digest('8'),
    evaluators: criticEvaluators,
    measurements: criticMeasurements,
    issues: [],
    decision: 'approved',
    recommendedAction: 'none',
    thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v1',
    decidedAt: '2029-04-30T23:59:00.000Z',
    ...overrides,
  })
}

/** The same take, judged and refused, with its cause localized on the block. */
function rejectedCriticReport() {
  return criticReport({
    id: 'promotion-critic-report-rejected',
    measurements: criticMeasurements.map((measurement) =>
      measurement.dimension === 'pronunciation' ? { ...measurement, value: 2 } : measurement),
    issues: [{
      blockId: 'promotion-block-1', dimension: 'pronunciation', severity: 'blocking',
      range: { startMs: 1_200, endMs: 1_850 },
      evidence: 'two words of the approved script were not spoken in the aligned take',
      action: 'retry',
    }],
    decision: 'rejected',
    recommendedAction: 'retry',
  })
}

const actor = Object.freeze({
  clientId: 'promotion-client',
  credentialId: 'promotion-credential',
  workspaceId,
  environment: 'production',
  actor: Object.freeze({ type: 'api-client', id: 'promotion-client' }),
  scopes: new Set(['projects:read', 'projects:write']),
  authenticationKind: 'bearer',
  clientKillSwitchEngaged: false,
  workspaceKillSwitchEngaged: false,
  clientAccessStatus: 'active',
  workspaceAccessStatus: 'active',
  auditContext: Object.freeze({
    clientId: 'promotion-client',
    credentialId: 'promotion-credential',
    workspaceId,
    environment: 'production',
    actor: Object.freeze({ type: 'api-client', id: 'promotion-client' }),
  }),
})

function harness(overrides = {}) {
  const calls = { verifiedKeys: [], sealed: [], criticLookups: [] }
  const rightsSnapshot = createAssetRightsSnapshot({
    id: 'promotion-rights', workspaceId, artifactId: 'artifact-audio', sequence: 1,
    draft: {
      status: 'approved', allowedUses: ['ads'], prohibitedUses: [], allowedMarkets: ['BRA'], allowedLocales: ['pt-BR'],
      allowedSyntheticOperations: ['tts', 'audio-avatar'], expiresAt: '2030-01-01T00:00:00.000Z',
      consent: { status: 'not-required', allowedUses: [] },
    },
    createdBy: { type: 'api-client', id: 'promotion-client' }, createdAt: now.toISOString(),
  })
  const dependencies = {
    masters: {
      findReplay: async () => null,
      findByProviderJob: async () => null,
      findByMasterHash: async () => null,
      read: async () => null,
      list: async () => [],
      create: async (input) => {
        calls.sealed.push(input)
        return Object.freeze({
          value: { master: input.master, requestFingerprint: input.requestFingerprint, idempotencyKey: input.idempotencyKey },
          replayed: false,
        })
      },
      ...overrides.masters,
    },
    jobs: {
      read: async () => ({
        id: providerJobId, workspaceId, projectId, originProjectVersionId: 'project-version-1',
        operation: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
        providerJobId: 'heygen_job_promotion', status: 'approved',
        criticResultHash: overrides.criticReports?.[0]?.reportHash ?? criticReport().reportHash,
        authorization: { profileSnapshotId: 'promotion-presenter:v3' },
        audioRange: { startMs: 0, endMs: 8_000, rangeHash: audioRangeHash },
        audioMaster: {
          id: 'promotion-audio-master', masterHash: digest('6'), profileSnapshotId: 'promotion-presenter:v3',
          sourceProviderJobId: 'promotion-tts-job',
          audio: { artifactId: 'artifact-audio', artifactSha256: digest('c'), durationMs: 8_000, locale: 'pt-BR' },
          alignmentEvidence: { artifactId: 'artifact-alignment', artifactSha256: digest('d') },
        },
        resultArtifact: { artifactId: 'artifact-original', artifactSha256: digest('a') },
        authorizationHash: digest('2'), submittedAt: '2029-05-01T00:00:00.000Z', completedAt: '2029-05-01T00:00:08.000Z',
        ...overrides.job,
      }),
    },
    resultArtifacts: {
      persistOrReplay: async () => { throw new Error('unused') },
      listByJob: async ({ jobId }) => overrides.results ?? Object.entries(ROLES)
        .filter(([, entry]) => jobId === providerJobId
          ? ['primary-video', 'output-speech-evidence'].includes(entry.providerRole)
          : ['primary-audio', 'alignment-evidence'].includes(entry.providerRole))
        .map(([, entry]) => ({
          role: entry.providerRole, artifactId: entry.artifactId, artifactSha256: entry.sha256,
          byteSize: 4_096, modelRef: 'avatar-model-1', adapterConfigHash: digest('7'),
        })),
    },
    artifacts: {
      findById: async (_workspaceId, artifactId) => {
        const entry = Object.values(ROLES).find((role) => role.artifactId === artifactId)
        if (!entry) return null
        return {
          id: artifactId, workspaceId, artifactKey: `promotion/${artifactId}`, sha256: entry.sha256,
          byteSize: 4_096n, mediaType: entry.mediaType, container: entry.container,
          status: overrides.artifactStatus ?? 'available', lifecycleRevision: 1, manifests: [], createdAt: now.toISOString(),
        }
      },
      findColorProbe: async () => null,
    },
    profiles: {
      readProfile: async () => ({
        snapshot: overrides.snapshot ?? snapshot,
        profileSnapshotId: 'promotion-presenter:v3',
        requestFingerprint: digest('9'), idempotencyKey: 'promotion-profile', createdAt: now.toISOString(),
      }),
      readProfileHead: async () => null,
    },
    rights: {
      currentSnapshot: async () => (overrides.rights === null ? null : { ...rightsSnapshot, ...overrides.rights }),
    },
    criticReports: {
      readByHash: async (input) => {
        calls.criticLookups.push(input.reportHash)
        return (overrides.criticReports ?? [criticReport()])
          .find((report) => report.reportHash === input.reportHash) ?? null
      },
    },
    bytes: {
      verify: async (input) => {
        calls.verifiedKeys.push(input.artifactKey)
        if (overrides.byteFailure) throw new Error(overrides.byteFailure)
      },
    },
    durations: {
      measure: async () => overrides.durations ?? { audioDurationMs: 8_000, videoDurationMs: 8_012 },
    },
    clock: () => now,
    createId: () => 'synthetic-master-promoted',
  }
  return { calls, promote: promoteSyntheticMasterAssetService(dependencies) }
}

const request = {
  workspaceId, projectId, providerJobId, profileSnapshotId: 'promotion-presenter:v3',
  scriptText,
  locale: 'pt-BR', use: 'ads', market: 'BRA',
  lineage: ['generation-1', 'generation-2'],
  cost: { currency: 'USD', minorUnits: 150 },
  actor, idempotencyKey: 'promotion-key-1',
}

test('T-FR-104 promotion seals an approved result only after every gate passes', async () => {
  const { calls, promote } = harness()
  const { master, replayed } = await promote(request)

  assert.equal(replayed, false)
  assert.equal(master.id, 'synthetic-master-promoted')
  assert.equal(master.profileId, 'promotion-presenter')
  assert.equal(master.profileVersion, 3)
  assert.equal(master.projectVersionId, 'project-version-1')
  assert.equal(master.provenance.providerJobRef, 'heygen_job_promotion')
  // Latency is measured from the durable job, never supplied by the caller.
  assert.equal(master.cost.latencyMs, 8_000)
  assert.equal(master.durationMs, 8_000)
  assert.equal(master.videoDurationMs, 8_012)
  assert.deepEqual([...master.lineage], ['generation-1', 'generation-2'])
  // The approving evidence is the persisted report, not the job's hash: the
  // master points at a verdict a reader can open and re-hash.
  const approving = criticReport()
  assert.equal(master.critic.reportId, approving.id)
  assert.equal(master.critic.reportHash, approving.reportHash)
  assert.equal(master.critic.decision, 'approved')
  assert.equal(master.critic.reportHash, approving.reportHash, 'specialized critic report is the job approval seal')
  assert.equal(approving.scriptHash, scriptHash)
  assert.equal(approving.profileSnapshotId, request.profileSnapshotId)
  assert.equal(approving.alignmentArtifactId, ROLES.alignment.artifactId)
  assert.equal(approving.artifactId, ROLES['provider-original'].artifactId)
  assert.equal(approving.artifactSha256, ROLES['provider-original'].sha256)
  // And the verdict consulted is the one about the bytes being promoted.
  assert.deepEqual(calls.criticLookups, [approving.reportHash])

  // Every promoted artifact had its bytes verified against storage.
  assert.equal(calls.verifiedKeys.length, 3)
  assert.deepEqual(
    [...calls.verifiedKeys].sort(),
    ['artifact-alignment', 'artifact-audio', 'artifact-original'].map((id) => `promotion/${id}`).sort(),
  )
  // Without a normalization stage the master holds the provider's own video.
  assert.deepEqual(master.artifacts.map(({ role }) => role), ['provider-original', 'final-audio', 'alignment'])
  // The repository re-checks the snapshot and critic inside its transaction.
  assert.equal(calls.sealed[0].profileSnapshotHash, snapshot.snapshotHash)
  assert.equal(calls.sealed[0].criticResultHash, approving.reportHash)
})

test('T-FR-104 promotion refuses a job that is not terminal, approved and criticised', async () => {
  for (const [job, expected] of [
    [{ status: 'evaluating' }, /Only an approved provider job/],
    [{ criticResultHash: null }, /no critic result to promote/],
    [{ completedAt: null }, /not terminal yet/],
    [{ providerJobId: null }, /no provider reference/],
    [{ workspaceId: 'other-workspace' }, /another workspace or project/],
  ]) {
    const { calls, promote } = harness({ job })
    await assert.rejects(promote(request), expected)
    assert.equal(calls.sealed.length, 0, 'nothing may be sealed when a job gate fails')
  }
})

test('T-FR-104 promotion refuses missing, unavailable, drifted or tampered bytes', async () => {
  const withoutAudio = Object.entries(ROLES)
    .filter(([role]) => role !== 'final-audio')
    .map(([, entry]) => ({ role: entry.providerRole, artifactId: entry.artifactId, artifactSha256: entry.sha256, byteSize: 4_096, modelRef: null, adapterConfigHash: digest('7') }))
  const missing = harness({ results: withoutAudio })
  await assert.rejects(missing.promote(request), /TTS provider result ledger does not match/)
  assert.equal(missing.calls.sealed.length, 0)

  const unavailable = harness({ artifactStatus: 'quarantined' })
  await assert.rejects(unavailable.promote(request), /is not available/)

  const drifted = harness({
    results: Object.entries(ROLES).map(([role, entry]) => ({
      role: entry.providerRole, artifactId: entry.artifactId,
      artifactSha256: role === 'final-audio' ? digest('9') : entry.sha256,
      byteSize: 4_096, modelRef: null, adapterConfigHash: digest('7'),
    })),
  })
  await assert.rejects(drifted.promote(request), /TTS provider result ledger does not match/)

  const tampered = harness({ byteFailure: 'stored artifact checksum mismatch' })
  await assert.rejects(tampered.promote(request), /checksum mismatch/)
  assert.equal(tampered.calls.sealed.length, 0)
})

test('T-FR-104 uploaded and concatenated audio masters use their canonical artifacts without inventing a TTS job', async () => {
  for (const source of ['uploaded', 'concatenated']) {
    const controlled = harness({
      job: {
        audioMaster: {
          id: `promotion-audio-master-${source}`, masterHash: digest('6'), profileSnapshotId: 'promotion-presenter:v3',
          sourceProviderJobId: null,
          audio: { artifactId: 'artifact-audio', artifactSha256: digest('c'), durationMs: 8_000, locale: 'pt-BR' },
          alignmentEvidence: { artifactId: 'artifact-alignment', artifactSha256: digest('d') },
        },
      },
      results: Object.values(ROLES)
        .filter((entry) => ['primary-video', 'output-speech-evidence'].includes(entry.providerRole))
        .map((entry) => ({
          role: entry.providerRole, artifactId: entry.artifactId, artifactSha256: entry.sha256,
          byteSize: 4_096, modelRef: 'avatar-model-1', adapterConfigHash: digest('7'),
        })),
    })
    const promoted = await controlled.promote({ ...request, idempotencyKey: `promotion-${source}-key` })
    assert.equal(promoted.master.artifacts.find(({ role }) => role === 'final-audio').artifactId, 'artifact-audio')
    assert.equal(promoted.master.artifacts.find(({ role }) => role === 'alignment').artifactId, 'artifact-alignment')
  }
})

test('T-FR-104 promotion refuses revoked consent, blocked rights and incoherent durations', async () => {
  const revoked = harness({
    snapshot: createSyntheticPresenterProfileSnapshot({
      ...snapshot,
      consent: { ...snapshot.consent, revokedAt: '2029-04-01T00:00:00.000Z' },
    }),
  })
  await assert.rejects(revoked.promote(request), /ASSET_RIGHTS_BLOCKED|consent/i)
  assert.equal(revoked.calls.sealed.length, 0)

  const blocked = harness({ rights: null })
  await assert.rejects(blocked.promote(request), /not cleared for ads/)
  assert.equal(blocked.calls.sealed.length, 0)

  const incoherent = harness({ durations: { audioDurationMs: 8_000, videoDurationMs: 9_400 } })
  await assert.rejects(incoherent.promote(request), /disagree beyond one frame/)
  assert.equal(incoherent.calls.sealed.length, 0)
})

test('T-FR-106 promotion requires a persisted approval, never merely an unjudged take', async () => {
  // No report at all: an unjudged take is unjudged, not approved.
  const unjudged = harness({ criticReports: [] })
  await assert.rejects(unjudged.promote(request), /No persisted critic report judges/)
  assert.equal(unjudged.calls.sealed.length, 0)

  // Every non-approval decision blocks, including "we could not tell".
  for (const [report, expected] of [
    [rejectedCriticReport(), /job verdict is rejected/],
    [criticReport({
      id: 'promotion-critic-report-review',
      decision: 'needs-review',
      recommendedAction: 'manual-review',
    }), /job verdict is needs-review/],
    [criticReport({
      id: 'promotion-critic-report-unknown',
      decision: 'evidence-unavailable',
      recommendedAction: 'manual-review',
    }), /job verdict is evidence-unavailable/],
  ]) {
    const blocked = harness({ criticReports: [report] })
    await assert.rejects(blocked.promote(request), expected)
    assert.equal(blocked.calls.sealed.length, 0, 'a refused take must never be sealed')
  }

  // The report sealed by the job is authoritative even when another opinion
  // about the same bytes exists.
  const superseded = harness({ criticReports: [rejectedCriticReport(), criticReport()] })
  await assert.rejects(superseded.promote(request), /job verdict is rejected/)
  assert.equal(superseded.calls.sealed.length, 0)

  // Historical approvals remain readable but cannot authorize promotion once
  // either the evaluation expectation or policy version is no longer current.
  for (const report of [
    criticReport({ id: 'promotion-critic-report-no-expectation', expectationHash: undefined }),
    criticReport({ id: 'promotion-critic-report-no-context', evaluationContextHash: undefined }),
    criticReport({ id: 'promotion-critic-report-stale-policy', thresholdsVersion: 'synthetic-critic-thresholds/audio-avatar/heygen-v3/v0' }),
  ]) {
    const stale = harness({ criticReports: [report] })
    await assert.rejects(stale.promote(request), /job verdict is approved/)
    assert.equal(stale.calls.sealed.length, 0, 'stale critic evidence must never authorize a seal')
  }

  // A report about other bytes or another project is not evidence about these.
  const otherBytes = harness({
    criticReports: [criticReport({ id: 'promotion-critic-report-other', artifactSha256: digest('9') })],
  })
  await assert.rejects(otherBytes.promote(request), /do not describe the exact master/)
  assert.equal(otherBytes.calls.sealed.length, 0)
})

test('T-FR-106 promotion refuses a job authorized for another presenter snapshot', async () => {
  const mismatched = harness({ job: { authorization: { profileSnapshotId: 'promotion-presenter:v2' } } })
  await assert.rejects(mismatched.promote(request), /approved for a different presenter snapshot/)
  assert.equal(mismatched.calls.sealed.length, 0)
})

test('T-FR-106 promotion refuses a critic report for another presenter snapshot', async () => {
  const mismatched = harness({
    criticReports: [criticReport({ profileSnapshotId: 'promotion-presenter:v2' })],
  })
  await assert.rejects(mismatched.promote(request), /do not describe the exact master/)
  assert.equal(mismatched.calls.sealed.length, 0)
})

test('T-FR-106 the specialized report hash stays as the seal transaction guard', async () => {
  // Both defences hold at once: the report approves, and the hash the
  // repository re-checks inside its transaction is still the job's own.
  const { calls, promote } = harness()
  await promote(request)
  assert.equal(calls.sealed[0].criticResultHash, criticReport().reportHash)
  assert.equal(calls.sealed[0].master.critic.reportHash, criticReport().reportHash)

  // A job that lost its critic result is refused before the report is even
  // consulted: the two gates are cumulative, never alternatives.
  const withoutJobHash = harness({ job: { criticResultHash: null } })
  await assert.rejects(withoutJobHash.promote(request), /no critic result to promote/)
  assert.equal(withoutJobHash.calls.criticLookups.length, 0)
})

test('T-FR-104 promotion is idempotent and never seals a job twice', async () => {
  const master = { id: 'existing-master', workspaceId, masterHash: digest('e') }
  const fingerprintSource = harness()
  await fingerprintSource.promote(request)
  const requestFingerprint = fingerprintSource.calls.sealed[0].requestFingerprint
  const byReplay = harness({
    masters: { findReplay: async () => ({ master, requestFingerprint, idempotencyKey: 'promotion-key-1' }) },
  })
  const replayed = await byReplay.promote(request)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.master.id, 'existing-master')
  assert.equal(byReplay.calls.sealed.length, 0)

  const mismatchedReplay = harness({
    masters: { findReplay: async () => ({ master, requestFingerprint, idempotencyKey: 'promotion-key-1' }) },
  })
  await assert.rejects(
    mismatchedReplay.promote({ ...request, scriptText: `${request.scriptText} diferente` }),
    (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH',
  )
  assert.equal(mismatchedReplay.calls.sealed.length, 0)

  const byJob = harness({
    masters: { findByProviderJob: async () => ({ master, requestFingerprint: digest('1'), idempotencyKey: 'other-key' }) },
  })
  const sealedAlready = await byJob.promote({ ...request, idempotencyKey: 'promotion-key-2' })
  assert.equal(sealedAlready.replayed, true)
  assert.equal(sealedAlready.master.id, 'existing-master')
  assert.equal(byJob.calls.sealed.length, 0, 'a promoted job must never be sealed twice')
})

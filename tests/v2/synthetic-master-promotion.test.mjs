import assert from 'node:assert/strict'
import test from 'node:test'

import { promoteSyntheticMasterAssetService } from '../../src/v2/application/synthetic-master-assets.ts'
import { createAssetRightsSnapshot } from '../../src/v2/domain/asset-rights.ts'
import { createSyntheticCriticReport } from '../../src/v2/domain/synthetic-critic-report.ts'
import { createSyntheticPresenterProfileSnapshot } from '../../src/v2/domain/synthetic-production.ts'

const digest = (character) => character.repeat(64)
const workspaceId = 'promotion-workspace'
const projectId = 'promotion-project'
const providerJobId = 'promotion-job'
const now = new Date('2029-05-01T00:00:00.000Z')

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

function criticReport(overrides = {}) {
  return createSyntheticCriticReport({
    id: 'promotion-critic-report-1',
    workspaceId,
    projectId,
    blockId: 'promotion-block-1',
    capability: 'audio-avatar',
    adapterId: 'heygen-v3',
    adapterVersion: '3.0.0',
    artifactId: 'artifact-original',
    artifactSha256: digest('a'),
    audioArtifactId: 'artifact-audio',
    alignmentArtifactId: 'artifact-alignment',
    scriptHash: digest('7'),
    profileSnapshotId: 'promotion-presenter:v3',
    expectedIdentityRef: 'avatar_promotion',
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
        providerJobId: 'heygen_job_promotion', status: 'approved', criticResultHash: digest('f'),
        authorizationHash: digest('2'), submittedAt: '2029-05-01T00:00:00.000Z', completedAt: '2029-05-01T00:00:08.000Z',
        ...overrides.job,
      }),
    },
    resultArtifacts: {
      persistOrReplay: async () => { throw new Error('unused') },
      listByJob: async () => overrides.results ?? Object.entries(ROLES).map(([, entry]) => ({
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
      readByArtifact: async (input) => {
        calls.criticLookups.push(input.artifactId)
        return overrides.criticReports ?? [criticReport()]
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
  scriptText: 'Primeira ideia do roteiro. Segunda ideia bem forte.',
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
  assert.notEqual(master.critic.reportHash, digest('f'), 'the job hash must not be what approves')
  // And the verdict consulted is the one about the bytes being promoted.
  assert.deepEqual(calls.criticLookups, ['artifact-original'])

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
  assert.equal(calls.sealed[0].criticResultHash, digest('f'))
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
  await assert.rejects(missing.promote(request), /no final-audio artifact to promote/)
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
  await assert.rejects(drifted.promote(request), /drifted from the provider result ledger/)

  const tampered = harness({ byteFailure: 'stored artifact checksum mismatch' })
  await assert.rejects(tampered.promote(request), /checksum mismatch/)
  assert.equal(tampered.calls.sealed.length, 0)
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
    [rejectedCriticReport(), /current verdict is rejected/],
    [criticReport({
      id: 'promotion-critic-report-review',
      decision: 'needs-review',
      recommendedAction: 'manual-review',
    }), /current verdict is needs-review/],
    [criticReport({
      id: 'promotion-critic-report-unknown',
      decision: 'evidence-unavailable',
      recommendedAction: 'manual-review',
    }), /current verdict is evidence-unavailable/],
  ]) {
    const blocked = harness({ criticReports: [report] })
    await assert.rejects(blocked.promote(request), expected)
    assert.equal(blocked.calls.sealed.length, 0, 'a refused take must never be sealed')
  }

  // A newer rejection supersedes an older approval on the same bytes.
  const superseded = harness({ criticReports: [rejectedCriticReport(), criticReport()] })
  await assert.rejects(superseded.promote(request), /current verdict is rejected/)
  assert.equal(superseded.calls.sealed.length, 0)

  // A report about other bytes or another project is not evidence about these.
  const otherBytes = harness({
    criticReports: [criticReport({ id: 'promotion-critic-report-other', artifactSha256: digest('9') })],
  })
  await assert.rejects(otherBytes.promote(request), /does not describe the artifact being promoted/)
  assert.equal(otherBytes.calls.sealed.length, 0)
})

test('T-FR-106 the job critic hash stays as the seal transaction guard', async () => {
  // Both defences hold at once: the report approves, and the hash the
  // repository re-checks inside its transaction is still the job's own.
  const { calls, promote } = harness()
  await promote(request)
  assert.equal(calls.sealed[0].criticResultHash, digest('f'))
  assert.notEqual(calls.sealed[0].master.critic.reportHash, digest('f'))

  // A job that lost its critic result is refused before the report is even
  // consulted: the two gates are cumulative, never alternatives.
  const withoutJobHash = harness({ job: { criticResultHash: null } })
  await assert.rejects(withoutJobHash.promote(request), /no critic result to promote/)
  assert.equal(withoutJobHash.calls.criticLookups.length, 0)
})

test('T-FR-104 promotion is idempotent and never seals a job twice', async () => {
  const master = { id: 'existing-master', workspaceId, masterHash: digest('e') }
  const byReplay = harness({
    masters: { findReplay: async () => ({ master, requestFingerprint: digest('1'), idempotencyKey: 'promotion-key-1' }) },
  })
  const replayed = await byReplay.promote(request)
  assert.equal(replayed.replayed, true)
  assert.equal(replayed.master.id, 'existing-master')
  assert.equal(byReplay.calls.sealed.length, 0)

  const byJob = harness({
    masters: { findByProviderJob: async () => ({ master, requestFingerprint: digest('1'), idempotencyKey: 'other-key' }) },
  })
  const sealedAlready = await byJob.promote({ ...request, idempotencyKey: 'promotion-key-2' })
  assert.equal(sealedAlready.replayed, true)
  assert.equal(sealedAlready.master.id, 'existing-master')
  assert.equal(byJob.calls.sealed.length, 0, 'a promoted job must never be sealed twice')
})

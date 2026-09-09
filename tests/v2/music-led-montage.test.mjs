import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createMusicAnalysis, compileMusicLedMontage, critiqueMusicMontage } from '../../src/v2/domain/music-led-montage.ts'
import { analyzeMusicForMontageService, MUSIC_ANALYZER_ID, MUSIC_ANALYZER_VERSION } from '../../src/v2/application/analyze-music-for-montage.ts'
import { compileMusicLedMontageService } from '../../src/v2/application/compile-music-led-montage.ts'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { parseMusicMontageBody } from '../../src/v2/public-api/music-led-montage-contract.ts'

const sha = 'a'.repeat(64)
const audit = createApiAccessAuditContext({ clientId: 'client-1', credentialId: 'credential-1', workspaceId: 'workspace-1', environment: 'sandbox', authenticationKind: 'bearer' })
function analysis(overrides = {}) {
  return createMusicAnalysis({
    id: 'analysis-1', sourceArtifactId: 'artifact-1', sourceSha256: sha, sourceByteSize: 100,
    analyzer: { id: MUSIC_ANALYZER_ID, version: MUSIC_ANALYZER_VERSION, sampleRate: 22050, windowSize: 1024, hopSize: 512 },
    durationMs: 20_000, tempo: { bpm: 120, confidence: .9 },
    beats: [1_000, 2_000, 3_000, 4_000].map((atMs) => ({ atMs, strength: .9, confidence: .9, kind: 'beat' })),
    sections: [{ id: 'section-1', rangeMs: [0, 20_000], energy: .7, confidence: .4, role: 'unknown' }],
    energyCurve: [{ atMs: 0, value: .5 }], confidence: .9, limitations: ['downbeats-not-inferred'], ...overrides,
  })
}

test('low confidence falls back without inventing a beat or downbeat', () => {
  const source = analysis({ confidence: .2 })
  const plan = compileMusicLedMontage({ analysis: source, semanticCutCandidatesMs: [1_090], protectedSpeechRanges: [], fps: 30 })
  assert.equal(plan.mode, 'narrative-led')
  assert.deepEqual(plan.cutDecisions.map((cut) => [cut.atMs, cut.source]), [[1_100, 'semantic']])
  assert.equal(source.beats.some((beat) => beat.kind === 'downbeat-candidate'), false)
})

test('distant beats and protected speech preserve the semantic cut', () => {
  const distant = compileMusicLedMontage({ analysis: analysis(), semanticCutCandidatesMs: [1_400], protectedSpeechRanges: [], maximumSnapDistanceMs: 100, fps: 25 })
  assert.equal(distant.cutDecisions[0].source, 'semantic')
  const protectedPlan = compileMusicLedMontage({ analysis: analysis(), semanticCutCandidatesMs: [1_080], protectedSpeechRanges: [{ id: 'word', rangeMs: [950, 1_050], reason: 'word' }], maximumSnapDistanceMs: 120, fps: 25 })
  assert.equal(protectedPlan.cutDecisions[0].source, 'semantic')
})

test('critic rejects protected cuts and sliding-window over-editing', () => {
  const source = analysis({ durationMs: 30_000, sections: [{ id: 'section-1', rangeMs: [0, 30_000], energy: .7, confidence: .4, role: 'unknown' }] })
  const plan = compileMusicLedMontage({ analysis: source, semanticCutCandidatesMs: [9_900, 10_100, 10_300], protectedSpeechRanges: [{ id: 'claim', rangeMs: [10_050, 10_150], reason: 'claim' }], minimumConfidence: 1 })
  const result = critiqueMusicMontage({ plan, durationMs: 30_000, minimumCutSpacingMs: 0, maximumCutsPer10s: 2 })
  assert.equal(result.passed, false)
  assert.equal(result.eligibleForAutomaticRender, false)
  assert.ok(result.issues.some((issue) => issue.code === 'PROTECTED_SPEECH_CUT'))
  assert.ok(result.issues.some((issue) => issue.code === 'OVER_EDITING_DENSITY'))
})

test('analysis values are deeply copied, finite and hash protected', () => {
  const beats = [{ atMs: 1_000, strength: .9, confidence: .9, kind: 'beat' }]
  const value = analysis({ beats })
  beats[0].atMs = 2_000
  assert.equal(value.beats[0].atMs, 1_000)
  assert.throws(() => analysis({ confidence: Number.NaN }))
  assert.throws(() => analysis({ beats: [{ atMs: Number.NaN, strength: .9, confidence: .9, kind: 'beat' }] }))
})

test('rights are checked before replay and again before publication; source releases on mismatch', async () => {
  const events = []
  const cached = analysis()
  const replay = analyzeMusicForMontageService({
    rights: { async authorizeCurrent() { events.push('rights'); return { authorized: true } } },
    sources: { async materialize() { throw new Error('must not materialize replay') } }, analyzer: { async analyzeVerifiedFile() { throw new Error('must not analyze replay') } },
    analyses: { async findBySourceFingerprint() { events.push('cache'); return cached }, async authorizeReuse(input) { events.push(`authorize:${input.rightsSnapshotId}`); return input.analysis }, async save() { throw new Error('must not save replay') } },
  })
  assert.equal(await replay({ workspaceId: 'workspace', projectVersionId: 'version', artifactId: 'artifact-1', artifactKey: 'music.wav', expectedByteSize: 100, expectedSha256: sha, rightsSnapshotId: 'rights' }), cached)
  assert.deepEqual(events, ['rights', 'cache', 'authorize:rights'])

  let released = false
  const mismatch = analyzeMusicForMontageService({
    rights: { async authorizeCurrent() { return { authorized: true } } },
    sources: { async materialize() { return { filePath: 'x', observedByteSize: 99, observedSha256: sha, async release() { released = true } } } },
    analyzer: { async analyzeVerifiedFile() { throw new Error('must not analyze mismatch') } }, analyses: { async findBySourceFingerprint() { return null }, async save(value) { return value.analysis } },
  })
  await assert.rejects(mismatch({ workspaceId: 'workspace', projectVersionId: 'version', artifactId: 'artifact-1', artifactKey: 'music.wav', expectedByteSize: 100, expectedSha256: sha, rightsSnapshotId: 'rights' }), /do not match/)
  assert.equal(released, true)
})

test('compiler consumes persisted analysis, uses approved handles and publishes run plus renderable plan atomically', async () => {
  const persisted = analysis({ durationMs: 4_000, sections: [{ id: 'section-1', rangeMs: [0, 4_000], energy: .7, confidence: .4, role: 'unknown' }] })
  let publication
  const compile = compileMusicLedMontageService({
    authority: { async resolveCurrent() { return { analysis: persisted, musicArtifactId: persisted.sourceArtifactId, rightsSnapshotId: 'rights-1', visualSources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 8 }], protectedSpeechRanges: [] } } },
    runs: { async findRequestReplay() { return null }, async saveWithRenderablePlan(input) { publication = input; return { run: input.run, replayed: false } }, async findById() { return null } },
    clock: () => new Date('2026-09-08T12:00:00.000Z'),
  })
  const { run: result } = await compile({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', runId: 'music-run-1', planId: 'music-plan-1', analysisId: persisted.id, fps: 25, objective: 'awareness', locale: 'pt-BR', sources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 8 }], visualSegments: [{ id: 'clip-1', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [0, 2_100], preferredDurationMs: 1_920 }, { id: 'clip-2', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [3_000, 6_100], preferredDurationMs: 2_080 }], minimumCutSpacingMs: 100, maximumCutsPer10s: 8, actorClientId: 'client-1', idempotencyKey: 'music-key-1', authenticationAudit: audit })
  assert.equal(result.montagePlan.cutDecisions[0].atMs, 2_000)
  assert.equal(result.editPlan.videoTracks[0].clips[0].sourceOutFrame, 50)
  assert.equal(publication.renderablePlan.sourceHash, result.montagePlan.planHash)
  assert.equal(publication.run.runHash, result.runHash)
})

test('compiler derives protected speech from authority and request cannot remove it', async () => {
  const persisted = analysis({ durationMs: 4_000, sections: [{ id: 'section-1', rangeMs: [0, 4_000], energy: .7, confidence: .4, role: 'unknown' }] })
  const compile = compileMusicLedMontageService({
    authority: { async resolveCurrent() { return { analysis: persisted, musicArtifactId: persisted.sourceArtifactId, rightsSnapshotId: 'rights-1', visualSources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4.2 }], protectedSpeechRanges: [{ id: 'persisted-claim', sourceArtifactId: 'video-1', rangeMs: [1_050, 1_170], reason: 'claim' }] } } },
    runs: { async findRequestReplay() { return null }, async saveWithRenderablePlan(input) { return { run: input.run, replayed: false } }, async findById() { return null } },
  })
  const { run: result } = await compile({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', runId: 'music-run-protected', planId: 'music-plan-protected', analysisId: persisted.id, fps: 25, objective: 'awareness', locale: 'pt-BR', sources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4.2 }], visualSegments: [{ id: 'clip-1', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [0, 1_200], preferredDurationMs: 1_080 }, { id: 'clip-2', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [1_200, 4_240], preferredDurationMs: 2_920 }], maximumSnapDistanceMs: 120, actorClientId: 'client-1', idempotencyKey: 'music-key-2', authenticationAudit: audit })
  assert.equal(result.montagePlan.cutDecisions[0].source, 'beat')
  assert.ok(result.montagePlan.protectedSpeechRanges.some((range) => range.id.includes('persisted-claim')))
})

test('compiler replays before consulting clock or current authority', async () => {
  const stored = Object.freeze({ id: 'stored-run' })
  let clockCalls = 0
  const compile = compileMusicLedMontageService({
    runs: { async findRequestReplay() { return stored }, async saveWithRenderablePlan() { throw new Error('must not save replay') }, async findById() { return null } },
    authority: { async resolveCurrent() { throw new Error('must not resolve replay authority') } },
    clock() { clockCalls += 1; return new Date() },
  })
  const result = await compile({ workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', runId: 'new-id', planId: 'new-plan', analysisId: 'analysis-1', fps: 25, objective: 'awareness', locale: 'pt-BR', sources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4 }], visualSegments: [{ id: 'clip-1', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [0, 4_000], preferredDurationMs: 4_000 }], actorClientId: 'client-1', idempotencyKey: 'music-key-replay', authenticationAudit: audit })
  assert.equal(result.run, stored)
  assert.equal(result.replayed, true)
  assert.equal(clockCalls, 0)
})

test('public music montage parser rejects unknown fields and numeric coercion', () => {
  const valid = { projectVersionId: 'version-1', analysisId: 'analysis-1', locale: 'pt-br', objective: 'awareness', fps: 25, sources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4 }], visualSegments: [{ id: 'clip-1', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [0, 4_000], preferredDurationMs: 4_000 }] }
  assert.equal(parseMusicMontageBody(valid).locale, 'pt-BR')
  assert.throws(() => parseMusicMontageBody({ ...valid, fps: '25' }), /fps must be an integer/)
  assert.throws(() => parseMusicMontageBody({ ...valid, serverAuthority: [] }), /unknown fields/)
  assert.throws(() => parseMusicMontageBody({ ...valid, sources: [{ ...valid.sources[0], storageKey: 'secret' }] }), /unknown fields/)
  assert.throws(() => parseMusicMontageBody({ ...valid, visualSegments: [{ ...valid.visualSegments[0], sourceRangeMs: [0, 4_000.5] }] }), /integer/)
})

test('request fingerprint binds payload and full authenticated actor context', async () => {
  let stored
  const runs = {
    async findRequestReplay(input) {
      if (!stored) return null
      if (stored.requestFingerprint !== input.requestFingerprint || stored.actorContextHash !== input.actorContextHash) { const error = new Error('mismatch'); error.code = 'IDEMPOTENCY_PAYLOAD_MISMATCH'; throw error }
      return stored.run
    },
    async saveWithRenderablePlan(input) { stored = { requestFingerprint: input.requestFingerprint, actorContextHash: input.authenticationAudit.contextHash, run: input.run }; return { run: input.run, replayed: false } },
    async findById() { return null },
  }
  const persisted = analysis({ durationMs: 4_000, sections: [{ id: 'section-1', rangeMs: [0, 4_000], energy: .7, confidence: .4, role: 'unknown' }] })
  const compile = compileMusicLedMontageService({ runs, authority: { async resolveCurrent() { return { analysis: persisted, musicArtifactId: persisted.sourceArtifactId, rightsSnapshotId: 'rights-1', visualSources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4 }], protectedSpeechRanges: [] } } } })
  const base = { workspaceId: 'workspace-1', projectId: 'project-1', projectVersionId: 'version-1', runId: 'run-1', planId: 'plan-1', analysisId: 'analysis-1', fps: 25, objective: 'awareness', locale: 'pt-BR', sources: [{ id: 'source-1', artifactId: 'video-1', durationSeconds: 4 }], visualSegments: [{ id: 'clip-1', sourceId: 'source-1', sourceArtifactId: 'video-1', sourceRangeMs: [0, 4_000], preferredDurationMs: 4_000 }], actorClientId: 'client-1', idempotencyKey: 'same-key', authenticationAudit: audit }
  await compile(base)
  await assert.rejects(compile({ ...base, runId: 'run-2', planId: 'plan-2', fps: 30 }), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
  const otherCredential = createApiAccessAuditContext({ clientId: 'client-1', credentialId: 'credential-2', workspaceId: 'workspace-1', environment: 'sandbox', authenticationKind: 'bearer' })
  await assert.rejects(compile({ ...base, authenticationAudit: otherCredential }), (error) => error.code === 'IDEMPOTENCY_PAYLOAD_MISMATCH')
})

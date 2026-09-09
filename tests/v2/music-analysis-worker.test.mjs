import assert from 'node:assert/strict'
import test from 'node:test'
import { createApiAccessAuditContext } from '../../src/v2/domain/api-access-control.ts'
import { requestMusicAnalysisService, runNextMusicAnalysisService } from '../../src/v2/application/music-analysis-worker.ts'

const audit = createApiAccessAuditContext({ clientId: 'client-music', credentialId: 'credential-music', workspaceId: 'workspace-music', environment: 'sandbox', authenticationKind: 'bearer' })
function queued() { return { id: 'music-analysis-run-1', workspaceId: 'workspace-music', projectId: 'project-music', projectVersionId: 'version-music', sourceArtifactId: 'artifact-music', sourceArtifactKey: 'masters/music.wav', sourceSha256: 'a'.repeat(64), sourceByteSize: 1234, rightsSnapshotId: 'rights-music', locale: 'pt-BR', status: 'queued', attempt: 0, analysisId: null, analysisHash: null, failureCode: null, failureMessage: null, requestedByClientId: 'client-music', createdAt: '2026-09-08T12:00:00.000Z', updatedAt: '2026-09-08T12:00:00.000Z' } }

test('request binds server authority, idempotency actor context, and source fingerprint', async () => {
  let created
  const result = await requestMusicAnalysisService({ createId: () => '1', clock: () => new Date('2026-09-08T12:00:00Z'), runs: { findRequestReplay: async () => null, resolveRequestAuthority: async () => ({ artifactKey: 'masters/music.wav', sha256: 'a'.repeat(64), byteSize: 1234, rightsSnapshotId: 'rights-music', locale: 'pt-BR' }), create: async input => { created = input; return { run: input.run, replayed: false } } } })({ workspaceId: 'workspace-music', projectId: 'project-music', projectVersionId: 'version-music', artifactId: 'artifact-music', actorClientId: 'client-music', idempotencyKey: 'request-1', authenticationAudit: audit })
  assert.equal(result.run.sourceArtifactKey, 'masters/music.wav'); assert.match(created.sourceFingerprint, /^[a-f0-9]{64}$/); assert.equal(created.authenticationAudit.contextHash, audit.contextHash)
})

test('worker analyzes verified bytes and settles only through its fenced lease', async () => {
  const calls = []; const base = queued(); let tick = 0
  const outcome = await runNextMusicAnalysisService({ workerId: 'worker-1', clock: () => new Date(1_780_000_000_000 + tick++ * 100), createLeaseToken: () => 'secret', runs: { claim: async input => { calls.push(['claim', input.leaseTokenHash]); return { ...base, status: 'running', attempt: 1 } }, heartbeat: async () => true, settle: async input => { calls.push(['settle', input.leaseTokenHash, input.run.status]); return input.run } }, rights: { authorizeCurrent: async input => { calls.push(['rights', input.rightsSnapshotId]); return { authorized: true } } }, sources: { materialize: async () => ({ filePath: 'fixture.wav', observedByteSize: 1234, observedSha256: 'a'.repeat(64), release: async () => calls.push(['release']) }) }, analyzer: { analyzeVerifiedFile: async () => ({ id: 'analysis-1', schemaVersion: 'music-analysis/v1', sourceArtifactId: 'artifact-music', sourceSha256: 'a'.repeat(64), sourceByteSize: 1234, analyzer: { id: 'apollo-ffmpeg-pcm-onset', version: '1.0.0', sampleRate: 22050, windowSize: 1024, hopSize: 512 }, durationMs: 1000, tempo: { bpm: 120, confidence: .9 }, beats: [], sections: [], energyCurve: [], confidence: .9, limitations: [], analysisHash: 'b'.repeat(64) }) }, analyses: { findBySourceFingerprint: async () => null, save: async input => input.analysis } })()
  assert.equal(outcome.status, 'completed'); assert.equal(outcome.analysisId, 'analysis-1'); assert.equal(calls.filter(call => call[0] === 'rights').length, 2); assert.equal(calls.at(-2)[0], 'release'); assert.deepEqual(calls.at(-1).slice(0, 3), ['settle', calls[0][1], 'completed'])
})

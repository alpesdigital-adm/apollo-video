import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HeyGenProviderError, HeyGenV3AsyncMediaProviderAdapter } from '../../src/v2/infrastructure/heygen-v3-provider.ts'
import { AuthorizedProviderSubmissionInputMaterializer } from '../../src/v2/infrastructure/provider-submission-input-materializer.ts'
import { PersistedProviderResultCritic, SafeProviderResultDownloader, VerifiedProviderResultIngestor } from '../../src/v2/infrastructure/provider-result-ingestion.ts'

const require = createRequire(import.meta.url)
const ffmpegPath = require('ffmpeg-static')
const ffprobePath = require('ffprobe-static').path

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('T-FR-101 HeyGen v3 adapter normalizes submit, polling and retrieval without leaking its credential', async () => {
  const audio = Buffer.from('verified-wave-audio')
  const requests = []
  const statuses = ['pending', 'processing', 'completed', 'completed']
  const adapter = new HeyGenV3AsyncMediaProviderAdapter({
    apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 150,
    clock: () => new Date('2029-01-01T00:00:00.000Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body })
      if (String(url).endsWith('/v3/assets')) return json({ data: { asset_id: 'asset_audio_123', mime_type: 'audio/wav', size_bytes: audio.length } })
      if (init.method === 'POST') return json({ data: { video_id: 'video_job_123', status: 'pending', output_format: 'mp4' } })
      const status = statuses.shift()
      return json({ data: { id: 'video_job_123', status, ...(status === 'completed' ? { video_url: 'https://files.heygen.ai/video/result.mp4?Expires=123' } : {}) } })
    },
  })
  const capabilities = await adapter.getCapabilities()
  assert.deepEqual(capabilities.operations, ['audio-avatar', 'lip-sync'])
  assert.deepEqual(await adapter.estimate({ durationMs: 61_000 }), { currency: 'USD', costMinorUnits: 300, estimatedLatencyMs: 152_500 })
  const submitted = await adapter.submit({ avatarId: 'avatar_123', audioBytes: new Uint8Array(audio), audioSha256: createHash('sha256').update(audio).digest('hex'), audioByteSize: audio.length, audioContainer: 'wav', durationMs: 61_000, aspectRatio: '9:16' }, {
    workspaceId: 'workspace-one', projectVersionId: 'version-one', operationId: 'operation-one', idempotencyKey: 'apollo-idempotency-one',
  })
  assert.equal(submitted.providerJobId, 'video_job_123')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'queued')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'processing')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'completed')
  assert.deepEqual(await adapter.retrieve(submitted.providerJobId), { providerJobId: 'video_job_123', downloadUrl: 'https://files.heygen.ai/video/result.mp4?Expires=123', mediaType: 'video' })
  assert.match(requests[0].headers.get('idempotency-key'), /^apollo:asset:[a-f0-9]{64}$/)
  assert.match(requests[1].headers.get('idempotency-key'), /^apollo:video:[a-f0-9]{64}$/)
  assert.equal(requests[0].headers.get('x-api-key'), 'heygen-test-secret')
  assert.equal(JSON.stringify(requests.map(({ headers: _headers, ...request }) => request)).includes('heygen-test-secret'), false)
  assert.equal(requests[0].body instanceof FormData, true)
  assert.deepEqual(JSON.parse(requests[1].body), { type: 'avatar', avatar_id: 'avatar_123', audio_asset_id: 'asset_audio_123', aspect_ratio: '9:16', output_format: 'mp4' })
})

test('T-FR-101 HeyGen adapter fails closed on input, status, redirects, oversized bodies and normalized HTTP errors', async () => {
  const adapter = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => json({ data: { video_id: 'ok_job' } }) })
  await assert.rejects(() => adapter.submit({ avatarId: 'avatar_123', audioBytes: 'not-bytes', audioSha256: 'a'.repeat(64), audioByteSize: 12, audioContainer: 'wav', durationMs: 2_000 }, { workspaceId: 'w', projectVersionId: 'v', operationId: 'o', idempotencyKey: 'safe-key-123' }), (error) => error instanceof HeyGenProviderError && error.code === 'INVALID_AUDIO_BYTES')
  await assert.rejects(() => adapter.submit({ avatarId: 'avatar_123', audioBytes: new Uint8Array(12), audioSha256: 'a'.repeat(64), audioByteSize: 12, audioContainer: 'wav', durationMs: 2_000, hidden: true }, { workspaceId: 'w', projectVersionId: 'v', operationId: 'o', idempotencyKey: 'safe-key-123' }), (error) => error.code === 'PROVIDER_INPUT_INVALID')

  const cases = [
    [429, { 'retry-after': '2' }, 'PROVIDER_RATE_LIMITED', true, 2_000],
    [503, {}, 'PROVIDER_UNAVAILABLE', true, undefined],
    [401, {}, 'PROVIDER_AUTHENTICATION_FAILED', false, undefined],
  ]
  for (const [status, headers, code, retryable, retryAfterMs] of cases) {
    const failing = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => json({ secret: 'must-not-surface' }, status, headers) })
    await assert.rejects(() => failing.getStatus('video_job_123'), (error) => error.code === code && error.retryable === retryable && error.retryAfterMs === retryAfterMs && !error.message.includes('secret'))
  }
  const unknown = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => json({ data: { status: 'new-provider-state' } }) })
  await assert.rejects(() => unknown.getStatus('video_job_123'), (error) => error.code === 'PROVIDER_STATUS_UNKNOWN')
  const oversized = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) })
  await assert.rejects(() => oversized.getStatus('video_job_123'), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE')
  const redirected = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => { throw new TypeError('redirect blocked') } })
  await assert.rejects(() => redirected.getStatus('video_job_123'), (error) => error.code === 'PROVIDER_NETWORK_FAILURE' && error.retryable === true)
})

test('T-FR-101 provider materializer derives identity from the authorized snapshot and removes staging before submission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-provider-materializer-'))
  const path = join(root, 'audio.wav')
  const bytes = Buffer.from('immutable-authorized-audio')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(path, bytes)
  let cleanupCalls = 0
  const profile = {
    snapshot: {
      id: 'presenter-one:v1', snapshotHash: 'a'.repeat(64), status: 'active',
      avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_authorized_123' },
    },
  }
  const artifact = {
    id: 'audio-one', workspaceId: 'workspace-one', artifactKey: 'audio/source.wav', sha256,
    byteSize: BigInt(bytes.length), mediaType: 'audio', container: 'wav', status: 'available', lifecycleRevision: 1,
    manifests: [{ id: 'manifest-one', schemaVersion: 'media-artifact-manifest/v2', manifestHash: 'b'.repeat(64), recipe: { id: 'ingest', version: '1', parametersHash: 'c'.repeat(64) }, probe: { width: 0, height: 0, duration: 2, fps: 0 }, sources: [], createdAt: '2029-01-01T00:00:00.000Z' }],
    createdAt: '2029-01-01T00:00:00.000Z',
  }
  const materializer = new AuthorizedProviderSubmissionInputMaterializer({
    profiles: { async readProfile() { return profile } },
    artifacts: { async findById() { return artifact } },
    sources: {
      async materialize(input) { assert.equal(input.sha256, sha256); return { path, sha256, byteSize: bytes.length } },
      async cleanup() { cleanupCalls += 1 },
    },
    clock: () => new Date('2029-01-01T00:00:01.000Z'),
    async extractAudioRange(input) { assert.deepEqual([input.startMs, input.endMs], [0, 2_000]); return bytes },
  })
  const job = {
    id: 'provider-job-one', workspaceId: 'workspace-one', operation: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
    input: { audioArtifactId: 'audio-one', durationMs: 2_000, aspectRatio: '9:16', audioMasterId: 'audio-master-one', audioMasterHash: 'c'.repeat(64), audioRange: { startMs: 0, endMs: 2_000, rangeHash: 'd'.repeat(64) } },
    authorization: {
      profileSnapshotId: profile.snapshot.id, profileSnapshotHash: profile.snapshot.snapshotHash,
      expiresAt: '2030-01-01T00:00:00.000Z', artifactDecisions: [{ artifactId: 'audio-one', validUntil: '2030-01-01T00:00:00.000Z' }],
    },
  }
  const result = await materializer.materialize({ job })
  assert.equal(result.avatarId, 'avatar_authorized_123')
  assert.equal(result.audioSha256, sha256)
  assert.deepEqual(Buffer.from(result.audioBytes), bytes)
  assert.equal(result.audioContainer, 'mp3')
  assert.equal(cleanupCalls, 1)
  await rm(root, { recursive: true, force: true })
})

test('T-FR-100 audio-first materializer extracts the exact approved range with real FFmpeg', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-audio-first-range-'))
  const sourcePath = join(root, 'master.wav')
  const outputPath = join(root, 'range.mp3')
  let cleanupCalls = 0
  try {
    execFileSync(ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:a', 'pcm_s16le', sourcePath], { windowsHide: true })
    const sourceBytes = await readFile(sourcePath)
    const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
    const profile = { snapshot: { id: 'presenter-range:v1', snapshotHash: 'a'.repeat(64), status: 'active', avatar: { adapterId: 'heygen-v3', adapterVersion: '3.0.0', identityRef: 'avatar_range_123' } } }
    const artifact = {
      id: 'audio-range-master', workspaceId: 'workspace-range', artifactKey: 'audio/range-master.wav', sha256: sourceSha256,
      byteSize: BigInt(sourceBytes.length), mediaType: 'audio', container: 'wav', status: 'available', lifecycleRevision: 1,
      manifests: [{ id: 'manifest-range', probe: { width: 0, height: 0, duration: 3, fps: 0 }, createdAt: '2029-01-01T00:00:00.000Z' }], createdAt: '2029-01-01T00:00:00.000Z',
    }
    const materializer = new AuthorizedProviderSubmissionInputMaterializer({
      profiles: { async readProfile() { return profile } }, artifacts: { async findById() { return artifact } },
      sources: { async materialize() { return { path: sourcePath, sha256: sourceSha256, byteSize: sourceBytes.length } }, async cleanup() { cleanupCalls += 1 } },
      clock: () => new Date('2029-01-01T00:00:01.000Z'),
    })
    const result = await materializer.materialize({ job: {
      id: 'provider-job-range', workspaceId: 'workspace-range', operation: 'audio-avatar', adapterId: 'heygen-v3', adapterVersion: '3.0.0',
      input: { audioArtifactId: artifact.id, durationMs: 1_500, aspectRatio: '9:16', audioMasterId: 'audio-master-range', audioMasterHash: 'b'.repeat(64), audioRange: { startMs: 500, endMs: 2_000, rangeHash: 'c'.repeat(64) } },
      authorization: { profileSnapshotId: profile.snapshot.id, profileSnapshotHash: profile.snapshot.snapshotHash, expiresAt: '2030-01-01T00:00:00.000Z', artifactDecisions: [{ artifactId: artifact.id, validUntil: '2030-01-01T00:00:00.000Z' }] },
    } })
    await writeFile(outputPath, result.audioBytes)
    const probe = JSON.parse(execFileSync(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate', '-of', 'json', outputPath], { encoding: 'utf8', windowsHide: true }))
    assert.equal(result.audioContainer, 'mp3')
    assert.equal(result.durationMs, 1_500)
    assert.equal(result.audioSha256, createHash('sha256').update(result.audioBytes).digest('hex'))
    assert.notEqual(result.audioSha256, sourceSha256)
    assert.equal(probe.streams[0].codec_name, 'mp3')
    assert.equal(Number(probe.streams[0].sample_rate), 48_000)
    assert.ok(Math.abs(Number(probe.format.duration) - 1.5) <= 0.05, `expected 1.5s, got ${probe.format.duration}`)
    assert.equal(cleanupCalls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-101 provider result is probed, promoted and persisted before its critic can approve it', async () => {
  const source = { id: 'audio-one', artifactKey: 'audio/source.wav', sha256: 'b'.repeat(64), status: 'available' }
  let persistedBundle
  let outputRecord
  let cleanupCalls = 0
  const artifactQuery = {
    async findById(_workspaceId, artifactId) { return artifactId === 'audio-one' ? source : outputRecord },
  }
  const job = {
    id: 'provider-job-one', workspaceId: 'workspace-one', providerJobId: 'heygen-video-one', operation: 'audio-avatar',
    adapterId: 'heygen-v3', adapterVersion: '3.0.0', input: { durationMs: 2_000, aspectRatio: '9:16' }, inputHash: 'c'.repeat(64),
    authorization: { authorizationHash: 'd'.repeat(64), profileSnapshotHash: 'e'.repeat(64), artifactDecisions: [{ artifactId: 'audio-one' }] },
  }
  const ingestor = new VerifiedProviderResultIngestor({
    downloader: { async download() { return { path: 'C:/staged/provider.mp4', sha256: 'f'.repeat(64), byteSize: 1234 } }, async cleanup() { cleanupCalls += 1 } },
    storage: { async promoteDerived() { return { key: 'synthetic-provider-results/result.mp4', path: 'C:/stored/result.mp4', sha256: 'f'.repeat(64), byteSize: 1234 } } },
    artifacts: { async persistOrReplay(bundle) { persistedBundle = bundle; return { artifactId: bundle.artifactId, manifestId: bundle.manifestId, replayed: false } } },
    artifactQuery,
    prober: { async probe() { return { width: 540, height: 960, fps: 25, duration: 2, codec: 'h264', audioCodec: 'aac', container: 'mov,mp4', color: {}, producer: {} } } },
    clock: () => new Date('2029-01-01T00:00:00.000Z'),
  })
  const artifact = await ingestor.ingest({ job, providerResult: { providerJobId: 'heygen-video-one', downloadUrl: 'https://files.heygen.ai/result.mp4?sig=short', mediaType: 'video' } })
  assert.equal(cleanupCalls, 1)
  assert.equal(persistedBundle.manifest.artifact.sha256, artifact.artifactSha256)
  assert.equal(persistedBundle.manifest.sources[0].artifactKey, source.artifactKey)
  outputRecord = { id: artifact.artifactId, sha256: artifact.artifactSha256, byteSize: BigInt(artifact.byteSize), mediaType: 'video', manifests: [{ probe: { width: 540, height: 960, fps: 25, duration: 2 } }] }
  const critic = await new PersistedProviderResultCritic(artifactQuery).evaluate({ job, artifact })
  assert.equal(critic.approved, true)
  assert.match(critic.resultHash, /^[a-f0-9]{64}$/)
})

test('T-FR-101 provider result downloader rejects unlisted hosts and private DNS answers before opening a file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-provider-download-'))
  const downloader = new SafeProviderResultDownloader({ workRoot: root, allowedHosts: ['localhost'], maxBytes: 1024 })
  await assert.rejects(() => downloader.download({ operationId: 'provider-job-one', url: 'https://files.heygen.ai/result.mp4' }), /not allowed/)
  await assert.rejects(() => downloader.download({ operationId: 'provider-job-one', url: 'https://localhost/result.mp4' }), (error) => error.code === 'WEBHOOK_NETWORK_REJECTED')
  await rm(root, { recursive: true, force: true })
})

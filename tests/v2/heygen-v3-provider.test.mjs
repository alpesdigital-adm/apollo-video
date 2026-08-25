import assert from 'node:assert/strict'
import test from 'node:test'

import { HeyGenProviderError, HeyGenV3AsyncMediaProviderAdapter } from '../../src/v2/infrastructure/heygen-v3-provider.ts'

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

test('T-FR-101 HeyGen v3 adapter normalizes submit, polling and retrieval without leaking its credential', async () => {
  const requests = []
  const statuses = ['pending', 'processing', 'completed', 'completed']
  const adapter = new HeyGenV3AsyncMediaProviderAdapter({
    apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 150,
    clock: () => new Date('2029-01-01T00:00:00.000Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body })
      if (init.method === 'POST') return json({ data: { video_id: 'video_job_123', status: 'pending', output_format: 'mp4' } })
      const status = statuses.shift()
      return json({ data: { id: 'video_job_123', status, ...(status === 'completed' ? { video_url: 'https://files.heygen.ai/video/result.mp4?Expires=123' } : {}) } })
    },
  })
  const capabilities = await adapter.getCapabilities()
  assert.deepEqual(capabilities.operations, ['audio-avatar', 'lip-sync'])
  assert.deepEqual(await adapter.estimate({ durationMs: 61_000 }), { currency: 'USD', costMinorUnits: 300, estimatedLatencyMs: 152_500 })
  const submitted = await adapter.submit({ avatarId: 'avatar_123', audioUrl: 'https://storage.example/audio.wav?signature=short-lived', durationMs: 61_000, aspectRatio: '9:16' }, {
    workspaceId: 'workspace-one', projectVersionId: 'version-one', operationId: 'operation-one', idempotencyKey: 'apollo-idempotency-one',
  })
  assert.equal(submitted.providerJobId, 'video_job_123')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'queued')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'processing')
  assert.equal(await adapter.getStatus(submitted.providerJobId), 'completed')
  assert.deepEqual(await adapter.retrieve(submitted.providerJobId), { providerJobId: 'video_job_123', downloadUrl: 'https://files.heygen.ai/video/result.mp4?Expires=123', mediaType: 'video' })
  assert.equal(requests[0].headers.get('idempotency-key'), 'apollo-idempotency-one')
  assert.equal(requests[0].headers.get('x-api-key'), 'heygen-test-secret')
  assert.equal(JSON.stringify(requests.map(({ headers: _headers, ...request }) => request)).includes('heygen-test-secret'), false)
  assert.deepEqual(JSON.parse(requests[0].body), { type: 'avatar', avatar_id: 'avatar_123', audio_url: 'https://storage.example/audio.wav?signature=short-lived', aspect_ratio: '9:16', output_format: 'mp4' })
})

test('T-FR-101 HeyGen adapter fails closed on input, status, redirects, oversized bodies and normalized HTTP errors', async () => {
  const adapter = new HeyGenV3AsyncMediaProviderAdapter({ apiKey: 'heygen-test-secret', costMinorUnitsPerMinute: 0, fetch: async () => json({ data: { video_id: 'ok_job' } }) })
  await assert.rejects(() => adapter.submit({ avatarId: 'avatar_123', audioUrl: 'http://unsafe.example/audio.wav', durationMs: 2_000 }, { workspaceId: 'w', projectVersionId: 'v', operationId: 'o', idempotencyKey: 'safe-key-123' }), (error) => error instanceof HeyGenProviderError && error.code === 'INVALID_AUDIO_URL')
  await assert.rejects(() => adapter.submit({ avatarId: 'avatar_123', audioUrl: 'https://safe.example/audio.wav', durationMs: 2_000, hidden: true }, { workspaceId: 'w', projectVersionId: 'v', operationId: 'o', idempotencyKey: 'safe-key-123' }), (error) => error.code === 'PROVIDER_INPUT_INVALID')

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

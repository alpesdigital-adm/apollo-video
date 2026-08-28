import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { ElevenLabsProviderError, ElevenLabsTtsProviderAdapter } from '../../src/v2/infrastructure/elevenlabs-tts-provider.ts'

const SCRIPT = 'Olá mundo'
const SCRIPT_HASH = createHash('sha256').update(SCRIPT, 'utf8').digest('hex')
const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(61, 7)])
const WAV_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 0), Buffer.from('WAVE'), Buffer.alloc(52, 7)])

function alignmentFor(text) {
  const characters = [...text]
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * 0.1),
    character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.1),
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

function submitInput(overrides = {}) {
  return { text: SCRIPT, scriptHash: SCRIPT_HASH, voiceId: 'voice_abc_123', outputFormat: 'mp3', ...overrides }
}

const context = { workspaceId: 'workspace-one', projectVersionId: 'version-one', operationId: 'operation-one', idempotencyKey: 'apollo-idempotency-one' }

test('T-FR-101 ElevenLabs adapter completes synchronously with verified audio, alignment and provider reference', async () => {
  const requests = []
  const adapter = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    clock: () => new Date('2029-01-01T00:00:00.000Z'),
    fetch: async (url, init) => {
      requests.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body })
      return json(
        { audio_base64: MP3_BYTES.toString('base64'), alignment: alignmentFor(SCRIPT), normalized_alignment: alignmentFor(SCRIPT.toLowerCase()) },
        200,
        { 'request-id': 'elevenlabs_request_123' },
      )
    },
  })
  const capabilities = await adapter.getCapabilities()
  assert.deepEqual(capabilities.operations, ['tts'])
  assert.equal(capabilities.completion, 'synchronous')
  assert.equal(capabilities.supportsIdempotency, false)
  assert.equal(capabilities.supportsCancellation, false)
  assert.ok(Date.parse(capabilities.expiresAt) > Date.parse(capabilities.fetchedAt))
  assert.deepEqual(await adapter.estimate({ text: SCRIPT }), { currency: 'USD', costMinorUnits: 30, estimatedLatencyMs: 5_000 })
  const submitted = await adapter.submit(submitInput({ languageCode: 'pt-BR', seed: 42 }), context)
  assert.equal(submitted.kind, 'completed')
  assert.equal(submitted.bundle.providerJobRef, 'elevenlabs_request_123')
  assert.equal(submitted.bundle.completedAt, '2029-01-01T00:00:00.000Z')
  const result = submitted.bundle.result
  assert.equal(result.requestId, 'elevenlabs_request_123')
  assert.equal(result.modelId, 'eleven_multilingual_v2')
  assert.equal(result.scriptHash, SCRIPT_HASH)
  assert.equal(result.audioSha256, createHash('sha256').update(MP3_BYTES).digest('hex'))
  assert.equal(result.audioByteSize, MP3_BYTES.byteLength)
  assert.equal(result.audioContainer, 'mp3')
  assert.equal(result.mediaType, 'audio')
  assert.equal(result.alignment.characters.join(''), SCRIPT)
  assert.equal(result.alignment.startTimesSeconds.length, [...SCRIPT].length)
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice_abc_123/with-timestamps?output_format=mp3_44100_128')
  assert.equal(request.headers.get('xi-api-key'), 'elevenlabs-test-secret')
  assert.deepEqual(JSON.parse(request.body), { text: SCRIPT, model_id: 'eleven_multilingual_v2', language_code: 'pt-BR', seed: 42 })
  assert.equal(JSON.stringify({ result, url: request.url, body: request.body }).includes('elevenlabs-test-secret'), false)
})

test('T-FR-101 ElevenLabs adapter emits WAV when requested and validates the container signature', async () => {
  const adapter = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async (url) => {
      assert.ok(String(url).endsWith('output_format=wav_44100'))
      return json({ audio_base64: WAV_BYTES.toString('base64'), alignment: alignmentFor(SCRIPT) }, 200, { 'request-id': 'elevenlabs_request_wav' })
    },
  })
  const submitted = await adapter.submit(submitInput({ outputFormat: 'wav' }), context)
  assert.equal(submitted.bundle.result.audioContainer, 'wav')

  const mismatched = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => json({ audio_base64: MP3_BYTES.toString('base64'), alignment: alignmentFor(SCRIPT) }, 200, { 'request-id': 'elevenlabs_request_bad' }),
  })
  await assert.rejects(() => mismatched.submit(submitInput({ outputFormat: 'wav' }), context), (error) => error.code === 'PROVIDER_CONTAINER_MISMATCH')
})

test('T-FR-101 ElevenLabs adapter fails closed on tampered script, alignment drift and missing provider reference', async () => {
  const adapter = new ElevenLabsTtsProviderAdapter({ apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30, fetch: async () => { throw new Error('unreachable') } })
  await assert.rejects(() => adapter.submit(submitInput({ text: 'Texto adulterado' }), context), (error) => error instanceof ElevenLabsProviderError && error.code === 'SCRIPT_MATERIALIZATION_MISMATCH')
  await assert.rejects(() => adapter.submit(submitInput({ scriptHash: 'zz' }), context), (error) => error.code === 'INVALID_SCRIPT_HASH')
  await assert.rejects(() => adapter.submit(submitInput({ voiceId: '!' }), context), (error) => error.code === 'INVALID_VOICE_ID')
  await assert.rejects(() => adapter.submit(submitInput({ outputFormat: 'flac' }), context), (error) => error.code === 'INVALID_OUTPUT_FORMAT')
  await assert.rejects(() => adapter.submit(submitInput({ hidden: true }), context), (error) => error.code === 'PROVIDER_INPUT_INVALID')
  await assert.rejects(() => adapter.submit(submitInput({ seed: -1 }), context), (error) => error.code === 'INVALID_SEED')

  const drifted = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => json({ audio_base64: MP3_BYTES.toString('base64'), alignment: alignmentFor('Outro texto') }, 200, { 'request-id': 'elevenlabs_request_drift' }),
  })
  await assert.rejects(() => drifted.submit(submitInput(), context), (error) => error.code === 'PROVIDER_ALIGNMENT_MISMATCH')

  const unreferenced = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => json({ audio_base64: MP3_BYTES.toString('base64'), alignment: alignmentFor(SCRIPT) }),
  })
  await assert.rejects(() => unreferenced.submit(submitInput(), context), (error) => error.code === 'PROVIDER_REFERENCE_MISSING')

  const nonMonotonic = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => {
      const alignment = alignmentFor(SCRIPT)
      alignment.character_start_times_seconds[3] = 0
      return json({ audio_base64: MP3_BYTES.toString('base64'), alignment }, 200, { 'request-id': 'elevenlabs_request_mono' })
    },
  })
  await assert.rejects(() => nonMonotonic.submit(submitInput(), context), (error) => error.code === 'PROVIDER_ALIGNMENT_INVALID')
})

test('T-FR-101 ElevenLabs adapter normalizes HTTP failures, oversized payloads, timeout and abort without leaking secrets', async () => {
  const cases = [
    [429, { 'retry-after': '3' }, 'PROVIDER_RATE_LIMITED', true, 3_000],
    [503, {}, 'PROVIDER_UNAVAILABLE', true, undefined],
    [401, {}, 'PROVIDER_AUTHENTICATION_FAILED', false, undefined],
    [409, {}, 'PROVIDER_CONFLICT', true, undefined],
    [422, {}, 'PROVIDER_REQUEST_REJECTED', false, undefined],
  ]
  for (const [status, headers, code, retryable, retryAfterMs] of cases) {
    const failing = new ElevenLabsTtsProviderAdapter({
      apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
      fetch: async () => json({ secret: 'must-not-surface' }, status, headers),
    })
    await assert.rejects(() => failing.submit(submitInput(), context), (error) => error.code === code && error.retryable === retryable && error.retryAfterMs === retryAfterMs && !error.message.includes('secret'))
  }
  const malformed = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => new Response('not-json', { status: 200, headers: { 'request-id': 'elevenlabs_request_raw' } }),
  })
  await assert.rejects(() => malformed.submit(submitInput(), context), (error) => error.code === 'PROVIDER_RESPONSE_INVALID')
  const oversized = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30, maxAudioBytes: 1_024,
    fetch: async () => json({ audio_base64: Buffer.alloc(4_096, 7).toString('base64'), alignment: alignmentFor(SCRIPT) }, 200, { 'request-id': 'elevenlabs_request_big' }),
  })
  await assert.rejects(() => oversized.submit(submitInput(), context), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE')
  const networkFailure = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async () => { throw new TypeError('redirect blocked') },
  })
  await assert.rejects(() => networkFailure.submit(submitInput(), context), (error) => error.code === 'PROVIDER_NETWORK_FAILURE' && error.retryable === true)
  const aborted = new ElevenLabsTtsProviderAdapter({
    apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30,
    fetch: async (_url, init) => { init.signal.throwIfAborted(); throw new Error('unreachable') },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => aborted.submit(submitInput(), { ...context, signal: controller.signal }), (error) => error.code === 'PROVIDER_TIMEOUT')
})

test('T-FR-101 ElevenLabs adapter identity hash excludes the credential and configuration fails closed', () => {
  const first = new ElevenLabsTtsProviderAdapter({ apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30, fetch: async () => { throw new Error('unreachable') } })
  const rotated = new ElevenLabsTtsProviderAdapter({ apiKey: 'another-longer-secret', costMinorUnitsPerThousandCharacters: 30, fetch: async () => { throw new Error('unreachable') } })
  assert.equal(first.configHash, rotated.configHash)
  const reconfigured = new ElevenLabsTtsProviderAdapter({ apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 45, fetch: async () => { throw new Error('unreachable') } })
  assert.notEqual(first.configHash, reconfigured.configHash)
  assert.throws(() => new ElevenLabsTtsProviderAdapter({ apiKey: 'short', costMinorUnitsPerThousandCharacters: 30 }), /credential/)
  assert.throws(() => new ElevenLabsTtsProviderAdapter({ apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: -1 }), /cost/)
  assert.throws(() => new ElevenLabsTtsProviderAdapter({ apiKey: 'elevenlabs-test-secret', costMinorUnitsPerThousandCharacters: 30, baseUrl: 'http://api.elevenlabs.io' }), /base URL/)
})

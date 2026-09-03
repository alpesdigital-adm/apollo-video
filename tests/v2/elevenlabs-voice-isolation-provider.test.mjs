import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  ElevenLabsVoiceIsolationProvider,
} from '../../src/v2/infrastructure/elevenlabs-voice-isolation-provider.ts'

test('T-FR-123 ElevenLabs adapter binds the paid request and replays durable bytes without a second call', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-voice-isolation-'))
  const sourcePath = join(root, 'source.mp4')
  const sourceBytes = Buffer.alloc(4_096, 7)
  const isolatedBytes = Buffer.alloc(2_048, 11)
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  await writeFile(sourcePath, sourceBytes)
  let calls = 0
  const provider = new ElevenLabsVoiceIsolationProvider({
    apiKey: 'controlled-test-key',
    workRoot: root,
    baseUrl: 'http://127.0.0.1:32123',
    fetch: async (url, init) => {
      calls += 1
      assert.equal(url, 'http://127.0.0.1:32123/v1/audio-isolation')
      assert.equal(init.method, 'POST')
      assert.equal(init.headers['xi-api-key'], 'controlled-test-key')
      assert.ok(init.body instanceof FormData)
      assert.equal(init.body.get('file_format'), 'other')
      assert.ok(init.body.get('audio') instanceof Blob)
      assert.equal(init.body.get('audio').name, 'operation-voice-isolation-1.mp4')
      return new Response(isolatedBytes, {
        status: 200,
        headers: {
          'content-type': 'audio/mpeg',
          'request-id': 'voice-isolation-request-1',
        },
      })
    },
  })
  try {
    const offer = provider.offer(10_000)
    assert.equal(offer.billing.quantity, 1_000)
    const input = {
      operationId: 'operation-voice-isolation-1',
      sourcePath,
      sourceSha256,
      sourceDurationMs: 10_000,
      expectedOffer: offer,
    }
    const first = await provider.isolate(input)
    const replay = await provider.isolate(input)
    assert.equal(calls, 1)
    assert.equal(first.isolatedAudioSha256, createHash('sha256').update(isolatedBytes).digest('hex'))
    assert.equal(replay.isolatedAudioSha256, first.isolatedAudioSha256)
    assert.deepEqual(await readFile(replay.isolatedAudioPath), isolatedBytes)

    await writeFile(
      join(root, input.operationId, 'isolation-result.json'),
      '{"corrupted":true}',
    )
    await assert.rejects(
      provider.isolate(input),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(calls, 1)

    await assert.rejects(
      provider.isolate({
        ...input,
        operationId: 'operation-voice-isolation-2',
        expectedOffer: { ...offer, configHash: '0'.repeat(64) },
      }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(calls, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('T-FR-123 ElevenLabs adapter fails closed on missing provider identity and ambiguous transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'apollo-voice-isolation-fail-'))
  const sourcePath = join(root, 'source.mp4')
  const sourceBytes = Buffer.alloc(4_096, 5)
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex')
  await writeFile(sourcePath, sourceBytes)
  const makeProvider = (fetch) => new ElevenLabsVoiceIsolationProvider({
    apiKey: 'controlled-test-key', workRoot: root,
    baseUrl: 'http://127.0.0.1:32124', fetch,
  })
  try {
    const missingIdentity = makeProvider(async () => new Response(Buffer.alloc(2_048), {
      status: 200, headers: { 'content-type': 'audio/mpeg' },
    }))
    await assert.rejects(
      missingIdentity.isolate({
        operationId: 'operation-voice-isolation-missing-id', sourcePath, sourceSha256,
        sourceDurationMs: 10_000, expectedOffer: missingIdentity.offer(10_000),
      }),
      (error) => error instanceof DomainError && error.code === 'RENDER_OUTPUT_INVALID',
    )
    let ambiguousCalls = 0
    const ambiguous = makeProvider(async () => {
      ambiguousCalls += 1
      throw new Error('socket closed')
    })
    await assert.rejects(
      ambiguous.isolate({
        operationId: 'operation-voice-isolation-ambiguous', sourcePath, sourceSha256,
        sourceDurationMs: 10_000, expectedOffer: ambiguous.offer(10_000),
      }),
      (error) => error instanceof DomainError && error.code === 'RENDER_OUTPUT_CONFLICT',
    )
    await assert.rejects(
      ambiguous.isolate({
        operationId: 'operation-voice-isolation-ambiguous', sourcePath, sourceSha256,
        sourceDurationMs: 10_000, expectedOffer: ambiguous.offer(10_000),
      }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(ambiguousCalls, 1, 'ambiguous paid submissions must never be repeated')

    let partialCalls = 0
    const partial = makeProvider(async () => {
      partialCalls += 1
      throw new Error('must not reach provider')
    })
    const partialOperationId = 'operation-voice-isolation-partial'
    const partialDirectory = join(root, partialOperationId)
    await mkdir(partialDirectory, { recursive: true })
    await writeFile(join(partialDirectory, 'isolated-speech.mp3.partial'), 'partial')
    await assert.rejects(
      partial.isolate({
        operationId: partialOperationId, sourcePath, sourceSha256,
        sourceDurationMs: 10_000, expectedOffer: partial.offer(10_000),
      }),
      (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
    )
    assert.equal(partialCalls, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

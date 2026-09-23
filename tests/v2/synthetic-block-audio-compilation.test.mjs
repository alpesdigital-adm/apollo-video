import assert from 'node:assert/strict'
import test from 'node:test'

import { materializeBlockAudioSources } from '../../src/v2/application/synthetic-block-audio-compilation.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

test('block audio materialization waits for sibling downloads before exposing an integrity failure', async () => {
  let releaseSibling
  const siblingReleased = new Promise((resolve) => { releaseSibling = resolve })
  let siblingTerminal = false
  let cleanupCalled = false
  let concatenateCalled = false
  let promoteCalled = false
  const integrityFailure = new DomainError('PERSISTENCE_CONFLICT', 'corrupted source')
  const sources = {
    async materialize({ artifactKey }) {
      if (artifactKey === 'corrupted.mp3') throw integrityFailure
      await siblingReleased
      siblingTerminal = true
      return { path: '/controlled/sibling.mp3', sha256: 'b'.repeat(64), byteSize: 1 }
    },
    async cleanup() {
      cleanupCalled = true
      assert.equal(siblingTerminal, true, 'cleanup must run only after every sibling download is terminal')
    },
  }
  const blocks = [
    { blockId: 'corrupt', generationId: 'generation-corrupt', audio: { artifactKey: 'corrupted.mp3', sha256: 'a'.repeat(64), byteSize: 1 } },
    { blockId: 'sibling', generationId: 'generation-sibling', audio: { artifactKey: 'sibling.mp3', sha256: 'b'.repeat(64), byteSize: 1 } },
  ]

  const execute = async () => {
    try {
      const materialized = await materializeBlockAudioSources({ sources, operationId: 'compile-operation', blocks })
      concatenateCalled = true
      assert.ok(materialized.length > 0)
      promoteCalled = true
    } finally {
      await sources.cleanup('compile-operation')
    }
  }
  const execution = execute()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(cleanupCalled, false, 'an early rejection must not begin cleanup while a sibling is active')
  releaseSibling()
  await assert.rejects(execution, (error) => error === integrityFailure)
  assert.equal(cleanupCalled, true)
  assert.equal(concatenateCalled, false)
  assert.equal(promoteCalled, false)
})

test('block audio materialization preserves plan order when downloads finish out of order', async () => {
  let releaseFirst
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve })
  const completionOrder = []
  const sources = {
    async materialize({ artifactKey, sha256 }) {
      if (artifactKey === 'first.mp3') await firstReleased
      completionOrder.push(artifactKey)
      return { path: `/controlled/${artifactKey}`, sha256, byteSize: 1 }
    },
    async cleanup() {},
  }
  const blocks = [
    { blockId: 'first', generationId: 'generation-first', audio: { artifactKey: 'first.mp3', sha256: 'a'.repeat(64), byteSize: 1 } },
    { blockId: 'second', generationId: 'generation-second', audio: { artifactKey: 'second.mp3', sha256: 'b'.repeat(64), byteSize: 1 } },
  ]
  const pending = materializeBlockAudioSources({ sources, operationId: 'ordered-operation', blocks })
  await new Promise((resolve) => setImmediate(resolve))
  releaseFirst()
  const materialized = await pending
  assert.deepEqual(completionOrder, ['second.mp3', 'first.mp3'])
  assert.deepEqual(materialized.map(({ blockId }) => blockId), ['first', 'second'])
})

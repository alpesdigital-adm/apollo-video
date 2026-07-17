import test from 'node:test'
import assert from 'node:assert/strict'
import { createPerceptionTimeline, PERCEPTION_GOLDEN_FIXTURES, queryPerceptionRange } from '../../src/v2/domain/perception-timeline.ts'

test('T-FR-050 unifies timed observations with source, model, version and confidence', () => {
  const timeline = PERCEPTION_GOLDEN_FIXTURES.talkingHead
  assert.deepEqual(timeline.observations.map((item) => item.kind), ['transcript-word', 'face', 'silence'])
  assert.equal(timeline.observations.every((item) => item.provenance.version === '1'), true)
  assert.equal(Object.keys(PERCEPTION_GOLDEN_FIXTURES).length, 3)
})

test('T-FR-050 range API reports absent and partial coverage without invention', () => {
  const result = queryPerceptionRange(PERCEPTION_GOLDEN_FIXTURES.audioOnly, { startMs: 0, endMs: 1500, kinds: ['transcript-word', 'face', 'speaker'] })
  assert.deepEqual(result.coverage.map((item) => [item.kind, item.state]), [['transcript-word', 'partial'], ['face', 'absent'], ['speaker', 'complete']])
  assert.equal(result.inventedValues, 0)
  assert.throws(() => createPerceptionTimeline({ durationMs: 10, observations: [{ id: 'bad', kind: 'ocr', startMs: 0, endMs: 11, value: 'x', provenance: { source: 'x', model: 'x', version: '1', confidence: 1 } }] }), /Invalid/)
})

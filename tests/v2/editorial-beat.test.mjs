import test from 'node:test'
import assert from 'node:assert/strict'
import { adjustEditorialBeat, deriveEditorialBeats } from '../../src/v2/domain/editorial-beat.ts'

const words = [
  { id: 'w1', text: 'Uma', startMs: 0, endMs: 1000, subtitleChunkId: 'sub1' },
  { id: 'w2', text: 'frase', startMs: 1000, endMs: 4000, subtitleChunkId: 'sub1' },
  { id: 'w3', text: 'longa', startMs: 4000, endMs: 8100, subtitleChunkId: 'sub2' },
  { id: 'w4', text: 'continua', startMs: 8200, endMs: 9000, sentenceEnd: true, subtitleChunkId: 'sub2' }
]
const signals = words.map((word, index) => ({ wordId: word.id, intent: index < 3 ? 'explain' : 'conclude', argumentId: 'arg1', pauseAfterMs: index === 1 ? 500 : 0, visualContext: 'speaker' }))

test('T-FR-051 derives semantic beats from sentence, intention, pause, argument and visual change, not subtitle rows', () => {
  const beats = deriveEditorialBeats(words, signals)
  assert.equal(beats[0].endMs, 4000)
  assert.ok(beats[0].boundaryReasons.includes('pause'))
  assert.deepEqual(beats[0].wordIds, ['w1', 'w2'])
  assert.notEqual(beats.length, new Set(words.map((word) => word.subtitleChunkId)).size)
})

test('T-FR-051 director adjustment preserves original word alignment and handles internal pauses', () => {
  const before = structuredClone(words)
  const beat = deriveEditorialBeats(words, signals)[0]
  const result = adjustEditorialBeat(beat, { startMs: 250, endMs: 3750, actor: 'director' }, words)
  assert.equal(result.wordAlignmentUnchanged, true)
  assert.deepEqual(words, before)
  assert.equal(result.beat.adjustedBy, 'director')
})

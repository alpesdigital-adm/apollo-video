import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyEditorialCutsToTranscription,
  editorialCutsAsSilences,
  normalizeEditorialCuts
} from '../src/lib/editorial-cuts.ts'

const transcription = {
  text: 'Antes aula no dia oito depois porque em apenas dois dias você aprende',
  language: 'pt',
  segments: [
    { id: 0, start: 0, end: 4, text: 'Antes aula no dia oito depois', words: [
      { word: 'Antes', start: 0, end: .4 }, { word: 'aula', start: .5, end: .9 },
      { word: 'no', start: 1, end: 1.2 }, { word: 'dia', start: 1.3, end: 1.5 },
      { word: 'oito', start: 1.6, end: 2 }, { word: 'depois', start: 3, end: 4 }
    ]},
    { id: 1, start: 5, end: 9, text: 'porque em apenas dois dias você aprende', words: [
      { word: 'porque', start: 5, end: 5.5 }, { word: 'em', start: 5.6, end: 5.8 },
      { word: 'apenas', start: 5.9, end: 6.2 }, { word: 'dois', start: 6.3, end: 6.5 },
      { word: 'dias', start: 6.6, end: 7 }, { word: 'você', start: 7.2, end: 7.5 },
      { word: 'aprende', start: 7.6, end: 9 }
    ]}
  ]
}

test('editorial cuts remove complete and partial claims while preserving continuity words', () => {
  const cuts = normalizeEditorialCuts([
    { startTime: .45, endTime: 2.1, reason: 'data incorreta' },
    { startTime: 5.55, endTime: 7.05, reason: 'dois dias' }
  ], 9)
  const edited = applyEditorialCutsToTranscription(transcription, cuts)
  assert.equal(edited.text, 'Antes depois porque você aprende')
  assert.deepEqual(edited.segments.map((segment) => segment.id), [0, 1])
  assert.equal(edited.segments[1].text, 'porque você aprende')
})

test('editorial cut ranges merge and compensate the autocut safety margin', () => {
  const cuts = normalizeEditorialCuts([
    { startTime: 1, endTime: 2, reason: 'a' },
    { startTime: 2.02, endTime: 3, reason: 'b' }
  ], 10)
  assert.equal(cuts.length, 1)
  const [silence] = editorialCutsAsSilences(cuts, 30)
  assert.equal(silence.startTime, .88)
  assert.equal(silence.endTime, 3.12)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { locateSpokenCta } from '../../src/v2/application/run-project-director.ts'

const FPS = 30
const at = (seconds) => Math.round(seconds * FPS)

// Words of one clip; times in seconds, turned into timeline frames.
const words = [
  ['Bem-vindo', 0.0, 0.6], ['ao', 0.6, 0.8], ['encontro.', 0.8, 1.4],
  ['Então', 2.0, 2.4], ['já', 2.4, 2.6], ['reserve', 2.6, 3.0], ['a', 3.0, 3.1], ['sua', 3.1, 3.3], ['data.', 3.3, 3.8],
  ['Até', 4.2, 4.5], ['lá!', 4.5, 4.9],
].map(([text, start, end]) => ({ text, timelineStartFrame: at(start), timelineEndFrame: at(end) }))
const clips = [{ id: 'clip-1', timelineInFrame: 0, timelineOutFrame: at(5) }]

const action = (overrides) => Object.freeze({ schemaVersion: 1, kind: 'continue-viewing', disclosures: [], ...overrides })

test('a declared spoken call is located even when the action only asks the viewer to keep watching', () => {
  const found = locateSpokenCta({ action: action({ verbalCta: 'já reserve a sua data' }), language: 'pt', fps: FPS, words, clips })
  assert.deepEqual(found, { clipId: 'clip-1', startSeconds: 2, endSeconds: 3.8 })
})

test('without a declared spoken call, an action that only keeps the viewer watching has nothing to locate', () => {
  assert.equal(locateSpokenCta({ action: action({}), language: 'pt', fps: FPS, words, clips }), undefined)
})

test('a declared spoken call that the speech does not contain is not located', () => {
  assert.equal(locateSpokenCta({ action: action({ verbalCta: 'compre agora' }), language: 'pt', fps: FPS, words, clips }), undefined)
})

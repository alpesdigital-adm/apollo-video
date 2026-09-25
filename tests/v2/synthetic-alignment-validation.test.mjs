import assert from 'node:assert/strict'
import test from 'node:test'

import { validateSyntheticAlignment } from '../../src/v2/infrastructure/media/synthetic-alignment-validation.ts'

test('W24.1 provider alignment accepts zero-duration characters but rejects non-finite and non-monotonic timelines', () => {
  const valid = validateSyntheticAlignment({
    characters: ['O', 'i'],
    startTimesSeconds: [0, 0],
    endTimesSeconds: [0, 0.4],
  })
  assert.deepEqual(valid.endTimesSeconds, [0, 0.4])

  for (const alignment of [
    { characters: ['O'], startTimesSeconds: [Number.NaN], endTimesSeconds: [0.1] },
    { characters: ['O'], startTimesSeconds: [0.2], endTimesSeconds: [0.1] },
    { characters: ['O', 'i'], startTimesSeconds: [0, 0.05], endTimesSeconds: [0.1, 0.2] },
  ]) assert.throws(() => validateSyntheticAlignment(alignment), /timeline is invalid/)
})

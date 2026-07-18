import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRetainedSourceRanges,
  deriveRecoveryEditorialExclusions,
  RECOVERY_EDITORIAL_EXCLUSION_RULES,
  validateRecoveryEditorialAcceptance,
} from '../../src/v2/application/recovery-project-acceptance.ts'
import { createMediaTranscript } from '../../src/v2/domain/media-transcript.ts'

function recoveryTranscript() {
  const tokens = [
    ['As', 0, .2], ['aulas', .2, .6], ['serão', .6, .9], ['nos', .9, 1.1],
    ['dias', 1.1, 1.35], ['31', 1.35, 1.55], ['de', 1.55, 1.7], ['janeiro', 1.7, 2.1],
    ['e', 2.1, 2.2], ['1º', 2.2, 2.4], ['de', 2.4, 2.55], ['fevereiro.', 2.55, 3],
    ['Você', 3.2, 3.5], ['vai', 3.5, 3.7], ['avançar', 3.7, 4.2], ['em', 4.2, 4.35],
    ['apenas', 4.35, 4.7], ['dois', 4.7, 4.95], ['dias.', 4.95, 5.25],
    ['O', 5.5, 5.6], ['dia', 5.6, 5.8], ['8', 5.8, 6], ['continua', 6, 6.35],
    ['irrelevante', 6.35, 6.9], ['para', 6.9, 7.1], ['este', 7.1, 7.3], ['critério.', 7.3, 7.7],
  ]
  return createMediaTranscript({
    language: 'pt-BR',
    text: tokens.map(([word]) => word).join(' '),
    words: tokens.map(([word, start, end]) => ({ word, start, end })),
    segments: [
      { id: 0, start: 0, end: 3.05, text: 'As aulas serão nos dias 31 de janeiro e 1º de fevereiro.' },
      { id: 1, start: 3.2, end: 5.3, text: 'Você vai avançar em apenas dois dias.' },
      { id: 2, start: 5.5, end: 7.75, text: 'O dia 8 continua irrelevante para este critério.' },
    ],
    provider: 'acceptance-fixture',
    model: 'aligned-v1',
  })
}

test('recovery E2E criterion targets January 31, February 1 and two-day duration', () => {
  assert.deepEqual(
    RECOVERY_EDITORIAL_EXCLUSION_RULES.map(({ id, label }) => ({ id, label })),
    [
      { id: 'date-january-31', label: '31 de janeiro' },
      { id: 'date-february-1', label: '1 de fevereiro' },
      { id: 'duration-two-days', label: 'dois dias' },
    ],
  )
  const exclusions = deriveRecoveryEditorialExclusions(recoveryTranscript())
  assert.deepEqual([...new Set(exclusions.flatMap((range) => range.ruleIds))], [
    'date-january-31',
    'date-february-1',
    'duration-two-days',
  ])
  assert.equal(exclusions.some((range) => range.matchedText.includes('8')), false)
})

test('recovery E2E fails while forbidden speech remains and passes after complete source cuts', () => {
  const transcript = recoveryTranscript()
  assert.throws(
    () => validateRecoveryEditorialAcceptance({
      transcript,
      retainedSourceRanges: [{ sourceStartSeconds: 0, sourceEndSeconds: 7.75 }],
    }),
    (error) => error.code === 'EDITORIAL_ACCEPTANCE_FAILED' &&
      error.details.retainedRuleIds.includes('date-january-31') &&
      error.details.retainedRuleIds.includes('date-february-1'),
  )
  const exclusions = deriveRecoveryEditorialExclusions(transcript)
  const retainedSourceRanges = buildRetainedSourceRanges(7.75, exclusions)
  const result = validateRecoveryEditorialAcceptance({ transcript, retainedSourceRanges })
  assert.equal(result.accepted, true)
  assert.deepEqual(result.excludedRuleIds, [
    'date-february-1',
    'date-january-31',
    'duration-two-days',
  ])
  assert.deepEqual(retainedSourceRanges, [{ sourceStartSeconds: 5.3, sourceEndSeconds: 7.75 }])
})

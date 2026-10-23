import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProductionBrief,
  parseProductionBrief,
} from '../../src/v2/domain/production-brief.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'

test('briefing complete, partial and absent all advance with explicit assumptions', () => {
  // What a briefing covers is what its INTERPRETATION found (never a word list); the briefings are synthetic.
  const complete = createProductionBrief({ ownerText: 'alpha beta gamma', ingestedContextRef: 'transcript:asset-1', interpretedCoverage: ['audience', 'offer', 'tone'] })
  assert.deepEqual(complete.assumptions, [])
  assert.deepEqual(complete.summary.coverage, { audience: true, offer: true, tone: true })
  assert.equal(complete.ownerInput.trust, 'owner-authorized')
  assert.equal(complete.ingestedContext.trust, 'untrusted-media-derived')
  assert.equal('text' in complete.ingestedContext, false)
  const partial = createProductionBrief({ ownerText: 'alpha', interpretedCoverage: ['audience'] })
  assert.deepEqual(partial.assumptions, ['offer-not-specified', 'tone-not-specified'])
  assert.deepEqual(partial.summary.coverage, { audience: true, offer: false, tone: false })
  const absent = createProductionBrief({})
  assert.equal(absent.summary.supplied, false)
  assert.ok(absent.assumptions.includes('briefing-absent'))
  assert.equal(absent.readyForExpensiveGeneration, false)
  assert.deepEqual(absent.summary.coverage, { audience: false, offer: false, tone: false })
  assert.ok(Object.isFrozen(absent.summary.coverage))
})

test('briefing preserves paragraphs, normalizes whitespace and parses only canonical trust boundaries', () => {
  const brief = createProductionBrief({
    ownerText: '  alpha: one.\n\nbeta: two.   gamma: three.  ',
    ingestedContextRef: 'transcript:artifact-1',
    interpretedCoverage: ['audience', 'offer', 'tone'],
  })
  assert.equal(
    brief.ownerInput.text,
    'alpha: one.\n\nbeta: two. gamma: three.',
  )
  assert.deepEqual(brief.assumptions, [])
  assert.deepEqual(parseProductionBrief(JSON.parse(JSON.stringify(brief))), brief)
  assert.throws(
    () => parseProductionBrief({
      ...brief,
      ingestedContext: { ref: 'transcript:artifact-1', trust: 'owner-authorized' },
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => parseProductionBrief({ ...brief, readyForExpensiveGeneration: true }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('published V2 brief snapshots without additive coverage hydrate canonically', () => {
  const current = createProductionBrief({
    ownerText: 'alpha beta gamma',
    interpretedCoverage: ['audience', 'offer', 'tone'],
  })
  const persistedBeforeCoverage = JSON.parse(JSON.stringify(current))
  delete persistedBeforeCoverage.summary.coverage

  assert.deepEqual(parseProductionBrief(persistedBeforeCoverage), current)
  assert.throws(
    () => parseProductionBrief({
      ...persistedBeforeCoverage,
      assumptions: ['tone-not-specified', 'a-claim-the-brief-never-makes'],
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
  assert.throws(
    () => parseProductionBrief({
      ...persistedBeforeCoverage,
      summary: { ...persistedBeforeCoverage.summary, coverage: null },
    }),
    (error) => error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

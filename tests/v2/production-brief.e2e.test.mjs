import assert from 'node:assert/strict'
import test from 'node:test'
import { createProductionBrief } from '../../src/v2/domain/production-brief.ts'

test('briefing complete, partial and absent all advance with explicit assumptions', () => {
  const complete = createProductionBrief({ ownerText: 'Público: gestores. Oferta: guia. Tom: direto.', ingestedContextRef: 'transcript:asset-1' })
  assert.deepEqual(complete.assumptions, [])
  assert.equal(complete.ownerInput.trust, 'owner-authorized')
  assert.equal(complete.ingestedContext.trust, 'untrusted-media-derived')
  assert.equal('text' in complete.ingestedContext, false)
  const partial = createProductionBrief({ ownerText: 'Público: donos de clínica.' })
  assert.deepEqual(partial.assumptions, ['offer-not-specified', 'tone-not-specified'])
  const absent = createProductionBrief({})
  assert.equal(absent.summary.supplied, false)
  assert.ok(absent.assumptions.includes('briefing-absent'))
  assert.equal(absent.readyForExpensiveGeneration, false)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesiredAction, desiredActionConsumers, validateDesiredActionAlignment } from '../../src/v2/domain/desired-action.ts'

test('conversion action requires an explicit compatible destination and fans out canonically', () => {
  assert.throws(() => createDesiredAction({ objective: 'sale' }), /explicit destination/)
  assert.throws(() => createDesiredAction({ objective: 'sale', destination: 'http://checkout.test' }), /HTTPS/)
  const action = createDesiredAction({ objective: 'sale', destination: 'https://checkout.test/oferta', verbalCta: 'Compre agora', visualCta: 'Ver oferta', disclosures: ['Condições no site'] })
  const consumers = desiredActionConsumers(action)
  assert.strictEqual(consumers.storyPlan, consumers.critic)
  assert.equal(consumers.overlay.destination.value, 'https://checkout.test/oferta')
})

test('critic reports objective, spoken CTA and destination mismatches without inventing a fix', () => {
  const whatsapp = createDesiredAction({ objective: 'whatsapp', destination: '+5511999999999' })
  assert.deepEqual(validateDesiredActionAlignment({ objective: 'whatsapp', action: whatsapp, spokenCta: 'Clique para saber mais' }).issues, ['spoken-cta-mismatch'])
  assert.deepEqual(validateDesiredActionAlignment({ objective: 'sale', action: whatsapp }).issues, ['objective-action-mismatch'])
})

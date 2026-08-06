import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesiredAction, parseDesiredAction, validateDesiredActionAlignment } from '../../src/v2/domain/desired-action.ts'

test('conversion action requires an explicit compatible destination and canonicalizes owner inputs', () => {
  assert.throws(() => createDesiredAction({ objective: 'sale' }), /explicit destination/)
  assert.throws(() => createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'http://checkout.test' } } }), /HTTPS/)
  assert.throws(() => createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'handle', value: '@oferta' } } }), /destination type url/)
  const action = createDesiredAction({
    objective: 'sale',
    desiredAction: {
      destination: { type: 'url', value: ' https://checkout.test/oferta ' },
      verbalCta: ' Compre agora ', visualCta: ' Ver oferta ',
      disclosures: ['Condições no site'],
    },
  })
  assert.equal(action.destination.value, 'https://checkout.test/oferta')
  assert.equal(action.verbalCta, 'Compre agora')
  assert.ok(Object.isFrozen(action.destination))
  assert.ok(Object.isFrozen(action.disclosures))
  assert.deepEqual(parseDesiredAction(action, 'sale'), action)
})

test('critic reports objective, spoken CTA and destination mismatches without inventing a fix', () => {
  const whatsapp = createDesiredAction({ objective: 'whatsapp', desiredAction: { destination: { type: 'whatsapp', value: '+5511999999999' } } })
  assert.deepEqual(validateDesiredActionAlignment({ objective: 'whatsapp', action: whatsapp, spokenCta: 'Clique para saber mais' }).issues, ['spoken-cta-mismatch'])
  assert.deepEqual(validateDesiredActionAlignment({ objective: 'sale', action: whatsapp }).issues, ['objective-action-mismatch'])
})

test('destinations and disclosures fail closed by action type and bounded format', () => {
  assert.throws(() => createDesiredAction({ objective: 'whatsapp', desiredAction: { destination: { type: 'whatsapp', value: '11999999999' } } }), /E.164/)
  assert.throws(() => createDesiredAction({ objective: 'whatsapp', desiredAction: { destination: { type: 'whatsapp', value: 'https://evil.test/chat' } } }), /approved host/)
  assert.throws(() => createDesiredAction({ objective: 'booking', desiredAction: { destination: { type: 'calendar', value: 'https://user:secret@calendar.test/a' } } }), /embedded credentials/)
  assert.throws(() => createDesiredAction({ objective: 'download', desiredAction: { destination: { type: 'file', value: 'https://files.test/guide.pdf' }, disclosures: ['same', 'same'] } }), /unique/)
  const awareness = createDesiredAction({ objective: 'awareness', desiredAction: { destination: { type: 'handle', value: '@apollo.video' } } })
  assert.equal(awareness.destination.type, 'handle')
})

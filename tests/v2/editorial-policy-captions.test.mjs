import assert from 'node:assert/strict'
import test from 'node:test'
import { captionCuesThatDoNotFit, captionTextFitsEveryOutput } from '../../src/v2/domain/caption-fit.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { resolveEditorialPolicies } from '../../src/v2/domain/editorial-policy-resolution.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import { createOutputSpec } from '../../src/v2/domain/output-spec.ts'
import { ctaLexiconFor, observeSpokenCta } from '../../src/v2/domain/cta-lexicon.ts'

// ADR-160 F3: language and captions. Synthetic values only: no phrase of any real video.
const media = { transcriptId: 'transcript-1', transcriptLanguage: 'xx-YY', hasSelectedInsert: false }
const spec9x16 = createOutputSpec({ id: 'out-9x16', aspectRatio: '9:16', width: 1080, height: 1920, fps: 30, safeArea: { top: 0.08, right: 0.06, bottom: 0.06, left: 0.06 } })
const spec16x9 = createOutputSpec({ id: 'out-16x9', aspectRatio: '16:9', width: 1920, height: 1080, fps: 30, safeArea: { top: 0.055, right: 0.05, bottom: 0.06, left: 0.05 } })

test('the caption style is the request, else the project override, else the renderer baseline - and each says so', () => {
  const silent = createEditorialRequest({})
  const baseline = resolveEditorialPolicies(silent, media, [])
  assert.equal(baseline.policies.captions.origin, 'silence-rule')
  assert.equal(baseline.policies.captions.rule, 'renderer-baseline')
  assert.match(baseline.policies.captions.reason, /not a choice of the requester/)

  const project = resolveEditorialPolicies(silent, { ...media, subtitleStyleOverride: { presetId: 'kinetic', origin: 'project-custom' } }, [])
  assert.equal(project.policies.captions.value.presetId, 'kinetic')
  assert.equal(project.policies.captions.origin, 'request-field')
  assert.equal(project.policies.captions.rule, 'project-override')
  const workspace = resolveEditorialPolicies(silent, { ...media, subtitleStyleOverride: { presetId: 'caps-stroke', origin: 'workspace' } }, [])
  assert.equal(workspace.policies.captions.origin, 'workspace-policy')
  assert.equal(workspace.policies.captions.value.presetId, 'caps-stroke')

  const asked = createEditorialRequest({ directives: [{ id: 's', kind: 'caption-style', value: 'karaoke-pill' }] })
  const prevailing = resolveEditorialPolicies(asked, { ...media, subtitleStyleOverride: { presetId: 'kinetic', origin: 'project-custom' } }, [])
  assert.equal(prevailing.policies.captions.value.presetId, 'karaoke-pill')
  assert.equal(prevailing.policies.captions.rule, 'explicit-request')
  assert.equal(prevailing.blocked, false)
  assert.equal(resolveEditorialPolicies(silent, { ...media, subtitleStyleOverride: { presetId: 'nonsense', origin: 'workspace' } }, []).policies.captions.rule, 'renderer-baseline')
})

test('captions carry the grouping of the preset and no fixed width: capacity and cadence differ by preset', () => {
  const byPreset = (presetId) => resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 's', kind: 'caption-style', value: presetId }] }), media, []).policies.captions.value
  const kinetic = byPreset('kinetic')
  const pill = byPreset('karaoke-pill')
  assert.notDeepEqual(kinetic.grouping, pill.grouping)
  assert.equal(kinetic.grouping.maxWordsPerGroup, 2)
  assert.equal(pill.grouping.maxWordsPerGroup, 5)
  assert.equal(kinetic.capacityCharacters, 2 * 30)
  assert.equal(pill.capacityCharacters, 1 * 26)
  assert.equal(kinetic.maxLines, 2)
  assert.equal(pill.maxLines, 1)
})

test('captions are measured on each output that burns them: another output, another band', () => {
  const request = createEditorialRequest({})
  const outputs = [
    { variantId: 'v-portrait', spec: spec9x16, aspectRatio: '9:16', subtitleMode: 'burn-in' },
    { variantId: 'v-landscape', spec: spec16x9, aspectRatio: '16:9', subtitleMode: 'burn-in' },
    { variantId: 'v-sidecar', spec: spec16x9, aspectRatio: '16:9', subtitleMode: 'sidecar' },
    { variantId: 'v-none', spec: spec16x9, aspectRatio: '16:9', subtitleMode: 'none' },
    { variantId: 'v-unstated' },
  ]
  const { captions } = resolveEditorialPolicies(request, media, outputs).policies
  const byVariant = Object.fromEntries(captions.value.deliveries.map((delivery) => [delivery.variantId, delivery]))
  assert.equal(byVariant['v-portrait'].mode, 'burn-in')
  assert.equal(byVariant['v-sidecar'].fit, null)
  assert.equal(byVariant['v-none'].fit, null)
  assert.equal(byVariant['v-unstated'].mode, 'unspecified')
  const portrait = byVariant['v-portrait'].fit
  const landscape = byVariant['v-landscape'].fit
  assert.ok(portrait.bandWidthPx > 0 && landscape.bandWidthPx > 0 && portrait.fontPx > 0)
  assert.notEqual(portrait.bandWidthPx, landscape.bandWidthPx, 'the band is each output\'s own')
  assert.equal(resolveEditorialPolicies(request, media, outputs).policyResolutionHash, resolveEditorialPolicies(request, media, structuredClone(outputs)).policyResolutionHash)
  assert.notEqual(resolveEditorialPolicies(request, media, outputs.slice(0, 1)).policyResolutionHash, resolveEditorialPolicies(request, media, outputs).policyResolutionHash)
})

test('captionCuesThatDoNotFit measures against every burn-in output', () => {
  const geometries = resolveEditorialPolicies(createEditorialRequest({}), media, [
    { variantId: 'v-portrait', spec: spec9x16, subtitleMode: 'burn-in' }, { variantId: 'v-landscape', spec: spec16x9, subtitleMode: 'burn-in' },
  ]).policies.captions.value.deliveries.map((delivery) => delivery.fit)
  assert.deepEqual(captionCuesThatDoNotFit([{ id: 'c1', text: 'alpha beta' }], geometries), [])
  const refused = captionCuesThatDoNotFit([{ id: 'c1', text: 'alpha beta' }, { id: 'c2', text: 'w'.repeat(400) }], geometries)
  assert.deepEqual(refused.map((item) => item.cueId), ['c2'])
  assert.ok(captionTextFitsEveryOutput('alpha', geometries))
  assert.equal(captionTextFitsEveryOutput('w'.repeat(400), geometries), false)
  assert.equal(captionTextFitsEveryOutput('alpha', []), true, 'with no burn-in output there is nothing to measure against')
})

test('the spoken call to action is judged in the language of the speech; a language without a lexicon is a question, never a guess', () => {
  const destination = { type: 'url', value: 'https://example.com/x' }
  const sale = createEditorialRequest({ objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: { destination } }) })
  const portuguese = resolveEditorialPolicies(sale, { ...media, transcriptLanguage: 'pt-BR' }, [])
  assert.equal(portuguese.policies.cta.value.evaluation, 'lexicon')
  assert.equal(portuguese.blocked, false)
  const unknownLanguage = resolveEditorialPolicies(sale, { ...media, transcriptLanguage: 'xx-YY' }, [])
  assert.equal(unknownLanguage.policies.cta.value.evaluation, 'not-evaluable')
  assert.deepEqual(unknownLanguage.openQuestions.map((item) => item.id), ['cta-not-evaluable'])
  const withText = createEditorialRequest({ objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: { destination, verbalCta: 'phrase' } }) })
  const explicit = resolveEditorialPolicies(withText, { ...media, transcriptLanguage: 'xx-YY' }, [])
  assert.equal(explicit.policies.cta.value.evaluation, 'explicit-text')
  assert.equal(explicit.blocked, false)
  assert.equal(resolveEditorialPolicies(createEditorialRequest({}), media, []).policies.cta.value.evaluation, 'not-required')
})

test('the CTA lexicon recognises a call in the language it belongs to and says not-evaluable elsewhere', () => {
  const action = createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'https://example.com/x' } } })
  assert.equal(observeSpokenCta({ action, spokenText: 'Compre agora', language: 'pt-BR' }).state, 'present')
  assert.equal(observeSpokenCta({ action, spokenText: 'Buy it today', language: 'en-US' }).state, 'present')
  assert.equal(observeSpokenCta({ action, spokenText: 'Compra hoy', language: 'es' }).state, 'present')
  assert.equal(observeSpokenCta({ action, spokenText: 'nothing is asked here', language: 'en' }).state, 'absent')
  // the same words in the wrong language are not a call
  assert.equal(observeSpokenCta({ action, spokenText: 'Compre agora', language: 'en' }).state, 'absent')
  assert.deepEqual(observeSpokenCta({ action, spokenText: 'qualquer', language: 'xx' }), { state: 'not-evaluable', reason: 'no-lexicon-for-language', language: 'xx' })
  assert.equal(observeSpokenCta({ action, spokenText: 'qualquer' }).state, 'not-evaluable')
  assert.equal(ctaLexiconFor('xx'), null)
  const withText = createDesiredAction({ objective: 'sale', desiredAction: { destination: { type: 'url', value: 'https://example.com/x' }, verbalCta: 'phrase' } })
  assert.equal(observeSpokenCta({ action: withText, spokenText: 'qualquer', language: 'xx' }).state, 'present')
  assert.equal(observeSpokenCta({ action: createDesiredAction({ objective: 'discovery' }), spokenText: '', language: 'xx' }).state, 'not-required')
})

// ADR-160 (validator note on F2): the resolution module is exempt from the literal scan, so the values the planner still carries are NOT in its
// baseline. They are listed HERE, by policy key, and the list can only shrink. When it is empty the rule `carried-planner-value` is deleted.
const CARRIED_DEBT = Object.freeze(['opening', 'structure', 'ctaOverlay'])

test('no policy carries a planner value that is not listed as debt, and the debt can only shrink', () => {
  const destination = { type: 'url', value: 'https://example.com/x' }
  const requests = [
    createEditorialRequest({}),
    createEditorialRequest({ objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: { destination, visualCta: 'label', verbalCta: 'phrase' } }) }),
    createEditorialRequest({ directives: [{ id: 'o', kind: 'opening', value: 'none' }, { id: 's', kind: 'structure', value: 'source-order' }, { id: 'c', kind: 'cta', value: 'overlay-closing' }] }),
  ]
  const carried = new Set()
  for (const request of requests) {
    const { policies } = resolveEditorialPolicies(request, media, [{ variantId: 'v', spec: spec9x16, subtitleMode: 'burn-in' }])
    for (const [key, policy] of Object.entries(policies)) if (policy.rule === 'carried-planner-value' || /carried/i.test(policy.reason)) carried.add(key)
  }
  assert.deepEqual([...carried].sort(), [...CARRIED_DEBT].sort(), 'a carried value was fixed (shrink CARRIED_DEBT) or a new one appeared (never allowed)')
})

test('an override for one output of several is listed as unsupported by the shared plan, never ignored and never applied to all', () => {
  const request = createEditorialRequest({ variantOverrides: { 'v-a': [{ id: 'o1', kind: 'layout', value: 'fit-with-backdrop' }] } })
  const two = [{ variantId: 'v-a', spec: spec9x16, subtitleMode: 'none' }, { variantId: 'v-b', spec: spec16x9, subtitleMode: 'none' }]
  const shared = resolveEditorialPolicies(request, media, two)
  assert.equal(shared.blocked, true)
  assert.deepEqual(shared.unsupported.map((item) => [item.policyKey, item.source, item.reason]), [['layout', 'variant-override', 'not-executable']])
  assert.equal(shared.policies.layout.origin !== 'request-field', true, 'the override was not applied to the plan of both outputs')
  // with the one output the plan serves, the override is that output's own and is read
  const single = resolveEditorialPolicies(request, media, [two[0]])
  assert.equal(single.blocked, false)
  assert.equal(single.policies.layout.origin, 'request-field')
})

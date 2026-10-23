import assert from 'node:assert/strict'
import test from 'node:test'
import { captionCuesThatDoNotFit, captionFitGeometriesOfOutput, captionTextFitsEveryOutput, drawnCaptionCuesThatDoNotFit } from '../../src/v2/domain/caption-fit.ts'
import { createSubtitleSegmentOverride } from '../../src/v2/domain/subtitle-segment-override.ts'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import { EDITORIAL_POLICY_RULES, resolveEditorialPolicies } from '../../src/v2/domain/editorial-policy-resolution.ts'
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

// ADR-160 F6. The final measures again what it burns: a text exception inherited by a Version can lengthen a caption beyond the band the
// Director measured. Synthetic cues only.
const BURN_VARIANT = 'v-portrait'
const textException = (segmentId, range, text, variantId = BURN_VARIANT) => createSubtitleSegmentOverride({
  id: `override-${segmentId}-${variantId}`, workspaceId: 'workspace-x', projectId: 'project-x', baseVersionId: 'version-base', resultVersionId: `version-${segmentId}`,
  commandId: `command-${segmentId}`, variantId, segmentId, range, action: 'set', dimensions: [{ kind: 'text', text }], protected: false, previousOverrideId: null,
  createdAt: '2026-10-20T10:00:00.000Z',
})
const FINAL_CUES = [
  { id: 'cue-a', startFrame: 20, endFrame: 50, text: 'alpha beta' },
  { id: 'cue-b', startFrame: 100, endFrame: 130, text: 'gamma delta' },
]
const sealedDeliveries = () => resolveEditorialPolicies(createEditorialRequest({}), media, [
  { variantId: BURN_VARIANT, spec: spec9x16, subtitleMode: 'burn-in' },
  { variantId: 'v-landscape', spec: spec16x9, subtitleMode: 'burn-in' },
  { variantId: 'v-sidecar', spec: spec16x9, subtitleMode: 'sidecar' },
]).policies.captions.value.deliveries

test('the geometry a final is measured against is the own output; a sidecar output has none; an output the resolution does not name is measured against every burn-in output', () => {
  const deliveries = sealedDeliveries()
  const own = captionFitGeometriesOfOutput(deliveries, BURN_VARIANT)
  assert.deepEqual(own.map((geometry) => geometry.variantId), [BURN_VARIANT])
  assert.equal(own[0].aspectRatio, '9:16')
  assert.deepEqual(captionFitGeometriesOfOutput(deliveries, 'v-sidecar'), [], 'a sidecar output draws nothing: there is nothing to measure')
  assert.deepEqual(captionFitGeometriesOfOutput(deliveries, 'v-never-sealed').map((geometry) => geometry.variantId).sort(), ['v-landscape', BURN_VARIANT].sort(),
    'an output the resolution does not name is measured against every burn-in output, fail closed')
  assert.deepEqual(captionFitGeometriesOfOutput([], 'v-anything'), [], 'a resolution with no delivery has nothing to measure against')
  assert.deepEqual(captionFitGeometriesOfOutput([{ variantId: 'v-open', mode: 'unspecified', fit: null }, ...deliveries], 'v-open').length, 2,
    'a delivery whose mode was not stated cannot be trusted to draw nothing')
})

test('a text exception that makes a caption stop fitting the measured band is found; one that fits, an exception of another output, and a hidden one are not', () => {
  const geometries = captionFitGeometriesOfOutput(sealedDeliveries(), BURN_VARIANT)
  const tooLong = textException('cue-b', { startFrame: 100, endFrame: 130 }, 'palavra '.repeat(24).trim())
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [], variantId: BURN_VARIANT, geometries }), [], 'the cues of the plan fit (the Director measured them)')
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [tooLong], variantId: BURN_VARIANT, geometries }),
    [{ cueId: 'cue-b', variantId: BURN_VARIANT }])
  const shorter = textException('cue-b', { startFrame: 100, endFrame: 130 }, 'outra fala')
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [shorter], variantId: BURN_VARIANT, geometries }), [])
  // an exception of another output does not reach this one
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [textException('cue-b', { startFrame: 100, endFrame: 130 }, 'palavra '.repeat(24).trim(), 'v-landscape')], variantId: BURN_VARIANT, geometries }), [])
  // a range the plan no longer has is a recorded no-op, never a guess
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [textException('cue-b', { startFrame: 101, endFrame: 130 }, 'palavra '.repeat(24).trim())], variantId: BURN_VARIANT, geometries }), [])
  // no burn-in geometry: nothing is drawn, so nothing is refused
  assert.deepEqual(drawnCaptionCuesThatDoNotFit({ cues: FINAL_CUES, overrides: [tooLong], variantId: BURN_VARIANT, geometries: [] }), [])
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

// ADR-160 (validator note on F2): the resolution module is exempt from the literal scan, so a value the planner of the earlier waves still carried was NOT in
// its baseline. It was listed here, by policy key (opening, structure, captions, the CTA window), and could only shrink. It is empty: F3-F5 derived every one
// from the request, the media or the output, and the rule `carried-planner-value` no longer exists. This test keeps it so.
test('no policy of any request carries a value of the planner, and none names a rule that does not exist', () => {
  const destination = { type: 'url', value: 'https://example.com/x' }
  const requests = [
    createEditorialRequest({}),
    createEditorialRequest({ objective: 'sale', desiredAction: createDesiredAction({ objective: 'sale', desiredAction: { destination, visualCta: 'label', verbalCta: 'phrase' } }) }),
    createEditorialRequest({ directives: [{ id: 'o', kind: 'opening', value: 'none' }, { id: 's', kind: 'structure', value: 'source-order' }, { id: 'c', kind: 'cta', value: 'overlay-closing' }] }),
    createEditorialRequest({ directives: [{ id: 'l', kind: 'layout', value: 'source-native' }, { id: 'w', kind: 'opening', value: 'protect-seconds', param: 2 }] }),
  ]
  for (const request of requests) {
    const { policies } = resolveEditorialPolicies(request, { ...media, spokenCta: { startSeconds: 1, endSeconds: 2 }, timelineDurationSeconds: 5 }, [{ variantId: 'v', spec: spec9x16, subtitleMode: 'burn-in' }])
    for (const [key, policy] of Object.entries(policies)) {
      assert.ok(EDITORIAL_POLICY_RULES[policy.rule], `${key} names a catalogued rule`)
      assert.doesNotMatch(policy.reason, /carried|to be removed|scheduled/i, `${key} must not describe a carried value`)
    }
    // The values, not only the words: without a movement or an opening in the request the plan applies no motion and protects no window, and a window
    // exists only where the request gave its seconds (or the first sentence it named). None of these numbers is the planner's.
    const named = request.directives.find((directive) => directive.kind === 'opening')
    assert.deepEqual(policies.movement.value, { mode: 'none' })
    assert.equal(policies.movement.rule, request.directives.some((directive) => directive.kind === 'movement') ? 'explicit-request' : 'minimal-intervention')
    assert.deepEqual(policies.opening.value, named?.value === 'protect-seconds' ? { mode: 'protected-window', seconds: Number(named.param) } : { mode: 'not-applicable' })
    assert.equal(policies.opening.rule, named === undefined ? 'minimal-intervention' : 'explicit-request')
  }
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

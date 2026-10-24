import assert from 'node:assert/strict'
import test from 'node:test'
import { createDesiredAction } from '../../src/v2/domain/desired-action.ts'
import {
  compositionUnderPolicy, resolveEditorialPolicies, storyBlockUnderPolicy,
} from '../../src/v2/domain/editorial-policy-resolution.ts'
import { createEditorialRequest } from '../../src/v2/domain/editorial-request.ts'
import {
  createQualityReport, effectiveRubricCriteria, OPTIONAL_RUBRIC_CRITERIA, parseStrategicQualityReport, resolveStrategicRubric, STRATEGIC_RUBRICS,
} from '../../src/v2/domain/strategic-rubric.ts'

// ADR-160 F5: structure, CTA, layout, rubric and budgets. Synthetic values only.
const media = { transcriptId: 'transcript-1', transcriptLanguage: 'xx-YY', hasSelectedInsert: false }
const destination = { type: 'url', value: 'https://example.com/x' }
const sale = (extra = {}) => createDesiredAction({ objective: 'sale', desiredAction: { destination, ...extra } })

test('without a structure request the clips keep the source order and no block has a role by position', () => {
  const { policies } = resolveEditorialPolicies(createEditorialRequest({}), media, [])
  assert.deepEqual(policies.structure.value, { order: 'source-order', roles: 'none' })
  assert.equal(policies.structure.origin, 'silence-rule')
  assert.equal(policies.structure.rule, 'minimal-intervention')
  const shapes = [0, 1, 2, 3].map(() => storyBlockUnderPolicy(policies.structure, { isCta: false, actionKind: 'buy' }))
  for (const shape of shapes) assert.deepEqual({ ...shape }, { actId: 'sequence', role: 'segment', intent: 'retain-source-segment' })
  // only the block where the call is spoken is a call to action
  assert.equal(storyBlockUnderPolicy(policies.structure, { isCta: true, actionKind: 'buy' }).role, 'cta')
  // a request for another order is understood and not executable: it blocks, it is not ignored
  const hookFirst = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 's', kind: 'structure', value: 'hook-first' }] }), media, [])
  assert.equal(hookFirst.blocked, true)
  assert.equal(hookFirst.policies.structure.status, 'unsupported')
  const asked = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 's', kind: 'structure', value: 'source-order' }] }), media, [])
  assert.equal(asked.policies.structure.origin, 'request-field')
  assert.deepEqual(asked.policies.structure.value, { order: 'source-order', roles: 'none' })
})

test('the CTA is required only when the objective asks for an action, and the request cannot say the opposite in silence', () => {
  const none = resolveEditorialPolicies(createEditorialRequest({}), media, [])
  assert.equal(none.policies.cta.value.required, false)
  const awareness = createEditorialRequest({ objective: 'awareness', desiredAction: createDesiredAction({ objective: 'awareness' }) })
  assert.equal(resolveEditorialPolicies(awareness, media, []).policies.cta.value.required, false)
  const buy = createEditorialRequest({ objective: 'sale', desiredAction: sale() })
  assert.equal(resolveEditorialPolicies(buy, { ...media, transcriptLanguage: 'pt' }, []).policies.cta.value.required, true)
  // the objective asks for the action and the request asks for none: a question
  const contradictory = createEditorialRequest({ objective: 'sale', desiredAction: sale(), directives: [{ id: 'c', kind: 'cta', value: 'none' }] })
  const resolved = resolveEditorialPolicies(contradictory, { ...media, transcriptLanguage: 'pt' }, [])
  assert.deepEqual(resolved.openQuestions.map((item) => item.id), ['cta-conflicts-with-action'])
})

test('the visual call follows the request or where the speech says the call - and has no fixed window', () => {
  const spoken = { startSeconds: 3, endSeconds: 5.5 }
  const withText = createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }) })
  const at = resolveEditorialPolicies(withText, { ...media, transcriptLanguage: 'pt', spokenCta: spoken, timelineDurationSeconds: 12 }, [])
  assert.deepEqual(at.policies.ctaOverlay.value, { mode: 'window', startSeconds: 3, endSeconds: 5.5, anchoredTo: 'spoken-cta' })
  const closing = createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }), directives: [{ id: 'c', kind: 'cta', value: 'overlay-closing' }] })
  const toEnd = resolveEditorialPolicies(closing, { ...media, transcriptLanguage: 'pt', spokenCta: spoken, timelineDurationSeconds: 12 }, [])
  assert.deepEqual(toEnd.policies.ctaOverlay.value, { mode: 'window', startSeconds: 3, endSeconds: 12, anchoredTo: 'spoken-cta-to-end' })
  assert.equal(toEnd.policies.ctaOverlay.origin, 'request-field')
  // different calls, different windows
  assert.notEqual(at.policyResolutionHash, toEnd.policyResolutionHash)
  // a request that says closing, over a speech with no call: the closing of the video is the last sentence of the speech, from there to the end
  const closingOnly = resolveEditorialPolicies(closing, { ...media, transcriptLanguage: 'xx', closingSentenceStartSeconds: 9.5, timelineDurationSeconds: 12 }, [])
  assert.deepEqual(closingOnly.policies.ctaOverlay.value, { mode: 'window', startSeconds: 9.5, endSeconds: 12, anchoredTo: 'closing-sentence' })
  assert.match(closingOnly.policies.ctaOverlay.reason, /last sentence/)
  // ... but a request that says only "at the spoken call" still needs the call
  const atOnly = createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }), directives: [{ id: 'c', kind: 'cta', value: 'overlay-at-spoken-cta' }] })
  assert.deepEqual(resolveEditorialPolicies(atOnly, { ...media, transcriptLanguage: 'pt', closingSentenceStartSeconds: 9.5, timelineDurationSeconds: 12 }, []).openQuestions.map((item) => item.id), ['cta-overlay-placement-unknown'])
  // the speech shows no call: there is nowhere to draw it from
  const nowhere = resolveEditorialPolicies(withText, { ...media, transcriptLanguage: 'pt' }, [])
  assert.deepEqual(nowhere.openQuestions.map((item) => item.id), ['cta-overlay-placement-unknown'])
  assert.deepEqual(nowhere.policies.ctaOverlay.value, { mode: 'none' })
  // no text to draw
  const textless = createEditorialRequest({ objective: 'sale', desiredAction: sale(), directives: [{ id: 'c', kind: 'cta', value: 'overlay-at-spoken-cta' }] })
  assert.deepEqual(resolveEditorialPolicies(textless, { ...media, transcriptLanguage: 'pt', spokenCta: spoken }, []).openQuestions.map((item) => item.id), ['cta-overlay-text-missing'])
  // verbal only: the text of the desired action is not drawn, and the policy says so
  const verbal = createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }), directives: [{ id: 'c', kind: 'cta', value: 'verbal-only' }] })
  const drawn = resolveEditorialPolicies(verbal, { ...media, transcriptLanguage: 'pt', spokenCta: spoken }, [])
  assert.deepEqual(drawn.policies.ctaOverlay.value, { mode: 'none' })
  assert.match(drawn.policies.ctaOverlay.reason, /not drawn/)
})

test('layout: the source as it is where it has the frame shape of every output; otherwise the request decides and silence keeps the whole frame', () => {
  const output = (aspectRatio, variantId = `v-${aspectRatio}`) => ({ variantId, id: `out-${variantId}`, aspectRatio })
  const silent = createEditorialRequest({})
  const same = resolveEditorialPolicies(silent, { ...media, sourceAspectRatio: '1920:1080' }, [output('16:9')])
  assert.deepEqual(same.policies.layout.value, { mode: 'source-native' })
  assert.equal(same.policies.layout.origin, 'output-spec')
  assert.equal(compositionUnderPolicy(same.policies.layout).layout, 'source-native')
  assert.equal(compositionUnderPolicy(same.policies.layout).background, 'none')
  // one output of another shape is enough to keep the whole frame over a backdrop
  const mixed = resolveEditorialPolicies(silent, { ...media, sourceAspectRatio: '16:9' }, [output('16:9'), output('9:16')])
  assert.deepEqual(mixed.policies.layout.value, { mode: 'fit-with-backdrop' })
  assert.equal(mixed.policies.layout.rule, 'minimal-intervention')
  assert.match(mixed.policies.layout.reason, /9:16/)
  assert.equal(compositionUnderPolicy(mixed.policies.layout).layout, 'landscape-inset')
  assert.equal(compositionUnderPolicy(mixed.policies.layout).background, 'blurred-source')
  // the request decides when the shapes differ
  const fit = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'l', kind: 'layout', value: 'fit-with-backdrop' }] }), { ...media, sourceAspectRatio: '16:9' }, [output('9:16')])
  assert.equal(fit.policies.layout.origin, 'request-field')
  assert.equal(fit.blocked, false)
  // the fill that follows the face is the reframe trajectory the Apollo already has: it is applied, per output, and nothing blocks
  const fill = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'l', kind: 'layout', value: 'fill-crop' }] }), { ...media, sourceAspectRatio: '16:9' }, [output('9:16')])
  assert.equal(fill.policies.layout.status, 'applied')
  assert.deepEqual(fill.policies.layout.value.perOutput.map((entry) => entry.mode), ['fill-following-face'])
  assert.equal(fill.blocked, false)
  // source-native asked for a source that does not have the shape: a question
  const native = resolveEditorialPolicies(createEditorialRequest({ directives: [{ id: 'l', kind: 'layout', value: 'source-native' }] }), { ...media, sourceAspectRatio: '16:9' }, [output('9:16')])
  assert.deepEqual(native.openQuestions.map((item) => item.id), ['layout-source-native-mismatch'])
  // the layout of a plan whose policy is not executable is refused
  assert.throws(() => compositionUnderPolicy({ ...fill.policies.layout, status: 'unsupported' }), (error) => error.code === 'PRECONDITION_REQUIRED')
})

test('budgets and the rubric come from the resolution: nothing is added that was not asked for', () => {
  const buy = createEditorialRequest({ objective: 'sale', desiredAction: sale() })
  const { policies } = resolveEditorialPolicies(buy, { ...media, transcriptLanguage: 'pt', selectedInsertCount: 2 }, [])
  assert.deepEqual({ ...policies.budget.value }, { maxPatternBreaksPer30s: 0, allowedEffects: [], maxProofItems: 2, maxCtaOccurrences: 1 })
  assert.deepEqual([...policies.rubric.value.notRequested], ['hook-clarity'])
  const silent = resolveEditorialPolicies(createEditorialRequest({}), media, []).policies
  assert.deepEqual({ ...silent.budget.value }, { maxPatternBreaksPer30s: 0, allowedEffects: [], maxProofItems: 0, maxCtaOccurrences: 0 })
  assert.deepEqual([...silent.rubric.value.notRequested], ['hook-clarity', 'cta-clarity', 'friction-reduction'])
  assert.notEqual(policies.budget.reason, silent.budget.reason)
})

test('the strategic rubric scores only what was requested; weights are renormalized and the report parses back', () => {
  assert.ok(OPTIONAL_RUBRIC_CRITERIA.includes('hook-clarity') && !OPTIONAL_RUBRIC_CRITERIA.includes('rights-compliance'))
  for (const rubric of STRATEGIC_RUBRICS) {
    for (const notRequested of [[], ['hook-clarity'], ['hook-clarity', 'cta-clarity', 'friction-reduction']]) {
      const criteria = effectiveRubricCriteria(rubric, notRequested)
      const kept = rubric.criteria.filter((criterion) => !notRequested.includes(criterion.id))
      assert.deepEqual(criteria.map((criterion) => criterion.id), kept.map((criterion) => criterion.id), `${rubric.objective} keeps what is requested`)
      assert.ok(Math.abs(criteria.reduce((sum, criterion) => sum + criterion.weight, 0) - 1) < 1e-9, `${rubric.objective} weights sum to one`)
      assert.ok(criteria.length >= 5, `${rubric.objective} keeps at least five criteria`)
      // proportions between the criteria that stay do not change
      if (criteria.length > 1) assert.ok(Math.abs(criteria[0].weight / criteria[1].weight - kept[0].weight / kept[1].weight) < 1e-9)
    }
  }
  assert.throws(() => effectiveRubricCriteria(resolveStrategicRubric('sale'), ['rights-compliance']), (error) => error.code === 'INVALID_ARGUMENT')
  const rubric = resolveStrategicRubric('discovery')
  const notRequested = ['hook-clarity', 'cta-clarity', 'friction-reduction']
  const evidence = effectiveRubricCriteria(rubric, notRequested).map((criterion) => ({ criterionId: criterion.id, score: 90, evidence: [`proof:${criterion.id}`] }))
  const report = createQualityReport({
    objective: 'discovery', evidence, notRequested, gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt: '2026-01-01T00:00:00.000Z',
  })
  assert.equal(report.evidence.length, 5)
  assert.equal(report.score, 90)
  assert.deepEqual(parseStrategicQualityReport(JSON.parse(JSON.stringify(report))), report)
  // a report that left out a criterion that cannot be left out is refused on read
  const forged = JSON.parse(JSON.stringify(report))
  forged.evidence = forged.evidence.filter((item) => item.criterionId !== 'rights-compliance')
  assert.throws(() => parseStrategicQualityReport(forged), (error) => error.code === 'PERSISTENCE_CONFLICT')
  // missing evidence for a requested criterion is refused at creation
  assert.throws(() => createQualityReport({
    objective: 'discovery', evidence: evidence.slice(1), notRequested, gates: { narrativeIntegrity: true, legibility: true, rights: true }, evaluatedAt: '2026-01-01T00:00:00.000Z',
  }), (error) => error.code === 'INVALID_ARGUMENT')
})

test('a plan is judged on its call to action: drawn exactly when the resolution says so, wherever its timeline puts it', async () => {
  const { assertPlanHonorsResolution } = await import('../../src/v2/domain/editorial-policy-resolution.ts')
  const drawn = createEditorialRequest({
    objective: 'sale',
    desiredAction: sale({ visualCta: 'label', verbalCta: 'phrase' }),
    directives: [{ id: 'c', kind: 'cta', value: 'overlay-closing' }],
  })
  const withCall = resolveEditorialPolicies(drawn, { ...media, closingSentenceStartSeconds: 4, timelineDurationSeconds: 5 }, [])
  assert.equal(withCall.policies.ctaOverlay.value.mode, 'window')
  const none = resolveEditorialPolicies(createEditorialRequest({}), media, [])
  assert.equal(none.policies.ctaOverlay.value.mode, 'none')
  const plan = (overlayTracks) => ({ fps: 30, movementPolicy: { automaticZoom: false, protectedOpeningFrames: 0 }, effectTracks: [], overlayTracks })
  assertPlanHonorsResolution(plan([{ kind: 'cta' }]), withCall)
  assertPlanHonorsResolution(plan([]), none)
  assert.throws(() => assertPlanHonorsResolution(plan([]), withCall), /call to action/)
  assert.throws(() => assertPlanHonorsResolution(plan([{ kind: 'cta' }]), none), /call to action/)
  // a plan that states no overlay list says nothing about it
  assertPlanHonorsResolution({ fps: 30, movementPolicy: { automaticZoom: false, protectedOpeningFrames: 0 } }, none)
})

test('a speech with no call to say where the visual call goes is a question the structured placement answers', () => {
  const withText = createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }) })
  const speech = { ...media, transcriptLanguage: 'pt', timelineDurationSeconds: 12 }
  assert.deepEqual(resolveEditorialPolicies(withText, speech, []).openQuestions.map((item) => item.id), ['cta-overlay-placement-unknown'])
  const placed = (value, param) => createEditorialRequest({ objective: 'sale', desiredAction: sale({ visualCta: 'label' }), directives: [{ id: 'c', kind: 'cta', value, ...(param !== undefined ? { param } : {}) }] })
  const from = resolveEditorialPolicies(placed('overlay-from-seconds', 8), speech, [])
  assert.deepEqual(from.openQuestions, [])
  assert.deepEqual(from.policies.ctaOverlay.value, { mode: 'window', startSeconds: 8, endSeconds: 12, anchoredTo: 'requested-seconds' })
  assert.equal(from.policies.ctaOverlay.origin, 'request-field')
  assert.equal(from.policies.ctaOverlay.rule, 'explicit-request')
  const whole = resolveEditorialPolicies(placed('overlay-whole-video'), speech, [])
  assert.deepEqual(whole.policies.ctaOverlay.value, { mode: 'window', startSeconds: 0, endSeconds: 12, anchoredTo: 'whole-video' })
  assert.equal(whole.blocked, false)
  // the second is the requester's: past the end of the video, or a video of unknown length, is a question and not a guess
  assert.deepEqual(resolveEditorialPolicies(placed('overlay-from-seconds', 20), speech, []).openQuestions.map((item) => item.id), ['cta-overlay-after-end'])
  assert.deepEqual(resolveEditorialPolicies(placed('overlay-from-seconds', 8), { ...speech, timelineDurationSeconds: undefined }, []).openQuestions.map((item) => item.id), ['cta-overlay-timeline-unknown'])
  // the parameter is part of the vocabulary: a placement without its second, or a second on a value that takes none, is not a directive
  assert.throws(() => placed('overlay-from-seconds'), /needs seconds/)
  assert.throws(() => placed('overlay-whole-video', 4), /takes no parameter/)
  // the structured placement still needs the text to draw
  const textless = createEditorialRequest({ objective: 'sale', desiredAction: sale(), directives: [{ id: 'c', kind: 'cta', value: 'overlay-whole-video' }] })
  assert.deepEqual(resolveEditorialPolicies(textless, speech, []).openQuestions.map((item) => item.id), ['cta-overlay-text-missing'])
})

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  createEditorialRequest,
  EDITORIAL_EXECUTABLE_VALUES,
  type EditorialDirective,
  type EditorialDirectiveKind,
  type EditorialRequestV1,
  type BriefExcerpt,
} from './editorial-request.ts'
import { captionFitGeometryFor, type CaptionDeliveryMode, type CaptionFitGeometry } from './caption-fit.ts'
import { ctaLexiconFor } from './cta-lexicon.ts'
import type { OutputSpec } from './output-spec.ts'
import type { RubricCriterionId } from './strategic-rubric.ts'
import { readSubtitlePreset } from './subtitle-system.ts'
import { SUBTITLE_PRESET_IDS, type SubtitlePresetId } from './subtitle-style-tokens.ts'

/**
 * Editorial policy resolution (ADR-160, docs/specs/01 s7.4.3). `resolveEditorialPolicies` turns an editorial request, the observed media
 * and the output into the policies the Director plans with. It is a pure function: the same inputs always give the same resolution and
 * the same hash. Every policy says where it comes from (`origin`), by which named rule (`rule`), why (`reason`, in a sentence that only
 * claims what its origin supports) and on what (`evidenceRefs`).
 *
 * This is the one module of the product allowed to name an editorial value (tests/v2/editorial-literals.test.mjs exempts it). A value
 * that is named here is here under a named rule, and each rule is tested in tests/v2/editorial-policy-resolution.test.mjs.
 */
// v2 (ADR-160 F3-F5): the caption policy is derived from the preset and the measured width of each output (no fixed block width), the CTA
// policy states how the spoken call is judged, and the opening, structure, layout and budgets are derived from the request. A v1 resolution
// stays readable in its snapshot and is never admitted to final export (see `MINIMUM_ADMITTED_APOLLO_DIRECTOR_CRITIC_VERSION`).
export const EDITORIAL_POLICY_RESOLUTION_SCHEMA = 'editorial-policy-resolution/v2' as const
export const EDITORIAL_POLICY_RESOLVER_VERSION = 'editorial-policy-resolver/v2' as const
/** The `contentSchemaVersion` of the `policy-resolution` snapshot that holds a resolution of this schema. */
export const POLICY_RESOLUTION_SNAPSHOT_SCHEMA_VERSION = 2 as const

export const POLICY_ORIGINS = Object.freeze([
  'request-field', 'request-briefing', 'media-context', 'output-spec', 'workspace-policy', 'silence-rule',
] as const)
export type PolicyOrigin = (typeof POLICY_ORIGINS)[number]

/**
 * The named rules. `minimal-intervention` is the owner's "does not invent" rule: where the request is silent, nothing is added that was
 * not asked for and not observed in the source. (F2 had a third silence rule, `carried-planner-value`, for values the planner of the earlier waves
 * still applied; every one was derived from the request in F3-F5 and the rule no longer exists - a stored resolution that names it is refused.)
 */
export const EDITORIAL_POLICY_RULES = Object.freeze({
  'explicit-request': Object.freeze({ origins: Object.freeze(['request-field', 'request-briefing'] as const), summary: 'The requester said it, in a structured field or in the briefing.' }),
  'desired-action': Object.freeze({ origins: Object.freeze(['request-field'] as const), summary: 'The objective and desired action of the project, which the requester must give, decide it.' }),
  'source-observation': Object.freeze({ origins: Object.freeze(['media-context'] as const), summary: 'The media shows it (the transcript, the compiled timeline).' }),
  'output-geometry': Object.freeze({ origins: Object.freeze(['output-spec'] as const), summary: 'The output specification and the source geometry decide it.' }),
  'minimal-intervention': Object.freeze({ origins: Object.freeze(['silence-rule'] as const), summary: 'The request is silent: nothing is added that was not asked for and not observed in the source.' }),
  'project-override': Object.freeze({ origins: Object.freeze(['request-field', 'workspace-policy'] as const), summary: 'A project override (or, failing it, the workspace Guardrail it inherits) fixed it.' }),
  'renderer-baseline': Object.freeze({ origins: Object.freeze(['silence-rule'] as const), summary: 'Nothing named it and the output cannot be drawn without one: the baseline of the renderer registry is used, which is not an editorial preference.' }),
} as const)
export type PolicyRuleId = keyof typeof EDITORIAL_POLICY_RULES

export const POLICY_KEYS = Object.freeze([
  'movement', 'opening', 'structure', 'transitions', 'inserts', 'cta', 'ctaOverlay', 'layout', 'language', 'captions', 'speechRemovals', 'budget', 'rubric',
] as const)
export type PolicyKey = (typeof POLICY_KEYS)[number]

export interface ResolvedPolicy<V> {
  key: PolicyKey
  /** `applied`: the planner applies `value`. `unsupported`: the request asked for something the Apollo cannot execute; `value` is what would apply were the request waived, and it is NEVER applied (the resolution is blocked). */
  status: 'applied' | 'unsupported'
  value: Readonly<V>
  origin: PolicyOrigin
  rule: PolicyRuleId
  reason: string
  evidenceRefs: readonly string[]
}

export interface EditorialPolicies {
  movement: ResolvedPolicy<{ mode: 'none' }>
  opening: ResolvedPolicy<{ mode: 'protected-window'; seconds: number } | { mode: 'not-applicable' }>
  structure: ResolvedPolicy<{ order: 'source-order'; roles: 'none' }>
  transitions: ResolvedPolicy<{ type: 'straight-cut'; audioFadeMs: number }>
  inserts: ResolvedPolicy<{ mode: 'use-selected-insert' | 'no-insert' }>
  cta: ResolvedPolicy<{ required: boolean; evaluation: CtaEvaluation }>
  ctaOverlay: ResolvedPolicy<{ mode: 'none' } | { mode: 'window'; startSeconds: number; endSeconds: number; anchoredTo: 'spoken-cta' | 'spoken-cta-to-end' | 'closing-sentence' }>
  layout: ResolvedPolicy<{ mode: 'fit-with-backdrop' | 'source-native' }>
  language: ResolvedPolicy<{ captionLanguage: string | null }>
  captions: ResolvedPolicy<CaptionPolicyValue>
  speechRemovals: ResolvedPolicy<{ ruleIds: readonly string[] }>
  budget: ResolvedPolicy<EditorialBudgetValue>
  rubric: ResolvedPolicy<{ notRequested: readonly RubricCriterionId[] }>
}

/** What the plan is allowed to add, derived from the policies: nothing the request did not ask for, and what the timeline already holds. */
export interface EditorialBudgetValue {
  maxPatternBreaksPer30s: number
  allowedEffects: readonly string[]
  maxProofItems: number
  maxCtaOccurrences: number
}

/** How the spoken call to action is judged: not at all (none required), by the explicit text the requester gave, by the lexicon of the language, or it cannot be. */
export type CtaEvaluation = 'not-required' | 'explicit-text' | 'lexicon' | 'not-evaluable'

/**
 * The caption policy. Nothing in it is a number the planner carries: the grouping is the preset's, the capacity is the preset's lines
 * times its characters per line, and the width a cue may take is each burn-in output's own, measured (`caption-fit.ts`).
 */
export interface CaptionPolicyValue {
  presetId: SubtitlePresetId
  maxLines: number
  anchor: 'bottom'
  /** Words per cue and time on screen, from the preset's `grouping`; a silence longer than `silenceBreakMs` (the preset's minimum time on screen) ends a cue. */
  grouping: Readonly<{ maxWordsPerGroup: number; maxOnScreenMs: number; silenceBreakMs: number }>
  /** The characters a cue may hold: the preset's `maxLines` times its `lineBreaking.maxCharacters`. */
  capacityCharacters: number
  /** One entry per output the resolution knew: how captions are delivered there and, for a burned output, the geometry the cue must fit. */
  deliveries: readonly Readonly<{ variantId: string; mode: CaptionDeliveryMode | 'unspecified'; fit: Readonly<CaptionFitGeometry> | null }>[]
}

export interface UnsupportedRequestItem {
  /** Where it came from: a policy key, or 'interpretation' for what the interpreter itself could not map. */
  policyKey: PolicyKey | 'interpretation'
  directiveId: string
  kind: EditorialDirectiveKind | 'unmapped'
  value: string
  source: 'variant-override' | 'request-field' | 'request-briefing'
  reason: 'not-executable' | 'outside-vocabulary'
  summary: string
}

export interface OpenQuestion {
  id: string
  question: string
  source: 'interpretation' | 'resolution'
}

export interface EditorialPolicyResolutionV1 {
  schemaVersion: typeof EDITORIAL_POLICY_RESOLUTION_SCHEMA
  resolverVersion: typeof EDITORIAL_POLICY_RESOLVER_VERSION
  /** The request this resolution was made for. */
  requestHash: string
  policies: Readonly<EditorialPolicies>
  unsupported: readonly Readonly<UnsupportedRequestItem>[]
  openQuestions: readonly Readonly<OpenQuestion>[]
  /** True when the request asks for something the Apollo cannot execute or leaves a question open: no plan may be made from it. */
  blocked: boolean
  /** SHA-256 of the canonical resolution without this field. */
  policyResolutionHash: string
}

/** What the observed media contributes. Nothing here is a preference: it is what the source shows. */
export interface EditorialMediaContext {
  transcriptId?: string
  /** BCP-47 language of the observed transcript (absent: unknown). */
  transcriptLanguage?: string
  /** True when the compiled timeline already contains a rights-approved selected insert. */
  hasSelectedInsert: boolean
  /** Source frame aspect, `W:H` (absent: unknown). */
  sourceAspectRatio?: string
  /** Seconds, on the timeline, at which the first sentence of the speech ends (absent: the speech shows none). */
  firstSentenceEndSeconds?: number
  /** Seconds, on the timeline, where the call to action is spoken (its last occurrence): absent when the speech has none or it cannot be recognised. */
  spokenCta?: Readonly<{ startSeconds: number; endSeconds: number }>
  /** Seconds, on the timeline, where the last sentence of the speech begins (absent: no word). */
  closingSentenceStartSeconds?: number
  /** Seconds of the compiled timeline. */
  timelineDurationSeconds?: number
  /** Rights-approved selected inserts the compiled timeline already holds (the proofs it shows). */
  selectedInsertCount?: number
  /**
   * The caption style a project override (or the workspace Guardrail it inherits) fixed, as the policy snapshot resolved it. `project-none`
   * and an inherited nothing are absent here: they name no style.
   */
  subtitleStyleOverride?: Readonly<{ presetId: string; origin: 'workspace' | 'project-custom' }>
}

/** What the output imposes. */
export interface EditorialOutputSpec {
  id?: string
  variantId?: string
  /** Output frame aspect, `W:H` (absent: unknown). */
  aspectRatio?: string
  /** The sealed OutputSpec: with it and a burn-in `subtitleMode`, captions are measured against this output's own band. */
  spec?: Readonly<OutputSpec>
  /** How captions are delivered on this output (the delivery profile's subtitle mode); absent: not stated. */
  subtitleMode?: CaptionDeliveryMode
}

// The caption style the renderer registry designates for an output that must draw captions when nothing else names one (rule `renderer-baseline`).
export const RENDERER_BASELINE_CAPTION_PRESET: SubtitlePresetId = 'clean-color'
// Not editorial: a click guard at an audio seam.
const AUDIO_SEAM_FADE_MS = 24

type Selection = Readonly<{
  directive: Readonly<EditorialDirective>
  source: UnsupportedRequestItem['source']
  excerpt?: Readonly<BriefExcerpt>
  variantId?: string
  /** A briefing directive of the same kind that the selected (structured) one superseded. */
  supersededBriefing?: Readonly<EditorialDirective>
}>

const requestRef = (request: Readonly<EditorialRequestV1>): string => `request:${request.requestHash}`
const truncate = (text: string, max = 140): string => text.length <= max ? text : `${text.slice(0, max - 1)}…`
const sentence = (text: string): string => /[.!?]$/.test(text) ? text : `${text}.`
const describe = (directive: Readonly<EditorialDirective>): string => `${directive.kind} ${directive.value}${directive.param !== undefined ? ` ${String(directive.param)}` : ''}`

function select(request: Readonly<EditorialRequestV1>, outputSpec: Readonly<EditorialOutputSpec>, kind: EditorialDirectiveKind): Selection | undefined {
  const briefed = request.interpretation?.directives.find((directive) => directive.kind === kind)
  const variantList = outputSpec.variantId !== undefined ? request.variantOverrides[outputSpec.variantId] : undefined
  const overridden = variantList?.find((directive) => directive.kind === kind)
  const structured = request.directives.find((directive) => directive.kind === kind)
  const field = overridden ?? structured
  if (field !== undefined) {
    const superseded = briefed !== undefined && (briefed.value !== field.value || briefed.param !== field.param) ? briefed : undefined
    return Object.freeze({
      directive: field, source: overridden !== undefined ? 'variant-override' as const : 'request-field' as const,
      ...(overridden !== undefined ? { variantId: outputSpec.variantId! } : {}),
      ...(superseded ? { supersededBriefing: superseded } : {}),
    })
  }
  if (briefed !== undefined) return Object.freeze({ directive: briefed, source: 'request-briefing' as const, excerpt: briefed.excerpt })
  return undefined
}

/** The sentence that attributes a policy to the request: it quotes only what the request contains. */
function attribution(selection: Selection): string {
  const { directive } = selection
  const superseded = selection.supersededBriefing
    ? ` The briefing also read as ${describe(selection.supersededBriefing)}; the structured field prevails.`
    : ''
  if (selection.source === 'request-briefing') return `Requested in the briefing: "${truncate(selection.excerpt!.text)}" (read as ${describe(directive)}).`
  if (selection.source === 'variant-override') return `Requested for output variant ${selection.variantId} as a structured field (${describe(directive)}).${superseded}`
  return `Requested as a structured field of the editorial request (${describe(directive)}).${superseded}`
}

const originOf = (selection: Selection): PolicyOrigin => selection.source === 'request-briefing' ? 'request-briefing' : 'request-field'

function evidenceOf(request: Readonly<EditorialRequestV1>, selection: Selection | undefined, ...extra: string[]): readonly string[] {
  return Object.freeze([requestRef(request), ...(selection ? [`directive:${selection.directive.id}`,
    ...(selection.excerpt ? [`briefing:${selection.excerpt.start}-${selection.excerpt.end}`] : [])] : []), ...extra])
}

/** A policy where the request is silent: the rule is named, and the reason says what was decided and why. */
function silent<V>(request: Readonly<EditorialRequestV1>, key: PolicyKey, value: V, rule: 'minimal-intervention' | 'renderer-baseline', reason: string, ...extra: string[]): ResolvedPolicy<V> {
  return Object.freeze({ key, status: 'applied' as const, value: Object.freeze(value) as Readonly<V>, origin: 'silence-rule' as const, rule, reason, evidenceRefs: evidenceOf(request, undefined, ...extra) })
}

interface Builder {
  unsupported: UnsupportedRequestItem[]
}

/** A policy the request names. When its value is not executable the policy is `unsupported`, the item is recorded, and the plan is blocked. */
function requested<V>(request: Readonly<EditorialRequestV1>, builder: Builder, key: PolicyKey, selection: Selection, executableValue: V, effect: string, fallback: V, ...extra: string[]): ResolvedPolicy<V> {
  const executable = EDITORIAL_EXECUTABLE_VALUES[selection.directive.kind].includes(selection.directive.value)
  if (executable) {
    return Object.freeze({
      key, status: 'applied' as const, value: Object.freeze(executableValue) as Readonly<V>, origin: originOf(selection), rule: 'explicit-request' as const,
      reason: `${attribution(selection)} ${sentence(effect)}`, evidenceRefs: evidenceOf(request, selection, ...extra),
    })
  }
  builder.unsupported.push(Object.freeze({
    policyKey: key, directiveId: selection.directive.id, kind: selection.directive.kind, value: describe(selection.directive), source: selection.source,
    reason: 'not-executable' as const, summary: `This Apollo version cannot execute ${describe(selection.directive)}.`,
  }))
  return Object.freeze({
    key, status: 'unsupported' as const, value: Object.freeze(fallback) as Readonly<V>, origin: originOf(selection), rule: 'explicit-request' as const,
    reason: `${attribution(selection)} This Apollo version cannot execute it, so the plan is blocked until the request is revised; the request is not ignored and no substitute is applied.`,
    evidenceRefs: evidenceOf(request, selection, ...extra),
  })
}

/** The caption policy of a preset over the outputs of the project: the preset's grouping and capacity, and the measured geometry of each burn-in output. */
function captionPolicyValue(presetId: SubtitlePresetId, outputs: readonly Readonly<EditorialOutputSpec>[]): CaptionPolicyValue {
  const preset = readSubtitlePreset(presetId)
  const deliveries = outputs.flatMap((output) => {
    if (output.variantId === undefined) return []
    const mode = output.subtitleMode ?? 'unspecified' as const
    return [Object.freeze({
      variantId: output.variantId, mode,
      fit: mode === 'burn-in' && output.spec !== undefined ? captionFitGeometryFor({ variantId: output.variantId, spec: output.spec, presetId }) : null,
    })]
  }).toSorted((left, right) => left.variantId.localeCompare(right.variantId))
  return Object.freeze({
    presetId, maxLines: preset.lineBreaking.maxLines, anchor: 'bottom' as const,
    grouping: Object.freeze({ maxWordsPerGroup: preset.grouping.maxWordsPerGroup, maxOnScreenMs: preset.grouping.maxOnScreenMs, silenceBreakMs: preset.grouping.minOnScreenMs }),
    capacityCharacters: preset.lineBreaking.maxLines * preset.lineBreaking.maxCharacters,
    deliveries: Object.freeze(deliveries),
  })
}

function primaryLanguage(tag: string): string {
  return tag.split('-')[0]!.toLowerCase()
}

function aspectOf(value: string | undefined): number | undefined {
  const match = /^(\d+):(\d+)$/.exec(value ?? '')
  return match ? Number(match[1]) / Number(match[2]) : undefined
}

/**
 * Resolves the policies of one video. Pure: no clock, no randomness, no I/O. Each policy comes from the request, from the media, from
 * the output, or from the silence rule; a request that asks for something the Apollo cannot execute blocks the resolution instead of
 * being ignored.
 */
export function resolveEditorialPolicies(
  request: Readonly<EditorialRequestV1>,
  mediaContext: Readonly<EditorialMediaContext>,
  outputsInput: Readonly<EditorialOutputSpec> | readonly Readonly<EditorialOutputSpec>[] = [],
): Readonly<EditorialPolicyResolutionV1> {
  const builder: Builder = { unsupported: [] }
  const openQuestions: OpenQuestion[] = []
  // The Director plans one timeline for every output of the project; a single output is that project's only one. A request that is about one
  // output (a variant override) is read for that output only when it is the only one the plan serves.
  const outputs: readonly Readonly<EditorialOutputSpec>[] = Array.isArray(outputsInput) ? outputsInput : [outputsInput as Readonly<EditorialOutputSpec>]
  const outputSpec: Readonly<EditorialOutputSpec> = outputs.length === 1 ? outputs[0]! : {}

  // Movement. Silence: no movement. The renderer executes no effect, so any movement other than none is understood and unsupported.
  const movementSelection = select(request, outputSpec, 'movement')
  const movement: EditorialPolicies['movement'] = movementSelection === undefined
    ? silent(request, 'movement', { mode: 'none' as const }, 'minimal-intervention',
      'The request does not mention camera movement and none was observed in the source as needed. Nothing that was not asked for is added: no zoom, punch-in, pan, tilt or parallax.')
    : requested(request, builder, 'movement', movementSelection, { mode: 'none' as const }, 'No camera movement is applied.', { mode: 'none' as const })

  // Opening. The window an opening keeps out of automatic motion exists only to protect it from a movement; with no movement applied there is
  // nothing to protect it from. A request that names a window gets exactly that window (from its seconds, or from the end of the first sentence of
  // the speech); one that says none, and silence, get no window.
  const openingSelection = select(request, outputSpec, 'opening')
  const noWindow = { mode: 'not-applicable' as const }
  let opening: EditorialPolicies['opening']
  if (openingSelection === undefined) {
    opening = silent(request, 'opening', noWindow, 'minimal-intervention',
      'The request does not mention the opening. No movement is applied, so there is no motion to keep out of it: there is no opening window to protect.')
  } else {
    const directive = openingSelection.directive
    let value: EditorialPolicies['opening']['value'] = noWindow
    let effect = 'No opening window is protected'
    if (directive.value === 'protect-seconds') {
      value = { mode: 'protected-window' as const, seconds: Number(directive.param) }
      effect = `The first ${String(directive.param)} s are kept out of automatic motion`
    } else if (directive.value === 'protect-first-sentence') {
      if (mediaContext.firstSentenceEndSeconds !== undefined) {
        value = { mode: 'protected-window' as const, seconds: mediaContext.firstSentenceEndSeconds }
        effect = `The first sentence of the speech (up to ${mediaContext.firstSentenceEndSeconds} s) is kept out of automatic motion`
      } else {
        openQuestions.push(Object.freeze({
          id: 'opening-first-sentence-unknown',
          question: 'The request protects the first sentence of the speech, and the speech shows no end of a first sentence. Until what second should the opening be protected?',
          source: 'resolution' as const,
        }))
        effect = 'The first sentence cannot be located in the speech, so no window is applied until the question is answered'
      }
    }
    opening = requested(request, builder, 'opening', openingSelection, value, effect, noWindow,
      ...(mediaContext.transcriptId ? [`transcript:${mediaContext.transcriptId}`] : []))
  }

  // Structure. The source order is kept, and no block is given a narrative role: a hook, a closing or a development are claims about the video that
  // only a request (or the speech, for the call to action) can make.
  const structureSelection = select(request, outputSpec, 'structure')
  const sourceOrder = { order: 'source-order' as const, roles: 'none' as const }
  const structure: EditorialPolicies['structure'] = structureSelection === undefined
    ? silent(request, 'structure', sourceOrder, 'minimal-intervention',
      'The request does not mention the structure. The retained clips keep the order of the source, and no block is given a narrative role (no hook, no development, no closing): nothing is reordered or named that the request did not ask for and the source did not show.')
    : requested(request, builder, 'structure', structureSelection, sourceOrder,
      'The retained clips keep the order of the source, and no block is given a narrative role', sourceOrder)

  // Transitions. No ornamental transition exists unless asked for; the audio seam fade only prevents a click.
  const transitions: EditorialPolicies['transitions'] = silent(request, 'transitions', { type: 'straight-cut' as const, audioFadeMs: AUDIO_SEAM_FADE_MS }, 'minimal-intervention',
    `The request defines no transition. A straight cut adds nothing that was not asked for; the ${AUDIO_SEAM_FADE_MS} ms audio fade at each seam only prevents a click and is not an editorial choice.`)

  // Inserts. They exist when the compiled timeline already holds one.
  const inserts: EditorialPolicies['inserts'] = mediaContext.hasSelectedInsert
    ? Object.freeze({
      key: 'inserts' as const, status: 'applied' as const, value: Object.freeze({ mode: 'use-selected-insert' as const }), origin: 'media-context' as const, rule: 'source-observation' as const,
      reason: 'The compiled timeline already contains a rights-approved selected insert; it is kept as it is.', evidenceRefs: Object.freeze([requestRef(request), 'timeline:selected-insert']),
    })
    : silent(request, 'inserts', { mode: 'no-insert' as const }, 'minimal-intervention',
      'The request does not ask for B-roll and the timeline contains none. No insert is added.')

  // CTA. The objective and desired action are fields the requester gives; the CTA is required only when they ask for an action.
  const action = request.desiredAction
  const ctaRequired = action !== undefined && action.kind !== 'continue-viewing'
  const ctaSelection = select(request, outputSpec, 'cta')
  // The spoken call is recognised by the explicit text the requester gave, or by the words of the language of the speech; with neither it is not evaluable.
  const explicitCtaText = Boolean(action?.verbalCta?.trim() || action?.visualCta?.trim())
  const evaluation: CtaEvaluation = !ctaRequired ? 'not-required'
    : explicitCtaText ? 'explicit-text'
      : ctaLexiconFor(mediaContext.transcriptLanguage) !== null ? 'lexicon' : 'not-evaluable'
  if (evaluation === 'not-evaluable' && mediaContext.transcriptLanguage !== undefined) {
    openQuestions.push(Object.freeze({
      id: 'cta-not-evaluable',
      question: `The objective asks for the action ${action!.kind}, and the Apollo has no list of the words that ask for it in ${mediaContext.transcriptLanguage}. What is the exact spoken call to action (the verbal CTA text), so that it can be checked?`,
      source: 'resolution' as const,
    }))
  }
  if (ctaRequired && ctaSelection?.directive.value === 'none') {
    openQuestions.push(Object.freeze({
      id: 'cta-conflicts-with-action',
      question: `The objective asks for the action ${action!.kind}, and the request asks for no call to action. Which of the two holds?`,
      source: 'resolution' as const,
    }))
  }
  const cta: EditorialPolicies['cta'] = Object.freeze({
    key: 'cta' as const, status: 'applied' as const,
    value: Object.freeze({ required: ctaRequired, evaluation }),
    origin: action !== undefined ? 'request-field' as const : 'silence-rule' as const,
    rule: action !== undefined ? 'desired-action' as const : 'minimal-intervention' as const,
    reason: action === undefined
      ? 'The request names no objective or desired action, so no call to action is required.'
      : action.kind === 'continue-viewing'
        ? `The project objective${request.objective ? ` (${request.objective})` : ''} asks the viewer only to keep watching (desired action ${action.kind}); no call to action is required.`
        : `The project objective${request.objective ? ` (${request.objective})` : ''} asks for the action ${action.kind}; a call to action is required, and it is judged where the speech says it.`,
    evidenceRefs: Object.freeze([requestRef(request), ...(action !== undefined ? [`desired-action:${action.kind}`] : [])]),
  })

  // CTA overlay. A visual call to action is drawn only when the request asks (the cta directive) or gives its text (the desired action), and it is
  // drawn where the speech says the call: at the spoken call, or - when the request says closing - from the spoken call to the end (from the last
  // sentence of the speech, when the speech has no call). Without a spoken call and without a closing request there is nowhere to draw it from,
  // which is a question.
  const visualText = action?.visualCta?.trim()
  const spoken = mediaContext.spokenCta
  const overlayWanted = ctaSelection !== undefined
    ? ctaSelection.directive.value === 'overlay-closing' || ctaSelection.directive.value === 'overlay-at-spoken-cta'
    : Boolean(visualText)
  const noOverlay = { mode: 'none' as const }
  let ctaOverlay: EditorialPolicies['ctaOverlay']
  if (!overlayWanted) {
    ctaOverlay = ctaSelection !== undefined
      ? requested(request, builder, 'ctaOverlay', ctaSelection, noOverlay,
        ctaSelection.directive.value === 'verbal-only' && visualText ? 'The call to action is only spoken: the visual call to action text of the desired action is not drawn' : 'No visual call to action is drawn', noOverlay)
      : silent(request, 'ctaOverlay', noOverlay, 'minimal-intervention', 'The request gives no visual call to action text, so none is drawn.')
  } else {
    const toEnd = ctaSelection?.directive.value === 'overlay-closing'
    let value: EditorialPolicies['ctaOverlay']['value'] = noOverlay
    let effect = 'No visual call to action is drawn until the question is answered'
    if (!visualText) {
      openQuestions.push(Object.freeze({ id: 'cta-overlay-text-missing', question: 'The request asks for a visual call to action and the desired action has no visual text. What should it say?', source: 'resolution' as const }))
    } else if (spoken === undefined && !(toEnd && mediaContext.closingSentenceStartSeconds !== undefined)) {
      openQuestions.push(Object.freeze({
        id: 'cta-overlay-placement-unknown',
        question: 'The visual call to action is drawn where the speech says the call, and the speech shows none that can be recognised. Where should it be drawn?',
        source: 'resolution' as const,
      }))
    } else {
      const startSeconds = spoken?.startSeconds ?? mediaContext.closingSentenceStartSeconds!
      const endSeconds = toEnd ? Math.max(spoken?.endSeconds ?? startSeconds, mediaContext.timelineDurationSeconds ?? spoken?.endSeconds ?? startSeconds) : spoken!.endSeconds
      value = { mode: 'window' as const, startSeconds, endSeconds, anchoredTo: !toEnd ? 'spoken-cta' as const : spoken ? 'spoken-cta-to-end' as const : 'closing-sentence' as const }
      effect = !toEnd
        ? `The visual call to action is drawn while the call is spoken (${startSeconds} s to ${endSeconds} s)`
        : spoken
          ? `The visual call to action is drawn from the spoken call (${startSeconds} s) to the end of the video (${endSeconds} s)`
          : `The speech has no call to action, so the closing of the video is its last sentence: the visual call to action is drawn from there (${startSeconds} s) to the end of the video (${endSeconds} s)`
    }
    if (ctaSelection !== undefined) {
      ctaOverlay = requested(request, builder, 'ctaOverlay', ctaSelection, value, effect, noOverlay)
    } else {
      ctaOverlay = Object.freeze({
        key: 'ctaOverlay' as const, status: 'applied' as const, value: Object.freeze(value), origin: 'request-field' as const, rule: 'explicit-request' as const,
        reason: `The desired action carries a visual call to action text, so it is drawn. ${sentence(effect)}`,
        evidenceRefs: Object.freeze([requestRef(request), `desired-action:${action!.kind}`]),
      })
    }
  }

  // Layout. The geometry of the source and of every output decides it unless the request does: where they have one frame shape the source is used
  // as it is; where they differ, the request decides how the frame is fitted, and silence keeps the whole frame visible over a backdrop.
  const layoutSelection = select(request, outputSpec, 'layout')
  const sourceAspect = aspectOf(mediaContext.sourceAspectRatio)
  const outputShapes = outputs.map((output) => aspectOf(output.aspectRatio ?? output.spec?.aspectRatio))
  const shapesKnown = sourceAspect !== undefined && outputShapes.length > 0 && outputShapes.every((shape) => shape !== undefined)
  const sameShape = shapesKnown && outputShapes.every((shape) => Math.abs(shape! - sourceAspect!) < 0.005)
  const outputsText = outputs.map((output) => output.aspectRatio ?? output.spec?.aspectRatio ?? 'unknown').join(', ')
  const fitWithBackdrop = { mode: 'fit-with-backdrop' as const }
  let layout: EditorialPolicies['layout']
  if (layoutSelection !== undefined) {
    const nativeAsked = layoutSelection.directive.value === 'source-native'
    if (nativeAsked && !sameShape) {
      openQuestions.push(Object.freeze({
        id: 'layout-source-native-mismatch',
        question: `The request keeps the source frame as it is, and the source (${mediaContext.sourceAspectRatio ?? 'unknown shape'}) does not have the frame shape of the output(s) (${outputsText || 'unknown'}). Should the whole frame stay visible over a backdrop?`,
        source: 'resolution' as const,
      }))
    }
    layout = requested(request, builder, 'layout', layoutSelection, nativeAsked && sameShape ? { mode: 'source-native' as const } : fitWithBackdrop,
      nativeAsked ? 'The source frame is used as it is' : 'The whole frame stays visible over a backdrop', fitWithBackdrop)
  } else if (sameShape) {
    layout = Object.freeze({
      key: 'layout' as const, status: 'applied' as const, value: Object.freeze({ mode: 'source-native' as const }), origin: 'output-spec' as const, rule: 'output-geometry' as const,
      reason: `The source (${mediaContext.sourceAspectRatio}) and the output(s) (${outputsText}) have the same frame shape, so the source is used as it is.`,
      evidenceRefs: Object.freeze([requestRef(request), ...outputs.flatMap((output) => output.id ? [`output-spec:${output.id}`] : [])]),
    })
  } else {
    layout = silent(request, 'layout', fitWithBackdrop, 'minimal-intervention',
      shapesKnown
        ? `The request does not mention layout and the source (${mediaContext.sourceAspectRatio}) does not have the frame shape of every output (${outputsText}). The whole frame stays visible over a backdrop: it removes nothing from what was filmed.`
        : 'The request does not mention layout and no source or output geometry was given to the resolution. The whole frame stays visible over a backdrop: it removes nothing from what was filmed.')
  }

  // Language. The request names it, or the transcript shows it; with neither, it is a question, not a guess.
  const languageSelection = select(request, outputSpec, 'caption-language')
  let language: EditorialPolicies['language']
  if (languageSelection !== undefined) {
    const requestedLanguage = String(languageSelection.directive.param)
    language = requested(request, builder, 'language', languageSelection, { captionLanguage: requestedLanguage }, `Captions are written in ${requestedLanguage}`, { captionLanguage: requestedLanguage },
      ...(mediaContext.transcriptId ? [`transcript:${mediaContext.transcriptId}`] : []))
    if (mediaContext.transcriptLanguage !== undefined && primaryLanguage(requestedLanguage) !== primaryLanguage(mediaContext.transcriptLanguage)) {
      openQuestions.push(Object.freeze({
        id: 'caption-language-translation',
        question: `Captions were requested in ${requestedLanguage}, but the observed speech is in ${mediaContext.transcriptLanguage} and the Apollo has no translation here. Should the captions stay in ${mediaContext.transcriptLanguage}?`,
        source: 'resolution' as const,
      }))
    }
  } else if (mediaContext.transcriptLanguage !== undefined) {
    language = Object.freeze({
      key: 'language' as const, status: 'applied' as const, value: Object.freeze({ captionLanguage: mediaContext.transcriptLanguage }), origin: 'media-context' as const, rule: 'source-observation' as const,
      reason: `The request does not name a caption language. The observed transcript is in ${mediaContext.transcriptLanguage}, and the captions are its own words.`,
      evidenceRefs: Object.freeze([requestRef(request), ...(mediaContext.transcriptId ? [`transcript:${mediaContext.transcriptId}`] : [])]),
    })
  } else {
    language = silent(request, 'language', { captionLanguage: null }, 'minimal-intervention',
      'The request does not name a caption language and the transcript does not state one. No language is assumed.')
    openQuestions.push(Object.freeze({ id: 'caption-language-unknown', question: 'In which language should the captions be written? The request does not say and the transcript does not state it.', source: 'resolution' as const }))
  }

  // Captions. The style is the request's, else the project override's (or the Guardrail it inherits), else the baseline of the renderer registry;
  // the grouping is the preset's and the width a cue may take is measured on each output that burns captions.
  const styleSelection = select(request, outputSpec, 'caption-style')
  const override = mediaContext.subtitleStyleOverride !== undefined && (SUBTITLE_PRESET_IDS as readonly string[]).includes(mediaContext.subtitleStyleOverride.presetId)
    ? mediaContext.subtitleStyleOverride : undefined
  const captionValue = (presetId: SubtitlePresetId): CaptionPolicyValue => captionPolicyValue(presetId, outputs)
  let captions: EditorialPolicies['captions']
  if (styleSelection !== undefined) {
    const presetId = styleSelection.directive.value as SubtitlePresetId
    captions = requested(request, builder, 'captions', styleSelection, captionValue(presetId),
      `Captions use the ${presetId} preset; their grouping is the preset's and their width is measured on each output that burns captions`, captionValue(presetId))
  } else if (override !== undefined) {
    const presetId = override.presetId as SubtitlePresetId
    captions = Object.freeze({
      key: 'captions' as const, status: 'applied' as const, value: Object.freeze(captionValue(presetId)),
      origin: override.origin === 'project-custom' ? 'request-field' as const : 'workspace-policy' as const, rule: 'project-override' as const,
      reason: override.origin === 'project-custom'
        ? `The project fixed the caption style ${presetId} (override subtitleStyle). The grouping is the preset's and the width is measured on each output that burns captions.`
        : `The workspace Guardrail fixed the caption style ${presetId} (override subtitleStyle, inherited by the project). The grouping is the preset's and the width is measured on each output that burns captions.`,
      evidenceRefs: Object.freeze([requestRef(request), `override:subtitleStyle:${override.origin}`]),
    })
  } else {
    captions = silent(request, 'captions', captionValue(RENDERER_BASELINE_CAPTION_PRESET), 'renderer-baseline',
      `The request, the project and the workspace do not name a caption style. The captions are the transcript's own words and need some style to be drawn: the baseline preset of the renderer registry (${RENDERER_BASELINE_CAPTION_PRESET}) is used. That is not a choice of the requester. Its grouping is the preset's and the width is measured on each output that burns captions.`)
  }

  // The speech the requester asked to remove.
  const removals = request.requestedRemovals
  const speechRemovals: EditorialPolicies['speechRemovals'] = removals.length > 0
    ? Object.freeze({
      key: 'speechRemovals' as const, status: 'applied' as const, value: Object.freeze({ ruleIds: Object.freeze([...removals]) }), origin: 'request-field' as const, rule: 'explicit-request' as const,
      reason: `The requester asked to remove ${removals.length} spoken phrase rule(s) with remove-spoken-content Commands; the captions must not say any of it.`,
      evidenceRefs: Object.freeze([requestRef(request), ...removals.map((ruleId) => `removal:${ruleId}`)]),
    })
    : silent(request, 'speechRemovals', { ruleIds: Object.freeze([] as string[]) }, 'minimal-intervention', 'The request asks to remove no speech; no spoken phrase is forbidden.')

  // The plan is one timeline for every output of the project. A value asked for one output of several cannot be executed by that plan, and is
  // therefore listed (never applied to all, never dropped). With one output the override has been read for it above.
  if (outputs.length > 1) {
    const policyKeyOf: Readonly<Record<EditorialDirectiveKind, PolicyKey | 'interpretation'>> = {
      movement: 'movement', opening: 'opening', structure: 'structure', cta: 'ctaOverlay', layout: 'layout',
      'caption-language': 'language', 'caption-style': 'captions', keep: 'interpretation', avoid: 'interpretation',
    }
    for (const output of outputs) {
      for (const directive of output.variantId !== undefined ? request.variantOverrides[output.variantId] ?? [] : []) {
        builder.unsupported.push(Object.freeze({
          policyKey: policyKeyOf[directive.kind], directiveId: directive.id, kind: directive.kind, value: describe(directive),
          source: 'variant-override' as const, reason: 'not-executable' as const,
          summary: `The plan is one for the ${outputs.length} outputs of the project: ${describe(directive)} for output variant ${output.variantId} alone cannot be executed.`,
        }))
      }
    }
  }

  // What the request asks for and the Apollo does not do at all: listed, never dropped.
  for (const directive of [...request.directives, ...Object.values(request.variantOverrides).flat(), ...(request.interpretation?.directives ?? [])]) {
    if ((directive.kind === 'keep' || directive.kind === 'avoid') && !EDITORIAL_EXECUTABLE_VALUES[directive.kind].includes(directive.value)) {
      builder.unsupported.push(Object.freeze({
        policyKey: 'interpretation' as const, directiveId: directive.id, kind: directive.kind, value: describe(directive),
        source: request.interpretation?.directives.some((item) => item.id === directive.id) ? 'request-briefing' as const : 'request-field' as const,
        reason: 'not-executable' as const, summary: `This Apollo version has no way to enforce ${describe(directive)} other than Commands.`,
      }))
    }
  }
  for (const item of request.interpretation?.unsupported ?? []) {
    builder.unsupported.push(Object.freeze({
      policyKey: 'interpretation' as const, directiveId: item.id, kind: 'unmapped' as const, value: truncate(item.excerpt.text), source: 'request-briefing' as const,
      reason: item.reason, summary: item.summary,
    }))
  }
  for (const question of request.interpretation?.questions ?? []) {
    if (question.status === 'open') openQuestions.push(Object.freeze({ id: question.id, question: question.question, source: 'interpretation' as const }))
  }

  // Budget. What the plan may add: nothing the request did not ask for (no pattern break, no effect), the proofs the timeline already shows, and
  // the one call to action the objective asks for.
  const budget: EditorialPolicies['budget'] = silent(request, 'budget', Object.freeze({
    maxPatternBreaksPer30s: 0, allowedEffects: Object.freeze([] as string[]), maxProofItems: mediaContext.selectedInsertCount ?? 0, maxCtaOccurrences: ctaRequired ? 1 : 0,
  }), 'minimal-intervention',
  `The request asks for no pattern break and no effect, so none is allowed. The proofs are the ${mediaContext.selectedInsertCount ?? 0} selected insert(s) the timeline already holds, and the call to action is ${ctaRequired ? 'the one the objective asks for' : 'not required'}.`)

  // Rubric. A criterion that measures what the request did not ask for is not scored; the others are renormalized (see effectiveRubricCriteria).
  const notRequested: RubricCriterionId[] = [
    ...(structure.value.roles === 'none' ? ['hook-clarity' as const] : []),
    ...(!cta.value.required ? ['cta-clarity' as const, 'friction-reduction' as const] : []),
  ]
  const rubric: EditorialPolicies['rubric'] = silent(request, 'rubric', Object.freeze({ notRequested: Object.freeze(notRequested) }), 'minimal-intervention',
    notRequested.length === 0 ? 'Every criterion of the objective rubric is about something the request asked for.'
      : `Not scored, because the request did not ask for what they measure: ${notRequested.join(', ')}. The other criteria keep their proportions and their weights sum to one.`,
  ...(structure.value.roles === 'none' ? ['policy-key:structure'] : []), ...(!cta.value.required ? ['policy-key:cta'] : []))

  const policies: EditorialPolicies = Object.freeze({
    movement, opening, structure, transitions, inserts, cta, ctaOverlay, layout, language, captions, speechRemovals, budget, rubric,
  })
  const body = {
    schemaVersion: EDITORIAL_POLICY_RESOLUTION_SCHEMA, resolverVersion: EDITORIAL_POLICY_RESOLVER_VERSION, requestHash: request.requestHash,
    policies, unsupported: Object.freeze(builder.unsupported), openQuestions: Object.freeze(openQuestions),
    blocked: builder.unsupported.length > 0 || openQuestions.length > 0,
  }
  return Object.freeze({ ...body, policyResolutionHash: calculateCanonicalHash(body) })
}

/** The reference a Director decision carries to name the policy that sustains it. Short enough for an evidence ref. */
export function policyRef(resolution: Readonly<Pick<EditorialPolicyResolutionV1, 'policyResolutionHash'>>, key: PolicyKey): string {
  return `policy:${key}:${resolution.policyResolutionHash.slice(0, 16)}`
}

const POLICY_REF = /^policy:([A-Za-z]+):([a-f0-9]{16})$/
export function parsePolicyRef(ref: string): Readonly<{ key: PolicyKey; hashPrefix: string }> | null {
  const match = POLICY_REF.exec(ref)
  return match && (POLICY_KEYS as readonly string[]).includes(match[1]!) ? Object.freeze({ key: match[1] as PolicyKey, hashPrefix: match[2]! }) : null
}

/** True when `ref` names a policy of this resolution. */
export function resolutionOwnsPolicyRef(resolution: Readonly<EditorialPolicyResolutionV1>, ref: string): boolean {
  const parsed = parsePolicyRef(ref)
  return parsed !== null && resolution.policyResolutionHash.startsWith(parsed.hashPrefix)
}

/** The resolution a plan may be made from: refuses a blocked one with the precise reason, so nothing is ever planned over an ignored request. */
export function assertResolutionPlannable(resolution: Readonly<EditorialPolicyResolutionV1>): void {
  assertDomain(!resolution.blocked, 'PRECONDITION_REQUIRED',
    'The editorial request asks for something the Apollo cannot execute, or leaves a question open; it must be revised before a plan is made',
    { reason: 'editorial-request-blocked', unsupported: resolution.unsupported.map((item) => ({ directiveId: item.directiveId, value: item.value, reason: item.reason })),
      openQuestions: resolution.openQuestions.map((item) => ({ id: item.id, question: item.question })) })
}

// ---- Consumers of the policies: the facts a plan must show for a policy to hold. Pure, so the Director and the gates read them one way.

/** Seconds of protected opening window the plan contract carries under this policy (0: none). */
export function protectedOpeningSeconds(policy: EditorialPolicies['opening']): number {
  return policy.value.mode === 'protected-window' ? policy.value.seconds : 0
}

/**
 * `automaticZoom` of a plan under the movement policy. The renderer executes no effect, so the only movement a plan can carry is none; a
 * movement the request asked for is `unsupported` and never reaches a plan (see `assertResolutionPlannable`).
 */
export function automaticZoomUnderPolicy(policy: EditorialPolicies['movement']): boolean {
  assertDomain(policy.status === 'applied' && policy.value.mode === 'none', 'PRECONDITION_REQUIRED', 'The movement policy is not one this planner version can execute')
  return policy.value.mode !== 'none'
}

/** The movement envelope a plan carries under the resolved movement and opening policies: exactly what they say, nothing carried over. */
export function planMovementPolicyUnder(policies: Pick<EditorialPolicies, 'movement' | 'opening'>, fps: number): Readonly<{ automaticZoom: boolean; protectedOpeningFrames: number }> {
  return Object.freeze({ automaticZoom: automaticZoomUnderPolicy(policies.movement), protectedOpeningFrames: Math.round(fps * protectedOpeningSeconds(policies.opening)) })
}

let requestlessPolicies: Readonly<EditorialPolicies> | undefined
/**
 * The policies of a plan that was made without an editorial request of its own (a cut of the source, a compile of an aggregate somebody else
 * decided): those of a request that is silent, resolved by this module like any other. Nothing here is a preference of the producer.
 */
export function requestlessEditorialPolicies(): Readonly<EditorialPolicies> {
  requestlessPolicies ??= resolveEditorialPolicies(createEditorialRequest({}), { hasSelectedInsert: false }).policies
  return requestlessPolicies
}

/**
 * The composition (frame fit) the plan draws for the layout policy: the source as it is, or the whole frame over a blurred backdrop. The two
 * safety regions are limits of the renderer (a face is assumed in the upper part of the frame until perception says otherwise; captions keep to
 * the lower band), not choices of the requester.
 */
export function compositionUnderPolicy(policy: EditorialPolicies['layout']): Readonly<{
  layout: 'landscape-inset' | 'source-native'; background: 'blurred-source' | 'none'; foregroundScale: 1; verticalPosition: 0.5
  faceSafeFallback: readonly [number, number, number, number]; subtitleSafeRegion: readonly [number, number, number, number]
}> {
  assertDomain(policy.status === 'applied', 'PRECONDITION_REQUIRED', 'The layout policy is not one this planner version can execute')
  const native = policy.value.mode === 'source-native'
  return Object.freeze({
    layout: native ? 'source-native' as const : 'landscape-inset' as const,
    background: native ? 'none' as const : 'blurred-source' as const,
    foregroundScale: 1 as const, verticalPosition: 0.5 as const,
    faceSafeFallback: Object.freeze([0.14, 0.08, 0.72, 0.56] as const),
    subtitleSafeRegion: Object.freeze([0.08, 0.7, 0.84, 0.24] as const),
  })
}

/** The id of the caption track: the language of its words, or `unspecified` when the language is not known. */
export function captionTrackId(policy: EditorialPolicies['language']): string {
  const language = policy.value.captionLanguage
  return `track-captions-${language === null ? 'unspecified' : language.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/** The act, role and intent of one story block. */
export interface StoryBlockShape {
  actId: 'sequence'
  role: 'segment' | 'cta'
  intent: string
}

/**
 * The block of a story plan under the structure policy. The only structure this planner version can express keeps the source order and names
 * no role: a block is a segment of the source, and the one block where the call to action is spoken (the CTA policy requires one and the speech
 * shows it) is the call to action. Position decides nothing.
 */
export function storyBlockUnderPolicy(policy: EditorialPolicies['structure'], input: Readonly<{ isCta: boolean; actionKind: string }>): StoryBlockShape {
  assertDomain(policy.status === 'applied' && policy.value.roles === 'none', 'PRECONDITION_REQUIRED', 'The structure policy is not one this planner version can execute')
  return Object.freeze({
    actId: 'sequence' as const,
    role: input.isCta ? 'cta' as const : 'segment' as const,
    intent: input.isCta ? `observed-${input.actionKind}-call` : 'retain-source-segment',
  })
}

/** The plan facts the movement and opening policies are judged on. */
export interface PlanMovementFacts {
  fps: number
  automaticZoom: boolean
  protectedOpeningFrames: number
  effectTrackCount: number
}

export function movementMatchesPolicy(facts: Readonly<PlanMovementFacts>, policy: EditorialPolicies['movement']): boolean {
  return policy.status === 'applied' && policy.value.mode === 'none' && !facts.automaticZoom && facts.effectTrackCount === 0
}

export function openingMatchesPolicy(facts: Readonly<PlanMovementFacts>, policy: EditorialPolicies['opening']): boolean {
  if (policy.status !== 'applied' || facts.effectTrackCount !== 0) return false
  // The plan states exactly the window the policy says: none for an opening that has nothing to be protected from, at least the window otherwise.
  return policy.value.mode === 'not-applicable' ? facts.protectedOpeningFrames === 0 : facts.protectedOpeningFrames >= Math.round(facts.fps * policy.value.seconds)
}

/** What a plan states of its movement: the facts a worker judges before it renders. */
export interface PlanMovementDeclaration {
  fps: number
  movementPolicy: Readonly<{ automaticZoom: boolean; protectedOpeningFrames: number }>
  effectTracks?: readonly unknown[]
}

/**
 * The check a render worker makes of the plan it is about to render (ADR-160 F4). It replaces the comparison with values the worker used to
 * carry (no zoom, a window of 4 s): the plan must honour the policy resolution it was made from - and, where the plan has none (a cut of the
 * source, a compile of an aggregate), it must at least declare nothing the renderer cannot execute. The renderer executes no effect, so a plan
 * that carries an effect track or an automatic zoom is never rendered, whatever asked for it.
 */
export function assertPlanHonorsResolution(plan: Readonly<PlanMovementDeclaration>, resolution: Readonly<EditorialPolicyResolutionV1> | null | undefined): void {
  const facts: PlanMovementFacts = Object.freeze({
    fps: plan.fps, automaticZoom: plan.movementPolicy.automaticZoom,
    protectedOpeningFrames: plan.movementPolicy.protectedOpeningFrames, effectTrackCount: Array.isArray(plan.effectTracks) ? plan.effectTracks.length : 0,
  })
  assertDomain(!facts.automaticZoom && facts.effectTrackCount === 0, 'INVALID_RENDER_INPUT',
    'The EditPlan declares a movement the renderer does not execute')
  assertDomain(Number.isInteger(facts.protectedOpeningFrames) && facts.protectedOpeningFrames >= 0, 'INVALID_RENDER_INPUT',
    'The EditPlan declares an invalid opening window')
  if (resolution === null || resolution === undefined) return
  assertDomain(!resolution.blocked, 'INVALID_RENDER_INPUT', 'The editorial policy resolution of this EditPlan is blocked: nothing may be rendered from it')
  assertDomain(movementMatchesPolicy(facts, resolution.policies.movement) && openingMatchesPolicy(facts, resolution.policies.opening),
    'INVALID_RENDER_INPUT', 'The EditPlan does not honour the editorial policy resolution it was made from')
}

// ---- Parsing a stored resolution (a Director run is read back from persisted JSON: fail closed on anything that is not what was written).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseEditorialPolicyResolution(value: unknown): Readonly<EditorialPolicyResolutionV1> {
  const fail = (why: string): never => { throw new DomainError('PERSISTENCE_CONFLICT', `Stored editorial policy resolution is invalid: ${why}`) }
  if (!isRecord(value)) return fail('not an object')
  if (Object.keys(value).sort().join('|') !== 'blocked|openQuestions|policies|policyResolutionHash|requestHash|resolverVersion|schemaVersion|unsupported') return fail('unexpected fields')
  if (value.schemaVersion !== EDITORIAL_POLICY_RESOLUTION_SCHEMA || value.resolverVersion !== EDITORIAL_POLICY_RESOLVER_VERSION) return fail('unknown version')
  if (typeof value.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestHash)) return fail('request hash')
  if (!isRecord(value.policies) || Object.keys(value.policies).sort().join('|') !== [...POLICY_KEYS].sort().join('|')) return fail('policy set')
  for (const key of POLICY_KEYS) {
    const policy = (value.policies as Record<string, unknown>)[key]
    if (!isRecord(policy) || Object.keys(policy).sort().join('|') !== 'evidenceRefs|key|origin|reason|rule|status|value') return fail(`policy ${key} shape`)
    const rule = EDITORIAL_POLICY_RULES[policy.rule as PolicyRuleId]
    if (policy.key !== key || (policy.status !== 'applied' && policy.status !== 'unsupported') || !isRecord(policy.value) ||
      typeof policy.reason !== 'string' || policy.reason.trim().length === 0 || policy.reason.length > 2_000 ||
      !(POLICY_ORIGINS as readonly string[]).includes(policy.origin as string) || rule === undefined ||
      !(rule.origins as readonly string[]).includes(policy.origin as string) ||
      !Array.isArray(policy.evidenceRefs) || policy.evidenceRefs.length === 0 || policy.evidenceRefs.length > 64 ||
      policy.evidenceRefs.some((ref) => typeof ref !== 'string' || ref.length === 0 || ref.length > 300)) return fail(`policy ${key} content`)
  }
  if (!Array.isArray(value.unsupported) || !Array.isArray(value.openQuestions) || typeof value.blocked !== 'boolean' ||
    value.blocked !== (value.unsupported.length > 0 || value.openQuestions.length > 0)) return fail('blocked flag')
  const { policyResolutionHash, ...body } = value
  if (typeof policyResolutionHash !== 'string' || policyResolutionHash !== calculateCanonicalHash(body)) return fail('hash')
  return Object.freeze(value) as unknown as Readonly<EditorialPolicyResolutionV1>
}

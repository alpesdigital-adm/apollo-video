import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'
import {
  EDITORIAL_EXECUTABLE_VALUES,
  type EditorialDirective,
  type EditorialDirectiveKind,
  type EditorialRequestV1,
  type BriefExcerpt,
} from './editorial-request.ts'
import type { SubtitlePresetId } from './subtitle-style-tokens.ts'

/**
 * Editorial policy resolution (ADR-160, docs/specs/01 s7.4.3). `resolveEditorialPolicies` turns an editorial request, the observed media
 * and the output into the policies the Director plans with. It is a pure function: the same inputs always give the same resolution and
 * the same hash. Every policy says where it comes from (`origin`), by which named rule (`rule`), why (`reason`, in a sentence that only
 * claims what its origin supports) and on what (`evidenceRefs`).
 *
 * This is the one module of the product allowed to name an editorial value (tests/v2/editorial-literals.test.mjs exempts it). A value
 * that is named here is here under a named rule, and each rule is tested in tests/v2/editorial-policy-resolution.test.mjs.
 */
export const EDITORIAL_POLICY_RESOLUTION_SCHEMA = 'editorial-policy-resolution/v1' as const
export const EDITORIAL_POLICY_RESOLVER_VERSION = 'editorial-policy-resolver/v1' as const

export const POLICY_ORIGINS = Object.freeze([
  'request-field', 'request-briefing', 'media-context', 'output-spec', 'workspace-policy', 'silence-rule',
] as const)
export type PolicyOrigin = (typeof POLICY_ORIGINS)[number]

/**
 * The named rules. `minimal-intervention` is the owner's "does not invent" rule: where the request is silent, nothing is added that was
 * not asked for and not observed in the source. `carried-planner-value` is NOT a rule of the product: it marks a value the planner of the
 * earlier waves still applies and that no slice of ADR-160 has yet derived from the request; it never attributes the value to the owner,
 * and each use is a debt listed in the editorial literals baseline.
 */
export const EDITORIAL_POLICY_RULES = Object.freeze({
  'explicit-request': Object.freeze({ origins: Object.freeze(['request-field', 'request-briefing'] as const), summary: 'The requester said it, in a structured field or in the briefing.' }),
  'desired-action': Object.freeze({ origins: Object.freeze(['request-field'] as const), summary: 'The objective and desired action of the project, which the requester must give, decide it.' }),
  'source-observation': Object.freeze({ origins: Object.freeze(['media-context'] as const), summary: 'The media shows it (the transcript, the compiled timeline).' }),
  'output-geometry': Object.freeze({ origins: Object.freeze(['output-spec'] as const), summary: 'The output specification and the source geometry decide it.' }),
  'minimal-intervention': Object.freeze({ origins: Object.freeze(['silence-rule'] as const), summary: 'The request is silent: nothing is added that was not asked for and not observed in the source.' }),
  'carried-planner-value': Object.freeze({ origins: Object.freeze(['silence-rule'] as const), summary: 'The request is silent and the planner of the earlier waves still applies this value; scheduled to be derived (ADR-160 F3-F5).' }),
} as const)
export type PolicyRuleId = keyof typeof EDITORIAL_POLICY_RULES

export const POLICY_KEYS = Object.freeze([
  'movement', 'opening', 'structure', 'transitions', 'inserts', 'cta', 'ctaOverlay', 'layout', 'language', 'captions', 'speechRemovals',
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
  structure: ResolvedPolicy<{ order: 'source-order'; roles: 'by-position' }>
  transitions: ResolvedPolicy<{ type: 'straight-cut'; audioFadeMs: number }>
  inserts: ResolvedPolicy<{ mode: 'use-selected-insert' | 'no-insert' }>
  cta: ResolvedPolicy<{ required: boolean }>
  ctaOverlay: ResolvedPolicy<{ mode: 'none' } | { mode: 'closing-window'; seconds: number }>
  layout: ResolvedPolicy<{ mode: 'fit-with-backdrop' | 'source-native' }>
  language: ResolvedPolicy<{ captionLanguage: string | null }>
  captions: ResolvedPolicy<{ presetId: SubtitlePresetId; maxCharactersPerBlock: number; maxLines: 2; anchor: 'bottom' }>
  speechRemovals: ResolvedPolicy<{ ruleIds: readonly string[] }>
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
}

/** What the output imposes. */
export interface EditorialOutputSpec {
  id?: string
  variantId?: string
  /** Output frame aspect, `W:H` (absent: unknown). */
  aspectRatio?: string
}

// The values the planner of the earlier waves still applies where the request is silent (rule `carried-planner-value`). ADR-160 F3
// derives the caption ones from the preset and the measured width, F4 the opening, F5 the structure and the CTA window.
const CARRIED_OPENING_SECONDS = 4
const CARRIED_CTA_WINDOW_SECONDS = 3
const CARRIED_CAPTION_BLOCK_CHARACTERS = 32
const CARRIED_CAPTION_PRESET: SubtitlePresetId = 'clean-color'
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
function silent<V>(request: Readonly<EditorialRequestV1>, key: PolicyKey, value: V, rule: 'minimal-intervention' | 'carried-planner-value', reason: string, ...extra: string[]): ResolvedPolicy<V> {
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
  outputSpec: Readonly<EditorialOutputSpec> = {},
): Readonly<EditorialPolicyResolutionV1> {
  const builder: Builder = { unsupported: [] }
  const openQuestions: OpenQuestion[] = []

  // Movement. Silence: no movement. The renderer executes no effect, so any movement other than none is understood and unsupported.
  const movementSelection = select(request, outputSpec, 'movement')
  const movement: EditorialPolicies['movement'] = movementSelection === undefined
    ? silent(request, 'movement', { mode: 'none' as const }, 'minimal-intervention',
      'The request does not mention camera movement and none was observed in the source as needed. Nothing that was not asked for is added: no zoom, punch-in, pan, tilt or parallax.')
    : requested(request, builder, 'movement', movementSelection, { mode: 'none' as const }, 'No camera movement is applied.', { mode: 'none' as const })

  // Opening. Without movement there is no motion to protect an opening from; the plan contract of this planner version still carries a
  // protected window, which is recorded as carried, never as the request's.
  const openingSelection = select(request, outputSpec, 'opening')
  const opening: EditorialPolicies['opening'] = openingSelection === undefined
    ? silent(request, 'opening', { mode: 'protected-window' as const, seconds: CARRIED_OPENING_SECONDS }, 'carried-planner-value',
      `The request does not mention the opening. No movement is applied, so there is no motion to keep out of it. The plan contract of this planner version still carries a protected opening window of ${CARRIED_OPENING_SECONDS} s; it is recorded here as a carried planner value (to be removed in ADR-160 F4), not as a request.`)
    : requested(request, builder, 'opening', openingSelection, { mode: 'protected-window' as const, seconds: CARRIED_OPENING_SECONDS },
      `The opening is left as the source has it; the plan contract of this planner version still carries a protected window of ${CARRIED_OPENING_SECONDS} s`,
      { mode: 'protected-window' as const, seconds: CARRIED_OPENING_SECONDS })

  // Structure. Silence: the source order is kept (nothing reorders). The roles the story plan names by position are the planner's.
  const structureSelection = select(request, outputSpec, 'structure')
  const structure: EditorialPolicies['structure'] = structureSelection === undefined
    ? silent(request, 'structure', { order: 'source-order' as const, roles: 'by-position' as const }, 'carried-planner-value',
      'The request does not mention the structure. The retained clips keep the order of the source; nothing is reordered. The story plan of this planner version still names block roles by position; that is recorded as a carried planner value (to be derived from the request in ADR-160 F5), not as a request.')
    : requested(request, builder, 'structure', structureSelection, { order: 'source-order' as const, roles: 'by-position' as const },
      'The retained clips keep the order of the source', { order: 'source-order' as const, roles: 'by-position' as const })

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
  const cta: EditorialPolicies['cta'] = Object.freeze({
    key: 'cta' as const, status: 'applied' as const,
    value: Object.freeze({ required: action !== undefined && action.kind !== 'continue-viewing' }),
    origin: action !== undefined ? 'request-field' as const : 'silence-rule' as const,
    rule: action !== undefined ? 'desired-action' as const : 'minimal-intervention' as const,
    reason: action === undefined
      ? 'The request names no objective or desired action, so no call to action is required.'
      : action.kind === 'continue-viewing'
        ? `The project objective${request.objective ? ` (${request.objective})` : ''} asks the viewer only to keep watching (desired action ${action.kind}); no call to action is required.`
        : `The project objective${request.objective ? ` (${request.objective})` : ''} asks for the action ${action.kind}; a call to action is required, and it is judged where the speech says it.`,
    evidenceRefs: Object.freeze([requestRef(request), ...(action !== undefined ? [`desired-action:${action.kind}`] : [])]),
  })

  // CTA overlay. Only when the requester gave a visual CTA text.
  const ctaSelection = select(request, outputSpec, 'cta')
  let ctaOverlay: EditorialPolicies['ctaOverlay']
  if (ctaSelection !== undefined) {
    const wantsOverlay = ctaSelection.directive.value === 'overlay-closing' || ctaSelection.directive.value === 'overlay-at-spoken-cta'
    ctaOverlay = requested(request, builder, 'ctaOverlay', ctaSelection,
      wantsOverlay ? { mode: 'closing-window' as const, seconds: CARRIED_CTA_WINDOW_SECONDS } : { mode: 'none' as const },
      wantsOverlay ? `The visual call to action is placed in the closing ${CARRIED_CTA_WINDOW_SECONDS} s window (the planner's carried placement)` : 'No visual call to action is drawn',
      { mode: 'none' as const })
  } else if (action?.visualCta?.trim()) {
    ctaOverlay = Object.freeze({
      key: 'ctaOverlay' as const, status: 'applied' as const, value: Object.freeze({ mode: 'closing-window' as const, seconds: CARRIED_CTA_WINDOW_SECONDS }),
      origin: 'request-field' as const, rule: 'explicit-request' as const,
      reason: `The desired action carries a visual call to action text, so it is drawn. Where it is drawn (the closing ${CARRIED_CTA_WINDOW_SECONDS} s) is the planner's carried placement, to be derived from the request in ADR-160 F5.`,
      evidenceRefs: Object.freeze([requestRef(request), `desired-action:${action.kind}`]),
    })
  } else {
    ctaOverlay = silent(request, 'ctaOverlay', { mode: 'none' as const }, 'minimal-intervention', 'The request gives no visual call to action text, so none is drawn.')
  }

  // Layout. The geometry of the source and of the output decide it unless the request does.
  const layoutSelection = select(request, outputSpec, 'layout')
  const sourceAspect = aspectOf(mediaContext.sourceAspectRatio)
  const outputAspect = aspectOf(outputSpec.aspectRatio)
  let layout: EditorialPolicies['layout']
  if (layoutSelection !== undefined) {
    layout = requested(request, builder, 'layout', layoutSelection, { mode: 'fit-with-backdrop' as const }, 'The whole frame stays visible over a backdrop', { mode: 'fit-with-backdrop' as const })
  } else if (sourceAspect !== undefined && outputAspect !== undefined && Math.abs(sourceAspect - outputAspect) < 0.005) {
    layout = Object.freeze({
      key: 'layout' as const, status: 'applied' as const, value: Object.freeze({ mode: 'source-native' as const }), origin: 'output-spec' as const, rule: 'output-geometry' as const,
      reason: `The source (${mediaContext.sourceAspectRatio}) and the output (${outputSpec.aspectRatio}) have the same frame shape, so the source is used as it is.`,
      evidenceRefs: Object.freeze([requestRef(request), ...(outputSpec.id ? [`output-spec:${outputSpec.id}`] : [])]),
    })
  } else {
    layout = silent(request, 'layout', { mode: 'fit-with-backdrop' as const }, 'minimal-intervention',
      sourceAspect !== undefined && outputAspect !== undefined
        ? `The request does not mention layout and the source (${mediaContext.sourceAspectRatio}) does not have the shape of the output (${outputSpec.aspectRatio}). The whole frame stays visible over a backdrop: it removes nothing from what was filmed.`
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

  // Captions.
  const styleSelection = select(request, outputSpec, 'caption-style')
  const captions: EditorialPolicies['captions'] = styleSelection === undefined
    ? silent(request, 'captions', { presetId: CARRIED_CAPTION_PRESET, maxCharactersPerBlock: CARRIED_CAPTION_BLOCK_CHARACTERS, maxLines: 2 as const, anchor: 'bottom' as const }, 'carried-planner-value',
      `The request does not mention caption style. The captions are the transcript's own words; their preset (${CARRIED_CAPTION_PRESET}) and block width (${CARRIED_CAPTION_BLOCK_CHARACTERS} characters) are the planner's carried values (to be derived from the preset and the measured width in ADR-160 F3), not the request's.`)
    : requested(request, builder, 'captions', styleSelection,
      { presetId: styleSelection.directive.value as SubtitlePresetId, maxCharactersPerBlock: CARRIED_CAPTION_BLOCK_CHARACTERS, maxLines: 2 as const, anchor: 'bottom' as const },
      `Captions use the ${styleSelection.directive.value} preset; the block width (${CARRIED_CAPTION_BLOCK_CHARACTERS} characters) is still the planner's carried value`,
      { presetId: CARRIED_CAPTION_PRESET, maxCharactersPerBlock: CARRIED_CAPTION_BLOCK_CHARACTERS, maxLines: 2 as const, anchor: 'bottom' as const })

  // The speech the requester asked to remove.
  const removals = request.requestedRemovals
  const speechRemovals: EditorialPolicies['speechRemovals'] = removals.length > 0
    ? Object.freeze({
      key: 'speechRemovals' as const, status: 'applied' as const, value: Object.freeze({ ruleIds: Object.freeze([...removals]) }), origin: 'request-field' as const, rule: 'explicit-request' as const,
      reason: `The requester asked to remove ${removals.length} spoken phrase rule(s) with remove-spoken-content Commands; the captions must not say any of it.`,
      evidenceRefs: Object.freeze([requestRef(request), ...removals.map((ruleId) => `removal:${ruleId}`)]),
    })
    : silent(request, 'speechRemovals', { ruleIds: Object.freeze([] as string[]) }, 'minimal-intervention', 'The request asks to remove no speech; no spoken phrase is forbidden.')

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

  const policies: EditorialPolicies = Object.freeze({
    movement, opening, structure, transitions, inserts, cta, ctaOverlay, layout, language, captions, speechRemovals,
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
  return `policy:${key}@${resolution.policyResolutionHash.slice(0, 16)}`
}

const POLICY_REF = /^policy:([A-Za-z]+)@([a-f0-9]{16})$/
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
    { unsupported: resolution.unsupported.map((item) => ({ directiveId: item.directiveId, value: item.value, reason: item.reason })),
      openQuestions: resolution.openQuestions.map((item) => ({ id: item.id, question: item.question })) })
}

// ---- Consumers of the policies: the facts a plan must show for a policy to hold. Pure, so the Director and the gates read them one way.

/** Seconds of protected opening window the plan contract carries under this policy (0: none). */
export function protectedOpeningSeconds(policy: EditorialPolicies['opening']): number {
  return policy.value.mode === 'protected-window' ? policy.value.seconds : 0
}

/** `automaticZoom` of a plan under the movement policy: the only executable movement is none. */
export function automaticZoomUnderPolicy(policy: EditorialPolicies['movement']): false {
  assertDomain(policy.status === 'applied' && policy.value.mode === 'none', 'PRECONDITION_REQUIRED', 'The movement policy is not one this planner version can execute')
  return false
}

/** The composition (frame fit) the plan draws for the layout policy. */
export function compositionLayoutUnderPolicy(policy: EditorialPolicies['layout']): Readonly<{ layout: 'landscape-inset'; background: 'blurred-source' }> {
  assertDomain(policy.status === 'applied', 'PRECONDITION_REQUIRED', 'The layout policy is not one this planner version can execute')
  return Object.freeze({ layout: 'landscape-inset' as const, background: 'blurred-source' as const })
}

/** The id of the caption track: the language of its words, or `unspecified` when the language is not known. */
export function captionTrackId(policy: EditorialPolicies['language']): string {
  const language = policy.value.captionLanguage
  return `track-captions-${language === null ? 'unspecified' : language.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/** The plan facts the movement and opening policies are judged on. */
export interface PlanMovementFacts {
  fps: number
  automaticZoom: boolean
  protectedOpeningFrames: number
  effectTrackCount: number
}

export function movementMatchesPolicy(facts: Readonly<PlanMovementFacts>, policy: EditorialPolicies['movement']): boolean {
  return policy.status === 'applied' && policy.value.mode === 'none' && facts.automaticZoom === false && facts.effectTrackCount === 0
}

export function openingMatchesPolicy(facts: Readonly<PlanMovementFacts>, policy: EditorialPolicies['opening']): boolean {
  if (policy.status !== 'applied' || facts.effectTrackCount !== 0) return false
  return policy.value.mode === 'not-applicable' || facts.protectedOpeningFrames >= Math.round(facts.fps * policy.value.seconds)
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

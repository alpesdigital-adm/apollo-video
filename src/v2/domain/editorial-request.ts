import { createHash } from 'node:crypto'

import { calculateCanonicalHash } from './canonical-hash.ts'
import { parseDesiredAction, type DesiredAction } from './desired-action.ts'
import { assertDomain } from './errors.ts'
import { resolveStrategicObjective, type StrategicObjectiveId } from './strategic-objective.ts'
import { SUBTITLE_PRESET_IDS } from './subtitle-style-tokens.ts'

/**
 * The editorial request of one video (ADR-160, docs/specs/01 s7.4). Nothing in the Apollo is fixed: what a video gets comes from this
 * value. It holds what the requester wrote (a free briefing, optional structured directives) and, when a model has read the briefing,
 * the interpretation of it. It holds no default: a directive the requester did not give is absent, and absence means "not requested".
 *
 * This module is the closed vocabulary of directives, linked to what the Apollo can really execute, and the validation of the two
 * values. The policies a request resolves to live in `editorial-policy-resolution.ts`.
 */
export const EDITORIAL_REQUEST_SCHEMA = 'editorial-request/v1' as const
export const BRIEF_INTERPRETATION_SCHEMA = 'brief-interpretation/v1' as const

export const EDITORIAL_DIRECTIVE_KINDS = Object.freeze([
  'movement', 'opening', 'structure', 'cta', 'layout', 'caption-language', 'caption-style', 'keep', 'avoid',
] as const)
export type EditorialDirectiveKind = (typeof EDITORIAL_DIRECTIVE_KINDS)[number]

/** What the parameter of a value is: seconds (a positive number), a BCP-47 language tag, or a short free subject. */
export type EditorialDirectiveParamKind = 'seconds' | 'language' | 'text'

/**
 * The closed vocabulary. `values` lists what an interpreter (or a structured field) may say about each kind; `params` names the
 * parameter a value takes. A value outside this table is not a directive: it is an `unsupported` item.
 */
export const EDITORIAL_DIRECTIVE_VOCABULARY: Readonly<Record<EditorialDirectiveKind, Readonly<{
  values: readonly string[]
  params: Readonly<Record<string, EditorialDirectiveParamKind>>
}>>> = Object.freeze({
  movement: Object.freeze({ values: Object.freeze(['none', 'punch-in', 'zoom-in', 'zoom-out', 'pan', 'tilt', 'parallax']), params: Object.freeze({}) }),
  opening: Object.freeze({ values: Object.freeze(['none', 'protect-first-sentence', 'protect-seconds']), params: Object.freeze({ 'protect-seconds': 'seconds' as const }) }),
  structure: Object.freeze({ values: Object.freeze(['source-order', 'hook-first']), params: Object.freeze({}) }),
  cta: Object.freeze({ values: Object.freeze(['none', 'verbal-only', 'overlay-closing', 'overlay-at-spoken-cta']), params: Object.freeze({}) }),
  layout: Object.freeze({ values: Object.freeze(['source-native', 'fit-with-backdrop', 'fill-crop']), params: Object.freeze({}) }),
  'caption-language': Object.freeze({ values: Object.freeze(['set']), params: Object.freeze({ set: 'language' as const }) }),
  'caption-style': Object.freeze({ values: Object.freeze([...SUBTITLE_PRESET_IDS]), params: Object.freeze({}) }),
  keep: Object.freeze({ values: Object.freeze(['subject']), params: Object.freeze({ subject: 'text' as const }) }),
  avoid: Object.freeze({ values: Object.freeze(['subject']), params: Object.freeze({ subject: 'text' as const }) }),
})

/**
 * What the Apollo can execute TODAY, per kind (a subset of the vocabulary). A directive whose value is in the vocabulary but not here
 * is understood and not executable: it is reported as `unsupported` and blocks the plan, it is never ignored. Each slice that teaches
 * the renderer something (ADR-160 F3-F5) widens this table in the same commit.
 */
export const EDITORIAL_EXECUTABLE_VALUES: Readonly<Record<EditorialDirectiveKind, readonly string[]>> = Object.freeze({
  movement: Object.freeze(['none']),
  opening: Object.freeze(['none', 'protect-first-sentence', 'protect-seconds']),
  structure: Object.freeze(['source-order']),
  cta: Object.freeze(['none', 'verbal-only', 'overlay-closing']),
  layout: Object.freeze(['fit-with-backdrop']),
  'caption-language': Object.freeze(['set']),
  'caption-style': Object.freeze([...SUBTITLE_PRESET_IDS]),
  keep: Object.freeze([]),
  avoid: Object.freeze([]),
})

export interface EditorialDirective {
  /** Unique within its source (the interpretation, the structured fields, one variant override). */
  id: string
  kind: EditorialDirectiveKind
  value: string
  param?: string | number
}

/** The exact words of the briefing a directive, an unsupported item or a question stands on. */
export interface BriefExcerpt {
  /** UTF-16 offsets into the briefing text the interpretation was made from: `[start, end)`. */
  start: number
  end: number
  text: string
}

export interface InterpretedDirective extends EditorialDirective {
  excerpt: Readonly<BriefExcerpt>
}

export interface UnsupportedBriefItem {
  id: string
  excerpt: Readonly<BriefExcerpt>
  /** What the briefing asked for, in the interpreter's words. */
  summary: string
  reason: 'outside-vocabulary' | 'not-executable'
}

export interface BriefQuestion {
  id: string
  question: string
  excerpt?: Readonly<BriefExcerpt>
  status: 'open' | 'answered'
  answer?: string
}

export interface BriefInterpretationV1 {
  schemaVersion: typeof BRIEF_INTERPRETATION_SCHEMA
  /** SHA-256 of the exact briefing text the interpreter read: an interpretation of other text is not this briefing's. */
  briefingSha256: string
  interpreter: Readonly<{ provider: string; model: string; promptVersion: string }>
  directives: readonly Readonly<InterpretedDirective>[]
  unsupported: readonly Readonly<UnsupportedBriefItem>[]
  questions: readonly Readonly<BriefQuestion>[]
  interpretationHash: string
}

export interface EditorialRequestV1 {
  schemaVersion: typeof EDITORIAL_REQUEST_SCHEMA
  briefing?: Readonly<{ text: string; sha256: string }>
  objective?: StrategicObjectiveId
  desiredAction?: Readonly<DesiredAction>
  /** Structured directives (every one optional; none is given by omission). */
  directives: readonly Readonly<EditorialDirective>[]
  /** Directives that apply only to one output variant, by `variantId`. */
  variantOverrides: Readonly<Record<string, readonly Readonly<EditorialDirective>[]>>
  interpretation?: Readonly<BriefInterpretationV1>
  /**
   * The speech the requester asked to remove, by phrase-rule id (the rules of the `remove-spoken-content` Commands of the lineage).
   * NOT part of `requestHash`: the hash is of what the BRIEF says, recomputed from the Brief Snapshot; the removals are Commands, and
   * the policy resolution that consumed them seals them.
   */
  requestedRemovals: readonly string[]
  /** SHA-256 of the canonical request without `requestedRemovals`. */
  requestHash: string
}

const MAX_BRIEFING_CHARS = 10_000
const MAX_DIRECTIVES = 64
const MAX_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

/** Validates one directive against the closed vocabulary: the kind, the value of that kind, and the parameter that value takes. */
export function parseEditorialDirective(value: unknown, where: string, allowExcerpt = false): Readonly<EditorialDirective> {
  assertDomain(isRecord(value) && onlyKeys(value, allowExcerpt ? ['id', 'kind', 'value', 'param', 'excerpt'] : ['id', 'kind', 'value', 'param']), 'INVALID_ARGUMENT', `${where}: directive is malformed`)
  const { id, kind, value: directiveValue, param } = value
  assertDomain(typeof id === 'string' && MAX_ID.test(id), 'INVALID_ARGUMENT', `${where}: directive id is invalid`)
  assertDomain(typeof kind === 'string' && (EDITORIAL_DIRECTIVE_KINDS as readonly string[]).includes(kind), 'INVALID_ARGUMENT', `${where}: directive kind is outside the vocabulary`)
  const entry = EDITORIAL_DIRECTIVE_VOCABULARY[kind as EditorialDirectiveKind]
  assertDomain(typeof directiveValue === 'string' && entry.values.includes(directiveValue), 'INVALID_ARGUMENT', `${where}: value of ${kind} is outside the vocabulary`)
  const paramKind = entry.params[directiveValue as string]
  if (paramKind === undefined) {
    assertDomain(param === undefined, 'INVALID_ARGUMENT', `${where}: ${kind} ${directiveValue} takes no parameter`)
  } else if (paramKind === 'seconds') {
    assertDomain(typeof param === 'number' && Number.isFinite(param) && param > 0 && param <= 30, 'INVALID_ARGUMENT', `${where}: ${kind} ${directiveValue} needs seconds between 0 and 30`)
  } else if (paramKind === 'language') {
    assertDomain(typeof param === 'string' && LANGUAGE_TAG.test(param), 'INVALID_ARGUMENT', `${where}: ${kind} ${directiveValue} needs a language tag`)
  } else {
    assertDomain(typeof param === 'string' && param.trim().length > 0 && param.length <= 200, 'INVALID_ARGUMENT', `${where}: ${kind} ${directiveValue} needs a short subject`)
  }
  return Object.freeze({ id, kind: kind as EditorialDirectiveKind, value: directiveValue as string, ...(param !== undefined ? { param: param as string | number } : {}) })
}

function parseDirectiveList(value: unknown, where: string, allowExcerpt = false): readonly Readonly<EditorialDirective>[] {
  assertDomain(Array.isArray(value) && value.length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', `${where}: directives must be a bounded list`)
  const directives = value.map((item) => parseEditorialDirective(item, where, allowExcerpt))
  assertDomain(new Set(directives.map((item) => item.id)).size === directives.length, 'INVALID_ARGUMENT', `${where}: directive ids repeat`)
  // One kind, one meaning: two directives of a kind that disagree are a question for the requester, never a pick made here.
  const byKind = new Map<string, string>()
  for (const directive of directives) {
    const meaning = `${directive.value}\u0000${String(directive.param ?? '')}`
    assertDomain(!byKind.has(directive.kind) || byKind.get(directive.kind) === meaning || directive.kind === 'keep' || directive.kind === 'avoid', 'INVALID_ARGUMENT', `${where}: two directives disagree about ${directive.kind}; that is a question, not a directive`)
    byKind.set(directive.kind, meaning)
  }
  return Object.freeze(directives)
}

function parseExcerpt(value: unknown, briefing: string, where: string): Readonly<BriefExcerpt> {
  assertDomain(isRecord(value) && onlyKeys(value, ['start', 'end', 'text']), 'INVALID_ARGUMENT', `${where}: excerpt is malformed`)
  const { start, end, text } = value
  assertDomain(Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0 && (end as number) > (start as number) && (end as number) <= briefing.length,
    'INVALID_ARGUMENT', `${where}: excerpt offsets are outside the briefing`)
  // The citation is checked against the briefing itself, never trusted: an excerpt that is not the briefing's words is invented.
  assertDomain(typeof text === 'string' && text === briefing.slice(start as number, end as number), 'INVALID_ARGUMENT', `${where}: excerpt is not the text of the briefing at those offsets`)
  return Object.freeze({ start: start as number, end: end as number, text })
}

/** The interpretation as it is hashed: everything but its own hash. */
function interpretationBody(interpretation: Omit<BriefInterpretationV1, 'interpretationHash'>): Omit<BriefInterpretationV1, 'interpretationHash'> {
  const { interpretationHash: _ignored, ...body } = interpretation as BriefInterpretationV1
  return body
}

/**
 * Validates an interpretation against the briefing it claims to read: every directive and every unsupported item and question cites
 * the briefing's words (exact offsets and text), every directive is inside the closed vocabulary, and the hashes agree. Fail closed.
 */
export function parseBriefInterpretation(value: unknown, briefingText: string): Readonly<BriefInterpretationV1> {
  assertDomain(isRecord(value) && onlyKeys(value, ['schemaVersion', 'briefingSha256', 'interpreter', 'directives', 'unsupported', 'questions', 'interpretationHash']),
    'INVALID_ARGUMENT', 'brief interpretation is malformed')
  assertDomain(value.schemaVersion === BRIEF_INTERPRETATION_SCHEMA, 'INVALID_ARGUMENT', 'brief interpretation schema is unknown')
  assertDomain(value.briefingSha256 === sha256(briefingText), 'INVALID_ARGUMENT', 'brief interpretation was made from other text than this briefing')
  const interpreter = value.interpreter
  assertDomain(isRecord(interpreter) && onlyKeys(interpreter, ['provider', 'model', 'promptVersion']) &&
    ['provider', 'model', 'promptVersion'].every((key) => typeof interpreter[key] === 'string' && (interpreter[key] as string).length > 0 && (interpreter[key] as string).length <= 128),
  'INVALID_ARGUMENT', 'brief interpreter identity is malformed')
  assertDomain(Array.isArray(value.directives) && value.directives.length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', 'brief interpretation directives are not a bounded list')
  const plain = parseDirectiveList((value.directives as unknown[]).map((item) => {
    assertDomain(isRecord(item), 'INVALID_ARGUMENT', 'brief interpretation directive is malformed')
    return item
  }), 'brief interpretation', true)
  const directives = (value.directives as Record<string, unknown>[]).map((item, index) => Object.freeze({
    ...plain[index]!, excerpt: parseExcerpt(item.excerpt, briefingText, `directive ${plain[index]!.id}`),
  }))
  assertDomain(Array.isArray(value.unsupported) && value.unsupported.length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', 'brief interpretation unsupported list is not bounded')
  const unsupported = (value.unsupported as unknown[]).map((item) => {
    assertDomain(isRecord(item) && onlyKeys(item, ['id', 'excerpt', 'summary', 'reason']) && typeof item.id === 'string' && MAX_ID.test(item.id) &&
      typeof item.summary === 'string' && item.summary.trim().length > 0 && item.summary.length <= 500 &&
      (item.reason === 'outside-vocabulary' || item.reason === 'not-executable'), 'INVALID_ARGUMENT', 'unsupported brief item is malformed')
    return Object.freeze({ id: item.id, excerpt: parseExcerpt(item.excerpt, briefingText, `unsupported ${item.id}`), summary: item.summary, reason: item.reason })
  })
  assertDomain(Array.isArray(value.questions) && value.questions.length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', 'brief interpretation questions are not bounded')
  const questions = (value.questions as unknown[]).map((item) => {
    assertDomain(isRecord(item) && onlyKeys(item, ['id', 'question', 'excerpt', 'status', 'answer']) && typeof item.id === 'string' && MAX_ID.test(item.id) &&
      typeof item.question === 'string' && item.question.trim().length > 0 && item.question.length <= 500 &&
      (item.status === 'open' || item.status === 'answered') &&
      (item.status === 'answered' ? typeof item.answer === 'string' && item.answer.trim().length > 0 && item.answer.length <= 500 : item.answer === undefined),
    'INVALID_ARGUMENT', 'brief question is malformed')
    return Object.freeze({
      id: item.id, question: item.question, status: item.status,
      ...(item.excerpt !== undefined ? { excerpt: parseExcerpt(item.excerpt, briefingText, `question ${item.id}`) } : {}),
      ...(item.answer !== undefined ? { answer: item.answer as string } : {}),
    })
  })
  const ids = [...directives.map((item) => item.id), ...unsupported.map((item) => item.id), ...questions.map((item) => item.id)]
  assertDomain(new Set(ids).size === ids.length, 'INVALID_ARGUMENT', 'brief interpretation ids repeat')
  const body = {
    schemaVersion: BRIEF_INTERPRETATION_SCHEMA, briefingSha256: value.briefingSha256 as string,
    interpreter: Object.freeze({ provider: interpreter.provider as string, model: interpreter.model as string, promptVersion: interpreter.promptVersion as string }),
    directives: Object.freeze(directives), unsupported: Object.freeze(unsupported), questions: Object.freeze(questions),
  } as const
  assertDomain(value.interpretationHash === calculateCanonicalHash(body), 'INVALID_ARGUMENT', 'brief interpretation hash is inconsistent')
  return Object.freeze({ ...body, interpretationHash: value.interpretationHash as string })
}

/** Builds a sealed interpretation from what a model returned and the briefing it read; throws when any citation does not hold. */
export function createBriefInterpretation(input: Readonly<{
  briefingText: string
  interpreter: Readonly<{ provider: string; model: string; promptVersion: string }>
  directives: readonly Readonly<InterpretedDirective>[]
  unsupported?: readonly Readonly<UnsupportedBriefItem>[]
  questions?: readonly Readonly<BriefQuestion>[]
}>): Readonly<BriefInterpretationV1> {
  const body = {
    schemaVersion: BRIEF_INTERPRETATION_SCHEMA, briefingSha256: sha256(input.briefingText), interpreter: input.interpreter,
    directives: input.directives, unsupported: input.unsupported ?? [], questions: input.questions ?? [],
  }
  return parseBriefInterpretation({ ...JSON.parse(JSON.stringify(body)) as object, interpretationHash: calculateCanonicalHash(JSON.parse(JSON.stringify(body))) }, input.briefingText)
}

/** The hash of the request: of what the brief says (everything but `requestedRemovals` and the hash itself). */
function requestBody(request: Omit<EditorialRequestV1, 'requestHash' | 'requestedRemovals'>): unknown {
  return {
    schemaVersion: request.schemaVersion,
    briefing: request.briefing ?? null,
    objective: request.objective ?? null,
    desiredAction: request.desiredAction ?? null,
    directives: request.directives,
    variantOverrides: request.variantOverrides,
    interpretation: request.interpretation ?? null,
  }
}

export function createEditorialRequest(input: Readonly<{
  briefing?: string
  objective?: StrategicObjectiveId
  desiredAction?: Readonly<DesiredAction>
  directives?: readonly Readonly<EditorialDirective>[]
  variantOverrides?: Readonly<Record<string, readonly Readonly<EditorialDirective>[]>>
  interpretation?: unknown
  requestedRemovals?: readonly string[]
}> = {}): Readonly<EditorialRequestV1> {
  const text = input.briefing
  assertDomain(text === undefined || (typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_BRIEFING_CHARS), 'INVALID_ARGUMENT',
    'briefing must be a non-empty text of at most 10000 characters (any text is a valid briefing; an absent one is simply absent)')
  const directives = parseDirectiveList(input.directives ?? [], 'request')
  const overrides = input.variantOverrides ?? {}
  assertDomain(isRecord(overrides) && Object.keys(overrides).length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', 'variant overrides are not a bounded map')
  const variantOverrides = Object.freeze(Object.fromEntries(Object.keys(overrides).sort().map((variantId) => {
    assertDomain(MAX_ID.test(variantId), 'INVALID_ARGUMENT', 'variant override id is invalid')
    return [variantId, parseDirectiveList(overrides[variantId], `override ${variantId}`)]
  })))
  assertDomain(input.interpretation === undefined || text !== undefined, 'INVALID_ARGUMENT', 'an interpretation needs the briefing it interprets')
  const interpretation = input.interpretation === undefined ? undefined : parseBriefInterpretation(input.interpretation, text!)
  const removals = [...new Set(input.requestedRemovals ?? [])].sort()
  assertDomain(removals.length <= 32 && removals.every((id) => /^[a-z0-9][a-z0-9-]{1,63}$/.test(id)), 'INVALID_ARGUMENT', 'requested removals are invalid')
  const core = {
    schemaVersion: EDITORIAL_REQUEST_SCHEMA,
    ...(text !== undefined ? { briefing: Object.freeze({ text, sha256: sha256(text) }) } : {}),
    ...(input.objective !== undefined ? { objective: resolveStrategicObjective(input.objective).id } : {}),
    ...(input.desiredAction !== undefined ? { desiredAction: input.desiredAction } : {}),
    directives, variantOverrides,
    ...(interpretation ? { interpretation } : {}),
  } as const
  return Object.freeze({ ...core, requestedRemovals: Object.freeze(removals), requestHash: calculateCanonicalHash(requestBody(core)) })
}

/**
 * The request a Brief Snapshot states. This is the one place the request is read back from the brief, so the Director (which seals the
 * request hash into its run) and the final-export admission (which recomputes it from the Version's brief) cannot disagree.
 * `brief.editorialRequest`, when present, holds the structured part: `{ directives, variantOverrides, interpretation }`.
 */
export function deriveEditorialRequestFromBrief(brief: Readonly<Record<string, unknown>>, requestedRemovals: readonly string[] = []): Readonly<EditorialRequestV1> {
  const productionBrief = isRecord(brief.productionBrief) ? brief.productionBrief : undefined
  const ownerInput = productionBrief && isRecord(productionBrief.ownerInput) ? productionBrief.ownerInput : undefined
  const briefing = typeof ownerInput?.text === 'string' && ownerInput.text.trim().length > 0 ? ownerInput.text : undefined
  const objective = typeof brief.objective === 'string' ? resolveStrategicObjective(brief.objective).id : undefined
  const structured = isRecord(brief.editorialRequest) ? brief.editorialRequest : {}
  assertDomain(onlyKeys(structured, ['directives', 'variantOverrides', 'interpretation']), 'PERSISTENCE_CONFLICT', 'Stored editorial request is malformed')
  return createEditorialRequest({
    ...(briefing !== undefined ? { briefing } : {}),
    ...(objective !== undefined ? { objective } : {}),
    ...(objective !== undefined && brief.desiredAction !== undefined ? { desiredAction: parseDesiredAction(brief.desiredAction, objective) } : {}),
    ...(structured.directives !== undefined ? { directives: structured.directives as readonly EditorialDirective[] } : {}),
    ...(structured.variantOverrides !== undefined ? { variantOverrides: structured.variantOverrides as Record<string, readonly EditorialDirective[]> } : {}),
    ...(structured.interpretation !== undefined ? { interpretation: structured.interpretation } : {}),
    requestedRemovals,
  })
}

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
  // `overlay-whole-video` and `overlay-from-seconds` are the structured placement of the visual call to action: where the requester says it goes,
  // for a speech that shows no call to say it (they run to the end of the video; the second is counted on the video's own timeline).
  cta: Object.freeze({
    values: Object.freeze(['none', 'verbal-only', 'overlay-closing', 'overlay-at-spoken-cta', 'overlay-whole-video', 'overlay-from-seconds']),
    params: Object.freeze({ 'overlay-from-seconds': 'seconds' as const }),
  }),
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
  cta: Object.freeze(['none', 'verbal-only', 'overlay-closing', 'overlay-at-spoken-cta', 'overlay-whole-video', 'overlay-from-seconds']),
  layout: Object.freeze(['fit-with-backdrop', 'source-native']),
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

/**
 * One of the closed answers of a question whose answers the Apollo knows (the briefing says two things about one subject: which one is meant).
 * Choosing it is the owner's own statement, and it becomes the structured directive of the same revision; nothing is chosen for them.
 */
export interface BriefQuestionChoice {
  id: string
  label: string
  directive: Readonly<EditorialDirective>
}

export interface BriefQuestion {
  id: string
  question: string
  excerpt?: Readonly<BriefExcerpt>
  status: 'open' | 'answered'
  answer?: string
  /** Present only when the answers are closed; a question without choices is answered in the owner's words. */
  choices?: readonly Readonly<BriefQuestionChoice>[]
}

/** What a briefing may be said to state about itself, beyond directives: the production-brief coverage the interpreter (never a regex) answers. */
export const BRIEF_COVERAGE_TOPICS = Object.freeze(['audience', 'offer', 'tone'] as const)
export type BriefCoverageTopic = (typeof BRIEF_COVERAGE_TOPICS)[number]
export interface BriefCoverageItem {
  topic: BriefCoverageTopic
  excerpt: Readonly<BriefExcerpt>
}

export interface BriefInterpretationV1 {
  schemaVersion: typeof BRIEF_INTERPRETATION_SCHEMA
  /** SHA-256 of the exact briefing text the interpreter read: an interpretation of other text is not this briefing's. */
  briefingSha256: string
  interpreter: Readonly<{ provider: string; model: string; promptVersion: string }>
  directives: readonly Readonly<InterpretedDirective>[]
  unsupported: readonly Readonly<UnsupportedBriefItem>[]
  questions: readonly Readonly<BriefQuestion>[]
  /** The topics the briefing states, each with its words. Present only when the interpreter found one: absent is not 'false'. */
  coverage?: readonly Readonly<BriefCoverageItem>[]
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
    // An opening window is a few seconds; the second a call to action starts at is a second of the whole video.
    const maxSeconds = directiveValue === 'overlay-from-seconds' ? 3_600 : 30
    assertDomain(typeof param === 'number' && Number.isFinite(param) && param > 0 && param <= maxSeconds, 'INVALID_ARGUMENT', `${where}: ${kind} ${directiveValue} needs seconds between 0 and ${maxSeconds}`)
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

function parseQuestionChoices(value: unknown, questionId: string): readonly Readonly<BriefQuestionChoice>[] {
  assertDomain(Array.isArray(value) && value.length >= 2 && value.length <= 8, 'INVALID_ARGUMENT', `question ${questionId}: closed answers are 2 to 8 choices`)
  const choices = (value as unknown[]).map((item) => {
    assertDomain(isRecord(item) && onlyKeys(item, ['id', 'label', 'directive']) && typeof item.id === 'string' && MAX_ID.test(item.id) &&
      typeof item.label === 'string' && item.label.trim().length > 0 && item.label.length <= 200, 'INVALID_ARGUMENT', `question ${questionId}: a choice is malformed`)
    return Object.freeze({ id: item.id, label: item.label, directive: parseEditorialDirective(item.directive, `question ${questionId} choice ${item.id}`) })
  })
  assertDomain(new Set(choices.map((item) => item.id)).size === choices.length, 'INVALID_ARGUMENT', `question ${questionId}: choices repeat`)
  return Object.freeze(choices)
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

const SHA256_HEX = /^[a-f0-9]{64}$/u
const AUDIT_SIGNAL = /^[a-z][a-z0-9-]{2,63}$/u
const AUDIT_TEXT = /^[^\u0000-\u001f\u007f]{1,200}$/u
const audited = (value: unknown, nullable = false): boolean => (nullable && value === null) || (typeof value === 'string' && AUDIT_TEXT.test(value))
const auditedInteger = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * ADR-160. The audit of a reading sealed with a Command is the record of ONE call that read ONE text: it is checked against that text and that
 * interpretation, never stored as whatever a caller handed over. Exact fields; the hash of the briefing it read is the hash of this briefing;
 * the provider, the model and the prompt version are those the interpretation names; every hash is a SHA-256; the cost and the usage are
 * numbers or an honest null. Fail closed.
 */
export function parseBriefInterpretationAudit(value: unknown, briefingText: string, interpretation: Readonly<Pick<BriefInterpretationV1, 'interpreter'>>): Readonly<Record<string, unknown>> {
  assertDomain(isRecord(value) && onlyKeys(value, ['schemaVersion', 'provider', 'model', 'resolvedModel', 'providerVersion', 'promptVersion', 'promptHash', 'inputHash',
    'modelInputHash', 'responseHash', 'usage', 'costBasis', 'costMinorUnits', 'signals', 'directivesMovedToUnsupported', 'directivesWithdrawnAsAmbiguous']),
  'INVALID_ARGUMENT', 'The audit of a reading has missing or unsupported fields')
  const audit = value as Record<string, unknown>
  assertDomain(audit.schemaVersion === 'brief-interpretation-audit/v1', 'INVALID_ARGUMENT', 'The audit of a reading has an unsupported version')
  assertDomain(audit.provider === interpretation.interpreter.provider && audit.model === interpretation.interpreter.model && audit.promptVersion === interpretation.interpreter.promptVersion,
    'INVALID_ARGUMENT', 'The audit names another provider, model or prompt than the interpretation it audits')
  assertDomain(audited(audit.provider) && audited(audit.model) && audited(audit.promptVersion) && audited(audit.resolvedModel, true) && audited(audit.providerVersion, true),
    'INVALID_ARGUMENT', 'The audit names its provider, model and versions in short plain text')
  assertDomain(audit.inputHash === sha256(briefingText), 'INVALID_ARGUMENT', 'The audit is of a reading of other words than this briefing')
  assertDomain(typeof audit.promptHash === 'string' && SHA256_HEX.test(audit.promptHash) && typeof audit.responseHash === 'string' && SHA256_HEX.test(audit.responseHash) &&
    (audit.modelInputHash === null || (typeof audit.modelInputHash === 'string' && SHA256_HEX.test(audit.modelInputHash))), 'INVALID_ARGUMENT', 'The hashes of the audit are not SHA-256')
  assertDomain(audit.usage === null || (isRecord(audit.usage) && onlyKeys(audit.usage, ['inputTokens', 'outputTokens']) && auditedInteger(audit.usage.inputTokens) && auditedInteger(audit.usage.outputTokens)),
    'INVALID_ARGUMENT', 'The usage of the audit is a count of tokens, or null')
  assertDomain(audit.costBasis === 'api-metered' || audit.costBasis === 'subscription', 'INVALID_ARGUMENT', 'The cost basis of the audit is unsupported')
  assertDomain(audit.costMinorUnits === null || (auditedInteger(audit.costMinorUnits) && audit.costBasis === 'api-metered'), 'INVALID_ARGUMENT',
    'Only a metered reading has a cost; a subscription states none')
  assertDomain(Array.isArray(audit.signals) && audit.signals.length <= 8 && audit.signals.every((item) => typeof item === 'string' && AUDIT_SIGNAL.test(item)) &&
    new Set(audit.signals).size === audit.signals.length, 'INVALID_ARGUMENT', 'The signals of the audit are a short list of facts')
  assertDomain(auditedInteger(audit.directivesMovedToUnsupported) && auditedInteger(audit.directivesWithdrawnAsAmbiguous), 'INVALID_ARGUMENT',
    'The counts of the audit are whole numbers')
  return Object.freeze({ ...audit })
}

/**
 * Validates an interpretation against the briefing it claims to read: every directive and every unsupported item and question cites
 * the briefing's words (exact offsets and text), every directive is inside the closed vocabulary, and the hashes agree. Fail closed.
 */
export function parseBriefInterpretation(value: unknown, briefingText: string): Readonly<BriefInterpretationV1> {
  assertDomain(isRecord(value) && onlyKeys(value, ['schemaVersion', 'briefingSha256', 'interpreter', 'directives', 'unsupported', 'questions', 'coverage', 'interpretationHash']),
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
    assertDomain(isRecord(item) && onlyKeys(item, ['id', 'question', 'excerpt', 'status', 'answer', 'choices']) && typeof item.id === 'string' && MAX_ID.test(item.id) &&
      typeof item.question === 'string' && item.question.trim().length > 0 && item.question.length <= 500 &&
      (item.status === 'open' || item.status === 'answered') &&
      (item.status === 'answered' ? typeof item.answer === 'string' && item.answer.trim().length > 0 && item.answer.length <= 500 : item.answer === undefined),
    'INVALID_ARGUMENT', 'brief question is malformed')
    const choices = item.choices === undefined ? undefined : parseQuestionChoices(item.choices, item.id as string)
    return Object.freeze({
      id: item.id, question: item.question, status: item.status,
      ...(item.excerpt !== undefined ? { excerpt: parseExcerpt(item.excerpt, briefingText, `question ${item.id}`) } : {}),
      ...(item.answer !== undefined ? { answer: item.answer as string } : {}),
      ...(choices !== undefined ? { choices } : {}),
    })
  })
  const ids = [...directives.map((item) => item.id), ...unsupported.map((item) => item.id), ...questions.map((item) => item.id)]
  assertDomain(new Set(ids).size === ids.length, 'INVALID_ARGUMENT', 'brief interpretation ids repeat')
  assertDomain(value.coverage === undefined || (Array.isArray(value.coverage) && value.coverage.length >= 1 && value.coverage.length <= BRIEF_COVERAGE_TOPICS.length),
    'INVALID_ARGUMENT', 'brief interpretation coverage is not a bounded, non-empty list (an interpretation that found none states no coverage)')
  const coverage = value.coverage === undefined ? undefined : (value.coverage as unknown[]).map((item) => {
    assertDomain(isRecord(item) && onlyKeys(item, ['topic', 'excerpt']) && typeof item.topic === 'string' && (BRIEF_COVERAGE_TOPICS as readonly string[]).includes(item.topic),
      'INVALID_ARGUMENT', 'brief coverage item is malformed')
    return Object.freeze({ topic: item.topic as BriefCoverageTopic, excerpt: parseExcerpt(item.excerpt, briefingText, `coverage ${item.topic}`) })
  })
  assertDomain(coverage === undefined || new Set(coverage.map((item) => item.topic)).size === coverage.length, 'INVALID_ARGUMENT', 'brief coverage topics repeat')
  const body = {
    schemaVersion: BRIEF_INTERPRETATION_SCHEMA, briefingSha256: value.briefingSha256 as string,
    interpreter: Object.freeze({ provider: interpreter.provider as string, model: interpreter.model as string, promptVersion: interpreter.promptVersion as string }),
    directives: Object.freeze(directives), unsupported: Object.freeze(unsupported), questions: Object.freeze(questions),
    // Present only when found: an interpretation that states no coverage hashes exactly as it did before coverage existed.
    ...(coverage !== undefined ? { coverage: Object.freeze(coverage) } : {}),
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
  coverage?: readonly Readonly<BriefCoverageItem>[]
}>): Readonly<BriefInterpretationV1> {
  const body = {
    schemaVersion: BRIEF_INTERPRETATION_SCHEMA, briefingSha256: sha256(input.briefingText), interpreter: input.interpreter,
    directives: input.directives, unsupported: input.unsupported ?? [], questions: input.questions ?? [],
    ...(input.coverage !== undefined && input.coverage.length > 0 ? { coverage: input.coverage } : {}),
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
  // `interpretationAudit` is the record of the interpreter's call (prompt and response hashes, cost): evidence, never part of the request.
  assertDomain(onlyKeys(structured, ['directives', 'variantOverrides', 'interpretation', 'interpretationAudit', 'revision']), 'PERSISTENCE_CONFLICT', 'Stored editorial request is malformed')
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

export const BRIEF_INTERPRETATION_REQUIRED_REASON = 'brief-interpretation-required' as const
/** A project with no output has no Version a revision can be made on: its briefing is read when it is created, and revised once it has an output. */
export const EDITORIAL_REQUEST_NEEDS_OUTPUT_REASON = 'editorial-request-needs-output' as const
/** The Director refuses a request with an unsupported item or an open question (the details name them; the reason is the published code). */
export const EDITORIAL_REQUEST_BLOCKED_REASON = 'editorial-request-blocked' as const
/** No interpreter is configured on this deployment, so a briefing with text cannot be read. */
export const BRIEF_INTERPRETER_UNAVAILABLE_REASON = 'brief-interpreter-unavailable' as const
/** An interpreter is configured but the reading was not made (timeout, abort, provider failure, a reply the Apollo refused): the briefing stays unread. */
export const BRIEF_INTERPRETATION_FAILED_REASON = 'brief-interpretation-failed' as const
/** The `reason` codes the public error envelope publishes for the editorial request (PRECONDITION_REQUIRED). */
export const EDITORIAL_REQUEST_PUBLISHED_REASONS = Object.freeze([BRIEF_INTERPRETATION_REQUIRED_REASON, EDITORIAL_REQUEST_NEEDS_OUTPUT_REASON, EDITORIAL_REQUEST_BLOCKED_REASON, BRIEF_INTERPRETER_UNAVAILABLE_REASON] as const)

/**
 * A briefing with text and no interpretation of exactly that text is NOT an empty briefing: it is a request nobody has read. The Director
 * refuses it instead of planning over it in silence; the way forward is the `revise-editorial-request` Command, which interprets the
 * briefing (and fails closed when no interpreter is configured). An interpretation of other text never reaches this point: the request
 * constructor refuses it.
 */
export function assertBriefingInterpreted(request: Readonly<EditorialRequestV1>): void {
  assertDomain(request.briefing === undefined || request.interpretation !== undefined, 'PRECONDITION_REQUIRED',
    'The briefing of this project has not been interpreted; revise the editorial request (apollo.projects.editorial-request.revise) so it is read before a plan is made',
    { reason: BRIEF_INTERPRETATION_REQUIRED_REASON, briefingSha256: request.briefing?.sha256 })
}

/**
 * The owner answers questions the interpretation left open. The answer is the owner's own statement, recorded on the question; it does not
 * become a directive by itself (a decision that must change the plan is a structured directive of the same revision). Only an OPEN question
 * of THIS interpretation can be answered, once; a question that is not there (the briefing changed, so it was read again) is not answerable.
 */
export function answerBriefQuestions(
  interpretation: Readonly<BriefInterpretationV1>,
  briefingText: string,
  answers: readonly Readonly<{ questionId: string; answer?: string; choiceId?: string }>[],
): Readonly<BriefInterpretationV1> {
  assertDomain(Array.isArray(answers) && answers.length >= 1 && answers.length <= MAX_DIRECTIVES, 'INVALID_ARGUMENT', 'answers must be a bounded, non-empty list')
  const byId = new Map<string, string>()
  for (const item of answers) {
    assertDomain(isRecord(item) && onlyKeys(item, ['questionId', 'answer', 'choiceId']) && typeof item.questionId === 'string' &&
      (typeof item.answer === 'string') !== (typeof item.choiceId === 'string'), 'INVALID_ARGUMENT', 'answer is malformed: it is the owner\'s words or one of the choices, never both')
    const question = interpretation.questions.find((candidate) => candidate.id === item.questionId)
    let answer: string
    if (typeof item.choiceId === 'string') {
      const choice = question?.choices?.find((candidate) => candidate.id === item.choiceId)
      assertDomain(choice !== undefined, 'INVALID_ARGUMENT', 'the choice is not one of the answers of this question', { questionId: item.questionId })
      answer = choice!.label
    } else {
      assertDomain(question?.choices === undefined, 'INVALID_ARGUMENT', 'this question has closed answers: choose one', { questionId: item.questionId })
      answer = (item.answer as string).replace(/\s+/gu, ' ').trim()
    }
    assertDomain(answer.length >= 1 && answer.length <= 500, 'INVALID_ARGUMENT', 'answer must contain 1 to 500 characters')
    assertDomain(!byId.has(item.questionId), 'INVALID_ARGUMENT', 'a question is answered once')
    byId.set(item.questionId, answer)
  }
  for (const id of byId.keys()) {
    const question = interpretation.questions.find((item) => item.id === id)
    assertDomain(question !== undefined && question.status === 'open', 'INVALID_ARGUMENT', 'only an open question of the current interpretation can be answered', { questionId: id })
  }
  return createBriefInterpretation({
    briefingText, interpreter: interpretation.interpreter, directives: interpretation.directives, unsupported: interpretation.unsupported,
    questions: interpretation.questions.map((question) => byId.has(question.id)
      ? Object.freeze({ ...question, status: 'answered' as const, answer: byId.get(question.id)! }) : question),
    ...(interpretation.coverage ? { coverage: interpretation.coverage } : {}),
  })
}

/**
 * The structured directives the owner's choices stand for, one per answer that chose a closed answer. Read from the interpretation that asked
 * (before the questions are marked answered), so the choice can only be one the Apollo offered.
 */
export function directivesOfChoices(
  interpretation: Readonly<BriefInterpretationV1>,
  answers: readonly Readonly<{ questionId: string; answer?: string; choiceId?: string }>[],
): readonly Readonly<EditorialDirective>[] {
  return Object.freeze(answers.flatMap((item) => {
    if (typeof item.choiceId !== 'string') return []
    const choice = interpretation.questions.find((question) => question.id === item.questionId)?.choices?.find((candidate) => candidate.id === item.choiceId)
    assertDomain(choice !== undefined, 'INVALID_ARGUMENT', 'the choice is not one of the answers of this question', { questionId: item.questionId })
    return [Object.freeze({ ...choice!.directive, id: `answer-${item.questionId}` })]
  }))
}

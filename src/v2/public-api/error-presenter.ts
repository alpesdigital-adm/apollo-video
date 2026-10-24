import type { DomainError } from '../domain/errors.ts'
import { PUBLIC_ERROR_CATALOG } from './public-error-catalog.ts'
import { EDITORIAL_REQUEST_PUBLISHED_REASONS } from '../domain/editorial-request.ts'
import { PUBLISHED_CONSUMPTION_REASONS } from '../domain/output-consumption.ts'
import { DIRECTOR_INHERITANCE_BLOCK_REASONS } from '../domain/director-run-inheritance.ts'

function boundedStrings(value: unknown, maximum: number, maximumLength = 256): string[] | null {
  if (
    !Array.isArray(value) || value.length > maximum ||
    !value.every(
      (item) => typeof item === 'string' && item.length > 0 && item.length <= maximumLength,
    )
  ) return null
  return [...new Set(value)]
}

function presentVersionConflict(value: unknown) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const conflict = value as Record<string, unknown>
  if (
    typeof conflict.currentVersionId !== 'string' || conflict.currentVersionId.length < 3 ||
    conflict.currentVersionId.length > 128 || typeof conflict.diff !== 'object' ||
    conflict.diff === null || Array.isArray(conflict.diff)
  ) return undefined
  const conflictingTargets = boundedStrings(conflict.conflictingTargets, 1024)
  if (!conflictingTargets || conflictingTargets.length === 0) return undefined
  const diff = conflict.diff as Record<string, unknown>
  const commands = boundedStrings(diff.commands, 1000, 128)
  const invalidatedArtifacts = boundedStrings(diff.invalidatedArtifacts, 1024, 128)
  if (
    !commands || !invalidatedArtifacts || typeof diff.estimatedCostDelta !== 'number' ||
    !Number.isFinite(diff.estimatedCostDelta) || Math.abs(diff.estimatedCostDelta) > 1_000_000
  ) return undefined

  const presentItems = (items: unknown) => {
    if (!Array.isArray(items) || items.length > 1000) return null
    const presented = []
    for (const item of items) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
      const candidate = item as Record<string, unknown>
      if (
        typeof candidate.commandId !== 'string' || candidate.commandId.length < 3 ||
        candidate.commandId.length > 128 || typeof candidate.target !== 'string' ||
        candidate.target.length < 1 || candidate.target.length > 256 ||
        typeof candidate.summary !== 'string' || candidate.summary.length < 1 ||
        candidate.summary.length > 500
      ) return null
      presented.push({
        commandId: candidate.commandId,
        target: candidate.target,
        summary: candidate.summary,
      })
    }
    return presented
  }
  const storyChanges = presentItems(diff.storyChanges)
  const timelineChanges = presentItems(diff.timelineChanges)
  const visualChanges = presentItems(diff.visualChanges)
  const audioChanges = presentItems(diff.audioChanges)
  const outputChanges = presentItems(diff.outputChanges)
  if (!storyChanges || !timelineChanges || !visualChanges || !audioChanges || !outputChanges) {
    return undefined
  }
  return {
    currentVersionId: conflict.currentVersionId,
    conflictingTargets,
    diff: {
      commands, storyChanges, timelineChanges, visualChanges, audioChanges, outputChanges,
      invalidatedArtifacts, estimatedCostDelta: diff.estimatedCostDelta,
    },
  }
}

/**
 * The codes whose refusal carries the version and hash that ARE current.
 *
 * A fenced write that refuses a stale base is only actionable if the caller is
 * told what to re-read. Without this the boundary replaced the domain's message
 * with the catalog's generic one and dropped `details` entirely, so a UI that
 * wanted to offer "reload and retry" had to ask the operator to guess — and the
 * precondition audit's rows, which say the refusal "carries the current pair",
 * described the domain rather than what the caller actually received.
 */
const STALE_PAIR_CODES = Object.freeze(new Set([
  'CAPTURE_SESSION_VERSION_STALE',
  'SYNC_DIAGNOSTIC_VERSION_STALE',
  'PLAYBACK_MAP_VERSION_STALE',
  'PERSISTENCE_CONFLICT',
  // VERSION_CONFLICT keeps its rich `conflict` body where a command builds one;
  // where it only carries the project version pair — every fenced project write
  // does — the pair travels as `details` beside it rather than being dropped.
  'VERSION_CONFLICT',
]))

/**
 * The pair, copied field by field and bounded field by field.
 *
 * Nothing else in `details` crosses: a domain error's details are internal, and
 * forwarding the whole object would publish whatever a future throw put in it.
 */
function presentStalePair(details: Readonly<Record<string, unknown>>) {
  const presented: Record<string, string | number> = {}
  if (
    typeof details.currentVersionId === 'string' &&
    details.currentVersionId.length > 0 && details.currentVersionId.length <= 300
  ) {
    presented.currentVersionId = details.currentVersionId
  }
  if (
    typeof details.currentVersion === 'number' &&
    Number.isSafeInteger(details.currentVersion) && details.currentVersion >= 0
  ) {
    presented.currentVersion = details.currentVersion
  }
  if (typeof details.currentHash === 'string' && /^[a-f0-9]{64}$/.test(details.currentHash)) {
    presented.currentHash = details.currentHash
  }
  // A project version names its hash `baseHash`, a derivation chain names its
  // own `hash`. Both are half of a fence and both are copied under the name the
  // caller has to send back.
  if (typeof details.currentBaseHash === 'string' && /^[a-f0-9]{64}$/.test(details.currentBaseHash)) {
    presented.currentBaseHash = details.currentBaseHash
  }
  return Object.keys(presented).length > 0 ? presented : undefined
}

/**
 * Which executable is missing, and what to set so it is not.
 *
 * `PERSISTENCE_NOT_CONFIGURED` is raised for every kind of deployment fault, so
 * most of them carry no such details and this answers `undefined` — the
 * envelope is then exactly what it was. The one that does carry them is the
 * media binary resolver, and without them the operator was told only that the
 * request could not be completed. The name of the binary and the variables that
 * name it are neither secret nor guessable; the resolver's `searched` directory
 * list is not published, because a path from the server's disk is not the
 * caller's business.
 */
function presentMissingTool(details: Readonly<Record<string, unknown>>) {
  const binary = typeof details.binary === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/.test(details.binary)
    ? details.binary
    : null
  const variables = Array.isArray(details.variables)
    ? details.variables.filter((name): name is string => typeof name === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(name))
    : []
  if (binary === null && variables.length === 0) return undefined
  return {
    ...(binary === null ? {} : { binary }),
    ...(variables.length === 0 ? {} : { variables }),
  }
}

/**
 * The closed set of reasons a precondition refusal publishes, each one a stable code a client can branch on and an operator can
 * act on. Anything else a domain throw put in `details` stays internal.
 */
const PUBLISHED_PRECONDITION_REASONS: ReadonlySet<string> = new Set([...PUBLISHED_CONSUMPTION_REASONS, ...EDITORIAL_REQUEST_PUBLISHED_REASONS])

/**
 * The reasons a subtitle sidecar refusal publishes (`SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH`), with the identifiers that let a client act on them:
 * the Version asked for, the Version whose render exists, the verdict that blocked it. Nothing else a domain throw put in `details` crosses.
 */
const PUBLISHED_SIDECAR_REASONS: ReadonlySet<string> = new Set([
  'render-blocked', 'review-missing', 'render-binding-mismatch', 'render-stale', 'override-set-mismatch', 'no-rendered-cue', 'rendered-cue-not-effective',
])
const SIDECAR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SIDECAR_REVIEW_STATUSES: ReadonlySet<string> = new Set(['blocked', 'warning-ack-required', 'ready-for-final'])

function presentSidecarMismatch(details: Readonly<Record<string, unknown>>) {
  if (typeof details.reason !== 'string' || !PUBLISHED_SIDECAR_REASONS.has(details.reason)) return undefined
  const presented: Record<string, string> = { reason: details.reason }
  for (const key of ['requestedVersionId', 'resolvedVersionId', 'renderedVersionId', 'requestedVariantId', 'resolvedVariantId', 'variantId'] as const) {
    const value = details[key]
    if (typeof value === 'string' && SIDECAR_ID.test(value)) presented[key] = value
  }
  if (typeof details.reviewStatus === 'string' && SIDECAR_REVIEW_STATUSES.has(details.reviewStatus)) presented.reviewStatus = details.reviewStatus
  if (typeof details.reviewHash === 'string' && /^[a-f0-9]{64}$/.test(details.reviewHash)) presented.reviewHash = details.reviewHash
  return presented
}

/**
 * W70 readiness. The reasons a final export refuses a Version whose Director quality it cannot inherit (`EDITORIAL_ACCEPTANCE_FAILED`):
 * the Version and Command that stopped the walk, so a client can say which exception or edit needs a new Director run.
 */
const PUBLISHED_DIRECTOR_INHERITANCE_REASONS: ReadonlySet<string> = new Set(['director-run-not-inherited', 'director-inheritance-moved'])
const PUBLISHED_INHERITANCE_BLOCKS: ReadonlySet<string> = new Set(DIRECTOR_INHERITANCE_BLOCK_REASONS)
const INHERITANCE_COMMAND_TYPE = /^[a-z][a-z0-9-]{1,79}$/

function presentDirectorInheritanceRefusal(details: Readonly<Record<string, unknown>>) {
  if (typeof details.reason !== 'string' || !PUBLISHED_DIRECTOR_INHERITANCE_REASONS.has(details.reason)) return undefined
  const presented: Record<string, string> = { reason: details.reason }
  if (typeof details.inheritanceReason === 'string' && PUBLISHED_INHERITANCE_BLOCKS.has(details.inheritanceReason)) presented.inheritanceReason = details.inheritanceReason
  for (const key of ['versionId', 'commandId'] as const) {
    const value = details[key]
    if (typeof value === 'string' && SIDECAR_ID.test(value)) presented[key] = value
  }
  if (typeof details.commandType === 'string' && INHERITANCE_COMMAND_TYPE.test(details.commandType)) presented.commandType = details.commandType
  return presented
}

/** A sentence the Apollo wrote for the owner: plain text of bounded length, with nothing a control character could carry. */
function plainSentence(value: unknown, max = 600): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u0008\u000e-\u001f\u007f]/u.test(value) ? value : undefined
}

const BLOCKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

const second = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

/**
 * The passages of a cut to confirm, as the owner is shown them: the whole text, the mentions that anchor each, the limits within which its start and end may be
 * moved and the segments around it to move them by. Anything out of shape is left out (a passage that cannot be shown whole is not offered).
 */
function presentRemovalPassages(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const passages = value.slice(0, 64).flatMap((item) => {
    const passage = item as Record<string, unknown> | null
    const limits = passage?.limits as Record<string, unknown> | undefined
    if (!passage || typeof passage.id !== 'string' || !BLOCKER_ID.test(passage.id) || !second(passage.startSeconds) || !second(passage.endSeconds) ||
      !plainSentence(passage.text, 20_000) || !limits || !second(limits.earliestStartSeconds) || !second(limits.latestEndSeconds) ||
      !Array.isArray(passage.mentions) || !Array.isArray(passage.segments) || !['sentence', 'segment', 'word'].includes(passage.boundary as string)) return []
    const mentions = passage.mentions.slice(0, 256).flatMap((mention) => {
      const entry = mention as Record<string, unknown> | null
      return entry && second(entry.startSeconds) && second(entry.endSeconds) && plainSentence(entry.text, 300)
        ? [{ startSeconds: entry.startSeconds, endSeconds: entry.endSeconds, text: entry.text }] : []
    })
    const segments = passage.segments.slice(0, 512).flatMap((segment) => {
      const entry = segment as Record<string, unknown> | null
      return entry && Number.isSafeInteger(entry.id) && second(entry.startSeconds) && second(entry.endSeconds) && plainSentence(entry.text, 2_000) && typeof entry.inPassage === 'boolean'
        ? [{ id: entry.id, startSeconds: entry.startSeconds, endSeconds: entry.endSeconds, text: entry.text, inPassage: entry.inPassage }] : []
    })
    return [{
      id: passage.id, startSeconds: passage.startSeconds, endSeconds: passage.endSeconds, text: passage.text, mentions, boundary: passage.boundary,
      limits: { earliestStartSeconds: limits.earliestStartSeconds, latestEndSeconds: limits.latestEndSeconds }, segments,
    }]
  })
  return passages.length === value.length ? passages : undefined
}

function presentRemovalSearch(value: unknown) {
  const search = value as Record<string, unknown> | null | undefined
  const policy = search?.policy as Record<string, unknown> | undefined
  if (!search || (search.matching !== 'stem' && search.matching !== 'literal') || !policy || !plainSentence(policy.name, 100) || !second(policy.maxGapSeconds) ||
    !second(policy.maxGapSentences) || !second(policy.maxSentenceSeconds)) return undefined
  return {
    matching: search.matching,
    language: plainSentence(search.language, 35) ?? null,
    lexicon: plainSentence(search.lexicon, 60) ?? null,
    ...(plainSentence(search.notice, 600) ? { notice: search.notice } : {}),
    policy: { name: policy.name, maxGapSeconds: policy.maxGapSeconds, maxGapSentences: policy.maxGapSentences, maxSentenceSeconds: policy.maxSentenceSeconds, origin: 'technical-search-parameter' },
  }
}

/**
 * Why the Director refused a request, in the words the Apollo wrote for the owner: what it does not do, and what it still needs to ask (the cut to
 * confirm comes with the exact rule and the stretches it would take out). Only these fields cross; anything else a domain throw carried stays internal.
 */
function presentEditorialRequestBlockers(details: Readonly<Record<string, unknown>>) {
  const blockers: Record<string, unknown>[] = []
  if (Array.isArray(details.unsupported)) {
    for (const item of details.unsupported.slice(0, 64)) {
      const record = item as Record<string, unknown> | null
      const text = plainSentence(record?.summary)
      if (record && typeof record.directiveId === 'string' && BLOCKER_ID.test(record.directiveId) && text) blockers.push({ kind: 'unsupported', id: record.directiveId, text })
    }
  }
  if (Array.isArray(details.openQuestions)) {
    for (const item of details.openQuestions.slice(0, 64)) {
      const record = item as Record<string, unknown> | null
      const text = plainSentence(record?.question, 2_000)
      if (!record || typeof record.id !== 'string' || !BLOCKER_ID.test(record.id) || !text) continue
      const removal = record.removal as Record<string, unknown> | undefined
      const matches = Array.isArray(removal?.matches) ? (removal!.matches as unknown[]).slice(0, 64).flatMap((match) => {
        const entry = match as Record<string, unknown> | null
        return entry && Number.isFinite(entry.startSeconds) && Number.isFinite(entry.endSeconds) && plainSentence(entry.text, 300)
          ? [{ startSeconds: entry.startSeconds, endSeconds: entry.endSeconds, text: entry.text }] : []
      }) : undefined
      const alternatives = Array.isArray(removal?.alternatives) ? (removal!.alternatives as unknown[]).slice(0, 8).flatMap((word) => plainSentence(word, 200) ? [word] : []) : undefined
      blockers.push({
        kind: 'question', id: record.id, text,
        ...(removal && typeof removal.ruleId === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(removal.ruleId) && plainSentence(removal.label, 200) && matches && alternatives
          ? { removal: {
            ruleId: removal.ruleId, label: removal.label, alternatives, matches,
            ...(presentRemovalPassages(removal.passages) ? { passages: presentRemovalPassages(removal.passages) } : {}),
            ...(presentRemovalSearch(removal.search) ? { search: presentRemovalSearch(removal.search) } : {}),
            ...(plainSentence(removal.subject, 200) ? { subject: removal.subject } : {}),
            ...(typeof removal.sourceTranscriptId === 'string' && BLOCKER_ID.test(removal.sourceTranscriptId) ? { sourceTranscriptId: removal.sourceTranscriptId } : {}),
          } } : {}),
      })
    }
  }
  return blockers.length > 0 ? blockers : undefined
}

function presentPreconditionReason(details: Readonly<Record<string, unknown>>) {
  if (typeof details.reason !== 'string' || !PUBLISHED_PRECONDITION_REASONS.has(details.reason)) return undefined
  if (details.reason === 'editorial-request-blocked') {
    const blockers = presentEditorialRequestBlockers(details)
    return blockers ? { reason: details.reason, blockers } : { reason: details.reason }
  }
  if ((details.reason === 'reframe-plan-required' || details.reason === 'output-not-produced') && typeof details.variantId === 'string' && BLOCKER_ID.test(details.variantId)) {
    return { reason: details.reason, variantId: details.variantId }
  }
  return { reason: details.reason }
}

export function presentPublicDomainError(error: DomainError, requestId: string) {
  const descriptor = PUBLIC_ERROR_CATALOG[error.code]
  const details =
    error.code === 'AUTH_SCOPE_REQUIRED'
      ? { requiredScope: error.details.requiredScope }
      : error.code === 'PERSISTENCE_NOT_CONFIGURED'
        ? presentMissingTool(error.details)
        : error.code === 'PRECONDITION_REQUIRED' || error.code === 'RENDER_OUTPUT_INVALID'
          ? presentPreconditionReason(error.details)
          : STALE_PAIR_CODES.has(error.code)
            ? presentStalePair(error.details)
            : error.code === 'SUBTITLE_SIDECAR_ALIGNMENT_MISMATCH'
              ? presentSidecarMismatch(error.details)
              : error.code === 'EDITORIAL_ACCEPTANCE_FAILED'
                ? presentDirectorInheritanceRefusal(error.details)
                : undefined
  const conflict =
    error.code === 'VERSION_CONFLICT'
      ? presentVersionConflict(error.details.conflict)
      : undefined
  return {
    error: {
      code: error.code,
      message: descriptor.message,
      category: descriptor.category,
      retryable: descriptor.retryable,
      requestId,
      ...(details ? { details } : {}),
      ...(conflict ? { conflict } : {}),
    },
  }
}

import type { DomainError } from '../domain/errors.ts'
import { PUBLIC_ERROR_CATALOG } from './public-error-catalog.ts'

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

export function presentPublicDomainError(error: DomainError, requestId: string) {
  const descriptor = PUBLIC_ERROR_CATALOG[error.code]
  const details =
    error.code === 'AUTH_SCOPE_REQUIRED'
      ? { requiredScope: error.details.requiredScope }
      : error.code === 'PERSISTENCE_NOT_CONFIGURED'
        ? presentMissingTool(error.details)
        : STALE_PAIR_CODES.has(error.code)
          ? presentStalePair(error.details)
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

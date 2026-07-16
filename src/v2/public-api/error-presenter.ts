import type { DomainError } from '../domain/errors.ts'

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

export function presentPublicDomainError(error: DomainError, requestId: string, status: number) {
  const details =
    error.code === 'AUTH_SCOPE_REQUIRED'
      ? { requiredScope: error.details.requiredScope }
      : undefined
  const conflict =
    error.code === 'VERSION_CONFLICT'
      ? presentVersionConflict(error.details.conflict)
      : undefined
  return {
    error: {
      code: error.code,
      message: error.message,
      category:
        status === 401 || status === 403
          ? 'auth'
          : status === 409 || status === 412
            ? 'conflict'
            : status >= 500
              ? 'internal'
              : 'validation',
      retryable: error.code === 'WEBHOOK_CHALLENGE_TRANSPORT_FAILED',
      requestId,
      ...(details ? { details } : {}),
      ...(conflict ? { conflict } : {}),
    },
  }
}

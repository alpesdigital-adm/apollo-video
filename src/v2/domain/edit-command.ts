import { assertDomain, DomainError } from './errors.ts'
import type { ProjectVersion } from './project-version.ts'

export type CommandActorType = 'user' | 'director' | 'system' | 'api-client'

export interface CommandActor {
  type: CommandActorType
  id: string
  delegatedUserId?: string
}
export interface EditScope {
  project?: true
  storyBlockId?: string
  trackId?: string
  clipIds?: string[]
  frameRange?: { startFrame: number; endFrame: number }
  locale?: string
  outputSpecIds?: string[]
  applyToAllFormats?: boolean
  applyToAllLocales?: boolean
  recipeIds?: string[]
}

export interface EditCommand<TPayload = unknown> {
  schemaVersion: 1
  id: string
  workspaceId: string
  projectId: string
  baseVersionId: string
  baseHash: string
  author: Readonly<CommandActor>
  type: string
  scope: Readonly<EditScope>
  payload: TPayload
  reason?: string
  idempotencyKey: string
  createdAt: string
}

export type EditCommandInput<TPayload = unknown> = Omit<EditCommand<TPayload>, 'schemaVersion'>

export const SEMANTIC_DIFF_CATEGORIES = [
  'story',
  'timeline',
  'visual',
  'audio',
  'output',
] as const
export type SemanticDiffCategory = (typeof SEMANTIC_DIFF_CATEGORIES)[number]

export interface SemanticDiffItem {
  commandId: string
  target: string
  summary: string
}

export interface InterveningEdit {
  versionId: string
  parentVersionId: string
  sequence: number
  commandId: string
  scope: Readonly<EditScope>
  changes: readonly Readonly<{
    category: SemanticDiffCategory
    target: string
    summary: string
  }>[]
  invalidatedArtifacts?: readonly string[]
  estimatedCostDelta?: number
}

export interface VersionDiff {
  commands: readonly string[]
  storyChanges: readonly Readonly<SemanticDiffItem>[]
  timelineChanges: readonly Readonly<SemanticDiffItem>[]
  visualChanges: readonly Readonly<SemanticDiffItem>[]
  audioChanges: readonly Readonly<SemanticDiffItem>[]
  outputChanges: readonly Readonly<SemanticDiffItem>[]
  invalidatedArtifacts: readonly string[]
  estimatedCostDelta: number
}

export type EditConcurrencyResolution<TPayload = unknown> =
  | Readonly<{
      status: 'exact-base'
      command: Readonly<EditCommand<TPayload>>
      currentVersionId: string
      diff: Readonly<VersionDiff>
    }>
  | Readonly<{
      status: 'auto-rebase'
      command: Readonly<EditCommand<TPayload>>
      previousBaseVersionId: string
      currentVersionId: string
      diff: Readonly<VersionDiff>
    }>
  | Readonly<{
      status: 'conflict'
      currentVersionId: string
      conflictingTargets: readonly string[]
      diff: Readonly<VersionDiff>
    }>

function nonEmptyUnique(values: string[] | undefined, field: string): void {
  if (!values) return
  assertDomain(values.length > 0, 'INVALID_SCOPE', `${field} cannot be empty`)
  assertDomain(
    values.every((value) => value.trim().length > 0),
    'INVALID_SCOPE',
    `${field} cannot contain empty identifiers`,
  )
  assertDomain(
    new Set(values).size === values.length,
    'INVALID_SCOPE',
    `${field} cannot contain duplicates`,
  )
}

export function validateEditScope(scope: EditScope): void {
  nonEmptyUnique(scope.clipIds, 'clipIds')
  nonEmptyUnique(scope.outputSpecIds, 'outputSpecIds')
  nonEmptyUnique(scope.recipeIds, 'recipeIds')

  if (scope.frameRange) {
    assertDomain(
      Number.isInteger(scope.frameRange.startFrame) && scope.frameRange.startFrame >= 0,
      'INVALID_SCOPE',
      'frameRange.startFrame must be a non-negative integer',
    )
    assertDomain(
      Number.isInteger(scope.frameRange.endFrame) &&
        scope.frameRange.endFrame > scope.frameRange.startFrame,
      'INVALID_SCOPE',
      'frameRange.endFrame must be greater than startFrame',
    )
  }

  assertDomain(
    !(scope.applyToAllFormats && scope.outputSpecIds),
    'INVALID_SCOPE',
    'applyToAllFormats cannot be combined with outputSpecIds',
  )
  assertDomain(
    !(scope.applyToAllLocales && scope.locale),
    'INVALID_SCOPE',
    'applyToAllLocales cannot be combined with locale',
  )

  const specificTargets = [
    scope.storyBlockId,
    scope.trackId,
    scope.clipIds,
    scope.frameRange,
    scope.locale,
    scope.outputSpecIds,
    scope.applyToAllFormats,
    scope.applyToAllLocales,
    scope.recipeIds,
  ].some(Boolean)

  assertDomain(
    Boolean(scope.project) || specificTargets,
    'INVALID_SCOPE',
    'Command scope cannot be empty',
  )
  assertDomain(
    !(scope.project && specificTargets),
    'INVALID_SCOPE',
    'Project-wide scope cannot be combined with specific targets',
  )
}

export function createEditCommand<TPayload>(
  input: EditCommandInput<TPayload>,
): Readonly<EditCommand<TPayload>> {
  for (const [field, value] of Object.entries({
    id: input.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    baseVersionId: input.baseVersionId,
    baseHash: input.baseHash,
    type: input.type,
    idempotencyKey: input.idempotencyKey,
    authorId: input.author.id,
  })) {
    assertDomain(value.trim().length > 0, 'INVALID_COMMAND', `${field} is required`, { field })
  }

  assertDomain(
    input.idempotencyKey.length <= 128,
    'INVALID_COMMAND',
    'idempotencyKey cannot exceed 128 characters',
  )
  assertDomain(
    !Number.isNaN(Date.parse(input.createdAt)),
    'INVALID_COMMAND',
    'createdAt must be an ISO-compatible date',
  )
  validateEditScope(input.scope)

  return Object.freeze({
    ...input,
    schemaVersion: 1 as const,
    author: Object.freeze({ ...input.author }),
    scope: Object.freeze({
      ...input.scope,
      clipIds: input.scope.clipIds ? Object.freeze([...input.scope.clipIds]) : undefined,
      outputSpecIds: input.scope.outputSpecIds
        ? Object.freeze([...input.scope.outputSpecIds])
        : undefined,
      recipeIds: input.scope.recipeIds ? Object.freeze([...input.scope.recipeIds]) : undefined,
      frameRange: input.scope.frameRange
        ? Object.freeze({ ...input.scope.frameRange })
        : undefined,
    }),
  }) as Readonly<EditCommand<TPayload>>
}

function intersects(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  if (!left || !right) return undefined
  const rightValues = new Set(right)
  return left.filter((value) => rightValues.has(value)).sort()
}

function disjoint(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  const shared = intersects(left, right)
  return shared !== undefined && shared.length === 0
}

function scopesOverlap(left: EditScope, right: EditScope): readonly string[] {
  if (left.project || right.project) return Object.freeze(['project:*'])

  if (
    (left.storyBlockId && right.storyBlockId && left.storyBlockId !== right.storyBlockId) ||
    (left.trackId && right.trackId && left.trackId !== right.trackId) ||
    disjoint(left.clipIds, right.clipIds) ||
    (left.locale && right.locale && left.locale !== right.locale) ||
    disjoint(left.outputSpecIds, right.outputSpecIds) ||
    disjoint(left.recipeIds, right.recipeIds) ||
    (left.frameRange &&
      right.frameRange &&
      (left.frameRange.endFrame <= right.frameRange.startFrame ||
        right.frameRange.endFrame <= left.frameRange.startFrame))
  ) {
    return Object.freeze([])
  }

  const targets: string[] = []
  if (left.storyBlockId && left.storyBlockId === right.storyBlockId) {
    targets.push(`story-block:${left.storyBlockId}`)
  }
  if (left.trackId && left.trackId === right.trackId) targets.push(`track:${left.trackId}`)
  for (const clipId of intersects(left.clipIds, right.clipIds) ?? []) {
    targets.push(`clip:${clipId}`)
  }
  if (left.frameRange && right.frameRange) {
    targets.push(
      `frames:${Math.max(left.frameRange.startFrame, right.frameRange.startFrame)}-` +
        `${Math.min(left.frameRange.endFrame, right.frameRange.endFrame)}`,
    )
  }
  if (left.locale && left.locale === right.locale) targets.push(`locale:${left.locale}`)
  for (const outputSpecId of intersects(left.outputSpecIds, right.outputSpecIds) ?? []) {
    targets.push(`output-spec:${outputSpecId}`)
  }
  for (const recipeId of intersects(left.recipeIds, right.recipeIds) ?? []) {
    targets.push(`recipe:${recipeId}`)
  }
  if (
    (left.applyToAllFormats && (right.applyToAllFormats || right.outputSpecIds)) ||
    (right.applyToAllFormats && left.outputSpecIds)
  ) {
    targets.push('output-spec:*')
  }
  if (
    (left.applyToAllLocales && (right.applyToAllLocales || right.locale)) ||
    (right.applyToAllLocales && left.locale)
  ) {
    targets.push('locale:*')
  }
  if (targets.length === 0) targets.push('scope:intersection')
  return Object.freeze([...new Set(targets)].sort())
}

function validateInterveningEdit(edit: InterveningEdit): void {
  for (const [field, value] of Object.entries({
    versionId: edit.versionId,
    parentVersionId: edit.parentVersionId,
    commandId: edit.commandId,
  })) {
    assertDomain(
      value.trim().length > 0 && value.length <= 128,
      'INVALID_COMMAND',
      `Intervening ${field} is invalid`,
    )
  }
  assertDomain(
    Number.isSafeInteger(edit.sequence) && edit.sequence >= 2,
    'INVALID_COMMAND',
    'Intervening version sequence is invalid',
  )
  validateEditScope(edit.scope)
  assertDomain(
    edit.changes.length > 0 && edit.changes.length <= 256,
    'INVALID_COMMAND',
    'Intervening semantic changes must be bounded and non-empty',
  )
  for (const change of edit.changes) {
    assertDomain(
      SEMANTIC_DIFF_CATEGORIES.includes(change.category) &&
        change.target.trim().length > 0 &&
        change.target.length <= 256 &&
        change.summary.trim().length > 0 &&
        change.summary.length <= 500,
      'INVALID_COMMAND',
      'Intervening semantic change is invalid',
    )
  }
  assertDomain(
    (edit.invalidatedArtifacts?.length ?? 0) <= 1024 &&
      (edit.invalidatedArtifacts ?? []).every(
        (artifactId) => artifactId.trim().length > 0 && artifactId.length <= 128,
      ),
    'INVALID_COMMAND',
    'Intervening invalidated artifacts are invalid',
  )
  assertDomain(
    edit.estimatedCostDelta === undefined ||
      (Number.isFinite(edit.estimatedCostDelta) && Math.abs(edit.estimatedCostDelta) <= 1_000_000),
    'INVALID_COMMAND',
    'Intervening cost delta is invalid',
  )
}

function buildVersionDiff(interveningEdits: readonly InterveningEdit[]): Readonly<VersionDiff> {
  const groups: Record<SemanticDiffCategory, SemanticDiffItem[]> = {
    story: [], timeline: [], visual: [], audio: [], output: [],
  }
  const commands: string[] = []
  const invalidatedArtifacts: string[] = []
  let estimatedCostDelta = 0
  for (const edit of interveningEdits) {
    commands.push(edit.commandId)
    invalidatedArtifacts.push(...(edit.invalidatedArtifacts ?? []))
    estimatedCostDelta += edit.estimatedCostDelta ?? 0
    for (const change of edit.changes) {
      groups[change.category].push(Object.freeze({
        commandId: edit.commandId,
        target: change.target.trim(),
        summary: change.summary.trim(),
      }))
    }
  }
  assertDomain(
    Number.isFinite(estimatedCostDelta) && Math.abs(estimatedCostDelta) <= 1_000_000,
    'INVALID_COMMAND',
    'Aggregated semantic diff cost delta is invalid',
  )
  return Object.freeze({
    commands: Object.freeze([...new Set(commands)]),
    storyChanges: Object.freeze(groups.story),
    timelineChanges: Object.freeze(groups.timeline),
    visualChanges: Object.freeze(groups.visual),
    audioChanges: Object.freeze(groups.audio),
    outputChanges: Object.freeze(groups.output),
    invalidatedArtifacts: Object.freeze([...new Set(invalidatedArtifacts)].sort()),
    estimatedCostDelta,
  })
}

export function resolveEditCommandConcurrency<TPayload>(input: {
  command: Readonly<EditCommand<TPayload>>
  baseVersion: Readonly<ProjectVersion>
  currentVersion: Readonly<ProjectVersion>
  interveningEdits: readonly Readonly<InterveningEdit>[]
}): EditConcurrencyResolution<TPayload> {
  assertCommandMatchesVersion(input.command, input.baseVersion)
  assertDomain(
    input.currentVersion.workspaceId === input.command.workspaceId &&
      input.currentVersion.projectId === input.command.projectId &&
      input.currentVersion.sequence >= input.baseVersion.sequence,
    'INVALID_COMMAND',
    'Current version is outside the command project or precedes its base',
  )

  if (input.currentVersion.id === input.baseVersion.id) {
    assertDomain(
      input.currentVersion.sequence === input.baseVersion.sequence &&
        input.currentVersion.baseHash === input.baseVersion.baseHash,
      'PERSISTENCE_CONFLICT',
      'Exact version identity has inconsistent immutable state',
    )
    return Object.freeze({
      status: 'exact-base' as const,
      command: input.command,
      currentVersionId: input.currentVersion.id,
      diff: buildVersionDiff([]),
    })
  }

  const edits = [...input.interveningEdits].sort((left, right) => left.sequence - right.sequence)
  for (const edit of edits) validateInterveningEdit(edit)
  const sequenceDelta = input.currentVersion.sequence - input.baseVersion.sequence
  assertDomain(
    Number.isSafeInteger(sequenceDelta) && sequenceDelta >= 1 && sequenceDelta <= 1000,
    'PERSISTENCE_CONFLICT',
    'Intervening edit history exceeds the bounded rebase window',
  )
  const expectedSequences = Array.from(
    { length: sequenceDelta },
    (_, index) => input.baseVersion.sequence + index + 1,
  )
  assertDomain(
    edits.map((edit) => edit.sequence).join(',') === expectedSequences.join(','),
    'PERSISTENCE_CONFLICT',
    'Intervening edit history is incomplete',
  )
  assertDomain(
    edits.at(-1)?.versionId === input.currentVersion.id,
    'PERSISTENCE_CONFLICT',
    'Intervening edit history does not reach the current version',
  )
  let expectedParentVersionId = input.baseVersion.id
  for (const edit of edits) {
    assertDomain(
      edit.parentVersionId === expectedParentVersionId,
      'PERSISTENCE_CONFLICT',
      'Intervening edit history is not a continuous version chain',
    )
    expectedParentVersionId = edit.versionId
  }
  assertDomain(
    input.currentVersion.parentVersionId === edits.at(-1)?.parentVersionId,
    'PERSISTENCE_CONFLICT',
    'Current version parent does not match intervening history',
  )

  const diff = buildVersionDiff(edits)
  const conflictingTargets = edits.flatMap((edit) =>
    scopesOverlap(input.command.scope, edit.scope),
  )
  if (conflictingTargets.length > 0) {
    return Object.freeze({
      status: 'conflict' as const,
      currentVersionId: input.currentVersion.id,
      conflictingTargets: Object.freeze([...new Set(conflictingTargets)].sort()),
      diff,
    })
  }

  return Object.freeze({
    status: 'auto-rebase' as const,
    previousBaseVersionId: input.command.baseVersionId,
    currentVersionId: input.currentVersion.id,
    command: Object.freeze({
      ...input.command,
      baseVersionId: input.currentVersion.id,
      baseHash: input.currentVersion.baseHash,
    }),
    diff,
  })
}

export function requireResolvedEditCommand<TPayload>(
  resolution: EditConcurrencyResolution<TPayload>,
): Readonly<EditCommand<TPayload>> {
  if (resolution.status === 'conflict') {
    throw new DomainError('VERSION_CONFLICT', 'Command targets changed since its base version', {
      conflict: {
        currentVersionId: resolution.currentVersionId,
        conflictingTargets: resolution.conflictingTargets,
        diff: resolution.diff,
      },
    })
  }
  return resolution.command
}

export function assertCommandMatchesVersion(
  command: EditCommand,
  currentVersion: ProjectVersion,
): void {
  assertDomain(
    command.workspaceId === currentVersion.workspaceId && command.projectId === currentVersion.projectId,
    'INVALID_COMMAND',
    'Command and ProjectVersion must belong to the same workspace and project',
  )

  if (
    command.baseVersionId !== currentVersion.id ||
    command.baseHash !== currentVersion.baseHash
  ) {
    throw new DomainError('VERSION_CONFLICT', 'Command base version is stale', {
      commandBaseVersionId: command.baseVersionId,
      currentVersionId: currentVersion.id,
      commandBaseHash: command.baseHash,
      currentBaseHash: currentVersion.baseHash,
    })
  }
}

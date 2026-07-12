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

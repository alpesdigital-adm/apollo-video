import type {
  CreateCompatibilityGraphRequest,
} from '../application/compatibility-graphs.ts'
import type {
  CompatibilityClaim,
  CompatibilityGraphRun,
  CompatibilityNodeContextInput,
} from '../domain/compatibility-graph.ts'
import { DomainError } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be an object`,
    )
  }
  return value as Record<string, unknown>
}

function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
) {
  const unknown = Object.keys(value).filter((key) =>
    !allowed.includes(key))
  if (unknown.length > 0) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} contains unknown fields`,
      { fields: unknown },
    )
  }
}

function string(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < minimum ||
    value.trim().length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} characters`,
    )
  }
  return value.trim()
}

function array(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > maximum
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must contain ${minimum} to ${maximum} entries`,
    )
  }
  return value
}

function unit(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be between 0 and 1`,
    )
  }
  return value
}

function threshold(value: unknown, field: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      `${field} must be between 0 and 100`,
    )
  }
  return value
}

function tokens(
  value: unknown,
  field: string,
  minimum = 0,
  maximum = 100,
): readonly string[] {
  return Object.freeze(
    array(value, field, minimum, maximum).map((entry, index) =>
      string(entry, `${field}[${index}]`, 3, 128)),
  )
}

function parseClaims(
  value: unknown,
  field: string,
): readonly Readonly<CompatibilityClaim>[] {
  return Object.freeze(array(value, field, 0, 100).map((entry, index) => {
    const claimField = `${field}[${index}]`
    const claim = record(entry, claimField)
    exactFields(claim, ['key', 'value'], claimField)
    return Object.freeze({
      key: string(claim.key, `${claimField}.key`, 3, 128),
      value: string(claim.value, `${claimField}.value`, 1, 500),
    })
  }))
}

function parseContext(
  value: unknown,
  index: number,
): Readonly<CompatibilityNodeContextInput> {
  const field = `contexts[${index}]`
  const context = record(value, field)
  exactFields(
    context,
    [
      'takeId',
      'expectedTakeHash',
      'offerId',
      'audienceTags',
      'claims',
      'personaId',
      'locale',
      'desiredAction',
      'continuityProvides',
      'continuityRequires',
      'narrativeTags',
      'tone',
      'energy',
      'visual',
      'experiment',
      'evidenceRefs',
    ],
    field,
  )
  return Object.freeze({
    takeId: string(context.takeId, `${field}.takeId`, 3, 128),
    expectedTakeHash: string(
      context.expectedTakeHash,
      `${field}.expectedTakeHash`,
      64,
      64,
    ),
    offerId: string(context.offerId, `${field}.offerId`, 3, 128),
    audienceTags: tokens(
      context.audienceTags,
      `${field}.audienceTags`,
      1,
    ),
    claims: parseClaims(context.claims, `${field}.claims`),
    personaId: string(
      context.personaId,
      `${field}.personaId`,
      3,
      128,
    ),
    locale: string(context.locale, `${field}.locale`, 2, 16),
    ...(context.desiredAction !== undefined
      ? {
          desiredAction: string(
            context.desiredAction,
            `${field}.desiredAction`,
            3,
            128,
          ),
        }
      : {}),
    continuityProvides: tokens(
      context.continuityProvides,
      `${field}.continuityProvides`,
    ),
    continuityRequires: tokens(
      context.continuityRequires,
      `${field}.continuityRequires`,
    ),
    narrativeTags: tokens(
      context.narrativeTags,
      `${field}.narrativeTags`,
      1,
    ),
    tone: unit(context.tone, `${field}.tone`),
    energy: unit(context.energy, `${field}.energy`),
    visual: unit(context.visual, `${field}.visual`),
    experiment: unit(
      context.experiment,
      `${field}.experiment`,
    ),
    evidenceRefs: tokens(
      context.evidenceRefs,
      `${field}.evidenceRefs`,
      1,
    ),
  })
}

export function parseCreateCompatibilityGraphBody(
  raw: unknown,
): Omit<
  CreateCompatibilityGraphRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
> {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'takeLibraryId',
      'expectedTakeLibraryRunHash',
      'contexts',
      'acceptThreshold',
      'reviewThreshold',
    ],
    'body',
  )
  return Object.freeze({
    takeLibraryId: string(
      body.takeLibraryId,
      'takeLibraryId',
      3,
      128,
    ),
    expectedTakeLibraryRunHash: string(
      body.expectedTakeLibraryRunHash,
      'expectedTakeLibraryRunHash',
      64,
      64,
    ),
    contexts: Object.freeze(
      array(body.contexts, 'contexts', 2, 2_000)
        .map(parseContext),
    ),
    ...(body.acceptThreshold !== undefined
      ? {
          acceptThreshold: threshold(
            body.acceptThreshold,
            'acceptThreshold',
          ),
        }
      : {}),
    ...(body.reviewThreshold !== undefined
      ? {
          reviewThreshold: threshold(
            body.reviewThreshold,
            'reviewThreshold',
          ),
        }
      : {}),
  })
}

export function presentCompatibilityGraph(
  run: Readonly<CompatibilityGraphRun>,
) {
  return run
}

export function presentCompatibilityGraphPage(input: {
  runs: readonly Readonly<CompatibilityGraphRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    graphs: Object.freeze(input.runs.map(presentCompatibilityGraph)),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}

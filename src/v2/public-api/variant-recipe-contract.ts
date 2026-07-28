import type {
  CreateVariantRecipeRequest,
} from '../application/variant-recipes.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  VariantRecipeAssumptionInput,
  VariantRecipeColdOpenInput,
  VariantRecipeRun,
  VariantRecipeSelectionInput,
} from '../domain/variant-recipe.ts'

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

function parseSelection(
  value: unknown,
): Readonly<VariantRecipeSelectionInput> {
  const selection = record(value, 'selection')
  exactFields(
    selection,
    ['hookNodeId', 'bodyNodeId', 'proofNodeId', 'ctaNodeId'],
    'selection',
  )
  return Object.freeze({
    hookNodeId: string(
      selection.hookNodeId,
      'selection.hookNodeId',
      3,
      128,
    ),
    bodyNodeId: string(
      selection.bodyNodeId,
      'selection.bodyNodeId',
      3,
      128,
    ),
    ...(selection.proofNodeId !== undefined
      ? {
          proofNodeId: string(
            selection.proofNodeId,
            'selection.proofNodeId',
            3,
            128,
          ),
        }
      : {}),
    ctaNodeId: string(
      selection.ctaNodeId,
      'selection.ctaNodeId',
      3,
      128,
    ),
  })
}

function parseAssumption(
  value: unknown,
  index: number,
): Readonly<VariantRecipeAssumptionInput> {
  const field = `assumptions[${index}]`
  const assumption = record(value, field)
  exactFields(
    assumption,
    ['code', 'statement', 'evidenceRefs'],
    field,
  )
  return Object.freeze({
    code: string(assumption.code, `${field}.code`, 3, 80),
    statement: string(
      assumption.statement,
      `${field}.statement`,
      3,
      500,
    ),
    evidenceRefs: Object.freeze(
      array(
        assumption.evidenceRefs,
        `${field}.evidenceRefs`,
        1,
        25,
      ).map((entry, evidenceIndex) =>
        string(
          entry,
          `${field}.evidenceRefs[${evidenceIndex}]`,
          3,
          256,
        )),
    ),
  })
}

function parseColdOpen(
  value: unknown,
): Readonly<VariantRecipeColdOpenInput> {
  const coldOpen = record(value, 'coldOpen')
  exactFields(
    coldOpen,
    ['nodeId', 'sourceRangeMs', 'returnAtRole'],
    'coldOpen',
  )
  const range = array(
    coldOpen.sourceRangeMs,
    'coldOpen.sourceRangeMs',
    2,
    2,
  )
  if (
    !range.every((entry) =>
      Number.isSafeInteger(entry) && Number(entry) >= 0) ||
    Number(range[0]) >= Number(range[1]) ||
    Number(range[1]) - Number(range[0]) > 10_000
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'coldOpen.sourceRangeMs must be an ascending integer range of at most 10000ms',
    )
  }
  if (coldOpen.returnAtRole !== 'hook') {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'coldOpen.returnAtRole must be hook',
    )
  }
  return Object.freeze({
    nodeId: string(coldOpen.nodeId, 'coldOpen.nodeId', 3, 128),
    sourceRangeMs: Object.freeze([
      Number(range[0]),
      Number(range[1]),
    ]) as readonly [number, number],
    returnAtRole: 'hook',
  })
}

export function parseCreateVariantRecipeBody(
  raw: unknown,
): Omit<
  CreateVariantRecipeRequest,
  'workspaceId' | 'batchId' | 'actor' | 'idempotencyKey'
> {
  const body = record(raw, 'body')
  exactFields(
    body,
    [
      'compatibilityGraphId',
      'expectedCompatibilityGraphRunHash',
      'selection',
      'orderedNodeIds',
      'assumptions',
      'requireProof',
      'coldOpen',
    ],
    'body',
  )
  if (
    body.requireProof !== undefined &&
    typeof body.requireProof !== 'boolean'
  ) {
    throw new DomainError(
      'INVALID_ARGUMENT',
      'requireProof must be a boolean',
    )
  }
  return Object.freeze({
    compatibilityGraphId: string(
      body.compatibilityGraphId,
      'compatibilityGraphId',
      3,
      128,
    ),
    expectedCompatibilityGraphRunHash: string(
      body.expectedCompatibilityGraphRunHash,
      'expectedCompatibilityGraphRunHash',
      64,
      64,
    ),
    selection: parseSelection(body.selection),
    orderedNodeIds: Object.freeze(
      array(body.orderedNodeIds, 'orderedNodeIds', 3, 4)
        .map((entry, index) =>
          string(entry, `orderedNodeIds[${index}]`, 3, 128)),
    ),
    ...(body.assumptions !== undefined
      ? {
          assumptions: Object.freeze(
            array(body.assumptions, 'assumptions', 0, 25)
              .map(parseAssumption),
          ),
        }
      : {}),
    ...(body.requireProof !== undefined
      ? { requireProof: body.requireProof }
      : {}),
    ...(body.coldOpen !== undefined
      ? { coldOpen: parseColdOpen(body.coldOpen) }
      : {}),
  })
}

export function presentVariantRecipe(
  run: Readonly<VariantRecipeRun>,
) {
  return run
}

export function presentVariantRecipePage(input: {
  runs: readonly Readonly<VariantRecipeRun>[]
  nextCursor?: string
}) {
  return Object.freeze({
    recipes: Object.freeze(input.runs.map(presentVariantRecipe)),
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  })
}

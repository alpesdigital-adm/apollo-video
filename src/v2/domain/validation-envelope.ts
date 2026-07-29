import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type {
  CatalogedValidatedSegment,
} from './validated-segment.ts'
import type {
  VariantRecipeRun,
  VariantRecipeSourceSegment,
} from './variant-recipe.ts'

export const VALIDATION_ENVELOPE_REUSE_SCHEMA_VERSION =
  'validation-envelope-reuse/v1' as const
export const VALIDATION_ENVELOPE_POLICY_VERSION =
  'validation-envelope-policy/v1' as const
export const VALIDATION_ENVELOPE_COMPOSITION_VERSION =
  'validation-envelope-composition/v1' as const
export const VALIDATION_ENVELOPE_DECISION_VERSION =
  'validation-envelope-decision/v1' as const

export const VALIDATION_ENVELOPE_ASPECTS = [
  'copy',
  'take',
  'framing',
  'timing',
  'opening',
] as const

export type ValidationEnvelopeAspect =
  (typeof VALIDATION_ENVELOPE_ASPECTS)[number]

export interface ValidationEnvelopeChangeRequest {
  aspect: ValidationEnvelopeAspect
  required: boolean
  rationale: string
}

export interface ValidationEnvelopeAspectRule {
  aspect: ValidationEnvelopeAspect
  state: 'protected' | 'mutable'
  source:
    | 'copy-evidence'
    | 'spoken-take-evidence'
    | 'opening-edit-evidence'
}

export interface ValidationEnvelopeCompositionClip {
  id: string
  role: 'hook' | 'body' | 'proof' | 'cta'
  source:
    | 'validated-segment-envelope'
    | 'target-variant-recipe'
  sourceArtifactId: string
  sourceHash: string
  sourceRangeMs: readonly [number, number]
  sourceSegmentId: string
  takeId?: string
  durationMs: number
}

export interface ValidationEnvelopeComposition {
  schemaVersion: typeof VALIDATION_ENVELOPE_COMPOSITION_VERSION
  clips: readonly Readonly<ValidationEnvelopeCompositionClip>[]
  orderedRoles: readonly ('hook' | 'body' | 'proof' | 'cta')[]
  includedSourceSegmentIds: readonly string[]
  excludedTargetRecipeSegmentIds: readonly string[]
  targetRecipeHookExcluded: true
  validatedSourceOutsideEnvelopeIncluded: false
  excessMaterialIncluded: false
  durationMs: number
  compositionHash: string
}

export interface ValidationEnvelopeReusePlan {
  schemaVersion: typeof VALIDATION_ENVELOPE_REUSE_SCHEMA_VERSION
  policyVersion: typeof VALIDATION_ENVELOPE_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  validatedSegmentId: string
  validatedSegmentHash: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceRangeMs: readonly [number, number]
  targetRecipeId: string
  targetRecipeHash: string
  objective: string
  aspectRules: readonly Readonly<ValidationEnvelopeAspectRule>[]
  protectedAspects: readonly ValidationEnvelopeAspect[]
  mutableAspects: readonly ValidationEnvelopeAspect[]
  requestedChanges: readonly Readonly<ValidationEnvelopeChangeRequest>[]
  autoProtectedChanges: readonly ValidationEnvelopeAspect[]
  approvalRequiredChanges: readonly ValidationEnvelopeAspect[]
  approvalRequired: boolean
  initialValidation:
    | 'preserved'
    | 'pending-approval'
  composition: Readonly<ValidationEnvelopeComposition>
  createdByClientId: string
  createdAt: string
  planHash: string
}

export interface ValidationEnvelopeDecision {
  schemaVersion: typeof VALIDATION_ENVELOPE_DECISION_VERSION
  id: string
  reusePlanId: string
  sequence: number
  kind: 'created' | 'approval'
  outcome:
    | 'ready'
    | 'approval-required'
    | 'approved'
    | 'rejected'
  validation:
    | 'preserved'
    | 'pending-approval'
    | 'lost'
  appliedChanges: readonly ValidationEnvelopeAspect[]
  blockedChanges: readonly ValidationEnvelopeAspect[]
  lostAspects: readonly ValidationEnvelopeAspect[]
  note: string
  actorClientId: string
  createdAt: string
  decisionHash: string
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function instant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical UTC instant`,
  )
  return value
}

function text(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  assertDomain(
    typeof value === 'string' &&
      value.trim().length >= minimum &&
      value.trim().length <= maximum,
    'INVALID_ARGUMENT',
    `${field} must contain ${minimum} to ${maximum} characters`,
  )
  return value.trim()
}

function uniqueAspects(
  values: readonly ValidationEnvelopeAspect[],
  field: string,
): readonly ValidationEnvelopeAspect[] {
  assertDomain(
    Array.isArray(values) &&
      values.every((value) =>
        VALIDATION_ENVELOPE_ASPECTS.includes(value)),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  assertDomain(
    new Set(values).size === values.length,
    'INVALID_ARGUMENT',
    `${field} must not contain duplicates`,
  )
  return Object.freeze([...values])
}

function evidenceProtectedAspects(
  segment: Readonly<CatalogedValidatedSegment>,
): readonly ValidationEnvelopeAspect[] {
  if (segment.scope.evidenceScope === 'copy') {
    return Object.freeze(['copy'])
  }
  if (segment.scope.evidenceScope === 'spoken-take') {
    return Object.freeze(['copy', 'take'])
  }
  return Object.freeze([
    'copy',
    'take',
    'framing',
    'timing',
    'opening',
  ])
}

function aspectRules(
  segment: Readonly<CatalogedValidatedSegment>,
): readonly Readonly<ValidationEnvelopeAspectRule>[] {
  const protectedAspects = evidenceProtectedAspects(segment)
  const source = segment.scope.evidenceScope === 'copy'
    ? 'copy-evidence'
    : segment.scope.evidenceScope === 'spoken-take'
      ? 'spoken-take-evidence'
      : 'opening-edit-evidence'
  return Object.freeze(VALIDATION_ENVELOPE_ASPECTS.map((aspect) =>
    Object.freeze({
      aspect,
      state: protectedAspects.includes(aspect)
        ? 'protected' as const
        : 'mutable' as const,
      source,
    })))
}

function primarySegment(
  recipe: Readonly<VariantRecipeRun>,
  role: 'body' | 'cta',
): Readonly<VariantRecipeSourceSegment> {
  const candidates = recipe.sourceSegments.filter((segment) =>
    segment.usage === 'primary' && segment.role === role)
  assertDomain(
    candidates.length === 1,
    'PRECONDITION_REQUIRED',
    `Target recipe must contain exactly one primary ${role}`,
  )
  return candidates[0]!
}

function optionalProof(
  recipe: Readonly<VariantRecipeRun>,
): Readonly<VariantRecipeSourceSegment> | undefined {
  const candidates = recipe.sourceSegments.filter((segment) =>
    segment.usage === 'primary' && segment.role === 'proof')
  assertDomain(
    candidates.length <= 1,
    'PRECONDITION_REQUIRED',
    'Target recipe must not contain more than one primary proof',
  )
  return candidates[0]
}

function recipeClip(
  planId: string,
  segment: Readonly<VariantRecipeSourceSegment>,
): Readonly<ValidationEnvelopeCompositionClip> {
  const role = segment.role
  assertDomain(
    ['body', 'proof', 'cta'].includes(role),
    'PRECONDITION_REQUIRED',
    'Only body, proof and CTA can be reused from the target recipe',
  )
  return Object.freeze({
    id: `validation-clip-${calculateCanonicalHash({
      planId,
      sourceSegmentId: segment.id,
    }).slice(0, 48)}`,
    role: role as 'body' | 'proof' | 'cta',
    source: 'target-variant-recipe' as const,
    sourceArtifactId: segment.sourceArtifactId,
    sourceHash: segment.sourceHash,
    sourceRangeMs: Object.freeze([
      segment.sourceRangeMs[0],
      segment.sourceRangeMs[1],
    ]) as readonly [number, number],
    sourceSegmentId: segment.id,
    takeId: segment.takeId,
    durationMs: segment.durationMs,
  })
}

function composition(
  planId: string,
  validated: Readonly<CatalogedValidatedSegment>,
  recipe: Readonly<VariantRecipeRun>,
): Readonly<ValidationEnvelopeComposition> {
  assertDomain(
    validated.scope.unit === 'hook',
    'PRECONDITION_REQUIRED',
    'Validation envelope composition requires a hook validation',
  )
  const body = primarySegment(recipe, 'body')
  const proof = optionalProof(recipe)
  const cta = primarySegment(recipe, 'cta')
  const range = validated.protectedEnvelope.sourceRangeMs
  const hook = Object.freeze({
    id: `validation-clip-${calculateCanonicalHash({
      planId,
      validatedSegmentId: validated.id,
    }).slice(0, 48)}`,
    role: 'hook' as const,
    source: 'validated-segment-envelope' as const,
    sourceArtifactId: validated.sourceArtifactId,
    sourceHash: validated.sourceArtifactSha256,
    sourceRangeMs: Object.freeze([range[0], range[1]]) as readonly [
      number,
      number,
    ],
    sourceSegmentId:
      validated.sourceSpeechSegmentId ?? validated.id,
    durationMs: range[1] - range[0],
  })
  const clips = Object.freeze([
    hook,
    recipeClip(planId, body),
    ...(proof ? [recipeClip(planId, proof)] : []),
    recipeClip(planId, cta),
  ])
  const includedIds = new Set(
    clips
      .filter((clip) => clip.source === 'target-variant-recipe')
      .map((clip) => clip.sourceSegmentId),
  )
  const excluded = Object.freeze(
    recipe.sourceSegments
      .filter((segment) => !includedIds.has(segment.id))
      .map((segment) => segment.id)
      .toSorted(),
  )
  assertDomain(
    recipe.sourceSegments.some((segment) =>
      segment.usage === 'primary' &&
      segment.role === 'hook' &&
      excluded.includes(segment.id)),
    'PRECONDITION_REQUIRED',
    'Target recipe hook must be excluded from validated hook reuse',
  )
  const bodyValue = {
    schemaVersion: VALIDATION_ENVELOPE_COMPOSITION_VERSION,
    clips,
    orderedRoles: Object.freeze(
      clips.map((clip) => clip.role),
    ),
    includedSourceSegmentIds: Object.freeze(
      clips.map((clip) => clip.sourceSegmentId),
    ),
    excludedTargetRecipeSegmentIds: excluded,
    targetRecipeHookExcluded: true as const,
    validatedSourceOutsideEnvelopeIncluded: false as const,
    excessMaterialIncluded: false as const,
    durationMs: clips.reduce((total, clip) =>
      total + clip.durationMs, 0),
  }
  return Object.freeze({
    ...bodyValue,
    compositionHash: calculateCanonicalHash(bodyValue),
  })
}

function changeRequests(
  values: readonly Readonly<ValidationEnvelopeChangeRequest>[],
): readonly Readonly<ValidationEnvelopeChangeRequest>[] {
  assertDomain(
    Array.isArray(values) && values.length <= 5,
    'INVALID_ARGUMENT',
    'requestedChanges must contain at most five entries',
  )
  const normalized = values.map((value, index) => {
    assertDomain(
      typeof value === 'object' &&
        value !== null &&
        VALIDATION_ENVELOPE_ASPECTS.includes(value.aspect) &&
        typeof value.required === 'boolean',
      'INVALID_ARGUMENT',
      `requestedChanges[${index}] is invalid`,
    )
    return Object.freeze({
      aspect: value.aspect,
      required: value.required,
      rationale: text(
        value.rationale,
        `requestedChanges[${index}].rationale`,
        3,
        500,
      ),
    })
  })
  assertDomain(
    new Set(normalized.map((change) => change.aspect)).size ===
      normalized.length,
    'INVALID_ARGUMENT',
    'requestedChanges must not contain duplicate aspects',
  )
  return Object.freeze(normalized)
}

export function createValidationEnvelopeReusePlan(input: {
  id: string
  workspaceId: string
  projectId: string
  batchId: string
  validatedSegment: Readonly<CatalogedValidatedSegment>
  targetRecipe: Readonly<VariantRecipeRun>
  requestedChanges: readonly Readonly<ValidationEnvelopeChangeRequest>[]
  createdByClientId: string
  createdAt: string
}): Readonly<ValidationEnvelopeReusePlan> {
  const id = identity(input.id, 'id')
  const workspaceId = identity(input.workspaceId, 'workspaceId')
  const projectId = identity(input.projectId, 'projectId')
  const batchId = identity(input.batchId, 'batchId')
  assertDomain(
    input.validatedSegment.workspaceId === workspaceId &&
      input.validatedSegment.projectId === projectId &&
      input.targetRecipe.workspaceId === workspaceId &&
      input.targetRecipe.projectId === projectId &&
      input.targetRecipe.batchId === batchId,
    'PRECONDITION_REQUIRED',
    'Validation source and target recipe must belong to the same project and batch scope',
  )
  const rules = aspectRules(input.validatedSegment)
  const protectedAspects = uniqueAspects(
    rules
      .filter((rule) => rule.state === 'protected')
      .map((rule) => rule.aspect),
    'protectedAspects',
  )
  const mutableAspects = uniqueAspects(
    rules
      .filter((rule) => rule.state === 'mutable')
      .map((rule) => rule.aspect),
    'mutableAspects',
  )
  const changes = changeRequests(input.requestedChanges)
  const protectedChanges = changes.filter((change) =>
    protectedAspects.includes(change.aspect))
  const autoProtectedChanges = uniqueAspects(
    protectedChanges
      .filter((change) => !change.required)
      .map((change) => change.aspect),
    'autoProtectedChanges',
  )
  const approvalRequiredChanges = uniqueAspects(
    protectedChanges
      .filter((change) => change.required)
      .map((change) => change.aspect),
    'approvalRequiredChanges',
  )
  const targetComposition = composition(
    id,
    input.validatedSegment,
    input.targetRecipe,
  )
  const createdAt = instant(input.createdAt, 'createdAt')
  const body = {
    schemaVersion: VALIDATION_ENVELOPE_REUSE_SCHEMA_VERSION,
    policyVersion: VALIDATION_ENVELOPE_POLICY_VERSION,
    id,
    workspaceId,
    projectId,
    batchId,
    validatedSegmentId: input.validatedSegment.id,
    validatedSegmentHash:
      input.validatedSegment.validatedSegmentHash,
    sourceArtifactId: input.validatedSegment.sourceArtifactId,
    sourceArtifactSha256:
      input.validatedSegment.sourceArtifactSha256,
    sourceRangeMs: Object.freeze([
      input.validatedSegment.protectedEnvelope.sourceRangeMs[0],
      input.validatedSegment.protectedEnvelope.sourceRangeMs[1],
    ]) as readonly [number, number],
    targetRecipeId: input.targetRecipe.id,
    targetRecipeHash: input.targetRecipe.runHash,
    objective: input.targetRecipe.objective,
    aspectRules: rules,
    protectedAspects,
    mutableAspects,
    requestedChanges: changes,
    autoProtectedChanges,
    approvalRequiredChanges,
    approvalRequired: approvalRequiredChanges.length > 0,
    initialValidation: approvalRequiredChanges.length > 0
      ? 'pending-approval' as const
      : 'preserved' as const,
    composition: targetComposition,
    createdByClientId: identity(
      input.createdByClientId,
      'createdByClientId',
    ),
    createdAt,
  }
  return Object.freeze({
    ...body,
    planHash: calculateCanonicalHash(body),
  })
}

function decision(
  body: Omit<ValidationEnvelopeDecision, 'decisionHash'>,
): Readonly<ValidationEnvelopeDecision> {
  return Object.freeze({
    ...body,
    decisionHash: calculateCanonicalHash(body),
  })
}

export function createInitialValidationEnvelopeDecision(input: {
  id: string
  plan: Readonly<ValidationEnvelopeReusePlan>
}): Readonly<ValidationEnvelopeDecision> {
  const mutableRequested = input.plan.requestedChanges
    .filter((change) =>
      input.plan.mutableAspects.includes(change.aspect))
    .map((change) => change.aspect)
  return decision({
    schemaVersion: VALIDATION_ENVELOPE_DECISION_VERSION,
    id: identity(input.id, 'decision.id'),
    reusePlanId: input.plan.id,
    sequence: 1,
    kind: 'created',
    outcome: input.plan.approvalRequired
      ? 'approval-required'
      : 'ready',
    validation: input.plan.initialValidation,
    appliedChanges: uniqueAspects(
      mutableRequested,
      'appliedChanges',
    ),
    blockedChanges: input.plan.autoProtectedChanges,
    lostAspects: Object.freeze([]),
    note: input.plan.approvalRequired
      ? 'Protected changes require explicit approval.'
      : 'Validation envelope preserved automatically.',
    actorClientId: input.plan.createdByClientId,
    createdAt: input.plan.createdAt,
  })
}

export function decideValidationEnvelopeExit(input: {
  id: string
  plan: Readonly<ValidationEnvelopeReusePlan>
  action: 'approve' | 'reject'
  note: string
  actorClientId: string
  createdAt: string
}): Readonly<ValidationEnvelopeDecision> {
  assertDomain(
    input.plan.approvalRequired,
    'PRECONDITION_REQUIRED',
    'Validation envelope does not require approval',
  )
  assertDomain(
    ['approve', 'reject'].includes(input.action),
    'INVALID_ARGUMENT',
    'action must be approve or reject',
  )
  const mutableRequested = input.plan.requestedChanges
    .filter((change) =>
      input.plan.mutableAspects.includes(change.aspect))
    .map((change) => change.aspect)
  const approved = input.action === 'approve'
  return decision({
    schemaVersion: VALIDATION_ENVELOPE_DECISION_VERSION,
    id: identity(input.id, 'decision.id'),
    reusePlanId: input.plan.id,
    sequence: 2,
    kind: 'approval',
    outcome: approved ? 'approved' : 'rejected',
    validation: approved ? 'lost' : 'preserved',
    appliedChanges: uniqueAspects(
      approved
        ? [
            ...mutableRequested,
            ...input.plan.approvalRequiredChanges,
          ]
        : mutableRequested,
      'appliedChanges',
    ),
    blockedChanges: approved
      ? input.plan.autoProtectedChanges
      : uniqueAspects(
          [
            ...input.plan.autoProtectedChanges,
            ...input.plan.approvalRequiredChanges,
          ],
          'blockedChanges',
        ),
    lostAspects: approved
      ? input.plan.approvalRequiredChanges
      : Object.freeze([]),
    note: text(input.note, 'note', 3, 1_000),
    actorClientId: identity(
      input.actorClientId,
      'actorClientId',
    ),
    createdAt: instant(input.createdAt, 'createdAt'),
  })
}

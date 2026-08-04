import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createInitialValidationEnvelopeDecision,
  createValidationEnvelopeReusePlan,
  decideValidationEnvelopeExit,
  VALIDATION_ENVELOPE_POLICY_VERSION,
  type ValidationEnvelopeChangeRequest,
} from '../domain/validation-envelope.ts'
import {
  evaluateValidatedSegmentReuse,
} from '../domain/validated-segment.ts'
import type {
  ProjectWorkspaceQueryRepository,
} from './ports/project-workspace-query-repository.ts'
import type {
  ValidatedSegmentRepository,
} from './ports/validated-segment-repository.ts'
import type {
  ValidationEnvelopeRepository,
} from './ports/validation-envelope-repository.ts'
import type {
  VariantRecipeRepository,
} from './ports/variant-recipe-repository.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function hash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && HASH.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' &&
      IDEMPOTENCY_KEY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

export function createValidationEnvelopeReuseService(dependencies: {
  repository: ValidationEnvelopeRepository
  validatedSegments: ValidatedSegmentRepository
  variantRecipes: VariantRecipeRepository
  projects: ProjectWorkspaceQueryRepository
  clock: () => Date
  createPlanId: () => string
  createDecisionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    batchId: string
    validatedSegmentId: string
    expectedValidatedSegmentHash: string
    targetRecipeId: string
    expectedTargetRecipeHash: string
    policyVersion: string
    requestedChanges: readonly Readonly<ValidationEnvelopeChangeRequest>[]
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const batchId = identity(request.batchId, 'batchId')
    const validatedSegmentId = identity(
      request.validatedSegmentId,
      'validatedSegmentId',
    )
    const expectedValidatedSegmentHash = hash(
      request.expectedValidatedSegmentHash,
      'expectedValidatedSegmentHash',
    )
    const targetRecipeId = identity(
      request.targetRecipeId,
      'targetRecipeId',
    )
    const expectedTargetRecipeHash = hash(
      request.expectedTargetRecipeHash,
      'expectedTargetRecipeHash',
    )
    assertDomain(
      request.policyVersion === VALIDATION_ENVELOPE_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${VALIDATION_ENVELOPE_POLICY_VERSION}`,
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Validation envelope actor does not belong to the workspace',
    )
    const createdByClientId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const fingerprint = calculateCanonicalHash({
      schemaVersion: 'create-validation-envelope-reuse-request/v1',
      policyVersion: VALIDATION_ENVELOPE_POLICY_VERSION,
      workspaceId,
      projectId,
      batchId,
      validatedSegmentId,
      expectedValidatedSegmentHash,
      targetRecipeId,
      expectedTargetRecipeHash,
      requestedChanges: request.requestedChanges,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      projectId,
      actorClientId: createdByClientId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different validation envelope request',
        )
      }
      return Object.freeze({
        ...replay.record,
        replayed: true,
      })
    }
    const [validatedContext, targetRecipe, project] =
      await Promise.all([
        dependencies.validatedSegments.readReuseContext({
          workspaceId,
          projectId,
          validatedSegmentId,
        }),
        dependencies.variantRecipes.read({
          workspaceId,
          batchId,
          runId: targetRecipeId,
        }),
        dependencies.projects.read({ workspaceId, projectId }),
      ])
    if (!validatedContext) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'ValidatedSegment was not found',
      )
    }
    if (!targetRecipe || targetRecipe.projectId !== projectId) {
      throw new DomainError(
        'VARIANT_RECIPE_NOT_FOUND',
        'Target VariantRecipe was not found in the project',
      )
    }
    if (!project) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project was not found',
      )
    }
    if (
      validatedContext.segment.validatedSegmentHash !==
        expectedValidatedSegmentHash ||
      targetRecipe.runHash !== expectedTargetRecipeHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'ValidatedSegment or target VariantRecipe changed before composition',
        {
          currentValidatedSegmentHash:
            validatedContext.segment.validatedSegmentHash,
          currentTargetRecipeHash: targetRecipe.runHash,
        },
      )
    }
    assertDomain(
      targetRecipe.status !== 'excluded',
      'PRECONDITION_REQUIRED',
      'Excluded VariantRecipe cannot be used as a validation envelope target',
    )
    assertDomain(
      typeof project.project.format === 'string' &&
        typeof project.project.locale === 'string',
      'PERSISTENCE_CONFLICT',
      'Project format and locale are required for validation reuse',
    )
    const reusePreflight = evaluateValidatedSegmentReuse({
      segment: validatedContext.segment,
      currentRights: validatedContext.currentRights,
      targetRecipe: {
        id: targetRecipe.id,
        role: 'hook',
        objective: targetRecipe.objective,
        format: project.project.format,
        locale: project.project.locale,
      },
      requestedChanges: [],
      claim: 'historical-association',
      evaluatedAt: dependencies.clock().toISOString(),
    })
    if (!reusePreflight.compatible) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'Validated hook is not currently eligible for reuse',
        { reasons: reusePreflight.reasons },
      )
    }
    const createdAt = dependencies.clock().toISOString()
    const plan = createValidationEnvelopeReusePlan({
      id: identity(
        dependencies.createPlanId(),
        'created validation envelope plan ID',
      ),
      workspaceId,
      projectId,
      batchId,
      validatedSegment: validatedContext.segment,
      targetRecipe,
      requestedChanges: request.requestedChanges,
      createdByClientId,
      createdAt,
    })
    const initialDecision = createInitialValidationEnvelopeDecision({
      id: identity(
        dependencies.createDecisionId(),
        'created validation envelope decision ID',
      ),
      plan,
    })
    return dependencies.repository.create({
      plan,
      initialDecision,
      requestFingerprint: fingerprint,
      idempotencyKey: key,
    }, authenticationAudit)
  }
}

export function decideValidationEnvelopeReuseService(dependencies: {
  repository: ValidationEnvelopeRepository
  clock: () => Date
  createDecisionId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    reusePlanId: string
    expectedPlanHash: string
    action: 'approve' | 'reject'
    note: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const reusePlanId = identity(
      request.reusePlanId,
      'reusePlanId',
    )
    const expectedPlanHash = hash(
      request.expectedPlanHash,
      'expectedPlanHash',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Validation envelope actor does not belong to the workspace',
    )
    const decidingClientId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    assertDomain(
      ['approve', 'reject'].includes(request.action),
      'INVALID_ARGUMENT',
      'action must be approve or reject',
    )
    const fingerprint = calculateCanonicalHash({
      schemaVersion: 'decide-validation-envelope-reuse-request/v1',
      workspaceId,
      projectId,
      reusePlanId,
      expectedPlanHash,
      action: request.action,
      note: request.note,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findDecisionReplay({
      workspaceId,
      projectId,
      actorClientId: decidingClientId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different validation envelope decision',
        )
      }
      const record = await dependencies.repository.read({
        workspaceId,
        projectId,
        reusePlanId: replay.decision.reusePlanId,
      })
      if (!record) {
        throw new DomainError(
          'PERSISTENCE_CONFLICT',
          'Validation envelope decision lost its plan',
        )
      }
      return Object.freeze({ ...record, replayed: true })
    }
    const record = await dependencies.repository.read({
      workspaceId,
      projectId,
      reusePlanId,
    })
    if (!record) {
      throw new DomainError(
        'VALIDATION_ENVELOPE_NOT_FOUND',
        'Validation envelope reuse was not found',
      )
    }
    if (record.plan.planHash !== expectedPlanHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Validation envelope plan hash is stale',
        { currentPlanHash: record.plan.planHash },
      )
    }
    if (record.decisions.length > 1) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Validation envelope approval was already decided',
        {
          currentDecisionHash:
            record.currentDecision.decisionHash,
          currentOutcome: record.currentDecision.outcome,
        },
      )
    }
    const decision = decideValidationEnvelopeExit({
      id: identity(
        dependencies.createDecisionId(),
        'created validation envelope decision ID',
      ),
      plan: record.plan,
      action: request.action,
      note: request.note,
      actorClientId: decidingClientId,
      createdAt: dependencies.clock().toISOString(),
    })
    return dependencies.repository.appendDecision({
      decision,
      requestFingerprint: fingerprint,
      idempotencyKey: key,
    }, authenticationAudit)
  }
}

export function readValidationEnvelopeReuseService(dependencies: {
  repository: ValidationEnvelopeRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    reusePlanId: string
  }) {
    const record = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      reusePlanId: identity(request.reusePlanId, 'reusePlanId'),
    })
    if (!record) {
      throw new DomainError(
        'VALIDATION_ENVELOPE_NOT_FOUND',
        'Validation envelope reuse was not found',
      )
    }
    return record
  }
}

export function listValidationEnvelopeReusesService(dependencies: {
  repository: ValidationEnvelopeRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    validatedSegmentId?: string
    batchId?: string
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(request.validatedSegmentId
        ? {
            validatedSegmentId: identity(
              request.validatedSegmentId,
              'validatedSegmentId',
            ),
          }
        : {}),
      ...(request.batchId
        ? { batchId: identity(request.batchId, 'batchId') }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

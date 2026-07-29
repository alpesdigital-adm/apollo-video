import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createProofNeedRun,
  PROOF_CLAIM_KINDS,
  PROOF_NEED_POLICY_VERSION,
  proofNeedPolicyForClaimKind,
  type ProofClaimKind,
  type ProofEvidenceCandidate,
  type ProofNeedDeclarationInput,
  type ProofNeedResolution,
} from '../domain/proof-need.ts'
import {
  normalizeSpeechText,
} from '../domain/speech-segment-catalog.ts'
import type {
  EvidenceSegmentRepository,
} from './ports/evidence-segment-repository.ts'
import type {
  ProofNeedRepository,
} from './ports/proof-need-repository.ts'
import type {
  VariantRecipeRepository,
} from './ports/variant-recipe-repository.ts'

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

function optionalText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  return text(value, field, 2, 500)
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

function actorId(
  actor: Readonly<{ type: 'api-client'; id: string }>,
): string {
  assertDomain(
    actor?.type === 'api-client',
    'AUTH_INVALID',
    'Proof need planning requires an API client',
  )
  return identity(actor.id, 'actor.id')
}

function declaration(
  value: Readonly<ProofNeedDeclarationInput>,
  index: number,
): Readonly<ProofNeedDeclarationInput> {
  assertDomain(
    PROOF_CLAIM_KINDS.includes(value?.claimKind),
    'INVALID_ARGUMENT',
    `declarations[${index}].claimKind is invalid`,
  )
  return Object.freeze({
    storyBlockId: identity(
      value.storyBlockId,
      `declarations[${index}].storyBlockId`,
    ),
    claimId: identity(
      value.claimId,
      `declarations[${index}].claimId`,
    ),
    claimText: text(
      value.claimText,
      `declarations[${index}].claimText`,
      2,
      2_000,
    ),
    claimKind: value.claimKind,
    ...(optionalText(
      value.offerId,
      `declarations[${index}].offerId`,
    )
      ? {
          offerId: identity(
            value.offerId,
            `declarations[${index}].offerId`,
          ),
        }
      : {}),
    ...(optionalText(
      value.objection,
      `declarations[${index}].objection`,
    )
      ? {
          objection: optionalText(
            value.objection,
            `declarations[${index}].objection`,
          ),
        }
      : {}),
  })
}

function proofCandidate(
  result: Awaited<
    ReturnType<EvidenceSegmentRepository['search']>
  >[number],
): Readonly<ProofEvidenceCandidate> {
  return Object.freeze({
    id: result.evidence.id,
    evidenceHash: result.evidence.evidenceHash,
    category: result.evidence.category,
    sourceArtifactId: result.evidence.sourceArtifactId,
    sourceRangeMs: result.evidence.sourceRangeMs,
    contextRangeMs: result.evidence.contextRangeMs,
    credibilityScore: result.evidence.credibilityScore,
    specificityScore: result.evidence.specificityScore,
    authenticityScore: result.evidence.authenticityScore,
    reuseAllowed: result.reuseDecision.allowed,
    reuseReasons: result.reuseDecision.reasons,
  })
}

export function createProofNeedRunService(dependencies: {
  repository: ProofNeedRepository
  evidenceSegments: EvidenceSegmentRepository
  variantRecipes: VariantRecipeRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    batchId: string
    targetRecipeId: string
    expectedTargetRecipeHash: string
    policyVersion: string
    declarations: readonly Readonly<ProofNeedDeclarationInput>[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const batchId = identity(request.batchId, 'batchId')
    const targetRecipeId = identity(
      request.targetRecipeId,
      'targetRecipeId',
    )
    const expectedTargetRecipeHash = hash(
      request.expectedTargetRecipeHash,
      'expectedTargetRecipeHash',
    )
    assertDomain(
      request.policyVersion === PROOF_NEED_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${PROOF_NEED_POLICY_VERSION}`,
    )
    assertDomain(
      Array.isArray(request.declarations) &&
        request.declarations.length >= 1 &&
        request.declarations.length <= 16,
      'INVALID_ARGUMENT',
      'declarations must contain one to sixteen entries',
    )
    const declarations = Object.freeze(
      request.declarations.map(declaration),
    )
    const keys = declarations.map((entry) =>
      `${entry.storyBlockId}\u0000${entry.claimId}`)
    assertDomain(
      new Set(keys).size === keys.length,
      'INVALID_ARGUMENT',
      'declarations must not repeat a StoryPlan claim',
    )
    const createdByClientId = actorId(request.actor)
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-proof-need-run-request/v1',
      policyVersion: PROOF_NEED_POLICY_VERSION,
      workspaceId,
      projectId,
      batchId,
      targetRecipeId,
      expectedTargetRecipeHash,
      declarations,
      createdByClientId,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      projectId,
      actorClientId: createdByClientId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different ProofNeed request',
        )
      }
      return Object.freeze({
        run: replay,
        replayed: true,
      })
    }
    const targetRecipe = await dependencies.variantRecipes.read({
      workspaceId,
      batchId,
      runId: targetRecipeId,
    })
    if (!targetRecipe || targetRecipe.projectId !== projectId) {
      throw new DomainError(
        'VARIANT_RECIPE_NOT_FOUND',
        'Target VariantRecipe was not found in the project',
      )
    }
    if (targetRecipe.runHash !== expectedTargetRecipeHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Target VariantRecipe changed before proof planning',
        { currentTargetRecipeHash: targetRecipe.runHash },
      )
    }
    assertDomain(
      targetRecipe.status !== 'excluded',
      'PRECONDITION_REQUIRED',
      'Excluded VariantRecipe cannot receive a ProofNeed plan',
    )
    const createdAt = dependencies.clock().toISOString()
    const evidenceCandidates = await Promise.all(
      declarations.map(async (entry) => {
        const policy = proofNeedPolicyForClaimKind(
          entry.claimKind as ProofClaimKind,
        )
        if (!policy.required) return Object.freeze([])
        const results = await Promise.all(policy.categories.map(
          (category) => dependencies.evidenceSegments.search({
            workspaceId,
            projectId,
            text: normalizeSpeechText(entry.claimText),
            category,
            ...(entry.offerId ? { offerId: entry.offerId } : {}),
            ...(entry.objection
              ? { objection: entry.objection }
              : {}),
            intendedClaim: entry.claimText,
            includedContext: true,
            limit: 20,
            now: createdAt,
          }),
        ))
        const candidates = new Map<string, ProofEvidenceCandidate>()
        for (const result of results.flat()) {
          candidates.set(result.evidence.id, proofCandidate(result))
        }
        return Object.freeze([...candidates.values()])
      }),
    )
    const run = createProofNeedRun({
      id: identity(
        dependencies.createRunId(),
        'created ProofNeed run ID',
      ),
      workspaceId,
      projectId,
      batchId,
      targetRecipe,
      declarations,
      evidenceCandidates,
      createdByClientId,
      createdAt,
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
    })
  }
}

export function readProofNeedRunService(dependencies: {
  repository: ProofNeedRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const record = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      runId: identity(request.runId, 'runId'),
    })
    if (!record) {
      throw new DomainError(
        'PROOF_NEED_RUN_NOT_FOUND',
        'ProofNeed run was not found',
      )
    }
    return record
  }
}

export function listProofNeedRunsService(dependencies: {
  repository: ProofNeedRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    batchId?: string
    targetRecipeId?: string
    resolution?: ProofNeedResolution
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between one and one hundred',
    )
    if (request.resolution !== undefined) {
      assertDomain(
        [
          'selected-evidence',
          'proof-unavailable',
          'no-proof-needed',
        ].includes(request.resolution),
        'INVALID_ARGUMENT',
        'resolution is invalid',
      )
    }
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(request.batchId
        ? { batchId: identity(request.batchId, 'batchId') }
        : {}),
      ...(request.targetRecipeId
        ? {
            targetRecipeId: identity(
              request.targetRecipeId,
              'targetRecipeId',
            ),
          }
        : {}),
      ...(request.resolution
        ? { resolution: request.resolution }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

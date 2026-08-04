import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createProofIntegrityRun,
  PROOF_INTEGRITY_OUTCOMES,
  PROOF_INTEGRITY_POLICY_VERSION,
  type ProofIntegrityOutcome,
  type ProofIntegrityUseInput,
} from '../domain/proof-integrity.ts'
import type {
  CompatibilityGraphRepository,
} from './ports/compatibility-graph-repository.ts'
import type {
  EvidenceSegmentRepository,
} from './ports/evidence-segment-repository.ts'
import type {
  ProofIntegrityRepository,
} from './ports/proof-integrity-repository.ts'
import type {
  ProofNeedRepository,
} from './ports/proof-need-repository.ts'
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

function use(
  value: Readonly<ProofIntegrityUseInput>,
  index: number,
): Readonly<ProofIntegrityUseInput> {
  assertDomain(
    value && typeof value === 'object',
    'INVALID_ARGUMENT',
    `uses[${index}] must be an object`,
  )
  const includedContextRangeMs = value.includedContextRangeMs
  assertDomain(
    includedContextRangeMs === undefined ||
      (
        Array.isArray(includedContextRangeMs) &&
        includedContextRangeMs.length === 2 &&
        Number.isSafeInteger(includedContextRangeMs[0]) &&
        Number.isSafeInteger(includedContextRangeMs[1]) &&
        includedContextRangeMs[0] >= 0 &&
        includedContextRangeMs[1] > includedContextRangeMs[0]
      ),
    'INVALID_ARGUMENT',
    `uses[${index}].includedContextRangeMs is invalid`,
  )
  assertDomain(
    Array.isArray(value.includedAdjacentEvidenceIds) &&
      value.includedAdjacentEvidenceIds.length <= 64,
    'INVALID_ARGUMENT',
    `uses[${index}].includedAdjacentEvidenceIds must contain at most 64 references`,
  )
  const adjacent = value.includedAdjacentEvidenceIds.map(
    (entry, adjacentIndex) => identity(
      entry,
      `uses[${index}].includedAdjacentEvidenceIds[${adjacentIndex}]`,
    ),
  )
  assertDomain(
    new Set(adjacent).size === adjacent.length,
    'INVALID_ARGUMENT',
    `uses[${index}].includedAdjacentEvidenceIds contains duplicates`,
  )
  return Object.freeze({
    proofNeedItemId: identity(
      value.proofNeedItemId,
      `uses[${index}].proofNeedItemId`,
    ),
    ...(includedContextRangeMs
      ? {
          includedContextRangeMs: Object.freeze([
            includedContextRangeMs[0],
            includedContextRangeMs[1],
          ]) as readonly [number, number],
        }
      : {}),
    includedAdjacentEvidenceIds: Object.freeze(adjacent.toSorted()),
  })
}

export function createProofIntegrityRunService(dependencies: {
  repository: ProofIntegrityRepository
  proofNeeds: ProofNeedRepository
  variantRecipes: VariantRecipeRepository
  compatibilityGraphs: CompatibilityGraphRepository
  evidenceSegments: EvidenceSegmentRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    proofNeedRunId: string
    expectedProofNeedRunHash: string
    policyVersion: string
    uses: readonly Readonly<ProofIntegrityUseInput>[]
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const proofNeedRunId = identity(
      request.proofNeedRunId,
      'proofNeedRunId',
    )
    const expectedProofNeedRunHash = hash(
      request.expectedProofNeedRunHash,
      'expectedProofNeedRunHash',
    )
    assertDomain(
      request.policyVersion === PROOF_INTEGRITY_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${PROOF_INTEGRITY_POLICY_VERSION}`,
    )
    assertDomain(
      Array.isArray(request.uses) && request.uses.length <= 16,
      'INVALID_ARGUMENT',
      'uses must contain at most sixteen entries',
    )
    const uses = Object.freeze(request.uses.map(use))
    assertDomain(
      new Set(uses.map((entry) => entry.proofNeedItemId)).size ===
        uses.length,
      'INVALID_ARGUMENT',
      'uses must not repeat a ProofNeed item',
    )
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Proof integrity actor does not belong to the workspace')
    const createdByClientId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-proof-integrity-run-request/v1',
      policyVersion: PROOF_INTEGRITY_POLICY_VERSION,
      workspaceId,
      projectId,
      proofNeedRunId,
      expectedProofNeedRunHash,
      uses,
      createdByClientId,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      projectId,
      actorClientId: createdByClientId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different ProofIntegrity request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }

    const proofNeedRun = await dependencies.proofNeeds.read({
      workspaceId,
      projectId,
      runId: proofNeedRunId,
    })
    if (!proofNeedRun) {
      throw new DomainError(
        'PROOF_NEED_RUN_NOT_FOUND',
        'ProofNeed run was not found in the project',
      )
    }
    if (proofNeedRun.runHash !== expectedProofNeedRunHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'ProofNeed run changed before integrity evaluation',
        { currentProofNeedRunHash: proofNeedRun.runHash },
      )
    }
    const itemIds = new Set(proofNeedRun.items.map((item) => item.id))
    assertDomain(
      uses.every((entry) => itemIds.has(entry.proofNeedItemId)),
      'INVALID_ARGUMENT',
      'uses contains an item outside the target ProofNeed run',
    )

    const targetRecipe = await dependencies.variantRecipes.read({
      workspaceId,
      batchId: proofNeedRun.batchId,
      runId: proofNeedRun.targetRecipeId,
    })
    if (
      !targetRecipe ||
      targetRecipe.projectId !== projectId ||
      targetRecipe.runHash !== proofNeedRun.targetRecipeHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Target VariantRecipe no longer matches the ProofNeed run',
      )
    }
    const graph = await dependencies.compatibilityGraphs.read({
      workspaceId,
      batchId: proofNeedRun.batchId,
      runId: targetRecipe.compatibilityGraphId,
    })
    if (
      !graph ||
      graph.projectId !== projectId ||
      graph.runHash !== targetRecipe.compatibilityGraphRunHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'CompatibilityGraph no longer matches the target VariantRecipe',
      )
    }
    const usesByItemId = new Map(uses.map((entry) =>
      [entry.proofNeedItemId, entry]))
    const createdAt = dependencies.clock().toISOString()
    const sources = await Promise.all(proofNeedRun.items.map(
      async (item) => {
        const block = targetRecipe.storyPlan.blocks.find((entry) =>
          entry.id === item.storyBlockId)
        const recipeNode = block
          ? graph.nodes.find((node) =>
              block.sourceCandidateIds.includes(node.takeId))
          : undefined
        const selectedEvidence = item.selectedEvidence
          ? await dependencies.evidenceSegments.readCurrent({
              workspaceId,
              projectId,
              evidenceId: item.selectedEvidence.id,
            })
          : null
        return Object.freeze({
          item,
          ...(recipeNode ? { recipeNode } : {}),
          ...(selectedEvidence
            ? {
                evidence: selectedEvidence.evidence,
                ...(selectedEvidence.currentRights
                  ? {
                      currentRights:
                        selectedEvidence.currentRights,
                    }
                  : {}),
              }
            : {}),
          ...(usesByItemId.get(item.id)
            ? { use: usesByItemId.get(item.id)! }
            : {}),
        })
      },
    ))
    const run = createProofIntegrityRun({
      id: identity(
        dependencies.createRunId(),
        'created ProofIntegrity run ID',
      ),
      workspaceId,
      projectId,
      proofNeedRun,
      sources,
      createdByClientId,
      createdAt,
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
      authenticationAudit,
    })
  }
}

export function readProofIntegrityRunService(dependencies: {
  repository: ProofIntegrityRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    runId: string
  }) {
    const run = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      runId: identity(request.runId, 'runId'),
    })
    if (!run) {
      throw new DomainError(
        'PROOF_INTEGRITY_RUN_NOT_FOUND',
        'ProofIntegrity run was not found',
      )
    }
    return run
  }
}

export function listProofIntegrityRunsService(dependencies: {
  repository: ProofIntegrityRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    proofNeedRunId?: string
    targetRecipeId?: string
    outcome?: ProofIntegrityOutcome
    readyForAssembly?: boolean
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between one and one hundred',
    )
    if (request.outcome !== undefined) {
      assertDomain(
        PROOF_INTEGRITY_OUTCOMES.includes(request.outcome),
        'INVALID_ARGUMENT',
        'outcome is invalid',
      )
    }
    assertDomain(
      request.readyForAssembly === undefined ||
        typeof request.readyForAssembly === 'boolean',
      'INVALID_ARGUMENT',
      'readyForAssembly must be boolean',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(request.proofNeedRunId
        ? {
            proofNeedRunId: identity(
              request.proofNeedRunId,
              'proofNeedRunId',
            ),
          }
        : {}),
      ...(request.targetRecipeId
        ? {
            targetRecipeId: identity(
              request.targetRecipeId,
              'targetRecipeId',
            ),
          }
        : {}),
      ...(request.outcome ? { outcome: request.outcome } : {}),
      ...(request.readyForAssembly !== undefined
        ? { readyForAssembly: request.readyForAssembly }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

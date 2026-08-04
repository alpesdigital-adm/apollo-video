import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createProofModeRun,
  PROOF_MEDIA_TYPES,
  PROOF_MODES,
  PROOF_MODE_POLICY_VERSION,
  PROOF_RHYTHMS,
  type ProofMode,
  type ProofModeOverride,
  type ProofRhythm,
} from '../domain/proof-mode.ts'
import {
  OUTPUT_ASPECT_RATIOS,
  type OutputAspectRatio,
} from '../domain/output-spec.ts'
import type {
  EvidenceSegmentRepository,
} from './ports/evidence-segment-repository.ts'
import type {
  ProofIntegrityRepository,
} from './ports/proof-integrity-repository.ts'
import type {
  ProofModeRepository,
} from './ports/proof-mode-repository.ts'
import type {
  ProofNeedRepository,
} from './ports/proof-need-repository.ts'
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

function formats(
  values: readonly OutputAspectRatio[],
): readonly OutputAspectRatio[] {
  assertDomain(
    Array.isArray(values) &&
      values.length >= 1 &&
      values.length <= OUTPUT_ASPECT_RATIOS.length &&
      values.every((value) => OUTPUT_ASPECT_RATIOS.includes(value)),
    'INVALID_OUTPUT_SPEC',
    'formats must contain one to five supported formats',
  )
  assertDomain(
    new Set(values).size === values.length,
    'INVALID_OUTPUT_SPEC',
    'formats contains duplicates',
  )
  return Object.freeze([...values].toSorted())
}

function overrides(
  values: readonly Readonly<ProofModeOverride>[],
): readonly Readonly<ProofModeOverride>[] {
  assertDomain(
    Array.isArray(values) && values.length <= 80,
    'INVALID_ARGUMENT',
    'overrides must contain at most eighty entries',
  )
  return Object.freeze(values.map((value, index) => {
    assertDomain(
      value && typeof value === 'object',
      'INVALID_ARGUMENT',
      `overrides[${index}] must be an object`,
    )
    assertDomain(
      OUTPUT_ASPECT_RATIOS.includes(value.format),
      'INVALID_OUTPUT_SPEC',
      `overrides[${index}].format is unsupported`,
    )
    assertDomain(
      PROOF_MODES.includes(value.mode),
      'INVALID_ARGUMENT',
      `overrides[${index}].mode is unsupported`,
    )
    return Object.freeze({
      proofNeedItemId: identity(
        value.proofNeedItemId,
        `overrides[${index}].proofNeedItemId`,
      ),
      format: value.format,
      mode: value.mode,
      expectedEvaluationHash: hash(
        value.expectedEvaluationHash,
        `overrides[${index}].expectedEvaluationHash`,
      ),
    })
  }))
}

export function createProofModeRunService(dependencies: {
  repository: ProofModeRepository
  proofIntegrity: ProofIntegrityRepository
  proofNeeds: ProofNeedRepository
  evidenceSegments: EvidenceSegmentRepository
  clock: () => Date
  createRunId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    proofIntegrityRunId: string
    expectedProofIntegrityRunHash: string
    policyVersion: string
    formats: readonly OutputAspectRatio[]
    rhythm: ProofRhythm
    overrides: readonly Readonly<ProofModeOverride>[]
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const proofIntegrityRunId = identity(
      request.proofIntegrityRunId,
      'proofIntegrityRunId',
    )
    const expectedProofIntegrityRunHash = hash(
      request.expectedProofIntegrityRunHash,
      'expectedProofIntegrityRunHash',
    )
    assertDomain(
      request.policyVersion === PROOF_MODE_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${PROOF_MODE_POLICY_VERSION}`,
    )
    assertDomain(
      PROOF_RHYTHMS.includes(request.rhythm),
      'INVALID_ARGUMENT',
      'rhythm is unsupported',
    )
    const selectedFormats = formats(request.formats)
    const selectedOverrides = overrides(request.overrides)
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(authenticationAudit.workspaceId === workspaceId, 'AUTH_INVALID', 'Proof mode actor does not belong to the workspace')
    const createdByClientId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-proof-mode-run-request/v1',
      policyVersion: PROOF_MODE_POLICY_VERSION,
      workspaceId,
      projectId,
      proofIntegrityRunId,
      expectedProofIntegrityRunHash,
      formats: selectedFormats,
      rhythm: request.rhythm,
      overrides: selectedOverrides,
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
          'Idempotency key was used with a different ProofMode request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }

    const integrity = await dependencies.proofIntegrity.read({
      workspaceId,
      projectId,
      runId: proofIntegrityRunId,
    })
    if (!integrity) {
      throw new DomainError(
        'PROOF_INTEGRITY_RUN_NOT_FOUND',
        'ProofIntegrity run was not found in the project',
      )
    }
    if (integrity.runHash !== expectedProofIntegrityRunHash) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'ProofIntegrity run changed before proof mode planning',
        { currentProofIntegrityRunHash: integrity.runHash },
      )
    }
    if (!integrity.summary.readyForAssembly) {
      throw new DomainError(
        'PRECONDITION_REQUIRED',
        'ProofIntegrity run is not ready for assembly',
      )
    }
    const proofNeed = await dependencies.proofNeeds.read({
      workspaceId,
      projectId,
      runId: integrity.proofNeedRunId,
    })
    if (
      !proofNeed ||
      proofNeed.runHash !== integrity.proofNeedRunHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'ProofNeed run no longer matches the ProofIntegrity run',
      )
    }
    const approved = integrity.evaluations.filter(
      (evaluation) => evaluation.outcome === 'approved',
    )
    const sources = await Promise.all(approved.map(
      async (evaluation) => {
        const item = proofNeed.items.find((candidate) =>
          candidate.id === evaluation.proofNeedItemId)
        if (!item || !evaluation.selectedEvidenceId) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Approved proof has no matching ProofNeed item',
          )
        }
        const current = await dependencies.evidenceSegments.readCurrent({
          workspaceId,
          projectId,
          evidenceId: evaluation.selectedEvidenceId,
        })
        if (
          !current ||
          current.evidence.evidenceHash !==
            evaluation.selectedEvidenceHash ||
          !PROOF_MEDIA_TYPES.includes(current.sourceMediaType)
        ) {
          throw new DomainError(
            'VERSION_CONFLICT',
            'Approved evidence changed before proof mode planning',
          )
        }
        return Object.freeze({
          evaluation,
          proofNeedItem: item,
          sourceArtifactId: current.evidence.sourceArtifactId,
          sourceMediaType: current.sourceMediaType,
          contextRequired: current.evidence.requiresContext,
        })
      },
    ))
    const run = createProofModeRun({
      id: identity(
        dependencies.createRunId(),
        'created ProofMode run ID',
      ),
      workspaceId,
      projectId,
      proofIntegrityRun: integrity,
      proofNeedRun: proofNeed,
      sources,
      formats: selectedFormats,
      rhythm: request.rhythm,
      overrides: selectedOverrides,
      createdByClientId,
      createdAt: dependencies.clock().toISOString(),
    })
    return dependencies.repository.create({
      run,
      requestFingerprint,
      idempotencyKey: key,
      authenticationAudit,
    })
  }
}

export function readProofModeRunService(dependencies: {
  repository: ProofModeRepository
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
        'PROOF_MODE_RUN_NOT_FOUND',
        'ProofMode run was not found',
      )
    }
    return run
  }
}

export function listProofModeRunsService(dependencies: {
  repository: ProofModeRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    proofIntegrityRunId?: string
    format?: OutputAspectRatio
    mode?: ProofMode
    manualOverride?: boolean
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between one and one hundred',
    )
    if (request.format !== undefined) {
      assertDomain(
        OUTPUT_ASPECT_RATIOS.includes(request.format),
        'INVALID_OUTPUT_SPEC',
        'format is unsupported',
      )
    }
    if (request.mode !== undefined) {
      assertDomain(
        PROOF_MODES.includes(request.mode),
        'INVALID_ARGUMENT',
        'mode is unsupported',
      )
    }
    assertDomain(
      request.manualOverride === undefined ||
        typeof request.manualOverride === 'boolean',
      'INVALID_ARGUMENT',
      'manualOverride must be boolean',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(request.proofIntegrityRunId
        ? {
            proofIntegrityRunId: identity(
              request.proofIntegrityRunId,
              'proofIntegrityRunId',
            ),
          }
        : {}),
      ...(request.format ? { format: request.format } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.manualOverride !== undefined
        ? { manualOverride: request.manualOverride }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

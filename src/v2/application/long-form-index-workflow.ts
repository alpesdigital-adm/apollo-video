import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createLongFormIndexWorkflow,
  LONG_FORM_INDEX_STAGES,
  LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION,
  type LongFormIndexStage,
  type LongFormIndexStageBudget,
  type LongFormIndexStageVersion,
  type LongFormIndexWorkflow,
} from '../domain/long-form-index-workflow.ts'
import {
  createQueuedPublicOperation,
} from '../domain/public-operation.ts'
import type {
  LongFormIndexWorkflowRepository,
} from './ports/long-form-index-workflow-repository.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{8,128}$/

type StageVersions = Readonly<Record<
  LongFormIndexStage,
  Readonly<LongFormIndexStageVersion>
>>
type StageBudgets = Readonly<Record<
  LongFormIndexStage,
  Readonly<LongFormIndexStageBudget>
>>

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function sha256(value: unknown, field: string): string {
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

function canonicalInstant(value: Date, field: string): string {
  assertDomain(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.toISOString()
}

function assertStageMap(
  value: unknown,
  field: string,
): asserts value is Readonly<Record<LongFormIndexStage, unknown>> {
  assertDomain(
    typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === LONG_FORM_INDEX_STAGES.length &&
      LONG_FORM_INDEX_STAGES.every((stage) =>
        Object.hasOwn(value, stage)),
    'INVALID_ARGUMENT',
    `${field} must define every long-form stage exactly once`,
  )
}

function normalizeVersions(value: StageVersions): StageVersions {
  assertStageMap(value, 'versions')
  return Object.freeze(Object.fromEntries(
    LONG_FORM_INDEX_STAGES.map((stage) => [
      stage,
      Object.freeze({ ...value[stage] }),
    ]),
  ) as Record<LongFormIndexStage, Readonly<LongFormIndexStageVersion>>)
}

function normalizeStageBudgets(value: StageBudgets): StageBudgets {
  assertStageMap(value, 'stageBudgets')
  return Object.freeze(Object.fromEntries(
    LONG_FORM_INDEX_STAGES.map((stage) => [
      stage,
      Object.freeze({ ...value[stage] }),
    ]),
  ) as Record<LongFormIndexStage, Readonly<LongFormIndexStageBudget>>)
}

function rightsAllowIndexing(
  context: Readonly<{
    rightsStatus: string
    consentStatus: string
    rightsExpiresAt?: string
    consentExpiresAt?: string
  }>,
  now: string,
): boolean {
  const instant = Date.parse(now)
  return context.rightsStatus === 'approved' &&
    ['approved', 'not-required'].includes(context.consentStatus) &&
    (!context.rightsExpiresAt ||
      Date.parse(context.rightsExpiresAt) > instant) &&
    (!context.consentExpiresAt ||
      Date.parse(context.consentExpiresAt) > instant)
}

export function createLongFormIndexWorkflowService(dependencies: {
  repository: LongFormIndexWorkflowRepository
  clock: () => Date
  createWorkflowId: () => string
  createOperationId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    expectedArtifactSha256: string
    sourceManifestId: string
    expectedManifestHash: string
    sourceTranscriptId?: string
    expectedTranscriptHash?: string
    policyVersion: string
    versions: StageVersions
    stageBudgets: StageBudgets
    budget: Readonly<{
      currency: 'USD'
      maximumCostMinorUnits: number
      maximumElapsedMs: number
      maximumConcurrency: number
    }>
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceArtifactId = identity(
      request.sourceArtifactId,
      'sourceArtifactId',
    )
    const sourceManifestId = identity(
      request.sourceManifestId,
      'sourceManifestId',
    )
    const expectedArtifactSha256 = sha256(
      request.expectedArtifactSha256,
      'expectedArtifactSha256',
    )
    const expectedManifestHash = sha256(
      request.expectedManifestHash,
      'expectedManifestHash',
    )
    assertDomain(
      (request.sourceTranscriptId === undefined) ===
        (request.expectedTranscriptHash === undefined),
      'INVALID_ARGUMENT',
      'source transcript ID and expected hash must be provided together',
    )
    const sourceTranscriptId = request.sourceTranscriptId
      ? identity(request.sourceTranscriptId, 'sourceTranscriptId')
      : undefined
    const expectedTranscriptHash = request.expectedTranscriptHash
      ? sha256(
          request.expectedTranscriptHash,
          'expectedTranscriptHash',
        )
      : undefined
    assertDomain(
      request.policyVersion ===
        LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `policyVersion must be ${LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION}`,
    )
    const versions = normalizeVersions(request.versions)
    const stageBudgets = normalizeStageBudgets(
      request.stageBudgets,
    )
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match long-form workflow')
    const createdByClientId = identity(audit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'create-long-form-index-workflow-request/v1',
      policyVersion: LONG_FORM_INDEX_WORKFLOW_POLICY_VERSION,
      workspaceId,
      projectId,
      sourceArtifactId,
      expectedArtifactSha256,
      sourceManifestId,
      expectedManifestHash,
      sourceTranscriptId,
      expectedTranscriptHash,
      versions,
      stageBudgets,
      budget: request.budget,
      createdByClientId,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.repository.findReplay({
      workspaceId,
      projectId,
      createdByClientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different long-form workflow request',
        )
      }
      return Object.freeze({ record: replay, replayed: true })
    }

    const context = await dependencies.repository.readSourceContext({
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
      ...(sourceTranscriptId ? { sourceTranscriptId } : {}),
    })
    if (!context) {
      throw new DomainError(
        'MEDIA_ARTIFACT_SOURCE_NOT_FOUND',
        'Long-form source, manifest or transcript was not found in the project',
      )
    }
    if (
      context.sourceArtifactSha256 !== expectedArtifactSha256 ||
      context.sourceManifestHash !== expectedManifestHash ||
      (sourceTranscriptId &&
        (
          context.sourceTranscript?.id !== sourceTranscriptId ||
          context.sourceTranscript.transcriptHash !==
            expectedTranscriptHash
        ))
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form source changed before workflow creation',
        {
          currentArtifactSha256: context.sourceArtifactSha256,
          currentManifestHash: context.sourceManifestHash,
          currentTranscriptHash:
            context.sourceTranscript?.transcriptHash,
        },
      )
    }
    const createdAt = canonicalInstant(
      dependencies.clock(),
      'long-form workflow clock',
    )
    if (!rightsAllowIndexing(context, createdAt)) {
      throw new DomainError(
        'ASSET_RIGHTS_BLOCKED',
        'Long-form source rights do not allow indexing',
      )
    }
    const workflowId = identity(
      dependencies.createWorkflowId(),
      'created workflow ID',
    )
    const operationId = identity(
      dependencies.createOperationId(),
      'created operation ID',
    )
    const workflow = createLongFormIndexWorkflow({
      id: workflowId,
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceArtifactSha256: context.sourceArtifactSha256,
      sourceManifestId,
      sourceManifestHash: context.sourceManifestHash,
      ...(context.sourceTranscript
        ? {
            sourceTranscriptId: context.sourceTranscript.id,
            sourceTranscriptHash:
              context.sourceTranscript.transcriptHash,
          }
        : {}),
      durationMs: context.durationMs,
      versions,
      stageBudgets,
      reusableOutputs: {
        probe: {
          outputHash: context.probeOutputHash,
          outputEntityId: sourceManifestId,
          resultCount: 1,
        },
        ...(context.sourceTranscript
          ? {
              transcript: {
                outputHash:
                  context.sourceTranscript.transcriptHash,
                outputEntityId:
                  context.sourceTranscript.id,
                resultCount:
                  context.sourceTranscript.resultCount,
              },
            }
          : {}),
      },
      budget: request.budget,
      createdByClientId,
      createdAt,
    })
    const operation = createQueuedPublicOperation({
      id: operationId,
      workspaceId,
      projectId,
      clientId: createdByClientId,
      type: 'long-form-index',
      target: {
        type: 'media-artifact',
        id: sourceArtifactId,
        manifestId: sourceManifestId,
      },
      estimatedCost: {
        currency: workflow.budget.currency,
        estimatedMinorUnits: workflow.stages.reduce(
          (total, stage) => total + stage.budget.estimatedCostMinorUnits,
          0,
        ),
        maximumMinorUnits: workflow.budget.maximumCostMinorUnits,
      },
      createdAt,
    })
    return dependencies.repository.create({
      workflow,
      operation,
      authenticationAudit: audit,
      requestFingerprint,
      idempotencyKey: key,
      expectedRightsSnapshotId: context.rightsSnapshotId,
      traceId: request.traceId,
    })
  }
}

export function readLongFormIndexWorkflowService(dependencies: {
  repository: LongFormIndexWorkflowRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    workflowId: string
  }) {
    const record = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      workflowId: identity(request.workflowId, 'workflowId'),
    })
    if (!record) {
      throw new DomainError(
        'LONG_FORM_INDEX_WORKFLOW_NOT_FOUND',
        'Long-form index workflow was not found',
      )
    }
    return record
  }
}

export function listLongFormIndexWorkflowsService(dependencies: {
  repository: LongFormIndexWorkflowRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    status?: LongFormIndexWorkflow['status']
    sourceArtifactId?: string
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between one and one hundred',
    )
    const status = request.status
    assertDomain(
      status === undefined ||
        ['queued', 'running', 'partial', 'succeeded', 'failed']
          .includes(status),
      'INVALID_ARGUMENT',
      'status is unsupported',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(status ? { status } : {}),
      ...(request.sourceArtifactId
        ? {
            sourceArtifactId: identity(
              request.sourceArtifactId,
              'sourceArtifactId',
            ),
          }
        : {}),
      limit,
      ...(request.cursor
        ? { cursor: identity(request.cursor, 'cursor') }
        : {}),
    })
  }
}

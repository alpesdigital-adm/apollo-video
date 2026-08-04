import type {
  ProjectAnalysisExecutionContext,
  ProjectAnalysisExecutionProvenance,
} from '../../application/ports/long-form-stage-persistence.ts'
import {
  createProjectAnalysisExecutionContext,
} from '../../application/project-analysis-execution.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  externalActorAuditData,
  hydrateExternalActorAudit,
  type StoredExternalActorAudit,
} from './external-actor-audit.ts'

export interface StoredProjectAnalysisExecution
extends StoredExternalActorAudit {
  executionKind: string | null
  originOperationId: string | null
  originWorkflowId: string | null
  originStage: string | null
  originStageInputHash: string | null
  originStageIdempotencyKey: string | null
}

function storedProvenance(
  row: Readonly<StoredProjectAnalysisExecution>,
): Readonly<ProjectAnalysisExecutionProvenance> {
  if (row.executionKind === 'external-request') {
    if (
      row.originOperationId || row.originWorkflowId || row.originStage ||
      row.originStageInputHash || row.originStageIdempotencyKey
    ) throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored external project analysis has worker lineage',
    )
    return Object.freeze({ kind: 'external-request' as const })
  }
  if (
    row.executionKind !== 'long-form-stage' ||
    !row.originOperationId || !row.originWorkflowId || !row.originStage ||
    !row.originStageInputHash || !row.originStageIdempotencyKey
  ) throw new DomainError(
    'PERSISTENCE_CONFLICT',
    'Stored project analysis execution provenance is incomplete',
  )
  return Object.freeze({
    kind: 'long-form-stage' as const,
    operationId: row.originOperationId,
    workflowId: row.originWorkflowId,
    stage: row.originStage as 'chunks' | 'moments',
    stageInputHash: row.originStageInputHash,
    stageIdempotencyKey: row.originStageIdempotencyKey,
  })
}

export function hydrateProjectAnalysisExecution(
  row: Readonly<StoredProjectAnalysisExecution>,
  actorClientId: string,
  expectedStage: 'chunks' | 'moments',
): Readonly<ProjectAnalysisExecutionContext> {
  try {
    return createProjectAnalysisExecutionContext({
      workspaceId: row.workspaceId,
      authenticationAudit: hydrateExternalActorAudit(row, actorClientId),
      provenance: storedProvenance(row),
      expectedStage,
    })
  } catch (error) {
    if (
      error instanceof DomainError &&
      error.code === 'PERSISTENCE_CONFLICT'
    ) throw error
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored project analysis execution audit is invalid',
    )
  }
}

export function projectAnalysisExecutionData(
  context: Readonly<ProjectAnalysisExecutionContext>,
  workspaceId: string,
  actorClientId: string,
  expectedStage: 'chunks' | 'moments',
) {
  const canonical = createProjectAnalysisExecutionContext({
    workspaceId,
    authenticationAudit: context.authenticationAudit,
    provenance: context.provenance,
    expectedStage,
  })
  const audit = externalActorAuditData(
    canonical.authenticationAudit,
    workspaceId,
    actorClientId,
  )
  return {
    ...audit,
    executionKind: canonical.provenance.kind,
    originOperationId: canonical.provenance.kind === 'long-form-stage'
      ? canonical.provenance.operationId
      : null,
    originWorkflowId: canonical.provenance.kind === 'long-form-stage'
      ? canonical.provenance.workflowId
      : null,
    originStage: canonical.provenance.kind === 'long-form-stage'
      ? canonical.provenance.stage
      : null,
    originStageInputHash:
      canonical.provenance.kind === 'long-form-stage'
        ? canonical.provenance.stageInputHash
        : null,
    originStageIdempotencyKey:
      canonical.provenance.kind === 'long-form-stage'
        ? canonical.provenance.stageIdempotencyKey
        : null,
  }
}

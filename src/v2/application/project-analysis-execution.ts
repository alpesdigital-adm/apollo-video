import {
  createApiAccessAuditContext,
  type ApiAccessAuditContext,
} from '../domain/api-access-control.ts'
import { DomainError } from '../domain/errors.ts'
import type {
  LongFormStagePersistenceFence,
  ProjectAnalysisExecutionContext,
  ProjectAnalysisExecutionProvenance,
} from './ports/long-form-stage-persistence.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const HASH = /^[a-f0-9]{64}$/

export function canonicalProjectMutationAudit(
  audit: Readonly<ApiAccessAuditContext>,
  workspaceId: string,
): Readonly<ApiAccessAuditContext> {
  let canonical: Readonly<ApiAccessAuditContext>
  try {
    canonical = createApiAccessAuditContext({
      clientId: audit.clientId,
      credentialId: audit.credentialId,
      workspaceId: audit.workspaceId,
      environment: audit.environment,
      authenticationKind: audit.authenticationKind,
      ...(audit.delegatedUserId
        ? { delegatedUserId: audit.delegatedUserId }
        : {}),
      ...(audit.delegatedIdentityId
        ? { delegatedIdentityId: audit.delegatedIdentityId }
        : {}),
      ...(audit.workspaceRole
        ? { workspaceRole: audit.workspaceRole }
        : {}),
    })
  } catch {
    throw new DomainError(
      'AUTH_INVALID',
      'Project analysis authentication audit is invalid',
    )
  }
  if (
    canonical.contextHash !== audit.contextHash ||
    canonical.workspaceId !== workspaceId
  ) {
    throw new DomainError(
      'AUTH_INVALID',
      'Project analysis authentication audit does not match its workspace',
    )
  }
  return canonical
}

function normalizedProvenance(
  provenance: Readonly<ProjectAnalysisExecutionProvenance>,
  expectedStage: 'chunks' | 'moments',
): Readonly<ProjectAnalysisExecutionProvenance> {
  if (provenance.kind === 'external-request') {
    return Object.freeze({ kind: 'external-request' as const })
  }
  if (
    provenance.kind !== 'long-form-stage' ||
    provenance.stage !== expectedStage ||
    !ID.test(provenance.workflowId) ||
    !ID.test(provenance.operationId) ||
    !HASH.test(provenance.stageInputHash) ||
    provenance.stageIdempotencyKey.length < 1 ||
    provenance.stageIdempotencyKey.length > 256
  ) {
    throw new DomainError(
      'AUTH_INVALID',
      `Project analysis execution provenance must identify the ${expectedStage} stage`,
    )
  }
  return Object.freeze({
    kind: 'long-form-stage' as const,
    workflowId: provenance.workflowId,
    operationId: provenance.operationId,
    stage: provenance.stage,
    stageInputHash: provenance.stageInputHash,
    stageIdempotencyKey: provenance.stageIdempotencyKey,
  })
}

export function createProjectAnalysisExecutionContext(input: {
  workspaceId: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
  provenance: Readonly<ProjectAnalysisExecutionProvenance>
  expectedStage: 'chunks' | 'moments'
}): Readonly<ProjectAnalysisExecutionContext> {
  return Object.freeze({
    authenticationAudit: canonicalProjectMutationAudit(
      input.authenticationAudit,
      input.workspaceId,
    ),
    provenance: normalizedProvenance(
      input.provenance,
      input.expectedStage,
    ),
  })
}

export function resolveProjectAnalysisExecutionContext(input: {
  workspaceId: string
  actor?: Readonly<AuthenticatedExternalActor>
  authenticationAudit?: Readonly<ApiAccessAuditContext>
  provenance: Readonly<ProjectAnalysisExecutionProvenance>
  expectedStage: 'chunks' | 'moments'
}): Readonly<ProjectAnalysisExecutionContext> {
  let authenticationAudit: Readonly<ApiAccessAuditContext>
  if (input.provenance.kind === 'external-request') {
    if (!input.actor || input.authenticationAudit) {
      throw new DomainError(
        'AUTH_INVALID',
        'Direct project analysis requires exactly one authenticated external actor',
      )
    }
    requireScope(input.actor, 'projects:write')
    authenticationAudit = materializeActorAuditContext(input.actor)
  } else {
    if (!input.authenticationAudit || input.actor) {
      throw new DomainError(
        'AUTH_INVALID',
        'Durable project analysis requires exactly one persisted authentication audit',
      )
    }
    authenticationAudit = input.authenticationAudit
  }
  return createProjectAnalysisExecutionContext({
    workspaceId: input.workspaceId,
    authenticationAudit,
    provenance: input.provenance,
    expectedStage: input.expectedStage,
  })
}

export function projectAnalysisProvenanceFromFence(
  fence: Readonly<LongFormStagePersistenceFence>,
): Readonly<ProjectAnalysisExecutionProvenance> {
  return Object.freeze({
    kind: 'long-form-stage' as const,
    workflowId: fence.workflowId,
    operationId: fence.operationId,
    stage: fence.stage,
    stageInputHash: fence.expectedStageInputHash,
    stageIdempotencyKey: fence.expectedStageIdempotencyKey,
  })
}

export function assertProjectAnalysisFenceBinding(
  context: Readonly<ProjectAnalysisExecutionContext>,
  fence: Readonly<LongFormStagePersistenceFence>,
): void {
  const expected = projectAnalysisProvenanceFromFence(fence)
  if (
    context.provenance.kind !== 'long-form-stage' ||
    expected.kind !== 'long-form-stage' ||
    context.provenance.workflowId !== expected.workflowId ||
    context.provenance.operationId !== expected.operationId ||
    context.provenance.stage !== expected.stage ||
    context.provenance.stageInputHash !== expected.stageInputHash ||
    context.provenance.stageIdempotencyKey !==
      expected.stageIdempotencyKey
  ) {
    throw new DomainError(
      'VERSION_CONFLICT',
      'Project analysis execution provenance does not match its durable stage fence',
    )
  }
}

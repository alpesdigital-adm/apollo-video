import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  assertProjectAnalysisFenceBinding,
  createProjectAnalysisExecutionContext,
  projectAnalysisProvenanceFromFence,
  resolveProjectAnalysisExecutionContext,
} from '../../src/v2/application/project-analysis-execution.ts'
import { DomainError } from '../../src/v2/domain/errors.ts'
import {
  hydrateProjectAnalysisExecution,
  projectAnalysisExecutionData,
} from '../../src/v2/infrastructure/prisma/project-analysis-execution.ts'
import {
  authenticatedActor,
  authenticationAudit,
} from './helpers/authentication-audit.mjs'

const workspaceId = 'workspace-project-analysis'
const audit = authenticationAudit({
  clientId: 'client-project-analysis',
  credentialId: 'credential-project-analysis',
  workspaceId,
})
const fence = Object.freeze({
  workspaceId,
  projectId: 'project-project-analysis',
  workflowId: 'workflow-project-analysis',
  operationId: 'operation-project-analysis',
  stage: 'chunks',
  expectedStageInputHash: 'a'.repeat(64),
  expectedStageIdempotencyKey: 'project-analysis-stage-key',
  leaseOwner: 'worker-project-analysis',
  operationAttempt: 2,
  now: '2026-08-05T10:00:00.000Z',
})

test('T-FR-242 project analysis execution audit round-trips direct and durable provenance', () => {
  const external = createProjectAnalysisExecutionContext({
    workspaceId,
    authenticationAudit: audit,
    provenance: { kind: 'external-request' },
    expectedStage: 'chunks',
  })
  const externalStored = projectAnalysisExecutionData(
    external,
    workspaceId,
    audit.clientId,
    'chunks',
  )
  assert.deepEqual(
    hydrateProjectAnalysisExecution(
      { workspaceId, ...externalStored },
      audit.clientId,
      'chunks',
    ),
    external,
  )

  const durable = createProjectAnalysisExecutionContext({
    workspaceId,
    authenticationAudit: audit,
    provenance: projectAnalysisProvenanceFromFence(fence),
    expectedStage: 'chunks',
  })
  assert.doesNotThrow(() =>
    assertProjectAnalysisFenceBinding(durable, fence))
  const durableStored = projectAnalysisExecutionData(
    durable,
    workspaceId,
    audit.clientId,
    'chunks',
  )
  assert.deepEqual(
    hydrateProjectAnalysisExecution(
      { workspaceId, ...durableStored },
      audit.clientId,
      'chunks',
    ),
    durable,
  )
})

test('T-FR-242 project analysis execution fails closed on audit, stage and fence drift', () => {
  assert.throws(
    () => resolveProjectAnalysisExecutionContext({
      workspaceId,
      actor: authenticatedActor({
        clientId: audit.clientId,
        credentialId: audit.credentialId,
        workspaceId,
        scopes: ['projects:read'],
      }),
      provenance: { kind: 'external-request' },
      expectedStage: 'chunks',
    }),
    (error) =>
      error instanceof DomainError && error.code === 'AUTH_SCOPE_REQUIRED',
  )
  assert.throws(
    () => createProjectAnalysisExecutionContext({
      workspaceId,
      authenticationAudit: { ...audit, contextHash: 'f'.repeat(64) },
      provenance: { kind: 'external-request' },
      expectedStage: 'chunks',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  assert.throws(
    () => createProjectAnalysisExecutionContext({
      workspaceId,
      authenticationAudit: audit,
      provenance: projectAnalysisProvenanceFromFence(fence),
      expectedStage: 'moments',
    }),
    (error) => error instanceof DomainError && error.code === 'AUTH_INVALID',
  )
  const durable = createProjectAnalysisExecutionContext({
    workspaceId,
    authenticationAudit: audit,
    provenance: projectAnalysisProvenanceFromFence(fence),
    expectedStage: 'chunks',
  })
  assert.throws(
    () => assertProjectAnalysisFenceBinding(durable, {
      ...fence,
      operationId: 'operation-project-analysis-other',
    }),
    (error) =>
      error instanceof DomainError && error.code === 'VERSION_CONFLICT',
  )
  assert.throws(
    () => hydrateProjectAnalysisExecution({
      workspaceId,
      actorCredentialId: audit.credentialId,
      actorEnvironment: audit.environment,
      actorAuthenticationKind: audit.authenticationKind,
      actorContextHash: audit.contextHash,
      delegatedUserId: null,
      delegatedIdentityId: null,
      workspaceRole: null,
      executionKind: 'long-form-stage',
      originOperationId: null,
      originWorkflowId: fence.workflowId,
      originStage: fence.stage,
      originStageInputHash: fence.expectedStageInputHash,
      originStageIdempotencyKey: fence.expectedStageIdempotencyKey,
    }, audit.clientId, 'chunks'),
    (error) =>
      error instanceof DomainError && error.code === 'PERSISTENCE_CONFLICT',
  )
})

test('T-FR-242 project analysis migration cannot admit partial tuples through SQL UNKNOWN', () => {
  const migration = readFileSync(new URL(
    '../../prisma/v2/migrations/20260805050000_project_analysis_execution_audit/migration.sql',
    import.meta.url,
  ), 'utf8')
  for (const field of [
    'actorCredentialId',
    'actorEnvironment',
    'actorAuthenticationKind',
    'actorContextHash',
    'executionKind',
    'originStage',
    'originStageInputHash',
    'originStageIdempotencyKey',
  ]) {
    assert.equal(
      migration.split(`"${field}" IS NOT NULL`).length - 1,
      2,
      `${field} must be explicitly non-null in both complete-tuple checks`,
    )
  }
})

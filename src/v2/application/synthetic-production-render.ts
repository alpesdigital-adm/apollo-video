import { randomUUID } from 'node:crypto'

import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createQueuedPublicOperation, type PublicOperation } from '../domain/public-operation.ts'
import { createRenderInputPayload } from '../domain/render-input-payload.ts'
import {
  calculateSyntheticProductionRenderContextHash,
  type SyntheticProductionRenderAspectRatio,
  type SyntheticProductionRenderKind,
} from '../domain/synthetic-production-render.ts'
import { compileSyntheticPresenterRenderInputs } from './compile-synthetic-presenter-render.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { SyntheticRuntimeIdentityReader } from './ports/synthetic-runtime-identity-reader.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/
const KEY = /^[\x21-\x7e]{8,128}$/

function identifier(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value.trim()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

function key(value: unknown): string {
  assertDomain(typeof value === 'string' && KEY.test(value.trim()), 'INVALID_ARGUMENT', 'Idempotency-Key must contain 8 to 128 visible ASCII characters')
  return value.trim()
}

export interface SyntheticProductionRenderResult {
  operation: Readonly<PublicOperation>
  render: Readonly<{
    runId: string
    projectVersionId: string
    editPlanSnapshotId: string
    renderInputHash: string
    outputArtifactId: string
    outputManifestId: string
  }>
  replayed: boolean
}

function presentResult(record: Awaited<ReturnType<PublicOperationRepository['createOrReplay']>>): Readonly<SyntheticProductionRenderResult> {
  if (record.context.kind !== 'synthetic-production-render') {
    throw new DomainError('PERSISTENCE_CONFLICT', 'Stored render replay has an incompatible operation context')
  }
  return Object.freeze({
    operation: record.operation,
    render: Object.freeze({
      runId: record.context.productionRunId,
      projectVersionId: record.context.projectVersionId,
      editPlanSnapshotId: record.context.editPlanSnapshotId,
      renderInputHash: record.context.renderInputHash,
      outputArtifactId: record.context.outputArtifactId,
      outputManifestId: record.context.outputManifestId,
    }),
    replayed: record.replayed,
  })
}

export function enqueueSyntheticProductionRenderService(dependencies: {
  production: SyntheticProductionRepository
  projects: ProjectWorkspaceQueryRepository
  operations: PublicOperationRepository
  runtimeIdentity: SyntheticRuntimeIdentityReader
  renderer: Readonly<{ id: string; version: string }>
  clock?: () => Date
  createId?: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  const clock = dependencies.clock ?? (() => new Date())
  const createId = dependencies.createId ?? (() => randomUUID())
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    runId: string
    output: Readonly<{
      kind: SyntheticProductionRenderKind
      aspectRatio: SyntheticProductionRenderAspectRatio
    }>
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
    traceId?: string
    signal?: AbortSignal
  }): Promise<Readonly<SyntheticProductionRenderResult>> {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identifier(request.workspaceId, 'workspaceId')
    const projectId = identifier(request.projectId, 'projectId')
    const runId = identifier(request.runId, 'runId')
    assertDomain(request.actor.workspaceId === workspaceId, 'AUTH_INVALID', 'Render actor does not belong to workspace')
    assertDomain(request.output?.kind === 'proxy' || request.output?.kind === 'final', 'INVALID_ARGUMENT', 'output.kind is unsupported')
    assertDomain(['9:16', '16:9', '4:5', '1:1', '21:9'].includes(request.output.aspectRatio), 'INVALID_ARGUMENT', 'output.aspectRatio is unsupported')
    const idempotencyKey = key(request.idempotencyKey)
    const audit = materializeActorAuditContext(request.actor)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'enqueue-synthetic-production-render-request/v1',
      workspaceId,
      projectId,
      runId,
      output: request.output,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({
      workspaceId,
      clientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey,
      requestFingerprint,
    })
    if (replay) return presentResult(replay)

    const [run, project, runtimeIdentity] = await Promise.all([
      dependencies.production.readRun({ workspaceId, projectId, runId }),
      dependencies.projects.read({ workspaceId, projectId }),
      dependencies.runtimeIdentity.read({ signal: request.signal }),
    ])
    if (!run || !project?.version) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic production run was not found')
    }
    assertDomain(
      run.status === 'compiled' || run.status === 'rendering',
      'VERSION_CONFLICT',
      'Synthetic production run is not renderable',
    )
    assertDomain(
      project.project.currentVersionId === run.plan.projectVersionId &&
        project.version.id === run.plan.projectVersionId,
      'VERSION_CONFLICT',
      'Synthetic production project version is no longer current',
    )
    const compiled = compileSyntheticPresenterRenderInputs({
      plan: run.plan,
      renderer: {
        id: dependencies.renderer.id,
        version: dependencies.renderer.version,
        digest: runtimeIdentity.toolchainHash,
      },
      aspectRatio: request.output.aspectRatio,
    })
    const renderInput = request.output.kind === 'proxy' ? compiled.proxy : compiled.final
    const payload = createRenderInputPayload(renderInput)
    const operationId = identifier(createId('operation'), 'operationId')
    const outputArtifactId = identifier(createId('artifact'), 'outputArtifactId')
    const outputManifestId = identifier(createId('manifest'), 'outputManifestId')
    const contextBody = {
      schemaVersion: 'synthetic-production-render-context/v1' as const,
      operationId,
      workspaceId,
      projectId,
      projectVersionId: run.plan.projectVersionId,
      projectVersionHash: project.version.baseHash,
      productionRunId: run.plan.id,
      editPlanSnapshotId: run.editPlanSnapshotId,
      editPlanSnapshotHash: run.plan.planHash,
      planHash: run.plan.planHash,
      outputKind: request.output.kind,
      aspectRatio: request.output.aspectRatio,
      renderInputRef: payload.ref,
      renderInputHash: payload.inputHash,
      propsHash: renderInput.composition.propsHash,
      outputArtifactId,
      outputManifestId,
    }
    const contextHash = calculateSyntheticProductionRenderContextHash(contextBody)
    const now = clock().toISOString()
    const operation = createQueuedPublicOperation({
      id: operationId,
      workspaceId,
      projectId,
      clientId: audit.clientId,
      type: 'synthetic-production-render',
      target: { type: 'project-version', id: run.plan.projectVersionId },
      createdAt: now,
    })
    const persisted = await dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: {
        kind: 'synthetic-production-render',
        ...contextBody,
        contextHash,
        renderInput,
      },
      idempotencyKey,
      requestFingerprint,
      ...(request.traceId ? { traceId: request.traceId } : {}),
    })
    return presentResult(persisted)
  }
}

import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createExportMatrixDefinition,
  createExportMatrixPreflight,
  type ExportMatrixCellRequest,
} from '../domain/export-matrix.ts'
import { readOutputFormatPreset } from '../domain/output-format-registry.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import { enqueueProjectFinalExportService } from './enqueue-project-final-export.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import type { ExportMatrixCapacityProvider } from './ports/export-matrix-capacity.ts'
import type { ExportMatrixRepository } from './ports/export-matrix-repository.ts'
import type { PreflightCommitTokenIssuer } from './ports/preflight-commit-token.ts'
import type { ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { projectRenderSourcesFingerprint } from './project-render-sources.ts'
import { requirePreflightForActionService } from './preflight-gate.ts'
import { resolveRenderColorPipelineBindings } from './resolve-render-color-pipelines.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && ID.test(value.trim()), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

function idempotencyKey(value: unknown): string {
  assertDomain(typeof value === 'string' && IDEMPOTENCY.test(value.trim()), 'INVALID_ARGUMENT', 'Idempotency-Key must contain 8 to 128 visible ASCII characters')
  return value.trim()
}

function durationFrames(source: Awaited<ReturnType<ProjectFinalExportRepository['readApprovedCurrentSource']>>): number {
  if (!source) return 1
  const clips = source.editPlan.videoTracks.flatMap((track) => track.clips)
  const end = Math.max(0, ...clips.map((clip) => clip.timelineOutFrame))
  return Math.max(1, end)
}

function requestFingerprint(input: {
  definitionHash: string
  requestedMaximumCostMinorUnits: number
  requestedMaximumStorageBytes: number
  actorContextHash: string
}) {
  return calculateCanonicalHash({ schemaVersion: 'export-matrix-preflight-request/v1', ...input })
}

export function createExportMatrixPreflightService(dependencies: {
  matrices: ExportMatrixRepository
  projects: ProjectFinalExportRepository
  rights: AssetRightsRepository
  colorPipelines: ColorPipelineCompilationRepository
  capacity: ExportMatrixCapacityProvider
  tokenIssuer: PreflightCommitTokenIssuer
  clock: () => Date
  createPreflightId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    cells: readonly Readonly<ExportMatrixCellRequest>[]
    requestedMaximumCostMinorUnits: number
    requestedMaximumStorageBytes: number
    actor: AuthenticatedExternalActor
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Export matrix actor does not belong to the workspace')
    const key = idempotencyKey(request.idempotencyKey)
    const definition = createExportMatrixDefinition({ workspaceId, cells: request.cells })
    const fingerprint = requestFingerprint({
      definitionHash: definition.definitionHash,
      requestedMaximumCostMinorUnits: request.requestedMaximumCostMinorUnits,
      requestedMaximumStorageBytes: request.requestedMaximumStorageBytes,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.matrices.findPreflightReplay({
      workspaceId,
      clientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) throw new DomainError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key was used with a different export matrix preflight')
      return Object.freeze({
        record: replay,
        commitToken: replay.preflight.allowed ? dependencies.tokenIssuer.issue({
          clientId: audit.clientId,
          workspaceId,
          fingerprint,
          snapshot: replay.preflight.snapshotHash,
          costFingerprint: replay.preflight.costFingerprint,
          expiresAt: replay.preflight.expiresAt,
        }) : undefined,
        replayed: true,
      })
    }

    const evidence = []
    for (const cell of definition.cells) {
      const outputSpec = readOutputFormatPreset(cell.format).spec
      const source = await dependencies.projects.readApprovedCurrentSource({
        workspaceId,
        projectId: cell.projectId,
        projectVersionId: cell.projectVersionId,
        projectVersionHash: cell.projectVersionHash,
      })
      let ready = Boolean(source && source.format === cell.format && source.locale === cell.locale)
      let colorPipelineBindings = Object.freeze([]) as Awaited<ReturnType<typeof resolveRenderColorPipelineBindings>>
      if (source && ready) {
        try {
          colorPipelineBindings = await resolveRenderColorPipelineBindings({
            repository: dependencies.colorPipelines,
            workspaceId,
            projectId: cell.projectId,
            sources: source.renderSources,
          })
        } catch {
          ready = false
        }
      }
      let rightsAllowed = ready
      if (source && source.format === cell.format && source.locale === cell.locale) {
        rightsAllowed = true
        for (const asset of source.renderSources) {
          const rights = await dependencies.rights.findCurrent(workspaceId, asset.artifactId)
          const decision = evaluateAssetUse(rights?.snapshot ?? null, {
            workspaceId,
            use: 'rendering',
            locale: cell.locale,
          }, dependencies.clock())
          if (decision.outcome !== 'allow') rightsAllowed = false
        }
      }
      evidence.push(Object.freeze({
        cellId: cell.id,
        ready,
        rightsAllowed,
        durationFrames: durationFrames(source),
        fps: outputSpec.fps,
        width: outputSpec.width,
        height: outputSpec.height,
        sourceFingerprint: source ? calculateCanonicalHash({
          projectId: cell.projectId,
          projectVersionId: cell.projectVersionId,
          projectVersionHash: cell.projectVersionHash,
          editPlanHash: source.editPlanHash,
          renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
          colorPipelineBindings,
        }) : calculateCanonicalHash({ unavailableCellId: cell.id }),
      }))
    }
    const capacity = await dependencies.capacity.read(workspaceId)
    const now = dependencies.clock()
    assertDomain(now instanceof Date && Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'Clock returned an invalid instant')
    const preflight = createExportMatrixPreflight({
      definition,
      evidence,
      requestedMaximumCostMinorUnits: request.requestedMaximumCostMinorUnits,
      requestedMaximumStorageBytes: request.requestedMaximumStorageBytes,
      ...capacity,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    })
    const record = await dependencies.matrices.createPreflight({
      id: identity(dependencies.createPreflightId(), 'created preflight ID'),
      preflight,
      authenticationAudit: audit,
      requestFingerprint: fingerprint,
      idempotencyKey: key,
    })
    return Object.freeze({
      record,
      commitToken: preflight.allowed ? dependencies.tokenIssuer.issue({
        clientId: audit.clientId,
        workspaceId,
        fingerprint,
        snapshot: preflight.snapshotHash,
        costFingerprint: preflight.costFingerprint,
        expiresAt: preflight.expiresAt,
      }) : undefined,
      replayed: false,
    })
  }
}

export function commitExportMatrixService(dependencies: {
  matrices: ExportMatrixRepository
  projects: ProjectFinalExportRepository
  rights: AssetRightsRepository
  operations: PublicOperationRepository
  colorPipelines: ColorPipelineCompilationRepository
  tokenIssuer: PreflightCommitTokenIssuer
  clock: () => Date
  createId: (kind: 'matrix' | 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function execute(request: {
    workspaceId: string
    preflightId: string
    commitToken: string
    approval: Readonly<{ approved: true; note?: string }>
    actor: AuthenticatedExternalActor
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const preflightId = identity(request.preflightId, 'preflightId')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Export matrix actor does not belong to the workspace')
    const preflight = await dependencies.matrices.readPreflight({ workspaceId, preflightId })
    if (!preflight) throw new DomainError('EXPORT_MATRIX_PREFLIGHT_NOT_FOUND', 'Export matrix preflight was not found')
    assertDomain(preflight.createdByClientId === audit.clientId && preflight.actorContextHash === audit.contextHash, 'AUTH_INVALID', 'Export matrix preflight belongs to another actor context')
    assertDomain(preflight.preflight.allowed, 'PRECONDITION_REQUIRED', 'Blocked export matrix preflight cannot be committed')
    requirePreflightForActionService({ issuer: dependencies.tokenIssuer, clock: dependencies.clock })({
      actionId: 'final-export-matrix.commit',
      token: request.commitToken,
      clientId: audit.clientId,
      workspaceId,
      fingerprint: preflight.requestFingerprint,
      snapshot: preflight.preflight.snapshotHash,
      costFingerprint: preflight.preflight.costFingerprint,
    })
    const existing = await dependencies.matrices.findMatrixByPreflight({ workspaceId, preflightId })
    if (existing) return Object.freeze({ matrix: existing, replayed: true })
    const createdAt = dependencies.clock().toISOString()
    const matrix = await dependencies.matrices.createMatrix({
      id: identity(dependencies.createId('matrix'), 'created matrix ID'),
      preflight,
      authenticationAudit: audit,
      createdAt,
    })
    const enqueue = enqueueProjectFinalExportService({
      projects: dependencies.projects,
      rights: dependencies.rights,
      operations: dependencies.operations,
      colorPipelines: dependencies.colorPipelines,
      clock: dependencies.clock,
      createId: (kind) => dependencies.createId(kind),
    })
    for (const cell of preflight.preflight.definition.cells) {
      try {
        const operation = await enqueue({
          workspaceId,
          projectId: cell.projectId,
          projectVersionId: cell.projectVersionId,
          projectVersionHash: cell.projectVersionHash,
          format: cell.format,
          approval: request.approval,
          actor: request.actor,
          idempotencyKey: `matrix:${matrix.id}:${cell.id}`,
          outputFileName: cell.outputFileName,
        })
        await dependencies.matrices.attachCellOperation({ workspaceId, matrixId: matrix.id, cellId: cell.id, operationId: operation.operation.id })
      } catch (error) {
        await dependencies.matrices.recordCellDispatchFailure({
          workspaceId,
          matrixId: matrix.id,
          cellId: cell.id,
          error: Object.freeze({
            code: error instanceof DomainError ? error.code : 'EXPORT_MATRIX_DISPATCH_FAILED',
            message: 'Export matrix cell could not be dispatched',
            retryable: !(error instanceof DomainError && ['AUTH_INVALID', 'ASSET_RIGHTS_BLOCKED', 'EDITORIAL_ACCEPTANCE_FAILED', 'INVALID_ARGUMENT', 'INVALID_OUTPUT_SPEC'].includes(error.code)),
          }),
        })
      }
    }
    const result = await dependencies.matrices.readMatrix({ workspaceId, matrixId: matrix.id })
    if (!result) throw new DomainError('PERSISTENCE_CONFLICT', 'Committed export matrix disappeared')
    return Object.freeze({ matrix: result, replayed: false })
  }
}

export function readExportMatrixService(dependencies: { matrices: ExportMatrixRepository }) {
  return async function execute(request: { workspaceId: string; matrixId: string }) {
    const matrix = await dependencies.matrices.readMatrix({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      matrixId: identity(request.matrixId, 'matrixId'),
    })
    if (!matrix) throw new DomainError('EXPORT_MATRIX_NOT_FOUND', 'Export matrix was not found')
    return matrix
  }
}

import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  FINAL_OUTPUT_PROFILE,
  OUTPUT_ASPECT_RATIOS,
  type OutputAspectRatio,
} from '../domain/output-spec.ts'
import { readOutputFormatPreset, validateOutputCompatibility } from '../domain/output-format-registry.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import type { ColorPipelineCompilationRepository } from './ports/color-pipeline-compilation-repository.ts'
import { projectRenderSourcesFingerprint } from './project-render-sources.ts'
import { requirePreflightForActionService } from './preflight-gate.ts'
import { resolveRenderColorPipelineBindings } from './resolve-render-color-pipelines.ts'
import { calculateVersionHash } from './version-hash.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

function validateId(value: string, field: string): string {
  const normalized = value.trim()
  assertDomain(normalized.length >= 3 && normalized.length <= 128, 'INVALID_ARGUMENT', `${field} must contain 3 to 128 characters`)
  return normalized
}

function validateHash(value: string, field: string): string {
  const normalized = value.trim().toLowerCase()
  assertDomain(/^[a-f0-9]{64}$/.test(normalized), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return normalized
}

function validateNote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.trim()
  assertDomain(normalized.length >= 1 && normalized.length <= 1000, 'INVALID_ARGUMENT', 'approval.note must contain 1 to 1000 characters')
  return normalized
}

export function enqueueProjectFinalExportService(dependencies: {
  projects: ProjectFinalExportRepository
  rights: AssetRightsRepository
  operations: PublicOperationRepository
  colorPipelines: ColorPipelineCompilationRepository
  clock: () => Date
  createId: (kind: 'operation' | 'artifact' | 'manifest') => string
}) {
  return async function enqueue(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    format: string
    approval: { approved: true; note?: string }
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
    outputFileName?: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const projectVersionId = validateId(request.projectVersionId, 'projectVersionId')
    const projectVersionHash = validateHash(request.projectVersionHash, 'projectVersionHash')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match export request')
    const clientId = validateId(audit.clientId, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length >= 1 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    assertDomain(request.approval?.approved === true, 'INVALID_ARGUMENT', 'Explicit final approval is required')
    const approvalNote = validateNote(request.approval.note)
    const outputFileName = request.outputFileName?.trim()
    assertDomain(
      outputFileName === undefined ||
        (outputFileName.length >= 5 && outputFileName.length <= 240 && /^[A-Za-z0-9._-]+\.mp4$/.test(outputFileName)),
      'INVALID_ARGUMENT',
      'outputFileName must be a portable MP4 file name',
    )
    assertDomain(OUTPUT_ASPECT_RATIOS.includes(request.format as OutputAspectRatio), 'INVALID_OUTPUT_SPEC', 'Final export format is not supported')
    requirePreflightForActionService()({
      actionId: 'project-final-export.enqueue',
    })

    const source = await dependencies.projects.readApprovedCurrentSource({
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
    })
    if (!source) throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'Current project version does not have an approved DirectorRun, QualityReport and post-render proxy review')
    assertDomain(source.format === request.format, 'INVALID_OUTPUT_SPEC', 'Final export format must match the approved project format')
    const outputSpec = readOutputFormatPreset(source.format as OutputAspectRatio).spec
    assertDomain(Boolean(outputSpec), 'INVALID_OUTPUT_SPEC', 'Approved project format has no final export preset')
    validateOutputCompatibility({
      aspectRatio: source.format as OutputAspectRatio,
      platform: 'generic',
      codec: FINAL_OUTPUT_PROFILE.codec,
      audioCodec: FINAL_OUTPUT_PROFILE.audioCodec,
      container: FINAL_OUTPUT_PROFILE.container,
      pixelFormat: 'yuv420p',
    })
    const finalOutputSpec = Object.freeze({
      aspectRatio: outputSpec.aspectRatio,
      width: outputSpec.width,
      height: outputSpec.height,
      fps: outputSpec.fps,
      ...FINAL_OUTPUT_PROFILE,
    })

    for (const asset of source.renderSources) {
      const rightsRecord = await dependencies.rights.findCurrent(
        workspaceId,
        asset.artifactId,
      )
      const rightsDecision = evaluateAssetUse(rightsRecord?.snapshot ?? null, {
        workspaceId,
        use: 'rendering',
        locale: source.locale,
      }, dependencies.clock())
      if (rightsDecision.outcome !== 'allow') {
        throw new DomainError(
          'ASSET_RIGHTS_BLOCKED',
          'A render source does not permit final export',
          { artifactId: asset.artifactId, reasonCodes: rightsDecision.reasonCodes },
        )
      }
    }
    const colorPipelineBindings = await resolveRenderColorPipelineBindings({
      repository: dependencies.colorPipelines, workspaceId, projectId, sources: source.renderSources,
    })

    const inputHash = calculateVersionHash({
      kind: 'project-final-export/v1',
      projectId,
      projectVersionId,
      projectVersionHash,
      editPlanSnapshotId: source.editPlanSnapshotId,
      editPlanHash: source.editPlanHash,
      directorRunId: source.directorRunId,
      qualitySnapshotId: source.qualitySnapshotId,
      qualitySnapshotHash: source.qualitySnapshotHash,
      proxyReviewId: source.proxyReviewId,
      proxyReviewHash: source.proxyReviewHash,
      proxyArtifactId: source.proxyArtifactId,
      sourceArtifactId: source.sourceArtifactId,
      sourceManifestId: source.sourceManifestId,
      sourceSha256: source.sourceSha256,
      renderSourcesFingerprint: projectRenderSourcesFingerprint(source.renderSources),
      colorPipelineBindings,
      outputSpec: finalOutputSpec,
    })
    const requestFingerprint = calculateVersionHash({
      type: 'project-final-export',
      projectId,
      projectVersionId,
      projectVersionHash,
      format: request.format,
      approval: { approved: true, ...(approvalNote ? { note: approvalNote } : {}) },
      ...(outputFileName ? { outputFileName } : {}),
      inputHash,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, actorContextHash: audit.contextHash, idempotencyKey, requestFingerprint })
    if (replay) return replay

    const operationId = dependencies.createId('operation')
    const outputArtifactId = dependencies.createId('artifact')
    const outputManifestId = dependencies.createId('manifest')
    const approvedAt = dependencies.clock().toISOString()
    const operation = createQueuedPublicOperation({
      id: operationId,
      workspaceId,
      projectId,
      clientId,
      type: 'project-final-export',
      target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId },
      createdAt: approvedAt,
    })
    return dependencies.operations.createOrReplay({
      operation,
      authenticationAudit: audit,
      context: {
        kind: 'project-final-export',
        projectId,
        projectVersionId,
        projectVersionHash,
        editPlanSnapshotId: source.editPlanSnapshotId,
        directorRunId: source.directorRunId,
        qualitySnapshotId: source.qualitySnapshotId,
        qualitySnapshotHash: source.qualitySnapshotHash,
        proxyReviewId: source.proxyReviewId,
        proxyReviewHash: source.proxyReviewHash,
        proxyArtifactId: source.proxyArtifactId,
        sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId,
        colorPipelineBindings,
        inputHash,
        outputArtifactId,
        outputManifestId,
        outputSpec: finalOutputSpec,
        approval: {
          actorType: 'api-client',
          actorId: clientId,
          approvedAt,
          ...(approvalNote ? { note: approvalNote } : {}),
        },
        originalFileName: outputFileName ?? `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 190)}-final-${outputSpec.width}x${outputSpec.height}.mp4`,
      },
      idempotencyKey,
      requestFingerprint,
      traceId: request.traceId,
    })
  }
}

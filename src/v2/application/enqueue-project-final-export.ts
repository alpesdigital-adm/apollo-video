import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { OUTPUT_ASPECT_RATIOS, OUTPUT_PRESETS, type OutputAspectRatio } from '../domain/output-spec.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { ProjectFinalExportRepository } from './ports/project-final-export-repository.ts'
import type { PublicOperationRepository } from './ports/public-operation-repository.ts'
import { calculateVersionHash } from './version-hash.ts'

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
    actor: { type: 'api-client'; id: string }
    idempotencyKey: string
  }) {
    const workspaceId = validateId(request.workspaceId, 'workspaceId')
    const projectId = validateId(request.projectId, 'projectId')
    const projectVersionId = validateId(request.projectVersionId, 'projectVersionId')
    const projectVersionHash = validateHash(request.projectVersionHash, 'projectVersionHash')
    const clientId = validateId(request.actor.id, 'actor.id')
    const idempotencyKey = request.idempotencyKey.trim()
    assertDomain(idempotencyKey.length >= 1 && idempotencyKey.length <= 128, 'INVALID_ARGUMENT', 'Idempotency-Key must contain 1 to 128 characters')
    assertDomain(request.approval?.approved === true, 'INVALID_ARGUMENT', 'Explicit final approval is required')
    const approvalNote = validateNote(request.approval.note)
    assertDomain(OUTPUT_ASPECT_RATIOS.includes(request.format as OutputAspectRatio), 'INVALID_OUTPUT_SPEC', 'Final export format is not supported')

    const source = await dependencies.projects.readApprovedCurrentSource({
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
    })
    if (!source) throw new DomainError('EDITORIAL_ACCEPTANCE_FAILED', 'Current project version does not have an approved DirectorRun and QualityReport')
    assertDomain(source.format === request.format, 'INVALID_OUTPUT_SPEC', 'Final export format must match the approved project format')
    const outputSpec = OUTPUT_PRESETS[source.format as OutputAspectRatio]
    assertDomain(Boolean(outputSpec), 'INVALID_OUTPUT_SPEC', 'Approved project format has no final export preset')

    const rightsRecord = await dependencies.rights.findCurrent(workspaceId, source.sourceArtifactId)
    const rightsDecision = evaluateAssetUse(rightsRecord?.snapshot ?? null, {
      workspaceId,
      use: 'rendering',
      locale: source.locale,
    }, dependencies.clock())
    if (rightsDecision.outcome !== 'allow') {
      throw new DomainError('ASSET_RIGHTS_BLOCKED', 'Source master rights do not permit final export', { reasonCodes: rightsDecision.reasonCodes })
    }

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
      sourceArtifactId: source.sourceArtifactId,
      sourceManifestId: source.sourceManifestId,
      sourceSha256: source.sourceSha256,
      outputSpec,
    })
    const requestFingerprint = calculateVersionHash({
      type: 'project-final-export',
      projectId,
      projectVersionId,
      projectVersionHash,
      format: request.format,
      approval: { approved: true, ...(approvalNote ? { note: approvalNote } : {}) },
      inputHash,
    })
    const replay = await dependencies.operations.findReplay({ workspaceId, clientId, idempotencyKey, requestFingerprint })
    if (replay) return replay

    const operationId = dependencies.createId('operation')
    const outputArtifactId = dependencies.createId('artifact')
    const outputManifestId = dependencies.createId('manifest')
    const approvedAt = dependencies.clock().toISOString()
    const operation = createQueuedPublicOperation({
      id: operationId,
      workspaceId,
      clientId,
      type: 'project-final-export',
      target: { type: 'media-artifact', id: outputArtifactId, manifestId: outputManifestId },
      createdAt: approvedAt,
    })
    return dependencies.operations.createOrReplay({
      operation,
      context: {
        kind: 'project-final-export',
        projectId,
        projectVersionId,
        projectVersionHash,
        editPlanSnapshotId: source.editPlanSnapshotId,
        directorRunId: source.directorRunId,
        qualitySnapshotId: source.qualitySnapshotId,
        qualitySnapshotHash: source.qualitySnapshotHash,
        sourceArtifactId: source.sourceArtifactId,
        sourceManifestId: source.sourceManifestId,
        inputHash,
        outputArtifactId,
        outputManifestId,
        outputSpec: {
          aspectRatio: outputSpec.aspectRatio,
          width: outputSpec.width,
          height: outputSpec.height,
          fps: outputSpec.fps,
        },
        approval: {
          actorType: request.actor.type,
          actorId: clientId,
          approvedAt,
          ...(approvalNote ? { note: approvalNote } : {}),
        },
        originalFileName: `${source.originalFileName.replace(/\.[^.]+$/, '').slice(0, 190)}-final-${outputSpec.width}x${outputSpec.height}.mp4`,
      },
      idempotencyKey,
      requestFingerprint,
    })
  }
}

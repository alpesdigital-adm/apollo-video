import {
  evaluateAssetUse,
} from '../domain/asset-rights.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createQueuedPublicOperation } from '../domain/public-operation.ts'
import {
  createSourceCleanupPlan,
  defaultSourceCleanupPolicy,
  SOURCE_CLEANUP_POLICY_VERSION,
  type SourceCleanupPolicy,
} from '../domain/source-cleanup.ts'
import type {
  AssetRightsRepository,
} from './ports/asset-rights-repository.ts'
import type {
  ContaminationReportRepository,
} from './ports/contamination-report-repository.ts'
import type {
  MediaArtifactQueryRepository,
} from './ports/media-artifact-query-repository.ts'
import type {
  ProjectWorkspaceQueryRepository,
} from './ports/project-workspace-query-repository.ts'
import type {
  SourceCleanupRepository,
} from './ports/source-cleanup-repository.ts'
import type {
  SourceSeparationProvider,
} from './ports/source-separation-provider.ts'
import { materializeActorAuditContext, requireScope, type AuthenticatedExternalActor } from './authenticate-api-client.ts'

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

function requestFingerprint(input: {
  workspaceId: string
  projectId: string
  contaminationReportId: string
  expectedReportHash: string
  findingId: string
  policy: Readonly<SourceCleanupPolicy>
  actorClientId: string
  actorContextHash: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'create-source-cleanup-request/v1',
    policyVersion: SOURCE_CLEANUP_POLICY_VERSION,
    ...input,
  })
}

export function createSourceCleanupService(dependencies: {
  repository: SourceCleanupRepository
  contaminationReports: ContaminationReportRepository
  mediaArtifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  projects: ProjectWorkspaceQueryRepository
  clock: () => Date
  createId: () => string
  separationProvider?: Pick<SourceSeparationProvider, 'offer'>
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    contaminationReportId: string
    expectedReportHash: string
    findingId: string
    policy?: Readonly<SourceCleanupPolicy>
    actor: AuthenticatedExternalActor
    idempotencyKey: string
    traceId?: string
  }) {
    const workspaceId = identity(
      request.workspaceId,
      'workspaceId',
    )
    const projectId = identity(request.projectId, 'projectId')
    const contaminationReportId = identity(
      request.contaminationReportId,
      'contaminationReportId',
    )
    const expectedReportHash = hash(
      request.expectedReportHash,
      'expectedReportHash',
    )
    const findingId = identity(request.findingId, 'findingId')
    requireScope(request.actor, 'projects:write')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Authenticated workspace does not match source cleanup')
    const actorClientId = identity(audit.clientId, 'actor.id')
    const replayKey = idempotencyKey(request.idempotencyKey)
    const policy = request.policy ?? defaultSourceCleanupPolicy()
    const fingerprint = requestFingerprint({
      workspaceId,
      projectId,
      contaminationReportId,
      expectedReportHash,
      findingId,
      policy,
      actorClientId,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      projectId,
      actorClientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: replayKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== fingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different source cleanup request',
        )
      }
      return Object.freeze({
        ...replay.record,
        replayed: true,
      })
    }
    const [report, project] = await Promise.all([
      dependencies.contaminationReports.read({
        workspaceId,
        projectId,
        reportId: contaminationReportId,
      }),
      dependencies.projects.read({ workspaceId, projectId }),
    ])
    if (!report) {
      throw new DomainError(
        'CONTAMINATION_REPORT_NOT_FOUND',
        'Contamination report was not found',
      )
    }
    if (!project) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project was not found',
      )
    }
    const separationOffer = dependencies.separationProvider
      ? dependencies.separationProvider.offer(report.sourceDurationMs)
      : undefined
    const artifact = await dependencies.mediaArtifacts.findById(
      workspaceId,
      report.sourceArtifactId,
    )
    if (
      !artifact ||
      artifact.status !== 'available' ||
      artifact.sha256 !== report.sourceArtifactSha256 ||
      artifact.manifests.length === 0
    ) {
      throw new DomainError(
        'MEDIA_ARTIFACT_NOT_FOUND',
        'Source cleanup requires the exact available source artifact and manifest',
      )
    }
    const sourceManifest = artifact.manifests[0]!
    const rightsRecord = await dependencies.rights.findCurrent(
      workspaceId,
      artifact.id,
    )
    const evaluatedAt = dependencies.clock()
    const locale = project.project.locale
    assertDomain(
      typeof locale === 'string' && locale.length > 0,
      'PERSISTENCE_CONFLICT',
      'Project locale is required to evaluate source cleanup rights',
    )
    const rightsDecision = evaluateAssetUse(
      rightsRecord?.snapshot ?? null,
      { workspaceId, use: 'editing', locale },
      evaluatedAt,
    )
    const plan = createSourceCleanupPlan({
      id: identity(dependencies.createId(), 'created cleanup plan ID'),
      report,
      expectedReportHash,
      findingId,
      sourceManifestId: sourceManifest.id,
      policy,
      ...(separationOffer ? { separationOffer } : {}),
      rights: {
        outcome: rightsDecision.outcome,
        reasonCodes: rightsDecision.reasonCodes,
        ...(rightsRecord?.snapshot
          ? {
              rightsSnapshotId: rightsRecord.snapshot.id,
              rightsSnapshotHash:
                rightsRecord.snapshot.snapshotHash,
            }
          : {}),
      },
      createdByClientId: actorClientId,
      createdAt: evaluatedAt,
    })
    const operation = plan.decision === 'execute'
      ? createQueuedPublicOperation({
          id: plan.operationId!,
          workspaceId,
          projectId,
          clientId: actorClientId,
          type: 'source-cleanup',
          target: {
            type: 'media-artifact',
            id: plan.outputArtifactId!,
            manifestId: plan.outputManifestId!,
          },
          createdAt: plan.createdAt,
        })
      : undefined
    return dependencies.repository.create({
      plan,
      ...(operation
        ? {
            operation,
            operationContext: {
              kind: 'source-cleanup',
              projectId,
              cleanupPlanId: plan.id,
              cleanupPlanHash: plan.planHash,
              sourceArtifactId: plan.sourceArtifactId,
              sourceArtifactSha256:
                plan.sourceArtifactSha256,
              sourceManifestId: plan.sourceManifestId,
              outputArtifactId: plan.outputArtifactId!,
              outputManifestId: plan.outputManifestId!,
              strategy: plan.selectedStrategy as
                'trim' | 'crop-reframe' | 'cover' | 'separation',
            },
          }
        : {}),
      requestFingerprint: fingerprint,
      authenticationAudit: audit,
      idempotencyKey: replayKey,
      traceId: request.traceId,
    })
  }
}

export function readSourceCleanupService(dependencies: {
  repository: SourceCleanupRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    cleanupPlanId: string
  }) {
    const record = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      cleanupPlanId: identity(
        request.cleanupPlanId,
        'cleanupPlanId',
      ),
    })
    if (!record) {
      throw new DomainError(
        'SOURCE_CLEANUP_NOT_FOUND',
        'Source cleanup was not found',
      )
    }
    return record
  }
}

export function listSourceCleanupsService(dependencies: {
  repository: SourceCleanupRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    contaminationReportId?: string
    findingId?: string
    limit?: number
    cursor?: string
  }) {
    const limit = request.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      ...(request.contaminationReportId
        ? {
            contaminationReportId: identity(
              request.contaminationReportId,
              'contaminationReportId',
            ),
          }
        : {}),
      ...(request.findingId
        ? {
            findingId: identity(
              request.findingId,
              'findingId',
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

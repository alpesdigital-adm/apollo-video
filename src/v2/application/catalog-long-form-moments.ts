import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  catalogLongFormHierarchy,
  LONG_FORM_INDEX_POLICY_VERSION,
  normalizeLongFormProducer,
  type LongFormChapterInput,
  type LongFormMomentInput,
  type LongFormProducer,
} from '../domain/long-form-moment.ts'
import { normalizeSpeechText } from '../domain/speech-segment-catalog.ts'
import type {
  LongFormIndexRepository,
  LongFormMomentSearchQuery,
  PersistedLongFormIndexRun,
} from './ports/long-form-index-repository.ts'
import type {
  ApiAccessAuditContext,
} from '../domain/api-access-control.ts'
import type {
  ProjectAnalysisExecutionProvenance,
} from './ports/long-form-stage-persistence.ts'
import {
  resolveProjectAnalysisExecutionContext,
} from './project-analysis-execution.ts'
import type {
  AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SHA_256 = /^[a-f0-9]{64}$/
const IDEMPOTENCY = /^[\x21-\x7E]{8,128}$/

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
    typeof value === 'string' &&
      SHA_256.test(value.trim().toLowerCase()),
    'INVALID_ARGUMENT',
    `${field} must be SHA-256`,
  )
  return value.trim().toLowerCase()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function finiteScore(value: unknown, field: string): number {
  assertDomain(
    typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1,
    'INVALID_ARGUMENT',
    `${field} must be between 0 and 1`,
  )
  return value
}

function optionalText(
  value: unknown,
  field: string,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(
    typeof value === 'string' &&
      value.trim().length > 0 &&
      value.trim().length <= 2_000,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  const normalized = normalizeSpeechText(value.trim())
  assertDomain(
    normalized.length > 0,
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return normalized
}

function boundedInteger(
  value: unknown,
  field: string,
  fallback: number,
  maximum: number,
): number {
  const selected = value ?? fallback
  assertDomain(
    Number.isSafeInteger(selected) &&
      Number(selected) >= 0 &&
      Number(selected) <= maximum,
    'INVALID_ARGUMENT',
    `${field} must be an integer between 0 and ${maximum}`,
  )
  return Number(selected)
}

function validNow(value: Date, field: string): string {
  assertDomain(
    value instanceof Date && !Number.isNaN(value.getTime()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.toISOString()
}

export function calculateLongFormIndexRecordHash(
  run: Omit<
    PersistedLongFormIndexRun,
    'recordHash' | 'active' | 'authenticationAudit' | 'provenance'
  >,
): string {
  return calculateCanonicalHash(run)
}

export function catalogLongFormMomentsService(dependencies: {
  repository: LongFormIndexRepository
  clock: () => Date
  createId: (
    kind: 'long-form-index-run' | 'long-form-chapter' | 'long-form-moment',
    sourceId?: string,
  ) => string
}) {
  return async function catalog(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    expectedArtifactSha256: string
    sourceManifestId: string
    expectedManifestHash: string
    indexPolicyVersion: string
    producer: LongFormProducer
    chapters: readonly LongFormChapterInput[]
    moments: readonly LongFormMomentInput[]
    actor?: Readonly<AuthenticatedExternalActor>
    authenticationAudit?: Readonly<ApiAccessAuditContext>
    provenance: Readonly<ProjectAnalysisExecutionProvenance>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceArtifactId = identity(
      request.sourceArtifactId,
      'sourceArtifactId',
    )
    const expectedArtifactSha256 = hash(
      request.expectedArtifactSha256,
      'expectedArtifactSha256',
    )
    const sourceManifestId = identity(
      request.sourceManifestId,
      'sourceManifestId',
    )
    const expectedManifestHash = hash(
      request.expectedManifestHash,
      'expectedManifestHash',
    )
    assertDomain(
      request.indexPolicyVersion === LONG_FORM_INDEX_POLICY_VERSION,
      'INVALID_ARGUMENT',
      `indexPolicyVersion must be ${LONG_FORM_INDEX_POLICY_VERSION}`,
    )
    const execution = resolveProjectAnalysisExecutionContext({
      workspaceId,
      ...(request.actor ? { actor: request.actor } : {}),
      ...(request.authenticationAudit
        ? { authenticationAudit: request.authenticationAudit }
        : {}),
      provenance: request.provenance,
      expectedStage: 'moments',
    })
    const actorId = identity(
      execution.authenticationAudit.clientId,
      'actor.id',
    )
    const key = idempotencyKey(request.idempotencyKey)
    const producer = normalizeLongFormProducer(request.producer)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'catalog-long-form-moments-request/v1',
      workspaceId,
      projectId,
      sourceArtifactId,
      expectedArtifactSha256,
      sourceManifestId,
      expectedManifestHash,
      indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
      producer,
      chapters: request.chapters,
      moments: request.moments,
      actorContextHash: execution.authenticationAudit.contextHash,
      provenance: execution.provenance,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
      actorContextHash: execution.authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different long-form index request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const context = await dependencies.repository.readCreationContext({
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceManifestId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'Project long-form artifact or manifest was not found',
      )
    }
    if (
      context.sourceArtifactSha256 !== expectedArtifactSha256 ||
      context.sourceManifestHash !== expectedManifestHash
    ) {
      throw new DomainError(
        'VERSION_CONFLICT',
        'Long-form source changed before indexing',
        {
          currentArtifactSha256: context.sourceArtifactSha256,
          currentManifestHash: context.sourceManifestHash,
        },
      )
    }
    const createdAt = validNow(
      dependencies.clock(),
      'long-form index clock',
    )
    const runId = identity(
      dependencies.createId('long-form-index-run'),
      'longFormIndexRunId',
    )
    const hierarchy = catalogLongFormHierarchy({
      workspaceId,
      projectId,
      indexRunId: runId,
      sourceArtifactId,
      durationMs: context.durationMs,
      chapters: request.chapters,
      moments: request.moments,
      producer,
      createdAt,
      createId: (kind, sourceId) =>
        dependencies.createId(kind, sourceId),
    })
    const hierarchyHash = calculateCanonicalHash(hierarchy)
    const content = Object.freeze({
      schemaVersion: 'long-form-index-run/v1' as const,
      id: runId,
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceArtifactSha256: context.sourceArtifactSha256,
      sourceManifestId,
      sourceManifestHash: context.sourceManifestHash,
      durationMs: context.durationMs,
      rightsSnapshotId: context.rights.id,
      rightsStatus: context.rights.status,
      consentStatus: context.rights.consentStatus,
      indexPolicyVersion: LONG_FORM_INDEX_POLICY_VERSION,
      producer,
      chapters: hierarchy.chapters,
      moments: hierarchy.moments,
      chapterCount: hierarchy.chapters.length,
      momentCount: hierarchy.moments.length,
      hierarchyHash,
      requestFingerprint,
      idempotencyKey: key,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt,
    })
    const run = Object.freeze({
      ...content,
      recordHash: calculateLongFormIndexRecordHash(content),
      active: true,
      ...execution,
    })
    return dependencies.repository.persist(run)
  }
}

export function searchLongFormMomentsService(dependencies: {
  repository: LongFormIndexRepository
  clock: () => Date
}) {
  return async function search(request: {
    workspaceId: string
    projectId: string
    text?: string
    chapterId?: string
    sourceArtifactId?: string
    speakerId?: string
    role?: string
    tag?: string
    minSalience?: number
    contextBeforeMs?: number
    contextAfterMs?: number
    limit?: number
  }) {
    const limit = boundedInteger(request.limit, 'limit', 20, 100)
    assertDomain(limit >= 1, 'INVALID_ARGUMENT', 'limit must be at least 1')
    const query: LongFormMomentSearchQuery = {
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      contextBeforeMs: boundedInteger(
        request.contextBeforeMs,
        'contextBeforeMs',
        15_000,
        300_000,
      ),
      contextAfterMs: boundedInteger(
        request.contextAfterMs,
        'contextAfterMs',
        15_000,
        300_000,
      ),
      limit,
      now: validNow(dependencies.clock(), 'long-form search clock'),
      ...(optionalText(request.text, 'q')
        ? { text: optionalText(request.text, 'q') }
        : {}),
      ...(request.chapterId
        ? { chapterId: identity(request.chapterId, 'chapterId') }
        : {}),
      ...(request.sourceArtifactId
        ? {
            sourceArtifactId: identity(
              request.sourceArtifactId,
              'sourceArtifactId',
            ),
          }
        : {}),
      ...(request.speakerId
        ? { speakerId: identity(request.speakerId, 'speakerId') }
        : {}),
      ...(optionalText(request.role, 'role')
        ? { role: optionalText(request.role, 'role') }
        : {}),
      ...(optionalText(request.tag, 'tag')
        ? { tag: optionalText(request.tag, 'tag') }
        : {}),
      ...(request.minSalience !== undefined
        ? {
            minSalience: finiteScore(
              request.minSalience,
              'minSalience',
            ),
          }
        : {}),
    }
    return dependencies.repository.search(query)
  }
}

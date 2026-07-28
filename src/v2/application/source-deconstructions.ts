import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  createSourceDeconstructionReport,
  SOURCE_DECONSTRUCTION_ANALYZER_VERSION,
  SOURCE_DECONSTRUCTION_DESIRED_ROLES,
  SOURCE_DECONSTRUCTION_POLICY_VERSION,
  SOURCE_DECONSTRUCTION_VALIDATION_SCOPES,
  type SourceDeconstructionBoundaryPolicy,
  type SourceDeconstructionDesiredRole,
  type SourceDeconstructionTargetComposition,
  type SourceDeconstructionValidationScope,
} from '../domain/source-deconstruction.ts'
import type {
  SourceDeconstructionRepository,
} from './ports/source-deconstruction-repository.ts'

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
  sourceArtifactId: string
  expectedArtifactSha256: string
  sourceTranscriptId: string
  expectedTranscriptHash: string
  desiredRole: SourceDeconstructionDesiredRole
  validationScope: SourceDeconstructionValidationScope
  targetComposition: Readonly<SourceDeconstructionTargetComposition>
  boundaryPolicy: Readonly<SourceDeconstructionBoundaryPolicy>
  actorClientId: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'source-deconstruction-request/v1',
    policyVersion: SOURCE_DECONSTRUCTION_POLICY_VERSION,
    analyzerVersion: SOURCE_DECONSTRUCTION_ANALYZER_VERSION,
    ...input,
  })
}

function assertReplayFingerprint(
  actual: string,
  expected: string,
) {
  if (actual !== expected) {
    throw new DomainError(
      'IDEMPOTENCY_PAYLOAD_MISMATCH',
      'Idempotency key was used with a different source deconstruction request',
    )
  }
}

export function createSourceDeconstructionService(dependencies: {
  repository: SourceDeconstructionRepository
  clock: () => Date
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    expectedArtifactSha256: string
    sourceTranscriptId: string
    expectedTranscriptHash: string
    desiredRole: SourceDeconstructionDesiredRole
    validationScope: SourceDeconstructionValidationScope
    targetComposition: Readonly<SourceDeconstructionTargetComposition>
    boundaryPolicy: Readonly<SourceDeconstructionBoundaryPolicy>
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sourceArtifactId = identity(
      request.sourceArtifactId,
      'sourceArtifactId',
    )
    const sourceTranscriptId = identity(
      request.sourceTranscriptId,
      'sourceTranscriptId',
    )
    const expectedArtifactSha256 = hash(
      request.expectedArtifactSha256,
      'expectedArtifactSha256',
    )
    const expectedTranscriptHash = hash(
      request.expectedTranscriptHash,
      'expectedTranscriptHash',
    )
    const actorClientId = identity(request.actor?.id, 'actor.id')
    assertDomain(
      SOURCE_DECONSTRUCTION_DESIRED_ROLES.includes(
        request.desiredRole,
      ),
      'INVALID_ARGUMENT',
      'desiredRole is invalid',
    )
    assertDomain(
      SOURCE_DECONSTRUCTION_VALIDATION_SCOPES.includes(
        request.validationScope,
      ),
      'INVALID_ARGUMENT',
      'validationScope is invalid',
    )
    const replayKey = idempotencyKey(request.idempotencyKey)
    const fingerprint = requestFingerprint({
      workspaceId,
      projectId,
      sourceArtifactId,
      expectedArtifactSha256,
      sourceTranscriptId,
      expectedTranscriptHash,
      desiredRole: request.desiredRole,
      validationScope: request.validationScope,
      targetComposition: request.targetComposition,
      boundaryPolicy: request.boundaryPolicy,
      actorClientId,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      projectId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      assertReplayFingerprint(replay.requestFingerprint, fingerprint)
      return Object.freeze({
        report: replay.report,
        replayed: true,
      })
    }
    const source = await dependencies.repository.loadSourceContext({
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceTranscriptId,
      actorClientId,
    })
    if (!source) {
      throw new DomainError(
        'SOURCE_DECONSTRUCTION_SOURCE_NOT_FOUND',
        'Source artifact, transcript or speech catalog was not found',
      )
    }
    assertDomain(
      source.sourceArtifactSha256 === expectedArtifactSha256 &&
        source.sourceTranscriptHash === expectedTranscriptHash,
      'VERSION_CONFLICT',
      'Source artifact or transcript changed before deconstruction',
    )
    const report = createSourceDeconstructionReport({
      id: identity(dependencies.createId(), 'created report ID'),
      workspaceId,
      projectId,
      sourceArtifactId,
      sourceArtifactSha256: expectedArtifactSha256,
      sourceTranscriptId,
      sourceTranscriptHash: expectedTranscriptHash,
      sourceDurationMs: source.sourceDurationMs,
      desiredRole: request.desiredRole,
      validationScope: request.validationScope,
      targetComposition: request.targetComposition,
      boundaryPolicy: request.boundaryPolicy,
      speechEvidence: source.speechEvidence,
      createdByClientId: actorClientId,
      createdAt: dependencies.clock().toISOString(),
    })
    return dependencies.repository.create({
      report,
      requestFingerprint: fingerprint,
      idempotencyKey: replayKey,
    })
  }
}

export function readSourceDeconstructionService(dependencies: {
  repository: SourceDeconstructionRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    reportId: string
  }) {
    const report = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      reportId: identity(request.reportId, 'reportId'),
    })
    if (!report) {
      throw new DomainError(
        'SOURCE_DECONSTRUCTION_NOT_FOUND',
        'Source deconstruction report was not found',
      )
    }
    return report
  }
}

export function listSourceDeconstructionsService(dependencies: {
  repository: SourceDeconstructionRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceArtifactId?: string
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

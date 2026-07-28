import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import {
  CONTAMINATION_POLICY_VERSION,
  createContaminationReport,
  type ContaminationDetector,
  type ContaminationObservation,
  type ContaminationPolicy,
  type ContaminationProtectedRegion,
} from '../domain/contamination-report.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import type {
  ContaminationReportRepository,
} from './ports/contamination-report-repository.ts'
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

function fingerprint(input: {
  workspaceId: string
  projectId: string
  sourceDeconstructionReportId: string
  expectedSourceDeconstructionReportHash: string
  analyzer: Readonly<ContaminationDetector>
  policy: Readonly<ContaminationPolicy>
  observations: readonly Readonly<ContaminationObservation>[]
  protectedRegions: readonly Omit<
    ContaminationProtectedRegion,
    'regionHash'
  >[]
  actorClientId: string
}) {
  return calculateCanonicalHash({
    schemaVersion: 'create-contamination-report-request/v1',
    policyVersion: CONTAMINATION_POLICY_VERSION,
    ...input,
  })
}

export function createContaminationReportService(dependencies: {
  repository: ContaminationReportRepository
  sourceRepository: SourceDeconstructionRepository
  clock: () => Date
  createId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceDeconstructionReportId: string
    expectedSourceDeconstructionReportHash: string
    analyzer: Readonly<ContaminationDetector>
    policy: Readonly<ContaminationPolicy>
    observations: readonly Readonly<ContaminationObservation>[]
    protectedRegions: readonly Omit<
      ContaminationProtectedRegion,
      'regionHash'
    >[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(
      request.workspaceId,
      'workspaceId',
    )
    const projectId = identity(request.projectId, 'projectId')
    const sourceDeconstructionReportId = identity(
      request.sourceDeconstructionReportId,
      'sourceDeconstructionReportId',
    )
    const expectedSourceDeconstructionReportHash = hash(
      request.expectedSourceDeconstructionReportHash,
      'expectedSourceDeconstructionReportHash',
    )
    assertDomain(
      request.actor?.type === 'api-client',
      'AUTH_INVALID',
      'Contamination analysis requires an API client',
    )
    const actorClientId = identity(request.actor.id, 'actor.id')
    const replayKey = idempotencyKey(request.idempotencyKey)
    const requestFingerprint = fingerprint({
      workspaceId,
      projectId,
      sourceDeconstructionReportId,
      expectedSourceDeconstructionReportHash,
      analyzer: request.analyzer,
      policy: request.policy,
      observations: request.observations,
      protectedRegions: request.protectedRegions,
      actorClientId,
    })
    const replay = await dependencies.repository.findCreateReplay({
      workspaceId,
      projectId,
      actorClientId,
      idempotencyKey: replayKey,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different contamination request',
        )
      }
      return Object.freeze({
        report: replay.report,
        replayed: true,
      })
    }
    const source = await dependencies.sourceRepository.read({
      workspaceId,
      projectId,
      reportId: sourceDeconstructionReportId,
    })
    if (!source) {
      throw new DomainError(
        'SOURCE_DECONSTRUCTION_NOT_FOUND',
        'Source deconstruction report was not found',
      )
    }
    const report = createContaminationReport({
      id: identity(dependencies.createId(), 'created report ID'),
      sourceDeconstruction: source,
      expectedSourceDeconstructionReportHash,
      analyzer: request.analyzer,
      policy: request.policy,
      observations: request.observations,
      protectedRegions: request.protectedRegions,
      createdByClientId: actorClientId,
      createdAt: dependencies.clock(),
    })
    return dependencies.repository.create({
      report,
      requestFingerprint,
      idempotencyKey: replayKey,
    })
  }
}

export function readContaminationReportService(dependencies: {
  repository: ContaminationReportRepository
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
        'CONTAMINATION_REPORT_NOT_FOUND',
        'Contamination report was not found',
      )
    }
    return report
  }
}

export function listContaminationReportsService(dependencies: {
  repository: ContaminationReportRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    sourceDeconstructionReportId?: string
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
      ...(request.sourceDeconstructionReportId
        ? {
            sourceDeconstructionReportId: identity(
              request.sourceDeconstructionReportId,
              'sourceDeconstructionReportId',
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

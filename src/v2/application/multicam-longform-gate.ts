import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  buildLegacyRuntimeCriterion,
  describeMulticamLongformCriteria,
  evaluateMulticamLongformGate,
  explainMulticamLongformGate,
  MULTICAM_LONGFORM_GATE_SCHEMA_VERSION,
  type MulticamLongformCriterionEvidenceInput,
  type LegacyRuntimeAuditResult,
} from '../domain/multicam-longform-gate.ts'
import type {
  LegacyRuntimeAuditPort,
  MulticamLongformGateRepository,
  PersistedMulticamLongformGate,
} from './ports/multicam-longform-gate-repository.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'

/**
 * F4.016 — run, read and explain the multicamera/long-form phase gate.
 *
 * The request carries a project id, optionally a session id, the authenticated
 * actor and an idempotency key. It carries no evidence, no measurement and no
 * approval: those come from `repository.readEvidence` (PostgreSQL) and from
 * `legacyAudit.audit` (the module graph), both of which run on the server.
 *
 * The evaluation is synchronous. MAP open question 11 offered a durable
 * `capture_sync_runs`-shaped run instead; a gate evaluation reads rows and
 * writes one record, so a lease, a fencing token and a worker would be
 * ceremony around a single transaction. If a criterion ever has to render
 * media to answer, that decision has to be revisited.
 */

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\-/]{2,127}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function optionalSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null
  assertDomain(
    typeof value === 'string' && SESSION_ID_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    'sessionId is invalid',
  )
  return value.trim()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && IDEMPOTENCY_PATTERN.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function boundedLimit(value: unknown): number {
  const limit = value === undefined ? 20 : value
  assertDomain(
    Number.isSafeInteger(limit) && (limit as number) >= 1 && (limit as number) <= 100,
    'INVALID_ARGUMENT',
    'limit must be an integer between 1 and 100',
  )
  return limit as number
}

export function calculateMulticamLongformGateRecordHash(
  gate: Omit<PersistedMulticamLongformGate, 'recordHash'>,
): string {
  return calculateCanonicalHash(gate)
}

/** The catalogue endpoint's answer: what the gate checks, before any run. */
export function listMulticamLongformGateCriteria() {
  return describeMulticamLongformCriteria()
}

export function evaluateMulticamLongformGateService(dependencies: {
  repository: MulticamLongformGateRepository
  legacyAudit: LegacyRuntimeAuditPort
  clock: () => Date
  createId: () => string
}) {
  return async function evaluate(request: {
    workspaceId: string
    projectId: string
    sessionId?: string | null
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const sessionId = optionalSessionId(request.sessionId)
    requireScope(request.actor, 'projects:write')
    const authenticationAudit = materializeActorAuditContext(request.actor)
    assertDomain(
      authenticationAudit.workspaceId === workspaceId,
      'AUTH_INVALID',
      'gate actor does not belong to the workspace',
    )
    const actorId = identity(authenticationAudit.clientId, 'actor.id')
    const key = idempotencyKey(request.idempotencyKey)
    // The fingerprint binds the key to the whole actor context, not just the
    // client id: the same key replayed by another credential, environment or
    // delegated user is a different request and must not return this answer.
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'multicam-longform-gate-request/v1',
      workspaceId,
      projectId,
      sessionId,
      actorContextHash: authenticationAudit.contextHash,
    })
    const replay = await dependencies.repository.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
      actorContextHash: authenticationAudit.contextHash,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different multicam long-form gate request',
        )
      }
      return Object.freeze({ gate: replay, replayed: true })
    }

    const context = await dependencies.repository.readEvidence({
      workspaceId,
      projectId,
      sessionId,
    })
    if (!context) {
      throw new DomainError(
        'PROJECT_NOT_FOUND',
        'multicam long-form gate project was not found',
      )
    }
    // A scanner that throws must not take the gate down with it: an audit that
    // could not run is missing evidence for criterion 10, which reproves that
    // criterion and the gate while leaving the other nine visible.
    let audit: Readonly<LegacyRuntimeAuditResult> | null = null
    try {
      audit = await dependencies.legacyAudit.audit()
    } catch {
      audit = null
    }
    const evidence: readonly MulticamLongformCriterionEvidenceInput[] = [
      ...context.evidence.filter(
        (item) => item.criterion !== 'no-legacy-runtime-dependency',
      ),
      buildLegacyRuntimeCriterion(audit),
    ]
    const now = dependencies.clock()
    assertDomain(
      !Number.isNaN(now.getTime()),
      'INVALID_ARGUMENT',
      'gate clock is invalid',
    )
    const report = evaluateMulticamLongformGate({
      workspaceId,
      projectId,
      // The session the reader resolved, never the caller's filter: a record
      // that names a session the server never found cannot be read back.
      sessionId: context.resolvedSessionId,
      evidence,
      evaluatedAt: now.toISOString(),
    })
    const content = Object.freeze({
      schemaVersion: MULTICAM_LONGFORM_GATE_SCHEMA_VERSION,
      id: identity(dependencies.createId(), 'gate.id'),
      workspaceId,
      projectId,
      sessionId: context.resolvedSessionId,
      projectVersionId: context.projectVersionId,
      projectVersionHash: context.projectVersionHash,
      report,
      reportFingerprint: report.fingerprint,
      idempotencyKey: key,
      requestFingerprint,
      createdBy: Object.freeze({
        type: 'api-client' as const,
        id: actorId,
      }),
      createdAt: now.toISOString(),
    })
    const gate = Object.freeze({
      ...content,
      recordHash: calculateMulticamLongformGateRecordHash(content),
    })
    return dependencies.repository.persist(gate, authenticationAudit)
  }
}

export function readMulticamLongformGateService(dependencies: {
  repository: MulticamLongformGateRepository
}) {
  return async function read(request: {
    workspaceId: string
    projectId: string
    gateId: string
  }) {
    const gate = await dependencies.repository.read({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      gateId: identity(request.gateId, 'gateId'),
    })
    if (!gate) {
      throw new DomainError(
        'MULTICAM_LONGFORM_GATE_NOT_FOUND',
        'multicam long-form gate was not found',
      )
    }
    return gate
  }
}

export function readLatestMulticamLongformGateService(dependencies: {
  repository: MulticamLongformGateRepository
}) {
  return async function readLatest(request: {
    workspaceId: string
    projectId: string
  }) {
    const gate = await dependencies.repository.readLatest({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
    })
    if (!gate) {
      throw new DomainError(
        'MULTICAM_LONGFORM_GATE_NOT_FOUND',
        'no multicam long-form gate has been evaluated for this project',
      )
    }
    return gate
  }
}

export function listMulticamLongformGatesService(dependencies: {
  repository: MulticamLongformGateRepository
}) {
  return async function list(request: {
    workspaceId: string
    projectId: string
    limit?: number
  }) {
    return dependencies.repository.list({
      workspaceId: identity(request.workspaceId, 'workspaceId'),
      projectId: identity(request.projectId, 'projectId'),
      limit: boundedLimit(request.limit),
    })
  }
}

/**
 * What is still missing on the newest evaluation, ordered so a reader starts
 * with the criteria nothing has ever answered.
 */
export function explainMulticamLongformGateService(dependencies: {
  repository: MulticamLongformGateRepository
}) {
  const readLatest = readLatestMulticamLongformGateService(dependencies)
  return async function explain(request: {
    workspaceId: string
    projectId: string
  }) {
    const gate = await readLatest(request)
    return Object.freeze({
      gateId: gate.id,
      evaluatedAt: gate.report.evaluatedAt,
      ...explainMulticamLongformGate(gate.report),
    })
  }
}

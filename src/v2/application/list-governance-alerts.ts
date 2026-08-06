import { stableSerialize } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type {
  GovernanceAdmissionRepository,
} from './ports/governance-admission-repository.ts'

interface GovernanceAlertCursor {
  v: 1
  workspaceId: string
  createdAt: string
  alertHash: string
}

const CURSOR = /^[A-Za-z0-9_-]{16,1024}$/

function encodeCursor(value: GovernanceAlertCursor): string {
  return Buffer.from(stableSerialize(value), 'utf8').toString('base64url')
}

function decodeCursor(value: string, workspaceId: string) {
  assertDomain(CURSOR.test(value), 'INVALID_CURSOR', 'cursor is invalid')
  try {
    const decoded = Buffer.from(value, 'base64url')
    assertDomain(
      decoded.toString('base64url') === value,
      'INVALID_CURSOR',
      'cursor is invalid',
    )
    const parsed = JSON.parse(decoded.toString('utf8')) as GovernanceAlertCursor
    const createdAt = Date.parse(parsed?.createdAt)
    assertDomain(
      typeof parsed === 'object' && parsed !== null &&
        Object.keys(parsed).toSorted().join(',') ===
          'alertHash,createdAt,v,workspaceId' &&
        parsed.v === 1 && parsed.workspaceId === workspaceId &&
        /^[a-f0-9]{64}$/.test(parsed.alertHash) &&
        Number.isFinite(createdAt) &&
        new Date(createdAt).toISOString() === parsed.createdAt,
      'INVALID_CURSOR',
      'cursor does not match this governance alert query',
    )
    return Object.freeze({
      createdAt: parsed.createdAt,
      alertHash: parsed.alertHash,
    })
  } catch (error) {
    if (error instanceof DomainError) throw error
    throw new DomainError('INVALID_CURSOR', 'cursor is invalid')
  }
}

export function listGovernanceAlertsService(dependencies: {
  repository: Pick<GovernanceAdmissionRepository, 'listAlerts'>
}) {
  return async function query(input: {
    actor: AuthenticatedExternalActor
    workspaceId: string
    limit?: number
    after?: string
  }) {
    requireScope(input.actor, 'clients:admin')
    const audit = materializeActorAuditContext(input.actor)
    const workspaceId = input.workspaceId.trim()
    assertDomain(
      audit.workspaceId === workspaceId,
      'WORKSPACE_NOT_FOUND',
      'Workspace was not found',
    )
    const limit = input.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    const rows = await dependencies.repository.listAlerts({
      workspaceId,
      limit: limit + 1,
      ...(input.after
        ? { after: decodeCursor(input.after, workspaceId) }
        : {}),
    })
    const page = rows.slice(0, limit)
    const last = page.at(-1)
    return Object.freeze({
      entries: Object.freeze(page.map((alert) => Object.freeze({
        schemaVersion: alert.schemaVersion,
        alertHash: alert.alertHash,
        clientId: alert.clientId,
        admissionId: alert.admissionId,
        scopeType: alert.scopeType,
        reasonCode: alert.reasonCode,
        observed: alert.observed,
        threshold: alert.threshold,
        ...(alert.policyHash ? { policyHash: alert.policyHash } : {}),
        anomalyRecoveryBypassed:
          alert.anomalyRecoveryBypassed ?? false,
        ...(alert.windowStartedAt
          ? { windowStartedAt: alert.windowStartedAt }
          : {}),
        ...(alert.windowEndedAt
          ? { windowEndedAt: alert.windowEndedAt }
          : {}),
        createdAt: alert.createdAt,
      }))),
      ...(rows.length > limit && last
        ? {
            nextCursor: encodeCursor({
              v: 1,
              workspaceId,
              createdAt: last.createdAt,
              alertHash: last.alertHash,
            }),
          }
        : {}),
    })
  }
}

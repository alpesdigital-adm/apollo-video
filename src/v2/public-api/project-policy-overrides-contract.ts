import type {
  CurrentProjectPolicyOverrides,
  ProjectPolicyOverridesResult,
} from '../application/ports/project-policy-overrides-repository.ts'
import { DomainError } from '../domain/errors.ts'
import { normalizeProjectOverrides } from '../domain/project-overrides.ts'
import { presentProjectVersionV2 } from './presenters.ts'

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DomainError('INVALID_ARGUMENT', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, fields: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !fields.includes(key))
  if (unknown.length > 0) {
    throw new DomainError('INVALID_ARGUMENT', `${field} contains unknown fields`, { fields: unknown })
  }
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new DomainError('INVALID_ARGUMENT', `${field} is invalid`)
  return value.trim()
}

export function parseSetProjectPolicyOverridesBody(raw: unknown) {
  const body = object(raw, 'body')
  exact(body, ['baseVersionId', 'baseHash', 'overrides', 'reason'], 'body')
  return Object.freeze({
    baseVersionId: string(body.baseVersionId, 'baseVersionId'),
    baseHash: string(body.baseHash, 'baseHash'),
    overrides: normalizeProjectOverrides(body.overrides),
    ...(body.reason !== undefined ? { reason: string(body.reason, 'reason') } : {}),
  })
}

export function presentCurrentProjectPolicyOverrides(value: Readonly<CurrentProjectPolicyOverrides>) {
  return Object.freeze({
    version: presentProjectVersionV2(
      {
        id: value.version.id,
        sequence: value.version.sequence,
        parentVersionId: value.version.parentVersionId,
        baseHash: value.version.baseHash,
        createdAt: value.version.createdAt,
      },
      { current: true, previewAvailable: false },
    ),
    policySnapshot: value.policySnapshot,
    workspaceDefaults: value.workspaceDefaults,
    overrides: value.overrides,
    resolved: value.resolved,
  })
}

export function presentProjectPolicyOverridesResult(value: Readonly<ProjectPolicyOverridesResult>) {
  return Object.freeze({
    command: Object.freeze({
      id: value.command.id,
      type: value.command.type,
      baseVersionId: value.command.baseVersionId,
      author: value.command.author,
      ...(value.command.reason ? { reason: value.command.reason } : {}),
      createdAt: value.command.createdAt,
    }),
    ...presentCurrentProjectPolicyOverrides({
      version: value.version,
      policySnapshot: {
        id: value.policySnapshot.id,
        contentSchemaVersion: value.policySnapshot.contentSchemaVersion,
        contentHash: value.policySnapshot.contentHash,
      },
      workspaceDefaults: value.workspaceDefaults,
      overrides: value.overrides,
      resolved: value.resolved,
    }),
    impact: value.impact,
    invalidations: value.invalidations,
    nextRequiredCapability: value.command.payload.nextRequiredCapability,
    replayed: value.replayed,
  })
}

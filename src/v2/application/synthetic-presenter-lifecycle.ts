import { assertDomain, DomainError } from '../domain/errors.ts'
import type { SyntheticPresenterProfileSnapshot } from '../domain/synthetic-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'
import type { registerSyntheticPresenterProfileService } from './synthetic-production.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/

function identity(value: string, field: string): string {
  assertDomain(ID.test(value), 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function workspaceBoundActor(actor: Readonly<AuthenticatedExternalActor>, workspaceId: string, scope: 'projects:read' | 'projects:write') {
  requireScope(actor, scope)
  const audit = materializeActorAuditContext(actor)
  assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Presenter lifecycle actor does not belong to workspace')
  return audit
}

export function listSyntheticPresenterProfilesService(dependencies: { repository: SyntheticProductionRepository }) {
  return async function execute(request: { workspaceId: string; actor: Readonly<AuthenticatedExternalActor> }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    workspaceBoundActor(request.actor, workspaceId, 'projects:read')
    return dependencies.repository.listProfileHeads({ workspaceId })
  }
}

export function readSyntheticPresenterProfileService(dependencies: { repository: SyntheticProductionRepository }) {
  return async function execute(request: { workspaceId: string; profileId: string; actor: Readonly<AuthenticatedExternalActor> }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    workspaceBoundActor(request.actor, workspaceId, 'projects:read')
    const head = await dependencies.repository.readProfileHead({
      workspaceId,
      profileId: identity(request.profileId, 'profileId'),
    })
    if (!head) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic presenter profile was not found')
    const versions = await dependencies.repository.listProfileVersions({ workspaceId, profileId: request.profileId })
    return Object.freeze({ ...head, versions })
  }
}

export interface SyntheticPresenterProfileChanges {
  avatar?: SyntheticPresenterProfileSnapshot['avatar']
  voice?: SyntheticPresenterProfileSnapshot['voice']
  defaultLocale?: string
  status?: SyntheticPresenterProfileSnapshot['status']
  disclosure?: string
  consent?: Omit<SyntheticPresenterProfileSnapshot['consent'], 'snapshotHash' | 'evidenceSha256'>
  pronunciationDictionaryRef?: string | null
  visualContinuity?: SyntheticPresenterProfileSnapshot['visualContinuity'] | null
  restrictions?: readonly string[] | null
}

/**
 * Every relevant change appends exactly the next immutable version and
 * advances the head under strict optimistic concurrency: the caller must name
 * the version it believes is current. History is never mutated.
 */
export function createSyntheticPresenterProfileVersionService(dependencies: {
  repository: SyntheticProductionRepository
  register: ReturnType<typeof registerSyntheticPresenterProfileService>
}) {
  return async function execute(request: {
    workspaceId: string
    profileId: string
    expectedVersion: number
    changes: Readonly<SyntheticPresenterProfileChanges>
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const audit = workspaceBoundActor(request.actor, workspaceId, 'projects:write')
    const profileId = identity(request.profileId, 'profileId')
    assertDomain(
      Number.isSafeInteger(request.expectedVersion) && request.expectedVersion >= 1,
      'INVALID_ARGUMENT',
      'expectedVersion must be a positive ordinal',
    )
    // Replay resolves before optimistic concurrency: a repeated command sees
    // its own already-appended version, never a spurious conflict.
    const replay = await dependencies.repository.findProfileReplay({
      workspaceId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: request.idempotencyKey,
    })
    if (replay) return Object.freeze({ profile: replay, replayed: true })
    const persisted = await dependencies.repository.readProfileHead({ workspaceId, profileId })
    if (!persisted) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic presenter profile was not found')
    assertDomain(
      persisted.head.currentVersion === request.expectedVersion,
      'VERSION_CONFLICT',
      'Synthetic presenter profile advanced concurrently',
    )
    const current = persisted.current.snapshot
    const changes = request.changes
    const consent = changes.consent ?? {
      id: current.consent.id,
      evidenceArtifactId: current.consent.evidenceArtifactId,
      granted: current.consent.granted,
      allowedUses: current.consent.allowedUses,
      allowedMarkets: current.consent.allowedMarkets,
      allowedLocales: current.consent.allowedLocales,
      allowedOperations: current.consent.allowedOperations,
      expiresAt: current.consent.expiresAt,
      ...(current.consent.revokedAt ? { revokedAt: current.consent.revokedAt } : {}),
    }
    const pronunciationDictionaryRef = changes.pronunciationDictionaryRef === null
      ? undefined
      : changes.pronunciationDictionaryRef ?? current.pronunciationDictionaryRef
    const visualContinuity = changes.visualContinuity === null
      ? undefined
      : changes.visualContinuity ?? current.visualContinuity
    const restrictions = changes.restrictions === null
      ? undefined
      : changes.restrictions ?? current.restrictions
    return dependencies.register({
      workspaceId,
      profileId,
      version: request.expectedVersion + 1,
      actorIdentityId: current.actorIdentityId,
      avatar: changes.avatar ?? current.avatar,
      voice: changes.voice ?? current.voice,
      defaultLocale: changes.defaultLocale ?? current.defaultLocale,
      status: changes.status ?? current.status,
      disclosure: changes.disclosure ?? current.disclosure,
      consent,
      ...(pronunciationDictionaryRef ? { pronunciationDictionaryRef } : {}),
      ...(visualContinuity ? { visualContinuity } : {}),
      ...(restrictions ? { restrictions } : {}),
      actor: request.actor,
      idempotencyKey: request.idempotencyKey,
    })
  }
}

/**
 * Activation is gated: a profile whose current consent is missing, revoked or
 * expired can never be reactivated — the invalid consent must be replaced
 * with a fresh attached proof first.
 */
export function setSyntheticPresenterProfileStatusService(dependencies: {
  repository: SyntheticProductionRepository
  createVersion: ReturnType<typeof createSyntheticPresenterProfileVersionService>
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    profileId: string
    expectedVersion: number
    status: 'active' | 'disabled'
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    assertDomain(['active', 'disabled'].includes(request.status), 'INVALID_ARGUMENT', 'Lifecycle status must be active or disabled')
    if (request.status === 'active') {
      const persisted = await dependencies.repository.readProfileHead({
        workspaceId: identity(request.workspaceId, 'workspaceId'),
        profileId: identity(request.profileId, 'profileId'),
      })
      if (!persisted) throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic presenter profile was not found')
      const consent = persisted.current.snapshot.consent
      const now = dependencies.clock()
      assertDomain(
        consent.granted &&
          (!consent.revokedAt || Date.parse(consent.revokedAt) > now.getTime()) &&
          Date.parse(consent.expiresAt) > now.getTime(),
        'ASSET_RIGHTS_BLOCKED',
        'A profile cannot be reactivated while its consent is missing, revoked or expired',
      )
    }
    return dependencies.createVersion({
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      expectedVersion: request.expectedVersion,
      changes: { status: request.status },
      actor: request.actor,
      idempotencyKey: request.idempotencyKey,
    })
  }
}

/** Attaching a consent proof is itself an auditable immutable version. */
export function attachSyntheticPresenterConsentProofService(dependencies: {
  createVersion: ReturnType<typeof createSyntheticPresenterProfileVersionService>
}) {
  return async function execute(request: {
    workspaceId: string
    profileId: string
    expectedVersion: number
    consent: Omit<SyntheticPresenterProfileSnapshot['consent'], 'snapshotHash' | 'evidenceSha256'>
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    return dependencies.createVersion({
      workspaceId: request.workspaceId,
      profileId: request.profileId,
      expectedVersion: request.expectedVersion,
      changes: { consent: request.consent },
      actor: request.actor,
      idempotencyKey: request.idempotencyKey,
    })
  }
}

import {
  calculateCanonicalHash,
  stableSerialize,
} from '../domain/canonical-hash.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'
import { createProjectSnapshot } from '../domain/project-snapshot.ts'
import {
  createSyntheticPresenterEditPlan,
  createSyntheticPresenterProfileSnapshot,
  type ApprovedSyntheticBlock,
  type SyntheticAudioMasterRef,
  type SyntheticPresenterProfileSnapshot,
  type SyntheticVisualInsert,
} from '../domain/synthetic-production.ts'
import {
  materializeActorAuditContext,
  requireScope,
  type AuthenticatedExternalActor,
} from './authenticate-api-client.ts'
import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type {
  MediaArtifactQueryRepository,
  MediaArtifactRecord,
} from './ports/media-artifact-query-repository.ts'
import type { ProjectWorkspaceQueryRepository } from './ports/project-workspace-query-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const KEY = /^[\x21-\x7E]{8,128}$/

function identity(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function idempotencyKey(value: unknown): string {
  assertDomain(
    typeof value === 'string' && KEY.test(value.trim()),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return value.trim()
}

function currentTime(clock: () => Date): Date {
  const now = clock()
  assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
  return now
}

async function availableArtifact(
  repository: MediaArtifactQueryRepository,
  workspaceId: string,
  artifactId: string,
  expectedKinds: readonly MediaArtifactRecord['mediaType'][],
): Promise<Readonly<MediaArtifactRecord>> {
  const artifact = await repository.findById(workspaceId, identity(artifactId, 'artifactId'))
  if (!artifact) {
    throw new DomainError('MEDIA_ARTIFACT_NOT_FOUND', 'Synthetic production artifact was not found')
  }
  assertDomain(
    artifact.status === 'available' && expectedKinds.includes(artifact.mediaType),
    'ASSET_NOT_USABLE',
    'Synthetic production artifact is unavailable or has an incompatible type',
  )
  return artifact
}

export function registerSyntheticPresenterProfileService(dependencies: {
  repository: SyntheticProductionRepository
  artifacts: MediaArtifactQueryRepository
  clock: () => Date
}) {
  return async function execute(request: {
    workspaceId: string
    profileId: string
    version: number
    actorIdentityId: string
    avatar: SyntheticPresenterProfileSnapshot['avatar']
    voice: SyntheticPresenterProfileSnapshot['voice']
    defaultLocale: string
    status: SyntheticPresenterProfileSnapshot['status']
    disclosure: string
    consent: Omit<SyntheticPresenterProfileSnapshot['consent'], 'snapshotHash' | 'evidenceSha256'>
    pronunciationDictionaryRef?: string
    visualContinuity?: SyntheticPresenterProfileSnapshot['visualContinuity']
    restrictions?: readonly string[]
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Profile actor does not belong to workspace')
    const key = idempotencyKey(request.idempotencyKey)
    const createdAt = currentTime(dependencies.clock).toISOString()
    const evidence = await availableArtifact(
      dependencies.artifacts,
      workspaceId,
      request.consent.evidenceArtifactId,
      ['data'],
    )
    const snapshot = createSyntheticPresenterProfileSnapshot({
      id: identity(request.profileId, 'profileId'),
      version: request.version,
      actorIdentityId: request.actorIdentityId,
      avatar: request.avatar,
      voice: request.voice,
      defaultLocale: request.defaultLocale,
      status: request.status,
      disclosure: request.disclosure,
      consent: {
        ...request.consent,
        evidenceSha256: evidence.sha256,
      },
      ...(request.pronunciationDictionaryRef ? { pronunciationDictionaryRef: request.pronunciationDictionaryRef } : {}),
      ...(request.visualContinuity ? { visualContinuity: request.visualContinuity } : {}),
      ...(request.restrictions ? { restrictions: request.restrictions } : {}),
    })
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'register-synthetic-presenter-profile-request/v1',
      workspaceId,
      snapshotHash: snapshot.snapshotHash,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.repository.findProfileReplay({
      workspaceId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different synthetic profile',
        )
      }
      return Object.freeze({ profile: replay, replayed: true })
    }
    return dependencies.repository.createProfile({
      snapshot,
      workspaceId,
      requestFingerprint,
      idempotencyKey: key,
      authenticationAudit: audit,
      createdAt,
    })
  }
}

export function createSyntheticProductionRunService(dependencies: {
  repository: SyntheticProductionRepository
  projects: ProjectWorkspaceQueryRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  clock: () => Date
  createRunId: () => string
  createSnapshotId: () => string
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    profileSnapshotId: string
    audio: Omit<SyntheticAudioMasterRef, keyof Pick<SyntheticAudioMasterRef, 'id' | 'artifactKey' | 'kind' | 'sha256' | 'byteSize'>> & { artifactId: string }
    blocks: readonly Readonly<Omit<ApprovedSyntheticBlock, 'artifact'> & { artifactId: string }>[]
    bRoll?: readonly Readonly<Omit<SyntheticVisualInsert, 'artifact'> & { artifactId: string }>[]
    overlays?: readonly Readonly<Omit<SyntheticVisualInsert, 'artifact'> & { artifactId: string }>[]
    captions: boolean
    use: string
    market: string
    actor: Readonly<AuthenticatedExternalActor>
    idempotencyKey: string
  }) {
    requireScope(request.actor, 'projects:write')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const audit = materializeActorAuditContext(request.actor)
    assertDomain(audit.workspaceId === workspaceId, 'AUTH_INVALID', 'Synthetic run actor does not belong to workspace')
    const key = idempotencyKey(request.idempotencyKey)
    const now = currentTime(dependencies.clock)
    const requestBodyHash = calculateCanonicalHash({
      schemaVersion: 'create-synthetic-production-run-request/v1',
      projectVersionId,
      profileSnapshotId: request.profileSnapshotId,
      audio: request.audio,
      blocks: request.blocks,
      bRoll: request.bRoll ?? [],
      overlays: request.overlays ?? [],
      captions: request.captions,
      use: request.use,
      market: request.market,
      actorContextHash: audit.contextHash,
    })
    const replay = await dependencies.repository.findRunReplay({
      workspaceId,
      projectId,
      actorClientId: audit.clientId,
      actorContextHash: audit.contextHash,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestBodyHash) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different synthetic production request',
        )
      }
      return Object.freeze({ run: replay, replayed: true })
    }
    const workspace = await dependencies.projects.read({ workspaceId, projectId })
    if (!workspace) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    assertDomain(
      workspace.project.currentVersionId === projectVersionId &&
        workspace.version?.id === projectVersionId,
      'VERSION_CONFLICT',
      'Synthetic production must target the current project version',
    )
    const persistedProfile = await dependencies.repository.readProfile({
      workspaceId,
      snapshotId: identity(request.profileSnapshotId, 'profileSnapshotId'),
    })
    if (!persistedProfile) {
      throw new DomainError('PRECONDITION_REQUIRED', 'Synthetic presenter profile was not found')
    }
    const audioRow = await availableArtifact(dependencies.artifacts, workspaceId, request.audio.artifactId, ['audio'])
    const blockRows = await Promise.all(request.blocks.map((entry) =>
      availableArtifact(dependencies.artifacts, workspaceId, entry.artifactId, ['video'])))
    const bRollRows = await Promise.all((request.bRoll ?? []).map((entry) =>
      availableArtifact(dependencies.artifacts, workspaceId, entry.artifactId, ['video', 'image'])))
    const overlayRows = await Promise.all((request.overlays ?? []).map((entry) =>
      availableArtifact(dependencies.artifacts, workspaceId, entry.artifactId, ['video', 'image'])))
    const rows = [audioRow, ...blockRows, ...bRollRows, ...overlayRows]
    assertDomain(
      new Set(rows.map((entry) => entry.id)).size === rows.length,
      'INVALID_ARGUMENT',
      'Synthetic production cannot reuse one artifact in multiple plan roles',
    )
    const rights = await dependencies.rights.findCurrentForArtifacts(
      workspaceId,
      rows.map((entry) => entry.id),
    )
    const decisions = rows.map((entry) => ({
      artifactId: entry.id,
      ...evaluateAssetUse(rights.get(entry.id) ?? null, {
        workspaceId,
        use: request.use,
        market: request.market,
        locale: request.audio.locale,
        syntheticOperations: ['tts', 'audio-avatar'],
      }, now),
    }))
    assertDomain(
      decisions.every((entry) => entry.outcome === 'allow'),
      'ASSET_RIGHTS_BLOCKED',
      'Synthetic production contains an asset without current compatible rights or consent',
      { decisions },
    )
    const validUntil = decisions
      .flatMap((entry) => entry.outcome === 'allow' ? [entry.validUntil] : [])
      .toSorted()[0]
    assertDomain(Boolean(validUntil), 'ASSET_RIGHTS_BLOCKED', 'Synthetic authorization has no validity window')
    const authorizationDecisions = decisions.map((entry) => {
      assertDomain(
        entry.outcome === 'allow' &&
          Boolean(entry.rightsSnapshotId) &&
          Boolean(entry.rightsSnapshotHash) &&
          Boolean(entry.validUntil),
        'ASSET_RIGHTS_BLOCKED',
        'Synthetic authorization decision is incomplete',
      )
      return Object.freeze({
        artifactId: entry.artifactId,
        rightsSnapshotId: entry.rightsSnapshotId!,
        rightsSnapshotHash: entry.rightsSnapshotHash!,
        validUntil: entry.validUntil!,
      })
    })
    const authorizationBody = Object.freeze({
      id: `synthetic-authorization-${requestBodyHash.slice(0, 24)}`,
      outcome: 'allowed' as const,
      use: request.use,
      market: request.market,
      locale: request.audio.locale,
      syntheticOperations: Object.freeze(['tts', 'audio-avatar'] as const),
      artifactIds: Object.freeze(rows.map((entry) => entry.id)),
      decisions: Object.freeze(authorizationDecisions),
      evaluatedAt: now.toISOString(),
      expiresAt: validUntil!,
    })
    const authorization = Object.freeze({
      ...authorizationBody,
      authorizationHash: calculateCanonicalHash(authorizationBody),
    })
    const toRef = (row: Readonly<MediaArtifactRecord>) => Object.freeze({
      id: `asset-${row.id}`,
      artifactId: row.id,
      artifactKey: row.artifactKey,
      kind: row.mediaType as 'video' | 'audio' | 'image',
      sha256: row.sha256,
      byteSize: Number(row.byteSize),
    })
    const plan = createSyntheticPresenterEditPlan({
      id: identity(dependencies.createRunId(), 'createRunId()'),
      workspaceId,
      projectId,
      projectVersionId,
      profile: persistedProfile.snapshot,
      audio: {
        ...toRef(audioRow),
        kind: 'audio',
        durationMs: request.audio.durationMs,
        locale: request.audio.locale,
        scriptHash: request.audio.scriptHash,
        alignment: request.audio.alignment,
      },
      blocks: request.blocks.map((entry, index) => ({
        ...entry,
        artifact: { ...toRef(blockRows[index]!), kind: 'video' },
      })),
      bRoll: (request.bRoll ?? []).map((entry, index) => ({
        ...entry,
        artifact: {
          ...toRef(bRollRows[index]!),
          kind: bRollRows[index]!.mediaType as 'video' | 'image',
        },
      })),
      overlays: (request.overlays ?? []).map((entry, index) => ({
        ...entry,
        artifact: {
          ...toRef(overlayRows[index]!),
          kind: overlayRows[index]!.mediaType as 'video' | 'image',
        },
      })),
      captions: request.captions,
      use: request.use,
      market: request.market,
      authorization,
      createdAt: now.toISOString(),
    })
    const editPlanSnapshot = createProjectSnapshot({
      id: identity(dependencies.createSnapshotId(), 'createSnapshotId()'),
      workspaceId,
      projectId,
      kind: 'edit-plan',
      contentSchemaVersion: 1,
      contentJson: stableSerialize(plan),
      contentHash: plan.planHash,
      createdAt: now.toISOString(),
    })
    return dependencies.repository.createRun({
      plan,
      editPlanSnapshot,
      requestFingerprint: requestBodyHash,
      idempotencyKey: key,
      authenticationAudit: audit,
    })
  }
}

export function readSyntheticProductionRunService(dependencies: {
  repository: SyntheticProductionRepository
}) {
  return async function execute(request: {
    workspaceId: string
    projectId: string
    runId: string
    actor: Readonly<AuthenticatedExternalActor>
  }) {
    requireScope(request.actor, 'projects:read')
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    assertDomain(
      request.actor.workspaceId === workspaceId,
      'AUTH_INVALID',
      'Synthetic run actor does not belong to workspace',
    )
    const run = await dependencies.repository.readRun({
      workspaceId,
      projectId: identity(request.projectId, 'projectId'),
      runId: identity(request.runId, 'runId'),
    })
    if (!run) {
      throw new DomainError('PROJECT_NOT_FOUND', 'Synthetic production run was not found')
    }
    return run
  }
}

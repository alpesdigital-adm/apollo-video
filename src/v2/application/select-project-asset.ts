import type { AssetRightsRepository } from './ports/asset-rights-repository.ts'
import type { AssetSelectionRepository } from './ports/asset-selection-repository.ts'
import type { MediaArtifactQueryRepository } from './ports/media-artifact-query-repository.ts'
import {
  calculateAssetSelectionRecordHash,
  createAssetBrief,
  createAssetCandidate,
  selectAsset,
  type AssetBrief,
  type AssetCandidate,
  type AssetCandidateRightsEvidence,
} from '../domain/asset-selection.ts'
import { evaluateAssetUse } from '../domain/asset-rights.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { assertDomain, DomainError } from '../domain/errors.ts'

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const IDEMPOTENCY_PATTERN = /^[\x21-\x7E]{8,128}$/
const SHA_256_PATTERN = /^[a-f0-9]{64}$/

export type AssetSelectionCandidateInput = Readonly<
  Omit<AssetCandidate, 'id' | 'rights'> & { artifactId: string }
>

function identity(value: string, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(ID_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function sha256(value: string, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim().toLowerCase()
  assertDomain(SHA_256_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} must be a SHA-256 hash`)
  return normalized
}

function idempotencyKey(value: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', 'Idempotency-Key must be a string')
  const normalized = value.trim()
  assertDomain(
    IDEMPOTENCY_PATTERN.test(normalized),
    'INVALID_ARGUMENT',
    'Idempotency-Key must contain 8 to 128 visible ASCII characters',
  )
  return normalized
}

function normalizeRequestedCandidates(
  values: readonly AssetSelectionCandidateInput[],
): readonly Readonly<AssetSelectionCandidateInput>[] {
  assertDomain(Array.isArray(values), 'INVALID_ARGUMENT', 'candidates must be an array')
  const normalized = values.map((candidate) => {
    assertDomain(
      typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate),
      'INVALID_ARGUMENT',
      'Each asset candidate must be an object',
    )
    const artifactId = identity(candidate.artifactId, 'candidate.artifactId')
    const validated = createAssetCandidate({
      id: artifactId,
      source: candidate.source,
      content: candidate.content,
      style: candidate.style,
      durationMs: candidate.durationMs,
      rights: 'unknown',
      quality: candidate.quality,
      continuity: candidate.continuity,
      novelty: candidate.novelty,
      literalness: candidate.literalness,
    })
    return Object.freeze({
      artifactId,
      source: validated.source,
      content: validated.content,
      style: validated.style,
      durationMs: validated.durationMs,
      quality: validated.quality,
      continuity: validated.continuity,
      novelty: validated.novelty,
      literalness: validated.literalness,
    })
  }).sort((left, right) => left.artifactId.localeCompare(right.artifactId))
  assertDomain(
    new Set(normalized.map((candidate) => candidate.artifactId)).size === normalized.length,
    'INVALID_ARGUMENT',
    'Asset candidate artifact identities must be unique',
  )
  return Object.freeze(normalized)
}

export function selectProjectAssetService(dependencies: {
  selections: AssetSelectionRepository
  artifacts: MediaArtifactQueryRepository
  rights: AssetRightsRepository
  clock: () => Date
  createId: () => string
}) {
  return async function select(request: {
    workspaceId: string
    projectId: string
    projectVersionId: string
    projectVersionHash: string
    brief: AssetBrief
    candidates: readonly AssetSelectionCandidateInput[]
    actor: Readonly<{ type: 'api-client'; id: string }>
    idempotencyKey: string
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = identity(request.projectVersionId, 'projectVersionId')
    const projectVersionHash = sha256(request.projectVersionHash, 'projectVersionHash')
    const actorId = identity(request.actor.id, 'actor.id')
    assertDomain(request.actor.type === 'api-client', 'INVALID_ARGUMENT', 'Asset selection actor is invalid')
    const key = idempotencyKey(request.idempotencyKey)
    const brief = createAssetBrief(request.brief)
    const requestedCandidates = normalizeRequestedCandidates(request.candidates)
    const requestFingerprint = calculateCanonicalHash({
      schemaVersion: 'asset-selection-request/v1',
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      brief,
      candidates: requestedCandidates,
      actor: { type: 'api-client', id: actorId },
    })
    const replay = await dependencies.selections.findIdempotent({
      workspaceId,
      projectId,
      idempotencyKey: key,
    })
    if (replay) {
      if (replay.requestFingerprint !== requestFingerprint) {
        throw new DomainError(
          'IDEMPOTENCY_PAYLOAD_MISMATCH',
          'Idempotency key was used with a different asset selection request',
        )
      }
      return Object.freeze({ selection: replay, replayed: true })
    }

    const context = await dependencies.selections.readProjectContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    if (
      context.projectVersionId !== projectVersionId ||
      context.projectVersionHash !== projectVersionHash
    ) {
      throw new DomainError('VERSION_CONFLICT', 'Asset selection base version is stale', {
        currentVersionId: context.projectVersionId,
        currentVersionHash: context.projectVersionHash,
      })
    }

    const artifacts = await Promise.all(
      requestedCandidates.map((candidate) =>
        dependencies.artifacts.findById(workspaceId, candidate.artifactId)),
    )
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index]
      const candidate = requestedCandidates[index]
      if (
        !artifact ||
        artifact.status !== 'available' ||
        !['video', 'image'].includes(artifact.mediaType)
      ) {
        throw new DomainError(
          'ASSET_NOT_USABLE',
          'Asset candidate is missing, unavailable or not visual media',
          { artifactId: candidate.artifactId },
        )
      }
    }

    const evaluatedAt = dependencies.clock()
    assertDomain(!Number.isNaN(evaluatedAt.getTime()), 'INVALID_ARGUMENT', 'Selection clock is invalid')
    const rightsByArtifact = await dependencies.rights.findCurrentForArtifacts(
      workspaceId,
      requestedCandidates.map((candidate) => candidate.artifactId),
    )
    const candidates: AssetCandidate[] = []
    const rightsEvidence: AssetCandidateRightsEvidence[] = []
    for (let index = 0; index < requestedCandidates.length; index += 1) {
      const requested = requestedCandidates[index]
      const artifact = artifacts[index]
      if (!artifact) throw new DomainError('ASSET_NOT_FOUND', 'Asset candidate was not found')
      const snapshot = rightsByArtifact.get(requested.artifactId) ?? null
      const use = evaluateAssetUse(snapshot, {
        workspaceId,
        use: 'rendering',
        locale: context.locale,
      }, evaluatedAt)
      const rights = use.outcome === 'allow'
        ? 'approved'
        : snapshot === null || snapshot.status === 'unknown'
          ? 'unknown'
          : 'denied'
      candidates.push(createAssetCandidate({
        id: requested.artifactId,
        source: requested.source,
        content: requested.content,
        style: requested.style,
        durationMs: requested.durationMs,
        rights,
        quality: requested.quality,
        continuity: requested.continuity,
        novelty: requested.novelty,
        literalness: requested.literalness,
      }))
      rightsEvidence.push(Object.freeze({
        artifactId: requested.artifactId,
        artifactSha256: artifact.sha256,
        outcome: use.outcome,
        reasonCodes: Object.freeze([...use.reasonCodes]),
        ...(use.rightsSnapshotId ? { rightsSnapshotId: use.rightsSnapshotId } : {}),
        ...(use.rightsSnapshotHash ? { rightsSnapshotHash: use.rightsSnapshotHash } : {}),
        ...(use.validUntil ? { validUntil: use.validUntil } : {}),
      }))
    }
    const frozenCandidates = Object.freeze(candidates)
    const frozenRightsEvidence = Object.freeze(rightsEvidence)
    const result = selectAsset(brief, frozenCandidates)
    const createdAt = evaluatedAt.toISOString()
    const id = identity(dependencies.createId(), 'selection.id')
    const briefHash = calculateCanonicalHash(brief)
    const candidatesHash = calculateCanonicalHash(frozenCandidates)
    const content = Object.freeze({
      schemaVersion: 'asset-selection/v1' as const,
      id,
      workspaceId,
      projectId,
      projectVersionId,
      projectVersionHash,
      brief,
      briefHash,
      candidates: frozenCandidates,
      candidatesHash,
      rightsEvidence: frozenRightsEvidence,
      result,
      idempotencyKey: key,
      requestFingerprint,
      createdBy: Object.freeze({ type: 'api-client' as const, id: actorId }),
      createdAt,
    })
    const selection = Object.freeze({
      ...content,
      selectionHash: calculateAssetSelectionRecordHash(content),
    })
    return dependencies.selections.persist(selection)
  }
}

export function listProjectAssetSelectionsService(dependencies: {
  selections: AssetSelectionRepository
}) {
  return async function list(request: {
    workspaceId: string
    projectId: string
    projectVersionId?: string
    limit?: number
  }) {
    const workspaceId = identity(request.workspaceId, 'workspaceId')
    const projectId = identity(request.projectId, 'projectId')
    const projectVersionId = request.projectVersionId
      ? identity(request.projectVersionId, 'projectVersionId')
      : undefined
    const limit = request.limit ?? 50
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer from 1 to 100',
    )
    const context = await dependencies.selections.readProjectContext({ workspaceId, projectId })
    if (!context) throw new DomainError('PROJECT_NOT_FOUND', 'Project was not found')
    return dependencies.selections.list({
      workspaceId,
      projectId,
      ...(projectVersionId ? { projectVersionId } : {}),
      limit,
    })
  }
}

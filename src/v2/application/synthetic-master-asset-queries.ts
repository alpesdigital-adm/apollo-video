import { assertDomain } from '../domain/errors.ts'
import type { SyntheticSpeechSegment } from '../domain/synthetic-speech-segment.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type {
  PersistedSyntheticMasterAsset,
  SyntheticMasterAssetRepository,
} from './ports/synthetic-master-asset-repository.ts'
import type { SyntheticSpeechSegmentRepository } from './ports/synthetic-speech-segment-repository.ts'

/**
 * Read-side services for the sealed synthetic masters of one project.
 *
 * Every read is workspace-bound by the authenticated actor and project-bound by
 * the persisted master itself: a master that belongs to another project of the
 * same workspace is reported as missing instead of being served through a
 * neighbouring project's path, so the URL can never widen what the caller sees.
 */

export const SYNTHETIC_MASTER_LIST_DEFAULT_LIMIT = 20
export const SYNTHETIC_MASTER_LIST_MAX_LIMIT = 100

function assertReadableWorkspace(actor: AuthenticatedExternalActor, workspaceId: string): void {
  requireScope(actor, 'projects:read')
  assertDomain(
    actor.workspaceId === workspaceId,
    'INVALID_WORKSPACE',
    'Actor cannot read synthetic masters in another workspace',
  )
}

function assertBoundedLimit(limit: number): number {
  assertDomain(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= SYNTHETIC_MASTER_LIST_MAX_LIMIT,
    'INVALID_ARGUMENT',
    `limit must be an integer between 1 and ${SYNTHETIC_MASTER_LIST_MAX_LIMIT}`,
  )
  return limit
}

export interface ReadSyntheticMasterAssetRequest {
  workspaceId: string
  projectId: string
  masterId: string
  actor: AuthenticatedExternalActor
}

export function readSyntheticMasterAssetService(dependencies: {
  masters: SyntheticMasterAssetRepository
}) {
  return async function read(
    request: ReadSyntheticMasterAssetRequest,
  ): Promise<Readonly<PersistedSyntheticMasterAsset>> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    const persisted = await dependencies.masters.read({
      workspaceId: request.workspaceId,
      masterId: request.masterId,
    })
    assertDomain(Boolean(persisted), 'ASSET_NOT_FOUND', 'Synthetic master was not found in this workspace')
    assertDomain(
      persisted!.master.projectId === request.projectId,
      'ASSET_NOT_FOUND',
      'Synthetic master was not found in this project',
    )
    return persisted!
  }
}

export interface ListSyntheticMasterAssetsRequest {
  workspaceId: string
  projectId: string
  actor: AuthenticatedExternalActor
  profileId?: string
  scriptHash?: string
  limit?: number
}

export function listSyntheticMasterAssetsService(dependencies: {
  masters: SyntheticMasterAssetRepository
}) {
  return async function list(
    request: ListSyntheticMasterAssetsRequest,
  ): Promise<readonly Readonly<PersistedSyntheticMasterAsset>[]> {
    assertReadableWorkspace(request.actor, request.workspaceId)
    return await dependencies.masters.list({
      workspaceId: request.workspaceId,
      projectId: request.projectId,
      ...(request.profileId ? { profileId: request.profileId } : {}),
      ...(request.scriptHash ? { scriptHash: request.scriptHash } : {}),
      limit: assertBoundedLimit(request.limit ?? SYNTHETIC_MASTER_LIST_DEFAULT_LIMIT),
    })
  }
}

export interface ListSyntheticSpeechSegmentsRequest {
  workspaceId: string
  projectId: string
  masterId: string
  actor: AuthenticatedExternalActor
}

/**
 * Lists the catalogued sentences of one master. The master is re-read first so
 * a segment listing can never be served for a master the caller cannot read.
 */
export function listSyntheticSpeechSegmentsService(dependencies: {
  masters: SyntheticMasterAssetRepository
  segments: SyntheticSpeechSegmentRepository
}) {
  const readMaster = readSyntheticMasterAssetService({ masters: dependencies.masters })
  return async function listByMaster(
    request: ListSyntheticSpeechSegmentsRequest,
  ): Promise<readonly Readonly<SyntheticSpeechSegment>[]> {
    const persisted = await readMaster(request)
    return await dependencies.segments.listByMaster({
      workspaceId: request.workspaceId,
      masterId: persisted.master.id,
    })
  }
}

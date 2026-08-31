import { assertDomain } from '../domain/errors.ts'
import { findSyntheticMasterArtifact } from '../domain/synthetic-master-asset.ts'
import {
  catalogSyntheticSpeechSegments,
  type SyntheticSpeechSegment,
  type SyntheticSpeechSegmentBlock,
  type SyntheticSpeechSegmentWord,
} from '../domain/synthetic-speech-segment.ts'
import type { AuthenticatedExternalActor } from './authenticate-api-client.ts'
import { requireScope } from './authenticate-api-client.ts'
import type { SyntheticMasterAssetRepository } from './ports/synthetic-master-asset-repository.ts'
import type {
  SyntheticSpeechSegmentRepository,
  SyntheticSpeechSegmentSearchQuery,
} from './ports/synthetic-speech-segment-repository.ts'
import type { SyntheticProductionRepository } from './ports/synthetic-production-repository.ts'

/**
 * Reads the consolidated word timing a master sealed. The words come from the
 * persisted alignment artifact, never from the caller: a caller-supplied range
 * could describe bytes that do not exist.
 */
export interface MasterAlignmentReader {
  readWords(input: {
    workspaceId: string
    artifactId: string
  }): Promise<readonly Readonly<SyntheticSpeechSegmentWord>[]>
}

export interface CatalogSyntheticSpeechSegmentsRequest {
  workspaceId: string
  masterId: string
  /** The approved F3.005 blocks, in master order. Boundaries are not recomputed. */
  blocks: readonly Readonly<SyntheticSpeechSegmentBlock>[]
  actor: AuthenticatedExternalActor
}

export function catalogSyntheticSpeechSegmentsService(dependencies: {
  masters: SyntheticMasterAssetRepository
  segments: SyntheticSpeechSegmentRepository
  profiles: SyntheticProductionRepository
  alignment: MasterAlignmentReader
  createId: (input: { masterId: string; blockId: string; occurrence: number }) => string
}) {
  return async function catalog(request: CatalogSyntheticSpeechSegmentsRequest): Promise<
    Readonly<{ segments: readonly Readonly<SyntheticSpeechSegment>[]; replayed: boolean }>
  > {
    requireScope(request.actor, 'projects:write')
    assertDomain(
      request.actor.workspaceId === request.workspaceId,
      'INVALID_WORKSPACE',
      'Actor cannot catalog segments in another workspace',
    )

    const persisted = await dependencies.masters.read({
      workspaceId: request.workspaceId,
      masterId: request.masterId,
    })
    assertDomain(Boolean(persisted), 'ASSET_NOT_FOUND', 'Synthetic master was not found in this workspace')
    const master = persisted!.master

    const existing = await dependencies.segments.listByMaster({
      workspaceId: request.workspaceId,
      masterId: master.id,
    })
    if (existing.length > 0) return Object.freeze({ segments: existing, replayed: true })

    const profile = await dependencies.profiles.readProfile({
      workspaceId: request.workspaceId,
      snapshotId: master.profileSnapshotId,
    })
    assertDomain(Boolean(profile), 'ASSET_NOT_FOUND', 'Presenter snapshot behind the master is missing')
    const snapshot = profile!.snapshot

    const words = await dependencies.alignment.readWords({
      workspaceId: request.workspaceId,
      artifactId: findSyntheticMasterArtifact(master, 'alignment').artifactId,
    })

    const segments = catalogSyntheticSpeechSegments({
      master,
      blocks: request.blocks,
      words,
      identity: {
        actorIdentityId: snapshot.actorIdentityId,
        profileId: master.profileId,
        profileVersion: master.profileVersion,
        voiceId: snapshot.voice.id,
        voiceVersion: snapshot.voice.version,
        avatarIdentityRef: snapshot.avatar.identityRef,
        // No measured emotion source exists yet; inventing one would make the
        // catalog answer a question nothing verified.
        emotion: null,
        wardrobe: snapshot.visualContinuity?.wardrobe ?? null,
        background: snapshot.visualContinuity?.background ?? null,
        framing: snapshot.visualContinuity?.framing ?? null,
      },
      createId: (block) => dependencies.createId({
        masterId: master.id,
        blockId: block.blockId,
        occurrence: block.occurrence,
      }),
    })

    return await dependencies.segments.catalog({
      masterId: master.id,
      workspaceId: request.workspaceId,
      segments,
    })
  }
}

export function searchSyntheticSpeechSegmentsService(dependencies: {
  segments: SyntheticSpeechSegmentRepository
}) {
  return async function search(request: {
    workspaceId: string
    actor: AuthenticatedExternalActor
    query: Omit<SyntheticSpeechSegmentSearchQuery, 'workspaceId' | 'limit'> & { limit?: number }
  }): Promise<readonly Readonly<SyntheticSpeechSegment>[]> {
    requireScope(request.actor, 'projects:read')
    assertDomain(
      request.actor.workspaceId === request.workspaceId,
      'INVALID_WORKSPACE',
      'Actor cannot search segments in another workspace',
    )
    const limit = request.query.limit ?? 20
    assertDomain(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'INVALID_ARGUMENT',
      'limit must be an integer between 1 and 100',
    )
    return await dependencies.segments.search({ ...request.query, workspaceId: request.workspaceId, limit })
  }
}

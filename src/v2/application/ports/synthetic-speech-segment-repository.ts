import type { SyntheticSpeechSegment } from '../../domain/synthetic-speech-segment.ts'

export interface SyntheticSpeechSegmentSearchQuery {
  workspaceId: string
  projectId?: string
  profileId?: string
  locale?: string
  text?: string
  emotion?: string
  wardrobe?: string
  setting?: string
  scriptHash?: string
  limit: number
}

export interface SyntheticSpeechSegmentRepository {
  /**
   * Catalogs a master's segments atomically. Re-cataloguing the same master
   * returns the stored rows instead of duplicating them: the catalog is a
   * deterministic function of the sealed master.
   */
  catalog(input: {
    masterId: string
    workspaceId: string
    segments: readonly Readonly<SyntheticSpeechSegment>[]
  }): Promise<Readonly<{ segments: readonly Readonly<SyntheticSpeechSegment>[]; replayed: boolean }>>

  listByMaster(input: {
    workspaceId: string
    masterId: string
  }): Promise<readonly Readonly<SyntheticSpeechSegment>[]>

  read(input: {
    workspaceId: string
    segmentId: string
  }): Promise<Readonly<SyntheticSpeechSegment> | null>

  search(query: Readonly<SyntheticSpeechSegmentSearchQuery>): Promise<readonly Readonly<SyntheticSpeechSegment>[]>
}

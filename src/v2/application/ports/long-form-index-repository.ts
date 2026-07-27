import type {
  CatalogedLongFormChapter,
  CatalogedLongFormMoment,
  LongFormMomentPreview,
  LongFormProducer,
} from '../../domain/long-form-moment.ts'

export interface LongFormRightsSnapshot {
  id: string
  status: string
  consentStatus: string
  expiresAt?: string
  consentExpiresAt?: string
}

export interface LongFormIndexCreationContext {
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  durationMs: number
  rights: Readonly<LongFormRightsSnapshot>
}

export interface PersistedLongFormIndexRun {
  schemaVersion: 'long-form-index-run/v1'
  id: string
  workspaceId: string
  projectId: string
  sourceArtifactId: string
  sourceArtifactSha256: string
  sourceManifestId: string
  sourceManifestHash: string
  durationMs: number
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  indexPolicyVersion: 'long-form-index/v1'
  producer: Readonly<LongFormProducer>
  chapters: readonly Readonly<CatalogedLongFormChapter>[]
  moments: readonly Readonly<CatalogedLongFormMoment>[]
  chapterCount: number
  momentCount: number
  hierarchyHash: string
  requestFingerprint: string
  idempotencyKey: string
  createdBy: Readonly<{ type: 'api-client'; id: string }>
  createdAt: string
  recordHash: string
  active: boolean
}

export interface LongFormMomentSearchQuery {
  workspaceId: string
  projectId: string
  text?: string
  chapterId?: string
  sourceArtifactId?: string
  speakerId?: string
  role?: string
  tag?: string
  minSalience?: number
  contextBeforeMs: number
  contextAfterMs: number
  limit: number
  now: string
}

export interface LongFormMomentSearchResult {
  moment: Readonly<CatalogedLongFormMoment>
  chapter: Readonly<CatalogedLongFormChapter>
  matchedBy: readonly (
    | 'text'
    | 'chapter'
    | 'source-artifact'
    | 'speaker'
    | 'role'
    | 'tag'
    | 'salience'
  )[]
  preview: Readonly<LongFormMomentPreview>
  rightsSnapshotId: string
  rightsStatus: string
  consentStatus: string
  eligibleForReuse: boolean
  blockedReasons: readonly string[]
}

export interface LongFormIndexRepository {
  readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
  }): Promise<Readonly<LongFormIndexCreationContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedLongFormIndexRun> | null>
  persist(
    run: Readonly<PersistedLongFormIndexRun>,
  ): Promise<Readonly<{
    run: Readonly<PersistedLongFormIndexRun>
    replayed: boolean
  }>>
  search(
    query: Readonly<LongFormMomentSearchQuery>,
  ): Promise<readonly Readonly<LongFormMomentSearchResult>[]>
}

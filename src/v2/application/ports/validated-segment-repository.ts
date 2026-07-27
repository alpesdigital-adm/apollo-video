import type {
  CatalogedValidatedSegment,
  ValidatedSegmentSourceContext,
} from '../../domain/validated-segment.ts'

export interface ValidatedSegmentCurrentRights {
  id: string
  status: string
  consentStatus: string
  expiresAt?: string
  consentExpiresAt?: string
}

export interface ValidatedSegmentCreationContext
extends ValidatedSegmentSourceContext {
  currentRights: Readonly<ValidatedSegmentCurrentRights>
}

export interface PersistedValidatedSegment
extends CatalogedValidatedSegment {
  requestFingerprint: string
  idempotencyKey: string
}

export interface ValidatedSegmentSearchQuery {
  workspaceId: string
  projectId: string
  text?: string
  sourceArtifactId?: string
  platform?: string
  unit?: string
  evidenceScope?: string
  metric?: string
  activeAt?: string
  now: string
  limit: number
}

export interface ValidatedSegmentSearchResult {
  segment: Readonly<PersistedValidatedSegment>
  currentRights: Readonly<ValidatedSegmentCurrentRights> | null
  matchedBy: readonly (
    | 'text'
    | 'source-artifact'
    | 'platform'
    | 'unit'
    | 'evidence-scope'
    | 'metric'
    | 'active-at'
  )[]
  eligibleForReuse: boolean
  blockedReasons: readonly string[]
}

export interface ValidatedSegmentReuseContext {
  segment: Readonly<PersistedValidatedSegment>
  currentRights: Readonly<ValidatedSegmentCurrentRights> | null
}

export interface ValidatedSegmentRepository {
  readCreationContext(input: {
    workspaceId: string
    projectId: string
    sourceArtifactId: string
    sourceManifestId: string
    sourceSpeechSegmentId?: string
  }): Promise<Readonly<ValidatedSegmentCreationContext> | null>
  findIdempotent(input: {
    workspaceId: string
    projectId: string
    idempotencyKey: string
  }): Promise<Readonly<PersistedValidatedSegment> | null>
  persist(
    segment: Readonly<PersistedValidatedSegment>,
  ): Promise<Readonly<{
    segment: Readonly<PersistedValidatedSegment>
    replayed: boolean
  }>>
  search(
    query: Readonly<ValidatedSegmentSearchQuery>,
  ): Promise<readonly Readonly<ValidatedSegmentSearchResult>[]>
  readReuseContext(input: {
    workspaceId: string
    projectId: string
    validatedSegmentId: string
  }): Promise<Readonly<ValidatedSegmentReuseContext> | null>
}

import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { CanonicalScriptVersion, LocalizationVariant, LocalizedAudioMode } from '../../domain/localization.ts'
import type { ScriptAlignmentRun } from '../../domain/script-alignment.ts'

export interface LocalizationCanonicalContext {
  alignment: Readonly<ScriptAlignmentRun>
  projectVersionId: string
}

export interface LocalizationSourceAuthority {
  artifactId: string
  sha256: string
  rightsSnapshotId: string
  allowedModes: readonly LocalizedAudioMode[]
}

export interface LocalizationProfileSnapshot {
  id: string
  workspaceId: string
  targetLocale: string
  market?: string
  allowedModes: readonly LocalizedAudioMode[]
  profileHash: string
}

export interface LocalizationMutationRecord {
  previous: Readonly<LocalizationVariant>
  next: Readonly<LocalizationVariant>
  action: 'advance' | 'review' | 'cancel' | 'mark-stale' | 'rebase'
  requestFingerprint: string
  idempotencyKey: string
  authenticationAudit: Readonly<ApiAccessAuditContext>
}

export interface LocalizationRepository {
  findProfileReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<LocalizationProfileSnapshot> | null>
  insertProfile(input: { profile: Readonly<LocalizationProfileSnapshot>; requestFingerprint: string; idempotencyKey: string; actorClientId: string; authenticationAudit: Readonly<ApiAccessAuditContext>; createdAt: string }): Promise<Readonly<{ profile: Readonly<LocalizationProfileSnapshot>; replayed: boolean }>>
  findCanonicalReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<CanonicalScriptVersion> | null>
  loadCanonicalContext(input: { workspaceId: string; projectId: string; projectVersionId: string; alignmentId: string; expectedAlignmentHash: string; actorClientId: string }): Promise<Readonly<LocalizationCanonicalContext>>
  insertCanonical(input: { canonical: Readonly<CanonicalScriptVersion>; alignmentRunHash: string; requestFingerprint: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }): Promise<Readonly<{ canonical: Readonly<CanonicalScriptVersion>; replayed: boolean }>>
  readCanonical(input: { workspaceId: string; projectId: string; canonicalId: string }): Promise<Readonly<CanonicalScriptVersion> | null>
  loadVariantCreationContext(input: { workspaceId: string; projectId: string; canonicalId: string; profileId: string; sourceArtifactId: string; expectedSourceSha256: string; preferredMode: LocalizedAudioMode; actorClientId: string }): Promise<Readonly<{ canonical: Readonly<CanonicalScriptVersion>; profile: Readonly<LocalizationProfileSnapshot>; source: Readonly<LocalizationSourceAuthority> }>>
  findVariantReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<LocalizationVariant> | null>
  insertVariant(input: { variant: Readonly<LocalizationVariant>; profileId: string; source: Readonly<LocalizationSourceAuthority>; requestFingerprint: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }): Promise<Readonly<{ variant: Readonly<LocalizationVariant>; replayed: boolean }>>
  readVariant(input: { workspaceId: string; projectId: string; variantId: string }): Promise<Readonly<LocalizationVariant> | null>
  findMutationReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<LocalizationVariant> | null>
  appendVariantRevision(record: Readonly<LocalizationMutationRecord>): Promise<Readonly<{ variant: Readonly<LocalizationVariant>; replayed: boolean }>>
}

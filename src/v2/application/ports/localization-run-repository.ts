import type { ApiAccessAuditContext } from '../../domain/api-access-control.ts'
import type { LocalizationRun } from '../../domain/localization-run.ts'
import type { CanonicalScriptVersion, LocalizationVariant } from '../../domain/localization.ts'
import type { LocalizationTranslationPreflight } from '../../domain/localization-translation-preflight.ts'

export interface LocalizationRunRepository {
  findRequestReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<LocalizationRun> | null>
  findPreflightReplay(input: { workspaceId: string; actorClientId: string; actorContextHash: string; idempotencyKey: string; requestFingerprint: string }): Promise<Readonly<LocalizationTranslationPreflight> | null>
  readPreflight(input: { workspaceId: string; projectId: string; variantId: string; preflightId: string }): Promise<Readonly<LocalizationTranslationPreflight> | null>
  createPreflight(input: { preflight: Readonly<LocalizationTranslationPreflight>; requestFingerprint: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext> }): Promise<Readonly<{ preflight: Readonly<LocalizationTranslationPreflight>; replayed: boolean }>>
  create(input: { run: Readonly<LocalizationRun>; preflightId: string; expectedPreflightHash: string; requestFingerprint: string; idempotencyKey: string; authenticationAudit: Readonly<ApiAccessAuditContext>; consumedAt: string }): Promise<Readonly<{ run: Readonly<LocalizationRun>; replayed: boolean }>>
  claim(input: { workerId: string; leaseTokenHash: string; now: string; leaseExpiresAt: string }): Promise<Readonly<{ run: Readonly<LocalizationRun>; variant: Readonly<LocalizationVariant>; canonical: Readonly<CanonicalScriptVersion>; preflight: Readonly<LocalizationTranslationPreflight> }> | null>
  settle(input: { previousRunHash: string; run: Readonly<LocalizationRun>; leaseTokenHash: string; settledAt: string }): Promise<Readonly<LocalizationRun>>
  readAuthenticationAudit(input: { workspaceId: string; runId: string }): Promise<Readonly<ApiAccessAuditContext>>
  authorizeCurrentSource(input: { run: Readonly<LocalizationRun>; preflight: Readonly<LocalizationTranslationPreflight>; at: string }): Promise<void>
}

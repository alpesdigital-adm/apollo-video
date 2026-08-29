import type { PersistedSyntheticPresenterProfile } from '../application/ports/synthetic-production-repository.ts'
import type { SyntheticPresenterPolicyDecision } from '../domain/synthetic-presenter-policy-engine.ts'
import type { SyntheticPresenterProfileHead, SyntheticPresenterProfileSnapshot } from '../domain/synthetic-production.ts'
import { assertDomain } from '../domain/errors.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(typeof value === 'object' && value !== null && !Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an object`)
  return value as Record<string, unknown>
}

function string(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim().length > 0, 'INVALID_ARGUMENT', `${field} must be a non-empty string`)
  return value.trim()
}

function positiveInteger(value: unknown, field: string): number {
  assertDomain(Number.isSafeInteger(value) && (value as number) >= 1, 'INVALID_ARGUMENT', `${field} must be a positive integer`)
  return value as number
}

function subset(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], field: string) {
  assertDomain(
    Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => key in value),
    'INVALID_ARGUMENT',
    `${field} contains missing or unsupported properties`,
  )
}

function stringArray(value: unknown, field: string): readonly string[] {
  assertDomain(Array.isArray(value) && value.length >= 1 && value.length <= 64, 'INVALID_ARGUMENT', `${field} must be a bounded non-empty array`)
  return Object.freeze(value.map((entry, index) => string(entry, `${field}[${index}]`)))
}

function parseConsent(raw: unknown, field: string) {
  const consent = record(raw, field)
  subset(
    consent,
    ['id', 'evidenceArtifactId', 'granted', 'allowedUses', 'allowedMarkets', 'allowedLocales', 'allowedOperations', 'expiresAt', 'revokedAt'],
    ['id', 'evidenceArtifactId', 'granted', 'allowedUses', 'allowedMarkets', 'allowedLocales', 'allowedOperations', 'expiresAt'],
    field,
  )
  assertDomain(typeof consent.granted === 'boolean', 'INVALID_ARGUMENT', `${field}.granted must be a boolean`)
  return Object.freeze({
    id: string(consent.id, `${field}.id`),
    evidenceArtifactId: string(consent.evidenceArtifactId, `${field}.evidenceArtifactId`),
    granted: consent.granted,
    allowedUses: stringArray(consent.allowedUses, `${field}.allowedUses`),
    allowedMarkets: stringArray(consent.allowedMarkets, `${field}.allowedMarkets`),
    allowedLocales: stringArray(consent.allowedLocales, `${field}.allowedLocales`),
    allowedOperations: stringArray(consent.allowedOperations, `${field}.allowedOperations`) as readonly ('tts' | 'audio-avatar')[],
    expiresAt: string(consent.expiresAt, `${field}.expiresAt`),
    ...(consent.revokedAt !== undefined ? { revokedAt: string(consent.revokedAt, `${field}.revokedAt`) } : {}),
  })
}

function parseAdapterRef(raw: unknown, field: string) {
  const value = record(raw, field)
  subset(value, ['adapterId', 'adapterVersion', 'identityRef'], ['adapterId', 'adapterVersion', 'identityRef'], field)
  return Object.freeze({
    adapterId: string(value.adapterId, `${field}.adapterId`),
    adapterVersion: string(value.adapterVersion, `${field}.adapterVersion`),
    identityRef: string(value.identityRef, `${field}.identityRef`),
  })
}

function parseVoiceRef(raw: unknown, field: string) {
  const value = record(raw, field)
  subset(value, ['id', 'version', 'adapterId', 'adapterVersion'], ['id', 'version', 'adapterId', 'adapterVersion'], field)
  return Object.freeze({
    id: string(value.id, `${field}.id`),
    version: positiveInteger(value.version, `${field}.version`),
    adapterId: string(value.adapterId, `${field}.adapterId`),
    adapterVersion: string(value.adapterVersion, `${field}.adapterVersion`),
  })
}

export function parseCreatePresenterVersionBody(raw: unknown) {
  const body = record(raw, 'body')
  subset(body, ['baseRevision', 'changes'], ['baseRevision', 'changes'], 'body')
  const changes = record(body.changes, 'body.changes')
  subset(
    changes,
    ['avatar', 'voice', 'defaultLocale', 'disclosure', 'consent', 'pronunciationDictionaryRef', 'visualContinuity', 'restrictions'],
    [],
    'body.changes',
  )
  assertDomain(Object.keys(changes).length >= 1, 'INVALID_ARGUMENT', 'body.changes must name at least one change')
  const visual = changes.visualContinuity === undefined ? undefined : record(changes.visualContinuity, 'body.changes.visualContinuity')
  if (visual) subset(visual, ['wardrobe', 'background', 'framing'], [], 'body.changes.visualContinuity')
  return Object.freeze({
    baseRevision: positiveInteger(body.baseRevision, 'body.baseRevision'),
    changes: Object.freeze({
      ...(changes.avatar !== undefined ? { avatar: parseAdapterRef(changes.avatar, 'body.changes.avatar') } : {}),
      ...(changes.voice !== undefined ? { voice: parseVoiceRef(changes.voice, 'body.changes.voice') } : {}),
      ...(changes.defaultLocale !== undefined ? { defaultLocale: string(changes.defaultLocale, 'body.changes.defaultLocale') } : {}),
      ...(changes.disclosure !== undefined ? { disclosure: string(changes.disclosure, 'body.changes.disclosure') } : {}),
      ...(changes.consent !== undefined ? { consent: parseConsent(changes.consent, 'body.changes.consent') } : {}),
      ...(changes.pronunciationDictionaryRef !== undefined ? { pronunciationDictionaryRef: string(changes.pronunciationDictionaryRef, 'body.changes.pronunciationDictionaryRef') } : {}),
      ...(visual ? {
        visualContinuity: Object.freeze({
          ...(visual.wardrobe !== undefined ? { wardrobe: string(visual.wardrobe, 'body.changes.visualContinuity.wardrobe') } : {}),
          ...(visual.background !== undefined ? { background: string(visual.background, 'body.changes.visualContinuity.background') } : {}),
          ...(visual.framing !== undefined ? { framing: string(visual.framing, 'body.changes.visualContinuity.framing') } : {}),
        }),
      } : {}),
      ...(changes.restrictions !== undefined ? { restrictions: stringArray(changes.restrictions, 'body.changes.restrictions') } : {}),
    }),
  })
}

export function parsePresenterStatusBody(raw: unknown) {
  const body = record(raw, 'body')
  subset(body, ['baseRevision'], ['baseRevision'], 'body')
  return Object.freeze({ baseRevision: positiveInteger(body.baseRevision, 'body.baseRevision') })
}

export function parseAttachConsentBody(raw: unknown) {
  const body = record(raw, 'body')
  subset(body, ['baseRevision', 'consent'], ['baseRevision', 'consent'], 'body')
  return Object.freeze({
    baseRevision: positiveInteger(body.baseRevision, 'body.baseRevision'),
    consent: parseConsent(body.consent, 'body.consent'),
  })
}

export function parseEligibilityBody(raw: unknown) {
  const body = record(raw, 'body')
  subset(body, ['operation', 'use', 'market', 'locale', 'profileVersion', 'requireActiveVersion'], ['operation', 'use', 'market', 'locale'], 'body')
  return Object.freeze({
    operation: string(body.operation, 'body.operation'),
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
    locale: string(body.locale, 'body.locale'),
    ...(body.profileVersion !== undefined ? { profileVersion: positiveInteger(body.profileVersion, 'body.profileVersion') } : {}),
    ...(body.requireActiveVersion !== undefined ? { requireActiveVersion: body.requireActiveVersion === true } : {}),
  })
}

export function presentPresenterSummary(entry: Readonly<{
  head: Readonly<SyntheticPresenterProfileHead>
  current: Readonly<PersistedSyntheticPresenterProfile>
}>) {
  const snapshot = entry.current.snapshot
  return Object.freeze({
    profileId: entry.head.profileId,
    currentVersion: entry.head.currentVersion,
    status: snapshot.status,
    defaultLocale: snapshot.defaultLocale,
    disclosure: snapshot.disclosure,
    voice: Object.freeze({
      adapterId: snapshot.voice.adapterId,
      adapterVersion: snapshot.voice.adapterVersion,
      version: snapshot.voice.version,
    }),
    avatarAdapterId: snapshot.avatar.adapterId,
    consent: Object.freeze({
      granted: snapshot.consent.granted,
      expiresAt: snapshot.consent.expiresAt,
      ...(snapshot.consent.revokedAt ? { revokedAt: snapshot.consent.revokedAt } : {}),
    }),
    updatedAt: entry.head.updatedAt,
  })
}

export function presentPresenterProfile(profile: Readonly<PersistedSyntheticPresenterProfile>) {
  return Object.freeze({ ...profile.snapshot, createdAt: profile.createdAt })
}

export function presentPresenterDetail(detail: Readonly<{
  head: Readonly<SyntheticPresenterProfileHead>
  current: Readonly<PersistedSyntheticPresenterProfile>
  versions: readonly Readonly<PersistedSyntheticPresenterProfile>[]
}>) {
  return Object.freeze({
    profileId: detail.head.profileId,
    head: Object.freeze({
      currentVersion: detail.head.currentVersion,
      currentSnapshotId: detail.head.currentSnapshotId,
      updatedAt: detail.head.updatedAt,
    }),
    current: presentPresenterProfile(detail.current),
    versions: Object.freeze(detail.versions.map(presentPresenterProfile)),
  })
}

export function presentEligibility(decision: Readonly<SyntheticPresenterPolicyDecision>, snapshot: Readonly<SyntheticPresenterProfileSnapshot>) {
  return Object.freeze({
    policyVersion: decision.policyVersion,
    allowed: decision.allowed,
    reasons: decision.reasons,
    profileVersion: snapshot.version,
  })
}

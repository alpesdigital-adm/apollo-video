import { createHash } from 'node:crypto';

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain, DomainError } from './errors.ts'

export const SYNTHETIC_EDIT_PLAN_SCHEMA_VERSION =
  'synthetic-edit-plan/v1' as const
export const SYNTHETIC_POLICY_VERSION =
  'synthetic-presenter-policy/v1' as const

const SHA256 = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

function canonicalId(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && ID.test(value.trim()),
    'INVALID_ARGUMENT',
    `${field} is invalid`,
  )
  return value.trim()
}

function canonicalHash(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && SHA256.test(value),
    'INVALID_ARGUMENT',
    `${field} must be a lowercase SHA-256`,
  )
  return value
}

function isoInstant(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    'INVALID_ARGUMENT',
    `${field} must be a canonical ISO instant`,
  )
  return value
}

export type Consent = { granted: boolean; expiresAt?: string; allowedLocales: string[]; allowedUses: string[]; evidenceId: string };
export type SyntheticPresenterProfile = { id: string; version: number; actor: string; providerIdentities: Record<string, string>; voiceProfiles: Record<string, string>; languages: string[]; consent: Consent; restrictions: string[]; active: boolean; disclosure: string };
export function assertProfileEligible(profile: SyntheticPresenterProfile, input: { locale: string; use: string; now?: string }) {
  const expired = profile.consent.expiresAt && new Date(profile.consent.expiresAt) <= new Date(input.now ?? Date.now());
  if (!profile.active || !profile.consent.granted || expired || !profile.languages.includes(input.locale) || !profile.consent.allowedUses.includes(input.use)) throw new Error('synthetic-profile-ineligible');
  return true;
}

export type AudioMaster = { id: string; source: 'tts' | 'uploaded'; uri: string; durationMs: number; locale: string; alignment: { word: string; startMs: number; endMs: number }[]; approved: boolean };
export function prepareAudio(input: { text?: string; uploaded?: AudioMaster; locale: string; regenerated?: boolean }): AudioMaster {
  if (input.uploaded && !input.regenerated) return input.uploaded;
  if (!input.text?.trim()) throw new Error('text-or-audio-required');
  const words = input.text.trim().split(/\s+/);
  const alignment = words.map((word, index) => ({ word, startMs: index * 420, endMs: (index + 1) * 420 }));
  return { id: `audio-${createHash('sha256').update(`${input.locale}:${input.text}`).digest('hex').slice(0, 12)}`, source: 'tts', uri: 'pending://tts', durationMs: words.length * 420, locale: input.locale, alignment, approved: false };
}

// Blocks carry no cache key of their own: the canonical synthetic cache
// identity (`synthetic-cache-identity.ts`) is the single address of synthetic
// work. A second, locally invented key here would answer the same question
// differently and silently duplicate paid generations.
export type SyntheticBlock = { id: string; text: string; audioId: string; rangeMs: [number, number]; status: 'planned' | 'ready' | 'failed'; artifact?: string };
export function splitSyntheticBlocks(text: string, input: { audio: AudioMaster; profile: SyntheticPresenterProfile; providerCapability: string; settings?: object }) {
  const sentences = text.match(/[^.!?]+[.!?]?/g)?.map(value => value.trim()).filter(Boolean) ?? [];
  let cursor = 0;
  return sentences.map((sentence, index): SyntheticBlock => {
    const wordCount = sentence.split(/\s+/).length;
    const duration = Math.max(420, wordCount * 420);
    const rangeMs: [number, number] = [cursor, Math.min(input.audio.durationMs, cursor + duration)];
    cursor = rangeMs[1];
    return { id: `block-${index + 1}`, text: sentence, audioId: input.audio.id, rangeMs, status: 'planned' };
  });
}

export type StoryBlock = { id: string; kind: 'real' | 'synthetic' | 'voiceover' | 'proof' | 'broll'; sourceId: string; rights: boolean; consent: boolean; identity?: string; scene?: string; disclosure?: string };
export function compileSyntheticEditPlan(input: { profile: SyntheticPresenterProfile; audio: AudioMaster; blocks: SyntheticBlock[]; broll: string[]; captions: boolean; overlays: string[]; use: string }) {
  assertProfileEligible(input.profile, { locale: input.audio.locale, use: input.use });
  return { mode: 'synthetic-presenter', durationMs: input.audio.durationMs, hasRealPerson: false, tracks: { audio: input.audio, synthetic: input.blocks, broll: input.broll, captions: input.captions ? input.audio.alignment : [], overlays: input.overlays }, disclosure: input.profile.disclosure };
}

export function validateHybridStory(blocks: StoryBlock[]) {
  const issues: string[] = [];
  for (const block of blocks) {
    if (!block.rights || !block.consent) issues.push(`${block.id}:rights-or-consent`);
    if (block.kind === 'synthetic' && !block.disclosure) issues.push(`${block.id}:missing-disclosure`);
  }
  for (let index = 1; index < blocks.length; index++) {
    const previous = blocks[index - 1], current = blocks[index];
    if (previous.identity && current.identity && previous.identity !== current.identity && current.kind === 'synthetic') issues.push(`${current.id}:identity-discontinuity`);
  }
  return { allowed: issues.length === 0, issues, sequence: blocks.map(block => block.kind).join('>') };
}

// The in-memory master, its catalog and its reuse lookup lived here as a
// second, unpersisted implementation of F3.007/F3.008. They were never called
// by any service, worker or route. The canonical master aggregate now lives in
// `synthetic-master-asset.ts`, is persisted, content-addressed and gated by
// consent, rights and criticism; `synthetic-master-assets.ts` promotes it.

export function evaluateSyntheticBlock(input: { blockId: string; rangeMs: [number, number]; lipSync: number; identity: number; pronunciation: number; artifacts: number; framing: number; continuity: number }) {
  const hardFailure = input.identity < .9 || input.pronunciation < .8 || input.artifacts > .2;
  const score = (input.lipSync + input.identity + input.pronunciation + input.framing + input.continuity + (1 - input.artifacts)) / 6;
  return { passed: !hardFailure && score >= .82, score, issue: hardFailure ? { blockId: input.blockId, rangeMs: input.rangeMs, action: input.identity < .9 ? 'fallback' : 'retry' } : undefined };
}

export interface SyntheticArtifactRef {
  id: string
  artifactId: string
  artifactKey: string
  kind: 'video' | 'audio' | 'image'
  sha256: string
  byteSize: number
}

export interface SyntheticConsentSnapshot {
  id: string
  evidenceArtifactId: string
  evidenceSha256: string
  snapshotHash: string
  granted: boolean
  allowedUses: readonly string[]
  allowedMarkets: readonly string[]
  allowedLocales: readonly string[]
  allowedOperations: readonly ('tts' | 'audio-avatar')[]
  expiresAt: string
  revokedAt?: string
}

export interface SyntheticPresenterProfileSnapshot {
  id: string
  version: number
  snapshotHash: string
  actorIdentityId: string
  avatar: Readonly<{
    adapterId: string
    adapterVersion: string
    identityRef: string
  }>
  voice: Readonly<{
    id: string
    version: number
    adapterId: string
    adapterVersion: string
  }>
  defaultLocale: string
  status: 'active' | 'disabled' | 'expired'
  disclosure: string
  consent: Readonly<SyntheticConsentSnapshot>
  /** Reserved reference; participates in block cache keys once dictionaries exist. */
  pronunciationDictionaryRef?: string
  visualContinuity?: Readonly<{ wardrobe?: string; background?: string; framing?: string }>
  restrictions?: readonly string[]
}

/**
 * Mutable head of a logical presenter: the row lifecycle commands
 * compare-and-swap against. Every version stays an immutable snapshot row;
 * the head only points at the current one.
 */
export interface SyntheticPresenterProfileHead {
  workspaceId: string
  profileId: string
  currentVersion: number
  currentSnapshotId: string
  createdAt: string
  updatedAt: string
}

export function createSyntheticPresenterProfileSnapshot(input: {
  id: string
  version: number
  actorIdentityId: string
  avatar: SyntheticPresenterProfileSnapshot['avatar']
  voice: SyntheticPresenterProfileSnapshot['voice']
  defaultLocale: string
  status: SyntheticPresenterProfileSnapshot['status']
  disclosure: string
  consent: Omit<SyntheticConsentSnapshot, 'snapshotHash'>
  pronunciationDictionaryRef?: string
  visualContinuity?: Readonly<{ wardrobe?: string; background?: string; framing?: string }>
  restrictions?: readonly string[]
}): Readonly<SyntheticPresenterProfileSnapshot> {
  assertDomain(
    Number.isSafeInteger(input.version) && input.version >= 1 &&
      Number.isSafeInteger(input.voice.version) && input.voice.version >= 1,
    'INVALID_ARGUMENT',
    'Synthetic presenter or voice version is invalid',
  )
  assertDomain(
    LOCALE.test(input.defaultLocale),
    'INVALID_ARGUMENT',
    'Synthetic presenter locale is invalid',
  )
  assertDomain(
    ['active', 'disabled', 'expired'].includes(input.status) &&
      input.disclosure.trim().length >= 3 &&
      input.disclosure.trim().length <= 500,
    'INVALID_ARGUMENT',
    'Synthetic presenter status or disclosure is invalid',
  )
  const consentBody = Object.freeze({
    id: canonicalId(input.consent.id, 'consent.id'),
    evidenceArtifactId: canonicalId(
      input.consent.evidenceArtifactId,
      'consent.evidenceArtifactId',
    ),
    evidenceSha256: canonicalHash(
      input.consent.evidenceSha256,
      'consent.evidenceSha256',
    ),
    granted: input.consent.granted === true,
    allowedUses: Object.freeze([...new Set(input.consent.allowedUses)].toSorted()),
    allowedMarkets: Object.freeze([...new Set(input.consent.allowedMarkets)].toSorted()),
    allowedLocales: Object.freeze([...new Set(input.consent.allowedLocales)].toSorted()),
    allowedOperations: Object.freeze([...new Set(input.consent.allowedOperations)].toSorted()),
    expiresAt: isoInstant(input.consent.expiresAt, 'consent.expiresAt'),
    ...(input.consent.revokedAt
      ? { revokedAt: isoInstant(input.consent.revokedAt, 'consent.revokedAt') }
      : {}),
  })
  assertDomain(
    consentBody.allowedUses.length > 0 &&
      consentBody.allowedMarkets.length > 0 &&
      consentBody.allowedLocales.length > 0 &&
      consentBody.allowedOperations.length > 0,
    'INVALID_ARGUMENT',
    'Synthetic consent scope cannot be empty',
  )
  const consent = Object.freeze({
    ...consentBody,
    snapshotHash: calculateCanonicalHash(consentBody),
  })
  const body = Object.freeze({
    id: canonicalId(input.id, 'profile.id'),
    version: input.version,
    actorIdentityId: canonicalId(input.actorIdentityId, 'profile.actorIdentityId'),
    avatar: Object.freeze({
      adapterId: canonicalId(input.avatar.adapterId, 'profile.avatar.adapterId'),
      adapterVersion: canonicalId(input.avatar.adapterVersion, 'profile.avatar.adapterVersion'),
      identityRef: canonicalId(input.avatar.identityRef, 'profile.avatar.identityRef'),
    }),
    voice: Object.freeze({
      id: canonicalId(input.voice.id, 'profile.voice.id'),
      version: input.voice.version,
      adapterId: canonicalId(input.voice.adapterId, 'profile.voice.adapterId'),
      adapterVersion: canonicalId(input.voice.adapterVersion, 'profile.voice.adapterVersion'),
    }),
    defaultLocale: input.defaultLocale,
    status: input.status,
    disclosure: input.disclosure.trim(),
    consent,
    // Optional fields enter the hashed body only when present, so every
    // previously persisted snapshot keeps verifying byte-identically.
    ...(input.pronunciationDictionaryRef
      ? { pronunciationDictionaryRef: canonicalId(input.pronunciationDictionaryRef, 'profile.pronunciationDictionaryRef') }
      : {}),
    ...(input.visualContinuity && Object.values(input.visualContinuity).some(Boolean)
      ? {
          visualContinuity: Object.freeze(Object.fromEntries(
            (['wardrobe', 'background', 'framing'] as const)
              .filter((key) => {
                const value = input.visualContinuity?.[key]
                assertDomain(
                  value === undefined || (typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 200),
                  'INVALID_ARGUMENT',
                  `profile.visualContinuity.${key} is invalid`,
                )
                return Boolean(value)
              })
              .map((key) => [key, input.visualContinuity![key]!.trim()]),
          )),
        }
      : {}),
    ...(input.restrictions && input.restrictions.length > 0
      ? {
          restrictions: Object.freeze([...new Set(input.restrictions.map((value, index) => {
            assertDomain(
              typeof value === 'string' && value.trim().length >= 3 && value.trim().length <= 300,
              'INVALID_ARGUMENT',
              `profile.restrictions[${index}] is invalid`,
            )
            return value.trim()
          }))].toSorted()),
        }
      : {}),
  })
  return Object.freeze({ ...body, snapshotHash: calculateCanonicalHash(body) })
}

export interface SyntheticUseAuthorization {
  id: string
  authorizationHash: string
  outcome: 'allowed' | 'denied'
  use: string
  market: string
  locale: string
  syntheticOperations: readonly ('tts' | 'audio-avatar')[]
  artifactIds: readonly string[]
  decisions: readonly Readonly<{
    artifactId: string
    rightsSnapshotId: string
    rightsSnapshotHash: string
    validUntil: string
  }>[]
  evaluatedAt: string
  expiresAt: string
}

export interface SyntheticAudioMasterRef extends SyntheticArtifactRef {
  kind: 'audio'
  durationMs: number
  locale: string
  scriptHash: string
  alignment: readonly Readonly<{
    text: string
    startMs: number
    endMs: number
  }>[]
}

export interface ApprovedSyntheticBlock {
  id: string
  text: string
  rangeMs: readonly [number, number]
  cacheKey: string
  providerJobId: string
  audioSha256: string
  artifact: Readonly<SyntheticArtifactRef & { kind: 'video' }>
  critic: Readonly<{
    id: string
    resultHash: string
    status: 'approved' | 'rejected'
  }>
}

export interface SyntheticVisualInsert {
  id: string
  rangeMs: readonly [number, number]
  artifact: Readonly<SyntheticArtifactRef & { kind: 'video' | 'image' }>
  role: 'b-roll' | 'overlay'
}

export interface SyntheticPresenterEditPlan {
  schemaVersion: typeof SYNTHETIC_EDIT_PLAN_SCHEMA_VERSION
  policyVersion: typeof SYNTHETIC_POLICY_VERSION
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  mode: 'synthetic-presenter'
  hasRealPerson: false
  durationMs: number
  use: string
  market: string
  locale: string
  profile: Readonly<SyntheticPresenterProfileSnapshot>
  audio: Readonly<SyntheticAudioMasterRef>
  blocks: readonly Readonly<ApprovedSyntheticBlock>[]
  bRoll: readonly Readonly<SyntheticVisualInsert>[]
  overlays: readonly Readonly<SyntheticVisualInsert>[]
  captions: readonly Readonly<{
    text: string
    startMs: number
    endMs: number
    anchor: 'bottom'
  }>[]
  disclosure: string
  authorization: Readonly<SyntheticUseAuthorization>
  planHash: string
  createdAt: string
}

function artifact(
  value: Readonly<SyntheticArtifactRef>,
  field: string,
): Readonly<SyntheticArtifactRef> {
  assertDomain(
    value.kind === 'video' || value.kind === 'audio' || value.kind === 'image',
    'INVALID_ARGUMENT',
    `${field}.kind is unsupported`,
  )
  assertDomain(
    Number.isSafeInteger(value.byteSize) && value.byteSize > 0,
    'INVALID_ARGUMENT',
    `${field}.byteSize must be positive`,
  )
  return Object.freeze({
    id: canonicalId(value.id, `${field}.id`),
    artifactId: canonicalId(value.artifactId, `${field}.artifactId`),
    artifactKey: canonicalId(value.artifactKey, `${field}.artifactKey`),
    kind: value.kind,
    sha256: canonicalHash(value.sha256, `${field}.sha256`),
    byteSize: value.byteSize,
  })
}

function timedRange(
  value: readonly [number, number],
  durationMs: number,
  field: string,
): readonly [number, number] {
  assertDomain(
    Array.isArray(value) &&
      value.length === 2 &&
      value.every(Number.isSafeInteger) &&
      value[0] >= 0 &&
      value[1] > value[0] &&
      value[1] <= durationMs,
    'INVALID_ARGUMENT',
    `${field} is outside the audio timeline`,
  )
  return Object.freeze([value[0], value[1]])
}

function assertConsent(
  profile: Readonly<SyntheticPresenterProfileSnapshot>,
  context: Readonly<{ use: string; market: string; locale: string; now: string }>,
): void {
  const { consent } = profile
  const expiresAt = isoInstant(consent.expiresAt, 'profile.consent.expiresAt')
  const revoked = consent.revokedAt
    ? Date.parse(isoInstant(consent.revokedAt, 'profile.consent.revokedAt')) <=
      Date.parse(context.now)
    : false
  assertDomain(
    profile.status === 'active' &&
      consent.granted &&
      Date.parse(expiresAt) > Date.parse(context.now) &&
      !revoked &&
      consent.allowedUses.includes(context.use) &&
      consent.allowedMarkets.includes(context.market) &&
      consent.allowedLocales.includes(context.locale) &&
      consent.allowedOperations.includes('tts') &&
      consent.allowedOperations.includes('audio-avatar'),
    'ASSET_RIGHTS_BLOCKED',
    'Synthetic presenter consent is absent, expired, revoked or incompatible',
  )
}

function assertAuthorization(
  authorization: Readonly<SyntheticUseAuthorization>,
  input: Readonly<{
    use: string
    market: string
    locale: string
    now: string
    artifactIds: readonly string[]
  }>,
): void {
  const available = new Set(authorization.artifactIds)
  assertDomain(
    authorization.outcome === 'allowed' &&
      authorization.use === input.use &&
      authorization.market === input.market &&
      authorization.locale === input.locale &&
      authorization.syntheticOperations.includes('tts') &&
      authorization.syntheticOperations.includes('audio-avatar') &&
      Date.parse(isoInstant(authorization.evaluatedAt, 'authorization.evaluatedAt')) <=
        Date.parse(input.now) &&
      Date.parse(isoInstant(authorization.expiresAt, 'authorization.expiresAt')) >
        Date.parse(input.now) &&
      input.artifactIds.every((id) => available.has(id)),
    'ASSET_RIGHTS_BLOCKED',
    'Synthetic production authorization is absent, stale or incomplete',
  )
  assertDomain(
    authorization.decisions.length === input.artifactIds.length &&
      authorization.decisions.every((decision) =>
        available.has(decision.artifactId) &&
        SHA256.test(decision.rightsSnapshotHash) &&
        Date.parse(isoInstant(decision.validUntil, 'authorization.decision.validUntil')) >
          Date.parse(input.now)),
    'ASSET_RIGHTS_BLOCKED',
    'Synthetic production rights decision lineage is incomplete or expired',
  )
}

/**
 * Creates the immutable EditPlan consumed by the synthetic render compiler.
 * Provider responses are admitted only after local ingest and critic approval;
 * provider URLs and provider-specific payloads never enter this aggregate.
 */
export function createSyntheticPresenterEditPlan(input: {
  id: string
  workspaceId: string
  projectId: string
  projectVersionId: string
  profile: Readonly<SyntheticPresenterProfileSnapshot>
  audio: Readonly<SyntheticAudioMasterRef>
  blocks: readonly Readonly<ApprovedSyntheticBlock>[]
  bRoll?: readonly Readonly<SyntheticVisualInsert>[]
  overlays?: readonly Readonly<SyntheticVisualInsert>[]
  captions: boolean
  use: string
  market: string
  authorization: Readonly<SyntheticUseAuthorization>
  createdAt: string
}): Readonly<SyntheticPresenterEditPlan> {
  const createdAt = isoInstant(input.createdAt, 'createdAt')
  const durationMs = input.audio.durationMs
  assertDomain(
    Number.isSafeInteger(durationMs) && durationMs > 0,
    'INVALID_ARGUMENT',
    'audio.durationMs must be positive',
  )
  assertDomain(
    LOCALE.test(input.audio.locale),
    'INVALID_ARGUMENT',
    'audio.locale is invalid',
  )
  assertDomain(
    input.audio.kind === 'audio' && input.audio.alignment.length > 0,
    'INVALID_ARGUMENT',
    'Synthetic production requires an aligned audio master',
  )
  const audio = Object.freeze({
    ...artifact(input.audio, 'audio'),
    kind: 'audio' as const,
    durationMs,
    locale: input.audio.locale,
    scriptHash: canonicalHash(input.audio.scriptHash, 'audio.scriptHash'),
    alignment: Object.freeze(input.audio.alignment.map((entry, index) => {
      assertDomain(
        typeof entry.text === 'string' && entry.text.trim().length > 0,
        'INVALID_ARGUMENT',
        `audio.alignment[${index}].text is empty`,
      )
      const [startMs, endMs] = timedRange(
        [entry.startMs, entry.endMs],
        durationMs,
        `audio.alignment[${index}]`,
      )
      return Object.freeze({ text: entry.text.trim(), startMs, endMs })
    })),
  })
  assertDomain(
    input.profile.defaultLocale === audio.locale &&
      input.profile.disclosure.trim().length >= 3,
    'INVALID_ARGUMENT',
    'Synthetic presenter profile locale or disclosure is incompatible',
  )
  canonicalHash(input.profile.snapshotHash, 'profile.snapshotHash')
  canonicalHash(input.profile.consent.snapshotHash, 'profile.consent.snapshotHash')
  assertDomain(
    Number.isSafeInteger(input.profile.version) && input.profile.version >= 1 &&
      Number.isSafeInteger(input.profile.voice.version) && input.profile.voice.version >= 1,
    'INVALID_ARGUMENT',
    'Synthetic presenter or voice version is invalid',
  )
  const verifiedProfile = createSyntheticPresenterProfileSnapshot({
    id: input.profile.id,
    version: input.profile.version,
    actorIdentityId: input.profile.actorIdentityId,
    avatar: input.profile.avatar,
    voice: input.profile.voice,
    defaultLocale: input.profile.defaultLocale,
    status: input.profile.status,
    disclosure: input.profile.disclosure,
    consent: {
      id: input.profile.consent.id,
      evidenceArtifactId: input.profile.consent.evidenceArtifactId,
      evidenceSha256: input.profile.consent.evidenceSha256,
      granted: input.profile.consent.granted,
      allowedUses: input.profile.consent.allowedUses,
      allowedMarkets: input.profile.consent.allowedMarkets,
      allowedLocales: input.profile.consent.allowedLocales,
      allowedOperations: input.profile.consent.allowedOperations,
      expiresAt: input.profile.consent.expiresAt,
      ...(input.profile.consent.revokedAt
        ? { revokedAt: input.profile.consent.revokedAt }
        : {}),
    },
    ...(input.profile.pronunciationDictionaryRef
      ? { pronunciationDictionaryRef: input.profile.pronunciationDictionaryRef }
      : {}),
    ...(input.profile.visualContinuity ? { visualContinuity: input.profile.visualContinuity } : {}),
    ...(input.profile.restrictions ? { restrictions: input.profile.restrictions } : {}),
  })
  assertDomain(
    verifiedProfile.snapshotHash === input.profile.snapshotHash &&
      verifiedProfile.consent.snapshotHash === input.profile.consent.snapshotHash,
    'PERSISTENCE_CONFLICT',
    'Synthetic presenter profile snapshot hash is invalid',
  )
  assertConsent(input.profile, {
    use: input.use,
    market: input.market,
    locale: audio.locale,
    now: createdAt,
  })
  assertDomain(
    input.blocks.length > 0 && input.blocks.length <= 500,
    'INVALID_ARGUMENT',
    'Synthetic production must contain one to five hundred blocks',
  )
  let cursor = 0
  const blocks = Object.freeze(input.blocks.map((entry, index) => {
    const rangeMs = timedRange(entry.rangeMs, durationMs, `blocks[${index}].rangeMs`)
    assertDomain(
      rangeMs[0] === cursor,
      'INVALID_ARGUMENT',
      'Synthetic blocks must cover the audio timeline without gaps or overlap',
    )
    cursor = rangeMs[1]
    assertDomain(
      entry.critic.status === 'approved' && entry.audioSha256 === audio.sha256,
      'PRECONDITION_REQUIRED',
      `Synthetic block ${index + 1} is not approved for the current audio`,
    )
    const video = artifact(entry.artifact, `blocks[${index}].artifact`)
    assertDomain(video.kind === 'video', 'INVALID_ARGUMENT', 'Synthetic block artifact must be video')
    return Object.freeze({
      id: canonicalId(entry.id, `blocks[${index}].id`),
      text: entry.text.trim(),
      rangeMs,
      cacheKey: canonicalHash(entry.cacheKey, `blocks[${index}].cacheKey`),
      providerJobId: canonicalId(entry.providerJobId, `blocks[${index}].providerJobId`),
      audioSha256: canonicalHash(entry.audioSha256, `blocks[${index}].audioSha256`),
      artifact: Object.freeze({ ...video, kind: 'video' as const }),
      critic: Object.freeze({
        id: canonicalId(entry.critic.id, `blocks[${index}].critic.id`),
        resultHash: canonicalHash(entry.critic.resultHash, `blocks[${index}].critic.resultHash`),
        status: 'approved' as const,
      }),
    })
  }))
  assertDomain(
    cursor === durationMs,
    'INVALID_ARGUMENT',
    'Synthetic blocks must cover the complete audio timeline',
  )
  const normalizeInserts = (
    entries: readonly Readonly<SyntheticVisualInsert>[],
    role: SyntheticVisualInsert['role'],
  ) => Object.freeze(entries.map((entry, index) => {
    assertDomain(entry.role === role, 'INVALID_ARGUMENT', `${role}[${index}].role is invalid`)
    const normalized = artifact(entry.artifact, `${role}[${index}].artifact`)
    assertDomain(normalized.kind !== 'audio', 'INVALID_ARGUMENT', `${role}[${index}] cannot be audio`)
    return Object.freeze({
      id: canonicalId(entry.id, `${role}[${index}].id`),
      rangeMs: timedRange(entry.rangeMs, durationMs, `${role}[${index}].rangeMs`),
      artifact: Object.freeze({ ...normalized, kind: normalized.kind as 'video' | 'image' }),
      role,
    })
  }))
  const bRoll = normalizeInserts(input.bRoll ?? [], 'b-roll')
  const overlays = normalizeInserts(input.overlays ?? [], 'overlay')
  const artifactIds = [
    audio.artifactId,
    ...blocks.map((entry) => entry.artifact.artifactId),
    ...bRoll.map((entry) => entry.artifact.artifactId),
    ...overlays.map((entry) => entry.artifact.artifactId),
  ]
  assertDomain(
    new Set(artifactIds).size === artifactIds.length,
    'INVALID_ARGUMENT',
    'Synthetic EditPlan artifact identities must be unique',
  )
  canonicalHash(input.authorization.authorizationHash, 'authorization.authorizationHash')
  assertAuthorization(input.authorization, {
    use: input.use,
    market: input.market,
    locale: audio.locale,
    now: createdAt,
    artifactIds,
  })
  const captions = input.captions
    ? Object.freeze(audio.alignment.map((entry) => Object.freeze({
        ...entry,
        anchor: 'bottom' as const,
      })))
    : Object.freeze([])
  const body = Object.freeze({
    schemaVersion: SYNTHETIC_EDIT_PLAN_SCHEMA_VERSION,
    policyVersion: SYNTHETIC_POLICY_VERSION,
    id: canonicalId(input.id, 'id'),
    workspaceId: canonicalId(input.workspaceId, 'workspaceId'),
    projectId: canonicalId(input.projectId, 'projectId'),
    projectVersionId: canonicalId(input.projectVersionId, 'projectVersionId'),
    mode: 'synthetic-presenter' as const,
    hasRealPerson: false as const,
    durationMs,
    use: canonicalId(input.use, 'use'),
    market: canonicalId(input.market, 'market'),
    locale: audio.locale,
    profile: Object.freeze(structuredClone(input.profile)),
    audio,
    blocks,
    bRoll,
    overlays,
    captions,
    disclosure: input.profile.disclosure.trim(),
    authorization: Object.freeze(structuredClone(input.authorization)),
    createdAt,
  })
  return Object.freeze({ ...body, planHash: calculateCanonicalHash(body) })
}

export function assertSyntheticPresenterEditPlan(
  value: Readonly<SyntheticPresenterEditPlan>,
): void {
  const { planHash, ...input } = value
  if (calculateCanonicalHash(input) !== planHash) {
    throw new DomainError(
      'PERSISTENCE_CONFLICT',
      'Stored synthetic EditPlan hash is invalid',
    )
  }
  createSyntheticPresenterEditPlan({
    id: value.id,
    workspaceId: value.workspaceId,
    projectId: value.projectId,
    projectVersionId: value.projectVersionId,
    profile: value.profile,
    audio: value.audio,
    blocks: value.blocks,
    bRoll: value.bRoll,
    overlays: value.overlays,
    captions: value.captions.length > 0,
    use: value.use,
    market: value.market,
    authorization: value.authorization,
    createdAt: value.createdAt,
  })
}

import { assertDomain } from '../domain/errors.ts'
import type {
  PersistedSyntheticPresenterProfile,
  PersistedSyntheticProductionRun,
} from '../application/ports/synthetic-production-repository.ts'

function record(value: unknown, field: string): Record<string, unknown> {
  assertDomain(
    typeof value === 'object' && value !== null && !Array.isArray(value),
    'INVALID_ARGUMENT',
    `${field} must be an object`,
  )
  return value as Record<string, unknown>
}

function exact(value: Record<string, unknown>, keys: readonly string[], field: string) {
  const allowed = new Set(keys.map((key) => key.endsWith('?') ? key.slice(0, -1) : key))
  assertDomain(
    Object.keys(value).every((key) => allowed.has(key)) &&
      keys.filter((key) => !key.endsWith('?')).every((key) => key in value),
    'INVALID_ARGUMENT',
    `${field} contains missing or unsupported properties`,
  )
}

function string(value: unknown, field: string): string {
  assertDomain(
    typeof value === 'string' && value.trim().length > 0,
    'INVALID_ARGUMENT',
    `${field} must be a non-empty string`,
  )
  return value.trim()
}

function strings(value: unknown, field: string): readonly string[] {
  assertDomain(
    Array.isArray(value) && value.length > 0 && value.length <= 64,
    'INVALID_ARGUMENT',
    `${field} must contain one to sixty-four values`,
  )
  return Object.freeze(value.map((entry, index) => string(entry, `${field}[${index}]`)))
}

function integer(value: unknown, field: string): number {
  assertDomain(Number.isSafeInteger(value), 'INVALID_ARGUMENT', `${field} must be an integer`)
  return Number(value)
}

function range(value: unknown, field: string): readonly [number, number] {
  assertDomain(
    Array.isArray(value) && value.length === 2,
    'INVALID_ARGUMENT',
    `${field} must be a two-item range`,
  )
  return Object.freeze([integer(value[0], `${field}[0]`), integer(value[1], `${field}[1]`)])
}

export function parseRegisterSyntheticPresenterBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, [
    'profileId', 'version', 'actorIdentityId', 'avatar', 'voice',
    'defaultLocale', 'status', 'disclosure', 'consent',
  ], 'body')
  const avatar = record(body.avatar, 'body.avatar')
  exact(avatar, ['adapterId', 'adapterVersion', 'identityRef'], 'body.avatar')
  const voice = record(body.voice, 'body.voice')
  exact(voice, ['id', 'version', 'adapterId', 'adapterVersion'], 'body.voice')
  const consent = record(body.consent, 'body.consent')
  exact(consent, [
    'id', 'evidenceArtifactId', 'granted', 'allowedUses', 'allowedMarkets',
    'allowedLocales', 'allowedOperations', 'expiresAt', 'revokedAt?',
  ], 'body.consent')
  assertDomain(
    body.status === 'active' || body.status === 'disabled' || body.status === 'expired',
    'INVALID_ARGUMENT',
    'body.status is unsupported',
  )
  assertDomain(typeof consent.granted === 'boolean', 'INVALID_ARGUMENT', 'body.consent.granted must be boolean')
  const operations = strings(consent.allowedOperations, 'body.consent.allowedOperations')
  assertDomain(
    operations.every((entry) => entry === 'tts' || entry === 'audio-avatar'),
    'INVALID_ARGUMENT',
    'body.consent.allowedOperations is unsupported',
  )
  return Object.freeze({
    profileId: string(body.profileId, 'body.profileId'),
    version: integer(body.version, 'body.version'),
    actorIdentityId: string(body.actorIdentityId, 'body.actorIdentityId'),
    avatar: Object.freeze({
      adapterId: string(avatar.adapterId, 'body.avatar.adapterId'),
      adapterVersion: string(avatar.adapterVersion, 'body.avatar.adapterVersion'),
      identityRef: string(avatar.identityRef, 'body.avatar.identityRef'),
    }),
    voice: Object.freeze({
      id: string(voice.id, 'body.voice.id'),
      version: integer(voice.version, 'body.voice.version'),
      adapterId: string(voice.adapterId, 'body.voice.adapterId'),
      adapterVersion: string(voice.adapterVersion, 'body.voice.adapterVersion'),
    }),
    defaultLocale: string(body.defaultLocale, 'body.defaultLocale'),
    status: body.status,
    disclosure: string(body.disclosure, 'body.disclosure'),
    consent: Object.freeze({
      id: string(consent.id, 'body.consent.id'),
      evidenceArtifactId: string(consent.evidenceArtifactId, 'body.consent.evidenceArtifactId'),
      granted: consent.granted,
      allowedUses: strings(consent.allowedUses, 'body.consent.allowedUses'),
      allowedMarkets: strings(consent.allowedMarkets, 'body.consent.allowedMarkets'),
      allowedLocales: strings(consent.allowedLocales, 'body.consent.allowedLocales'),
      allowedOperations: operations as readonly ('tts' | 'audio-avatar')[],
      expiresAt: string(consent.expiresAt, 'body.consent.expiresAt'),
      ...(consent.revokedAt === undefined
        ? {}
        : { revokedAt: string(consent.revokedAt, 'body.consent.revokedAt') }),
    }),
  })
}

export function parseCreateSyntheticProductionRunBody(raw: unknown) {
  const body = record(raw, 'body')
  exact(body, [
    'projectVersionId', 'profileSnapshotId', 'audio', 'blocks',
    'bRoll?', 'overlays?', 'captions', 'use', 'market',
  ], 'body')
  const audio = record(body.audio, 'body.audio')
  exact(audio, ['artifactId', 'durationMs', 'locale', 'scriptHash', 'alignment'], 'body.audio')
  assertDomain(Array.isArray(audio.alignment) && audio.alignment.length > 0, 'INVALID_ARGUMENT', 'body.audio.alignment must not be empty')
  const alignment = audio.alignment.map((value, index) => {
    const entry = record(value, `body.audio.alignment[${index}]`)
    exact(entry, ['text', 'startMs', 'endMs'], `body.audio.alignment[${index}]`)
    return Object.freeze({
      text: string(entry.text, `body.audio.alignment[${index}].text`),
      startMs: integer(entry.startMs, `body.audio.alignment[${index}].startMs`),
      endMs: integer(entry.endMs, `body.audio.alignment[${index}].endMs`),
    })
  })
  assertDomain(Array.isArray(body.blocks) && body.blocks.length > 0 && body.blocks.length <= 500, 'INVALID_ARGUMENT', 'body.blocks must contain one to five hundred entries')
  const blocks = body.blocks.map((value, index) => {
    const entry = record(value, `body.blocks[${index}]`)
    exact(entry, ['id', 'text', 'rangeMs', 'cacheKey', 'providerJobId', 'audioSha256', 'artifactId', 'critic'], `body.blocks[${index}]`)
    const critic = record(entry.critic, `body.blocks[${index}].critic`)
    exact(critic, ['id', 'resultHash', 'status'], `body.blocks[${index}].critic`)
    assertDomain(critic.status === 'approved' || critic.status === 'rejected', 'INVALID_ARGUMENT', `body.blocks[${index}].critic.status is unsupported`)
    return Object.freeze({
      id: string(entry.id, `body.blocks[${index}].id`),
      text: string(entry.text, `body.blocks[${index}].text`),
      rangeMs: range(entry.rangeMs, `body.blocks[${index}].rangeMs`),
      cacheKey: string(entry.cacheKey, `body.blocks[${index}].cacheKey`),
      providerJobId: string(entry.providerJobId, `body.blocks[${index}].providerJobId`),
      audioSha256: string(entry.audioSha256, `body.blocks[${index}].audioSha256`),
      artifactId: string(entry.artifactId, `body.blocks[${index}].artifactId`),
      critic: Object.freeze({
        id: string(critic.id, `body.blocks[${index}].critic.id`),
        resultHash: string(critic.resultHash, `body.blocks[${index}].critic.resultHash`),
        status: critic.status,
      }),
    })
  })
  const inserts = (value: unknown, field: string, role: 'b-roll' | 'overlay') => {
    assertDomain(value === undefined || Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an array`)
    return Object.freeze((value ?? []).map((rawEntry: unknown, index: number) => {
      const entry = record(rawEntry, `${field}[${index}]`)
      exact(entry, ['id', 'rangeMs', 'artifactId'], `${field}[${index}]`)
      return Object.freeze({
        id: string(entry.id, `${field}[${index}].id`),
        rangeMs: range(entry.rangeMs, `${field}[${index}].rangeMs`),
        artifactId: string(entry.artifactId, `${field}[${index}].artifactId`),
        role,
      })
    }))
  }
  assertDomain(typeof body.captions === 'boolean', 'INVALID_ARGUMENT', 'body.captions must be boolean')
  return Object.freeze({
    projectVersionId: string(body.projectVersionId, 'body.projectVersionId'),
    profileSnapshotId: string(body.profileSnapshotId, 'body.profileSnapshotId'),
    audio: Object.freeze({
      artifactId: string(audio.artifactId, 'body.audio.artifactId'),
      durationMs: integer(audio.durationMs, 'body.audio.durationMs'),
      locale: string(audio.locale, 'body.audio.locale'),
      scriptHash: string(audio.scriptHash, 'body.audio.scriptHash'),
      alignment: Object.freeze(alignment),
    }),
    blocks: Object.freeze(blocks),
    bRoll: inserts(body.bRoll, 'body.bRoll', 'b-roll'),
    overlays: inserts(body.overlays, 'body.overlays', 'overlay'),
    captions: body.captions,
    use: string(body.use, 'body.use'),
    market: string(body.market, 'body.market'),
  })
}

export function presentSyntheticPresenterProfile(
  profile: Readonly<PersistedSyntheticPresenterProfile>,
) {
  return Object.freeze({
    ...profile.snapshot,
    createdAt: profile.createdAt,
  })
}

export function presentSyntheticProductionRun(
  run: Readonly<PersistedSyntheticProductionRun>,
) {
  return Object.freeze({
    id: run.plan.id,
    status: run.status,
    editPlanSnapshotId: run.editPlanSnapshotId,
    plan: run.plan,
  })
}

import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'

export const ASSET_RIGHTS_STATUSES = [
  'approved',
  'restricted',
  'unknown',
  'expired',
  'revoked',
] as const
export type AssetRightsStatus = (typeof ASSET_RIGHTS_STATUSES)[number]

export const ASSET_CONSENT_STATUSES = [
  'not-required',
  'approved',
  'restricted',
  'unknown',
  'expired',
  'revoked',
] as const
export type AssetConsentStatus = (typeof ASSET_CONSENT_STATUSES)[number]

export function assetRightsRevision(artifactId: string, revision: number): string {
  assertDomain(
    artifactId.trim().length >= 3 && artifactId.trim().length <= 128,
    'INVALID_MEDIA_ARTIFACT',
    'Asset rights revision requires a valid artifact id',
  )
  assertDomain(
    Number.isSafeInteger(revision) && revision >= 0,
    'INVALID_MEDIA_ARTIFACT',
    'Asset rights revision counter is invalid',
  )
  return calculateCanonicalHash({
    schemaVersion: 'asset-rights-revision/v1',
    artifactId: artifactId.trim(),
    revision,
  })
}

export interface AssetConsentScope {
  status: AssetConsentStatus
  allowedUses: readonly string[]
  allowedMarkets?: readonly string[]
  allowedLocales?: readonly string[]
  allowedSyntheticOperations?: readonly string[]
  expiresAt?: string
  documentArtifactId?: string
}

export interface AssetRightsSnapshot {
  schemaVersion: 'asset-rights/v1'
  id: string
  workspaceId: string
  artifactId: string
  sequence: number
  snapshotHash: string
  owner?: string
  license?: string
  status: AssetRightsStatus
  allowedUses: readonly string[]
  prohibitedUses: readonly string[]
  allowedWorkspaceIds: readonly string[]
  allowedMarkets?: readonly string[]
  allowedLocales?: readonly string[]
  allowedSyntheticOperations?: readonly string[]
  expiresAt?: string
  consent: AssetConsentScope
  sourceNote?: string
  createdBy: { type: 'api-client' | 'user' | 'system'; id: string }
  createdAt: string
}

export interface AssetRightsDraft {
  owner?: string
  license?: string
  status: AssetRightsStatus
  allowedUses: readonly string[]
  prohibitedUses: readonly string[]
  allowedMarkets?: readonly string[]
  allowedLocales?: readonly string[]
  allowedSyntheticOperations?: readonly string[]
  expiresAt?: string
  consent: {
    status: AssetConsentStatus
    allowedUses: readonly string[]
    allowedMarkets?: readonly string[]
    allowedLocales?: readonly string[]
    allowedSyntheticOperations?: readonly string[]
    expiresAt?: string
    documentArtifactId?: string
  }
  sourceNote?: string
}

export const ASSET_USE_DENIAL_CODES = [
  'RIGHTS_MISSING',
  'RIGHTS_STATUS_RESTRICTED',
  'RIGHTS_STATUS_UNKNOWN',
  'RIGHTS_STATUS_EXPIRED',
  'RIGHTS_STATUS_REVOKED',
  'RIGHTS_EXPIRED',
  'RIGHTS_WORKSPACE_NOT_ALLOWED',
  'RIGHTS_USE_PROHIBITED',
  'RIGHTS_USE_NOT_ALLOWED',
  'RIGHTS_MARKET_NOT_ALLOWED',
  'RIGHTS_LOCALE_NOT_ALLOWED',
  'RIGHTS_SYNTHETIC_OPERATION_NOT_ALLOWED',
  'CONSENT_STATUS_RESTRICTED',
  'CONSENT_STATUS_UNKNOWN',
  'CONSENT_STATUS_EXPIRED',
  'CONSENT_STATUS_REVOKED',
  'CONSENT_EXPIRED',
  'CONSENT_USE_NOT_ALLOWED',
  'CONSENT_MARKET_NOT_ALLOWED',
  'CONSENT_LOCALE_NOT_ALLOWED',
  'CONSENT_SYNTHETIC_OPERATION_NOT_ALLOWED',
] as const
export type AssetUseDenialCode = (typeof ASSET_USE_DENIAL_CODES)[number]

export interface AssetUseContext {
  workspaceId: string
  use: string
  market?: string
  locale: string
  syntheticOperations?: readonly string[]
}

export interface AssetUseDecision {
  outcome: 'allow' | 'deny'
  reasonCodes: readonly AssetUseDenialCode[]
  rightsSnapshotId?: string
  rightsSnapshotHash?: string
  validUntil?: string
}

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/
const MARKET_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,15}$/

function assertExactKeys(value: object, keys: readonly string[], field: string): void {
  const allowed = new Set(keys)
  assertDomain(
    Object.keys(value).every((key) => allowed.has(key)),
    'INVALID_ARGUMENT',
    `${field} contains unsupported properties`,
  )
}

function normalizeOptionalText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(
    normalized.length > 0 && normalized.length <= maxLength,
    'INVALID_ARGUMENT',
    `${field} must contain 1 to ${maxLength} characters`,
  )
  return normalized
}

function normalizeTokens(
  value: readonly string[],
  field: string,
  options: { allowEmpty?: boolean } = {},
): readonly string[] {
  assertDomain(Array.isArray(value), 'INVALID_ARGUMENT', `${field} must be an array`)
  assertDomain(
    value.length <= 64 && (options.allowEmpty || value.length > 0),
    'INVALID_ARGUMENT',
    `${field} must contain ${options.allowEmpty ? '0 to' : '1 to'} 64 values`,
  )
  const normalized = value.map((item) => {
    assertDomain(typeof item === 'string', 'INVALID_ARGUMENT', `${field} must contain strings`)
    const token = item.trim().toLowerCase()
    assertDomain(TOKEN_PATTERN.test(token), 'INVALID_ARGUMENT', `${field} contains an invalid token`)
    return token
  })
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze([...normalized].sort())
}

function normalizeMarkets(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  assertDomain(Array.isArray(value) && value.length <= 64, 'INVALID_ARGUMENT', `${field} must contain at most 64 values`)
  const normalized = value.map((item) => {
    assertDomain(typeof item === 'string', 'INVALID_ARGUMENT', `${field} must contain strings`)
    const market = item.trim().toUpperCase()
    assertDomain(MARKET_PATTERN.test(market), 'INVALID_ARGUMENT', `${field} contains an invalid market`)
    return market
  })
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze([...normalized].sort())
}

function normalizeLocales(
  value: readonly string[] | undefined,
  field: string,
): readonly string[] | undefined {
  if (value === undefined) return undefined
  assertDomain(Array.isArray(value) && value.length <= 64, 'INVALID_ARGUMENT', `${field} must contain at most 64 values`)
  const normalized = value.map((item) => {
    assertDomain(typeof item === 'string', 'INVALID_ARGUMENT', `${field} must contain strings`)
    let canonical = ''
    try {
      canonical = Intl.getCanonicalLocales(item.trim())[0] ?? ''
    } catch {
      canonical = ''
    }
    assertDomain(canonical.length > 0, 'INVALID_ARGUMENT', `${field} contains an invalid locale`)
    return canonical
  })
  assertDomain(
    normalized.every(Boolean),
    'INVALID_ARGUMENT',
    `${field} contains an invalid locale`,
  )
  assertDomain(new Set(normalized).size === normalized.length, 'INVALID_ARGUMENT', `${field} contains duplicates`)
  return Object.freeze([...normalized].sort())
}

function normalizeDate(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const date = new Date(value)
  assertDomain(!Number.isNaN(date.getTime()), 'INVALID_ARGUMENT', `${field} must be a valid date-time`)
  return date.toISOString()
}

function normalizeId(value: string, field: string): string {
  assertDomain(typeof value === 'string', 'INVALID_ARGUMENT', `${field} must be a string`)
  const normalized = value.trim()
  assertDomain(ID_PATTERN.test(normalized), 'INVALID_ARGUMENT', `${field} is invalid`)
  return normalized
}

function immutableSnapshot(snapshot: AssetRightsSnapshot): AssetRightsSnapshot {
  return Object.freeze({
    ...snapshot,
    allowedUses: Object.freeze([...snapshot.allowedUses]),
    prohibitedUses: Object.freeze([...snapshot.prohibitedUses]),
    allowedWorkspaceIds: Object.freeze([...snapshot.allowedWorkspaceIds]),
    ...(snapshot.allowedMarkets ? { allowedMarkets: Object.freeze([...snapshot.allowedMarkets]) } : {}),
    ...(snapshot.allowedLocales ? { allowedLocales: Object.freeze([...snapshot.allowedLocales]) } : {}),
    ...(snapshot.allowedSyntheticOperations
      ? { allowedSyntheticOperations: Object.freeze([...snapshot.allowedSyntheticOperations]) }
      : {}),
    consent: Object.freeze({
      ...snapshot.consent,
      allowedUses: Object.freeze([...snapshot.consent.allowedUses]),
      ...(snapshot.consent.allowedMarkets
        ? { allowedMarkets: Object.freeze([...snapshot.consent.allowedMarkets]) }
        : {}),
      ...(snapshot.consent.allowedLocales
        ? { allowedLocales: Object.freeze([...snapshot.consent.allowedLocales]) }
        : {}),
      ...(snapshot.consent.allowedSyntheticOperations
        ? {
            allowedSyntheticOperations: Object.freeze([
              ...snapshot.consent.allowedSyntheticOperations,
            ]),
          }
        : {}),
    }),
    createdBy: Object.freeze({ ...snapshot.createdBy }),
  })
}

export function createAssetRightsSnapshot(input: {
  id: string
  workspaceId: string
  artifactId: string
  sequence: number
  draft: AssetRightsDraft
  createdBy: AssetRightsSnapshot['createdBy']
  createdAt: string
}): AssetRightsSnapshot {
  assertExactKeys(
    input.draft,
    [
      'owner', 'license', 'status', 'allowedUses', 'prohibitedUses',
      'allowedMarkets', 'allowedLocales', 'allowedSyntheticOperations',
      'expiresAt', 'consent', 'sourceNote',
    ],
    'rights',
  )
  assertDomain(
    ASSET_RIGHTS_STATUSES.includes(input.draft.status),
    'INVALID_ARGUMENT',
    'rights.status is invalid',
  )
  assertExactKeys(
    input.draft.consent,
    [
      'status', 'allowedUses', 'allowedMarkets', 'allowedLocales',
      'allowedSyntheticOperations', 'expiresAt', 'documentArtifactId',
    ],
    'rights.consent',
  )
  assertDomain(
    ASSET_CONSENT_STATUSES.includes(input.draft.consent.status),
    'INVALID_ARGUMENT',
    'rights.consent.status is invalid',
  )
  assertDomain(
    Number.isSafeInteger(input.sequence) && input.sequence > 0,
    'INVALID_ARGUMENT',
    'rights sequence must be a positive integer',
  )
  assertDomain(
    ['api-client', 'user', 'system'].includes(input.createdBy.type),
    'INVALID_ARGUMENT',
    'rights creator type is invalid',
  )

  const workspaceId = normalizeId(input.workspaceId, 'workspaceId')
  const artifactId = normalizeId(input.artifactId, 'artifactId')
  const createdAt = normalizeDate(input.createdAt, 'createdAt') as string
  const allowedUses = normalizeTokens(input.draft.allowedUses, 'rights.allowedUses', {
    allowEmpty: input.draft.status !== 'approved',
  })
  const prohibitedUses = normalizeTokens(
    input.draft.prohibitedUses,
    'rights.prohibitedUses',
    { allowEmpty: true },
  )
  assertDomain(
    allowedUses.every((use) => !prohibitedUses.includes(use)),
    'INVALID_ARGUMENT',
    'rights allowedUses and prohibitedUses cannot overlap',
  )
  const consentAllowedUses = normalizeTokens(
    input.draft.consent.allowedUses,
    'rights.consent.allowedUses',
    { allowEmpty: input.draft.consent.status !== 'approved' },
  )
  const content = {
    schemaVersion: 'asset-rights/v1' as const,
    workspaceId,
    artifactId,
    owner: normalizeOptionalText(input.draft.owner, 'rights.owner', 240),
    license: normalizeOptionalText(input.draft.license, 'rights.license', 240),
    status: input.draft.status,
    allowedUses,
    prohibitedUses,
    allowedWorkspaceIds: Object.freeze([workspaceId]),
    allowedMarkets: normalizeMarkets(input.draft.allowedMarkets, 'rights.allowedMarkets'),
    allowedLocales: normalizeLocales(input.draft.allowedLocales, 'rights.allowedLocales'),
    allowedSyntheticOperations: input.draft.allowedSyntheticOperations === undefined
      ? undefined
      : normalizeTokens(
          input.draft.allowedSyntheticOperations,
          'rights.allowedSyntheticOperations',
          { allowEmpty: true },
        ),
    expiresAt: normalizeDate(input.draft.expiresAt, 'rights.expiresAt'),
    consent: {
      status: input.draft.consent.status,
      allowedUses: consentAllowedUses,
      allowedMarkets: normalizeMarkets(
        input.draft.consent.allowedMarkets,
        'rights.consent.allowedMarkets',
      ),
      allowedLocales: normalizeLocales(
        input.draft.consent.allowedLocales,
        'rights.consent.allowedLocales',
      ),
      allowedSyntheticOperations:
        input.draft.consent.allowedSyntheticOperations === undefined
          ? undefined
          : normalizeTokens(
              input.draft.consent.allowedSyntheticOperations,
              'rights.consent.allowedSyntheticOperations',
              { allowEmpty: true },
            ),
      expiresAt: normalizeDate(
        input.draft.consent.expiresAt,
        'rights.consent.expiresAt',
      ),
      documentArtifactId: input.draft.consent.documentArtifactId === undefined
        ? undefined
        : normalizeId(
            input.draft.consent.documentArtifactId,
            'rights.consent.documentArtifactId',
          ),
    },
    sourceNote: normalizeOptionalText(input.draft.sourceNote, 'rights.sourceNote', 2000),
  }
  const snapshotHash = calculateCanonicalHash(content)

  return immutableSnapshot({
    ...content,
    id: normalizeId(input.id, 'rights.id'),
    sequence: input.sequence,
    snapshotHash,
    createdBy: {
      type: input.createdBy.type,
      id: normalizeId(input.createdBy.id, 'rights.createdBy.id'),
    },
    createdAt,
  })
}

function statusReason(
  prefix: 'RIGHTS' | 'CONSENT',
  status: Exclude<AssetRightsStatus | AssetConsentStatus, 'approved' | 'not-required'>,
): AssetUseDenialCode {
  return `${prefix}_STATUS_${status.toUpperCase().replace('-', '_')}` as AssetUseDenialCode
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
  return expiresAt !== undefined && new Date(expiresAt).getTime() <= now.getTime()
}

function scopedValueAllowed(
  allowed: readonly string[] | undefined,
  requested: string | undefined,
): boolean {
  return allowed === undefined || (requested !== undefined && allowed.includes(requested))
}

export function evaluateAssetUse(
  snapshot: AssetRightsSnapshot | null,
  context: AssetUseContext,
  now: Date,
  authorizationTtlSeconds = 300,
): AssetUseDecision {
  if (!snapshot) {
    return Object.freeze({
      outcome: 'deny',
      reasonCodes: Object.freeze(['RIGHTS_MISSING'] as const),
    })
  }
  assertDomain(!Number.isNaN(now.getTime()), 'INVALID_ARGUMENT', 'evaluation time is invalid')
  assertDomain(
    Number.isInteger(authorizationTtlSeconds) &&
      authorizationTtlSeconds >= 1 &&
      authorizationTtlSeconds <= 900,
    'INVALID_ARGUMENT',
    'authorization TTL must be between 1 and 900 seconds',
  )

  const normalizedContext = normalizeAssetUseContext(context)
  const { workspaceId, use, market, locale } = normalizedContext
  const syntheticOperations = normalizedContext.syntheticOperations ?? Object.freeze([] as string[])
  const reasons: AssetUseDenialCode[] = []

  if (snapshot.status !== 'approved') {
    reasons.push(statusReason('RIGHTS', snapshot.status))
  } else {
    if (isExpired(snapshot.expiresAt, now)) reasons.push('RIGHTS_EXPIRED')
    if (!snapshot.allowedWorkspaceIds.includes(workspaceId)) {
      reasons.push('RIGHTS_WORKSPACE_NOT_ALLOWED')
    }
    if (snapshot.prohibitedUses.includes(use)) reasons.push('RIGHTS_USE_PROHIBITED')
    if (!snapshot.allowedUses.includes(use)) reasons.push('RIGHTS_USE_NOT_ALLOWED')
    if (!scopedValueAllowed(snapshot.allowedMarkets, market)) {
      reasons.push('RIGHTS_MARKET_NOT_ALLOWED')
    }
    if (!scopedValueAllowed(snapshot.allowedLocales, locale)) {
      reasons.push('RIGHTS_LOCALE_NOT_ALLOWED')
    }
    if (
      syntheticOperations.some(
        (operation) => !snapshot.allowedSyntheticOperations?.includes(operation),
      )
    ) {
      reasons.push('RIGHTS_SYNTHETIC_OPERATION_NOT_ALLOWED')
    }
  }

  if (snapshot.consent.status !== 'not-required') {
    if (snapshot.consent.status !== 'approved') {
      reasons.push(statusReason('CONSENT', snapshot.consent.status))
    } else {
      if (isExpired(snapshot.consent.expiresAt, now)) reasons.push('CONSENT_EXPIRED')
      if (!snapshot.consent.allowedUses.includes(use)) {
        reasons.push('CONSENT_USE_NOT_ALLOWED')
      }
      if (!scopedValueAllowed(snapshot.consent.allowedMarkets, market)) {
        reasons.push('CONSENT_MARKET_NOT_ALLOWED')
      }
      if (!scopedValueAllowed(snapshot.consent.allowedLocales, locale)) {
        reasons.push('CONSENT_LOCALE_NOT_ALLOWED')
      }
      if (
        syntheticOperations.some(
          (operation) => !snapshot.consent.allowedSyntheticOperations?.includes(operation),
        )
      ) {
        reasons.push('CONSENT_SYNTHETIC_OPERATION_NOT_ALLOWED')
      }
    }
  }

  const reasonCodes = Object.freeze([...new Set(reasons)])
  if (reasonCodes.length > 0) {
    return Object.freeze({
      outcome: 'deny',
      reasonCodes,
      rightsSnapshotId: snapshot.id,
      rightsSnapshotHash: snapshot.snapshotHash,
    })
  }

  const expiryCandidates = [
    now.getTime() + authorizationTtlSeconds * 1000,
    snapshot.expiresAt ? new Date(snapshot.expiresAt).getTime() : Number.POSITIVE_INFINITY,
    snapshot.consent.status === 'approved' && snapshot.consent.expiresAt
      ? new Date(snapshot.consent.expiresAt).getTime()
      : Number.POSITIVE_INFINITY,
  ]
  return Object.freeze({
    outcome: 'allow',
    reasonCodes,
    rightsSnapshotId: snapshot.id,
    rightsSnapshotHash: snapshot.snapshotHash,
    validUntil: new Date(Math.min(...expiryCandidates)).toISOString(),
  })
}

export function normalizeAssetUseContext(context: AssetUseContext): AssetUseContext {
  return Object.freeze({
    workspaceId: normalizeId(context.workspaceId, 'workspaceId'),
    use: normalizeTokens([context.use], 'use')[0],
    ...(context.market
      ? { market: normalizeMarkets([context.market], 'market')?.[0] as string }
      : {}),
    locale: normalizeLocales([context.locale], 'locale')?.[0] as string,
    ...(context.syntheticOperations === undefined
      ? {}
      : {
          syntheticOperations: normalizeTokens(
            context.syntheticOperations,
            'syntheticOperations',
            { allowEmpty: true },
          ),
        }),
  })
}

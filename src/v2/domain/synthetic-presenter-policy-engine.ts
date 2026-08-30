import { assertDomain } from './errors.ts'
import {
  createSyntheticPresenterProfileSnapshot,
  type SyntheticPresenterProfileSnapshot,
} from './synthetic-production.ts'

export const SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION = 'synthetic-presenter-eligibility-policy/v1' as const

/**
 * Operations the policy knows how to judge. Anything else — voice cloning,
 * lip-sync, or an operation invented tomorrow — is unclassified and denied
 * fail-closed until it is deliberately added here AND to consent scopes.
 */
export const CLASSIFIED_SYNTHETIC_OPERATIONS = Object.freeze(['tts', 'audio-avatar'] as const)

export interface SyntheticPresenterPolicyReason {
  code:
    | 'PAYLOAD_TAMPERED'
    | 'WORKSPACE_MISMATCH'
    | 'OPERATION_UNCLASSIFIED'
    | 'OPERATION_NOT_CONSENTED'
    | 'PROFILE_NOT_ACTIVE'
    | 'CONSENT_MISSING'
    | 'CONSENT_REVOKED'
    | 'CONSENT_EXPIRED'
    | 'USE_NOT_ALLOWED'
    | 'MARKET_NOT_ALLOWED'
    | 'LOCALE_NOT_ALLOWED'
    | 'VERSION_SUPERSEDED'
    | 'CURRENT_VERSION_NOT_ACTIVE'
    | 'CURRENT_CONSENT_REVOKED'
    | 'CURRENT_CONSENT_EXPIRED'
  message: string
}

export interface SyntheticPresenterPolicyDecision {
  policyVersion: typeof SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION
  allowed: boolean
  reasons: readonly Readonly<SyntheticPresenterPolicyReason>[]
}

function consentReasons(
  consent: SyntheticPresenterProfileSnapshot['consent'],
  context: { operation: string; use: string; market: string; locale: string; now: Date },
  prefix: '' | 'CURRENT_',
): SyntheticPresenterPolicyReason[] {
  const reasons: SyntheticPresenterPolicyReason[] = []
  if (!consent.granted) {
    reasons.push({ code: prefix ? 'CURRENT_CONSENT_REVOKED' : 'CONSENT_MISSING', message: 'consent was never granted' })
  }
  if (consent.revokedAt && Date.parse(consent.revokedAt) <= context.now.getTime()) {
    reasons.push({ code: `${prefix}CONSENT_REVOKED` as SyntheticPresenterPolicyReason['code'], message: `consent was revoked at ${consent.revokedAt}` })
  }
  if (Date.parse(consent.expiresAt) <= context.now.getTime()) {
    reasons.push({ code: `${prefix}CONSENT_EXPIRED` as SyntheticPresenterPolicyReason['code'], message: `consent expired at ${consent.expiresAt}` })
  }
  if (prefix === '') {
    if (!consent.allowedUses.includes(context.use)) reasons.push({ code: 'USE_NOT_ALLOWED', message: `use ${context.use} is outside the consented scope` })
    if (!consent.allowedMarkets.includes(context.market)) reasons.push({ code: 'MARKET_NOT_ALLOWED', message: `market ${context.market} is outside the consented scope` })
    if (!consent.allowedLocales.includes(context.locale)) reasons.push({ code: 'LOCALE_NOT_ALLOWED', message: `locale ${context.locale} is outside the consented scope` })
    if (!consent.allowedOperations.includes(context.operation as 'tts' | 'audio-avatar')) {
      reasons.push({ code: 'OPERATION_NOT_CONSENTED', message: `operation ${context.operation} was never consented` })
    }
  }
  return reasons
}

/**
 * Deterministic identity/voice/consent gate. It runs before cost, before any
 * cache lookup, before every submit, again before reuse and again before a
 * master materializes. The most recent version of the logical profile — its
 * head — expresses the actor's latest will: a revoked or expired CURRENT
 * consent blocks generation for every older snapshot of the same identity.
 */
export function evaluateSyntheticPresenterPolicy(input: {
  snapshot: Readonly<SyntheticPresenterProfileSnapshot>
  snapshotWorkspaceId: string
  head?: Readonly<{ currentVersion: number; current: Readonly<SyntheticPresenterProfileSnapshot> }>
  context: {
    operation: string
    use: string
    market: string
    locale: string
    workspaceId: string
    now: Date
    requireActiveVersion?: boolean
  }
}): Readonly<SyntheticPresenterPolicyDecision> {
  const reasons: SyntheticPresenterPolicyReason[] = []
  const { snapshot, context } = input

  try {
    const recreated = createSyntheticPresenterProfileSnapshot({
      id: snapshot.id,
      version: snapshot.version,
      actorIdentityId: snapshot.actorIdentityId,
      avatar: snapshot.avatar,
      voice: snapshot.voice,
      defaultLocale: snapshot.defaultLocale,
      status: snapshot.status,
      disclosure: snapshot.disclosure,
      consent: snapshot.consent,
      ...(snapshot.pronunciationDictionaryRef ? { pronunciationDictionaryRef: snapshot.pronunciationDictionaryRef } : {}),
      ...(snapshot.visualContinuity ? { visualContinuity: snapshot.visualContinuity } : {}),
      ...(snapshot.restrictions ? { restrictions: snapshot.restrictions } : {}),
    })
    if (recreated.snapshotHash !== snapshot.snapshotHash || recreated.consent.snapshotHash !== snapshot.consent.snapshotHash) {
      reasons.push({ code: 'PAYLOAD_TAMPERED', message: 'profile snapshot hash does not match its content' })
    }
  } catch {
    reasons.push({ code: 'PAYLOAD_TAMPERED', message: 'profile snapshot content is invalid' })
  }

  if (input.snapshotWorkspaceId !== context.workspaceId) {
    reasons.push({ code: 'WORKSPACE_MISMATCH', message: 'profile belongs to another workspace' })
  }
  if (!CLASSIFIED_SYNTHETIC_OPERATIONS.includes(context.operation as 'tts' | 'audio-avatar')) {
    reasons.push({ code: 'OPERATION_UNCLASSIFIED', message: `operation ${context.operation} has no classified policy yet` })
  }
  if (snapshot.status !== 'active') {
    reasons.push({ code: 'PROFILE_NOT_ACTIVE', message: `profile version ${snapshot.version} is ${snapshot.status}` })
  }
  reasons.push(...consentReasons(snapshot.consent, context, ''))

  if (input.head) {
    if (context.requireActiveVersion && input.head.currentVersion !== snapshot.version) {
      reasons.push({ code: 'VERSION_SUPERSEDED', message: `version ${snapshot.version} is superseded by ${input.head.currentVersion}` })
    }
    if (input.head.current.status !== 'active') {
      reasons.push({ code: 'CURRENT_VERSION_NOT_ACTIVE', message: `the profile's current version ${input.head.currentVersion} is ${input.head.current.status}` })
    }
    reasons.push(...consentReasons(input.head.current.consent, context, 'CURRENT_')
      .filter(({ code }) => code.startsWith('CURRENT_')))
  }

  const unique = new Map(reasons.map((reason) => [reason.code, reason]))
  return Object.freeze({
    policyVersion: SYNTHETIC_PRESENTER_ELIGIBILITY_POLICY_VERSION,
    allowed: unique.size === 0,
    reasons: Object.freeze([...unique.values()]),
  })
}

export function assertSyntheticPresenterPolicy(
  input: Parameters<typeof evaluateSyntheticPresenterPolicy>[0],
): void {
  const decision = evaluateSyntheticPresenterPolicy(input)
  assertDomain(
    decision.allowed,
    'ASSET_RIGHTS_BLOCKED',
    `Synthetic presenter policy denied ${input.context.operation}: ${decision.reasons.map(({ code }) => code).join(', ')}`,
  )
}

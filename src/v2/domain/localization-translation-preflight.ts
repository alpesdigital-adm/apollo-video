import { calculateCanonicalHash } from './canonical-hash.ts'
import { assertDomain } from './errors.ts'
import type { LocalizedAudioMode } from './localization.ts'

export const LOCALIZATION_TRANSLATION_PREFLIGHT_SCHEMA_VERSION = 'localization-translation-preflight/v1' as const

export interface LocalizationTranslationPreflight {
  schemaVersion: typeof LOCALIZATION_TRANSLATION_PREFLIGHT_SCHEMA_VERSION
  id: string
  workspaceId: string
  projectId: string
  variantId: string
  variantRevision: number
  variantHash: string
  canonicalScriptVersionId: string
  canonicalContentHash: string
  targetLocale: string
  market?: string
  mode: LocalizedAudioMode
  providerId: string
  adapterVersion: string
  model: string
  providerConfigHash: string
  inputCharacterCount: number
  maximumOutputTokens: number
  estimatedCostMicros: number
  maximumCostMicros: number
  currency: string
  costFingerprint: string
  requestedByClientId: string
  createdAt: string
  expiresAt: string
  preflightHash: string
}

export function createLocalizationTranslationPreflight(input: Omit<LocalizationTranslationPreflight, 'schemaVersion' | 'costFingerprint' | 'preflightHash'>) {
  assertDomain(Number.isSafeInteger(input.inputCharacterCount) && input.inputCharacterCount > 0 && Number.isSafeInteger(input.maximumOutputTokens) && input.maximumOutputTokens > 0 && Number.isSafeInteger(input.estimatedCostMicros) && input.estimatedCostMicros >= 0 && Number.isSafeInteger(input.maximumCostMicros) && input.maximumCostMicros >= input.estimatedCostMicros, 'PRECONDITION_REQUIRED', 'Localization translation exceeds the configured cost bound')
  assertDomain(/^[A-Z]{3}$/.test(input.currency) && /^[a-f0-9]{64}$/.test(input.variantHash) && /^[a-f0-9]{64}$/.test(input.canonicalContentHash) && /^[a-f0-9]{64}$/.test(input.providerConfigHash), 'INVALID_ARGUMENT', 'Localization translation preflight binding is invalid')
  assertDomain(new Date(input.expiresAt) > new Date(input.createdAt), 'INVALID_ARGUMENT', 'Localization translation preflight expiry is invalid')
  const costFingerprint = calculateCanonicalHash({ providerId: input.providerId, adapterVersion: input.adapterVersion, model: input.model, providerConfigHash: input.providerConfigHash, inputCharacterCount: input.inputCharacterCount, maximumOutputTokens: input.maximumOutputTokens, estimatedCostMicros: input.estimatedCostMicros, maximumCostMicros: input.maximumCostMicros, currency: input.currency })
  const body = { schemaVersion: LOCALIZATION_TRANSLATION_PREFLIGHT_SCHEMA_VERSION, ...input, costFingerprint }
  return Object.freeze({ ...body, preflightHash: calculateCanonicalHash(body) })
}

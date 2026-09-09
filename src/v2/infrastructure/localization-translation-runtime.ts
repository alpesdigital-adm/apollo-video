import { DomainError } from '../domain/errors.ts'
import { OpenAiCompatibleLocalizationProvider } from './openai-compatible-localization-provider.ts'
import type { LocalizationTranslationPricing } from '../application/localization-translation-worker.ts'

function integer(environment: NodeJS.ProcessEnv, name: string, minimum: number, maximum: number) {
  const value = Number(environment[name])
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', `${name} is not configured with a safe bound`)
  return value
}

export function createLocalizationTranslationProviderFromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  const baseUrl = environment.APOLLO_LOCALIZATION_PROVIDER_BASE_URL?.trim(), apiKey = environment.APOLLO_LOCALIZATION_PROVIDER_API_KEY?.trim(), model = environment.APOLLO_LOCALIZATION_PROVIDER_MODEL?.trim()
  if (!baseUrl || !apiKey || !model) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Localization provider credentials and model are not configured')
  return new OpenAiCompatibleLocalizationProvider({ baseUrl, apiKey, model, timeoutMs: integer(environment, 'APOLLO_LOCALIZATION_PROVIDER_TIMEOUT_MS', 1_000, 600_000), maxResponseBytes: integer(environment, 'APOLLO_LOCALIZATION_PROVIDER_MAX_RESPONSE_BYTES', 1_024, 8 * 1024 * 1024), maxCompletionTokens: integer(environment, 'APOLLO_LOCALIZATION_PROVIDER_MAX_COMPLETION_TOKENS', 1, 32_768) })
}

export function createLocalizationTranslationPricingFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Readonly<LocalizationTranslationPricing> {
  const currency = environment.APOLLO_LOCALIZATION_PRICE_CURRENCY?.trim().toUpperCase()
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Localization pricing currency is not configured')
  return Object.freeze({ currency, microsPerThousandInputCharacters: integer(environment, 'APOLLO_LOCALIZATION_PRICE_MICROS_PER_1K_INPUT_CHARS', 0, Number.MAX_SAFE_INTEGER), microsPerThousandOutputTokens: integer(environment, 'APOLLO_LOCALIZATION_PRICE_MICROS_PER_1K_OUTPUT_TOKENS', 0, Number.MAX_SAFE_INTEGER), maximumCostMicros: integer(environment, 'APOLLO_LOCALIZATION_MAX_COST_MICROS', 0, Number.MAX_SAFE_INTEGER), confirmationTtlMs: integer(environment, 'APOLLO_LOCALIZATION_PREFLIGHT_TTL_MS', 10_000, 900_000) })
}

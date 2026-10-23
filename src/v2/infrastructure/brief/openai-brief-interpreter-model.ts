import { createHash } from 'node:crypto'

import type {
  BriefInterpreterModel,
  BriefInterpreterRequest,
  BriefInterpreterResponse,
} from '../../application/ports/brief-interpreter-model.ts'
import { DomainError } from '../../domain/errors.ts'

/**
 * The OpenAI adapter of the briefing interpreter (ADR-160 F6). One chat completion with a structured output (JSON Schema, strict) per
 * briefing, over `fetch` like the other OpenAI adapters of the repository (no SDK). The adapter carries a request and returns the raw text;
 * it knows nothing about directives. Every check of the answer is `interpret-brief.ts`'s.
 *
 * The alternative provider (`APOLLO_V2_BRIEF_INTERPRETER_PROVIDER=openai-api`; the primary one is the Codex CLI, see codex-cli-brief-interpreter-model.ts).
 * Configuration is infrastructure, not an editorial decision, so it has NO default for the model or the key:
 *   APOLLO_V2_BRIEF_INTERPRETER_MODEL   the model name (required)
 *   OPENAI_API_KEY                      the credential (required; never logged, never stored, never put in an error)
 *   APOLLO_V2_BRIEF_INTERPRETER_BASE_URL            optional endpoint (https, or http on loopback for a local stand-in); default the OpenAI API
 *   APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS          optional transport bound
 *   APOLLO_V2_BRIEF_INTERPRETER_MAX_COMPLETION_TOKENS  optional output bound
 *   APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_INPUT_TOKENS / _OUTPUT_TOKENS   optional price, so the audit can state a cost
 * Without the model or the key there is no interpreter, and a briefing with text fails closed (`PRECONDITION_REQUIRED`).
 */
export const OPENAI_BRIEF_INTERPRETER_PROVIDER = 'openai'
const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export interface OpenAiBriefInterpreterConfiguration {
  apiKey: string
  model: string
  baseUrl?: string
  timeoutMs?: number
  maxCompletionTokens?: number
  maxResponseBytes?: number
  pricing?: BriefInterpreterModel['pricing']
  fetch?: FetchLike
}

function notConfigured(message: string): DomainError {
  return new DomainError('PERSISTENCE_NOT_CONFIGURED', message)
}

function providerFailure(status?: number): DomainError {
  const transient = status === undefined || status === 408 || status === 425 || status === 429 || status >= 500
  return new DomainError('RENDER_EXECUTION_FAILED',
    transient ? 'Brief interpreter provider is temporarily unavailable'
      : status === 401 || status === 403 ? 'Brief interpreter provider rejected the credential'
        : 'Brief interpreter provider rejected the request')
}

function invalid(message: string): DomainError {
  return new DomainError('RENDER_OUTPUT_INVALID', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function boundedText(response: Response, limit: number): Promise<string> {
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => undefined)
    throw invalid('Brief interpreter response exceeds the configured limit')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw invalid('Brief interpreter response exceeds the configured limit')
      chunks.push(part.value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return new TextDecoder().decode(bytes)
}

export class OpenAiBriefInterpreterModel implements BriefInterpreterModel {
  readonly provider = OPENAI_BRIEF_INTERPRETER_PROVIDER
  readonly model: string
  readonly costBasis = 'api-metered' as const
  readonly pricing?: BriefInterpreterModel['pricing']
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxCompletionTokens: number
  private readonly maxResponseBytes: number
  private readonly request: FetchLike

  constructor(configuration: Readonly<OpenAiBriefInterpreterConfiguration>) {
    const model = configuration.model.trim()
    const apiKey = configuration.apiKey.trim()
    if (model.length === 0 || model.length > 128 || apiKey.length < 8) throw notConfigured('Brief interpreter configuration is incomplete')
    let url: URL
    try { url = new URL(configuration.baseUrl ?? OPENAI_BASE_URL) } catch { throw notConfigured('Brief interpreter base URL is invalid') }
    if (!((url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))) && !url.username && !url.password && !url.search && !url.hash)) {
      throw notConfigured('Brief interpreter base URL is invalid')
    }
    this.model = model
    this.apiKey = apiKey
    this.baseUrl = url.toString().replace(/\/$/u, '')
    this.timeoutMs = configuration.timeoutMs ?? 60_000
    this.maxCompletionTokens = configuration.maxCompletionTokens ?? 8_192
    this.maxResponseBytes = configuration.maxResponseBytes ?? 512 * 1024
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 10 || this.timeoutMs > 600_000 ||
      !Number.isSafeInteger(this.maxCompletionTokens) || this.maxCompletionTokens < 256 || this.maxCompletionTokens > 65_536 ||
      !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1_024 || this.maxResponseBytes > 8 * 1024 * 1024) {
      throw notConfigured('Brief interpreter transport bounds are invalid')
    }
    if (configuration.pricing) {
      const { inputMinorUnitsPerMillionTokens: input, outputMinorUnitsPerMillionTokens: output } = configuration.pricing
      if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) throw notConfigured('Brief interpreter pricing is invalid')
      this.pricing = Object.freeze({ ...configuration.pricing })
    }
    this.request = configuration.fetch ?? ((target, init) => fetch(target, init))
  }

  async interpret(input: Readonly<BriefInterpreterRequest>): Promise<Readonly<BriefInterpreterResponse>> {
    input.signal?.throwIfAborted()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort('provider-timeout'), this.timeoutMs)
    const abort = () => controller.abort(input.signal?.reason)
    input.signal?.addEventListener('abort', abort, { once: true })
    try {
      const requestBody = JSON.stringify({
        model: this.model,
        max_completion_tokens: this.maxCompletionTokens,
        response_format: { type: 'json_schema', json_schema: { name: input.responseSchema.name, strict: true, schema: input.responseSchema.schema } },
        messages: [{ role: 'system', content: input.system }, { role: 'user', content: input.user }],
      })
      let response: Response
      try {
        response = await this.request(`${this.baseUrl}/chat/completions`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
          body: requestBody,
        })
      } catch {
        if (input.signal?.aborted) throw input.signal.reason
        throw providerFailure()
      }
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw providerFailure(response.status) }
      let envelope: unknown
      try { envelope = JSON.parse(await boundedText(response, this.maxResponseBytes)) } catch (error) {
        if (error instanceof DomainError) throw error
        if (input.signal?.aborted) throw input.signal.reason
        if (controller.signal.aborted) throw providerFailure()
        throw invalid('Brief interpreter response is not valid JSON')
      }
      const choice = isRecord(envelope) && Array.isArray(envelope.choices) && envelope.choices.length === 1 ? envelope.choices[0] : undefined
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined
      if (!message) throw invalid('Brief interpreter returned no message')
      if (typeof message.refusal === 'string' && message.refusal.length > 0) throw invalid('Brief interpreter declined to answer')
      if ((choice as Record<string, unknown>).finish_reason === 'length') throw invalid('Brief interpreter answer was cut short')
      if (typeof message.content !== 'string' || message.content.length === 0) throw invalid('Brief interpreter returned no structured content')
      const usage = isRecord((envelope as Record<string, unknown>).usage) ? (envelope as Record<string, unknown>).usage as Record<string, unknown> : undefined
      const resolved = (envelope as Record<string, unknown>).model
      return Object.freeze({
        text: message.content,
        ...(usage && Number.isSafeInteger(usage.prompt_tokens) && Number.isSafeInteger(usage.completion_tokens)
          ? { usage: Object.freeze({ inputTokens: usage.prompt_tokens as number, outputTokens: usage.completion_tokens as number }) } : {}),
        modelInputHash: createHash('sha256').update(requestBody, 'utf8').digest('hex'),
        ...(typeof resolved === 'string' && resolved.length > 0 && resolved.length <= 128 ? { resolvedModel: resolved } : {}),
      })
    } finally {
      clearTimeout(timeout)
      input.signal?.removeEventListener('abort', abort)
    }
  }
}

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw notConfigured('Brief interpreter numeric configuration is invalid')
  return parsed
}

function price(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw notConfigured('Brief interpreter pricing is invalid')
  return parsed
}

/**
 * The interpreter this deployment configured, or `null` when it configured none (model or key absent). `null` is not an error here: it is
 * the state in which a briefing with text cannot be read, and the services that need it fail closed with PRECONDITION_REQUIRED.
 */
export function createOpenAiApiBriefInterpreterModelFromEnvironment(environment: NodeJS.ProcessEnv = process.env): OpenAiBriefInterpreterModel | null {
  const model = environment.APOLLO_V2_BRIEF_INTERPRETER_MODEL?.trim()
  const apiKey = environment.OPENAI_API_KEY?.trim()
  if (!model || !apiKey) return null
  const input = price(environment.APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_INPUT_TOKENS)
  const output = price(environment.APOLLO_V2_BRIEF_INTERPRETER_COST_MINOR_UNITS_PER_MILLION_OUTPUT_TOKENS)
  const timeoutMs = positiveInteger(environment.APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS)
  const maxCompletionTokens = positiveInteger(environment.APOLLO_V2_BRIEF_INTERPRETER_MAX_COMPLETION_TOKENS)
  const baseUrl = environment.APOLLO_V2_BRIEF_INTERPRETER_BASE_URL?.trim()
  return new OpenAiBriefInterpreterModel({
    apiKey, model,
    ...(baseUrl ? { baseUrl } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxCompletionTokens !== undefined ? { maxCompletionTokens } : {}),
    ...(input !== undefined && output !== undefined ? { pricing: { inputMinorUnitsPerMillionTokens: input, outputMinorUnitsPerMillionTokens: output } } : {}),
  })
}

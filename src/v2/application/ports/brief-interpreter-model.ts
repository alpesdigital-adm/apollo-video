/**
 * The port of the model that reads a briefing (ADR-160 F6). The Apollo owns the instruction, the response schema and every check of what
 * comes back (`interpret-brief.ts`); an adapter only carries one request to one provider and returns the provider's raw text.
 */
export interface BriefInterpreterRequest {
  promptVersion: string
  /** The standing instruction. It is constant for a prompt version and never contains a word of the briefing. */
  system: string
  /** The briefing as DATA: a JSON document. It is never concatenated into `system`. */
  user: string
  /** The JSON Schema the response must satisfy (structured output). */
  responseSchema: Readonly<{ name: string; schema: Readonly<Record<string, unknown>> }>
  signal?: AbortSignal
}

export interface BriefInterpreterResponse {
  /** The JSON text the model produced, exactly as received: the audit hashes it. */
  text: string
  usage?: Readonly<{ inputTokens: number; outputTokens: number }>
  /** The model identifier the provider says answered (a snapshot name), when it says one. */
  resolvedModel?: string
  /** The version of the program that answered (a CLI), when it states one. */
  providerVersion?: string
  /** SHA-256 of everything that entered the model for this call (the prompt with the briefing in it, the flags or parameters that bound the agent, the schema). */
  modelInputHash?: string
}

export interface BriefInterpreterModel {
  readonly provider: string
  readonly model: string
  /**
   * How the use of the model is paid: `api-metered` (per token, so a price may be stated) or `subscription` (an account's plan: there is no
   * per-call cost to record, and the audit says so instead of writing zero).
   */
  readonly costBasis: 'api-metered' | 'subscription'
  /**
   * How long the adapter itself waits for its provider. The service that calls the model waits LONGER than this (plus a margin), so the adapter's
   * own, typed failure always arrives before the service's backstop gives up.
   */
  readonly timeoutMs?: number
  /** Minor units of cost per million tokens, when the deployment states a price; absent means the cost is unknown, never zero. */
  readonly pricing?: Readonly<{ inputMinorUnitsPerMillionTokens: number; outputMinorUnitsPerMillionTokens: number }>
  interpret(request: Readonly<BriefInterpreterRequest>): Promise<Readonly<BriefInterpreterResponse>>
}

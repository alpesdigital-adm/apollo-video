import type { BriefInterpreterModel } from '../../application/ports/brief-interpreter-model.ts'
import { DomainError } from '../../domain/errors.ts'
import { CodexCliBriefInterpreterModel } from './codex-cli-brief-interpreter-model.ts'
import { createOpenAiApiBriefInterpreterModelFromEnvironment } from './openai-brief-interpreter-model.ts'

/** The providers a deployment may select. There is no default: the choice, like the model, is infrastructure the owner makes. */
export const BRIEF_INTERPRETER_PROVIDERS = Object.freeze(['codex-cli', 'openai-api'] as const)

/**
 * The interpreter this deployment configured, or `null` when it configured none. `null` is not an error here: it is the state in which a
 * briefing with text cannot be read, and the services that need it fail closed with PRECONDITION_REQUIRED.
 *
 *   APOLLO_V2_BRIEF_INTERPRETER_PROVIDER   `codex-cli` (the Codex CLI signed in with a ChatGPT account) or `openai-api` (an API key)
 *   APOLLO_V2_BRIEF_INTERPRETER_MODEL      the model name (both)
 *   codex-cli:  APOLLO_V2_CODEX_BIN, optional APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS / _WORK_ROOT
 *   openai-api: OPENAI_API_KEY and the optional variables of openai-brief-interpreter-model.ts
 */
export function createBriefInterpreterModelFromEnvironment(environment: NodeJS.ProcessEnv = process.env): BriefInterpreterModel | null {
  const provider = environment.APOLLO_V2_BRIEF_INTERPRETER_PROVIDER?.trim()
  if (!provider) return null
  if (provider === 'openai-api') return createOpenAiApiBriefInterpreterModelFromEnvironment(environment)
  if (provider !== 'codex-cli') throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Brief interpreter provider is not supported')
  const binary = environment.APOLLO_V2_CODEX_BIN?.trim()
  const model = environment.APOLLO_V2_BRIEF_INTERPRETER_MODEL?.trim()
  if (!binary || !model) return null
  const timeout = environment.APOLLO_V2_BRIEF_INTERPRETER_TIMEOUT_MS?.trim()
  const timeoutMs = timeout ? Number(timeout) : undefined
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) throw new DomainError('PERSISTENCE_NOT_CONFIGURED', 'Brief interpreter timeout is invalid')
  const workRoot = environment.APOLLO_V2_BRIEF_INTERPRETER_WORK_ROOT?.trim()
  return new CodexCliBriefInterpreterModel({ binary, model, ...(timeoutMs !== undefined ? { timeoutMs } : {}), ...(workRoot ? { workRoot } : {}) }, environment)
}

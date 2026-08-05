import type {
  ProviderRuntimeRouter,
} from '../application/ports/provider-runtime-router.ts'
import type { ApiAccessAuditContext } from '../domain/api-access-control.ts'
import { DomainError } from '../domain/errors.ts'
import {
  createMediaTranscriberFromEnvironment,
} from './media/groq-media-transcriber.ts'
import {
  createOpenAiSpeakerDiarizationProviderFromEnvironment,
} from './media/openai-speaker-diarization-provider.ts'
import {
  SANDBOX_DIARIZATION_IDENTITY,
  SANDBOX_TRANSCRIPTION_IDENTITY,
  SandboxMediaTranscriber,
  SandboxSpeakerDiarizationProvider,
} from './sandbox/media-providers.ts'
import type {
  SandboxProviderExecutionRepository,
} from '../application/ports/sandbox-provider-execution-repository.ts'

const MAX_PRICE = 10_000_000

function pricing(
  value: string | undefined,
  field: string,
): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PRICE) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      `${field} pricing is not configured`,
    )
  }
  return parsed
}

function sandboxContext(audit: Readonly<ApiAccessAuditContext>) {
  return Object.freeze({
    workspaceId: audit.workspaceId,
    clientId: audit.clientId,
    environment: 'sandbox' as const,
  })
}

export class EnvironmentProviderRuntimeRouter
implements ProviderRuntimeRouter {
  private readonly environment: NodeJS.ProcessEnv
  private readonly sandboxExecutions: SandboxProviderExecutionRepository

  constructor(
    environment: NodeJS.ProcessEnv,
    sandboxExecutions: SandboxProviderExecutionRepository,
  ) {
    this.environment = environment
    this.sandboxExecutions = sandboxExecutions
  }

  resolveTranscription(audit: Readonly<ApiAccessAuditContext>) {
    if (audit.environment === 'sandbox') {
      return Object.freeze({
        identity: SANDBOX_TRANSCRIPTION_IDENTITY,
        pricingMinorUnitsPerHour: 7_200,
        create: () => new SandboxMediaTranscriber(
          sandboxContext(audit),
          this.sandboxExecutions,
        ),
      })
    }
    const model = this.environment.GROQ_TRANSCRIBE_MODEL?.trim() ||
      'whisper-large-v3-turbo'
    const version = this.environment.GROQ_TRANSCRIBE_ADAPTER_VERSION?.trim() ||
      'groq-audio-transcriptions/v1'
    const configuredPricing = pricing(
      this.environment.GROQ_TRANSCRIBE_COST_MINOR_UNITS_PER_HOUR,
      'Groq transcription',
    )
    return Object.freeze({
      identity: Object.freeze({ provider: 'groq', model, version }),
      pricingMinorUnitsPerHour: configuredPricing,
      create: () => createMediaTranscriberFromEnvironment(this.environment),
    })
  }

  resolveDiarization(audit: Readonly<ApiAccessAuditContext>) {
    if (audit.environment === 'sandbox') {
      return Object.freeze({
        identity: SANDBOX_DIARIZATION_IDENTITY,
        pricingMinorUnitsPerHour: 7_200,
        create: () => new SandboxSpeakerDiarizationProvider(
          sandboxContext(audit),
          this.sandboxExecutions,
        ),
      })
    }
    const model = this.environment.OPENAI_DIARIZATION_MODEL?.trim() ||
      'gpt-4o-transcribe-diarize'
    const configuredPricing = pricing(
      this.environment.OPENAI_DIARIZATION_COST_MINOR_UNITS_PER_HOUR,
      'OpenAI diarization',
    )
    return Object.freeze({
      identity: Object.freeze({
        provider: 'openai', model, version: 'diarized-json/v1',
      }),
      pricingMinorUnitsPerHour: configuredPricing,
      create: () =>
        createOpenAiSpeakerDiarizationProviderFromEnvironment(this.environment),
    })
  }
}

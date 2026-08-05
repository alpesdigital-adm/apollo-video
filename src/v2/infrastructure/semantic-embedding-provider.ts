import { createHash } from 'node:crypto'

import type {
  SemanticEmbeddingProvider,
} from '../application/ports/semantic-embedding-provider.ts'
import type {
  SandboxProviderExecutionRepository,
} from '../application/ports/sandbox-provider-execution-repository.ts'
import type {
  ApiEnvironment,
} from '../domain/api-client.ts'
import { calculateCanonicalHash } from '../domain/canonical-hash.ts'
import { DomainError } from '../domain/errors.ts'
import { normalizeSpeechText } from '../domain/speech-segment-catalog.ts'
import { SimulatedSandboxProvider } from './sandbox/simulated-provider.ts'

const DIMENSIONS = 256

function normalizedVector(
  values: readonly number[],
): readonly number[] {
  const magnitude = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  )
  if (!magnitude) return Object.freeze([...values])
  return Object.freeze(values.map((value) => value / magnitude))
}

export class DeterministicSemanticEmbeddingProvider
implements SemanticEmbeddingProvider {
  readonly descriptor = Object.freeze({
    provider: 'apollo',
    model: 'deterministic-semantic-projection',
    version: '1.0.0',
    dimensions: DIMENSIONS,
    degraded: true,
  })

  async embed(input: string): Promise<readonly number[]> {
    const terms = normalizeSpeechText(input).split(' ').filter(Boolean)
    if (terms.length === 0) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Semantic embedding input is empty',
      )
    }
    const vector = Array.from({ length: DIMENSIONS }, () => 0)
    for (const [position, term] of terms.entries()) {
      const digest = createHash('sha256')
        .update(`${term}:${position % 3}`)
        .digest()
      for (let offset = 0; offset < 8; offset += 2) {
        const index = digest.readUInt16BE(offset) % DIMENSIONS
        const sign = digest[offset + 8]! % 2 === 0 ? 1 : -1
        vector[index] += sign
      }
    }
    return normalizedVector(vector)
  }
}

export class OpenAISemanticEmbeddingProvider
implements SemanticEmbeddingProvider {
  private readonly apiKey: string
  private readonly fetcher: typeof fetch

  readonly descriptor = Object.freeze({
    provider: 'openai',
    model: 'text-embedding-3-small',
    version: '2024-01-25',
    dimensions: DIMENSIONS,
    degraded: false,
  })

  constructor(
    apiKey: string,
    fetcher: typeof fetch = fetch,
  ) {
    if (!apiKey.trim()) {
      throw new DomainError(
        'PERSISTENCE_NOT_CONFIGURED',
        'OPENAI_API_KEY is required for semantic embeddings',
      )
    }
    this.apiKey = apiKey
    this.fetcher = fetcher
  }

  async embed(input: string): Promise<readonly number[]> {
    const response = await this.fetcher(
      'https://api.openai.com/v1/embeddings',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.descriptor.model,
          input,
          dimensions: DIMENSIONS,
          encoding_format: 'float',
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )
    if (!response.ok) {
      throw new DomainError(
        'RENDER_EXECUTION_FAILED',
        `Semantic embedding provider returned HTTP ${response.status}`,
      )
    }
    const payload = await response.json() as {
      data?: { embedding?: unknown }[]
    }
    const vector = payload.data?.[0]?.embedding
    if (
      !Array.isArray(vector) ||
      vector.length !== DIMENSIONS ||
      !vector.every((value) =>
        typeof value === 'number' && Number.isFinite(value))
    ) {
      throw new DomainError(
        'INVALID_ARGUMENT',
        'Semantic embedding provider returned an invalid vector',
      )
    }
    return normalizedVector(vector)
  }
}

export class SandboxSemanticEmbeddingProvider
implements SemanticEmbeddingProvider {
  readonly descriptor = Object.freeze({
    provider: 'apollo-sandbox-fake',
    model: 'deterministic-semantic-projection',
    version: '1.0.0',
    dimensions: DIMENSIONS,
    degraded: false,
  })

  private readonly deterministic =
    new DeterministicSemanticEmbeddingProvider()
  private readonly context: Readonly<{
    workspaceId: string
    clientId: string
    environment: 'sandbox'
  }>
  private readonly repository: SandboxProviderExecutionRepository
  private readonly provider: SimulatedSandboxProvider

  constructor(
    context: Readonly<{
      workspaceId: string
      clientId: string
      environment: 'sandbox'
    }>,
    repository: SandboxProviderExecutionRepository,
    provider = new SimulatedSandboxProvider(),
  ) {
    this.context = context
    this.repository = repository
    this.provider = provider
  }

  async embed(input: string): Promise<readonly number[]> {
    const vector = await this.deterministic.embed(input)
    const receipt = this.provider.execute({
      ...this.context,
      operation: 'semantic-embedding',
      inputHash: calculateCanonicalHash({ input }),
      outputHash: calculateCanonicalHash({ vector }),
      units: Buffer.byteLength(input, 'utf8'),
    })
    await this.repository.record(receipt)
    return vector
  }
}

export function createSemanticEmbeddingProvider(input: {
  environment: ApiEnvironment
  workspaceId: string
  clientId: string
  sandboxExecutions: SandboxProviderExecutionRepository
  environmentVariables?: NodeJS.ProcessEnv
}): SemanticEmbeddingProvider {
  if (input.environment === 'sandbox') {
    return new SandboxSemanticEmbeddingProvider({
      environment: 'sandbox',
      workspaceId: input.workspaceId,
      clientId: input.clientId,
    }, input.sandboxExecutions)
  }
  const environmentVariables = input.environmentVariables ?? process.env
  const selected =
    environmentVariables.APOLLO_SEMANTIC_EMBEDDING_PROVIDER?.trim()
      .toLowerCase()
  if (selected === 'deterministic') {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Deterministic semantic embeddings are sandbox-only',
    )
  }
  if (selected && selected !== 'openai') {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Configured semantic embedding provider is not supported',
    )
  }
  const apiKey = environmentVariables.OPENAI_API_KEY?.trim()
  if (apiKey) return new OpenAISemanticEmbeddingProvider(apiKey)
  throw new DomainError(
    'PERSISTENCE_NOT_CONFIGURED',
    'OPENAI_API_KEY is required for production semantic search',
  )
}

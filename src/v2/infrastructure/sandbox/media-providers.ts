import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import type {
  SandboxProviderExecutionRepository,
} from '../../application/ports/sandbox-provider-execution-repository.ts'
import type {
  MediaTranscriber,
} from '../../application/ports/media-ingest.ts'
import type {
  SpeakerDiarizationProvider,
} from '../../application/ports/speaker-diarization-provider.ts'
import { calculateCanonicalHash } from '../../domain/canonical-hash.ts'
import { createMediaTranscript } from '../../domain/media-transcript.ts'
import { SimulatedSandboxProvider } from './simulated-provider.ts'

export const SANDBOX_TRANSCRIPTION_IDENTITY = Object.freeze({
  provider: 'apollo-sandbox-fake',
  model: 'deterministic-transcript',
  version: 'sandbox-transcription/v1',
})

export const SANDBOX_DIARIZATION_IDENTITY = Object.freeze({
  provider: 'apollo-sandbox-fake',
  model: 'deterministic-speakers',
  version: 'sandbox-diarization/v1',
})

interface SandboxProviderContext {
  workspaceId: string
  clientId: string
  environment: 'sandbox'
}

function inputIdentity(bytes: Buffer, language: string): string {
  return calculateCanonicalHash({
    audioSha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    language,
  })
}

function simulatedUnits(bytes: Buffer): number {
  return Math.max(1, Math.ceil(bytes.length / 2_048))
}

export class SandboxMediaTranscriber implements MediaTranscriber {
  private readonly provider = new SimulatedSandboxProvider()
  private readonly context: Readonly<SandboxProviderContext>
  private readonly repository: SandboxProviderExecutionRepository

  constructor(
    context: Readonly<SandboxProviderContext>,
    repository: SandboxProviderExecutionRepository,
  ) {
    this.context = context
    this.repository = repository
  }

  async transcribe(input: {
    audioPath: string
    language: string
    signal?: AbortSignal
  }) {
    input.signal?.throwIfAborted()
    const bytes = await readFile(input.audioPath)
    input.signal?.throwIfAborted()
    const transcript = createMediaTranscript({
      language: input.language,
      text: 'sandbox transcript',
      words: [
        { word: 'sandbox', start: 0, end: 0.05 },
        { word: 'transcript', start: 0.05, end: 0.1 },
      ],
      segments: [{
        id: 0,
        text: 'sandbox transcript',
        start: 0,
        end: 0.1,
        confidence: 1,
      }],
      provider: SANDBOX_TRANSCRIPTION_IDENTITY.provider,
      model: SANDBOX_TRANSCRIPTION_IDENTITY.model,
    })
    const receipt = this.provider.executeV2({
      ...this.context,
      operation: 'transcription',
      inputHash: inputIdentity(bytes, input.language),
      outputHash: transcript.transcriptHash,
      units: simulatedUnits(bytes),
    })
    await this.repository.record(receipt)
    return transcript
  }
}

export class SandboxSpeakerDiarizationProvider
implements SpeakerDiarizationProvider {
  private readonly provider = new SimulatedSandboxProvider()
  private readonly context: Readonly<SandboxProviderContext>
  private readonly repository: SandboxProviderExecutionRepository

  constructor(
    context: Readonly<SandboxProviderContext>,
    repository: SandboxProviderExecutionRepository,
  ) {
    this.context = context
    this.repository = repository
  }

  async diarize(input: {
    audioPath: string
    language: string
    expectedDurationMs: number
    signal: AbortSignal
  }) {
    input.signal.throwIfAborted()
    const bytes = await readFile(input.audioPath)
    input.signal.throwIfAborted()
    const result = Object.freeze({
      provider: Object.freeze({
        id: SANDBOX_DIARIZATION_IDENTITY.provider,
        model: SANDBOX_DIARIZATION_IDENTITY.model,
        version: SANDBOX_DIARIZATION_IDENTITY.version,
      }),
      segments: Object.freeze([Object.freeze({
        providerSegmentId: 'sandbox-speaker-segment-1',
        providerLabel: 'speaker-1',
        startMs: 0,
        endMs: input.expectedDurationMs,
        text: 'sandbox speaker',
      })]),
      usageSeconds: Math.max(1, Math.ceil(input.expectedDurationMs / 1_000)),
    })
    const receipt = this.provider.executeV2({
      ...this.context,
      operation: 'speaker-diarization',
      inputHash: inputIdentity(bytes, input.language),
      outputHash: calculateCanonicalHash(result),
      units: simulatedUnits(bytes),
    })
    await this.repository.record(receipt)
    return result
  }
}

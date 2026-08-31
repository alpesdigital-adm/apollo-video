import { randomUUID } from 'node:crypto'

import type { ArtifactContentStorage } from '../../application/ports/artifact-content-storage.ts'
import type { ArtifactSourceMaterializer } from '../../application/ports/media-ingest.ts'
import type {
  MasterArtifactByteVerifier,
  MasterDurationProber,
  MasterDurations,
} from '../../application/synthetic-master-assets.ts'
import { assertDomain } from '../../domain/errors.ts'
import { probeAudioDurationSeconds, probeVideo } from './video-probe.ts'

/**
 * Verifies a master artifact against the bytes storage actually holds.
 *
 * The content storage port already fails closed on a size or checksum mismatch,
 * so opening the stream is the verification; the body is cancelled immediately
 * because the promotion only needs the verdict, never the bytes.
 */
export class ArtifactContentSyntheticMasterByteVerifier implements MasterArtifactByteVerifier {
  private readonly storage: ArtifactContentStorage

  constructor(storage: ArtifactContentStorage) {
    this.storage = storage
  }

  async verify(input: {
    artifactKey: string
    expectedSha256: string
    expectedByteSize: bigint
  }): Promise<void> {
    const opened = await this.storage.open({
      artifactKey: input.artifactKey,
      expectedByteSize: input.expectedByteSize,
      expectedSha256: input.expectedSha256,
    })
    await opened.body.cancel().catch(() => undefined)
  }
}

export interface StoredArtifactIdentityReader {
  readByKey(artifactKey: string): Promise<Readonly<{ sha256: string; byteSize: number }> | null>
}

function positiveMilliseconds(seconds: number, field: string): number {
  const milliseconds = Math.round(seconds * 1000)
  assertDomain(
    Number.isSafeInteger(milliseconds) && milliseconds > 0,
    'RENDER_OUTPUT_INVALID',
    `${field} is not a measurable duration`,
  )
  return milliseconds
}

/**
 * Measures the real audio and video durations of a candidate master with
 * ffprobe.
 *
 * Both files are materialized against their persisted content address first, so
 * the measurement always describes the exact bytes the master will seal. The
 * scratch copies are removed even when probing fails.
 */
export class FfprobeSyntheticMasterDurationProber implements MasterDurationProber {
  private readonly sources: ArtifactSourceMaterializer
  private readonly identities: StoredArtifactIdentityReader
  private readonly environment: NodeJS.ProcessEnv

  constructor(
    sources: ArtifactSourceMaterializer,
    identities: StoredArtifactIdentityReader,
    environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.sources = sources
    this.identities = identities
    this.environment = environment
  }

  private async materialize(operationId: string, artifactKey: string, role: string): Promise<string> {
    const identity = await this.identities.readByKey(artifactKey)
    assertDomain(
      Boolean(identity),
      'MEDIA_ARTIFACT_NOT_FOUND',
      `Master ${role} bytes are not catalogued in storage`,
    )
    const materialized = await this.sources.materialize({
      operationId,
      artifactKey,
      sha256: identity!.sha256,
      byteSize: identity!.byteSize,
    })
    return materialized.path
  }

  async measure(input: {
    audio: Readonly<{ artifactId: string; artifactKey: string }>
    video: Readonly<{ artifactId: string; artifactKey: string }>
  }): Promise<Readonly<MasterDurations>> {
    const operationId = `synthetic-master-probe-${randomUUID()}`
    try {
      const audioPath = await this.materialize(operationId, input.audio.artifactKey, 'final-audio')
      const videoPath = await this.materialize(operationId, input.video.artifactKey, 'normalized-video')
      const audioSeconds = await probeAudioDurationSeconds(audioPath, { environment: this.environment })
      const video = await probeVideo(videoPath, { environment: this.environment })
      return Object.freeze({
        audioDurationMs: positiveMilliseconds(audioSeconds, 'master audio duration'),
        videoDurationMs: positiveMilliseconds(video.duration, 'master video duration'),
      })
    } finally {
      await this.sources.cleanup(operationId).catch(() => undefined)
    }
  }
}

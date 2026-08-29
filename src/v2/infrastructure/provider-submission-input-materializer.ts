import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'

import { DomainError, assertDomain } from '../domain/errors.ts'
import type { ProviderJob } from '../domain/provider-job.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { ArtifactSourceMaterializer } from '../application/ports/media-ingest.ts'
import type { ProviderSubmissionInputMaterializer } from '../application/ports/provider-job-runtime.ts'
import type { SyntheticProductionRepository } from '../application/ports/synthetic-production-repository.ts'

const MAX_HEYGEN_ASSET_BYTES = 32 * 1024 * 1024
const AUDIO_CONTAINERS = new Set(['mp3', 'wav'])
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const ffmpeg = require('ffmpeg-static') as string | null

async function extractAudioRange(input: { path: string; startMs: number; endMs: number; signal?: AbortSignal }): Promise<Uint8Array> {
  assertDomain(Boolean(ffmpeg), 'PRECONDITION_REQUIRED', 'FFmpeg is unavailable for audio-first range materialization')
  const { stdout } = await execFileAsync(ffmpeg!, [
    '-v', 'error', '-ss', (input.startMs / 1_000).toFixed(3), '-i', input.path,
    '-t', ((input.endMs - input.startMs) / 1_000).toFixed(3), '-vn', '-c:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ], { encoding: 'buffer', maxBuffer: MAX_HEYGEN_ASSET_BYTES + 1024, windowsHide: true, signal: input.signal })
  return new Uint8Array(stdout)
}

function stringField(value: unknown, field: string): string {
  assertDomain(typeof value === 'string' && value.trim() === value && value.length >= 3, 'INVALID_ARGUMENT', `${field} is invalid`)
  return value
}

function durationField(value: unknown): number {
  const durationMs = Number(value)
  assertDomain(Number.isSafeInteger(durationMs) && durationMs >= 1_000 && durationMs <= 1_800_000, 'INVALID_ARGUMENT', 'providerInput.durationMs is invalid')
  return durationMs
}

function aspectRatioField(value: unknown): '9:16' | '16:9' {
  const aspectRatio = value ?? '9:16'
  assertDomain(aspectRatio === '9:16' || aspectRatio === '16:9', 'INVALID_ARGUMENT', 'providerInput.aspectRatio is invalid')
  return aspectRatio
}

export class AuthorizedProviderSubmissionInputMaterializer
implements ProviderSubmissionInputMaterializer {
  private readonly dependencies: {
    profiles: SyntheticProductionRepository
    artifacts: MediaArtifactQueryRepository
    sources: ArtifactSourceMaterializer
    clock?: () => Date
    extractAudioRange?: (input: { path: string; startMs: number; endMs: number; signal?: AbortSignal }) => Promise<Uint8Array>
  }

  constructor(dependencies: AuthorizedProviderSubmissionInputMaterializer['dependencies']) {
    this.dependencies = dependencies
  }

  async materialize(input: { job: Readonly<ProviderJob>; signal?: AbortSignal }): Promise<Readonly<Record<string, unknown>>> {
    const { job } = input
    assertDomain(job.operation === 'audio-avatar' || job.operation === 'tts', 'PRECONDITION_REQUIRED', 'Provider input materializer does not support this operation')
    const now = (this.dependencies.clock ?? (() => new Date()))()
    assertDomain(Number.isFinite(now.getTime()) && Date.parse(job.authorization.expiresAt) > now.getTime(), 'ASSET_RIGHTS_BLOCKED', 'Provider authorization expired before submission')
    if (job.operation === 'tts') return this.materializeTts(job, now)

    const profile = await this.dependencies.profiles.readProfile({
      workspaceId: job.workspaceId,
      snapshotId: job.authorization.profileSnapshotId,
    })
    if (!profile || profile.snapshot.snapshotHash !== job.authorization.profileSnapshotHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic presenter profile authorization drifted')
    }
    assertDomain(
      profile.snapshot.status === 'active' &&
      profile.snapshot.avatar.adapterId === job.adapterId &&
      profile.snapshot.avatar.adapterVersion === job.adapterVersion,
      'ASSET_RIGHTS_BLOCKED',
      'Synthetic presenter profile is not eligible for the configured adapter',
    )

    const audioArtifactId = stringField(job.input.audioArtifactId, 'providerInput.audioArtifactId')
    const decision = job.authorization.artifactDecisions.find((entry) => entry.artifactId === audioArtifactId)
    assertDomain(Boolean(decision) && Date.parse(decision!.validUntil) > now.getTime(), 'ASSET_RIGHTS_BLOCKED', 'Audio artifact is not authorized for provider submission')
    const artifact = await this.dependencies.artifacts.findById(job.workspaceId, audioArtifactId)
    if (!artifact || artifact.status !== 'available') throw new DomainError('ASSET_NOT_USABLE', 'Audio artifact is unavailable')
    assertDomain(artifact.mediaType === 'audio' && AUDIO_CONTAINERS.has(artifact.container.toLowerCase()), 'ASSET_NOT_USABLE', 'Provider audio must be an MP3 or WAV artifact')
    const byteSize = Number(artifact.byteSize)
    assertDomain(Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_HEYGEN_ASSET_BYTES, 'ASSET_NOT_USABLE', 'Provider audio exceeds the upload limit')
    const durationMs = durationField(job.input.durationMs)
    const range = job.input.audioRange
    assertDomain(typeof range === 'object' && range !== null && !Array.isArray(range), 'INVALID_ARGUMENT', 'providerInput.audioRange is invalid')
    const { startMs, endMs, rangeHash } = range as Record<string, unknown>
    assertDomain(Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs) && Number(startMs) >= 0 && Number(endMs) > Number(startMs) && Number(endMs) - Number(startMs) === durationMs, 'INVALID_ARGUMENT', 'providerInput.audioRange timing is invalid')
    assertDomain(typeof rangeHash === 'string' && /^[a-f0-9]{64}$/.test(rangeHash), 'INVALID_ARGUMENT', 'providerInput.audioRange hash is invalid')
    assertDomain(typeof job.input.audioMasterId === 'string' && typeof job.input.audioMasterHash === 'string' && /^[a-f0-9]{64}$/.test(job.input.audioMasterHash), 'INVALID_ARGUMENT', 'providerInput audio master lineage is invalid')
    const probe = artifact.manifests
      .filter((manifest) => manifest.probe)
      .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.probe
    assertDomain(Boolean(probe), 'ASSET_NOT_USABLE', 'Provider audio has no verified media probe')
    const measuredDurationMs = Math.round(probe!.duration * 1_000)
    assertDomain(Number(endMs) <= measuredDurationMs + 100, 'PERSISTENCE_CONFLICT', 'Provider audio range exceeds its immutable probe')

    const source = await this.dependencies.sources.materialize({
      operationId: job.id,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize,
    })
    try {
      const audioBytes = await (this.dependencies.extractAudioRange ?? extractAudioRange)({ path: source.path, startMs: Number(startMs), endMs: Number(endMs), signal: input.signal })
      assertDomain(audioBytes.byteLength > 0 && audioBytes.byteLength <= MAX_HEYGEN_ASSET_BYTES, 'ASSET_NOT_USABLE', 'Materialized audio range exceeds provider limits')
      return Object.freeze({
        avatarId: profile.snapshot.avatar.identityRef,
        audioBytes,
        audioSha256: createHash('sha256').update(audioBytes).digest('hex'),
        audioByteSize: audioBytes.byteLength,
        audioContainer: 'mp3',
        durationMs,
        aspectRatio: aspectRatioField(job.input.aspectRatio),
      })
    } finally {
      await this.dependencies.sources.cleanup(job.id)
    }
  }

  /**
   * Materializes the ElevenLabs TTS submission from the approved job input:
   * the exact approved text (sealed by scriptHash inside the job's inputHash),
   * the versioned voice identity from the authorized profile snapshot, and
   * the requested output container. No rewriting happens here — the adapter
   * re-verifies text against scriptHash before any paid call.
   */
  private async materializeTts(job: Readonly<ProviderJob>, now: Date): Promise<Readonly<Record<string, unknown>>> {
    const profile = await this.dependencies.profiles.readProfile({
      workspaceId: job.workspaceId,
      snapshotId: job.authorization.profileSnapshotId,
    })
    if (!profile || profile.snapshot.snapshotHash !== job.authorization.profileSnapshotHash) {
      throw new DomainError('PERSISTENCE_CONFLICT', 'Synthetic presenter profile authorization drifted')
    }
    assertDomain(
      profile.snapshot.status === 'active' &&
      profile.snapshot.voice.adapterId === job.adapterId &&
      profile.snapshot.voice.adapterVersion === job.adapterVersion,
      'ASSET_RIGHTS_BLOCKED',
      'Synthetic presenter voice is not eligible for the configured adapter',
    )
    assertDomain(Number.isFinite(now.getTime()), 'INVALID_ARGUMENT', 'clock returned an invalid date')
    const text = job.input.text
    assertDomain(typeof text === 'string' && text.trim().length > 0, 'INVALID_ARGUMENT', 'providerInput.text is invalid')
    const scriptHash = job.input.scriptHash
    assertDomain(typeof scriptHash === 'string' && /^[a-f0-9]{64}$/.test(scriptHash), 'INVALID_ARGUMENT', 'providerInput.scriptHash is invalid')
    assertDomain(createHash('sha256').update(text as string, 'utf8').digest('hex') === scriptHash, 'PERSISTENCE_CONFLICT', 'Approved TTS text does not match its script hash')
    const locale = job.input.locale
    assertDomain(typeof locale === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(locale), 'INVALID_ARGUMENT', 'providerInput.locale is invalid')
    const outputFormat = job.input.outputFormat ?? 'mp3'
    assertDomain(outputFormat === 'mp3' || outputFormat === 'wav', 'INVALID_ARGUMENT', 'providerInput.outputFormat is invalid')
    return Object.freeze({
      text,
      scriptHash,
      voiceId: profile.snapshot.voice.id,
      outputFormat,
      // ElevenLabs documents language_code as ISO 639-1; the job locale is
      // BCP-47, so only the primary language subtag travels upstream.
      languageCode: (locale as string).slice(0, 2),
      ...(Number.isSafeInteger(job.input.seed) ? { seed: Number(job.input.seed) } : {}),
    })
  }
}

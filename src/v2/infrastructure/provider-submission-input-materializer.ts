import { readFile } from 'node:fs/promises'

import { DomainError, assertDomain } from '../domain/errors.ts'
import type { ProviderJob } from '../domain/provider-job.ts'
import type { MediaArtifactQueryRepository } from '../application/ports/media-artifact-query-repository.ts'
import type { ArtifactSourceMaterializer } from '../application/ports/media-ingest.ts'
import type { ProviderSubmissionInputMaterializer } from '../application/ports/provider-job-runtime.ts'
import type { SyntheticProductionRepository } from '../application/ports/synthetic-production-repository.ts'

const MAX_HEYGEN_ASSET_BYTES = 32 * 1024 * 1024
const AUDIO_CONTAINERS = new Set(['mp3', 'wav'])

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
  }

  constructor(dependencies: AuthorizedProviderSubmissionInputMaterializer['dependencies']) {
    this.dependencies = dependencies
  }

  async materialize(input: { job: Readonly<ProviderJob>; signal?: AbortSignal }): Promise<Readonly<Record<string, unknown>>> {
    const { job } = input
    assertDomain(job.operation === 'audio-avatar', 'PRECONDITION_REQUIRED', 'Provider input materializer does not support this operation')
    const now = (this.dependencies.clock ?? (() => new Date()))()
    assertDomain(Number.isFinite(now.getTime()) && Date.parse(job.authorization.expiresAt) > now.getTime(), 'ASSET_RIGHTS_BLOCKED', 'Provider authorization expired before submission')

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
    const probe = artifact.manifests
      .filter((manifest) => manifest.probe)
      .toSorted((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0]?.probe
    assertDomain(Boolean(probe), 'ASSET_NOT_USABLE', 'Provider audio has no verified media probe')
    const measuredDurationMs = Math.round(probe!.duration * 1_000)
    assertDomain(Math.abs(measuredDurationMs - durationMs) <= 1_000, 'PERSISTENCE_CONFLICT', 'Provider audio duration does not match its immutable probe')

    const source = await this.dependencies.sources.materialize({
      operationId: job.id,
      artifactKey: artifact.artifactKey,
      sha256: artifact.sha256,
      byteSize,
    })
    try {
      const audioBytes = new Uint8Array(await readFile(source.path, { signal: input.signal }))
      return Object.freeze({
        avatarId: profile.snapshot.avatar.identityRef,
        audioBytes,
        audioSha256: source.sha256,
        audioByteSize: source.byteSize,
        audioContainer: artifact.container.toLowerCase(),
        durationMs: measuredDurationMs,
        aspectRatio: aspectRatioField(job.input.aspectRatio),
      })
    } finally {
      await this.dependencies.sources.cleanup(job.id)
    }
  }
}

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { MarkerArtifactRef } from '../../application/ports/sync-diagnostic-repository.ts'
import type { VerifiedMediaStorage } from '../../application/ports/media-ingest.ts'
import type { MarkerMediaPort } from '../../application/sync-diagnostic.ts'
import { DomainError } from '../../domain/errors.ts'
import {
  fuseMarkerDetections,
  type FusionMode,
  type MarkerDetection,
} from '../../domain/sync-marker-detection.ts'
import type { SyncMarker } from '../../domain/sync-marker.ts'
import { detectAudioMarker, detectVisualMarker } from './ffmpeg-marker-detectors.ts'
import { FfmpegSyncMarkerRenderer } from './ffmpeg-sync-marker-renderer.ts'

/**
 * The media side of sync markers (F4.010).
 *
 * Two things happen here and they are deliberately kept apart.
 *
 * **Rendering** produces an MP4 and promotes it to artifact storage. The bytes
 * never touch the database: a marker is a few seconds of video, and a row that
 * carried it would be paid for on every read of the marker list.
 *
 * **Detection** runs the visual and audio detectors and hands both results to
 * the fusion, which is the only code that sees the two together. That
 * separation is the whole point of having two channels: a detector that could
 * read the other's verdict would agree with it, and two agreeing detectors
 * that share a cause are one detector wearing a disguise.
 *
 * Both scratch directories are removed in `finally`. FFmpeg leaves whole
 * decoded frame dumps behind, and a detection loop over a long session would
 * otherwise fill the disk with evidence nobody will read again.
 */
export interface MarkerMediaAdapterOptions {
  readonly workRoot: string
  readonly storage: VerifiedMediaStorage
  readonly ffmpegPath?: string
  readonly ffprobePath?: string
}

export class MarkerMediaAdapter implements MarkerMediaPort {
  private readonly renderer: FfmpegSyncMarkerRenderer
  private readonly options: MarkerMediaAdapterOptions

  constructor(options: MarkerMediaAdapterOptions) {
    this.options = options
    this.renderer = new FfmpegSyncMarkerRenderer({
      workRoot: options.workRoot,
      ffmpegPath: options.ffmpegPath,
      ffprobePath: options.ffprobePath,
    })
  }

  async render(marker: Readonly<SyncMarker>): Promise<Readonly<MarkerArtifactRef>> {
    const rendered = await this.renderer.render(marker)
    try {
      const promoted = await this.options.storage.promoteDerived({
        workspaceId: marker.workspaceId,
        sourcePath: rendered.filePath,
        sha256: rendered.sha256,
        extension: 'mp4',
        prefix: 'sync-markers',
      })
      return Object.freeze({
        artifactId: promoted.key,
        sha256: promoted.sha256,
        byteSize: promoted.byteSize,
      })
    } finally {
      // The renderer's scratch holds the raw frames and PCM as well as the
      // muxed file; once the file is in storage none of it is evidence.
      await rm(join(rendered.filePath, '..'), { recursive: true, force: true }).catch(() => {})
    }
  }

  async detect(input: {
    marker: Readonly<SyncMarker>
    trackId: string
    mediaPath: string
    mode: FusionMode
  }): Promise<Readonly<MarkerDetection>> {
    const runId = randomUUID()
    const scratch = join(this.options.workRoot, `detect-${runId}`)
    const detectorOptions = {
      workRoot: scratch,
      ffmpegPath: this.options.ffmpegPath,
      ffprobePath: this.options.ffprobePath,
    }
    try {
      // Started together, judged apart. Neither call can observe the other's
      // outcome, so a chirp cannot talk a flash into existence.
      const [visual, audio] = await Promise.all([
        detectVisualMarker({
          marker: input.marker,
          mediaPath: input.mediaPath,
          trackId: input.trackId,
          observationId: `${runId}-visual`,
          options: detectorOptions,
        }),
        detectAudioMarker({
          marker: input.marker,
          mediaPath: input.mediaPath,
          trackId: input.trackId,
          observationId: `${runId}-audio`,
          options: detectorOptions,
        }),
      ])
      return fuseMarkerDetections({
        marker: input.marker,
        trackId: input.trackId,
        mode: input.mode,
        // The detectors say "nothing found" with null; the fusion says the
        // same with an absent field. Same fact, two spellings.
        visual: visual ?? undefined,
        audio: audio ?? undefined,
      })
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export function createMarkerMediaAdapter(
  storage: VerifiedMediaStorage,
  environment: NodeJS.ProcessEnv = process.env,
): MarkerMediaAdapter {
  const workRoot = environment.APOLLO_V2_RENDER_WORK_ROOT?.trim()
  if (!workRoot) {
    throw new DomainError(
      'PERSISTENCE_NOT_CONFIGURED',
      'Marker media work root is not configured',
    )
  }
  return new MarkerMediaAdapter({
    workRoot,
    storage,
    ffmpegPath: environment.APOLLO_FFMPEG_PATH?.trim() || undefined,
    ffprobePath: environment.APOLLO_FFPROBE_PATH?.trim() || undefined,
  })
}

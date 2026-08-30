export const AUDIO_CONCATENATION_SCHEMA_VERSION = 'synthetic-block-concatenation/v1' as const

export interface AudioConcatenationBlockInput {
  blockId: string
  generationId: string
  path: string
  sha256: string
}

/**
 * One row per block in the persisted concatenation manifest: where the
 * block's audio really sits in the consolidated timeline, how much measured
 * silence follows it, and whether its packets were copied or reencoded.
 */
export interface AudioConcatenationManifestEntry {
  blockId: string
  generationId: string
  artifactSha256: string
  sourceDurationMs: number
  outputInMs: number
  outputOutMs: number
  gapAfterMs: number
  processing: 'copy' | 'reencode'
  alignmentOffsetMs: number
}

export interface AudioConcatenationResult {
  outputPath: string
  container: 'mp3' | 'wav'
  codec: string
  sampleRate: number
  channels: number
  durationMs: number
  finalAudioSha256: string
  entries: readonly Readonly<AudioConcatenationManifestEntry>[]
  concatHash: string
}

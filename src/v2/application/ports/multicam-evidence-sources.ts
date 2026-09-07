import type { CaptureTrackPart } from '../../domain/capture-session.ts'

/**
 * What the direction reads to build a `MulticamEvidenceSet` (F4.012, spec 05 §20).
 *
 * Five narrow ports rather than the repositories they are served by. The
 * evidence producer needs "the diarization segments for these artifacts" and
 * "the visual statistics of these windows", not the ability to persist a
 * diarization run or to reach the artifact registry; a wide dependency would
 * let a later edit of the producer write through a port it was only supposed to
 * read, and would make the unit suite stand up two aggregates it never asserts
 * on.
 *
 * Every one of them returns MEASUREMENTS, never observations. Turning a
 * measurement into a `MulticamObservation` — deciding the kind, mapping the
 * milliseconds onto the session clock, refusing a magnitude of zero — is the
 * producer's work, in one place, so no adapter can invent an observation the
 * domain would have refused.
 */

/** One diarization run as the direction reads it: segments and where they came from. */
export interface MulticamDiarizationRun {
  readonly runId: string
  readonly sourceArtifactId: string
  readonly provider: string
  readonly producedAt: string
  /**
   * Milliseconds relative to the START OF THE FILE the run analysed, which is
   * the artifact, not the session. The producer maps them through the track's
   * part coverage and its clock map; nothing here knows about session time.
   */
  readonly segments: readonly Readonly<{
    readonly segmentId: string
    readonly ordinal: number
    readonly speakerKey: string
    readonly startMs: number
    readonly endMs: number
  }>[]
}

export interface MulticamDiarizationSource {
  /**
   * The newest run per source artifact, for the artifacts given.
   *
   * Newest per artifact and not "all runs": two runs of the same file are two
   * opinions about the same speech, and directing on both would count one
   * person's turn twice.
   */
  listLatestRunsForArtifacts(input: {
    workspaceId: string
    projectId: string
    sourceArtifactIds: readonly string[]
  }): Promise<readonly Readonly<MulticamDiarizationRun>[]>
}

/** One stretch of one file to measure, already materialized on disk by the caller. */
export interface MulticamVisualWindow {
  readonly trackId: string
  readonly partId: string
  readonly sourceArtifactId: string
  /** Absolute path handed out by the media resolver; released by the caller in `finally`. */
  readonly path: string
  /** Milliseconds relative to the start of the file. */
  readonly sourceStartMs: number
  readonly sourceEndMs: number
}

/**
 * What one visual pass measured, with `null` wherever it measured nothing.
 *
 * A dimension this pass does not measure is `null` and stays `null` — never a
 * zero, which would claim the dimension was read and came out at nothing. The
 * producer drops a `null` dimension instead of emitting an observation that
 * asserts it.
 */
export interface MulticamVisualMeasurement {
  readonly trackId: string
  readonly partId: string
  readonly sourceArtifactId: string
  readonly sourceStartMs: number
  readonly sourceEndMs: number
  readonly sampledFrameCount: number
  /** Frame-to-frame luma change, in basis points of full scale. */
  readonly activityBps: number | null
  readonly sharpnessBps: number | null
  readonly stabilityBps: number | null
  readonly exposureBps: number | null
  /** How it was measured, e.g. `ffmpeg/signalstats+scdet`. */
  readonly method: string
  /** Where to look it up again: the artifact and the exact window inside it. */
  readonly evidenceRef: string
}

export interface MulticamVisualEvidenceProvider {
  measure(input: {
    windows: readonly Readonly<MulticamVisualWindow>[]
    signal?: AbortSignal
  }): Promise<readonly Readonly<MulticamVisualMeasurement>[]>
}

/** One stretch of one file to LISTEN to, already materialized on disk by the caller. */
export interface MulticamAudioWindow {
  readonly trackId: string
  readonly partId: string
  readonly sourceArtifactId: string
  /** Absolute path handed out by the media resolver; released by the caller in `finally`. */
  readonly path: string
  /** Milliseconds relative to the start of the file. */
  readonly sourceStartMs: number
  readonly sourceEndMs: number
}

/**
 * One stretch inside a window during which the level never rose above
 * `ceilingDbfs`.
 *
 * `ceilingDbfs` is an upper BOUND that was measured, not an average that was
 * computed: the loudest analysis block inside the stretch when at least one
 * block had a finite level, and otherwise the detection threshold the whole
 * stretch stayed under. Both readings are true statements about the samples,
 * and neither invents a level for digital silence, for which dBFS has no
 * finite value. It is never positive.
 */
export interface MulticamSilentStretch {
  /** Milliseconds relative to the start of the FILE, like the window itself. */
  readonly startMs: number
  readonly endMs: number
  readonly ceilingDbfs: number
}

/**
 * What one listening pass found, with absence kept as absence.
 *
 * `measuredBlockCount === 0` says the decode produced no audio at all — a file
 * with no audio stream, or a window past its end. It does NOT say the window
 * was silent: the producer drops it and reports it, because a window nobody
 * could listen to and a window that was quiet are opposite facts
 * (`ffmpeg-audio-sync-signal-source.ts:743-750` draws the same line).
 */
export interface MulticamSilenceMeasurement {
  readonly trackId: string
  readonly partId: string
  readonly sourceArtifactId: string
  readonly sourceStartMs: number
  readonly sourceEndMs: number
  /** How many level blocks the decode produced. Zero means nothing was heard, not that nothing sounded. */
  readonly measuredBlockCount: number
  /** How long one level block is. Part of the reading: a 100 ms block cannot resolve a 40 ms gap. */
  readonly blockMs: number
  /** The level a stretch had to stay under, and the minimum time it had to stay there. */
  readonly thresholdDbfs: number
  readonly minimumSilenceMs: number
  readonly stretches: readonly Readonly<MulticamSilentStretch>[]
  /** How it was measured, e.g. `ffmpeg/silencedetect+astats`. */
  readonly method: string
  /** Where to look it up again: the artifact and the exact window inside it. */
  readonly evidenceRef: string
}

/**
 * Where `silence` evidence comes from.
 *
 * Separate from the visual provider rather than folded into it because the two
 * answer about different tracks: a microphone is never an angle and a screen
 * share rarely carries speech, so one port would force every caller to
 * materialize both kinds of media for whichever half it wanted.
 */
export interface MulticamSilenceEvidenceProvider {
  measure(input: {
    windows: readonly Readonly<MulticamAudioWindow>[]
    signal?: AbortSignal
  }): Promise<readonly Readonly<MulticamSilenceMeasurement>[]>
}

/**
 * Already-persisted perception, when the project has any.
 *
 * Optional on purpose: a session nobody has run perception over produces no
 * reaction observations at all, which is the honest answer and the one the
 * direction is built to handle (it holds the current angle). A stub returning
 * intensity zero would instead assert "measured, and there was no reaction".
 */
export interface MulticamPerceptionSource {
  listReactionIntensities(input: {
    workspaceId: string
    projectId: string
    sourceArtifactIds: readonly string[]
  }): Promise<readonly Readonly<{
    readonly sourceArtifactId: string
    readonly timelineId: string
    readonly producedAt: string
    readonly method: string
    readonly entries: readonly Readonly<{
      readonly entryId: string
      readonly startMs: number
      readonly endMs: number
      /** In (0, 10000]. An entry that measured nothing is not returned. */
      readonly intensityBps: number
      readonly confidence: number
    }>[]
  }>[]>
}

/**
 * A capture part's bytes as a path, and the way to give them back.
 *
 * The shape `CaptureMediaResolver.resolve` already returns
 * (`infrastructure/media/capture-media-resolver.ts:60`), named as a port so the
 * producer can be exercised without an artifact registry. `release` is not
 * optional politeness: the S3 driver downloads the whole recording per call.
 */
export interface CaptureTrackMediaResolver {
  resolve(input: {
    workspaceId: string
    part: Readonly<CaptureTrackPart>
  }): Promise<Readonly<{ path: string; release: () => Promise<void> }>>
}

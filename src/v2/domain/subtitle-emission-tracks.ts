/**
 * The subtitle tracks a renderer may burn in.
 *
 * An editorial-cut plan can also carry an aligned source-transcript track
 * (`emission: 'suppressed-missing-visual-clock-authority'`): it records word
 * timing facts only and has no persisted preset, so it contributes no cue to
 * any render. Directed captions tracks always carry their preset and cues.
 * Before the editorial cut plan gained those tracks, its `subtitleTracks` was
 * empty, so excluding them here keeps what every renderer emits unchanged.
 */
export function emittedSubtitleTracks<A extends readonly object[]>(
  tracks: A,
): readonly Extract<A[number], { presetId: unknown; cues: readonly unknown[] }>[] {
  return (tracks as readonly object[]).filter(
    (track) => 'presetId' in track && 'cues' in track,
  ) as unknown as readonly Extract<A[number], { presetId: unknown; cues: readonly unknown[] }>[]
}

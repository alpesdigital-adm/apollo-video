/**
 * The six things the reference can be doing during a stretch of the reaction
 * (spec 05 §16).
 *
 * A leaf on purpose, for the same reason as `multicam-output-format.ts`:
 * `playback-map.ts` reaches `canonical-hash.ts` and therefore `node:crypto`, so
 * a browser page cannot import it — and the anchor editor, where a person says
 * what the player was doing in a stretch nobody could measure, has to offer
 * exactly the vocabulary the boundary accepts. A hand-typed copy in the page is
 * a second authority, and a mode added here would silently become unrecordable
 * from the only surface that can record one.
 *
 * ADR-135 names four in prose; the sixth vocabulary is the one the spec's type
 * carries, and `replay` and `commentary-only` are exactly the two cases a
 * four-value vocabulary has to lie about.
 */

export const PLAYBACK_MODES = Object.freeze([
  'playing',
  'paused',
  'rewind',
  'replay',
  'seek',
  'commentary-only',
] as const)
export type PlaybackMode = (typeof PLAYBACK_MODES)[number]

/** Modes during which the reference produces no time at all. */
export const NO_REFERENCE_PLAYBACK_MODES: ReadonlySet<PlaybackMode> = new Set<PlaybackMode>([
  'paused',
  'commentary-only',
])

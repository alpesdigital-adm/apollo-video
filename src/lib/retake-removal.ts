/**
 * Retake / false-start removal.
 *
 * Bug this fixes: the narrator sometimes restarts a sentence mid-word (a
 * "false start" — "e aí você... e aí você percebe"). The existing autocut
 * only removes the silent PAUSE between the aborted attempt and the retry;
 * both spoken attempts survive and get spliced together, so the rendered
 * video visibly repeats one or two words across the cut.
 *
 * Fix: for every silence that autocut is about to turn into a cut, look at
 * the words immediately before and immediately after it. If the tail of
 * "before" repeats as the head of "after" (the narrator re-said the same
 * words after the pause), extend the silence backwards to swallow the
 * aborted first attempt too, so only the clean retake survives the cut.
 */

import type { Silence, Transcription, TranscriptionWord } from './types/project'
import { FPS } from './types/timing'
import { AUTOCUT_MARGIN } from './services/ffmpeg'

// How many trailing/leading words we compare across a silence boundary.
const MAX_LOOKAROUND_WORDS = 5
// A single-word repeat only counts as a retake if the word is long enough —
// short function words ("e", "a", "de") repeat naturally and would false-positive.
const MIN_SINGLE_WORD_CHARS = 3
// Hard cap on how far back we're willing to extend a silence to swallow a retake.
const MAX_EXTENSION_SECONDS = 3.5
// Extra buffer (seconds) kept between the extended cut boundary and the first
// repeated word, so the retake's own onset is never clipped.
const RETAKE_FOLGA_SECONDS = 0.06

export interface RetakeRemoval {
  at: number
  phrase: string
}

export interface ExpandCutsForRetakesResult {
  silences: Silence[]
  removed: RetakeRemoval[]
}

/** Lowercase, strip accents, and drop punctuation so word comparisons are robust. */
function normalizeWord(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/** Flatten all transcription words into a single chronologically-ordered list. */
function flattenWords(transcription: Transcription): TranscriptionWord[] {
  const words: TranscriptionWord[] = []
  for (const segment of transcription.segments) {
    for (const word of segment.words) {
      words.push(word)
    }
  }
  words.sort((a, b) => a.start - b.start)
  return words
}

/**
 * Find the longest N (1..MAX_LOOKAROUND_WORDS) such that the last N words of
 * `before` equal (normalized) the first N words of `after`. Returns 0 if no
 * qualifying repetition exists.
 */
function findRepeatLength(before: TranscriptionWord[], after: TranscriptionWord[]): number {
  const maxN = Math.min(MAX_LOOKAROUND_WORDS, before.length, after.length)

  for (let n = maxN; n >= 1; n--) {
    const beforeSuffix = before.slice(before.length - n)
    const afterPrefix = after.slice(0, n)

    let allMatch = true
    for (let k = 0; k < n; k++) {
      const a = normalizeWord(beforeSuffix[k].word)
      const b = normalizeWord(afterPrefix[k].word)
      if (!a || a !== b) {
        allMatch = false
        break
      }
    }

    if (!allMatch) continue

    if (n === 1) {
      const only = normalizeWord(beforeSuffix[0].word)
      if (only.length < MIN_SINGLE_WORD_CHARS) continue
    }

    return n
  }

  return 0
}

/**
 * For each silence, check whether it sits between a false start and its
 * retake (repeated words immediately before/after the pause). When it does,
 * extend the silence backwards to swallow the aborted first attempt.
 *
 * Integration note: this runs on the RAW silences from detectSilences(),
 * before cutSilencesFromVideo() -> selectAutoCutSilences() shrinks each
 * silence by a margin on both edges (to avoid clipping adjacent speech) and
 * filters by minimum duration. Extending duration only ever helps a silence
 * pass the min-duration filter, but the margin shrink moves the effective
 * cut *start* later by AUTOCUT_MARGIN — enough to swallow back most of a
 * small extension. We compensate by extending past the target boundary by
 * AUTOCUT_MARGIN so the boundary that survives the downstream shrink still
 * lands RETAKE_FOLGA_SECONDS before the first repeated word.
 */
export function expandCutsForRetakes(
  silences: Silence[],
  transcription: Transcription
): ExpandCutsForRetakesResult {
  const words = flattenWords(transcription)
  const sortedSilences = [...silences].sort((a, b) => a.startTime - b.startTime)
  const removed: RetakeRemoval[] = []

  const result: Silence[] = sortedSilences.map((silence, index) => {
    const before = words.filter((w) => w.end <= silence.startTime).slice(-MAX_LOOKAROUND_WORDS)
    const after = words.filter((w) => w.start >= silence.endTime).slice(0, MAX_LOOKAROUND_WORDS)

    const n = findRepeatLength(before, after)
    if (n === 0) return silence

    const firstRepeatedWord = before[before.length - n]
    const repeatedPhrase = before
      .slice(before.length - n)
      .map((w) => w.word.trim())
      .join(' ')

    const previousSilenceEnd = index > 0 ? sortedSilences[index - 1].endTime : 0
    const minAllowedStart = Math.max(
      0,
      previousSilenceEnd,
      silence.startTime - MAX_EXTENSION_SECONDS
    )

    // Target: the surviving cut boundary (after selectAutoCutSilences adds
    // AUTOCUT_MARGIN back) should land RETAKE_FOLGA_SECONDS before the first
    // repeated word — so extend past it by that same margin now.
    const targetStart = firstRepeatedWord.start - AUTOCUT_MARGIN - RETAKE_FOLGA_SECONDS
    const newStart = Math.min(silence.startTime, Math.max(targetStart, minAllowedStart))

    if (newStart >= silence.startTime) return silence

    removed.push({ at: silence.startTime, phrase: repeatedPhrase })
    console.log(
      `[retake-removal] swallowing false start "${repeatedPhrase}" — extended silence back from ${silence.startTime.toFixed(3)}s to ${newStart.toFixed(3)}s`
    )

    return {
      startTime: newStart,
      endTime: silence.endTime,
      startFrame: Math.round(newStart * FPS),
      endFrame: silence.endFrame,
      duration: silence.endTime - newStart
    }
  })

  return { silences: result, removed }
}

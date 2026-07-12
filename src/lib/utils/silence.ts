/**
 * Silence detection and subtitle generation utilities
 */

import type { Silence, Transcription, SubtitleEntry, TranscriptionWord } from '../types/project.ts'
import { FPS } from '../types/timing.ts'

/**
 * Parse FFmpeg silencedetect output and return Silence objects
 * Expects output with lines like:
 *   "[silencedetect @ 0x...] silence_start: 2.5"
 *   "[silencedetect @ 0x...] silence_end: 4.0 | silence_duration: 1.5"
 * @param ffmpegOutput The stderr output from ffmpeg silencedetect filter
 * @param fps Frames per second for the video
 * @returns Array of Silence objects
 */
export function parseSilenceDetection(ffmpegOutput: string, fps: number = FPS): Silence[] {
  const silences: Silence[] = []
  const lines = ffmpegOutput.split('\n')

  let currentSilence: { startTime?: number; endTime?: number; duration?: number } = {}

  for (const line of lines) {
    if (line.includes('silence_start:')) {
      const match = line.match(/silence_start:\s*([\d.]+)/)
      if (match) {
        currentSilence.startTime = parseFloat(match[1])
      }
    } else if (line.includes('silence_end:')) {
      const endMatch = line.match(/silence_end:\s*([\d.]+)/)
      const durationMatch = line.match(/silence_duration:\s*([\d.]+)/)

      if (endMatch && durationMatch) {
        currentSilence.endTime = parseFloat(endMatch[1])
        currentSilence.duration = parseFloat(durationMatch[1])

        // Create silence object if we have all required data
        if (
          currentSilence.startTime !== undefined &&
          currentSilence.endTime !== undefined &&
          currentSilence.duration !== undefined
        ) {
          const startFrame = Math.round(currentSilence.startTime * fps)
          const endFrame = Math.round(currentSilence.endTime * fps)

          silences.push({
            startTime: currentSilence.startTime,
            endTime: currentSilence.endTime,
            startFrame,
            endFrame,
            duration: currentSilence.duration
          })

          currentSilence = {}
        }
      }
    }
  }

  return silences
}

/**
 * Reconcile a subtitle's `words` array against the tokens of its `text` so that
 * EVERY token of the text is present, in order. Whisper's word-level timestamps
 * (or downstream re-segmentation) can drop boundary words — we observed a
 * subtitle "…ninguém dá muita atenção" whose words ended at "muita", and one
 * whose text started "e de repente" whose words started at "de". The renderer
 * highlights per word, so a dropped token is a word that never lights up.
 *
 * Strategy: tokenize `text`, align each token to the next matching timed word
 * (normalized compare, forward-only), keep that word's timing when matched, and
 * interpolate timing for any token with no timed match from its neighbors
 * (falling back to the segment [start,end] bounds at the edges). No token of
 * `text` is ever left out of the returned array.
 */
function reconcileWordsWithText(
  text: string,
  timedWords: TranscriptionWord[],
  boundStart: number,
  boundEnd: number
): TranscriptionWord[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return []

  const normalize = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

  // Forward-only alignment: for each text token, find the next timed word (from
  // the last matched position) whose normalized form matches.
  const matchIdx: (number | null)[] = new Array(tokens.length).fill(null)
  let cursor = 0
  for (let i = 0; i < tokens.length; i++) {
    const nt = normalize(tokens[i])
    if (!nt) continue
    for (let k = cursor; k < timedWords.length; k++) {
      if (normalize(timedWords[k].word) === nt) {
        matchIdx[i] = k
        cursor = k + 1
        break
      }
    }
  }

  const starts: number[] = new Array(tokens.length)
  const ends: number[] = new Array(tokens.length)
  const strings: string[] = new Array(tokens.length)

  for (let i = 0; i < tokens.length; i++) {
    const k = matchIdx[i]
    if (k !== null) {
      starts[i] = timedWords[k].start
      ends[i] = timedWords[k].end
      strings[i] = timedWords[k].word
    } else {
      strings[i] = tokens[i]
    }
  }

  // Interpolate timing for unmatched tokens from the nearest matched neighbors,
  // clamped to the segment bounds so nothing lands outside the visible window.
  for (let i = 0; i < tokens.length; i++) {
    if (matchIdx[i] !== null) continue

    let prev = i - 1
    while (prev >= 0 && matchIdx[prev] === null) prev--
    let next = i + 1
    while (next < tokens.length && matchIdx[next] === null) next++

    const anchorStart = prev >= 0 ? ends[prev] : boundStart
    const anchorEnd = next < tokens.length ? starts[next] : boundEnd
    const gapCount = next - prev // tokens spanning the gap (inclusive of endpoints)
    const span = Math.max(0, anchorEnd - anchorStart)
    const step = gapCount > 0 ? span / gapCount : 0
    const offset = i - prev
    starts[i] = anchorStart + step * (offset - 1)
    ends[i] = anchorStart + step * offset
  }

  return tokens.map((_, i) => ({
    word: strings[i],
    start: starts[i],
    end: ends[i]
  }))
}

/**
 * Generate subtitle entries from a Whisper transcription
 * Creates SubtitleEntry objects with timing adjusted for silence cuts
 * @param transcription The Whisper transcription with segments and word-level timing
 * @param silences Array of silence objects that will be removed
 * @param fps Frames per second (default 30)
 * @returns Array of SubtitleEntry objects
 */
export function generateSubtitlesFromTranscription(
  transcription: Transcription,
  silences: Silence[] = [],
  fps: number = FPS
): SubtitleEntry[] {
  const subtitles: SubtitleEntry[] = []

  // Small buffer (seconds) added after the true end of the last spoken word so
  // rounding/interpolation never clips the final word's visibility/highlight.
  const END_SAFETY_PADDING = 0.05
  // "Hang time": keep the subtitle visible a bit longer after speech ends so it
  // doesn't vanish abruptly during a breath/pause. Capped by the next subtitle's
  // (adjusted) start time so consecutive subtitles never overlap.
  const HANG_TIME_SECONDS = 0.6

  // Sort silences by start time for easier processing
  const sortedSilences = [...silences].sort((a, b) => a.startTime - b.startTime)

  /**
   * Helper function to adjust time based on silence cuts
   * Removes the duration of all silences that occur before the given time
   */
  function adjustTimeForSilences(time: number): number {
    let adjustedTime = time
    for (const silence of sortedSilences) {
      if (silence.endTime <= time) {
        // Entire silence is before this time, subtract its duration
        adjustedTime -= silence.duration
      } else if (silence.startTime < time && silence.endTime > time) {
        // Silence partially overlaps this time, subtract partial duration
        adjustedTime -= time - silence.startTime
        break
      }
    }
    return Math.max(0, adjustedTime)
  }

  // Create a subtitle entry for each segment
  for (let i = 0; i < transcription.segments.length; i++) {
    const segment = transcription.segments[i]

    // Adjust times for silence cuts
    const adjustedStartTime = adjustTimeForSilences(segment.start)

    // Whisper's segment.end does not always reach the end of the last word —
    // word-level timestamps can run slightly past it. If we anchor the
    // subtitle's visible window on segment.end alone, the final word can be
    // cut off before it ever renders/highlights. Anchor on whichever is later.
    const lastWord = segment.words.length > 0 ? segment.words[segment.words.length - 1] : null
    const rawEndTime = lastWord ? Math.max(segment.end, lastWord.end) : segment.end

    // Adjust the combined end as a single value (rather than adjusting
    // segment.end and each word's end independently) so the subtitle's end and
    // the last word's end always move together across a silence-cut boundary —
    // otherwise they can diverge by up to a whole removed silence's duration.
    const speechEndTime = adjustTimeForSilences(rawEndTime) + END_SAFETY_PADDING

    // Hang time: extend the visible window after speech ends, capped by the
    // next subtitle's (adjusted) start so consecutive subtitles never overlap.
    const nextSegment = transcription.segments[i + 1]
    const nextStartTime = nextSegment ? adjustTimeForSilences(nextSegment.start) : null
    const adjustedEndTime = nextStartTime !== null
      ? Math.min(speechEndTime + HANG_TIME_SECONDS, Math.max(speechEndTime, nextStartTime))
      : speechEndTime + HANG_TIME_SECONDS

    // Convert to frames
    const startFrame = Math.round(adjustedStartTime * fps)
    const endFrame = Math.round(adjustedEndTime * fps)

    // Process words to adjust their timing as well
    const adjustedWords: TranscriptionWord[] = segment.words.map(word => ({
      word: word.word,
      start: adjustTimeForSilences(word.start),
      end: adjustTimeForSilences(word.end)
    }))

    // Reconcile so EVERY token of segment.text is represented in words (in order).
    // Boundary tokens that Whisper omitted from word-level timing get interpolated
    // timing from their neighbors instead of silently vanishing from the highlight.
    const reconciledWords = reconcileWordsWithText(
      segment.text,
      adjustedWords,
      adjustedStartTime,
      speechEndTime
    )

    subtitles.push({
      id: i,
      text: segment.text,
      startTime: adjustedStartTime,
      endTime: adjustedEndTime,
      startFrame,
      endFrame,
      words: reconciledWords
    })
  }

  return subtitles
}

/**
 * Silence detection and subtitle generation utilities
 */

import type { Silence, Transcription, SubtitleEntry, TranscriptionWord } from '../types/project'
import { FPS } from '../types/timing'

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
    const adjustedEndTime = adjustTimeForSilences(segment.end)

    // Convert to frames
    const startFrame = Math.round(adjustedStartTime * fps)
    const endFrame = Math.round(adjustedEndTime * fps)

    // Process words to adjust their timing as well
    const adjustedWords: TranscriptionWord[] = segment.words.map(word => ({
      word: word.word,
      start: adjustTimeForSilences(word.start),
      end: adjustTimeForSilences(word.end)
    }))

    subtitles.push({
      id: i,
      text: segment.text,
      startTime: adjustedStartTime,
      endTime: adjustedEndTime,
      startFrame,
      endFrame,
      words: adjustedWords
    })
  }

  return subtitles
}

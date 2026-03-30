/**
 * OpenAI Whisper service for audio transcription
 */

import OpenAI from 'openai'
import * as fs from 'fs'
import type { Transcription, TranscriptionSegment, TranscriptionWord } from '../types/project'

// Initialize OpenAI client - uses OPENAI_API_KEY env variable
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

/**
 * Transcribe audio using OpenAI Whisper API
 * Returns detailed timing information at both segment and word level
 * @param audioPath Path to audio file (WAV, MP3, etc.)
 * @returns Transcription object with segments, words, and timing information
 */
export async function transcribeAudio(audioPath: string): Promise<Transcription> {
  try {
    // Verify file exists
    if (!fs.existsSync(audioPath)) {
      throw new Error(`Audio file not found: ${audioPath}`)
    }

    // Read audio file
    const audioBuffer = fs.readFileSync(audioPath)

    // Create file blob for OpenAI API
    const audioFile = new File([audioBuffer], 'audio.wav', { type: 'audio/wav' })

    // Call Whisper API with verbose_json response format for detailed timing
    const response = await openai.audio.transcriptions.create({
      file: audioFile,
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment']
    })

    // Type the response to handle the verbose_json format
    const verboseResponse = response as any

    // Parse segments and ensure they have word-level timing
    const segments: TranscriptionSegment[] = (verboseResponse.segments || []).map(
      (segment: any, index: number) => {
        // Extract words from the segment or create them from the text
        const words: TranscriptionWord[] = (segment.words || []).map((word: any) => ({
          word: word.word.trim(),
          start: word.start,
          end: word.end
        }))

        return {
          id: index,
          start: segment.start,
          end: segment.end,
          text: segment.text,
          words
        }
      }
    )

    return {
      text: verboseResponse.text || '',
      language: verboseResponse.language || 'unknown',
      segments
    }
  } catch (error) {
    throw new Error(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

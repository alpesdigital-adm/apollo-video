/**
 * Core project type definitions for the video editor
 */

export interface TranscriptionWord {
  word: string
  start: number
  end: number
}

export interface TranscriptionSegment {
  id: number
  start: number
  end: number
  text: string
  words: TranscriptionWord[]
}

export interface Transcription {
  text: string
  language: string
  segments: TranscriptionSegment[]
}

export interface Silence {
  startTime: number
  endTime: number
  startFrame: number
  endFrame: number
  duration: number
}

export interface SubtitleEntry {
  id: number
  text: string
  startTime: number
  endTime: number
  startFrame: number
  endFrame: number
  words: TranscriptionWord[]
}

export type VideoFormat = '9:16' | '16:9'

export type ProjectStatus =
  | 'created'
  | 'uploading'
  | 'normalizing'
  | 'transcribing'
  | 'analyzing'
  | 'ready'
  | 'rendering'
  | 'complete'
  | 'error'

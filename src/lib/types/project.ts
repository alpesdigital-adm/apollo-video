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
  // Camada 2 da coordenação de legenda: âncora vertical calculada POR BATIDA a
  // partir do conteúdo real do frame (vision sobre o thumbnail). 'top' quando o
  // rosto/ação dominante está no terço de BAIXO (a legenda desvia para o topo);
  // 'bottom' (ou ausente) = rodapé padrão. Consumida na matriz do SubtitleOverlay
  // como fallback, abaixo das regras de composição (split-50 / tweet / palco).
  anchor?: 'top' | 'bottom'
}

export type VideoFormat = '9:16' | '16:9'

export type InsertStylePreset = 'creator-clean' | 'editorial-bold' | 'minimal-glass'

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

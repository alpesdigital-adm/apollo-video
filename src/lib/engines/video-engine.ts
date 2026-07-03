import type { EditEngineKind, EditPlan } from '../types/edl'
import type { Scene } from '../types/scene'
import type { Silence, SubtitleEntry, Transcription, VideoFormat } from '../types/project'

export interface VideoEngineContext {
  projectId: string
  format: VideoFormat
  stylePreset: string
  fps: number
  source: {
    rawPath?: string | null
    renderPath: string
    duration: number
    width?: number | null
    height?: number | null
  }
  transcription?: Transcription | null
  subtitles: SubtitleEntry[]
  silences: Silence[]
  scenes: Scene[]
  // Optional persistent hook headline written straight into the plan.
  hookTitle?: string
  // COLD OPEN (Fase 3): janela na timeline FONTE preservada/normalizada no plano.
  coldOpen?: { fromFrame: number; toFrame: number }
}

export interface VideoEngine {
  kind: EditEngineKind
  name: string
  version: string
  createPlan(context: VideoEngineContext): EditPlan
}

export function assertEnginePlan(plan: EditPlan): EditPlan {
  if (!plan.sources.some((source) => source.id === plan.renderSourceId)) {
    throw new Error(`Edit plan render source "${plan.renderSourceId}" was not found`)
  }

  if (plan.duration <= 0) {
    throw new Error('Edit plan duration must be greater than zero')
  }

  if (plan.durationFrames <= 0) {
    throw new Error('Edit plan durationFrames must be greater than zero')
  }

  return plan
}

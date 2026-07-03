import type { SubtitleEntry, VideoFormat } from './project'
import type { NarrativeRole, VisualRole } from './scene'

export type EditEngineKind = 'narrative' | 'visual'

export type EditSourceRole = 'raw' | 'primary' | 'broll' | 'audio' | 'generated'

export interface EditSource {
  id: string
  role: EditSourceRole
  path: string
  duration: number
  width?: number
  height?: number
  fps?: number
}

export interface EditRange {
  id: string
  sourceId: string
  sourceStart: number
  sourceEnd: number
  timelineStart: number
  timelineEnd: number
  sourceStartFrame: number
  sourceEndFrame: number
  timelineStartFrame: number
  timelineEndFrame: number
  reason: string
}

export interface EditCut {
  id: string
  sourceStart: number
  sourceEnd: number
  sourceStartFrame: number
  sourceEndFrame: number
  removedDuration: number
  removedFrames: number
  reason: 'silence' | 'manual' | 'engine'
}

export interface EditOverlay {
  id: string
  kind: 'scene' | 'kv' | 'text' | 'image' | 'generated'
  sceneType?: string
  from: number
  to: number
  fromFrame: number
  toFrame: number
  props: Record<string, unknown>
}

export interface EditAudioEvent {
  id: string
  type: 'fade' | 'duck' | 'sfx' | 'music'
  from: number
  to: number
  fromFrame: number
  toFrame: number
  props?: Record<string, unknown>
}

export interface EditPlanPorts {
  acceptsNarration: boolean
  acceptsVisualMontage: boolean
  canUseBroll: boolean
  canUseMusicDrivenCuts: boolean
}

export type SegmentLayoutKind = 'fullscreen' | 'split-50' | 'blur-bg' | 'tweet-card'

export interface LayoutSegmentEffects {
  zoom?: 'in' | 'out'
  bw?: boolean
}

export interface LayoutSegment {
  id: string
  fromFrame: number
  toFrame: number
  layout: SegmentLayoutKind
  effects?: LayoutSegmentEffects
  props?: Record<string, unknown>
}

// Pacote 5: jump-cut punch-in. An interval between two consecutive silence cuts
// that scales the base video slightly, alternating 1.0/1.06 to disguise cuts.
export interface PlanPunchIn {
  fromFrame: number
  toFrame: number
  scale: number
}

export interface CreativeLineageUnit {
  id: string
  kind: 'source-video' | 'subtitle-window' | 'generated-image' | 'overlay'
  role?: NarrativeRole
  visualRole?: VisualRole
  sceneType?: string
  startFrame: number
  endFrame: number
  sourceSubtitleStart?: number
  sourceSubtitleEnd?: number
  assetPath?: string
  prompt?: string
  sourceText?: string
}

export interface CreativeLineage {
  projectId: string
  strategy: 'recorded-narrative'
  sourceOfTruth: 'uploaded-video'
  stylePreset: string
  generatedAt: string
  units: CreativeLineageUnit[]
  protectedWorkflow: string[]
  futurePorts: string[]
}

export interface EditPlan {
  version: 1
  engine: {
    kind: EditEngineKind
    name: string
    version: string
  }
  format: VideoFormat
  stylePreset: string
  fps: number
  duration: number
  durationFrames: number
  renderSourceId: string
  sources: EditSource[]
  ranges: EditRange[]
  cuts: EditCut[]
  subtitles: SubtitleEntry[]
  overlays: EditOverlay[]
  audio: EditAudioEvent[]
  ports: EditPlanPorts
  lineage: CreativeLineage
  notes: string[]
  // Optional segment layout track. Absent (or empty) = the base video is
  // fullscreen for the whole timeline (backwards-compatible with v1 plans).
  layoutSegments?: LayoutSegment[]
  // Optional persistent hook headline pinned to the top of the whole video.
  // Absent = no headline (backwards-compatible with v1 plans).
  hookTitle?: string
  // Optional jump-cut punch-in track (alternating base-video scale between
  // silence cuts). Absent/empty = base video keeps a steady scale.
  punchIns?: PlanPunchIn[]
  // COLD OPEN (Fase 3): janela na timeline FONTE (frames do vídeo base sem
  // deslocamento) replicada como gancho ANTES do vídeo normal. Duração 3-8s. O
  // offset da montagem acontece só nos inputProps (ver src/lib/cold-open.ts +
  // resolveColdOpen). Ausente = sem abertura (compatível com planos v1).
  coldOpen?: { fromFrame: number; toFrame: number }
}

/**
 * Scene type definitions for video composition
 */

export type SceneType =
  | 'FullScreen'
  | 'LowerThird'
  | 'Split'
  | 'SplitVertical'
  | 'Card'
  | 'Message'
  | 'Number'
  | 'Flow'
  | 'CTA'
  | 'StickFigures'
  | 'ImageInsert'

export type NarrativeRole =
  | 'hook'
  | 'context'
  | 'proof'
  | 'process'
  | 'objection'
  | 'decision'
  | 'cta'

export type VisualRole =
  | 'evidence'
  | 'contrast'
  | 'process'
  | 'context'
  | 'decision'

export type SegmentSceneLayout = 'split-50' | 'blur-bg' | 'tweet-card'

export interface SegmentSceneEffects {
  zoom?: 'in' | 'out'
  bw?: boolean
}

export interface BaseScene {
  id: string
  type: SceneType
  startLeg: number
  durationInSubtitles: number
  startFrame?: number
  endFrame?: number
  // Optional segment layout: when set, this scene's timeline window
  // repositions the base video (split/blur/tweet) instead of staying fullscreen.
  segmentLayout?: SegmentSceneLayout
  segmentEffects?: SegmentSceneEffects
}

export interface FullScreenScene extends BaseScene {
  type: 'FullScreen'
  text: string
  fontSize?: number
  color?: string
  bgColor?: string
}

export interface LowerThirdScene extends BaseScene {
  type: 'LowerThird'
  title: string
  subtitle: string
}

export interface SplitScene extends BaseScene {
  type: 'Split'
  topText: string
  bottomText: string
}

export interface SplitVerticalScene extends BaseScene {
  type: 'SplitVertical'
  leftText: string
  rightText: string
  leftLabel?: string
  rightLabel?: string
}

export interface CardScene extends BaseScene {
  type: 'Card'
  number: number
  title: string
  description: string
  icon?: string
}

export interface MessageScene extends BaseScene {
  type: 'Message'
  sender: string
  message: string
}

export interface NumberScene extends BaseScene {
  type: 'Number'
  value: string
  label: string
  prefix?: string
  suffix?: string
}

export interface FlowScene extends BaseScene {
  type: 'Flow'
  steps: string[]
}

export interface CTAScene extends BaseScene {
  type: 'CTA'
  text: string
  highlight: string
}

export interface StickFiguresScene extends BaseScene {
  type: 'StickFigures'
  situation: string
  caption: string
}

export interface ImageInsertScene extends BaseScene {
  type: 'ImageInsert'
  layout: 'full' | 'split-bottom' | 'top-image-compact'
  narrativeRole?: NarrativeRole
  visualRole?: VisualRole
  imagePrompt: string
  imagePath?: string
  imageAlt?: string
  sourceText?: string
}

export type Scene =
  | FullScreenScene
  | LowerThirdScene
  | SplitScene
  | SplitVerticalScene
  | CardScene
  | MessageScene
  | NumberScene
  | FlowScene
  | CTAScene
  | StickFiguresScene
  | ImageInsertScene

export interface ColorPalette {
  primary: string
  secondary: string
  accent: string
  background: string
  text: string
}

export interface AnalysisResult {
  narrativeFormat: string
  palette: ColorPalette
  scenes: Scene[]
  colorGroup?: string
}

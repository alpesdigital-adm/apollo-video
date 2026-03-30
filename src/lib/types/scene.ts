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

export interface BaseScene {
  id: string
  type: SceneType
  startLeg: number
  durationInSubtitles: number
  startFrame?: number
  endFrame?: number
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
}

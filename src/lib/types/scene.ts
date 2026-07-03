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
  | 'AssetCard'

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
  // Pacote 5: flash transition on this scene's entrance (any scene type).
  transitionIn?: 'flash'
}

export interface FullScreenScene extends BaseScene {
  type: 'FullScreen'
  text: string
  fontSize?: number
  color?: string
  bgColor?: string
  // Pacote 5: stylized title-card variant for the opening/hook. Omit = kinetic.
  variant?: 'torn-paper' | 'crt-glitch'
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
  // Optional short action label (≤5 palavras) para a caixa amarela final.
  boxText?: string
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
  // B-roll motion (Pacote 3): when true, animate the still via image-to-video.
  motion?: boolean
  // Pacote 5: stutter cluster — 5 deterministic micro-jumps over the first ~1.6s.
  stutter?: boolean
  // Where the media comes from: 'generate' (AI still, default) or 'stock' (Pexels).
  source?: 'generate' | 'stock'
  // Short English search query used when source === 'stock'.
  stockQuery?: string
  // Resolved animated/stock clip path (e.g. /generated-videos/... or /stock/...).
  videoSrc?: string
  // Pacote 4: reference to a user library asset. When present and valid, the
  // asset media replaces generation (resolved to imagePath/videoSrc server-side).
  assetId?: string
}

// Pacote 4 — cena que usa uma mídia PRÓPRIA da biblioteca do usuário.
export interface AssetCardScene extends BaseScene {
  type: 'AssetCard'
  assetId: string
  // credibility: foto+nome em rajada de prova social; meme: imagem+caption;
  // news: print de notícia quase full-width (sem texto extra).
  style: 'credibility' | 'meme' | 'news'
  name?: string
  caption?: string
  // Paths resolvidos server-side a partir do assetId (imagem OU vídeo).
  imageSrc?: string
  videoSrc?: string
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
  | AssetCardScene

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
  // Título-hook persistente (manchete-promessa ≤10 palavras) no topo do vídeo.
  hookTitle?: string
}

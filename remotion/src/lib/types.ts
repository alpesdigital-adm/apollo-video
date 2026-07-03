export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  background: string;
}

export interface Scene {
  type: 'fullscreen' | 'lower-third' | 'split' | 'split-vertical' | 'card' | 'message' | 'number' | 'flow' | 'cta' | 'stick-figures' | 'image-insert';
  from: number;
  to: number;
  fromFrame?: number;
  toFrame?: number;
  props: Record<string, any>;
}

export interface SubtitleWord {
  word: string;
  start: number;
  end: number;
}

export interface SubtitleEntry {
  text: string;
  startTime: number;
  endTime: number;
  startFrame?: number;
  endFrame?: number;
  words?: Array<string | SubtitleWord>;
}

export interface CreatorProfile {
  name: string;
  handle: string;
  avatarUrl: string | null;
}

// Subtitle preset styles (decupados das referências). 'kinetic' é o padrão e
// preserva o comportamento atual (sem caixa, highlight no accent, pop).
export type SubtitleStyle =
  | 'kinetic'
  | 'karaoke-box'
  | 'karaoke-pill'
  | 'caps-stroke'
  | 'clean-color';

export type SegmentLayoutKind = 'fullscreen' | 'split-50' | 'blur-bg' | 'tweet-card';

export interface LayoutSegmentEffects {
  zoom?: 'in' | 'out';
  bw?: boolean;
}

export interface LayoutSegment {
  id: string;
  fromFrame: number;
  toFrame: number;
  layout: SegmentLayoutKind;
  effects?: LayoutSegmentEffects;
  props?: Record<string, any>;
}

export interface CompositionProps extends Record<string, unknown> {
  scenes: Scene[];
  subtitles: SubtitleEntry[];
  videoSrc: string;
  format: '9:16' | '16:9';
  stylePreset?: string;
  // Preset de estilo das legendas (default 'kinetic' = comportamento atual).
  subtitleStyle?: SubtitleStyle;
  // Título-hook persistente no topo do vídeo inteiro (opcional).
  hookTitle?: string;
  palette: ColorPalette;
  creator?: CreatorProfile;
  layoutSegments?: LayoutSegment[];
}

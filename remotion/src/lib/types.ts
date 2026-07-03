export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  background: string;
}

export interface Scene {
  type: 'fullscreen' | 'lower-third' | 'split' | 'split-vertical' | 'card' | 'message' | 'number' | 'flow' | 'cta' | 'stick-figures' | 'image-insert' | 'asset-card';
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
  // Per-beat vertical anchor from Camada 2 (vision over the beat thumbnail).
  // 'top' = dominant face/action sits in the LOWER third, so the karaoke
  // subtitle displaces up; 'bottom'/undefined = default lower third.
  anchor?: 'top' | 'bottom';
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

// Base-video color grade preset (decupado das referências). 'natural' é o
// padrão e substitui o cru sem parecer um filtro pesado de Instagram.
export type GradePreset = 'natural' | 'cinema' | 'quente' | 'frio' | 'off';

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

export interface PunchIn {
  fromFrame: number;
  toFrame: number;
  scale: number;
}

export interface AudioSfxEvent {
  kind: string;
  src: string;
  fromFrame: number;
  volume: number;
}

export interface AudioMusic {
  src: string;
  volume: number;
}

export interface AudioProps {
  events: AudioSfxEvent[];
  music?: AudioMusic;
}

export interface CompositionProps extends Record<string, unknown> {
  scenes: Scene[];
  subtitles: SubtitleEntry[];
  videoSrc: string;
  format: '9:16' | '16:9';
  stylePreset?: string;
  // Preset de estilo das legendas (default 'kinetic' = comportamento atual).
  subtitleStyle?: SubtitleStyle;
  // Preset de correção de cor do vídeo base do narrador (default 'natural').
  gradePreset?: GradePreset;
  // Título-hook persistente no topo do vídeo inteiro (opcional).
  hookTitle?: string;
  palette: ColorPalette;
  creator?: CreatorProfile;
  layoutSegments?: LayoutSegment[];
  // Pacote 5: jump-cut punch-in track applied to the base video.
  punchIns?: PunchIn[];
  audio?: AudioProps;
}

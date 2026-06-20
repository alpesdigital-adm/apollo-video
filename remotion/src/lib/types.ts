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

export interface CompositionProps extends Record<string, unknown> {
  scenes: Scene[];
  subtitles: SubtitleEntry[];
  videoSrc: string;
  format: '9:16' | '16:9';
  stylePreset?: string;
  palette: ColorPalette;
}

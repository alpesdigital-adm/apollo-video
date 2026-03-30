export interface ColorPalette {
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  background: string;
}

export interface Scene {
  type: 'fullscreen' | 'lower-third' | 'split' | 'split-vertical' | 'card' | 'message' | 'number' | 'flow' | 'cta' | 'stick-figures';
  from: number;
  to: number;
  props: Record<string, any>;
}

export interface SubtitleEntry {
  text: string;
  startTime: number;
  endTime: number;
  words?: string[];
}

export interface CompositionProps {
  scenes: Scene[];
  subtitles: SubtitleEntry[];
  videoSrc: string;
  format: '9:16' | '16:9';
  palette: ColorPalette;
}

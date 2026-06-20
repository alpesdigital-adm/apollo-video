import React from 'react';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export type InsertStylePresetId = 'creator-clean' | 'editorial-bold' | 'minimal-glass';

interface InsertStylePreset {
  id: InsertStylePresetId;
  panel: string;
  panelSoft: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  border: string;
  shadow: string;
  radius: number;
  scrim: string;
  typeface: string;
}

const PRESETS: Record<InsertStylePresetId, InsertStylePreset> = {
  'creator-clean': {
    id: 'creator-clean',
    panel: 'rgba(8, 10, 18, 0.88)',
    panelSoft: 'rgba(8, 10, 18, 0.68)',
    text: '#FFFFFF',
    muted: 'rgba(255, 255, 255, 0.72)',
    accent: '#FFB800',
    accentText: '#101014',
    border: 'rgba(255, 255, 255, 0.18)',
    shadow: '0 28px 80px rgba(0, 0, 0, 0.42)',
    radius: 28,
    scrim: 'linear-gradient(180deg, rgba(0,0,0,0.08), rgba(0,0,0,0.52))',
    typeface: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
  },
  'editorial-bold': {
    id: 'editorial-bold',
    panel: '#F4EFE7',
    panelSoft: 'rgba(244, 239, 231, 0.88)',
    text: '#101014',
    muted: 'rgba(16, 16, 20, 0.68)',
    accent: '#F2572D',
    accentText: '#FFFFFF',
    border: 'rgba(16, 16, 20, 0.16)',
    shadow: '0 30px 90px rgba(0, 0, 0, 0.38)',
    radius: 18,
    scrim: 'linear-gradient(180deg, rgba(0,0,0,0.12), rgba(0,0,0,0.48))',
    typeface: 'Georgia, Cambria, Times New Roman, serif',
  },
  'minimal-glass': {
    id: 'minimal-glass',
    panel: 'rgba(15, 23, 42, 0.58)',
    panelSoft: 'rgba(15, 23, 42, 0.42)',
    text: '#F8FAFC',
    muted: 'rgba(248, 250, 252, 0.72)',
    accent: '#8DD7CF',
    accentText: '#071012',
    border: 'rgba(255, 255, 255, 0.22)',
    shadow: '0 24px 72px rgba(0, 0, 0, 0.34)',
    radius: 32,
    scrim: 'linear-gradient(180deg, rgba(2,6,23,0.04), rgba(2,6,23,0.42))',
    typeface: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
  },
};

export function getInsertStyle(stylePreset?: string): InsertStylePreset {
  return PRESETS[(stylePreset as InsertStylePresetId) || 'creator-clean'] || PRESETS['creator-clean'];
}

function stripDecorativeEmoji(value: string): string {
  return value
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\uFE0F?/gu, '')
    .replace(/[\uFE0F\u200D]/g, '');
}

export function compactText(value: unknown, maxChars = 80): string {
  const text = stripDecorativeEmoji(String(value || ''))
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxChars) {
    return text;
  }

  const slice = text.slice(0, maxChars - 1);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 32 ? lastSpace : maxChars - 1).trim()}...`;
}

export function smartFontSize(text: string, base: number, min: number): number {
  const length = text.length;
  if (length <= 28) return base;
  if (length <= 48) return Math.max(min, base - 8);
  if (length <= 72) return Math.max(min, base - 16);
  return Math.max(min, base - 24);
}

export function splitLines(text: string, maxLines = 3): string[] {
  const cleaned = compactText(text, maxLines === 1 ? 42 : 96);
  const existingLines = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  if (existingLines.length > 1) {
    return existingLines.slice(0, maxLines);
  }

  const words = cleaned.split(' ');
  const lines: string[] = [];
  let line = '';
  const target = Math.ceil(cleaned.length / maxLines);

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > target && line && lines.length < maxLines - 1) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) lines.push(line);
  return lines.slice(0, maxLines);
}

export function useInsertMotion(durationInFrames?: number) {
  const frame = useCurrentFrame();
  const config = useVideoConfig();
  const duration = Math.max(1, durationInFrames || config.durationInFrames || 1);
  const opacity = interpolate(
    frame,
    [0, 10, Math.max(12, duration - 10), duration],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );
  const lift = spring({
    frame,
    fps: config.fps,
    from: 24,
    to: 0,
    durationInFrames: 24,
  });
  const scale = spring({
    frame,
    fps: config.fps,
    from: 0.96,
    to: 1,
    durationInFrames: 24,
  });

  return { opacity, lift, scale };
}

interface InsertFrameProps {
  children: React.ReactNode;
  format: '9:16' | '16:9';
  stylePreset?: string;
  durationInFrames?: number;
  placement?: 'center' | 'bottom' | 'top' | 'upper-safe';
  scrim?: boolean;
}

export const InsertFrame: React.FC<InsertFrameProps> = ({
  children,
  format,
  stylePreset,
  durationInFrames,
  placement = 'center',
  scrim = true,
}) => {
  const style = getInsertStyle(stylePreset);
  const { opacity, lift, scale } = useInsertMotion(durationInFrames);
  const isVertical = format === '9:16';
  const safePlacement = isVertical && placement === 'bottom' ? 'upper-safe' : placement;
  const justifyContent =
    safePlacement === 'bottom' ? 'flex-end' : safePlacement === 'top' || safePlacement === 'upper-safe' ? 'flex-start' : 'center';
  const alignItems = isVertical && safePlacement === 'upper-safe' ? 'flex-start' : 'center';
  const padding = isVertical && safePlacement === 'upper-safe'
    ? '135px 260px 0 82px'
    : isVertical
      ? '124px 78px 176px'
      : '78px 108px';

  return (
    <AbsoluteFill
      style={{
        opacity,
        background: scrim ? style.scrim : 'transparent',
        display: 'flex',
        alignItems,
        justifyContent,
        padding,
        boxSizing: 'border-box',
        fontFamily: style.typeface,
      }}
    >
      <div
        style={{
          width: '100%',
          transform: `translateY(${-lift}px) scale(${scale})`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

interface PanelProps {
  children: React.ReactNode;
  stylePreset?: string;
  soft?: boolean;
  maxWidth?: number | string;
  align?: 'left' | 'center';
}

export const Panel: React.FC<PanelProps> = ({
  children,
  stylePreset,
  soft = false,
  maxWidth = 900,
  align = 'left',
}) => {
  const style = getInsertStyle(stylePreset);

  return (
    <div
      style={{
        width: '100%',
        maxWidth,
        margin: align === 'center' ? '0 auto' : '0',
        background: soft ? style.panelSoft : style.panel,
        color: style.text,
        border: `1px solid ${style.border}`,
        borderRadius: style.radius,
        boxShadow: style.shadow,
        padding: '30px 34px',
        boxSizing: 'border-box',
        backdropFilter: 'blur(18px)',
      }}
    >
      {children}
    </div>
  );
};

export const Kicker: React.FC<{ children: React.ReactNode; stylePreset?: string }> = ({
  children,
  stylePreset,
}) => {
  const style = getInsertStyle(stylePreset);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 13px',
        borderRadius: 999,
        background: style.accent,
        color: style.accentText,
        fontSize: 26,
        fontWeight: 800,
        letterSpacing: 0,
        textTransform: 'uppercase',
        lineHeight: 1,
        marginBottom: 16,
      }}
    >
      {children}
    </div>
  );
};

interface SmartTextProps {
  children: React.ReactNode;
  stylePreset?: string;
  variant?: 'title' | 'body' | 'muted' | 'accent';
  align?: 'left' | 'center';
  maxChars?: number;
  maxLines?: number;
  baseSize?: number;
  minSize?: number;
}

export const SmartText: React.FC<SmartTextProps> = ({
  children,
  stylePreset,
  variant = 'body',
  align = 'left',
  maxChars = variant === 'title' ? 72 : 96,
  maxLines = variant === 'title' ? 3 : 4,
  baseSize = variant === 'title' ? 66 : 38,
  minSize = variant === 'title' ? 44 : 32,
}) => {
  const style = getInsertStyle(stylePreset);
  const text = compactText(children, maxChars);
  const lines = splitLines(text, maxLines);
  const color =
    variant === 'muted' ? style.muted : variant === 'accent' ? style.accent : style.text;
  const fontSize = smartFontSize(text, baseSize, minSize);

  return (
    <div
      style={{
        color,
        textAlign: align,
        fontSize,
        fontWeight: variant === 'title' ? 850 : 650,
        lineHeight: variant === 'title' ? 1.06 : 1.22,
        letterSpacing: 0,
        textWrap: 'balance' as any,
        textShadow: variant === 'accent' ? 'none' : '0 2px 18px rgba(0,0,0,0.22)',
      }}
    >
      {lines.map((line, index) => (
        <div key={index}>{line}</div>
      ))}
    </div>
  );
};

export const AccentRule: React.FC<{ stylePreset?: string }> = ({ stylePreset }) => {
  const style = getInsertStyle(stylePreset);
  return (
    <div
      style={{
        width: 72,
        height: 7,
        borderRadius: 999,
        background: style.accent,
        margin: '20px 0',
      }}
    />
  );
};

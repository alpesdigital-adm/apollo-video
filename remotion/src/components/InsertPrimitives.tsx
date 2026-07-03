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
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  typeface: string;
}

const PRESETS: Record<InsertStylePresetId, InsertStylePreset> = {
  'creator-clean': {
    id: 'creator-clean',
    text: '#FFFFFF',
    muted: 'rgba(255, 255, 255, 0.82)',
    accent: '#FFB800',
    accentText: '#101014',
    typeface: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
  },
  'editorial-bold': {
    id: 'editorial-bold',
    text: '#FFFFFF',
    muted: 'rgba(255, 255, 255, 0.80)',
    accent: '#FF7A45',
    accentText: '#101014',
    typeface: 'Georgia, Cambria, Times New Roman, serif',
  },
  'minimal-glass': {
    id: 'minimal-glass',
    text: '#F8FAFC',
    muted: 'rgba(248, 250, 252, 0.80)',
    accent: '#8DD7CF',
    accentText: '#071012',
    typeface: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
  },
};

export function getInsertStyle(stylePreset?: string): InsertStylePreset {
  return PRESETS[(stylePreset as InsertStylePresetId) || 'creator-clean'] || PRESETS['creator-clean'];
}

// Layered text shadow keeps type legible over any footage without a solid panel.
export const TEXT_SHADOW = '0 2px 12px rgba(0,0,0,0.9), 0 0 40px rgba(0,0,0,0.5)';
export const TEXT_SHADOW_SOFT = '0 2px 10px rgba(0,0,0,0.85), 0 0 26px rgba(0,0,0,0.45)';

// Approximate text column width (px) inside InsertFrame's safe zone. Used to
// estimate how many characters fit per line at the legible font floor, so we
// can trim words instead of shrinking the font below readability.
const KINETIC_CONTENT_WIDTH = 780;

function stripDecorativeEmoji(value: string): string {
  return value
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?/gu, '')
    .replace(/[️‍]/g, '');
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

function normalizeToken(value: string): string {
  return value.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// InsertFrame — no panel, no border. Text is plotted directly on the video
// inside a safe zone (upper third by default; a discreet lower band for
// LowerThird) with a localized gradient scrim for legibility only.
// ---------------------------------------------------------------------------

interface InsertFrameProps {
  children: React.ReactNode;
  format: '9:16' | '16:9';
  stylePreset?: string;
  durationInFrames?: number;
  zone?: 'top' | 'lower';
  align?: 'left' | 'center';
  scrim?: boolean;
}

export const InsertFrame: React.FC<InsertFrameProps> = ({
  children,
  format,
  stylePreset,
  durationInFrames,
  zone = 'top',
  align = 'left',
  scrim = true,
}) => {
  const style = getInsertStyle(stylePreset);
  const frame = useCurrentFrame();
  const { fps, durationInFrames: total } = useVideoConfig();
  const dur = Math.max(1, durationInFrames || total || 1);

  const intro = interpolate(frame, [0, 6], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const outro = interpolate(frame, [dur - 8, dur], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const opacity = Math.min(intro, outro);
  const isVertical = format === '9:16';

  const scrimStyle: React.CSSProperties =
    zone === 'lower'
      ? {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: isVertical ? '26%' : '10%',
          height: isVertical ? '26%' : '30%',
          background:
            'linear-gradient(0deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 45%, rgba(0,0,0,0) 100%)',
        }
      : {
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: isVertical ? '52%' : '62%',
          background:
            'linear-gradient(180deg, rgba(0,0,0,0.62) 0%, rgba(0,0,0,0.3) 46%, rgba(0,0,0,0) 100%)',
        };

  const contentStyle: React.CSSProperties =
    zone === 'lower'
      ? {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: isVertical ? '30%' : '13%',
          boxSizing: 'border-box',
          padding: isVertical ? '0 96px 0 84px' : '0 130px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: align === 'center' ? 'center' : 'flex-start',
          textAlign: align,
        }
      : {
          position: 'absolute',
          top: isVertical ? '13%' : '12%',
          left: 0,
          right: 0,
          boxSizing: 'border-box',
          padding: isVertical ? '0 200px 0 84px' : '0 150px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: align === 'center' ? 'center' : 'flex-start',
          textAlign: align,
        };

  return (
    <AbsoluteFill style={{ opacity, fontFamily: style.typeface }}>
      {scrim && <div style={scrimStyle} />}
      <div style={contentStyle}>{children}</div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------------------
// KineticText — line-by-line spring entrance, keyword coloring, no container.
// ---------------------------------------------------------------------------

interface KineticTextProps {
  children: React.ReactNode;
  highlight?: string;
  stylePreset?: string;
  variant?: 'title' | 'muted';
  align?: 'left' | 'center';
  maxChars?: number;
  maxLines?: number;
  baseSize?: number;
  minSize?: number;
  pulse?: boolean;
  startDelay?: number;
}

export const KineticText: React.FC<KineticTextProps> = ({
  children,
  highlight,
  stylePreset,
  variant = 'title',
  align = 'left',
  maxChars,
  maxLines,
  baseSize,
  minSize,
  pulse = false,
  startDelay = 0,
}) => {
  const style = getInsertStyle(stylePreset);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isTitle = variant === 'title';
  const resolvedMaxChars = maxChars ?? (isTitle ? 72 : 96);
  const resolvedMaxLines = maxLines ?? (isTitle ? 3 : 3);
  // Legible floor: the font never drops below a readable size for 9:16.
  // When the text is too long to fit at that floor, we reduce the WORDS shown
  // (truncate at a word boundary with an ellipsis) rather than shrink the font
  // into illegibility.
  const legibleFloor = isTitle ? 54 : 30;
  const resolvedBase = baseSize ?? (isTitle ? 74 : 40);
  const resolvedMin = Math.max(legibleFloor, minSize ?? legibleFloor);

  const clean = compactText(children, resolvedMaxChars);
  const fontSize = smartFontSize(clean, resolvedBase, resolvedMin);
  // Cap the character budget to what fits legibly across maxLines at the floored
  // font size; anything beyond gets truncated at a word boundary (with a "...").
  const charsPerLine = Math.max(8, Math.floor(KINETIC_CONTENT_WIDTH / (fontSize * 0.56)));
  const capacity = charsPerLine * resolvedMaxLines;
  const fitted = clean.length > capacity ? compactText(clean, capacity) : clean;
  const lines = splitLines(fitted, resolvedMaxLines);

  const highlightSet = new Set(
    String(highlight || '')
      .split(/\s+/)
      .map(normalizeToken)
      .filter(Boolean)
  );

  const pulseScale = pulse ? 1 + 0.05 * Math.sin((frame / fps) * Math.PI * 3) : 1;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        gap: Math.round(fontSize * (isTitle ? 0.04 : 0.12)),
      }}
    >
      {lines.map((line, index) => {
        const delay = startDelay + index * 4;
        const progress = spring({
          frame: frame - delay,
          fps,
          from: 0,
          to: 1,
          durationInFrames: 20,
          config: { damping: 200 },
        });
        const translateY = (1 - progress) * 26;

        return (
          <div
            key={index}
            style={{
              transform: `translateY(${translateY}px)`,
              opacity: progress,
              fontSize,
              fontWeight: isTitle ? 800 : 600,
              lineHeight: isTitle ? 1.04 : 1.16,
              letterSpacing: isTitle ? '-0.02em' : '-0.01em',
              color: isTitle ? style.text : style.muted,
              textShadow: isTitle ? TEXT_SHADOW : TEXT_SHADOW_SOFT,
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0 0.28em',
              justifyContent: align === 'center' ? 'center' : 'flex-start',
              textAlign: align,
            }}
          >
            {line.split(' ').map((word, wordIndex) => {
              const isHighlight = highlightSet.size > 0 && highlightSet.has(normalizeToken(word));
              return (
                <span
                  key={wordIndex}
                  style={{
                    color: isHighlight ? style.accent : undefined,
                    display: 'inline-block',
                    transform: isHighlight && pulse ? `scale(${pulseScale})` : undefined,
                  }}
                >
                  {word}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

// Thin accent marker (number or dash) used by list-style scenes instead of cards.
export const Marker: React.FC<{
  children?: React.ReactNode;
  stylePreset?: string;
  size?: number;
}> = ({ children, stylePreset, size = 46 }) => {
  const style = getInsertStyle(stylePreset);
  return (
    <span
      style={{
        color: style.accent,
        fontSize: size,
        fontWeight: 800,
        lineHeight: 1,
        letterSpacing: '-0.02em',
        textShadow: TEXT_SHADOW,
        flexShrink: 0,
      }}
    >
      {children ?? '—'}
    </span>
  );
};

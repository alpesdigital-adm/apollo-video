import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { InsertFrame, KineticText, getInsertStyle } from '../components/InsertPrimitives';

interface FullScreenProps {
  title: string;
  subtitle?: string;
  text?: string;
  highlight?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
  // Pacote 5: stylized title-card variant for the opening/hook. Omit = kinetic.
  variant?: 'torn-paper' | 'crt-glitch';
}

export const FullScreen: React.FC<FullScreenProps> = ({
  title,
  subtitle,
  text,
  highlight,
  format,
  palette,
  stylePreset,
  durationInFrames,
  variant,
}) => {
  const mainText = title || text || 'Highlight';

  if (variant === 'torn-paper') {
    return <TornPaperCard text={mainText} format={format} />;
  }
  if (variant === 'crt-glitch') {
    return <CrtGlitchCard text={mainText} format={format} palette={palette} stylePreset={stylePreset} />;
  }

  return (
    <InsertFrame
      format={format}
      stylePreset={stylePreset}
      durationInFrames={durationInFrames}
      zone="top"
      align="left"
    >
      <KineticText
        stylePreset={stylePreset}
        highlight={highlight}
        variant="title"
        align="left"
        maxChars={72}
        maxLines={3}
        baseSize={format === '9:16' ? 86 : 92}
        minSize={48}
      >
        {mainText}
      </KineticText>
      {subtitle && (
        <div style={{ marginTop: 22 }}>
          <KineticText
            stylePreset={stylePreset}
            variant="muted"
            align="left"
            maxChars={84}
            maxLines={2}
            baseSize={38}
            minSize={30}
            startDelay={6}
          >
            {subtitle}
          </KineticText>
        </div>
      )}
    </InsertFrame>
  );
};

// ---------------------------------------------------------------------------
// torn-paper — red band with irregular torn edges crossing the screen behind
// CAPS text, slight rotation, slide + spring entrance. Urgency / news tone.
// ---------------------------------------------------------------------------
const TornPaperCard: React.FC<{ text: string; format: '9:16' | '16:9' }> = ({ text, format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({
    frame,
    fps,
    config: { damping: 16, stiffness: 150, mass: 0.8 },
    from: 0,
    to: 1,
    durationInFrames: 18,
  });
  const slideX = interpolate(enter, [0, 1], [-140, 0]);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const fontSize = format === '9:16' ? 104 : 116;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '112%',
          transform: `translateX(${slideX}px) rotate(-1.5deg)`,
          opacity,
        }}
      >
        {/* Torn red band — fixed irregular polygon edges (deterministic). */}
        <div
          style={{
            position: 'relative',
            backgroundColor: '#D92B2B',
            padding: format === '9:16' ? '56px 90px' : '52px 120px',
            clipPath:
              'polygon(0% 12%, 6% 4%, 14% 10%, 23% 2%, 34% 9%, 46% 1%, 58% 8%, 70% 2%, 82% 9%, 92% 3%, 100% 11%, 98% 88%, 90% 96%, 79% 90%, 67% 98%, 55% 91%, 43% 99%, 31% 92%, 20% 98%, 10% 91%, 2% 97%)',
            boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
          }}
        >
          <div
            style={{
              color: '#FFFFFF',
              fontFamily: 'Aptos, Segoe UI Semibold, Helvetica, Arial, sans-serif',
              fontWeight: 900,
              textTransform: 'uppercase',
              letterSpacing: '-0.01em',
              lineHeight: 1.02,
              fontSize,
              textAlign: 'center',
              textShadow: '0 3px 0 rgba(0,0,0,0.25)',
            }}
          >
            {text}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// crt-glitch — letterbox bars, RGB-split text (red/cyan layers tremble across 3
// fixed offsets alternating every 4 frames, frame-deterministic), scanlines.
// ---------------------------------------------------------------------------
const CRT_JITTER: Array<{ x: number; y: number }> = [
  { x: 3, y: 0 },
  { x: -3, y: 2 },
  { x: 2, y: -2 },
];

const CrtGlitchCard: React.FC<{
  text: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
}> = ({ text, format, stylePreset }) => {
  const frame = useCurrentFrame();
  const style = getInsertStyle(stylePreset);
  const jitter = CRT_JITTER[Math.floor(frame / 4) % CRT_JITTER.length];
  const fontSize = format === '9:16' ? 92 : 104;
  const barHeight = format === '9:16' ? '13%' : '11%';

  const layerBase: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
    fontWeight: 800,
    letterSpacing: '-0.01em',
    lineHeight: 1.05,
    fontSize,
    textAlign: 'center',
    padding: '0 90px',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}>
      {/* Letterbox bars */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: barHeight, backgroundColor: '#000' }} />
      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: barHeight, backgroundColor: '#000' }} />

      {/* RGB split text layers */}
      <div style={{ ...layerBase, color: '#FF2D2D', mixBlendMode: 'screen', transform: `translate(${jitter.x}px, ${jitter.y}px)` }}>
        {text}
      </div>
      <div style={{ ...layerBase, color: '#2DF0FF', mixBlendMode: 'screen', transform: `translate(${-jitter.x}px, ${-jitter.y}px)` }}>
        {text}
      </div>
      <div style={{ ...layerBase, color: style.text }}>{text}</div>

      {/* Scanlines */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 1px, transparent 2px, transparent 4px)',
          opacity: 0.5,
        }}
      />
    </div>
  );
};

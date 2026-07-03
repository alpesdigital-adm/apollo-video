import React from 'react';
import { Img, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  InsertFrame,
  KineticText,
  getInsertStyle,
  TEXT_SHADOW_SOFT,
} from '../components/InsertPrimitives';
import type { CreatorProfile } from '../lib/types';

interface CTAProps {
  text: string;
  highlightWord?: string;
  emoji?: string;
  // Optional short action label (≤5 palavras). When present, a yellow prompt box
  // ("Toque em Saiba Mais" 👆) appears in the final 40% of the scene.
  boxText?: string;
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
  creator?: CreatorProfile;
}

export const CTA: React.FC<CTAProps> = ({
  text,
  highlightWord,
  boxText,
  format,
  stylePreset,
  durationInFrames,
  creator,
}) => {
  return (
    <>
      <InsertFrame
        format={format}
        stylePreset={stylePreset}
        durationInFrames={durationInFrames}
        zone="top"
        align="left"
      >
        <KineticText
          stylePreset={stylePreset}
          highlight={highlightWord}
          variant="title"
          align="left"
          maxChars={64}
          maxLines={3}
          baseSize={format === '9:16' ? 78 : 84}
          minSize={46}
          pulse
        >
          {text}
        </KineticText>
        {creator?.handle && (
          <CreatorHandle creator={creator} stylePreset={stylePreset} />
        )}
      </InsertFrame>
      {boxText && <CTABox text={boxText} format={format} durationInFrames={durationInFrames} />}
    </>
  );
};

// Yellow action box (referência v3): sits in the bottom-left, above the subtitle
// zone, and appears only in the LAST 40% of the CTA scene, entering with a
// spring. Black bold text + 👆.
const CTABox: React.FC<{ text: string; format: '9:16' | '16:9'; durationInFrames?: number }> = ({
  text,
  format,
  durationInFrames,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames: total } = useVideoConfig();
  const dur = Math.max(1, durationInFrames || total || 1);
  const appearFrame = Math.round(dur * 0.6);

  if (frame < appearFrame) {
    return null;
  }

  const progress = spring({
    frame: frame - appearFrame,
    fps,
    from: 0,
    to: 1,
    durationInFrames: 14,
    config: { damping: 200 },
  });
  const translateY = (1 - progress) * 24;
  const isVertical = format === '9:16';
  const clean = String(text || '').replace(/\s+/g, ' ').trim();

  return (
    <div
      style={{
        position: 'absolute',
        left: isVertical ? 84 : 130,
        bottom: isVertical ? '30%' : '16%',
        opacity: progress,
        transform: `translateY(${translateY}px) scale(${0.96 + progress * 0.04})`,
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          background: '#FFD400',
          color: '#101014',
          borderRadius: 16,
          padding: isVertical ? '18px 30px' : '16px 26px',
          fontFamily: 'Aptos, Segoe UI, Helvetica, Arial, sans-serif',
          fontSize: isVertical ? 42 : 38,
          fontWeight: 800,
          letterSpacing: '-0.01em',
          boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
        }}
      >
        <span>{clean}</span>
        <span aria-hidden style={{ fontSize: isVertical ? 44 : 40 }}>
          👆
        </span>
      </div>
    </div>
  );
};

// Discreet kinetic byline: small round avatar + accent-colored @handle,
// entering with the same delayed spring as the KineticText lines above it.
// No panel/pill — text-shadow only, consistent with the "no boxes" language.
const CreatorHandle: React.FC<{ creator: CreatorProfile; stylePreset?: string }> = ({
  creator,
  stylePreset,
}) => {
  const style = getInsertStyle(stylePreset);
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const delay = 26;
  const progress = spring({
    frame: frame - delay,
    fps,
    from: 0,
    to: 1,
    durationInFrames: 20,
    config: { damping: 200 },
  });
  const translateY = (1 - progress) * 20;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginTop: 18,
        opacity: progress,
        transform: `translateY(${translateY}px)`,
      }}
    >
      {creator.avatarUrl && (
        <Img
          src={creator.avatarUrl}
          alt=""
          style={{
            width: 30,
            height: 30,
            borderRadius: '50%',
            objectFit: 'cover',
            boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
          }}
        />
      )}
      <span
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: style.accent,
          textShadow: TEXT_SHADOW_SOFT,
          letterSpacing: '-0.01em',
        }}
      >
        @{creator.handle}
      </span>
    </div>
  );
};

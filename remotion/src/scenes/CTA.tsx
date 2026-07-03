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
  format: '9:16' | '16:9';
  palette: any;
  stylePreset?: string;
  durationInFrames?: number;
  creator?: CreatorProfile;
}

export const CTA: React.FC<CTAProps> = ({
  text,
  highlightWord,
  format,
  stylePreset,
  durationInFrames,
  creator,
}) => {
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

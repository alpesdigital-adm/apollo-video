import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  spring,
  useVideoConfig,
  interpolate,
} from 'remotion';

interface SplitVerticalProps {
  leftLabel: string;
  rightLabel: string;
  leftContent: string;
  rightContent: string;
  format: '9:16' | '16:9';
  palette: any;
}

export const SplitVertical: React.FC<SplitVerticalProps> = ({
  leftLabel,
  rightLabel,
  leftContent,
  rightContent,
  palette,
}) => {
  const frame = useCurrentFrame();
  const config = useVideoConfig();

  const leftTranslateX = spring({
    frame,
    fps: config.fps,
    from: -300,
    to: 0,
    duration: 40,
    damp: 0.8,
  });

  const rightTranslateX = spring({
    frame: Math.max(0, frame - 10),
    fps: config.fps,
    from: 300,
    to: 0,
    duration: 40,
    damp: 0.8,
  });

  const opacity = interpolate(
    frame,
    [0, 15, config.durationInFrames - 20, config.durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  return (
    <AbsoluteFill
      style={{
        display: 'flex',
        opacity,
      }}
    >
      <div
        style={{
          flex: 1,
          backgroundColor: 'rgba(255, 107, 107, 0.2)',
          padding: '40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translateX(${leftTranslateX}px)`,
          borderRight: `2px solid ${palette.text}`,
        }}
      >
        <h3
          style={{
            fontSize: '48px',
            fontWeight: 'bold',
            color: palette.accent,
            margin: '0 0 30px 0',
          }}
        >
          {leftLabel}
        </h3>
        <p
          style={{
            fontSize: '40px',
            color: palette.text,
            margin: '0',
            textAlign: 'center',
            lineHeight: '1.4',
          }}
        >
          {leftContent}
        </p>
      </div>

      <div
        style={{
          flex: 1,
          backgroundColor: 'rgba(78, 205, 196, 0.2)',
          padding: '40px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          transform: `translateX(${rightTranslateX}px)`,
        }}
      >
        <h3
          style={{
            fontSize: '48px',
            fontWeight: 'bold',
            color: palette.accent,
            margin: '0 0 30px 0',
          }}
        >
          {rightLabel}
        </h3>
        <p
          style={{
            fontSize: '40px',
            color: palette.text,
            margin: '0',
            textAlign: 'center',
            lineHeight: '1.4',
          }}
        >
          {rightContent}
        </p>
      </div>
    </AbsoluteFill>
  );
};
